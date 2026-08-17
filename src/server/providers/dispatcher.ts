import { createHash, createHmac, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { ProviderId, Severity } from '../../shared/types.js';
import type { AppConfig } from '../config.js';
import { assertSafeHost, safeFetch, type ResolveHost } from './network.js';

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
  whatsapp: 3900, 'wecom-app': 1800, kook: 3500, signal: 3500, 'qq-bot': 3500
};
const BODY_BYTE_LIMITS: Partial<Record<ProviderId, number>> = { wecom: 2600, webex: 6000, ntfy: 4096, pushover: 900 };

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

export class ProviderDispatcher {
  private readonly tokenCache = new Map<string, { value: string; expiresAt: number }>();
  private readonly tokenInflight = new Map<string, Promise<string>>();
  constructor(
    private readonly appConfig: Pick<AppConfig, 'allowPrivateWebhooks' | 'allowInsecureHttp'>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly resolveHost?: ResolveHost
  ) {}

  async send(provider: ProviderId, config: Record<string, unknown>, message: ProviderMessage): Promise<ProviderResult> {
    if (provider === 'smtp') return this.sendSmtp(config, message);
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
        return { url: `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, init: this.json({ touser: string(config, 'toUser') || undefined, toparty: string(config, 'toParty') || undefined, totag: string(config, 'toTag') || undefined, msgtype: 'text', agentid: Number(config.agentId), text: { content: bodyText }, enable_duplicate_check: 1, duplicate_check_interval: 1800 }) };
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
      case 'jira-service-management':
        return { url: `${string(config, 'site').replace(/\/$/, '')}/rest/servicedeskapi/request`, init: this.json({ serviceDeskId: string(config, 'serviceDeskId'), requestTypeId: string(config, 'requestTypeId'), requestFieldValues: { summary: message.title, description: bodyText } }, { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${string(config, 'email')}:${string(config, 'apiToken')}`).toString('base64')}` }) };
      case 'telegram':
        return { url: `https://api.telegram.org/bot${string(config, 'botToken')}/sendMessage`, init: this.json({
          chat_id: string(config, 'chatId'), text: bodyText, disable_notification: Boolean(config.disableNotification),
          ...(config.parseMode ? { parse_mode: string(config, 'parseMode') } : {}),
          ...(config.messageThreadId ? { message_thread_id: Number(config.messageThreadId) } : {})
        }) };
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
      case 'bark':
        return { url: `${string(config, 'server').replace(/\/$/, '')}/push`, init: this.json({
          device_key: string(config, 'deviceKey'), title: message.title, body: message.body,
          group: string(config, 'group') || 'Walkie',
          level: message.severity === 'critical' ? 'critical' : message.severity === 'warning' ? 'timeSensitive' : 'active',
          ...(message.severity === 'critical' && config.criticalVolume !== undefined && config.criticalVolume !== '' ? { volume: Number(config.criticalVolume) } : {}),
          ...(config.sound ? { sound: string(config, 'sound') } : {}),
          ...(config.icon ? { icon: string(config, 'icon') } : {}),
          ...(message.severity === 'critical' && config.callOnCritical ? { call: '1' } : {}),
          url: message.url
        }) };
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
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body) as Record<string, unknown>; } catch {
      if (['whatsapp', 'wecom-app', 'qq-bot', 'kook', 'fcm', 'expo', 'onesignal', 'resend', 'postmark', 'mailgun', 'brevo', 'aliyun-sms', 'tencent-sms', 'nextcloud-talk', 'jira-service-management'].includes(provider)) {
        throw new Error(`${provider} 未返回有效 JSON`);
      }
      return;
    }
    if (provider === 'whatsapp' && !Array.isArray(parsed.messages)) throw new Error(String((parsed.error as Record<string, unknown> | undefined)?.message ?? 'WhatsApp 未返回消息 ID'));
    if (provider === 'wecom-app' && Number(parsed.errcode) !== 0) throw new Error(String(parsed.errmsg ?? `企业微信返回错误码 ${parsed.errcode}`));
    if (provider === 'qq-bot' && !parsed.id) throw new Error(String(parsed.message ?? 'QQ 机器人未返回消息 ID'));
    if (provider === 'kook' && Number(parsed.code) !== 0) throw new Error(String(parsed.message ?? `KOOK 返回错误码 ${parsed.code}`));
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
