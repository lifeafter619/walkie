import type { NotificationInput } from '../shared/types.js';
import type { RelayRepository } from './database.js';
import type { NotificationService } from './notifications.js';

/**
 * 兼容端点用的 URL 过滤：只放行 http(s)。这些入口不走 notificationSchema，
 * 而 javascript:/data: 链接会在管理面板渲染成可点击 <a href>，等于存储型 XSS。
 */
export function safeCompatUrl(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return undefined;
  try {
    const protocol = new URL(raw).protocol;
    return protocol === 'https:' || protocol === 'http:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

export async function sendWithAgentKey(
  repository: RelayRepository,
  notifications: NotificationService,
  token: string,
  input: Omit<NotificationInput, 'destination'> & { destination?: string },
  source: string
) {
  const apiKey = await repository.authenticateKey(token);
  if (!apiKey) throw new Error('无效或已吊销的 Agent API Key');
  const destination = input.destination || (apiKey.destinationIds.length === 1 ? apiKey.destinationIds[0] : '');
  if (!destination) throw new Error('该 Agent Key 必须只配置一个目的地，或由协议参数指定目的地');
  return notifications.send({ ...input, destination }, source, apiKey);
}

/**
 * 把兼容端点的 priority 折算成 severity。
 *
 * 两套刻度不能共用一个阈值：Gotify 是 0–10（8 起算紧急），ntfy 是 1–5（5=max/urgent），
 * 且 ntfy 允许用 max/urgent/high/default/low/min 这些名字代替数字。按 Gotify 的阈值去读
 * ntfy，`Priority: 5` 只会得到 warning，而 `Priority: urgent` 因为 Number() 得到 NaN
 * 直接跌到 info——最高优先级反而拿到最低级别，静默时段里会被延后而不是穿透。
 */
const NTFY_NAMED: Record<string, number> = { max: 5, urgent: 5, high: 4, default: 3, low: 2, min: 1 };

export function prioritySeverity(priority: unknown, scale: 'gotify' | 'ntfy' = 'gotify'): NotificationInput['severity'] {
  if (scale === 'ntfy') {
    const level = NTFY_NAMED[String(priority ?? '').trim().toLowerCase()] ?? Number(priority);
    return level >= 5 ? 'critical' : level >= 4 ? 'warning' : 'info';
  }
  const value = Number(priority);
  return value >= 8 ? 'critical' : value >= 5 ? 'warning' : 'info';
}
