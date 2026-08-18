import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { AppConfig } from '../src/server/config.js';
import { PROVIDERS } from '../src/server/providers/catalog.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import type { ProviderId } from '../src/shared/types.js';

// workerd（Cloudflare Workers 运行时）的 fetch 会校验 redirect 取值，只接受 follow/manual；
// 传 Node/undici 独有的 'error' 会直接抛 TypeError（线上报错原文），所有 HTTP 渠道全军覆没。
// 本文件用复刻该校验的 fetcher 把全部渠道跑一遍，防止运行时差异再次回归。
const INVALID_REDIRECT = 'Invalid redirect value, must be one of "follow" or "manual"';

const config = { allowPrivateWebhooks: true, allowInsecureHttp: true } as AppConfig;

// SMTP 走 nodemailer 而非 fetcher，这里 mock 掉以纳入矩阵
const transportMock = { sendMail: vi.fn(async () => ({ messageId: '<smtp@walkie>' })) };
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => transportMock) } }));

const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccountJson = JSON.stringify({
  project_id: 'walkie-test',
  client_email: 'push@walkie-test.iam.gserviceaccount.com',
  private_key: rsaKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
});

// 二段式渠道的 token 端点响应（按 URL 路由）
const TOKEN_BODIES: Array<[RegExp, string]> = [
  [/qyapi\.weixin\.qq\.com\/cgi-bin\/gettoken/, '{"access_token":"t","expires_in":7200}'],
  [/api\.bot\.qq\.com\/app\/getAppAccessToken/, '{"access_token":"t","expires_in":7200}'],
  [/oauth-login\.cloud\.huawei\.com/, '{"access_token":"t","expires_in":3600}'],
  [/iam\.developer\.honor\.com/, '{"access_token":"t","expires_in":3600}'],
  [/api\.push\.oppomobile\.com\/server\/v1\/auth/, '{"code":0,"data":{"auth_token":"t"}}'],
  [/api-push\.vivo\.com\.cn\/message\/auth/, '{"result":0,"authToken":"t"}'],
  [/restapi\.getui\.com\/v2\/[^/]+\/auth/, `{"code":0,"data":{"token":"t","expire_time":${Date.now() + 3_600_000}}}`],
  [/oauth2\.googleapis\.com\/token/, '{"access_token":"t","expires_in":3600}']
];

// assertProviderResponse 里逐渠道的成功判定所需的最小响应体；缺省 '{}' 即可通过通用校验
const SUCCESS_BODIES: Partial<Record<ProviderId, string>> = {
  'aws-sns': '<MessageId>arn:aws:sns:us-east-1:000000000000:topic</MessageId>',
  novu: '{"data":{"acknowledged":true,"status":"processed"}}',
  knock: '{"workflow_run_id":"run-1"}',
  courier: '{"requestId":"req-1"}',
  'honor-push': '{"code":0}',
  'oppo-push': '{"code":0}',
  'vivo-push': '{"result":0}',
  'meizu-push': '{"code":200,"value":""}',
  pushy: '{"success":true,"id":"pushy-1"}',
  pushsafer: '{"status":1}',
  simplepush: '{"success":true}',
  'huawei-push': '{"code":"80000000"}',
  'xiaomi-push': '{"code":0,"result":"ok"}',
  jpush: '{"msg_id":1}',
  getui: '{"code":0}',
  'pusher-beams': '{"publishId":"pub-1"}',
  pushpad: '{"id":1}',
  'vonage-sms': '{"messages":[{"status":"0"}]}',
  'plivo-sms': '{"message_uuid":["uuid-1"]}',
  'telnyx-sms': '{"data":{"id":"msg-1"}}',
  'bird-sms': '{"id":"msg-1","status":"accepted"}',
  'infobip-sms': '{"messages":[{"status":{"groupName":"DELIVERED"}}]}',
  whatsapp: '{"messages":[{"id":"wamid-1"}]}',
  'wecom-app': '{"errcode":0}',
  'qq-bot': '{"id":"msg-1"}',
  kook: '{"code":0}',
  fcm: '{"name":"projects/walkie-test/messages/1"}',
  resend: '{"id":"email-1"}',
  mailgun: '{"id":"<email-1@walkie>"}',
  brevo: '{"messageId":"<email-1@walkie>"}',
  'jira-service-management': '{"issueKey":"JSM-1"}',
  onesignal: '{"id":"notif-1"}',
  expo: '{"data":[{"status":"ok"}]}',
  'aliyun-sms': '{"Code":"OK"}',
  'tencent-sms': '{"Response":{"SendStatusSet":[{"Code":"Ok"}]}}',
  'nextcloud-talk': '{"ocs":{"meta":{"statuscode":100}}}',
  onebot: '{"status":"ok","retcode":0}',
  'synology-chat': '{"success":true}',
  pushover: '{"status":1}',
  rocketchat: '{"success":true}'
};

