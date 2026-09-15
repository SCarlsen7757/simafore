import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../src/poller.js';
import { Store } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { atom, csaf } from './fixture.js';
import { parseFeed } from '../src/parse.js';
import { UpstreamCooldownError } from '../src/feed.js';

test('blocking without Retry-After escalates from one hour to two hours', async () => {
  const store = new Store(':memory:');
  store.ingest(parseFeed(atom()), () => true);
  const poller = new Poller(store, loadConfig({}), {
    fetchFeed: async () => {
      throw new Error('unused');
    },
    fetchCsaf: async () => {
      throw new UpstreamCooldownError('403', null);
    },
  });
  try {
    await poller.workOnce();
    assert.ok(
      Number(store.meta('upstream_cooldown_until')) >= Math.floor(Date.now() / 1000) + 3599,
    );
    store.setMeta({ upstream_cooldown_until: 0, next_request_at: 0 });
    store.db.exec('UPDATE queue SET next_attempt=0');
    await poller.workOnce();
    assert.ok(
      Number(store.meta('upstream_cooldown_until')) >= Math.floor(Date.now() / 1000) + 7199,
    );
  } finally {
    store.close();
  }
});
test('failed enrichment retries after unchanged Atom and feed outages preserve cached display', async () => {
  const store = new Store(':memory:');
  let feedCalls = 0,
    detailCalls = 0,
    offline = false;
  const poller = new Poller(store, loadConfig({}), {
    fetchFeed: async () => {
      feedCalls++;
      if (offline) throw new Error('offline');
      return feedCalls === 1
        ? { status: 200, xml: atom(), etag: 'test', modified: '' }
        : { status: 304 };
    },
    fetchCsaf: async () => {
      detailCalls++;
      if (detailCalls === 1) throw new Error('temporary');
      return JSON.stringify(csaf());
    },
  });
  try {
    await Promise.all([poller.pollOnce(), poller.pollOnce()]);
    assert.equal(feedCalls, 1);
    store.setMeta({ next_request_at: 0 });
    await poller.workOnce();
    assert.equal(poller.snapshot().enrichmentFailed, 1);
    store.db.exec('UPDATE queue SET next_attempt=0');
    store.setMeta({ next_request_at: 0 });
    await poller.pollOnce();
    store.setMeta({ next_request_at: 0 });
    await poller.workOnce();
    assert.equal(detailCalls, 2);
    assert.equal(poller.snapshot().enrichmentPending, 0);
    const revision = poller.snapshot().contentRevision;
    offline = true;
    store.setMeta({ next_request_at: 0 });
    await poller.pollOnce();
    assert.equal(poller.snapshot().contentRevision, revision);
    assert.equal(poller.snapshot().items.length, 1);
    assert.equal(poller.snapshot().lastError, 'offline');
  } finally {
    store.close();
  }
});

test('all outgoing requests share spacing and blocked responses pause the entire queue across restarts', async () => {
  const store = new Store(':memory:');
  const config = loadConfig({ REQUEST_INTERVAL_SECONDS: '60' });
  let calls = 0;
  const transport = {
    fetchFeed: async () => {
      calls++;
      return { status: 200 as const, xml: atom(), etag: '', modified: '' };
    },
    fetchCsaf: async () => {
      calls++;
      throw new UpstreamCooldownError('blocked', Math.floor(Date.now() / 1000) + 7200);
    },
  };
  try {
    const poller = new Poller(store, config, transport);
    await poller.pollOnce();
    await poller.workOnce();
    assert.equal(calls, 1, 'detail fetch cannot follow feed immediately');
    store.setMeta({ next_request_at: 0 });
    store.ingest(parseFeed(atom().replaceAll('123456', '654321')), () => true);
    await poller.workOnce();
    assert.equal(calls, 2, 'one blocked fetch stops before another job');
    assert.ok(
      (poller.snapshot().upstreamCooldownUntil ?? 0) >= Math.floor(Date.now() / 1000) + 7199,
    );
    store.setMeta({ next_request_at: 0 });
    const restarted = new Poller(store, config, transport);
    await Promise.all([restarted.pollOnce(), restarted.workOnce()]);
    assert.equal(calls, 2, 'restart and feed checks respect persisted cooldown');
    store.setMeta({ upstream_cooldown_until: 0 });
    store.db.exec('UPDATE queue SET next_attempt=0');
    await restarted.workOnce();
    assert.equal(calls, 3, 'one probe resumes after cooldown');
    assert.equal(Number(store.meta('upstream_backoff_count')), 2);
    assert.ok(store.get('SSA-123456'), 'cached advisory is preserved');
  } finally {
    store.close();
  }
});
