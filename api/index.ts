import express from 'express';
import { waitUntil } from '@vercel/functions';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { createLibsqlRepository } from '../src/server/database-libsql.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import { DeliveryWorker } from '../src/server/queue.js';

// Vercel serverless 入口：状态存 Turso/libSQL，队列由请求内 drain + Vercel Cron 兜底重试
const databaseUrl = process.env.TURSO_DATABASE_URL;
if (!databaseUrl) throw new Error('TURSO_DATABASE_URL is required on Vercel');

const config = loadConfig({ host: '0.0.0.0' });
const repository = await createLibsqlRepository(databaseUrl, process.env.TURSO_AUTH_TOKEN, config.masterKey);
const dispatcher = new ProviderDispatcher(config);
let workerRef: DeliveryWorker;
const notifications = new NotificationService(repository, () => void workerRef.drainAll());
const worker = new DeliveryWorker(repository, dispatcher, config);
workerRef = worker;
// 请求返回后继续跑完投递，而不是随函数冻结中断
const drain = worker.drainAll.bind(worker);
worker.drainAll = () => { const pending = drain(); waitUntil(pending); return pending; };

const app = express();
app.get('/api/cron/drain', async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'CRON_SECRET required' });
  }
  res.json({ processed: await worker.drainAll() });
});
app.use(createApp({ config, repository, notifications, dispatcher, worker }));

export default app;
