import { LANGUAGE_OPTIONS } from '../types';
import { store } from '../store';

export function renderGeneralPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';

  const settings = store.settings;

  container.innerHTML = `
    <!-- Header -->
    <div class="settings-page-header">
      <div class="header-icon-box">
        <i class="ri-settings-3-line"></i>
      </div>
      <div class="header-text-group">
        <h2 class="header-title">General</h2>

      </div>
    </div>

    <!-- Language Card -->
    <div class="kaji-card">
      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-icon"><i class="ri-global-line"></i></div>
          <div class="settings-row-text">
            <div class="settings-row-label">Language</div>
          </div>
        </div>
        <select class="kaji-select" id="gen-lang-select">
              ${LANGUAGE_OPTIONS.map((language) => `<option value="${language}" ${settings.language === language ? 'selected' : ''}>${language}</option>`).join('')}
        </select>
      </div>
    </div>

    <!-- Startup & Behavior Group -->
    <div class="kaji-card">
      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-shut-down-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Launch on startup</div>

            </div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="gen-launch-toggle" ${settings.launch_on_startup ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-archive-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Minimize to system tray</div>

            </div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="gen-tray-toggle" ${settings.minimize_to_tray ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-notification-3-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Notifications</div>

            </div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="gen-notif-toggle" ${settings.notifications ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
    </div>

    <!-- At startup open -->
    <div class="kaji-card">
      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-icon"><i class="ri-layout-grid-line"></i></div>
          <div class="settings-row-text">
            <div class="settings-row-label">At startup, open</div>
          </div>
        </div>
        <div class="segmented-control" id="gen-startup-open-seg">
          <button class="segmented-btn ${settings.startup_open === 'composer' ? 'active' : ''}" data-val="composer">
            Composer
          </button>
          <button class="segmented-btn ${settings.startup_open === 'mainWindow' ? 'active' : ''}" data-val="mainWindow">
            Main window
          </button>
        </div>
      </div>
    </div>
  `;

  // Attach event handlers
  const langSelect = container.querySelector('#gen-lang-select') as HTMLSelectElement;
  langSelect.onchange = () => store.setDraftField('language', langSelect.value);

  const launchToggle = container.querySelector('#gen-launch-toggle') as HTMLInputElement;
  launchToggle.onchange = () => store.setDraftField('launch_on_startup', launchToggle.checked);

  const trayToggle = container.querySelector('#gen-tray-toggle') as HTMLInputElement;
  trayToggle.onchange = () => store.setDraftField('minimize_to_tray', trayToggle.checked);

  const notifToggle = container.querySelector('#gen-notif-toggle') as HTMLInputElement;
  notifToggle.onchange = () => store.setDraftField('notifications', notifToggle.checked);

  const startupBtns = container.querySelectorAll('#gen-startup-open-seg .segmented-btn');
  startupBtns.forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const val = btn.getAttribute('data-val') as 'composer' | 'mainWindow';
      store.setDraftField('startup_open', val);
      startupBtns.forEach((b) => {
        const bVal = b.getAttribute('data-val');
        b.className = `segmented-btn ${bVal === val ? 'active' : ''}`;
        b.textContent = bVal === 'composer' ? 'Composer' : 'Main window';
      });
    };
  });

  return container;
}
