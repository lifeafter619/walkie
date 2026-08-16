import type { Channel, ProviderId } from '../shared/types.js';
import type { RelayRepository } from './database.js';
import { PROVIDER_MAP, validateProviderConfig } from './providers/catalog.js';

/** 创建频道校验：provider 存在 + 必填字段（admin REST 与 MCP create_channel 共用） */
export function validateChannelCreate(provider: unknown, config: Record<string, unknown>): string[] {
  if (!PROVIDER_MAP.has(provider as ProviderId)) return ['不支持的渠道类型'];
  return validateProviderConfig(provider as ProviderId, config);
}

/**
 * 更新频道校验：换 provider/改 config 时合并当前配置后重校验必填字段。
 * 返回解析出的当前频道（slug 入参也能解析），供调用方写回真实 id。
 */
export async function validateChannelUpdate(repository: RelayRepository, id: string, input: { provider?: unknown; config?: Record<string, unknown> }): Promise<{ current?: Channel; errors: string[] }> {
  const current = await repository.getChannel(id);
  if (!current) return { errors: ['频道不存在'] };
  if (!input.config && !input.provider) return { current, errors: [] };
  const providerToCheck = (input.provider ?? current.provider) as ProviderId;
  if (!PROVIDER_MAP.has(providerToCheck)) return { current, errors: ['不支持的渠道类型'] };
  const merged = { ...await repository.getChannelConfig(current.id), ...(input.config ?? {}) };
  return { current, errors: validateProviderConfig(providerToCheck, merged) };
}

/** 路由引用频道校验（admin REST 与 MCP create_route/update_route 共用） */
export async function validateRouteChannelIds(repository: RelayRepository, channelIds: string[]): Promise<string[]> {
  const channels = new Set((await repository.listChannels()).map((channel) => channel.id));
  return channelIds.some((id) => !channels.has(id)) ? ['路由包含不存在的频道'] : [];
}

/** Key 目的地白名单校验（admin REST create/patch key 共用），未知 ID 全部列出 */
export async function assertKeyDestinations(repository: RelayRepository, destinationIds: string[]): Promise<string[]> {
  if (!destinationIds.length) return [];
  const destinations = new Set((await repository.listDestinations()).map((destination) => destination.id));
  const unknown = destinationIds.filter((id) => !destinations.has(id));
  return unknown.length ? [`目的地不存在：${unknown.join('、')}`] : [];
}
