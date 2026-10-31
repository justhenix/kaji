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
    if (width === 390 || width === 320) {
      await page.locator('#head').screenshot({ path: new URL(`head-mobile-${width}.png`, output).pathname.replace(/^\/(?=[A-Z]:)/, '') });
    }
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
await check('wheel scrolling and anchors work with Lenis', async () => {
  await page.goto(base);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('html')).toHaveClass(/\blenis\b/);
  await page.mouse.wheel(0, 650);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(500);
  await page.goto(base);
  await expect(page.locator('html')).toHaveClass(/\blenis\b/);
  await page.locator('.explore').click();
  await expect.poll(() => page.evaluate(() => Math.abs(document.querySelector('#how-it-works')!.getBoundingClientRect().top - 32)), { timeout: 5000 }).toBeLessThan(10);
  await expect(page).toHaveURL(/#how-it-works$/);
  await expect(page.locator('.product-demo.guide')).toHaveClass(/is-playing/);
});
await check('reduced motion and touch use native scrolling', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('html')).not.toHaveClass(/\blenis\b/);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('html')).toHaveClass(/\blenis\b/);
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const touchPage = await touchContext.newPage();
  await touchPage.goto(base);
  expect(await touchPage.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(false);
  await expect(touchPage.locator('html')).not.toHaveClass(/\blenis\b/);
  await touchContext.close();
});
await check('feature cards are illustrative without extra captions', async () => {
  await expect(page.locator('.product-demo')).toHaveCount(3);
  await expect(page.locator('.product-demo button, .product-demo a, .product-demo input, .product-demo [tabindex], .product-demo [role="button"]')).toHaveCount(0);
  await expect(page.locator('.feature figcaption, .feature .note')).toHaveCount(0);
  await expect(page.locator('astro-island[component-url*="ProductDemo"]')).toHaveCount(0);
  await expect(page.locator('.guide .step-marker .step-after svg')).toHaveCount(1);
  await expect(page.locator('.guide .step-marker .step-after')).toHaveText('');
});
await check('landing and download share the same pixel field', async () => {
  for (const selector of ['.hero', '#how-it-works', '#head', '#control', '.final-cta', '.footer']) {
    await expect(page.locator(`${selector} .dither-field`)).toHaveCount(1);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const field = page.locator('.hero .field-left img');
    await expect(field).toHaveAttribute('src', '/art/sweep.png');
    expect(await field.evaluate((img: HTMLImageElement) => ({ width: img.naturalWidth, rendered: img.getBoundingClientRect().width }))).toEqual({ width: 960, rendered: 960 });
  }
  await page.goto(`${base}/download`);
  await expect(page.locator('.download-page .dither-field, .footer .dither-field')).toHaveCount(2);
  await expect(page.locator('.download-page .dither-field img').first()).toHaveAttribute('src', '/art/sweep.png');
});
await check('document formatting tools stay beside the font selector', async () => {
  await page.goto(base);
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const ribbon = page.locator('.guide .editor-ribbon');
    const geometry = await ribbon.evaluate(element => {
      const font = element.querySelector('.font-readout')!.getBoundingClientRect();
      const tools = element.querySelector('.text-tools')!.getBoundingClientRect();
      const target = element.querySelector('.align-center')!.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      return { font, tools, target, bounds };
    });
    expect(Math.abs((geometry.font.top + geometry.font.bottom) / 2 - (geometry.tools.top + geometry.tools.bottom) / 2)).toBeLessThan(2);
    expect(geometry.font.right).toBeLessThanOrEqual(geometry.tools.left);
    expect(geometry.tools.right).toBeLessThanOrEqual(geometry.target.left);
    expect(geometry.target.right).toBeLessThanOrEqual(geometry.bounds.right);
  }
});
for (const width of [1440, 390]) {
  await check(`installation demonstration sequence at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/download`);
    const list = page.locator('.installation');
    await list.scrollIntoViewIfNeeded();
    await expect(list).toHaveAttribute('data-demo-playing', '');
    const stateAt = (time: number) => list.evaluate((el, ms) => {
      const animations = el.getAnimations({ subtree: true });
      animations.forEach(animation => { animation.pause(); animation.currentTime = ms; });
      const style = (selector: string) => getComputedStyle(el.querySelector(selector)!);
      return {
        count: animations.length,
        file: Number(style('.file-cursor').opacity),
        more: Number(style('.more-cursor').opacity),
        runButton: Number(style('.run-anyway').opacity),
        runCursor: Number(style('.run-cursor').opacity),
        progress: new DOMMatrixReadOnly(style('.installation-progress').transform).a,
        ready: Number(style('.ready-label').opacity),
      };
    }, time);
    const first = await stateAt(1800);
    expect(first.count).toBeGreaterThanOrEqual(8);
    expect(first.file).toBeGreaterThan(.9);
    expect(first.runButton).toBe(0);
    expect((await stateAt(4400)).more).toBeGreaterThan(.9);
    const second = await stateAt(5700);
    expect(second.runButton).toBe(1);
    expect(second.runCursor).toBeGreaterThan(.9);
    const third = await stateAt(8000);
    expect(third.progress).toBeGreaterThan(.3);
    expect(third.progress).toBeLessThan(.7);
    const complete = await stateAt(11000);
    expect(complete.progress).toBe(1);
    expect(complete.ready).toBe(1);
    expect((await stateAt(13500)).ready).toBe(1);
    const replay = await stateAt(14300);
    expect(replay.progress).toBeLessThan(.1);
    expect(replay.ready).toBe(0);
  });
}
await check('installation demonstration pauses offscreen and respects reduced motion', async () => {
  await page.setViewportSize({ width: 390, height: 300 });
  await page.goto(`${base}/download`);
  const list = page.locator('.installation');
  await page.evaluate(() => window.scrollTo({ top: document.querySelector('.installation')!.getBoundingClientRect().top + scrollY, behavior: 'instant' }));
  await expect(list).toHaveAttribute('data-demo-playing', '');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(list).toHaveAttribute('data-demo-paused', '');
  const timeBefore = await list.evaluate(el => Number(el.getAnimations({ subtree: true })[0].currentTime));
  await page.waitForTimeout(250);
  const timeAfter = await list.evaluate(el => Number(el.getAnimations({ subtree: true })[0].currentTime));
  expect(timeAfter).toBe(timeBefore);
  await page.evaluate(() => window.scrollTo({ top: document.querySelector('.installation')!.getBoundingClientRect().top + scrollY, behavior: 'instant' }));
  await expect(list).not.toHaveAttribute('data-demo-paused', '');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(list).not.toHaveAttribute('data-demo-playing', '');
  await expect(page.getByRole('button', { name: 'Pause animation' })).toHaveCount(0);
  expect(await list.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(list.locator('.run-anyway')).toHaveCSS('opacity', '1');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
await check('installation animation can be paused and resumed', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/download`);
  const list = page.locator('.installation');
  await expect(list).toHaveAttribute('data-demo-playing', '');
  await page.getByRole('button', { name: 'Pause animation' }).click();
  await expect(list).toHaveAttribute('data-demo-paused', '');
  const before = await list.evaluate(el => Number(el.getAnimations({ subtree: true })[0].currentTime));
  await page.waitForTimeout(250);
  expect(await list.evaluate(el => Number(el.getAnimations({ subtree: true })[0].currentTime))).toBe(before);
  await page.getByRole('button', { name: 'Play animation' }).click();
  await expect(list).not.toHaveAttribute('data-demo-paused', '');
});
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 700 }]) {
  await check(`feature demonstrations play and restart at ${viewport.width}px`, async () => {
    await page.setViewportSize(viewport);
    await page.goto(base);
    for (const kind of ['guide', 'head', 'control']) {
      const demo = page.locator(`.product-demo.${kind}`);
      const section = demo.locator('xpath=ancestor::section');
      await demo.scrollIntoViewIfNeeded();
      await expect(demo).toHaveClass(/is-playing/);
      const states = await demo.evaluate(element => {
        const animations = element.getAnimations({ subtree: true });
        animations.forEach(animation => { animation.pause(); animation.currentTime = 1000; });
        const early = animations.map(animation => animation.currentTime);
        animations.forEach(animation => { animation.currentTime = 3800; });
        return { count: animations.length, early, late: animations.map(animation => animation.currentTime) };
      });
      expect(states.count).toBeGreaterThan(3);
      expect(states.early.every(time => time === 1000)).toBe(true);
      expect(states.late.every(time => time === 3800)).toBe(true);
      await demo.screenshot({ path: new URL(`${kind}-motion-${viewport.width}.png`, output).pathname.replace(/^\/(?=[A-Z]:)/, '') });
      await demo.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = 1800; }));
      await demo.screenshot({ path: new URL(`${kind}-mid-${viewport.width}.png`, output).pathname.replace(/^\/(?=[A-Z]:)/, '') });
      if (kind === 'guide') {
        await expect(demo.locator('.document-page')).toHaveCSS('text-align', 'left');
        await expect(demo.locator('.guide-callout')).toHaveCSS('opacity', '1');
      } else if (kind === 'head') {
        const offset = await demo.locator('.ring-progress').evaluate(el => parseFloat(getComputedStyle(el).strokeDashoffset));
        expect(offset).toBeGreaterThan(25);
        expect(offset).toBeLessThan(40);
      } else {
        await expect(demo.locator('.permission-panel')).toHaveCSS('opacity', '1');
        await expect(demo.locator('.approval-before')).toHaveCSS('opacity', '1');
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => section.evaluate(el => el.getBoundingClientRect().top >= innerHeight)).toBe(true);
      await demo.scrollIntoViewIfNeeded();
      await expect.poll(() => demo.evaluate(el => el.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'))).toBe(true);
      const latest = await demo.evaluate(el => Math.max(...el.getAnimations({ subtree: true }).map(animation => Number(animation.currentTime))));
      expect(latest).toBeLessThan(2000);
      for (let i = 0; i < 2; i++) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => demo.evaluate(el => el.getAnimations({ subtree: true }).every(animation => animation.playState === 'paused'))).toBe(true);
        await demo.scrollIntoViewIfNeeded();
        await expect.poll(() => demo.evaluate(el => el.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'))).toBe(true);
      }
    }
  });
}
await check('feature demonstrations show completed states with reduced motion', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(base);
  for (const kind of ['guide', 'head', 'control']) {
    const demo = page.locator(`.product-demo.${kind}`);
    await demo.scrollIntoViewIfNeeded();
    expect(await demo.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  }
  await expect(page.locator('.step-after').last()).toHaveCSS('opacity', '1');
  await expect(page.locator('.approval-after')).toHaveCSS('opacity', '1');
  await expect(page.locator('.dwell-feedback')).toBeVisible();
  await expect(page.locator('.pause-control')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
await check('head control matches the reference without LEDs or doodles', async () => {
  const head = page.locator('.product-demo.head');
  await head.scrollIntoViewIfNeeded();
  await expect(head.locator('.window-title')).toHaveText('Head control');
  await expect(head.locator('.tracking-chip')).toHaveText('Head tracking active');
  await expect(head.locator('.tracking-chip svg, .tracking-chip i')).toHaveCount(0);
  await expect(head.locator('.dwell-cursor, .dwell-ring, .dwell-target')).toHaveCount(3);
  await expect(head.locator('.head-tool')).toHaveText(['Open', 'Click', 'Settings']);
  await expect(head.locator('.dwell-instruction strong')).toHaveText('Hover on target for 0.9 seconds.');
  await expect(head.locator('.face-panel, .face-landmarks, .led, .doodle')).toHaveCount(0);
  await head.screenshot({ path: new URL('dwell-static.png', output).pathname.replace(/^\/(?=[A-Z]:)/, '') });
});

async function canvasHash(selector = '.hero-cursor canvas') {
  return page.locator(selector).evaluate((canvas: HTMLCanvasElement) => {
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
await check('mirrored edge grains respond at the pointer and settle', async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  const selector = '.hero .field-right canvas';
  await page.locator(`${selector}.ready`).waitFor();
  await page.mouse.move(700, 20);
  const before = await canvasHash(selector);
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width - 140, box!.y + 170);
  await page.waitForTimeout(300);
  expect(await canvasHash(selector)).not.toBe(before);
  await page.mouse.move(700, 20);
  await expect.poll(() => canvasHash(selector), { timeout: 5000, intervals: [300, 500] }).toBe(before);
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
