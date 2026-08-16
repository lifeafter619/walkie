import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { createNodeRepository } from './database-node.js';
import { createApp } from './app.js';
import { NotificationService } from './notifications.js';
import { ProviderDispatcher } from './providers/dispatcher.js';
import { DeliveryWorker } from './queue.js';

const config = loadConfig();
const repository = await createNodeRepository(config.databasePath, config.masterKey);
const dispatcher = new ProviderDispatcher(config);
let workerRef: DeliveryWorker;
const notifications = new NotificationService(repository, () => void workerRef.drainOnce());
const worker = new DeliveryWorker(repository, dispatcher, config);
workerRef = worker;
const app = createApp({ config, repository, notifications, dispatcher, worker });
const server = createServer(app);

worker.start();
server.listen(config.port, config.host, () => {
  console.log(`Walkie listening on http://${config.host}:${config.port}`);
  if (!config.adminToken) console.log('Local development mode: admin API does not require a token.');
});

const shutdown = () => {
  void (async () => {
    // 先停调度并等待在途 drain 结束（避免消息已发出但状态未落库，重启后重复推送），再关 HTTP
    await worker.stop();
    void app.locals.closeMcp?.();
    server.close(() => {
      void repository.close();
      process.exit(0);
    });
    // server.close 要等所有连接结束（MCP 长轮询可达 25s），兜底强制退出避免 SIGTERM 挂死
    setTimeout(() => { void repository.close(); process.exit(0); }, 10_000).unref();
  })();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
