import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeRepository } from '../src/server/database-node.js';
import type { RelayRepository } from '../src/server/database.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher, type ProviderMessage } from '../src/server/providers/dispatcher.js';
import { discordCallbackSecret, handleDiscordInteraction } from '../src/server/discord-interactions.js';
import { handleSlackEvent, handleSlackInteractive, slackCallbackSecret } from '../src/server/slack-interactive.js';
import { verifySlackSignature, withinReplayWindow } from '../src/server/webhook-signing.js';
import type { MockFetch } from './helpers.js';

const repositories: RelayRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

async function fixture() {
  const repository = await createNodeRepository(':memory:', randomBytes(32));
  repositories.push(repository);
  return { repository, notifications: new NotificationService(repository) };
}

/** 按 Slack 官方算法生成签名，供正例使用 */
async function signSlack(secret: string, body: string, timestamp: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  return `v0=${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

describe('slack signing', () => {
  it('accepts a correct signature and rejects tampering, wrong secret and replays', async () => {
    const body = 'payload=%7B%7D';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signSlack('shhh', body, timestamp);

    expect(await verifySlackSignature('shhh', body, signature, timestamp)).toBe(true);
    expect(await verifySlackSignature('shhh', `${body}&extra=1`, signature, timestamp)).toBe(false);
    expect(await verifySlackSignature('other', body, signature, timestamp)).toBe(false);
    // 6 分钟前的请求：即使签名对也拒绝（防重放）
    const old = String(Math.floor(Date.now() / 1000) - 400);
    expect(await verifySlackSignature('shhh', body, await signSlack('shhh', body, old), old)).toBe(false);
    expect(withinReplayWindow(undefined)).toBe(false);
  });

  it('enforces the signature once a signing secret is configured', async () => {
    const { repository, notifications } = await fixture();
    const channel = await repository.createChannel({ name: 'SL', slug: 'sl', provider: 'slack-bot',
      config: { botToken: 'xoxb-1', channel: 'C1', signingSecret: 'shhh' } });
    const { apiKey } = await repository.createKey({ name: 'k', destinationIds: [channel.id] });
    const asked = await notifications.ask({ destination: channel.id, question: '上线？', options: ['上线', '再等等'] }, `agent:${apiKey.id}`, apiKey, 'https://walkie.test');
    const secret = slackCallbackSecret('xoxb-1');
    const body = new URLSearchParams({ payload: JSON.stringify({ actions: [{ value: `${asked.conversation.id}:0` }] }) }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));

    // 配了 signingSecret 之后，光有回调 URL 不够
    expect((await handleSlackInteractive(repository, body, secret, {})).statusCode).toBe(401);
    expect((await handleSlackInteractive(repository, body, secret, { signature: 'v0=deadbeef', timestamp })).statusCode).toBe(401);

    const good = await handleSlackInteractive(repository, body, secret, { signature: await signSlack('shhh', body, timestamp), timestamp });
    expect(good.statusCode).toBe(200);
    expect((await repository.getConversation(asked.conversation.id))!.reply).toBe('上线');
  });

  it('answers the events url_verification handshake and routes messages to reply or inbox', async () => {
    const { repository, notifications } = await fixture();
    // 没配 signingSecret：退回路径 secret 鉴权，保持零配置可用
    const channel = await repository.createChannel({ name: 'SL', slug: 'sl', provider: 'slack-bot', config: { botToken: 'xoxb-2', channel: 'C1' } });
    const { apiKey } = await repository.createKey({ name: 'k', destinationIds: [channel.id] });
    const secret = slackCallbackSecret('xoxb-2');
    const event = (body: unknown) => handleSlackEvent(repository, JSON.stringify(body), secret);

    const handshake = await event({ type: 'url_verification', challenge: 'abc123' });
    expect(handshake.body).toEqual({ challenge: 'abc123' });
    expect((await handleSlackEvent(repository, '{}', 'wrong-secret')).statusCode).toBe(401);

    const asked = await notifications.ask({ destination: channel.id, question: '版本号？' }, `agent:${apiKey.id}`, apiKey, 'https://walkie.test');
    await event({ type: 'event_callback', event: { type: 'message', channel: 'C1', text: '就叫 v2' } });
    const conversation = (await repository.getConversation(asked.conversation.id))!;
    expect(conversation.reply).toBe('就叫 v2');
    expect(conversation.replySource).toBe('slack-message');

    // 没有待回复问题 → 收件箱；机器人自己的消息与别的频道都不算
    await event({ type: 'event_callback', event: { type: 'message', channel: 'C1', text: '顺手改下文案' } });
    await event({ type: 'event_callback', event: { type: 'message', channel: 'C1', text: 'bot 回声', bot_id: 'B1' } });
    await event({ type: 'event_callback', event: { type: 'message', channel: 'C-other', text: '别的频道' } });
    expect((await repository.listInboxMessages({ pendingOnly: true })).map((item) => [item.body, item.source]))
      .toEqual([['顺手改下文案', 'slack:sl']]);
  });
});

describe('discord interactions', () => {
  /** 用真实 Ed25519 密钥对模拟 Discord 的签名 */
  async function discordKeys() {
    const pair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
    const hex = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
    const sign = async (timestamp: string, body: string) => {
      const signature = new Uint8Array(await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(`${timestamp}${body}`)));
      return [...signature].map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    return { publicKey: hex, sign };
  }

  it('rejects a bad signature (Discord probes with one before saving the endpoint) and pongs a valid PING', async () => {
    const { repository } = await fixture();
    const { publicKey, sign } = await discordKeys();
    const channel = await repository.createChannel({ name: 'DC', slug: 'dc', provider: 'discord-bot',
      config: { botToken: 'bot-1', channelId: '99', publicKey } });
    void channel;
    const secret = discordCallbackSecret('bot-1');
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1700000000';

    const bad = await handleDiscordInteraction(repository, body, secret, { signature: 'ab'.repeat(32), timestamp });
    expect(bad.statusCode).toBe(401);
    const missing = await handleDiscordInteraction(repository, body, secret, {});
    expect(missing.statusCode).toBe(401);

    const good = await handleDiscordInteraction(repository, body, secret, { signature: await sign(timestamp, body), timestamp });
    expect(good.statusCode).toBe(200);
    expect(good.body).toEqual({ type: 1 });
  });

  it('records the tapped button and renders custom_id on the outgoing message', async () => {
    const { repository, notifications } = await fixture();
    const { publicKey, sign } = await discordKeys();
    const channel = await repository.createChannel({ name: 'DC', slug: 'dc', provider: 'discord-bot',
      config: { botToken: 'bot-2', channelId: '99', publicKey } });
    const { apiKey } = await repository.createKey({ name: 'k', destinationIds: [channel.id] });
    const asked = await notifications.ask({ destination: channel.id, question: '合并？', options: ['合并', '再看看'] }, `agent:${apiKey.id}`, apiKey, 'https://walkie.test');

    const dispatcher = new ProviderDispatcher({ allowPrivateWebhooks: false, allowInsecureHttp: false },
      (async () => new Response('{}')) as unknown as MockFetch);
    const built = await dispatcher.buildRequest('discord-bot', { botToken: 'bot-2', channelId: '99' }, {
      title: '合并？', body: 'q', severity: 'warning',
      metadata: { askOptions: ['合并', '再看看'], conversationId: asked.conversation.id }
    } satisfies ProviderMessage);
    const components = (JSON.parse(String(built.init.body)) as Record<string, any>).components;
    expect(components[0].components[1].custom_id).toBe(`${asked.conversation.id}:1`);

    const body = JSON.stringify({ type: 3, data: { custom_id: `${asked.conversation.id}:1` } });
    const timestamp = '1700000001';
    const result = await handleDiscordInteraction(repository, body, discordCallbackSecret('bot-2'), { signature: await sign(timestamp, body), timestamp });
    expect(result.statusCode).toBe(200);
    expect((result.body as Record<string, any>).data.content).toContain('再看看');
    expect((await repository.getConversation(asked.conversation.id))!.reply).toBe('再看看');
    expect((await repository.getConversation(asked.conversation.id))!.replySource).toBe('discord-button');
  });
});
