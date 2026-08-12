import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function encryptJson(value: Record<string, unknown>, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
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

export function safeSecretEqual(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createApiSecret(): { secret: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString('hex');
  const secret = `rdk_${prefix}_${randomBytes(24).toString('base64url')}`;
  return { secret, prefix, hash: hashSecret(secret) };
}
