// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/web/api';
import { Conversations } from '../src/web/components/Conversations';
import { WebPushPanel } from '../src/web/components/WebPushPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'PushManager');
  Reflect.deleteProperty(navigator, 'serviceWorker');
  Reflect.deleteProperty(globalThis, 'Notification');
  Reflect.deleteProperty(globalThis, 'isSecureContext');
});

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container, cleanup: () => { act(() => root.unmount()); container.remove(); } };
}

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text));

/** 装出一个支持 Web Push 的浏览器；返回被调用参数供断言 */
function stubPushBrowser() {
  const subscribe = vi.fn(async (options: { applicationServerKey: Uint8Array }) => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/new-device',
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new-device', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
    _key: options.applicationServerKey
  }));
  const registration = { pushManager: { subscribe, getSubscription: vi.fn(async () => null) } };
  Object.defineProperty(globalThis, 'PushManager', { value: class {}, configurable: true });
  Object.defineProperty(globalThis, 'Notification', { value: { requestPermission: vi.fn(async () => 'granted') }, configurable: true });
  // 面板要求安全上下文（HTTPS 或 localhost）；jsdom 默认 isSecureContext 为 false
  Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
      ready: Promise.resolve(registration)
    },
    configurable: true
  });
  return { subscribe, registration };
}

describe('Web Push 面板', () => {
  it('浏览器不支持时给出可操作提示，而不是一个点不动的按钮', async () => {
    // jsdom 默认没有 serviceWorker/PushManager，正是「不支持」的情形
    vi.spyOn(api, 'webpush').mockResolvedValue({ vapidPublicKey: 'x', subscriptions: [] });
    const { container, cleanup } = await render(<WebPushPanel notify={() => {}} />);
    expect(container.textContent).toContain('不支持 Web Push');
    expect(button(container, '订阅本设备')).toBeUndefined();
    cleanup();
  });

  it('订阅本设备：申请权限 → 注册 sw → 用 VAPID 公钥订阅 → 回传服务端', async () => {
    const { subscribe } = stubPushBrowser();
    // 65 字节未压缩 P-256 公钥的 base64url；面板要把它解成原始字节交给 pushManager
    const vapidPublicKey = Buffer.from(new Uint8Array([4, ...Array.from({ length: 64 }, (_, i) => i)])).toString('base64url');
    vi.spyOn(api, 'webpush').mockResolvedValue({ vapidPublicKey, subscriptions: [] });
    const saved = vi.spyOn(api, 'subscribeWebpush').mockResolvedValue({ success: true });

    const { container, cleanup } = await render(<WebPushPanel notify={() => {}} />);
    await act(async () => button(container, '订阅本设备')?.click());

    expect(subscribe).toHaveBeenCalledOnce();
    const key = subscribe.mock.calls[0]![0].applicationServerKey;
    expect(key.byteLength).toBe(65);
    expect(key[0]).toBe(4); // 未压缩点标记，解码正确才会是 0x04
    expect(saved).toHaveBeenCalledWith({ endpoint: 'https://fcm.googleapis.com/fcm/send/new-device', keys: { p256dh: 'p', auth: 'a' } });
    cleanup();
  });

  it('列出已有订阅并可逐个移除', async () => {
    stubPushBrowser();
    vi.spyOn(api, 'webpush').mockResolvedValue({
      vapidPublicKey: Buffer.from(new Uint8Array(65)).toString('base64url'),
      subscriptions: [{ endpoint: 'https://fcm.googleapis.com/fcm/send/old-device', createdAt: new Date().toISOString() }]
    });
    const removed = vi.spyOn(api, 'unsubscribeWebpush').mockResolvedValue({ success: true });

    const { container, cleanup } = await render(<WebPushPanel notify={() => {}} />);
    expect(container.textContent).toContain('fcm.googleapis.com');
    const remove = [...container.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === '移除订阅');
    await act(async () => remove?.click());
    expect(removed).toHaveBeenCalledWith('https://fcm.googleapis.com/fcm/send/old-device');
    cleanup();
  });
});

describe('收件箱面板', () => {
  it('发消息给 Agent 并展示读取状态', async () => {
    vi.spyOn(api, 'conversations').mockResolvedValue({ conversations: [] });
    vi.spyOn(api, 'inbox').mockResolvedValue({ messages: [
      { id: '1', body: '先跑 lint', source: 'admin', createdAt: new Date().toISOString() },
      { id: '2', body: '已被读走的', source: 'telegram:ops', createdAt: new Date().toISOString(), claimedAt: new Date().toISOString(), claimedBy: 'agent:x' }
    ] });
    const sent = vi.spyOn(api, 'sendToAgent').mockResolvedValue({ id: '3' });

    const { container, cleanup } = await render(<Conversations notify={() => {}} onChanged={() => {}} />);
    expect(container.textContent).toContain('发消息给 Agent');
    expect(container.textContent).toContain('等待 Agent 读取');
    expect(container.textContent).toContain('已被 agent:x 读取');

    const input = container.querySelector('.inbox-form input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '改用方案 B');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('.inbox-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(sent).toHaveBeenCalledWith('改用方案 B');
    cleanup();
  });
});