// 每个渠道能走到 fetch 的最小配置（跳过 catalog 的表单校验，专注传输层兼容）
const MINIMAL_CONFIGS: Record<ProviderId, Record<string, unknown>> = {
  telegram: { botToken: 'bot-token', chatId: '-1001234' },
  bark: { server: 'https://api.day.app', deviceKey: 'dk' },
  wecom: { key: 'wecom-key' },
  feishu: { webhookUrl: 'https://open.feishu.cn/hook/x' },
  dingtalk: { accessToken: 'at', secret: 'sec' },
  'wecom-app': { corpId: 'corp', secret: 'sec', agentId: '1000002', toUser: '@all' },
  serverchan: { sendKey: 'sctp1234tabcdef' },
  ntfy: { server: 'https://ntfy.sh', topic: 'walkie' },
  pushplus: { token: 'pp-token' },
  wxpusher: { appToken: 'AT_x', uids: 'UID_a' },
  discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x' },
  slack: { webhookUrl: 'https://hooks.slack.com/services/x' },
  pushover: { apiToken: 'at', userKey: 'uk' },
  gotify: { server: 'https://gotify.example.com', token: 'At' },
  pushdeer: { server: 'https://api2.pushdeer.com', pushKey: 'pd' },
  chanify: { server: 'https://api.chanify.net', token: 'ct' },
  pushme: { server: 'https://push.i-i.me', pushKey: 'pm' },
  xizhi: { key: 'xz-key' },
  qmsg: { key: 'qmsg-key' },
  pushbullet: { accessToken: 'pb-token' },
  smtp: { host: 'smtp.example.com', port: 587, from: 'a@example.com', to: 'b@example.com' },
  apprise: { server: 'https://apprise.example.com', configKey: 'saved' },
  webhook: { url: 'https://hooks.example.com/in', method: 'POST', bodyTemplate: '{"t":"{{title}}"}' },
  onebot: { server: 'http://127.0.0.1:3000', userId: '42' },
  'qq-bot': { appId: 'app', clientSecret: 'sec', targetId: 'chan', targetType: 'channel' },
  kook: { token: 'bot-token', targetId: 'chan' },
  teams: { webhookUrl: 'https://outlook.office.com/webhook/x' },
  'google-chat': { webhookUrl: 'https://chat.googleapis.com/x' },
  whatsapp: { phoneNumberId: 'pn', accessToken: 'at', to: '+8613800000000', mode: 'text' },
  line: { channelAccessToken: 'at', to: 'U123' },
  signal: { server: 'http://signal-api:8080', number: '+1000', recipients: '+2000' },
  matrix: { homeserver: 'https://matrix.example.com', accessToken: 'at', roomId: '!r:e.com' },
  mattermost: { webhookUrl: 'https://mm.example.com/hooks/x' },
  rocketchat: { webhookUrl: 'https://rc.example.com/hooks/x' },
  zulip: { site: 'https://example.zulipchat.com', email: 'b@e.com', apiKey: 'ak', stream: 's', topic: 't' },
  webex: { accessToken: 'at', roomId: 'room' },
  'nextcloud-talk': { server: 'https://nc.example.com', username: 'u', appPassword: 'ap', conversationToken: 'ct' },
  'synology-chat': { webhookUrl: 'https://nas.example.com/webapi/x' },
  resend: { apiKey: 'ak', from: 'a@e.com', to: 'b@e.com' },
  sendgrid: { apiKey: 'ak', from: 'a@e.com', to: 'b@e.com' },
  mailgun: { apiKey: 'key-x', domain: 'mg.example.com', from: 'a@e.com', to: 'b@e.com' },
  postmark: { serverToken: 'st', from: 'a@e.com', to: 'b@e.com' },
  brevo: { apiKey: 'ak', from: 'a@e.com', to: 'b@e.com' },
  twilio: { accountSid: 'ACx', authToken: 'at', from: '+1000', to: '+2000' },
  'vonage-sms': { apiKey: 'ak', apiSecret: 'as', from: 'Vonage', to: '+2000' },
  'aliyun-sms': { accessKeyId: 'ak', accessKeySecret: 'as', phoneNumbers: '+8613800000000', signName: 's', templateCode: 'SMS_1', templateParam: '{"code":"{{title}}"}' },
  'tencent-sms': { secretId: 'si', secretKey: 'sk', smsSdkAppId: '1400000000', phoneNumbers: '+8613800000000', signName: 's', templateId: '1' },
  'plivo-sms': { authId: 'ai', authToken: 'at', from: '+1000', to: '+2000' },
  'telnyx-sms': { apiKey: 'ak', from: '+1000', to: '+2000' },
  'bird-sms': { accessKey: 'ak', workspaceId: 'w', channelId: 'c', to: '+2000' },
  'infobip-sms': { baseUrl: 'https://xxxx.api.infobip.com', apiKey: 'ak', from: 'Info', to: '+2000' },
  'home-assistant': { server: 'https://ha.example.com', accessToken: 'at', service: 'notify' },
  alertmanager: { server: 'https://am.example.com' },
  pagerduty: { routingKey: 'rk' },
  'jira-service-management': { site: 'https://example.atlassian.net', email: 'e@x.com', apiToken: 'at', serviceDeskId: '1', requestTypeId: '2' },
  'aws-sns': { accessKeyId: 'ak', secretAccessKey: 'sk', region: 'us-east-1', targetType: 'topicArn', target: 'arn:aws:sns:us-east-1:0:t' },
  ifttt: { key: 'ifttt-key', event: 'evt' },
  join: { apiKey: 'ak', deviceIds: 'dev1' },
  novu: { apiKey: 'ak', workflowId: 'wf', subscriberIds: 'sub1' },
  knock: { apiKey: 'ak', workflowKey: 'wf', recipients: 'r1' },
  courier: { apiKey: 'ak', templateId: 'tpl', recipient: 'r1' },
  fcm: { serviceAccountJson, target: 'device-token' },
  expo: { pushTokens: 'ExponentPushToken[x]' },
  onesignal: { appId: 'app', apiKey: 'ak', segment: 'seg' },
  pushy: { apiKey: 'ak', targets: 'dev1' },
  pushsafer: { privateKey: 'pk' },
  simplepush: { key: 'sp-key' },
  'pusher-beams': { instanceId: 'abc-123', secretKey: 'sk', targets: 'interest' },
  pushpad: { accessToken: 'at', projectId: '1' },
  'huawei-push': { appId: 'app', appSecret: 'as', targets: 'tok1' },
  'xiaomi-push': { appSecret: 'as', packageName: 'com.x', targetType: 'regid', target: 'reg1' },
  'oppo-push': { appKey: 'ak', masterSecret: 'ms', targets: 'reg1' },
  'vivo-push': { appId: '1', appKey: 'ak', appSecret: 'as', target: 'reg1' },
  'meizu-push': { appId: '1', appSecret: 'as', targets: 'p1' },
  'honor-push': { appId: 'app', clientId: 'cid', clientSecret: 'cs', targets: 'tok1' },
  jpush: { appKey: 'ak', masterSecret: 'ms', targets: 'reg1' },
  getui: { appId: 'app', appKey: 'ak', masterSecret: 'ms', target: 'cid1' }
};

