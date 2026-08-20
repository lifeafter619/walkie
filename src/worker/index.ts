import { DurableObject } from 'cloudflare:workers';
import { resolve4, resolve6 } from 'node:dns/promises';
import { Buffer } from 'node:buffer';
import { ZodError } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { ApiKey, ProviderId } from '../shared/types.js';
import { VERSION } from '../shared/version.js';
import { askSchema, channelSchema, credentialTokenSchema, keySchema, keyUpdateSchema, notificationSchema, platformUsageSchema, retentionSchema, routeSchema, usageSettingsSchema } from '../shared/schemas.js';
import { RelayRepository } from '../server/database.js';
import { generateAdminToken, safeTokenEqual } from '../server/crypto.js';
import { COMPATIBILITY_ENDPOINTS, PLATFORM_PROFILES } from '../shared/platform.js';
import { createRelayMcpHandler } from '../server/mcp.js';
import { renderReplyForm, renderReplyResult } from '../server/reply-page.js';
import { NotificationService } from '../server/notifications.js';
import { PROVIDERS } from '../server/providers/catalog.js';
import { ProviderDispatcher } from '../server/providers/dispatcher.js';
import { DeliveryWorker } from '../server/queue.js';
import { assertKeyDestinations, validateChannelCreate, validateChannelUpdate, validateRouteChannelIds } from '../server/validation.js';
import { barkFailure, barkSuccess, registerResponse, resolveBarkDestination, sendBark } from '../server/bark-compat.js';
import { appriseSeverity, discordText, parseAlertmanager, prioritySeverity, safeCompatUrl, sendWithAgentKey, slackText } from '../server/compat.js';
import { BodyTooLargeError, readBody, readTextBody } from './body.js';
import { DurableRelayDatabase } from './database.js';
import { PlatformUsageMonitor } from '../server/platform-usage.js';
import { parseWalkieTrace } from '../shared/instance-link.js';

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
  private readonly platformUsage: PlatformUsageMonitor;

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
    this.platformUsage = new PlatformUsageMonitor(this.repository, this.notifications, 'cloudflare-workers');
    this.mcp = createRelayMcpHandler(this.repository, this.notifications, this.dispatcher, (request) => request ? new URL(request.url).origin : '');
  }

  async alarm(): Promise<void> {
    try { await this.platformUsage.refreshIfDue(); }
    catch (error) { console.error(JSON.stringify({ event: 'platform-usage.refresh.failed', message: error instanceof Error ? error.message : String(error) })); }
    await this.drainAndSchedule();
    // 数据保留清理挂在 alarm 上（幂等，retention 全 0 时零开销）。空闲实例无 alarm，
    // 但空闲时也无新数据产生；下一次活动触发 alarm 后过期行自然被清
    try { await this.repository.purgeExpiredData(); }
    catch (error) { console.error(JSON.stringify({ event: 'retention.purge.failed', message: error instanceof Error ? error.message : String(error) })); }
  }

  private async drainAndSchedule(): Promise<void> {
    // drain 前先设临时兜底 alarm：isolate 中途被逐时仍有定时器能回来收拾残局
    // （正常结束后会被下面的精确时间覆盖；空闲路径不设，避免永久 6 分钟心跳）
    if (await this.repository.nextDueAttempt()) {
      const monitorAt = await this.platformUsage.nextCheckAt();
      await this.ctx.storage.setAlarm(Math.min(Date.now() + 6 * 60_000, monitorAt ?? Number.POSITIVE_INFINITY));
    }
    try { await this.worker.drainOnce(); }
    catch (error) { console.error(JSON.stringify({ event: 'drain.error', message: error instanceof Error ? error.message : String(error) })); }
    const due = await this.repository.nextDueAttempt();
    // 存在滞留 sending（drain 中途异常/isolate 被逐）时设 6 分钟兜底 alarm：
    // nextDueAttempt 不看 sending，不设的话单频道投递会无限期卡在 processing；
    // 6 分钟 > claimDueAttempts 的 5 分钟回收阈值，触发时必然可回收
    const stuck = await this.repository.hasStuckSending();
    const monitorAt = await this.platformUsage.nextCheckAt();
    const next = [due ? new Date(due).getTime() : undefined, stuck ? Date.now() + 6 * 60_000 : undefined, monitorAt]
      .filter((value): value is number => value !== undefined);
    if (next.length) {
      // schedule 因平台暂停/用量限制滞留到期时，due 永远指向过去：按 250ms 空转
      // 会以 ~34.5 万 alarm/天击穿 DO 免费配额——正是这些功能想保护的那份额度。
      // 退避到 60s 重查；暂停恢复/限额重置后自然回到正常节奏
      const floor = this.worker.scheduleBlocked ? 60 * 1000 : 250;
      await this.ctx.storage.setAlarm(Math.max(Date.now() + floor, Math.min(...next)));
    }
  }

  private async requireAdmin(request: Request): Promise<Response | undefined> {
    const provided = bearer(request) ?? request.headers.get('x-admin-token') ?? undefined;
    if (this.env.ADMIN_TOKEN && provided && safeTokenEqual(provided, this.env.ADMIN_TOKEN)) return;
    if (provided && await this.repository.authenticateAdminToken(provided)) return;
    const hasDatabaseToken = (await this.repository.listAdminTokens()).some((token) => !token.revokedAt);
    if (!this.env.ADMIN_TOKEN && !hasDatabaseToken) return json({ error: 'ADMIN_TOKEN secret is required' }, 503);
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
        const hasDatabaseToken = (await this.repository.listAdminTokens()).some((token) => !token.revokedAt);
        return json({
          name: 'Walkie', version: VERSION, runtime: 'cloudflare-workers',
          platform: 'cloudflare-workers', platformProfile: PLATFORM_PROFILES['cloudflare-workers'], compatibilityEndpoints: COMPATIBILITY_ENDPOINTS,
          adminAuthRequired: Boolean(this.env.ADMIN_TOKEN) || hasDatabaseToken,
          publicUrl: url.origin, mcpEndpoint: '/mcp', mcpUrl: `${url.origin}/mcp`
        });
      }

      if (path === '/ping' && request.method === 'GET') return json(barkSuccess());
      if (path === '/healthz' && request.method === 'GET') return json(barkSuccess());
      if (path === '/info' && request.method === 'GET') return json(barkSuccess({ version: VERSION, server: 'Walkie Bark relay' }));
      if ((path === '/push' && ['GET', 'POST'].includes(request.method))) return this.barkPush(request, url);
      if ((path === '/register' && ['GET', 'POST'].includes(request.method))) return this.barkRegister(request, url);
      const registerCheck = /^\/register\/([^/]+)$/.exec(path);
      if (registerCheck && request.method === 'GET') {
        try { await resolveBarkDestination(this.repository, decodeURIComponent(registerCheck[1]!)); return json(barkSuccess()); }
        catch (error) { return json(barkFailure(400, error instanceof Error ? error.message : '设备未注册'), 400); }
      }
      if (path === '/message' && request.method === 'POST') {
        const params = await readBody(request);
        try {
          // Gotify 的 token 三种传法都要认：X-Gotify-Key 头、?token= 查询参数、Authorization: Bearer
          const token = request.headers.get('x-gotify-key') || url.searchParams.get('token') || String(params.token ?? '') || bearer(request) || '';
          const delivery = await sendWithAgentKey(this.repository, this.notifications, token, {
            title: String(params.title ?? 'Gotify').slice(0, 200), body: String(params.message ?? '').trim().slice(0, 20_000) || 'Empty Message',
            severity: prioritySeverity(params.priority), metadata: { via: 'gotify-compat', extras: params.extras ?? {} }
          }, 'gotify-compat');
          return json({ id: delivery.id });
        } catch (error) { return json({ error: error instanceof Error ? error.message : '推送失败' }, 400); }
      }
      if (path === '/send' && ['GET', 'POST'].includes(request.method)) {
        const body = request.method === 'POST' ? await readBody(request) : {};
        const params = { ...Object.fromEntries(url.searchParams), ...body };
        try {
          const delivery = await sendWithAgentKey(this.repository, this.notifications, String(params.token ?? ''), {
            title: String(params.title ?? 'PushPlus').slice(0, 200), body: String(params.content ?? params.body ?? '').trim().slice(0, 20_000) || 'Empty Message',
            severity: 'info', metadata: { via: 'pushplus-compat', template: params.template, topic: params.topic }
          }, 'pushplus-compat');
          return json({ code: 200, msg: '请求成功', data: delivery.id });
        } catch (error) { return json({ code: 400, msg: error instanceof Error ? error.message : '推送失败' }, 400); }
      }
      const ntfy = /^\/ntfy\/([^/]+)$/.exec(path);
      if (ntfy && request.method === 'POST') {
        const isText = (request.headers.get('content-type') ?? '').includes('text/plain');
        const content = isText ? await readTextBody(request) : await readBody(request);
        const params = typeof content === 'string' ? {} : content;
        const message = typeof content === 'string' ? content : String(params.message ?? params.body ?? '');
        try {
          const delivery = await sendWithAgentKey(this.repository, this.notifications, bearer(request) ?? '', {
            destination: decodeURIComponent(ntfy[1]!), title: String(request.headers.get('title') ?? params.title ?? 'ntfy').slice(0, 200),
            body: message.trim().slice(0, 20_000) || 'Empty Message', severity: prioritySeverity(request.headers.get('priority') ?? params.priority, 'ntfy'),
            url: safeCompatUrl(request.headers.get('click') ?? params.click),
            tags: String(request.headers.get('tags') ?? params.tags ?? '').slice(0, 200) || undefined, metadata: { via: 'ntfy-compat' }
          }, 'ntfy-compat');
          return json({ id: delivery.id, time: Math.floor(Date.now() / 1000), event: 'message', topic: decodeURIComponent(ntfy[1]!), message });
        } catch (error) { return json({ code: 400, error: error instanceof Error ? error.message : '推送失败' }, 400); }
      }

      // ---- 以下五个兼容端点必须在 legacyBark 正则之前匹配：那个模式吃掉任何 1–4 段路径 ----

      // Slack Incoming Webhook：POST /services/<T>/<B>/<xxx>，末段为 Agent Key，成功返回纯文本 ok
      const slack = /^\/services\/([A-Za-z0-9_\-]+)\/([A-Za-z0-9_\-]+)\/([A-Za-z0-9_\-]+)$/.exec(path);
      if (slack && request.method === 'POST') {
        const fields = await readBody(request);
        // 老式提交是 payload=<urlencoded json>，新式直接 POST JSON 对象
        let params = fields;
        if (typeof fields.payload === 'string' && fields.payload.trim().startsWith('{')) {
          try { params = JSON.parse(fields.payload) as Record<string, unknown>; } catch { /* 保留原字段 */ }
        }
        try {
          const delivery = await sendWithAgentKey(this.repository, this.notifications, slack[3]!, {
            title: (String(params.text ?? '').trim() || 'Slack').slice(0, 200),
            body: (slackText(params) || 'Empty Message').slice(0, 20_000),
            severity: 'info', metadata: { via: 'slack-webhook-compat' }
          }, 'slack-webhook-compat');
          void this.worker.drainOnce().catch(() => undefined);
          return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : '推送失败', { status: 400, headers: { 'content-type': 'text/plain' } });
        }
      }

      // Discord Webhook：POST /api/webhooks/<id>/<token>，token 段为 Agent Key
      const discord = /^\/api\/webhooks\/([0-9]+)\/([A-Za-z0-9_\-]+)$/.exec(path);
      if (discord && request.method === 'POST') {
        const params = await readBody(request);
        const content = String(params.content ?? '').trim();
        const embeds = discordText(params);
        try {
          const delivery = await sendWithAgentKey(this.repository, this.notifications, discord[2]!, {
            title: (content.split('\n')[0] || 'Discord').slice(0, 200),
            body: ([content, embeds].filter(Boolean).join('\n') || 'Empty Message').slice(0, 20_000),
            severity: 'info', metadata: { via: 'discord-webhook-compat' }
          }, 'discord-webhook-compat');
          void this.worker.drainOnce().catch(() => undefined);
          if (url.searchParams.get('wait') === 'true' || url.searchParams.get('wait') === '1') {
            return json({ id: delivery.id, content, timestamp: new Date().toISOString(), webhook_id: discord[1]! });
          }
          return new Response(null, { status: 204 });
        } catch (error) { return json({ message: error instanceof Error ? error.message : '推送失败' }, 400); }
      }

      // Alertmanager / Grafana 告警 webhook：POST /alertmanager?key=<AgentKey>（或 Bearer）
      if (path === '/alertmanager' && request.method === 'POST') {
        const params = await readBody(request);
        const token = url.searchParams.get('key') || bearer(request) || '';
        const alerts = parseAlertmanager(params);
        if (!alerts.length) return json({ error: 'alerts 数组为空或缺失' }, 400);
        try {
          const deliveries = await Promise.all(alerts.map((alert) => sendWithAgentKey(this.repository, this.notifications, token, {
            title: alert.title.slice(0, 200), body: alert.body.slice(0, 20_000) || 'Empty Message',
            severity: alert.severity, url: alert.url,
            idempotencyKey: alert.fingerprint ? `alertmanager:${alert.fingerprint}:${alert.status}` : undefined,
            metadata: { via: 'alertmanager-compat', fingerprint: alert.fingerprint, status: alert.status }
          }, 'alertmanager-compat')));
          void this.worker.drainOnce().catch(() => undefined);
          return json({ delivered: deliveries.length, ids: deliveries.map((delivery) => delivery.id) });
        } catch (error) { return json({ error: error instanceof Error ? error.message : '推送失败' }, 400); }
      }

      // Pushover：POST /1/messages.json，token/user 任一作为 Agent Key
      if ((path === '/1/messages.json' || path === '/1/messages') && request.method === 'POST') {
        const params = { ...Object.fromEntries(url.searchParams), ...(await readBody(request)) };
        const token = String(params.token ?? '') || String(params.user ?? '');
        const message = String(params.message ?? '').trim();
        if (!message) return json({ status: 0, request: '', errors: ['message is required'] }, 400);
        try {
          const delivery = await sendWithAgentKey(this.repository, this.notifications, token, {
            title: (String(params.title ?? '') || 'Pushover').slice(0, 200),
            body: message.slice(0, 20_000), severity: prioritySeverity(params.priority, 'pushover'),
            url: safeCompatUrl(params.url), tags: String(params.device ?? '').slice(0, 200) || undefined,
            metadata: { via: 'pushover-compat', urlTitle: params.url_title, sound: params.sound, device: params.device }
          }, 'pushover-compat');
          void this.worker.drainOnce().catch(() => undefined);
          return json({ status: 1, request: delivery.id });
        } catch (error) {
          return json({ status: 0, request: '', errors: [error instanceof Error ? error.message : '推送失败'] }, 400);
        }
      }

      // Apprise API：POST /notify 或 /notify/<KEY>，body 必填，type 映射 severity
      const apprise = /^\/notify(\/([A-Za-z0-9_\-]+))?$/.exec(path);
      if (apprise && request.method === 'POST') {
        const params = await readBody(request);
        const token = apprise[2] || bearer(request) || '';
        const body = String(params.body ?? '').trim();
        if (!body) return json({ error: 'body is required' }, 400);
        try {
          const delivery = await sendWithAgentKey(this.repository, this.notifications, token, {
            title: (String(params.title ?? '') || 'Apprise').slice(0, 200),
            body: body.slice(0, 20_000), severity: appriseSeverity(params.type),
            tags: String(params.tag ?? '').slice(0, 200) || undefined,
            metadata: { via: 'apprise-compat', format: params.format, type: params.type, tag: params.tag }
          }, 'apprise-compat');
          void this.worker.drainOnce().catch(() => undefined);
          return json({ error: null, kind: 'success' });
        } catch (error) {
          const message = error instanceof Error ? error.message : '推送失败';
          return json({ error: { kind: 'warning', message } }, 400);
        }
      }
      const legacyBark = /^\/(?!api(?:\/|$)|mcp(?:\/|$)|reply(?:\/|$)|assets(?:\/|$)|send(?:\/|$)|health$|healthz$|info$|ping$|push$|register(?:\/|$)|[^/]*\.[^/]+$)([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(path);
      if (legacyBark && ['GET', 'POST'].includes(request.method)) {
        const body = request.method === 'POST' ? await readBody(request) : {};
        const params: Record<string, unknown> = { ...Object.fromEntries(url.searchParams), ...body, device_key: decodeURIComponent(legacyBark[1]!) };
        const part = (index: number) => legacyBark[index] ? decodeURIComponent(legacyBark[index]!) : '';
        const [bodyPart, title, subtitle, finalBody] = [part(2), part(2), part(3), part(4)];
        if (finalBody) { params.title = title; params.subtitle = subtitle; params.body = finalBody; }
        else if (subtitle) { params.title = title; params.body = subtitle; }
        else if (bodyPart) params.body = bodyPart;
        try { await sendBark(this.notifications, this.repository, params); return json(barkSuccess()); }
        catch (error) { return json(barkFailure(400, error instanceof Error ? error.message : '推送失败'), 400); }
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
        const input = notificationSchema.parse(await readBody(request));
        const trace = parseWalkieTrace(request.headers.get('x-walkie-trace'));
        const delivery = await this.notifications.send({ ...input, ...(trace.length ? { metadata: { ...input.metadata, walkieTrace: trace } } : {}) }, `agent:${agent.apiKey.id}`, agent.apiKey);
        return json({ deliveryId: delivery.id, scheduleId: delivery.scheduleId, status: delivery.status, scheduledAt: delivery.scheduledAt, createdAt: delivery.createdAt }, 202);
      }
      if (path === '/api/v1/schedules' && request.method === 'GET') {
        const agent = await this.authenticateAgent(request);
        if (agent instanceof Response) return agent;
        if (!agent.apiKey.scopes.includes('notifications:send')) return json({ error: 'API Key 缺少 notifications:send 权限' }, 403);
        return json({ schedules: await this.repository.listSchedules({ source: `agent:${agent.apiKey.id}` }) });
      }
      const agentSchedule = /^\/api\/v1\/schedules\/([^/]+)\/cancel$/.exec(path);
      if (agentSchedule && request.method === 'POST') {
        const agent = await this.authenticateAgent(request);
        if (agent instanceof Response) return agent;
        if (!agent.apiKey.scopes.includes('notifications:send')) return json({ error: 'API Key 缺少 notifications:send 权限' }, 403);
        return json(await this.repository.cancelSchedule(agentSchedule[1]!, `agent:${agent.apiKey.id}`, `agent:${agent.apiKey.id}`));
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
      const { provider, ...input } = channelSchema.partial().parse(await readBody(request));
      // PATCH 换 provider/改 config 后重新校验必填字段（与 Node 版一致）
      const { current, errors } = await validateChannelUpdate(this.repository, channel[1], { provider, config: input.config });
      if (errors[0] === '频道不存在') return json({ error: '频道不存在' }, 404);
      if (errors.length) return json({ error: errors.join('；') }, 400);
      return json(await this.repository.updateChannel(current!.id, { ...input, ...(provider !== undefined ? { provider: provider as ProviderId } : {}) }));
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
      const adminToken = await this.repository.setAdminToken(token, input.name);
      return json({ token, adminToken }, 201);
    }
    const revokeAdminToken = /^\/api\/admin\/credentials\/admin-tokens\/([^/]+)$/.exec(path);
    if (revokeAdminToken && request.method === 'DELETE') { await this.repository.revokeAdminToken(revokeAdminToken[1]!, Boolean(this.env.ADMIN_TOKEN)); return new Response(null, { status: 204 }); }
    const restoreAdminToken = /^\/api\/admin\/credentials\/admin-tokens\/([^/]+)\/restore$/.exec(path);
    if (restoreAdminToken && request.method === 'POST') { await this.repository.restoreAdminToken(restoreAdminToken[1]!); return json({ success: true }); }
    if (path === '/api/admin/credentials/master-key/rotate' && request.method === 'POST') return json(await this.repository.rotateMasterKey());

    if (path === '/api/admin/usage' && request.method === 'GET') return json(await this.repository.getUsageSnapshot());
    if (path === '/api/admin/usage' && request.method === 'PUT') {
      await this.repository.setUsageSettings(usageSettingsSchema.parse(await readBody(request)));
      return json(await this.repository.getUsageSnapshot());
    }
    if (path === '/api/admin/platform-usage' && request.method === 'GET') return json(await this.platformUsage.getStatus(true));
    if (path === '/api/admin/platform-usage' && request.method === 'PUT') {
      const status = await this.platformUsage.configure(platformUsageSchema.parse(await readBody(request)));
      await this.drainAndSchedule();
      return json(status);
    }
    if (path === '/api/admin/platform-usage/refresh' && request.method === 'POST') {
      const status = await this.platformUsage.refresh();
      await this.drainAndSchedule();
      return json(status);
    }
    if (path === '/api/admin/platform-usage/reenable' && request.method === 'POST') return json(await this.platformUsage.reenableDelivery());

    if (path === '/api/admin/audit' && request.method === 'GET') {
      return json({ events: await this.repository.listAuditEvents({
        limit: Number(url.searchParams.get('limit') ?? 100),
        actor: url.searchParams.get('actor') || undefined,
        action: url.searchParams.get('action') || undefined
      }) });
    }
    if (path === '/api/admin/audit' && request.method === 'DELETE') return json({ deleted: await this.repository.clearAuditEvents() });

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
        return json({ currentVersion: VERSION, latestVersion, hasUpdate, releaseNotes: release.body?.slice(0, 500), releaseUrl: release.html_url, canApply: false, applyHint: PLATFORM_PROFILES['cloudflare-workers'].updateHint });
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
    if (path === '/api/admin/schedules' && request.method === 'GET') return json({ schedules: await this.repository.listSchedules() });
    const cancelSchedule = /^\/api\/admin\/schedules\/([^/]+)\/cancel$/.exec(path);
    if (cancelSchedule && request.method === 'POST') return json(await this.repository.cancelSchedule(cancelSchedule[1]!));
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

  private async barkPush(request: Request, url: URL): Promise<Response> {
    const body = request.method === 'POST' ? await readBody(request) : {};
    const params = { ...body, ...Object.fromEntries(url.searchParams) } as Record<string, unknown>;
    try {
      const result = await sendBark(this.notifications, this.repository, params);
      return json(barkSuccess(result.deliveries.length === 1 ? undefined : result.keys.map((key, index) => ({ code: 200, device_key: key, deliveryId: result.deliveries[index] }))));
    } catch (error) {
      return json(barkFailure(400, error instanceof Error ? error.message : '推送失败'), 400);
    }
  }

  private async barkRegister(request: Request, url: URL): Promise<Response> {
    const body = request.method === 'POST' ? await readBody(request) : {};
    const params = { ...Object.fromEntries(url.searchParams), ...body } as Record<string, unknown>;
    const key = String(params.device_key ?? params.key ?? '').trim();
    const token = String(params.device_token ?? params.devicetoken ?? '').trim();
    if (!key) return json(barkFailure(400, 'device key 不能为空'), 400);
    if (!token) return json(barkFailure(400, 'device token 不能为空'), 400);
    try {
      await resolveBarkDestination(this.repository, key);
      return json(registerResponse(key, token));
    } catch (error) {
      return json(barkFailure(400, error instanceof Error ? error.message : '设备未注册'), 400);
    }
  }
}

/** MASTER_KEY 缺失/格式错误时 DO 构造函数会抛错，每个请求都变成没有线索的 500。
 *  一键部署按钮无法代填 secret，所以这里前置拦截，直接给出可照抄的命令。 */
function setupRequired(reason: string): Response {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Walkie · 需要完成设置</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#fafafa;font:15px/1.7 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
main{max-width:640px;padding:32px}h1{font-size:20px;margin:0 0 8px}p{color:#a1a1aa;margin:0 0 16px}
pre{background:#18181b;border:1px solid #27272a;border-radius:8px;padding:14px 16px;overflow-x:auto;font-size:13px}
code{color:#5eead4}a{color:#5eead4}</style></head><body><main>
<h1>📻 Walkie 部署成功，还差最后一步</h1>
<p>${reason}</p>
<p>在本地仓库里执行下面两条命令设置 secret，然后刷新本页：</p>
<pre><code># 32 字节根密钥，加密所有渠道凭据；丢失后数据无法解密，请一并备份
openssl rand -base64 32 | npx wrangler secret put MASTER_KEY

# 管理密码（≥8 位），用于登录控制台
npx wrangler secret put ADMIN_TOKEN</code></pre>
<p>没有 openssl 时用：<code>node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"</code></p>
</main></body></html>`;
  return new Response(body, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (!env.MASTER_KEY) return setupRequired('还没有配置 MASTER_KEY，实例暂时无法启动。');
    if (Buffer.from(env.MASTER_KEY, 'base64').length !== 32) return setupRequired('MASTER_KEY 不是 base64 编码的 32 字节密钥。');
    const path = new URL(request.url).pathname;
    if (path === '/health' || path === '/push' || path === '/ping' || path === '/healthz' || path === '/info' || path === '/register' || path.startsWith('/register/') || path === '/mcp' || path.startsWith('/api/') || path.startsWith('/reply/') || /^\/(?:send\/)?[^/]+\.send$/.test(path) || /^\/(?!assets(?:\/|$))[^/]+(?:\/[^/]+){0,3}$/.test(path)) {
      return env.WALKIE.getByName('default').fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<WorkerEnv>;
