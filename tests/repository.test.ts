import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptJson, encryptJson } from '../src/server/crypto.js';
import { createNodeRepository } from '../src/server/database-node.js';
import { NotificationService } from '../src/server/notifications.js';

const createRepository = () => createNodeRepository(':memory:', randomBytes(32));

describe('credential storage and repository', () => {
  it('encrypts credential JSON with authenticated encryption', () => {
    const key = randomBytes(32);
    const encrypted = encryptJson({ token: 'secret', count: 2 }, key);
    expect(encrypted).not.toContain('secret');
    expect(decryptJson(encrypted, key)).toEqual({ token: 'secret', count: 2 });
    expect(() => decryptJson(encrypted, randomBytes(32))).toThrow();
  });

  it('never exposes channel credentials and authenticates high-entropy API keys', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 'leak-canary-secret-token-xyz123', chatId: '42' } });
    expect(channel.configKeys).toEqual(['botToken', 'chatId']);
    expect(JSON.stringify(channel)).not.toContain('leak-canary-secret-token-xyz123');
    expect(await repository.getChannelConfig(channel.id)).toEqual({ botToken: 'leak-canary-secret-token-xyz123', chatId: '42' });

    const created = await repository.createKey({ name: 'Build agent' });
    expect((await repository.authenticateKey(created.secret))?.id).toBe(created.apiKey.id);
    expect(await repository.authenticateKey(`${created.secret}x`)).toBeUndefined();
    await repository.revokeKey(created.apiKey.id);
    expect(await repository.authenticateKey(created.secret)).toBeUndefined();
    repository.close();
  });

  it('does not carry credentials across provider changes', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 'telegram-secret', chatId: '42' } });
    await repository.setChannelTest(channel.id, true);
    await repository.updateChannel(channel.id, { provider: 'slack', config: { webhookUrl: 'https://hooks.slack.test/1' } });
    expect(await repository.getChannelConfig(channel.id)).toEqual({ webhookUrl: 'https://hooks.slack.test/1' });
    expect((await repository.getChannel(channel.id))?.lastTestStatus).toBe('untested');
    repository.close();
  });

  it('supports user-chosen key secrets and rejects duplicates', async () => {
    const repository = await createRepository();
    const custom = await repository.createKey({ name: 'Custom agent', secret: 'my-own-password-123' });
    expect(custom.secret).toBe('my-own-password-123');
    expect((await repository.authenticateKey('my-own-password-123'))?.id).toBe(custom.apiKey.id);
    expect(await repository.authenticateKey('my-own-password-124')).toBeUndefined();
    await expect(repository.createKey({ name: 'Dup', secret: 'my-own-password-123' })).rejects.toThrow('已被其他 Agent Key 使用');
    repository.close();
  });

  it('deduplicates deliveries by source and idempotency key', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'webhook', config: { url: 'https://example.com', bodyTemplate: '{}' } });
    const service = new NotificationService(repository);
    const input = { destination: channel.id, title: 'Build complete', body: 'Version 2', idempotencyKey: 'build-42' };
    const first = await service.send(input, 'agent:test');
    const second = await service.send(input, 'agent:test');
    expect(second.id).toBe(first.id);
    expect(await repository.listDeliveries()).toHaveLength(1);
    repository.close();
  });

  it('returns the existing delivery when concurrent idempotent inserts collide', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'webhook', config: { url: 'https://example.com', bodyTemplate: '{}' } });
    const input = { targetType: 'channel' as const, targetId: channel.id, title: 'x', body: 'x', severity: 'info' as const, source: 'agent:test', idempotencyKey: 'race-1', channelIds: [channel.id] };
    const first = await repository.createDelivery(input);
    // 模拟并发：让第二次的幂等预检查落空，走 UNIQUE 冲突恢复路径
    const originalGet = repository.db.get.bind(repository.db);
    let skipped = false;
    repository.db.get = async (sql, params) => {
      if (!skipped && sql.includes('idempotency_key=?')) { skipped = true; return undefined; }
      return originalGet(sql, params);
    };
    const second = await repository.createDelivery(input);
    expect(second.id).toBe(first.id);
    expect(await repository.listDeliveries()).toHaveLength(1);
    repository.close();
  });

  it('does not schedule disabled channel attempts', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Disabled', slug: 'disabled', provider: 'webhook', config: { url: 'https://example.com', bodyTemplate: '{}' }, enabled: false });
    const service = new NotificationService(repository);
    await expect(service.send({ destination: channel.id, title: 'Ignored', body: 'x' }, 'test')).rejects.toThrow('目的地不存在或已禁用');
    await repository.db.run("INSERT INTO deliveries (id,target_type,target_id,title,body,severity,metadata,source,status,created_at,updated_at) VALUES ('delivery-1','channel',?,'x','x','info','{}','test','queued',datetime('now'),datetime('now'))", [channel.id]);
    await repository.db.run("INSERT INTO attempts (id,delivery_id,channel_id,position,status,next_attempt_at,created_at,updated_at) VALUES ('attempt-1','delivery-1',?,0,'pending',datetime('now'),datetime('now'),datetime('now'))", [channel.id]);
    expect(await repository.nextDueAttempt()).toBeUndefined();
    repository.close();
  });
});

