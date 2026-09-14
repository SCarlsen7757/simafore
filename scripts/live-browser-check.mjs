// Optional read-only check of an already-running local deployment.
/* global document */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || '../data/tooling/node_modules/playwright/index.mjs'
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (/Refused to|Content Security Policy/i.test(m.text())) errors.push(m.text());
  });
  await page.goto((process.env.LIVE_URL || 'http://127.0.0.1:8081') + '/tv');
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('#status').innerText(), 'Feed current');
  const count = await page.locator('.focus').count();
  assert.ok(count > 0);
  await mkdir('data/browser-check', { recursive: true });
  for (let i = 0; i < count; i++) {
    await page.evaluate((index) => {
      document.querySelectorAll('.focus').forEach((e, n) => {
        e.hidden = n !== index;
      });
      document
        .querySelectorAll('[data-rail]')
        .forEach((e, n) => e.classList.toggle('active', n === index));
    }, i);
    const metrics = await page.evaluate(() => {
      const focus = document.querySelector('.focus:not([hidden])');
      const bottom = focus.querySelector('.focus-bottom').getBoundingClientRect();
      return {
        bottom: bottom.bottom,
        footer: document.querySelector('footer').getBoundingClientRect().top,
        title: focus.querySelector('h1').textContent,
      };
    });
    assert.ok(metrics.bottom <= metrics.footer, JSON.stringify(metrics));
    await page.screenshot({ path: `data/browser-check/live-${i + 1}.png` });
  }
  assert.deepEqual(errors, []);
  console.log(`${count} live advisory layouts passed without runtime or CSP errors`);
} finally {
  await browser.close();
}
