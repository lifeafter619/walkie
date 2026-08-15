import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  databasePath: string;
  adminToken?: string;
  masterKey: Buffer;
  allowPrivateWebhooks: boolean;
  allowInsecureHttp: boolean;
  deliveryWorkers: number;
  /** 全局每分钟最大推送条数，0 表示不限 */
  maxSendsPerMin: number;
  maxDeliveryAttempts: number;
  retryBaseMs: number;
  publicUrl?: string;
  isProduction: boolean;
}

function bool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function resolveMasterKey(isProduction: boolean): Buffer {
  const configured = process.env.MASTER_KEY;
  if (configured) {
    const decoded = Buffer.from(configured, 'base64');
    if (decoded.length === 32) return decoded;
    throw new Error('MASTER_KEY must be a base64-encoded 32-byte key');
  }
  if (isProduction) throw new Error('MASTER_KEY is required in production');
  return createHash('sha256').update('walkie-local-development-key').digest();
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const isProduction = process.env.NODE_ENV === 'production';
  const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
  const host = process.env.HOST ?? '127.0.0.1';
  // 远程数据库（Turso/libSQL，如 Vercel 部署）不需要本地数据目录
  if (!process.env.TURSO_DATABASE_URL) mkdirSync(dataDir, { recursive: true });
  const adminToken = process.env.ADMIN_TOKEN || undefined;
  if (isProduction && !adminToken) throw new Error('ADMIN_TOKEN is required in production');
  if (adminToken && adminToken.length < 8) throw new Error('ADMIN_TOKEN must contain at least 8 characters');
  if (!adminToken && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('ADMIN_TOKEN is required when binding to a non-loopback host');
  if (!adminToken) console.warn('[walkie] ADMIN_TOKEN 未设置，管理接口对本机开放且无鉴权（仅限本地开发；反向代理暴露端口前务必设置）');

  return {
    port: integer('PORT', 4310, 1, 65535),
    host,
    dataDir,
    databasePath: path.join(dataDir, 'walkie.db'),
    adminToken,
    masterKey: resolveMasterKey(isProduction),
    allowPrivateWebhooks: bool('ALLOW_PRIVATE_WEBHOOKS'),
    allowInsecureHttp: bool('ALLOW_INSECURE_HTTP'),
    deliveryWorkers: integer('DELIVERY_WORKERS', 2, 1, 16),
    maxSendsPerMin: integer('MAX_SENDS_PER_MIN', 0, 0, 100000),
    maxDeliveryAttempts: integer('MAX_DELIVERY_ATTEMPTS', 4, 1, 10),
    retryBaseMs: integer('RETRY_BASE_MS', 2000, 100, 60000),
    publicUrl: process.env.PUBLIC_URL || undefined,
    isProduction,
    ...overrides
  };
}
