import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import type { RelayRepository } from '../src/server/database.js';
import { createNodeRepository } from '../src/server/database-node.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import { DeliveryWorker } from '../src/server/queue.js';

const repositories: RelayRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

const config = {
  port: 4310, host: '127.0.0.1', dataDir: '.', databasePath: ':memory:', adminToken: undefined,
  masterKey: randomBytes(32), allowPrivateWebhooks: true, allowInsecureHttp: false,
  deliveryWorkers: 1, maxSendsPerMin: 0, maxDeliveryAttempts: 1, retryBaseMs: 1, isProduction: false
} as AppConfig;

async function setup() {
  const repository = await createNodeRepository(':memory:', config.masterKey); repositories.push(repository);
  const notifications = new NotificationService(repository);
  const dispatcher = new ProviderDispatcher(config, async () => new Response('{}', { status: 200 }));
  const worker = new DeliveryWorker(repository, dispatcher, config);
  return { app: createApp({ config, repository, notifications, dispatcher, worker }), repository, notifications };
}

describe('data retention', () => {
  it('defaults to keeping everything forever (retention disabled)', async () => {
    const { app } = await setup();
    const status = await request(app).get('/api/admin/retention').expect(200);
    expect(status.body).toEqual({ deliveriesDays: 0, conversationsDays: 0, auditDays: 0 });
  });

  it('persists retention settings and rejects invalid values', async () => {
    const { app } = await setup();
    await request(app).put('/api/admin/retention').send({ deliveriesDays: 30, conversationsDays: 14, auditDays: 90 }).expect(200);
    const status = await request(app).get('/api/admin/retention').expect(200);
    expect(status.body).toEqual({ deliveriesDays: 30, conversationsDays: 14, auditDays: 90 });

    await request(app).put('/api/admin/retention').send({ deliveriesDays: -1 }).expect(400);
    await request(app).put('/api/admin/retention').send({ deliveriesDays: 'forever' }).expect(400);
  });

  it('purges expired deliveries with their attempts but keeps fresh ones', async () => {
    const { repository, notifications } = await setup();
    const channel = await repository.createChannel({ name: 'R', slug: 'retention-c', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' } });
    await notifications.send({ destination: channel.id, title: 'old', body: 'x' }, 'test');
    await notifications.send({ destination: channel.id, title: 'new', body: 'y' }, 'test');
    // 把第一条改成 40 天前，第二条保持现在
    const deliveries = await repository.listDeliveries({});
    const old = deliveries.find((item) => item.title === 'old')!;
    await repository.db.run("UPDATE deliveries SET created_at='2020-01-01T00:00:00.000Z',updated_at='2020-01-01T00:00:00.000Z' WHERE id=?", [old.id]);
    await repository.db.run("UPDATE attempts SET created_at='2020-01-01T00:00:00.000Z',updated_at='2020-01-01T00:00:00.000Z' WHERE delivery_id=?", [old.id]);

    await repository.setRetention({ deliveriesDays: 30 });
    const purged = await repository.purgeExpiredData();
    expect(purged.deliveries).toBeGreaterThanOrEqual(1);

    const after = await repository.listDeliveries({});
    expect(after.some((item) => item.title === 'new')).toBe(true);
    expect(after.some((item) => item.title === 'old')).toBe(false);
    // attempts 级联清理（外键 ON DELETE CASCADE 需开启；查不到残留即通过）
    const staleAttempts = await repository.db.all('SELECT COUNT(*) count FROM attempts WHERE delivery_id=?', [old.id]);
    expect(Number(staleAttempts[0].count)).toBe(0);
  });

  it('purges expired conversations and audit events by their own windows', async () => {
    const { repository } = await setup();
    await repository.createChannel({ name: 'A', slug: 'ret-a', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' } }, 'admin');
    await repository.db.run("UPDATE conversations SET created_at='2020-01-01T00:00:00.000Z' WHERE id=(SELECT id FROM conversations LIMIT 1)");
    // 已过期会话（真实系统会话最长 1 天，创建于 2020 必然已过期）
    await repository.db.run("INSERT INTO conversations (id,api_key_id,reply_token,question,expires_at,created_at) VALUES ('c1','k1','t1','q','2020-01-02T00:00:00.000Z','2020-01-01T00:00:00.000Z')");
    await repository.db.run("UPDATE audit_events SET created_at='2020-01-01T00:00:00.000Z'");

    await repository.setRetention({ conversationsDays: 7, auditDays: 7 });
    const purged = await repository.purgeExpiredData();
    expect(purged.conversations).toBeGreaterThanOrEqual(1);
    expect(purged.auditEvents).toBeGreaterThanOrEqual(1);
    // setRetention 自身会追加一条新审计事件；断言 2020 年的旧行已全部清掉即可
    const remaining = await repository.listAuditEvents({});
    expect(remaining.every((event) => event.createdAt > '2021')).toBe(true);
    expect(remaining.length).toBeLessThanOrEqual(1);
  });

  it('does nothing when retention is unset', async () => {
    const { repository, notifications } = await setup();
    const channel = await repository.createChannel({ name: 'K', slug: 'keep-c', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' } });
    await notifications.send({ destination: channel.id, title: 'keep', body: 'x' }, 'test');
    await repository.db.run("UPDATE deliveries SET created_at='2020-01-01T00:00:00.000Z' WHERE title='keep'");
    const purged = await repository.purgeExpiredData();
    expect(purged).toEqual({ deliveries: 0, conversations: 0, auditEvents: 0 });
  });
});
