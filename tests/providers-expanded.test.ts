import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { PROVIDER_MAP, validateProviderConfig } from '../src/server/providers/catalog.js';
import { buildAliyunSmsRequest, buildTencentSmsRequest, ProviderDispatcher, type ProviderMessage } from '../src/server/providers/dispatcher.js';

const appConfig = { allowPrivateWebhooks: true, allowInsecureHttp: true } as AppConfig;
const message: ProviderMessage = { title: 'Database alert', body: 'CPU 95%', severity: 'critical', url: 'https://status.example.com/i/42', metadata: {} };
const responseFor = (url: string) => {
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
  it('publishes every new provider with a maintained documentation URL and support level', () => {
    const ids = ['whatsapp', 'signal', 'wecom-app', 'qq-bot', 'kook', 'fcm', 'expo', 'onesignal', 'sendgrid', 'resend', 'postmark', 'mailgun', 'brevo', 'aliyun-sms', 'tencent-sms', 'home-assistant', 'nextcloud-talk', 'alertmanager', 'jira-service-management'] as const;
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
  });
});

describe('expanded provider request contracts', () => {
  it('builds WhatsApp, Signal and KOOK requests', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: 200 })) as unknown as typeof fetch;
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
    }) as unknown as typeof fetch;
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
    }) as unknown as typeof fetch;
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
    }) as unknown as typeof fetch;
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
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: 200 })) as unknown as typeof fetch;
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
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: provider === 'sendgrid' ? 202 : 200 })) as unknown as typeof fetch;
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
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(responseFor(String(url))), { status: String(url).includes('atlassian') || String(url).includes('nextcloud') ? 201 : 200 })) as unknown as typeof fetch;
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
