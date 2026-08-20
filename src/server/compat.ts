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

export function prioritySeverity(priority: unknown, scale: 'gotify' | 'ntfy' | 'pushover' = 'gotify'): NotificationInput['severity'] {
  if (scale === 'ntfy') {
    const level = NTFY_NAMED[String(priority ?? '').trim().toLowerCase()] ?? Number(priority);
    return level >= 5 ? 'critical' : level >= 4 ? 'warning' : 'info';
  }
  if (scale === 'pushover') {
    // Pushover 的刻度是 -2..2（2=emergency 需要确认，1=high，0=正常，-1/-2=安静时段降级），
    // 与 Gotify 的 0–10 完全不兼容：按 Gotify 阈值读 Pushover，priority=2 只会得到 info
    const value = Number(priority);
    return value >= 2 ? 'critical' : value >= 1 ? 'warning' : 'info';
  }
  const value = Number(priority);
  return value >= 8 ? 'critical' : value >= 5 ? 'warning' : 'info';
}

/** Apprise 的 type 取值 info|success|warning|failure，直接映射 severity */
export function appriseSeverity(type: unknown): NotificationInput['severity'] {
  switch (String(type ?? '').trim().toLowerCase()) {
    case 'success': return 'success';
    case 'warning': return 'warning';
    case 'failure': return 'critical';
    default: return 'info';
  }
}

/**
 * 把 Slack blocks/attachments 降级提取成纯文本。只有 text 字段是可靠来源；
 * mrkdwn 的 <URL|text> 还原成 text (URL)。
 */
export function slackText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text) parts.push(text);
  const collectBlocks = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      for (const field of [record.text, record.fields]) {
        const texts = field && typeof field === 'object' && 'text' in (field as Record<string, unknown>)
          ? [(field as Record<string, unknown>).text]
          : Array.isArray(field)
            ? field.map((item) => (item && typeof item === 'object' && 'text' in (item as Record<string, unknown>) ? (item as Record<string, unknown>).text : undefined))
            : [];
        for (const value of texts) if (typeof value === 'string' && value.trim()) parts.push(value.trim());
      }
      if (Array.isArray(record.elements)) {
        for (const element of record.elements) {
          if (!element || typeof element !== 'object') continue;
          const elementText = (element as Record<string, unknown>).text;
          if (typeof elementText === 'string' && elementText.trim()) parts.push(elementText.trim());
        }
      }
    }
  };
  collectBlocks(payload.blocks);
  if (Array.isArray(payload.attachments)) {
    for (const attachment of payload.attachments) {
      if (!attachment || typeof attachment !== 'object') continue;
      const record = attachment as Record<string, unknown>;
      for (const value of [record.title, record.text, record.pretext, record.fallback]) {
        if (typeof value === 'string' && value.trim()) parts.push(value.trim());
      }
      collectBlocks(record.blocks);
    }
  }
  return parts.map((part) => part.replace(/<([^|>]+)\|([^>]+)>/g, '$2 ($1)').replace(/[<>]/g, '')).join('\n').trim();
}

/**
 * Discord embeds 补充文本：title + description (+ fields value)。content 之外的
 * 信息不该丢，但也没必要逐字段罗列——拼成补充段。
 */
export function discordText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(payload.embeds)) {
    for (const embed of payload.embeds) {
      if (!embed || typeof embed !== 'object') continue;
      const record = embed as Record<string, unknown>;
      for (const value of [record.title, record.description]) {
        if (typeof value === 'string' && value.trim()) parts.push(value.trim());
      }
 if (Array.isArray(record.fields)) {
        for (const field of record.fields) {
          if (field && typeof field === 'object' && typeof (field as Record<string, unknown>).value === 'string') {
            parts.push(String((field as Record<string, unknown>).value));
          }
        }
      }
    }
  }
  return parts.join('\n').trim();
}

export interface AlertmanagerAlert {
  severity: NotificationInput['severity'];
  title: string;
  body: string;
  url?: string;
  fingerprint: string;
  status: string;
}

/**
 * Alertmanager / Grafana 统一告警 webhook：alerts[] 逐条转通知。
 * status=resolved 视为 success（很多接收端把 resolved 当低优先级处理），
 * firing 且 labels.severity=critical 才是 critical，其余 firing 按 label 降级。
 */
export function parseAlertmanager(payload: Record<string, unknown>): AlertmanagerAlert[] {
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const results: AlertmanagerAlert[] = [];
  for (const alert of alerts) {
    if (!alert || typeof alert !== 'object') continue;
    const record = alert as Record<string, unknown>;
    const labels = record.labels && typeof record.labels === 'object' ? record.labels as Record<string, unknown> : {};
    const annotations = record.annotations && typeof record.annotations === 'object' ? record.annotations as Record<string, unknown> : {};
    const status = String(record.status ?? 'firing');
    const labelSeverity = String(labels.severity ?? '').toLowerCase();
    const severity: NotificationInput['severity'] = status === 'resolved'
      ? 'success'
      : labelSeverity === 'critical' ? 'critical'
      : labelSeverity === 'warning' ? 'warning'
      : labelSeverity === 'info' ? 'info'
      : labelSeverity === 'none' ? 'info'
      : 'warning';
    const title = String(labels.alertname ?? annotations.title ?? 'Alert');
    const summary = typeof annotations.summary === 'string' ? annotations.summary.trim() : '';
    const description = typeof annotations.description === 'string' ? annotations.description.trim() : '';
    const body = [summary, description].filter(Boolean).join('\n\n') || JSON.stringify(labels);
    const generator = typeof record.generatorURL === 'string' ? record.generatorURL : undefined;
    results.push({
      severity,
      title: status === 'resolved' ? `✅ RESOLVED: ${title}` : `🔥 ${title}`,
      body: `${body}\n\n状态: ${status}`,
      url: safeCompatUrl(generator),
      fingerprint: String(record.fingerprint ?? randomUUID()),
      status
    });
  }
  return results;
}

function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
