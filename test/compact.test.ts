import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budget, CSAF_LIMITS, jsonBytes } from '../src/budget.js';
import { CsafProcessor } from '../src/processor.js';
import { parseCsaf } from '../src/parse.js';
import { compactLegacy, productRemedies } from '../src/compact.js';
import { Store } from '../src/db.js';
import { Poller } from '../src/poller.js';
import { loadConfig } from '../src/config.js';
import { advisory, csaf } from './fixture.js';

function expanded(products = 200, remedies = 200) {
  const raw = csaf();
  const ids = Array.from({ length: products }, (_, i) => 'p' + i);
  return {
    ...raw,
    product_tree: {
      full_product_names: ids.map((id) => ({ product_id: id, name: 'SIMATIC ' + id })),
      product_groups: [{ group_id: 'all', product_ids: ids }],
    },
    vulnerabilities: [
      {
        cve: 'CVE-2026-12345',
        product_status: { known_affected: ids },
        remediations: Array.from({ length: remedies }, (_, i) => ({
          category: 'vendor_fix',
          details: 'Remedy ' + i + ': ' + 'x'.repeat(1024),
          group_ids: ['all', 'all'],
        })),
      },
    ],
  };
}
function legacy() {
  const details = parseCsaf(csaf(), 'SSA-123456');
  const definitions = new Map(details.remedies.map((r) => [r.id, r]));
  const { schemaVersion: _version, remedies: _remedies, ...rest } = details;
  return {
    ...rest,
    products: details.products.map((p) => ({
      ...p,
      remedies: productRemedies(p, definitions).map(({ id: _id, ...r }) => r),
    })),
  };
}

test('large CSAF stays compact with exact product/CVE scope and deduplicated groups', async () => {
  const processor = new CsafProcessor();
  try {
    const raw = expanded();
    const { details } = await processor.process(JSON.stringify(raw), 'SSA-123456');
    assert.equal(details.remedies.length, 200);
    assert.equal(
      details.products.reduce((n, p) => n + p.remedies.length, 0),
      40000,
    );
    assert.ok(jsonBytes(details) < 5 * 1024 * 1024);
    const scoped = csaf();
    scoped.vulnerabilities.push({
      ...scoped.vulnerabilities[0]!,
      cve: 'CVE-2026-99999',
      product_status: { known_affected: ['fixed'], fixed: [], known_not_affected: [] },
      remediations: [
        {
          category: 'vendor_fix',
          details: 'Update to V3.1 or later.',
          product_ids: ['fixed'],
          url: 'https://support.industry.siemens.com/',
        },
      ],
    });
    const result = parseCsaf(scoped, 'SSA-123456');
    const first = result.products.find((p) => p.id === 'affected')!.remedies[0]!;
    const second = result.products.find((p) => p.id === 'fixed')!.remedies[0]!;
    assert.equal(first.remedyId, second.remedyId);
    assert.deepEqual(first.cves, ['CVE-2026-12345']);
    assert.deepEqual(second.cves, ['CVE-2026-99999']);
  } finally {
    processor.close();
  }
});

test('processing, relationship, escaped-byte, depth, text and input budgets reject excess', async () => {
  const operations = new Budget();
  operations.step(CSAF_LIMITS.operations);
  assert.throws(() => operations.step(), /processing budget/);
  const relationships = new Budget();
  for (let i = 0; i < CSAF_LIMITS.relationships; i++) relationships.relation();
  assert.throws(() => relationships.relation(), /relationship budget/);
  const value = { text: '😀\n"\\\u0000' };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  assert.equal(jsonBytes(value, bytes), bytes);
  assert.throws(() => jsonBytes(value, bytes - 1), /output budget/);
  const output = new Budget();
  assert.throws(() => output.add('x'.repeat(CSAF_LIMITS.outputBytes)), /output budget/);
  let deep: unknown = 'leaf';
  for (let i = 0; i < 66; i++) deep = [deep];
  assert.throws(() => jsonBytes(deep), /processing budget/);
  const raw = csaf();
  raw.vulnerabilities[0]!.remediations[0]!.details = 'x'.repeat(CSAF_LIMITS.textBytes);
  assert.doesNotThrow(() => parseCsaf(raw, 'SSA-123456'));
  raw.vulnerabilities[0]!.remediations[0]!.details += 'x';
  assert.throws(() => parseCsaf(raw, 'SSA-123456'), /text budget/);
  const processor = new CsafProcessor();
  try {
    await assert.rejects(
      processor.process('x'.repeat(CSAF_LIMITS.inputBytes + 1), 'SSA-123456'),
      /input budget/,
    );
  } finally {
    processor.close();
  }
});

