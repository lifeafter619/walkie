/**
 * 平台 webhook 的签名校验。Slack 与 Discord 都要求对**未解析的原始请求体**验签，
 * 所以这些路由必须挂在任何 body 解析中间件之前（见 app.ts 的外层 app）。
 *
 * 全部走 globalThis.crypto.subtle：Node ≥22 与 workerd 都支持 HMAC-SHA256 与 Ed25519，
 * 不引入依赖，也不需要按运行时分叉。
 */

const encoder = new TextEncoder();

/** TS 5.9 起 Uint8Array<ArrayBufferLike> 不再满足 BufferSource；显式拷成 ArrayBuffer 视图 */
function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

function fromHex(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) return undefined;
  const out = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return out;
}

const toHex = (value: ArrayBuffer): string =>
  [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** 恒定时间比较等长字符串；长度不同直接假 */
function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

/** 请求时间戳与当前时间的偏差是否在容忍窗口内（默认 5 分钟），防重放 */
export function withinReplayWindow(timestamp: string | undefined, toleranceSeconds = 300, now = Date.now()): boolean {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(now / 1000 - seconds) <= toleranceSeconds;
}

/**
 * Slack 请求签名（https://api.slack.com/authentication/verifying-requests-from-slack）：
 * `v0=` + HMAC-SHA256(signing secret, `v0:<timestamp>:<raw body>`)
 */
export async function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  now = Date.now()
): Promise<boolean> {
  if (!signingSecret || !signature?.startsWith('v0=')) return false;
  if (!withinReplayWindow(timestamp, 300, now)) return false;
  const key = await globalThis.crypto.subtle.importKey('raw', bytes(encoder.encode(signingSecret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await globalThis.crypto.subtle.sign('HMAC', key, bytes(encoder.encode(`v0:${timestamp}:${rawBody}`)));
  return timingSafeEqual(`v0=${toHex(digest)}`, signature);
}

/**
 * Discord Interactions 签名（https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint）：
 * Ed25519(application public key) 验证 `<timestamp><raw body>`。
 * Discord 在保存 Interactions Endpoint URL 时会**故意发一个坏签名**，必须返回 401，
 * 否则端点保存不上——所以这里不能有「没配公钥就放行」的旁路。
 */
export async function verifyDiscordSignature(
  publicKeyHex: string,
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined
): Promise<boolean> {
  const publicKey = fromHex(publicKeyHex);
  const signatureBytes = signature ? fromHex(signature) : undefined;
  if (!publicKey || publicKey.length !== 32 || !signatureBytes || signatureBytes.length !== 64 || !timestamp) return false;
  try {
    const key = await globalThis.crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    return await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, signatureBytes, bytes(encoder.encode(`${timestamp}${rawBody}`)));
  } catch {
    return false; // 公钥格式不对/运行时不支持 Ed25519：一律按验签失败处理
  }
}
