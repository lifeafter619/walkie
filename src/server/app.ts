import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { type AuthInfo } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { ApiKey, ProviderId } from '../shared/types.js';
import { VERSION } from '../shared/version.js';
import { askSchema, channelSchema, credentialTokenSchema, keySchema, keyUpdateSchema, notificationSchema, platformUsageSchema, retentionSchema, routeSchema, usageSettingsSchema } from '../shared/schemas.js';
import type { AppConfig } from './config.js';
import { COMPATIBILITY_ENDPOINTS, PLATFORM_PROFILES } from '../shared/platform.js';
import { generateAdminToken, safeTokenEqual } from './crypto.js';
import type { RelayRepository } from './database.js';
import { createRelayMcpHandler } from './mcp.js';
import { renderReplyForm, renderReplyResult } from './reply-page.js';
import type { NotificationService } from './notifications.js';
import type { ProviderDispatcher } from './providers/dispatcher.js';
import { PROVIDERS } from './providers/catalog.js';
import type { DeliveryWorker } from './queue.js';
import { applyUpdate, checkUpdate } from './update.js';
import { assertKeyDestinations, validateChannelCreate, validateChannelUpdate, validateRouteChannelIds } from './validation.js';
import { barkFailure, barkSuccess, registerResponse, resolveBarkDestination, sendBark } from './bark-compat.js';
import { appriseSeverity, bareFormText, discordText, parseAlertmanager, prioritySeverity, safeCompatUrl, sendWithAgentKey, slackText } from './compat.js';
import { handleTelegramWebhook } from './telegram-webhook.js';
import { handleSlackEvent, handleSlackInteractive } from './slack-interactive.js';
import { handleDiscordInteraction } from './discord-interactions.js';
import { handleClaudeHook, parseMinSeverity } from './claude-hook.js';
import { generateVapidKeys } from './providers/webpush.js';
import { parseMultipart } from '../shared/multipart.js';
import { openApiSpec } from '../shared/openapi.js';
import type { PlatformUsageMonitor } from './platform-usage.js';
import { parseWalkieTrace } from '../shared/instance-link.js';

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
  platformUsage?: PlatformUsageMonitor;
}

function bearer(req: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return match?.[1];
}

