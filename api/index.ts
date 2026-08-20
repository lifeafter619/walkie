import express from 'express';
import { waitUntil } from '@vercel/functions';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { safeTokenEqual } from '../src/server/crypto.js';
import { createLibsqlRepository } from '../src/server/database-libsql.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import { DeliveryWorker } from '../src/server/queue.js';
import { PlatformUsageMonitor } from '../src/server/platform-usage.js';

const bearer = (req: express.Request) => /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];

/** 一键部署按钮会在环境变量填好之前就跑起来：模块顶层 throw 只会得到
 *  FUNCTION_INVOCATION_FAILED，看不出缺什么。改成返回一页可照抄的设置说明。 */
function setupApp(missing: string[]) {
  const app = express();
  app.use((_req, res) => res.status(503).type('html').set('cache-control', 'no-store').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Walkie · 需要完成设置</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#fafafa;font:15px/1.7 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
main{max-width:640px;padding:32px}h1{font-size:20px;margin:0 0 8px}p{color:#a1a1aa;margin:0 0 16px}
li{margin:2px 0}code{color:#5eead4}</style></head><body><main>
<h1>📻 Walkie 部署成功，还差最后一步</h1>
<p>Vercel 部署需要一个 Turso (libSQL) 数据库保存状态。请在 Project → Settings → Environment Variables 补齐后重新部署：</p>
<ul>${missing.map((name) => `<li><code>${name}</code></li>`).join('')}</ul>
<p><code>MASTER_KEY</code> 是 base64 编码的 32 字节根密钥，<code>ADMIN_TOKEN</code> 是控制台管理密码（≥8 位）。</p>
</main></body></html>`));
  return app;
}

async function relayApp() {
  const config = loadConfig({ host: '0.0.0.0' });
  const repository = await createLibsqlRepository(process.env.TURSO_DATABASE_URL!, process.env.TURSO_AUTH_TOKEN, config.masterKey);
  const dispatcher = new ProviderDispatcher(config);
  let workerRef: DeliveryWorker;
  const notifications = new NotificationService(repository, () => void workerRef.drainAll().catch(() => undefined));
  const worker = new DeliveryWorker(repository, dispatcher, config);
  workerRef = worker;
  const platformUsage = new PlatformUsageMonitor(repository, notifications, 'vercel');
  // 请求返回后继续跑完投递，而不是随函数冻结中断。包在实例方法上：app.ts 内部直调的
  // drainOnce 也走 waitUntil（只包 drainAll 会漏掉这些调用点，冻结会产生 sending 残留→重复推送）
  for (const method of ['drainOnce', 'drainAll'] as const) {
    const original = worker[method].bind(worker);
    worker[method] = () => { const pending = original().catch(() => 0); waitUntil(pending); return pending; };
  }

  const app = express();
  app.get('/api/cron/drain', async (req, res) => {
    // 恒定时间比较，与其余令牌路径一致
    if (!process.env.CRON_SECRET || !safeTokenEqual(bearer(req), process.env.CRON_SECRET)) {
      return res.status(401).json({ error: 'CRON_SECRET required' });
    }
    // cron 兜底两件事：排空投递队列 + 数据保留清理（幂等，retention 全 0 时零开销）
    const processed = await worker.drainAll();
    const [purged, platform] = await Promise.all([
      repository.purgeExpiredData().catch(() => ({ deliveries: 0, conversations: 0, auditEvents: 0 })),
      platformUsage.refreshIfDue().catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
    ]);
    res.json({ processed, purged, platform });
  });
  app.use(createApp({ config, repository, notifications, dispatcher, worker, platformUsage }));
  return app;
}

const missing = ['TURSO_DATABASE_URL', 'ADMIN_TOKEN', 'MASTER_KEY'].filter((name) => !process.env[name]);
const app = missing.length ? setupApp(missing) : await relayApp();

export default app;
