import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { createNodeRepository } from '../src/server/database-node.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import { DeliveryWorker } from '../src/server/queue.js';

const config = { allowPrivateWebhooks: true, allowInsecureHttp: false } as AppConfig;

describe('delivery callback and global rate limit', () => {
  it('POSTs final result to callbackUrl exactly once', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    // 双频道 fanout：两个 attempt 各自到达终态都会触发一次回调记账，只有 claimCallback 去重才能保证恰好一次
    const first = await repository.createChannel({ name: 'Hook A', slug: 'hook-a', provider: 'webhook', config: { url: 'https://hooks.example.com/a', method: 'POST', bodyTemplate: '{}' } });
    const second = await repository.createChannel({ name: 'Hook B', slug: 'hook-b', provider: 'webhook', config: { url: 'https://hooks.example.com/b', method: 'POST', bodyTemplate: '{}' } });
    const route = await repository.createRoute({ name: 'Fan', slug: 'fan', strategy: 'fanout', channelIds: [first.id, second.id] });
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    const worker = new DeliveryWorker(repository, dispatcher, { deliveryWorkers: 4, maxDeliveryAttempts: 1, retryBaseMs: 1 });
    const delivery = await new NotificationService(repository).send(
      { destination: route.id, title: 'Done', body: 'ok', callbackUrl: 'https://agent.example.com/callback' }, 'test'
    );
    await worker.drainOnce();
    await worker.drainOnce();
    const callbackCalls = vi.mocked(fetcher).mock.calls.filter((call) => String(call[0]).includes('agent.example.com'));
    expect(callbackCalls).toHaveLength(1);
    const payload = JSON.parse(String(callbackCalls[0][1]?.body));
    expect(payload).toMatchObject({ deliveryId: delivery.id, status: 'delivered' });
    expect(payload.attempts).toHaveLength(2);
    expect(payload.attempts[0].status).toBe('delivered');
    await repository.close();
  });

  it('deduplicates repeated channel ids in a route', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    const channel = await repository.createChannel({ name: 'C', slug: 'dup-c', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' } });
    const route = await repository.createRoute({ name: 'Dup', slug: 'dup', strategy: 'fanout', channelIds: [channel.id, channel.id] });
    // 重复 ID 不去重会撞 attempts 的 UNIQUE(delivery_id, channel_id)，导致该路由永远发不出任何投递
    const delivery = await new NotificationService(repository).send({ destination: route.id, title: 't', body: 'b' }, 'test');
    expect(delivery.attempts).toHaveLength(1);
    await repository.close();
  });

  it('enforces the global sends-per-minute cap', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    const channel = await repository.createChannel({ name: 'C', slug: 'c', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' } });
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const worker = new DeliveryWorker(repository, new ProviderDispatcher(config, fetcher), { deliveryWorkers: 8, maxDeliveryAttempts: 1, retryBaseMs: 1, maxSendsPerMin: 1 });
    const notifications = new NotificationService(repository);
    await notifications.send({ destination: channel.id, title: 'a', body: 'x' }, 'test');
    await notifications.send({ destination: channel.id, title: 'b', body: 'x' }, 'test');
    await worker.drainOnce();
    await worker.drainOnce();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await repository.close();
  });
});