export function createApp(deps: AppDependencies) {
  const { config, repository, notifications, dispatcher, worker, platformUsage } = deps;
  // Slack/Discord 的验签对象是**未解析的原始请求体**，而 createMcpExpressApp 内部第一位就注册了
  // express.json——一旦它跑过，原始字节就没了。所以外层再包一个 app，把这三条签名路由排在
  // 解析中间件之前，其余路由照旧挂在外层（mcpApp 作为中间件先跑完 json/host 校验再回来）。
  const app = express();
  const mcpApp = createMcpExpressApp({ host: config.host, jsonLimit: '256kb' });
  // 信任第一跳代理的 X-Forwarded-Proto/Host：反代 TLS 终止后 req.protocol 才能还原为 https，
  // 未设 PUBLIC_URL 时回复链接/元数据才不会生成 http://内网地址（req.ip 判定也只信任这一跳）
  app.set('trust proxy', 1);

  const rawBody = express.raw({ type: '*/*', limit: '256kb' });
  const rawText = (req: Request) => Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  app.post('/slack/interactive/:secret', rawBody, asyncRoute(async (req, res) => {
    const result = await handleSlackInteractive(repository, rawText(req), String(req.params.secret), {
      signature: req.header('x-slack-signature'), timestamp: req.header('x-slack-request-timestamp')
    });
    res.status(result.statusCode).json(result.body);
  }));
  app.post('/slack/events/:secret', rawBody, asyncRoute(async (req, res) => {
    const result = await handleSlackEvent(repository, rawText(req), String(req.params.secret), {
      signature: req.header('x-slack-signature'), timestamp: req.header('x-slack-request-timestamp')
    });
    res.status(result.statusCode).json(result.body);
  }));
  app.post('/discord/interactions/:secret', rawBody, asyncRoute(async (req, res) => {
    const result = await handleDiscordInteraction(repository, rawText(req), String(req.params.secret), {
      signature: req.header('x-signature-ed25519'), timestamp: req.header('x-signature-timestamp')
    });
    res.status(result.statusCode).json(result.body);
  }));

  app.use(mcpApp);
  // createMcpExpressApp 内部已注册 express.json（默认 100kb），此处传入 jsonLimit 统一为 256kb；
  // 不能再重复注册第二个 json 解析器，否则实际生效的仍是最先注册的 100kb 限制。
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(express.text({ type: 'text/plain', limit: '256kb' }));
  // multipart 只服务兼容端点（Gotify curl -F 等）；文件部分丢弃，字段并入 req.body
  app.use(express.text({ type: 'multipart/form-data', limit: '256kb' }) as unknown as express.RequestHandler);
  const multipartFields = (req: Request): Record<string, unknown> => {
    if (typeof req.body !== 'string' || !(req.header('content-type') ?? '').includes('multipart/form-data')) return {};
    return parseMultipart(req.body, req.header('content-type')!);
  };
  // Slack 老式提交：Content-Type 为 form，payload=<urlencoded json>；新式直接 POST JSON
  const slackPayload = (req: Request): Record<string, unknown> => {
    const fields = { ...multipartFields(req), ...(req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}) };
    const payload = fields.payload;
    if (typeof payload === 'string' && payload.trim().startsWith('{')) {
      try { return JSON.parse(payload) as Record<string, unknown>; } catch { return fields; }
    }
    return fields;
  };
  // publicUrl：优先显式配置；未配置时用调用方给出的请求 origin（反向代理场景生成可用链接），
  // 无请求上下文时退回监听地址
  const publicUrl = (origin?: string) => (config.publicUrl ?? origin ?? `http://${config.host}:${config.port}`).replace(/\/$/, '');
  const mcpHandler = createRelayMcpHandler(repository, notifications, dispatcher, (request) => publicUrl(request ? new URL(request.url).origin : undefined));
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => console.error('MCP adapter failed:', error.message)
  });
  app.locals.closeMcp = () => mcpHandler.close();

  const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    const provided = bearer(req) ?? req.header('x-admin-token');
    // env 管理令牌（本地开发未设置时跳过鉴权，保持原行为）
    if (config.adminToken && safeTokenEqual(provided, config.adminToken)) return next();
    if (provided && await repository.authenticateAdminToken(provided)) return next();
    const hasDatabaseToken = (await repository.listAdminTokens()).some((token) => !token.revokedAt);
    // 未配置任何管理令牌（本地开发，仅 loopback）：放行，保持原行为
    if (!config.adminToken && !hasDatabaseToken) return next();
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
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec(publicUrl())));
  app.get('/api/meta', asyncRoute(async (req, res) => {
    const publicUrl = (config.publicUrl ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const hasDatabaseToken = (await repository.listAdminTokens()).some((token) => !token.revokedAt);
    res.json({
      name: 'Walkie', version: VERSION, runtime: 'node',
      platform: config.platform,
      platformProfile: PLATFORM_PROFILES[config.platform],
      compatibilityEndpoints: COMPATIBILITY_ENDPOINTS,
      adminAuthRequired: Boolean(config.adminToken) || hasDatabaseToken,
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
  admin.delete('/channels/:id', asyncRoute(async (req, res) => {
    // ?purge=1：连同该频道的投递历史一并删除。默认保守（软禁用），保住审计链
    const result = await repository.deleteChannel(String(req.params.id), 'admin', { purgeHistory: req.query.purge === '1' });
    res.json(result);
  }));
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

  admin.get('/credentials', asyncRoute(async (_req, res) => res.json(await repository.getCredentialStatus(Boolean(config.adminToken)))));
  admin.post('/credentials/admin-token', asyncRoute(async (req, res) => {
    const input = credentialTokenSchema.parse(req.body);
    const token = input.token ?? generateAdminToken();
    const adminToken = await repository.setAdminToken(token, input.name);
    res.status(201).json({ token, adminToken });
  }));
  admin.delete('/credentials/admin-tokens/:id', asyncRoute(async (req, res) => {
    await repository.revokeAdminToken(String(req.params.id), Boolean(config.adminToken));
    res.status(204).end();
  }));
  admin.post('/credentials/admin-tokens/:id/restore', asyncRoute(async (req, res) => {
    await repository.restoreAdminToken(String(req.params.id));
    res.json({ success: true });
  }));
  admin.get('/usage', asyncRoute(async (_req, res) => res.json(await repository.getUsageSnapshot())));
  admin.put('/usage', asyncRoute(async (req, res) => {
    const settings = usageSettingsSchema.parse(req.body);
    await repository.setUsageSettings(settings);
    res.json(await repository.getUsageSnapshot());
  }));
  if (platformUsage) {
    admin.get('/platform-usage', asyncRoute(async (_req, res) => res.json(await platformUsage.getStatus(true))));
    admin.put('/platform-usage', asyncRoute(async (req, res) => res.json(await platformUsage.configure(platformUsageSchema.parse(req.body)))));
    admin.post('/platform-usage/refresh', asyncRoute(async (_req, res) => res.json(await platformUsage.refresh())));
    admin.post('/platform-usage/reenable', asyncRoute(async (_req, res) => res.json(await platformUsage.reenableDelivery())));
  }
  admin.post('/credentials/master-key/rotate', asyncRoute(async (_req, res) => res.json(await repository.rotateMasterKey())));

  admin.get('/audit', asyncRoute(async (req, res) => res.json({
    events: await repository.listAuditEvents({
      limit: Number(req.query.limit ?? 100),
      actor: typeof req.query.actor === 'string' && req.query.actor ? req.query.actor : undefined,
      action: typeof req.query.action === 'string' && req.query.action ? req.query.action : undefined
    })
  })));
  admin.delete('/audit', asyncRoute(async (_req, res) => res.json({ deleted: await repository.clearAuditEvents() })));

  admin.get('/retention', asyncRoute(async (_req, res) => res.json(await repository.getRetention())));
  admin.put('/retention', asyncRoute(async (req, res) => res.json(await repository.setRetention(retentionSchema.parse(req.body)))));
  admin.post('/retention/purge', asyncRoute(async (_req, res) => res.json(await repository.purgeExpiredData())));

  admin.get('/update/check', asyncRoute(async (_req, res) => res.json(await checkUpdate(process.env.UPDATE_REPO, config.platform))));
  admin.post('/update/apply', asyncRoute(async (_req, res) => {
    const result = await applyUpdate(config.platform);
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
  admin.get('/schedules', asyncRoute(async (_req, res) => res.json({ schedules: await repository.listSchedules() })));
  admin.post('/schedules/:id/cancel', asyncRoute(async (req, res) => res.json(await repository.cancelSchedule(String(req.params.id)))));
  admin.post('/queue/drain', asyncRoute(async (_req, res) => res.json({ processed: await worker.drainOnce() })));
  admin.get('/conversations', asyncRoute(async (req, res) => res.json({ conversations: await repository.listConversations({ pendingOnly: req.query.pending === '1', limit: Number(req.query.limit ?? 50) }) })));
  admin.post('/conversations/:id/reply', asyncRoute(async (req, res) => {
    const reply = String((req.body as Record<string, unknown>)?.reply ?? '').trim().slice(0, 4000);
    if (!reply) return res.status(400).json({ error: '回复内容不能为空' });
    const accepted = await repository.replyConversation(String(req.params.id), reply, 'admin');
    if (!accepted) return res.status(409).json({ error: '会话已回复或已过期' });
    res.json({ success: true });
  }));

  // 收件箱：人主动发给 Agent 的消息；Agent 侧由 MCP wait_for_inbox 取走
  admin.get('/inbox', asyncRoute(async (req, res) => res.json({
    messages: await repository.listInboxMessages({ pendingOnly: req.query.pending === '1', limit: Number(req.query.limit ?? 50) })
  })));
  admin.post('/inbox', asyncRoute(async (req, res) => {
    const text = String((req.body as Record<string, unknown>)?.body ?? '').trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: '消息内容不能为空' });
    res.status(201).json(await repository.pushInboxMessage(text, 'admin'));
  }));

  // Web Push 订阅管理（#6）：控制台登录后订阅本设备；VAPID 密钥对惰性生成存 settings
  admin.get('/webpush', asyncRoute(async (_req, res) => {
    let vapid = await repository.getPushVapidKeys();
    if (!vapid) {
      const keys = await generateVapidKeys();
      await repository.setPushVapidKeys(keys);
      vapid = keys;
    }
    const subscriptions = await repository.listPushSubscriptions();
    res.json({ vapidPublicKey: vapid.publicKey, subscriptions: subscriptions.map((item) => ({ endpoint: item.endpoint, createdAt: item.createdAt })) });
  }));
  admin.post('/webpush/subscribe', asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const endpoint = String(body.endpoint ?? '').trim();
    const keys = body.keys && typeof body.keys === 'object' ? body.keys as Record<string, unknown> : {};
    const p256dh = String(keys.p256dh ?? '').trim();
    const auth = String(keys.auth ?? '').trim();
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:') throw new Error('只支持 https push endpoint');
    } catch {
      return res.status(400).json({ error: 'endpoint 不是合法的 HTTPS URL' });
    }
    if (!p256dh || !auth) return res.status(400).json({ error: '缺少 keys.p256dh / keys.auth' });
    await repository.savePushSubscription({ endpoint, p256dh, auth, userAgent: req.header('user-agent') ?? undefined });
    res.status(201).json({ success: true });
  }));
  admin.delete('/webpush/subscribe', asyncRoute(async (req, res) => {
    const endpoint = String(req.query.endpoint ?? req.body?.endpoint ?? '');
    const removed = await repository.deletePushSubscription(endpoint);
    if (!removed) return res.status(404).json({ error: '订阅不存在' });
    res.json({ success: true });
  }));

  app.use('/api/admin', admin);

  app.post('/api/v1/notify', requireAgent, asyncRoute(async (req, res) => {
    const input = notificationSchema.parse(req.body);
    const trace = parseWalkieTrace(req.header('x-walkie-trace'));
    const delivery = await notifications.send({ ...input, ...(trace.length ? { metadata: { ...input.metadata, walkieTrace: trace } } : {}) }, `agent:${req.agentKey!.id}`, req.agentKey);
    void worker.drainOnce().catch(() => undefined);
    res.status(202).json({ deliveryId: delivery.id, scheduleId: delivery.scheduleId, status: delivery.status, scheduledAt: delivery.scheduledAt, createdAt: delivery.createdAt });
  }));
  // 编码 Agent HTTP hook：事件 JSON 直接 POST，翻译成带 severity 的通知。
  // key 绑多个目的地时用 ?destination=<slug> 指定；?min_severity= 过滤低级别事件
  // （用户/Agent 安装时自选通知条件）。/claude 是早期别名，与 /agent 同处理器
  const hookQuery = (req: Request) => ({
    destination: typeof req.query.destination === 'string' ? req.query.destination : undefined,
    minSeverity: parseMinSeverity(typeof req.query.min_severity === 'string' ? req.query.min_severity : undefined)
  });
  for (const hookPath of ['/api/v1/hooks/agent', '/api/v1/hooks/claude']) {
    app.post(hookPath, requireAgent, asyncRoute(async (req, res) => {
      const { destination, minSeverity } = hookQuery(req);
      const result = await handleClaudeHook(repository, notifications, req.body, bearer(req) ?? '', destination, () => void worker.drainOnce().catch(() => undefined), minSeverity);
      res.status(result.statusCode).json(result.body);
    }));
  }
  app.get('/api/v1/schedules', requireAgent, asyncRoute(async (req, res) => {
    if (!req.agentKey!.scopes.includes('notifications:send')) return res.status(403).json({ error: 'API Key 缺少 notifications:send 权限' });
    res.json({ schedules: await repository.listSchedules({ source: `agent:${req.agentKey!.id}` }) });
  }));
  app.post('/api/v1/schedules/:id/cancel', requireAgent, asyncRoute(async (req, res) => {
    if (!req.agentKey!.scopes.includes('notifications:send')) return res.status(403).json({ error: 'API Key 缺少 notifications:send 权限' });
    res.json(await repository.cancelSchedule(String(req.params.id), `agent:${req.agentKey!.id}`, `agent:${req.agentKey!.id}`));
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

  // Bark-compatible relay: device_key maps to a configured Bark channel or a single-destination Agent Key.
  const barkPush = asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const params = { ...body, ...req.query } as Record<string, unknown>;
    try {
      const result = await sendBark(notifications, repository, params);
      void worker.drainOnce().catch(() => undefined);
      res.json(barkSuccess(result.deliveries.length === 1 ? undefined : result.keys.map((key, index) => ({ code: 200, device_key: key, deliveryId: result.deliveries[index] }))));
    } catch (error) {
      res.status(400).json(barkFailure(400, error instanceof Error ? error.message : '推送失败'));
    }
  });
  const barkRegister = asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const params = { ...req.query, ...body } as Record<string, unknown>;
    const key = String(params.device_key ?? params.key ?? '').trim();
    const token = String(params.device_token ?? params.devicetoken ?? '').trim();
    if (!key) return res.status(400).json(barkFailure(400, 'device key 不能为空'));
    if (!token) return res.status(400).json(barkFailure(400, 'device token 不能为空'));
    try {
      await resolveBarkDestination(repository, key);
      res.json(registerResponse(key, token));
    } catch (error) {
      res.status(400).json(barkFailure(400, error instanceof Error ? error.message : '设备未注册'));
    }
  });
  app.get('/ping', (_req, res) => res.json(barkSuccess()));
  app.get('/healthz', (_req, res) => res.json(barkSuccess()));
  app.get('/info', (_req, res) => res.json(barkSuccess({ version: VERSION, server: 'Walkie Bark relay' })));
  app.get('/register', barkRegister);
  app.post('/register', barkRegister);
  app.get(/^\/register\/([^/]+)$/, asyncRoute(async (req, res) => {
    try { await resolveBarkDestination(repository, String(req.params[0])); res.json(barkSuccess()); }
    catch (error) { res.status(400).json(barkFailure(400, error instanceof Error ? error.message : '设备未注册')); }
  }));
  app.get('/push', barkPush);
  app.post('/push', barkPush);

  app.post('/message', asyncRoute(async (req, res) => {
    const params = { ...multipartFields(req), ...(req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}) };
    try {
      // Gotify 的 token 三种传法都要认：X-Gotify-Key 头、?token= 查询参数、Authorization: Bearer
      const token = req.header('x-gotify-key') || String(req.query.token ?? params.token ?? '') || bearer(req) || '';
      const delivery = await sendWithAgentKey(repository, notifications, token, {
        title: String(params.title ?? 'Gotify').slice(0, 200),
        body: String(params.message ?? '').trim().slice(0, 20_000) || 'Empty Message',
        severity: prioritySeverity(params.priority),
        metadata: { via: 'gotify-compat', extras: params.extras ?? {} }
      }, 'gotify-compat');
      void worker.drainOnce().catch(() => undefined);
      res.json({ id: delivery.id });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '推送失败' }); }
  }));

  const pushplusCompat = asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const params = { ...req.query, ...body } as Record<string, unknown>;
    try {
      const delivery = await sendWithAgentKey(repository, notifications, String(params.token ?? ''), {
        title: String(params.title ?? 'PushPlus').slice(0, 200),
        body: String(params.content ?? params.body ?? '').trim().slice(0, 20_000) || 'Empty Message',
        severity: 'info',
        metadata: { via: 'pushplus-compat', template: params.template, topic: params.topic }
      }, 'pushplus-compat');
      void worker.drainOnce().catch(() => undefined);
      res.json({ code: 200, msg: '请求成功', data: delivery.id });
    } catch (error) { res.status(400).json({ code: 400, msg: error instanceof Error ? error.message : '推送失败' }); }
  });
  app.get('/send', pushplusCompat);
  app.post('/send', pushplusCompat);

  app.post(/^\/ntfy\/([^/]+)$/, asyncRoute(async (req, res) => {
    const params = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    // curl -d "hi" 的裸文本会被 urlencoded 解析成 { 'hi': '' }，还原回正文
    const message = typeof req.body === 'string' ? req.body : String(params.message ?? params.body ?? '') || bareFormText(params) || '';
    try {
      const delivery = await sendWithAgentKey(repository, notifications, bearer(req) ?? '', {
        destination: String(req.params[0]),
        title: String(req.header('title') ?? params.title ?? 'ntfy').slice(0, 200),
        body: message.trim().slice(0, 20_000) || 'Empty Message',
        severity: prioritySeverity(req.header('priority') ?? params.priority, 'ntfy'),
        url: safeCompatUrl(req.header('click') ?? params.click),
        tags: String(req.header('tags') ?? params.tags ?? '').slice(0, 200) || undefined,
        metadata: { via: 'ntfy-compat' }
      }, 'ntfy-compat');
      void worker.drainOnce().catch(() => undefined);
      res.json({ id: delivery.id, time: Math.floor(Date.now() / 1000), event: 'message', topic: String(req.params[0]), message });
    } catch (error) { res.status(400).json({ code: 400, error: error instanceof Error ? error.message : '推送失败' }); }
  }));

  // Telegram Bot webhook：inline_keyboard 按钮点按回调 + 自由文本回复 + 收件箱（#11）
  app.post('/telegram/webhook/:secret', asyncRoute(async (req, res) => {
    try {
      const result = await handleTelegramWebhook(repository, (url, init) => dispatcher.rawPost(url, init), req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}, req.header('x-telegram-bot-api-secret-token'));
      res.status(result.statusCode).json(result.body);
    } catch (error) {
      // Telegram 对非 2xx 会无限重试；处理不了的更新重试也没用，记日志后按收讫处理
      res.status(200).json({ ok: true });
      console.error(JSON.stringify({ event: 'telegram.webhook.failed', message: error instanceof Error ? error.message : String(error) }));
    }
  }));

  // Slack Bot 交互回调与 Discord Interactions 需要原始请求体验签，已在文件顶部的外层
  // app 上注册（必须排在 body 解析中间件之前）。

  // ---- 以下五个兼容端点都必须注册在 barkLegacy 正则之前：那个模式吃掉任何 1–4 段路径 ----

  // Slack Incoming Webhook 兼容：POST /services/<T>/<B>/<xxx>，末段作为 Agent Key。
  // 成功必须返回纯文本 "ok"（Slack 的行为，JSON 会被当失败）。
  app.post(/^\/services\/([A-Za-z0-9_\-]+)\/([A-Za-z0-9_\-]+)\/([A-Za-z0-9_\-]+)$/, asyncRoute(async (req, res) => {
    const params = slackPayload(req);
    try {
      const delivery = await sendWithAgentKey(repository, notifications, String(req.params[2]), {
        title: (String(params.text ?? '').trim() || 'Slack').slice(0, 200),
        body: (slackText(params) || 'Empty Message').slice(0, 20_000),
        severity: 'info',
        metadata: { via: 'slack-webhook-compat' }
      }, 'slack-webhook-compat');
      void worker.drainOnce().catch(() => undefined);
      res.type('text/plain').send('ok');
    } catch (error) { res.status(400).type('text/plain').send(error instanceof Error ? error.message : '推送失败'); }
  }));

  // Discord Webhook 兼容：POST /api/webhooks/<id>/<token>，token 段作为 Agent Key。
  // 默认 204；?wait=true 时 Discord 客户端期待一个 message JSON 对象。
  app.post(/^\/api\/webhooks\/([0-9]+)\/([A-Za-z0-9_\-]+)$/, asyncRoute(async (req, res) => {
    const params = { ...multipartFields(req), ...(req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}) };
    const content = String(params.content ?? '').trim();
    const embeds = discordText(params);
    try {
      const delivery = await sendWithAgentKey(repository, notifications, String(req.params[1]), {
        title: (content.split('\n')[0] || 'Discord').slice(0, 200),
        body: ([content, embeds].filter(Boolean).join('\n') || 'Empty Message').slice(0, 20_000),
        severity: 'info',
        metadata: { via: 'discord-webhook-compat' }
      }, 'discord-webhook-compat');
      void worker.drainOnce().catch(() => undefined);
      if (req.query.wait === 'true' || req.query.wait === '1') {
        res.status(200).json({ id: delivery.id, content, timestamp: new Date().toISOString(), webhook_id: String(req.params[0]) });
      } else res.status(204).end();
    } catch (error) { res.status(400).json({ message: error instanceof Error ? error.message : '推送失败' }); }
  }));

  // Alertmanager / Grafana 告警 webhook 兼容：POST /alertmanager?key=<AgentKey>（或 Bearer）。
  // fingerprint 作幂等键：同一告警的重复推送天然去重，不会刷屏。
  app.post('/alertmanager', asyncRoute(async (req, res) => {
    const params = { ...multipartFields(req), ...(req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}) };
    const token = String(req.query.key ?? '') || bearer(req) || '';
    const alerts = parseAlertmanager(params);
    if (!alerts.length) return res.status(400).json({ error: 'alerts 数组为空或缺失' });
    try {
      const deliveries = await Promise.all(alerts.map((alert) => sendWithAgentKey(repository, notifications, token, {
        title: alert.title.slice(0, 200),
        body: alert.body.slice(0, 20_000) || 'Empty Message',
        severity: alert.severity,
        url: alert.url,
        idempotencyKey: alert.fingerprint ? `alertmanager:${alert.fingerprint}:${alert.status}` : undefined,
        metadata: { via: 'alertmanager-compat', fingerprint: alert.fingerprint, status: alert.status }
      }, 'alertmanager-compat')));
      void worker.drainOnce().catch(() => undefined);
      res.status(200).json({ delivered: deliveries.length, ids: deliveries.map((delivery) => delivery.id) });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '推送失败' }); }
  }));

  // Pushover 兼容：POST /1/messages.json。token/user 任一作为 Agent Key（另一个忽略），
  // 返回 {"status":1,"request":"<uuid>"}。
  const pushoverCompat = asyncRoute(async (req, res) => {
    const params = { ...req.query, ...multipartFields(req), ...(req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}) };
    const token = String(params.token ?? '') || String(params.user ?? '');
    const message = String(params.message ?? '').trim();
    if (!message) return res.status(400).json({ status: 0, request: '', errors: ['message is required'] });
    try {
      const delivery = await sendWithAgentKey(repository, notifications, token, {
        title: (String(params.title ?? '') || 'Pushover').slice(0, 200),
        body: message.slice(0, 20_000),
        severity: prioritySeverity(params.priority, 'pushover'),
        url: safeCompatUrl(params.url),
        tags: String(params.device ?? '').slice(0, 200) || undefined,
        metadata: { via: 'pushover-compat', urlTitle: params.url_title, sound: params.sound, device: params.device }
      }, 'pushover-compat');
      void worker.drainOnce().catch(() => undefined);
      res.json({ status: 1, request: delivery.id });
    } catch (error) {
      res.status(400).json({ status: 0, request: '', errors: [error instanceof Error ? error.message : '推送失败'] });
    }
  });
  app.post('/1/messages.json', pushoverCompat);
  app.post('/1/messages', pushoverCompat);

  // Apprise API 兼容：POST /notify 或 /notify/<KEY>。body 必填，type 映射 severity，
  // 同时认 JSON 与表单（含 multipart）。
  app.post(/^\/notify(\/([A-Za-z0-9_\-]+))?$/, asyncRoute(async (req, res) => {
    const params = { ...multipartFields(req), ...(req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}) };
    const token = (req.params && typeof req.params[1] === 'string' ? String(req.params[1]) : '') || bearer(req) || '';
    const body = String(params.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'body is required' });
    try {
      const delivery = await sendWithAgentKey(repository, notifications, token, {
        title: (String(params.title ?? '') || 'Apprise').slice(0, 200),
        body: body.slice(0, 20_000),
        severity: appriseSeverity(params.type),
        tags: String(params.tag ?? '').slice(0, 200) || undefined,
        metadata: { via: 'apprise-compat', format: params.format, type: params.type, tag: params.tag }
      }, 'apprise-compat');
      void worker.drainOnce().catch(() => undefined);
      res.json({ error: null, kind: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '推送失败';
      res.status(400).json({ error: { kind: 'warning', message } });
    }
  }));

  const barkLegacy = asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const query = req.query as Record<string, unknown>;
    const params: Record<string, unknown> = { ...query, ...body };
    const key = String(req.params[0] ?? '');
    const pathParts = [req.params[1], req.params[2], req.params[3]].map((value) => value === undefined ? '' : String(value));
    params.device_key = key;
    if (pathParts[2]) { params.title = pathParts[0]; params.subtitle = pathParts[1]; params.body = pathParts[2]; }
    else if (pathParts[1]) { params.title = pathParts[0]; params.body = pathParts[1]; }
    else if (pathParts[0]) params.body = pathParts[0];
    try {
      await sendBark(notifications, repository, params);
      void worker.drainOnce().catch(() => undefined);
      res.json(barkSuccess());
    } catch (error) {
      res.status(400).json(barkFailure(400, error instanceof Error ? error.message : '推送失败'));
    }
  });
  const barkLegacyPattern = /^\/(?!api(?:\/|$)|mcp(?:\/|$)|reply(?:\/|$)|assets(?:\/|$)|send(?:\/|$)|health$|healthz$|info$|ping$|push$|register(?:\/|$)|[^/]*\.[^/]+$)([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/;
  app.get(barkLegacyPattern, barkLegacy);
  app.post(barkLegacyPattern, barkLegacy);

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
    // 未知的 /api/* 路径返回 404 JSON 而不是 SPA 页面（与 Workers 行为一致；API 客户端拿到 HTML 会误导排错）
    app.get('/api/{*splat}', (_req, res) => res.status(404).json({ error: 'Not found' }));
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
