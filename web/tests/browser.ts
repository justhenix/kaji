import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const output = new URL('../scratch/verification/', import.meta.url);
await mkdir(output, { recursive: true });
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4321';
const browser = await chromium.launch({ headless: true });
const failures: string[] = [];
const errors: string[] = [];
const checks: string[] = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));

async function check(name: string, action: () => Promise<void>) {
  try { await action(); checks.push(name); console.log(`PASS ${name}`); }
  catch (error) { failures.push(`${name}: ${String(error)}`); console.error(`FAIL ${name}: ${error}`); }
}

for (const width of [1440, 1024, 768, 390, 320, 2560]) {
  await check(`home layout at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(base);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('steer your screenhands-free.');
    await expect(page.locator('.feature')).toHaveCount(3);
    const overflow = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(overflow.content).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({ path: new URL(`home-${width}.png`, output).pathname.replace(/^\/(?=[A-Z]:)/, ''), fullPage: true });
  });
}

for (const route of ['/download', '/missing-kaji-page', '/500']) {
  for (const width of [1440, 390, 320]) {
    await check(`${route} at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      const response = await page.goto(`${base}${route}`);
      if (route.includes('missing')) expect(response?.status()).toBe(404);
      else expect(response?.status()).toBe(200);
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: new URL(`${route.replaceAll('/', '')}-${width}.png`, output).pathname.replace(/^\/(?=[A-Z]:)/, ''), fullPage: true });
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(result.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
    });
  }
}

await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(base);
await check('landing page accessibility', async () => {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});
await check('keyboard skip link and visible focus', async () => {
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
});
await check('feature cards are static illustrations without extra captions', async () => {
  await expect(page.locator('.product-demo')).toHaveCount(3);
  await expect(page.locator('.product-demo button, .product-demo a, .product-demo input, .product-demo [tabindex], .product-demo [role="button"]')).toHaveCount(0);
  await expect(page.locator('.feature figcaption, .feature .note')).toHaveCount(0);
  await expect(page.locator('astro-island[component-url*="ProductDemo"]')).toHaveCount(0);
});
await check('dwell visual uses a cursor, timer, target and plain tracking chip', async () => {
  const head = page.locator('.product-demo.head');
  await head.scrollIntoViewIfNeeded();
  await expect(head.locator('.tracking-chip')).toHaveText('Head tracking');
  await expect(head.locator('.tracking-chip svg, .tracking-chip i')).toHaveCount(0);
  await expect(head.locator('.dwell-cursor, .dwell-ring, .dwell-target')).toHaveCount(3);
  await expect(head.locator('.face-panel, .face-landmarks, .head-footer')).toHaveCount(0);
  await head.screenshot({ path: new URL('dwell-static.png', output).pathname.replace(/^\/(?=[A-Z]:)/, '') });
});

async function canvasHash() {
  return page.locator('.hero-cursor canvas').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (const byte of data) { hash ^= byte; hash = Math.imul(hash, 16777619); }
    return hash >>> 0;
  });
}
await check('dither grains displace and return to exact pixel positions', async () => {
  await page.goto(base);
  await page.locator('.hero-cursor canvas.ready').waitFor();
  await page.mouse.move(700, 20);
  const before = await canvasHash();
  const box = await page.locator('.hero-cursor').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * .42, box!.y + box!.height * .38);
  await page.waitForTimeout(300);
  expect(await canvasHash()).not.toBe(before);
  await page.screenshot({ path: new URL('sand-hover.png', output).pathname.replace(/^\/(?=[A-Z]:)/, '') });
  await page.mouse.move(700, 20);
  await expect.poll(canvasHash, { timeout: 5000, intervals: [300, 500] }).toBe(before);
});

await check('reduced motion leaves grains static', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(base);
  await page.locator('.hero-cursor canvas.ready').waitFor();
  const before = await canvasHash();
  const box = await page.locator('.hero-cursor').boundingBox();
  await page.mouse.move(box!.x + box!.width * .42, box!.y + box!.height * .38);
  await page.waitForTimeout(350);
  expect(await canvasHash()).toBe(before);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
await check('mobile landing accessibility and 200% text scaling', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map(v => v.id)).toEqual([]);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
await check('all links have real destinations and images resolve', async () => {
  const invalid = await page.locator('a').evaluateAll(anchors => anchors.filter(a => !a.getAttribute('href') || a.getAttribute('href') === '#').map(a => a.textContent));
  expect(invalid).toEqual([]);
  const broken = await page.locator('img').evaluateAll(images => (images as HTMLImageElement[]).filter(i => i.complete && !i.naturalWidth).map(i => i.src));
  expect(broken).toEqual([]);
});
await check('static page remains complete without JavaScript', async () => {
  const staticContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const staticPage = await staticContext.newPage();
  await staticPage.goto(base);
  await expect(staticPage.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(staticPage.locator('.hero-cursor img')).toBeVisible();
  await expect(staticPage.getByRole('link', { name: 'Get Kaji for Windows' }).first()).toBeVisible();
  await staticPage.screenshot({ path: new URL('no-javascript.png', output).pathname.replace(/^\/(?=[A-Z]:)/, ''), fullPage: true });
  await staticContext.close();
});

if (errors.length) failures.push(...errors.map(error => `Browser runtime: ${error}`));
await writeFile(new URL('results.json', output), JSON.stringify({ checks, failures, errors }, null, 2));
await browser.close();
console.log(`${checks.length} checks passed; ${failures.length} failed.`);
if (failures.length) process.exit(1);
