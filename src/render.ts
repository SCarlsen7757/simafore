import type { Config } from './config.js';
import type { DisplayAdvisory, Product, Snapshot, Remedy } from './types.js';
import { productRemedies } from './compact.js';
import { qrSvg } from './qr.js';
import { advisoryTitle } from './parse.js';
import { advisoryLink } from './urls.js';
export const escapeHtml = (v: string): string =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
const short = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
const date = (n: number | null): string =>
  n ? new Date(n * 1000).toISOString().slice(0, 10) : 'Unavailable';
export const modeLabel = (mode: string): string =>
  ({
    'recent-severity': 'Severity first · newest later',
    'newest-first': 'Newest changes first',
    'highest-severity': 'Highest severity first',
  })[mode] ?? mode;
function remedy(p: Product, definitions: ReadonlyMap<string, Remedy>): string {
  const remedies = productRemedies(p, definitions);
  const fixes = remedies.filter((r) => r.category === 'vendor_fix');
  const noFix = remedies.filter((r) => r.category === 'none_available');
  const mitigations = remedies.filter(
    (r) => r.category === 'mitigation' || r.category === 'workaround',
  );
  const text =
    (fixes.length && noFix.length ? 'Partial fixes. ' : '') +
    [...(fixes.length ? fixes : noFix), ...mitigations].map((r) => r.text).join(' • ');
  return text.trim() || 'Remediation details unavailable';
}
function productRow(p: Product, definitions: ReadonlyMap<string, Remedy>): string {
  const version = p.version.startsWith(p.name) ? p.version.slice(p.name.length).trim() : p.version;
  return `<div class="product-row"><div><strong>${escapeHtml(short(p.name, 125))}</strong><span>${escapeHtml(short(version || 'Affected version details unavailable', 110))}</span></div><p>${escapeHtml(short(remedy(p, definitions), 230))}</p></div>`;
}
function focus(item: DisplayAdvisory, index: number, config: Config): string {
  const link = advisoryLink(item.id);
  const definitions = new Map(item.details?.remedies.map((r) => [r.id, r]) ?? []);
  const old = item.materialDate < Date.now() / 1000 - config.recentDays * 86400;
  const pending = !item.details || item.enrichedUpdated !== item.updated;
  const title = advisoryTitle(item.title);
  const summary =
    item.details?.summary ||
    item.summary ||
    'Summary unavailable. Scan the official advisory for details.';
  const rowCount =
    title.length > 110 ||
    summary.length > 250 ||
    item.matchedProducts.some((p) => p.name.length > 75 || remedy(p, definitions).length > 160)
      ? 3
      : 4;
  return `<article class="focus" data-focus="${index}" ${index ? 'hidden' : ''}>
    <div class="focus-header"><div class="focus-heading">
    <div class="advisory-meta"><span>${escapeHtml(item.id)}</span><span class="severity ${item.severity.toLowerCase()}">${item.severity}${item.score ? ` <b>${item.score.value.toFixed(1)}</b>` : ''}</span><span>${item.score ? `CVSS ${escapeHtml(item.score.version)}${item.scoreScope === 'advisory' ? ' · advisory-wide' : ''}` : 'Score unavailable'}</span></div>
    <div class="product-family">${escapeHtml(item.matchedFamilies.slice(0, 3).join(' / '))}</div>
    <h1>${escapeHtml(short(title, 190))}</h1>
    </div>${link ? `<a class="qr" href="${escapeHtml(link)}">${qrSvg(link)}<span>Official advisory</span></a>` : ''}</div>
    <p class="summary">${escapeHtml(short(summary, 270))}</p>
    <div class="dates"><span>Published ${date(item.published)}</span><span>${item.details?.published && item.updated > item.details.published ? 'Updated' : 'Source date'} ${date(item.updated)}</span>${old ? '<span class="older">Older advisory</span>' : ''}</div>
    <div class="details-heading"><span>Affected equipment / versions</span><span>Siemens recommendation</span></div>
    <div class="products">${
      item.matchedProducts.length
        ? item.matchedProducts
            .slice(0, rowCount)
            .map((p) => productRow(p, definitions))
            .join('')
        : `<div class="unavailable">${item.provisional ? 'Product match awaiting confirmation from advisory details.' : 'Detailed affected versions unavailable.'}</div>`
    }</div>
    <div class="focus-bottom"><div class="revision"><p>${item.matchedProducts.length > rowCount ? `+${item.matchedProducts.length - rowCount} additional product/version entries. ` : ''}Excerpts shown; full details in advisory.</p>${pending ? `<p class="warning">${item.details ? 'Previous revision details; update pending.' : 'Detailed advisory information pending.'}${item.enrichmentError ? ' Retrieval failed; retry scheduled.' : ''}</p>` : ''}${!pending && item.details?.revisionSummary && !/^publication date$/i.test(item.details.revisionSummary) ? `<p class="change">${escapeHtml(short(item.details.revisionSummary, 130))}</p>` : ''}<span>${item.details ? `${item.details.cves.length} CVE${item.details.cves.length === 1 ? '' : 's'}` : 'CVE details pending'}</span></div></div>
  </article>`;
}
export function renderBoard(snapshot: Snapshot, config: Config): string {
  const items = snapshot.items.slice(0, config.heroCount);
  const rail = snapshot.items.slice(0, config.railCount);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Siemens ProductCERT · Automation security</title><link rel="stylesheet" href="/board.css"><script defer src="/board.js"></script></head>
  <body data-rotate="${config.rotateSeconds}" data-revision="${snapshot.contentRevision}" data-last-success="${snapshot.lastSuccess ?? 0}" data-stale-after="${config.staleAfterMin * 60}" data-timezone="${escapeHtml(config.timezone)}"><div class="screen">
  <header><div class="identity"><span class="brand">SIEMENS</span><span class="heading">ProductCERT security advisories</span></div><div class="clock"><span id="clock"></span><span>Automation watch</span></div></header>
  <main><section class="stage">${items.length ? items.map((i, n) => focus(i, n, config)).join('') : `<article class="empty"><div class="product-family">Automation watch</div><h1>${snapshot.lastSuccess ? 'No matching advisories' : 'Waiting for Siemens ProductCERT'}</h1><p>${snapshot.lastSuccess ? 'No retained advisories currently match the configured product families. This does not establish that installed equipment is unaffected.' : 'The feed is being retrieved. This screen will update automatically.'}</p>${snapshot.lastError ? '<p class="warning">Feed unavailable. Automatic retry scheduled.</p>' : ''}</article>`}</section>
  <aside><div class="rail-heading"><h2>Advisory overview</h2></div><p class="mode">${modeLabel(config.priorityMode)}</p><ol class="rail" data-count="${rail.length}">${rail.map((i, n) => `<li data-rail="${n}" class="${n === 0 ? 'active' : ''}"><div><span class="rail-severity ${i.severity.toLowerCase()}">${i.severity}${i.score ? ' ' + i.score.value.toFixed(1) : ''}</span><time>${date(i.updated)}</time></div><h3>${escapeHtml(short(advisoryTitle(i.title), 110))}</h3><span class="rail-id">${escapeHtml(i.id)}</span></li>`).join('')}</ol><div class="rotation"><span id="position">${items.length ? `1 / ${items.length}` : '0 / 0'}</span><span>Automatic rotation</span><div class="progress"><div id="progress"></div></div></div></aside></main>
  <footer><div><span id="status-dot" class="dot ${snapshot.stale ? 'stale' : ''}"></span><span id="status">${snapshot.stale ? 'Feed stale' : 'Feed current'}</span><span id="checked">Last successful check: ${snapshot.lastSuccess ? new Date(snapshot.lastSuccess * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'not yet'}</span></div><span>Unofficial dashboard · <a href="https://www.siemens.com/productcert/terms-of-use">Siemens terms</a></span></footer>
  </div></body></html>`;
}
