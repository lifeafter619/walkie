export type ProviderId =
  | 'join'
  | 'ifttt'
  | 'novu'
  | 'knock'
  | 'courier'
  | 'honor-push'
  | 'oppo-push'
  | 'vivo-push'
  | 'meizu-push'
  | 'pushy'
  | 'pushsafer'
  | 'simplepush'
  | 'huawei-push'
  | 'xiaomi-push'
  | 'jpush'
  | 'getui'
  | 'aws-sns'
  | 'pusher-beams'
  | 'pushpad'
  | 'vonage-sms'
  | 'plivo-sms'
  | 'telnyx-sms'
  | 'bird-sms'
  | 'infobip-sms'
  | 'whatsapp'
  | 'signal'
  | 'wecom-app'
  | 'qq-bot'
  | 'kook'
  | 'fcm'
  | 'expo'
  | 'onesignal'
  | 'sendgrid'
  | 'resend'
  | 'postmark'
  | 'mailgun'
  | 'brevo'
  | 'aliyun-sms'
  | 'tencent-sms'
  | 'home-assistant'
  | 'nextcloud-talk'
  | 'alertmanager'
  | 'jira-service-management'
  | 'pushdeer'
  | 'chanify'
  | 'pushme'
  | 'onebot'
  | 'synology-chat'
  | 'pagerduty'
  | 'line'
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
  /** 原生直连、外部网关兼容层或用户自定义请求。 */
  support?: 'native' | 'gateway' | 'custom';
  capabilities?: Array<'text' | 'markdown' | 'link' | 'image' | 'email' | 'sms' | 'incident' | 'receipt'>;
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
  /** 每频道重试上限；0 = 继承全局 MAX_DELIVERY_ATTEMPTS */
  maxAttempts?: number;
  lastTestStatus: 'untested' | 'success' | 'failed';
  lastTestError?: string;
  lastTestAt?: string;
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
  /** 可逆密文解出的完整密钥（仅此功能启用后创建的密钥才有） */
  secret?: string;
  /** 是否可查看明文（功能启用前创建的密钥仅存哈希，无法恢复） */
  viewable: boolean;
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
  /** 投递到达终态后 POST 结果到该地址（SSRF 校验同 webhook） */
  callbackUrl?: string;
}

export interface Conversation {
  id: string;
  apiKeyId: string;
  deliveryId?: string;
  question: string;
  /** 预设选项；回复页渲染为按钮，仍可自由输入 */
  options?: string[];
  reply?: string;
  replySource?: string;
  repliedAt?: string;
  expiresAt: string;
  createdAt: string;
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

/** 管理令牌状态：来源（环境变量 / 已轮换）与是否轮换过 */
export interface AdminTokenStatus {
  source: 'env' | 'rotated';
  rotated: boolean;
  /** 轮换令牌前缀预览（rd_xxxx…），仅 rotated 时有值 */
  prefix?: string;
  envConfigured: boolean;
}

/** 主密钥（KEK/DEK）状态 */
export interface MasterKeyStatus {
  /** env MASTER_KEY(KEK) 指纹，sha256 前 8 位 */
  kekFingerprint: string;
  dekVersion: number;
  rotatedAt?: string;
}

export interface CredentialStatus {
  admin: AdminTokenStatus;
  masterKey: MasterKeyStatus;
}

/** 审计事件：管理员与 Agent 的全部变更操作（channel/key/route/credential/conversation） */
export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

/** 数据保留策略：各表保留天数，0 = 永久保留（默认） */
export interface RetentionSettings {
  deliveriesDays: number;
  conversationsDays: number;
  auditDays: number;
}
