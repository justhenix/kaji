import type { RuntimeSnapshot } from '../../shared/runtime';

export function isFreshRuntimeSnapshot(snapshot: RuntimeSnapshot, currentRevision: number): boolean {
  return snapshot.revision > currentRevision;
}

export function dwellFeedback(head: Pick<RuntimeSnapshot['head'], 'enabled' | 'dwellEnabled' | 'dwellReady' | 'phase' | 'reason'>) {
  const manual = head.phase === 'mouse' || head.phase === 'stopped' && /manual takeover|input interrupted camera startup/i.test(head.reason);
  const stoppedByUser = /emergency stop|disabled|by user|cancelled/i.test(head.reason);
  const failed = !manual && !stoppedByUser && head.phase === 'stopped' && /sensor:|camera startup|tracking heartbeat|tracking sample|cursor moved outside/i.test(head.reason);
  if (failed) return { status: 'Retry', hint: 'Dwell is unavailable. Click to retry the camera.', failed: true };
  if (!head.enabled || !head.dwellEnabled) return { status: 'Off', hint: 'Start dwell with head control.', failed: false };
  if (manual) return { status: 'Paused', hint: 'Head control pauses for other input, then resumes after 1.5 seconds idle.', failed: false };
  if (head.phase === 'paused') return { status: 'Paused', hint: 'Actions are paused.', failed: false };
  if (head.phase === 'initializing') return { status: 'Starting', hint: 'Opening the camera. You can keep using your mouse.', failed: false };
  if (head.phase === 'calibrating') return { status: 'Calibrate', hint: 'Face the camera and hold your head still to calibrate.', failed: false };
  if (head.phase === 'no_face') return { status: 'No face', hint: 'Face the camera to resume head control.', failed: false };
  if (head.phase === 'tracking') return head.dwellReady
    ? { status: 'Ready', hint: 'Hold still over a target to click.', failed: false }
    : { status: 'Aim', hint: 'Aim at a button, link or field. Dwell starts only on recognized controls.', failed: false };
  return { status: 'Starting', hint: 'Waiting for head control.', failed: false };
}
