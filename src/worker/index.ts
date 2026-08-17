import { DurableObject } from 'cloudflare:workers';
import { resolve4, resolve6 } from 'node:dns/promises';
import { Buffer } from 'node:buffer';
import { ZodError } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { ApiKey, ProviderId } from '../shared/types.js';
import { VERSION } from '../shared/version.js';
import { askSchema, channelSchema, credentialTokenSchema, keySchema, keyUpdateSchema, notificationSchema, retentionSchema, routeSchema } from '../shared/schemas.js';
import { RelayRepository } from '../server/database.js';
import { generateAdminToken, safeSecretEqual, safeTokenEqual } from '../server/crypto.js';
import { createRelayMcpHandler } from '../server/mcp.js';
import { renderReplyForm, renderReplyResult } from '../server/reply-page.js';
import { NotificationService } from '../server/notifications.js';
import { PROVIDERS } from '../server/providers/catalog.js';
import { ProviderDispatcher } from '../server/providers/dispatcher.js';
import { DeliveryWorker } from '../server/queue.js';
import { assertKeyDestinations, validateChannelCreate, validateChannelUpdate, validateRouteChannelIds } from '../server/validation.js';
import { BodyTooLargeError, readBody } from './body.js';
import { DurableRelayDatabase } from './database.js';

type WorkerEnv = Env & {
  ADMIN_TOKEN?: string;
  MASTER_KEY?: string;
  DELIVERY_WORKERS?: string;
  MAX_DELIVERY_ATTEMPTS?: string;
  RETRY_BASE_MS?: string;
  MAX_SENDS_PER_MIN?: string;
  UPDATE_REPO?: string;
};

