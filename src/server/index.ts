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
  worker.stop();
  void app.locals.closeMcp?.();
  server.close(() => {
    void repository.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
