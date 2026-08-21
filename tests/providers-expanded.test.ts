import { generateKeyPairSync } from 'node:crypto';
import type { MockFetch } from './helpers.js';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { PROVIDER_MAP, PROVIDERS, validateProviderConfig } from '../src/server/providers/catalog.js';
import { buildAliyunSmsRequest, buildAwsSnsRequest, buildTencentSmsRequest, ProviderDispatcher, type ProviderMessage } from '../src/server/providers/dispatcher.js';

const appConfig = { allowPrivateWebhooks: true, allowInsecureHttp: true } as AppConfig;
const message: ProviderMessage = { title: 'Database alert', body: 'CPU 95%', severity: 'critical', url: 'https://status.example.com/i/42', metadata: {} };
const responseFor = (url: string) => {
  if (url.includes('joinjoaomgcd.appspot.com')) return { success: true };
  if (url.includes('maker.ifttt.com')) return { success: true };
  if (url.includes('api.novu.co')) return { acknowledged: true, status: 'processed', transactionId: 'novu-1' };
  if (url.includes('api.knock.app')) return { workflow_run_id: 'knock-1' };
  if (url.includes('api.courier.com')) return { requestId: 'courier-1' };
  if (url.includes('iam.developer.honor.com')) return { access_token: 'honor-token', expires_in: 3600 };
  if (url.includes('push-api.cloud.hihonor.com')) return { code: '0', message: 'success', requestId: 'honor-1' };
  if (url.includes('oppomobile.com/server/v1/auth')) return { code: 0, message: 'success', data: { auth_token: 'oppo-token' } };
  if (url.includes('oppomobile.com/server/v1/message')) return { code: 0, message: 'success', data: [{ messageId: 'oppo-1' }] };
  if (url.includes('vivo.com.cn/message/auth')) return { result: 0, desc: '请求成功', authToken: 'vivo-token' };
  if (url.includes('vivo.com.cn/message/send')) return { result: 0, desc: '请求成功', taskId: 'vivo-1' };
  if (url.includes('server-api-push.meizu.com')) return { code: '200', message: '', value: {}, msgId: 'meizu-1' };
  if (url.includes('api.pushy.me')) return { success: true, id: 'pushy-1', info: { devices: 1 } };
  if (url.includes('pushsafer.com')) return { status: 1, request: 'pushsafer-1' };
  if (url.includes('simplepu.sh')) return { success: true };
  if (url.includes('oauth-login.cloud.huawei.com')) return { access_token: 'huawei-token', expires_in: 3600 };
  if (url.includes('push-api.cloud.huawei.com')) return { code: '80000000', msg: 'Success', requestId: 'huawei-1' };
  if (url.includes('xmpush.xiaomi.com')) return { result: 'ok', code: 0, description: '成功', data: { id: 'xiaomi-1' } };
  if (url.includes('api.jpush.cn')) return { sendno: '1', msg_id: 'jpush-1' };
  if (url.includes('restapi.getui.com') && url.endsWith('/auth')) return { code: 0, data: { token: 'getui-token', expire_time: String(Date.now() + 86_400_000) } };
  if (url.includes('restapi.getui.com')) return { code: 0, msg: 'SUCCESS', data: { taskid: 'getui-task' } };
  if (url.includes('pushnotifications.pusher.com')) return { publishId: 'pusher-1' };
  if (url.includes('pushpad.xyz')) return { id: 12345, scheduled: 1 };
  if (url.includes('rest.nexmo.com')) return { 'message-count': '1', messages: [{ status: '0', 'message-id': 'vonage-1' }] };
  if (url.includes('api.plivo.com')) return { message: 'message(s) queued', message_uuid: ['plivo-1'], api_id: 'plivo-api' };
  if (url.includes('api.telnyx.com')) return { data: { id: 'telnyx-1' } };
  if (url.includes('api.bird.com')) return { id: 'bird-1', status: 'accepted' };
  if (url.includes('infobip.com')) return { bulkId: 'bulk-1', messages: [{ messageId: 'info-1', status: { groupName: 'PENDING', description: 'accepted' } }] };
  if (url.includes('graph.facebook.com')) return { messages: [{ id: 'wamid.1' }] };
  if (url.includes('exp.host')) return { data: { status: 'ok', id: 'expo-1' } };
  if (url.includes('onesignal.com')) return { id: 'one-1' };
  if (url.includes('resend.com')) return { id: 'email-1' };
  if (url.includes('postmarkapp.com')) return { ErrorCode: 0, MessageID: 'postmark-1' };
  if (url.includes('mailgun.net')) return { id: '<mailgun-1>', message: 'Queued' };
  if (url.includes('brevo.com')) return { messageId: '<brevo-1>' };
  if (url.includes('aliyuncs.com')) return { Code: 'OK', BizId: 'ali-1' };
  if (url.includes('tencentcloudapi.com')) return { Response: { SendStatusSet: [{ Code: 'Ok', SerialNo: 'tc-1' }] } };
  if (url.includes('nextcloud')) return { ocs: { meta: { statuscode: 100, message: 'OK' }, data: { id: 1 } } };
  if (url.includes('atlassian.net')) return { issueKey: 'HELP-1' };
  if (url.includes('kookapp.cn')) return { code: 0, data: { msg_id: 'kook-1' } };
  return {};
};

