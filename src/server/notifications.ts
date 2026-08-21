import type { ApiKey, Conversation, Delivery, Destination, NotificationInput, Severity } from '../shared/types.js';
import type { RelayRepository } from './database.js';

export class NotificationService {
  constructor(private readonly repository: RelayRepository, private readonly onQueued?: (delivery: Delivery) => void) {}

  /** 解析目的地与可用频道；目的地不可用、Key 无权限或无可用频道时抛错（send 与 ask 共用） */
  private async resolveTarget(destinationRef: string, apiKey?: ApiKey): Promise<{ destination: Destination; channelIds: string[] }> {
    const destination = (await this.repository.listDestinations()).find((item) => item.id === destinationRef || item.slug === destinationRef);
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
    // 路由允许存重复频道 ID；attempts 有 UNIQUE(delivery_id, channel_id)，不去重会让整个投递创建失败
    channelIds = [...new Set(channelIds)];
    if (!channelIds.length) throw new Error('目的地没有可用频道');
    return { destination, channelIds };
  }

  async send(input: NotificationInput, source: string, apiKey?: ApiKey, options: { bypassLimits?: boolean } = {}): Promise<Delivery> {
    if (apiKey && !apiKey.scopes.includes('notifications:send')) throw new Error('API Key 缺少 notifications:send 权限');
    if (!options.bypassLimits) {
      await this.repository.assertPlatformDeliveryEnabled();
      await this.repository.assertWithinUsageLimits();
    }
    const { destination, channelIds } = await this.resolveTarget(input.destination, apiKey);

    const firstAt = input.sendAt
      ? new Date(input.sendAt).toISOString()
      : input.delaySeconds
        ? new Date(Date.now() + input.delaySeconds * 1000).toISOString()
        : new Date().toISOString();
    const repeat = input.repeatEverySeconds;
    const scheduleId = repeat ? crypto.randomUUID() : undefined;
    if (repeat) {
      const remainingRuns = input.repeatCount === undefined ? undefined : Math.max(0, input.repeatCount - 1);
      await this.repository.createSchedule({
        id: scheduleId,
        targetType: destination.kind,
        targetId: destination.id,
        title: input.title.trim(),
        body: input.body.trim(),
        severity: (input.severity ?? 'info') as Severity,
        url: input.url,
        metadata: { ...input.metadata, ...(input.tags ? { tags: input.tags } : {}), ...(input.short ? { short: input.short } : {}), ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}) },
        source,
        intervalSeconds: repeat,
        nextRunAt: new Date(new Date(firstAt).getTime() + repeat * 1000).toISOString(),
        remainingRuns
      });
    }
    let delivery: Delivery;
    try {
      delivery = await this.repository.createDelivery({
      targetType: destination.kind,
      targetId: destination.id,
      title: input.title.trim(),
      body: input.body.trim(),
      severity: (input.severity ?? 'info') as Severity,
      url: input.url,
      metadata: { ...input.metadata, ...(input.tags ? { tags: input.tags } : {}), ...(input.short ? { short: input.short } : {}), ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}) },
      source,
      idempotencyKey: input.idempotencyKey,
      channelIds,
      scheduledAt: firstAt,
      scheduleId
      });
    } catch (error) {
      if (scheduleId) await this.repository.cancelSchedule(scheduleId, 'scheduler');
      throw error;
    }
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
    // 先校验目的地/权限/可用频道再建会话，避免 send 注定失败却留下永远无人回复的孤儿会话
    if (!apiKey.scopes.includes('notifications:send')) throw new Error('API Key 缺少 notifications:send 权限');
    await this.resolveTarget(input.destination, apiKey);

    const timeoutSeconds = Math.min(Math.max(input.timeoutSeconds ?? 3600, 30), 86_400);
    const { conversation, replyToken } = await this.repository.createConversation({ apiKeyId: apiKey.id, question: input.question, options: input.options, timeoutSeconds });
    const replyUrl = `${publicUrl.replace(/\/$/, '')}/reply/${conversation.id}/${replyToken}`;
    const delivery = await this.send({
      destination: input.destination,
      title: input.title ?? '❓ Agent 等待回复',
      body: `${input.question}${input.options?.length ? `\n\n选项：${input.options.join(' / ')}` : ''}\n\n打开链接回复（${Math.round(timeoutSeconds / 60)} 分钟内有效）：\n${replyUrl}`,
      severity: input.severity ?? 'warning',
      url: replyUrl,
      // askOptions + conversationId：telegram/discord-bot 等渠道据此渲染内联按钮（点按即回）
      metadata: { via: 'ask_user', conversationId: conversation.id, ...(input.options?.length ? { askOptions: input.options } : {}) }
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
