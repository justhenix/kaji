import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:net';
import { Database } from 'bun:sqlite';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, expect, type Browser, type Page } from '../../web/node_modules/@playwright/test/index';
import { DEFAULT_SETTINGS } from '../src/gui/ipc';

const binary = resolve(process.argv[2] ?? join(process.env.LOCALAPPDATA!, 'Kaji/kaji.exe'));
const profile = await mkdtemp(join(tmpdir(), 'kaji-fresh-install-'));
const credential = join(profile, 'local/Kaji/gateway-token.dpapi');
await mkdir(dirname(credential), { recursive: true });
await mkdir(join(profile, 'roaming/Kaji'), { recursive: true });
await Bun.write(join(profile, 'roaming/Kaji/settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS,
  voice_activation: false, voice_feedback: false, sound_effects: false, enable_head_control: false, permission_input: false,
}));
assert.equal(await Bun.file(credential).exists(), false);
const python = resolve(dirname(binary), 'python/python.exe');
assert(await Bun.file(python).exists(), 'Build/package the bundled Python runtime first');
let credentialHash: string | undefined;
try {
  for (let run = 0; run < 2; run++) {
    const portServer = createServer();
    await new Promise<void>(accept => portServer.listen(0, '127.0.0.1', accept));
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>(accept => portServer.close(() => accept()));
    const child = Bun.spawn([python, '-I', resolve(import.meta.dir, 'fixtures/isolated-desktop.py'), binary], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VERCEL_|BLOB_|PUBLIC_|TAURI_SIGNING_|KAJI_GATEWAY_TOKEN$)/.test(key))),
        APPDATA: join(profile, 'roaming'), LOCALAPPDATA: join(profile, 'local'), KAJI_GATEWAY_CREDENTIAL_PATH: credential,
        WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
          `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --use-fake-device-for-media-stream`,
      }, stdin: 'pipe', stdout: 'pipe', stderr: Bun.file(join(profile, 'launcher.log')), windowsHide: true,
    });
    let browser: Browser | undefined;
    try {
      const endpoint = `http://127.0.0.1:${port}`;
      await expect.poll(() => fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false), { timeout: 30000 }).toBe(true);
      browser = await chromium.connectOverCDP(endpoint);
      let page: Page | undefined;
      await expect.poll(() => { page = browser!.contexts().flatMap((context: { pages(): Page[] }) => context.pages()).find((view: Page) => view.url().endsWith('/composer.html')); return !!page; }, { timeout: 20000 }).toBe(true);
      assert(page);
      await expect.poll(() => page!.evaluate(async () => {
        const snapshot = await (window as any).__TAURI_INTERNALS__.invoke('gui_get_runtime', {});
        return snapshot.services && Object.values(snapshot.services).every((service: any) => service.available);
      }), { timeout: 30000 }).toBe(true);
      const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(credential).arrayBuffer()).digest('hex');
      if (credentialHash) assert.equal(hash, credentialHash, 'Restart must reuse the enrolled DPAPI login');
      credentialHash = hash;
      if (run === 0) {
        await page.getByRole('button', { name: 'Type a request', exact: true }).evaluate((element: HTMLElement) => element.click());
        await page.getByRole('textbox', { name: 'Your request' }).fill('Reply with exactly Kaji fresh install works. Do not use tools.');
        await page.getByRole('textbox', { name: 'Your request' }).press('Enter');
        let result: any;
        await expect.poll(async () => { result = await page!.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('gui_get_runtime', {})); return result.task?.phase; }, { timeout: 90000 }).toMatch(/^(complete|error|blocked)$/);
        assert.equal(result.task.phase, 'complete', result.message);
        assert.equal(result.message.trim(), 'Kaji fresh install works.');
      }
      console.log(run === 0 ? 'PASS: Empty credential path enrolled automatically; all five services and a real Gemini composer reply work.'
        : 'PASS: Full process restart reused the encrypted device login; all five services remain connected.');
    } finally { await browser?.close(); child.stdin.end(); await child.exited; }
  }
  const history = new Database(join(profile, 'local/Kaji/history.sqlite3'), { readonly: true });
  assert.equal((history.query("SELECT count(*) AS count FROM messages WHERE role='assistant' AND text='Kaji fresh install works.'").get() as { count: number }).count, 1);
  assert.equal((history.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  history.close();
  console.log('PASS: Fresh-install composer reply persists in SQLite. No owner credential was copied; no visible desktop or hardware devices were used.');
} finally {
  // Keep non-secret diagnostic output, but remove the test's reusable login.
  const { rm } = await import('node:fs/promises');
  await rm(credential, { force: true });
  console.log(`Verification profile: ${profile}`);
}
