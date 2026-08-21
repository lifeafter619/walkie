import { createHash } from 'node:crypto';
import type { RelayRepository } from './database.js';

/**
 * Telegram Bot webhook（#11）：接收 inline_keyboard 的 callback_query，
 * 转成 replyConversation —— 复用一次性 token 语义：一个会话只接受第一次回复。
 *
 * secret 派生自渠道 botToken（sha256/base64url）：不用额外配置项，setWebhook 时
 * 从「频道 → 编辑」页复制完整 webhook URL。校验顺序：先从 callback_data 反查会话与
 * 渠道，再比对 X-Telegram-Bot-Api-Secret-Token——渠道即权威。
 */
export function telegramWebhookSecret(botToken: string): string {
  return createHash('sha256').update(`walkie:tg:${botToken}`).digest('base64url');
}

export interface TelegramWebhookResult {
  statusCode: number;
  body: unknown;
}

/** 处理 POST /telegram/webhook/<secret>；幂等（重复回调 answerCallbackQuery 会失败但回复不重复写） */
export async function handleTelegramWebhook(
  repository: RelayRepository,
  post: (url: string, init: RequestInit) => Promise<void>,
  update: Record<string, unknown>,
  headerSecret: string | undefined
): Promise<TelegramWebhookResult> {
  const callback = update.callback_query;
  if (!callback || typeof callback !== 'object') return { statusCode: 200, body: { ok: true } };
  const record = callback as Record<string, unknown>;
  const match = /^([0-9a-f-]{36}):(\d+)$/.exec(String(record.data ?? ''));
  if (!match) return { statusCode: 200, body: { ok: true } };
  const [, conversationId, index] = match;

  const conversation = await repository.getConversation(conversationId);
  if (!conversation?.deliveryId) return { statusCode: 200, body: { ok: true } };
  const delivery = await repository.getDelivery(conversation.deliveryId);
  if (!delivery) return { statusCode: 200, body: { ok: true } };
  const channel = await repository.getChannel(delivery.targetId);
  if (!channel || channel.provider !== 'telegram') return { statusCode: 200, body: { ok: true } };
  const config = await repository.getChannelConfig(channel.id);
  const botToken = String(config.botToken ?? '');
  if (!botToken) return { statusCode: 200, body: { ok: true } };

  // secret 校验放在能定位渠道之后：X-Telegram-Bot-Api-Secret-Token 必须等于该渠道派生值
  if (!headerSecret || headerSecret !== telegramWebhookSecret(botToken)) {
    return { statusCode: 401, body: { ok: false, error: 'invalid secret' } };
  }

  const option = (conversation.options ?? [])[Number(index)];
  if (option === undefined) return { statusCode: 200, body: { ok: true } };

  const accepted = await repository.replyConversation(conversationId, option, 'telegram-callback');
  const notice = accepted ? `✅ 已回复：${option}` : '该问题已回复或已过期';
  try {
    await post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callback_query_id: String(record.id), text: notice })
    });
  } catch { /* 回复已落库；Telegram 按钮 loading 停不下来可接受 */ }
  return { statusCode: 200, body: { ok: true } };
}
