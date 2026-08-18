// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { ApiKey, Destination } from '../src/shared/types';
import { KeyForm } from '../src/web/components/Keys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('lets an editor remove a disabled destination from a key', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const destination: Destination = { id: 'channel-1', slug: 'old', name: 'Old Telegram', kind: 'channel', provider: 'telegram', enabled: false };
  const key: ApiKey = {
    id: 'key-1', name: 'Agent', prefix: '12345678', scopes: ['notifications:send'], destinationIds: [destination.id],
    createdAt: '2026-01-01T00:00:00.000Z', viewable: false
  };

  act(() => root.render(<KeyForm destinations={[destination]} editing={key} close={() => {}} saved={() => {}} notify={() => {}} />));
  const choice = [...container.querySelectorAll('label')].find((item) => item.textContent?.includes('Old Telegram'));
  expect(choice).toBeTruthy();
  expect(choice?.textContent).toContain('已停用');
  const checkbox = choice?.querySelector('input');
  expect(checkbox?.checked).toBe(true);
  act(() => checkbox!.click());
  expect([...container.querySelectorAll('button')].find((item) => item.textContent?.includes('保存修改'))?.disabled).toBe(true);

  act(() => root.unmount());
  container.remove();
});