describe('expanded provider catalog', () => {
  it('ships a local image asset for every provider', () => {
    const files = new Set(readdirSync(resolve(process.cwd(), 'src/web/assets/providers')).map((file) => file.replace(/\.(svg|png|ico)$/, '')));
    // 与 ProviderIcon 的 SLUG_OVERRIDES 同步：复用同品牌图的衍生渠道
    const overrides: Partial<Record<string, string>> = {
      'synology-chat': 'synology', 'slack-bot': 'slack', 'discord-bot': 'discord',
      'feishu-app': 'feishu', 'dingtalk-work': 'dingtalk', 'aws-ses': 'aws-sns', webpush: 'walkie'
    };
    for (const provider of PROVIDERS) expect(files.has(overrides[provider.id] ?? provider.id), provider.id).toBe(true);
  });

  it('publishes every new provider with a maintained documentation URL and support level', () => {
    const ids = ['join', 'ifttt', 'novu', 'knock', 'courier', 'honor-push', 'oppo-push', 'vivo-push', 'meizu-push', 'pushy', 'pushsafer', 'simplepush', 'huawei-push', 'xiaomi-push', 'jpush', 'getui', 'aws-sns', 'pusher-beams', 'pushpad', 'vonage-sms', 'plivo-sms', 'telnyx-sms', 'bird-sms', 'infobip-sms', 'whatsapp', 'signal', 'wecom-app', 'qq-bot', 'kook', 'fcm', 'expo', 'onesignal', 'sendgrid', 'resend', 'postmark', 'mailgun', 'brevo', 'aliyun-sms', 'tencent-sms', 'home-assistant', 'nextcloud-talk', 'alertmanager', 'jira-service-management'] as const;
    for (const id of ids) {
      const provider = PROVIDER_MAP.get(id);
      expect(provider, id).toBeDefined();
      expect(provider?.docsUrl, id).toMatch(/^https:\/\//);
      expect(provider?.support, id).toMatch(/^(native|gateway)$/);
      expect(provider?.fields.some((field) => field.required), id).toBe(true);
    }
  });

  it('rejects conditional and structured configuration errors', () => {
    expect(validateProviderConfig('whatsapp', { phoneNumberId: '1', accessToken: 'x', to: '+1', graphVersion: 'v25.0', mode: 'template' })).toContain('模板模式下模板名称不能为空');
    expect(validateProviderConfig('wecom-app', { corpId: 'c', secret: 's', agentId: '1' })).toContain('成员 ID、部门 ID 或标签 ID 至少填写一项');
    expect(validateProviderConfig('onesignal', { appId: 'a', apiKey: 'k' })).toContain('Subscription ID、External ID 或 Segment 至少填写一项');
    expect(validateProviderConfig('fcm', { serviceAccountJson: '{}', targetType: 'token', target: 't' })).toContain('服务账号 JSON 必须包含 project_id、client_email 和 private_key');
    expect(validateProviderConfig('aliyun-sms', { accessKeyId: 'a', accessKeySecret: 'b', phoneNumbers: '1', signName: 's', templateCode: 't', templateParam: '[]' })).toContain('模板参数必须是 JSON 对象');
    expect(validateProviderConfig('expo', { pushTokens: 'not-a-token' })).toContain('Expo Push Token 格式无效');
    expect(validateProviderConfig('xiaomi-push', { appSecret: 's', packageName: 'com.example', targetType: 'alias' })).toContain('非全量推送必须填写目标值');
    expect(validateProviderConfig('jpush', { appKey: 'a', masterSecret: 's', platform: 'all', targetType: 'alias' })).toContain('非全量推送必须填写目标');
    expect(validateProviderConfig('getui', { appId: 'a', appKey: 'k', masterSecret: 's', targetType: 'cid' })).toContain('非全量推送必须填写目标值');
    expect(validateProviderConfig('huawei-push', { appId: 'a', appSecret: 's', targetType: 'topic', targets: 'a\nb' })).toContain('Topic 或 Condition 只能填写一个目标');
    expect(validateProviderConfig('oppo-push', { appKey: 'a', masterSecret: 's', targetType: 'registrationId', targets: Array.from({ length: 1001 }, (_, index) => `id-${index}`).join('\n') })).toContain('OPPO Push 单次最多支持 1000 个目标');
    expect(validateProviderConfig('simplepush', { key: 'short' })).toContain('Simplepush Key 至少需要 6 个字符');
    expect(validateProviderConfig('novu', { server: 'https://api.novu.co', apiKey: 'k', workflowId: 'w', subscriberIds: Array.from({ length: 101 }, (_, index) => `s-${index}`).join('\n') })).toContain('Novu 单次最多支持 100 个 Subscriber');
    expect(validateProviderConfig('knock', { apiKey: 'k', workflowKey: 'w', recipients: Array.from({ length: 1001 }, (_, index) => `r-${index}`).join('\n') })).toContain('Knock 单次最多支持 1000 个 Recipient');
  });
});

describe('expanded provider request contracts', () => {
  it('builds WhatsApp, Signal and KOOK requests', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(appConfig, fetcher);
    await dispatcher.send('whatsapp', { phoneNumberId: '123', accessToken: 'meta-token', to: '+8613800000000', graphVersion: 'v25.0', mode: 'text' }, message);
    await dispatcher.send('signal', { server: 'https://signal.example.com', number: '+1000', recipients: '+2000\n+3000' }, message);
    await dispatcher.send('kook', { token: 'kook-token', targetId: 'channel-1' }, message);

    expect(String(fetcher.mock.calls[0][0])).toBe('https://graph.facebook.com/v25.0/123/messages');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer meta-token');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ messaging_product: 'whatsapp', to: '+8613800000000', type: 'text' });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({ number: '+1000', recipients: ['+2000', '+3000'] });
    expect(String(fetcher.mock.calls[2][0])).toContain('/api/v3/message/create');
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('authorization')).toBe('Bot kook-token');
  });

  it('gets and caches WeCom and QQ access tokens before sending', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.includes('gettoken')) return new Response(JSON.stringify({ errcode: 0, access_token: 'wecom-token', expires_in: 7200 }), { status: 200 });
      if (target.includes('getAppAccessToken')) return new Response(JSON.stringify({ access_token: 'qq-token', expires_in: '7200' }), { status: 200 });
      return new Response(JSON.stringify(target.includes('qyapi.weixin.qq.com') ? { errcode: 0, msgid: 'wx-1' } : { id: 'qq-1' }), { status: 200 });
    }) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(appConfig, fetcher);
    const wecom = { corpId: 'corp', secret: 'secret', agentId: '1001', toUser: '@all' };
    const qq = { appId: 'app', clientSecret: 'secret', targetType: 'channel', targetId: 'channel' };
    await dispatcher.send('wecom-app', wecom, message);
    await dispatcher.send('wecom-app', wecom, message);
    await dispatcher.send('qq-bot', qq, message);
    await dispatcher.send('qq-bot', qq, message);

    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('gettoken'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('getAppAccessToken'))).toHaveLength(1);
    const wecomSend = fetcher.mock.calls.find(([url]) => String(url).includes('/message/send'))!;
    expect(String(wecomSend[0])).toContain('access_token=wecom-token');
    const qqSend = fetcher.mock.calls.find(([url]) => String(url).includes('/channels/'))!;
    expect(new Headers(qqSend[1]?.headers).get('authorization')).toBe('QQBot qq-token');
  });

  it('coalesces concurrent token requests and retries after a failed token request', async () => {
    let tokenCalls = 0;
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.includes('gettoken')) {
        tokenCalls += 1;
        await Promise.resolve();
        if (tokenCalls === 1) return new Response(JSON.stringify({ errcode: 40013, errmsg: 'invalid corpid' }), { status: 200 });
        return new Response(JSON.stringify({ errcode: 0, access_token: 'wecom-token', expires_in: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ errcode: 0, msgid: 'wx-1' }), { status: 200 });
    }) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(appConfig, fetcher);
    const config = { corpId: 'corp', secret: 'secret', agentId: '1001', toUser: '@all' };

    await expect(Promise.all([dispatcher.send('wecom-app', config, message), dispatcher.send('wecom-app', config, message)])).rejects.toThrow('invalid corpid');
    expect(tokenCalls).toBe(1);
    await dispatcher.send('wecom-app', config, message);
    expect(tokenCalls).toBe(2);
  });

  it('mints an OAuth token and sends an FCM HTTP v1 notification', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const serviceAccountJson = JSON.stringify({ project_id: 'project-1', client_email: 'sender@project-1.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'fcm-access', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ name: 'projects/project-1/messages/1' }), { status: 200 });
    }) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(appConfig, fetcher);
    await dispatcher.send('fcm', { serviceAccountJson, targetType: 'topic', target: '/topics/ops' }, message);

    const tokenForm = fetcher.mock.calls[0][1]?.body as URLSearchParams;
    const claims = JSON.parse(Buffer.from(String(tokenForm.get('assertion')).split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: 'sender@project-1.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token' });
    expect(String(fetcher.mock.calls[1][0])).toBe('https://fcm.googleapis.com/v1/projects/project-1/messages:send');
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer fcm-access');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).message).toMatchObject({ topic: 'ops', notification: { title: 'Database alert', body: 'CPU 95%' } });
  });

  it('builds Expo and OneSignal push requests and surfaces ticket failures', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(appConfig, fetcher);
    await dispatcher.send('expo', { pushTokens: 'ExpoPushToken[token1]\nExponentPushToken[token2]', accessToken: 'expo-access' }, message);
    await dispatcher.send('onesignal', { appId: 'app-1', apiKey: 'rest-key', externalIds: 'user-1\nuser-2' }, message);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).to).toEqual(['ExpoPushToken[token1]', 'ExponentPushToken[token2]']);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer expo-access');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({ app_id: 'app-1', include_aliases: { external_id: ['user-1', 'user-2'] }, target_channel: 'push' });

    const failed = new ProviderDispatcher(appConfig, async () => new Response(JSON.stringify({ data: { status: 'error', message: 'DeviceNotRegistered' } }), { status: 200 }));
    await expect(failed.send('expo', { pushTokens: 'ExpoPushToken[token1]' }, message)).rejects.toThrow('DeviceNotRegistered');
  });

  it.each([
    ['sendgrid', { apiKey: 'sg', from: 'from@example.com', to: 'a@example.com,b@example.com' }, 'api.sendgrid.com', 'Bearer sg'],
    ['resend', { apiKey: 're', from: 'from@example.com', to: 'a@example.com' }, 'api.resend.com', 'Bearer re'],
    ['postmark', { serverToken: 'pm', from: 'from@example.com', to: 'a@example.com' }, 'api.postmarkapp.com', null],
    ['mailgun', { apiKey: 'mg', domain: 'mg.example.com', from: 'from@example.com', to: 'a@example.com', region: 'eu' }, 'api.eu.mailgun.net', null],
    ['brevo', { apiKey: 'br', from: 'from@example.com', to: 'a@example.com,b@example.com' }, 'api.brevo.com', null]
  ] as const)('builds the %s email API request', async (provider, config, host, authorization) => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: provider === 'sendgrid' ? 202 : 200 })) as unknown as MockFetch;
    await new ProviderDispatcher(appConfig, fetcher).send(provider, config, message);
    expect(String(fetcher.mock.calls[0][0])).toContain(host);
    if (authorization) expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe(authorization);
  });

  it('pins Alibaba Cloud and Tencent Cloud SMS signatures and payloads', () => {
    const aliyun = buildAliyunSmsRequest({ accessKeyId: 'testid', accessKeySecret: 'testsecret', phoneNumbers: '13800138000', signName: 'RelayDock', templateCode: 'SMS_1', templateParam: '{"message":"{{body}}"}', regionId: 'cn-hangzhou' }, message, 'nonce-1', new Date('2026-08-17T00:00:00Z'));
    const aliForm = aliyun.init.body as URLSearchParams;
    expect(aliForm.get('TemplateParam')).toBe('{"message":"CPU 95%"}');
    expect(aliForm.get('Signature')).toBe('9b4d1E36MIJpt61fXZpOJzJOCKg=');

    const tencent = buildTencentSmsRequest({ secretId: 'AKIDEXAMPLE', secretKey: 'SECRET', smsSdkAppId: '1400000000', phoneNumbers: '+8613800138000', signName: 'RelayDock', templateId: '1000', templateParams: '{{body}}', region: 'ap-guangzhou' }, message, 1786924800);
    expect(JSON.parse(String(tencent.init.body))).toMatchObject({ PhoneNumberSet: ['+8613800138000'], TemplateParamSet: ['CPU 95%'] });
    expect(new Headers(tencent.init.headers).get('authorization')).toBe('TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2026-08-17/sms/tc3_request, SignedHeaders=content-type;host, Signature=912562a78429c40fed21c7b2c0c8e8d06b04b05de875c4e8cdedfe30a13ffa53');
  });

  it('builds Home Assistant, Nextcloud Talk, Alertmanager and Jira requests', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: String(url).includes('atlassian') || String(url).includes('nextcloud') ? 201 : 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(appConfig, fetcher);
    await dispatcher.send('home-assistant', { server: 'https://home.example.com', accessToken: 'ha-token', service: 'mobile_app_phone' }, message);
    await dispatcher.send('nextcloud-talk', { server: 'https://nextcloud.example.com', username: 'bot', appPassword: 'pass', conversationToken: 'room' }, message);
    await dispatcher.send('alertmanager', { server: 'https://alerts.example.com', bearerToken: 'am-token' }, message);
    await dispatcher.send('jira-service-management', { site: 'https://example.atlassian.net', email: 'bot@example.com', apiToken: 'jira-token', serviceDeskId: '10', requestTypeId: '25' }, message);
    expect(String(fetcher.mock.calls[0][0])).toContain('/api/services/notify/mobile_app_phone');
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('ocs-apirequest')).toBe('true');
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))[0]).toMatchObject({ labels: { alertname: 'Database alert', severity: 'critical' } });
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toMatchObject({ serviceDeskId: '10', requestTypeId: '25', requestFieldValues: { summary: 'Database alert' } });
  });

  it('rejects logical failures returned with HTTP 200', async () => {
    const aliyun = new ProviderDispatcher(appConfig, async () => new Response(JSON.stringify({ Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: 'rate limited' }), { status: 200 }));
    await expect(aliyun.send('aliyun-sms', { accessKeyId: 'a', accessKeySecret: 'b', phoneNumbers: '1', signName: 's', templateCode: 't', templateParam: '{}' }, message)).rejects.toThrow('rate limited');
    const tencent = new ProviderDispatcher(appConfig, async () => new Response(JSON.stringify({ Response: { Error: { Code: 'AuthFailure', Message: 'bad signature' } } }), { status: 200 }));
    await expect(tencent.send('tencent-sms', { secretId: 'a', secretKey: 'b', smsSdkAppId: '1', phoneNumbers: '+1', signName: 's', templateId: 't' }, message)).rejects.toThrow('bad signature');
    const wecom = new ProviderDispatcher(appConfig, async (url) => new Response(JSON.stringify(String(url).includes('gettoken') ? { errcode: 0, access_token: 'token', expires_in: 7200 } : { errcode: 40014, errmsg: 'invalid access token' }), { status: 200 }));
    await expect(wecom.send('wecom-app', { corpId: 'c', secret: 's', agentId: '1', toUser: '@all' }, message)).rejects.toThrow('invalid access token');
    const kook = new ProviderDispatcher(appConfig, async () => new Response(JSON.stringify({ code: 40000, message: 'bad request' }), { status: 200 }));
    await expect(kook.send('kook', { token: 't', targetId: 'c' }, message)).rejects.toThrow('bad request');
    const malformed = new ProviderDispatcher(appConfig, async () => new Response('not json', { status: 200 }));
    await expect(malformed.send('kook', { token: 't', targetId: 'c' }, message)).rejects.toThrow('kook 未返回有效 JSON');
  });
});

