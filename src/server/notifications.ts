import type { ApiKey, Delivery, NotificationInput, Severity } from '../shared/types.js';
import type { RelayRepository } from './database.js';

export class NotificationService {
  constructor(private readonly repository: RelayRepository) {}

  send(input: NotificationInput, source: string, apiKey?: ApiKey): Delivery {
    if (apiKey && !apiKey.scopes.includes('notifications:send')) throw new Error('API Key 缺少 notifications:send 权限');
    const destination = this.repository.listDestinations().find((item) => item.id === input.destination || item.slug === input.destination);
    if (!destination || !destination.enabled) throw new Error('目的地不存在或已禁用');
    if (apiKey?.destinationIds.length && !apiKey.destinationIds.includes(destination.id)) throw new Error('API Key 无权访问该目的地');

    let channelIds: string[];
    if (destination.kind === 'channel') {
      channelIds = [destination.id];
    } else {
      const route = this.repository.getRoute(destination.id)!;
      const enabled = new Set(this.repository.listChannels().filter((channel) => channel.enabled).map((channel) => channel.id));
      channelIds = route.channelIds.filter((channelId) => enabled.has(channelId));
    }
    if (!channelIds.length) throw new Error('目的地没有可用频道');

    return this.repository.createDelivery({
      targetType: destination.kind,
      targetId: destination.id,
      title: input.title.trim(),
      body: input.body.trim(),
      severity: (input.severity ?? 'info') as Severity,
      url: input.url,
      metadata: { ...input.metadata, ...(input.tags ? { tags: input.tags } : {}), ...(input.short ? { short: input.short } : {}) },
      source,
      idempotencyKey: input.idempotencyKey,
      channelIds
    });
  }

  listDestinations(apiKey?: ApiKey) {
    return this.repository.listDestinations().filter((destination) =>
      destination.enabled && (!apiKey?.destinationIds.length || apiKey.destinationIds.includes(destination.id))
    );
  }

  getDelivery(id: string, apiKey?: ApiKey): Delivery {
    if (apiKey && !apiKey.scopes.includes('deliveries:read')) throw new Error('API Key 缺少 deliveries:read 权限');
    const delivery = this.repository.getDelivery(id);
    if (!delivery) throw new Error('投递不存在');
    if (apiKey?.destinationIds.length && !apiKey.destinationIds.includes(delivery.targetId)) throw new Error('API Key 无权访问该投递');
    return delivery;
  }
}
