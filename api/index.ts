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

// Vercel serverless 入口：状态存 Turso/libSQL，队列由请求内 drain + Vercel Cron 兜底重试
const databaseUrl = process.env.TURSO_DATABASE_URL;
if (!databaseUrl) throw new Error('TURSO_DATABASE_URL is required on Vercel');

const config = loadConfig({ host: '0.0.0.0' });
const repository = await createLibsqlRepository(databaseUrl, process.env.TURSO_AUTH_TOKEN, config.masterKey);
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

const bearer = (req: express.Request) => /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];

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

export default app;
