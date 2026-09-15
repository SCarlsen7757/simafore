import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/db.js';
import { Poller } from '../src/poller.js';
import { loadConfig } from '../src/config.js';
import { createBoardServer } from '../src/server.js';
import { advisory } from './fixture.js';

test('all strategies reuse views, refresh together and roll over once per UTC day', (t) => {
  const store = new Store(':memory:');
  store.save(advisory());
  const poller = new Poller(store, loadConfig({}));
  const all = t.mock.method(store, 'all');
  const stats = t.mock.method(store, 'queueStats');
  const modes = ['recent-severity', 'newest-first', 'highest-severity'] as const;
  try {
    const before = modes.map((mode) => poller.snapshot(mode));
    for (let n = 0; n < 10; n++)
      modes.forEach((mode, i) => assert.equal(poller.snapshot(mode).items, before[i]!.items));
    assert.equal(all.mock.callCount(), 0);
    assert.equal(stats.mock.callCount(), 0);
    store.save(advisory({ id: 'SSA-654321' }));
    poller.refresh();
    modes.forEach((mode, i) => {
      assert.equal(poller.snapshot(mode).items.length, 2);
      assert.notEqual(poller.snapshot(mode).contentRevision, before[i]!.contentRevision);
    });
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 86400000 });
    modes.forEach((mode) => poller.snapshot(mode));
    assert.equal(all.mock.callCount(), 2);
    assert.equal(stats.mock.callCount(), 2);
  } finally {
    store.close();
  }
});

test('assets and unknown routes bypass snapshots; GET and HEAD reuse strategy views', async (t) => {
  const store = new Store(':memory:');
  const config = loadConfig({});
  const poller = new Poller(store, config);
  const snapshot = t.mock.method(poller, 'snapshot');
  const all = t.mock.method(store, 'all');
  const server = createBoardServer(poller, config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ['/board.js', '/board.css', '/missing']) await fetch(base + path);
    assert.equal(snapshot.mock.callCount(), 0);
    for (const mode of ['recent-severity', 'highest-severity', 'newest-first'])
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(base + '/api/advisories?strategy=' + mode, { method });
        assert.equal(response.status, 200);
        if (method === 'HEAD') assert.equal(await response.text(), '');
      }
    assert.equal(all.mock.callCount(), 0);
  } finally {
    server.close();
    await once(server, 'close');
    store.close();
  }
});
