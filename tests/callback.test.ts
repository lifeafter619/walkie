import { randomBytes } from 'node:crypto';
import type { MockFetch } from './helpers.js';
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
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch;
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

  it('fires the callback when a channel is disabled before drain (bypass finalization path)', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    const channel = await repository.createChannel({ name: 'Hook', slug: 'hook-d', provider: 'webhook', config: { url: 'https://hooks.example.com/d', method: 'POST', bodyTemplate: '{}' } });
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch;
    const worker = new DeliveryWorker(repository, new ProviderDispatcher(config, fetcher), { deliveryWorkers: 2, maxDeliveryAttempts: 1, retryBaseMs: 1 });
    const delivery = await new NotificationService(repository).send({ destination: channel.id, title: 'x', body: 'y', callbackUrl: 'https://agent.example.com/cb' }, 'test');
    // 禁用频道让投递不经 processAttempt 直达 failed：没有兜底扫描的话 callbackUrl 永远不会发出
    await repository.updateChannel(channel.id, { enabled: false });
    await worker.drainOnce();
    await worker.drainOnce(); // 再跑一轮验证 claimCallback 原子去重，不会重发
    const calls = vi.mocked(fetcher).mock.calls.filter((call) => String(call[0]).includes('agent.example.com'));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({ deliveryId: delivery.id, status: 'failed' });
    await repository.close();
  });

  it('retries a failed callback on the next drain', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    const channel = await repository.createChannel({ name: 'Hook', slug: 'hook-retry', provider: 'webhook', config: { url: 'https://hooks.example.com/retry', method: 'POST', bodyTemplate: '{}' } });
    let callbackAttempts = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('agent.example.com') && callbackAttempts++ === 0) return new Response('temporary', { status: 500 });
      return new Response('{}', { status: 200 });
    }) as unknown as MockFetch;
    const worker = new DeliveryWorker(repository, new ProviderDispatcher(config, fetcher), { deliveryWorkers: 2, maxDeliveryAttempts: 1, retryBaseMs: 1 });
    await new NotificationService(repository).send({ destination: channel.id, title: 'x', body: 'y', callbackUrl: 'https://agent.example.com/retry' }, 'test');

    await worker.drainOnce();
    await worker.drainOnce();

    const calls = vi.mocked(fetcher).mock.calls.filter((call) => String(call[0]).includes('agent.example.com'));
    expect(calls).toHaveLength(2);
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
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch;
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
