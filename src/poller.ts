import type { Config, PriorityMode } from './config.js';
import { Store, hash } from './db.js';
import { fetchFeed, fetchCsaf, UpstreamCooldownError } from './feed.js';
import { parseFeed, parseCsaf } from './parse.js';
import { select, matches } from './selection.js';
import type { DisplayAdvisory, Snapshot } from './types.js';
const now = () => Math.floor(Date.now() / 1000);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export class Poller {
  private views = new Map<PriorityMode, { items: DisplayAdvisory[]; revision: string }>();
  private stats = { pending: 0, failed: 0 };
  private itemCount = 0;
  private day = -1;
  private polling: Promise<void> | null = null;
  private working: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private workerTimer: NodeJS.Timeout | undefined;
  private outboundBusy = false;
  private pollDeferred = false;
  private stopped = true;
  readonly store: Store;
  readonly config: Config;
  private transport: { fetchFeed: typeof fetchFeed; fetchCsaf: typeof fetchCsaf };
  constructor(store: Store, config: Config, transport = { fetchFeed, fetchCsaf }) {
    this.store = store;
    this.config = config;
    this.transport = transport;
    this.refresh();
  }
  refresh(): void {
    const all = this.store.all();
    const views = new Map<PriorityMode, { items: DisplayAdvisory[]; revision: string }>();
    const time = now();
    for (const mode of ['recent-severity', 'newest-first', 'highest-severity'] as const) {
      const items = select(all, { ...this.config, priorityMode: mode }, time);
      views.set(mode, { items, revision: this.revision(items, mode) });
    }
    this.views = views;
    this.stats = this.store.queueStats();
    this.itemCount = all.length;
    this.day = Math.floor(time / 86400);
  }
  private revision(items: DisplayAdvisory[], priorityMode: PriorityMode): string {
    return hash({
      config: [
        priorityMode,
        this.config.recentDays,
        this.config.severityDays,
        this.config.families,
        this.config.keywords,
      ],
      items: items
        .slice(0, Math.max(this.config.heroCount, this.config.railCount))
        .map(({ enrichedAt: _at, firstSeen: _seen, ...i }) => i),
    });
  }
  snapshot(priorityMode: PriorityMode = this.config.priorityMode): Snapshot {
    if (this.day !== Math.floor(now() / 86400)) this.refresh();
    const { items, revision } = this.views.get(priorityMode)!;
    const lastSuccess = Number(this.store.meta('last_success')) || null;
    const stats = this.stats;
    return {
      items,
      itemCount: this.itemCount,
      matchingCount: items.length,
      contentRevision: revision,
      lastSuccess,
      lastChecked: Number(this.store.meta('last_checked')) || null,
      lastError: this.store.meta('last_error') || null,
      stale: lastSuccess === null || now() - lastSuccess > this.config.staleAfterMin * 60,
      enrichmentPending: stats.pending,
      enrichmentFailed: stats.failed,
      upstreamCooldownUntil:
        Number(this.store.meta('upstream_cooldown_until')) > now()
          ? Number(this.store.meta('upstream_cooldown_until'))
          : null,
    };
  }
  pollOnce(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.performPoll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }
  private nextRequestAt(): number {
    return Math.max(
      Number(this.store.meta('next_request_at')) || 0,
      Number(this.store.meta('upstream_cooldown_until')) || 0,
    );
  }
  private beginRequest(): boolean {
    if (this.outboundBusy || now() < this.nextRequestAt()) return false;
    this.outboundBusy = true;
    this.store.setMeta({ next_request_at: now() + this.config.requestIntervalSeconds });
    return true;
  }
  private requestSucceeded(): void {
    this.store.setMeta({ upstream_backoff_count: 0 });
  }
  private requestFailed(error: unknown): void {
    if (!(error instanceof UpstreamCooldownError)) return;
    const count = Number(this.store.meta('upstream_backoff_count')) || 0;
    const delay = Math.min(86400, this.config.rateLimitCooldownMin * 60 * 2 ** Math.min(count, 10));
    const until = Math.max(this.nextRequestAt(), now() + delay, error.retryAt ?? 0);
    this.store.setMeta({ upstream_cooldown_until: until, upstream_backoff_count: count + 1 });
    console.warn(`[upstream] Requests paused until ${new Date(until * 1000).toISOString()}`);
  }
  private async performPoll(): Promise<void> {
    this.pollDeferred = !this.beginRequest();
    if (this.pollDeferred) return;
    try {
      const res = await this.transport.fetchFeed(
        this.config,
        this.store.meta('etag'),
        this.store.meta('modified'),
      );
      if (res.status === 200) {
        const digest = hash(res.xml);
        if (digest !== this.store.meta('body_hash')) {
          this.store.ingest(
            parseFeed(res.xml),
            (e) =>
              matches(e.title + ' ' + e.summary, [...this.config.families, ...this.config.keywords])
                .length > 0,
          );
          this.store.setMeta({ body_hash: digest });
        }
        this.store.setMeta({ etag: res.etag, modified: res.modified });
      } else if (!this.store.meta('last_success'))
        throw new Error('Unexpected 304 without cached feed');
      this.store.setMeta({ last_success: now(), last_checked: now(), last_error: '' });
      this.requestSucceeded();
      this.refresh();
      console.log(`[poll] ${new Date().toISOString()} ${res.status}; ${this.itemCount} retained`);
    } catch (error) {
      this.requestFailed(error);
      this.store.setMeta({ last_checked: now(), last_error: message(error) });
      console.error('[poll]', message(error));
    } finally {
      this.outboundBusy = false;
    }
  }
  workOnce(): Promise<void> {
    if (this.working) return this.working;
    this.working = this.performWork().finally(() => {
      this.working = null;
    });
    return this.working;
  }
  private async performWork(): Promise<void> {
    const job = this.store.jobs(1)[0];
    if (!job || !this.beginRequest()) return;
    try {
      const raw = await this.transport.fetchCsaf(job.id, this.config);
      this.store.enrich(job.id, job.updated, parseCsaf(raw, job.id), raw);
      this.requestSucceeded();
    } catch (error) {
      this.requestFailed(error);
      this.store.fail(job.id, job.updated, job.attempts, message(error));
      console.error(`[enrich] ${job.id}: ${message(error)}`);
    } finally {
      this.outboundBusy = false;
      this.refresh();
    }
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const poll = async () => {
      try {
        await this.pollOnce();
      } finally {
        if (!this.stopped)
          this.timer = setTimeout(
            () => {
              void poll();
            },
            this.pollDeferred
              ? Math.max(1000, Math.min(60000, (this.nextRequestAt() - now()) * 1000))
              : this.config.pollIntervalMin * 60000,
          );
      }
    };
    const work = async () => {
      try {
        await this.workOnce();
      } catch (error) {
        console.error('[worker]', message(error));
      } finally {
        if (!this.stopped)
          this.workerTimer = setTimeout(() => {
            void work();
          }, this.config.requestIntervalSeconds * 1000);
      }
    };
    if (this.config.pollOnStart) void poll();
    else
      this.timer = setTimeout(() => {
        void poll();
      }, this.config.pollIntervalMin * 60000);
    void work();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.workerTimer);
    await Promise.all([this.polling, this.working]);
  }
}
