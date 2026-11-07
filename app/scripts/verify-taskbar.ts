import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dlopen, FFIType, ptr } from 'bun:ffi';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, expect, type Browser, type Page } from '../../web/node_modules/@playwright/test/index';
import { DEFAULT_SETTINGS } from '../src/gui/ipc';
import type { RuntimeAction, RuntimeSnapshot } from '../shared/runtime';
import { nativeTargetDir } from './native-output';
import { GATEWAY_MODELS } from '../shared/models';

if (!process.argv.includes('--execute')) {
  console.log('Run with --execute on an available desktop. This test clicks File Explorer on the taskbar and changes foreground focus.');
  process.exit(0);
}

const { symbols: windows } = dlopen('user32.dll', {
  GetForegroundWindow: { args: [], returns: FFIType.ptr },
  GetClassNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
});
function cursor() {
  const point = new Int32Array(2);
  assert(windows.GetCursorPos(ptr(point)));
  return [...point];
}
function foreground() {
  const hwnd = windows.GetForegroundWindow();
  const name = new Uint16Array(128);
  const length = hwnd ? windows.GetClassNameW(hwnd, ptr(name), name.length) : 0;
  return { hwnd: Number(hwnd), className: String.fromCharCode(...name.slice(0, length)) };
}

const profile = await mkdtemp(join(tmpdir(), 'kaji-taskbar-'));
const modelFlag = process.argv.indexOf('--model');
const selectedModel = modelFlag < 0 ? 'Kaji Pro' : process.argv[modelFlag + 1]!;
assert(selectedModel === 'Kaji Pro' || GATEWAY_MODELS.some(model => model.id === selectedModel));
await mkdir(join(profile, 'roaming/Kaji'), { recursive: true });
await Bun.write(join(profile, 'roaming/Kaji/settings.json'), JSON.stringify({
  ...DEFAULT_SETTINGS, startup_open: 'composer', theme: 'dark',
  model: selectedModel,
  permission_input: true, enable_head_control: false, voice_feedback: false, voice_activation: false,
}));
const probe = createServer();
await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
const address = probe.address();
assert(address && typeof address === 'object');
const port = address.port;
await new Promise<void>((accept, reject) => probe.close(error => error ? reject(error) : accept()));
const child = Bun.spawn([resolve(nativeTargetDir, 'debug/kaji.exe')], {
  env: {
    ...process.env, APPDATA: join(profile, 'roaming'), LOCALAPPDATA: join(profile, 'local'),
    WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  },
  stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', windowsHide: true,
});
const nativeLog = new Response(child.stderr).text();
let browser: Browser | undefined;
try {
  const endpoint = `http://127.0.0.1:${port}`;
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`Kaji startup failed: ${await nativeLog}`);
    return fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false);
  }, { timeout: 20_000 }).toBe(true);
  browser = await chromium.connectOverCDP(endpoint);
  let main: Page | undefined;
  await expect.poll(() => {
    main = browser!.contexts().flatMap((context: { pages(): Page[] }) => context.pages())
      .find((page: Page) => page.url().endsWith('/composer.html'));
    return !!main;
  }).toBe(true);
  assert(main);
  const page = main;
  const dispatch = (action: RuntimeAction) => page.evaluate((action: RuntimeAction) =>
    (window as any).__TAURI_INTERNALS__.invoke('gui_dispatch', { action }), action) as Promise<RuntimeSnapshot>;
  const snapshot = () => page.evaluate(() =>
    (window as any).__TAURI_INTERNALS__.invoke('gui_get_runtime', {})) as Promise<RuntimeSnapshot>;
  await dispatch({ type: 'services.refresh' });
  await expect.poll(async () => {
    const services = (await snapshot()).services;
    if (services && !services.vision.available) throw new Error(services.vision.reason || 'Vision unavailable');
    return services?.vision.available;
  }, { timeout: 25_000 }).toBe(true);
  await page.getByRole('button', { name: 'Type a request', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your request' }).fill(
    'Use Doppelganger to click the pinned File Explorer icon on the Windows taskbar exactly once. ' +
    'Use its supported activation action with the independent Doppel cursor; do not move or borrow my Windows pointer. ' +
    'Then verify File Explorer is foreground and report done.',
  );
  const before = foreground();
  assert.notEqual(before.className, 'CabinetWClass', 'Start while another app is foreground to verify Explorer actually opens.');
  await page.getByRole('textbox', { name: 'Your request' }).press('Enter');
  const cursorBefore = cursor();
  let pointerMoved = false;
  const monitor = setInterval(() => { pointerMoved ||= JSON.stringify(cursor()) !== JSON.stringify(cursorBefore); }, 4);
  let doppelObserved = false;
  let explorerObserved = false;
  let completed: RuntimeSnapshot | undefined;
  let lastProgress = '';
  try { await expect.poll(async () => {
    const state = await snapshot();
    const progress = `${state.task?.phase ?? 'idle'}: ${state.question?.title ?? state.task?.message ?? ''}`;
    if (progress !== lastProgress) { console.log(progress); lastProgress = progress; }
    explorerObserved ||= foreground().className === 'CabinetWClass';
    doppelObserved ||= state.overlay.mode === 'task' && !!state.overlay.point;
    assert(!state.question, `Routine taskbar activation must not ask: ${state.question?.title}`);
    if (['error', 'blocked', 'stopped'].includes(state.task?.phase ?? '')) throw new Error(`${state.task?.message}; Explorer observed=${explorerObserved}; pointer unchanged=${!pointerMoved}`);
    completed = state;
    return state.task?.phase;
  }, { timeout: 120_000, intervals: [150, 300, 500] }).toBe('complete');
  } finally { clearInterval(monitor); }
  assert(doppelObserved, 'Independent Doppel cursor was never shown.');
  assert(!pointerMoved, 'The user’s Windows pointer moved during the task.');
  assert(explorerObserved, 'File Explorer never became foreground.');
  assert(completed?.task?.verified, 'Kaji did not verify its result.');
  assert.equal(foreground().className, 'CabinetWClass', 'Completed task did not leave Explorer visible in the foreground.');
  const report = { passed: true, time: new Date().toISOString(), selectedModel, explorerObserved, doppelObserved, noApprovalPrompt: true, resultForeground: true, pointerUnchanged: !pointerMoved, reply: completed.task.message, profile };
  await mkdir(resolve('app/verification'), { recursive: true });
  await writeFile(resolve('app/verification/taskbar-live.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch(error) {
  if(child.exitCode===null){child.kill();await child.exited;}
  console.log((await nativeLog).slice(-12000));
  throw error;
} finally {
  if (child.exitCode === null) { child.kill(); await child.exited; }
  await browser?.close().catch(() => {});
}
