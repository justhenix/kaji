import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, expect } from '../../web/node_modules/@playwright/test/index';
import { DEFAULT_SETTINGS } from '../src/gui/ipc';

const dist = resolve(import.meta.dir, '../dist');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = resolve(dist, new URL(request.url).pathname.slice(1));
  return path.startsWith(dist + sep) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
} });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await context.addInitScript((defaults: typeof DEFAULT_SETTINGS) => {
    const harness = window as any;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number[]>();
    let next = 0, checks = 0;
    let saved = JSON.parse(localStorage.getItem('saved-settings') ?? JSON.stringify({ ...defaults, theme: 'dark' }));
    const unavailable = { available: false, model: '', reason: 'service capabilities unavailable (HTTP 401)' };
    const snapshot = { revision: 1, mode: 'assist', message: '', task: null,
      head: { enabled: false, active: false, phase: 'off', sessionId: 0 }, voice: { enabled: false },
      services: Object.fromEntries(['reasoning', 'vision', 'stt', 'tts', 'titles'].map(key => [key, { ...unavailable }])) };
    const emit = () => {
      snapshot.revision++;
      for (const id of listeners.get('kaji:runtime-update') ?? []) callbacks.get(id)?.({ payload: structuredClone(snapshot) });
    };
    harness.__closed = false;
    let update = { phase: 'idle', currentVersion: '0.1.2', version: null as string | null, downloaded: 0, total: null, message: '' };
    harness.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event: string) { listeners.delete(event); } };
    harness.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback: (event: unknown) => void) { const id = ++next; callbacks.set(id, callback); return id; },
      async invoke(command: string, args: any = {}) {
        if (command === 'gui_update_status') return update;
        if (command === 'gui_update_check') { update = { ...update, phase: 'available', version: '0.1.3' }; return update; }
        if (command === 'gui_update_install') { update = { ...update, phase: 'error', message: 'Couldn’t download and verify the update. Try again.' }; return update; }
        if (command === 'gui_get_settings') return saved;
        if (command === 'gui_get_runtime') return structuredClone(snapshot);
        if (command === 'plugin:event|listen') {
          listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]); return ++next;
        }
        if (command === 'plugin:event|unlisten') return;
        if (command === 'gui_dispatch' && args.action.type === 'services.refresh') {
          const recovered = ++checks > 1;
          snapshot.message = 'Checking speech and reasoning services';
          setTimeout(() => {
            if (recovered) for (const key of Object.keys(snapshot.services)) snapshot.services[key] = { available: true, model: 'Connected', reason: '' };
            snapshot.message = 'Service status updated'; emit();
          }, 50);
          return structuredClone(snapshot);
        }
        if (command === 'gui_save_settings') {
          await new Promise<void>(resolveSave => { harness.__finishSave = resolveSave; });
          saved = args.settings;
          localStorage.setItem('saved-settings', JSON.stringify(saved));
          return;
        }
        if (command === 'gui_window_close') { harness.__closed = true; return; }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  }, DEFAULT_SETTINGS);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/settings.html?page=ai`);
  await expect(page.locator('#ai-service-state')).toContainText('couldn’t sign in');
  assert.equal(await page.locator('#ai-service-state').getByText('couldn’t sign in', { exact: false }).count(), 1);
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.locator('.service-row.available')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Check connection', exact: true })).toBeEnabled();
  await page.screenshot({ path: resolve(import.meta.dir, '../verification/screenshots/settings-connection-recovered.png') });
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.locator('.theme-card[data-theme="light"]').click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#settings-save-btn')).toContainText('Saving');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => (window as any).__closed), false, 'Close must wait for the settings write');
  await page.evaluate(() => (window as any).__finishSave());
  await expect.poll(() => page.evaluate(() => (window as any).__closed)).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.locator('[data-update-status]')).toContainText('Version 0.1.3 is ready');
  await page.getByRole('button', { name: 'Install and restart', exact: true }).click();
  await expect(page.locator('[data-update-status]')).toContainText('download and verify');
  await expect(page.getByRole('button', { name: 'Check for updates', exact: true })).toBeEnabled();
  assert.deepEqual(errors, []);
  console.log('PASS: 401 recovery, Save/Close/reopen, update offer and failed-download retry. No devices or provider calls.');
} finally { await browser.close(); server.stop(true); }
