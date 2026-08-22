import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNodeRepository } from '../src/server/database-node.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import type { ProviderDispatcher as ProviderDispatcherType } from '../src/server/providers/dispatcher.js';
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
    const worker = new DeliveryWorker(repository, { send } as unknown as ProviderDispatcherType, { deliveryWorkers: 4, maxDeliveryAttempts: 1, retryBaseMs: 1 });
    const delivery = await new NotificationService(repository).send({ destination: route.id, title: 'Incident', body: 'Database unavailable' }, 'test');

    expect(await worker.drainOnce()).toBe(1);
    expect((await repository.getDelivery(delivery.id))?.attempts?.map((attempt) => attempt.status)).toEqual(['failed', 'pending']);
    expect(await worker.drainOnce()).toBe(1);
    expect((await repository.getDelivery(delivery.id))?.status).toBe('delivered');
    expect(send.mock.calls.map((call) => call[1].target)).toEqual(['first', 'second']);
    repository.close();
  });

  it('drains all due fanout attempts for serverless callers', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    const channels = await Promise.all([1, 2, 3].map((index) => repository.createChannel({ name: `C${index}`, slug: `c-${index}`, provider: 'webhook', config: {} })));
    const route = await repository.createRoute({ name: 'All', slug: 'all-three', strategy: 'fanout', channelIds: channels.map((channel) => channel.id) });
    const send = vi.fn(async () => ({ responseCode: 200 }));
    const worker = new DeliveryWorker(repository, { send } as unknown as ProviderDispatcherType, { deliveryWorkers: 1, maxDeliveryAttempts: 1, retryBaseMs: 1 });
    const delivery = await new NotificationService(repository).send({ destination: route.id, title: 'T', body: 'B' }, 'test');
    expect(await worker.drainAll()).toBe(3);
    expect(send).toHaveBeenCalledTimes(3);
    expect((await repository.getDelivery(delivery.id))?.status).toBe('delivered');
    repository.close();
  });

  // 分块续发：长正文按渠道上限拆块逐块发送。块 1 成功、块 2 失败后重试必须从块 2 续发——
  // 从块 1 重发等于给用户重复推送。必须用真 dispatcher（mock send 会绕过拆块与 onChunkSent 记账）
  it('resumes a failed chunked delivery from the failed chunk instead of resending delivered ones', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    const channel = await repository.createChannel({ name: 'C', slug: 'chunked', provider: 'telegram', config: { botToken: 't', chatId: 'c' } });
    let requestCount = 0;
    const fetcher = vi.fn(async (_url: unknown, init: { body?: unknown } = {}) => {
      requestCount += 1;
      if (requestCount === 2) return new Response('{"ok":false,"error_code":500,"description":"chunk 2 failed"}', { status: 200 });
      return new Response('{"ok":true,"result":{"message_id":1}}', { status: 200 });
    });
    const dispatcher = new ProviderDispatcher({ allowPrivateWebhooks: true, allowInsecureHttp: false }, fetcher as unknown as typeof fetch, async () => ['142.250.0.1']);
    const worker = new DeliveryWorker(repository, dispatcher, { deliveryWorkers: 2, maxDeliveryAttempts: 2, retryBaseMs: 1 });
    const delivery = await new NotificationService(repository).send({ destination: channel.id, title: '长文', body: 'x'.repeat(9000) }, 'test');

    await worker.drainOnce(); // 块 1 送达、块 2 平台报错 → retrying
    expect((await repository.getDelivery(delivery.id))?.status).toBe('processing');
    await new Promise((resolve) => setImmediate(resolve)); // 等 fire-and-forget 的 ackChunks 落库
    await worker.drainOnce(); // 重试：从块 2 续发

    // 9000 字符按 Telegram 3600 上限拆 3 块：首轮 2 次调用 + 重试 2 次（块 2、块 3）。
    // 从头重发会是 5 次（块 1 又来一遍）——断点续发的关键就是不重发已送达的块 1
    expect(fetcher).toHaveBeenCalledTimes(4);
    const lengths = fetcher.mock.calls.map((call) => (JSON.parse(String(call[1]?.body)).text as string).length);
    expect(lengths).toEqual([3610, 3610, 3610, 1810]); // 重试轮补发块 2（3610）与块 3（1810），块 1 不重复
    expect((await repository.getDelivery(delivery.id))?.status).toBe('delivered');
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
    const worker = new DeliveryWorker(repository, { send } as unknown as ProviderDispatcherType, { deliveryWorkers: 4, maxDeliveryAttempts: 3, retryBaseMs: 1 });
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
