import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/db.js';
import { Poller } from '../src/poller.js';
import { loadConfig } from '../src/config.js';
import { createBoardServer } from '../src/server.js';
import { advisory, csaf } from './fixture.js';
import { parseCsaf } from '../src/parse.js';

test('URL strategy overrides ranking per screen, preserves history and defaults, and validates input', async () => {
  const store = new Store(':memory:');
  const config = loadConfig({ PRIORITY_MODE: 'newest-first', POLL_ON_START: 'false' });
  const now = Math.floor(Date.now() / 1000);
  for (const [id, age, score] of [
    ['SSA-111111', 1, 4],
    ['SSA-222222', 5, 9],
    ['SSA-333333', 200, 10],
  ] as const) {
    const details = parseCsaf(csaf(), 'SSA-123456');
    details.scores = [{ value: score, version: '3.1', vector: '', products: ['affected'] }];
    store.save(advisory({ id, materialDate: now - age * 86400, details }));
  }
  const poller = new Poller(store, config);
  const server = createBoardServer(poller, config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (query: string) =>
    (await (await fetch(base + '/api/advisories' + query)).json()) as {
      priorityMode: string;
      items: { id: string }[];
      contentRevision: string;
    };
  try {
    const initial = await get('');
    assert.equal(initial.priorityMode, 'newest-first');
    assert.equal(initial.items[0]?.id, 'SSA-111111');
    const recent = await get('?strategy=recent-severity');
    assert.deepEqual(
      recent.items.map((i) => i.id),
      ['SSA-222222', 'SSA-111111'],
    );
    const highest = await get('?strategy=highest-severity');
    assert.equal(highest.items[0]?.id, 'SSA-333333');
    assert.notEqual(recent.contentRevision, highest.contentRevision);
    assert.deepEqual(await get(''), initial);
    for (const strategy of ['recent-severity', 'newest-first', 'highest-severity']) {
      const data = await get('?strategy=' + strategy);
      const html = await (await fetch(base + '/tv?strategy=' + strategy)).text();
      assert.ok(html.includes(data.contentRevision));
      assert.ok(html.indexOf(data.items[0]!.id) < html.lastIndexOf(data.items[1]!.id));
    }
    assert.equal((await fetch(base + '/tv?strategy=invalid')).status, 400);
    assert.equal((await fetch(base + '/api/advisories?strategy=')).status, 400);
    assert.equal(
      (await fetch(base + '/?strategy=highest-severity', { redirect: 'manual' })).headers.get(
        'location',
      ),
      '/tv?strategy=highest-severity',
    );
    // An override must use the full cache even when the environment default excludes older items.
    const recentPoller = new Poller(store, loadConfig({}));
    assert.equal(recentPoller.snapshot().items.length, 2);
    assert.equal(recentPoller.snapshot('highest-severity').items[0]?.id, 'SSA-333333');
  } finally {
    server.close();
    await once(server, 'close');
    store.close();
  }
});
test('HTTP contract, root reservation, empty health, unmatched health, escaping, API limits', async () => {
  const store = new Store(':memory:'),
    config = loadConfig({ POLL_ON_START: 'false' });
  const poller = new Poller(store, config),
    server = createBoardServer(poller, config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 302);
    assert.equal((await fetch(base + '/healthz')).status, 503);
    assert.equal((await fetch(base + '/tv')).status, 200);
    store.setMeta({ last_success: Math.floor(Date.now() / 1000) });
    assert.equal((await fetch(base + '/healthz')).status, 200);
    for (let i = 0; i < 105; i++)
      store.save(
        advisory({
          id: `SSA-${String(i).padStart(6, '0')}`,
          title: 'SIMATIC <script>alert(1)</script>',
          summary: '<img onerror="bad">',
        }),
      );
    poller.refresh();
    const html = await (await fetch(base + '/tv')).text();
    assert.ok(!html.includes('<script>alert'));
    assert.match(html, /&lt;script&gt;/);
    const json = (await (await fetch(base + '/api/advisories?limit=999')).json()) as {
      items: unknown[];
    };
    assert.equal(json.items.length, 100);
    assert.equal((await fetch(base + '/%')).status, 400);
    assert.equal((await fetch(base + '/tv', { method: 'POST' })).status, 405);
  } finally {
    server.close();
    await once(server, 'close');
    store.close();
  }
});
