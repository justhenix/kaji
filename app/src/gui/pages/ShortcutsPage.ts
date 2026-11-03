import { showShortcutRecorderModal } from '../components/Modal';
import { store } from '../store';

export function renderShortcutsPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';

  const settings = store.settings;

  function formatKeycaps(str: string): string {
    return str
      .split(' + ')
      .map((k) => `<span class="keycap-item">${k}</span>`)
      .join('<span class="keycap-plus">+</span>');
  }

  container.innerHTML = `
    <!-- Header -->
    <div class="settings-page-header">
      <div class="header-icon-box">
        <i class="ri-keyboard-line"></i>
      </div>
      <div class="header-text-group">
        <h2 class="header-title">Shortcuts</h2>

      </div>
    </div>

    <!-- Enable Shortcuts Card -->
    <div class="kaji-card">
      <div class="settings-row" style="padding: 2px 0;">
        <div style="display: flex; align-items: center; gap: 14px;">
          <label class="toggle-switch">
            <input type="checkbox" id="sc-enable-toggle" ${settings.enable_shortcuts ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
          <div class="settings-row-text">
            <div class="settings-row-label">Enable keyboard shortcuts</div>

          </div>
        </div>
      </div>
    </div>

    <!-- Shortcuts List Card -->
    <div class="kaji-card" id="shortcuts-list-card" style="opacity: ${settings.enable_shortcuts ? '1' : '0.5'};">
      <div class="settings-group">
        <!-- 1. Open composer -->
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-sparkling-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Open composer</div>

            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="keycap-badge" id="badge-composer">${formatKeycaps(settings.shortcut_open_composer)}</div>
            <button class="btn-icon" data-sc="composer" title="Edit shortcut"><i class="ri-pencil-line"></i></button>
          </div>
        </div>

        <!-- 2. Start / stop listening -->
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-mic-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Start / stop listening</div>

            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="keycap-badge" id="badge-listening">${formatKeycaps(settings.shortcut_toggle_listening)}</div>
            <button class="btn-icon" data-sc="listening" title="Edit shortcut"><i class="ri-pencil-line"></i></button>
          </div>
        </div>

        <!-- 3. Toggle head control -->
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-cursor-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Toggle head control</div>

            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="keycap-badge" id="badge-head">${formatKeycaps(settings.shortcut_toggle_head_control)}</div>
            <button class="btn-icon" data-sc="head" title="Edit shortcut"><i class="ri-pencil-line"></i></button>
          </div>
        </div>

        <!-- 4. Switch mode -->
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-refresh-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Switch mode</div>

            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="keycap-badge" id="badge-mode">${formatKeycaps(settings.shortcut_switch_mode)}</div>
            <button class="btn-icon" data-sc="mode" title="Edit shortcut"><i class="ri-pencil-line"></i></button>
          </div>
        </div>

        <!-- 5. Pause all actions -->
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-pause-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Pause all actions</div>

            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="keycap-badge" id="badge-pause">${formatKeycaps(settings.shortcut_pause_all)}</div>
            <button class="btn-icon" data-sc="pause" title="Edit shortcut"><i class="ri-pencil-line"></i></button>
          </div>
        </div>

        <!-- 6. Emergency stop -->
        <div class="settings-row" style="padding-bottom: 0;">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-stop-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Emergency stop</div>

            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="keycap-badge" id="badge-estop">${formatKeycaps(settings.shortcut_emergency_stop)}</div>
            <button class="btn-icon" data-sc="estop" title="Edit shortcut"><i class="ri-pencil-line"></i></button>
          </div>
        </div>
      </div>
    </div>

    <!-- Sub-footer row -->
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 0 4px;">
      <button class="btn-secondary" id="sc-reset-defaults-btn">
        <i class="ri-restart-line"></i> Reset to default
      </button>

    </div>
  `;

  // Attach event handlers
  const enableToggle = container.querySelector('#sc-enable-toggle') as HTMLInputElement;
  const listCard = container.querySelector('#shortcuts-list-card') as HTMLElement;
  enableToggle.onchange = () => {
    store.setDraftField('enable_shortcuts', enableToggle.checked);
    listCard.style.opacity = enableToggle.checked ? '1' : '0.5';
  };

  const editBtns = container.querySelectorAll('.btn-icon[data-sc]');
  editBtns.forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const type = btn.getAttribute('data-sc');
      let name = '';
      let current = '';
      let field: keyof typeof settings = 'shortcut_open_composer';

      if (type === 'composer') {
        name = 'Open composer';
        current = store.settings.shortcut_open_composer;
        field = 'shortcut_open_composer';
      } else if (type === 'listening') {
        name = 'Start / stop listening';
        current = store.settings.shortcut_toggle_listening;
        field = 'shortcut_toggle_listening';
      } else if (type === 'head') {
        name = 'Toggle head control';
        current = store.settings.shortcut_toggle_head_control;
        field = 'shortcut_toggle_head_control';
      } else if (type === 'mode') {
        name = 'Switch mode';
        current = store.settings.shortcut_switch_mode;
        field = 'shortcut_switch_mode';
      } else if (type === 'pause') {
        name = 'Pause all actions';
        current = store.settings.shortcut_pause_all;
        field = 'shortcut_pause_all';
      } else if (type === 'estop') {
        name = 'Emergency stop';
        current = store.settings.shortcut_emergency_stop;
        field = 'shortcut_emergency_stop';
      }

      const existing: Record<string, string> = {
        'Open composer': store.settings.shortcut_open_composer,
        'Start / stop listening': store.settings.shortcut_toggle_listening,
        'Toggle head control': store.settings.shortcut_toggle_head_control,
        'Switch mode': store.settings.shortcut_switch_mode,
        'Pause all actions': store.settings.shortcut_pause_all,
        'Emergency stop': store.settings.shortcut_emergency_stop,
      };

      showShortcutRecorderModal(name, current, existing, (newSc) => {
        store.setDraftField(field, newSc as any);
        if (field === 'shortcut_emergency_stop') {
          store.setDraftField('emergency_stop_shortcut', newSc);
        }
        const badge = container.querySelector(`#badge-${type}`);
        if (badge) badge.innerHTML = formatKeycaps(newSc);
      });
    };
  });

  const resetBtn = container.querySelector('#sc-reset-defaults-btn') as HTMLButtonElement;
  resetBtn.onclick = () => {
    store.setDraftField('shortcut_open_composer', 'Ctrl + Alt + Space');
    store.setDraftField('shortcut_toggle_listening', 'Ctrl + Alt + L');
    store.setDraftField('shortcut_toggle_head_control', 'Ctrl + Alt + H');
    store.setDraftField('shortcut_switch_mode', 'Ctrl + Alt + M');
    store.setDraftField('shortcut_pause_all', 'Ctrl + Alt + P');
    store.setDraftField('shortcut_emergency_stop', 'Ctrl + Alt + Esc');
    store.setDraftField('emergency_stop_shortcut', 'Ctrl + Alt + Esc');

    const bComp = container.querySelector('#badge-composer');
    if (bComp) bComp.innerHTML = formatKeycaps('Ctrl + Alt + Space');
    const bList = container.querySelector('#badge-listening');
    if (bList) bList.innerHTML = formatKeycaps('Ctrl + Alt + L');
    const bHead = container.querySelector('#badge-head');
    if (bHead) bHead.innerHTML = formatKeycaps('Ctrl + Alt + H');
    const bMode = container.querySelector('#badge-mode');
    if (bMode) bMode.innerHTML = formatKeycaps('Ctrl + Alt + M');
    const bPause = container.querySelector('#badge-pause');
    if (bPause) bPause.innerHTML = formatKeycaps('Ctrl + Alt + P');
    const bEstop = container.querySelector('#badge-estop');
    if (bEstop) bEstop.innerHTML = formatKeycaps('Ctrl + Alt + Esc');
  };

  return container;
}
