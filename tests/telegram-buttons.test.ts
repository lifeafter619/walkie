import { randomBytes } from 'node:crypto';
import { testConfig, type MockFetch } from './helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeRepository } from '../src/server/database-node.js';
import type { RelayRepository } from '../src/server/database.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher, type ProviderMessage } from '../src/server/providers/dispatcher.js';
import { telegramWebhookSecret, handleTelegramWebhook } from '../src/server/telegram-webhook.js';
import { createApp } from '../src/server/app.js';
import { DeliveryWorker } from '../src/server/queue.js';
import request from 'supertest';

const repositories: RelayRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

describe('telegram inline buttons + webhook (#11)', () => {
  it('renders ask options as inline_keyboard with conversation callback_data', async () => {
    const dispatcher = new ProviderDispatcher({ allowPrivateWebhooks: false, allowInsecureHttp: false }, vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch);
    const built = await dispatcher.buildRequest('telegram', { botToken: '123:ABC', chatId: '42' }, {
      title: 'Q', body: 'body', severity: 'warning',
      metadata: { askOptions: ['回滚', '继续'], conversationId: '11111111-2222-3333-4444-555555555555' }
    } satisfies ProviderMessage);
    const payload = JSON.parse(String(built.init.body)) as Record<string, any>;
    expect(payload.reply_markup.inline_keyboard[0]).toEqual([
      { text: '回滚', callback_data: '11111111-2222-3333-4444-555555555555:0' },
      { text: '继续', callback_data: '11111111-2222-3333-4444-555555555555:1' }
    ]);
  });

  it('accepts callback_query via the webhook and records the reply once', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    repositories.push(repository);
    const channel = await repository.createChannel({ name: 'TG', slug: 'tg', provider: 'telegram', config: { botToken: '123:ABC', chatId: '42' } });
    const notifications = new NotificationService(repository);
    const dispatcher = new ProviderDispatcher({ allowPrivateWebhooks: false, allowInsecureHttp: false }, vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch);
    const worker = new DeliveryWorker(repository, dispatcher, { deliveryWorkers: 1, maxDeliveryAttempts: 1, retryBaseMs: 1, maxSendsPerMin: 0 });
    const app = createApp({ config: testConfig({ port: 4310, host: '127.0.0.1', dataDir: '.', databasePath: ':memory:', adminToken: 'x'.repeat(12), masterKey: randomBytes(32), allowPrivateWebhooks: false, allowInsecureHttp: false, deliveryWorkers: 1, maxSendsPerMin: 0, maxDeliveryAttempts: 1, retryBaseMs: 1, isProduction: false, }), repository, notifications, dispatcher, worker });

    const { apiKey: agentKey } = await repository.createKey({ name: 'k', destinationIds: [channel.id] });
    const asked = await notifications.ask({ destination: channel.id, question: '要不要回滚？', options: ['回滚', '继续'] }, `agent:${agentKey.id}`, agentKey, 'https://walkie.test');
    const conversationId = (await notifications.conversationStatus(asked.conversation.id, agentKey)).conversation.id;
    const secret = telegramWebhookSecret('123:ABC');
    const update = {
      update_id: 1,
      callback_query: { id: 'cbq1', from: { id: 1 }, data: `${conversationId}:0` }
    };

    // 错 secret → 401
    await request(app).post(`/telegram/webhook/wrongsecret`)
      .set('X-Telegram-Bot-Api-Secret-Token', 'wrong')
      .send(update).expect(401);
    // 对 secret → 接受第一下
    await request(app).post(`/telegram/webhook/${encodeURIComponent(secret)}`)
      .set('X-Telegram-Bot-Api-Secret-Token', secret)
      .send(update).expect(200);
    const status = await notifications.conversationStatus(conversationId, agentKey);
    expect(status.status).toBe('replied');
    expect(status.conversation.reply).toBe('回滚');
    expect(status.conversation.replySource).toBe('telegram-callback');
    // 重复点按（同一会话第二次）不再改写回复
    await request(app).post(`/telegram/webhook/${encodeURIComponent(secret)}`)
      .set('X-Telegram-Bot-Api-Secret-Token', secret)
      .send(update).expect(200);
    const again = await notifications.conversationStatus(conversationId, agentKey);
    expect(again.conversation.reply).toBe('回滚');
  });
});
