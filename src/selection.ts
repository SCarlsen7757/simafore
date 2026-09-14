import type { Advisory, DisplayAdvisory, Score } from './types.js';
import type { Config } from './config.js';

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/s7[-\s]*plcsim/g, 'plcsim')
    .replace(/[^a-z0-9]/g, '');
}
export function matches(text: string, terms: string[]): string[] {
  const value = normalize(text);
  return terms.filter((term) => value.includes(normalize(term)));
}
function bestScore(scores: Score[]): Score | null {
  for (const major of ['3', '4', '2']) {
    const candidates = scores
      .filter((s) => s.version.startsWith(major))
      .sort((a, b) => b.value - a.value);
    if (candidates.length) return candidates[0] ?? null;
  }
  return null;
}
export function classify(item: Advisory, config: Config): DisplayAdvisory | null {
  const terms = [...config.families, ...config.keywords];
  const affected = item.details?.products.filter((p) => p.status.includes('known_affected')) ?? [];
  const matchedProducts = affected.filter((p) => matches(p.name + ' ' + p.version, terms).length);
  // Once structured affected-product data exists, title mentions cannot override it.
  const structured = Boolean(item.details?.products.some((p) => p.status.length));
  const matchedFamilies = structured
    ? [...new Set(matchedProducts.flatMap((p) => matches(p.name + ' ' + p.version, terms)))]
    : matches(item.title + ' ' + item.summary + ' ' + item.id, terms);
  if (!matchedFamilies.length) return null;
  const scores = item.details?.scores ?? [];
  const ids = new Set(matchedProducts.map((p) => p.id));
  const applicable = scores.filter((s) => s.products.some((id) => ids.has(id)));
  const score = bestScore(applicable.length ? applicable : scores);
  const suppliedSeverity = item.details?.aggregateSeverity?.toLowerCase();
  const severityFallback = ['critical', 'high', 'medium', 'low', 'none'].includes(
    suppliedSeverity ?? '',
  )
    ? suppliedSeverity![0]!.toUpperCase() + suppliedSeverity!.slice(1)
    : 'Unknown';
  return {
    ...item,
    matchedFamilies,
    matchedProducts,
    provisional: !structured,
    score,
    scoreScope: applicable.length ? 'matched-products' : 'advisory',
    severity:
      score === null
        ? severityFallback
        : score.value >= 9
          ? 'Critical'
          : score.value >= 7
            ? 'High'
            : score.value >= 4
              ? 'Medium'
              : score.value > 0
                ? 'Low'
                : 'None',
  };
}
export function select(
  items: Advisory[],
  config: Config,
  now = Math.floor(Date.now() / 1000),
): DisplayAdvisory[] {
  const cutoff = now - config.recentDays * 86400;
  const priorityCutoff = now - config.severityDays * 86400;
  return items
    .map((i) => classify(i, config))
    .filter((i): i is DisplayAdvisory => i !== null)
    .filter((i) => config.priorityMode !== 'recent-severity' || i.materialDate >= cutoff)
    .sort((a, b) => {
      const severityRank = (item: DisplayAdvisory): number =>
        item.score?.value ??
        { Critical: 9, High: 7, Medium: 4, Low: 1, None: 0 }[item.severity] ??
        -1;
      const severity = severityRank(b) - severityRank(a);
      const recency = b.materialDate - a.materialDate;
      if (config.priorityMode === 'newest-first')
        return recency || severity || a.id.localeCompare(b.id);
      if (config.priorityMode === 'highest-severity')
        return severity || recency || a.id.localeCompare(b.id);
      const aRecent = a.materialDate >= priorityCutoff,
        bRecent = b.materialDate >= priorityCutoff;
      if (aRecent !== bRecent) return aRecent ? -1 : 1;
      return (aRecent ? severity || recency : recency || severity) || a.id.localeCompare(b.id);
    });
}
