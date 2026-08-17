import { z } from 'zod';

export const slugSchema = z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, '只允许小写字母、数字和连字符');
export const quietHoursSchema = z.string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d(?:@[\w/+-]+)?$/, '格式应为 HH:MM-HH:MM，可选 @时区（如 @Asia/Shanghai）')
  .or(z.literal('')).nullish();
export const channelSchema = z.object({
  name: z.string().min(1).max(100),
  slug: slugSchema,
  provider: z.string(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()),
  rateLimitPerMin: z.number().int().min(0).max(600).nullish(),
  quietHours: quietHoursSchema,
  /** 每频道重试上限；0 = 继承全局 MAX_DELIVERY_ATTEMPTS */
  maxAttempts: z.number().int().min(0).max(10).optional()
});
export const routeSchema = z.object({
  name: z.string().min(1).max(100),
  slug: slugSchema,
  strategy: z.enum(['fanout', 'fallback']),
  channelIds: z.array(z.string().uuid()).min(1),
  enabled: z.boolean().optional()
});
export const notificationSchema = z.object({
  destination: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  severity: z.enum(['info', 'success', 'warning', 'critical']).optional(),
  url: z.url().optional(),
  tags: z.string().max(200).optional(),
  short: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  callbackUrl: z.url().optional()
});

export const askSchema = z.object({
  destination: z.string().min(1),
  question: z.string().min(1).max(4000),
  options: z.array(z.string().min(1).max(100)).max(12).optional(),
  title: z.string().max(200).optional(),
  severity: z.enum(['info', 'success', 'warning', 'critical']).optional(),
  timeoutSeconds: z.number().int().min(30).max(86_400).optional()
});

/** 自定义密钥/密码通用规则：≥8 位可见 ASCII（要放进 Authorization 头，不能含空格与非 ASCII） */
const secretSchema = z.string().min(8, '至少 8 个字符').max(200).regex(/^[\x21-\x7e]+$/, '仅支持字母、数字和符号（不含空格）');

export const SCOPE_IDS = ['notifications:send', 'deliveries:read', 'config:write'] as const;

export const keySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(SCOPE_IDS)).min(1).optional(),
  destinationIds: z.array(z.string()).optional(),
  /** 自定义密钥（像密码一样随意设置）；缺省则服务端生成随机 rdk_ 密钥 */
  secret: secretSchema.optional()
});

/** 编辑 Key：不允许改密钥本身（换密钥走吊销重建）；全部字段可选，strict 拒绝未知键 */
export const keyUpdateSchema = keySchema.omit({ secret: true }).partial().strict();

/** 管理密码设置：可自定义（≥8 字符）；缺省则服务端随机生成 */
export const credentialTokenSchema = z.object({
  token: secretSchema.optional()
});

/** 数据保留天数：0 = 永久保留；上限 10 年防误输入 */
export const retentionSchema = z.object({
  deliveriesDays: z.number().int().min(0).max(3650).optional(),
  conversationsDays: z.number().int().min(0).max(3650).optional(),
  auditDays: z.number().int().min(0).max(3650).optional()
}).strict();
