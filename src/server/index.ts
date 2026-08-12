import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { RelayRepository } from './database.js';
import { createApp } from './app.js';
import { NotificationService } from './notifications.js';
import { ProviderDispatcher } from './providers/dispatcher.js';
import { DeliveryWorker } from './queue.js';

const config = loadConfig();
const repository = new RelayRepository(config.databasePath, config.masterKey);
const notifications = new NotificationService(repository);
const dispatcher = new ProviderDispatcher(config);
const worker = new DeliveryWorker(repository, dispatcher, config);
const app = createApp({ config, repository, notifications, dispatcher, worker });
const server = createServer(app);

worker.start();
server.listen(config.port, config.host, () => {
  console.log(`RelayDock listening on http://${config.host}:${config.port}`);
  if (!config.adminToken) console.log('Local development mode: admin API does not require a token.');
});

const shutdown = () => {
  worker.stop();
  void app.locals.closeMcp?.();
  server.close(() => {
    repository.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