const json = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, { status, headers });
const bearer = (request: Request) => /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
const integer = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const enabled = (value: string | undefined) => value === 'true' || value === '1';
const isSemver = (version: string): boolean => /^\d+\.\d+\.\d+$/.test(version);
const isNewerVersion = (candidate: string, current: string): boolean => {
  // 仅在双方都是合法语义化版本（X.Y.Z）时才比较，拒绝 "latest"、日期、预发布标签等
  if (!isSemver(candidate) || !isSemver(current)) return false;
  const left = candidate.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = current.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

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
    this.mcp = createRelayMcpHandler(this.repository, this.notifications, this.dispatcher, (request) => request ? new URL(request.url).origin : '');
  }

  async alarm(): Promise<void> {
    await this.drainAndSchedule();
    // 数据保留清理挂在 alarm 上（幂等，retention 全 0 时零开销）。空闲实例无 alarm，
    // 但空闲时也无新数据产生；下一次活动触发 alarm 后过期行自然被清
    try { await this.repository.purgeExpiredData(); }
    catch (error) { console.error(JSON.stringify({ event: 'retention.purge.failed', message: error instanceof Error ? error.message : String(error) })); }
  }

  private async drainAndSchedule(): Promise<void> {
    // drain 前先设临时兜底 alarm：isolate 中途被逐时仍有定时器能回来收拾残局
    // （正常结束后会被下面的精确时间覆盖；空闲路径不设，避免永久 6 分钟心跳）
    if (await this.repository.nextDueAttempt()) await this.ctx.storage.setAlarm(Date.now() + 6 * 60_000);
    try { await this.worker.drainOnce(); }
    catch (error) { console.error(JSON.stringify({ event: 'drain.error', message: error instanceof Error ? error.message : String(error) })); }
    const due = await this.repository.nextDueAttempt();
    // 存在滞留 sending（drain 中途异常/isolate 被逐）时设 6 分钟兜底 alarm：
    // nextDueAttempt 不看 sending，不设的话单频道投递会无限期卡在 processing；
    // 6 分钟 > claimDueAttempts 的 5 分钟回收阈值，触发时必然可回收
    const stuck = await this.repository.hasStuckSending();
    if (due) await this.ctx.storage.setAlarm(Math.max(Date.now() + 250, new Date(due).getTime()));
    else if (stuck) await this.ctx.storage.setAlarm(Date.now() + 6 * 60_000);
  }

  private async requireAdmin(request: Request): Promise<Response | undefined> {
    const provided = bearer(request) ?? request.headers.get('x-admin-token') ?? undefined;
    if (this.env.ADMIN_TOKEN && provided && safeTokenEqual(provided, this.env.ADMIN_TOKEN)) return;
    // 数据库轮换令牌：存的是 sha256 哈希，用 safeSecretEqual 比较（与 Agent Key 同模型）。
    // env ADMIN_TOKEN 缺失时轮换令牌也必须可用，否则轮换后重新部署会把管理员锁死。
    const rotated = await this.repository.getAdminTokenHash();
    if (rotated.hash && provided && safeSecretEqual(provided, rotated.hash)) return;
    if (!this.env.ADMIN_TOKEN && !rotated.hash) return json({ error: 'ADMIN_TOKEN secret is required' }, 503);
    return json({ error: '管理密码不正确' }, 401);
  }

  private async authenticateAgent(request: Request): Promise<{ apiKey: ApiKey; authInfo: AuthInfo } | Response> {
    const token = bearer(request);
    const apiKey = token ? await this.repository.authenticateKey(token) : undefined;
    if (!token || !apiKey) return json({ error: '无效或已吊销的 Agent API Key' }, 401, { 'www-authenticate': 'Bearer realm="Walkie"' });
    return { apiKey, authInfo: { token, clientId: apiKey.id, scopes: apiKey.scopes } };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/health' && request.method === 'GET') return json({ status: 'ok', version: VERSION, runtime: 'cloudflare-workers', queue: 'alarm' });
      if (path === '/api/meta' && request.method === 'GET') {
        const rotated = await this.repository.getAdminTokenHash();
        return json({
          name: 'Walkie', version: VERSION, runtime: 'cloudflare-workers',
          adminAuthRequired: Boolean(this.env.ADMIN_TOKEN) || Boolean(rotated.hash),
          publicUrl: url.origin, mcpEndpoint: '/mcp', mcpUrl: `${url.origin}/mcp`
        });
      }

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
          if (!text) {
            // 空提交时链接仍有效，重新渲染表单并提示，而不是误报「链接已失效」把人劝退（与 Node 版一致）
            const conversation = await this.repository.getConversationForReply(reply[1], reply[2]);
            const usable = conversation && !conversation.repliedAt && conversation.expiresAt > new Date().toISOString();
            return html(usable ? renderReplyForm(conversation.question, conversation.options, '回复内容不能为空，请输入后再发送。') : renderReplyResult('gone'), usable ? 400 : 410);
          }
          const accepted = await this.repository.replyConversation(reply[1], text, 'reply-link', reply[2]);
          return html(renderReplyResult(accepted ? 'done' : 'gone'), accepted ? 200 : 410);
        }
      }

      const compat = /^\/(?:send\/)?([^/]+)\.send$/.exec(path);
      if (compat && ['GET', 'POST'].includes(request.method)) {
        let key = compat[1];
        try { key = decodeURIComponent(key); } catch { /* 保留原样 */ }
        return this.serverchan(request, key);
      }

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
      const errors = validateChannelCreate(input.provider, input.config);
      if (errors.length) return json({ error: errors.join('；') }, 400);
      return json(await this.repository.createChannel({ ...input, provider: input.provider as ProviderId }), 201);
    }
    const channel = /^\/api\/admin\/channels\/([^/]+)$/.exec(path);
    if (channel && request.method === 'PATCH') {
      const input = channelSchema.partial().parse(await readBody(request));
      // PATCH 换 provider/改 config 后重新校验必填字段（与 Node 版一致）
      if (input.config || input.provider) {
        const { current, errors } = await validateChannelUpdate(this.repository, channel[1], input);
        if (errors[0] === '频道不存在') return json({ error: '频道不存在' }, 404);
        if (errors.length) return json({ error: errors.join('；') }, 400);
        return json(await this.repository.updateChannel(current!.id, { ...input, provider: input.provider as ProviderId }));
      }
      return json(await this.repository.updateChannel(channel[1], { ...input, provider: input.provider as ProviderId }));
    }
    if (channel && request.method === 'DELETE') { await this.repository.deleteChannel(channel[1]); return new Response(null, { status: 204 }); }
    const testChannel = /^\/api\/admin\/channels\/([^/]+)\/test$/.exec(path);
    if (testChannel && request.method === 'POST') {
      const item = await this.repository.getChannel(testChannel[1]);
      if (!item) return json({ error: '频道不存在' }, 404);
      try {
        await this.dispatcher.send(item.provider, await this.repository.getChannelConfig(item.id), { title: 'Walkie 测试通知', body: '频道连接正常，可以接收 Agent 通知。', severity: 'success', metadata: {} });
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
      const errors = await validateRouteChannelIds(this.repository, input.channelIds);
      if (errors.length) return json({ error: errors.join('；') }, 400);
      return json(await this.repository.createRoute(input), 201);
    }
    const route = /^\/api\/admin\/routes\/([^/]+)$/.exec(path);
    if (route && request.method === 'PATCH') {
      const input = routeSchema.partial().parse(await readBody(request));
      if (input.channelIds) {
        const errors = await validateRouteChannelIds(this.repository, input.channelIds);
        if (errors.length) return json({ error: errors.join('；') }, 400);
      }
      return json(await this.repository.updateRoute(route[1], input));
    }
    if (route && request.method === 'DELETE') { await this.repository.deleteRoute(route[1]); return new Response(null, { status: 204 }); }

    if (path === '/api/admin/keys' && request.method === 'GET') return json({ keys: await this.repository.listKeys() });
    if (path === '/api/admin/keys' && request.method === 'POST') {
      const input = keySchema.parse(await readBody(request));
      if (input.destinationIds?.length) {
        const errors = await assertKeyDestinations(this.repository, input.destinationIds);
        if (errors.length) return json({ error: errors.join('；') }, 400);
      }
      return json(await this.repository.createKey(input), 201);
    }
    const revoke = /^\/api\/admin\/keys\/([^/]+)\/revoke$/.exec(path);
    if (revoke && request.method === 'POST') { await this.repository.revokeKey(revoke[1]); return json({ success: true }); }
    const restore = /^\/api\/admin\/keys\/([^/]+)\/restore$/.exec(path);
    if (restore && request.method === 'POST') { await this.repository.restoreKey(restore[1]); return json({ success: true }); }
    const patchKey = /^\/api\/admin\/keys\/([^/]+)$/.exec(path);
    if (patchKey && request.method === 'PATCH') {
      const input = keyUpdateSchema.parse(await readBody(request));
      if (input.destinationIds) {
        const errors = await assertKeyDestinations(this.repository, input.destinationIds);
        if (errors.length) return json({ error: errors.join('；') }, 400);
      }
      return json(await this.repository.updateKey(patchKey[1], input));
    }
    const deleteKey = /^\/api\/admin\/keys\/([^/]+)$/.exec(path);
    if (deleteKey && request.method === 'DELETE') { await this.repository.deleteKey(deleteKey[1]); return new Response(null, { status: 204 }); }

    if (path === '/api/admin/credentials' && request.method === 'GET') return json(await this.repository.getCredentialStatus(Boolean(this.env.ADMIN_TOKEN)));
    if (path === '/api/admin/credentials/admin-token' && request.method === 'POST') {
      const input = credentialTokenSchema.parse(await readBody(request));
      const token = input.token ?? generateAdminToken();
      await this.repository.setAdminToken(token);
      return json({ token }, 201);
    }
    if (path === '/api/admin/credentials/master-key/rotate' && request.method === 'POST') return json(await this.repository.rotateMasterKey());

    if (path === '/api/admin/audit' && request.method === 'GET') {
      return json({ events: await this.repository.listAuditEvents({
        limit: Number(url.searchParams.get('limit') ?? 100),
        actor: url.searchParams.get('actor') || undefined,
        action: url.searchParams.get('action') || undefined
      }) });
    }

    if (path === '/api/admin/retention' && request.method === 'GET') return json(await this.repository.getRetention());
    if (path === '/api/admin/retention' && request.method === 'PUT') return json(await this.repository.setRetention(retentionSchema.parse(await readBody(request))));
    if (path === '/api/admin/retention/purge' && request.method === 'POST') return json(await this.repository.purgeExpiredData());

    if (path === '/api/admin/update/check' && request.method === 'GET') {
      const repo = this.env.UPDATE_REPO ?? 'lifeafter619/walkie';
      const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
      try {
        const response = await fetch(apiUrl, { headers: { 'user-agent': 'walkie-update-checker', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return json({ currentVersion: VERSION, latestVersion: VERSION, hasUpdate: false, canApply: false, applyHint: `无法获取版本信息（HTTP ${response.status}）。请确认 UPDATE_REPO 环境变量是否正确指向 GitHub 仓库。` });
        const release = await response.json() as { tag_name: string; html_url: string; body?: string };
        const latestVersion = release.tag_name.replace(/^v/, '');
        const hasUpdate = isNewerVersion(latestVersion, VERSION);
        return json({ currentVersion: VERSION, latestVersion, hasUpdate, releaseNotes: release.body?.slice(0, 500), releaseUrl: release.html_url, canApply: false, applyHint: 'Cloudflare Workers 不支持应用内更新，请运行 npm run deploy:cf 重新部署。' });
      } catch (error) {
        return json({ currentVersion: VERSION, latestVersion: VERSION, hasUpdate: false, canApply: false, applyHint: `检查更新失败：${error instanceof Error ? error.message : '网络错误'}` });
      }
    }
    if (path === '/api/admin/update/apply' && request.method === 'POST') {
      // Cloudflare Workers 不支持应用内更新；明确拒绝以防前端误调用
      return json({ success: false, message: 'Cloudflare Workers 不支持应用内更新，请运行 npm run deploy:cf 重新部署。', needsRestart: false });
    }

    if (path === '/api/admin/deliveries' && request.method === 'GET') return json({ deliveries: await this.repository.listDeliveries({
      limit: Number(url.searchParams.get('limit') ?? 100),
      status: url.searchParams.get('status') ?? undefined,
      q: url.searchParams.get('q') || undefined,
      before: url.searchParams.get('before') || undefined
    }) });
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

  private async serverchan(request: Request, secret: string): Promise<Response> {
    const apiKey = await this.repository.authenticateKey(secret);
    if (!apiKey) return json({ code: 40001, message: '无效或已吊销的 SendKey', data: {} }, 401);
    const params = { ...Object.fromEntries(new URL(request.url).searchParams), ...(request.method === 'POST' ? await readBody(request) : {}) };
    const title = String(params.title ?? params.text ?? '').trim();
    const desp = String(params.desp ?? '').trim();
    if (!title && !desp) return json({ code: 40003, message: 'title 或 desp 至少填写一项', data: {} }, 400);
    const destination = String(params.destination ?? '').trim() || (apiKey.destinationIds.length === 1 ? apiKey.destinationIds[0] : '');
    if (!destination) return json({ code: 40002, message: '请用 destination 参数指定目的地，或为该 Key 只配置一个目的地', data: {} }, 400);
    try {
      const delivery = await this.notifications.send({
        destination, title: (title || desp).slice(0, 200), body: (desp || title).slice(0, 20_000), severity: 'info',
        tags: typeof params.tags === 'string' ? params.tags.slice(0, 200) : undefined,
        short: typeof params.short === 'string' ? params.short.slice(0, 200) : undefined,
        metadata: { via: 'serverchan-compat' }
      }, `agent:${apiKey.id}`, apiKey);
      return json({ code: 0, message: '', data: { pushid: delivery.id, readkey: '', error: 'SUCCESS', errno: 0 } });
    } catch (error) {
      return json({ code: 40004, message: error instanceof Error ? error.message : '发送失败', data: {} }, 400);
    }
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' || path === '/mcp' || path.startsWith('/api/') || path.startsWith('/reply/') || /^\/(?:send\/)?[^/]+\.send$/.test(path)) {
      return env.WALKIE.getByName('default').fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<WorkerEnv>;
