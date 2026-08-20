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

async function setup(adminToken?: string, platform: AppConfig['platform'] = 'node') {
  const config = {
    port: 4310, host: '127.0.0.1', dataDir: '.', databasePath: ':memory:', adminToken,
    masterKey: randomBytes(32), allowPrivateWebhooks: true, allowInsecureHttp: false,
    deliveryWorkers: 1, maxSendsPerMin: 0, maxDeliveryAttempts: 1, retryBaseMs: 1, isProduction: false, platform
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

  it('rejects an empty provider on channel update', async () => {
    const { app, repository } = await setup();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    await request(app).patch(`/api/admin/channels/${channel.id}`).send({ provider: '' }).expect(400);
    expect((await repository.getChannel(channel.id))?.provider).toBe('telegram');
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

  it('accepts Bark V2, registration, and legacy path pushes', async () => {
    const { app, repository } = await setup();
    const channel = await repository.createChannel({ name: 'Bark', slug: 'bark', provider: 'bark', config: { server: 'https://api.day.app', deviceKey: 'device-key' } });
    await request(app).post('/register').send({ device_key: 'device-key', device_token: 'token' }).expect(200);
    await request(app).get('/register/device-key').expect(200);

    const push = await request(app).post('/push').send({
      device_key: 'device-key', title: 'Title', subtitle: 'Subtitle', body: 'Body', level: 'critical',
      sound: 'minuet', group: 'ops', url: 'https://example.com'
    }).expect(200);
    expect(push.body).toMatchObject({ code: 200, message: 'success' });
    const v2Delivery = (await repository.listDeliveries({ limit: 10 })).find((item) => item.targetId === channel.id)!;
    expect(v2Delivery.metadata).toMatchObject({ via: 'bark-compat', bark: { subtitle: 'Subtitle', level: 'critical', group: 'ops' } });

    await request(app).get('/device-key/Legacy%20title/Legacy%20body').expect(200);
    const deliveries = await repository.listDeliveries({ limit: 10 });
    expect(deliveries.some((item) => item.title === 'Legacy title' && item.body === 'Legacy body')).toBe(true);
  });

  it('accepts Gotify, PushPlus, and ntfy-compatible pushes', async () => {
    const { app, repository } = await setup();
    const channel = await repository.createChannel({ name: 'Hook', slug: 'hook', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' } });
    const { secret } = await repository.createKey({ name: 'compat', destinationIds: [channel.id] });

    expect((await request(app).post(`/message?token=${encodeURIComponent(secret)}`).send({ title: 'Gotify title', message: 'Gotify body', priority: 8 }).expect(200)).body.id).toBeTruthy();
    expect((await request(app).post('/send').send({ token: secret, title: 'PushPlus title', content: 'PushPlus body' }).expect(200)).body.code).toBe(200);
    expect((await request(app).post('/ntfy/hook').set('Authorization', `Bearer ${secret}`).set('Title', 'ntfy title').type('text').send('ntfy body').expect(200)).body.event).toBe('message');

    const deliveries = await repository.listDeliveries({ limit: 10 });
    expect(deliveries.map((item) => item.source)).toEqual(expect.arrayContaining(['gotify-compat', 'pushplus-compat', 'ntfy-compat']));
  });

  // ntfy 的刻度是 1–5 且允许 urgent/high 之类的名字，不能按 Gotify 的 0–10 去折算：
  // 否则最高优先级只到 warning（数字 5）甚至掉到 info（名字 urgent），静默时段里会被延后
  it('maps ntfy priorities on the ntfy scale, not the Gotify one', async () => {
    const { app, repository } = await setup();
    const channel = await repository.createChannel({ name: 'Hook', slug: 'hook', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' } });
    const { secret } = await repository.createKey({ name: 'compat', destinationIds: [channel.id] });

    const push = (priority: string, title: string) => request(app)
      .post('/ntfy/hook').set('Authorization', `Bearer ${secret}`)
      .set('Title', title).set('Priority', priority).type('text').send('body').expect(200);

    await push('urgent', 'named-urgent');
    await push('5', 'numeric-max');
    await push('high', 'named-high');
    await push('default', 'named-default');

    const byTitle = Object.fromEntries((await repository.listDeliveries({ limit: 20 })).map((item) => [item.title, item.severity]));
    expect(byTitle['named-urgent']).toBe('critical');
    expect(byTitle['numeric-max']).toBe('critical');
    expect(byTitle['named-high']).toBe('warning');
    expect(byTitle['named-default']).toBe('info');
  });

  // 通知 url/callbackUrl 会渲染成管理面板里可点击的 <a href>；javascript: 等 scheme
  // 通过 z.url() 的纯语法校验，等于给恶意 Agent 留了存储型 XSS 的口子
  it('rejects javascript: and data: URLs but accepts http(s) in notifications and compat endpoints', async () => {
    const { app, repository } = await setup();
    const channel = await repository.createChannel({ name: 'Hook', slug: 'hook', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' } });
    const { secret } = await repository.createKey({ name: 'compat', destinationIds: [channel.id] });

    await request(app).post('/api/v1/notify').set('Authorization', `Bearer ${secret}`)
      .send({ destination: channel.id, title: 'x', body: 'x', url: 'javascript:alert(1)' }).expect(400);
    await request(app).post('/api/v1/notify').set('Authorization', `Bearer ${secret}`)
      .send({ destination: channel.id, title: 'x', body: 'x', url: 'data:text/html,<b>' }).expect(400);
    await request(app).post('/api/v1/notify').set('Authorization', `Bearer ${secret}`)
      .send({ destination: channel.id, title: 'x', body: 'x', callbackUrl: 'javascript:alert(1)' }).expect(400);
    await request(app).post('/api/v1/notify').set('Authorization', `Bearer ${secret}`)
      .send({ destination: channel.id, title: 'ok', body: 'ok', url: 'https://example.com/a?b=1' }).expect(202);

    // 兼容端点不走 schema，需各自过滤：bark url 参数、ntfy Click 头
    await repository.createChannel({ name: 'Bark', slug: 'bark2', provider: 'bark', config: { server: 'https://api.day.app', deviceKey: 'device-key' } });
    await request(app).post('/push').send({ device_key: 'device-key', title: 't', body: 'b', url: 'javascript:alert(1)' }).expect(200);
    await request(app).post('/ntfy/hook').set('Authorization', `Bearer ${secret}`)
      .set('Title', 'click-xss').set('Click', 'javascript:alert(1)').type('text').send('b').expect(200);

    const deliveries = await repository.listDeliveries({ limit: 20 });
    expect(deliveries.find((item) => item.title === 'ok')?.url).toBe('https://example.com/a?b=1');
    expect(deliveries.find((item) => item.source === 'bark-compat')?.url).toBeUndefined();
    expect(deliveries.find((item) => item.title === 'click-xss')?.url).toBeUndefined();
  });

  it('reports platform metadata and enforces delivery soft limits', async () => {
    const { app, repository } = await setup(undefined, 'vercel');
    const meta = (await request(app).get('/api/meta').expect(200)).body;
    expect(meta.platform).toBe('vercel');
    expect(meta.platformProfile.label).toBe('Vercel Functions');
    expect(meta.compatibilityEndpoints.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(['bark', 'gotify', 'pushplus', 'ntfy']));

    const channel = await repository.createChannel({ name: 'Hook', slug: 'hook', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' } });
    const { secret } = await repository.createKey({ name: 'limited', destinationIds: [channel.id] });
    await request(app).put('/api/admin/usage').send({ dailyDeliveryLimit: 1, monthlyDeliveryLimit: 0, warningPercent: 80 }).expect(200);
    const body = { destination: channel.id, title: 'one', body: 'one' };
    await request(app).post('/api/v1/notify').set('Authorization', `Bearer ${secret}`).send(body).expect(202);
    await request(app).post('/api/v1/notify').set('Authorization', `Bearer ${secret}`).send(body).expect(400, { error: '已达到每日投递软限制' });
    const usage = (await request(app).get('/api/admin/usage').expect(200)).body;
    expect(usage.today.deliveries).toBe(1);
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
