import type { AppConfig } from './config.js';
import type { RelayRepository } from './database.js';
import type { ProviderDispatcher } from './providers/dispatcher.js';
import type { Channel, Severity } from '../shared/types.js';

/** 返回静默结束时刻；不在静默期返回 undefined。quietHours 形如 "22:00-08:00"，服务器本地时间 */
export function quietUntil(quietHours: string | undefined, severity: Severity, at = new Date()): Date | undefined {
  if (!quietHours || severity === 'critical') return undefined;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(quietHours);
  if (!match) return undefined;
  const minutes = at.getHours() * 60 + at.getMinutes();
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  const inQuiet = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!inQuiet) return undefined;
  const release = new Date(at);
  release.setHours(Number(match[3]), Number(match[4]), 0, 0);
  if (release <= at) release.setDate(release.getDate() + 1);
  return release;
}

export class DeliveryWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  // ponytail: 内存滑动窗口限流，进程重启后窗口清零；需要跨进程精确限流时改为按 attempts 表统计
  private readonly sentAt = new Map<string, number[]>();

  constructor(
    private readonly repository: RelayRepository,
    private readonly dispatcher: ProviderDispatcher,
    private readonly config: Pick<AppConfig, 'deliveryWorkers' | 'maxDeliveryAttempts' | 'retryBaseMs'> & { maxSendsPerMin?: number }
  ) {}

  private throttled(channel: Channel): boolean {
    // ponytail: 全局与频道限流共用内存滑动窗口；跨进程精确限流需改为按 attempts 表统计
    const cutoff = Date.now() - 60_000;
    if (this.config.maxSendsPerMin) {
      const global = (this.sentAt.get('*') ?? []).filter((time) => time > cutoff);
      this.sentAt.set('*', global);
      if (global.length >= this.config.maxSendsPerMin) return true;
    }
    if (!channel.rateLimitPerMin) return false;
    const window = (this.sentAt.get(channel.id) ?? []).filter((time) => time > cutoff);
    this.sentAt.set(channel.id, window);
    return window.length >= channel.rateLimitPerMin;
  }

  private recordSend(channel: Channel): void {
    if (this.config.maxSendsPerMin) this.sentAt.set('*', [...(this.sentAt.get('*') ?? []), Date.now()]);
    if (channel.rateLimitPerMin) this.sentAt.set(channel.id, [...(this.sentAt.get(channel.id) ?? []), Date.now()]);
  }

  /** 投递到达终态且带 callbackUrl 时，POST 最终结果（只发一次，SSRF 校验同 webhook） */
  private async notifyCallback(deliveryId: string): Promise<void> {
    const delivery = await this.repository.getDelivery(deliveryId);
    const callbackUrl = delivery?.metadata.callbackUrl;
    if (!delivery || typeof callbackUrl !== 'string') return;
    if (!['delivered', 'partial', 'failed'].includes(delivery.status)) return;
    if (!(await this.repository.claimCallback(deliveryId))) return;
    try {
      await this.dispatcher.postCallback(callbackUrl, {
        deliveryId: delivery.id,
        status: delivery.status,
        title: delivery.title,
        severity: delivery.severity,
        attempts: (delivery.attempts ?? []).map((a) => ({
          channel: a.channelName ?? a.channelId, provider: a.provider, status: a.status,
          attemptCount: a.attemptCount, responseCode: a.responseCode, error: a.error
        }))
      });
    } catch (error) {
      console.error(JSON.stringify({ event: 'callback.failed', deliveryId, message: error instanceof Error ? error.message : String(error) }));
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drainOnce(), 750);
    void this.drainOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async drainOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const attempts = await this.repository.claimDueAttempts(this.config.deliveryWorkers);
      await Promise.all(attempts.map(async (attempt) => {
        const delivery = await this.repository.getDelivery(attempt.deliveryId);
        const channel = await this.repository.getChannel(attempt.channelId);
        if (!delivery || !channel) {
          await this.repository.completeAttempt(attempt.id, { success: false, error: '投递或频道已不存在' });
          return;
        }
        try {
          const quiet = quietUntil(channel.quietHours, delivery.severity);
          if (quiet) {
            await this.repository.deferAttempt(attempt.id, quiet.toISOString());
            return;
          }
          if (this.throttled(channel)) {
            await this.repository.deferAttempt(attempt.id, new Date(Date.now() + 15_000).toISOString());
            return;
          }
          if (channel.rateLimitPerMin || this.config.maxSendsPerMin) this.recordSend(channel);
          const result = await this.dispatcher.send(channel.provider, await this.repository.getChannelConfig(channel.id), {
            title: delivery.title,
            body: delivery.body,
            severity: delivery.severity,
            url: delivery.url,
            metadata: { ...delivery.metadata, ...(delivery.idempotencyKey ? { idempotencyKey: delivery.idempotencyKey } : {}) }
          });
          await this.repository.completeAttempt(attempt.id, { success: true, responseCode: result.responseCode });
          const route = delivery.targetType === 'route' ? await this.repository.getRoute(delivery.targetId) : undefined;
          if (route?.strategy === 'fallback') await this.repository.skipAttempts(delivery.id, attempt.id);
          await this.notifyCallback(delivery.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const retryAt = attempt.attemptCount < this.config.maxDeliveryAttempts
            ? new Date(Date.now() + this.config.retryBaseMs * 2 ** (attempt.attemptCount - 1)).toISOString()
            : undefined;
          const responseCode = /^HTTP (\d+)/.exec(message)?.[1];
          await this.repository.completeAttempt(attempt.id, {
            success: false,
            error: message.slice(0, 1000),
            responseCode: responseCode ? Number(responseCode) : undefined,
            retryAt
          });
          await this.notifyCallback(delivery.id);
        }
      }));
      return attempts.length;
    } finally {
      this.running = false;
    }
  }
}
