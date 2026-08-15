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
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 'abc', chatId: '42' } });
    expect(channel.configKeys).toEqual(['botToken', 'chatId']);
    expect(JSON.stringify(channel)).not.toContain('abc');
    expect(await repository.getChannelConfig(channel.id)).toEqual({ botToken: 'abc', chatId: '42' });

    const created = await repository.createKey({ name: 'Build agent' });
    expect((await repository.authenticateKey(created.secret))?.id).toBe(created.apiKey.id);
    expect(await repository.authenticateKey(`${created.secret}x`)).toBeUndefined();
    await repository.revokeKey(created.apiKey.id);
    expect(await repository.authenticateKey(created.secret)).toBeUndefined();
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
