import type { ConfigField, ProviderDefinition, ProviderId } from '../../shared/types.js';

const field = (
  key: string,
  label: string,
  type: ConfigField['type'] = 'text',
  options: Partial<ConfigField> = {}
): ConfigField => ({ key, label, type, ...options });

const webhook = (help = '在对应平台创建的 Incoming Webhook 地址') =>
  field('webhookUrl', 'Webhook 地址', 'password', { required: true, placeholder: 'https://…', help });

export const PROVIDERS: ProviderDefinition[] = [
  { id: 'telegram', name: 'Telegram', category: 'chat', description: '通过 Bot API 发送到用户、群组或频道', docsUrl: 'https://core.telegram.org/bots/api#sendmessage', fields: [field('botToken', 'Bot Token', 'password', { required: true }), field('chatId', 'Chat ID', 'text', { required: true }), field('disableNotification', '静默发送', 'boolean')] },
  { id: 'wecom', name: '企业微信机器人', category: 'chat', description: '企业微信群机器人 Markdown 消息', docsUrl: 'https://developer.work.weixin.qq.com/document/path/91770', fields: [field('key', '机器人 Key', 'password', { required: true })] },
  { id: 'feishu', name: '飞书 / Lark', category: 'chat', description: '飞书群自定义机器人，支持签名校验', docsUrl: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot', fields: [webhook(), field('secret', '签名密钥', 'password')] },
  { id: 'dingtalk', name: '钉钉机器人', category: 'chat', description: '钉钉群机器人 Markdown 消息', docsUrl: 'https://open.dingtalk.com/document/robots/custom-robot-access', fields: [field('accessToken', 'Access Token', 'password', { required: true }), field('secret', '加签密钥', 'password')] },
  { id: 'slack', name: 'Slack', category: 'chat', description: 'Slack Incoming Webhook', docsUrl: 'https://api.slack.com/messaging/webhooks', fields: [webhook()] },
  { id: 'discord', name: 'Discord', category: 'chat', description: 'Discord Webhook，使用 Embed 呈现级别和链接', docsUrl: 'https://discord.com/developers/docs/resources/webhook#execute-webhook', fields: [webhook()] },
  { id: 'teams', name: 'Microsoft Teams', category: 'chat', description: 'Teams Workflows Webhook，自适应卡片', docsUrl: 'https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook', fields: [webhook()] },
  { id: 'google-chat', name: 'Google Chat', category: 'chat', description: 'Google Chat Incoming Webhook', docsUrl: 'https://developers.google.com/workspace/chat/quickstart/webhooks', fields: [webhook()] },
  { id: 'mattermost', name: 'Mattermost', category: 'chat', description: 'Mattermost Incoming Webhook', docsUrl: 'https://developers.mattermost.com/integrate/webhooks/incoming/', fields: [webhook()] },
  { id: 'rocketchat', name: 'Rocket.Chat', category: 'chat', description: 'Rocket.Chat Incoming Integration', docsUrl: 'https://developer.rocket.chat/apidocs/post-message-incoming-webhook', fields: [webhook()] },
  { id: 'zulip', name: 'Zulip', category: 'chat', description: '向 Zulip stream/topic 发送消息', docsUrl: 'https://zulip.com/api/send-message', fields: [field('site', '站点地址', 'url', { required: true, placeholder: 'https://example.zulipchat.com' }), field('email', 'Bot Email', 'text', { required: true }), field('apiKey', 'API Key', 'password', { required: true }), field('stream', 'Stream', 'text', { required: true }), field('topic', 'Topic', 'text', { required: true })] },
  { id: 'webex', name: 'Webex', category: 'chat', description: 'Webex Bot API', docsUrl: 'https://developer.webex.com/docs/api/v1/messages/create-a-message', fields: [field('accessToken', 'Bot Access Token', 'password', { required: true }), field('roomId', 'Room ID', 'text', { required: true })] },
  { id: 'matrix', name: 'Matrix', category: 'chat', description: '向 Matrix 房间发送 m.room.message', docsUrl: 'https://spec.matrix.org/latest/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid', fields: [field('homeserver', 'Homeserver', 'url', { required: true, placeholder: 'https://matrix.example.com' }), field('accessToken', 'Access Token', 'password', { required: true }), field('roomId', 'Room ID', 'text', { required: true })] },
  { id: 'ntfy', name: 'ntfy', category: 'push', description: 'ntfy 移动与桌面推送，可使用自托管服务', docsUrl: 'https://docs.ntfy.sh/publish/', fields: [field('server', '服务地址', 'url', { required: true, defaultValue: 'https://ntfy.sh' }), field('topic', 'Topic', 'text', { required: true }), field('token', 'Access Token', 'password')] },
  { id: 'gotify', name: 'Gotify', category: 'push', description: '自托管 Gotify 推送', docsUrl: 'https://gotify.net/docs/pushmsg', fields: [field('server', '服务地址', 'url', { required: true }), field('token', 'Application Token', 'password', { required: true }), field('priority', '优先级', 'number', { defaultValue: 5 })] },
  { id: 'pushover', name: 'Pushover', category: 'push', description: 'Pushover 设备推送', docsUrl: 'https://pushover.net/api', fields: [field('apiToken', 'Application API Token', 'password', { required: true }), field('userKey', 'User / Group Key', 'password', { required: true }), field('device', '设备（可选）')] },
  { id: 'pushbullet', name: 'Pushbullet', category: 'push', description: 'Pushbullet Note 推送', docsUrl: 'https://docs.pushbullet.com/#create-push', fields: [field('accessToken', 'Access Token', 'password', { required: true }), field('deviceIden', 'Device Iden（可选）')] },
  { id: 'bark', name: 'Bark', category: 'push', description: '向 iOS Bark 客户端推送', docsUrl: 'https://bark.day.app/#/tutorial', fields: [field('server', '服务地址', 'url', { required: true, defaultValue: 'https://api.day.app' }), field('deviceKey', 'Device Key', 'password', { required: true }), field('group', '分组', 'text', { defaultValue: 'RelayDock' })] },
  { id: 'serverchan', name: 'Server 酱', category: 'push', description: 'Server酱³ 与 Server酱Turbo，按 SendKey 自动识别', docsUrl: 'https://serverchan3-doc.vercel.app/zh/serverchan3', fields: [field('sendKey', 'SendKey', 'password', { required: true, help: 'sctp 开头为 Server酱³，其余走 Turbo (sctapi.ftqq.com)' })] },
  { id: 'pushplus', name: 'PushPlus', category: 'push', description: 'PushPlus 微信消息推送', docsUrl: 'https://www.pushplus.plus/doc/guide/api.html', fields: [field('token', 'Token', 'password', { required: true }), field('topic', '群组编码（可选）')] },
  { id: 'wxpusher', name: 'WxPusher', category: 'push', description: 'WxPusher 微信实时推送，支持按 UID 或主题群发', docsUrl: 'https://wxpusher.zjiecode.com/docs/#/', fields: [field('appToken', 'App Token', 'password', { required: true }), field('uids', 'UID 列表', 'textarea', { help: '每行一个 UID，与主题 ID 至少填一项' }), field('topicIds', '主题 ID 列表', 'textarea', { help: '每行一个数字主题 ID' })] },
  { id: 'xizhi', name: '息知', category: 'push', description: '息知微信推送，单点/频道 Key 通用', docsUrl: 'https://xz.qqoq.net/#/index', fields: [field('key', 'Key', 'password', { required: true })] },
  { id: 'qmsg', name: 'Qmsg 酱', category: 'push', description: 'Qmsg 酱 QQ 消息推送', docsUrl: 'https://qmsg.zendee.cn/docs/api/', fields: [field('key', 'Key', 'password', { required: true }), field('qq', '指定 QQ（可选）', 'text', { help: '多个用逗号分隔，留空发给全部绑定 QQ' })] },
  { id: 'smtp', name: 'SMTP 邮件', category: 'email', description: '标准 SMTP/SMTPS 邮件', docsUrl: 'https://nodemailer.com/smtp', fields: [field('host', 'SMTP 主机', 'text', { required: true }), field('port', '端口', 'number', { required: true, defaultValue: 587 }), field('secure', '使用 TLS 直连', 'boolean'), field('username', '用户名'), field('password', '密码', 'password'), field('from', '发件人', 'text', { required: true }), field('to', '收件人', 'text', { required: true, help: '多个地址用逗号分隔' })] },
  { id: 'twilio', name: 'Twilio SMS', category: 'sms', description: '通过 Twilio 发送短信', docsUrl: 'https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource', fields: [field('accountSid', 'Account SID', 'password', { required: true }), field('authToken', 'Auth Token', 'password', { required: true }), field('from', '发送号码', 'text', { required: true }), field('to', '接收号码', 'text', { required: true })] },
  { id: 'apprise', name: 'Apprise API', category: 'universal', description: '连接 Apprise API，一次扩展到 100+ 通知服务', docsUrl: 'https://github.com/caronc/apprise-api', fields: [field('server', 'Apprise API 地址', 'url', { required: true, placeholder: 'https://apprise.example.com' }), field('configKey', '持久配置 Key'), field('urls', 'Apprise URLs', 'textarea', { help: '未使用持久配置时填写，每行一个' })] },
  { id: 'webhook', name: '通用 Webhook', category: 'universal', description: '可配置方法、请求头与 JSON 模板，兼容自定义服务', docsUrl: 'https://developer.mozilla.org/docs/Web/HTTP/Methods/POST', fields: [field('url', '请求地址', 'password', { required: true }), field('method', '请求方法', 'select', { required: true, defaultValue: 'POST', options: [{ label: 'POST', value: 'POST' }, { label: 'PUT', value: 'PUT' }, { label: 'PATCH', value: 'PATCH' }] }), field('headers', '请求头 JSON', 'textarea', { defaultValue: '{\n  "Content-Type": "application/json"\n}' }), field('bodyTemplate', '请求体模板', 'textarea', { required: true, defaultValue: '{\n  "title": "{{title}}",\n  "body": "{{body}}",\n  "severity": "{{severity}}"\n}' })] }
];

export const PROVIDER_MAP = new Map<ProviderId, ProviderDefinition>(PROVIDERS.map((provider) => [provider.id, provider]));

export function validateProviderConfig(provider: ProviderId, config: Record<string, unknown>): string[] {
  const definition = PROVIDER_MAP.get(provider);
  if (!definition) return ['不支持的渠道类型'];
  return definition.fields
    .filter((item) => item.required && (config[item.key] === undefined || config[item.key] === ''))
    .map((item) => `${item.label}不能为空`);
}
