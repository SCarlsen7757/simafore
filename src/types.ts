export interface FeedEntry {
  id: string;
  feedId: string;
  title: string;
  summary: string;
  link: string;
  updated: number;
  published: number | null;
}
export interface Score {
  value: number;
  version: string;
  vector: string;
  products: string[];
}
export interface Remedy {
  id: string;
  category: string;
  text: string;
  url: string | null;
}
export interface RemedyReference {
  remedyId: string;
  cves: string[];
}
export interface Product {
  id: string;
  name: string;
  version: string;
  status: string[];
  cves: string[];
  remedies: RemedyReference[];
}
export interface Details {
  schemaVersion: 2;
  remedies: Remedy[];
  title: string;
  summary: string;
  published: number | null;
  updated: number;
  revision: string;
  revisionSummary: string;
  aggregateSeverity: string | null;
  products: Product[];
  scores: Score[];
  cves: string[];
}
export interface Advisory extends FeedEntry {
  schemaVersion?: 2;
  detailsFingerprint?: string;
  firstSeen: number;
  materialDate: number;
  details: Details | null;
  enrichedAt: number | null;
  enrichedUpdated: number | null;
  enrichmentError: string | null;
}
export interface DisplayAdvisory extends Advisory {
  matchedFamilies: string[];
  matchedProducts: Product[];
  provisional: boolean;
  score: Score | null;
  scoreScope: 'matched-products' | 'advisory';
  severity: string;
}
export interface Snapshot {
  items: DisplayAdvisory[];
  itemCount: number;
  matchingCount: number;
  contentRevision: string;
  lastSuccess: number | null;
  lastChecked: number | null;
  lastError: string | null;
  stale: boolean;
  enrichmentPending: number;
  enrichmentFailed: number;
  upstreamCooldownUntil: number | null;
}
