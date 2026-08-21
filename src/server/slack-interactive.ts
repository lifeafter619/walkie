import type { Channel } from '../shared/types.js';
import { channelCallbackSecret, safeTokenEqual } from './crypto.js';
import type { RelayRepository } from './database.js';
import { verifySlackSignature } from './webhook-signing.js';

/**
 * Slack Bot 双向：Block Kit 按钮点按即回（interactive），以及直接在频道里回一句话（events）。
 *
 * 鉴权两层，任配其一即可用：
 *  1. 渠道配置了 signingSecret → 走官方的 X-Slack-Signature 验签（推荐，能防 URL 泄露）
 *  2. 没配 → 退回路径里的高熵 secret（由 botToken 派生），零配置可用
 * 两条路都要先用路径 secret 定位到频道，所以 URL 本身始终是必要条件。
 */
export function slackCallbackSecret(botToken: string): string {
  return channelCallbackSecret('slack', botToken);
}

export interface SlackResult {
  statusCode: number;
  body: unknown;
}

export interface SlackHeaders {
  signature?: string;
  timestamp?: string;
}

interface Resolved {
  channel: Channel;
  signingSecret: string;
  slackChannel: string;
}

async function resolveChannel(repository: RelayRepository, secret: string): Promise<Resolved | undefined> {
  if (!secret) return undefined;
  const candidates: Resolved[] = [];
  for (const channel of await repository.listChannels()) {
    if (channel.provider !== 'slack-bot') continue;
    const config = await repository.getChannelConfig(channel.id);
    const botToken = String(config.botToken ?? '');
    if (botToken && safeTokenEqual(secret, slackCallbackSecret(botToken))) {
      candidates.push({ channel, signingSecret: String(config.signingSecret ?? ''), slackChannel: String(config.channel ?? '') });
    }
  }
  // 同一个 bot token 可以配成多个频道（不同 Slack channel）；优先启用的，
  // 别让软删除的历史频道兜住回调
  return candidates.find((item) => item.channel.enabled) ?? candidates[0];
}

/** 配了 signing secret 就必须验签通过；没配则路径 secret 已经是唯一凭据 */
async function authorized(resolved: Resolved, rawBody: string, headers: SlackHeaders): Promise<boolean> {
  if (!resolved.signingSecret) return true;
  return verifySlackSignature(resolved.signingSecret, rawBody, headers.signature, headers.timestamp);
}

/** POST /slack/interactive/<secret>：按钮点按。rawBody 是 `payload=<urlencoded json>` */
export async function handleSlackInteractive(
  repository: RelayRepository,
  rawBody: string,
  secret: string,
  headers: SlackHeaders = {}
): Promise<SlackResult> {
  const resolved = await resolveChannel(repository, secret);
  if (!resolved || !await authorized(resolved, rawBody, headers)) return { statusCode: 401, body: { error: 'invalid signature' } };
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get('payload') ?? '{}') as Record<string, unknown>;
  } catch {
    return { statusCode: 400, body: { error: 'invalid payload' } };
  }
  const action = (Array.isArray(payload.actions) ? payload.actions : [])
    .find((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  const match = /^([0-9a-f-]{36}):(\d+)$/.exec(String(action?.value ?? ''));
  // Slack 对非 2xx 会给用户报错；无法处理的交互按收讫返回空体即可
  if (!match) return { statusCode: 200, body: {} };
  const [, conversationId, index] = match;
  const conversation = await repository.getConversation(conversationId!);
  const option = (conversation?.options ?? [])[Number(index)];
  if (option === undefined) return { statusCode: 200, body: {} };
  const accepted = await repository.replyConversation(conversationId!, option, 'slack-button');
  return {
    statusCode: 200,
    body: {
      response_type: 'ephemeral',
      replace_original: false,
      text: accepted ? `✅ 已回复：${option}` : '该问题已回复或已过期'
    }
  };
}

/**
 * POST /slack/events/<secret>：Events API。订阅 `message.channels` / `message.im` 后，
 * 人在频道里直接说一句话 → 有待回复问题就当回复，否则进收件箱（与 Telegram 同语义）。
 */
export async function handleSlackEvent(
  repository: RelayRepository,
  rawBody: string,
  secret: string,
  headers: SlackHeaders = {}
): Promise<SlackResult> {
  const resolved = await resolveChannel(repository, secret);
  if (!resolved || !await authorized(resolved, rawBody, headers)) return { statusCode: 401, body: { error: 'invalid signature' } };
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(rawBody || '{}') as Record<string, unknown>; }
  catch { return { statusCode: 400, body: { error: 'invalid payload' } }; }

  // 订阅 Event Subscriptions 时 Slack 先来一次握手，原样回 challenge
  if (payload.type === 'url_verification') return { statusCode: 200, body: { challenge: String(payload.challenge ?? '') } };
  if (payload.type !== 'event_callback') return { statusCode: 200, body: { ok: true } };

  const event = payload.event && typeof payload.event === 'object' ? payload.event as Record<string, unknown> : {};
  // bot_id/subtype 覆盖掉机器人自己的消息、编辑、加入频道等噪声——否则我们回的确认会被自己吃回来
  if (event.type !== 'message' || event.bot_id || event.subtype) return { statusCode: 200, body: { ok: true } };
  const channelId = String(event.channel ?? '');
  if (resolved.slackChannel && channelId && channelId !== resolved.slackChannel) return { statusCode: 200, body: { ok: true } };
  const text = String(event.text ?? '').trim().slice(0, 4000);
  if (!text || text.startsWith('/')) return { statusCode: 200, body: { ok: true } };

  const pending = await repository.findPendingConversationForChannel(resolved.channel.id);
  if (pending && await repository.replyConversation(pending.id, text, 'slack-message')) {
    return { statusCode: 200, body: { ok: true } };
  }
  await repository.pushInboxMessage(text, `slack:${resolved.channel.slug}`);
  return { statusCode: 200, body: { ok: true } };
}
