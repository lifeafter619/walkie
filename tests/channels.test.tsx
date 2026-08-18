// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDERS } from '../src/server/providers/catalog';
import type { Channel } from '../src/shared/types';
import { ChannelForm } from '../src/web/components/Channels';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = () => {};

const providers = PROVIDERS.filter(({ id }) => id === 'telegram' || id === 'slack');
const channel: Channel = {
  id: 'channel-1', name: 'Alerts', slug: 'alerts', provider: 'telegram', enabled: true,
  configKeys: ['botToken', 'chatId'], lastTestStatus: 'untested',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
};

describe('ChannelForm provider switching', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<ChannelForm providers={providers} channel={channel} close={() => {}} saved={() => {}} notify={() => {}} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const click = (text: string) => {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
    expect(button).toBeTruthy();
    act(() => button!.click());
  };

  const input = (label: string) => {
    const field = [...container.querySelectorAll('label')].find((item) => item.textContent?.startsWith(label))?.querySelector('input');
    expect(field).toBeTruthy();
    return field!;
  };

  const fill = (field: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

  it('keeps independent drafts when switching away and back', () => {
    fill(input('Bot Token'), 'telegram-draft');
    click('更换');
    click('Slack');
    expect(container.textContent).not.toContain('Bot Token');
    expect(input('Webhook 地址').value).toBe('');

    fill(input('Webhook 地址'), 'https://hooks.slack.test/1');
    click('更换');
    click('Telegram');
    expect(input('Bot Token').value).toBe('telegram-draft');

    click('更换');
    click('Slack');
    expect(input('Webhook 地址').value).toBe('https://hooks.slack.test/1');
  });
});
