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

describe('HTTP API and MCP', () => {
  it('protects admin endpoints and does not return channel credentials', async () => {
    const { app } = await setup('a-secure-admin-token-with-32-chars');
    await request(app).get('/api/admin/channels').expect(401);
    const auth = { Authorization: 'Bearer a-secure-admin-token-with-32-chars' };
    const created = await request(app).post('/api/admin/channels').set(auth).send({ name: 'Ops webhook', slug: 'ops-webhook', provider: 'webhook', config: { url: 'https://hooks.example.com/secret', method: 'POST', bodyTemplate: '{"body":"{{body}}"}' } }).expect(201);
    expect(created.body.configKeys).toContain('url');
    expect(JSON.stringify(created.body)).not.toContain('hooks.example.com');
  });

  it('creates an Agent key once and accepts an MCP initialize handshake', async () => {
    const { app } = await setup();
    const keyResponse = await request(app).post('/api/admin/keys').send({ name: 'MCP test' }).expect(201);
    const secret = keyResponse.body.secret as string;
    expect(secret).toMatch(/^rdk_[a-f0-9]{8}_/);
    const listed = await request(app).get('/api/admin/keys').expect(200);
    // 凭据管理功能：已认证管理员可查看 Agent 密钥明文（viewable=true 且 secret 可复制）
    expect(listed.body.keys[0].viewable).toBe(true);
    expect(listed.body.keys[0].secret).toBe(secret);
    await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } }).expect(401);
    const initialized = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${secret}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } })
      .expect(200);
    expect(initialized.text).toContain('Walkie');
    const tools = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${secret}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      .expect(200);
    expect(tools.text).toContain('list_destinations');
    expect(tools.text).toContain('send_notification');
    expect(tools.text).toContain('get_delivery');

    const modernMeta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'modern-test', version: '1.0.0' }
    };
    const discovered = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${secret}`)
      .set('Accept', 'application/json')
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Mcp-Method', 'server/discover')
      .send({ jsonrpc: '2.0', id: 3, method: 'server/discover', params: { _meta: modernMeta } })
      .expect(200);
    expect(discovered.text).toContain('2026-07-28');

    const modernTools = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${secret}`)
      .set('Accept', 'application/json')
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Mcp-Method', 'tools/list')
      .send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: modernMeta } })
      .expect(200);
    expect(modernTools.text).toContain('list_destinations');
    expect(modernTools.text).toContain('send_notification');
    await request(app).get('/mcp').expect('Allow', 'POST').expect(405);
  });

  it('exposes MCP tools according to Agent key scopes', async () => {
    const { app } = await setup();
    const { secret } = (await request(app).post('/api/admin/keys').send({ name: 'Read only', scopes: ['deliveries:read'] }).expect(201)).body;
    const tools = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${secret}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(200);
    expect(tools.text).toContain('get_delivery');
    expect(tools.text).not.toContain('send_notification');
  });

  it('accepts Server酱-compatible pushes via /send/{key}.send', async () => {
    const { app, repository } = await setup();
    const channel = await repository.createChannel({ name: 'Hook', slug: 'hook', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{"t":"{{title}}"}' } });
    let secret = '';
    for (let index = 0; index < 100 && !secret.includes('-'); index += 1) {
      secret = (await repository.createKey({ name: `compat-${index}`, destinationIds: [channel.id] })).secret;
    }
    expect(secret).toContain('-');
    await request(app).get('/send/rdk_00000000_bad.send?title=x').expect(401);
    await request(app).get(`/send/${secret}.send`).expect(400);
    const get = await request(app).get(`/send/${secret}.send?title=hello&desp=world&tags=a|b`).expect(200);
    expect(get.body.code).toBe(0);
    expect(get.body.data.pushid).toBeTruthy();
    const post = await request(app).post(`/${secret}.send`).type('form').send({ title: 'via form', desp: 'body' }).expect(200);
    expect(post.body.code).toBe(0);
    const delivery = (await repository.getDelivery(String(get.body.data.pushid)))!;
    expect(delivery.metadata).toMatchObject({ tags: 'a|b', via: 'serverchan-compat' });
  });
});

describe('admin key editing', () => {
  it('updates scopes and destination whitelist via PATCH', async () => {
    const { app, repository } = await setup();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' } });
    const created = await request(app).post('/api/admin/keys').send({ name: 'Editable' }).expect(201);
    const id = created.body.apiKey.id as string;

    await request(app).patch(`/api/admin/keys/${id}`).send({ scopes: ['notifications:send', 'config:write'], destinationIds: [channel.id] }).expect(200);
    const listed = await request(app).get('/api/admin/keys').expect(200);
    const key = listed.body.keys.find((item: { id: string }) => item.id === id);
    expect(key.scopes).toEqual(['notifications:send', 'config:write']);
    expect(key.destinationIds).toEqual([channel.id]);

    await request(app).patch(`/api/admin/keys/${id}`).send({ destinationIds: ['no-such-dest'] }).expect(400);
    await request(app).patch('/api/admin/keys/no-such-key').send({ name: 'x' }).expect(404);
  });

  it('rejects unknown destinations on key create', async () => {
    const { app } = await setup();
    await request(app).post('/api/admin/keys').send({ name: 'Bad', destinationIds: ['no-such-dest'] }).expect(400);
  });

  it('rejects secret or unknown fields via PATCH', async () => {
    const { app } = await setup();
    const created = await request(app).post('/api/admin/keys').send({ name: 'S' }).expect(201);
    await request(app).patch(`/api/admin/keys/${created.body.apiKey.id}`).send({ secret: 'new-secret-123' }).expect(400);
  });
});
