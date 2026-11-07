import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, expect, type Browser, type Page } from '../../web/node_modules/@playwright/test/index';
import { DEFAULT_SETTINGS } from '../src/gui/ipc';
import type { RuntimeSnapshot } from '../shared/runtime';

const binaryFlag = process.argv.indexOf('--binary');
const binary = binaryFlag < 0 ? resolve(import.meta.dir, '../src-tauri/target/debug/kaji.exe') : resolve(process.argv[binaryFlag + 1]!);
const audioFlag = process.argv.indexOf('--audio');
assert(audioFlag >= 0, 'Supply --audio with a WAV containing Hey Kaji, a harmless command, and trailing silence');
const audioFile = resolve(process.argv[audioFlag + 1]!);
assert(await Bun.file(audioFile).exists());
const profile = await mkdtemp(join(tmpdir(), 'kaji-wake-check-'));
await mkdir(join(profile, 'roaming/Kaji'), { recursive: true });
await Bun.write(join(profile, 'roaming/Kaji/settings.json'), JSON.stringify({
  ...DEFAULT_SETTINGS, voice_activation: true, voice_feedback: false, sound_effects: false,
  permission_input: false, enable_head_control: false, startup_open: 'composer',
}));
const probe = createServer();
await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
const address = probe.address();
assert(address && typeof address === 'object');
const port = address.port;
await new Promise<void>((accept, reject) => probe.close(error => error ? reject(error) : accept()));
const child = Bun.spawn([binary], {
  env: {
    ...process.env, APPDATA: join(profile, 'roaming'), LOCALAPPDATA: join(profile, 'local'),
    WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=${audioFile}`,
  },
  stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', windowsHide: true,
});
const nativeLog = new Response(child.stderr).text();
let browser: Browser | undefined;
let passed = false;
const phases = new Set<string>();
const errors: string[] = [];
let final: RuntimeSnapshot | undefined;
let lastVoice: RuntimeSnapshot['voice'] | undefined;
async function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(({ command, args }: {command: string; args: Record<string, unknown>}) =>
    (window as unknown as {__TAURI_INTERNALS__: {invoke(command: string, args: Record<string, unknown>): Promise<T>}}).__TAURI_INTERNALS__.invoke(command, args), { command, args });
}
try {
  const endpoint = `http://127.0.0.1:${port}`;
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`Startup failed: ${await nativeLog}`);
    return fetch(`${endpoint}/json/version`).then(response => response.ok, () => false);
  }, {timeout: 20_000}).toBe(true);
  browser = await chromium.connectOverCDP(endpoint);
  let main: Page | undefined;
  await expect.poll(() => {
    main = browser!.contexts().flatMap((context: {pages(): Page[]}) => context.pages()).find((page: Page) => page.url().endsWith('/composer.html'));
    return !!main;
  }, {timeout: 15_000}).toBe(true);
  assert(main);
  for (const page of browser.contexts().flatMap((context: {pages(): Page[]}) => context.pages())) page.on('pageerror', (error: Error) => errors.push(error.message));
  const waitWake = () => expect.poll(async () => {
    lastVoice = (await invoke<RuntimeSnapshot>(main!, 'gui_get_runtime')).voice;
    if (lastVoice.phase === 'error') throw new Error(lastVoice.reason);
    return lastVoice.phase;
  }, {timeout: 15_000}).toBe('wake');
  await waitWake();
  const settings = await invoke<Record<string, unknown>>(main, 'gui_get_settings');
  await invoke(main, 'gui_save_settings', {settings: {...settings, voice_activation: false}});
  await expect.poll(async () => (await invoke<RuntimeSnapshot>(main, 'gui_get_runtime')).voice.enabled).toBe(false);
  await invoke(main, 'gui_save_settings', {settings: {...settings, voice_activation: true}});
  await waitWake();
  if (!process.argv.includes('--settings-only')) {
  await expect.poll(async () => {
    assert.deepEqual(errors, []);
    const state = await invoke<RuntimeSnapshot>(main, 'gui_get_runtime');
    final = state;
    if (!phases.has(state.voice.phase)) console.log(`Voice: ${state.voice.phase}`);
    phases.add(state.voice.phase);
    assert(!state.head.enabled && !state.head.active, 'Voice started head control');
    assert(!state.question, 'Harmless voice reply asked for approval');
    if (state.voice.phase === 'error' || state.task?.phase === 'error') throw new Error(state.voice.reason || state.task?.message);
    return state.task?.phase;
  }, {timeout: 70_000, intervals: [100, 250, 500]}).toBe('complete');
  assert(phases.has('wake') && phases.has('listening') && phases.has('transcribing'), `Missing voice transitions: ${[...phases]}`);
  assert(/kaji voice works/i.test(final!.task!.message), `Unexpected reply: ${final!.task!.message}`);
  await expect.poll(async () => (await invoke<RuntimeSnapshot>(main, 'gui_get_runtime')).voice.phase).toBe('wake');
  await expect(main.locator('.composer-notice')).toBeHidden({timeout: 5500});
  await invoke(main, 'gui_dispatch', {action: {type: 'listen', enabled: false}});
  const audio = browser.contexts().flatMap((context: {pages(): Page[]}) => context.pages()).find((page: Page) => page.url().endsWith('/audio.html'))!;
  await audio.reload();
  await Bun.sleep(1200);
  const stopped = await invoke<RuntimeSnapshot>(main, 'gui_get_runtime');
  assert.equal(stopped.voice.enabled, false, 'Reload overrode an explicit Stop');
  assert.equal(stopped.voice.phase, 'off');
  await main.getByRole('button', {name: 'Start listening', exact: true}).click();
  await expect.poll(async () => {
    const state = await invoke<RuntimeSnapshot>(main, 'gui_get_runtime');
    if (state.voice.phase === 'error' || state.task?.phase === 'error') throw new Error(state.voice.reason || state.task?.message);
    return state.task?.id !== final!.task!.id && state.task?.phase === 'complete';
  }, {timeout: 60_000, intervals: [100, 250, 500]}).toBe(true);
  await expect.poll(async () => (await invoke<RuntimeSnapshot>(main, 'gui_get_runtime')).voice.phase).toBe('wake');
  await expect(main.getByRole('button', {name: 'Speak now', exact: true})).toBeVisible();
  await main.screenshot({path: resolve(import.meta.dir, '../verification/screenshots/native-wake-ready.png')});
  }
  assert.deepEqual(errors, []);
  passed = true;
  console.log(process.argv.includes('--settings-only')
    ? 'PASS: launch arms wake listening; saved switch stops and restarts the wake model'
    : 'PASS: Hey Kaji launch/detection/transcription/reply; Stop survives reload; cold mic returns to wake; saved wake switch starts/stops capture');
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  child.kill(); await child.exited;
  await browser?.close().catch(() => {});
  await Bun.write(resolve(import.meta.dir, '../verification/wake-live.json'), JSON.stringify({time: new Date().toISOString(), binary, passed, phases: [...phases], transcript: final?.voice.transcript, reply: final?.task?.message, voice: lastVoice ?? final?.voice, errors, nativeLog: await nativeLog}, null, 2));
  assert(!relative(tmpdir(), profile).startsWith('..') && basename(profile).startsWith('kaji-wake-check-'));
  await rm(profile, {recursive: true, force: true, maxRetries: 15, retryDelay: 100}).catch(error => {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  });
}
