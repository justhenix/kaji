import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, expect, type Route } from '../../web/node_modules/@playwright/test/index';
// @ts-ignore Axe is installed in the web workspace.
import AxeBuilder from '../../web/node_modules/@axe-core/playwright/dist/index.mjs';
import { DEFAULT_SETTINGS } from '../src/gui/ipc';
import { SETTINGS_CATEGORIES } from '../src/gui/types';

const root = resolve(import.meta.dir, '..'), dist = resolve(root, 'dist'), output = resolve(root, 'verification');
await mkdir(resolve(output, 'screenshots'), { recursive: true });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const target = resolve(dist, path === '/' ? 'index.html' : path.slice(1));
  if (!target.startsWith(dist + sep)) return new Response(null, { status: 404 });
  const file = Bun.file(target);
  return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks: string[] = [], errors: string[] = [];
type AccessibilityViolation = { id: string; impact?: string | null; nodes: { target: unknown[] }[] };
const failures: unknown[] = [];
let passed = false;
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 920, height: 680 }, reducedMotion: 'reduce', permissions: [] });
    await context.route('**/*', (route: Route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addInitScript((settings: typeof DEFAULT_SETTINGS) => {
      if (!localStorage.getItem('kaji_settings')) localStorage.setItem('kaji_settings', JSON.stringify(settings));
    }, { ...DEFAULT_SETTINGS, theme, voice_activation: false, voice_feedback: false, enable_head_control: false });
    const page = await context.newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${origin}/settings.html`);
    for (const category of SETTINGS_CATEGORIES) {
      await page.getByRole('button', { name: category.label, exact: true }).click();
      await expect(page.getByRole('heading', { name: category.label, exact: true })).toBeVisible();
      const overflow = await page.evaluate(() => {
        const content = document.querySelector('.settings-page-wrapper')!;
        return document.documentElement.scrollWidth > innerWidth || content.scrollWidth > content.clientWidth;
      });
      assert(!overflow, `${theme} ${category.label} exceeds minimum window width`);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      const violations = (results.violations as AccessibilityViolation[]).filter(issue => ['serious', 'critical'].includes(issue.impact ?? ''));
      if (violations.length) failures.push({ theme, page: category.label, issues: violations.map(issue => ({ id: issue.id, targets: issue.nodes.map(node => node.target) })) });
      else checks.push(`${theme} ${category.label}: minimum size and accessibility`);
    }
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.screenshot({ path: resolve(output, `screenshots/headless-settings-${theme}-min.png`) });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.setViewportSize({ width: 880, height: 620 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Recents', exact: true })).toBeVisible();
    await expect(page.locator('.history-error')).toBeVisible();
    checks.push(`${theme} main and History: minimum size, same-window navigation, unavailable runtime feedback`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, [], 'Frontend accessibility checks failed');
  passed = true;
  console.log(`PASS: ${checks.length} headless frontend checks; no native windows, devices, or provider calls.`);
} finally {
  await browser.close();
  server.stop(true);
  await Bun.write(resolve(output, 'frontend-headless.json'), JSON.stringify({ time: new Date().toISOString(), passed, checks, errors, failures }, null, 2));
}
