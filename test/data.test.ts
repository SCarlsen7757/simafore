import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { parseFeed, parseCsaf, advisoryTitle } from '../src/parse.js';
import { classify, select } from '../src/selection.js';
import { advisory, atom, csaf, timestamp } from './fixture.js';

test('Atom namespaces, summaries, missing dates, unsafe XML, and nonempty invalid feed', () => {
  assert.equal(
    advisoryTitle('SSA-123456 V1.1 (Last Update: 2026-09-08): SIMATIC issue'),
    'SIMATIC issue',
  );
  assert.equal(parseFeed(atom())[0]?.summary, 'Affected controller');
  assert.equal(parseFeed(atom())[0]?.published, null);
  assert.throws(() => parseFeed('<!DOCTYPE foo><feed/>'));
  assert.throws(() => parseFeed('<feed><entry><title>broken</title></entry></feed>'));
  assert.deepEqual(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"/>'), []);
  assert.throws(() => parseFeed('<rss/>'));
});

test('source aggregate severity survives when CVSS details are unavailable', () => {
  const details = parseCsaf(csaf(), 'SSA-123456');
  details.scores = [];
  details.aggregateSeverity = 'HIGH';
  const item = classify(advisory({ details }), loadConfig({}));
  assert.equal(item?.severity, 'High');
  assert.equal(item?.score, null);
});
test('CSAF keeps affected, fixed, unaffected and group remediation scopes distinct', () => {
  const details = parseCsaf(csaf(), 'SSA-123456');
  assert.equal(details.products.find((p) => p.id === 'affected')?.remedies.length, 2);
  assert.deepEqual(details.products.find((p) => p.id === 'unaffected')?.remedies, []);
  assert.throws(() => parseCsaf(csaf(), 'SSA-999999'));
  const item = advisory({ details });
  assert.equal(
    classify(item, loadConfig({ PRODUCT_FAMILIES: 'WinCC', PRODUCT_KEYWORDS: '' })),
    null,
  );
  const match = classify(item, loadConfig({ PRODUCT_FAMILIES: 'S7-1500', PRODUCT_KEYWORDS: '' }));
  assert.equal(match?.score?.value, 8.8);
  assert.equal(match?.score?.version, '3.1');
  assert.equal(match?.matchedProducts.length, 1);
});
test('partial fixes keep CVE-specific remediation and missing optional fields survive', () => {
  const raw = csaf();
  raw.vulnerabilities.push({
    ...raw.vulnerabilities[0]!,
    cve: 'CVE-2026-99999',
    remediations: [
      {
        category: 'none_available',
        details: 'Currently no fix is available',
        product_ids: ['affected'],
        url: '',
      },
    ],
  });
  const details = parseCsaf(raw, 'SSA-123456');
  const p = details.products.find((p) => p.id === 'affected')!;
  assert.deepEqual(p.remedies.find((r) => r.category === 'vendor_fix')?.cves, ['CVE-2026-12345']);
  assert.deepEqual(p.remedies.find((r) => r.category === 'none_available')?.cves, [
    'CVE-2026-99999',
  ]);
  assert.deepEqual(parseCsaf({ document: raw.document }, 'SSA-123456').products, []);
});
test('priority windows, severity ordering, other modes, aliases and configuration validation', () => {
  const scored = (id: string, value: number, age: number) =>
    advisory({
      id,
      materialDate: timestamp - age * 86400,
      details: {
        ...parseCsaf(csaf(), 'SSA-123456'),
        scores: [{ value, version: '3.1', vector: '', products: ['affected'] }],
      },
    });
  const items = [
    scored('SSA-111111', 7, 1),
    scored('SSA-222222', 9, 20),
    scored('SSA-333333', 10, 200),
  ];
  assert.deepEqual(
    select(items, loadConfig({}), timestamp).map((i) => i.id),
    ['SSA-111111', 'SSA-222222'],
  );
  const windows = [
    scored('SSA-111111', 7, 1),
    scored('SSA-222222', 9, 7),
    scored('SSA-333333', 10, 7 + 1 / 86400),
    scored('SSA-444444', 8, 90),
    scored('SSA-555555', 10, 90 + 1 / 86400),
    scored('SSA-666666', 8, 20),
    advisory({ id: 'SSA-777777', materialDate: timestamp - 30 * 86400 }),
  ];
  assert.deepEqual(
    select(windows, loadConfig({}), timestamp).map((i) => i.id),
    ['SSA-222222', 'SSA-111111', 'SSA-333333', 'SSA-666666', 'SSA-777777', 'SSA-444444'],
  );
  // A newer low-severity fallback gets the final slot ahead of an older critical issue.
  assert.deepEqual(
    select(
      [scored('SSA-111111', 9, 1), scored('SSA-222222', 3, 8), scored('SSA-333333', 10, 9)],
      loadConfig({}),
      timestamp,
    )
      .slice(0, 2)
      .map((i) => i.id),
    ['SSA-111111', 'SSA-222222'],
  );
  assert.deepEqual(
    select(windows, loadConfig({ SEVERITY_DAYS: '30', RECENT_DAYS: '60' }), timestamp)
      .slice(0, 3)
      .map((i) => i.id),
    ['SSA-333333', 'SSA-222222', 'SSA-666666'],
  );
  assert.equal(select([scored('SSA-111111', 9, 91)], loadConfig({}), timestamp).length, 0);
  assert.equal(
    select(items, loadConfig({ PRIORITY_MODE: 'newest-first' }), timestamp)[0]?.id,
    'SSA-111111',
  );
  assert.equal(
    select(items, loadConfig({ PRIORITY_MODE: 'highest-severity' }), timestamp)[0]?.id,
    'SSA-333333',
  );
  assert.ok(
    classify(
      advisory({ title: 'PLCSIM update' }),
      loadConfig({ PRODUCT_FAMILIES: 'S7-PLCSIM', PRODUCT_KEYWORDS: '' }),
    ),
  );
  for (const env of [
    { PRIORITY_MODE: 'other' },
    { HERO_COUNT: '0' },
    { POLL_ON_START: 'maybe' },
    { SEVERITY_DAYS: '0' },
    { SEVERITY_DAYS: '8', RECENT_DAYS: '7' },
    { SEVERITY_DAYS: '1.5' },
    { PRODUCT_FAMILIES: '', PRODUCT_KEYWORDS: '' },
  ])
    assert.throws(() => loadConfig(env));
});
test('deduplication, material revision, no timestamp-only resurface, retry and restart persistence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'siemens-store-test-'));
  const path = join(directory, 'board.db');
  let store = new Store(path);
  try {
    const entries = parseFeed(atom());
    store.ingest(entries, () => true);
    store.ingest(entries, () => true);
    assert.equal(store.all().length, 1);
    store.enrich('SSA-123456', timestamp, parseCsaf(csaf(), 'SSA-123456'), csaf());
    assert.equal(store.queueStats().pending, 0);
    const original = store.get('SSA-123456')!;
    store.ingest(parseFeed(atom('SIMATIC S7-1500 update', timestamp + 60)), () => true);
    assert.equal(store.get('SSA-123456')?.materialDate, original.materialDate);
    assert.equal(store.get('SSA-123456')?.published, original.published);
    store.fail('SSA-123456', timestamp + 60, 0, 'offline');
    assert.equal(store.queueStats().failed, 1);
    assert.equal(store.jobs().length, 0);
    assert.equal(store.jobs(2, timestamp + 120).length, 1);
    store.close();
    store = new Store(path);
    assert.equal(store.get('SSA-123456')?.firstSeen, original.firstSeen);
    assert.ok(store.get('SSA-123456')?.details);
    store.ingest(
      parseFeed(atom('Changed SIMATIC S7-1500 affected versions', timestamp + 120)),
      () => true,
    );
    assert.equal(store.get('SSA-123456')?.materialDate, timestamp + 120);
  } finally {
    store.close();
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + '\\') ||
        resolve(directory).startsWith(resolve(tmpdir()) + '/'),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

test('revision labels and reordered CSAF lists do not resurface an advisory; changed fixes do', () => {
  const store = new Store(':memory:');
  try {
    const entry = parseFeed(atom())[0]!;
    entry.title = 'SSA-123456 V1.0: SIMATIC update';
    store.ingest([entry], () => true);
    const details = parseCsaf(csaf(), entry.id);
    store.enrich(entry.id, timestamp, details, {});
    store.ingest(
      [{ ...entry, title: 'SSA-123456 V1.1: SIMATIC update', updated: timestamp + 60 }],
      () => true,
    );
    assert.equal(store.get(entry.id)?.materialDate, timestamp);
    const reordered = {
      ...details,
      products: [...details.products].reverse(),
      scores: [...details.scores].reverse(),
      updated: timestamp + 60,
    };
    store.enrich(entry.id, timestamp + 60, reordered, {});
    assert.equal(store.get(entry.id)?.materialDate, timestamp);
    const changed = structuredClone(reordered);
    changed.products.find((p) => p.id === 'affected')!.remedies[0]!.text =
      'Update to V3.2 or later.';
    changed.updated = timestamp + 120;
    store.ingest([{ ...entry, updated: timestamp + 120 }], () => true);
    store.enrich(entry.id, timestamp + 120, changed, {});
    assert.equal(store.get(entry.id)?.materialDate, timestamp + 120);
  } finally {
    store.close();
  }
});

test('unknown remediation group never becomes an advisory-wide fix; version comparisons survive', () => {
  const raw = csaf();
  raw.vulnerabilities[0]!.remediations = [
    {
      category: 'vendor_fix',
      details: 'For versions < V3.1 and > V2.0, update to V3.1.',
      group_ids: ['missing'],
    },
  ];
  assert.equal(
    parseCsaf(raw, 'SSA-123456').products.find((p) => p.id === 'affected')?.remedies.length,
    0,
  );
  raw.vulnerabilities[0]!.remediations[0]!.group_ids = ['g1'];
  assert.match(
    parseCsaf(raw, 'SSA-123456').products.find((p) => p.id === 'affected')!.remedies[0]!.text,
    /< V3.1 and > V2.0/,
  );
});
