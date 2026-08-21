import { createHash, createHmac, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { ProviderId, Severity } from '../../shared/types.js';
import { appendWalkieTrace } from '../../shared/instance-link.js';
import type { AppConfig } from '../config.js';
import { assertSafeHost, safeFetch, type ResolveHost } from './network.js';
import { encryptPushPayload, generateVapidKeys, vapidHeader, type PushSubscription, type VapidKeys } from './webpush.js';

export interface ProviderMessage {
  title: string;
  body: string;
  severity: Severity;
  url?: string;
  metadata: Record<string, unknown>;
}

export interface ProviderResult { responseCode?: number; response?: string }

const string = (config: Record<string, unknown>, key: string) => String(config[key] ?? '');
const lines = (value: unknown) => String(value ?? '').split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
const text = (message: ProviderMessage) => `${message.title}\n\n${message.body}${message.url ? `\n\n${message.url}` : ''}`;
const markdown = (message: ProviderMessage) => `**${message.title}**\n\n${message.body}${message.url ? `\n\n[查看详情](${message.url})` : ''}`;
const color: Record<Severity, string> = { info: '#267365', success: '#178458', warning: '#b26b16', critical: '#b83b32' };

// 有严格正文长度上限的渠道（字符数，留出标题/链接/多字节余量）；未列出的渠道不分片
const BODY_LIMITS: Partial<Record<ProviderId, number>> = {
  telegram: 3600, wecom: 1200, dingtalk: 16000, discord: 3600,
  'google-chat': 3600, qmsg: 900, twilio: 1400, onebot: 3500, line: 4500,
  whatsapp: 3900, 'wecom-app': 1800, kook: 3500, signal: 3500, 'qq-bot': 3500,
  'oppo-push': 200, 'vivo-push': 100, 'meizu-push': 100, pushsafer: 1000
};
const BODY_BYTE_LIMITS: Partial<Record<ProviderId, number>> = { wecom: 2600, webex: 6000, ntfy: 4096, pushover: 900, pushy: 3000 };

/** 按上限切分正文，优先在换行处断开 */
export function splitBody(body: string, limit: number): string[] {
  if (body.length <= limit) return [body];
  const chunks: string[] = [];
  let rest = body;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit);
    const at = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** 按 UTF-8 字节上限切分，适用于平台按字节计数的正文。 */
export function splitBodyBytes(body: string, limit: number): string[] {
  if (Buffer.byteLength(body, 'utf8') <= limit) return [body];
  const chunks: string[] = [];
  let rest = body;
  while (Buffer.byteLength(rest, 'utf8') > limit) {
    let low = 1;
    let high = Math.min(rest.length, limit);
    let end = 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (Buffer.byteLength(rest.slice(0, middle), 'utf8') <= limit) { end = middle; low = middle + 1; } else high = middle - 1;
    }
    if (end > 0 && end < rest.length && /[\uD800-\uDBFF]/.test(rest[end - 1]!)) end -= 1;
    const cut = rest.lastIndexOf('\n', end);
    const at = cut > end / 2 ? cut : end;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function renderTemplate(template: string, message: ProviderMessage): string {
  const values: Record<string, unknown> = { ...message.metadata, title: message.title, body: message.body, content: message.body, severity: message.severity, url: message.url ?? '' };
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_, key: string) => {
    const value = values[key];
    // JSON.stringify 完整转义控制字符，去掉外层引号后嵌入模板
    return typeof value === 'string' ? JSON.stringify(value).slice(1, -1) : JSON.stringify(value ?? '');
  });
}

const base64url = (value: string) => Buffer.from(value).toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const hmac = (algorithm: string, key: string | Buffer, value: string, encoding?: 'hex' | 'base64') => {
  const digest = createHmac(algorithm, key).update(value);
  return encoding ? digest.digest(encoding) : digest.digest();
};
const rfc3986 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const signRs256 = async (value: string, pem: string): Promise<string> => {
  const der = new Uint8Array(Buffer.from(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ''), 'base64'));
  const key = await globalThis.crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(value))).toString('base64url');
};

export function buildAliyunSmsRequest(config: Record<string, unknown>, message: ProviderMessage, nonce = randomUUID(), date = new Date()): { url: string; init: RequestInit } {
  const params: Record<string, string> = {
    AccessKeyId: string(config, 'accessKeyId'), Action: 'SendSms', Format: 'JSON',
    PhoneNumbers: string(config, 'phoneNumbers'), RegionId: string(config, 'regionId') || 'cn-hangzhou',
    SignName: string(config, 'signName'), SignatureMethod: 'HMAC-SHA1', SignatureNonce: nonce,
    SignatureVersion: '1.0', TemplateCode: string(config, 'templateCode'),
    TemplateParam: renderTemplate(string(config, 'templateParam'), message),
    Timestamp: date.toISOString().replace(/\.\d{3}Z$/, 'Z'), Version: '2017-05-25'
  };
  const canonical = Object.entries(params).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`).join('&');
  const signature = hmac('sha1', `${string(config, 'accessKeySecret')}&`, `POST&%2F&${rfc3986(canonical)}`, 'base64') as string;
  return { url: 'https://dysmsapi.aliyuncs.com/', init: { method: 'POST', body: new URLSearchParams({ ...params, Signature: signature }) } };
}

export function buildTencentSmsRequest(config: Record<string, unknown>, message: ProviderMessage, timestamp = Math.floor(Date.now() / 1000)): { url: string; init: RequestInit } {
  const host = 'sms.tencentcloudapi.com';
  const payload = JSON.stringify({
    PhoneNumberSet: lines(config.phoneNumbers), SmsSdkAppId: string(config, 'smsSdkAppId'),
    SignName: string(config, 'signName'), TemplateId: string(config, 'templateId'),
    TemplateParamSet: lines(config.templateParams).map((value) => renderTemplate(value, message))
  });
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\ncontent-type;host\n${sha256(payload)}`;
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/sms/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmac('sha256', `TC3${string(config, 'secretKey')}`, date) as Buffer;
  const secretService = hmac('sha256', secretDate, 'sms') as Buffer;
  const secretSigning = hmac('sha256', secretService, 'tc3_request') as Buffer;
  const signature = hmac('sha256', secretSigning, stringToSign, 'hex') as string;
  const authorization = `TC3-HMAC-SHA256 Credential=${string(config, 'secretId')}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`;
  return { url: `https://${host}/`, init: { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json; charset=utf-8', 'X-TC-Action': 'SendSms', 'X-TC-Version': '2021-01-11', 'X-TC-Timestamp': String(timestamp), 'X-TC-Region': string(config, 'region') || 'ap-guangzhou' }, body: payload } };
}

export function buildAwsSnsRequest(config: Record<string, unknown>, message: ProviderMessage, date = new Date()): { url: string; init: RequestInit } {  const region = string(config, 'region') || 'us-east-1';
  const host = `sns.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`;
  const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, '').replace(/Z$/, 'Z');
  const shortDate = amzDate.slice(0, 8);
  const scope = `${shortDate}/${region}/sns/aws4_request`;
  const params = new URLSearchParams({ Action: 'Publish', Version: '2010-03-31', Message: text(message) });
  const targetType = string(config, 'targetType') || 'topicArn';
  params.set(targetType === 'targetArn' ? 'TargetArn' : targetType === 'phoneNumber' ? 'PhoneNumber' : 'TopicArn', string(config, 'target'));
  if (targetType === 'phoneNumber') {
    params.set('MessageAttributes.entry.1.Name', 'AWS.SNS.SMS.SMSType');
    params.set('MessageAttributes.entry.1.Value.DataType', 'String');
    params.set('MessageAttributes.entry.1.Value.StringValue', string(config, 'smsType') || 'Transactional');
    if (config.senderId) {
      params.set('MessageAttributes.entry.2.Name', 'AWS.SNS.SMS.SenderID');
      params.set('MessageAttributes.entry.2.Value.DataType', 'String');
      params.set('MessageAttributes.entry.2.Value.StringValue', string(config, 'senderId'));
    }
  }
  const payload = params.toString();
  const contentType = 'application/x-www-form-urlencoded; charset=utf-8';
  const payloadHash = sha256(payload);
  const sessionToken = string(config, 'sessionToken');
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-date:${amzDate}`,
    ...(sessionToken ? [`x-amz-security-token:${sessionToken}`] : [])
  ].join('\n') + '\n';
  const signedHeaders = ['content-type', 'host', 'x-amz-date', ...(sessionToken ? ['x-amz-security-token'] : [])].join(';');
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const dateKey = hmac('sha256', `AWS4${string(config, 'secretAccessKey')}`, shortDate) as Buffer;
  const regionKey = hmac('sha256', dateKey, region) as Buffer;
  const serviceKey = hmac('sha256', regionKey, 'sns') as Buffer;
  const signingKey = hmac('sha256', serviceKey, 'aws4_request') as Buffer;
  const signature = hmac('sha256', signingKey, stringToSign, 'hex') as string;
  const authorization = `AWS4-HMAC-SHA256 Credential=${string(config, 'accessKeyId')}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    url: `https://${host}/`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'X-Amz-Date': amzDate, ...(sessionToken ? { 'X-Amz-Security-Token': sessionToken } : {}), Authorization: authorization },
      body: payload
    }
  };
}

