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
afterEach(() => repositories.splice(0).forEach((repository) => void repository.close()));

async function setup() {
  const config = {
    port: 4310, host: '127.0.0.1', dataDir: '.', databasePath: ':memory:', adminToken: undefined,
    masterKey: randomBytes(32), allowPrivateWebhooks: true, allowInsecureHttp: false,
    deliveryWorkers: 1, maxSendsPerMin: 0, maxDeliveryAttempts: 1, retryBaseMs: 1, isProduction: false,
    publicUrl: 'https://relay.example.com'
  } as AppConfig;
  const repository = await createNodeRepository(':memory:', config.masterKey); repositories.push(repository);
  const notifications = new NotificationService(repository);
  const dispatcher = new ProviderDispatcher(config, async () => new Response('{}', { status: 200 }));
  const worker = new DeliveryWorker(repository, dispatcher, config);
  const app = createApp({ config, repository, notifications, dispatcher, worker });
  const channel = await repository.createChannel({ name: 'Hook', slug: 'hook', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' } });
  const { secret } = await repository.createKey({ name: 'agent', destinationIds: [channel.id] });
  return { app, repository, secret, channel };
}

describe('ask_user bidirectional flow', () => {
  it('runs ask -> reply link -> agent polls reply', async () => {
    const { app, secret } = await setup();
    const asked = await request(app).post('/api/v1/ask')
      .set('Authorization', `Bearer ${secret}`)
      .send({ destination: 'hook', question: '可以删除旧备份吗？' })
      .expect(201);
    expect(asked.body.replyUrl).toMatch(/^https:\/\/relay\.example\.com\/reply\//);
    const replyPath = new URL(asked.body.replyUrl).pathname;

    const pending = await request(app).get(`/api/v1/conversations/${asked.body.conversationId}`)
      .set('Authorization', `Bearer ${secret}`).expect(200);
    expect(pending.body.status).toBe('pending');

    const form = await request(app).get(replyPath).expect(200);
    expect(form.text).toContain('可以删除旧备份吗？');
    await request(app).post(replyPath).type('form').send({ reply: 'yes, go ahead' }).expect(200);
    // 链接一次性：重复提交 410
    await request(app).post(replyPath).type('form').send({ reply: 'again' }).expect(410);
    await request(app).get(replyPath).expect(410);

    const replied = await request(app).get(`/api/v1/conversations/${asked.body.conversationId}`)
      .set('Authorization', `Bearer ${secret}`).expect(200);
    expect(replied.body).toMatchObject({ status: 'replied', reply: 'yes, go ahead' });
  });

  it('rejects wrong token and lists pending conversations for admin', async () => {
    const { app, secret, repository } = await setup();
    const asked = await request(app).post('/api/v1/ask')
      .set('Authorization', `Bearer ${secret}`)
      .send({ destination: 'hook', question: 'Q' }).expect(201);
    await request(app).get(`/reply/${asked.body.conversationId}/badtoken`).expect(410);

    const listed = await request(app).get('/api/admin/conversations?pending=1').expect(200);
    expect(listed.body.conversations).toHaveLength(1);
    await request(app).post(`/api/admin/conversations/${asked.body.conversationId}/reply`).send({ reply: 'no' }).expect(200);
    await request(app).post(`/api/admin/conversations/${asked.body.conversationId}/reply`).send({ reply: 'again' }).expect(409);
    const conversation = await repository.getConversation(asked.body.conversationId);
    expect(conversation?.reply).toBe('no');
    expect(conversation?.replySource).toBe('admin');
  });

  it('renders option buttons and accepts an option reply', async () => {
    const { app, secret } = await setup();
    const asked = await request(app).post('/api/v1/ask')
      .set('Authorization', `Bearer ${secret}`)
      .send({ destination: 'hook', question: 'Deploy target?', options: ['staging', 'production', 'abort'] })
      .expect(201);
    const replyPath = new URL(asked.body.replyUrl).pathname;
    const form = await request(app).get(replyPath).expect(200);
    expect(form.text).toContain('staging');
    expect(form.text).toContain('production');
    await request(app).post(replyPath).type('form').send({ reply: 'production', replyText: '' }).expect(200);
    const replied = await request(app).get(`/api/v1/conversations/${asked.body.conversationId}`)
      .set('Authorization', `Bearer ${secret}`).expect(200);
    expect(replied.body).toMatchObject({ status: 'replied', reply: 'production' });
  });

  it('honors X-Forwarded-* behind a reverse proxy when publicUrl is unset', async () => {
    // 不设 publicUrl 时回复链接取自请求 origin；反代场景必须读 X-Forwarded-Proto/Host，
    // 否则生成 http://内网地址，ask_user 的回复链接打不开
    const config = {
      port: 4310, host: '127.0.0.1', dataDir: '.', databasePath: ':memory:', adminToken: undefined,
      masterKey: randomBytes(32), allowPrivateWebhooks: true, allowInsecureHttp: false,
      deliveryWorkers: 1, maxSendsPerMin: 0, maxDeliveryAttempts: 1, retryBaseMs: 1, isProduction: false,
      publicUrl: undefined
    } as AppConfig;
    const repository = await createNodeRepository(':memory:', config.masterKey); repositories.push(repository);
    const app = createApp({ config, repository, notifications: new NotificationService(repository), dispatcher: new ProviderDispatcher(config, async () => new Response('{}', { status: 200 })), worker: new DeliveryWorker(repository, new ProviderDispatcher(config, async () => new Response('{}', { status: 200 })), config) });
    const channel = await repository.createChannel({ name: 'Hook', slug: 'hook-fwd', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' } });
    const { secret } = await repository.createKey({ name: 'agent', destinationIds: [channel.id] });
    // 反代透传真实域名的 Host 头（Express 原生读取），X-Forwarded-Proto 负责还原协议；
    // trust proxy 未启用时 req.protocol 恒为 http，会生成打不开的 http:// 链接
    const asked = await request(app).post('/api/v1/ask')
      .set('Authorization', `Bearer ${secret}`)
      .set('X-Forwarded-Proto', 'https')
      .send({ destination: 'hook-fwd', question: 'Q' }).expect(201);
    expect(asked.body.replyUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/reply\//);
  });

  it('exposes ask_user and check_reply MCP tools', async () => {
    const { app, secret } = await setup();
    const tools = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${secret}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(200);
    expect(tools.text).toContain('ask_user');
    expect(tools.text).toContain('check_reply');
  });
});
