import type { ApiKey, Conversation, Delivery, NotificationInput, Severity } from '../shared/types.js';
import type { RelayRepository } from './database.js';

export class NotificationService {
  constructor(private readonly repository: RelayRepository, private readonly onQueued?: (delivery: Delivery) => void) {}

  async send(input: NotificationInput, source: string, apiKey?: ApiKey): Promise<Delivery> {
    if (apiKey && !apiKey.scopes.includes('notifications:send')) throw new Error('API Key 缺少 notifications:send 权限');
    const destination = (await this.repository.listDestinations()).find((item) => item.id === input.destination || item.slug === input.destination);
    if (!destination || !destination.enabled) throw new Error('目的地不存在或已禁用');
    if (apiKey?.destinationIds.length && !apiKey.destinationIds.includes(destination.id)) throw new Error('API Key 无权访问该目的地');

    let channelIds: string[];
    if (destination.kind === 'channel') {
      channelIds = [destination.id];
    } else {
      const route = (await this.repository.getRoute(destination.id))!;
      const enabled = new Set((await this.repository.listChannels()).filter((channel) => channel.enabled).map((channel) => channel.id));
      channelIds = route.channelIds.filter((channelId) => enabled.has(channelId));
    }
    if (!channelIds.length) throw new Error('目的地没有可用频道');

    const delivery = await this.repository.createDelivery({
      targetType: destination.kind,
      targetId: destination.id,
      title: input.title.trim(),
      body: input.body.trim(),
      severity: (input.severity ?? 'info') as Severity,
      url: input.url,
      metadata: { ...input.metadata, ...(input.tags ? { tags: input.tags } : {}), ...(input.short ? { short: input.short } : {}), ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}) },
      source,
      idempotencyKey: input.idempotencyKey,
      channelIds
    });
    this.onQueued?.(delivery);
    return delivery;
  }

  async listDestinations(apiKey?: ApiKey) {
    return (await this.repository.listDestinations()).filter((destination) =>
      destination.enabled && (!apiKey?.destinationIds.length || apiKey.destinationIds.includes(destination.id))
    );
  }

  async getDelivery(id: string, apiKey?: ApiKey): Promise<Delivery> {
    if (apiKey && !apiKey.scopes.includes('deliveries:read')) throw new Error('API Key 缺少 deliveries:read 权限');
    const delivery = await this.repository.getDelivery(id);
    if (!delivery) throw new Error('投递不存在');
    if (apiKey?.destinationIds.length && !apiKey.destinationIds.includes(delivery.targetId)) throw new Error('API Key 无权访问该投递');
    return delivery;
  }

  /** 双向确认：创建会话并把问题+回复链接推送出去 */
  async ask(
    input: { destination: string; question: string; options?: string[]; title?: string; severity?: Severity; timeoutSeconds?: number },
    source: string,
    apiKey: ApiKey,
    publicUrl: string
  ): Promise<{ conversation: Conversation; replyUrl: string; deliveryId: string }> {
    const timeoutSeconds = Math.min(Math.max(input.timeoutSeconds ?? 3600, 30), 86_400);
    const { conversation, replyToken } = await this.repository.createConversation({ apiKeyId: apiKey.id, question: input.question, options: input.options, timeoutSeconds });
    const replyUrl = `${publicUrl.replace(/\/$/, '')}/reply/${conversation.id}/${replyToken}`;
    const delivery = await this.send({
      destination: input.destination,
      title: input.title ?? '❓ Agent 等待回复',
      body: `${input.question}${input.options?.length ? `\n\n选项：${input.options.join(' / ')}` : ''}\n\n打开链接回复（${Math.round(timeoutSeconds / 60)} 分钟内有效）：\n${replyUrl}`,
      severity: input.severity ?? 'warning',
      url: replyUrl,
      metadata: { via: 'ask_user', conversationId: conversation.id }
    }, source, apiKey);
    await this.repository.attachConversationDelivery(conversation.id, delivery.id);
    return { conversation, replyUrl, deliveryId: delivery.id };
  }

  /** Agent 查询自己的会话；未回复返回 pending，过期返回 expired */
  async conversationStatus(id: string, apiKey: ApiKey): Promise<{ status: 'pending' | 'replied' | 'expired'; conversation: Conversation }> {
    const conversation = await this.repository.getConversation(id);
    if (!conversation || conversation.apiKeyId !== apiKey.id) throw new Error('会话不存在');
    const status = conversation.repliedAt ? 'replied' : conversation.expiresAt <= new Date().toISOString() ? 'expired' : 'pending';
    return { status, conversation };
  }
}
