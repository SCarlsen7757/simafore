/* global document */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || '../data/tooling/node_modules/playwright/index.mjs'
);
const output = 'data/browser-check';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const scene of ['default', 'empty', 'single', 'long', 'missing', 'partial', 'stale']) {
    await page.goto(`http://127.0.0.1:8097/tv?scene=${scene}`);
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('.focus:not([hidden])').count(), scene === 'empty' ? 0 : 1);
    if (scene === 'stale') assert.equal(await page.locator('#status').innerText(), 'Feed stale');
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll('.focus:not([hidden]) .focus-bottom,footer,.rail li')].map(
        (e) => {
          const b = e.getBoundingClientRect();
          return { name: e.className, x: b.x, y: b.y, right: b.right, bottom: b.bottom };
        },
      ),
    );
    for (const box of boxes)
      assert.ok(
        box.x >= 0 && box.y >= 0 && box.right <= 1921 && box.bottom <= 1081,
        `${scene}: ${JSON.stringify(box)}`,
      );
    const overlap = await page.evaluate(() => {
      const content = document.querySelector('.focus:not([hidden]) .focus-bottom');
      const footer = document.querySelector('footer');
      return content
        ? content.getBoundingClientRect().bottom > footer.getBoundingClientRect().top
        : false;
    });
    assert.equal(overlap, false, scene + ': focus overlaps footer');
    await page.screenshot({ path: `${output}/${scene}.png` });
  }
  await page.goto('http://127.0.0.1:8097/tv');
  await page.waitForTimeout(5500);
  assert.equal(await page.locator('#position').innerText(), '2 / 6');
  await page.context().setOffline(true);
  await page.waitForTimeout(16000);
  assert.equal(await page.locator('#status').innerText(), 'Connection unavailable');
  assert.equal(await page.locator('.focus:not([hidden])').count(), 1);
  await page.context().setOffline(false);
  await page.clock.install();
  await page.goto('http://127.0.0.1:8097/tv');
  await page.clock.runFor(300000);
  assert.equal(
    await page.locator('#position').innerText(),
    '1 / 6',
    'Complete five-minute rotation',
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(100);
  const fits = await page.evaluate(() => {
    const r = document.querySelector('.screen').getBoundingClientRect();
    return r.right <= 1281 && r.bottom <= 721;
  });
  assert.ok(fits, 'Scaled 720p display fits');
  assert.deepEqual(errors, []);
  console.log(
    'Seven visual scenes, rotation and offline continuity passed. Screenshots: ' + output,
  );
} finally {
  await browser.close();
}
