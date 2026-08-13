import { randomUUID } from 'node:crypto';
import type {
  ApiKey,
  Channel,
  Conversation,
  DashboardStats,
  Delivery,
  DeliveryAttempt,
  Destination,
  ProviderId,
  Route,
  RouteStrategy,
  Severity
} from '../shared/types.js';
import { createApiSecret, decryptJson, encryptJson, safeSecretEqual } from './crypto.js';

type Row = Record<string, unknown>;

export interface SqlRunResult { changes: number }
export interface SqlBatchStatement { sql: string; params?: unknown[] }
/** 异步 SQL 抽象：better-sqlite3（同步包装）、Durable Object SQLite、libSQL/Turso 共用 */
export interface RelayDatabase {
  close(): void | Promise<void>;
  exec(sql: string): Promise<void>;
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  get(sql: string, params?: unknown[]): Promise<Row | undefined>;
  run(sql: string, params?: unknown[]): Promise<SqlRunResult>;
  /** 事务性批量执行，全部成功或全部回滚 */
  batch(statements: SqlBatchStatement[]): Promise<void>;
}

const now = () => new Date().toISOString();
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === 'string' ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
};

export class RelayRepository {
  readonly db: RelayDatabase;

  constructor(database: RelayDatabase, private readonly masterKey: Buffer) {
    this.db = database;
  }

  close(): void | Promise<void> {
    return this.db.close();
  }

  /** 必须在使用前调用一次（建表 + 迁移） */
  async init(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL, config_encrypted TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        last_test_status TEXT NOT NULL DEFAULT 'untested', last_test_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        strategy TEXT NOT NULL, channel_ids TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL UNIQUE, secret_hash TEXT NOT NULL,
        scopes TEXT NOT NULL, destination_ids TEXT NOT NULL, last_used_at TEXT,
        created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, severity TEXT NOT NULL, url TEXT,
        metadata TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
        idempotency_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS deliveries_idempotency_source
        ON deliveries(source, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS deliveries_created ON deliveries(created_at DESC);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT, position INTEGER NOT NULL,
        status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, response_code INTEGER,
        error TEXT, next_attempt_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(delivery_id, channel_id)
      );
      CREATE INDEX IF NOT EXISTS attempts_due ON attempts(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
        resource_type TEXT NOT NULL, resource_id TEXT, details TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, api_key_id TEXT NOT NULL, delivery_id TEXT,
        reply_token TEXT NOT NULL, question TEXT NOT NULL, options TEXT,
        reply TEXT, reply_source TEXT, replied_at TEXT,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_pending ON conversations(replied_at, expires_at);
    `);
    const channelColumns = new Set((await this.db.all('PRAGMA table_info(channels)')).map((row) => String(row.name)));
    if (!channelColumns.has('rate_limit_per_min')) await this.db.exec('ALTER TABLE channels ADD COLUMN rate_limit_per_min INTEGER');
    if (!channelColumns.has('quiet_hours')) await this.db.exec('ALTER TABLE channels ADD COLUMN quiet_hours TEXT');
    const conversationColumns = new Set((await this.db.all('PRAGMA table_info(conversations)')).map((row) => String(row.name)));
    if (!conversationColumns.has('options')) await this.db.exec('ALTER TABLE conversations ADD COLUMN options TEXT');
  }

  private channelFrom(row: Row): Channel {
    const config = decryptJson(String(row.config_encrypted), this.masterKey);
    return {
      id: String(row.id), name: String(row.name), slug: String(row.slug), provider: row.provider as ProviderId,
      enabled: Boolean(row.enabled), configKeys: Object.keys(config),
      rateLimitPerMin: row.rate_limit_per_min ? Number(row.rate_limit_per_min) : undefined,
      quietHours: row.quiet_hours ? String(row.quiet_hours) : undefined,
      lastTestStatus: row.last_test_status as Channel['lastTestStatus'],
      lastTestError: row.last_test_error ? String(row.last_test_error) : undefined,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  async listChannels(): Promise<Channel[]> {
    return (await this.db.all('SELECT * FROM channels ORDER BY name')).map((row) => this.channelFrom(row));
  }

  async getChannel(idOrSlug: string): Promise<Channel | undefined> {
    const row = await this.db.get('SELECT * FROM channels WHERE id = ? OR slug = ?', [idOrSlug, idOrSlug]);
    return row ? this.channelFrom(row) : undefined;
  }

  async getChannelConfig(id: string): Promise<Record<string, unknown>> {
    const row = await this.db.get('SELECT config_encrypted FROM channels WHERE id = ?', [id]);
    if (!row) throw new Error('Channel not found');
    return decryptJson(String(row.config_encrypted), this.masterKey);
  }

  async createChannel(input: { name: string; slug: string; provider: ProviderId; enabled?: boolean; config: Record<string, unknown>; rateLimitPerMin?: number | null; quietHours?: string | null }): Promise<Channel> {
    const id = randomUUID();
    const timestamp = now();
    await this.db.run(`INSERT INTO channels
      (id,name,slug,provider,config_encrypted,enabled,rate_limit_per_min,quiet_hours,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, input.name, input.slug, input.provider, encryptJson(input.config, this.masterKey), input.enabled === false ? 0 : 1, input.rateLimitPerMin || null, input.quietHours || null, timestamp, timestamp]);
    await this.audit('admin', 'channel.create', 'channel', id, { provider: input.provider });
    return (await this.getChannel(id))!;
  }

