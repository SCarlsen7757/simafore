// Run npm test first to compile application and synthetic fixtures.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../dist/src/config.js';
import { renderBoard } from '../dist/src/render.js';
import { parseCsaf } from '../dist/src/parse.js';
import { compactLegacy, productRemedies } from '../dist/src/compact.js';
import { select } from '../dist/src/selection.js';
import { advisory, csaf, timestamp } from '../dist/test/fixture.js';
const config = loadConfig({ ROTATE_SECONDS: '5', POLL_ON_START: 'false' });
function snapshot(scene) {
  const names = [
    'S7-1500 controller firmware',
    'SCALANCE industrial switches',
    'WinCC Unified runtime',
    'TIA Portal engineering software',
    'SINAMICS drive systems',
    'Industrial Edge devices',
  ];
  let items = names.map((name, index) => {
    const id = 'SSA-' + String(123456 + index),
      raw = csaf(id);
    raw.document.title = id + ': ' + name;
    raw.document.notes[0].text =
      'A vulnerability could allow unauthorized access under specific conditions. Siemens recommends the product-specific updates and mitigations below.';
    raw.product_tree.branches[0].name = name;
    const details = parseCsaf(raw, id);
    return advisory({
      id,
      title: id + ': Security update for ' + name,
      details,
      enrichedAt: timestamp,
      enrichedUpdated: timestamp,
    });
  });
  if (scene === 'empty') items = [];
  if (scene === 'single') items = items.slice(0, 1);
  if (scene === 'missing')
    items = items.map((i) => ({ ...i, details: null, enrichmentError: 'CSAF HTTP 503' }));
  if (scene === 'long' || scene === 'partial')
    items = items.map((i) => {
      const definitions = new Map(i.details.remedies.map((r) => [r.id, r]));
      const legacyProducts = i.details.products.map((p) => ({
        ...p,
        remedies: productRemedies(p, definitions),
      }));
      const products = Array.from({ length: 8 }, (_, index) => ({
        ...legacyProducts[0],
        id: 'p' + index,
        name: 'SIMATIC S7-1500 CPU 1518F-4 PN/DP MFP including SIPLUS variant (6ES7518-4FX00-1AC0)',
        version: 'All versions >= V3.1.6 and < V3.1.7',
        remedies: [
          {
            category: 'vendor_fix',
            text: 'Update to V3.1.7 or later for the listed vulnerabilities. Further product-specific countermeasures apply.',
            url: null,
            cves: ['CVE-2026-12345'],
          },
          {
            category: 'none_available',
            text: 'Currently no fix is available for other listed vulnerabilities.',
            url: null,
            cves: ['CVE-2026-99999'],
          },
        ],
      }));
      return {
        ...i,
        title:
          i.id +
          ': Multiple vulnerabilities in the additional GNU/Linux subsystem of SIMATIC S7-1500 CPU 1518(F)-4 PN/DP MFP industrial controllers and related SIPLUS variants',
        details: compactLegacy({
          ...i.details,
          products,
          revisionSummary:
            'Added 79 CVEs; added fixes for selected vulnerabilities. Additional countermeasures remain applicable to products without fixes.',
        }),
      };
    });
  const selected = select(items, config);
  return {
    items: selected,
    itemCount: items.length,
    matchingCount: selected.length,
    contentRevision: 'fixture-' + scene,
    lastSuccess: scene === 'stale' ? timestamp - 86400 : timestamp,
    lastChecked: timestamp,
    lastError: scene === 'stale' ? 'Offline' : null,
    stale: scene === 'stale',
    enrichmentPending: scene === 'missing' ? items.length : 0,
    enrichmentFailed: scene === 'missing' ? items.length : 0,
  };
}
const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url, 'http://localhost'),
      scene = url.searchParams.get('scene') || 'default';
    if (url.pathname === '/tv') {
      res.setHeader('Content-Type', 'text/html');
      res.end(renderBoard(snapshot(scene), config));
      return;
    }
    if (url.pathname === '/api/advisories') {
      const referer = new URL(req.headers.referer || 'http://localhost');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(snapshot(referer.searchParams.get('scene') || 'default')));
      return;
    }
    const types = {
      '/board.css': 'text/css',
      '/board.js': 'text/javascript',
      '/source-sans-3.otf': 'font/otf',
    };
    if (types[url.pathname]) {
      res.setHeader('Content-Type', types[url.pathname]);
      res.end(await readFile(new URL('../public' + url.pathname, import.meta.url)));
      return;
    }
    res.writeHead(404);
    res.end();
  })().catch((error) => {
    console.error(error);
    res.writeHead(500);
    res.end();
  });
});
server.listen(8097, '127.0.0.1', () =>
  console.log('Synthetic preview: http://127.0.0.1:8097/tv?scene=default'),
);
