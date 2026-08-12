export type ProviderId =
  | 'telegram'
  | 'wecom'
  | 'feishu'
  | 'dingtalk'
  | 'slack'
  | 'discord'
  | 'teams'
  | 'google-chat'
  | 'ntfy'
  | 'gotify'
  | 'pushover'
  | 'pushbullet'
  | 'bark'
  | 'serverchan'
  | 'pushplus'
  | 'wxpusher'
  | 'xizhi'
  | 'qmsg'
  | 'smtp'
  | 'twilio'
  | 'matrix'
  | 'mattermost'
  | 'rocketchat'
  | 'zulip'
  | 'webex'
  | 'apprise'
  | 'webhook';

export type DeliveryStatus = 'queued' | 'processing' | 'delivered' | 'partial' | 'failed';
export type AttemptStatus = 'pending' | 'sending' | 'delivered' | 'retrying' | 'failed' | 'skipped';
export type Severity = 'info' | 'success' | 'warning' | 'critical';
export type RouteStrategy = 'fanout' | 'fallback';

export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'number' | 'textarea' | 'select' | 'boolean';
  required?: boolean;
  placeholder?: string;
  help?: string;
  defaultValue?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  category: 'chat' | 'push' | 'email' | 'sms' | 'universal';
  description: string;
  docsUrl: string;
  fields: ConfigField[];
}

export interface Channel {
  id: string;
  name: string;
  slug: string;
  provider: ProviderId;
  enabled: boolean;
  configKeys: string[];
  /** 每分钟最大投递数，0/undefined 表示不限 */
  rateLimitPerMin?: number;
  /** 静默时段 "HH:MM-HH:MM"（服务器本地时间），critical 消息穿透 */
  quietHours?: string;
  lastTestStatus: 'untested' | 'success' | 'failed';
  lastTestError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Route {
  id: string;
  name: string;
  slug: string;
  strategy: RouteStrategy;
  channelIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  destinationIds: string[];
  lastUsedAt?: string;
  createdAt: string;
  revokedAt?: string;
}

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  channelId: string;
  channelName?: string;
  provider?: ProviderId;
  status: AttemptStatus;
  attemptCount: number;
  responseCode?: number;
  error?: string;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Delivery {
  id: string;
  targetType: 'channel' | 'route';
  targetId: string;
  targetName?: string;
  title: string;
  body: string;
  severity: Severity;
  url?: string;
  metadata: Record<string, unknown>;
  source: string;
  status: DeliveryStatus;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  attempts?: DeliveryAttempt[];
}

export interface NotificationInput {
  destination: string;
  title: string;
  body: string;
  severity?: Severity;
  url?: string;
  /** 标签列表，竖线分隔（Server酱³ 风格），透传到支持标签的渠道 */
  tags?: string;
  /** 消息卡片简短描述，透传到支持的渠道 */
  short?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface DashboardStats {
  channels: number;
  enabledChannels: number;
  routes: number;
  activeKeys: number;
  deliveries24h: number;
  successRate24h: number;
  failed24h: number;
}

export interface Destination {
  id: string;
  slug: string;
  name: string;
  kind: 'channel' | 'route';
  provider?: ProviderId;
  strategy?: RouteStrategy;
  enabled: boolean;
}
