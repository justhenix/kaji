import { listen } from '@tauri-apps/api/event';
import { fetchShortcutStatus, type ShortcutStatus } from '../ipc';
import { store } from '../store';

export function renderShortcutsPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';
  const settings = store.settings;
  const bindings = [
    ['Show Kaji', settings.shortcut_open_composer],
    ['Start or stop voice input', settings.shortcut_toggle_listening],
    ['Turn Dwell on or off', settings.shortcut_toggle_head_control],
    ['Switch Guide, Assist or Agent', settings.shortcut_switch_mode],
    ['Pause or resume', settings.shortcut_pause_all],
    ['Stop all actions', settings.shortcut_emergency_stop],
  ];
  container.innerHTML = `
    <div class="settings-page-header">
      <div class="header-icon-box"><i class="ri-keyboard-line" aria-hidden="true"></i></div>
      <div class="header-text-group"><h2 class="header-title">Shortcuts</h2></div>
    </div>
    <div class="kaji-card"><div class="settings-row">
      <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-keyboard-line" aria-hidden="true"></i></div><label for="shortcuts-enabled">Keyboard shortcuts</label></div>
      <label class="toggle-switch"><input type="checkbox" id="shortcuts-enabled" ${settings.enable_shortcuts ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div></div>
    <div class="kaji-card"><div class="kaji-card-title">Across Windows</div><div data-shortcut-list></div></div>
    <div class="kaji-card"><div class="settings-row">
      <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-stop-circle-line" aria-hidden="true"></i></div><div><div class="settings-row-label">Emergency stop</div><div class="settings-row-desc">Escape always stops Kaji, even when shortcuts are off.</div></div></div>
      <kbd class="keycap-badge">Esc</kbd>
    </div></div>
    <p class="settings-row-desc" data-shortcut-error role="alert" hidden></p>`;
  const list = container.querySelector<HTMLElement>('[data-shortcut-list]')!;
  for (const [index, [label, keys]] of bindings.entries()) {
    const row = document.createElement('div'); row.className = 'settings-row';
    const info = document.createElement('div'); info.className = 'settings-row-text';
    const name = document.createElement('div'); name.className = 'settings-row-label'; name.textContent = label;
    const status = document.createElement('div'); status.className = 'settings-row-desc'; status.dataset.shortcutStatus = String(index); status.hidden = true;
    const keycap = document.createElement('kbd'); keycap.className = 'keycap-badge'; keycap.textContent = keys;
    info.append(name, status); row.append(info, keycap); list.append(row);
  }
  container.querySelector<HTMLInputElement>('#shortcuts-enabled')!.onchange = event => {
    store.setDraftField('enable_shortcuts', (event.currentTarget as HTMLInputElement).checked);
  };
  let active = true;
  const update = (statuses: ShortcutStatus[] | null) => {
    if (!active || !statuses) return;
    for (const item of statuses) {
      const status = container.querySelector<HTMLElement>(`[data-shortcut-status="${item.id}"]`);
      if (!status) continue;
      status.hidden = item.available;
      status.textContent = item.reason || '';
    }
  };
  void fetchShortcutStatus().then(update).catch(() => {
    if (!active) return;
    const error = container.querySelector<HTMLElement>('[data-shortcut-error]')!;
    error.hidden = false; error.textContent = 'Could not check keyboard shortcuts. Reopen this page to try again.';
  });
  const events = listen<ShortcutStatus[]>('kaji:shortcuts-updated', event => update(event.payload)).catch(() => undefined);
  const observer = new MutationObserver(() => {
    if (!container.isConnected) {
      active = false; void events.then(stop => stop?.()); observer.disconnect();
    }
  });
  observer.observe(document.getElementById('app')!, {childList: true, subtree: true});
  return container;
}
