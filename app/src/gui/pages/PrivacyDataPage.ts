import { navigateMain } from '../ipc';
import { store } from '../store';

export function renderPrivacyDataPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';
  const settings = store.settings;
  container.innerHTML = `
    <div class="settings-page-header">
      <div class="header-icon-box"><i class="ri-lock-line" aria-hidden="true"></i></div>
      <div class="header-text-group"><h2 class="header-title">Privacy & Data</h2></div>
    </div>
    <div class="kaji-card">
      <div class="settings-row history-settings-row">
        <div class="settings-row-info">
          <div class="settings-row-icon"><i class="ri-chat-1-line" aria-hidden="true"></i></div>
          <div class="settings-row-text"><div class="settings-row-label">Conversation history</div></div>
        </div>
        <label class="toggle-switch"><input type="checkbox" id="pd-save-hist-toggle" ${settings.save_history ? 'checked' : ''} /><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row history-settings-row">
        <label for="pd-retention-select">Retention</label>
        <select class="kaji-select" id="pd-retention-select">
          <option value="7 days" ${settings.retention === '7 days' ? 'selected' : ''}>7 days</option>
          <option value="30 days" ${settings.retention === '30 days' ? 'selected' : ''}>30 days</option>
          <option value="90 days" ${settings.retention === '90 days' ? 'selected' : ''}>90 days</option>
          <option value="Forever" ${settings.retention === 'Forever' ? 'selected' : ''}>Forever</option>
        </select>
      </div>
      <div class="history-manage-row"><button class="btn-secondary" id="pd-manage-hist-btn" type="button"><i class="ri-history-line" aria-hidden="true"></i> Manage history</button></div>
    </div>
    <div class="kaji-card">
      <div class="kaji-card-title">Screen & data capture</div>
      <div class="settings-row">
        <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-tv-line" aria-hidden="true"></i></div><div class="settings-row-text"><div class="settings-row-label">Allow screen capture</div></div></div>
        <label class="toggle-switch"><input type="checkbox" id="pd-capture-ss-toggle" ${settings.capture_screenshots ? 'checked' : ''} /><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-image-line" aria-hidden="true"></i></div><div class="settings-row-text"><div class="settings-row-label">Allow image understanding</div></div></div>
        <label class="toggle-switch"><input type="checkbox" id="pd-process-img-toggle" ${settings.process_image_content ? 'checked' : ''} /><span class="toggle-slider"></span></label>
      </div>
    </div>`;
  container.querySelector<HTMLInputElement>('#pd-save-hist-toggle')!.onchange = (event) => store.setDraftField('save_history', (event.currentTarget as HTMLInputElement).checked);
  container.querySelector<HTMLSelectElement>('#pd-retention-select')!.onchange = (event) => store.setDraftField('retention', (event.currentTarget as HTMLSelectElement).value);
  container.querySelector<HTMLInputElement>('#pd-capture-ss-toggle')!.onchange = (event) => store.setDraftField('capture_screenshots', (event.currentTarget as HTMLInputElement).checked);
  container.querySelector<HTMLInputElement>('#pd-process-img-toggle')!.onchange = (event) => store.setDraftField('process_image_content', (event.currentTarget as HTMLInputElement).checked);
  container.querySelector<HTMLButtonElement>('#pd-manage-hist-btn')!.onclick = () => { void navigateMain('history.html?view=history'); };
  return container;
}
