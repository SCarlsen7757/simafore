import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedBody, retryAfter, cooldownError } from '../src/feed.js';
test('stream and content-length limits bound downloads after decompression', async () => {
  assert.equal(await boundedBody(new Response('hello'), 5), 'hello');
  await assert.rejects(() => boundedBody(new Response('too long'), 3), /too large/);
  await assert.rejects(
    () => boundedBody(new Response('hello', { headers: { 'content-length': '99999' } }), 10),
    /too large/,
  );
  await assert.rejects(() => boundedBody(new Response(null), 10), /Empty/);
});

test('Retry-After supports seconds and dates; rate-limit and blocked pages trigger cooldown', () => {
  const now = 1800000000;
  assert.equal(retryAfter('120', now), now + 120);
  assert.equal(retryAfter(new Date((now + 300) * 1000).toUTCString(), now), now + 300);
  assert.equal(retryAfter('invalid', now), null);
  assert.ok(cooldownError(new Response('', { status: 403 })));
  assert.equal(
    cooldownError(new Response('', { status: 429, headers: { 'Retry-After': '7200' } }), '', now)
      ?.retryAt,
    now + 7200,
  );
  assert.ok(
    cooldownError(
      new Response('', { headers: { 'Content-Type': 'text/html' } }),
      '<h1>You made too many requests</h1>',
    ),
  );
  assert.equal(
    cooldownError(
      new Response('', { headers: { 'Content-Type': 'application/json' } }),
      '{"document":{"title":"Rate limited authentication issue"}}',
    ),
    null,
  );
});
