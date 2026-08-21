import type { AppConfig } from './config.js';
import type { RelayRepository } from './database.js';
import type { ProviderDispatcher } from './providers/dispatcher.js';
import type { Channel, DeliveryAttempt, Severity } from '../shared/types.js';

/** idle gating 阈值下延后投递的"手机推送类"渠道；桌面（webpush）与聊天渠道不拦 */
const MOBILE_PUSH_PROVIDERS: ReadonlySet<string> = new Set([
  'bark', 'ntfy', 'gotify', 'pushover', 'pushbullet', 'pushdeer', 'chanify', 'pushme',
  'xizhi', 'qmsg', 'serverchan', 'pushplus', 'wxpusher', 'pushsafer', 'simplepush',
  'pushy', 'fcm', 'expo', 'onesignal', 'pusher-beams', 'pushpad', 'join',
  'huawei-push', 'xiaomi-push', 'oppo-push', 'vivo-push', 'meizu-push', 'honor-push', 'jpush', 'getui'
]);

/** 返回静默结束时刻；不在静默期返回 undefined。quietHours 形如 "22:00-08:00"（服务器本地时间）
 *  或 "22:00-08:00@Asia/Shanghai"（显式 IANA 时区；Cloudflare Workers 本地时间恒为 UTC，务必带时区） */
export function quietUntil(quietHours: string | undefined, severity: Severity, at = new Date()): Date | undefined {
  if (!quietHours || severity === 'critical') return undefined;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})(?:@(.+))?$/.exec(quietHours);
  if (!match) return undefined;
  let minutes: number;
  if (match[5]) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: match[5], hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
      const [hour, minute] = parts.split(':').map(Number);
      minutes = hour * 60 + minute;
    } catch {
      return undefined; // 非法时区名，视为无静默期
    }
  } else {
    minutes = at.getHours() * 60 + at.getMinutes();
  }
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  const inQuiet = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!inQuiet) return undefined;
  const untilEnd = (end - minutes + 1440) % 1440;
  const release = new Date(at);
  release.setSeconds(0, 0);
  return new Date(release.getTime() + untilEnd * 60_000);
}