test('worker recovers after timeout, crash and parse error and permits one active job', async () => {
  const processor = new CsafProcessor(1000, new URL('./worker-fixture.js', import.meta.url));
  const valid = JSON.stringify(csaf());
  try {
    await processor.process(valid, 'SSA-123456');
    const stalled = processor.process('hang', 'SSA-123456');
    await assert.rejects(processor.process(valid, 'SSA-123456'), /busy/);
    await assert.rejects(stalled, /timed out/);
    await processor.process(valid, 'SSA-123456');
    await assert.rejects(processor.process('crash', 'SSA-123456'), /exited/);
    await processor.process(valid, 'SSA-123456');
  } finally {
    processor.close();
  }
  const real = new CsafProcessor();
  try {
    await assert.rejects(real.process('invalid JSON', 'SSA-123456'));
    assert.equal((await real.process(valid, 'SSA-123456')).details.schemaVersion, 2);
  } finally {
    real.close();
  }
});

test('legacy migration resumes, preserves dates, archives failures and queues retrieval', async () => {
  const store = new Store(':memory:');
  const insert = (id: string, details: unknown) =>
    store.db
      .prepare('INSERT INTO advisories(id,data) VALUES (?,?)')
      .run(id, JSON.stringify({ ...advisory({ id }), details }));
  insert('SSA-123456', legacy());
  insert('SSA-654321', {
    ...legacy(),
    products: [
      {
        ...legacy().products[0],
        remedies: [{ category: 'vendor_fix', text: 'x'.repeat(65537), cves: [] }],
      },
    ],
  });
  const dates = store.get('SSA-123456')!;
  const poller = new Poller(store, loadConfig({}));
  try {
    assert.equal(poller.snapshot().items.find((p) => p.id === 'SSA-123456')!.details, null);
    await poller.migrate();
    const converted = store.get('SSA-123456')!;
    assert.equal(converted.details!.schemaVersion, 2);
    assert.equal(converted.materialDate, dates.materialDate);
    assert.equal(converted.published, dates.published);
    assert.equal(store.queueStats().pending, 1);
    assert.match(store.get('SSA-654321')!.enrichmentError!, /text budget/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM legacy_archive').get()!.n, 1);
    const restarted = new Poller(store, loadConfig({}));
    await restarted.migrate();
    assert.deepEqual(store.get('SSA-123456'), converted);
    await restarted.stop();
    assert.deepEqual(compactLegacy(legacy()), parseCsaf(csaf(), 'SSA-123456'));
  } finally {
    await poller.stop();
    store.close();
  }
});

test('oversized enrichment keeps previous successful details and schedules retry', async () => {
  const store = new Store(':memory:');
  const original = advisory({ details: parseCsaf(csaf(), 'SSA-123456') });
  store.save(original);
  store.db.prepare('INSERT INTO queue(id,updated) VALUES (?,?)').run(original.id, original.updated);
  const raw = csaf();
  raw.vulnerabilities[0]!.remediations[0]!.details = 'x'.repeat(65537);
  const poller = new Poller(store, loadConfig({}), {
    fetchFeed: async () => {
      throw new Error('unused');
    },
    fetchCsaf: async () => JSON.stringify(raw),
  });
  try {
    await poller.workOnce();
    assert.deepEqual(store.get(original.id)!.details, original.details);
    assert.equal(poller.snapshot().enrichmentFailed, 1);
    assert.equal(store.jobs().length, 0);
  } finally {
    await poller.stop();
    store.close();
  }
});
