/**
 * Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID ES256)。
 * Node 与 workerd 都有 globalThis.crypto.subtle，签名/加密全部走 WebCrypto。
 */

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidKeys {
  publicKey: string; // base64url, uncompressed P-256 point (65 字节)
  privateKey: string; // base64url, 32 字节标量
}

/** 生成一对 VAPID P-256 密钥（WebCrypto 导出 raw 公钥 + jwk 私钥标量） */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    publicKey: Buffer.from(raw).toString('base64url'),
    privateKey: Buffer.from(jwk.d!, 'base64url').toString('base64url')
  };
}

function b64urlToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

/** RFC 8292 VAPID Authorization 头（ES256）；aud = push 服务 origin */
export async function vapidHeader(keys: VapidKeys, aud: string, subject = 'mailto:admin@walkie.local', expiration = 12 * 3600): Promise<string> {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + expiration, sub: subject })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  // 私钥是 32 字节标量；配对公钥可由标量导出——但 WebCrypto 不支持从标量直接推公钥，
  // 所以用 JWK：x/y 从公钥 raw 里切出来（P-256 raw = 0x04 || X || Y）
  const publicKeyRaw = b64urlToBytes(keys.publicKey);
  const jwk = {
    kty: 'EC' as const, crv: 'P-256',
    x: Buffer.from(publicKeyRaw.slice(1, 33)).toString('base64url'),
    y: Buffer.from(publicKeyRaw.slice(33)).toString('base64url'),
    d: keys.privateKey
  };
  const key = await globalThis.crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // Node 与 workerd 的 subtle.sign(ECDSA) 都返回 raw r||s（各 32 字节），正是 JWT 需要的格式
  const raw = new Uint8Array(await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned)));
  expectRawSignature(raw);
  return `vapid t=${unsigned}.${Buffer.from(raw).toString('base64url')}, k=${keys.publicKey}`;
}

/** 防御：万一运行时返回 DER（0x30 开头），转换成 raw；64 字节 raw 直接用 */
function expectRawSignature(signature: Uint8Array): void {
  if (signature.length === 64) return;
  if (signature[0] === 0x30) throw new Error('此运行时返回 DER 签名，需要转换；当前未实现');
  throw new Error(`意外的签名长度: ${signature.length}`);
}

/** RFC 8291 §3.2 aes128gcm 内容编码。
 *  IKM  = ECDH(server_priv, ua_public)
 *  PRK  = HKDF(salt=auth_secret, ikm=IKM, info="WebPush: info"\0 || ua_public)
 *  salt = 16 随机字节（写进头里，接收端据此重导出）
 *  CEK   = HKDF(salt=salt, ikm=PRK, info="Content-Encoding: aes128gcm\0", 16)
 *  NONCE = HKDF(salt=salt, ikm=PRK, info="Content-Encoding: nonce\0", 12)
 *  CEK/Nonce 的 ikm 是 PRK 而不是原始 ECDH 输出——用错对端直接解不开。
 */
export async function encryptPushPayload(payload: string, subscription: PushSubscription): Promise<Buffer> {
  const asBytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
  const uaPublic = await globalThis.crypto.subtle.importKey('raw', asBytes(subscription.p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const serverPair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPublic = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', serverPair.publicKey));
  const ikm = new Uint8Array(await globalThis.crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublic }, serverPair.privateKey, 256));

  // PRK（"WebPush: info" 上下文，绑定 auth secret 与订阅公钥）
  const authSecret = asBytes(subscription.auth);
  const prkInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), asBytes(subscription.p256dh)]);
  const prk = await hkdfSha256(authSecret, ikm, prkInfo, 32);

  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const cek = await hkdfSha256(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = await hkdfSha256(salt, prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]); // 0x02 = last record padding delimiter
  const aesKey = await globalThis.crypto.subtle.importKey('raw', bytesOf(cek), 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bytesOf(nonce), additionalData: new Uint8Array(0), tagLength: 128 }, aesKey, bytesOf(plaintext)
  ));

  // aes128gcm 头: salt(16) | rs(4 BE) | idlen(1) | keyid(server public 65)
  const header = Buffer.concat([Buffer.from(salt), Buffer.from([0, 0, 0x10, 0]), Buffer.from([serverPublic.length]), Buffer.from(serverPublic)]);
  return Buffer.concat([header, encrypted]);
}

/** TS 5.9 起 Buffer<ArrayBufferLike> 不再直接满足 BufferSource；显式拷成 ArrayBuffer 视图 */
function bytesOf(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

async function hkdfSha256(salt: Uint8Array, ikm: Uint8Array, info: Buffer, length: number): Promise<Buffer> {
  // Node 的 crypto.hkdf 是同步的，但 workerd 没有；两端可用的只有 subtle.deriveBits(HKDF)
  const key = await globalThis.crypto.subtle.importKey('raw', bytesOf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bytesOf(salt), info: bytesOf(info) } as globalThis.HkdfParams, key, length * 8);
  return Buffer.from(bits);
}

/** 校验订阅里推回来的 endpoint 是否是合法的 push 服务 URL（防 SSRF：只许 https） */
export function assertPushEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('Push endpoint 只允许 HTTPS');
  return url;
}
