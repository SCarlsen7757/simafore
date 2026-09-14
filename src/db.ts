import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Advisory, Details, FeedEntry } from './types.js';
import { advisoryTitle } from './parse.js';
import { hash, fingerprint } from './fingerprint.js';
import { CSAF_LIMITS, jsonBytes } from './budget.js';
export { hash };
const titleContent = advisoryTitle;
const now = () => Math.floor(Date.now() / 1000);
interface Row {
  data: string;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS advisories (id TEXT PRIMARY KEY, data TEXT NOT NULL, raw_csaf TEXT);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, updated INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS legacy_archive (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version=2;`);
  }
  close(): void {
    this.db.close();
  }
  all(): Advisory[] {
    return (this.db.prepare('SELECT data FROM advisories').all() as unknown as Row[]).map((r) =>
      this.read(r.data),
    );
  }
  get(id: string): Advisory | null {
    const row = this.db.prepare('SELECT data FROM advisories WHERE id=?').get(id) as unknown as
      Row | undefined;
    return row ? this.read(row.data) : null;
  }
  private read(data: string): Advisory {
    const item = JSON.parse(data) as Advisory;
    if (item.details && item.details.schemaVersion !== 2) {
      item.details = null;
      item.enrichmentError =
        this.meta('migration_error:' + item.id) || 'Cached details migration pending';
    }
    return item;
  }
  legacyRows(): { id: string }[] {
    return this.db
      .prepare(
        "SELECT id FROM advisories WHERE json_extract(data,'$.details') IS NOT NULL AND coalesce(json_extract(data,'$.details.schemaVersion'),0) != 2",
      )
      .all() as unknown as { id: string }[];
  }
  legacyDetails(id: string): string {
    const row = this.db
      .prepare("SELECT json_extract(data,'$.details') AS data FROM advisories WHERE id=?")
      .get(id) as unknown as Row;
    return row.data;
  }
  migrate(id: string, details: Details, detailsFingerprint: string): void {
    const row = this.db.prepare('SELECT data FROM advisories WHERE id=?').get(id) as
      Row | undefined;
    if (!row) return;
    const item = {
      ...(JSON.parse(row.data) as Advisory),
      details,
      detailsFingerprint,
      schemaVersion: 2 as const,
    };
    jsonBytes(item);
    this.save(item);
  }
  migrationFailed(id: string, error: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO legacy_archive SELECT id,data FROM advisories WHERE id=?')
      .run(id);
    this.setMeta({ ['migration_error:' + id]: error });
    const item = this.get(id);
    if (item)
      this.db
        .prepare('INSERT OR IGNORE INTO queue(id,updated,priority) VALUES (?,?,1)')
        .run(id, item.updated);
  }
  save(item: Advisory): void {
    this.db
      .prepare(
        'INSERT INTO advisories(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(item.id, JSON.stringify({ ...item, schemaVersion: 2 }));
  }
  meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }
  setMeta(values: Record<string, string | number>): void {
    const stmt = this.db.prepare(
      'INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    );
    for (const [k, v] of Object.entries(values)) stmt.run(k, String(v));
  }
  ingest(entries: FeedEntry[], relevant: (entry: FeedEntry) => boolean): void {
    this.db.exec('BEGIN');
    try {
      for (const entry of entries) {
        const old = this.get(entry.id);
        if (old && entry.updated < old.updated) continue;
        const material =
          old &&
          (titleContent(old.title) !== titleContent(entry.title) || old.summary !== entry.summary);
        const item: Advisory = {
          ...entry,
          published: entry.published ?? old?.published ?? null,
          firstSeen: old?.firstSeen ?? now(),
          materialDate: old
            ? material
              ? Math.max(old.materialDate, entry.updated)
              : old.materialDate
            : entry.updated,
          details: old?.details ?? null,
          ...(old?.detailsFingerprint ? { detailsFingerprint: old.detailsFingerprint } : {}),
          enrichedAt: old?.enrichedAt ?? null,
          enrichedUpdated: old?.enrichedUpdated ?? null,
          enrichmentError: old?.enrichmentError ?? null,
        };
        this.save(item);
        if (!old?.details || old.updated !== entry.updated || material) {
          this.db
            .prepare(
              `INSERT INTO queue(id,updated,priority) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET priority=excluded.priority, attempts=CASE WHEN queue.updated != excluded.updated THEN 0 ELSE attempts END, next_attempt=CASE WHEN queue.updated != excluded.updated THEN 0 ELSE next_attempt END, updated=excluded.updated`,
            )
            .run(item.id, item.updated, relevant(entry) ? 1 : 0);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  jobs(limit = 2, time = now()): { id: string; updated: number; attempts: number }[] {
    return this.db
      .prepare(
        'SELECT id,updated,attempts FROM queue WHERE next_attempt<=? ORDER BY priority DESC, updated DESC LIMIT ?',
      )
      .all(time, limit) as unknown as { id: string; updated: number; attempts: number }[];
  }
  enrich(
    id: string,
    feedUpdated: number,
    details: Details,
    raw: unknown,
    preparedFingerprint?: string,
  ): void {
    const item = this.get(id);
    if (!item || item.updated !== feedUpdated) return;
    if (details.updated < feedUpdated) throw new Error('CSAF has not caught up with Atom revision');
    // First enrichment establishes the baseline; retries do not create an update event.
    const nextFingerprint = preparedFingerprint ?? fingerprint(details);
    if (item.details && (item.detailsFingerprint ?? fingerprint(item.details)) !== nextFingerprint)
      item.materialDate = Math.max(item.materialDate, details.updated);
    item.details = details;
    item.detailsFingerprint = nextFingerprint;
    item.schemaVersion = 2;
    item.published = details.published ?? item.published;
    item.enrichedAt = now();
    item.enrichedUpdated = feedUpdated;
    item.enrichmentError = null;
    jsonBytes(item);
    const serialized = JSON.stringify(item);
    const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (Buffer.byteLength(rawText) > CSAF_LIMITS.inputBytes)
      throw new Error('CSAF input budget exceeded');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE advisories SET data=? WHERE id=?').run(serialized, id);
      this.db.prepare('UPDATE advisories SET raw_csaf=? WHERE id=?').run(rawText, id);
      this.db.prepare('DELETE FROM queue WHERE id=? AND updated=?').run(id, feedUpdated);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  fail(id: string, revision: number, attempts: number, error: string): void {
    const item = this.get(id);
    if (!item || item.updated !== revision) return;
    item.enrichmentError = error;
    this.save(item);
    this.db
      .prepare('UPDATE queue SET attempts=?, next_attempt=? WHERE id=? AND updated=?')
      .run(attempts + 1, now() + Math.min(86400, 60 * 2 ** Math.min(attempts, 11)), id, revision);
  }
  queueStats(): { pending: number; failed: number } {
    return this.db
      .prepare('SELECT count(*) AS pending, coalesce(sum(attempts>0),0) AS failed FROM queue')
      .get() as unknown as { pending: number; failed: number };
  }
}
