import { describe, expect, it, vi } from 'vitest';
import type { MockFetch } from './helpers.js';
import { encryptPushPayload, generateVapidKeys, vapidHeader, type PushSubscription, type VapidKeys } from '../src/server/providers/webpush.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';

/** TS 5.9 起 Buffer<ArrayBufferLike> 不再满足 BufferSource；统一拷成 ArrayBuffer 视图 */
const view = (value: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
};

async function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Promise<Buffer> {
  const key = await globalThis.crypto.subtle.importKey('raw', view(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: view(salt), info: view(info) } as globalThis.HkdfParams, key, length * 8);
  return Buffer.from(bits);
}

/** 用 Node WebCrypto 模拟浏览器 push service 的 RFC 8291 解密端 */
async function decryptAes128gcm(body: Buffer, subscription: PushSubscription & { p256dhPriv: string }): Promise<string> {
  const asBytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20]!;
  const serverPublic = body.subarray(21, 21 + idlen);
  const encrypted = body.subarray(21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);

  const priv = await globalThis.crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: Buffer.from(asBytes(subscription.p256dh).subarray(1, 33)).toString('base64url'),
    y: Buffer.from(asBytes(subscription.p256dh).subarray(33)).toString('base64url'),
    d: subscription.p256dhPriv
  }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const serverKey = await globalThis.crypto.subtle.importKey('raw', view(serverPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ikm = new Uint8Array(await globalThis.crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, priv, 256));

  // PRK = HKDF(salt=auth, ikm, info="WebPush: info"\0 || ua_public)
  const prkInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), Buffer.from(asBytes(subscription.p256dh))]);
  const prk = await hkdf(Buffer.from(asBytes(subscription.auth)), Buffer.from(ikm), prkInfo, 32);

  const cek = await hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = await hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const aesKey = await globalThis.crypto.subtle.importKey('raw', view(cek), 'AES-GCM', false, ['decrypt']);
  const plaintext = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: view(nonce), additionalData: new Uint8Array(0) }, aesKey, view(encrypted)));
  const text = Buffer.from(plaintext).toString('utf8');
  return text.replace(/\x02$/, '');
}

/** 生成浏览器侧订阅密钥对（含私钥，供解密端用） */
async function browserSubscription(): Promise<PushSubscription & { p256dhPriv: string }> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
  const auth = new Uint8Array(16);
  globalThis.crypto.getRandomValues(auth);
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/some-subscription',
    p256dh: Buffer.from(raw).toString('base64'),
    auth: Buffer.from(auth).toString('base64'),
    p256dhPriv: String(jwk.d)
  };
}

describe('webpush RFC 8291/8292', () => {
  it('round-trips an encrypted payload through the browser push service decryption path', async () => {
    const subscription = await browserSubscription();
    const encrypted = await encryptPushPayload('部署完成 v2.4.0 🚀', subscription);
    // 头结构: 16 salt + 4 rs + 1 idlen + 65 keyid + 密文(>= 16 tag + 1 padding)
    expect(encrypted.length).toBeGreaterThan(21 + 65 + 17);
    const decrypted = await decryptAes128gcm(encrypted, subscription);
    expect(decrypted).toBe('部署完成 v2.4.0 🚀');
  });

  it('generates VAPID keys and a verifiable ES256 Authorization header', async () => {
    const keys: VapidKeys = await generateVapidKeys();
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32);
    const header = await vapidHeader(keys, 'https://fcm.googleapis.com');
    expect(header).toMatch(/^vapid t=ey[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    // 用公钥验证 JWT 签名；Node 的 subtle verify 直接接受 raw r||s（64 字节）签名
    const token = /^vapid t=([^,]+),/.exec(header)![1]!;
    const [h, p, s] = token.split('.');
    const raw = Buffer.from(s, 'base64url');
    expect(raw).toHaveLength(64);
    const key = await globalThis.crypto.subtle.importKey('raw', new Uint8Array(Buffer.from(keys.publicKey, 'base64url')), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });

  it('truncates oversized bodies so the push service does not reject the whole notification', async () => {
    const subscription = await browserSubscription();
    let sentBody: Uint8Array = new Uint8Array();
    const captured = vi.fn(async (_url: unknown, init: RequestInit) => {
      sentBody = init.body as Uint8Array;
      return new Response('', { status: 201 });
    });
    // resolveHost 打桩成公网地址：测试机不该真去解析 fcm.googleapis.com
    const dispatcher = new ProviderDispatcher({ allowPrivateWebhooks: false, allowInsecureHttp: false },
      captured as unknown as MockFetch, async () => ['142.250.0.1']);
    dispatcher.pushSubscriptions = async () => ({ subscriptions: [subscription], vapid: await generateVapidKeys() });

    await dispatcher.send('webpush', {}, { title: '长正文', body: '啊'.repeat(20_000), severity: 'info', metadata: {} });
    // 密文 = 明文 + 1 padding + 16 tag，加上 86 字节头，整体必须留在 4096 以内
    expect(sentBody.byteLength).toBeLessThanOrEqual(4096);
    expect(await decryptAes128gcm(Buffer.from(sentBody), subscription)).toMatch(/…"/);
  });

  it('drops an oversized url before truncating the body — the notification itself must survive', async () => {
    const subscription = await browserSubscription();
    let sentBody: Uint8Array = new Uint8Array();
    const captured = vi.fn(async (_url: unknown, init: RequestInit) => {
      sentBody = init.body as Uint8Array;
      return new Response('', { status: 201 });
    });
    const dispatcher = new ProviderDispatcher({ allowPrivateWebhooks: false, allowInsecureHttp: false },
      captured as unknown as MockFetch, async () => ['142.250.0.1']);
    dispatcher.pushSubscriptions = async () => ({ subscriptions: [subscription], vapid: await generateVapidKeys() });

    // schema 之后仍可能出现的极端组合：长标题 + 长 URL + 长正文。
    // 丢 url 保正文——通知不能整条被推送服务 413 掉
    await dispatcher.send('webpush', {}, {
      title: '超'.repeat(120), body: '正文'.repeat(600), severity: 'critical',
      url: `https://example.com/${'很长的路径'.repeat(180)}`, metadata: {}
    });
    expect(sentBody.byteLength).toBeLessThanOrEqual(4096);
    const decrypted = await decryptAes128gcm(Buffer.from(sentBody), subscription);
    expect(decrypted).toContain('"title"');
    expect(decrypted).not.toContain('https://example.com/');
  });
});
