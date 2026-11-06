import { store } from '../store';

export function renderPermissionsSafetyPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';
  const settings = store.settings;
  container.innerHTML = `
    <div class="settings-page-header">
      <div class="header-icon-box"><i class="ri-shield-line" aria-hidden="true"></i></div>
      <div class="header-text-group"><h2 class="header-title">Permissions & Safety</h2></div>
    </div>
    <div class="kaji-card">
      <div class="kaji-card-title">Access permissions</div>
      <div class="settings-row">
        <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-tv-line" aria-hidden="true"></i></div><div class="settings-row-text"><div class="settings-row-label">Screen access</div></div></div>
        <label class="toggle-switch"><input type="checkbox" id="ps-screen-toggle" ${settings.permission_screen ? 'checked' : ''} /><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-cursor-line" aria-hidden="true"></i></div><div class="settings-row-text"><div class="settings-row-label">Control mouse & keyboard</div></div></div>
        <label class="toggle-switch"><input type="checkbox" id="ps-input-toggle" ${settings.permission_input ? 'checked' : ''} /><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-window-line" aria-hidden="true"></i></div><div class="settings-row-text"><div class="settings-row-label">App integration</div></div></div>
        <label class="toggle-switch"><input type="checkbox" id="ps-apps-toggle" ${settings.permission_apps ? 'checked' : ''} /><span class="toggle-slider"></span></label>
      </div>
    </div>
    <div class="kaji-card">
      <div class="settings-row">
        <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-stop-circle-line" aria-hidden="true"></i></div><div class="settings-row-text"><div class="settings-row-label">Emergency stop</div></div></div>
        <div class="settings-row-actions"><div class="keycap-badge"><span class="keycap-item">Escape</span></div></div>
      </div>
      <p class="safety-note">Escape stops the current task.</p>
    </div>`;
  for (const [selector, key] of [
    ['#ps-screen-toggle', 'permission_screen'],
    ['#ps-input-toggle', 'permission_input'],
    ['#ps-apps-toggle', 'permission_apps'],
  ] as const) {
    container.querySelector<HTMLInputElement>(selector)!.onchange = (event) => {
      store.setDraftField(key, (event.currentTarget as HTMLInputElement).checked);
    };
  }
  return container;
}
