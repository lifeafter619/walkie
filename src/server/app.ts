import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { type AuthInfo } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { ApiKey, ProviderId } from '../shared/types.js';
import { VERSION } from '../shared/version.js';
import { askSchema, channelSchema, credentialTokenSchema, keySchema, keyUpdateSchema, notificationSchema, retentionSchema, routeSchema } from '../shared/schemas.js';
import type { AppConfig } from './config.js';
import { generateAdminToken, safeSecretEqual, safeTokenEqual } from './crypto.js';
import type { RelayRepository } from './database.js';
import { createRelayMcpHandler } from './mcp.js';
import { renderReplyForm, renderReplyResult } from './reply-page.js';
import type { NotificationService } from './notifications.js';
import type { ProviderDispatcher } from './providers/dispatcher.js';
import { PROVIDERS } from './providers/catalog.js';
import type { DeliveryWorker } from './queue.js';
import { applyUpdate, checkUpdate } from './update.js';
import { assertKeyDestinations, validateChannelCreate, validateChannelUpdate, validateRouteChannelIds } from './validation.js';

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
  const app = createMcpExpressApp({ host: config.host, jsonLimit: '256kb' });
  // 信任第一跳代理的 X-Forwarded-Proto/Host：反代 TLS 终止后 req.protocol 才能还原为 https，
  // 未设 PUBLIC_URL 时回复链接/元数据才不会生成 http://内网地址（req.ip 判定也只信任这一跳）
  app.set('trust proxy', 1);
  // createMcpExpressApp 内部已注册 express.json（默认 100kb），此处传入 jsonLimit 统一为 256kb；
  // 不能再重复注册第二个 json 解析器，否则实际生效的仍是最先注册的 100kb 限制。
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  // publicUrl：优先显式配置；未配置时用调用方给出的请求 origin（反向代理场景生成可用链接），
  // 无请求上下文时退回监听地址
  const publicUrl = (origin?: string) => (config.publicUrl ?? origin ?? `http://${config.host}:${config.port}`).replace(/\/$/, '');
  const mcpHandler = createRelayMcpHandler(repository, notifications, dispatcher, (request) => publicUrl(request ? new URL(request.url).origin : undefined));
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

  app.get('/health', (_req, res) => res.json({ status: 'ok', version: VERSION, queue: 'running' }));
  app.get('/api/meta', asyncRoute(async (req, res) => {
    const publicUrl = (config.publicUrl ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const rotated = await repository.getAdminTokenHash();
    res.json({
      name: 'Walkie', version: VERSION, runtime: 'node',
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
    const errors = validateChannelCreate(input.provider, input.config);
    if (errors.length) return res.status(400).json({ error: errors.join('；') });
    res.status(201).json(await repository.createChannel({ ...input, provider: input.provider as ProviderId }));
  }));
  admin.patch('/channels/:id', asyncRoute(async (req, res) => {
    const { provider, ...input } = channelSchema.partial().parse(req.body);
    // PATCH 换 provider/改 config 后重新校验必填字段，避免存入必然发送失败的配置
    const { current, errors } = await validateChannelUpdate(repository, String(req.params.id), { provider, config: input.config });
    if (errors[0] === '频道不存在') return res.status(404).json({ error: '频道不存在' });
    if (errors.length) return res.status(400).json({ error: errors.join('；') });
    res.json(await repository.updateChannel(current!.id, { ...input, ...(provider !== undefined ? { provider: provider as ProviderId } : {}) }));
  }));
  admin.delete('/channels/:id', asyncRoute(async (req, res) => { await repository.deleteChannel(String(req.params.id)); res.status(204).end(); }));
  admin.post('/channels/:id/test', asyncRoute(async (req, res) => {
    const channel = await repository.getChannel(String(req.params.id));
    if (!channel) return res.status(404).json({ error: '频道不存在' });
    try {
      await dispatcher.send(channel.provider, await repository.getChannelConfig(channel.id), { title: 'Walkie 测试通知', body: '频道连接正常，可以接收 Agent 通知。', severity: 'success', metadata: {} });
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
    const errors = await validateRouteChannelIds(repository, input.channelIds);
    if (errors.length) return res.status(400).json({ error: errors.join('；') });
    res.status(201).json(await repository.createRoute(input));
  }));
  admin.patch('/routes/:id', asyncRoute(async (req, res) => {
    const input = routeSchema.partial().parse(req.body);
    if (input.channelIds) {
      const errors = await validateRouteChannelIds(repository, input.channelIds);
      if (errors.length) return res.status(400).json({ error: errors.join('；') });
    }
    res.json(await repository.updateRoute(String(req.params.id), input));
  }));
  admin.delete('/routes/:id', asyncRoute(async (req, res) => { await repository.deleteRoute(String(req.params.id)); res.status(204).end(); }));

  admin.get('/keys', asyncRoute(async (_req, res) => res.json({ keys: await repository.listKeys() })));
  admin.post('/keys', asyncRoute(async (req, res) => {
    const input = keySchema.parse(req.body);
    if (input.destinationIds?.length) {
      const errors = await assertKeyDestinations(repository, input.destinationIds);
      if (errors.length) return res.status(400).json({ error: errors.join('；') });
    }
    res.status(201).json(await repository.createKey(input));
  }));
  admin.patch('/keys/:id', asyncRoute(async (req, res) => {
    const input = keyUpdateSchema.parse(req.body);
    if (input.destinationIds) {
      const errors = await assertKeyDestinations(repository, input.destinationIds);
      if (errors.length) return res.status(400).json({ error: errors.join('；') });
    }
    res.json(await repository.updateKey(String(req.params.id), input));
  }));
  admin.post('/keys/:id/revoke', asyncRoute(async (req, res) => { await repository.revokeKey(String(req.params.id)); res.json({ success: true }); }));
  admin.post('/keys/:id/restore', asyncRoute(async (req, res) => { await repository.restoreKey(String(req.params.id)); res.json({ success: true }); }));
  admin.delete('/keys/:id', asyncRoute(async (req, res) => { await repository.deleteKey(String(req.params.id)); res.status(204).end(); }));

  admin.get('/credentials', asyncRoute(async (_req, res) => res.json(await repository.getCredentialStatus(Boolean(config.adminToken)))));  admin.post('/credentials/admin-token', asyncRoute(async (req, res) => {
    const input = credentialTokenSchema.parse(req.body);
    const token = input.token ?? generateAdminToken();
    await repository.setAdminToken(token);
    res.status(201).json({ token });
  }));
  admin.post('/credentials/master-key/rotate', asyncRoute(async (_req, res) => res.json(await repository.rotateMasterKey())));

  admin.get('/audit', asyncRoute(async (req, res) => res.json({
    events: await repository.listAuditEvents({
      limit: Number(req.query.limit ?? 100),
      actor: typeof req.query.actor === 'string' && req.query.actor ? req.query.actor : undefined,
      action: typeof req.query.action === 'string' && req.query.action ? req.query.action : undefined
    })
  })));

  admin.get('/retention', asyncRoute(async (_req, res) => res.json(await repository.getRetention())));
  admin.put('/retention', asyncRoute(async (req, res) => res.json(await repository.setRetention(retentionSchema.parse(req.body)))));
  admin.post('/retention/purge', asyncRoute(async (_req, res) => res.json(await repository.purgeExpiredData())));

  admin.get('/update/check', asyncRoute(async (_req, res) => res.json(await checkUpdate(process.env.UPDATE_REPO))));
  admin.post('/update/apply', asyncRoute(async (_req, res) => {
    const result = await applyUpdate();
    if (result.success && result.needsRestart) {
      res.json(result);
      // 给响应 1.5s 发出窗口，然后重启进程（容器管理器会拉起新实例）
      setTimeout(() => { void repository.close(); process.exit(0); }, 1500);
    } else {
      res.json(result);
    }
  }));

  admin.get('/deliveries', asyncRoute(async (req, res) => res.json({ deliveries: await repository.listDeliveries({
    limit: Number(req.query.limit ?? 100),
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
    before: typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined
  }) })));
  admin.get('/deliveries/:id', asyncRoute(async (req, res) => {
    const delivery = await repository.getDelivery(String(req.params.id));
    if (!delivery) return res.status(404).json({ error: '投递不存在' });
    res.json(delivery);
  }));
  admin.post('/send', asyncRoute(async (req, res) => {
    const delivery = await notifications.send(notificationSchema.parse(req.body), 'admin');
    // 浮动 drain 必须挂 catch：DB 瞬时错误产生的拒绝若无人处理会击穿进程（Node≥15 默认 throw）
    void worker.drainOnce().catch(() => undefined);
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
    void worker.drainOnce().catch(() => undefined);
    res.status(202).json({ deliveryId: delivery.id, status: delivery.status, createdAt: delivery.createdAt });
  }));
  app.get('/api/v1/deliveries/:id', requireAgent, asyncRoute(async (req, res) => res.json(await notifications.getDelivery(String(req.params.id), req.agentKey))));
  app.post('/api/v1/ask', requireAgent, asyncRoute(async (req, res) => {
    const input = askSchema.parse(req.body);
    const base = publicUrl(`${req.protocol}://${req.get('host')}`);
    const asked = await notifications.ask(input, `agent:${req.agentKey!.id}`, req.agentKey!, base);
    void worker.drainOnce().catch(() => undefined);
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
    if (!reply) {
      // 空提交时链接仍有效，重新渲染表单并提示，而不是误报「链接已失效」把人劝退
      const conversation = await repository.getConversationForReply(String(req.params.id), String(req.params.token));
      const usable = conversation && !conversation.repliedAt && conversation.expiresAt > new Date().toISOString();
      return res.status(usable ? 400 : 410).type('html').send(usable ? renderReplyForm(conversation.question, conversation.options, '回复内容不能为空，请输入后再发送。') : renderReplyResult('gone'));
    }
    const accepted = await repository.replyConversation(String(req.params.id), reply, 'reply-link', String(req.params.token));
    res.status(accepted ? 200 : 410).type('html').send(renderReplyResult(accepted ? 'done' : 'gone'));
  }));

  // Server酱兼容入口：GET/POST /{key}.send 或 /send/{key}.send，key 为 Agent API Key。
  // 参数 title/text、desp、tags、short 与 Server酱³ 一致；destination 指定目的地（Key 白名单只有一个时可省略）。
  const serverchanCompat = asyncRoute(async (req: Request, res: Response) => {
    // Express 5 已对正则路由参数做过一次 percent-decode，再 decode 会把含 %xx 的自定义密钥解坏（与 Workers 版行为对齐）
    const compatKey = String(req.params[0]);
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
      void worker.drainOnce().catch(() => undefined);
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
