import { invoke } from '@tauri-apps/api/core';

export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error';
  currentVersion: string;
  version: string | null;
  downloaded: number;
  total: number | null;
  message: string;
}
export function updateCommand(action: 'status' | 'check' | 'install'): Promise<UpdateStatus> {
  if (!('__TAURI_INTERNALS__' in window)) return Promise.resolve({ phase: 'idle', currentVersion: '0.1.3', version: null, downloaded: 0, total: null, message: '' });
  return invoke<UpdateStatus>(`gui_update_${action}`);
}

export function mountUpdates(container: HTMLElement): () => void {
  const status = container.querySelector<HTMLElement>('[data-update-status]')!;
  const version = container.querySelector<HTMLElement>('[data-app-version]')!;
  const button = container.querySelector<HTMLButtonElement>('[data-update-action]')!;
  let active = true, state: UpdateStatus | undefined;
  const render = (value: UpdateStatus) => {
    if (!active) return;
    state = value;
    version.textContent = `Version ${value.currentVersion} · Windows`;
    status.textContent = value.phase === 'available' ? `Version ${value.version} is ready.`
      : value.phase === 'checking' ? 'Checking for updates…'
      : value.phase === 'current' ? 'You’re up to date.'
      : value.phase === 'downloading' ? (value.total ? `Downloading update… ${Math.floor(value.downloaded / value.total * 100)}%` : 'Downloading update…')
      : value.phase === 'installing' ? 'Installing update. Kaji will restart…'
      : value.phase === 'error' ? value.message : 'Updates are checked automatically on launch.';
    button.textContent = value.phase === 'available' ? 'Install and restart' : 'Check for updates';
    button.disabled = ['checking', 'downloading', 'installing'].includes(value.phase);
  };
  const error = (reason: unknown) => { if (active) { status.textContent = typeof reason === 'string' ? reason : 'Couldn’t check for updates. Try again.'; button.disabled = false; } };
  button.onclick = () => {
    button.disabled = true;
    void updateCommand(state?.phase === 'available' ? 'install' : 'check').then(render, error);
  };
  void updateCommand('status').then(render, error);
  const timer = window.setInterval(() => { void updateCommand('status').then(render, error); }, 1500);
  return () => { active = false; clearInterval(timer); };
}
