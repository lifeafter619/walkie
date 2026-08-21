import { randomBytes } from 'node:crypto';
import type { MockFetch } from './helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeRepository } from '../src/server/database-node.js';
import type { RelayRepository } from '../src/server/database.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher, type ProviderMessage } from '../src/server/providers/dispatcher.js';
import { handleSlackInteractive, slackCallbackSecret } from '../src/server/slack-interactive.js';
import { handleTelegramWebhook, telegramWebhookSecret } from '../src/server/telegram-webhook.js';

const repositories: RelayRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

const noopPost = async () => undefined;

async function fixture() {
  const repository = await createNodeRepository(':memory:', randomBytes(32));
  repositories.push(repository);
  const notifications = new NotificationService(repository);
  return { repository, notifications };
}

describe('inbox: human → agent', () => {
  it('claims each message exactly once', async () => {
    const { repository } = await fixture();
    await repository.pushInboxMessage('先跑测试再合并', 'admin');
    await repository.pushInboxMessage('顺便更新 changelog', 'admin');

    const first = await repository.claimInboxMessages('agent:a');
    expect(first.map((item) => item.body)).toEqual(['先跑测试再合并', '顺便更新 changelog']);
    expect(await repository.claimInboxMessages('agent:b')).toEqual([]);

    const all = await repository.listInboxMessages();
    expect(all.every((item) => item.claimedBy === 'agent:a')).toBe(true);
    expect(await repository.listInboxMessages({ pendingOnly: true })).toEqual([]);
  });
});

describe('telegram webhook: routes, free text and inbox', () => {
  it('answers button callbacks when the ask target is a route, not a bare channel', async () => {
    const { repository, notifications } = await fixture();
    const telegram = await repository.createChannel({ name: 'TG', slug: 'tg', provider: 'telegram', config: { botToken: '123:ABC', chatId: '42' } });
    const other = await repository.createChannel({ name: 'Mail', slug: 'mail', provider: 'smtp', config: { host: 'smtp.example.com', port: 587, from: 'a@b.c', to: 'd@e.f' } });
    const route = await repository.createRoute({ name: 'R', slug: 'r', strategy: 'fanout', channelIds: [telegram.id, other.id] });
    const { apiKey } = await repository.createKey({ name: 'k', destinationIds: [route.id] });

    const asked = await notifications.ask({ destination: route.id, question: '回滚？', options: ['回滚', '继续'] }, `agent:${apiKey.id}`, apiKey, 'https://walkie.test');
    const secret = telegramWebhookSecret('123:ABC');
    const update = { callback_query: { id: 'cb1', message: { chat: { id: 42 } }, data: `${asked.conversation.id}:0` } };

    expect((await handleTelegramWebhook(repository, noopPost, update, 'nope')).statusCode).toBe(401);
    expect((await handleTelegramWebhook(repository, noopPost, update, secret)).statusCode).toBe(200);
    expect((await repository.getConversation(asked.conversation.id))!.reply).toBe('回滚');
  });

  it('treats a plain message as the reply when a question is pending, else stores it in the inbox', async () => {
    const { repository, notifications } = await fixture();
    const channel = await repository.createChannel({ name: 'TG', slug: 'tg', provider: 'telegram', config: { botToken: '123:ABC', chatId: '42' } });
    const { apiKey } = await repository.createKey({ name: 'k', destinationIds: [channel.id] });
    const secret = telegramWebhookSecret('123:ABC');
    const message = (text: string, chatId = 42) => ({ message: { message_id: 7, chat: { id: chatId }, text } });

    const asked = await notifications.ask({ destination: channel.id, question: '标题写什么？' }, `agent:${apiKey.id}`, apiKey, 'https://walkie.test');
    await handleTelegramWebhook(repository, noopPost, message('叫 v2 就行'), secret);
    const conversation = (await repository.getConversation(asked.conversation.id))!;
    expect(conversation.reply).toBe('叫 v2 就行');
    expect(conversation.replySource).toBe('telegram-message');

    // 没有待回复问题时进收件箱
    await handleTelegramWebhook(repository, noopPost, message('顺手把 lint 也修了'), secret);
    expect((await repository.listInboxMessages({ pendingOnly: true })).map((item) => item.body)).toEqual(['顺手把 lint 也修了']);

    // 陌生 chat 的消息不进任何通道；bot 命令也不算内容
    await handleTelegramWebhook(repository, noopPost, message('我是陌生人', 999), secret);
    await handleTelegramWebhook(repository, noopPost, message('/start'), secret);
    expect(await repository.listInboxMessages({ pendingOnly: true })).toHaveLength(1);
  });
  it('picks the channel by chat id when several channels share one bot token', async () => {
    // 线上抓到的真 bug：同一个 bot 配多个频道（一个群一个频道）时，只按 token 匹配会取到
    // 任意一个——回复归错频道，自由文本找不到待回复会话而误落收件箱。
    const { repository, notifications } = await fixture();
    const token = '123:SHARED';
    const teamA = await repository.createChannel({ name: 'A', slug: 'team-a', provider: 'telegram', config: { botToken: token, chatId: '111' } });
    const teamB = await repository.createChannel({ name: 'B', slug: 'team-b', provider: 'telegram', config: { botToken: token, chatId: '222' } });
    // 已软删除的历史频道不该抢走回调
    await repository.updateChannel(teamA.id, { enabled: false });
    const { apiKey } = await repository.createKey({ name: 'k', destinationIds: [teamA.id, teamB.id] });
    const secret = telegramWebhookSecret(token);

    const asked = await notifications.ask({ destination: teamB.id, question: 'B 组的问题？' }, `agent:${apiKey.id}`, apiKey, 'https://walkie.test');
    await handleTelegramWebhook(repository, noopPost, { message: { message_id: 1, chat: { id: 222 }, text: 'B 组的答案' } }, secret);

    const conversation = (await repository.getConversation(asked.conversation.id))!;
    expect(conversation.reply).toBe('B 组的答案');
    expect(conversation.replySource).toBe('telegram-message');
    expect(await repository.listInboxMessages({ pendingOnly: true })).toEqual([]);

    // 另一个 chat 的消息归到它自己的频道，来源标记不会串台
    await handleTelegramWebhook(repository, noopPost, { message: { message_id: 2, chat: { id: 111 }, text: 'A 组随口一说' } }, secret);
    const inbox = await repository.listInboxMessages({ pendingOnly: true });
    expect(inbox.map((item) => [item.body, item.source])).toEqual([['A 组随口一说', 'telegram:team-a']]);
  });
});

