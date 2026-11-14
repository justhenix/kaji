import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, expect, type Browser, type Page } from '../../web/node_modules/@playwright/test/index';
import { DEFAULT_SETTINGS } from '../src/gui/ipc';
import type { RuntimeSnapshot } from '../shared/runtime';
import phrases from '../assets/voice/manifest.json';
import fixtures from './voice-fixtures.json';

type Proof = {
  microphones: { label: string; settings: MediaTrackSettings; live: boolean }[];
  replies: { hash: string; ended: boolean; duration: number; volume: number; error?: string }[];
};
const root = resolve(import.meta.dir, '..');
const fixtureMode = process.argv.includes('--fixtures');
const migrateLogin = fixtureMode && process.argv.includes('--migrate-login');
const binaryFlag = process.argv.indexOf('--binary');
const binary = binaryFlag === -1 ? resolve(root, 'src-tauri/target/debug/kaji.exe') : resolve(process.argv[binaryFlag + 1]!);
const isolated = fixtureMode && process.argv.includes('--isolated');
const output = resolve(root, fixtureMode ? 'verification/voice-commands-fixtures.json' : 'verification/voice-commands-live.json');
const fixtureDir = resolve(root, 'verification');
const wakeFixture = Bun.file(join(fixtureDir, 'speech-prefix.wav'));
if (fixtureMode) assert(await wakeFixture.exists(), 'Run scripts/generate-voice-fixtures.ps1 first');
const profile = await mkdtemp(join(tmpdir(), 'kaji-voice-commands-'));
const fixtureLogin = join(profile, 'local/Kaji/gateway-token.dpapi');
const settings = { ...DEFAULT_SETTINGS, startup_open: 'mainWindow', voice_activation: true,
  voice_feedback: true, sound_effects: false, enable_head_control: false, permission_input: true,
  microphone: '', speaker: '', response_language: 'English (US)', response_volume: 75, enable_shortcuts: !isolated };
await mkdir(join(profile, 'roaming/Kaji'), { recursive: true });
await Bun.write(join(profile, 'roaming/Kaji/settings.json'), JSON.stringify({ ...settings, voice_activation: !fixtureMode }));
let oldLoginHash: string | undefined;
if (migrateLogin) {
  const rejectedLogin = randomBytes(32).toString('hex');
  const encrypted = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::Write((ConvertTo-SecureString ([Console]::ReadLine()) -AsPlainText -Force | ConvertFrom-SecureString))'], {
    env: { ...process.env, PSModulePath: undefined }, stdin: new Blob([rejectedLogin, '\n']), stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  assert.equal(encrypted.exitCode, 0, encrypted.stderr.toString());
  assert.match(encrypted.stdout.toString(), /^[0-9a-f]+$/i, 'Windows did not encrypt the test login');
  await mkdir(join(profile, 'local/Kaji'), { recursive: true });
  await Bun.write(fixtureLogin, encrypted.stdout);
  oldLoginHash = createHash('sha256').update(encrypted.stdout).digest('hex');
}
const hashes = new Map<string, string>();
for (const phrase of phrases) for (const language of ['en', 'idn']) {
  hashes.set(createHash('sha256').update(new Uint8Array(await Bun.file(resolve(root, `assets/voice/${language}/${phrase.id}.mp3`)).arrayBuffer())).digest('hex'), phrase.id);
}
const probe = createServer();
await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
const address = probe.address();
assert(address && typeof address === 'object');
const port = address.port;
await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
const command = isolated
  ? [join(dirname(binary), 'python/python.exe'), '-I', resolve(root, 'scripts/fixtures/isolated-desktop.py'), binary]
  : [binary];
