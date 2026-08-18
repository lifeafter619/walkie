// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { Channel, Route } from '../src/shared/types';
import { RouteForm } from '../src/web/components/Routes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('lets an editor remove a disabled channel from a route', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const channel: Channel = {
    id: 'channel-1', name: 'Old Telegram', slug: 'old-telegram', provider: 'telegram', enabled: false,
    configKeys: ['botToken', 'chatId'], lastTestStatus: 'untested',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  };
  const route: Route = {
    id: 'route-1', name: 'Alerts', slug: 'alerts', strategy: 'fanout', channelIds: [channel.id], enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  };

  act(() => root.render(<RouteForm channels={[channel]} route={route} close={() => {}} saved={() => {}} notify={() => {}} />));
  const choice = [...container.querySelectorAll('label')].find((item) => item.textContent?.includes('Old Telegram'));
  expect(choice).toBeTruthy();
  expect(choice?.textContent).toContain('已停用');
  const checkbox = choice?.querySelector('input');
  expect(checkbox?.checked).toBe(true);
  act(() => checkbox!.click());
  expect(checkbox?.checked).toBe(false);

  act(() => root.unmount());
  container.remove();
});
