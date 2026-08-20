import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { AppConfig } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import type { RelayRepository } from '../src/server/database.js';
import { createNodeRepository } from '../src/server/database-node.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import { DeliveryWorker } from '../src/server/queue.js';
import { decryptJson, encryptJson, generateDek, unwrapDek, wrapDek } from '../src/server/crypto.js';

const ENV_ADMIN_TOKEN = 'a-secure-env-admin-token-with-32-chars';

const repositories: RelayRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

async function setup(adminToken = ENV_ADMIN_TOKEN) {
  const config = {
    port: 4310, host: '127.0.0.1', dataDir: '.', databasePath: ':memory:', adminToken,
    masterKey: randomBytes(32), allowPrivateWebhooks: true, allowInsecureHttp: false,
    deliveryWorkers: 1, maxSendsPerMin: 0, maxDeliveryAttempts: 1, retryBaseMs: 1, isProduction: false, platform: 'node'
  } satisfies AppConfig;
  const repository = await createNodeRepository(':memory:', config.masterKey); repositories.push(repository);
  const notifications = new NotificationService(repository);
  const dispatcher = new ProviderDispatcher(config, async () => new Response('{}', { status: 200 }));
  const worker = new DeliveryWorker(repository, dispatcher, config);
  return { app: createApp({ config, repository, notifications, dispatcher, worker }), repository, config };
}