describe('additional provider request contracts', () => {
  it('builds Join, IFTTT, Novu, Knock and Courier requests', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(appConfig, fetcher);
    await dispatcher.send('join', { apiKey: 'join-key', deviceIds: 'device-1\ndevice-2' }, message);
    await dispatcher.send('ifttt', { key: 'ifttt-key', event: 'database_alert' }, message);
    await dispatcher.send('novu', { server: 'https://api.novu.co', apiKey: 'novu-key', workflowId: 'database-alert', subscriberIds: 'user-1\nuser-2' }, message);
    await dispatcher.send('knock', { apiKey: 'knock-key', workflowKey: 'database-alert', recipients: 'user-1\nuser-2' }, message);
    await dispatcher.send('courier', { apiKey: 'courier-key', templateId: 'template-1', recipientType: 'user_id', recipient: 'user-1' }, message);

    const join = fetcher.mock.calls.find(([url]) => String(url).includes('joinjoaomgcd.appspot.com'))!;
    const joinParams = new URL(String(join[0])).searchParams;
    expect(joinParams.get('apikey')).toBe('join-key');
    expect(joinParams.get('deviceIds')).toBe('device-1,device-2');
    expect(joinParams.get('title')).toBe('Database alert');
    expect(joinParams.get('text')).toBe('CPU 95%');
    expect(joinParams.get('url')).toBe(message.url);
    const ifttt = fetcher.mock.calls.find(([url]) => String(url).includes('maker.ifttt.com'))!;
    expect(String(ifttt[0])).toContain('/trigger/database_alert/with/key/ifttt-key');
    expect(JSON.parse(String(ifttt[1]?.body))).toEqual({ value1: 'Database alert', value2: 'CPU 95%', value3: message.url });
    const novu = fetcher.mock.calls.find(([url]) => String(url).includes('api.novu.co'))!;
    expect(new Headers(novu[1]?.headers).get('authorization')).toBe('ApiKey novu-key');
    expect(JSON.parse(String(novu[1]?.body))).toMatchObject({ name: 'database-alert', to: ['user-1', 'user-2'], payload: { title: 'Database alert', body: 'CPU 95%', severity: 'critical' } });
    const knock = fetcher.mock.calls.find(([url]) => String(url).includes('api.knock.app'))!;
    expect(new Headers(knock[1]?.headers).get('authorization')).toBe('Bearer knock-key');
    expect(JSON.parse(String(knock[1]?.body))).toMatchObject({ recipients: ['user-1', 'user-2'], data: { title: 'Database alert', body: 'CPU 95%' } });
    const courier = fetcher.mock.calls.find(([url]) => String(url).includes('api.courier.com'))!;
    expect(new Headers(courier[1]?.headers).get('authorization')).toBe('Bearer courier-key');
    expect(JSON.parse(String(courier[1]?.body))).toMatchObject({ message: { to: { user_id: 'user-1' }, template: 'template-1', data: { title: 'Database alert', body: 'CPU 95%' } } });
  });

  it('surfaces logical failures from notification gateways', async () => {
    const cases: Array<[Parameters<ProviderDispatcher['send']>[0], Record<string, unknown>, string]> = [
      ['novu', { server: 'https://api.novu.co', apiKey: 'k', workflowId: 'w', subscriberIds: 's' }, 'Novu 失败'],
      ['knock', { apiKey: 'k', workflowKey: 'w', recipients: 'r' }, 'Knock 失败'],
      ['courier', { apiKey: 'k', templateId: 't', recipientType: 'user_id', recipient: 'r' }, 'Courier 失败']
    ];
    for (const [provider, config, error] of cases) {
      const failed = new ProviderDispatcher(appConfig, async (url) => {
        const target = String(url);
        if (provider === 'novu') return new Response(JSON.stringify({ acknowledged: false, status: 'error', error: [error] }), { status: 200 });
        if (provider === 'knock') return new Response(JSON.stringify({ error }), { status: 200 });
        return new Response(JSON.stringify({ message: error }), { status: 200 });
      });
      await expect(failed.send(provider, config, message)).rejects.toThrow(error);
    }
  });

  it('builds HONOR, OPPO, vivo, Meizu, Pushy, Pushsafer and Simplepush requests', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(appConfig, fetcher);
    await dispatcher.send('honor-push', { appId: 'honor-app', clientId: 'honor-client', clientSecret: 'honor-secret', targets: 'honor-token-1\nhonor-token-2' }, message);
    await dispatcher.send('oppo-push', { appKey: 'oppo-key', masterSecret: 'oppo-secret', targetType: 'registrationId', targets: 'oppo-token' }, message);
    await dispatcher.send('vivo-push', { appId: '10004', appKey: 'vivo-key', appSecret: 'vivo-secret', targetType: 'regId', target: 'vivo-token' }, message);
    await dispatcher.send('meizu-push', { appId: 'meizu-app', appSecret: 'meizu-secret', targetType: 'pushId', targets: 'meizu-token' }, message);
    await dispatcher.send('pushy', { apiKey: 'pushy-secret', targets: 'pushy-token' }, message);
    await dispatcher.send('pushsafer', { privateKey: 'pushsafer-key', device: '42' }, message);
    await dispatcher.send('simplepush', { key: 'simple-key', event: 'critical' }, message);

    const honor = fetcher.mock.calls.find(([url]) => String(url).includes('push-api.cloud.hihonor.com'))!;
    expect(String(honor[0])).toContain('/api/v1/honor-app/sendMessage');
    expect(new Headers(honor[1]?.headers).get('authorization')).toBe('Bearer honor-token');
    expect(JSON.parse(String(honor[1]?.body)).token).toEqual(['honor-token-1', 'honor-token-2']);

    const oppoAuth = fetcher.mock.calls.find(([url]) => String(url).endsWith('/server/v1/auth'))!;
    expect(String((oppoAuth[1]?.body as URLSearchParams).get('sign'))).toMatch(/^[a-f0-9]{64}$/);
    const oppo = fetcher.mock.calls.find(([url]) => String(url).includes('/unicast_batch'))!;
    expect(new Headers(oppo[1]?.headers).get('auth_token')).toBe('oppo-token');
    expect(JSON.parse(String((oppo[1]?.body as URLSearchParams).get('messages')))[0]).toMatchObject({ target_type: 2, target_value: 'oppo-token', notification: { title: 'Database alert' } });

    const vivoAuth = fetcher.mock.calls.find(([url]) => String(url).endsWith('/message/auth'))!;
    expect(JSON.parse(String(vivoAuth[1]?.body)).sign).toMatch(/^[a-f0-9]{32}$/);
    const vivo = fetcher.mock.calls.find(([url]) => String(url).endsWith('/message/send'))!;
    expect(new Headers(vivo[1]?.headers).get('authtoken')).toBe('vivo-token');
    expect(JSON.parse(String(vivo[1]?.body))).toMatchObject({ regId: 'vivo-token', skipType: 2, skipContent: message.url });

    const meizu = fetcher.mock.calls.find(([url]) => String(url).includes('server-api-push.meizu.com'))!;
    const meizuForm = meizu[1]?.body as URLSearchParams;
    expect(meizuForm.get('pushIds')).toBe('meizu-token');
    expect(meizuForm.get('sign')).toBe('7307a93165a96557a1fc06aa61ac7dd0');

    const pushy = fetcher.mock.calls.find(([url]) => String(url).includes('api.pushy.me'))!;
    expect(String(pushy[0])).toContain('api_key=pushy-secret');
    expect(JSON.parse(String(pushy[1]?.body))).toMatchObject({ to: 'pushy-token', data: { message: 'CPU 95%' }, notification: { title: 'Database alert' } });
    const pushsafer = fetcher.mock.calls.find(([url]) => String(url).includes('pushsafer.com'))!;
    expect((pushsafer[1]?.body as URLSearchParams).get('d')).toBe('42');
    const simplepush = fetcher.mock.calls.find(([url]) => String(url).includes('simplepu.sh'))!;
    expect(JSON.parse(String(simplepush[1]?.body))).toMatchObject({ key: 'simple-key', event: 'critical', msg: expect.stringContaining('CPU 95%') });
  });

  it('surfaces logical failures from the additional push providers', async () => {
    const cases: Array<[Parameters<ProviderDispatcher['send']>[0], Record<string, unknown>, string]> = [
      ['honor-push', { appId: 'a', clientId: 'c', clientSecret: 's', targets: 't' }, 'HONOR 失败'],
      ['oppo-push', { appKey: 'a', masterSecret: 's', targetType: 'registrationId', targets: 't' }, 'OPPO 失败'],
      ['vivo-push', { appId: '1', appKey: 'a', appSecret: 's', targetType: 'regId', target: 't' }, 'vivo 失败'],
      ['meizu-push', { appId: 'a', appSecret: 's', targetType: 'pushId', targets: 't' }, '魅族 Push 存在无效目标'],
      ['pushy', { apiKey: 'a', targets: 't' }, 'Pushy 失败'],
      ['pushsafer', { privateKey: 'a' }, 'Pushsafer 失败'],
      ['simplepush', { key: 'abcdef' }, 'Simplepush 失败']
    ];
    for (const [provider, config, error] of cases) {
      const dispatcher = new ProviderDispatcher(appConfig, async (url) => {
        const target = String(url);
        if (target.includes('iam.developer.honor.com')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
        if (target.endsWith('/server/v1/auth')) return new Response(JSON.stringify({ code: 0, data: { auth_token: 'token' } }), { status: 200 });
        if (target.endsWith('/message/auth')) return new Response(JSON.stringify({ result: 0, authToken: 'token' }), { status: 200 });
        const body = provider === 'honor-push' ? { code: 42, message: error }
          : provider === 'oppo-push' ? { code: 42, message: error }
            : provider === 'vivo-push' ? { result: 42, desc: error }
              : provider === 'meizu-push' ? { code: '200', value: { 110002: ['t'] } }
                : provider === 'pushy' ? { success: false, error }
                  : provider === 'pushsafer' ? { status: 0, error: [{ message: error }] }
                    : { success: false, error };
        return new Response(JSON.stringify(body), { status: 200 });
      });
      await expect(dispatcher.send(provider, config, message)).rejects.toThrow(error);
    }
  });

  it('builds Huawei, Xiaomi, JPush, Getui, Pusher Beams and Pushpad requests', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(appConfig, fetcher);
    await dispatcher.send('huawei-push', { appId: 'hms-app', appSecret: 'hms-secret', targetType: 'token', targets: 'hms-token' }, message);
    await dispatcher.send('xiaomi-push', { appSecret: 'mi-secret', packageName: 'com.example', targetType: 'alias', target: 'user-1' }, message);
    await dispatcher.send('jpush', { appKey: 'j-app', masterSecret: 'j-secret', platform: 'all', targetType: 'alias', targets: 'user-1' }, message);
    await dispatcher.send('getui', { appId: 'gt-app', appKey: 'gt-key', masterSecret: 'gt-secret', targetType: 'cid', target: 'cid-1' }, message);
    await dispatcher.send('pusher-beams', { instanceId: 'instance-1', secretKey: 'pusher-secret', targetType: 'interests', targets: 'ops\ncritical' }, message);
    await dispatcher.send('pushpad', { accessToken: 'pushpad-token', projectId: 'project-1', uids: 'user-1' }, message);

    expect(String(fetcher.mock.calls.find(([url]) => String(url).includes('push-api.cloud.huawei.com'))?.[0])).toContain('/v1/hms-app/messages:send');
    expect(new Headers(fetcher.mock.calls.find(([url]) => String(url).includes('push-api.cloud.huawei.com'))?.[1]?.headers).get('authorization')).toBe('Bearer huawei-token');
    expect(String(fetcher.mock.calls.find(([url]) => String(url).includes('xmpush.xiaomi.com'))?.[0])).toContain('/v3/message/alias');
    expect(new Headers(fetcher.mock.calls.find(([url]) => String(url).includes('api.jpush.cn'))?.[1]?.headers).get('authorization')).toMatch(/^Basic /);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('restapi.getui.com/v2/') && String(url).endsWith('/auth'))).toHaveLength(1);
    expect(new Headers(fetcher.mock.calls.find(([url]) => String(url).includes('/push/single/cid'))?.[1]?.headers).get('token')).toBe('getui-token');
    expect(String(fetcher.mock.calls.find(([url]) => String(url).includes('pushnotifications.pusher.com'))?.[0])).toContain('/publishes/interests');
    expect(new Headers(fetcher.mock.calls.find(([url]) => String(url).includes('pushpad.xyz'))?.[1]?.headers).get('authorization')).toBe('Bearer pushpad-token');
  });

  it('builds AWS SigV4, Vonage, Plivo, Telnyx, Bird and Infobip SMS requests', async () => {
    const aws = buildAwsSnsRequest({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', region: 'us-east-1', targetType: 'phoneNumber', target: '+15551234567', smsType: 'Transactional' }, message, new Date('2026-08-17T00:00:00Z'));
    expect(String(aws.url)).toBe('https://sns.us-east-1.amazonaws.com/');
    expect(String(aws.init.body)).toContain('Action=Publish');
    expect(new Headers(aws.init.headers).get('authorization')).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260817/us-east-1/sns/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=cb971f2b9c00fb63667ea62086a25c3a88c967339b19cc6d1d95ad2c9a991996');
    expect(new Headers(aws.init.headers).get('x-amz-date')).toBe('20260817T000000Z');

    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: String(url).includes('api.bird.com') ? 202 : 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(appConfig, fetcher);
    await dispatcher.send('vonage-sms', { apiKey: 'vonage-key', apiSecret: 'vonage-secret', from: 'RelayDock', to: '15551234567' }, message);
    await dispatcher.send('plivo-sms', { authId: 'MA123', authToken: 'plivo-secret', from: '+15551234567', to: '+15559876543' }, message);
    await dispatcher.send('telnyx-sms', { apiKey: 'telnyx-key', from: '+15551234567', to: '+15559876543' }, message);
    await dispatcher.send('bird-sms', { accessKey: 'bird-key', workspaceId: 'workspace-1', channelId: 'channel-1', to: '+15559876543' }, message);
    await dispatcher.send('infobip-sms', { baseUrl: 'https://example.api.infobip.com', apiKey: 'infobip-key', from: 'RelayDock', to: '+15559876543' }, message);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toMatch(/^Basic /);
    expect(String(fetcher.mock.calls[1][0])).toContain('/Account/MA123/Message/');
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('authorization')).toBe('Bearer telnyx-key');
    expect(new Headers(fetcher.mock.calls[3][1]?.headers).get('authorization')).toBe('AccessKey bird-key');
    expect(String(fetcher.mock.calls[4][0])).toBe('https://example.api.infobip.com/sms/3/messages');
  });

  it('surfaces logical failures from the new JSON providers', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['xiaomi-push', { appSecret: 's', packageName: 'p', targetType: 'all' }, '小米失败'],
      ['jpush', { appKey: 'a', masterSecret: 's', targetType: 'all', platform: 'all' }, 'JPush 失败'],
      ['getui', { appId: 'a', appKey: 'k', masterSecret: 's', targetType: 'all' }, '个推失败'],
      ['pusher-beams', { instanceId: 'i', secretKey: 's', targetType: 'interests', targets: 'ops' }, 'Pusher 失败']
    ];
    for (const [provider, config, error] of cases) {
      const failed = new ProviderDispatcher(appConfig, async (url) => {
        if (String(url).includes('restapi.getui.com') && String(url).endsWith('/auth')) return new Response(JSON.stringify({ code: 0, data: { token: 't', expire_time: String(Date.now() + 60_000) } }), { status: 200 });
        if (provider === 'xiaomi-push') return new Response(JSON.stringify({ code: 500, description: error }), { status: 200 });
        if (provider === 'jpush') return new Response(JSON.stringify({ error }), { status: 200 });
        if (provider === 'getui') return new Response(JSON.stringify({ code: 10001, msg: error }), { status: 200 });
        return new Response(JSON.stringify({ error }), { status: 200 });
      });
      await expect(failed.send(provider as never, config, message)).rejects.toThrow(error);
    }
  });
});
