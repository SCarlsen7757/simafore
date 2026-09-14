import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Details, FeedEntry, Product, Score } from './types.js';
import { safeLink } from './urls.js';
import { Budget, CSAF_LIMITS, jsonBytes } from './budget.js';
import { hash } from './fingerprint.js';
import type { Remedy, RemedyReference } from './types.js';

export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function array(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}
export function str(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 65536) : '';
}
export function plain(value: unknown): string {
  return str(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(?:lt|gt|amp|quot|apos|nbsp);/g,
      (s) =>
        ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[
          s
        ] ?? s,
    )
    .replace(/\s+/g, ' ')
    .trim();
}
export function date(value: unknown): number | null {
  const n = Date.parse(str(value));
  return Number.isFinite(n) ? Math.floor(n / 1000) : null;
}
const strings = (value: unknown): string[] => array(value).map(str).filter(Boolean);
const sourceText = (value: unknown): string => str(value).replace(/\s+/g, ' ').trim();
export const advisoryTitle = (value: string): string =>
  value
    .replace(/^SSA-\d+\s*(?:V[\d.]+)?(?:\s*\([^)]*\))?\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
export function parseFeed(xml: string): FeedEntry[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error('Invalid or unsafe Atom XML');
  const root = obj(
    new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false }).parse(
      xml,
    ),
  );
  if (!Object.hasOwn(root, 'feed')) throw new Error('Expected an Atom feed');
  const entries = array(obj(root.feed).entry);
  if (entries.length > 10000) throw new Error('Too many Atom entries');
  const result: FeedEntry[] = [];
  for (const raw of entries) {
    const e = obj(raw);
    const link = array(e.link)
      .map(obj)
      .find((l) => l['@_rel'] === 'alternate' || !l['@_rel']);
    const url = safeLink(str(link?.['@_href']));
    const id = (str(e.id) + ' ' + str(e.title) + ' ' + (url ?? ''))
      .match(/ssa-\d{6}/i)?.[0]
      .toUpperCase();
    const updated = date(e.updated);
    if (!id || !url || !updated || !str(e.title)) continue;
    result.push({
      id,
      feedId: str(e.id),
      title: plain(e.title),
      summary: plain(typeof e.summary === 'object' ? obj(e.summary)['#text'] : e.summary),
      link: url,
      updated,
      published: date(e.published),
    });
  }
  if (entries.length && !result.length)
    throw new Error('No valid advisory entries in nonempty feed');
  return result;
}

