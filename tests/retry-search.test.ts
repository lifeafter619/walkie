import { randomBytes } from 'node:crypto';
import type { MockFetch } from './helpers.js';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import type { RelayRepository } from '../src/server/database.js';
import { createNodeRepository } from '../src/server/database-node.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import { DeliveryWorker } from '../src/server/queue.js';

const repositories: RelayRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

const config = { allowPrivateWebhooks: true, allowInsecureHttp: false } as AppConfig;

async function setup(maxDeliveryAttempts = 4) {
  const fullConfig = {
    port: 4310, host: '127.0.0.1', dataDir: '.', databasePath: ':memory:', adminToken: undefined,
    masterKey: randomBytes(32), allowPrivateWebhooks: true, allowInsecureHttp: false,
    deliveryWorkers: 1, maxSendsPerMin: 0, maxDeliveryAttempts, retryBaseMs: 1, isProduction: false
  } as AppConfig;
  const repository = await createNodeRepository(':memory:', fullConfig.masterKey); repositories.push(repository);
  const notifications = new NotificationService(repository);
  const dispatcher = new ProviderDispatcher(config, async () => new Response('{}', { status: 200 }));
  const worker = new DeliveryWorker(repository, dispatcher, fullConfig);
  return { app: createApp({ config: fullConfig, repository, notifications, dispatcher, worker }), repository, notifications, worker };
}

