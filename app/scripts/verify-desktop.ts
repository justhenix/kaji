import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, expect, type Browser, type Page } from '../../web/node_modules/@playwright/test/index';
import { DEFAULT_SETTINGS } from '../src/gui/ipc';
import { SETTINGS_CATEGORIES } from '../src/gui/types';
import type { RuntimeSnapshot } from '../shared/runtime';

const root = resolve(import.meta.dir, '..');
const binaryIndex = process.argv.indexOf('--binary');
const binary = binaryIndex < 0 ? resolve(root, 'src-tauri/target/debug/kaji.exe') : resolve(process.argv[binaryIndex + 1]);
const output = resolve(root, 'verification');
const liveDocument = process.argv.includes('--live-document');
const liveReply = process.argv.includes('--live-reply');
const isolated = await mkdtemp(join(tmpdir(), 'kaji-desktop-verify-'));
await mkdir(join(isolated, 'roaming/Kaji'), { recursive: true });
await mkdir(join(output, 'screenshots'), { recursive: true });
await Bun.write(join(isolated, 'roaming/Kaji/settings.json'), JSON.stringify({
  ...DEFAULT_SETTINGS, startup_open: 'mainWindow', theme: 'dark',
  permission_input: false, enable_head_control: false,
  voice_feedback: false, voice_activation: false,
}));

let child: ReturnType<typeof Bun.spawn> | undefined;
let browser: Browser | undefined;
let passed = false;
let nativeLog: Promise<string> = Promise.resolve('');
const errors: string[] = [];
const checks: string[] = [];
let launches = 0;
let documentEvidence: { reply: string; paragraphs: string[]; title?: string } | undefined;
let replyEvidence: string | undefined;

async function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  await page.waitForLoadState('domcontentloaded');
  return page.evaluate(async ({ command, args }: { command: string; args: Record<string, unknown> }) => {
    const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke(command: string, args: Record<string, unknown>): Promise<unknown> } }).__TAURI_INTERNALS__;
    return bridge.invoke(command, args);
  }, { command, args });
}

