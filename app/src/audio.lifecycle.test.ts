import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { AudioControl } from '../shared/runtime';

const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  readFileSync(new URL('./audio.ts', import.meta.url), 'utf8').replace(/^import .+;\r?$/gm, '')
).replace(/^export\s+/gm, '').replace(/^\s*export\s*\{\s*\};?\s*$/gm, '');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function harness(enumerateDevices: () => Promise<unknown[]>, setSinkId: () => Promise<void> = async () => {}) {
  let plays = 0, pauses = 0, runtimeReads = 0;
  let player: Audio | undefined;
  const phases: string[] = [], revoked: string[] = [];
  class Audio {
    constructor() { player = this; }
    src = ''; volume = 1; title = '';
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    async play() { plays++; }
    pause() { pauses++; }
    setSinkId = setSinkId;
  }
  const context = {
    Audio, Blob, console, Uint8Array, AbortController, atob,
    performance: { now: () => 0 },
    URL: { createObjectURL: () => 'blob:test-audio', revokeObjectURL: (value: string) => revoked.push(value) },
    navigator: { mediaDevices: { enumerateDevices } },
    fetchRuntime: async () => { runtimeReads++; return { revision: 1, activeConversationId: 'conversation', voice: { sessionId: 1 } }; },
    dispatchRuntime: async (action: { phase: string }) => { phases.push(action.phase); },
  };
  const Host = runInNewContext(`${source}\nAudioHost;`, context) as new () => { control(value: AudioControl): Promise<void>; acceptRuntime(value: unknown): void };
  return { host: new Host(), phases, revoked, finishPlayback: () => player?.onended?.(), get plays() { return plays; }, get pauses() { return pauses; }, get runtimeReads() { return runtimeReads; } };
}

const speech = (utteranceId: string): AudioControl => ({
  type: 'play', utteranceId, voiceSessionId: 1, conversationId: 'conversation', audioBase64: btoa('encoded-test-audio'), mimeType: 'audio/mpeg', volume: 0.5,
});

test('Stop during delayed speaker enumeration cannot start audio later', async () => {
  const devices = deferred<unknown[]>();
  const h = harness(() => devices.promise);
  const playing = h.host.control(speech('delayed-devices'));
  await flush();
  await h.host.control({ type: 'stop' });
  devices.resolve([]);
  await playing;
  expect(h.plays).toBe(0);
  expect(h.phases).toEqual(['speaking', 'off']);
  expect(h.revoked).toHaveLength(1);
});

test('Spoken feedback returns to off when a one-shot recording has ended', async () => {
  const h = harness(async () => []);
  const playing = h.host.control(speech('one-shot-reply'));
  await flush();
  expect(h.plays).toBe(1);
  h.finishPlayback();
  await playing;
  expect(h.phases).toEqual(['speaking', 'off']);
});

test('Stop during delayed speaker selection cannot start audio later', async () => {
  const sink = deferred<void>();
  const h = harness(async () => [{ kind: 'audiooutput', deviceId: 'speaker' }], () => sink.promise);
  const playing = h.host.control({ ...speech('delayed-sink'), outputDeviceId: 'speaker' } as AudioControl);
  await flush();
  await h.host.control({ type: 'stop' });
  sink.resolve();
  await playing;
  expect(h.plays).toBe(0);
  expect(h.phases).toEqual(['speaking', 'off']);
});

test('Stop settles active speech and a repeated utterance never replays', async () => {
  const h = harness(async () => []);
  const playing = h.host.control(speech('active'));
  await flush();
  expect(h.plays).toBe(1);
  await h.host.control({ type: 'stop' });
  await playing;
  await h.host.control(speech('active'));
  expect(h.plays).toBe(1);
  expect(h.pauses).toBeGreaterThan(0);
  expect(h.phases.at(-1)).toBe('off');
});

test('A newer speech event supersedes delayed older playback', async () => {
  const first = deferred<unknown[]>(), second = deferred<unknown[]>();
  let calls = 0;
  const h = harness(() => ++calls === 1 ? first.promise : second.promise);
  const older = h.host.control(speech('older'));
  await flush();
  const newer = h.host.control(speech('newer'));
  await flush();
  second.resolve([]);
  await flush();
  expect(h.plays).toBe(1);
  first.resolve([]);
  await older;
  expect(h.plays).toBe(1);
  await h.host.control({ type: 'stop' });
  await newer;
});

test('Late synthesis from an old voice session or another conversation stays silent', async () => {
  const h = harness(async () => []);
  await h.host.control({ ...speech('stale-session'), voiceSessionId: 0 } as AudioControl);
  await h.host.control({ ...speech('stale-conversation'), conversationId: 'another' } as AudioControl);
  expect(h.plays).toBe(0);
  expect(h.phases).toEqual([]);
});

test('A new native voice session stops current playback without overwriting its new state', async () => {
  const h = harness(async () => []);
  const playing = h.host.control(speech('session-ended'));
  await flush();
  expect(h.plays).toBe(1);
  h.host.acceptRuntime({ revision: 2, activeConversationId: 'conversation', voice: { sessionId: 2 } });
  await playing;
  expect(h.pauses).toBeGreaterThan(0);
  expect(h.phases).toEqual(['speaking']);
});

test('A delayed wake hit cannot begin recording in a replacement session', async () => {
  const hit = deferred<{ label: string }[]>();
  const h = harness(async () => []);
  const capture = h.host as unknown as {
    mode: string; wakeEnabled: boolean; capturing: boolean;
    spotter: { processAudio(): Promise<{ label: string }[]>; dispose(): void };
    handleSamples(samples: Float32Array): Promise<void>;
  };
  capture.mode = 'wake';
  capture.wakeEnabled = true;
  capture.spotter = { processAudio: () => hit.promise, dispose() {} };
  const processing = capture.handleSamples(new Float32Array([0.1]));
  await h.host.control({ type: 'stop' });
  capture.mode = 'wake';
  hit.resolve([{ label: 'Hey Kaji' }]);
  await processing;
  expect(capture.capturing).toBe(false);
  expect(h.runtimeReads).toBe(0);
});

test('Stop discards the wake model tied to the cancelled microphone session', async () => {
  const h = harness(async () => []);
  const capture = h.host as unknown as { startAbort: AbortController; spotter: {dispose(): void} | null };
  const controller = new AbortController();
  let disposed = 0;
  capture.startAbort = controller;
  capture.spotter = {dispose() { disposed++; }};
  await h.host.control({type: 'stop'});
  expect(controller.signal.aborted).toBe(true);
  expect(disposed).toBe(1);
  expect(capture.spotter).toBeNull();
});

test('Auto-send waits for three continuous seconds of silence after speech', async () => {
  const h = harness(async () => []);
  const capture = h.host as unknown as {
    mode: string; capturing: boolean;
    recordUtterance(samples: Float32Array, level: number): Promise<void>;
    finishUtterance(): Promise<void>;
  };
  capture.mode = 'utterance';
  capture.capturing = true;
  let sends = 0;
  capture.finishUtterance = async () => { sends++; };
  const second = new Float32Array(16_000);
  await capture.recordUtterance(second, 0);
  await capture.recordUtterance(second, 0.1);
  await capture.recordUtterance(second, 0);
  await capture.recordUtterance(second, 0);
  await capture.recordUtterance(second, 0.1);
  await capture.recordUtterance(second, 0);
  await capture.recordUtterance(second, 0);
  expect(sends).toBe(0);
  await capture.recordUtterance(second, 0);
  expect(sends).toBe(1);
});
