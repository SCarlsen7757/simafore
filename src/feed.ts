import type { Config } from './config.js';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
export class UpstreamCooldownError extends Error {
  readonly retryAt: number | null;
  constructor(message: string, retryAt: number | null) {
    super(message);
    this.name = 'UpstreamCooldownError';
    this.retryAt = retryAt;
  }
}
export function retryAfter(
  value: string | null,
  now = Math.floor(Date.now() / 1000),
): number | null {
  if (!value?.trim()) return null;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) &&
      Number.isSafeInteger(now + seconds) &&
      now + seconds <= 8640000000000
      ? now + seconds
      : null;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(now, Math.ceil(at / 1000)) : null;
}
export function cooldownError(
  response: Response,
  body = '',
  now = Math.floor(Date.now() / 1000),
): UpstreamCooldownError | null {
  const hint = retryAfter(response.headers.get('retry-after'), now);
  const html = /text\/html/i.test(response.headers.get('content-type') ?? '') || /^\s*</.test(body);
  const blockedPage =
    html && /too many requests|made too? many requests|rate limit(?:ed| exceeded)/i.test(body);
  return response.status === 403 ||
    response.status === 429 ||
    (response.status === 503 && hint !== null) ||
    blockedPage
    ? new UpstreamCooldownError(
        `Siemens request blocked (HTTP ${response.status}); shared cooldown`,
        hint,
      )
    : null;
}
async function checkedBody(response: Response, limit: number): Promise<string> {
  const error = cooldownError(response);
  if (error || !response.ok) {
    await response.body?.cancel();
    throw error ?? new Error(`Siemens HTTP ${response.status}`);
  }
  const body = await boundedBody(response, limit);
  const bodyError = cooldownError(response, body);
  if (bodyError) throw bodyError;
  return body;
}
export async function boundedBody(response: Response, max: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  if (!response.body) throw new Error('Empty response body');
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error('Response too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function fetchFeed(config: Config, etag: string | null, modified: string | null) {
  const headers: Record<string, string> = {
    'User-Agent': config.userAgent,
    Accept: 'application/atom+xml, application/xml',
    'Accept-Language': 'en',
  };
  if (etag) headers['If-None-Match'] = etag;
  if (modified) headers['If-Modified-Since'] = modified;
  const res = await fetch(config.feedUrl, {
    headers,
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (res.status === 304) return { status: 304 as const };
  return {
    status: 200 as const,
    xml: await checkedBody(res, 10 * 1024 * 1024),
    etag: res.headers.get('etag') ?? '',
    modified: res.headers.get('last-modified') ?? '',
  };
}
export async function fetchCsaf(id: string, config: Config): Promise<string> {
  if (!/^SSA-\d{6}$/.test(id)) throw new Error('Invalid advisory ID');
  const res = await fetch(
    `https://cert-portal.siemens.com/productcert/csaf/${id.toLowerCase()}.json`,
    {
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    },
  );
  return checkedBody(res, 20 * 1024 * 1024);
}
