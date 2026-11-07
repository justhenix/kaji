import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, expect } from '../../web/node_modules/@playwright/test/index';
const dist = resolve(import.meta.dir, '../dist');
const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'fixtures/composer-reply.ts')], target: 'browser' });
assert(built.success);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/') return new Response('<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/composer.css"></head><body><div id="fixture"></div></body></html>', { headers: { 'content-type': 'text/html' } });
  if (url.pathname === '/fixture.js') return new Response(built.outputs[0], { headers: { 'content-type': 'text/javascript' } });
  const file = resolve(dist, url.pathname.slice(1));
  return file.startsWith(dist + sep) && await Bun.file(file).exists() ? new Response(Bun.file(file)) : new Response(null, { status: 404 });
} });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 400 }, reducedMotion: 'reduce' });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.evaluate(async () => {
    const fixture = '/fixture.js';
    const { composer } = await import(fixture);
    (window as any).composerTest = composer;
    composer.update({ state: 'ready', message: 'The test action is done.' });
    composer.showReply('first', []);
  });
  await expect(page.locator('.composer-notice')).toBeVisible();
  await expect(page.locator('.composer-notice')).toBeHidden({ timeout: 4500 });
  await page.evaluate(() => {
    const composer = (window as any).composerTest;
    composer.update({ state: 'ready', speechPending: true, message: 'A longer spoken reply.' });
    composer.showReply('spoken', []);
  });
  await page.waitForTimeout(3300);
  await expect(page.locator('.composer-notice')).toBeVisible();
  await page.evaluate(() => (window as any).composerTest.update({ speechPending: false, voicePhase: 'speaking' }));
  await page.waitForTimeout(3300);
  await expect(page.locator('.composer-notice')).toBeVisible();
  await page.evaluate(() => (window as any).composerTest.update({ voicePhase: 'wake' }));
  await page.waitForTimeout(2700);
  await expect(page.locator('.composer-notice')).toBeVisible();
  await expect(page.locator('.composer-notice')).toBeHidden({ timeout: 1500 });
  await page.evaluate(() => {
    const composer = (window as any).composerTest;
    composer.update({ state: 'ready', message: 'Another completed action.' });
    composer.showReply('second', []);
    composer.update({ state: 'question', question: { id: 'q', title: 'Choose a window', options: [{ id: 'one', label: 'Test window', value: 'one' }] } });
  });
  await page.waitForTimeout(3300);
  await expect(page.getByRole('heading', { name: 'Choose a window' })).toBeVisible();
  console.log('PASS: Replies stay through synthesis/playback and collapse three seconds afterward; a new question stays open.');
} finally { await browser.close(); server.stop(true); }