  async updateChannel(id: string, input: Partial<{ name: string; slug: string; provider: ProviderId; enabled: boolean; config: Record<string, unknown>; rateLimitPerMin: number | null; quietHours: string | null }>): Promise<Channel> {
    const current = await this.getChannel(id);
    if (!current) throw new Error('Channel not found');
    const config = input.config ? { ...await this.getChannelConfig(id), ...input.config } : await this.getChannelConfig(id);
    await this.db.run(`UPDATE channels SET name=?,slug=?,provider=?,enabled=?,config_encrypted=?,rate_limit_per_min=?,quiet_hours=?,updated_at=? WHERE id=?`, [
      input.name ?? current.name, input.slug ?? current.slug, input.provider ?? current.provider,
      input.enabled ?? current.enabled ? 1 : 0, encryptJson(config, this.masterKey),
      input.rateLimitPerMin !== undefined ? input.rateLimitPerMin || null : current.rateLimitPerMin ?? null,
      input.quietHours !== undefined ? input.quietHours || null : current.quietHours ?? null,
      now(), id
    ]);
    await this.audit('admin', 'channel.update', 'channel', id, {});
    return (await this.getChannel(id))!;
  }

  async setChannelTest(id: string, success: boolean, error?: string): Promise<void> {
    await this.db.run('UPDATE channels SET last_test_status=?,last_test_error=?,updated_at=? WHERE id=?',
      [success ? 'success' : 'failed', error ?? null, now(), id]);
  }

  async deleteChannel(id: string): Promise<void> {
    const used = (await this.db.get("SELECT COUNT(*) count FROM attempts WHERE channel_id=?", [id])) as { count: number };
    const routed = (await this.db.get('SELECT COUNT(*) count FROM routes, json_each(routes.channel_ids) WHERE json_each.value=?', [id])) as { count: number };
    if (used.count > 0 || routed.count > 0) {
      await this.db.run('UPDATE channels SET enabled=0,updated_at=? WHERE id=?', [now(), id]);
      return;
    }
    await this.db.run('DELETE FROM channels WHERE id=?', [id]);
    await this.audit('admin', 'channel.delete', 'channel', id, {});
  }

