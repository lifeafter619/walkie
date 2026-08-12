import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  ApiKey,
  Channel,
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

type Db = Database.Database;
type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === 'string' ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
};

export class RelayRepository {
  readonly db: Db;

  constructor(databasePath: string, private readonly masterKey: Buffer) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
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
    `);
    const channelColumns = new Set((this.db.prepare('PRAGMA table_info(channels)').all() as Row[]).map((row) => String(row.name)));
    if (!channelColumns.has('rate_limit_per_min')) this.db.exec('ALTER TABLE channels ADD COLUMN rate_limit_per_min INTEGER');
    if (!channelColumns.has('quiet_hours')) this.db.exec('ALTER TABLE channels ADD COLUMN quiet_hours TEXT');
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

  listChannels(): Channel[] {
    return (this.db.prepare('SELECT * FROM channels ORDER BY name').all() as Row[]).map((row) => this.channelFrom(row));
  }

  getChannel(idOrSlug: string): Channel | undefined {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ? OR slug = ?').get(idOrSlug, idOrSlug) as Row | undefined;
    return row ? this.channelFrom(row) : undefined;
  }

  getChannelConfig(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT config_encrypted FROM channels WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error('Channel not found');
    return decryptJson(String(row.config_encrypted), this.masterKey);
  }

  createChannel(input: { name: string; slug: string; provider: ProviderId; enabled?: boolean; config: Record<string, unknown>; rateLimitPerMin?: number | null; quietHours?: string | null }): Channel {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO channels
      (id,name,slug,provider,config_encrypted,enabled,rate_limit_per_min,quiet_hours,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, input.name, input.slug, input.provider, encryptJson(input.config, this.masterKey), input.enabled === false ? 0 : 1, input.rateLimitPerMin || null, input.quietHours || null, timestamp, timestamp);
    this.audit('admin', 'channel.create', 'channel', id, { provider: input.provider });
    return this.getChannel(id)!;
  }

  updateChannel(id: string, input: Partial<{ name: string; slug: string; provider: ProviderId; enabled: boolean; config: Record<string, unknown>; rateLimitPerMin: number | null; quietHours: string | null }>): Channel {
    const current = this.getChannel(id);
    if (!current) throw new Error('Channel not found');
    const config = input.config ? { ...this.getChannelConfig(id), ...input.config } : this.getChannelConfig(id);
    this.db.prepare(`UPDATE channels SET name=?,slug=?,provider=?,enabled=?,config_encrypted=?,rate_limit_per_min=?,quiet_hours=?,updated_at=? WHERE id=?`).run(
      input.name ?? current.name, input.slug ?? current.slug, input.provider ?? current.provider,
      input.enabled ?? current.enabled ? 1 : 0, encryptJson(config, this.masterKey),
      input.rateLimitPerMin !== undefined ? input.rateLimitPerMin || null : current.rateLimitPerMin ?? null,
      input.quietHours !== undefined ? input.quietHours || null : current.quietHours ?? null,
      now(), id
    );
    this.audit('admin', 'channel.update', 'channel', id, {});
    return this.getChannel(id)!;
  }

  setChannelTest(id: string, success: boolean, error?: string): void {
    this.db.prepare('UPDATE channels SET last_test_status=?,last_test_error=?,updated_at=? WHERE id=?')
      .run(success ? 'success' : 'failed', error ?? null, now(), id);
  }

  deleteChannel(id: string): void {
    const used = this.db.prepare("SELECT COUNT(*) count FROM attempts WHERE channel_id=?").get(id) as { count: number };
    const routed = this.db.prepare('SELECT COUNT(*) count FROM routes, json_each(routes.channel_ids) WHERE json_each.value=?').get(id) as { count: number };
    if (used.count > 0 || routed.count > 0) {
      this.db.prepare('UPDATE channels SET enabled=0,updated_at=? WHERE id=?').run(now(), id);
      return;
    }
    this.db.prepare('DELETE FROM channels WHERE id=?').run(id);
    this.audit('admin', 'channel.delete', 'channel', id, {});
  }

  private routeFrom(row: Row): Route {
    return {
      id: String(row.id), name: String(row.name), slug: String(row.slug), strategy: row.strategy as RouteStrategy,
      channelIds: json<string[]>(row.channel_ids, []), enabled: Boolean(row.enabled),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  listRoutes(): Route[] {
    return (this.db.prepare('SELECT * FROM routes ORDER BY name').all() as Row[]).map((row) => this.routeFrom(row));
  }

  getRoute(idOrSlug: string): Route | undefined {
    const row = this.db.prepare('SELECT * FROM routes WHERE id=? OR slug=?').get(idOrSlug, idOrSlug) as Row | undefined;
    return row ? this.routeFrom(row) : undefined;
  }

  createRoute(input: { name: string; slug: string; strategy: RouteStrategy; channelIds: string[]; enabled?: boolean }): Route {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO routes (id,name,slug,strategy,channel_ids,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, input.name, input.slug, input.strategy, JSON.stringify(input.channelIds), input.enabled === false ? 0 : 1, timestamp, timestamp);
    this.audit('admin', 'route.create', 'route', id, { strategy: input.strategy });
    return this.getRoute(id)!;
  }

  updateRoute(id: string, input: Partial<{ name: string; slug: string; strategy: RouteStrategy; channelIds: string[]; enabled: boolean }>): Route {
    const current = this.getRoute(id);
    if (!current) throw new Error('Route not found');
    this.db.prepare('UPDATE routes SET name=?,slug=?,strategy=?,channel_ids=?,enabled=?,updated_at=? WHERE id=?').run(
      input.name ?? current.name, input.slug ?? current.slug, input.strategy ?? current.strategy,
      JSON.stringify(input.channelIds ?? current.channelIds), input.enabled ?? current.enabled ? 1 : 0, now(), id
    );
    this.audit('admin', 'route.update', 'route', id, {});
    return this.getRoute(id)!;
  }

  deleteRoute(id: string): void {
    this.db.prepare('DELETE FROM routes WHERE id=?').run(id);
    this.audit('admin', 'route.delete', 'route', id, {});
  }

  listDestinations(): Destination[] {
    return [
      ...this.listChannels().map((c): Destination => ({ id: c.id, slug: c.slug, name: c.name, kind: 'channel', provider: c.provider, enabled: c.enabled })),
      ...this.listRoutes().map((r): Destination => ({ id: r.id, slug: r.slug, name: r.name, kind: 'route', strategy: r.strategy, enabled: r.enabled }))
    ];
  }

  createKey(input: { name: string; scopes?: string[]; destinationIds?: string[] }): { apiKey: ApiKey; secret: string } {
    const id = randomUUID();
    const generated = createApiSecret();
    const timestamp = now();
    this.db.prepare('INSERT INTO api_keys (id,name,prefix,secret_hash,scopes,destination_ids,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.name, generated.prefix, generated.hash, JSON.stringify(input.scopes ?? ['notifications:send', 'deliveries:read']), JSON.stringify(input.destinationIds ?? []), timestamp);
    this.audit('admin', 'api_key.create', 'api_key', id, { prefix: generated.prefix });
    return { apiKey: this.getKey(id)!, secret: generated.secret };
  }

  private keyFrom(row: Row): ApiKey {
    return {
      id: String(row.id), name: String(row.name), prefix: String(row.prefix), scopes: json<string[]>(row.scopes, []),
      destinationIds: json<string[]>(row.destination_ids, []), lastUsedAt: row.last_used_at ? String(row.last_used_at) : undefined,
      createdAt: String(row.created_at), revokedAt: row.revoked_at ? String(row.revoked_at) : undefined
    };
  }

  getKey(id: string): ApiKey | undefined {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE id=?').get(id) as Row | undefined;
    return row ? this.keyFrom(row) : undefined;
  }

  listKeys(): ApiKey[] {
    return (this.db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as Row[]).map((row) => this.keyFrom(row));
  }

  authenticateKey(secret: string): ApiKey | undefined {
    const prefix = /^rdk_([a-f0-9]{8})_/.exec(secret)?.[1];
    if (!prefix) return undefined;
    const row = this.db.prepare('SELECT * FROM api_keys WHERE prefix=? AND revoked_at IS NULL').get(prefix) as Row | undefined;
    if (!row || !safeSecretEqual(secret, String(row.secret_hash))) return undefined;
    this.db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now(), row.id);
    return this.keyFrom({ ...row, last_used_at: now() });
  }

  revokeKey(id: string): void {
    this.db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=?').run(now(), id);
    this.audit('admin', 'api_key.revoke', 'api_key', id, {});
  }

  createDelivery(input: {
    targetType: 'channel' | 'route'; targetId: string; title: string; body: string; severity: Severity;
    url?: string; metadata?: Record<string, unknown>; source: string; idempotencyKey?: string; channelIds: string[];
  }): Delivery {
    if (input.idempotencyKey) {
      const existing = this.db.prepare('SELECT id FROM deliveries WHERE source=? AND idempotency_key=?').get(input.source, input.idempotencyKey) as Row | undefined;
      if (existing) return this.getDelivery(String(existing.id))!;
    }
    const id = randomUUID();
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO deliveries
        (id,target_type,target_id,title,body,severity,url,metadata,source,status,idempotency_key,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?,?)`).run(
        id, input.targetType, input.targetId, input.title, input.body, input.severity, input.url ?? null,
        JSON.stringify(input.metadata ?? {}), input.source, input.idempotencyKey ?? null, timestamp, timestamp
      );
      const insertAttempt = this.db.prepare(`INSERT INTO attempts
        (id,delivery_id,channel_id,position,status,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
      input.channelIds.forEach((channelId, position) => insertAttempt.run(randomUUID(), id, channelId, position, 'pending', timestamp, timestamp, timestamp));
    });
    transaction();
    return this.getDelivery(id)!;
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

  getAttempts(deliveryId: string): DeliveryAttempt[] {
    return (this.db.prepare(`SELECT a.*,c.name channel_name,c.provider provider FROM attempts a
      JOIN channels c ON c.id=a.channel_id WHERE a.delivery_id=? ORDER BY a.position`).all(deliveryId) as Row[]).map((row) => this.attemptFrom(row));
  }

  private deliveryFrom(row: Row, withAttempts = false): Delivery {
    const delivery: Delivery = {
      id: String(row.id), targetType: row.target_type as Delivery['targetType'], targetId: String(row.target_id),
      targetName: row.target_name ? String(row.target_name) : undefined, title: String(row.title), body: String(row.body),
      severity: row.severity as Severity, url: row.url ? String(row.url) : undefined,
      metadata: json<Record<string, unknown>>(row.metadata, {}), source: String(row.source), status: row.status as Delivery['status'],
      idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
    if (withAttempts) delivery.attempts = this.getAttempts(delivery.id);
    return delivery;
  }

  getDelivery(id: string): Delivery | undefined {
    const row = this.db.prepare(`SELECT d.*,COALESCE(c.name,r.name) target_name FROM deliveries d
      LEFT JOIN channels c ON d.target_type='channel' AND c.id=d.target_id
      LEFT JOIN routes r ON d.target_type='route' AND r.id=d.target_id WHERE d.id=?`).get(id) as Row | undefined;
    return row ? this.deliveryFrom(row, true) : undefined;
  }

  listDeliveries(options: { limit?: number; status?: string } = {}): Delivery[] {
    const limit = Math.min(options.limit ?? 50, 200);
    const rows = options.status
      ? this.db.prepare('SELECT * FROM deliveries WHERE status=? ORDER BY created_at DESC LIMIT ?').all(options.status, limit)
      : this.db.prepare('SELECT * FROM deliveries ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as Row[]).map((row) => this.deliveryFrom(row));
  }

  claimDueAttempts(limit: number): DeliveryAttempt[] {
    const rows = this.db.prepare(`SELECT a.*,c.name channel_name,c.provider provider FROM attempts a
      JOIN channels c ON c.id=a.channel_id JOIN deliveries d ON d.id=a.delivery_id
      LEFT JOIN routes r ON d.target_type='route' AND r.id=d.target_id
      WHERE a.status IN ('pending','retrying') AND a.next_attempt_at<=? AND c.enabled=1
      AND (r.strategy IS NULL OR r.strategy<>'fallback' OR (
        NOT EXISTS (SELECT 1 FROM attempts won WHERE won.delivery_id=a.delivery_id AND won.status='delivered')
        AND a.position=(SELECT MIN(next.position) FROM attempts next WHERE next.delivery_id=a.delivery_id AND next.status IN ('pending','retrying'))
      ))
      ORDER BY a.next_attempt_at,a.position LIMIT ?`).all(now(), limit) as Row[];
    const claimed: DeliveryAttempt[] = [];
    const claim = this.db.transaction(() => {
      for (const row of rows) {
        const result = this.db.prepare(`UPDATE attempts SET status='sending',attempt_count=attempt_count+1,updated_at=?
          WHERE id=? AND status IN ('pending','retrying')`).run(now(), row.id);
        if (result.changes) {
          this.db.prepare("UPDATE deliveries SET status='processing',updated_at=? WHERE id=? AND status='queued'").run(now(), row.delivery_id);
          claimed.push(this.attemptFrom({ ...row, status: 'sending', attempt_count: Number(row.attempt_count) + 1 }));
        }
      }
    });
    claim();
    return claimed;
  }

  /** 限流/静默推迟：不消耗尝试次数，回到待发送状态 */
  deferAttempt(id: string, until: string): void {
    this.db.prepare(`UPDATE attempts SET status='pending',attempt_count=MAX(attempt_count-1,0),next_attempt_at=?,updated_at=? WHERE id=?`).run(until, now(), id);
  }

  completeAttempt(id: string, result: { success: boolean; responseCode?: number; error?: string; retryAt?: string }): void {
    const attempt = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id) as Row | undefined;
    if (!attempt) return;
    const status = result.success ? 'delivered' : result.retryAt ? 'retrying' : 'failed';
    this.db.prepare('UPDATE attempts SET status=?,response_code=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?').run(
      status, result.responseCode ?? null, result.error ?? null, result.retryAt ?? null, now(), id
    );
    this.refreshDeliveryStatus(String(attempt.delivery_id));
  }

  skipAttempts(deliveryId: string, exceptId: string): void {
    this.db.prepare("UPDATE attempts SET status='skipped',updated_at=? WHERE delivery_id=? AND id<>? AND status IN ('pending','retrying')")
      .run(now(), deliveryId, exceptId);
    this.refreshDeliveryStatus(deliveryId);
  }

  private refreshDeliveryStatus(deliveryId: string): void {
    const delivery = this.db.prepare('SELECT target_type,target_id FROM deliveries WHERE id=?').get(deliveryId) as Row;
    const attempts = this.getAttempts(deliveryId);
    const route = delivery.target_type === 'route' ? this.getRoute(String(delivery.target_id)) : undefined;
    const delivered = attempts.filter((a) => a.status === 'delivered').length;
    const active = attempts.some((a) => ['pending', 'sending', 'retrying'].includes(a.status));
    let status: Delivery['status'];
    if (active) status = 'processing';
    else if (route?.strategy === 'fallback') status = delivered > 0 ? 'delivered' : 'failed';
    else if (delivered === attempts.length && delivered > 0) status = 'delivered';
    else if (delivered > 0) status = 'partial';
    else status = 'failed';
    this.db.prepare('UPDATE deliveries SET status=?,updated_at=? WHERE id=?').run(status, now(), deliveryId);
  }

  getDashboardStats(): DashboardStats {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { count: number }).count);
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const totals = this.db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN status IN ('delivered','partial') THEN 1 ELSE 0 END) successes,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed FROM deliveries WHERE created_at>=?`).get(since) as Row;
    const total = Number(totals.total ?? 0);
    return {
      channels: one('SELECT COUNT(*) count FROM channels'), enabledChannels: one('SELECT COUNT(*) count FROM channels WHERE enabled=1'),
      routes: one('SELECT COUNT(*) count FROM routes'), activeKeys: one('SELECT COUNT(*) count FROM api_keys WHERE revoked_at IS NULL'),
      deliveries24h: total, successRate24h: total ? Math.round(Number(totals.successes ?? 0) / total * 1000) / 10 : 100,
      failed24h: Number(totals.failed ?? 0)
    };
  }

  audit(actor: string, action: string, resourceType: string, resourceId: string | undefined, details: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO audit_events (id,actor,action,resource_type,resource_id,details,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), actor, action, resourceType, resourceId ?? null, JSON.stringify(details), now());
  }
}
