import { showModal } from '../components/Modal';
import { store } from '../store';

export function renderPrivacyDataPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';

  const settings = store.settings;

  container.innerHTML = `
    <!-- Header -->
    <div class="settings-page-header">
      <div class="header-icon-box">
        <i class="ri-lock-line"></i>
      </div>
      <div class="header-text-group">
        <h2 class="header-title">Privacy & Data</h2>

      </div>
    </div>

    <!-- Data Processing Card -->
    <div class="kaji-card">
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-cloud-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Data processing</div>

            </div>
          </div>
          <div class="segmented-control" id="pd-proc-seg">
            <button class="segmented-btn ${settings.data_processing === 'local' ? 'active' : ''}" data-val="local">
              Local (on this device)
            </button>
            <button class="segmented-btn ${settings.data_processing === 'cloud' ? 'active' : ''}" data-val="cloud">
              Cloud (online)
            </button>
          </div>
        </div>

      </div>
    </div>

    <!-- Conversation History Card -->
    <div class="kaji-card">
      <div class="settings-row" style="padding-top: 0; padding-bottom: 8px; border-bottom: 1px solid var(--divider);">
        <div class="settings-row-info">
          <div class="settings-row-icon"><i class="ri-chat-1-line"></i></div>
          <div class="settings-row-text">
            <div class="settings-row-label">Conversation History</div>

          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 13.5px; font-weight: 500;">Save conversation history</span>
          <label class="toggle-switch">
            <input type="checkbox" id="pd-save-hist-toggle" ${settings.save_history ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div style="display: flex; align-items: center; justify-content: flex-end; gap: 14px; padding-top: 8px;">
        <span style="font-size: 13.5px; font-weight: 500;">Retention</span>
        <select class="kaji-select" id="pd-retention-select" style="min-width: 120px;">
          <option value="7 days" ${settings.retention === '7 days' ? 'selected' : ''}>7 days</option>
          <option value="30 days" ${settings.retention === '30 days' ? 'selected' : ''}>30 days</option>
          <option value="90 days" ${settings.retention === '90 days' ? 'selected' : ''}>90 days</option>
          <option value="Forever" ${settings.retention === 'Forever' ? 'selected' : ''}>Forever</option>
        </select>
        <button class="btn-secondary" id="pd-manage-hist-btn" style="color: var(--kaji-blue); border-color: rgba(9, 49, 141, 0.25);">
          <i class="ri-list-check"></i> Manage history...
        </button>
      </div>
    </div>

    <!-- Screen & Data Capture Card -->
    <div class="kaji-card">
      <div class="split-card-grid">
        <div class="split-card-left">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 2px;">
            <i class="ri-fullscreen-line" style="color: var(--kaji-blue); font-size: 18px;"></i>
            <span class="split-card-title">Screen & data capture</span>
          </div>

        </div>

        <div class="split-card-right">
          <div class="settings-group">
            <div class="settings-row" style="padding-top: 0;">
              <div class="settings-row-info">
                <div class="settings-row-icon"><i class="ri-tv-line"></i></div>
                <div class="settings-row-text">
                  <div class="settings-row-label">Capture screenshots (for analysis)</div>
                </div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="pd-capture-ss-toggle" ${settings.capture_screenshots ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="settings-row">
              <div class="settings-row-info">
                <div class="settings-row-icon"><i class="ri-image-line"></i></div>
                <div class="settings-row-text">
                  <div class="settings-row-label">Process image content (OCR, diagrams, etc.)</div>
                </div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="pd-process-img-toggle" ${settings.process_image_content ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="settings-row" style="padding-bottom: 0;">
              <div class="settings-row-info">
                <div class="settings-row-icon"><i class="ri-stack-line"></i></div>
                <div class="settings-row-text">
                  <div class="settings-row-label">Store captured content</div>
                </div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="pd-store-cap-toggle" ${settings.store_captured_content ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Data Management Card -->
    <div class="kaji-card">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div class="settings-row-info">
          <div class="settings-row-icon"><i class="ri-database-2-line"></i></div>
          <div class="settings-row-text">
            <div class="settings-row-label">Data management</div>

          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 12px;">
          <button class="btn-secondary" id="pd-export-btn">
            <i class="ri-download-2-line"></i> Export data...
          </button>
          <button class="btn-danger-outline" id="pd-clear-btn">
            <i class="ri-delete-bin-line"></i> Clear all data...
          </button>
        </div>
      </div>
    </div>

    <!-- Privacy Controls Card -->
    <div class="kaji-card">
      <div class="split-card-grid">
        <div class="split-card-left">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 2px;">
            <i class="ri-shield-check-line" style="color: var(--kaji-blue); font-size: 18px;"></i>
            <span class="split-card-title">Privacy controls</span>
          </div>

        </div>

        <div class="split-card-right">
          <div class="settings-group">
            <div class="settings-row" style="padding-top: 0;">
              <div class="settings-row-info">
                <div class="settings-row-icon"><i class="ri-bar-chart-line"></i></div>
                <div class="settings-row-text">
                  <div class="settings-row-label">Send usage analytics (anonymous)</div>
                </div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="pd-analytics-toggle" ${settings.send_analytics ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="settings-row" style="padding-bottom: 0;">
              <div class="settings-row-info">
                <div class="settings-row-icon"><i class="ri-cloud-line"></i></div>
                <div class="settings-row-text">
                  <div class="settings-row-label">Check for updates automatically</div>
                </div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="pd-updates-toggle" ${settings.check_updates ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Attach event handlers
  const procBtns = container.querySelectorAll('#pd-proc-seg .segmented-btn');
  procBtns.forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const val = btn.getAttribute('data-val') as 'local' | 'cloud';
      store.setDraftField('data_processing', val);
      procBtns.forEach((b) => {
        const bVal = b.getAttribute('data-val');
        b.className = `segmented-btn ${bVal === val ? 'active' : ''}`;
        if (bVal === 'local') b.textContent = 'Local (on this device)';
        if (bVal === 'cloud') b.textContent = 'Cloud (online)';
      });
    };
  });

  const saveHistToggle = container.querySelector('#pd-save-hist-toggle') as HTMLInputElement;
  saveHistToggle.onchange = () => store.setDraftField('save_history', saveHistToggle.checked);

  const retentionSelect = container.querySelector('#pd-retention-select') as HTMLSelectElement;
  retentionSelect.onchange = () => store.setDraftField('retention', retentionSelect.value);

  const captureSsToggle = container.querySelector('#pd-capture-ss-toggle') as HTMLInputElement;
  captureSsToggle.onchange = () => store.setDraftField('capture_screenshots', captureSsToggle.checked);

  const processImgToggle = container.querySelector('#pd-process-img-toggle') as HTMLInputElement;
  processImgToggle.onchange = () => store.setDraftField('process_image_content', processImgToggle.checked);

  const storeCapToggle = container.querySelector('#pd-store-cap-toggle') as HTMLInputElement;
  storeCapToggle.onchange = () => store.setDraftField('store_captured_content', storeCapToggle.checked);

  const analyticsToggle = container.querySelector('#pd-analytics-toggle') as HTMLInputElement;
  analyticsToggle.onchange = () => store.setDraftField('send_analytics', analyticsToggle.checked);

  const updatesToggle = container.querySelector('#pd-updates-toggle') as HTMLInputElement;
  updatesToggle.onchange = () => store.setDraftField('check_updates', updatesToggle.checked);

  const exportBtn = container.querySelector('#pd-export-btn') as HTMLButtonElement;
  exportBtn.onclick = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(store.settings, null, 2));
    const dlAnchor = document.createElement('a');
    dlAnchor.setAttribute('href', dataStr);
    dlAnchor.setAttribute('download', 'kaji-user-settings.json');
    dlAnchor.click();
    dlAnchor.remove();
  };

  const clearBtn = container.querySelector('#pd-clear-btn') as HTMLButtonElement;
  clearBtn.onclick = () => {
    const dialog = document.createElement('div');
    dialog.innerHTML = `
      <p style="font-size: 13.5px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 16px;">
        Are you sure you want to clear all local data? This will reset all conversation transcripts and cached context.
      </p>
      <div style="display: flex; justify-content: flex-end; gap: 10px;">
        <button class="btn-secondary" data-modal-close>Cancel</button>
        <button class="btn-danger-outline" id="confirm-clear-btn">Clear All</button>
      </div>
    `;
    const close = showModal('Clear Local Data', dialog);
    const conf = dialog.querySelector('#confirm-clear-btn') as HTMLButtonElement;
    if (conf) {
      conf.onclick = () => {
        try {
          localStorage.clear();
        } catch {}
        close();
      };
    }
  };

  const manageHistBtn = container.querySelector('#pd-manage-hist-btn') as HTMLButtonElement;
  manageHistBtn.onclick = () => {
    const dialog = document.createElement('div');
    dialog.innerHTML = `
      <p style="font-size: 13.5px; color: var(--text-secondary); margin-bottom: 12px;">
        Local conversation sessions stored on this machine:
      </p>
      <div style="border: 1px solid var(--border-subtle); border-radius: 8px; padding: 14px; background: var(--surface-bg); font-size: 13px; color: var(--text-muted); text-align: center;">
        No active history sessions stored.
      </div>
      <div style="display: flex; justify-content: flex-end; margin-top: 16px;">
        <button class="btn-primary" data-modal-close>Close</button>
      </div>
    `;
    showModal('Conversation History', dialog);
  };

  return container;
}
