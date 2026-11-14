import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, expect } from '../../web/node_modules/@playwright/test/index';
import { DEFAULT_SETTINGS } from '../src/gui/ipc';

const dist = resolve(import.meta.dir, '../dist');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const target = resolve(dist, new URL(request.url).pathname.slice(1));
  if (!target.startsWith(dist + sep)) return new Response(null, { status: 404 });
  const file = Bun.file(target);
  return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
} });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 620, height: 460 }, reducedMotion: 'reduce' });
    await context.addInitScript((settings: typeof DEFAULT_SETTINGS) => {
      localStorage.setItem('kaji_settings', JSON.stringify(settings));
    }, { ...DEFAULT_SETTINGS, theme, voice_activation: false, voice_feedback: false, enable_head_control: false });
    const page = await context.newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/composer.html`);
    await expect(page.locator('.composer-stage')).toBeVisible();
    await page.evaluate(async () => {
      // @ts-ignore Browser loads the built desktop component.
      const { Composer } = await import('/composer.js');
      const root = document.getElementById('app')!;
      root.replaceChildren();
      const composer = new Composer(root);
      composer.update({ state: 'ready', attachments: [{ id: 'attachment-check', name: 'Kaji verification notes.pdf', path: 'C:/Kaji verification notes.pdf', kind: 'file' }] });
      (window as unknown as { attachmentComposer: typeof composer; attachmentEvents: string[] }).attachmentComposer = composer;
      const events: string[] = [];
      (window as unknown as { attachmentEvents: string[] }).attachmentEvents = events;
      window.addEventListener('kaji:composer-action', event => { events.push((event as CustomEvent<{ type: string }>).detail.type); });
    });
    await page.locator('.composer-prompt').click();
    await expect(page.locator('.composer-attachment')).toBeVisible();
    await expect(page.locator('.composer-attachment')).toContainText('Kaji verification notes.pdf');
    assert(await page.locator('.composer-attachment').evaluate((card: Element) => card.getBoundingClientRect().bottom < document.querySelector('textarea')!.getBoundingClientRect().top));
    const remove = page.getByRole('button', { name: 'Remove Kaji verification notes.pdf', exact: true });
    await remove.focus(); await remove.press('Enter');
    assert((await page.evaluate(() => (window as unknown as { attachmentEvents: string[] }).attachmentEvents)).includes('file.remove'));
    await page.screenshot({ path: resolve(import.meta.dir, `../verification/screenshots/native-attachment-card-${theme}.png`) });
    await page.evaluate(() => (window as unknown as { attachmentComposer: { update(value: unknown): void } }).attachmentComposer.update({ attachments: [] }));
    await expect(page.locator('.composer-attachments')).toBeHidden();
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: filename cards appear above the request in both themes; keyboard removal dispatches file.remove; cleared selections disappear.');
} finally { await browser.close(); server.stop(true); }
