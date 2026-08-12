import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z, ZodError } from 'zod';
import type { ApiKey, ProviderId } from '../shared/types.js';
import type { AppConfig } from './config.js';
import type { RelayRepository } from './database.js';
import { createRelayMcpServer } from './mcp.js';
import type { NotificationService } from './notifications.js';
import type { ProviderDispatcher } from './providers/dispatcher.js';
import { PROVIDERS, PROVIDER_MAP, validateProviderConfig } from './providers/catalog.js';
import type { DeliveryWorker } from './queue.js';

declare global {
  namespace Express { interface Request { agentKey?: ApiKey; auth?: AuthInfo } }
}

const slug = z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, '只允许小写字母、数字和连字符');
const channelSchema = z.object({ name: z.string().min(1).max(100), slug, provider: z.string(), enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()), rateLimitPerMin: z.number().int().min(0).max(600).nullish(), quietHours: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, '格式应为 HH:MM-HH:MM').or(z.literal('')).nullish() });
const routeSchema = z.object({ name: z.string().min(1).max(100), slug, strategy: z.enum(['fanout', 'fallback']), channelIds: z.array(z.string().uuid()).min(1), enabled: z.boolean().optional() });
const notificationSchema = z.object({ destination: z.string().min(1), title: z.string().min(1).max(200), body: z.string().min(1).max(20_000), severity: z.enum(['info', 'success', 'warning', 'critical']).optional(), url: z.url().optional(), tags: z.string().max(200).optional(), short: z.string().max(200).optional(), metadata: z.record(z.string(), z.unknown()).optional(), idempotencyKey: z.string().max(200).optional() });

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
  const mcpHandler = createMcpHandler(({ authInfo }) => {
    const apiKey = authInfo?.clientId ? repository.getKey(authInfo.clientId) : undefined;
    if (!apiKey || apiKey.revokedAt) throw new Error('无效或已吊销的 Agent API Key');
    return createRelayMcpServer(repository, notifications, apiKey);
  }, {
    legacy: 'stateless',
    responseMode: 'json',
    onerror: (error) => console.error('MCP request failed:', error.message)
  });
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => console.error('MCP adapter failed:', error.message)
  });
  app.locals.closeMcp = () => mcpHandler.close();

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!config.adminToken || bearer(req) === config.adminToken || req.header('x-admin-token') === config.adminToken) return next();
    res.status(401).json({ error: '需要管理令牌' });
  };
  const requireAgent = (req: Request, res: Response, next: NextFunction) => {
    const secret = bearer(req);
    const apiKey = secret ? repository.authenticateKey(secret) : undefined;
    if (!apiKey) return res.status(401).json({ error: '无效或已吊销的 Agent API Key' });
    req.agentKey = apiKey;
    req.auth = { token: secret!, clientId: apiKey.id, scopes: apiKey.scopes };
    next();
  };

  app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0', queue: 'running' }));
  app.get('/api/meta', (_req, res) => res.json({ name: 'RelayDock', version: '0.1.0', adminAuthRequired: Boolean(config.adminToken), mcpEndpoint: '/mcp' }));
  app.get('/api/admin/session', requireAdmin, (_req, res) => res.json({ authenticated: true }));

  const admin = express.Router();
  admin.use(requireAdmin);
  admin.get('/providers', (_req, res) => res.json({ providers: PROVIDERS }));
  admin.get('/stats', (_req, res) => res.json(repository.getDashboardStats()));
  admin.get('/destinations', (_req, res) => res.json({ destinations: repository.listDestinations() }));
  admin.get('/channels', (_req, res) => res.json({ channels: repository.listChannels() }));
  admin.post('/channels', (req, res) => {
    const input = channelSchema.parse(req.body);
    const provider = input.provider as ProviderId;
    if (!PROVIDER_MAP.has(provider)) throw new Error('不支持的渠道类型');
    const errors = validateProviderConfig(provider, input.config);
    if (errors.length) return res.status(400).json({ error: errors.join('；') });
    res.status(201).json(repository.createChannel({ ...input, provider }));
  });
  admin.patch('/channels/:id', (req, res) => {
    const input = channelSchema.partial().parse(req.body);
    const provider = input.provider as ProviderId | undefined;
    if (provider && !PROVIDER_MAP.has(provider)) throw new Error('不支持的渠道类型');
    res.json(repository.updateChannel(req.params.id, { ...input, provider }));
  });
  admin.delete('/channels/:id', (req, res) => { repository.deleteChannel(req.params.id); res.status(204).end(); });
  admin.post('/channels/:id/test', asyncRoute(async (req, res) => {
    const channel = repository.getChannel(String(req.params.id));
    if (!channel) return res.status(404).json({ error: '频道不存在' });
    try {
      await dispatcher.send(channel.provider, repository.getChannelConfig(channel.id), { title: 'RelayDock 测试通知', body: '频道连接正常，可以接收 Agent 通知。', severity: 'success', metadata: {} });
      repository.setChannelTest(channel.id, true);
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      repository.setChannelTest(channel.id, false, message);
      res.status(502).json({ error: message });
    }
  }));

  admin.get('/routes', (_req, res) => res.json({ routes: repository.listRoutes() }));
  admin.post('/routes', (req, res) => {
    const input = routeSchema.parse(req.body);
    const channels = new Set(repository.listChannels().map((channel) => channel.id));
    if (input.channelIds.some((id) => !channels.has(id))) return res.status(400).json({ error: '路由包含不存在的频道' });
    res.status(201).json(repository.createRoute(input));
  });
  admin.patch('/routes/:id', (req, res) => {
    const input = routeSchema.partial().parse(req.body);
    const channels = new Set(repository.listChannels().map((channel) => channel.id));
    if (input.channelIds?.some((id) => !channels.has(id))) return res.status(400).json({ error: '路由包含不存在的频道' });
    res.json(repository.updateRoute(String(req.params.id), input));
  });
  admin.delete('/routes/:id', (req, res) => { repository.deleteRoute(req.params.id); res.status(204).end(); });

  admin.get('/keys', (_req, res) => res.json({ keys: repository.listKeys() }));
  admin.post('/keys', (req, res) => {
    const input = z.object({ name: z.string().min(1).max(100), scopes: z.array(z.enum(['notifications:send', 'deliveries:read'])).min(1).optional(), destinationIds: z.array(z.string()).optional() }).parse(req.body);
    res.status(201).json(repository.createKey(input));
  });
  admin.post('/keys/:id/revoke', (req, res) => { repository.revokeKey(req.params.id); res.json({ success: true }); });

  admin.get('/deliveries', (req, res) => res.json({ deliveries: repository.listDeliveries({ limit: Number(req.query.limit ?? 100), status: typeof req.query.status === 'string' ? req.query.status : undefined }) }));
  admin.get('/deliveries/:id', (req, res) => {
    const delivery = repository.getDelivery(String(req.params.id));
    if (!delivery) return res.status(404).json({ error: '投递不存在' });
    res.json(delivery);
  });
  admin.post('/send', (req, res) => {
    const delivery = notifications.send(notificationSchema.parse(req.body), 'admin');
    void worker.drainOnce();
    res.status(202).json(delivery);
  });
  admin.post('/queue/drain', asyncRoute(async (_req, res) => res.json({ processed: await worker.drainOnce() })));
  app.use('/api/admin', admin);

  app.post('/api/v1/notify', requireAgent, (req, res) => {
    const delivery = notifications.send(notificationSchema.parse(req.body), `agent:${req.agentKey!.id}`, req.agentKey);
    void worker.drainOnce();
    res.status(202).json({ deliveryId: delivery.id, status: delivery.status, createdAt: delivery.createdAt });
  });
  app.get('/api/v1/deliveries/:id', requireAgent, (req, res) => res.json(notifications.getDelivery(String(req.params.id), req.agentKey)));

  // Server酱兼容入口：GET/POST /{key}.send 或 /send/{key}.send，key 为 Agent API Key。
  // 参数 title/text、desp、tags、short 与 Server酱³ 一致；destination 指定目的地（Key 白名单只有一个时可省略）。
  const serverchanCompat = (req: Request, res: Response) => {
    const apiKey = repository.authenticateKey(String(req.params[0]));
    if (!apiKey) return res.status(401).json({ code: 40001, message: '无效或已吊销的 SendKey', data: {} });
    const params: Record<string, unknown> = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
    const title = String(params.title ?? params.text ?? '').trim();
    const desp = String(params.desp ?? '').trim();
    if (!title && !desp) return res.status(400).json({ code: 40003, message: 'title 或 desp 至少填写一项', data: {} });
    const destination = String(params.destination ?? '').trim() || (apiKey.destinationIds.length === 1 ? apiKey.destinationIds[0] : '');
    if (!destination) return res.status(400).json({ code: 40002, message: '请用 destination 参数指定目的地，或为该 Key 只配置一个目的地', data: {} });
    try {
      const delivery = notifications.send({
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
  };
  app.get(/^\/(?:send\/)?(rdk_[a-f0-9]{8}_[A-Za-z0-9_-]+)\.send$/, serverchanCompat);
  app.post(/^\/(?:send\/)?(rdk_[a-f0-9]{8}_[A-Za-z0-9_-]+)\.send$/, serverchanCompat);

  app.post('/mcp', requireAgent, asyncRoute(async (req, res) => {
    await nodeMcpHandler(req, res, req.body);
  }));

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
