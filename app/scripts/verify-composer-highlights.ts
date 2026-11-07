import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { Database } from 'bun:sqlite';
import { dlopen, FFIType, ptr } from 'bun:ffi';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, expect, type Browser, type Page } from '../../web/node_modules/@playwright/test/index';
import { DEFAULT_SETTINGS } from '../src/gui/ipc';
import type { RuntimeSnapshot } from '../shared/runtime';

if (!process.argv.includes('--execute')) {
  console.log('Use --execute on an idle desktop. This shows the installed composer and its target highlight.');
  process.exit(0);
}

const flag = process.argv.indexOf('--binary');
const binary = flag < 0 ? resolve(process.env.LOCALAPPDATA!, 'Kaji/kaji.exe') : resolve(process.argv[flag + 1]!);
const profile = await mkdtemp(join(tmpdir(), 'kaji-highlight-composer-'));
await mkdir(join(profile, 'roaming/Kaji'), { recursive: true });
await mkdir(join(profile, 'local/Kaji'), { recursive: true });
// The encrypted login stays on this Windows account; all test data is isolated.
await cp(resolve(process.env.LOCALAPPDATA!, 'Kaji/gateway-token.dpapi'), join(profile, 'local/Kaji/gateway-token.dpapi'));
await Bun.write(join(profile, 'roaming/Kaji/settings.json'), JSON.stringify({
  ...DEFAULT_SETTINGS, startup_open: 'composer', model: 'ag/gemini-3.8-flash-medium',
  voice_activation: false, voice_feedback: false, sound_effects: false, enable_head_control: false, permission_input: false,
}));
const fixtureExe = join(profile, 'highlight-target.exe');
const compiler = resolve(process.env.WINDIR!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const compile = Bun.spawn([compiler, '/nologo', '/target:winexe', `/out:${fixtureExe}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', resolve(import.meta.dir, 'fixtures/highlight-target.cs')], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
assert.equal(await compile.exited, 0, await new Response(compile.stdout).text());
const user32 = dlopen('user32.dll', {
  GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  GetForegroundWindow: { args: [], returns: FFIType.ptr },
});
const readyFile = join(profile, 'target.json');
const fixture = Bun.spawn([fixtureExe, readyFile], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true });
let child: ReturnType<typeof Bun.spawn> | undefined;
let browser: Browser | undefined;
let focusStolen = false;
let stage = 'startup', focusStage = '';
const processId = new Uint32Array(1);
const monitor = setInterval(() => {
  const hwnd = user32.symbols.GetForegroundWindow();
  if (hwnd) {
    user32.symbols.GetWindowThreadProcessId(hwnd, ptr(processId));
    if (processId[0] === child?.pid || processId[0] === fixture.pid) {
      focusStolen = true;
      focusStage ||= `${stage} (${processId[0] === child?.pid ? 'Kaji composer' : 'test fixture'})`;
    }
  }
}, 8);
try {
  await expect.poll(() => Bun.file(readyFile).exists(), { timeout: 10_000 }).toBe(true);
  const target = await Bun.file(readyFile).json();
  const probe = createServer();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const address = probe.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((accept, reject) => probe.close(error => error ? reject(error) : accept()));
  child = Bun.spawn([binary], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(VERCEL_|BLOB_|PUBLIC_)/.test(name))),
      APPDATA: join(profile, 'roaming'), LOCALAPPDATA: join(profile, 'local'), WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
    stdin: 'ignore', stdout: 'ignore', stderr: Bun.file(join(profile, 'native.log')), windowsHide: true,
  });
  const endpoint = `http://127.0.0.1:${port}`;
  await expect.poll(() => fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false), { timeout: 25_000 }).toBe(true);
  browser = await chromium.connectOverCDP(endpoint);
  let composer: Page | undefined, overlay: Page | undefined;
  await expect.poll(() => {
    const pages = browser!.contexts().flatMap((context: { pages(): Page[] }) => context.pages());
    composer = pages.find((page: Page) => page.url().endsWith('/composer.html'));
    overlay = pages.find((page: Page) => page.url().endsWith('/overlay.html'));
    return !!composer && !!overlay;
  }, { timeout: 20_000 }).toBe(true);
  assert(composer && overlay);
  stage = 'opening composer';
  const snapshot = () => composer.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('gui_get_runtime', {})) as Promise<RuntimeSnapshot>;
  await composer.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('gui_dispatch', { action: { type: 'mode', mode: 'guide' } }));
  await composer.getByRole('button', { name: 'Type a request', exact: true }).evaluate((element: HTMLButtonElement) => element.click());
  stage = 'filling composer';
  await composer.getByRole('textbox', { name: 'Your request' }).fill('In the window titled Kaji Highlight Test, show me the Highlight check button. Inspect that window and point the independent cursor at that exact button. Keep it highlighted and ask me to click it. Do not invoke it or open or read another application.');
  stage = 'submitting composer';
  await composer.locator('.composer-editor').evaluate((form: HTMLFormElement) => form.requestSubmit());
  let state: RuntimeSnapshot | undefined;
  await expect.poll(async () => {
    assert(!focusStolen, `Test application stole desktop focus during ${focusStage}`);
    state = await snapshot();
    if (['error', 'blocked', 'stopped'].includes(state.task?.phase ?? '')) throw new Error(state.task?.message);
    return state.overlay.target;
  }, { timeout: 120_000, intervals: [150, 300, 500] }).toEqual(target);
  assert(state);
  assert.equal(state.overlay.mode, 'task');
  assert.match(state.overlay.targetLabel, /Highlight check/);
  await expect(overlay.locator('.doppelganger-target')).toBeVisible();
  await expect(overlay.locator('.doppelganger-label')).toContainText('Highlight check');
  const geometry = await overlay.locator('.doppelganger-target').boundingBox();
  assert(geometry && state.overlay.viewport);
  const viewport = state.overlay.viewport;
  const expected = { x: (target.left - viewport.left) / viewport.scaleFactor, y: (target.top - viewport.top) / viewport.scaleFactor, width: (target.right - target.left) / viewport.scaleFactor, height: (target.bottom - target.top) / viewport.scaleFactor };
  // Chromium's fractional CSS geometry is quantized to 1/64 of a pixel.
  for (const key of ['x', 'y', 'width', 'height'] as const) assert(Math.abs(geometry[key] - expected[key]) < 1 / 64, `Target ${key} shifted`);
  await overlay.screenshot({ path: join(profile, 'native-overlay.png') });
  await composer.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('gui_dispatch', { action: { type: 'stop' } }));
  await expect.poll(async () => (await snapshot()).overlay.target).toBeNull();
  const databasePath = join(profile, 'local/Kaji/history.sqlite3');
  const database = new Database(databasePath, { readonly: true });
  try {
    const saved = database.query("SELECT count(*) AS count FROM messages WHERE role = 'user' AND text LIKE '%Kaji Highlight Test%'").get() as { count: number };
    assert.equal(saved.count, 1, 'Composer request was not persisted by the installed app');
  } finally { database.close(); }
  assert(!focusStolen);
  const report = { passed: true, binary, model: 'ag/gemini-3.8-flash-medium', target, geometry, label: state.overlay.targetLabel, sqlitePersistence: true, focusStolen, profile };
  await Bun.write(join(profile, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  child?.kill();
  if (child) await child.exited;
  fixture.kill();
  await fixture.exited;
  clearInterval(monitor);
  user32.close();
}