export function parseCsaf(raw: unknown, expectedId: string): Details {
  jsonBytes(raw, CSAF_LIMITS.inputBytes);
  const budget = new Budget();
  const remedies = new Map<string, Remedy>();
  const references = new Map<string, Map<string, RemedyReference>>();
  const root = obj(raw),
    document = obj(root.document),
    tracking = obj(document.tracking);
  if (str(tracking.id).toUpperCase() !== expectedId || !/^2\./.test(str(document.csaf_version)))
    throw new Error('Unsupported CSAF document or advisory ID mismatch');
  const products = new Map<string, Product>();
  const tree = obj(root.product_tree);
  function visit(branches: unknown, parent = '', depth = 0): void {
    if (depth > 32) throw new Error('CSAF product tree too deep');
    for (const rawBranch of array(branches)) {
      budget.step();
      const b = obj(rawBranch),
        p = obj(b.product),
        category = str(b.category);
      const name = category === 'product_name' ? str(b.name) : parent;
      const id = str(p.product_id);
      if (id)
        products.set(id, {
          id,
          name: name || str(p.name),
          version: str(p.name),
          status: [],
          cves: [],
          remedies: [],
        });
      visit(b.branches, name, depth + 1);
    }
  }
  visit(tree.branches);
  for (const p of array(tree.full_product_names).map(obj)) {
    const id = str(p.product_id);
    if (id && !products.has(id))
      products.set(id, {
        id,
        name: str(p.name),
        version: str(p.name),
        status: [],
        cves: [],
        remedies: [],
      });
  }
  for (const r of array(tree.relationships).map(obj)) {
    const p = obj(r.full_product_name),
      id = str(p.product_id);
    if (id)
      products.set(id, {
        id,
        name: str(p.name),
        version: str(p.name),
        status: [],
        cves: [],
        remedies: [],
      });
  }
  if (products.size > 20000) throw new Error('CSAF document exceeds item limits');
  for (const p of products.values()) {
    budget.add(p);
    references.set(p.id, new Map());
  }
  const groups = new Map<string, Set<string>>();
  for (const value of array(tree.product_groups)) {
    const group = obj(value);
    const ids = strings(group.product_ids);
    budget.step(ids.length + 1);
    groups.set(str(group.group_id), new Set(ids));
  }
  const scores: Score[] = [],
    cves = new Set<string>();
  const vulnerabilities = array(root.vulnerabilities);
  if (vulnerabilities.length > 20000 || products.size > 20000)
    throw new Error('CSAF document exceeds item limits');
  for (const rawVulnerability of vulnerabilities) {
    budget.step();
    const v = obj(rawVulnerability),
      cve = str(v.cve);
    if (cve) cves.add(cve);
    for (const [status, ids] of Object.entries(obj(v.product_status)))
      for (const id of strings(ids)) {
        budget.step();
        const p = products.get(id);
        if (p) {
          if (!p.status.includes(status)) {
            budget.add(status);
            p.status.push(status);
          }
          if (cve && !p.cves.includes(cve)) {
            budget.add(cve);
            p.cves.push(cve);
          }
        }
      }
    for (const rawRemedy of array(v.remediations)) {
      budget.step();
      const r = obj(rawRemedy);
      const textValue = typeof r.details === 'string' ? r.details : '';
      if (Buffer.byteLength(textValue) > CSAF_LIMITS.textBytes)
        throw new Error('CSAF remediation text budget exceeded');
      const category = str(r.category),
        text = sourceText(textValue),
        url = safeLink(str(r.url));
      const remedyId = hash([category, text, url]);
      const targets = new Set<string>();
      const direct = strings(r.product_ids),
        groupIds = strings(r.group_ids);
      budget.step(direct.length + groupIds.length);
      const hasScope = array(r.product_ids).length > 0 || array(r.group_ids).length > 0;
      for (const id of hasScope ? direct : strings(obj(v.product_status).known_affected)) {
        budget.step();
        targets.add(id);
      }
      for (const group of new Set(groupIds)) {
        for (const id of groups.get(group) ?? []) {
          budget.step();
          targets.add(id);
        }
      }
      for (const id of targets) {
        budget.step();
        const p = products.get(id);
        if (!p) continue;
        if (!remedies.has(remedyId)) {
          const definition = { id: remedyId, category, text, url };
          budget.add(definition);
          remedies.set(remedyId, definition);
        }
        const refs = references.get(id)!;
        const existing = refs.get(remedyId);
        if (existing) {
          if (cve && !existing.cves.includes(cve)) {
            budget.add(cve);
            existing.cves.push(cve);
          }
        } else {
          budget.relation();
          const ref = { remedyId, cves: cve ? [cve] : [] };
          budget.add(ref);
          refs.set(remedyId, ref);
          p.remedies.push(ref);
        }
      }
    }
    for (const s of array(v.scores).map(obj))
      for (const key of ['cvss_v3', 'cvss_v4', 'cvss_v2']) {
        const cvss = obj(s[key]),
          value = cvss.baseScore;
        if (typeof value === 'number' && value >= 0 && value <= 10) {
          const score: Score = {
            value,
            version:
              str(cvss.version) || (key === 'cvss_v4' ? '4.0' : key === 'cvss_v2' ? '2.0' : '3.1'),
            vector: str(cvss.vectorString),
            products: strings(s.products),
          };
          budget.step(score.products.length + 1);
          budget.add(score);
          scores.push(score);
        }
      }
  }
  const notes = array(document.notes).map(obj);
  const history = array(tracking.revision_history)
    .map(obj)
    .sort((a, b) => (date(b.date) ?? 0) - (date(a.date) ?? 0));
  const updated = date(tracking.current_release_date);
  if (!updated) throw new Error('CSAF missing current release date');
  const details: Details = {
    schemaVersion: 2,
    remedies: [...remedies.values()],
    title: sourceText(document.title),
    summary: sourceText(notes.find((n) => n.category === 'summary')?.text),
    published: date(tracking.initial_release_date),
    updated,
    revision: str(tracking.version),
    revisionSummary: sourceText(history[0]?.summary),
    aggregateSeverity: sourceText(obj(document.aggregate_severity).text) || null,
    products: [...products.values()],
    scores,
    cves: [...cves],
  };
  jsonBytes(details);
  return details;
}
