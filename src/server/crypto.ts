import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const base64url = (value: Uint8Array) => Buffer.from(value).toString('base64url');

export function encryptJson(value: Record<string, unknown>, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', base64url(iv), base64url(tag), base64url(encrypted)].join('.');
}

export function decryptJson(payload: string, key: Buffer): Record<string, unknown> {
  const [version, iv, tag, encrypted] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final()
  ]);
  return JSON.parse(clear.toString('utf8')) as Record<string, unknown>;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 恒定时间比较两个明文令牌（先哈希消除长度泄露） */
export function safeTokenEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return timingSafeEqual(createHash('sha256').update(provided, 'utf8').digest(), createHash('sha256').update(expected, 'utf8').digest());
}

export function safeSecretEqual(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createApiSecret(): { secret: string; prefix: string; hash: string } {
  const prefix = Buffer.from(randomBytes(4)).toString('hex');
  const secret = `rdk_${prefix}_${base64url(randomBytes(24))}`;
  return { secret, prefix, hash: hashSecret(secret) };
}

/* ────────────────────────────────────────────────────────────
 * 凭据管理：KEK/DEK 模型与管理令牌
 *
 * env MASTER_KEY 作为永久根密钥(KEK)，仅 wrangler 可改；
 * 面板轮换的是数据加密密钥(DEK)，用于加密频道凭据与 Agent 可逆密文。
 * DEK 用 KEK 包裹后存数据库（settings.dek_wrapped）。
 * ──────────────────────────────────────────────────────────── */

/** 生成 32 字节数据加密密钥 */
export function generateDek(): Buffer {
  return randomBytes(32);
}

/** 用 KEK 包裹 DEK，返回持久化字符串（与 encryptJson 同格式） */
export function wrapDek(dek: Buffer, kek: Buffer): string {
  return encryptJson({ k: Buffer.from(dek).toString('base64url') }, kek);
}

/** 用 KEK 解开包裹的 DEK；校验长度 32 */
export function unwrapDek(wrapped: string, kek: Buffer): Buffer {
  const payload = decryptJson(wrapped, kek);
  const key = Buffer.from(String(payload.k), 'base64url');
  if (key.length !== 32) throw new Error('包裹的 DEK 不是 32 字节');
  return key;
}

const ADMIN_TOKEN_PREFIX = 'rd_';

/** 生成管理密码：rd_ + 24 字节 base64url（远超 8 字符下限） */
export function generateAdminToken(): string {
  return `${ADMIN_TOKEN_PREFIX}${base64url(randomBytes(24))}`;
}

/** 管理令牌前缀预览（仅展示用）：生成式 rd_ 令牌取前 7 位；
 *  自定义密码不能存明文前缀（8 位密码泄露 7 位形同泄露），改用哈希前缀识别 */
export function adminTokenPrefix(token: string): string {
  if (!token.startsWith(ADMIN_TOKEN_PREFIX)) return hashSecret(token).slice(0, 8) + '…';
  return token.slice(0, 7) + '…';
}

/** 密钥指纹：sha256 的前 8 个十六进制字符，用于展示 KEK 指纹（不可逆推原文） */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/**
 * 渠道双向回调 URL 里的路径秘密，由渠道自己的 bot token 派生：不引入额外配置项，
 * 换了 token 旧回调地址自动失效。Telegram 另外用同一个值填 secret_token 头。
 */
export function channelCallbackSecret(kind: 'tg' | 'slack' | 'discord', token: string): string {
  return createHash('sha256').update(`walkie:${kind}:${token}`).digest('base64url');
}