describe('per-channel retry policy', () => {
  it('stores and returns maxAttempts on channels; 0 means inherit global', async () => {
    const { app } = await setup();
    const created = await request(app).post('/api/admin/channels').send({
      name: 'Paid SMS', slug: 'paid-sms', provider: 'webhook',
      config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' },
      maxAttempts: 1
    }).expect(201);
    expect(created.body.maxAttempts).toBe(1);
    const listed = await request(app).get('/api/admin/channels').expect(200);
    expect(listed.body.channels[0].maxAttempts).toBe(1);
    // 清回 0（继承全局）
    const cleared = await request(app).patch(`/api/admin/channels/${created.body.id}`).send({ maxAttempts: 0 }).expect(200);
    expect(cleared.body.maxAttempts).toBe(0);
  });

  it('rejects out-of-range maxAttempts', async () => {
    const { app } = await setup();
    await request(app).post('/api/admin/channels').send({
      name: 'Bad', slug: 'bad-retry', provider: 'webhook',
      config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' },
      maxAttempts: 11
    }).expect(400);
  });

  it('retries only maxAttempts times for a channel with maxAttempts=1 while global allows 4', async () => {
    const { repository, worker } = await setup(4);
    // 永远失败的发送器
    const failing = new ProviderDispatcher(config, vi.fn(async () => new Response('boom', { status: 500 })) as unknown as MockFetch);
    const failingWorker = new DeliveryWorker(repository, failing, { deliveryWorkers: 1, maxDeliveryAttempts: 4, retryBaseMs: 1 });
    const onceChannel = await repository.createChannel({ name: 'Once', slug: 'once-c', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' }, maxAttempts: 1 });
    const defaultChannel = await repository.createChannel({ name: 'Default', slug: 'default-c', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' } });

    await new NotificationService(repository).send({ destination: onceChannel.id, title: 'once', body: 'x' }, 'test');
    await new NotificationService(repository).send({ destination: defaultChannel.id, title: 'default', body: 'x' }, 'test');
    for (let i = 0; i < 10; i++) {
      await failingWorker.drainOnce();
      // retryBaseMs 极短，但 next_attempt_at 仍需在下轮 claim 前到期
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // listDeliveries 不带 attempts；用 getDelivery 取完整投递
    const summary = await repository.listDeliveries({});
    const once = (await repository.getDelivery(summary.find((item) => item.title === 'once')!.id))!;
    const def = (await repository.getDelivery(summary.find((item) => item.title === 'default')!.id))!;
    expect(once.status).toBe('failed');
    expect(once.attempts![0].attemptCount).toBe(1); // 只试 1 次
    expect(def.status).toBe('failed');
    expect(def.attempts![0].attemptCount).toBe(4); // 全局 4 次
    void worker;
  });

  it('uses the channel retry limit when reclaiming a stuck send', async () => {
    const { repository } = await setup(1);
    const channel = await repository.createChannel({
      name: 'Extended', slug: 'extended-retry', provider: 'webhook',
      config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' }, maxAttempts: 2
    });
    const delivery = await new NotificationService(repository).send({ destination: channel.id, title: 'stuck', body: 'x' }, 'test');

    expect((await repository.claimDueAttempts(1, 1))[0].attemptCount).toBe(1);
    await repository.db.run("UPDATE attempts SET updated_at='2000-01-01T00:00:00.000Z' WHERE delivery_id=?", [delivery.id]);

    expect((await repository.claimDueAttempts(1, 1))[0].attemptCount).toBe(2);
  });
});

describe('delivery search and cursor pagination', () => {
  it('filters deliveries by title/ID substring server-side', async () => {
    const { app, repository, notifications } = await setup();
    const channel = await repository.createChannel({ name: 'S', slug: 'search-c', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' } });
    await notifications.send({ destination: channel.id, title: 'deploy failed prod', body: 'x' }, 'test');
    await notifications.send({ destination: channel.id, title: 'backup done', body: 'x' }, 'test');

    const hit = await request(app).get('/api/admin/deliveries?q=deploy').expect(200);
    expect(hit.body.deliveries).toHaveLength(1);
    expect(hit.body.deliveries[0].title).toBe('deploy failed prod');
    const byId = await request(app).get(`/api/admin/deliveries?q=${hit.body.deliveries[0].id.slice(0, 8)}`).expect(200);
    expect(byId.body.deliveries).toHaveLength(1);
    const miss = await request(app).get('/api/admin/deliveries?q=nonexistent').expect(200);
    expect(miss.body.deliveries).toHaveLength(0);
  });

  it('pages with before cursor (older than given createdAt)', async () => {
    const { app, repository, notifications } = await setup();
    const channel = await repository.createChannel({ name: 'P', slug: 'page-c', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' } });
    // 循环创建在同一毫秒完成会让 created_at 相同，游标无法分隔；显式错开时间戳
    const titles = ['one', 'two', 'three'] as const;
    for (const title of titles) {
      await notifications.send({ destination: channel.id, title, body: 'x' }, 'test');
    }
    const rows = await repository.db.all("SELECT id,title FROM deliveries WHERE title IN ('one','two','three')");
    await repository.db.run("UPDATE deliveries SET created_at='2026-08-17T10:00:00.000Z' WHERE title='one'");
    await repository.db.run("UPDATE deliveries SET created_at='2026-08-17T10:00:01.000Z' WHERE title='two'");
    await repository.db.run("UPDATE deliveries SET created_at='2026-08-17T10:00:02.000Z' WHERE title='three'");
    void rows;
    const all = await request(app).get('/api/admin/deliveries').expect(200);
    expect(all.body.deliveries).toHaveLength(3);
    expect(all.body.deliveries.map((item: { title: string }) => item.title)).toEqual(['three', 'two', 'one']);
    // 以第二条（10:00:01）为游标：应只返回更老的 one
    const page = await request(app).get('/api/admin/deliveries?before=2026-08-17T10%3A00%3A01.000Z').expect(200);
    expect(page.body.deliveries).toHaveLength(1);
    expect(page.body.deliveries[0].title).toBe('one');
  });

  it('pages through deliveries created in the same millisecond', async () => {
    const { app, repository, notifications } = await setup();
    const channel = await repository.createChannel({ name: 'P', slug: 'same-ms-c', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' } });
    await notifications.send({ destination: channel.id, title: 'one', body: 'x' }, 'test');
    await notifications.send({ destination: channel.id, title: 'two', body: 'x' }, 'test');
    await repository.db.run("UPDATE deliveries SET created_at='2026-08-17T10:00:00.000Z'");

    const all = await request(app).get('/api/admin/deliveries').expect(200);
    const cursor = `${all.body.deliveries[0].createdAt}|${all.body.deliveries[0].id}`;
    const page = await request(app).get(`/api/admin/deliveries?before=${encodeURIComponent(cursor)}`).expect(200);
    expect(page.body.deliveries.map((item: { title: string }) => item.title)).toEqual([all.body.deliveries[1].title]);
  });
});