describe('credential management', () => {
  it('rotates the admin token with a custom value while the env token still authenticates', async () => {
    const { app } = await setup();
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    // 初始状态：来源 env，未轮换
    const initial = (await request(app).get('/api/admin/credentials').set(auth(ENV_ADMIN_TOKEN)).expect(200)).body;
    expect(initial.admin.source).toBe('env');
    expect(initial.admin.rotated).toBe(false);
    expect(initial.admin.envConfigured).toBe(true);
    expect(initial.masterKey.dekVersion).toBe(1);

    // 自定义令牌轮换
    const custom = 'a-custom-rotated-token-with-enough-length';
    const rotated = (await request(app).post('/api/admin/credentials/admin-token').set(auth(ENV_ADMIN_TOKEN)).send({ token: custom }).expect(201)).body;
    expect(rotated.token).toBe(custom);

    // 新令牌可鉴权
    await request(app).get('/api/admin/stats').set(auth(custom)).expect(200);
    // env 令牌仍可鉴权（运行时不可吊销）
    await request(app).get('/api/admin/stats').set(auth(ENV_ADMIN_TOKEN)).expect(200);

    // 状态反映轮换
    const after = (await request(app).get('/api/admin/credentials').set(auth(custom)).expect(200)).body;
    expect(after.admin.source).toBe('rotated');
    expect(after.admin.rotated).toBe(true);
    expect(after.admin.prefix).toBeTruthy();
    expect(after.admin.activeCount).toBe(2);
    expect(after.admin.tokens).toHaveLength(1);
  });

  it('generates a random admin token when no custom value is provided', async () => {
    const { app } = await setup();
    const auth = { Authorization: `Bearer ${ENV_ADMIN_TOKEN}` };
    const result = (await request(app).post('/api/admin/credentials/admin-token').set(auth).send({}).expect(201)).body;
    expect(result.token).toMatch(/^rd_/);
    expect(result.token.length).toBeGreaterThanOrEqual(24);
    // 新生成的随机令牌可鉴权
    await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${result.token}`).expect(200);
  });

  it('keeps multiple admin passwords and refuses to revoke the last active credential', async () => {
    const { app } = await setup('');
    const firstSecret = 'first-admin-password';
    const secondSecret = 'second-admin-password';
    const first = (await request(app).post('/api/admin/credentials/admin-token').send({ name: 'First', token: firstSecret }).expect(201)).body.adminToken;
    const second = (await request(app).post('/api/admin/credentials/admin-token').set('Authorization', `Bearer ${firstSecret}`).send({ name: 'Second', token: secondSecret }).expect(201)).body.adminToken;

    const status = (await request(app).get('/api/admin/credentials').set('Authorization', `Bearer ${secondSecret}`).expect(200)).body;
    expect(status.admin.activeCount).toBe(2);
    expect(status.admin.tokens.map((item: { name: string }) => item.name)).toEqual(['Second', 'First']);

    await request(app).delete(`/api/admin/credentials/admin-tokens/${first.id}`).set('Authorization', `Bearer ${secondSecret}`).expect(204);
    await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${firstSecret}`).expect(401);
    await request(app).delete(`/api/admin/credentials/admin-tokens/${second.id}`).set('Authorization', `Bearer ${secondSecret}`).expect(400, { error: '至少保留一个有效管理密码' });
    await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${secondSecret}`).expect(200);
  });

  it('restores a revoked admin password', async () => {
    const { app } = await setup('');
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    const firstSecret = 'first-restorable-admin-password';
    const secondSecret = 'second-admin-password';
    const first = (await request(app).post('/api/admin/credentials/admin-token').send({ name: 'First', token: firstSecret }).expect(201)).body.adminToken;
    await request(app).post('/api/admin/credentials/admin-token').set(auth(firstSecret)).send({ name: 'Second', token: secondSecret }).expect(201);
    await request(app).delete(`/api/admin/credentials/admin-tokens/${first.id}`).set(auth(secondSecret)).expect(204);
    await request(app).get('/api/admin/stats').set(auth(firstSecret)).expect(401);

    await request(app).post(`/api/admin/credentials/admin-tokens/${first.id}/restore`).set(auth(secondSecret)).expect(200, { success: true });
    await request(app).get('/api/admin/stats').set(auth(firstSecret)).expect(200);
  });

  it('clears audit history and records the clear operation', async () => {
    const { app } = await setup();
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    const authHeader = auth(ENV_ADMIN_TOKEN);
    await request(app).post('/api/admin/credentials/admin-token').set(authHeader).send({ name: 'Audit source', token: 'audit-source-admin-password' }).expect(201);
    const cleared = (await request(app).delete('/api/admin/audit').set(authHeader).expect(200)).body;
    expect(cleared.deleted).toBeGreaterThan(0);
    const events = (await request(app).get('/api/admin/audit').set(authHeader).expect(200)).body.events;
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('audit.clear');
    expect(events[0].details.deleted).toBe(cleared.deleted);
  });

  it('rotates the master key (DEK) and preserves channel credentials + agent key reversibility', async () => {
    const { app, repository } = await setup();
    const auth = { Authorization: `Bearer ${ENV_ADMIN_TOKEN}` };

    // 建一个带凭据的频道
    await request(app).post('/api/admin/channels').set(auth).send({
      name: 'Hook', slug: 'hook', provider: 'webhook',
      config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{"t":"{{title}}"}' }
    }).expect(201);
    const channel = (await repository.listChannels())[0];
    const originalConfig = await repository.getChannelConfig(channel.id);
    expect(originalConfig).toEqual({ url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{"t":"{{title}}"}' });

    // 建 Agent Key
    const created = (await request(app).post('/api/admin/keys').set(auth).send({ name: 'CI agent' }).expect(201)).body;
    const agentSecret = created.secret as string;

    // 轮换前 DEK 版本
    const before = (await request(app).get('/api/admin/credentials').set(auth).expect(200)).body;
    expect(before.masterKey.dekVersion).toBe(1);

    // 轮换主密钥 (DEK)
    const rotated = (await request(app).post('/api/admin/credentials/master-key/rotate').set(auth).expect(200)).body;
    expect(rotated.version).toBe(2);
    expect(rotated.rotatedAt).toBeTruthy();

    // 频道凭据仍可解密且内容不变
    const restoredConfig = await repository.getChannelConfig(channel.id);
    expect(restoredConfig).toEqual(originalConfig);

    // Agent Key 明文仍可解出且与创建时一致
    const listed = (await request(app).get('/api/admin/keys').set(auth).expect(200)).body;
    expect(listed.keys[0].viewable).toBe(true);
    expect(listed.keys[0].secret).toBe(agentSecret);

    // DEK 版本递增
    const after = (await request(app).get('/api/admin/credentials').set(auth).expect(200)).body;
    expect(after.masterKey.dekVersion).toBe(2);
    expect(after.masterKey.rotatedAt).toBe(rotated.rotatedAt);
    // KEK 指纹轮换前后不变（根密钥未动）
    expect(after.masterKey.kekFingerprint).toBe(before.masterKey.kekFingerprint);
  });

  it('shows agent keys as viewable with recoverable secret', async () => {
    const { app } = await setup();
    const auth = { Authorization: `Bearer ${ENV_ADMIN_TOKEN}` };
    const created = (await request(app).post('/api/admin/keys').set(auth).send({ name: 'Viewable agent' }).expect(201)).body;
    const listed = (await request(app).get('/api/admin/keys').set(auth).expect(200)).body;
    expect(listed.keys[0].viewable).toBe(true);
    expect(listed.keys[0].secret).toBe(created.secret);
  });
});

describe('DEK wrap/unwrap roundtrip and bootstrap migration', () => {
  it('wraps and unwraps a DEK with the KEK', () => {
    const kek = randomBytes(32);
    const dek = generateDek();
    const wrapped = wrapDek(dek, kek);
    expect(wrapped).not.toContain(dek.toString('hex'));
    expect(unwrapDek(wrapped, kek)).toEqual(dek);
    // 用错误 KEK 解包应失败
    expect(() => unwrapDek(wrapped, randomBytes(32))).toThrow();
  });

  it('migrates legacy channel credentials from KEK to DEK on first init', async () => {
    // 直接用底层 in-memory 库预置一条用 KEK 加密的频道，再走 init() 触发 DEK 自举迁移
    const kek = randomBytes(32);
    const raw = new Database(':memory:');
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    // 建最小 schema（与 database.ts 一致），但直接用 KEK 加密凭据
    raw.exec(`
      CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, slug TEXT, provider TEXT, config_encrypted TEXT, enabled INTEGER, last_test_status TEXT, last_test_error TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE routes (id TEXT PRIMARY KEY, name TEXT, slug TEXT, strategy TEXT, channel_ids TEXT, enabled INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT, prefix TEXT, secret_hash TEXT, scopes TEXT, destination_ids TEXT, last_used_at TEXT, created_at TEXT, revoked_at TEXT);
      CREATE TABLE deliveries (id TEXT PRIMARY KEY, target_type TEXT, target_id TEXT, title TEXT, body TEXT, severity TEXT, url TEXT, metadata TEXT, source TEXT, status TEXT, idempotency_key TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE attempts (id TEXT PRIMARY KEY, delivery_id TEXT, channel_id TEXT, position INTEGER, status TEXT, attempt_count INTEGER, response_code INTEGER, error TEXT, next_attempt_at TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor TEXT, action TEXT, resource_type TEXT, resource_id TEXT, details TEXT, created_at TEXT);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, api_key_id TEXT, delivery_id TEXT, reply_token TEXT, question TEXT, options TEXT, reply TEXT, reply_source TEXT, replied_at TEXT, expires_at TEXT, created_at TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    `);
    const legacyConfig = { token: 'super-secret-bot-token', chatId: '42' };
    raw.prepare('INSERT INTO channels (id,name,slug,provider,config_encrypted,enabled,last_test_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('ch-1', 'Legacy', 'legacy', 'telegram', encryptJson(legacyConfig, kek), 1, 'untested', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

    // 用同一个 KEK 构造 repository；init() 应检测无 DEK → 生成并迁移
    const repository = await createNodeRepository(':memory:', kek, raw);
    repositories.push(repository);

    const migratedConfig = await repository.getChannelConfig('ch-1');
    expect(migratedConfig).toEqual(legacyConfig);
    // settings 里应有 dek_version=1
    const dekVersion = await repository.db.get("SELECT value FROM settings WHERE key='dek_version'");
    expect(dekVersion?.value).toBe('1');
    repository.close();
  });
});
