import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { advisoryLink, safeLink } from '../src/urls.js';
import { parseFeed, parseCsaf } from '../src/parse.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { Poller } from '../src/poller.js';
import { renderBoard } from '../src/render.js';
import { createBoardServer } from '../src/server.js';
import { qrSvg } from '../src/qr.js';
import { advisory, atom, csaf } from './fixture.js';

test('primary URLs use SSA IDs regardless of foreign, deceptive or mismatched feed destinations', () => {
  const official = advisoryLink('SSA-123456');
  for (const url of [
    'https://attacker.invalid/fake-firmware',
    'https://cert-portal.siemens.com.attacker.invalid/ssa-123456.html',
    'http://cert-portal.siemens.com/productcert/html/ssa-123456.html',
    'https://user:password@cert-portal.siemens.com/productcert/html/ssa-123456.html',
    advisoryLink('SSA-999999'),
    'javascript:alert(1)',
  ]) {
    const feed = atom().replace(`href="${official}"`, `href="${url}"`);
    assert.equal(parseFeed(feed)[0]!.link, official);
  }
  for (const id of ['SSA-1234567', 'SSA-12345', '../SSA-123456', 'SSA-123456\n', 'invalid'])
    assert.equal(advisoryLink(id), '');
  assert.throws(() => parseFeed(atom().replaceAll('123456', '1234567')), /No valid advisory/);
});

test('legacy cached links are canonical in HTML, QR and API before migration or polling', async () => {
  const store = new Store(':memory:');
  const item = advisory({ link: 'https://attacker.invalid/fake-firmware' });
  store.db
    .prepare('INSERT INTO advisories(id,data) VALUES (?,?)')
    .run(item.id, JSON.stringify(item));
  const config = loadConfig({ POLL_ON_START: 'false' });
  const poller = new Poller(store, config);
  const server = createBoardServer(poller, config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const snapshot = poller.snapshot();
    const html = renderBoard(snapshot, config);
    assert.ok(!html.includes('attacker.invalid'));
    assert.ok(html.includes(qrSvg(advisoryLink(item.id))));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const api = (await (await fetch(base + '/api/advisories')).json()) as {
      items: { link: string }[];
    };
    assert.equal(api.items[0]!.link, advisoryLink(item.id));
    snapshot.items[0]!.id = 'invalid';
    assert.ok(!renderBoard(snapshot, config).includes('class="qr"'));
  } finally {
    server.close();
    await once(server, 'close');
    await poller.stop();
    store.close();
  }
});

test('feeds require credential-free HTTPS while remediation links allow legitimate external vendors', () => {
  for (const url of [
    'http://127.0.0.1/feed',
    'http://example.com/feed',
    'file:///tmp/feed',
    'https://user:secret@example.com/feed',
  ])
    assert.throws(() => loadConfig({ FEED_URL: url }), /HTTPS without embedded credentials/);
  assert.equal(
    loadConfig({ FEED_URL: 'https://example.com/feed' }).feedUrl,
    'https://example.com/feed',
  );
  const raw = csaf();
  raw.vulnerabilities[0]!.remediations[0]!.url = 'https://vendor.example/fix';
  assert.ok(
    parseCsaf(raw, 'SSA-123456').remedies.some((r) => r.url === 'https://vendor.example/fix'),
  );
  assert.equal(safeLink('javascript:alert(1)'), '');
});
