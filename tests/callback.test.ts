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
    const channel = await repository.createChannel({ name: 'Hook', slug: 'hook', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' } });
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    const worker = new DeliveryWorker(repository, dispatcher, { deliveryWorkers: 4, maxDeliveryAttempts: 1, retryBaseMs: 1 });
    const delivery = await new NotificationService(repository).send(
      { destination: channel.id, title: 'Done', body: 'ok', callbackUrl: 'https://agent.example.com/callback' }, 'test'
    );
    await worker.drainOnce();
    await worker.drainOnce();
    const callbackCalls = vi.mocked(fetcher).mock.calls.filter((call) => String(call[0]).includes('agent.example.com'));
    expect(callbackCalls).toHaveLength(1);
    const payload = JSON.parse(String(callbackCalls[0][1]?.body));
    expect(payload).toMatchObject({ deliveryId: delivery.id, status: 'delivered' });
    expect(payload.attempts[0].status).toBe('delivered');
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
