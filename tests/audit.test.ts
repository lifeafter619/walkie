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

async function setup(adminToken?: string) {
  const config = {
    port: 4310, host: '127.0.0.1', dataDir: '.', databasePath: ':memory:', adminToken,
    masterKey: randomBytes(32), allowPrivateWebhooks: true, allowInsecureHttp: false,
    deliveryWorkers: 1, maxSendsPerMin: 0, maxDeliveryAttempts: 1, retryBaseMs: 1, isProduction: false
  } satisfies AppConfig;
  const repository = await createNodeRepository(':memory:', config.masterKey); repositories.push(repository);
  const notifications = new NotificationService(repository);
  const dispatcher = new ProviderDispatcher(config, async () => new Response('{}', { status: 200 }));
  const worker = new DeliveryWorker(repository, dispatcher, config);
  return { app: createApp({ config, repository, notifications, dispatcher, worker }), repository };
}

describe('audit log viewer', () => {
  it('requires admin auth and lists audit events newest first', async () => {
    const { app, repository } = await setup('audit-admin-token-32-chars-long');
    await request(app).get('/api/admin/audit').expect(401);

    const auth = { Authorization: 'Bearer audit-admin-token-32-chars-long' };
    await repository.createChannel({ name: 'A', slug: 'audit-a', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' } }, 'admin');
    await repository.createChannel({ name: 'B', slug: 'audit-b', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' } }, 'agent:key-1');

    const listed = await request(app).get('/api/admin/audit').set(auth).expect(200);
    expect(listed.body.events.length).toBeGreaterThanOrEqual(2);
    const creates = listed.body.events.filter((event: { action: string }) => event.action === 'channel.create');
    expect(creates).toHaveLength(2);
    // 两条审计事件可能在同一毫秒写入（ORDER BY 顺序不定），断言集合而非顺序
    expect(creates.map((event: { actor: string }) => event.actor).sort()).toEqual(['admin', 'agent:key-1']);
    expect(creates[0]).toMatchObject({ resourceType: 'channel' });
  });

  it('filters by actor and action', async () => {
    const { app, repository } = await setup();
    const auth = {};
    await repository.createChannel({ name: 'A', slug: 'fa', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' } }, 'admin');
    await repository.createChannel({ name: 'B', slug: 'fb', provider: 'webhook', config: { url: 'https://x.example.com', method: 'POST', bodyTemplate: '{}' } }, 'agent:key-9');
    await repository.createRoute({ name: 'R', slug: 'fr', strategy: 'fanout', channelIds: [] }, 'agent:key-9');

    const byActor = await request(app).get('/api/admin/audit?actor=agent:').set(auth).expect(200);
    expect(byActor.body.events.length).toBe(2);
    expect(byActor.body.events.every((event: { actor: string }) => event.actor.startsWith('agent:'))).toBe(true);

    const byAction = await request(app).get('/api/admin/audit?action=route.create').set(auth).expect(200);
    expect(byAction.body.events).toHaveLength(1);
    expect(byAction.body.events[0].resourceType).toBe('route');

    const combined = await request(app).get('/api/admin/audit?actor=agent:&action=channel.create').set(auth).expect(200);
    expect(combined.body.events).toHaveLength(1);
  });

  it('caps limit at 200 and treats invalid limit as default', async () => {
    const { app } = await setup();
    const oversized = await request(app).get('/api/admin/audit?limit=99999').expect(200);
    expect(oversized.body.events.length).toBeLessThanOrEqual(200);
    const invalid = await request(app).get('/api/admin/audit?limit=abc').expect(200);
    expect(Array.isArray(invalid.body.events)).toBe(true);
  });
});