  private routeFrom(row: Row): Route {
    return {
      id: String(row.id), name: String(row.name), slug: String(row.slug), strategy: row.strategy as RouteStrategy,
      channelIds: json<string[]>(row.channel_ids, []), enabled: Boolean(row.enabled),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  async listRoutes(): Promise<Route[]> {
    return (await this.db.all('SELECT * FROM routes ORDER BY name')).map((row) => this.routeFrom(row));
  }

  async getRoute(idOrSlug: string): Promise<Route | undefined> {
    const row = await this.db.get('SELECT * FROM routes WHERE id=? OR slug=?', [idOrSlug, idOrSlug]);
    return row ? this.routeFrom(row) : undefined;
  }

  async createRoute(input: { name: string; slug: string; strategy: RouteStrategy; channelIds: string[]; enabled?: boolean }): Promise<Route> {
    const id = randomUUID();
    const timestamp = now();
    await this.db.run('INSERT INTO routes (id,name,slug,strategy,channel_ids,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, input.name, input.slug, input.strategy, JSON.stringify(input.channelIds), input.enabled === false ? 0 : 1, timestamp, timestamp]);
    await this.audit('admin', 'route.create', 'route', id, { strategy: input.strategy });
    return (await this.getRoute(id))!;
  }

  async updateRoute(id: string, input: Partial<{ name: string; slug: string; strategy: RouteStrategy; channelIds: string[]; enabled: boolean }>): Promise<Route> {
    const current = await this.getRoute(id);
    if (!current) throw new Error('Route not found');
    await this.db.run('UPDATE routes SET name=?,slug=?,strategy=?,channel_ids=?,enabled=?,updated_at=? WHERE id=?', [
      input.name ?? current.name, input.slug ?? current.slug, input.strategy ?? current.strategy,
      JSON.stringify(input.channelIds ?? current.channelIds), input.enabled ?? current.enabled ? 1 : 0, now(), id
    ]);
    await this.audit('admin', 'route.update', 'route', id, {});
    return (await this.getRoute(id))!;
  }

  async deleteRoute(id: string): Promise<void> {
    await this.db.run('DELETE FROM routes WHERE id=?', [id]);
    await this.audit('admin', 'route.delete', 'route', id, {});
  }

  async listDestinations(): Promise<Destination[]> {
    const [channels, routes] = await Promise.all([this.listChannels(), this.listRoutes()]);
    return [
      ...channels.map((c): Destination => ({ id: c.id, slug: c.slug, name: c.name, kind: 'channel', provider: c.provider, enabled: c.enabled })),
      ...routes.map((r): Destination => ({ id: r.id, slug: r.slug, name: r.name, kind: 'route', strategy: r.strategy, enabled: r.enabled }))
    ];
  }

  async createKey(input: { name: string; scopes?: string[]; destinationIds?: string[] }): Promise<{ apiKey: ApiKey; secret: string }> {
    const id = randomUUID();
    const generated = createApiSecret();
    const timestamp = now();
    await this.db.run('INSERT INTO api_keys (id,name,prefix,secret_hash,scopes,destination_ids,created_at) VALUES (?,?,?,?,?,?,?)',
      [id, input.name, generated.prefix, generated.hash, JSON.stringify(input.scopes ?? ['notifications:send', 'deliveries:read']), JSON.stringify(input.destinationIds ?? []), timestamp]);
    await this.audit('admin', 'api_key.create', 'api_key', id, { prefix: generated.prefix });
    return { apiKey: (await this.getKey(id))!, secret: generated.secret };
  }

  private keyFrom(row: Row): ApiKey {
    return {
      id: String(row.id), name: String(row.name), prefix: String(row.prefix), scopes: json<string[]>(row.scopes, []),
      destinationIds: json<string[]>(row.destination_ids, []), lastUsedAt: row.last_used_at ? String(row.last_used_at) : undefined,
      createdAt: String(row.created_at), revokedAt: row.revoked_at ? String(row.revoked_at) : undefined
    };
  }

  async getKey(id: string): Promise<ApiKey | undefined> {
    const row = await this.db.get('SELECT * FROM api_keys WHERE id=?', [id]);
    return row ? this.keyFrom(row) : undefined;
  }

  async listKeys(): Promise<ApiKey[]> {
    return (await this.db.all('SELECT * FROM api_keys ORDER BY created_at DESC')).map((row) => this.keyFrom(row));
  }

  async authenticateKey(secret: string): Promise<ApiKey | undefined> {
    const prefix = /^rdk_([a-f0-9]{8})_/.exec(secret)?.[1];
    if (!prefix) return undefined;
    const row = await this.db.get('SELECT * FROM api_keys WHERE prefix=? AND revoked_at IS NULL', [prefix]);
    if (!row || !safeSecretEqual(secret, String(row.secret_hash))) return undefined;
    await this.db.run('UPDATE api_keys SET last_used_at=? WHERE id=?', [now(), row.id]);
    return this.keyFrom({ ...row, last_used_at: now() });
  }

  async revokeKey(id: string): Promise<void> {
    await this.db.run('UPDATE api_keys SET revoked_at=? WHERE id=?', [now(), id]);
    await this.audit('admin', 'api_key.revoke', 'api_key', id, {});
  }

  async createDelivery(input: {
    targetType: 'channel' | 'route'; targetId: string; title: string; body: string; severity: Severity;
    url?: string; metadata?: Record<string, unknown>; source: string; idempotencyKey?: string; channelIds: string[];
  }): Promise<Delivery> {
    if (input.idempotencyKey) {
      const existing = await this.db.get('SELECT id FROM deliveries WHERE source=? AND idempotency_key=?', [input.source, input.idempotencyKey]);
      if (existing) return (await this.getDelivery(String(existing.id)))!;
    }
    const id = randomUUID();
    const timestamp = now();
    await this.db.batch([
      {
        sql: `INSERT INTO deliveries
          (id,target_type,target_id,title,body,severity,url,metadata,source,status,idempotency_key,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
        params: [id, input.targetType, input.targetId, input.title, input.body, input.severity, input.url ?? null,
          JSON.stringify(input.metadata ?? {}), input.source, input.idempotencyKey ?? null, timestamp, timestamp]
      },
      ...input.channelIds.map((channelId, position) => ({
        sql: `INSERT INTO attempts
          (id,delivery_id,channel_id,position,status,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        params: [randomUUID(), id, channelId, position, 'pending', timestamp, timestamp, timestamp]
      }))
    ]);
    return (await this.getDelivery(id))!;
  }

  private attemptFrom(row: Row): DeliveryAttempt {
    return {
      id: String(row.id), deliveryId: String(row.delivery_id), channelId: String(row.channel_id),
      channelName: row.channel_name ? String(row.channel_name) : undefined,
      provider: row.provider as ProviderId | undefined, status: row.status as DeliveryAttempt['status'],
      attemptCount: Number(row.attempt_count), responseCode: row.response_code ? Number(row.response_code) : undefined,
      error: row.error ? String(row.error) : undefined, nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : undefined,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  async getAttempts(deliveryId: string): Promise<DeliveryAttempt[]> {
    return (await this.db.all(`SELECT a.*,c.name channel_name,c.provider provider FROM attempts a
      JOIN channels c ON c.id=a.channel_id WHERE a.delivery_id=? ORDER BY a.position`, [deliveryId])).map((row) => this.attemptFrom(row));
  }

  private deliveryFrom(row: Row): Delivery {
    return {
      id: String(row.id), targetType: row.target_type as Delivery['targetType'], targetId: String(row.target_id),
      targetName: row.target_name ? String(row.target_name) : undefined, title: String(row.title), body: String(row.body),
      severity: row.severity as Severity, url: row.url ? String(row.url) : undefined,
      metadata: json<Record<string, unknown>>(row.metadata, {}), source: String(row.source), status: row.status as Delivery['status'],
      idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  async getDelivery(id: string): Promise<Delivery | undefined> {
    const row = await this.db.get(`SELECT d.*,COALESCE(c.name,r.name) target_name FROM deliveries d
      LEFT JOIN channels c ON d.target_type='channel' AND c.id=d.target_id
      LEFT JOIN routes r ON d.target_type='route' AND r.id=d.target_id WHERE d.id=?`, [id]);
    if (!row) return undefined;
    const delivery = this.deliveryFrom(row);
    delivery.attempts = await this.getAttempts(delivery.id);
    return delivery;
  }

  async listDeliveries(options: { limit?: number; status?: string } = {}): Promise<Delivery[]> {
    const limit = Math.min(options.limit ?? 50, 200);
    const rows = options.status
      ? await this.db.all('SELECT * FROM deliveries WHERE status=? ORDER BY created_at DESC LIMIT ?', [options.status, limit])
      : await this.db.all('SELECT * FROM deliveries ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map((row) => this.deliveryFrom(row));
  }

  async claimDueAttempts(limit: number): Promise<DeliveryAttempt[]> {
    const rows = await this.db.all(`SELECT a.*,c.name channel_name,c.provider provider FROM attempts a
      JOIN channels c ON c.id=a.channel_id JOIN deliveries d ON d.id=a.delivery_id
      LEFT JOIN routes r ON d.target_type='route' AND r.id=d.target_id
      WHERE a.status IN ('pending','retrying') AND a.next_attempt_at<=? AND c.enabled=1
      AND (r.strategy IS NULL OR r.strategy<>'fallback' OR (
        NOT EXISTS (SELECT 1 FROM attempts won WHERE won.delivery_id=a.delivery_id AND won.status='delivered')
        AND a.position=(SELECT MIN(next.position) FROM attempts next WHERE next.delivery_id=a.delivery_id AND next.status IN ('pending','retrying'))
      ))
      ORDER BY a.next_attempt_at,a.position LIMIT ?`, [now(), limit]);
    const claimed: DeliveryAttempt[] = [];
    // 每行 UPDATE 带 status 守卫本身原子，无需外层事务
    for (const row of rows) {
      const result = await this.db.run(`UPDATE attempts SET status='sending',attempt_count=attempt_count+1,updated_at=?
        WHERE id=? AND status IN ('pending','retrying')`, [now(), row.id]);
      if (result.changes) {
        await this.db.run("UPDATE deliveries SET status='processing',updated_at=? WHERE id=? AND status='queued'", [now(), row.delivery_id]);
        claimed.push(this.attemptFrom({ ...row, status: 'sending', attempt_count: Number(row.attempt_count) + 1 }));
      }
    }
    return claimed;
  }

  async nextDueAttempt(): Promise<string | undefined> {
    const row = await this.db.get("SELECT MIN(next_attempt_at) next_at FROM attempts WHERE status IN ('pending','retrying')");
    return row?.next_at ? String(row.next_at) : undefined;
  }

  /** 终态回调只发一次：原子置位，抢到的调用方返回 true */
  async claimCallback(deliveryId: string): Promise<boolean> {
    const result = await this.db.run(`UPDATE deliveries SET metadata=json_set(metadata,'$.callbackSent',1)
      WHERE id=? AND status IN ('delivered','partial','failed') AND json_extract(metadata,'$.callbackSent') IS NULL`, [deliveryId]);
    return result.changes > 0;
  }

  private conversationFrom(row: Row): Conversation {
    return {
      id: String(row.id), apiKeyId: String(row.api_key_id),
      deliveryId: row.delivery_id ? String(row.delivery_id) : undefined,
      question: String(row.question),
      options: row.options ? json<string[]>(row.options, []) : undefined,
      reply: row.reply != null ? String(row.reply) : undefined,
      replySource: row.reply_source ? String(row.reply_source) : undefined,
      repliedAt: row.replied_at ? String(row.replied_at) : undefined,
      expiresAt: String(row.expires_at), createdAt: String(row.created_at)
    };
  }

  async createConversation(input: { apiKeyId: string; question: string; options?: string[]; timeoutSeconds: number }): Promise<{ conversation: Conversation; replyToken: string }> {
    const id = randomUUID();
    const replyToken = randomUUID().replace(/-/g, '');
    const timestamp = now();
    const expiresAt = new Date(Date.now() + input.timeoutSeconds * 1000).toISOString();
    await this.db.run('INSERT INTO conversations (id,api_key_id,reply_token,question,options,expires_at,created_at) VALUES (?,?,?,?,?,?,?)',
      [id, input.apiKeyId, replyToken, input.question, input.options?.length ? JSON.stringify(input.options) : null, expiresAt, timestamp]);
    return { conversation: (await this.getConversation(id))!, replyToken };
  }

  async attachConversationDelivery(id: string, deliveryId: string): Promise<void> {
    await this.db.run('UPDATE conversations SET delivery_id=? WHERE id=?', [deliveryId, id]);
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    const row = await this.db.get('SELECT * FROM conversations WHERE id=?', [id]);
    return row ? this.conversationFrom(row) : undefined;
  }

  /** 回复链接鉴权：token 匹配且未过期未回复。返回问题文本，供回复页展示 */
  async getConversationForReply(id: string, replyToken: string): Promise<Conversation | undefined> {
    const row = await this.db.get('SELECT * FROM conversations WHERE id=? AND reply_token=?', [id, replyToken]);
    return row ? this.conversationFrom(row) : undefined;
  }

  /** 原子写入回复：已回复或已过期返回 false */
  async replyConversation(id: string, reply: string, source: string, replyToken?: string): Promise<boolean> {
    const result = await this.db.run(`UPDATE conversations SET reply=?,reply_source=?,replied_at=?
      WHERE id=? AND replied_at IS NULL AND expires_at>?${replyToken !== undefined ? ' AND reply_token=?' : ''}`,
      replyToken !== undefined ? [reply, source, now(), id, now(), replyToken] : [reply, source, now(), id, now()]);
    if (result.changes > 0) await this.audit(source, 'conversation.reply', 'conversation', id, {});
    return result.changes > 0;
  }

  async listConversations(options: { pendingOnly?: boolean; limit?: number } = {}): Promise<Conversation[]> {
    const limit = Math.min(options.limit ?? 50, 200);
    const rows = options.pendingOnly
      ? await this.db.all('SELECT * FROM conversations WHERE replied_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT ?', [now(), limit])
      : await this.db.all('SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map((row) => this.conversationFrom(row));
  }

  /** 限流/静默推迟：不消耗尝试次数，回到待发送状态 */
  async deferAttempt(id: string, until: string): Promise<void> {
    await this.db.run(`UPDATE attempts SET status='pending',attempt_count=MAX(attempt_count-1,0),next_attempt_at=?,updated_at=? WHERE id=?`, [until, now(), id]);
  }

  async completeAttempt(id: string, result: { success: boolean; responseCode?: number; error?: string; retryAt?: string }): Promise<void> {
    const attempt = await this.db.get('SELECT * FROM attempts WHERE id=?', [id]);
    if (!attempt) return;
    const status = result.success ? 'delivered' : result.retryAt ? 'retrying' : 'failed';
    await this.db.run('UPDATE attempts SET status=?,response_code=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?',
      [status, result.responseCode ?? null, result.error ?? null, result.retryAt ?? null, now(), id]);
    await this.refreshDeliveryStatus(String(attempt.delivery_id));
  }

  async skipAttempts(deliveryId: string, exceptId: string): Promise<void> {
    await this.db.run("UPDATE attempts SET status='skipped',updated_at=? WHERE delivery_id=? AND id<>? AND status IN ('pending','retrying')",
      [now(), deliveryId, exceptId]);
    await this.refreshDeliveryStatus(deliveryId);
  }

  private async refreshDeliveryStatus(deliveryId: string): Promise<void> {
    const delivery = (await this.db.get('SELECT target_type,target_id FROM deliveries WHERE id=?', [deliveryId]))!;
    const attempts = await this.getAttempts(deliveryId);
    const route = delivery.target_type === 'route' ? await this.getRoute(String(delivery.target_id)) : undefined;
    const delivered = attempts.filter((a) => a.status === 'delivered').length;
    const active = attempts.some((a) => ['pending', 'sending', 'retrying'].includes(a.status));
    let status: Delivery['status'];
    if (active) status = 'processing';
    else if (route?.strategy === 'fallback') status = delivered > 0 ? 'delivered' : 'failed';
    else if (delivered === attempts.length && delivered > 0) status = 'delivered';
    else if (delivered > 0) status = 'partial';
    else status = 'failed';
    await this.db.run('UPDATE deliveries SET status=?,updated_at=? WHERE id=?', [status, now(), deliveryId]);
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const one = async (sql: string) => Number(((await this.db.get(sql)) as { count: number }).count);
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const totals = (await this.db.get(`SELECT COUNT(*) total,
      SUM(CASE WHEN status IN ('delivered','partial') THEN 1 ELSE 0 END) successes,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed FROM deliveries WHERE created_at>=?`, [since]))!;
    const total = Number(totals.total ?? 0);
    return {
      channels: await one('SELECT COUNT(*) count FROM channels'), enabledChannels: await one('SELECT COUNT(*) count FROM channels WHERE enabled=1'),
      routes: await one('SELECT COUNT(*) count FROM routes'), activeKeys: await one('SELECT COUNT(*) count FROM api_keys WHERE revoked_at IS NULL'),
      deliveries24h: total, successRate24h: total ? Math.round(Number(totals.successes ?? 0) / total * 1000) / 10 : 100,
      failed24h: Number(totals.failed ?? 0)
    };
  }

  async audit(actor: string, action: string, resourceType: string, resourceId: string | undefined, details: Record<string, unknown>): Promise<void> {
    await this.db.run('INSERT INTO audit_events (id,actor,action,resource_type,resource_id,details,created_at) VALUES (?,?,?,?,?,?,?)',
      [randomUUID(), actor, action, resourceType, resourceId ?? null, JSON.stringify(details), now()]);
  }
}
