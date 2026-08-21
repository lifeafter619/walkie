import type { Channel } from '../shared/types.js';
import { channelCallbackSecret, safeTokenEqual } from './crypto.js';
import type { RelayRepository } from './database.js';

/**
 * Telegram Bot webhook（#11）：接收 inline_keyboard 的 callback_query 与普通消息。
 *
 *  - callback_query：按钮即点即回，转成 replyConversation()
 *  - message：正在等回复的会话 → 自由文本回复；没有待回复会话 → 进收件箱（人主动找 Agent）
 *
 * secret 派生自渠道 botToken（sha256/base64url）：不用额外配置项，「频道」页直接显示
 * 完整 webhook URL。校验顺序：先用 secret 反查是哪一个 telegram 渠道（渠道即权威），
 * 再校验 chat_id——否则任何找到这个 bot 的陌生人都能替你回答 Agent 的问题。
 */
export function telegramWebhookSecret(botToken: string): string {
  return channelCallbackSecret('tg', botToken);
}

export interface TelegramWebhookResult {
  statusCode: number;
  body: unknown;
}

const ok: TelegramWebhookResult = { statusCode: 200, body: { ok: true } };

/**
 * 用 header secret + 更新里的 chat.id 反查发起回调的 telegram 渠道。
 *
 * bot token 标识的是「机器人」而不是「频道」：同一个 bot 配成多个频道（一个群一个频道，
 * chatId 不同）是正常用法，光按 token 匹配会取到任意一个，回复归错频道、自由文本
 * 找不到待回复会话而误落收件箱。chat.id 才是区分频道的键；启用的频道优先，
 * 软删除的历史频道不该抢走回调。
 */
async function resolveChannel(repository: RelayRepository, headerSecret: string | undefined, chatId: string):
Promise<{ channel: Channel; botToken: string; chatId: string } | undefined> {
  if (!headerSecret) return undefined;
  const candidates: Array<{ channel: Channel; botToken: string; chatId: string }> = [];
  for (const channel of await repository.listChannels()) {
    if (channel.provider !== 'telegram') continue;
    const config = await repository.getChannelConfig(channel.id);
    const botToken = String(config.botToken ?? '');
    if (botToken && safeTokenEqual(headerSecret, telegramWebhookSecret(botToken))) {
      candidates.push({ channel, botToken, chatId: String(config.chatId ?? '') });
    }
  }
  if (!candidates.length) return undefined;
  const sameChat = candidates.filter((item) => chatId && item.chatId === chatId);
  const enabledFirst = (list: typeof candidates) => list.find((item) => item.channel.enabled) ?? list[0];
  // 精确命中 chat 的优先；都没命中时退回任一同 token 频道，让下游的 chat 校验去拒绝
  return sameChat.length ? enabledFirst(sameChat) : enabledFirst(candidates);
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** 处理 POST /telegram/webhook/<secret>；幂等（重复回调 answerCallbackQuery 会失败但回复不重复写） */
export async function handleTelegramWebhook(
  repository: RelayRepository,
  post: (url: string, init: RequestInit) => Promise<void>,
  update: Record<string, unknown>,
  headerSecret: string | undefined
): Promise<TelegramWebhookResult> {
  const callbackQuery = update.callback_query && typeof update.callback_query === 'object' ? record(update.callback_query) : undefined;
  const message = callbackQuery ? record(callbackQuery.message) : record(update.message ?? update.edited_message);
  // 先取 chat.id：同一个 bot 可能配了多个频道，要用它选中正确的那个
  const incomingChat = String(record(message.chat).id ?? '');

  const resolved = await resolveChannel(repository, headerSecret, incomingChat);
  if (!resolved) return { statusCode: 401, body: { ok: false, error: 'invalid secret' } };
  const { channel, botToken, chatId } = resolved;
  // 群里任何成员都能发消息/点按钮；只认频道配置的那个 chat，避免陌生人替你回答
  if (chatId && incomingChat && incomingChat !== chatId) return ok;
  const send = (method: string, payload: unknown) => post(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  }).catch(() => undefined); // 回复已落库；Telegram 侧提示发不出去可接受

  if (callbackQuery) {
    const match = /^([0-9a-f-]{36}):(\d+)$/.exec(String(callbackQuery.data ?? ''));
    if (!match) return ok;
    const [, conversationId, index] = match;
    const conversation = await repository.getConversation(conversationId!);
    const option = (conversation?.options ?? [])[Number(index)];
    if (option === undefined) return ok;
    const accepted = await repository.replyConversation(conversationId!, option, 'telegram-callback');
    await send('answerCallbackQuery', { callback_query_id: String(callbackQuery.id), text: accepted ? `✅ 已回复：${option}` : '该问题已回复或已过期' });
    return ok;
  }

  const text = String(message.text ?? message.caption ?? '').trim().slice(0, 4000);
  if (!text) return ok;
  if (text.startsWith('/')) return ok; // /start 等 bot 命令不是给 Agent 的内容

  // 有等着的问题就当回复，否则进收件箱：人可以随时给 Agent 发消息，wait_for_inbox 取走
  const pending = await repository.findPendingConversationForChannel(channel.id);
  if (pending && await repository.replyConversation(pending.id, text, 'telegram-message')) {
    await send('sendMessage', { chat_id: incomingChat || chatId, text: `✅ 已回复：${text.slice(0, 200)}`, reply_to_message_id: message.message_id });
    return ok;
  }
  await repository.pushInboxMessage(text, `telegram:${channel.slug}`);
  await send('sendMessage', { chat_id: incomingChat || chatId, text: '📥 已收到，Agent 下次查看收件箱时读取。', reply_to_message_id: message.message_id });
  return ok;
}
