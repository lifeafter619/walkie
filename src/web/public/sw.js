// Walkie Web Push Service Worker。
// Scope 是站点根（注册时指定 scope: '/'），payload 是 JSON：
// { title, body, severity, url?, conversationId? }
// conversationId 存在时点击通知打开控制台「会话」页回复；否则打开 url 或首页。
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* 非 JSON payload 忽略 */ }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Walkie';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: 'walkie',
    renotify: true,
    data: { url: typeof data.url === 'string' ? data.url : '/', conversationId: typeof data.conversationId === 'string' ? data.conversationId : '' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // 控制台用 hash 路由；conversationId 存在时直接落到「会话」页，而不是首页
  const target = data.conversationId ? '/#conversations' : (data.url || '/');
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if (client.url.includes(self.location.origin) && 'focus' in client) {
        client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
