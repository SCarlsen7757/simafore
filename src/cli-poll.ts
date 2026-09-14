import { config } from './config.js';
import { Store } from './db.js';
import { Poller } from './poller.js';
const store = new Store(config.dbPath);
const poller = new Poller(store, config);
try {
  await poller.pollOnce();
  const { items: _items, ...status } = poller.snapshot();
  console.log(status);
  if (status.lastError) process.exitCode = 1;
} finally {
  await poller.stop();
  store.close();
}
