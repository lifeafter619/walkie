import { randomUUID } from 'node:crypto';
import type {
  AdminTokenStatus,
  ApiKey,
  Channel,
  Conversation,
  CredentialStatus,
  DashboardStats,
  Delivery,
  DeliveryAttempt,
  Destination,
  MasterKeyStatus,
  ProviderId,
  Route,
  RouteStrategy,
  Severity
} from '../shared/types.js';
import {
  adminTokenPrefix,
  createApiSecret,
  decryptJson,
  encryptJson,
  generateDek,
  hashSecret,
  keyFingerprint,
  unwrapDek,
  wrapDek
} from './crypto.js';

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
/** 查询 limit 参数消毒：非法/非正数回退默认值，封顶 cap */
const clampLimit = (value: number | undefined, fallback: number, cap: number): number =>
  Number.isFinite(value) && (value as number) > 0 ? Math.min(Math.floor(value as number), cap) : fallback;
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === 'string' ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
};

export class RelayRepository {
  readonly db: RelayDatabase;
  /** 数据加密密钥(DEK)：加密频道凭据与 Agent 可逆密文。构造时为空，init() 后可用。 */
  private dek?: Buffer;
  /** 写锁：DEK 轮换期间串行化所有会读写加密字段的操作，防止快照与提交之间的并发写入用旧 DEK 加密 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(database: RelayDatabase, private readonly masterKey: Buffer) {
    this.db = database;
  }

  /** 当前应使用的加密密钥：优先 DEK；DEK 未自举时退回 KEK（兼容迁移失败重试场景） */
  private encryptionKey(): Buffer {
    return this.dek ?? this.masterKey;
  }

  /** 内存 DEK 对应的 dek_version；多实例部署（Vercel+Turso）下用于检测他实例已轮换 */
  private dekVersion = 1;

  /** 重新从 settings 加载 DEK：他实例轮换后，本实例内存里的旧 DEK 解不开新密文 */
  private async reloadDek(): Promise<void> {
    const dekRow = await this.db.get("SELECT value FROM settings WHERE key='dek_wrapped'");
    if (dekRow) this.dek = unwrapDek(String(dekRow.value), this.masterKey);
    const versionRow = await this.db.get("SELECT value FROM settings WHERE key='dek_version'");
    this.dekVersion = versionRow ? Number(versionRow.value) : 1;
  }

  /** 加密写入前校验 DEK 未被他实例轮换：拿过期 DEK 写入会产生所有实例都解不开的密文 */
  private async ensureFreshDek(): Promise<void> {
    const row = await this.db.get("SELECT value FROM settings WHERE key='dek_version'");
    if ((row ? Number(row.value) : 1) !== this.dekVersion) await this.reloadDek();
  }

