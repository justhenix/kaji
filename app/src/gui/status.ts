import type { EngineGuiStatus } from './types';
import type { RuntimeSnapshot } from '../../shared/runtime';

export function statusFromRuntime(runtime: RuntimeSnapshot): EngineGuiStatus {
  const voiceBusy = ['starting', 'listening', 'transcribing', 'speaking', 'error'].includes(runtime.voice.phase);
  const taskPhase = runtime.task?.phase;
  const phase = voiceBusy ? runtime.voice.phase
    : taskPhase && !['complete', 'stopped'].includes(taskPhase) ? taskPhase
    : runtime.voice.enabled && runtime.voice.phase === 'wake' ? 'wake'
    : runtime.head.active ? 'doing' : 'ready';
  return {
    phase,
    reason: voiceBusy ? runtime.voice.reason : runtime.message || runtime.head.reason,
    mode: runtime.mode,
    head_control_active: runtime.head.enabled,
    voice_active: runtime.voice.enabled,
    is_paused: taskPhase === 'paused' || runtime.head.phase === 'paused',
    session_id: runtime.head.sessionId,
  };
}

export function getStatusLabel(status: EngineGuiStatus): string {
  if (status.is_paused) return 'Paused';
  switch (status.phase) {
    case 'offline':
    case 'error':
    case 'disconnected':
      return 'Offline';
    case 'thinking':
    case 'planning':
    case 'starting':
    case 'transcribing':
      return 'Thinking';
    case 'wake':
      return 'Waiting for wake phrase';
    case 'listening':
      return 'Listening…';
    case 'speaking':
      return 'Speaking';
    case 'working':
    case 'verifying':
      return 'Working…';
    case 'awaiting_user':
    case 'awaiting_method':
    case 'awaiting_confirmation':
      return 'Waiting for you';
    case 'doing':
    case 'acting':
    case 'executing':
      return 'Doing';
    case 'paused':
      return 'Paused';
    default:
      return 'Ready';
  }
}