/** AWS SigV4 泛化签名：SNS 用 form、SES v2 用 JSON，canonical request 的差异由参数传入 */
function signAwsV4(options: {
  method: string; host: string; path: string; region: string; service: string;
  headers: Record<string, string>; body: string;
  accessKeyId: string; secretAccessKey: string; sessionToken?: string; date?: Date;
}): { authorization: string; amzDate: string } {
  const date = options.date ?? new Date();
  const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, '').replace(/Z$/, 'Z');
  const shortDate = amzDate.slice(0, 8);
  const scope = `${shortDate}/${options.region}/${options.service}/aws4_request`;
  const payloadHash = sha256(options.body);
  const headerEntries = Object.entries({ ...options.headers, host: options.host, 'x-amz-date': amzDate, ...(options.sessionToken ? { 'x-amz-security-token': options.sessionToken } : {}) }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const canonicalHeaders = headerEntries.map(([key, value]) => `${key}:${value}\n`).join('');
  const signedHeaders = headerEntries.map(([key]) => key).join(';');
  const canonicalRequest = `${options.method}\n${options.path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const dateKey = hmac('sha256', `AWS4${options.secretAccessKey}`, shortDate) as Buffer;
  const regionKey = hmac('sha256', dateKey, options.region) as Buffer;
  const serviceKey = hmac('sha256', regionKey, options.service) as Buffer;
  const signingKey = hmac('sha256', serviceKey, 'aws4_request') as Buffer;
  const signature = hmac('sha256', signingKey, stringToSign, 'hex') as string;
  return { authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, amzDate };
}

export function buildAwsSesRequest(config: Record<string, unknown>, message: ProviderMessage, date = new Date()): { url: string; init: RequestInit } {
  const region = string(config, 'region') || 'us-east-1';
  const host = `email.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`;
  const payload = JSON.stringify({
    FromEmailAddress: string(config, 'from'),
    Destination: { ToAddresses: lines(config.to) },
    Content: { Simple: { Subject: { Data: message.title }, Body: { Text: { Data: text(message) } } } }
  });
  const contentType = 'application/json';
  const { authorization, amzDate } = signAwsV4({
    method: 'POST', host, path: '/v2/email/outbound-emails', region, service: 'ses',
    headers: { 'content-type': contentType }, body: payload,
    accessKeyId: string(config, 'accessKeyId'), secretAccessKey: string(config, 'secretAccessKey'),
    sessionToken: string(config, 'sessionToken') || undefined, date
  });
  return {
    url: `https://${host}/v2/email/outbound-emails`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'X-Amz-Date': amzDate, ...(config.sessionToken ? { 'X-Amz-Security-Token': string(config, 'sessionToken') } : {}), Authorization: authorization },
      body: payload
    }
  };
}

export class ProviderDispatcher {
  private readonly tokenCache = new Map<string, { value: string; expiresAt: number }>();
  private readonly tokenInflight = new Map<string, Promise<string>>();
  /** Web Push 渠道的订阅与 VAPID 来源；由组装根（server/worker/vercel 入口）注入 */
  pushSubscriptions: () => Promise<{ subscriptions: PushSubscription[]; vapid: VapidKeys }> = async () => {
    throw new Error('Web Push 未配置：缺少订阅存储');
  };

  /** 订阅失效回调（404/410 清理）；组装根注入 */
  onPushExpired?: (endpoints: string[]) => void;

  /** 组装根一键接线：订阅存储 + VAPID 密钥（无则惰性生成）。与 RelayRepository 解耦成鸭子类型，保持 dispatcher 可独立实例化 */
  bindPushStore(store: {
    listPushSubscriptions: () => Promise<Array<{ endpoint: string; p256dh: string; auth: string }>>;
    deletePushSubscription: (endpoint: string) => Promise<boolean>;
    getPushVapidKeys: () => Promise<{ publicKey: string; privateKey: string } | undefined>;
    setPushVapidKeys: (keys: { publicKey: string; privateKey: string }) => Promise<void>;
  }): void {
    this.pushSubscriptions = async () => {
      let vapid = await store.getPushVapidKeys();
      if (!vapid) {
        vapid = await generateVapidKeys();
        await store.setPushVapidKeys(vapid);
      }
      return { subscriptions: await store.listPushSubscriptions(), vapid };
    };
    this.onPushExpired = (endpoints) => {
      for (const endpoint of endpoints) void store.deletePushSubscription(endpoint).catch(() => undefined);
    };
  }
  constructor(
    private readonly appConfig: Pick<AppConfig, 'allowPrivateWebhooks' | 'allowInsecureHttp'>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly resolveHost?: ResolveHost
  ) {}

  async send(provider: ProviderId, config: Record<string, unknown>, message: ProviderMessage): Promise<ProviderResult> {
    if (provider === 'smtp') return this.sendSmtp(config, message);
    if (provider === 'webpush') return this.sendWebPush(message);
    const limit = BODY_LIMITS[provider];
    const byteLimit = BODY_BYTE_LIMITS[provider];
    const chunks = byteLimit ? splitBodyBytes(message.body, byteLimit) : limit ? splitBody(message.body, limit) : [message.body];
    let result: ProviderResult = {};
    for (let index = 0; index < chunks.length; index += 1) {
      const part: ProviderMessage = chunks.length === 1 ? message : {
        ...message,
        title: `${message.title} (${index + 1}/${chunks.length})`,
        body: chunks[index],
        // 链接只挂最后一片，避免每片都带按钮
        url: index === chunks.length - 1 ? message.url : undefined
      };
      const request = await this.buildRequest(provider, config, part);
      const response = await safeFetch(request.url, request.init, this.appConfig, this.fetcher, this.resolveHost);
      this.assertProviderResponse(provider, response.body);
      result = { responseCode: response.status, response: response.body };
    }
    return result;
  }

  /** 投递终态回调，走同一套 SSRF 校验 */
  async postCallback(url: string, payload: unknown): Promise<void> {
    await safeFetch(url, this.json(payload), this.appConfig, this.fetcher, this.resolveHost);
  }

  /** 任意 JSON POST（Telegram answerCallbackQuery 等），走同一套 SSRF 校验 */
  async rawPost(url: string, init: RequestInit): Promise<void> {
    await safeFetch(url, init, this.appConfig, this.fetcher, this.resolveHost);
  }

  private json(body: unknown, headers: Record<string, string> = {}): RequestInit {
    return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
  }

  private async cachedToken(key: string, load: () => Promise<{ value: string; expiresIn: number }>): Promise<string> {
    const cached = this.tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const existing = this.tokenInflight.get(key);
    if (existing) return existing;
    const pending = load().then((token) => {
      if (!token.value) throw new Error('平台未返回 access token');
      this.tokenCache.set(key, { value: token.value, expiresAt: Date.now() + Math.max(30, token.expiresIn - 120) * 1000 });
      return token.value;
    }).finally(() => this.tokenInflight.delete(key));
    this.tokenInflight.set(key, pending);
    return pending;
  }

  private async wecomToken(config: Record<string, unknown>): Promise<string> {
    const key = `wecom:${sha256(`${string(config, 'corpId')}:${string(config, 'secret')}`)}`;
    return this.cachedToken(key, async () => {
      const query = new URLSearchParams({ corpid: string(config, 'corpId'), corpsecret: string(config, 'secret') });
      const result = await safeFetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?${query}`, { method: 'GET' }, this.appConfig, this.fetcher, this.resolveHost);
      const body = JSON.parse(result.body) as Record<string, unknown>;
      return { value: String(body.access_token ?? ''), expiresIn: Number(body.expires_in ?? 7200) };
    });
  }

  private async qqToken(config: Record<string, unknown>): Promise<string> {
    const key = `qq:${sha256(`${string(config, 'appId')}:${string(config, 'clientSecret')}`)}`;
    return this.cachedToken(key, async () => {
      const result = await safeFetch('https://api.bot.qq.com/app/getAppAccessToken', this.json({ appId: string(config, 'appId'), clientSecret: string(config, 'clientSecret') }), this.appConfig, this.fetcher, this.resolveHost);
      const body = JSON.parse(result.body) as Record<string, unknown>;
      return { value: String(body.access_token ?? ''), expiresIn: Number(body.expires_in ?? 7200) };
    });
  }

  private async feishuToken(config: Record<string, unknown>): Promise<string> {
    const key = `feishu:${sha256(`${string(config, 'appId')}:${string(config, 'appSecret')}`)}`;
    return this.cachedToken(key, async () => {
      const result = await safeFetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', this.json({ app_id: string(config, 'appId'), app_secret: string(config, 'appSecret') }), this.appConfig, this.fetcher, this.resolveHost);
      const body = JSON.parse(result.body) as Record<string, unknown>;
      if (Number(body.code) !== 0) throw new Error(String(body.msg ?? `飞书获取 tenant_access_token 失败（${body.code}）`));
      return { value: String(body.tenant_access_token ?? ''), expiresIn: Number(body.expire ?? 7200) };
    });
  }

  private async dingtalkWorkToken(config: Record<string, unknown>): Promise<string> {
    const key = `dingtalk-work:${sha256(`${string(config, 'appKey')}:${string(config, 'appSecret')}`)}`;
    return this.cachedToken(key, async () => {
      const query = new URLSearchParams({ appkey: string(config, 'appKey'), appsecret: string(config, 'appSecret') });
      const result = await safeFetch(`https://oapi.dingtalk.com/gettoken?${query}`, { method: 'GET' }, this.appConfig, this.fetcher, this.resolveHost);
      const body = JSON.parse(result.body) as Record<string, unknown>;
      if (Number(body.errcode) !== 0) throw new Error(String(body.errmsg ?? `钉钉获取 access_token 失败（${body.errcode}）`));
      return { value: String(body.access_token ?? ''), expiresIn: 7200 };
    });
  }