  /** 串行化会读写加密字段的操作（createChannel/createKey/rotateMasterKey/init DEK自举），
   *  防止 DEK 轮换的快照-提交间隙内并发写入用旧 DEK 加密导致数据不可解密。 */
  private withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    // 失败不阻断后续锁；成功则接续
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
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
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const channelColumns = new Set((await this.db.all('PRAGMA table_info(channels)')).map((row) => String(row.name)));
    if (!channelColumns.has('rate_limit_per_min')) await this.db.exec('ALTER TABLE channels ADD COLUMN rate_limit_per_min INTEGER');
    if (!channelColumns.has('quiet_hours')) await this.db.exec('ALTER TABLE channels ADD COLUMN quiet_hours TEXT');
    const conversationColumns = new Set((await this.db.all('PRAGMA table_info(conversations)')).map((row) => String(row.name)));
    if (!conversationColumns.has('options')) await this.db.exec('ALTER TABLE conversations ADD COLUMN options TEXT');
    const keyColumns = new Set((await this.db.all('PRAGMA table_info(api_keys)')).map((row) => String(row.name)));
    if (!keyColumns.has('secret_encrypted')) await this.db.exec('ALTER TABLE api_keys ADD COLUMN secret_encrypted TEXT');
    // 密钥按哈希直查（支持自定义密钥），哈希必须唯一；历史数据全是随机值，无碰撞
    await this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS api_keys_secret_hash ON api_keys(secret_hash)');
    // DEK 自举：无包裹记录则生成新 DEK 并把现存频道凭据从 KEK 迁到 DEK（原子事务）
    const dekRow = await this.db.get("SELECT value FROM settings WHERE key='dek_wrapped'");
    if (dekRow) {
      this.dek = unwrapDek(String(dekRow.value), this.masterKey);
      const versionRow = await this.db.get("SELECT value FROM settings WHERE key='dek_version'");
      this.dekVersion = versionRow ? Number(versionRow.value) : 1;
    } else {
      const freshDek = generateDek();
      // 迁移前先用 KEK 读出所有频道凭据，再用新 DEK 加密写回，全部在一个事务内
      const channels = await this.db.all('SELECT id, config_encrypted FROM channels');
      const reencrypt = channels.map((row) => {
        const config = decryptJson(String(row.config_encrypted), this.masterKey);
        return { sql: 'UPDATE channels SET config_encrypted=? WHERE id=?', params: [encryptJson(config, freshDek), String(row.id)] };
      });
      const timestamp = now();
      await this.db.batch([
        ...reencrypt,
        { sql: "INSERT INTO settings (key,value,updated_at) VALUES ('dek_wrapped',?,?)", params: [wrapDek(freshDek, this.masterKey), timestamp] },
        { sql: "INSERT INTO settings (key,value,updated_at) VALUES ('dek_version',?,?)", params: ['1', timestamp] },
        { sql: "INSERT INTO settings (key,value,updated_at) VALUES ('dek_rotated_at',?,?)", params: [timestamp, timestamp] }
      ]);
      this.dek = freshDek;
    }
  }

  private channelFrom(row: Row): Channel {
    const config = decryptJson(String(row.config_encrypted), this.encryptionKey());
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
    const rows = await this.db.all('SELECT * FROM channels ORDER BY name');
    try {
      return rows.map((row) => this.channelFrom(row));
    } catch {
      // 解密失败可能是他实例轮换了 DEK：重载后重试一次（仍失败则按真实错误抛出）
      await this.reloadDek();
      return rows.map((row) => this.channelFrom(row));
    }
  }

  async getChannel(idOrSlug: string): Promise<Channel | undefined> {
    const row = await this.db.get('SELECT * FROM channels WHERE id = ? OR slug = ?', [idOrSlug, idOrSlug]);
    if (!row) return undefined;
    try {
      return this.channelFrom(row);
    } catch {
      await this.reloadDek();
      return this.channelFrom(row);
    }
  }

  async getChannelConfig(id: string): Promise<Record<string, unknown>> {
    const row = await this.db.get('SELECT config_encrypted FROM channels WHERE id = ?', [id]);
    if (!row) throw new Error('Channel not found');
    try {
      return decryptJson(String(row.config_encrypted), this.encryptionKey());
    } catch {
      await this.reloadDek();
      return decryptJson(String(row.config_encrypted), this.encryptionKey());
    }
  }

  async createChannel(input: { name: string; slug: string; provider: ProviderId; enabled?: boolean; config: Record<string, unknown>; rateLimitPerMin?: number | null; quietHours?: string | null }, actor = 'admin'): Promise<Channel> {
    return this.withWriteLock(async () => {
      await this.ensureFreshDek();
      const id = randomUUID();
      const timestamp = now();
      await this.db.run(`INSERT INTO channels
        (id,name,slug,provider,config_encrypted,enabled,rate_limit_per_min,quiet_hours,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, input.name, input.slug, input.provider, encryptJson(input.config, this.encryptionKey()), input.enabled === false ? 0 : 1, input.rateLimitPerMin || null, input.quietHours || null, timestamp, timestamp]);
      await this.audit(actor, 'channel.create', 'channel', id, { provider: input.provider });
      return (await this.getChannel(id))!;
    });
  }

  async updateChannel(id: string, input: Partial<{ name: string; slug: string; provider: ProviderId; enabled: boolean; config: Record<string, unknown>; rateLimitPerMin: number | null; quietHours: string | null }>, actor = 'admin'): Promise<Channel> {
    return this.withWriteLock(async () => {
      const current = await this.getChannel(id);
      if (!current) throw new Error('Channel not found');
      await this.ensureFreshDek();
      // getChannel 按 id/slug 双解析，写回必须用解析出的真实 id（传 slug 时 WHERE id=slug 会静默 no-op）
      const config = input.config ? { ...await this.getChannelConfig(current.id), ...input.config } : await this.getChannelConfig(current.id);
      await this.db.run(`UPDATE channels SET name=?,slug=?,provider=?,enabled=?,config_encrypted=?,rate_limit_per_min=?,quiet_hours=?,updated_at=? WHERE id=?`, [
        input.name ?? current.name, input.slug ?? current.slug, input.provider ?? current.provider,
        input.enabled ?? current.enabled ? 1 : 0, encryptJson(config, this.encryptionKey()),
        input.rateLimitPerMin !== undefined ? input.rateLimitPerMin || null : current.rateLimitPerMin ?? null,
        input.quietHours !== undefined ? input.quietHours || null : current.quietHours ?? null,
        now(), current.id
      ]);
      // 禁用频道后，其未完结的 attempt 再也不会被 claim，必须就地失败并推进投递终态，否则投递永久停在 processing
      if (input.enabled === false) await this.failAttemptsForDisabledChannel(current.id);
      await this.audit(actor, 'channel.update', 'channel', current.id, {});
      return (await this.getChannel(current.id))!;
    });
  }

  async setChannelTest(id: string, success: boolean, error?: string): Promise<void> {
    await this.db.run('UPDATE channels SET last_test_status=?,last_test_error=?,updated_at=? WHERE id=?',
      [success ? 'success' : 'failed', error ?? null, now(), id]);
  }

  async deleteChannel(id: string, actor = 'admin'): Promise<void> {
    // 先解析真实 id：调用方可能传 slug，直接拿参数写 WHERE id=? 会静默 no-op 却返回成功
    const current = await this.getChannel(id);
    if (!current) return;
    const used = (await this.db.get("SELECT COUNT(*) count FROM attempts WHERE channel_id=?", [current.id])) as { count: number };
    const routed = (await this.db.get('SELECT COUNT(*) count FROM routes, json_each(routes.channel_ids) WHERE json_each.value=?', [current.id])) as { count: number };
    if (used.count > 0 || routed.count > 0) {
      await this.db.run('UPDATE channels SET enabled=0,updated_at=? WHERE id=?', [now(), current.id]);
      // 软删除同样要终结未完结 attempt，否则投递永久停在 processing
      await this.failAttemptsForDisabledChannel(current.id);
      return;
    }
    await this.db.run('DELETE FROM channels WHERE id=?', [current.id]);
    await this.audit(actor, 'channel.delete', 'channel', current.id, {});
  }

  /** 频道被禁用/软删除后，其 pending/retrying/sending attempt 就地失败，并刷新受影响投递的终态 */
  private async failAttemptsForDisabledChannel(channelId: string): Promise<void> {
    const ts = now();
    const rows = await this.db.all(`SELECT DISTINCT delivery_id FROM attempts WHERE channel_id=? AND status IN ('pending','retrying','sending')`, [channelId]);
    await this.db.run(`UPDATE attempts SET status='failed',error='频道已禁用，尝试终止',next_attempt_at=NULL,updated_at=? WHERE channel_id=? AND status IN ('pending','retrying','sending')`, [ts, channelId]);
    for (const row of rows) await this.refreshDeliveryStatus(String(row.delivery_id));
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

  async createRoute(input: { name: string; slug: string; strategy: RouteStrategy; channelIds: string[]; enabled?: boolean }, actor = 'admin'): Promise<Route> {
    const id = randomUUID();
    const timestamp = now();
    await this.db.run('INSERT INTO routes (id,name,slug,strategy,channel_ids,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, input.name, input.slug, input.strategy, JSON.stringify(input.channelIds), input.enabled === false ? 0 : 1, timestamp, timestamp]);
    await this.audit(actor, 'route.create', 'route', id, { strategy: input.strategy });
    return (await this.getRoute(id))!;
  }

  async updateRoute(id: string, input: Partial<{ name: string; slug: string; strategy: RouteStrategy; channelIds: string[]; enabled: boolean }>, actor = 'admin'): Promise<Route> {
    const current = await this.getRoute(id);
    if (!current) throw new Error('Route not found');
    // getRoute 按 id/slug 双解析，写回用真实 id（传 slug 时 WHERE id=slug 会静默 no-op）
    await this.db.run('UPDATE routes SET name=?,slug=?,strategy=?,channel_ids=?,enabled=?,updated_at=? WHERE id=?', [
      input.name ?? current.name, input.slug ?? current.slug, input.strategy ?? current.strategy,
      JSON.stringify(input.channelIds ?? current.channelIds), input.enabled ?? current.enabled ? 1 : 0, now(), current.id
    ]);
    await this.audit(actor, 'route.update', 'route', current.id, {});
    return (await this.getRoute(current.id))!;
  }

  async deleteRoute(id: string, actor = 'admin'): Promise<void> {
    const current = await this.getRoute(id);
    if (!current) return;
    // 在途投递还要靠路由行判定 fallback 语义（claim 时 JOIN routes 取 strategy），
    // 此时硬删会让 fallback 退化成 fanout（备份频道全发一遍）；先软禁用，投递完结后可再删
    const active = (await this.db.get(`SELECT COUNT(*) count FROM deliveries WHERE target_type='route' AND target_id=? AND status IN ('queued','processing')`, [current.id])) as { count: number };
    if (active.count > 0) {
      await this.db.run('UPDATE routes SET enabled=0,updated_at=? WHERE id=?', [now(), current.id]);
      await this.audit(actor, 'route.disable', 'route', current.id, { reason: 'delete-deferred-active-deliveries' });
      return;
    }
    await this.db.run('DELETE FROM routes WHERE id=?', [current.id]);
    await this.audit(actor, 'route.delete', 'route', current.id, {});
  }

  async listDestinations(): Promise<Destination[]> {
    const [channels, routes] = await Promise.all([this.listChannels(), this.listRoutes()]);
    return [
      ...channels.map((c): Destination => ({ id: c.id, slug: c.slug, name: c.name, kind: 'channel', provider: c.provider, enabled: c.enabled })),
      ...routes.map((r): Destination => ({ id: r.id, slug: r.slug, name: r.name, kind: 'route', strategy: r.strategy, enabled: r.enabled }))
    ];
  }

  async createKey(input: { name: string; scopes?: string[]; destinationIds?: string[]; secret?: string }): Promise<{ apiKey: ApiKey; secret: string }> {
    return this.withWriteLock(async () => {
      await this.ensureFreshDek();
      const id = randomUUID();
      const timestamp = now();
      // 生成密钥前缀仅 32 位，UNIQUE 碰撞时重新生成；自定义密钥前缀取哈希前 8 位（仅展示用）
      for (let attempt = 0; ; attempt += 1) {
        const generated = input.secret
          ? { secret: input.secret, prefix: hashSecret(input.secret).slice(0, 8), hash: hashSecret(input.secret) }
          : createApiSecret();
        const secretEncrypted = encryptJson({ s: generated.secret }, this.encryptionKey());
        try {
          await this.db.run('INSERT INTO api_keys (id,name,prefix,secret_hash,secret_encrypted,scopes,destination_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
            [id, input.name, generated.prefix, generated.hash, secretEncrypted, JSON.stringify(input.scopes ?? ['notifications:send', 'deliveries:read']), JSON.stringify(input.destinationIds ?? []), timestamp]);
          await this.audit('admin', 'api_key.create', 'api_key', id, { prefix: generated.prefix });
          return { apiKey: (await this.getKey(id))!, secret: generated.secret };
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (/UNIQUE constraint failed: api_keys\.secret_hash/.test(message)) throw new Error('该密钥已被其他 Agent Key 使用（含已吊销的），请换一个');
          if (/UNIQUE constraint failed: api_keys\.prefix/.test(message)) {
            if (!input.secret && attempt < 3) continue;
            throw new Error('密钥前缀冲突，请换一个自定义密钥');
          }
          throw error;
        }
      }
    });
  }

  private keyFrom(row: Row): ApiKey {
    let secret: string | undefined;
    const encrypted = row.secret_encrypted ? String(row.secret_encrypted) : undefined;
    if (encrypted) {
      try {
        secret = String(decryptJson(encrypted, this.encryptionKey()).s);
      } catch {
        secret = undefined; // DEK 不匹配（迁移期/异常），按不可查看处理
      }
    }
    return {
      id: String(row.id), name: String(row.name), prefix: String(row.prefix), scopes: json<string[]>(row.scopes, []),
      destinationIds: json<string[]>(row.destination_ids, []), lastUsedAt: row.last_used_at ? String(row.last_used_at) : undefined,
      createdAt: String(row.created_at), revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
      secret, viewable: Boolean(secret)
    };
  }

  async getKey(id: string): Promise<ApiKey | undefined> {
    const row = await this.db.get('SELECT * FROM api_keys WHERE id=?', [id]);
    return row ? this.keyFrom(row) : undefined;
  }

  async listKeys(): Promise<ApiKey[]> {
    return (await this.db.all('SELECT * FROM api_keys ORDER BY created_at DESC')).map((row) => this.keyFrom(row));
  }

  /** 密钥鉴权：按 sha256 哈希直查（唯一索引），生成密钥与自定义密钥统一处理 */
  async authenticateKey(secret: string): Promise<ApiKey | undefined> {
    if (!secret) return undefined;
    const row = await this.db.get('SELECT * FROM api_keys WHERE secret_hash=? AND revoked_at IS NULL', [hashSecret(secret)]);
    if (!row) return undefined;
    await this.db.run('UPDATE api_keys SET last_used_at=? WHERE id=?', [now(), row.id]);
    return this.keyFrom({ ...row, last_used_at: now() });
  }

  async revokeKey(id: string): Promise<void> {
    await this.db.run('UPDATE api_keys SET revoked_at=? WHERE id=?', [now(), id]);
    await this.audit('admin', 'api_key.revoke', 'api_key', id, {});
  }

  /** 重新启用已吊销的密钥：清空 revoked_at，恢复鉴权 */
  async restoreKey(id: string): Promise<void> {
    await this.db.run('UPDATE api_keys SET revoked_at=NULL WHERE id=?', [id]);
    await this.audit('admin', 'api_key.restore', 'api_key', id, {});
  }

  /** 编辑 Key 的名称/scope/目的地白名单；不改动密钥本身（换密钥走吊销重建） */
  async updateKey(id: string, input: { name?: string; scopes?: string[]; destinationIds?: string[] }): Promise<ApiKey> {
    const COLUMNS = { name: 'name', scopes: 'scopes', destinationIds: 'destination_ids' } as const;
    const fields = (Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>).filter((field) => input[field] !== undefined);
    const existing = await this.getKey(id);
    if (!existing) throw new Error('Key not found');
    if (fields.length) {
      const params = fields.map((field) => field === 'name' ? input.name! : JSON.stringify(input[field]));
      await this.db.run(`UPDATE api_keys SET ${fields.map((field) => `${COLUMNS[field]}=?`).join(', ')} WHERE id=?`, [...params, id]);
      await this.audit('admin', 'api_key.update', 'api_key', id, { fields });
    }
    return (await this.getKey(id))!;
  }

  /** 彻底删除密钥记录（不可恢复）。删除前应先吊销，确保缓存/会话立即失效 */
  async deleteKey(id: string): Promise<void> {
    await this.db.run('DELETE FROM api_keys WHERE id=?', [id]);
    await this.audit('admin', 'api_key.delete', 'api_key', id, {});
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
    try {
      await this.db.batch([
        {
          sql: `INSERT INTO deliveries
            (id,target_type,target_id,title,body,severity,url,metadata,source,status,idempotency_key,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
          params: [id, input.targetType, input.targetId, input.title, input.body, input.severity, input.url ?? null,
            JSON.stringify(input.metadata ?? {}), input.source, input.idempotencyKey || null, timestamp, timestamp]
        },
        ...input.channelIds.map((channelId, position) => ({
          sql: `INSERT INTO attempts
            (id,delivery_id,channel_id,position,status,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
          params: [randomUUID(), id, channelId, position, 'pending', timestamp, timestamp, timestamp]
        }))
      ]);
    } catch (error) {
      // 幂等键并发竞争：撞 UNIQUE 时返回先到者，而不是让调用方收到 409
      if (input.idempotencyKey && error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        const existing = await this.db.get('SELECT id FROM deliveries WHERE source=? AND idempotency_key=?', [input.source, input.idempotencyKey]);
        if (existing) return (await this.getDelivery(String(existing.id)))!;
      }
      throw error;
    }
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
    const limit = clampLimit(options.limit, 50, 200);
    // 与 getDelivery 同样带出目的地名称，前端列表不用拿 UUID 充数
    const base = `SELECT d.*,COALESCE(c.name,r.name) target_name FROM deliveries d
      LEFT JOIN channels c ON d.target_type='channel' AND c.id=d.target_id
      LEFT JOIN routes r ON d.target_type='route' AND r.id=d.target_id`;
    const rows = options.status
      ? await this.db.all(`${base} WHERE d.status=? ORDER BY d.created_at DESC LIMIT ?`, [options.status, limit])
      : await this.db.all(`${base} ORDER BY d.created_at DESC LIMIT ?`, [limit]);
    return rows.map((row) => this.deliveryFrom(row));
  }

  /**
   * 回收因 worker 崩溃/超时而滞留在 'sending' 状态的尝试。
   * 超过阈值（5分钟）未完结的 sending 视为滞留：尝试次数未达上限则退回 pending 等待重试，
   * 否则直接失败，避免长期阻塞 fallback 链。
   */
  private async reclaimStuckSending(maxAttempts = 4): Promise<void> {
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    const stuck = await this.db.all("SELECT id,delivery_id,attempt_count FROM attempts WHERE status='sending' AND updated_at<?", [cutoff]);
    if (stuck.length === 0) return;
    const ts = now();
    for (const row of stuck) {
      const retryable = Number(row.attempt_count) < maxAttempts;
      await this.db.run("UPDATE attempts SET status=?,next_attempt_at=?,updated_at=? WHERE id=? AND status='sending'",
        [retryable ? 'pending' : 'failed', retryable ? ts : null, ts, String(row.id)]);
      await this.refreshDeliveryStatus(String(row.delivery_id));
    }
  }

  async claimDueAttempts(limit: number, maxAttempts = 4): Promise<DeliveryAttempt[]> {
    await this.reclaimStuckSending(maxAttempts);
    const rows = await this.db.all(`SELECT a.*,c.name channel_name,c.provider provider FROM attempts a
      JOIN channels c ON c.id=a.channel_id JOIN deliveries d ON d.id=a.delivery_id
      LEFT JOIN routes r ON d.target_type='route' AND r.id=d.target_id
      WHERE a.status IN ('pending','retrying') AND a.next_attempt_at<=? AND c.enabled=1
      AND (r.strategy IS NULL OR r.strategy<>'fallback' OR (
        NOT EXISTS (SELECT 1 FROM attempts won WHERE won.delivery_id=a.delivery_id AND won.status='delivered')
        AND a.position=(SELECT MIN(next.position) FROM attempts next
          JOIN channels nc ON nc.id=next.channel_id
          WHERE next.delivery_id=a.delivery_id AND nc.enabled=1 AND next.status IN ('pending','sending','retrying'))
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
    const row = await this.db.get("SELECT MIN(a.next_attempt_at) next_at FROM attempts a JOIN channels c ON c.id=a.channel_id WHERE a.status IN ('pending','retrying') AND c.enabled=1");
    return row?.next_at ? String(row.next_at) : undefined;
  }

  /** 是否存在滞留 sending 的尝试；Workers 用它设兜底 alarm。
   *  不看时间阈值：刚崩溃的行也只有几秒新，等 5 分钟阈值到了才查就永远查不到（那时已无人再查）。
   *  兜底 alarm 定 6 分钟后触发，届时 claimDueAttempts 的 5 分钟回收自然接手。 */
  async hasStuckSending(): Promise<boolean> {
    const row = await this.db.get("SELECT 1 stuck FROM attempts WHERE status='sending' LIMIT 1");
    return Boolean(row?.stuck);
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
    const limit = clampLimit(options.limit, 50, 200);
    const rows = options.pendingOnly
      ? await this.db.all('SELECT * FROM conversations WHERE replied_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT ?', [now(), limit])
      : await this.db.all('SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map((row) => this.conversationFrom(row));
  }

  /** 限流/静默推迟：回到待发送状态。
   *  consumeAttempt=false（静默期）：不消耗尝试次数（attempt_count 减回 claimDueAttempts 的 +1）。
   *  consumeAttempt=true（限流）：保留 attempt_count 增长，避免持续限流导致无限 defer 循环。 */
  async deferAttempt(id: string, until: string, consumeAttempt = false): Promise<void> {
    const countExpr = consumeAttempt ? 'attempt_count' : 'MAX(attempt_count-1,0)';
    await this.db.run(`UPDATE attempts SET status='pending',attempt_count=${countExpr},next_attempt_at=?,updated_at=? WHERE id=?`, [until, now(), id]);
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
    const delivery = await this.db.get('SELECT target_type,target_id FROM deliveries WHERE id=?', [deliveryId]);
    if (!delivery) return;
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

  /* ────────────────────────────────────────────────────────────
   * 凭据管理：管理令牌轮换、主密钥(DEK)轮换、凭据状态
   * ──────────────────────────────────────────────────────────── */

  /** 读取轮换过的管理令牌哈希（比较用）；无则 undefined */
  async getAdminTokenHash(): Promise<{ hash?: string; prefix?: string }> {
    const row = await this.db.get("SELECT value FROM settings WHERE key='admin_token_hash'");
    const prefixRow = await this.db.get("SELECT value FROM settings WHERE key='admin_token_prefix'");
    return row ? { hash: String(row.value), prefix: prefixRow ? String(prefixRow.value) : undefined } : {};
  }

  /** 存储新管理令牌（哈希 + 前缀），返回前缀预览。明文由调用方返回一次后丢弃。 */
  async setAdminToken(token: string): Promise<{ prefix: string }> {
    const prefix = adminTokenPrefix(token);
    const timestamp = now();
    await this.db.batch([
      { sql: "INSERT INTO settings (key,value,updated_at) VALUES ('admin_token_hash',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params: [hashSecret(token), timestamp] },
      { sql: "INSERT INTO settings (key,value,updated_at) VALUES ('admin_token_prefix',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params: [prefix, timestamp] }
    ]);
    await this.audit('admin', 'credential.admin_token.rotate', 'credential', 'admin_token', {});
    return { prefix };
  }

  /** 凭据综合状态：管理令牌来源 + 主密钥(KEK/DEK)状态 */
  async getCredentialStatus(envAdminConfigured: boolean): Promise<CredentialStatus> {
    const adminHash = await this.getAdminTokenHash();
    const dekVersionRow = await this.db.get("SELECT value FROM settings WHERE key='dek_version'");
    const rotatedAtRow = await this.db.get("SELECT value FROM settings WHERE key='dek_rotated_at'");
    const dekVersion = dekVersionRow ? Number(dekVersionRow.value) : 1;
    const admin: AdminTokenStatus = adminHash.hash
      ? { source: 'rotated', rotated: true, prefix: adminHash.prefix, envConfigured: envAdminConfigured }
      : { source: 'env', rotated: false, envConfigured: envAdminConfigured };
    const masterKey: MasterKeyStatus = {
      kekFingerprint: keyFingerprint(this.masterKey),
      dekVersion,
      rotatedAt: rotatedAtRow ? String(rotatedAtRow.value) : undefined
    };
    return { admin, masterKey };
  }

  /**
   * 轮换数据加密密钥(DEK)：生成新 DEK2，逐条把频道凭据与 Agent 可逆密文
   * 用旧 DEK 解、新 DEK2 加，单事务原子写回。env MASTER_KEY(KEK) 不变。
   */
  async rotateMasterKey(): Promise<{ version: number; rotatedAt: string }> {
    return this.withWriteLock(async () => {
      await this.ensureFreshDek();
      if (!this.dek) throw new Error('DEK 尚未初始化');
      const oldDek = this.dek;
      const newDek = generateDek();
      const timestamp = now();
      const channels = await this.db.all('SELECT id, config_encrypted FROM channels');
      const keys = await this.db.all('SELECT id, secret_encrypted FROM api_keys WHERE secret_encrypted IS NOT NULL');
      const reencryptChannels = channels.map((row) => {
        const config = decryptJson(String(row.config_encrypted), oldDek);
        return { sql: 'UPDATE channels SET config_encrypted=? WHERE id=?', params: [encryptJson(config, newDek), String(row.id)] };
      });
      const reencryptKeys = keys.map((row) => {
        const payload = decryptJson(String(row.secret_encrypted), oldDek);
        return { sql: 'UPDATE api_keys SET secret_encrypted=? WHERE id=?', params: [encryptJson(payload, newDek), String(row.id)] };
      });
      const currentVersionRow = await this.db.get("SELECT value FROM settings WHERE key='dek_version'");
      const nextVersion = (currentVersionRow ? Number(currentVersionRow.value) : 1) + 1;
      await this.db.batch([
        ...reencryptChannels,
        ...reencryptKeys,
        { sql: "INSERT INTO settings (key,value,updated_at) VALUES ('dek_wrapped',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params: [wrapDek(newDek, this.masterKey), timestamp] },
        { sql: "INSERT INTO settings (key,value,updated_at) VALUES ('dek_version',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params: [String(nextVersion), timestamp] },
        { sql: "INSERT INTO settings (key,value,updated_at) VALUES ('dek_rotated_at',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params: [timestamp, timestamp] }
      ]);
      this.dek = newDek;
      this.dekVersion = nextVersion;
      await this.audit('admin', 'credential.master_key.rotate', 'credential', 'dek', { version: nextVersion });
      return { version: nextVersion, rotatedAt: timestamp };
    });
  }

  async listAuditEvents(limit = 100): Promise<Array<{ id: string; actor: string; action: string; resourceType: string; resourceId?: string; details: Record<string, unknown>; createdAt: string }>> {
    const rows = await this.db.all('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map((row) => ({
      id: String(row.id), actor: String(row.actor), action: String(row.action), resourceType: String(row.resource_type),
      resourceId: row.resource_id ? String(row.resource_id) : undefined,
      details: row.details ? JSON.parse(String(row.details)) : {}, createdAt: String(row.created_at)
    }));
  }

  async audit(actor: string, action: string, resourceType: string, resourceId: string | undefined, details: Record<string, unknown>): Promise<void> {
    await this.db.run('INSERT INTO audit_events (id,actor,action,resource_type,resource_id,details,created_at) VALUES (?,?,?,?,?,?,?)',
      [randomUUID(), actor, action, resourceType, resourceId ?? null, JSON.stringify(details), now()]);
  }
}
