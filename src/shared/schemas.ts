import { z } from 'zod';

export const slugSchema = z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, '只允许小写字母、数字和连字符');
export const channelSchema = z.object({
  name: z.string().min(1).max(100),
  slug: slugSchema,
  provider: z.string(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()),
  rateLimitPerMin: z.number().int().min(0).max(600).nullish(),
  quietHours: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}(@[\w/+-]+)?$/, '格式应为 HH:MM-HH:MM，可选 @时区（如 @Asia/Shanghai）').or(z.literal('')).nullish()
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
  idempotencyKey: z.string().max(200).optional(),
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

export const keySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(['notifications:send', 'deliveries:read'])).min(1).optional(),
  destinationIds: z.array(z.string()).optional()
});

/** 管理令牌轮换：可选自定义令牌（≥24 字符）；缺省则服务端随机生成 */
export const credentialTokenSchema = z.object({
  token: z.string().min(24).max(200).optional()
});
