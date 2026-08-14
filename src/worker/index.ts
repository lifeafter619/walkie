import { DurableObject } from 'cloudflare:workers';
import { resolve4, resolve6 } from 'node:dns/promises';
import { Buffer } from 'node:buffer';
import { ZodError } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { ApiKey, ProviderId } from '../shared/types.js';
import { askSchema, channelSchema, credentialTokenSchema, keySchema, notificationSchema, routeSchema } from '../shared/schemas.js';
import { RelayRepository } from '../server/database.js';
import { generateAdminToken, safeSecretEqual, safeTokenEqual } from '../server/crypto.js';
import { createRelayMcpHandler } from '../server/mcp.js';
import { renderReplyForm, renderReplyResult } from '../server/reply-page.js';
import { NotificationService } from '../server/notifications.js';
import { PROVIDERS, PROVIDER_MAP, validateProviderConfig } from '../server/providers/catalog.js';
import { ProviderDispatcher } from '../server/providers/dispatcher.js';
import { DeliveryWorker } from '../server/queue.js';
import { BodyTooLargeError, readBody } from './body.js';
import { DurableRelayDatabase } from './database.js';

type WorkerEnv = Env & {
  ADMIN_TOKEN?: string;
  MASTER_KEY?: string;
  DELIVERY_WORKERS?: string;
  MAX_DELIVERY_ATTEMPTS?: string;
  RETRY_BASE_MS?: string;
  MAX_SENDS_PER_MIN?: string;
};

const json = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, { status, headers });
const bearer = (request: Request) => /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
const integer = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const enabled = (value: string | undefined) => value === 'true' || value === '1';

async function resolveHost(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => [])
  ]);
  return [...v4, ...v6];
}

