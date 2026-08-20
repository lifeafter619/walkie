// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPATIBILITY_ENDPOINTS, PLATFORM_PROFILES } from '../src/shared/platform';
import type { PlatformUsageStatus } from '../src/shared/types';
import { api } from '../src/web/api';
import { SystemPage } from '../src/web/components/SystemPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings: PlatformUsageStatus['settings'] = {
  enabled: false,
  alertsEnabled: false,
  plan: 'auto',
  hiddenMetricKeys: [],
  accountId: '',
  scriptName: 'walkie',
  teamId: '',
  projectId: '',
  warningPercent: 80,
  action: 'notify',
  destination: ''
};

const platformUsage: PlatformUsageStatus = {
  platform: 'cloudflare-workers',
  configured: false,
  apiTokenConfigured: false,
  effectivePlan: 'workers-free',
  settings,
  metrics: [],
  deliveryDisabled: false
};

const meta: Awaited<ReturnType<typeof api.meta>> = {
  name: 'Walkie',
  version: '0.3.0',
  runtime: 'cloudflare-workers',
  platform: 'cloudflare-workers',
  platformProfile: PLATFORM_PROFILES['cloudflare-workers'],
  compatibilityEndpoints: COMPATIBILITY_ENDPOINTS,
  adminAuthRequired: true,
  publicUrl: 'https://walkie.example.com',
  mcpEndpoint: '/mcp',
  mcpUrl: 'https://walkie.example.com/mcp'
};

afterEach(() => vi.restoreAllMocks());

async function renderPage() {
  vi.spyOn(api, 'usage').mockResolvedValue({
    settings: { dailyDeliveryLimit: 0, monthlyDeliveryLimit: 0, warningPercent: 80 },
    today: { deliveries: 0, attempts: 0 },
    month: { deliveries: 0, attempts: 0 }
  });
  vi.spyOn(api, 'platformUsage').mockResolvedValue(platformUsage);
  vi.spyOn(api, 'getRetention').mockResolvedValue({ deliveriesDays: 0, conversationsDays: 0, auditDays: 0 });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SystemPage meta={meta} channels={[]} providers={[]} refresh={() => {}} notify={() => {}} />));
  return { container, root };
}

describe('system page guidance', () => {
  it('opens the compatibility documentation in a modal', async () => {
    const { container, root } = await renderPage();
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('查看接入文档'));
    await act(async () => button?.click());

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Bark');
    expect(dialog?.textContent).toContain('/push');

    act(() => root.unmount());
    container.remove();
  });

  it('shows plan-specific limits while choosing a Cloudflare plan', async () => {
    const { container, root } = await renderPage();
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('配置监控'));
    await act(async () => button?.click());
    const select = [...container.querySelectorAll('label')].find((item) => item.textContent?.startsWith('套餐'))?.querySelector('select');

    await act(async () => {
      if (!select) return;
      select.value = 'workers-paid';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('10,000,000 请求/月');

    act(() => root.unmount());
    container.remove();
  });
});
