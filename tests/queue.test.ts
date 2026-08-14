import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNodeRepository } from '../src/server/database-node.js';
import { NotificationService } from '../src/server/notifications.js';
import type { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import { DeliveryWorker, quietUntil } from '../src/server/queue.js';

describe('delivery worker', () => {
  it('runs fallback routes in order and stops after success', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    const first = await repository.createChannel({ name: 'Primary', slug: 'primary', provider: 'webhook', config: { target: 'first' } });
    const second = await repository.createChannel({ name: 'Backup', slug: 'backup', provider: 'webhook', config: { target: 'second' } });
    const route = await repository.createRoute({ name: 'Incident', slug: 'incident', strategy: 'fallback', channelIds: [first.id, second.id] });
    const send = vi.fn(async (_provider, config: Record<string, unknown>) => {
      if (config.target === 'first') throw new Error('primary unavailable');
      return { responseCode: 200 };
    });
    const worker = new DeliveryWorker(repository, { send } as unknown as ProviderDispatcher, { deliveryWorkers: 4, maxDeliveryAttempts: 1, retryBaseMs: 1 });
    const delivery = await new NotificationService(repository).send({ destination: route.id, title: 'Incident', body: 'Database unavailable' }, 'test');

    expect(await worker.drainOnce()).toBe(1);
    expect((await repository.getDelivery(delivery.id))?.attempts?.map((attempt) => attempt.status)).toEqual(['failed', 'pending']);
    expect(await worker.drainOnce()).toBe(1);
    expect((await repository.getDelivery(delivery.id))?.status).toBe('delivered');
    expect(send.mock.calls.map((call) => call[1].target)).toEqual(['first', 'second']);
    repository.close();
  });

  it('does not claim fallback backup while primary attempt is in flight', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    const first = await repository.createChannel({ name: 'Primary', slug: 'primary', provider: 'webhook', config: {} });
    const second = await repository.createChannel({ name: 'Backup', slug: 'backup', provider: 'webhook', config: {} });
    const route = await repository.createRoute({ name: 'Incident', slug: 'incident', strategy: 'fallback', channelIds: [first.id, second.id] });
    await new NotificationService(repository).send({ destination: route.id, title: 'Incident', body: 'x' }, 'test');
    // 领取主频道后其状态为 sending（在途），备用频道此时不可被另一实例领取
    const claimed = await repository.claimDueAttempts(4);
    expect(claimed.map((attempt) => attempt.channelId)).toEqual([first.id]);
    expect(await repository.claimDueAttempts(4)).toEqual([]);
    repository.close();
  });

  it('supports explicit timezone in quiet hours', () => {
    // 2026-01-01T15:00Z = 上海 23:00，在静默期，静默到上海 08:00 = 次日 00:00Z
    const at = new Date('2026-01-01T15:00:00Z');
    expect(quietUntil('22:00-08:00@Asia/Shanghai', 'info', at)?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(quietUntil('22:00-08:00@Asia/Shanghai', 'info', new Date('2026-01-01T04:00:00Z'))).toBeUndefined();
    expect(quietUntil('22:00-08:00@Not/AZone', 'info', at)).toBeUndefined();
  });

  it('defers deliveries inside quiet hours and lets critical pass', async () => {
    const at = new Date('2026-01-01T23:30:00');
    expect(quietUntil('22:00-08:00', 'info', at)?.getHours()).toBe(8);
    expect(quietUntil('22:00-08:00', 'critical', at)).toBeUndefined();
    expect(quietUntil('22:00-08:00', 'info', new Date('2026-01-01T12:00:00'))).toBeUndefined();
    expect(quietUntil('09:00-10:00', 'info', new Date('2026-01-01T09:30:00'))?.getHours()).toBe(10);
    expect(quietUntil(undefined, 'info', at)).toBeUndefined();

    const repository = await createNodeRepository(':memory:', randomBytes(32));
    const channel = await repository.createChannel({ name: 'Limited', slug: 'limited', provider: 'webhook', config: {}, rateLimitPerMin: 1 });
    const send = vi.fn(async () => ({ responseCode: 200 }));
    const worker = new DeliveryWorker(repository, { send } as unknown as ProviderDispatcher, { deliveryWorkers: 4, maxDeliveryAttempts: 3, retryBaseMs: 1 });
    const notifications = new NotificationService(repository);
    await notifications.send({ destination: channel.id, title: 'first', body: 'x' }, 'test');
    await notifications.send({ destination: channel.id, title: 'second', body: 'x' }, 'test');
    await worker.drainOnce();
    await worker.drainOnce();
    expect(send).toHaveBeenCalledTimes(1);
    const statuses = (await repository.listDeliveries()).map((delivery) => delivery.status).sort();
    expect(statuses).toEqual(['delivered', 'processing']);
    repository.close();
  });
});