export class RelayDockState extends DurableObject<WorkerEnv> {
  private readonly repository: RelayRepository;
  private readonly notifications: NotificationService;
  private readonly dispatcher: ProviderDispatcher;
  private readonly worker: DeliveryWorker;
  private readonly mcp: ReturnType<typeof createRelayMcpHandler>;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    if (!env.MASTER_KEY) throw new Error('MASTER_KEY secret is required');
    const key = Buffer.from(env.MASTER_KEY, 'base64');
    if (key.length !== 32) throw new Error('MASTER_KEY must be a base64-encoded 32-byte key');
    this.repository = new RelayRepository(new DurableRelayDatabase(ctx.storage), key);
    ctx.blockConcurrencyWhile(() => this.repository.init());
    this.dispatcher = new ProviderDispatcher({
      allowPrivateWebhooks: enabled(env.ALLOW_PRIVATE_WEBHOOKS),
      allowInsecureHttp: enabled(env.ALLOW_INSECURE_HTTP)
    }, fetch, resolveHost);
    this.worker = new DeliveryWorker(this.repository, this.dispatcher, {
      deliveryWorkers: integer(env.DELIVERY_WORKERS, 2, 1, 16),
      maxDeliveryAttempts: integer(env.MAX_DELIVERY_ATTEMPTS, 4, 1, 10),
      retryBaseMs: integer(env.RETRY_BASE_MS, 2000, 100, 60_000),
      maxSendsPerMin: integer(env.MAX_SENDS_PER_MIN, 0, 0, 100_000)
    });
    this.notifications = new NotificationService(this.repository, () => ctx.waitUntil(this.drainAndSchedule()));
    this.mcp = createRelayMcpHandler(this.repository, this.notifications, (request) => request ? new URL(request.url).origin : '');
  }

  async alarm(): Promise<void> {
    await this.drainAndSchedule();
  }

  private async drainAndSchedule(): Promise<void> {
    await this.worker.drainOnce();
    const due = await this.repository.nextDueAttempt();
    if (due) await this.ctx.storage.setAlarm(Math.max(Date.now() + 250, new Date(due).getTime()));
  }

  private async requireAdmin(request: Request): Promise<Response | undefined> {
    if (!this.env.ADMIN_TOKEN) return json({ error: 'ADMIN_TOKEN secret is required' }, 503);
    if (safeTokenEqual(bearer(request), this.env.ADMIN_TOKEN) || safeTokenEqual(request.headers.get('x-admin-token') ?? undefined, this.env.ADMIN_TOKEN)) return;
    // 数据库轮换令牌：存的是 sha256 哈希，用 safeSecretEqual 比较（与 Agent Key 同模型）
    const rotated = await this.repository.getAdminTokenHash();
    if (rotated.hash) {
      const provided = bearer(request) ?? request.headers.get('x-admin-token') ?? undefined;
      if (provided && safeSecretEqual(provided, rotated.hash)) return;
    }
    return json({ error: '需要管理令牌' }, 401);
  }

  private async authenticateAgent(request: Request): Promise<{ apiKey: ApiKey; authInfo: AuthInfo } | Response> {
    const token = bearer(request);
    const apiKey = token ? await this.repository.authenticateKey(token) : undefined;
    if (!token || !apiKey) return json({ error: '无效或已吊销的 Agent API Key' }, 401, { 'www-authenticate': 'Bearer realm="RelayDock"' });
    return { apiKey, authInfo: { token, clientId: apiKey.id, scopes: apiKey.scopes } };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/health' && request.method === 'GET') return json({ status: 'ok', version: '0.2.0', runtime: 'cloudflare-workers', queue: 'alarm' });
      if (path === '/api/meta' && request.method === 'GET') return json({
        name: 'RelayDock', version: '0.2.0', runtime: 'cloudflare-workers', adminAuthRequired: true,
        publicUrl: url.origin, mcpEndpoint: '/mcp', mcpUrl: `${url.origin}/mcp`
      });

      if (path === '/mcp') {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
        const agent = await this.authenticateAgent(request);
        if (agent instanceof Response) return agent;
        return this.mcp.fetch(request, { authInfo: agent.authInfo });
      }

      if (path === '/api/v1/notify' && request.method === 'POST') {
        const agent = await this.authenticateAgent(request);
        if (agent instanceof Response) return agent;
        const delivery = await this.notifications.send(notificationSchema.parse(await readBody(request)), `agent:${agent.apiKey.id}`, agent.apiKey);
        return json({ deliveryId: delivery.id, status: delivery.status, createdAt: delivery.createdAt }, 202);
      }
      const agentDelivery = /^\/api\/v1\/deliveries\/([^/]+)$/.exec(path);
      if (agentDelivery && request.method === 'GET') {
        const agent = await this.authenticateAgent(request);
        if (agent instanceof Response) return agent;
        return json(await this.notifications.getDelivery(agentDelivery[1], agent.apiKey));
      }

      if (path === '/api/v1/ask' && request.method === 'POST') {
        const agent = await this.authenticateAgent(request);
        if (agent instanceof Response) return agent;
        const input = askSchema.parse(await readBody(request));
        const asked = await this.notifications.ask(input, `agent:${agent.apiKey.id}`, agent.apiKey, url.origin);
        return json({ conversationId: asked.conversation.id, deliveryId: asked.deliveryId, replyUrl: asked.replyUrl, expiresAt: asked.conversation.expiresAt }, 201);
      }
      const conversationStatus = /^\/api\/v1\/conversations\/([^/]+)$/.exec(path);
      if (conversationStatus && request.method === 'GET') {
        const agent = await this.authenticateAgent(request);
        if (agent instanceof Response) return agent;
        const { status, conversation } = await this.notifications.conversationStatus(conversationStatus[1], agent.apiKey);
        return json({ status, reply: conversation.reply, repliedAt: conversation.repliedAt, expiresAt: conversation.expiresAt });
      }

      const reply = /^\/reply\/([^/]+)\/([^/]+)$/.exec(path);
      if (reply) {
        const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (request.method === 'GET') {
          const conversation = await this.repository.getConversationForReply(reply[1], reply[2]);
          const usable = conversation && !conversation.repliedAt && conversation.expiresAt > new Date().toISOString();
          return html(usable ? renderReplyForm(conversation.question, conversation.options) : renderReplyResult('gone'), usable ? 200 : 410);
        }
        if (request.method === 'POST') {
          const bodyParams = await readBody(request);
          const text = String(bodyParams.reply ?? bodyParams.replyText ?? '').trim().slice(0, 4000);
          if (!text) return html(renderReplyResult('gone'), 400);
          const accepted = await this.repository.replyConversation(reply[1], text, 'reply-link', reply[2]);
          return html(renderReplyResult(accepted ? 'done' : 'gone'), accepted ? 200 : 410);
        }
      }

      const compat = /^\/(?:send\/)?(rdk_[a-f0-9]{8}_[A-Za-z0-9_-]+)\.send$/.exec(path);
      if (compat && ['GET', 'POST'].includes(request.method)) return this.serverchan(request, compat[1]);

      if (!path.startsWith('/api/admin')) return json({ error: 'Not found' }, 404);
      const denied = await this.requireAdmin(request);
      if (denied) return denied;
      return this.admin(request, url);
    } catch (error) {
      const message = error instanceof ZodError
        ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')
        : error instanceof Error ? error.message : '未知错误';
      const status = error instanceof BodyTooLargeError ? 413 : /not found|不存在/i.test(message) ? 404 : /UNIQUE constraint failed/.test(message) ? 409 : 400;
      console.error(JSON.stringify({ event: 'request.error', message }));
      return json({ error: message }, status);
    }
  }

  private async admin(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === '/api/admin/session' && request.method === 'GET') return json({ authenticated: true });
    if (path === '/api/admin/providers' && request.method === 'GET') return json({ providers: PROVIDERS });
    if (path === '/api/admin/stats' && request.method === 'GET') return json(await this.repository.getDashboardStats());
    if (path === '/api/admin/destinations' && request.method === 'GET') return json({ destinations: await this.repository.listDestinations() });
    if (path === '/api/admin/channels' && request.method === 'GET') return json({ channels: await this.repository.listChannels() });
    if (path === '/api/admin/channels' && request.method === 'POST') {
      const input = channelSchema.parse(await readBody(request));
      const provider = input.provider as ProviderId;
      if (!PROVIDER_MAP.has(provider)) throw new Error('不支持的渠道类型');
      const errors = validateProviderConfig(provider, input.config);
      if (errors.length) return json({ error: errors.join('；') }, 400);
      return json(await this.repository.createChannel({ ...input, provider }), 201);
    }
    const channel = /^\/api\/admin\/channels\/([^/]+)$/.exec(path);
    if (channel && request.method === 'PATCH') {
      const input = channelSchema.partial().parse(await readBody(request));
      const provider = input.provider as ProviderId | undefined;
      if (provider && !PROVIDER_MAP.has(provider)) throw new Error('不支持的渠道类型');
      return json(await this.repository.updateChannel(channel[1], { ...input, provider }));
    }
    if (channel && request.method === 'DELETE') { await this.repository.deleteChannel(channel[1]); return new Response(null, { status: 204 }); }
    const testChannel = /^\/api\/admin\/channels\/([^/]+)\/test$/.exec(path);
    if (testChannel && request.method === 'POST') {
      const item = await this.repository.getChannel(testChannel[1]);
      if (!item) return json({ error: '频道不存在' }, 404);
      try {
        await this.dispatcher.send(item.provider, await this.repository.getChannelConfig(item.id), { title: 'RelayDock 测试通知', body: '频道连接正常，可以接收 Agent 通知。', severity: 'success', metadata: {} });
        await this.repository.setChannelTest(item.id, true);
        return json({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.repository.setChannelTest(item.id, false, message);
        return json({ error: message }, 502);
      }
    }

    if (path === '/api/admin/routes' && request.method === 'GET') return json({ routes: await this.repository.listRoutes() });
    if (path === '/api/admin/routes' && request.method === 'POST') {
      const input = routeSchema.parse(await readBody(request));
      await this.assertChannels(input.channelIds);
      return json(await this.repository.createRoute(input), 201);
    }
    const route = /^\/api\/admin\/routes\/([^/]+)$/.exec(path);
    if (route && request.method === 'PATCH') {
      const input = routeSchema.partial().parse(await readBody(request));
      if (input.channelIds) await this.assertChannels(input.channelIds);
      return json(await this.repository.updateRoute(route[1], input));
    }
    if (route && request.method === 'DELETE') { await this.repository.deleteRoute(route[1]); return new Response(null, { status: 204 }); }

    if (path === '/api/admin/keys' && request.method === 'GET') return json({ keys: await this.repository.listKeys() });
    if (path === '/api/admin/keys' && request.method === 'POST') return json(await this.repository.createKey(keySchema.parse(await readBody(request))), 201);
    const revoke = /^\/api\/admin\/keys\/([^/]+)\/revoke$/.exec(path);
    if (revoke && request.method === 'POST') { await this.repository.revokeKey(revoke[1]); return json({ success: true }); }

    if (path === '/api/admin/credentials' && request.method === 'GET') return json(await this.repository.getCredentialStatus(Boolean(this.env.ADMIN_TOKEN)));
    if (path === '/api/admin/credentials/admin-token' && request.method === 'POST') {
      const input = credentialTokenSchema.parse(await readBody(request));
      const token = input.token ?? generateAdminToken();
      await this.repository.setAdminToken(token);
      return json({ token }, 201);
    }
    if (path === '/api/admin/credentials/master-key/rotate' && request.method === 'POST') return json(await this.repository.rotateMasterKey());

    if (path === '/api/admin/deliveries' && request.method === 'GET') return json({ deliveries: await this.repository.listDeliveries({ limit: Number(url.searchParams.get('limit') ?? 100), status: url.searchParams.get('status') ?? undefined }) });
    const delivery = /^\/api\/admin\/deliveries\/([^/]+)$/.exec(path);
    if (delivery && request.method === 'GET') {
      const item = await this.repository.getDelivery(delivery[1]);
      return item ? json(item) : json({ error: '投递不存在' }, 404);
    }
    if (path === '/api/admin/send' && request.method === 'POST') return json(await this.notifications.send(notificationSchema.parse(await readBody(request)), 'admin'), 202);
    if (path === '/api/admin/queue/drain' && request.method === 'POST') {
      const processed = await this.worker.drainOnce();
      await this.drainAndSchedule();
      return json({ processed });
    }
    if (path === '/api/admin/conversations' && request.method === 'GET') {
      return json({ conversations: await this.repository.listConversations({ pendingOnly: url.searchParams.get('pending') === '1', limit: Number(url.searchParams.get('limit') ?? 50) }) });
    }
    const adminReply = /^\/api\/admin\/conversations\/([^/]+)\/reply$/.exec(path);
    if (adminReply && request.method === 'POST') {
      const text = String((await readBody(request)).reply ?? '').trim().slice(0, 4000);
      if (!text) return json({ error: '回复内容不能为空' }, 400);
      const accepted = await this.repository.replyConversation(adminReply[1], text, 'admin');
      return accepted ? json({ success: true }) : json({ error: '会话已回复或已过期' }, 409);
    }
    return json({ error: 'Not found' }, 404);
  }

  private async assertChannels(ids: string[]): Promise<void> {
    const channels = new Set((await this.repository.listChannels()).map((item) => item.id));
    if (ids.some((id) => !channels.has(id))) throw new Error('路由包含不存在的频道');
  }

  private async serverchan(request: Request, secret: string): Promise<Response> {
    const apiKey = await this.repository.authenticateKey(secret);
    if (!apiKey) return json({ code: 40001, message: '无效或已吊销的 SendKey', data: {} }, 401);
    const params = { ...Object.fromEntries(new URL(request.url).searchParams), ...(request.method === 'POST' ? await readBody(request) : {}) };
    const title = String(params.title ?? params.text ?? '').trim();
    const desp = String(params.desp ?? '').trim();
    if (!title && !desp) return json({ code: 40003, message: 'title 或 desp 至少填写一项', data: {} }, 400);
    const destination = String(params.destination ?? '').trim() || (apiKey.destinationIds.length === 1 ? apiKey.destinationIds[0] : '');
    if (!destination) return json({ code: 40002, message: '请用 destination 参数指定目的地，或为该 Key 只配置一个目的地', data: {} }, 400);
    const delivery = await this.notifications.send({
      destination, title: (title || desp).slice(0, 200), body: (desp || title).slice(0, 20_000), severity: 'info',
      tags: typeof params.tags === 'string' ? params.tags.slice(0, 200) : undefined,
      short: typeof params.short === 'string' ? params.short.slice(0, 200) : undefined,
      metadata: { via: 'serverchan-compat' }
    }, `agent:${apiKey.id}`, apiKey);
    return json({ code: 0, message: '', data: { pushid: delivery.id, readkey: '', error: 'SUCCESS', errno: 0 } });
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' || path === '/mcp' || path.startsWith('/api/') || path.startsWith('/reply/') || /^\/(?:send\/)?rdk_.*\.send$/.test(path)) {
      return env.RELAYDOCK.getByName('default').fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<WorkerEnv>;
