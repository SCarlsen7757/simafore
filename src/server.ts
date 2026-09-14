import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config, isPriorityMode } from './config.js';
import type { Config } from './config.js';
import { Store } from './db.js';
import { Poller } from './poller.js';
import { renderBoard } from './render.js';

export function createBoardServer(poller: Poller, settings: Config = config) {
  const assets: Record<string, string> = {
    '/board.css': 'text/css',
    '/board.js': 'text/javascript',
    '/source-sans-3.otf': 'font/otf',
  };
  return createServer((req, res) => {
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const handle = async () => {
      let url: URL, path: string;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
        path = decodeURIComponent(url.pathname);
        if ([...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
          throw new Error('control');
      } catch {
        send(400, 'text/plain', 'bad request');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(405, 'text/plain', 'method not allowed');
        return;
      }
      if (path === '/') {
        res.writeHead(302, { Location: '/tv' + url.search, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const type = assets[path];
      if (type) {
        const buffer = await readFile(
          fileURLToPath(new URL('../../public' + path, import.meta.url)),
        );
        send(200, type, buffer);
        return;
      }
      if (!['/tv', '/tv/', '/api/advisories', '/healthz'].includes(path)) {
        send(404, 'text/plain', 'not found');
        return;
      }
      const strategy = url.searchParams.get('strategy');
      const viewRoute = ['/tv', '/tv/', '/api/advisories'].includes(path);
      if (viewRoute && strategy !== null && !isPriorityMode(strategy)) {
        send(
          400,
          'text/plain',
          'strategy must be recent-severity, newest-first, or highest-severity',
        );
        return;
      }
      const priorityMode =
        viewRoute && strategy !== null && isPriorityMode(strategy)
          ? strategy
          : settings.priorityMode;
      const viewSettings = { ...settings, priorityMode };
      const snapshot = poller.snapshot(priorityMode);
      if (path === '/tv' || path === '/tv/') {
        send(
          200,
          'text/html; charset=utf-8',
          req.method === 'HEAD' ? '' : renderBoard(snapshot, viewSettings),
        );
        return;
      }
      if (path === '/api/advisories') {
        const requested = Number(url.searchParams.get('limit'));
        const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : 25;
        send(
          200,
          'application/json',
          req.method === 'HEAD'
            ? ''
            : JSON.stringify({
                ...snapshot,
                source: {
                  title: 'Siemens ProductCERT security advisories',
                  link: 'https://www.siemens.com/cert/advisories',
                },
                priorityMode,
                items: snapshot.items.slice(0, limit),
              }),
        );
        return;
      }
      if (path === '/healthz') {
        const ok = snapshot.lastSuccess !== null || snapshot.itemCount > 0;
        send(
          ok ? 200 : 503,
          'application/json',
          JSON.stringify({
            ok,
            itemCount: snapshot.itemCount,
            matchingCount: snapshot.matchingCount,
            stale: snapshot.stale,
            lastSuccess: snapshot.lastSuccess,
            enrichmentPending: snapshot.enrichmentPending,
            upstreamCooldownUntil: snapshot.upstreamCooldownUntil,
          }),
        );
        return;
      }
      send(404, 'text/plain', 'not found');
    };
    void handle().catch((error) => {
      console.error('[http]', error);
      if (!res.headersSent) send(500, 'text/plain', 'internal error');
      else res.destroy();
    });
  });
}
if (import.meta.main) {
  const store = new Store(config.dbPath),
    poller = new Poller(store, config);
  const server = createBoardServer(poller);
  server.listen(config.port, () => {
    console.log(`[boot] Siemens board http://0.0.0.0:${config.port}/tv`);
    poller.start();
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      server.close();
      void poller.stop().then(() => {
        store.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 35000).unref();
    });
}
