import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AppConfig } from '../config.js';

export type ResolveHost = (hostname: string) => Promise<string[]>;

const resolveWithLookup: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && (parts[1] === 168 || (parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)))) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || (parts[1] === 51 && parts[2] === 100))) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) || parts[0] >= 224;
}

/** 主机名（不带协议）版本的私网/回环防护，SMTP 等非 HTTP 渠道复用 */
export async function assertSafeHost(hostname: string, resolveHost: ResolveHost = resolveWithLookup): Promise<void> {
  if (hostname === 'localhost' || (isIP(hostname) && isPrivateAddress(hostname))) throw new Error('私网或回环通知地址已禁用');
  if (!isIP(hostname)) {
    const addresses = await resolveHost(hostname);
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('通知地址解析到了私网或保留地址');
  }
}

export async function assertSafeUrl(
  raw: string,
  config: Pick<AppConfig, 'allowPrivateWebhooks' | 'allowInsecureHttp'>,
  resolveHost: ResolveHost = resolveWithLookup
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('通知地址不是有效 URL');
  }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('通知地址只允许 HTTP 或 HTTPS');
  if (url.protocol === 'http:' && !config.allowInsecureHttp) throw new Error('HTTP 地址已禁用，请使用 HTTPS 或设置 ALLOW_INSECURE_HTTP=true');
  if (url.username || url.password) throw new Error('通知地址不能包含 URL 凭据');
  if (!config.allowPrivateWebhooks) await assertSafeHost(url.hostname, resolveHost);
  return url;
}

export async function safeFetch(
  rawUrl: string,
  init: RequestInit,
  config: Pick<AppConfig, 'allowPrivateWebhooks' | 'allowInsecureHttp'>,
  fetcher: typeof fetch = fetch,
  resolveHost: ResolveHost = resolveWithLookup
): Promise<{ status: number; body: string }> {
  const url = await assertSafeUrl(rawUrl, config, resolveHost);
  // ponytail: 解析校验与实际 fetch 之间存在 DNS TOCTOU 窗口（rebinding）。不能用「解析出 IP 后改写主机名」防御：
  // HTTPS 的 TLS SNI/证书校验必须用原始主机名，改写成 IP 会让所有 HTTPS 发送握手失败。真正钉死 IP 需自定义连接层。
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(12_000) });
  const body = (await response.text()).slice(0, 4096);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const code = parsed.errcode ?? parsed.code;
    // 0/'0'/200 为通用成功码；1000 是 WxPusher、80000000 是华为 Push Kit 的成功码。
    if (code !== undefined && code !== 0 && code !== '0' && code !== 200 && code !== '200' && code !== 1000 && code !== '80000000' && code !== 80000000) throw new Error(String(parsed.errmsg ?? parsed.description ?? parsed.msg ?? parsed.message ?? parsed.info ?? `平台返回错误码 ${code}`));
    if (parsed.ok === false) throw new Error(String(parsed.description ?? '平台拒绝了消息'));
  } catch (error) {
    if (error instanceof SyntaxError) return { status: response.status, body };
    throw error;
  }
  return { status: response.status, body };
}
