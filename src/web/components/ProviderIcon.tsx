import type { ProviderId } from '../../shared/types';
import { Bell } from 'lucide-react';

/**
 * 渠道品牌图标 —— 每个渠道都使用从官方/品牌库下载的真实 logo SVG。
 * 资产位于 src/web/assets/providers/，通过 Vite 的 import.meta.glob 静态导入为 URL。
 */

/** 文件名与 ProviderId 不一致的情况 */
const SLUG_OVERRIDES: Partial<Record<ProviderId, string>> = {
  'synology-chat': 'synology'
};

const assetModules = {
  ...import.meta.glob('../assets/providers/*.svg', { eager: true, query: '?url', import: 'default' }),
  ...import.meta.glob('../assets/providers/*.png', { eager: true, query: '?url', import: 'default' }),
  ...import.meta.glob('../assets/providers/*.ico', { eager: true, query: '?url', import: 'default' })
} as Record<string, string>;

const ICON_URL: Partial<Record<ProviderId, string>> = {};
for (const [path, url] of Object.entries(assetModules)) {
  const slug = path.split('/').pop()!.replace(/\.(svg|png|ico)$/, '');
  ICON_URL[slug as ProviderId] = url;
}

const TINTED_ICONS = new Set<ProviderId>([
  'ifttt', 'honor-push', 'oppo-push', 'vivo-push', 'meizu-push', 'huawei-push', 'xiaomi-push',
  'pusher-beams', 'vonage-sms', 'plivo-sms', 'wecom-app', 'qq-bot', 'expo', 'resend', 'brevo',
  'aliyun-sms', 'tencent-sms', 'home-assistant', 'matrix'
]);

/** 官方只提供黑/白标识的品牌，随主题切换以保持可见。 */
const ADAPTIVE_ICONS = new Set<ProviderId>([
  'ifttt', 'honor-push', 'vonage-sms', 'expo', 'resend', 'matrix'
]);

/** 各渠道的品牌主色，用于触发器边框 / 装饰等 CSS 变量 --brand */
const BRAND_HEX: Record<ProviderId, string> = {
  join: '00AEEF',
  ifttt: '000000',
  novu: '4700FF',
  knock: '6C5CE7',
  courier: '7C3AED',
  'honor-push': '000000',
  'oppo-push': '006B3C',
  'vivo-push': '415FFF',
  'meizu-push': '00C3F5',
  pushy: '4CAF50',
  pushsafer: 'FF6600',
  simplepush: '2563EB',
  'huawei-push': 'CF0A2C',
  'xiaomi-push': 'FF6900',
  jpush: '3B82F6',
  getui: '1677FF',
  'aws-sns': 'FF9900',
  'pusher-beams': '300D4F',
  pushpad: '4A90E2',
  'vonage-sms': '000000',
  'plivo-sms': '323DFE',
  'telnyx-sms': '00B3B8',
  'bird-sms': 'FF5A5F',
  'infobip-sms': 'FF4F12',
  whatsapp: '25D366',
  signal: '3A76F0',
  'wecom-app': '07C160',
  'qq-bot': '12B7F5',
  kook: '7F6AFF',
  fcm: 'FFCA28',
  expo: '11181C',
  onesignal: 'E54B4D',
  sendgrid: '1A82E2',
  resend: '111111',
  postmark: 'FFDE00',
  mailgun: 'F06B66',
  brevo: '0B996E',
  'aliyun-sms': 'FF6A00',
  'tencent-sms': '006EFF',
  'home-assistant': '18BCF2',
  'nextcloud-talk': '0082C9',
  alertmanager: 'E6522C',
  'jira-service-management': '1868DB',
  telegram: '26A5E4',
  wecom: '07C160',
  feishu: '00D6B9',
  dingtalk: '1677FF',
  slack: '611F69',
  discord: '5865F2',
  teams: '5059C9',
  'google-chat': '34A853',
  mattermost: '0058CC',
  rocketchat: 'F5455C',
  zulip: '6492FE',
  webex: '00B5A5',
  matrix: '000000',
  ntfy: '317F6F',
  gotify: '2D8659',
  pushover: '2D5B8C',
  pushbullet: '4AB367',
  bark: 'FF3B30',
  serverchan: 'FA541C',
  pushplus: 'FF7D00',
  wxpusher: '07C160',
  xizhi: '1296DB',
  qmsg: '12B7F5',
  smtp: '2563EB',
  twilio: 'F22F46',
  apprise: '4B5563',
  pushdeer: '3B82F6',
  chanify: '3B82F6',
  pushme: '8B5CF6',
  onebot: '2D8659',
  'synology-chat': 'B5B5B6',
  pagerduty: '06AC38',
  line: '00C300',
  webhook: '6B7280'
};

export function providerBrand(provider: ProviderId): { hex: string } {
  return { hex: BRAND_HEX[provider] ?? 'a1a1aa' };
}

export function ProviderIcon({ provider, name, size = 22 }: { provider: ProviderId; name?: string; size?: number }) {
  const slug = (SLUG_OVERRIDES[provider] ?? provider) as ProviderId;
  const url = ICON_URL[slug];
  const brand = providerBrand(provider);
  const tinted = Boolean(url && TINTED_ICONS.has(provider));
  return (
    <span
      className="provider-icon"
      style={{
        width: size,
        height: size,
        '--brand': `#${brand.hex}`,
        '--icon-url': url ? `url("${url}")` : undefined,
        '--icon-paint': provider === 'plivo-sms'
          ? 'linear-gradient(135deg, #CD3EF9, #323DFE)'
          : provider === 'pusher-beams'
            ? 'light-dark(#300D4F, #B786D7)'
            : provider === 'oppo-push'
              ? 'light-dark(#006B3C, #29C878)'
              : undefined
      } as React.CSSProperties}
      role="img"
      aria-label={name ?? provider}
    >
      {url ? (
        tinted
          ? <i className={`provider-icon-mask${ADAPTIVE_ICONS.has(provider) ? ' adaptive' : ''}`} aria-hidden="true" />
          : <img src={url} alt="" width={size} height={size} draggable={false} />
      ) : <Bell size={Math.max(14, Math.round(size * .62))} aria-hidden="true" />}
    </span>
  );
}