  private async huaweiToken(config: Record<string, unknown>): Promise<string> {
    const key = `huawei:${sha256(`${string(config, 'appId')}:${string(config, 'appSecret')}`)}`;
    return this.cachedToken(key, async () => {
      const result = await safeFetch('https://oauth-login.cloud.huawei.com/oauth2/v3/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: string(config, 'appId'), client_secret: string(config, 'appSecret') }) }, this.appConfig, this.fetcher, this.resolveHost);
      const body = JSON.parse(result.body) as Record<string, unknown>;
      if (!body.access_token) throw new Error(String(body.error_description ?? body.error ?? '华为 Push Kit 获取 access token 失败'));
      return { value: String(body.access_token), expiresIn: Number(body.expires_in ?? 3600) };
    });
  }

  private async honorToken(config: Record<string, unknown>): Promise<string> {
    const key = `honor:${sha256(`${string(config, 'clientId')}:${string(config, 'clientSecret')}`)}`;
    return this.cachedToken(key, async () => {
      const result = await safeFetch('https://iam.developer.honor.com/auth/realms/developer/protocol/openid-connect/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: string(config, 'clientId'), client_secret: string(config, 'clientSecret') }) }, this.appConfig, this.fetcher, this.resolveHost);
      const body = JSON.parse(result.body) as Record<string, unknown>;
      if (!body.access_token) throw new Error(String(body.error_description ?? body.error ?? 'HONOR Push 获取 access token 失败'));
      return { value: String(body.access_token), expiresIn: Number(body.expires_in ?? 3600) };
    });
  }

  private async oppoToken(config: Record<string, unknown>): Promise<string> {
    const key = `oppo:${sha256(`${string(config, 'appKey')}:${string(config, 'masterSecret')}`)}`;
    return this.cachedToken(key, async () => {
      const timestamp = String(Date.now());
      const sign = sha256(`${string(config, 'appKey')}${timestamp}${string(config, 'masterSecret')}`);
      const result = await safeFetch('https://api.push.oppomobile.com/server/v1/auth', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ app_key: string(config, 'appKey'), sign, timestamp }) }, this.appConfig, this.fetcher, this.resolveHost);
      const body = JSON.parse(result.body) as Record<string, unknown>;
      if (Number(body.code) !== 0) throw new Error(String(body.message ?? `OPPO Push 鉴权失败（${body.code}）`));
      const data = typeof body.data === 'string' ? JSON.parse(body.data) as Record<string, unknown> : body.data as Record<string, unknown> | undefined;
      return { value: String(data?.auth_token ?? ''), expiresIn: 86_400 };
    });
  }

  private async vivoToken(config: Record<string, unknown>): Promise<string> {
    const key = `vivo:${sha256(`${string(config, 'appId')}:${string(config, 'appKey')}:${string(config, 'appSecret')}`)}`;
    return this.cachedToken(key, async () => {
      const timestamp = Date.now();
      const appId = Number(string(config, 'appId')) || string(config, 'appId');
      const sign = md5(`${appId}${string(config, 'appKey')}${timestamp}${string(config, 'appSecret')}`.trim());
      const result = await safeFetch('https://api-push.vivo.com.cn/message/auth', this.json({ appId, appKey: string(config, 'appKey'), timestamp, sign }), this.appConfig, this.fetcher, this.resolveHost);
      const body = JSON.parse(result.body) as Record<string, unknown>;
      if (Number(body.result) !== 0 || !body.authToken) throw new Error(String(body.desc ?? `vivo Push 鉴权失败（${body.result}）`));
      return { value: String(body.authToken), expiresIn: 86_400 };
    });
  }

  private async getuiToken(config: Record<string, unknown>): Promise<string> {
    const key = `getui:${sha256(`${string(config, 'appId')}:${string(config, 'appKey')}:${string(config, 'masterSecret')}`)}`;
    return this.cachedToken(key, async () => {
      const timestamp = String(Date.now());
      const sign = sha256(`${string(config, 'appKey')}${timestamp}${string(config, 'masterSecret')}`);
      const result = await safeFetch(`https://restapi.getui.com/v2/${encodeURIComponent(string(config, 'appId'))}/auth`, this.json({ sign, timestamp, appkey: string(config, 'appKey') }), this.appConfig, this.fetcher, this.resolveHost);
      const body = JSON.parse(result.body) as Record<string, unknown>;
      if (Number(body.code) !== 0) throw new Error(String(body.msg ?? `个推鉴权失败（${body.code}）`));
      const data = body.data as Record<string, unknown> | undefined;
      const expiresAt = Number(data?.expire_time ?? 0);
      return { value: String(data?.token ?? ''), expiresIn: expiresAt > Date.now() ? (expiresAt - Date.now()) / 1000 : 3600 };
    });
  }

  private async fcmToken(config: Record<string, unknown>): Promise<{ value: string; projectId: string }> {
    const account = JSON.parse(string(config, 'serviceAccountJson')) as Record<string, unknown>;
    const clientEmail = String(account.client_email ?? '');
    const projectId = String(account.project_id ?? '');
    const privateKey = String(account.private_key ?? '');
    const key = `fcm:${sha256(`${clientEmail}:${projectId}:${privateKey}`)}`;
    const value = await this.cachedToken(key, async () => {
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
      const assertion = `${unsigned}.${await signRs256(unsigned, privateKey)}`;
      const result = await safeFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) }, this.appConfig, this.fetcher, this.resolveHost);
      const body = JSON.parse(result.body) as Record<string, unknown>;
      return { value: String(body.access_token ?? ''), expiresIn: Number(body.expires_in ?? 3600) };
    });
    return { value, projectId };
  }

  private async buildRequest(provider: ProviderId, config: Record<string, unknown>, message: ProviderMessage): Promise<{ url: string; init: RequestInit }> {
    const bodyText = text(message);
    switch (provider) {
      case 'walkie': {
        const server = string(config, 'server').replace(/\/$/, '');
        const trace = appendWalkieTrace(message.metadata.walkieTrace, server);
        return {
          url: `${server}/api/v1/notify`,
          init: this.json({
            destination: string(config, 'destination'), title: message.title, body: message.body,
            severity: message.severity, ...(message.url ? { url: message.url } : {}),
            idempotencyKey: `walkie:${String(message.metadata.walkieDeliveryId ?? message.metadata.idempotencyKey ?? randomUUID())}`,
            metadata: { via: 'walkie-instance' }
          }, { Authorization: `Bearer ${string(config, 'agentKey')}`, 'X-Walkie-Trace': JSON.stringify(trace) })
        };
      }
      case 'join': {
        const endpoint = new URL('https://joinjoaomgcd.appspot.com/_ah/api/messaging/v1/sendPush');
        endpoint.search = new URLSearchParams({ apikey: string(config, 'apiKey'), deviceIds: lines(config.deviceIds).join(','), title: message.title, text: message.body, ...(message.url ? { url: message.url } : {}), priority: String(message.severity === 'critical' ? 2 : message.severity === 'warning' ? 1 : 0) }).toString();
        return { url: endpoint.toString(), init: { method: 'POST' } };
      }
      case 'ifttt': {
        const endpoint = `https://maker.ifttt.com/trigger/${encodeURIComponent(string(config, 'event'))}/with/key/${encodeURIComponent(string(config, 'key'))}`;
        return { url: endpoint, init: this.json({ value1: message.title, value2: message.body, value3: message.url ?? message.severity }) };
      }
      case 'novu': {
        const subscribers = lines(config.subscriberIds);
        const payload = { ...message.metadata, title: message.title, body: message.body, severity: message.severity, ...(message.url ? { url: message.url } : {}) };
        return { url: `${(string(config, 'server') || 'https://api.novu.co').replace(/\/$/, '')}/v1/events/trigger`, init: this.json({ name: string(config, 'workflowId'), to: subscribers.length === 1 ? subscribers[0] : subscribers, payload }, { Authorization: `ApiKey ${string(config, 'apiKey')}` }) };
      }
      case 'knock': {
        const payload = { ...message.metadata, title: message.title, body: message.body, severity: message.severity, ...(message.url ? { url: message.url } : {}) };
        return { url: `https://api.knock.app/v1/workflows/${encodeURIComponent(string(config, 'workflowKey'))}/trigger`, init: this.json({ recipients: lines(config.recipients), data: payload }, { Authorization: `Bearer ${string(config, 'apiKey')}` }) };
      }
      case 'courier': {
        const recipientType = string(config, 'recipientType') || 'user_id';
        const data = { ...message.metadata, title: message.title, body: message.body, severity: message.severity, ...(message.url ? { url: message.url } : {}) };
        return { url: 'https://api.courier.com/send', init: this.json({ message: { to: { [recipientType]: string(config, 'recipient') }, template: string(config, 'templateId'), data } }, { Authorization: `Bearer ${string(config, 'apiKey')}` }) };
      }
      case 'honor-push': {
        const token = await this.honorToken(config);
        const notification = { title: message.title, body: message.body };
        const androidNotification = { ...notification, ...(message.url ? { clickAction: { type: 2, url: message.url } } : {}) };
        return { url: `https://push-api.cloud.hihonor.com/api/v1/${encodeURIComponent(string(config, 'appId'))}/sendMessage`, init: this.json({ notification, android: { notification: androidNotification }, token: lines(config.targets) }, { Authorization: `Bearer ${token}` }) };
      }
      case 'oppo-push': {
        const token = await this.oppoToken(config);
        const targetType = string(config, 'targetType') === 'alias' ? 5 : 2;
        const notification = { title: message.title.slice(0, 50), content: message.body.slice(0, 200), ...(message.url ? { click_action_type: 2, click_action_url: message.url } : {}) };
        const messages = lines(config.targets).map((target) => ({ target_type: targetType, target_value: target, notification }));
        return { url: 'https://api.push.oppomobile.com/server/v1/message/notification/unicast_batch', init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', auth_token: token }, body: new URLSearchParams({ messages: JSON.stringify(messages) }) } };
      }
      case 'vivo-push': {
        const token = await this.vivoToken(config);
        const targetKey = string(config, 'targetType') === 'alias' ? 'alias' : 'regId';
        const payload = { [targetKey]: string(config, 'target'), notifyType: 4, title: message.title.slice(0, 40), content: message.body.slice(0, 100), timeToLive: 86_400, skipType: message.url ? 2 : 1, ...(message.url ? { skipContent: message.url } : {}), networkType: -1, requestId: randomUUID().replace(/-/g, '').slice(0, 32) };
        return { url: 'https://api-push.vivo.com.cn/message/send', init: this.json(payload, { authToken: token }) };
      }
      case 'meizu-push': {
        const targetKey = string(config, 'targetType') === 'alias' ? 'alias' : 'pushIds';
        const targets = lines(config.targets).join(',');
        const messageJson = JSON.stringify({ noticeBarInfo: { noticeMsgType: 0, noticeBarType: 0, title: message.title.slice(0, 32), content: message.body.slice(0, 100) }, clickTypeInfo: message.url ? { clickType: 2, url: message.url } : { clickType: 0 }, pushTimeInfo: { offLine: 1, validTime: 24 } });
        const params: Record<string, string> = { appId: string(config, 'appId'), [targetKey]: targets, messageJson };
        const canonical = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('') + string(config, 'appSecret');
        return { url: `https://server-api-push.meizu.com/garcia/api/server/push/varnished/${string(config, 'targetType') === 'alias' ? 'pushByAlias' : 'pushByPushId'}`, init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams({ ...params, sign: md5(canonical) }) } };
      }
      case 'pushy': {
        const targets = lines(config.targets);
        const notification = { title: message.title, body: message.body };
        return { url: `https://api.pushy.me/push?api_key=${encodeURIComponent(string(config, 'apiKey'))}`, init: this.json({ to: targets.length === 1 ? targets[0] : targets, data: { title: message.title, message: message.body, ...(message.url ? { url: message.url } : {}) }, notification }) };
      }
      case 'pushsafer': {
        const form = new URLSearchParams({ k: string(config, 'privateKey'), t: message.title, m: bodyText });
        if (config.device) form.set('d', string(config, 'device'));
        if (message.url) { form.set('u', message.url); form.set('ut', '查看详情'); }
        return { url: 'https://www.pushsafer.com/api', init: { method: 'POST', body: form } };
      }
      case 'simplepush':
        return { url: 'https://simplepu.sh/', init: this.json({ key: string(config, 'key'), title: message.title, msg: bodyText, ...(config.event ? { event: string(config, 'event') } : {}) }) };
      case 'huawei-push': {
        const token = await this.huaweiToken(config);
        const targetType = string(config, 'targetType') || 'token';
        const targets = lines(config.targets);
        const target = targetType === 'condition' ? { condition: targets[0] } : { [targetType]: targets };
        const notification = { title: message.title, body: message.body, ...(config.category ? { category: string(config, 'category') } : {}), ...(message.url ? { clickAction: { type: 2, url: message.url } } : {}) };
        return { url: `https://push-api.cloud.huawei.com/v1/${encodeURIComponent(string(config, 'appId'))}/messages:send`, init: this.json({ message: { notification, android: { notification }, ...target } }, { Authorization: `Bearer ${token}` }) };
      }
      case 'xiaomi-push': {
        const targetType = string(config, 'targetType') || 'regid';
        const params: Record<string, string> = { restricted_package_name: string(config, 'packageName'), title: message.title.slice(0, 50), description: message.body.slice(0, 128), payload: bodyText, notify_type: '-1' };
        if (targetType !== 'all') params[targetType === 'regid' ? 'registration_id' : targetType] = lines(config.target).join(',');
        if (message.url) { params['extra.notify_effect'] = '3'; params['extra.web_uri'] = message.url; }
        return { url: `https://api.xmpush.xiaomi.com/v3/message/${targetType}`, init: { method: 'POST', headers: { Authorization: `key=${string(config, 'appSecret')}` }, body: new URLSearchParams(params) } };
      }
      case 'jpush': {
        const platform = string(config, 'platform') || 'all';
        const targetType = string(config, 'targetType') || 'registration_id';
        const targets = lines(config.targets);
        const audience = targetType === 'all' ? 'all' : { [targetType]: targets };
        const notification = platform === 'android'
          ? { alert: message.body, android: { alert: message.body, title: message.title } }
          : platform === 'ios'
            ? { alert: { title: message.title, body: message.body }, ios: { alert: { title: message.title, body: message.body }, sound: 'default' } }
            : { alert: message.body, android: { alert: message.body, title: message.title }, ios: { alert: { title: message.title, body: message.body }, sound: 'default' } };
        return { url: 'https://api.jpush.cn/v3/push', init: this.json({ platform: platform === 'all' ? 'all' : [platform], audience, notification, options: { apns_production: config.apnsProduction !== false } }, { Authorization: `Basic ${Buffer.from(`${string(config, 'appKey')}:${string(config, 'masterSecret')}`).toString('base64')}` }) };
      }
      case 'getui': {
        const token = await this.getuiToken(config);
        const targetType = string(config, 'targetType') || 'cid';
        const audience = targetType === 'all' ? 'all' : { [targetType]: [string(config, 'target')] };
        const notification = { title: message.title, body: message.body, click_type: message.url ? 'url' : 'startapp', ...(message.url ? { url: message.url } : {}) };
        const payload = { request_id: randomUUID().replace(/-/g, '').slice(0, 32), audience, push_message: { notification }, push_channel: { android: { ups: { notification } }, ios: { type: 'notify', aps: { alert: { title: message.title, body: message.body }, sound: 'default' }, ...(message.url ? { payload: JSON.stringify({ url: message.url }) } : {}) } } };
        const path = targetType === 'all' ? '/push/all' : `/push/single/${targetType}`;
        return { url: `https://restapi.getui.com/v2/${encodeURIComponent(string(config, 'appId'))}${path}`, init: this.json(payload, { token }) };
      }
      case 'aws-sns':
        return buildAwsSnsRequest(config, message);
      case 'pusher-beams': {
        const targets = lines(config.targets);
        const targetType = string(config, 'targetType') || 'interests';
        const audience = targetType === 'users' ? { users: targets } : { interests: targets };
        const data = { severity: message.severity, ...(message.url ? { url: message.url } : {}) };
        return { url: `https://${encodeURIComponent(string(config, 'instanceId'))}.pushnotifications.pusher.com/publish_api/v1/instances/${encodeURIComponent(string(config, 'instanceId'))}/publishes/${targetType}`, init: this.json({ ...audience, web: { notification: { title: message.title, body: message.body, ...(message.url ? { deep_link: message.url } : {}) } }, fcm: { notification: { title: message.title, body: message.body }, data }, apns: { aps: { alert: { title: message.title, body: message.body }, sound: 'default' }, data } }, { Authorization: `Bearer ${string(config, 'secretKey')}` }) };
      }
      case 'pushpad': {
        const uids = lines(config.uids);
        const tags = lines(config.tags);
        return { url: `https://pushpad.xyz/api/v1/projects/${encodeURIComponent(string(config, 'projectId'))}/notifications`, init: this.json({ body: message.body, title: message.title, ...(message.url ? { target_url: message.url } : {}), ...(message.severity === 'critical' ? { urgent: true } : {}), ...(uids.length ? { uids } : {}), ...(tags.length ? { tags } : {}) }, { Authorization: `Bearer ${string(config, 'accessToken')}`, Accept: 'application/json' }) };
      }
      case 'vonage-sms': {
        const body = new URLSearchParams({ from: string(config, 'from'), to: string(config, 'to'), text: bodyText, type: /[^\x20-\x7e\r\n]/.test(bodyText) ? 'unicode' : 'text' });
        return { url: 'https://rest.nexmo.com/sms/json', init: { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${string(config, 'apiKey')}:${string(config, 'apiSecret')}`).toString('base64')}` }, body } };
      }
      case 'plivo-sms':
        return { url: `https://api.plivo.com/v1/Account/${encodeURIComponent(string(config, 'authId'))}/Message/`, init: this.json({ src: string(config, 'from'), dst: string(config, 'to'), text: bodyText }, { Authorization: `Basic ${Buffer.from(`${string(config, 'authId')}:${string(config, 'authToken')}`).toString('base64')}` }) };
      case 'telnyx-sms':
        return { url: 'https://api.telnyx.com/v2/messages', init: this.json({ from: string(config, 'from'), to: string(config, 'to'), text: bodyText }, { Authorization: `Bearer ${string(config, 'apiKey')}` }) };
      case 'bird-sms':
        return { url: `https://api.bird.com/workspaces/${encodeURIComponent(string(config, 'workspaceId'))}/channels/${encodeURIComponent(string(config, 'channelId'))}/messages`, init: this.json({ receiver: { contacts: [{ identifierValue: string(config, 'to') }] }, body: { type: 'text', text: { text: bodyText } } }, { Authorization: `AccessKey ${string(config, 'accessKey')}` }) };
      case 'infobip-sms':
        return { url: `${string(config, 'baseUrl').replace(/\/$/, '')}/sms/3/messages`, init: this.json({ messages: [{ ...(config.from ? { sender: string(config, 'from') } : {}), destinations: lines(config.to).map((to) => ({ to })), content: { text: bodyText } }] }, { Authorization: `App ${string(config, 'apiKey')}` }) };
      case 'whatsapp': {
        const parameters = lines(config.templateParameters).map((value) => ({ type: 'text', text: renderTemplate(value, message) }));
        const payload = config.mode === 'template'
          ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: string(config, 'to'), type: 'template', template: { name: string(config, 'templateName'), language: { code: string(config, 'languageCode') || 'zh_CN' }, ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}) } }
          : { messaging_product: 'whatsapp', recipient_type: 'individual', to: string(config, 'to'), type: 'text', text: { preview_url: Boolean(message.url), body: bodyText } };
        return { url: `https://graph.facebook.com/${encodeURIComponent(string(config, 'graphVersion') || 'v25.0')}/${encodeURIComponent(string(config, 'phoneNumberId'))}/messages`, init: this.json(payload, { Authorization: `Bearer ${string(config, 'accessToken')}` }) };
      }
      case 'signal':
        return { url: `${string(config, 'server').replace(/\/$/, '')}/v2/send`, init: this.json({ message: bodyText, number: string(config, 'number'), recipients: lines(config.recipients) }) };
      case 'wecom-app': {
        const token = await this.wecomToken(config);
        // 不开 enable_duplicate_check：企业微信会静默丢弃 30 分钟内的重复消息且仍返回
        // errcode 0，告警平台会把「同一条失败重复发生」误报成已送达
        return { url: `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, init: this.json({ touser: string(config, 'toUser') || undefined, toparty: string(config, 'toParty') || undefined, totag: string(config, 'toTag') || undefined, msgtype: 'text', agentid: Number(config.agentId), text: { content: bodyText } }) };
      }
      case 'qq-bot': {
        const token = await this.qqToken(config);
        const targetType = string(config, 'targetType') || 'channel';
        const targetId = encodeURIComponent(string(config, 'targetId'));
        const base = config.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.bot.qq.com';
        const path = targetType === 'group' ? `/v2/groups/${targetId}/messages` : targetType === 'user' ? `/v2/users/${targetId}/messages` : `/channels/${targetId}/messages`;
        return { url: `${base}${path}`, init: this.json(targetType === 'channel' ? { content: bodyText } : { content: bodyText, msg_type: 0 }, { Authorization: `QQBot ${token}` }) };
      }
      case 'kook':
        return { url: `https://www.kookapp.cn/api/v3/${config.direct ? 'direct-message' : 'message'}/create`, init: this.json({ type: 9, target_id: string(config, 'targetId'), content: markdown(message) }, { Authorization: `Bot ${string(config, 'token')}` }) };
      case 'fcm': {
        const token = await this.fcmToken(config);
        const targetType = string(config, 'targetType') || 'token';
        const target = targetType === 'topic' ? string(config, 'target').replace(/^\/topics\//, '') : string(config, 'target');
        return { url: `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(token.projectId)}/messages:send`, init: this.json({ message: { [targetType]: target, notification: { title: message.title, body: message.body, ...(config.imageUrl ? { image: string(config, 'imageUrl') } : {}) }, data: { severity: message.severity, ...(message.url ? { url: message.url } : {}) } } }, { Authorization: `Bearer ${token.value}` }) };
      }
      case 'expo': {
        const tokens = lines(config.pushTokens);
        const payload = { to: tokens.length === 1 ? tokens[0] : tokens, title: message.title, body: message.body, sound: string(config, 'sound') || 'default', priority: message.severity === 'critical' ? 'high' : 'default', ...(config.channelId ? { channelId: string(config, 'channelId') } : {}), data: { severity: message.severity, ...(message.url ? { url: message.url } : {}) } };
        return { url: 'https://exp.host/--/api/v2/push/send', init: this.json(payload, config.accessToken ? { Authorization: `Bearer ${string(config, 'accessToken')}` } : {}) };
      }
      case 'onesignal': {
        const subscriptions = lines(config.subscriptionIds);
        const externalIds = lines(config.externalIds);
        const audience = subscriptions.length ? { include_subscription_ids: subscriptions }
          : externalIds.length ? { include_aliases: { external_id: externalIds }, target_channel: 'push' }
          : { included_segments: [string(config, 'segment')] };
        return { url: 'https://api.onesignal.com/notifications', init: this.json({ app_id: string(config, 'appId'), ...audience, headings: { en: message.title }, contents: { en: message.body }, ...(message.url ? { url: message.url } : {}), ...(config.imageUrl ? { big_picture: string(config, 'imageUrl'), ios_attachments: { image: string(config, 'imageUrl') }, chrome_web_image: string(config, 'imageUrl') } : {}) }, { Authorization: `Key ${string(config, 'apiKey')}` }) };
      }
      case 'sendgrid':
        return { url: config.eu ? 'https://api.eu.sendgrid.com/v3/mail/send' : 'https://api.sendgrid.com/v3/mail/send', init: this.json({ personalizations: [{ to: lines(config.to).map((email) => ({ email })) }], from: { email: string(config, 'from') }, subject: message.title, content: [{ type: 'text/plain', value: bodyText }] }, { Authorization: `Bearer ${string(config, 'apiKey')}` }) };
      case 'resend':
        return { url: 'https://api.resend.com/emails', init: this.json({ from: string(config, 'from'), to: lines(config.to), subject: message.title, text: bodyText }, { Authorization: `Bearer ${string(config, 'apiKey')}` }) };
      case 'postmark':
        return { url: 'https://api.postmarkapp.com/email', init: this.json({ From: string(config, 'from'), To: string(config, 'to'), Subject: message.title, TextBody: bodyText, MessageStream: string(config, 'messageStream') || 'outbound' }, { Accept: 'application/json', 'X-Postmark-Server-Token': string(config, 'serverToken') }) };
      case 'mailgun': {
        const form = new FormData();
        form.set('from', string(config, 'from')); form.set('to', string(config, 'to')); form.set('subject', message.title); form.set('text', bodyText);
        const host = config.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
        return { url: `https://${host}/v3/${encodeURIComponent(string(config, 'domain'))}/messages`, init: { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`api:${string(config, 'apiKey')}`).toString('base64')}` }, body: form } };
      }
      case 'brevo':
        return { url: 'https://api.brevo.com/v3/smtp/email', init: this.json({ sender: { email: string(config, 'from'), ...(config.fromName ? { name: string(config, 'fromName') } : {}) }, to: lines(config.to).map((email) => ({ email })), subject: message.title, textContent: bodyText }, { Accept: 'application/json', 'api-key': string(config, 'apiKey') }) };
      case 'aliyun-sms':
        return buildAliyunSmsRequest(config, message);
      case 'tencent-sms':
        return buildTencentSmsRequest(config, message);
      case 'home-assistant':
        return { url: `${string(config, 'server').replace(/\/$/, '')}/api/services/notify/${encodeURIComponent(string(config, 'service'))}`, init: this.json({ title: message.title, message: message.body, ...(message.url ? { data: { url: message.url, clickAction: message.url } } : {}) }, { Authorization: `Bearer ${string(config, 'accessToken')}` }) };
      case 'nextcloud-talk':
        return { url: `${string(config, 'server').replace(/\/$/, '')}/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(string(config, 'conversationToken'))}`, init: this.json({ message: bodyText, referenceId: sha256(`${message.title}:${message.body}:${Date.now()}`) }, { Accept: 'application/json', 'OCS-APIRequest': 'true', Authorization: `Basic ${Buffer.from(`${string(config, 'username')}:${string(config, 'appPassword')}`).toString('base64')}` }) };
      case 'alertmanager': {
        const startsAt = new Date();
        const endsAt = new Date(startsAt.getTime() + 5 * 60_000);
        return { url: `${string(config, 'server').replace(/\/$/, '')}/api/v2/alerts`, init: this.json([{ labels: { alertname: message.title.slice(0, 128), severity: message.severity, source: string(config, 'source') || 'walkie' }, annotations: { summary: message.title, description: message.body }, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), ...(message.url ? { generatorURL: message.url } : {}) }], config.bearerToken ? { Authorization: `Bearer ${string(config, 'bearerToken')}` } : {}) };
      }
      case 'slack-bot': {
        const payload: Record<string, unknown> = {
          channel: string(config, 'channel'),
          text: `${message.title}\n${message.body}${message.url ? `\n${message.url}` : ''}`,
          unfurl_links: false
        };
        if (config.threadTs) payload.thread_ts = string(config, 'threadTs');
        // ask_user 会话的选项渲染成内联按钮（Slack Block Kit）
        const options = Array.isArray(message.metadata.askOptions) ? message.metadata.askOptions.map(String) : [];
        if (options.length && typeof message.metadata.conversationId === 'string') {
          payload.blocks = [
            { type: 'section', text: { type: 'mrkdwn', text: `*${message.title}*\n${message.body}` } },
            { type: 'actions', elements: options.slice(0, 5).map((option, index) => ({ type: 'button', text: { type: 'plain_text', text: option.slice(0, 75) }, action_id: `walkie_ask_${index}` })) }
          ];
        }
        return { url: 'https://slack.com/api/chat.postMessage', init: this.json(payload, { Authorization: `Bearer ${string(config, 'botToken')}` }) };
      }
      case 'discord-bot':
        return { url: `https://discord.com/api/v10/channels/${encodeURIComponent(string(config, 'channelId'))}/messages`, init: this.json({ content: message.url ? `${message.title}\n${message.body}\n${message.url}` : `${message.title}\n${message.body}` }, { Authorization: `Bot ${string(config, 'botToken')}` }) };
      case 'feishu-app': {
        const token = await this.feishuToken(config);
        const receiveIdType = string(config, 'receiveIdType') || 'open_id';
        return { url: 'https://open.feishu.cn/open-apis/im/v1/messages', init: this.json({ receive_id_type: receiveIdType, receive_id: string(config, 'receiveId'), msg_type: 'text', content: JSON.stringify({ text: text(message) }) }, { Authorization: `Bearer ${token}` }) };
      }
      case 'dingtalk-work': {
        const token = await this.dingtalkWorkToken(config);
        return { url: `https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${encodeURIComponent(token)}`, init: this.json({ agent_id: Number(string(config, 'agentId')), userid_list: string(config, 'userIdList') || undefined, to_all_user: string(config, 'userIdList') ? false : true, msg: { msgtype: 'text', text: { content: text(message) } } }) };
      }
      case 'aws-ses':
        return buildAwsSesRequest(config, message);
      case 'jira-service-management':
        return { url: `${string(config, 'site').replace(/\/$/, '')}/rest/servicedeskapi/request`, init: this.json({ serviceDeskId: string(config, 'serviceDeskId'), requestTypeId: string(config, 'requestTypeId'), requestFieldValues: { summary: message.title, description: bodyText } }, { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${string(config, 'email')}:${string(config, 'apiToken')}`).toString('base64')}` }) };
      case 'telegram': {
        const payload: Record<string, unknown> = {
          chat_id: string(config, 'chatId'), text: bodyText, disable_notification: Boolean(config.disableNotification),
          ...(config.parseMode ? { parse_mode: string(config, 'parseMode') } : {}),
          ...(config.messageThreadId ? { message_thread_id: Number(config.messageThreadId) } : {})
        };
        // ask_user 的选项渲染成 inline_keyboard：点一下即回，不用打开一次性链接。
        // callback_data 填 <conversationId>:<index>，由 POST /telegram/webhook/<secret> 收回
        const askOptions = Array.isArray(message.metadata.askOptions) ? message.metadata.askOptions.map(String) : [];
        if (askOptions.length && typeof message.metadata.conversationId === 'string') {
          payload.reply_markup = {
            inline_keyboard: [
              askOptions.slice(0, 12).map((option, index) => ({
                text: option.slice(0, 60),
                callback_data: `${message.metadata.conversationId}:${index}`
              }))
            ]
          };
        }
        return { url: `https://api.telegram.org/bot${string(config, 'botToken')}/sendMessage`, init: this.json(payload) };
      }
      case 'wecom':
        return { url: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(string(config, 'key'))}`, init: this.json({ msgtype: 'markdown', markdown: { content: markdown(message) } }) };
      case 'feishu': {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const secret = string(config, 'secret');
        const signature = secret ? createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64') : undefined;
        return { url: string(config, 'webhookUrl'), init: this.json({ ...(signature ? { timestamp, sign: signature } : {}), msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: message.title }, template: string(config, 'headerTemplate') || ({ critical: 'red', warning: 'orange', success: 'green', info: 'blue' } as const)[message.severity] }, elements: [{ tag: 'markdown', content: `${message.body}${message.url ? `\n[查看详情](${message.url})` : ''}` }] } }) };
      }
      case 'dingtalk': {
        const timestamp = Date.now().toString();
        const secret = string(config, 'secret');
        const sign = secret ? createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64') : '';
        const params = new URLSearchParams({ access_token: string(config, 'accessToken') });
        if (sign) { params.set('timestamp', timestamp); params.set('sign', sign); }
        return { url: `https://oapi.dingtalk.com/robot/send?${params}`, init: this.json({ msgtype: 'markdown', markdown: { title: message.title, text: markdown(message) } }) };
      }
      case 'slack':
        return { url: string(config, 'webhookUrl'), init: this.json({ text: markdown(message), attachments: [{ color: color[message.severity], text: message.body }] }) };
      case 'discord':
        return { url: string(config, 'webhookUrl'), init: this.json({ embeds: [{ title: message.title, description: message.body, url: message.url, color: Number.parseInt(color[message.severity].slice(1), 16) }] }) };
      case 'teams':
        return { url: string(config, 'webhookUrl'), init: this.json({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: message.title, weight: 'Bolder', wrap: true }, { type: 'TextBlock', text: message.body, wrap: true }], actions: message.url ? [{ type: 'Action.OpenUrl', title: '查看详情', url: message.url }] : [] } }] }) };
      case 'google-chat':
        return { url: string(config, 'webhookUrl'), init: this.json({ text: `*${message.title}*\n${message.body}${message.url ? `\n<${message.url}|查看详情>` : ''}` }) };
      case 'mattermost':
      case 'rocketchat':
        return { url: string(config, 'webhookUrl'), init: this.json({ text: markdown(message) }) };
      case 'ntfy': {
        // HTTP 头只接受 Latin-1：中文标题/标签需 RFC 2047 编码（ntfy 服务端原生支持），否则 fetch 直接抛 TypeError
        const header = (value: string) => /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
        const priority = string(config, 'priority') || (message.severity === 'critical' ? 'urgent' : message.severity === 'warning' ? 'high' : 'default');
        const tags = string(config, 'tags') || (typeof message.metadata.tags === 'string' ? message.metadata.tags.replace(/\|/g, ',') : '');
        const click = message.url && /^[\x00-\xff]*$/.test(message.url) ? message.url : message.url ? encodeURI(message.url) : undefined;
        return { url: `${string(config, 'server').replace(/\/$/, '')}/${encodeURIComponent(string(config, 'topic'))}`, init: { method: 'POST', headers: { Title: header(message.title), Priority: priority, ...(tags ? { Tags: header(tags) } : {}), ...(click ? { Click: click } : {}), ...(config.token ? { Authorization: `Bearer ${string(config, 'token')}` } : {}) }, body: message.body } };
      }
      case 'gotify':
        return { url: `${string(config, 'server').replace(/\/$/, '')}/message?token=${encodeURIComponent(string(config, 'token'))}`, init: this.json({ title: message.title, message: message.body, priority: message.severity === 'critical' ? Math.max(Number(config.priority ?? 5), 8) : Number(config.priority ?? 5), extras: message.url ? { 'client::notification': { click: { url: message.url } } } : undefined }) };
      case 'pushover': {
        const form = new URLSearchParams({ token: string(config, 'apiToken'), user: string(config, 'userKey'), title: message.title, message: message.body, priority: message.severity === 'critical' ? '1' : '0' });
        if (config.device) form.set('device', string(config, 'device'));
        if (config.sound) form.set('sound', string(config, 'sound'));
        if (message.url) { form.set('url', message.url); form.set('url_title', '查看详情'); }
        return { url: 'https://api.pushover.net/1/messages.json', init: { method: 'POST', body: form } };
      }
      case 'pushbullet':
        return { url: 'https://api.pushbullet.com/v2/pushes', init: this.json({ type: message.url ? 'link' : 'note', title: message.title, body: message.body, url: message.url, device_iden: config.deviceIden || undefined }, { 'Access-Token': string(config, 'accessToken') }) };
      case 'bark': {
        const bark = message.metadata.bark && typeof message.metadata.bark === 'object'
          ? message.metadata.bark as Record<string, unknown>
          : {};
        const value = (key: string, fallback: unknown) => bark[key] ?? fallback;
        const level = value('level', message.severity === 'critical' ? 'critical' : message.severity === 'warning' ? 'timeSensitive' : 'active');
        return { url: `${string(config, 'server').replace(/\/$/, '')}/push`, init: this.json({
          device_key: string(config, 'deviceKey'), title: message.title, body: message.body,
          ...(bark.subtitle !== undefined ? { subtitle: String(bark.subtitle) } : {}),
          group: value('group', string(config, 'group') || 'Walkie'), level,
          ...(bark.volume !== undefined ? { volume: Number(bark.volume) } : message.severity === 'critical' && config.criticalVolume !== undefined && config.criticalVolume !== '' ? { volume: Number(config.criticalVolume) } : {}),
          ...(value('sound', config.sound) ? { sound: String(value('sound', config.sound)) } : {}),
          ...(value('icon', config.icon) ? { icon: String(value('icon', config.icon)) } : {}),
          ...(value('call', message.severity === 'critical' && config.callOnCritical ? '1' : '') ? { call: String(value('call', message.severity === 'critical' && config.callOnCritical ? '1' : '')) } : {}),
          ...(bark.badge !== undefined ? { badge: bark.badge } : {}),
          ...(bark.autoCopy !== undefined ? { autoCopy: bark.autoCopy } : {}),
          ...(bark.copy !== undefined ? { copy: bark.copy } : {}),
          ...(bark.image !== undefined ? { image: bark.image } : {}),
          ...(bark.action !== undefined ? { action: bark.action } : {}),
          ...(bark.id !== undefined ? { id: bark.id } : {}),
          ...(bark.delete !== undefined ? { delete: bark.delete } : {}),
          ...(bark.isArchive !== undefined ? { isArchive: bark.isArchive } : {}),
          ...(bark.ttl !== undefined ? { ttl: bark.ttl } : {}),
          ...(bark.ciphertext !== undefined ? { ciphertext: bark.ciphertext } : {}),
          url: message.url
        }) };
      }
      case 'serverchan': {
        const sendKey = string(config, 'sendKey');
        const desp = `${message.body}${message.url ? `\n\n${message.url}` : ''}`;
        // Server酱³ sendkey 形如 sctp{uid}t...，走 {uid}.push.ft07.com；否则走 Turbo sctapi.ftqq.com
        const sc3 = /^sctp(\d+)t/.exec(sendKey);
        if (sc3) {
          const tags = typeof message.metadata.tags === 'string' && message.metadata.tags ? message.metadata.tags : `Walkie|${message.severity}`;
          const short = typeof message.metadata.short === 'string' && message.metadata.short ? message.metadata.short : undefined;
          return { url: `https://${sc3[1]}.push.ft07.com/send/${encodeURIComponent(sendKey)}.send`, init: this.json({ title: message.title, desp, tags, ...(short ? { short } : {}) }) };
        }
        return { url: `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`, init: { method: 'POST', body: new URLSearchParams({ title: message.title, desp }) } };
      }
      case 'wxpusher': {
        const lines = (key: string) => string(config, key).split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
        const uids = lines('uids');
        const topicIds = lines('topicIds').map(Number).filter(Number.isFinite);
        if (!uids.length && !topicIds.length) throw new Error('WxPusher 需要至少一个 UID 或主题 ID');
        const summary = (typeof message.metadata.short === 'string' && message.metadata.short) || message.title;
        return { url: 'https://wxpusher.zjiecode.com/api/send/message', init: this.json({ appToken: string(config, 'appToken'), content: markdown(message), summary: summary.slice(0, 99), contentType: 3, uids, topicIds, url: message.url }) };
      }
      case 'xizhi':
        return { url: `https://xizhi.qqoq.net/${encodeURIComponent(string(config, 'key'))}.send`, init: { method: 'POST', body: new URLSearchParams({ title: message.title, content: markdown(message) }) } };
      case 'qmsg': {
        const form = new URLSearchParams({ msg: text(message) });
        if (config.qq) form.set('qq', string(config, 'qq'));
        return { url: `https://qmsg.zendee.cn/send/${encodeURIComponent(string(config, 'key'))}`, init: { method: 'POST', body: form } };
      }
      case 'pushplus':
        return { url: 'https://www.pushplus.plus/send', init: this.json({ token: string(config, 'token'), title: message.title, content: markdown(message), template: 'markdown', topic: config.topic || undefined }) };
      case 'twilio': {
        const accountSid = string(config, 'accountSid');
        return { url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, init: { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${string(config, 'authToken')}`).toString('base64')}` }, body: new URLSearchParams({ From: string(config, 'from'), To: string(config, 'to'), Body: bodyText }) } };
      }
      case 'matrix':
        return { url: `${string(config, 'homeserver').replace(/\/$/, '')}/_matrix/client/v3/rooms/${encodeURIComponent(string(config, 'roomId'))}/send/m.room.message/${randomUUID()}?access_token=${encodeURIComponent(string(config, 'accessToken'))}`, init: { ...this.json({ msgtype: 'm.text', body: bodyText }), method: 'PUT' } };
      case 'zulip': {
        const form = new URLSearchParams({ type: 'stream', to: string(config, 'stream'), topic: string(config, 'topic'), content: markdown(message) });
        return { url: `${string(config, 'site').replace(/\/$/, '')}/api/v1/messages`, init: { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${string(config, 'email')}:${string(config, 'apiKey')}`).toString('base64')}` }, body: form } };
      }
      case 'webex':
        return { url: 'https://webexapis.com/v1/messages', init: this.json({ roomId: string(config, 'roomId'), markdown: markdown(message) }, { Authorization: `Bearer ${string(config, 'accessToken')}` }) };
      case 'apprise': {
        const key = string(config, 'configKey').trim();
        const endpoint = `${string(config, 'server').replace(/\/$/, '')}/notify${key ? `/${encodeURIComponent(key)}` : ''}`;
        return { url: endpoint, init: this.json({ title: message.title, body: message.body, type: message.severity === 'critical' ? 'failure' : message.severity === 'warning' ? 'warning' : message.severity === 'success' ? 'success' : 'info', ...(key ? {} : { urls: string(config, 'urls').split(/\r?\n/).filter(Boolean) }) }) };
      }
      case 'webhook': {
        let headers: Record<string, string> = { 'content-type': 'application/json' };
        if (config.headers) {
          const parsed = JSON.parse(string(config, 'headers')) as unknown;
          if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('请求头必须是 JSON 对象');
          headers = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
        }
        return { url: string(config, 'url'), init: { method: string(config, 'method') || 'POST', headers, body: renderTemplate(string(config, 'bodyTemplate'), message) } };
      }
      case 'pushdeer':
        return { url: `${(string(config, 'server') || 'https://api2.pushdeer.com').replace(/\/$/, '')}/message/push`, init: { method: 'POST', body: new URLSearchParams({ pushkey: string(config, 'pushKey'), text: message.title, desp: markdown(message), type: 'markdown' }) } };
      case 'chanify':
        return { url: `${(string(config, 'server') || 'https://api.chanify.net').replace(/\/$/, '')}/v1/sender/${encodeURIComponent(string(config, 'token'))}`, init: this.json({ title: message.title, text: `${message.body}${message.url ? `\n${message.url}` : ''}`, priority: message.severity === 'critical' ? 10 : 5, ...(config.sound ? { sound: string(config, 'sound') } : {}) }) };
      case 'pushme':
        return { url: (string(config, 'server') || 'https://push.i-i.me').replace(/\/$/, ''), init: { method: 'POST', body: new URLSearchParams({ push_key: string(config, 'pushKey'), title: message.title, content: markdown(message), type: 'markdown' }) } };
      case 'onebot': {
        const target = string(config, 'groupId')
          ? { endpoint: 'send_group_msg', id: { group_id: Number(string(config, 'groupId')) } }
          : { endpoint: 'send_private_msg', id: { user_id: Number(string(config, 'userId')) } };
        return { url: `${string(config, 'server').replace(/\/$/, '')}/${target.endpoint}`, init: this.json({ ...target.id, message: bodyText }, config.accessToken ? { Authorization: `Bearer ${string(config, 'accessToken')}` } : {}) };
      }
      case 'synology-chat':
        return { url: string(config, 'webhookUrl'), init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ payload: JSON.stringify({ text: bodyText }) }) } };
      case 'pagerduty':
        return { url: 'https://events.pagerduty.com/v2/enqueue', init: this.json({
          routing_key: string(config, 'routingKey'), event_action: 'trigger',
          ...(message.metadata.idempotencyKey ? { dedup_key: String(message.metadata.idempotencyKey) } : {}),
          payload: {
            summary: `${message.title}: ${message.body}`.slice(0, 1024),
            source: string(config, 'source') || 'walkie',
            severity: ({ critical: 'critical', warning: 'warning', info: 'info', success: 'info' } as const)[message.severity]
          },
          ...(message.url ? { links: [{ href: message.url, text: message.title }] } : {})
        }) };
      case 'line':
        return { url: 'https://api.line.me/v2/bot/message/push', init: this.json({ to: string(config, 'to'), messages: [{ type: 'text', text: bodyText.slice(0, 5000) }] }, { Authorization: `Bearer ${string(config, 'channelAccessToken')}` }) };
      default:
        throw new Error(`不支持的渠道类型: ${provider}`);
    }
  }

  private assertProviderResponse(provider: ProviderId, body: string): void {
    if (provider === 'aws-sns' && !/<MessageId>[\s\S]+<\/MessageId>/.test(body)) throw new Error('Amazon SNS 未返回 MessageId');
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body) as Record<string, unknown>; } catch {
      if (['honor-push', 'oppo-push', 'vivo-push', 'meizu-push', 'pushy', 'pushsafer', 'simplepush', 'novu', 'knock', 'courier', 'huawei-push', 'jpush', 'getui', 'pusher-beams', 'pushpad', 'vonage-sms', 'plivo-sms', 'telnyx-sms', 'bird-sms', 'infobip-sms', 'whatsapp', 'wecom-app', 'qq-bot', 'kook', 'fcm', 'expo', 'onesignal', 'resend', 'postmark', 'mailgun', 'brevo', 'aliyun-sms', 'tencent-sms', 'nextcloud-talk', 'jira-service-management'].includes(provider)) {
        throw new Error(`${provider} 未返回有效 JSON`);
      }
      return;
    }
    if (provider === 'novu') {
      const result = (parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed) as Record<string, unknown>;
      if (result.acknowledged !== true || result.status !== 'processed') throw new Error(String((result.error as string[] | undefined)?.join('; ') ?? `Novu 未处理工作流: ${result.status ?? 'unknown'}`));
    }
    if (provider === 'knock' && !parsed.workflow_run_id) throw new Error(String(parsed.error ?? 'Knock 未返回 workflow run ID'));
    if (provider === 'courier' && !parsed.requestId) throw new Error(String(parsed.message ?? 'Courier 未返回 requestId'));
    if (provider === 'honor-push' && parsed.code !== undefined && !['0', '200', '80000000'].includes(String(parsed.code))) throw new Error(String(parsed.msg ?? parsed.message ?? `HONOR Push 返回错误码 ${parsed.code}`));
    if (provider === 'oppo-push' && parsed.code !== undefined && Number(parsed.code) !== 0) throw new Error(String(parsed.message ?? `OPPO Push 返回错误码 ${parsed.code}`));
    if (provider === 'vivo-push' && Number(parsed.result) !== 0) throw new Error(String(parsed.desc ?? `vivo Push 返回错误码 ${parsed.result}`));
    if (provider === 'meizu-push') {
      if (String(parsed.code) !== '200') throw new Error(String(parsed.message ?? `魅族 Push 返回错误码 ${parsed.code}`));
      const failures = parsed.value && typeof parsed.value === 'object' ? Object.keys(parsed.value as object) : [];
      if (failures.length) throw new Error(`魅族 Push 存在无效目标: ${failures.join(', ')}`);
    }
    if (provider === 'pushy' && (parsed.success !== true || !parsed.id)) throw new Error(String(parsed.error ?? 'Pushy 未返回通知 ID'));
    if (provider === 'pushsafer' && Number(parsed.status) !== 1) {
      // Pushsafer 失败时 error 可能是字符串或对象数组，统一转成可读消息
      const error = parsed.error;
      const detail = typeof error === 'string' ? error : Array.isArray(error) ? error.map((item) => String((item as Record<string, unknown>).message ?? '')).join('; ') : '';
      throw new Error(detail || 'Pushsafer 拒绝了消息');
    }
    if (provider === 'simplepush' && parsed.success === false) throw new Error(String(parsed.error ?? 'Simplepush 拒绝了消息'));
    if (provider === 'huawei-push' && String(parsed.code) !== '80000000') throw new Error(String(parsed.msg ?? `华为 Push Kit 返回错误码 ${parsed.code}`));
    if (provider === 'xiaomi-push' && (Number(parsed.code) !== 0 || parsed.result !== 'ok')) throw new Error(String(parsed.description ?? parsed.info ?? `小米推送返回错误码 ${parsed.code}`));
    if (provider === 'jpush' && !parsed.msg_id) throw new Error(String(parsed.error ?? 'JPush 未返回消息 ID'));
    if (provider === 'getui' && Number(parsed.code) !== 0) throw new Error(String(parsed.msg ?? `个推返回错误码 ${parsed.code}`));
    if (provider === 'pusher-beams' && !parsed.publishId) throw new Error(String(parsed.error ?? 'Pusher Beams 未返回 publishId'));
    if (provider === 'pushpad' && !parsed.id) throw new Error(String(parsed.error ?? 'Pushpad 未返回通知 ID'));
    if (provider === 'vonage-sms') {
      const messages = parsed.messages as Array<Record<string, unknown>> | undefined;
      const failed = messages?.find((item) => String(item.status) !== '0');
      if (!messages?.length || failed) throw new Error(String(failed?.['error-text'] ?? 'Vonage SMS 拒绝了消息'));
    }
    if (provider === 'plivo-sms' && !Array.isArray(parsed.message_uuid)) throw new Error(String(parsed.message ?? 'Plivo 未返回 message UUID'));
    if (provider === 'telnyx-sms' && !(parsed.data as Record<string, unknown> | undefined)?.id) throw new Error(String(parsed.errors ?? 'Telnyx 未返回消息 ID'));
    if (provider === 'bird-sms' && (!parsed.id || String(parsed.status) === 'failed')) throw new Error(String(parsed.reason ?? 'Bird SMS 拒绝了消息'));
    if (provider === 'infobip-sms') {
      const messages = parsed.messages as Array<Record<string, unknown>> | undefined;
      const failed = messages?.find((item) => ['REJECTED', 'UNDELIVERABLE', 'EXPIRED'].includes(String((item.status as Record<string, unknown> | undefined)?.groupName)));
      if (!messages?.length || failed) throw new Error(String((failed?.status as Record<string, unknown> | undefined)?.description ?? 'Infobip SMS 拒绝了消息'));
    }
    if (provider === 'whatsapp' && !Array.isArray(parsed.messages)) throw new Error(String((parsed.error as Record<string, unknown> | undefined)?.message ?? 'WhatsApp 未返回消息 ID'));
    if (provider === 'wecom-app' && Number(parsed.errcode) !== 0) throw new Error(String(parsed.errmsg ?? `企业微信返回错误码 ${parsed.errcode}`));
    if (provider === 'qq-bot' && !parsed.id) throw new Error(String(parsed.message ?? 'QQ 机器人未返回消息 ID'));
    if (provider === 'kook' && Number(parsed.code) !== 0) throw new Error(String(parsed.message ?? `KOOK 返回错误码 ${parsed.code}`));
    if (provider === 'slack-bot' && parsed.ok !== true) throw new Error(String(parsed.error ?? 'Slack API 调用失败'));
    if (provider === 'feishu-app' && parsed.code !== undefined && Number(parsed.code) !== 0) throw new Error(String(parsed.msg ?? `飞书返回错误码 ${parsed.code}`));
    if (provider === 'dingtalk-work' && parsed.errcode !== undefined && Number(parsed.errcode) !== 0) throw new Error(String(parsed.errmsg ?? `钉钉返回错误码 ${parsed.errcode}`));
    if (provider === 'fcm' && !parsed.name) throw new Error('FCM 未返回消息 ID');
    if (provider === 'resend' && !parsed.id) throw new Error(String(parsed.message ?? 'Resend 未返回邮件 ID'));
    if (provider === 'mailgun' && !parsed.id) throw new Error(String(parsed.message ?? 'Mailgun 未返回邮件 ID'));
    if (provider === 'brevo' && !parsed.messageId) throw new Error(String(parsed.message ?? 'Brevo 未返回邮件 ID'));
    if (provider === 'jira-service-management' && !parsed.issueKey) throw new Error('Jira Service Management 未返回请求编号');
    if (provider === 'onesignal' && !parsed.id) throw new Error(String((parsed.errors as string[] | undefined)?.join('; ') ?? 'OneSignal 未创建通知（可能没有有效订阅者）'));
    if (provider === 'expo') {
      if (parsed.data === undefined) throw new Error('Expo 未返回 push ticket');
      const entries = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
      const failed = entries.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).status === 'error') as Record<string, unknown> | undefined;
      if (failed) throw new Error(String(failed.message ?? (failed.details as Record<string, unknown> | undefined)?.error ?? 'Expo 拒绝了通知'));
    }
    if (provider === 'postmark' && parsed.ErrorCode !== undefined && Number(parsed.ErrorCode) !== 0) throw new Error(String(parsed.Message ?? `Postmark 返回错误码 ${parsed.ErrorCode}`));
    if (provider === 'aliyun-sms' && parsed.Code !== 'OK') throw new Error(String(parsed.Message ?? `阿里云短信返回错误码 ${parsed.Code}`));
    if (provider === 'tencent-sms') {
      const response = parsed.Response as Record<string, unknown> | undefined;
      if (response?.Error) throw new Error(String((response.Error as Record<string, unknown>).Message ?? '腾讯云短信调用失败'));
      const statuses = response?.SendStatusSet as Array<Record<string, unknown>> | undefined;
      if (!statuses?.length) throw new Error('腾讯云短信未返回发送状态');
      const failed = statuses.find((item) => item.Code !== 'Ok');
      if (failed) throw new Error(String(failed.Message ?? `腾讯云短信返回错误码 ${failed.Code}`));
    }
    if (provider === 'nextcloud-talk') {
      const meta = (parsed.ocs as Record<string, unknown> | undefined)?.meta as Record<string, unknown> | undefined;
      if (meta?.statuscode !== undefined && Number(meta.statuscode) !== 100) throw new Error(String(meta.message ?? 'Nextcloud Talk 拒绝了消息'));
    }
    if (provider === 'onebot') {
      if (parsed.status !== undefined && parsed.status !== 'ok') throw new Error(String(parsed.message ?? parsed.wording ?? 'OneBot 拒绝了消息'));
      if (parsed.retcode !== undefined && Number(parsed.retcode) !== 0) throw new Error(String(parsed.message ?? parsed.wording ?? `OneBot 返回错误码 ${parsed.retcode}`));
    }
    if (provider === 'synology-chat' && parsed.success === false) throw new Error(String(parsed.error ?? 'Synology Chat 拒绝了消息'));
    if (provider === 'pushover' && parsed.status !== undefined && Number(parsed.status) !== 1) throw new Error(String((parsed.errors as string[] | undefined)?.join('; ') ?? 'Pushover 拒绝了消息'));
    if (provider === 'rocketchat' && parsed.success === false) throw new Error(String(parsed.error ?? 'Rocket.Chat 拒绝了消息'));
  }

  /** Web Push：对本站所有订阅逐个加密投递（RFC 8291 每订阅单独 ECDH，不能复用密文） */
  private async sendWebPush(message: ProviderMessage): Promise<ProviderResult> {
    const { subscriptions, vapid } = await this.pushSubscriptions();
    if (!subscriptions.length) throw new Error('还没有任何 Web Push 订阅；在「系统 → Web Push」页订阅本设备');
    const payload = JSON.stringify({
      title: message.title,
      body: message.body,
      severity: message.severity,
      ...(message.url ? { url: message.url } : {}),
      ...(typeof message.metadata.conversationId === 'string' ? { conversationId: message.metadata.conversationId } : {})
    });
    let delivered = 0;
    let lastError = '';
    const expired: string[] = [];
    for (const subscription of subscriptions) {
      try {
        const endpoint = new URL(subscription.endpoint);
        if (endpoint.protocol !== 'https:') throw new Error('push endpoint 不是 HTTPS');
        const body = await encryptPushPayload(payload, subscription);
        const authorization = await vapidHeader(vapid, endpoint.origin);
        const response = await safeFetch(subscription.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length), ttl: '86400', urgency: message.severity === 'critical' ? 'high' : 'normal', authorization },
          body: new Uint8Array(body)
        }, this.appConfig, this.fetcher, this.resolveHost);
        // 404/410 = 订阅已失效（浏览器清了权限/换设备），删掉避免每次投递都白打
        if (response.status === 404 || response.status === 410) expired.push(subscription.endpoint);
        else if (response.status < 300) delivered += 1;
        else lastError = `HTTP ${response.status}: ${response.body.slice(0, 200)}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (expired.length) this.onPushExpired?.(expired);
    if (!delivered) throw new Error(`Web Push 全部订阅失败${lastError ? `：${lastError}` : ''}`);
    return { responseCode: 200, response: `delivered to ${subscriptions.length}` };
  }

  private async sendSmtp(config: Record<string, unknown>, message: ProviderMessage): Promise<ProviderResult> {
    const host = string(config, 'host');
    // preset 仅前端 UX 层：选预设时前端已把 host/port/secure 写入 config，这里直接读即可，无需感知 preset 值
    // SMTP 不走 safeFetch，单独做私网/回环防护，与 HTTP 渠道策略一致
    if (!this.appConfig.allowPrivateWebhooks) await assertSafeHost(host, this.resolveHost);
    const transporter = nodemailer.createTransport({
      host, port: Number(config.port ?? 587), secure: Boolean(config.secure),
      auth: config.username ? { user: string(config, 'username'), pass: string(config, 'password') } : undefined,
      connectionTimeout: 12_000, socketTimeout: 12_000
    });
    const info = await transporter.sendMail({ from: string(config, 'from'), to: string(config, 'to'), subject: message.title, text: text(message) });
    return { responseCode: 250, response: String(info.messageId) };
  }
}
