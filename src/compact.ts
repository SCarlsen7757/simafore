import type { Details, Product, Remedy, RemedyReference } from './types.js';
import { Budget, CSAF_LIMITS, jsonBytes } from './budget.js';
import { hash } from './fingerprint.js';
import { obj, array, str } from './parse.js';

export function compactLegacy(raw: unknown): Details {
  jsonBytes(raw, CSAF_LIMITS.inputBytes);
  const legacy = obj(raw);
  const budget = new Budget();
  const definitions = new Map<string, Remedy>();
  const products: Product[] = [];
  if (array(legacy.products).length > 20000) throw new Error('CSAF document exceeds item limits');
  for (const value of array(legacy.products)) {
    const p = obj(value);
    const refs = new Map<string, RemedyReference>();
    for (const value of array(p.remedies)) {
      budget.step();
      const r = obj(value);
      const text = str(r.text);
      if (typeof r.text === 'string' && Buffer.byteLength(r.text) > CSAF_LIMITS.textBytes)
        throw new Error('CSAF remediation text budget exceeded');
      const category = str(r.category),
        url = str(r.url);
      const id = hash([category, text, url]);
      if (!definitions.has(id)) {
        const definition = { id, category, text, url };
        budget.add(definition);
        definitions.set(id, definition);
      }
      let ref = refs.get(id);
      if (!ref) {
        budget.relation();
        ref = { remedyId: id, cves: [] };
        budget.add(ref);
        refs.set(id, ref);
      }
      for (const cve of array(r.cves).map(str)) {
        budget.step();
        if (cve && !ref.cves.includes(cve)) {
          budget.add(cve);
          ref.cves.push(cve);
        }
      }
    }
    const product = { ...p, remedies: [...refs.values()] } as unknown as Product;
    budget.add({ ...product, remedies: [] });
    products.push(product);
  }
  const details = {
    ...legacy,
    schemaVersion: 2,
    products,
    remedies: [...definitions.values()],
  } as unknown as Details;
  jsonBytes(details);
  return details;
}

export function productRemedies(
  p: Product,
  definitions: ReadonlyMap<string, Remedy>,
): (Remedy & { cves: string[] })[] {
  return p.remedies.flatMap((ref) => {
    const r = definitions.get(ref.remedyId);
    return r ? [{ ...r, cves: ref.cves }] : [];
  });
}
