import { showModal, showShortcutRecorderModal } from '../components/Modal';
import { setupSliderFill } from '../ipc';
import { store } from '../store';

export function renderPermissionsSafetyPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';

  const settings = store.settings;

  container.innerHTML = `
    <!-- Header -->
    <div class="settings-page-header">
      <div class="header-icon-box">
        <i class="ri-shield-line"></i>
      </div>
      <div class="header-text-group">
        <h2 class="header-title">Permissions & Safety</h2>

      </div>
    </div>

    <!-- Access Permissions Card -->
    <div class="kaji-card">
      <div class="split-card-grid">
        <div class="split-card-left">
          <div><i class="ri-shield-check-line"></i><span class="split-card-title">Access permissions</span></div>

        </div>

        <div class="split-card-right">
          <div class="settings-group">
            <div class="settings-row" style="padding-top: 0;">
              <div class="settings-row-info">
                <div class="settings-row-icon"><i class="ri-tv-line"></i></div>
                <div class="settings-row-text">
                  <div class="settings-row-label">Screen access</div>

                </div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="ps-screen-toggle" ${settings.permission_screen ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="settings-row">
              <div class="settings-row-info">
                <div class="settings-row-icon"><i class="ri-cursor-line"></i></div>
                <div class="settings-row-text">
                  <div class="settings-row-label">Control mouse & keyboard</div>

                </div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="ps-input-toggle" ${settings.permission_input ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="settings-row" style="padding-bottom: 0;">
              <div class="settings-row-info">
                <div class="settings-row-icon"><i class="ri-window-line"></i></div>
                <div class="settings-row-text">
                  <div class="settings-row-label">App integration</div>

                </div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="ps-apps-toggle" ${settings.permission_apps ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Action Safety Card -->
    <div class="kaji-card">
      <div class="split-card-grid">
        <div class="split-card-left">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 2px;">
            <i class="ri-alert-line" style="color: var(--kaji-blue); font-size: 18px;"></i>
            <span class="split-card-title">Action safety</span>
          </div>

        </div>

        <div class="split-card-right" style="gap: 16px;">
          <!-- Row 1: Confirmation policy -->
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
            <span style="font-size: 13.5px; font-weight: 500;">Confirmation policy</span>
            <div class="segmented-control" id="ps-conf-policy-seg">
              <button class="segmented-btn ${settings.confirmation_policy === 'full_access' ? 'active' : ''}" data-val="full_access">
                Full access
              </button>
              <button class="segmented-btn ${settings.confirmation_policy === 'auto_review' ? 'active' : ''}" data-val="auto_review">
                Auto Review
              </button>
            </div>
          </div>

          <!-- Row 2: Agent autonomy -->
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 13.5px; font-weight: 500;">Agent autonomy</span>
              <i class="ri-information-line" style="color: var(--text-muted); font-size: 14px;" title="Controls how autonomously agent mode executes multiple steps without waiting for confirmation."></i>
            </div>
            <div class="kaji-slider-wrap">
              <input type="range" min="0" max="100" value="${settings.agent_autonomy}" class="kaji-slider" id="ps-autonomy-slider" />
              <div class="slider-val-box" id="ps-autonomy-val">${getAutonomyLabel(settings.agent_autonomy)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Safety Controls Card -->
    <div class="kaji-card">
      <div class="split-card-grid">
        <div class="split-card-left">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 2px;">
            <i class="ri-flashlight-line" style="color: var(--kaji-blue); font-size: 18px;"></i>
            <span class="split-card-title">Safety controls</span>
          </div>

        </div>

        <div class="split-card-right">
          <div class="settings-group">
            <!-- Row 1: Emergency stop -->
            <div class="settings-row" style="padding-top: 0;">
              <div class="settings-row-info">
                <div style="padding: 3px 6px; background: var(--surface-hover); border-radius: 4px; font-size: 11px; font-weight: 600; color: var(--text-secondary);">Esc</div>
                <div class="settings-row-text">
                  <div class="settings-row-label">Emergency stop</div>

                </div>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <div class="keycap-badge" id="ps-esc-badge">${formatKeycaps(settings.emergency_stop_shortcut)}</div>
                <button class="btn-icon" id="ps-edit-estop-btn" title="Edit emergency stop shortcut"><i class="ri-pencil-line"></i></button>
              </div>
            </div>

            <!-- Row 2: Pause on lock -->
            <div class="settings-row">
              <div class="settings-row-info">
                <div class="settings-row-icon"><i class="ri-pause-line"></i></div>
                <div class="settings-row-text">
                  <div class="settings-row-label">Pause on lock / fullscreen</div>

                </div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="ps-lock-toggle" ${settings.pause_on_lock_fullscreen ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>

            <!-- Row 3: Limit to allowed apps -->
            <div class="settings-row" style="padding-bottom: 0;">
              <div class="settings-row-info">
                <div class="settings-row-icon"><i class="ri-tv-line"></i></div>
                <div class="settings-row-text">
                  <div class="settings-row-label">Limit to allowed apps</div>

                </div>
              </div>
              <button class="btn-secondary" id="ps-manage-apps-btn">Manage apps...</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  function getAutonomyLabel(val: number): string {
    if (val < 33) return 'Low';
    if (val < 67) return 'Medium';
    return 'High';
  }

  function formatKeycaps(str: string): string {
    return str
      .split(' + ')
      .map((k) => `<span class="keycap-item">${k}</span>`)
      .join('<span class="keycap-plus">+</span>');
  }

  // Hook up event handlers
  const screenToggle = container.querySelector('#ps-screen-toggle') as HTMLInputElement;
  screenToggle.onchange = () => store.setDraftField('permission_screen', screenToggle.checked);

  const inputToggle = container.querySelector('#ps-input-toggle') as HTMLInputElement;
  inputToggle.onchange = () => store.setDraftField('permission_input', inputToggle.checked);

  const appsToggle = container.querySelector('#ps-apps-toggle') as HTMLInputElement;
  appsToggle.onchange = () => store.setDraftField('permission_apps', appsToggle.checked);

  const lockToggle = container.querySelector('#ps-lock-toggle') as HTMLInputElement;
  lockToggle.onchange = () => store.setDraftField('pause_on_lock_fullscreen', lockToggle.checked);

  const confBtns = container.querySelectorAll('#ps-conf-policy-seg .segmented-btn');
  confBtns.forEach((btn) => {
    (btn as HTMLButtonElement).onclick = async () => {
      const val = btn.getAttribute('data-val') as 'full_access' | 'auto_review';
      store.setDraftField('confirmation_policy', val);
      await store.saveDraft();
      confBtns.forEach((b) => {
        const bVal = b.getAttribute('data-val');
        b.className = `segmented-btn ${bVal === val ? 'active' : ''}`;
      });
    };
  });

  const autonomySlider = container.querySelector('#ps-autonomy-slider') as HTMLInputElement;
  const autonomyVal = container.querySelector('#ps-autonomy-val') as HTMLElement;
  setupSliderFill(autonomySlider);
  autonomySlider.oninput = () => {
    const val = parseInt(autonomySlider.value, 10);
    autonomyVal.textContent = getAutonomyLabel(val);
    store.setDraftField('agent_autonomy', val);
  };

  const editEstopBtn = container.querySelector('#ps-edit-estop-btn') as HTMLButtonElement;
  editEstopBtn.onclick = () => {
    showShortcutRecorderModal(
      'Emergency Stop',
      store.settings.emergency_stop_shortcut,
      {
        'Open composer': store.settings.shortcut_open_composer,
        'Start / stop listening': store.settings.shortcut_toggle_listening,
        'Toggle head control': store.settings.shortcut_toggle_head_control,
        'Switch mode': store.settings.shortcut_switch_mode,
        'Pause all actions': store.settings.shortcut_pause_all,
      },
      (newSc) => {
        store.setDraftField('emergency_stop_shortcut', newSc);
        store.setDraftField('shortcut_emergency_stop', newSc);
        const badge = container.querySelector('#ps-esc-badge');
        if (badge) badge.innerHTML = formatKeycaps(newSc);
      }
    );
  };

  const manageAppsBtn = container.querySelector('#ps-manage-apps-btn') as HTMLButtonElement;
  manageAppsBtn.onclick = () => {
    const dialogContent = document.createElement('div');
    dialogContent.innerHTML = `
      <p style="font-size: 13.5px; color: var(--text-secondary); margin-bottom: 12px;">
        When "Limit to allowed apps" is enabled, Kaji will only inspect and interact with the selected applications.
      </p>
      <div style="border: 1px solid var(--border-subtle); border-radius: 8px; max-height: 200px; overflow-y: auto;">
        <label style="display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--divider);">
          <input type="checkbox" checked /> <span>Google Chrome</span>
        </label>
        <label style="display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--divider);">
          <input type="checkbox" checked /> <span>Microsoft Edge</span>
        </label>
        <label style="display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--divider);">
          <input type="checkbox" checked /> <span>Visual Studio Code</span>
        </label>
        <label style="display: flex; align-items: center; gap: 10px; padding: 10px 14px;">
          <input type="checkbox" checked /> <span>Notepad</span>
        </label>
      </div>
      <div style="display: flex; justify-content: flex-end; margin-top: 16px;">
        <button class="btn-primary" data-modal-close>Done</button>
      </div>
    `;
    showModal('Manage Allowed Apps', dialogContent);
  };

  return container;
}
