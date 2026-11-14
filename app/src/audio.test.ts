import { expect, test } from 'bun:test';
import type { RuntimeSnapshot } from '../shared/runtime';
import { AudioHost, downsample, encodeWav, selectedInputDevice, shouldRestoreWake, shouldStartWake, utteranceRoute } from './audio';

function utteranceCapture() {
  const host = Object.assign(Object.create(AudioHost.prototype), {
    mode: 'utterance', sensitivity: 50, noiseFloor: 0, speechLevel: 0, speechMs: 0, pauseEstimateMs: 0,
    heardSpeech: false, recording: [], recordingMs: 0, captureElapsedMs: 0, quietMs: 0,
  });
  let finished = false;
  host.finishUtterance = async () => { finished = true; };
  return {
    get finished() { return finished; },
    async feed(milliseconds: number, level: number) {
      for (let elapsed = 0; elapsed < milliseconds && !finished; elapsed += 32) {
        await host.recordUtterance(new Float32Array(512).fill(level), level);
      }
    },
  };
}

test('Bluetooth microphone background hiss ends a spoken request without waiting for the 30-second cap', async () => {
  const capture = utteranceCapture();
  await capture.feed(1600, 0.03);
  await capture.feed(2400, 0.00065);
  expect(capture.finished).toBe(true);
});

test('natural pauses do not submit a command before the speaker finishes', async () => {
  const capture = utteranceCapture();
  await capture.feed(1000, 0.03);
  await capture.feed(800, 0.00065);
  expect(capture.finished).toBe(false);
  await capture.feed(1000, 0.02);
  expect(capture.finished).toBe(false);
  await capture.feed(2400, 0.00065);
  expect(capture.finished).toBe(true);
});

test('automatic microphone follows Windows default rather than newest connected device', () => {
  const devices = [{ kind: 'audioinput', deviceId: 'default' }, { kind: 'audioinput', deviceId: 'vivo-buds' }, { kind: 'audioinput', deviceId: 'webcam' }] as const;
  expect(selectedInputDevice([...devices])).toBeUndefined();
  expect(selectedInputDevice([...devices], '')).toBeUndefined();
  expect(selectedInputDevice([...devices], 'default')).toBeUndefined();
  expect(selectedInputDevice([...devices], 'vivo-buds')).toBe('vivo-buds');
  expect(selectedInputDevice([...devices], 'unplugged-headset')).toBeUndefined();
});

test('captured PCM becomes mono 16 kHz WAV within expected byte bounds', () => {
  const bytes = encodeWav([new Float32Array([-1, 0, 1])]);
  const view = new DataView(bytes.buffer);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
  expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WAVE');
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16_000);
  expect(view.getUint32(40, true)).toBe(6);
  expect(bytes.byteLength).toBe(50);
  expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([-32768, 0, 32767]);
});

test('audio chunks resample from device rate to 16 kHz', () => {
  const source = Float32Array.from({ length: 48 }, (_, index) => index / 48);
  const output = downsample(source, 48_000);
  expect(output).toHaveLength(16);
  expect(output[0]).toBe(0);
  expect(output[15]).toBeCloseTo(45 / 48);
});

test('clipped microphone samples remain valid PCM for the wake model', () => {
  const input = new Float32Array([-1.2, -0.4, NaN, 1.3, Infinity, 0.5]);
  expect([...downsample(input, 16_000)]).toEqual([-1, expect.closeTo(-0.4), 0, 1, 0, 0.5]);
  for (const sample of downsample(input, 48_000)) {
    expect(Number.isFinite(sample)).toBe(true);
    expect(Math.abs(sample)).toBeLessThanOrEqual(1);
  }
});

test('wake preference starts a fresh app but never overrides an explicit stop', () => {
  const snapshot: RuntimeSnapshot = {
    revision: 0, historyRevision: 0, mode: 'assist', activeConversationId: null, task: null, question: null, message: '',
    head: { enabled: true, active: false, phase: 'off', reason: '', sessionId: 0, dwellEnabled: false, dwellReady: false, dwellProgress: 0, cursor: null, calibrationSamples: 0 },
    voice: { sessionId: 1, enabled: false, phase: 'off', reason: '', audioLevel: 0, transcript: '' },
    overlay: { mode: 'hidden', point: null, target: null, targetLabel: '', dwellProgress: 0, cursorEnabled: false, highlightEnabled: false },
    layout: { active: false },
    services: null,
  };
  expect(shouldRestoreWake(null)).toBe(false);
  expect(shouldRestoreWake(snapshot)).toBe(false);
  expect(shouldRestoreWake({ ...snapshot, voice: { ...snapshot.voice, enabled: true, phase: 'wake' } })).toBe(true);
  expect(shouldStartWake(null, true)).toBe(false);
  expect(shouldStartWake(snapshot, true)).toBe(false);
  const fresh = { ...snapshot, voice: { ...snapshot.voice, sessionId: 0 } };
  expect(shouldStartWake(fresh, true)).toBe(true);
  expect(shouldStartWake(fresh, false)).toBe(false);
  expect(shouldStartWake({ ...fresh, voice: { ...fresh.voice, phase: 'error' } }, true)).toBe(false);
});

test('utterance target is pinned only to a question present at capture start', () => {
  const snapshot: RuntimeSnapshot = {
    revision: 2, historyRevision: 0, mode: 'assist', activeConversationId: 'conversation-1', task: null, question: null, message: '',
    head: { enabled: false, active: false, phase: 'off', reason: '', sessionId: 0, dwellEnabled: false, dwellReady: false, dwellProgress: 0, cursor: null, calibrationSamples: 0 },
    voice: { sessionId: 1, enabled: true, phase: 'wake', reason: '', audioLevel: 0, transcript: '' },
    overlay: { mode: 'hidden', point: null, target: null, targetLabel: '', dwellProgress: 0, cursorEnabled: false, highlightEnabled: false },
    layout: { active: false }, services: null,
  };
  const activeTask = { id: 'task-unrelated', conversationId: 'conversation-1', phase: 'working' as const, mode: 'assist' as const, request: 'Export spreadsheet', message: '', verified: false, method: null, targetWindow: null, artifacts: [] };
  expect(utteranceRoute({ ...snapshot, task: activeTask })).toEqual({ voiceSessionId: 1, conversationId: 'conversation-1' });
  expect(utteranceRoute({ ...snapshot, task: activeTask, question: { id: 'question-7', taskId: activeTask.id, kind: 'clarification', title: 'Which sheet?', options: [], allowCustom: true, optional: false } }))
    .toEqual({ voiceSessionId: 1, conversationId: 'conversation-1', taskId: activeTask.id, questionId: 'question-7' });
});
