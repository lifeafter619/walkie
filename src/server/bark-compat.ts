import type { ApiKey, NotificationInput } from '../shared/types.js';
import type { RelayRepository } from './database.js';
import type { NotificationService } from './notifications.js';
import { safeTokenEqual } from './crypto.js';

export type BarkParams = Record<string, unknown>;

const BARK_METADATA_FIELDS = [
  'subtitle', 'badge', 'call', 'autoCopy', 'copy', 'sound', 'icon', 'image', 'group',
  'ciphertext', 'isArchive', 'ttl', 'action', 'id', 'delete', 'level', 'volume'
] as const;

const stringValue = (params: BarkParams, key: string): string => {
  const value = params[key];
  return value === undefined || value === null ? '' : String(value);
};

const nonEmpty = (value: string) => value.trim();

export function barkSuccess(data?: unknown) {
  return { code: 200, message: 'success', ...(data === undefined ? {} : { data }), timestamp: Math.floor(Date.now() / 1000) };
}

export function barkFailure(code: number, message: string) {
  return { code, message, timestamp: Math.floor(Date.now() / 1000) };
}

function metadata(params: BarkParams): Record<string, unknown> {
  return Object.fromEntries(BARK_METADATA_FIELDS
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .map((key) => [key, params[key]]));
}

function severity(level: string): NotificationInput['severity'] {
  if (level === 'critical') return 'critical';
  if (level === 'timeSensitive') return 'warning';
  return 'info';
}

export function barkNotification(params: BarkParams, deviceKey: string): NotificationInput {
  const title = nonEmpty(stringValue(params, 'title')) || 'Walkie';
  const body = nonEmpty(stringValue(params, 'markdown')) || nonEmpty(stringValue(params, 'body')) || 'Empty Message';
  const level = stringValue(params, 'level');
  // 与 notificationSchema.url 同一条规则：javascript:/data: scheme 会在管理面板渲染成可点击链接，必须拒绝
  const rawUrl = nonEmpty(stringValue(params, 'url'));
  let url: string | undefined;
  if (rawUrl) {
    try {
      const protocol = new URL(rawUrl).protocol;
      if (protocol === 'https:' || protocol === 'http:') url = rawUrl;
    } catch { /* 无效 URL 按未提供处理 */ }
  }
  return {
    destination: deviceKey,
    title: title.slice(0, 200),
    body: body.slice(0, 20_000),
    severity: severity(level),
    ...(url ? { url: url.slice(0, 2000) } : {}),
    metadata: { via: 'bark-compat', bark: metadata(params) }
  };
}

export function barkDeviceKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(nonEmpty).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(nonEmpty).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  throw new Error('device_keys 类型无效');
}

/** Resolve a Bark key to a configured Bark channel, or to an Agent Key with one destination. */
export async function resolveBarkDestination(repository: RelayRepository, key: string): Promise<{ destination: string; apiKey?: ApiKey }> {
  const apiKey = await repository.authenticateKey(key);
  if (apiKey) {
    if (apiKey.destinationIds.length !== 1) throw new Error('Bark Agent Key 必须只配置一个目的地');
    return { destination: apiKey.destinationIds[0]!, apiKey };
  }

  for (const channel of await repository.listChannels()) {
    if (!channel.enabled || channel.provider !== 'bark') continue;
    const config = await repository.getChannelConfig(channel.id);
    // deviceKey 就是这个端点的凭据（拿到即可向该频道推送），比较走定长哈希，别用 === 泄漏前缀
    if (safeTokenEqual(key, String(config.deviceKey ?? ''))) return { destination: channel.id };
  }
  throw new Error('device key 不存在或未绑定 Bark 频道');
}

export async function sendBark(
  notifications: NotificationService,
  repository: RelayRepository,
  params: BarkParams,
  source = 'bark-compat'
): Promise<{ deliveries: string[]; keys: string[] }> {
  const keys = barkDeviceKeys(params.device_keys);
  const single = nonEmpty(stringValue(params, 'device_key'));
  const targets = keys.length ? keys : single ? [single] : [];
  if (!targets.length) throw new Error('device key 不能为空');
  const deliveries: string[] = [];
  for (const key of targets) {
    const resolved = await resolveBarkDestination(repository, key);
    const delivery = await notifications.send(barkNotification(params, resolved.destination), source, resolved.apiKey);
    deliveries.push(delivery.id);
  }
  return { deliveries, keys: targets };
}

export function registerResponse(deviceKey: string, deviceToken: string) {
  return barkSuccess({ key: deviceKey, device_key: deviceKey, device_token: deviceToken });
}
