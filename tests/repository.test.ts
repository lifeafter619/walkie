import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptJson, encryptJson } from '../src/server/crypto.js';
import { RelayRepository } from '../src/server/database.js';
import { NotificationService } from '../src/server/notifications.js';

const createRepository = () => new RelayRepository(':memory:', randomBytes(32));

describe('credential storage and repository', () => {
  it('encrypts credential JSON with authenticated encryption', () => {
    const key = randomBytes(32);
    const encrypted = encryptJson({ token: 'secret', count: 2 }, key);
    expect(encrypted).not.toContain('secret');
    expect(decryptJson(encrypted, key)).toEqual({ token: 'secret', count: 2 });
    expect(() => decryptJson(encrypted, randomBytes(32))).toThrow();
  });

  it('never exposes channel credentials and authenticates high-entropy API keys', () => {
    const repository = createRepository();
    const channel = repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 'abc', chatId: '42' } });
    expect(channel.configKeys).toEqual(['botToken', 'chatId']);
    expect(JSON.stringify(channel)).not.toContain('abc');
    expect(repository.getChannelConfig(channel.id)).toEqual({ botToken: 'abc', chatId: '42' });

    const created = repository.createKey({ name: 'Build agent' });
    expect(repository.authenticateKey(created.secret)?.id).toBe(created.apiKey.id);
    expect(repository.authenticateKey(`${created.secret}x`)).toBeUndefined();
    repository.revokeKey(created.apiKey.id);
    expect(repository.authenticateKey(created.secret)).toBeUndefined();
    repository.close();
  });

  it('deduplicates deliveries by source and idempotency key', () => {
    const repository = createRepository();
    const channel = repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'webhook', config: { url: 'https://example.com', bodyTemplate: '{}' } });
    const service = new NotificationService(repository);
    const input = { destination: channel.id, title: 'Build complete', body: 'Version 2', idempotencyKey: 'build-42' };
    const first = service.send(input, 'agent:test');
    const second = service.send(input, 'agent:test');
    expect(second.id).toBe(first.id);
    expect(repository.listDeliveries()).toHaveLength(1);
    repository.close();
  });
});
