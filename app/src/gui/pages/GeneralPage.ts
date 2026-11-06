import { store } from '../store';

export function renderGeneralPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';
  const settings = store.settings;
  container.innerHTML = `
    <div class="settings-page-header">
      <div class="header-icon-box"><i class="ri-settings-3-line" aria-hidden="true"></i></div>
      <div class="header-text-group"><h2 class="header-title">General</h2></div>
    </div>
    <div class="kaji-card"><div class="settings-row">
      <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-window-line" aria-hidden="true"></i></div><label for="gen-startup-select">Open on launch</label></div>
      <select class="kaji-select" id="gen-startup-select">
        <option value="composer" ${settings.startup_open === 'composer' ? 'selected' : ''}>Composer</option>
        <option value="mainWindow" ${settings.startup_open === 'mainWindow' ? 'selected' : ''}>Main window</option>
      </select>
    </div></div>`;
  container.querySelector<HTMLSelectElement>('#gen-startup-select')!.onchange = event => {
    store.setDraftField('startup_open', (event.currentTarget as HTMLSelectElement).value as 'composer' | 'mainWindow');
  };
  return container;
}
