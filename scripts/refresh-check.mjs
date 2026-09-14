import assert from 'node:assert/strict';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || '../data/tooling/node_modules/playwright/index.mjs'
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.clock.install();
  await page.route('**/api/advisories*', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.contentRevision = 'changed';
    await route.fulfill({ json });
  });
  await page.goto('http://127.0.0.1:8097/tv?scene=single');
  const title = await page.locator('h1').innerText();
  await page.route('**/tv?*', (route) => route.abort());
  await page.clock.runFor(6000);
  assert.equal(
    await page.locator('h1').innerText(),
    title,
    'Failed refresh must retain the advisory',
  );
  assert.equal(await page.locator('#status').innerText(), 'Connection unavailable');
  await page.unroute('**/tv?*');
  await page.clock.runFor(16000);
  assert.equal(await page.locator('#status').innerText(), 'Feed current');
  assert.equal(
    await page.locator('.focus').count(),
    1,
    'Recovery adopts complete rendered response',
  );
  assert.match(page.url(), /scene=single/, 'Content updates without page navigation');
  console.log('Connection loss during refresh preserves the screen; recovery updates in place');
} finally {
  await browser.close();
}