describe('disabled channel cleanup (regression)', () => {
  it('fails pending attempts and finalizes deliveries when a channel is disabled after queueing', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Live', slug: 'live', provider: 'webhook', config: { url: 'https://example.com', bodyTemplate: '{}' } });
    const service = new NotificationService(repository);
    const delivery = await service.send({ destination: channel.id, title: 'x', body: 'x' }, 'test');
    expect((await repository.getDelivery(delivery.id))?.status).toBe('queued');
    // 排队后禁用频道：未完结 attempt 必须就地失败，投递进入终态而不是永久 processing
    await repository.updateChannel(channel.id, { enabled: false });
    const after = await repository.getDelivery(delivery.id);
    expect(after?.status).toBe('failed');
    expect(after?.attempts?.[0].status).toBe('failed');
    repository.close();
  });

  it('soft-deleting a channel with history also finalizes in-flight attempts', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Old', slug: 'old', provider: 'webhook', config: { url: 'https://example.com', bodyTemplate: '{}' } });
    const service = new NotificationService(repository);
    const delivery = await service.send({ destination: channel.id, title: 'x', body: 'x' }, 'test');
    await repository.deleteChannel(channel.id); // 有投递历史 → 软删除
    expect((await repository.getDelivery(delivery.id))?.status).toBe('failed');
    repository.close();
  });

  it('fallback route skips a disabled primary instead of blocking the chain', async () => {
    const repository = await createRepository();
    const primary = await repository.createChannel({ name: 'P', slug: 'p', provider: 'webhook', config: { url: 'https://example.com', bodyTemplate: '{}' } });
    const backup = await repository.createChannel({ name: 'B', slug: 'b', provider: 'webhook', config: { url: 'https://example.com', bodyTemplate: '{}' } });
    const route = await repository.createRoute({ name: 'R', slug: 'r', strategy: 'fallback', channelIds: [primary.id, backup.id] });
    const service = new NotificationService(repository);
    const delivery = await service.send({ destination: route.id, title: 'x', body: 'x' }, 'test');
    await repository.updateChannel(primary.id, { enabled: false });
    // 主频道禁用后，备用频道（position 1）应可被领取，而不是被 position 0 的 MIN 门控卡死
    const claimed = await repository.claimDueAttempts(4);
    expect(claimed.map((attempt) => attempt.channelId)).toEqual([backup.id]);
    expect(delivery.id).toBeTruthy();
    repository.close();
  });

  it('updates key scopes and destinations with audit trail', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    const { apiKey } = await repository.createKey({ name: 'Editor' });
    const updated = await repository.updateKey(apiKey.id, { scopes: ['config:write'], destinationIds: [channel.id] });
    expect(updated.scopes).toEqual(['config:write']);
    expect(updated.destinationIds).toEqual([channel.id]);
    expect((await repository.getKey(apiKey.id))?.scopes).toEqual(['config:write']);
    await expect(repository.updateKey('no-such-key', { name: 'x' })).rejects.toThrow('Key not found');
    const keyUpdate = (await repository.listAuditEvents()).find((event) => event.action === 'api_key.update');
    expect(keyUpdate?.actor).toBe('admin');
    expect(keyUpdate?.details).toEqual({ fields: ['scopes', 'destinationIds'] });
    repository.close();
  });

  it('records agent actor on channel mutations', async () => {
    const repository = await createRepository();
    await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } }, 'agent:key-1');
    expect((await repository.listAuditEvents()).find((event) => event.action === 'channel.create')?.actor).toBe('agent:key-1');
    repository.close();
  });
});
