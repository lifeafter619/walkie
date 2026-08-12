import { createHmac, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { ProviderId, Severity } from '../../shared/types.js';
import type { AppConfig } from '../config.js';
import { safeFetch } from './network.js';

export interface ProviderMessage {
  title: string;
  body: string;
  severity: Severity;
  url?: string;
  metadata: Record<string, unknown>;
}

export interface ProviderResult { responseCode?: number; response?: string }

const string = (config: Record<string, unknown>, key: string) => String(config[key] ?? '');
const text = (message: ProviderMessage) => `${message.title}\n\n${message.body}${message.url ? `\n\n${message.url}` : ''}`;
const markdown = (message: ProviderMessage) => `**${message.title}**\n\n${message.body}${message.url ? `\n\n[查看详情](${message.url})` : ''}`;
const color: Record<Severity, string> = { info: '#267365', success: '#178458', warning: '#b26b16', critical: '#b83b32' };

function renderTemplate(template: string, message: ProviderMessage): string {
  const values: Record<string, unknown> = { ...message.metadata, title: message.title, body: message.body, content: message.body, severity: message.severity, url: message.url ?? '' };
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_, key: string) => {
    const value = values[key];
    return typeof value === 'string' ? value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') : JSON.stringify(value ?? '');
  });
}

export class ProviderDispatcher {
  constructor(private readonly appConfig: AppConfig, private readonly fetcher: typeof fetch = fetch) {}

  async send(provider: ProviderId, config: Record<string, unknown>, message: ProviderMessage): Promise<ProviderResult> {
    if (provider === 'smtp') return this.sendSmtp(config, message);
    const request = this.buildRequest(provider, config, message);
    const result = await safeFetch(request.url, request.init, this.appConfig, this.fetcher);
    return { responseCode: result.status, response: result.body };
  }

  private json(body: unknown, headers: Record<string, string> = {}): RequestInit {
    return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
  }

  private buildRequest(provider: ProviderId, config: Record<string, unknown>, message: ProviderMessage): { url: string; init: RequestInit } {
    const bodyText = text(message);
    switch (provider) {
      case 'telegram':
        return { url: `https://api.telegram.org/bot${string(config, 'botToken')}/sendMessage`, init: this.json({ chat_id: string(config, 'chatId'), text: bodyText, disable_notification: Boolean(config.disableNotification) }) };
      case 'wecom':
        return { url: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(string(config, 'key'))}`, init: this.json({ msgtype: 'markdown', markdown: { content: markdown(message) } }) };
      case 'feishu': {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const secret = string(config, 'secret');
        const signature = secret ? createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64') : undefined;
        return { url: string(config, 'webhookUrl'), init: this.json({ ...(signature ? { timestamp, sign: signature } : {}), msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: message.title }, template: message.severity === 'critical' ? 'red' : message.severity === 'warning' ? 'orange' : 'green' }, elements: [{ tag: 'markdown', content: `${message.body}${message.url ? `\n[查看详情](${message.url})` : ''}` }] } }) };
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
        return { url: string(config, 'webhookUrl'), init: this.json({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: message.title, weight: 'Bolder', wrap: true }, { type: 'TextBlock', text: message.body, wrap: true }], actions: message.url ? [{ type: 'Action.OpenUrl', title: '查看详情', url: message.url }] : [] } }] }) };
      case 'google-chat':
        return { url: string(config, 'webhookUrl'), init: this.json({ text: `*${message.title}*\n${message.body}${message.url ? `\n<${message.url}|查看详情>` : ''}` }) };
      case 'mattermost':
      case 'rocketchat':
        return { url: string(config, 'webhookUrl'), init: this.json({ text: markdown(message) }) };
      case 'ntfy':
        return { url: `${string(config, 'server').replace(/\/$/, '')}/${encodeURIComponent(string(config, 'topic'))}`, init: { method: 'POST', headers: { Title: message.title, Priority: message.severity === 'critical' ? 'urgent' : message.severity === 'warning' ? 'high' : 'default', ...(message.url ? { Click: message.url } : {}), ...(config.token ? { Authorization: `Bearer ${string(config, 'token')}` } : {}) }, body: message.body } };
      case 'gotify':
        return { url: `${string(config, 'server').replace(/\/$/, '')}/message?token=${encodeURIComponent(string(config, 'token'))}`, init: this.json({ title: message.title, message: message.body, priority: Number(config.priority ?? 5), extras: message.url ? { 'client::notification': { click: { url: message.url } } } : undefined }) };
      case 'pushover': {
        const form = new URLSearchParams({ token: string(config, 'apiToken'), user: string(config, 'userKey'), title: message.title, message: message.body, priority: message.severity === 'critical' ? '1' : '0' });
        if (config.device) form.set('device', string(config, 'device'));
        if (message.url) { form.set('url', message.url); form.set('url_title', '查看详情'); }
        return { url: 'https://api.pushover.net/1/messages.json', init: { method: 'POST', body: form } };
      }
      case 'pushbullet':
        return { url: 'https://api.pushbullet.com/v2/pushes', init: this.json({ type: message.url ? 'link' : 'note', title: message.title, body: message.body, url: message.url, device_iden: config.deviceIden || undefined }, { 'Access-Token': string(config, 'accessToken') }) };
      case 'bark':
        return { url: `${string(config, 'server').replace(/\/$/, '')}/push`, init: this.json({ device_key: string(config, 'deviceKey'), title: message.title, body: message.body, group: string(config, 'group') || 'RelayDock', level: message.severity === 'critical' ? 'timeSensitive' : 'active', url: message.url }) };
      case 'serverchan': {
        const sendKey = string(config, 'sendKey');
        const desp = `${message.body}${message.url ? `\n\n${message.url}` : ''}`;
        // Server酱³ sendkey 形如 sctp{uid}t...，走 {uid}.push.ft07.com；否则走 Turbo sctapi.ftqq.com
        const sc3 = /^sctp(\d+)t/.exec(sendKey);
        if (sc3) {
          const tags = typeof message.metadata.tags === 'string' && message.metadata.tags ? message.metadata.tags : `RelayDock|${message.severity}`;
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
        const endpoint = `${string(config, 'server').replace(/\/$/, '')}/notify`;
        return { url: endpoint, init: this.json({ title: message.title, body: message.body, type: message.severity === 'critical' ? 'failure' : message.severity === 'warning' ? 'warning' : message.severity === 'success' ? 'success' : 'info', ...(config.configKey ? { key: config.configKey } : { urls: string(config, 'urls').split(/\r?\n/).filter(Boolean) }) }) };
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
      default:
        throw new Error(`不支持的渠道类型: ${provider}`);
    }
  }

  private async sendSmtp(config: Record<string, unknown>, message: ProviderMessage): Promise<ProviderResult> {
    const transporter = nodemailer.createTransport({
      host: string(config, 'host'), port: Number(config.port ?? 587), secure: Boolean(config.secure),
      auth: config.username ? { user: string(config, 'username'), pass: string(config, 'password') } : undefined,
      connectionTimeout: 12_000, socketTimeout: 12_000
    });
    const info = await transporter.sendMail({ from: string(config, 'from'), to: string(config, 'to'), subject: message.title, text: text(message) });
    return { responseCode: 250, response: String(info.messageId) };
  }
}
