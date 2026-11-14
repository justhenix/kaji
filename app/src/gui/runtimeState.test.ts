import { expect, test } from 'bun:test';
import type { RuntimeSnapshot } from '../../shared/runtime';
import { dwellFeedback, isFreshRuntimeSnapshot } from './runtimeState';
import { getStatusLabel, statusFromRuntime } from './status';

const snapshot = (revision: number): RuntimeSnapshot => ({
  revision, historyRevision: 0, mode: 'assist', activeConversationId: null, task: null, question: null, message: '',
  head: { enabled: false, active: false, phase: 'off', reason: '', sessionId: 0, dwellEnabled: false, dwellReady: false, dwellProgress: 0, cursor: null, calibrationSamples: 0 },
  voice: { sessionId: 1, enabled: false, phase: 'off', reason: '', audioLevel: 0, transcript: '' },
  overlay: { mode: 'hidden', point: null, target: null, targetLabel: '', dwellProgress: 0, cursorEnabled: false, highlightEnabled: false },
  layout: { active: false },
  services: null,
});

test('late snapshot cannot roll runtime state back', () => {
  expect(isFreshRuntimeSnapshot(snapshot(8), 9)).toBe(false);
  expect(isFreshRuntimeSnapshot(snapshot(9), 9)).toBe(false);
  expect(isFreshRuntimeSnapshot(snapshot(10), 9)).toBe(true);
});

test('main status follows live voice phases after finished tasks', () => {
  const state = snapshot(1);
  for (const [phase, label] of [['wake', 'Waiting for wake phrase'], ['listening', 'Listening…'], ['transcribing', 'Thinking'], ['speaking', 'Speaking']] as const) {
    const runtime = { ...state, voice: { ...state.voice, enabled: true, phase }, task: { phase: 'complete' } } as RuntimeSnapshot;
    expect(getStatusLabel(statusFromRuntime(runtime))).toBe(label);
  }
  for (const [phase, label] of [['planning', 'Thinking'], ['working', 'Working…'], ['verifying', 'Working…']] as const) {
    const runtime = { ...state, task: { phase } } as RuntimeSnapshot;
    expect(getStatusLabel(statusFromRuntime(runtime))).toBe(label);
  }
});

test('dwell shows the actual readiness step and treats other input as a pause', () => {
  const head = {...snapshot(1).head,enabled:true,dwellEnabled:true};
  for (const [phase, status] of [['initializing','Starting'],['calibrating','Calibrate'],['no_face','No face'],['tracking','Aim'],['mouse','Paused']]) {
    expect(dwellFeedback({...head,phase:phase!})).toMatchObject({status,failed:false});
  }
  expect(dwellFeedback({...head,phase:'tracking',dwellReady:true})).toMatchObject({status:'Ready',failed:false});
  expect(dwellFeedback({...head,enabled:false,dwellEnabled:false,phase:'stopped',reason:'Head control is off'}).status).toBe('Off');
  expect(dwellFeedback({...head,enabled:false,phase:'stopped',reason:'sensor: Mouse or keyboard input interrupted camera startup.'})).toMatchObject({status:'Off',failed:false});
  expect(dwellFeedback({...head,dwellEnabled:false,phase:'mouse'})).toMatchObject({status:'Off',failed:false});
  expect(dwellFeedback({...head,enabled:false,phase:'stopped',reason:'sensor: Camera startup timed out.'})).toMatchObject({status:'Retry',failed:true});
  expect(dwellFeedback({...head,enabled:false,phase:'stopped',reason:'sensor: Emergency stop interrupted camera startup.'})).toMatchObject({status:'Off',failed:false});
});
