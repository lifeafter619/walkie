import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DeploymentPlatform } from '../shared/types.js';

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
  platform: DeploymentPlatform;
}

function deploymentPlatform(): DeploymentPlatform {
  if (process.env.VERCEL) return 'vercel';
  if (process.env.WALKIE_RUNTIME === 'docker') return 'docker';
  return 'node';
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
  // 开发 fallback 必须保持更名前的旧值：更名后换 key 会让所有本地旧库的 dek_wrapped
  // 解密失败（启动即崩）。仅本地开发使用，生产强制显式 MASTER_KEY。
  return createHash('sha256').update('relaydock-local-development-key').digest();
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const isProduction = process.env.NODE_ENV === 'production';
  const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
  // 数据库文件选择：新名 walkie.db 已有数据则优先（c9480da 起的版本一直写它，
  // 若还倒回旧文件会让期间创建的频道/密钥「凭空消失」）；否则沿用有数据的旧名
  // relaydock.db（升级用户的存量数据）；两者都没有则用新名。0 字节残留视为不存在。
  const hasData = (file: string) => { try { return statSync(file).size > 0; } catch { return false; } };
  const newDb = path.join(dataDir, 'walkie.db');
  const legacyDb = path.join(dataDir, 'relaydock.db');
  const databasePath = hasData(newDb) ? newDb : hasData(legacyDb) ? legacyDb : newDb;
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
    databasePath,
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
    platform: deploymentPlatform(),
    ...overrides
  };
}
