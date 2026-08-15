import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { type AuthInfo } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { ApiKey, ProviderId } from '../shared/types.js';
import { askSchema, channelSchema, credentialTokenSchema, keySchema, notificationSchema, routeSchema } from '../shared/schemas.js';
import type { AppConfig } from './config.js';
import { generateAdminToken, safeSecretEqual, safeTokenEqual } from './crypto.js';
import type { RelayRepository } from './database.js';
import { createRelayMcpHandler } from './mcp.js';
import { renderReplyForm, renderReplyResult } from './reply-page.js';
import type { NotificationService } from './notifications.js';
import type { ProviderDispatcher } from './providers/dispatcher.js';
import { PROVIDERS, PROVIDER_MAP, validateProviderConfig } from './providers/catalog.js';
import type { DeliveryWorker } from './queue.js';

declare global {
  namespace Express { interface Request { agentKey?: ApiKey; auth?: AuthInfo } }
}

const asyncRoute = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => void handler(req, res, next).catch(next);

export interface AppDependencies {
  config: AppConfig;
  repository: RelayRepository;
  notifications: NotificationService;
  dispatcher: ProviderDispatcher;
  worker: DeliveryWorker;
}

function bearer(req: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return match?.[1];
}

export function createApp(deps: AppDependencies) {
  const { config, repository, notifications, dispatcher, worker } = deps;
  const app = createMcpExpressApp({ host: config.host });
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  const publicUrl = () => (config.publicUrl ?? `http://${config.host}:${config.port}`).replace(/\/$/, '');
  const mcpHandler = createRelayMcpHandler(repository, notifications, publicUrl);
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => console.error('MCP adapter failed:', error.message)
  });
  app.locals.closeMcp = () => mcpHandler.close();

  const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    // env 管理令牌（本地开发未设置时跳过鉴权，保持原行为）
    if (config.adminToken && (safeTokenEqual(bearer(req), config.adminToken) || safeTokenEqual(req.header('x-admin-token'), config.adminToken))) return next();
    // 数据库轮换令牌：存的是 sha256 哈希，用 safeSecretEqual 比较（与 Agent Key 同模型）
    const rotated = await repository.getAdminTokenHash();
    if (rotated.hash) {
      const provided = bearer(req) ?? req.header('x-admin-token');
      if (provided && safeSecretEqual(provided, rotated.hash)) return next();
    }
    // 未配置任何管理令牌（本地开发，仅 loopback）：放行，保持原行为
    if (!config.adminToken && !rotated.hash) return next();
    res.status(401).json({ error: '管理密码不正确' });
  };
  const requireAgent = asyncRoute(async (req: Request, res: Response, next: NextFunction) => {
    const secret = bearer(req);
    const apiKey = secret ? await repository.authenticateKey(secret) : undefined;
    if (!apiKey) return res.status(401).json({ error: '无效或已吊销的 Agent API Key' });
    req.agentKey = apiKey;
    req.auth = { token: secret!, clientId: apiKey.id, scopes: apiKey.scopes };
    next();
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.2.0', queue: 'running' }));
  app.get('/api/meta', asyncRoute(async (req, res) => {
    const publicUrl = (config.publicUrl ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const rotated = await repository.getAdminTokenHash();
    res.json({
      name: 'RelayDock', version: '0.2.0', runtime: 'node',
      adminAuthRequired: Boolean(config.adminToken) || Boolean(rotated.hash),
      publicUrl, mcpEndpoint: '/mcp', mcpUrl: `${publicUrl}/mcp`
    });
  }));
  app.get('/api/admin/session', asyncRoute(requireAdmin), (_req, res) => res.json({ authenticated: true }));

  const admin = express.Router();
  admin.use(asyncRoute(requireAdmin));
  admin.get('/providers', (_req, res) => res.json({ providers: PROVIDERS }));
  admin.get('/stats', asyncRoute(async (_req, res) => res.json(await repository.getDashboardStats())));
  admin.get('/destinations', asyncRoute(async (_req, res) => res.json({ destinations: await repository.listDestinations() })));
  admin.get('/channels', asyncRoute(async (_req, res) => res.json({ channels: await repository.listChannels() })));
  admin.post('/channels', asyncRoute(async (req, res) => {
    const input = channelSchema.parse(req.body);
    const provider = input.provider as ProviderId;
    if (!PROVIDER_MAP.has(provider)) throw new Error('不支持的渠道类型');
    const errors = validateProviderConfig(provider, input.config);
    if (errors.length) return res.status(400).json({ error: errors.join('；') });
    res.status(201).json(await repository.createChannel({ ...input, provider }));
  }));
  admin.patch('/channels/:id', asyncRoute(async (req, res) => {
    const input = channelSchema.partial().parse(req.body);
    const provider = input.provider as ProviderId | undefined;
    if (provider && !PROVIDER_MAP.has(provider)) throw new Error('不支持的渠道类型');
    res.json(await repository.updateChannel(String(req.params.id), { ...input, provider }));
  }));
  admin.delete('/channels/:id', asyncRoute(async (req, res) => { await repository.deleteChannel(String(req.params.id)); res.status(204).end(); }));
  admin.post('/channels/:id/test', asyncRoute(async (req, res) => {
    const channel = await repository.getChannel(String(req.params.id));
    if (!channel) return res.status(404).json({ error: '频道不存在' });
    try {
      await dispatcher.send(channel.provider, await repository.getChannelConfig(channel.id), { title: 'RelayDock 测试通知', body: '频道连接正常，可以接收 Agent 通知。', severity: 'success', metadata: {} });
      await repository.setChannelTest(channel.id, true);
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repository.setChannelTest(channel.id, false, message);
      res.status(502).json({ error: message });
    }
  }));

  admin.get('/routes', asyncRoute(async (_req, res) => res.json({ routes: await repository.listRoutes() })));
  admin.post('/routes', asyncRoute(async (req, res) => {
    const input = routeSchema.parse(req.body);
    const channels = new Set((await repository.listChannels()).map((channel) => channel.id));
    if (input.channelIds.some((id) => !channels.has(id))) return res.status(400).json({ error: '路由包含不存在的频道' });
    res.status(201).json(await repository.createRoute(input));
  }));
  admin.patch('/routes/:id', asyncRoute(async (req, res) => {
    const input = routeSchema.partial().parse(req.body);
    const channels = new Set((await repository.listChannels()).map((channel) => channel.id));
    if (input.channelIds?.some((id) => !channels.has(id))) return res.status(400).json({ error: '路由包含不存在的频道' });
    res.json(await repository.updateRoute(String(req.params.id), input));
  }));
  admin.delete('/routes/:id', asyncRoute(async (req, res) => { await repository.deleteRoute(String(req.params.id)); res.status(204).end(); }));

  admin.get('/keys', asyncRoute(async (_req, res) => res.json({ keys: await repository.listKeys() })));
  admin.post('/keys', asyncRoute(async (req, res) => {
    const input = keySchema.parse(req.body);
    res.status(201).json(await repository.createKey(input));
  }));
  admin.post('/keys/:id/revoke', asyncRoute(async (req, res) => { await repository.revokeKey(String(req.params.id)); res.json({ success: true }); }));

  admin.get('/credentials', asyncRoute(async (_req, res) => res.json(await repository.getCredentialStatus(Boolean(config.adminToken)))));
  admin.post('/credentials/admin-token', asyncRoute(async (req, res) => {
    const input = credentialTokenSchema.parse(req.body);
    const token = input.token ?? generateAdminToken();
    await repository.setAdminToken(token);
    res.status(201).json({ token });
  }));
  admin.post('/credentials/master-key/rotate', asyncRoute(async (_req, res) => res.json(await repository.rotateMasterKey())));

  admin.get('/deliveries', asyncRoute(async (req, res) => res.json({ deliveries: await repository.listDeliveries({ limit: Number(req.query.limit ?? 100), status: typeof req.query.status === 'string' ? req.query.status : undefined }) })));
  admin.get('/deliveries/:id', asyncRoute(async (req, res) => {
    const delivery = await repository.getDelivery(String(req.params.id));
    if (!delivery) return res.status(404).json({ error: '投递不存在' });
    res.json(delivery);
  }));
  admin.post('/send', asyncRoute(async (req, res) => {
    const delivery = await notifications.send(notificationSchema.parse(req.body), 'admin');
    void worker.drainOnce();
    res.status(202).json(delivery);
  }));
  admin.post('/queue/drain', asyncRoute(async (_req, res) => res.json({ processed: await worker.drainOnce() })));
  admin.get('/conversations', asyncRoute(async (req, res) => res.json({ conversations: await repository.listConversations({ pendingOnly: req.query.pending === '1', limit: Number(req.query.limit ?? 50) }) })));
  admin.post('/conversations/:id/reply', asyncRoute(async (req, res) => {
    const reply = String((req.body as Record<string, unknown>)?.reply ?? '').trim().slice(0, 4000);
    if (!reply) return res.status(400).json({ error: '回复内容不能为空' });
    const accepted = await repository.replyConversation(String(req.params.id), reply, 'admin');
    if (!accepted) return res.status(409).json({ error: '会话已回复或已过期' });
    res.json({ success: true });
  }));
  app.use('/api/admin', admin);

  app.post('/api/v1/notify', requireAgent, asyncRoute(async (req, res) => {
    const delivery = await notifications.send(notificationSchema.parse(req.body), `agent:${req.agentKey!.id}`, req.agentKey);
    void worker.drainOnce();
    res.status(202).json({ deliveryId: delivery.id, status: delivery.status, createdAt: delivery.createdAt });
  }));
  app.get('/api/v1/deliveries/:id', requireAgent, asyncRoute(async (req, res) => res.json(await notifications.getDelivery(String(req.params.id), req.agentKey))));
  app.post('/api/v1/ask', requireAgent, asyncRoute(async (req, res) => {
    const input = askSchema.parse(req.body);
    const base = config.publicUrl ? publicUrl() : `${req.protocol}://${req.get('host')}`;
    const asked = await notifications.ask(input, `agent:${req.agentKey!.id}`, req.agentKey!, base);
    void worker.drainOnce();
    res.status(201).json({ conversationId: asked.conversation.id, deliveryId: asked.deliveryId, replyUrl: asked.replyUrl, expiresAt: asked.conversation.expiresAt });
  }));
  app.get('/api/v1/conversations/:id', requireAgent, asyncRoute(async (req, res) => {
    const { status, conversation } = await notifications.conversationStatus(String(req.params.id), req.agentKey!);
    res.json({ status, reply: conversation.reply, repliedAt: conversation.repliedAt, expiresAt: conversation.expiresAt });
  }));

  // 一次性回复链接：GET 表单 / POST 提交，token 即鉴权
  app.get('/reply/:id/:token', asyncRoute(async (req, res) => {
    const conversation = await repository.getConversationForReply(String(req.params.id), String(req.params.token));
    const usable = conversation && !conversation.repliedAt && conversation.expiresAt > new Date().toISOString();
    res.status(usable ? 200 : 410).type('html').send(usable ? renderReplyForm(conversation.question, conversation.options) : renderReplyResult('gone'));
  }));
  app.post('/reply/:id/:token', asyncRoute(async (req, res) => {
    const params = (req.body ?? {}) as Record<string, unknown>;
    const reply = String(params.reply ?? params.replyText ?? '').trim().slice(0, 4000);
    if (!reply) return res.status(400).type('html').send(renderReplyResult('gone'));
    const accepted = await repository.replyConversation(String(req.params.id), reply, 'reply-link', String(req.params.token));
    res.status(accepted ? 200 : 410).type('html').send(renderReplyResult(accepted ? 'done' : 'gone'));
  }));

  // Server酱兼容入口：GET/POST /{key}.send 或 /send/{key}.send，key 为 Agent API Key。
  // 参数 title/text、desp、tags、short 与 Server酱³ 一致；destination 指定目的地（Key 白名单只有一个时可省略）。
  const serverchanCompat = asyncRoute(async (req: Request, res: Response) => {
    let compatKey = String(req.params[0]);
    try { compatKey = decodeURIComponent(compatKey); } catch { /* 保留原样 */ }
    const apiKey = await repository.authenticateKey(compatKey);
    if (!apiKey) return res.status(401).json({ code: 40001, message: '无效或已吊销的 SendKey', data: {} });
    const params: Record<string, unknown> = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
    const title = String(params.title ?? params.text ?? '').trim();
    const desp = String(params.desp ?? '').trim();
    if (!title && !desp) return res.status(400).json({ code: 40003, message: 'title 或 desp 至少填写一项', data: {} });
    const destination = String(params.destination ?? '').trim() || (apiKey.destinationIds.length === 1 ? apiKey.destinationIds[0] : '');
    if (!destination) return res.status(400).json({ code: 40002, message: '请用 destination 参数指定目的地，或为该 Key 只配置一个目的地', data: {} });
    try {
      const delivery = await notifications.send({
        destination,
        title: (title || desp).slice(0, 200),
        body: (desp || title).slice(0, 20_000),
        severity: 'info',
        tags: typeof params.tags === 'string' ? params.tags.slice(0, 200) : undefined,
        short: typeof params.short === 'string' ? params.short.slice(0, 200) : undefined,
        metadata: { via: 'serverchan-compat' }
      }, `agent:${apiKey.id}`, apiKey);
      void worker.drainOnce();
      res.json({ code: 0, message: '', data: { pushid: delivery.id, readkey: '', error: 'SUCCESS', errno: 0 } });
    } catch (error) {
      res.status(400).json({ code: 40004, message: error instanceof Error ? error.message : '发送失败', data: {} });
    }
  });
  app.get(/^\/(?:send\/)?([^/]+)\.send$/, serverchanCompat);
  app.post(/^\/(?:send\/)?([^/]+)\.send$/, serverchanCompat);

  app.post('/mcp', requireAgent, asyncRoute(async (req, res) => {
    await nodeMcpHandler(req, res, req.body);
  }));
  app.get('/mcp', (_req, res) => res.set('Allow', 'POST').status(405).send('Method not allowed'));
  app.delete('/mcp', (_req, res) => res.set('Allow', 'POST').status(405).send('Method not allowed'));

  const webDir = path.resolve('dist/web');
  if (existsSync(webDir)) {
    app.use(express.static(webDir, { index: false, maxAge: config.isProduction ? '1h' : 0 }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof ZodError
      ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')
      : error instanceof Error ? error.message : '未知错误';
    const status = /not found|不存在/i.test(message) ? 404 : /UNIQUE constraint failed/.test(message) ? 409 : 400;
    res.status(status).json({ error: message });
  });

  return app;
}
