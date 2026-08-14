import type { ProviderId } from '../../shared/types';

/**
 * 渠道品牌图标 —— 每个渠道都使用从官方/品牌库下载的真实 logo SVG。
 * 资产位于 src/web/assets/providers/，通过 Vite 的 import.meta.glob 静态导入为 URL。
 */

/** 文件名与 ProviderId 不一致的情况 */
const SLUG_OVERRIDES: Partial<Record<ProviderId, string>> = {
  'synology-chat': 'synology'
};

const assetModules = import.meta.glob('../assets/providers/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

const ICON_URL: Partial<Record<ProviderId, string>> = {};
for (const [path, url] of Object.entries(assetModules)) {
  const slug = path.split('/').pop()!.replace('.svg', '');
  ICON_URL[slug as ProviderId] = url;
}

/** 各渠道的品牌主色，用于触发器边框 / 装饰等 CSS 变量 --brand */
const BRAND_HEX: Record<ProviderId, string> = {
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
  return { hex: BRAND_HEX[provider] ?? '6b6353' };
}

export function ProviderIcon({ provider, name, size = 22 }: { provider: ProviderId; name?: string; size?: number }) {
  const slug = (SLUG_OVERRIDES[provider] ?? provider) as ProviderId;
  const url = ICON_URL[slug];
  const brand = providerBrand(provider);
  return (
    <span
      className="provider-icon"
      style={{ width: size, height: size, '--brand': `#${brand.hex}` } as React.CSSProperties}
      role="img"
      aria-label={name ?? provider}
    >
      {url && <img src={url} alt="" width={size} height={size} draggable={false} />}
    </span>
  );
}
