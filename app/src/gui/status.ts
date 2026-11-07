import type { EngineGuiStatus } from './types';

export function getStatusLabel(status: EngineGuiStatus): string {
  if (status.is_paused) return 'Paused';
  switch (status.phase) {
    case 'offline':
    case 'error':
    case 'disconnected':
      return 'Offline';
    case 'thinking':
    case 'planning':
      return 'Thinking';
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
