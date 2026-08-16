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

async function setup() {
  const config = {
    port: 4310, host: '127.0.0.1', dataDir: '.', databasePath: ':memory:', adminToken: undefined,
    masterKey: randomBytes(32), allowPrivateWebhooks: true, allowInsecureHttp: false,
    deliveryWorkers: 1, maxSendsPerMin: 0, maxDeliveryAttempts: 1, retryBaseMs: 1, isProduction: false
  } as AppConfig;
  const repository = await createNodeRepository(':memory:', config.masterKey); repositories.push(repository);
  const notifications = new NotificationService(repository);
  const dispatcher = new ProviderDispatcher(config, async () => new Response('{}', { status: 200 }));
  const worker = new DeliveryWorker(repository, dispatcher, config);
  const app = createApp({ config, repository, notifications, dispatcher, worker });
  const { secret } = await repository.createKey({ name: 'config-agent', scopes: ['config:write', 'notifications:send'] });
  const plain = await repository.createKey({ name: 'plain-agent', scopes: ['notifications:send'] });
  return { app, repository, secret, plainSecret: plain.secret };
}

const call = (app: ReturnType<typeof createApp>, secret: string, id: number, name: string, args: Record<string, unknown> = {}) =>
  request(app).post('/mcp')
    .set('Authorization', `Bearer ${secret}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('MCP config tools', () => {
  it('hides config tools from keys without config:write', async () => {
    const { app, plainSecret } = await setup();
    const tools = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${plainSecret}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(200);
    expect(tools.text).not.toContain('create_channel');
    const denied = await call(app, plainSecret, 2, 'create_channel', { name: 'X', slug: 'xx', provider: 'telegram', config: { botToken: 't', chatId: '1' } });
    expect(denied.text).toContain('error');
  });

  it('lists channel types with field definitions', async () => {
    const { app, secret } = await setup();
    const res = await call(app, secret, 1, 'list_channel_types').expect(200);
    expect(res.text).toContain('telegram');
    expect(res.text).toContain('botToken');
    expect(res.text).toContain('required');
  });

  it('creates, updates and tests a channel; never echoes config values', async () => {
    const { app, repository, secret } = await setup();
    const created = await call(app, secret, 1, 'create_channel', { name: 'My Telegram', slug: 'my-tg', provider: 'telegram', config: { botToken: 'super-secret-token', chatId: '42' } }).expect(200);
    expect(created.text).toContain('my-tg');
    expect(created.text).not.toContain('super-secret-token');
    expect((await repository.getChannel('my-tg'))?.provider).toBe('telegram');

    await call(app, secret, 2, 'update_channel', { channel: 'my-tg', name: 'Renamed' }).expect(200);
    expect((await repository.getChannel('my-tg'))?.name).toBe('Renamed');
    const broken = await call(app, secret, 3, 'update_channel', { channel: 'my-tg', config: { botToken: '' } });
    expect(broken.text).toContain('Bot Token不能为空');

    const tested = await call(app, secret, 4, 'test_channel', { channel: 'my-tg' }).expect(200);
    expect(tested.text).toContain('"success":true');
    expect((await repository.getChannel('my-tg'))?.lastTestStatus).toBe('success');

    const events = await repository.listAuditEvents();
    const createEvent = events.find((event) => event.action === 'channel.create');
    expect(createEvent?.actor).toMatch(/^agent:/);
    expect((await repository.getKey(createEvent!.actor.slice('agent:'.length)))?.id).toBe(createEvent!.actor.slice('agent:'.length));
  });

  it('create_channel missing required fields returns joined errors', async () => {
    const { app, secret } = await setup();
    const res = await call(app, secret, 1, 'create_channel', { name: 'X', slug: 'xx', provider: 'telegram', config: {} });
    expect(res.text).toContain('Bot Token不能为空');
    expect(res.text).toContain('Chat ID不能为空');
  });

  it('rejects malformed quiet hours in config tools', async () => {
    const { app, secret } = await setup();
    const res = await call(app, secret, 1, 'create_channel', { name: 'X', slug: 'quiet', provider: 'telegram', config: { botToken: 't', chatId: '1' }, quietHours: '99:99-08:00' });
    expect(res.text).toContain('quietHours');
  });

  it('manages routes: create, update, delete', async () => {
    const { app, repository, secret } = await setup();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    await call(app, secret, 1, 'create_route', { name: 'All', slug: 'all', strategy: 'fanout', channelIds: [channel.id] }).expect(200);
    expect(await repository.getRoute('all')).toBeTruthy();
    await call(app, secret, 2, 'update_route', { route: 'all', name: 'Renamed' }).expect(200);
    expect((await repository.getRoute('all'))?.name).toBe('Renamed');
    const bad = await call(app, secret, 3, 'create_route', { name: 'Bad', slug: 'bad', strategy: 'fanout', channelIds: ['no-such'] });
    expect(bad.text).toContain('路由包含不存在的频道');
    await call(app, secret, 4, 'delete_route', { route: 'all' }).expect(200);
    expect(await repository.getRoute('all')).toBeUndefined();
  });

  it('delete_channel soft-disables when referenced by a route', async () => {
    const { app, repository, secret } = await setup();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    await repository.createRoute({ name: 'R', slug: 'r', strategy: 'fanout', channelIds: [channel.id] });
    await call(app, secret, 1, 'delete_channel', { channel: 'ops' }).expect(200);
    expect((await repository.getChannel(channel.id))?.enabled).toBe(false);
  });
});