describe('slack bot buttons', () => {
  it('carries the conversation id in the button value and records the tapped option', async () => {
    const { repository, notifications } = await fixture();
    const channel = await repository.createChannel({ name: 'SL', slug: 'sl', provider: 'slack-bot', config: { botToken: 'xoxb-1', channel: 'C1' } });
    const { apiKey } = await repository.createKey({ name: 'k', destinationIds: [channel.id] });
    const asked = await notifications.ask({ destination: channel.id, question: '上线？', options: ['上线', '再等等'] }, `agent:${apiKey.id}`, apiKey, 'https://walkie.test');

    const dispatcher = new ProviderDispatcher({ allowPrivateWebhooks: false, allowInsecureHttp: false }, vi.fn(async () => new Response('{"ok":true}')) as unknown as MockFetch);
    const built = await dispatcher.buildRequest('slack-bot', { botToken: 'xoxb-1', channel: 'C1' }, {
      title: '上线？', body: 'q', severity: 'warning',
      metadata: { askOptions: ['上线', '再等等'], conversationId: asked.conversation.id }
    } satisfies ProviderMessage);
    const blocks = (JSON.parse(String(built.init.body)) as Record<string, any>).blocks;
    expect(blocks[1].elements[1].value).toBe(`${asked.conversation.id}:1`);

    // handleSlackInteractive 收的是**原始请求体**（验签需要），不是解析后的对象
    const payload = new URLSearchParams({ payload: JSON.stringify({ actions: [{ action_id: 'walkie_ask_1', value: `${asked.conversation.id}:1` }] }) }).toString();
    expect((await handleSlackInteractive(repository, payload, 'wrong')).statusCode).toBe(401);
    const accepted = await handleSlackInteractive(repository, payload, slackCallbackSecret('xoxb-1'));
    expect(accepted.statusCode).toBe(200);
    expect((await repository.getConversation(asked.conversation.id))!.reply).toBe('再等等');
  });
});

describe('retention purge', () => {
  it('removes attempts along with expired deliveries instead of orphaning them', async () => {
    const { repository, notifications } = await fixture();
    const channel = await repository.createChannel({ name: 'TG', slug: 'tg', provider: 'telegram', config: { botToken: '1:a', chatId: '1' } });
    const delivery = await notifications.send({ destination: channel.id, title: 't', body: 'b' }, 'admin');
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await repository.db.run('UPDATE deliveries SET created_at=? WHERE id=?', [old, delivery.id]);

    await repository.setRetention({ deliveriesDays: 7 });
    const purged = await repository.purgeExpiredData();
    expect(purged.deliveries).toBe(1);
    expect(await repository.db.all('SELECT id FROM attempts WHERE delivery_id=?', [delivery.id])).toEqual([]);
  });
});
