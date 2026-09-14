import { createHash } from 'node:crypto';
import type { Details } from './types.js';
export const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (Array.isArray(value))
    return value
      .map(canonical)
      .map((v) => ({ v, key: JSON.stringify(v) }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ v }) => v);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function fingerprint(d: Details): string {
  return hash(
    canonical({
      title: d.title,
      summary: d.summary,
      products: d.products,
      remedies: d.remedies,
      scores: d.scores,
      aggregateSeverity: d.aggregateSeverity,
      cves: d.cves,
    }),
  );
}
