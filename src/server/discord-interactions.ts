import type { Channel } from '../shared/types.js';
import { channelCallbackSecret, safeTokenEqual } from './crypto.js';
import type { RelayRepository } from './database.js';
import { verifyDiscordSignature } from './webhook-signing.js';

/**
 * Discord Interactions（按钮点按即回）。
 *
 * 与 Telegram/Slack 不同，Discord **强制** Ed25519 验签：保存 Interactions Endpoint URL 时
 * Discord 会故意发一个坏签名，端点必须回 401 才算通过，所以这里没有「未配公钥就放行」的旁路。
 * 路径里的 secret 只用来定位是哪个频道（同一个 bot 可以配多个频道），真正的鉴权是验签。
 *
 * 注意：Discord 的**普通聊天消息**不会推到 HTTP webhook，只有 interaction 会。
 * 收取自由文本需要常驻 Gateway(WebSocket) 连接，Workers 上做不到——所以 Discord 只有按钮，
 * 没有「回一句话即作答」，这是平台结构限制，不是没实现。
 */
export function discordCallbackSecret(botToken: string): string {
  return channelCallbackSecret('discord', botToken);
}

export interface DiscordInteractionResult {
  statusCode: number;
  body: unknown;
}

const INTERACTION = { PING: 1, MESSAGE_COMPONENT: 3 } as const;
const RESPONSE = { PONG: 1, CHANNEL_MESSAGE_WITH_SOURCE: 4 } as const;
const EPHEMERAL = 64;

/** 同 token 可能配多个频道；这里只用于取公钥，优先启用的频道 */
async function resolveChannel(repository: RelayRepository, secret: string):
Promise<{ channel: Channel; publicKey: string } | undefined> {
  if (!secret) return undefined;
  const candidates: Array<{ channel: Channel; publicKey: string }> = [];
  for (const channel of await repository.listChannels()) {
    if (channel.provider !== 'discord-bot') continue;
    const config = await repository.getChannelConfig(channel.id);
    const botToken = String(config.botToken ?? '');
    if (botToken && safeTokenEqual(secret, discordCallbackSecret(botToken))) {
      candidates.push({ channel, publicKey: String(config.publicKey ?? '') });
    }
  }
  return candidates.find((item) => item.channel.enabled) ?? candidates[0];
}

/** 处理 POST /discord/interactions/<secret>；rawBody 必须是未解析的原始请求体 */
export async function handleDiscordInteraction(
  repository: RelayRepository,
  rawBody: string,
  secret: string,
  headers: { signature?: string; timestamp?: string }
): Promise<DiscordInteractionResult> {
  const resolved = await resolveChannel(repository, secret);
  if (!resolved) return { statusCode: 401, body: { error: 'invalid signature' } };
  if (!await verifyDiscordSignature(resolved.publicKey, rawBody, headers.signature, headers.timestamp)) {
    return { statusCode: 401, body: { error: 'invalid signature' } };
  }

  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(rawBody || '{}') as Record<string, unknown>; }
  catch { return { statusCode: 400, body: { error: 'invalid payload' } }; }

  // 端点注册与保活的心跳
  if (Number(payload.type) === INTERACTION.PING) return { statusCode: 200, body: { type: RESPONSE.PONG } };
  if (Number(payload.type) !== INTERACTION.MESSAGE_COMPONENT) return { statusCode: 200, body: { type: RESPONSE.PONG } };

  const data = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {};
  const match = /^([0-9a-f-]{36}):(\d+)$/.exec(String(data.custom_id ?? ''));
  const reply = (text: string) => ({
    statusCode: 200,
    body: { type: RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: text, flags: EPHEMERAL } }
  });
  if (!match) return reply('无法识别的按钮。');
  const [, conversationId, index] = match;
  const conversation = await repository.getConversation(conversationId!);
  const option = (conversation?.options ?? [])[Number(index)];
  if (option === undefined) return reply('该问题已不存在。');
  const accepted = await repository.replyConversation(conversationId!, option, 'discord-button');
  return reply(accepted ? `✅ 已回复：${option}` : '该问题已回复或已过期');
}
