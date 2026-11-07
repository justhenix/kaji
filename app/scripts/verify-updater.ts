import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createServer } from 'node:net';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, expect, type Browser, type Page } from '../../web/node_modules/@playwright/test/index';
import { DEFAULT_SETTINGS } from '../src/gui/ipc';

assert(process.argv.includes('--execute'), 'Use --execute with an older updater-capable test binary. This installs the signed production update.');
const binary = resolve(process.argv[2]!);
const expected = JSON.parse(await Bun.file(resolve(import.meta.dir, '../src-tauri/tauri.conf.json')).text()).version;
const profile = await mkdtemp(join(tmpdir(), 'kaji-update-test-'));
await mkdir(join(profile, 'roaming/Kaji'), { recursive: true });
await mkdir(join(profile, 'local/Kaji'), { recursive: true });
const credential = join(profile, 'local/Kaji/gateway-token.dpapi');
await Bun.write(join(profile, 'roaming/Kaji/settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS,
  voice_activation: false, voice_feedback: false, sound_effects: false, enable_head_control: false, permission_input: false, check_updates: false,
}));
const portServer = createServer(); await new Promise<void>(accept => portServer.listen(0, '127.0.0.1', accept));
const port = (portServer.address() as { port: number }).port; await new Promise<void>(accept => portServer.close(() => accept()));
const child = Bun.spawn([resolve(dirname(binary), 'python/python.exe'), '-I', resolve(import.meta.dir, 'fixtures/isolated-desktop.py'), binary], {
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VERCEL_|BLOB_|PUBLIC_|TAURI_SIGNING_|KAJI_GATEWAY_TOKEN$)/.test(key))),
    APPDATA: join(profile, 'roaming'), LOCALAPPDATA: join(profile, 'local'), KAJI_GATEWAY_CREDENTIAL_PATH: credential,
    WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --use-fake-device-for-media-stream`,
  }, stdin: 'pipe', stdout: 'pipe', stderr: Bun.file(join(profile, 'launcher.log')), windowsHide: true,
});
let browser: Browser | undefined;
const endpoint = `http://127.0.0.1:${port}`;
async function connect(): Promise<Page> {
  await expect.poll(() => fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false), { timeout: 90000 }).toBe(true);
  browser = await chromium.connectOverCDP(endpoint);
  let page: Page | undefined;
  await expect.poll(() => { page = browser!.contexts().flatMap((context: { pages(): Page[] }) => context.pages()).find((view: Page) => view.url().endsWith('/composer.html')); return !!page; }, { timeout: 30000 }).toBe(true);
  assert(page); return page;
}
try {
  let page = await connect();
  await expect.poll(() => Bun.file(credential).exists(), { timeout: 30000 }).toBe(true);
  await expect.poll(() => page.evaluate(async () => !!(await (window as any).__TAURI_INTERNALS__.invoke('gui_get_runtime')).services?.reasoning.available), { timeout: 30000 }).toBe(true);
  const before = new Bun.CryptoHasher('sha256').update(await Bun.file(credential).arrayBuffer()).digest('hex');
  await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('gui_set_view', { view: 'settings' }));
  await page.goto('http://tauri.localhost/settings.html');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).evaluate((element: HTMLElement) => element.click());
  await expect(page.getByRole('button', { name: 'Install and restart', exact: true })).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('[data-update-status]')).toContainText(`Version ${expected} is ready`);
  const disconnected = new Promise<void>(accept => browser!.once('disconnected', () => accept()));
  await page.getByRole('button', { name: 'Install and restart', exact: true }).evaluate((element: HTMLElement) => element.click());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([disconnected, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('Updater did not finish downloading and exit')), 180000); })]);
  } finally { clearTimeout(timeout); }
  browser = undefined;
  page = await connect();
  const checked = await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('gui_update_check'));
  assert.equal(checked.phase, 'current', checked.message);
  assert.equal(checked.currentVersion, expected);
  await expect.poll(() => page.evaluate(async () => !!(await (window as any).__TAURI_INTERNALS__.invoke('gui_get_runtime')).services?.reasoning.available), { timeout: 30000 }).toBe(true);
  assert.equal(new Bun.CryptoHasher('sha256').update(await Bun.file(credential).arrayBuffer()).digest('hex'), before);
  assert.equal((await Bun.file(join(profile, 'roaming/Kaji/settings.json')).json()).theme, 'light');
  console.log('PASS: In-app update offer downloaded and verified the signed release, installed silently, restarted into the current version, and preserved device login and Light settings. The visible desktop was not switched.');
} finally {
  await browser?.close(); child.stdin.end(); await child.exited;
  const { rm } = await import('node:fs/promises'); await rm(credential, { force: true });
  console.log(`Verification profile: ${profile}`);
}