async function start(live = false): Promise<{ main: Page; pages: Page[] }> {
  const probe = createServer();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const address = probe.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((accept, reject) => probe.close(error => error ? reject(error) : accept()));
  const launched = Bun.spawn([binary], {
    env: {
      ...process.env,
      KAJI_GATEWAY_TOKEN: undefined,
      KAJI_GATEWAY_CREDENTIAL_PATH: live ? undefined : join(isolated, 'missing-gateway-token.dpapi'),
      APPDATA: join(isolated, 'roaming'), LOCALAPPDATA: join(isolated, 'local'),
      WEBVIEW2_USER_DATA_FOLDER: join(isolated, `webview-${++launches}`),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', windowsHide: true,
  });
  child = launched;
  nativeLog = new Response(launched.stderr).text();
  const endpoint = `http://127.0.0.1:${port}`;
  await expect.poll(async () => {
    if (child!.exitCode !== null) throw new Error(`Native startup exited (${child!.exitCode}): ${(await nativeLog).slice(-2000)}`);
    try { return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, { timeout: 30_000, message: 'Native WebView2 debugging endpoint did not start' }).toBe(true);
  browser = await chromium.connectOverCDP(endpoint);
  await expect.poll(() => browser!.contexts().flatMap((context: { pages(): Page[] }) => context.pages()).length, {timeout:10_000}).toBeGreaterThanOrEqual(4);
  const pages: Page[] = browser.contexts().flatMap((context: { pages(): Page[] }) => context.pages());
  for (const page of pages) page.on('pageerror', (error: Error) => errors.push(error.message));
  await expect.poll(()=>pages.map((page)=>page.url()).some((url)=>/tauri\.localhost\/(?:index\.html|composer\.html)?(?:\?.*)?$/.test(url))).toBe(true);
  const main = pages.find((page) => /tauri\.localhost\/(?:index\.html|composer\.html)?(?:\?.*)?$/.test(page.url()));
  assert(main, `Native main webview missing: ${pages.map(page=>page.url()).join(', ')}`);
  await expect(main.locator('#app')).not.toBeEmpty();
  if (main.url().endsWith('/composer.html')) {
    await main.getByRole('button', { name: 'Open Kaji', exact: true }).click();
    await expect(main).toHaveURL(/index\.html$/);
  }
  return { main, pages };
}

async function close(main: Page): Promise<void> {
  if (!main.url().includes('composer.html')) {
    await main.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(main).toHaveURL(/composer\.html$/);
  }
  await main.getByRole('button', { name: 'Open Kaji', exact: true }).click();
  await expect(main).toHaveURL(/index\.html$/);
  await main.getByRole('button', { name: 'Composer', exact: true }).click();
  await expect(main).toHaveURL(/composer\.html$/);
  const metrics=await invoke<{nativeCaption:boolean;clientWidth:number;clientHeight:number;outerWidth:number;outerHeight:number}>(main,'gui_set_view',{view:'composer'});
  assert.equal(metrics.nativeCaption,false);
  assert.equal(metrics.clientHeight,metrics.outerHeight);
  await main.locator('.composer-pill').screenshot({path:join(output,'screenshots/native-composer-dark.png')});
  checks.push('Composer native caption removed; client and outer heights match');
  await invoke(main, 'gui_window_close', { label: 'main' }).catch(() => {});
  await Promise.race([child!.exited, Bun.sleep(5000).then(() => { throw new Error('Native app did not exit'); })]);
  await browser?.close().catch(() => {});
  browser = undefined;
  child = undefined;
}

try {
  let { main, pages } = await start();
  const snapshot = await invoke<RuntimeSnapshot>(main, 'gui_get_runtime');
  assert.equal(snapshot.head.active, false);
  assert.equal(snapshot.voice.enabled, false);
  assert.equal(snapshot.layout.active, false);
  assert.equal(snapshot.task, null);
  checks.push('Real Tauri snapshot; sensors idle; typed layout state');

  const audio = pages.find((page) => page.url().endsWith('/audio.html'));
  const overlay = pages.find((page) => page.url().endsWith('/overlay.html'));
  assert(audio && overlay, 'Hidden runtime hosts missing');
  for (const page of [audio, overlay]) {
    const projection = await invoke<RuntimeSnapshot>(page, 'gui_get_runtime');
    assert.equal(projection.task, null);
    await assert.rejects(invoke(page, 'gui_dispatch', { action: { type: 'conversation.new' } }));
  }
  checks.push('Audio/overlay native permissions permit snapshots and reject conversation writes');
  const sprite = overlay.locator('.doppelganger-cursor');
  await expect(sprite).toBeVisible();
  const glow = await sprite.evaluate((element: Element) => getComputedStyle(element).filter);
  assert(glow.includes('drop-shadow'), 'Dither cursor glow is missing');
  const bounds = await sprite.boundingBox();
  assert(bounds);
  const viewport = await overlay.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const x = Math.max(0, bounds.x - 12), y = Math.max(0, bounds.y - 12);
  await overlay.screenshot({ path: join(output, 'screenshots/native-doppelganger.png'), omitBackground: true,
    clip: { x, y, width: Math.min(bounds.width + 24, viewport.width - x), height: Math.min(bounds.height + 24, viewport.height - y) } });
  checks.push('Small dither cursor renders a blue/pink glow in the native overlay');

  await main.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(main).toHaveURL(/settings\.html/);
  for (const theme of ['light', 'dark']) {
    await main.locator('.settings-sidebar').getByRole('button', { name: 'Appearance', exact: true }).click();
    await main.locator(`[data-theme="${theme}"]`).click();
    await expect(main.locator('html')).toHaveAttribute('data-theme', theme);
    for (const category of SETTINGS_CATEGORIES) {
      await main.locator('.settings-sidebar').getByRole('button', { name: category.label, exact: true }).click();
      await expect(main.getByRole('heading', { name: category.label, exact: true })).toBeVisible();
      assert(await main.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${theme} ${category.label} overflows horizontally`);
    }
    await main.locator('.settings-sidebar').getByRole('button', { name: 'Appearance', exact: true }).click();
    await main.screenshot({ path: join(output, `screenshots/native-settings-${theme}.png`) });
  }
  await main.locator('.settings-sidebar').getByRole('button', { name: 'General', exact: true }).click();
  const launch = main.getByRole('combobox', { name: 'Open on launch', exact: true });
  await launch.focus();
  await launch.press('Enter');
  await expect(main.getByRole('listbox')).toBeVisible();
  await main.keyboard.press('Escape');
  await expect(main.getByRole('listbox')).toHaveCount(0);
  await launch.click();
  await main.getByRole('option', { name: 'Composer', exact: true }).click();
  const save = main.getByRole('button', { name: 'Save changes', exact: true });
  await save.click();
  await expect(main.locator('#settings-save-btn')).toHaveText('Saved');
  const saved = await invoke<{ theme: string; startup_open: string }>(main, 'gui_get_settings');
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.startup_open, 'composer');
  await main.getByRole('button', { name: 'Back to Kaji', exact: true }).click();
  checks.push('All eight native settings pages render in both themes; keyboard dropdown dismissal and native save work');

  await main.getByRole('button', { name: 'History', exact: true }).click();
  await expect(main).toHaveURL(/history\.html\?view=history$/);
  await expect(main.getByRole('heading', { name: 'Recents', exact: true })).toBeVisible();
  checks.push('Native History route opens inside main window');
  await main.getByRole('button', { name: 'New session', exact: true }).click();
  await expect(main).toHaveURL(/view=conversation/);
  await expect(main.locator('#conversation-input')).toBeVisible();
  checks.push('Native empty conversation renders its composer');
  const created = await invoke<RuntimeSnapshot>(main, 'gui_get_runtime');
  assert(created.activeConversationId);
  await assert.rejects(invoke(main, 'gui_dispatch', { action: { type: 'request', text: 'Check native conversation persistence', conversationId: created.activeConversationId } }), /credential.*unavailable/i);
  const failedTask = await invoke<RuntimeSnapshot>(main, 'gui_get_runtime');
  assert.equal(failedTask.task?.phase, 'error');
  assert.equal(failedTask.task?.verified, false);
  checks.push('Credential failure is visible and persists the real request without provider inference');
  await invoke(main, 'gui_dispatch', { action: { type: 'conversation.rename', conversationId: created.activeConversationId, title: 'Native verification session' } });
  await main.getByRole('button', { name: 'Back to Kaji', exact: true }).click();
  await expect(main.getByRole('heading', { name: 'Recents', exact: true })).toBeVisible();
  await expect(main.locator('.history-open').filter({ hasText: 'Native verification session' })).toBeVisible();
  await main.getByPlaceholder('Search conversations').fill('Native verification');
  await expect(main.locator('.history-open').filter({ hasText: 'Native verification session' })).toBeVisible();
  await main.locator('.history-open').filter({ hasText: 'Native verification session' }).click();
  const reopened = await invoke<RuntimeSnapshot>(main, 'gui_get_runtime');
  assert.equal(reopened.task?.phase, 'error');
  assert.equal(reopened.question, null);
  checks.push('Same-window History: new, rename, search, reopen; no approval/task replay');
  await main.screenshot({ path: join(output, 'screenshots/native-history-dark.png') });
  const conversationId = created.activeConversationId;
  await close(main);

  ({ main } = await start());
  const rows = await invoke<{ id: string; title: string }[]>(main, 'gui_history_list');
  assert(rows.some((row) => row.id === conversationId && row.title === 'Native verification session'));
  const record = await invoke<{ messages: unknown[] } | null>(main, 'gui_history_get', { conversationId });
  assert(record);
  checks.push('SQLite conversation survives native process restart');
  await main.getByRole('button', { name: 'History', exact: true }).click();
  await main.getByRole('button', { name: 'Rename Native verification session', exact: true }).click();
  await main.getByRole('textbox', { name: 'Conversation title', exact: true }).fill('Renamed verification session');
  await main.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(main.getByRole('button', { name: 'Delete Renamed verification session', exact: true })).toBeVisible();
  await main.getByRole('button', { name: 'Delete Renamed verification session', exact: true }).click();
  await main.getByRole('dialog', { name: 'Delete conversation', exact: true }).screenshot({ path: join(output, 'screenshots/native-history-delete.png') });
  await main.getByRole('dialog', { name: 'Delete conversation', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(main.getByRole('button', { name: 'Delete Renamed verification session', exact: true })).toBeVisible();
  await main.getByRole('button', { name: 'Delete Renamed verification session', exact: true }).click();
  await main.getByRole('dialog', { name: 'Delete conversation', exact: true }).getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await expect(main.locator('.history-open').filter({ hasText: 'Renamed verification session' })).toHaveCount(0);
  assert.equal((await invoke<{ id: string }[]>(main, 'gui_history_list')).some(row => row.id === conversationId), false);
  checks.push('History rename, delete cancellation, and confirmed deletion work through the real interface');
  await close(main);
  if (liveReply) {
    ({ main } = await start(true));
    await main.getByRole('button', { name: 'Composer', exact: true }).click();
    await expect(main).toHaveURL(/composer\.html$/);
    await main.getByRole('button', { name: 'Type a request', exact: true }).click();
    const editor = main.getByRole('textbox', { name: 'Your request', exact: true });
    await editor.fill('Reply with exactly KAJI_TYPED_OK.');
    await editor.press('Enter');
    await expect.poll(async () => {
      const state = await invoke<RuntimeSnapshot>(main, 'gui_get_runtime');
      assert(!state.voice.enabled && !state.head.enabled, 'The typed test started a device');
      assert(!state.question, 'The typed reply unexpectedly needs user input');
      if (['error', 'stopped', 'blocked'].includes(state.task?.phase ?? '')) throw new Error(state.task?.message);
      replyEvidence = state.task?.message;
      return state.task?.phase;
    }, { timeout: 90_000, intervals: [250, 500, 1000] }).toBe('complete');
    assert(replyEvidence?.includes('KAJI_TYPED_OK'));
    await expect(main.locator('.composer-notice-text')).toHaveText(replyEvidence!);
    checks.push('Packaged agent answers a typed composer request with voice and camera disabled');
    await close(main);
  }
  if (liveDocument) {
    ({ main } = await start(true));
    await main.getByRole('button', { name: 'Composer', exact: true }).click();
    await expect(main).toHaveURL(/composer\.html$/);
    await main.getByRole('button', { name: 'Type a request', exact: true }).click();
    const editor = main.getByRole('textbox', { name: 'Your request', exact: true });
    await editor.fill('Create a new Word document. Use the exact heading "Kaji integration check" and the exact paragraph "Native to Python connection works."');
    await editor.press('Enter');
    let completed: RuntimeSnapshot | undefined;
    await expect.poll(async () => {
      const state = await invoke<RuntimeSnapshot>(main, 'gui_get_runtime');
      assert(!state.question, `Routine document creation prompted for input: ${state.question?.title}`);
      if (['error', 'stopped', 'blocked'].includes(state.task?.phase ?? '')) throw new Error(`Live task ${state.task?.phase}: ${state.task?.message}`);
      completed = state;
      return state.task?.phase === 'complete';
    }, { timeout: 120_000, intervals: [250, 500, 1000], message: 'Live native-to-agent document task did not complete' }).toBe(true);
    assert(completed?.task?.verified);
    assert.equal(completed.task.method, 'python_docx');
    assert(!/[\r\n]/.test(completed.task.message));
    assert(completed.task.message.split(/\s+/).length <= 20);
    assert.equal(completed.task.artifacts.length, 1);
    const artifact = completed.task.artifacts[0]!;
    await expect(main.locator('.composer-notice-text')).toHaveText(completed.task.message);
    await expect(main.getByRole('button', { name: artifact.name, exact: true })).toBeVisible();
    assert(!relative(isolated, artifact.path).startsWith('..'), 'Artifact escaped the isolated data directory');
    const python = Bun.spawn([resolve(binary, '../python/python.exe'), '-I', '-c', 'import json,sys;from docx import Document;print(json.dumps([p.text for p in Document(sys.argv[1]).paragraphs]))', artifact.path], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const paragraphs = JSON.parse(await new Response(python.stdout).text()) as string[];
    documentEvidence = { reply: completed.task.message, paragraphs };
    assert.equal(await python.exited, 0);
    assert(paragraphs.includes('Kaji integration check'));
    assert(paragraphs.includes('Native to Python connection works.'));
    checks.push('A typed request produces an independently inspected DOCX without a method or approval prompt');
    await expect.poll(async () => {
      const record = await invoke<{ titleSource: string; title: string }>(main, 'gui_history_get', { conversationId: completed!.task!.conversationId });
      documentEvidence!.title = record.title;
      return record.titleSource;
    }, { timeout: 20_000, message: 'Live automatic session title was not saved' }).toBe('automatic');
    checks.push('Live short reply, verified artifact, and asynchronous Groq title persist in the native conversation');
    await close(main);
  }
  assert.deepEqual(errors, []);
  passed = true;
  console.log(`PASS: ${checks.length} native desktop integration checks; no camera, microphone, or injected input; provider inference ${liveDocument || liveReply ? 'included' : 'disabled'}.`);
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  if (child) { child.kill(); await child.exited; }
  await browser?.close().catch(() => {});
  await Bun.write(join(output, liveDocument ? 'desktop-live.json' : liveReply ? 'desktop-live-reply.json' : 'desktop-integration.json'), JSON.stringify({ time: new Date().toISOString(), binary, passed, checks, errors, documentEvidence, replyEvidence, nativeExitCode: child?.exitCode, nativeLog: await nativeLog }, null, 2));
  const resolvedTemporary = await realpath(isolated);
  const resolvedParent = await realpath(tmpdir());
  if (!relative(resolvedParent, resolvedTemporary).startsWith('..') && basename(resolvedTemporary).startsWith('kaji-desktop-verify-')) {
    await rm(resolvedTemporary, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }).catch(error => {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    });
  }
}
