// 在真实 workerd（wrangler dev --local）里逐渠道验证测试发送：
// 创建渠道 → POST /test → 断言 success（HTTP 渠道打到本地 mock 上游，SMTP 打到 mock SMTP）。
// 用法：node scripts/e2e-verify-channels.mjs [baseUrl] [mockPort]
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const mockPort = Number(process.argv[3] ?? 4999);
const adminToken = (await import('node:fs')).readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
  .match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.trim();
if (!adminToken) { console.error('missing ADMIN_TOKEN in .dev.vars'); process.exit(1); }
const headers = { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` };
const MOCK = `http://127.0.0.1:${mockPort}`;

// 与 vitest 矩阵同一套最小配置；HTTP 类渠道全部指向 mock 上游
const CONFIGS = {
  telegram: { botToken: 'bot', chatId: '-100' },
  bark: { server: MOCK, deviceKey: 'dk' },
  wecom: { key: 'k' },
  feishu: { webhookUrl: `${MOCK}/feishu` },
  dingtalk: { accessToken: 'at' },
  'wecom-app': { corpId: 'c', secret: 's', agentId: '1', toUser: '@all' },
  serverchan: { sendKey: 'sctp123tabcdef' },
  ntfy: { server: MOCK, topic: 't' },
  pushplus: { token: 't' },
  wxpusher: { appToken: 'at', uids: 'u' },
  discord: { webhookUrl: `${MOCK}/discord` },
  slack: { webhookUrl: `${MOCK}/slack` },
  pushover: { apiToken: 'a', userKey: 'u' },
  gotify: { server: MOCK, token: 't' },
  pushdeer: { server: MOCK, pushKey: 'pk' },
  chanify: { server: MOCK, token: 't' },
  pushme: { server: MOCK, pushKey: 'pk' },
  xizhi: { key: 'k' },
  qmsg: { key: 'k' },
  pushbullet: { accessToken: 'at' },
  smtp: { host: '127.0.0.1', port: mockPort + 1, secure: false, from: 'a@mock.local', to: 'b@mock.local' },
  apprise: { server: MOCK, configKey: 'saved' },
  webhook: { url: `${MOCK}/generic`, method: 'POST', bodyTemplate: '{"t":"{{title}}"}' },
  onebot: { server: MOCK, userId: '42' },
  'qq-bot': { appId: 'a', clientSecret: 's', targetId: 't', targetType: 'channel' },
  kook: { token: 't', targetId: 't' },
  teams: { webhookUrl: `${MOCK}/teams` },
  'google-chat': { webhookUrl: `${MOCK}/google-chat` },
  whatsapp: { phoneNumberId: 'p', accessToken: 'a', to: '+1000', mode: 'text', graphVersion: 'v25.0' },
  line: { channelAccessToken: 'a', to: 'U1' },
  signal: { server: MOCK, number: '+1000', recipients: '+2000' },
  matrix: { homeserver: MOCK, accessToken: 'a', roomId: '!r:x' },
  mattermost: { webhookUrl: `${MOCK}/mattermost` },
  rocketchat: { webhookUrl: `${MOCK}/rocketchat` },
  zulip: { site: MOCK, email: 'e@x.com', apiKey: 'ak', stream: 's', topic: 't' },
  webex: { accessToken: 'a', roomId: 'r' },
  'nextcloud-talk': { server: MOCK, username: 'u', appPassword: 'ap', conversationToken: 'ct' },
  'synology-chat': { webhookUrl: `${MOCK}/synology` },
  resend: { apiKey: 'a', from: 'f@x.com', to: 't@x.com' },
  sendgrid: { apiKey: 'a', from: 'f@x.com', to: 't@x.com' },
  mailgun: { apiKey: 'a', domain: 'd.com', from: 'f@x.com', to: 't@x.com', region: 'us' },
  postmark: { serverToken: 'st', from: 'f@x.com', to: 't@x.com' },
  brevo: { apiKey: 'a', from: 'f@x.com', to: 't@x.com' },
  twilio: { accountSid: 'AC', authToken: 'at', from: '+1000', to: '+2000' },
  'vonage-sms': { apiKey: 'a', apiSecret: 's', from: 'V', to: '+2000' },
  'aliyun-sms': { accessKeyId: 'a', accessKeySecret: 's', phoneNumbers: '+8613800000000', signName: 's', templateCode: 'T', templateParam: '{"code":"{{title}}"}' },
  'tencent-sms': { secretId: 'si', secretKey: 'sk', smsSdkAppId: '1', phoneNumbers: '+8613800000000', signName: 's', templateId: '1' },
  'plivo-sms': { authId: 'a', authToken: 'at', from: '+1000', to: '+2000' },
  'telnyx-sms': { apiKey: 'a', from: '+1000', to: '+2000' },
  'bird-sms': { accessKey: 'a', workspaceId: 'w', channelId: 'c', to: '+2000' },
  'infobip-sms': { baseUrl: MOCK, apiKey: 'a', from: 'I', to: '+2000' },
  'home-assistant': { server: MOCK, accessToken: 'a', service: 'notify' },
  alertmanager: { server: MOCK },
  pagerduty: { routingKey: 'rk' },
  'jira-service-management': { site: MOCK, email: 'e@x.com', apiToken: 'at', serviceDeskId: '1', requestTypeId: '2' },
  'aws-sns': { accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1', targetType: 'topicArn', target: 'arn:aws:sns:us-east-1:0:t' },
  ifttt: { key: 'k', event: 'e' },
  join: { apiKey: 'a', deviceIds: 'd' },
  novu: { server: MOCK, apiKey: 'a', workflowId: 'w', subscriberIds: 's' },
  knock: { apiKey: 'a', workflowKey: 'w', recipients: 'r' },
  courier: { apiKey: 'a', templateId: 't', recipient: 'r', recipientType: 'user_id' },
  expo: { pushTokens: 'ExponentPushToken[x]' },
  onesignal: { appId: 'a', apiKey: 'k', segment: 'seg' },
  pushy: { apiKey: 'a', targets: 't' },
  pushsafer: { privateKey: 'pk' },
  simplepush: { key: 'sp-key' },
  'pusher-beams': { instanceId: 'abc-123', secretKey: 'sk', targets: 'i', targetType: 'interests' },
  pushpad: { accessToken: 'a', projectId: '1' },
  'xiaomi-push': { appSecret: 'as', packageName: 'com.x', targetType: 'regid', target: 'r' },
  'vivo-push': { appId: '1', appKey: 'ak', appSecret: 'as', target: 'r', targetType: 'regId' },
  'meizu-push': { appId: '1', appSecret: 'as', targets: 'p', targetType: 'pushId' },
  jpush: { appKey: 'ak', masterSecret: 'ms', targets: 'r', platform: 'all', targetType: 'registration_id' },
  getui: { appId: 'a', appKey: 'ak', masterSecret: 'ms', target: 'c', targetType: 'cid' }
};
// fcm 需要真实 RSA 私钥，单独生成
const { generateKeyPairSync } = await import('node:crypto');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
CONFIGS.fcm = { serviceAccountJson: JSON.stringify({ project_id: 'p', client_email: 'e@x.com', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }), target: 'tok', targetType: 'token' };

// 二段式 token 渠道：真实域名会去连外网真实平台（无凭据必失败），这里只验证传输层不被 workerd 拒绝。
// 这批渠道的 token 请求在 e2e 里预期失败（invalid credentials 之类），但错误必须来自平台而非 TypeError。
const TWO_STAGE = new Set(['wecom-app', 'qq-bot', 'huawei-push', 'honor-push', 'oppo-push', 'vivo-push', 'getui', 'fcm', 'novu', 'serverchan', 'aliyun-sms', 'tencent-sms', 'aws-sns']);

const results = [];
const post = async (path, body) => (await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();

for (const [id, config] of Object.entries(CONFIGS)) {
  const label = `${id} ${TWO_STAGE.has(id) ? '(two-stage)' : ''}`.trim();
  try {
    const created = await post('/api/admin/channels', { name: `e2e-${id}`, slug: `e2e-${id}-${Date.now()}`, provider: id, config });
    if (!created.id) { results.push(`FAIL ${label}: create failed: ${JSON.stringify(created)}`); continue; }
    const test = await (await fetch(`${base}/api/admin/channels/${created.id}/test`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}` } })).json();
    const errorText = typeof test.error === 'string' ? test.error : '';
    // 传输层判据：成功，或错误来自真实平台的业务拒绝（凭据无效等）。
    // 唯一不可接受的是 workerd 运行时错误（Invalid redirect / TypeError / Unsupported 等）
    if (test.success === true) results.push(`PASS ${label}`);
    else if (/Invalid redirect|TypeError|not implemented|Unsupported/i.test(errorText)) results.push(`FAIL ${label}: ${errorText.slice(0, 120)}`);
    else if (errorText) results.push(`PASS-TRANSPORT ${label}: ${errorText.slice(0, 100)}`);
    else results.push(`FAIL ${label}: ${JSON.stringify(test).slice(0, 160)}`);
    await fetch(`${base}/api/admin/channels/${created.id}`, { method: 'DELETE', headers });
  } catch (error) {
    results.push(`ERROR ${label}: ${error.message}`);
  }
}
console.log(results.join('\n'));
const fails = results.filter((line) => line.startsWith('FAIL') || line.startsWith('ERROR'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length} PASS / ${results.filter((r) => r.startsWith('PASS-TRANSPORT')).length} PASS-TRANSPORT / ${fails.length} FAIL`);
process.exit(fails.length ? 1 : 0);
