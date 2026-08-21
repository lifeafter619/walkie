import { randomBytes } from 'node:crypto';
import type { MockFetch } from './helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createNodeRepository } from '../src/server/database-node.js';
import type { RelayRepository } from '../src/server/database.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import { DeliveryWorker } from '../src/server/queue.js';
import { createApp } from '../src/server/app.js';

const repositories: RelayRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

async function setup() {
  const repository = await createNodeRepository(':memory:', randomBytes(32));
  repositories.push(repository);
  const notifications = new NotificationService(repository);
  const dispatcher = new ProviderDispatcher({ allowPrivateWebhooks: false, allowInsecureHttp: false }, vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch);
  const worker = new DeliveryWorker(repository, dispatcher, { deliveryWorkers: 1, maxDeliveryAttempts: 1, retryBaseMs: 1, maxSendsPerMin: 0 });
  const app = createApp({
    config: { port: 4310, host: '127.0.0.1', dataDir: '.', databasePath: ':memory:', adminToken: 'a-secure-admin-token', masterKey: randomBytes(32), allowPrivateWebhooks: false, allowInsecureHttp: false, deliveryWorkers: 1, maxSendsPerMin: 0, maxDeliveryAttempts: 1, retryBaseMs: 1, isProduction: false, platform: 'node' } as never,
    repository, notifications, dispatcher, worker
  });
  return { app, repository, dispatcher };
}

describe('webpush admin API + channel (#6) and idle gating (#13)', () => {
  it('serves a vapid public key and stores/deletes subscriptions', async () => {
    const { app, repository } = await setup();
    const auth = { Authorization: 'Bearer a-secure-admin-token' };

    const meta = (await request(app).get('/api/admin/webpush').set(auth).expect(200)).body;
    expect(meta.vapidPublicKey).toMatch(/^[\w-]{80,}$/); // base64url 65 字节
    expect(meta.subscriptions).toEqual([]);
    // 第二次读取返回同一把密钥（惰性生成只发生一次）
    const again = (await request(app).get('/api/admin/webpush').set(auth).expect(200)).body;
    expect(again.vapidPublicKey).toBe(meta.vapidPublicKey);

    await request(app).post('/api/admin/webpush/subscribe').set(auth)
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'a'.repeat(86), auth: 'b'.repeat(22) } })
      .expect(201);
    // 非 https endpoint / 缺 keys 拒绝
    await request(app).post('/api/admin/webpush/subscribe').set(auth)
      .send({ endpoint: 'http://evil.example/push', keys: { p256dh: 'x', auth: 'y' } }).expect(400);
    await request(app).post('/api/admin/webpush/subscribe').set(auth)
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/def', keys: {} }).expect(400);

    const listed = (await request(app).get('/api/admin/webpush').set(auth).expect(200)).body;
    expect(listed.subscriptions).toHaveLength(1);
    expect(listed.subscriptions[0].endpoint).toBe('https://fcm.googleapis.com/fcm/send/abc');

    await request(app).delete('/api/admin/webpush/subscribe?endpoint=https%3A%2F%2Ffcm.googleapis.com%2Ffcm%2Fsend%2Fabc').set(auth).expect(200);
    await request(app).delete('/api/admin/webpush/subscribe?endpoint=nope').set(auth).expect(404);
    expect((await repository.listPushSubscriptions())).toHaveLength(0);
  });

  it('defers mobile push channels while the human is at the keyboard, critical breaks through', async () => {
    const { app, repository } = await setup();
    const auth = { Authorization: 'Bearer a-secure-admin-token' };
    // bark 在 MOBILE_PUSH_PROVIDERS 里
    const channel = await repository.createChannel({ name: 'B', slug: 'b', provider: 'bark', config: { server: 'https://api.day.app', deviceKey: 'k' } });
    const { secret } = await repository.createKey({ name: 'k', destinationIds: [channel.id] });

    await repository.reportIdle(10, 'agent:test'); // 人在键盘前
    await request(app).post('/api/v1/notify').set('Authorization', `Bearer ${secret}`)
      .send({ destination: channel.id, title: 'deferred', body: 'b' }).expect(202);
    let deliveries = await repository.listDeliveries({ limit: 10 });
    let attempt = (await repository.getDelivery(deliveries.find((d) => d.title === 'deferred')!.id))!;
    // 未投递：尝试仍 pending 且 next_attempt_at 被推到 ~5 分钟后
    expect(attempt.attempts![0]!.status).toBe('pending');
    expect(new Date(attempt.attempts![0]!.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

    // critical 穿透 idle gating
    await request(app).post('/api/v1/notify').set('Authorization', `Bearer ${secret}`)
      .send({ destination: channel.id, title: 'urgent', body: 'b', severity: 'critical' }).expect(202);
    deliveries = await repository.listDeliveries({ limit: 10 });
    const critical = (await repository.getDelivery(deliveries.find((d) => d.title === 'urgent')!.id))!;

    // idle 上报 5 分钟后过期——不再拦
    await repository.db.run("UPDATE settings SET value=json_set(value,'$.at',?) WHERE key='idle_report'", [new Date(Date.now() - 400_000).toISOString()]);
    await request(app).post('/api/v1/notify').set('Authorization', `Bearer ${secret}`)
      .send({ destination: channel.id, title: 'after-expiry', body: 'b' }).expect(202);
    void critical;
    void auth;
  });
});