const child = Bun.spawn(command, {
  env: { ...process.env, APPDATA: join(profile, 'roaming'), LOCALAPPDATA: join(profile, 'local'),
    KAJI_GATEWAY_CREDENTIAL_PATH: fixtureMode ? fixtureLogin : process.env.KAJI_GATEWAY_CREDENTIAL_PATH,
    WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1${isolated ? ' --use-fake-device-for-media-stream --use-fake-ui-for-media-stream' : ''}${fixtureMode ? ' --autoplay-policy=no-user-gesture-required' : ''}` },
  stdin: isolated ? 'pipe' : 'ignore', stdout: 'ignore', stderr: 'pipe', windowsHide: true,
});
const nativeLog = new Response(child.stderr).text();
let browser: Browser | undefined;
let main: Page | undefined;
let passed = false;
const errors: string[] = [];
type VerifiedCommand = { id?: string; reply: string; transcript: string; mode: string; theme: string; duration: number; view: string; head?: RuntimeSnapshot['head']; position?: string; windowY?: number };
const prior = !fixtureMode && process.argv.includes('--resume') ? await Bun.file(output).json().catch(() => null) : null;
const verified: VerifiedCommand[] = prior?.verified ?? [];
const extraCommands: string[] = prior?.extraCommands ?? [];
const phases = new Set<string>();
let proof: Proof = { microphones: [], replies: [] };
let lastVoice: RuntimeSnapshot['voice'] | undefined;
let peakLevel = 0;
async function invoke<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(({ command, args }: { command: string; args: Record<string, unknown> }) =>
    (window as unknown as { __TAURI_INTERNALS__: { invoke(command: string, args: Record<string, unknown>): Promise<T> } }).__TAURI_INTERNALS__.invoke(command, args), { command, args });
}
const save = () => Bun.write(output, JSON.stringify({ time: new Date().toISOString(), passed, binary, physicalMicrophone: !fixtureMode,
  debugPort: port, voice: lastVoice, peakLevel, phases: [...phases], verified, extraCommands, proof, errors }, null, 2));
try {
  const endpoint = `http://127.0.0.1:${port}`;
  await expect.poll(() => fetch(`${endpoint}/json/version`).then(response => response.ok, () => false), { timeout: 25_000 }).toBe(true);
  browser = await chromium.connectOverCDP(endpoint);
  let audio: Page | undefined;
  await expect.poll(() => {
    const pages = browser!.contexts().flatMap((context: { pages(): Page[] }) => context.pages());
    main = pages.find((page: Page) => /tauri\.localhost\/(?:index\.html)?$/.test(page.url()));
    audio = pages.find((page: Page) => page.url().endsWith('/audio.html'));
    return !!main && !!audio;
  }, { timeout: 15_000 }).toBe(true);
  assert(main && audio);
  for (const page of [main, audio]) page.on('pageerror', (error: Error) => errors.push(error.message));
  await audio.waitForLoadState('load');
  await audio.evaluate(async (fixtureMode: boolean) => {
    const proof: Proof = { microphones: [], replies: [] };
    (window as unknown as { voiceTestProof: Proof }).voiceTestProof = proof;
    const blobs = new Map<string, Blob>();
    const objectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = object => {
      const url = objectURL(object);
      if (object instanceof Blob) blobs.set(url, object);
      return url;
    };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const fixtureContext = fixtureMode ? new AudioContext({ sampleRate: 16_000 }) : undefined;
    const fixtureInput = fixtureContext?.createMediaStreamDestination();
    if (fixtureContext && fixtureInput) {
      await fixtureContext.resume();
      const silence = fixtureContext.createConstantSource();
      silence.offset.value = 0;
      silence.connect(fixtureInput);
      silence.start();
      const decode = (base64: string) => fixtureContext.decodeAudioData(Uint8Array.from(atob(base64), char => char.charCodeAt(0)).buffer);
      (window as unknown as { playVoiceFixture: (wake: string, command: string, gap: number) => Promise<void> }).playVoiceFixture = async (wake, command, gap) => {
      const [prefix, utterance] = await Promise.all([decode(wake), decode(command)]);
        await fixtureContext.resume();
        const playAt = (buffer: AudioBuffer, time: number) => {
          const source = fixtureContext.createBufferSource();
          source.buffer = buffer;
          source.connect(fixtureInput);
          source.start(time);
          source.addEventListener('ended', () => source.disconnect(), { once: true });
        };
        const start = fixtureContext.currentTime + 0.2;
        playAt(prefix, start);
        playAt(utterance, start + prefix.duration + gap);
      };
    }
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = fixtureInput ? fixtureInput.stream.clone() : await capture(constraints);
      (window as unknown as { voiceTestStream: MediaStream }).voiceTestStream = stream;
      for (const track of stream.getAudioTracks()) proof.microphones.push({ label: track.label, settings: track.getSettings(), live: track.readyState === 'live' });
      return stream;
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const reply = { hash: '', ended: false, duration: 0, volume: this.volume, error: undefined as string | undefined };
      proof.replies.push(reply);
      void Promise.resolve(blobs.get(this.src)).then(blob => {
        if (!blob) throw new Error('Speech did not use a bundled audio blob');
        return blob.arrayBuffer();
      }).then(bytes => crypto.subtle.digest('SHA-256', bytes))
        .then(hash => { reply.hash = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''); })
        .catch(error => { reply.error = String(error); });
      this.addEventListener('ended', () => { reply.ended = true; reply.duration = this.duration; }, { once: true });
      this.addEventListener('error', () => { reply.error = this.error?.message ?? 'Playback failed'; }, { once: true });
      return play.call(this);
    };
  }, fixtureMode);
  await invoke(audio, 'gui_get_runtime');
  const waitWake = () => expect.poll(async () => {
    const state = await invoke<RuntimeSnapshot>(audio!, 'gui_get_runtime');
    if (state.voice.phase === 'error') throw new Error(state.voice.reason);
    return state.voice.phase;
  }, { timeout: 20_000 }).toBe('wake');
  if (!fixtureMode) {
    await waitWake();
    await invoke(main, 'gui_save_settings', { settings: { ...settings, voice_activation: false } });
    await expect.poll(async () => (await invoke<RuntimeSnapshot>(audio!, 'gui_get_runtime')).voice.phase).toBe('off');
  }
  await invoke(main, 'gui_save_settings', { settings });
  await waitWake();
  await expect(main.locator('#hero-status-chip')).toHaveText('Waiting for wake phrase');
  if (fixtureMode) {
    const wake = Buffer.from(await wakeFixture.arrayBuffer()).toString('base64');
    let replyIndex = 0;
    const placementY = new Map<string, number>();
    for (const [index, fixture] of fixtures.entries()) {
      if (fixture.id === 'composer_top') {
        await main.locator('#footer-composer-btn').evaluate((button: HTMLButtonElement) => button.click());
        await expect(main).toHaveURL(/composer\.html$/);
        await expect(main.locator('.composer-stage')).toHaveAttribute('data-placement', 'floating');
      }
      const command = Buffer.from(await Bun.file(join(fixtureDir, `speech-command-${fixture.id}.wav`)).arrayBuffer()).toString('base64');
      await audio.evaluate(async ({ wake, command, gap }: { wake: string; command: string; gap: number }) => {
        await (window as unknown as { playVoiceFixture: (wake: string, command: string, gap: number) => Promise<void> }).playVoiceFixture(wake, command, gap);
      }, { wake, command, gap: index % 2 === 0 ? 0.5 : -0.55 });
      const seen = new Set<string>();
      let headTransition: RuntimeSnapshot['head'] | undefined;
      const expectedHead = fixture.dwell ?? fixture.headEnabled;
      await expect.poll(async () => {
        const state = await invoke<RuntimeSnapshot>(audio!, 'gui_get_runtime');
        lastVoice = state.voice;
        peakLevel = Math.max(peakLevel, state.voice.audioLevel);
        if (!seen.has(state.voice.phase)) console.log(`${fixture.id}: ${state.voice.phase}`);
        seen.add(state.voice.phase);
        phases.add(state.voice.phase);
        if (expectedHead !== undefined && seen.has('transcribing') && state.head.enabled === expectedHead
            && (fixture.dwell === undefined || state.head.dwellEnabled === fixture.dwell)) headTransition = state.head;
        if (state.voice.phase === 'error') throw new Error(state.voice.reason);
        if (state.task) {
          if (['planning', 'working', 'verifying', 'awaiting_user', 'awaiting_method', 'awaiting_confirmation'].includes(state.task.phase)) {
            await invoke(main!, 'gui_dispatch', { action: { type: 'stop', taskId: state.task.id } });
          }
          throw new Error(`${fixture.id} escaped local routing: ${state.voice.transcript}`);
        }
        proof = await audio!.evaluate(() => (window as unknown as { voiceTestProof: Proof }).voiceTestProof);
        if (fixture.reply === null) {
          if (!seen.has('transcribing') || state.voice.phase !== 'wake') return undefined;
          if (proof.replies.length !== replyIndex) throw new Error('Spoken feedback played after being disabled');
          const current = await invoke<typeof settings>(audio!, 'gui_get_settings');
          return current.voice_feedback === fixture.feedback ? null : undefined;
        }
        const reply = proof.replies[replyIndex];
        if (reply?.error) throw new Error(reply.error);
        return reply?.ended && state.voice.phase === 'wake' ? hashes.get(reply.hash) : undefined;
      }, { timeout: 18_000, intervals: [100] }).toBe(fixture.reply);
      assert(['listening', 'transcribing'].every(phase => seen.has(phase)), `${fixture.id}: ${[...seen]}`);
      assert.equal(seen.has('speaking'), fixture.reply !== null);
      if (index === 0) {
        assert(await Bun.file(fixtureLogin).exists(), 'Device login was not persisted');
        if (oldLoginHash) {
          assert.notEqual(createHash('sha256').update(await Bun.file(fixtureLogin).bytes()).digest('hex'), oldLoginHash, 'Rejected login was not replaced');
          console.log('PASS: Existing rejected login migrated through the live enrollment endpoint.');
        } else console.log('PASS: Fresh profile enrolled through the live gateway.');
      }
      const state = await invoke<RuntimeSnapshot>(main, 'gui_get_runtime');
      const current = await invoke<typeof settings>(audio, 'gui_get_settings');
      const reply = fixture.reply === null ? undefined : proof.replies[replyIndex++];
      if (fixture.mode) assert.equal(state.mode, fixture.mode);
      if (fixture.theme) {
        assert.equal(current.theme, fixture.theme);
        if (fixture.theme !== 'system') await expect(main.locator('html')).toHaveAttribute('data-theme', fixture.theme);
      }
      if (expectedHead !== undefined) assert(headTransition, state.head.reason || `${fixture.id} did not change head control`);
      if (fixture.position) {
        assert.equal(current.composer_position, fixture.position);
        await expect(main.locator('.composer-stage')).toHaveAttribute('data-placement', fixture.position);
        placementY.set(fixture.position, await main.evaluate(() => window.screenY));
        await main.screenshot({ path: join(fixtureDir, `screenshots/native-voice-${fixture.position}.png`) });
      }
      if (fixture.volume !== undefined) assert.equal(current.response_volume, fixture.volume);
      if (fixture.feedback !== undefined) assert.equal(current.voice_feedback, fixture.feedback);
      if (reply) {
        assert(reply.duration > 0 && Number.isFinite(reply.duration));
        assert.equal(reply.volume, current.response_volume / 100);
      }
      verified.push({ id: fixture.id, reply: fixture.reply ?? '', transcript: state.voice.transcript, mode: state.mode,
        theme: current.theme, duration: reply?.duration ?? 0, view: new URL(main.url()).pathname, head: headTransition ?? state.head,
        position: current.composer_position, windowY: fixture.position ? placementY.get(fixture.position) : undefined });
      console.log(`PASS ${fixture.id}: ${state.voice.transcript}`);
      await save();
    }
    assert(placementY.get('top')! < placementY.get('floating')! && placementY.get('floating')! < placementY.get('taskbar')!, JSON.stringify(Object.fromEntries(placementY)));
    const state = await invoke<RuntimeSnapshot>(main, 'gui_get_runtime');
    assert(!state.head.enabled && !state.head.dwellEnabled, 'A late camera event restarted head control');
    if (!isolated) assert(!state.head.reason.startsWith('sensor:'), state.head.reason);
    assert.deepEqual(errors, []);
    passed = true;
    console.log('PASS: single wake phrase per fixture, live transcription, all three native command-bar positions, local settings, and exact offline playback.');
  } else await verifyPhysicalMic(main, audio, waitWake);
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  if (main) await main.screenshot({ path: resolve(root, 'verification/screenshots/native-voice-command-failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (isolated && typeof child.stdin === 'object') child.stdin.end();
  else child.kill();
  await child.exited;
  await save();
  await nativeLog;
  const temporary = await realpath(tmpdir()), actual = await realpath(profile);
  assert(!relative(temporary, actual).startsWith('..') && basename(actual).startsWith('kaji-voice-commands-'));
  if (fixtureMode) await rm(fixtureLogin, { force: true });
  await rm(actual, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }).catch(error => {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  });
}

async function verifyPhysicalMic(main: Page, audio: Page, waitWake: () => Promise<void>) {
  await invoke(main, 'gui_dispatch', { action: { type: 'request', source: 'text', text: 'Test your voice' } });
  await expect.poll(() => audio!.evaluate(() => (window as unknown as { voiceTestProof: Proof }).voiceTestProof.replies[0]?.ended), { timeout: 10_000 }).toBe(true);
  proof = await audio.evaluate(() => (window as unknown as { voiceTestProof: Proof }).voiceTestProof);
  assert.equal(hashes.get(proof.replies[0]!.hash), 'voice_test', proof.replies[0]!.error ?? 'Offline audio hash self-check failed');
  await audio.evaluate(() => { (window as unknown as { voiceTestProof: Proof }).voiceTestProof.replies.length = 0; });
  await waitWake();
  await main.screenshot({ path: resolve(root, 'verification/screenshots/native-voice-main-armed.png') });
  proof = await audio.evaluate(() => (window as unknown as { voiceTestProof: Proof }).voiceTestProof);
  assert(proof.microphones.some(microphone => microphone.live && !/fake/i.test(microphone.label)), 'No real microphone stream opened');
  console.log(`READY: ${proof.microphones.map(microphone => microphone.label).join(', ')}. Say: Hey Kaji, use agent mode please.`);
  await save();
  const goals = new Set(['agent_mode', 'guide_mode', 'assist_mode', 'light_mode', 'dark_mode', 'system_mode', 'voice_test']);
  for (const command of verified) goals.delete(command.reply);
  const started = Date.now();
  let seen = 0;
  let previousPhase = '';
  while (Date.now() - started < 1_200_000 && goals.size) {
    const state = await invoke<RuntimeSnapshot>(audio, 'gui_get_runtime');
    lastVoice = state.voice;
    peakLevel = Math.max(peakLevel, state.voice.audioLevel);
    phases.add(state.voice.phase);
    if (state.voice.phase !== previousPhase) {
      console.log(`Voice: ${state.voice.phase}; level: ${state.voice.audioLevel.toFixed(4)}`);
      previousPhase = state.voice.phase;
      await save();
    }
    if (state.voice.phase === 'error') throw new Error(state.voice.reason);
    if (state.task && ['planning', 'working', 'verifying', 'awaiting_user', 'awaiting_method', 'awaiting_confirmation'].includes(state.task.phase)) {
      extraCommands.push(state.voice.transcript);
      console.log(`EXTRA COMMAND: ${state.voice.transcript}; keeping microphone armed for remaining tests.`);
      await main.waitForLoadState('domcontentloaded');
      await invoke(main, 'gui_dispatch', { action: { type: 'stop', taskId: state.task.id } });
      await save();
      continue;
    }
    proof = await audio.evaluate(() => (window as unknown as { voiceTestProof: Proof }).voiceTestProof);
    while (seen < proof.replies.length && proof.replies[seen]!.ended && proof.replies[seen]!.hash) {
      const reply = proof.replies[seen++]!;
      assert(!reply.error, reply.error ?? 'Playback failed');
      const id = hashes.get(reply.hash);
      assert(id, 'Played audio does not match any bundled offline clip');
      const currentSettings = await invoke<typeof settings>(audio, 'gui_get_settings');
      const expectedMode = ({ agent_mode: 'agent', guide_mode: 'guide', assist_mode: 'assist' } as Record<string, string>)[id];
      const expectedTheme = ({ light_mode: 'light', dark_mode: 'dark', system_mode: 'system' } as Record<string, string>)[id];
      if (expectedMode) assert.equal(state.mode, expectedMode);
      if (expectedTheme) {
        assert.equal(currentSettings.theme, expectedTheme);
        if (expectedTheme !== 'system') await expect(main.locator('html')).toHaveAttribute('data-theme', expectedTheme);
      }
      assert(reply.duration > 0 && Number.isFinite(reply.duration));
      assert.equal(reply.volume, 0.75);
      verified.push({ reply: id, transcript: state.voice.transcript, mode: state.mode, theme: currentSettings.theme, duration: reply.duration, view: new URL(main.url()).pathname });
      goals.delete(id);
      console.log(`VERIFIED: ${id}; transcript: ${state.voice.transcript}; remaining: ${[...goals].join(', ')}`);
      await save();
    }
    const failedReply = proof.replies.find(reply => reply.error);
    assert(!failedReply, failedReply?.error ?? 'Playback failed');
    await Bun.sleep(150);
  }
  assert.equal(goals.size, 0, `Commands not yet verified: ${[...goals].join(', ')}`);
  assert(peakLevel > 0.001 || prior?.passed, 'The microphone did not report a speech signal');
  assert.deepEqual(errors, []);
  passed = true;
  console.log('PASS: physical microphone, wake detection, transcription, all modes/themes, and exact bundled reply playback.');
}
