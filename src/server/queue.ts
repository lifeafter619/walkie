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
  private timer?: NodeJS.Timeout;
  private running = false;
  // ponytail: 内存滑动窗口限流，进程重启后窗口清零；需要跨进程精确限流时改为按 attempts 表统计
  private readonly sentAt = new Map<string, number[]>();

  constructor(
    private readonly repository: RelayRepository,
    private readonly dispatcher: ProviderDispatcher,
    private readonly config: Pick<AppConfig, 'deliveryWorkers' | 'maxDeliveryAttempts' | 'retryBaseMs'>
  ) {}

  private throttled(channel: Channel): boolean {
    if (!channel.rateLimitPerMin) return false;
    const cutoff = Date.now() - 60_000;
    const window = (this.sentAt.get(channel.id) ?? []).filter((time) => time > cutoff);
    this.sentAt.set(channel.id, window);
    return window.length >= channel.rateLimitPerMin;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drainOnce(), 750);
    this.timer.unref();
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
      const attempts = this.repository.claimDueAttempts(this.config.deliveryWorkers);
      await Promise.all(attempts.map(async (attempt) => {
        const delivery = this.repository.getDelivery(attempt.deliveryId);
        const channel = this.repository.getChannel(attempt.channelId);
        if (!delivery || !channel) {
          this.repository.completeAttempt(attempt.id, { success: false, error: '投递或频道已不存在' });
          return;
        }
        try {
          const quiet = quietUntil(channel.quietHours, delivery.severity);
          if (quiet) {
            this.repository.deferAttempt(attempt.id, quiet.toISOString());
            return;
          }
          if (this.throttled(channel)) {
            this.repository.deferAttempt(attempt.id, new Date(Date.now() + 15_000).toISOString());
            return;
          }
          if (channel.rateLimitPerMin) this.sentAt.set(channel.id, [...(this.sentAt.get(channel.id) ?? []), Date.now()]);
          const result = await this.dispatcher.send(channel.provider, this.repository.getChannelConfig(channel.id), {
            title: delivery.title,
            body: delivery.body,
            severity: delivery.severity,
            url: delivery.url,
            metadata: delivery.metadata
          });
          this.repository.completeAttempt(attempt.id, { success: true, responseCode: result.responseCode });
          const route = delivery.targetType === 'route' ? this.repository.getRoute(delivery.targetId) : undefined;
          if (route?.strategy === 'fallback') this.repository.skipAttempts(delivery.id, attempt.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const retryAt = attempt.attemptCount < this.config.maxDeliveryAttempts
            ? new Date(Date.now() + this.config.retryBaseMs * 2 ** (attempt.attemptCount - 1)).toISOString()
            : undefined;
          const responseCode = /^HTTP (\d+)/.exec(message)?.[1];
          this.repository.completeAttempt(attempt.id, {
            success: false,
            error: message.slice(0, 1000),
            responseCode: responseCode ? Number(responseCode) : undefined,
            retryAt
          });
        }
      }));
      return attempts.length;
    } finally {
      this.running = false;
    }
  }
}