const message = { title: '兼容性验证', body: 'workerd 渠道矩阵测试', severity: 'info', url: 'https://example.com/r', metadata: {} };

function makeWorkerdFetch(provider: ProviderId, calls: Array<{ url: string; init: RequestInit | undefined }>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input instanceof Request ? input.url : input), init });
    const redirect = init?.redirect;
    if (redirect !== undefined && redirect !== 'follow' && redirect !== 'manual') throw new TypeError(INVALID_REDIRECT);
    const url = calls[calls.length - 1].url;
    for (const [pattern, body] of TOKEN_BODIES) if (pattern.test(url)) return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(SUCCESS_BODIES[provider] ?? '{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('workerd 渠道兼容矩阵', () => {
  it('全部 77 个渠道的发送请求都能通过 workerd 的 fetch 参数校验', async () => {
    const failures: string[] = [];
    expect(Object.keys(MINIMAL_CONFIGS).length).toBe(PROVIDERS.length);
    for (const provider of PROVIDERS) {
      const configForProvider = MINIMAL_CONFIGS[provider.id];
      if (!configForProvider) { failures.push(`${provider.id}: 测试矩阵缺少最小配置`); continue; }
      const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
      const dispatcher = new ProviderDispatcher(config, makeWorkerdFetch(provider.id, calls) as unknown as typeof fetch);
      try {
        await dispatcher.send(provider.id, configForProvider, message);
        if (provider.id !== 'smtp' && !calls.length) failures.push(`${provider.id}: 没有发出任何 fetch 请求`);
      } catch (error) {
        failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('manual 模式下 3xx 重定向仍按失败处理（SSRF 防重定向语义不回归）', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/x' } })) as unknown as typeof fetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await expect(dispatcher.send('telegram', MINIMAL_CONFIGS.telegram!, message)).rejects.toThrow('HTTP 302');
  });
});

describe('pushsafer 错误响应健壮性', () => {
  it('error 为字符串时给出可读错误而不是 TypeError', async () => {
    const fetcher = vi.fn(async () => new Response('{"status":0,"error":"Invalid key"}', { status: 200 })) as unknown as typeof fetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await expect(dispatcher.send('pushsafer', MINIMAL_CONFIGS['pushsafer']!, message)).rejects.toThrow('Invalid key');
  });
});