export class DeliveryWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<number> | undefined;
  /** 上轮 drain 发现 schedule 因平台暂停/用量限制滞留到期；Workers alarm 用它决定退避间隔 */
  scheduleBlocked = false;
  /** drain 在途期间又有触发进来（新投递入队）：结束后补一轮，避免 Vercel 上等 cron */
  private rerun = false;
  // ponytail: 内存滑动窗口限流，进程重启后窗口清零；需要跨进程精确限流时改为按 attempts 表统计
  private readonly sentAt = new Map<string, number[]>();

  constructor(
    private readonly repository: RelayRepository,
    private readonly dispatcher: ProviderDispatcher,
    private readonly config: Pick<AppConfig, 'deliveryWorkers' | 'maxDeliveryAttempts' | 'retryBaseMs'> & { maxSendsPerMin?: number }
  ) {}

  private throttled(channel: Channel): boolean {
    // ponytail: 全局与频道限流共用内存滑动窗口；跨进程精确限流需改为按 attempts 表统计
    // 同时修剪已删除频道的残留窗口，避免 Map 缓慢增长
    if (this.sentAt.size > 512) {
      const cutoff = Date.now() - 60_000;
      for (const [key, stamps] of this.sentAt) {
        if (stamps.every((time) => time <= cutoff)) this.sentAt.delete(key);
      }
    }
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
    const cutoff = Date.now() - 60_000;
    if (this.config.maxSendsPerMin) this.sentAt.set('*', [...(this.sentAt.get('*') ?? []).filter((t) => t > cutoff), Date.now()]);
    if (channel.rateLimitPerMin) this.sentAt.set(channel.id, [...(this.sentAt.get(channel.id) ?? []).filter((t) => t > cutoff), Date.now()]);
  }

  /** 投递到达终态且带 callbackUrl 时，POST 最终结果（只发一次，SSRF 校验同 webhook） */
  private async notifyCallback(deliveryId: string): Promise<void> {
    try {
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
        await this.repository.completeCallback(deliveryId, true);
      } catch (error) {
        await this.repository.completeCallback(deliveryId, false);
        throw error;
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'callback.failed', deliveryId, message: error instanceof Error ? error.message : String(error) }));
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.drainOnce().catch(() => undefined); }, 750);
    void this.drainOnce().catch(() => undefined);
  }

  /** 停止调度并等待在途 drain 完成（尽力而为）；返回的 promise 供优雅关停 await */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.running) await this.running.catch(() => undefined);
  }

  async drainOnce(): Promise<number> {
    if (this.running) {
      // drain 在途时不丢触发：置 rerun 标记，在途 drain 结束后自动补一轮。
      // Vercel 没有常驻定时器，错过这次触发就要等下一个请求或 10 分钟 cron
      this.rerun = true;
      return 0;
    }
    const run = (async () => {
      let claimed = 0;
      do {
        this.rerun = false;
        claimed += await this.drain();
      } while (this.rerun);
      return claimed;
    })();
    this.running = run;
    try {
      return await run;
    } finally {
      this.running = undefined;
    }
  }

  /** 排空当前所有已到期尝试；Serverless 入口没有常驻 timer，需要显式使用此方法。 */
  async drainAll(): Promise<number> {
    let total = 0;
    for (;;) {
      const processed = await this.drainOnce();
      total += processed;
      if (!processed) return total;
    }
  }

  private async drain(): Promise<number> {
    const { blocked } = await this.repository.materializeDueSchedules();
    // 有 schedule 因平台暂停/用量限制滞留到期：记录状态，Workers alarm 用它退避而不是 250ms 空转
    this.scheduleBlocked = blocked;
    const attempts = await this.repository.claimDueAttempts(this.config.deliveryWorkers, this.config.maxDeliveryAttempts);
    await Promise.all(attempts.map((attempt) => this.processAttempt(attempt)));
    // 旁路终态（禁用频道、滞留回收等）不经过 processAttempt，这里补扫漏发的终态回调；
    // notifyCallback 内部吞错，不会让 drain 整体失败
    for (const deliveryId of await this.repository.listPendingCallbacks()) {
      await this.notifyCallback(deliveryId);
    }
    return attempts.length;
  }

  /** 单个 attempt 的完整处理；任何异常在此兜底，绝不让 drainOnce 整体失败（浮动 promise 会击穿进程） */
  private async processAttempt(attempt: DeliveryAttempt): Promise<void> {
    try {
      const delivery = await this.repository.getDelivery(attempt.deliveryId);
      const channel = await this.repository.getChannel(attempt.channelId);
      if (!delivery || !channel) {
        await this.repository.completeAttempt(attempt.id, { success: false, error: '投递或频道已不存在' });
        return;
      }
      // 频道级重试上限：0 = 继承全局 MAX_DELIVERY_ATTEMPTS。
      // 超限仍被 claim 只会发生在滞留回收场景（reclaim 按全局值判可重试），直接终判不再发送
      const maxAttempts = channel.maxAttempts || this.config.maxDeliveryAttempts;
      if (attempt.attemptCount > maxAttempts) {
        await this.repository.completeAttempt(attempt.id, { success: false, error: '已达频道最大尝试次数' });
        await this.notifyCallback(delivery.id);
        return;
      }
      let outcome: 'sent' | undefined;
      try {
        const quiet = quietUntil(channel.quietHours, delivery.severity);
        if (quiet) {
          await this.repository.deferAttempt(attempt.id, quiet.toISOString());
          return;
        }
        // idle gating（#13）：Agent 报告人在键盘前（idle < 120s）时，手机推送类渠道延后，
        // 桌面（webpush）与 critical 照发。上报 5 分钟后过期，不会永久卡住通知
        const idle = await this.repository.getIdleReport();
        if (idle && idle.seconds < 120 && delivery.severity !== 'critical' && MOBILE_PUSH_PROVIDERS.has(channel.provider)) {
          await this.repository.deferAttempt(attempt.id, new Date(Date.now() + 5 * 60_000).toISOString());
          return;
        }
        if (this.throttled(channel)) {
          // 持续被限流时消耗尝试次数（consumeAttempt=true），避免无限 defer 循环；达到上限则失败
          if (attempt.attemptCount >= maxAttempts) {
            await this.repository.completeAttempt(attempt.id, { success: false, error: '频道持续限流，已达最大尝试次数' });
            await this.notifyCallback(delivery.id);
          } else {
            await this.repository.deferAttempt(attempt.id, new Date(Date.now() + 15_000).toISOString(), true);
          }
          return;
        }
        if (channel.rateLimitPerMin || this.config.maxSendsPerMin) this.recordSend(channel);
        const result = await this.dispatcher.send(channel.provider, await this.repository.getChannelConfig(channel.id), {
          title: delivery.title,
          body: delivery.body,
          severity: delivery.severity,
          url: delivery.url,
          metadata: {
            ...delivery.metadata,
            ...(delivery.idempotencyKey ? { idempotencyKey: delivery.idempotencyKey } : {}),
            ...(channel.provider === 'walkie' ? { walkieDeliveryId: delivery.id } : {})
          }
        });
        // 发送结果一旦确定立即提交；后续记账失败也不得把已送达改写回重试中（会造成重复推送）
        await this.repository.completeAttempt(attempt.id, { success: true, responseCode: result.responseCode });
        outcome = 'sent';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryAt = attempt.attemptCount < maxAttempts
          ? new Date(Date.now() + this.config.retryBaseMs * 2 ** (attempt.attemptCount - 1)).toISOString()
          : undefined;
        const responseCode = /^HTTP (\d+)/.exec(message)?.[1];
        await this.repository.completeAttempt(attempt.id, {
          success: false,
          error: message.slice(0, 1000),
          responseCode: responseCode ? Number(responseCode) : undefined,
          retryAt
        });
      }
      // 终态记账单独兜底：route 推进与回调通知的失败不影响投递结果本身
      try {
        if (outcome === 'sent') {
          const deliveryAfter = await this.repository.getDelivery(attempt.deliveryId);
          const route = deliveryAfter?.targetType === 'route' ? await this.repository.getRoute(deliveryAfter.targetId) : undefined;
          if (route?.strategy === 'fallback') await this.repository.skipAttempts(attempt.deliveryId, attempt.id);
        }
        await this.notifyCallback(attempt.deliveryId);
      } catch (error) {
        console.error(JSON.stringify({ event: 'attempt.postprocess.failed', attemptId: attempt.id, message: error instanceof Error ? error.message : String(error) }));
      }
    } catch (error) {
      // 最外层兜底：DB 异常等让本次 attempt 保持 sending，5 分钟后由 reclaimStuckSending 回收重试
      console.error(JSON.stringify({ event: 'attempt.crashed', attemptId: attempt.id, message: error instanceof Error ? error.message : String(error) }));
    }
  }
}
