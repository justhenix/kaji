import { LANGUAGE_OPTIONS } from '../types';
import { store } from '../store';

export function renderAiModelsPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';

  const settings = store.settings;

  container.innerHTML = `
    <!-- Header -->
    <div class="settings-page-header">
      <div class="header-icon-box">
        <i class="ri-stack-line"></i>
      </div>
      <div class="header-text-group">
        <h2 class="header-title">AI & Models</h2>

      </div>
    </div>

    <!-- AI Provider Card -->
    <div class="kaji-card">
      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-icon"><i class="ri-plug-line"></i></div>
          <div class="settings-row-text">
            <div class="settings-row-label">AI provider</div>

          </div>
        </div>
        <div class="segmented-control" id="ai-provider-seg">
          <button class="segmented-btn ${settings.ai_provider === 'cloud' ? 'active' : ''}" data-val="cloud">
            Cloud
          </button>
          <button class="segmented-btn ${settings.ai_provider === 'local' ? 'active' : ''}" data-val="local">
            Local
          </button>
          <button class="segmented-btn ${settings.ai_provider === 'custom' ? 'active' : ''}" data-val="custom">
            Custom
          </button>
        </div>
      </div>
    </div>

    <!-- Model Card -->
    <div class="kaji-card">
      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-icon"><i class="ri-box-3-line"></i></div>
          <div class="settings-row-text">
            <div class="settings-row-label">Model</div>

          </div>
        </div>
        <select class="kaji-select" id="ai-model-select" style="min-width: 240px;">
          <option value="Kaji Pro" ${settings.model === 'Kaji Pro' ? 'selected' : ''}>Kaji Pro (Recommended)</option>
          <option value="Kaji Flash" ${settings.model === 'Kaji Flash' ? 'selected' : ''}>Kaji Flash (Fast)</option>
        </select>
      </div>
    </div>

    <!-- Capabilities Card with 3 Subcards -->
    <div class="kaji-card">
      <div class="kaji-card-title" style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
        <i class="ri-sparkling-line" style="color: var(--kaji-blue); font-size: 18px;"></i>
        <span>Capabilities</span>
      </div>


      <div class="capabilities-grid">
        <!-- Capability 1 -->
        <div class="capability-card ${settings.capabilities_screen ? 'active' : ''}" id="cap-screen-card">
          <div class="capability-top">
            <i class="ri-tv-line capability-icon"></i>
            <label class="toggle-switch">
              <input type="checkbox" id="cap-screen-toggle" ${settings.capabilities_screen ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div>
            <div class="capability-title">Screen understanding</div>

          </div>
        </div>

        <!-- Capability 2 -->
        <div class="capability-card ${settings.capabilities_vision ? 'active' : ''}" id="cap-vision-card">
          <div class="capability-top">
            <i class="ri-image-line capability-icon"></i>
            <label class="toggle-switch">
              <input type="checkbox" id="cap-vision-toggle" ${settings.capabilities_vision ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div>
            <div class="capability-title">Vision (images)</div>

          </div>
        </div>

        <!-- Capability 3 -->
        <div class="capability-card ${settings.capabilities_actions ? 'active' : ''}" id="cap-actions-card">
          <div class="capability-top">
            <i class="ri-stack-line capability-icon"></i>
            <label class="toggle-switch">
              <input type="checkbox" id="cap-actions-toggle" ${settings.capabilities_actions ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div>
            <div class="capability-title">Computer actions</div>

          </div>
        </div>
      </div>
    </div>

    <!-- Response Style Card -->
    <div class="kaji-card">
      <div class="settings-row" style="align-items: flex-start;">
        <div class="settings-row-info">
          <div class="settings-row-icon"><i class="ri-chat-1-line"></i></div>
          <div class="settings-row-text">
            <div class="settings-row-label">Response</div>

          </div>
        </div>

        <div class="response-controls">
          <div style="display: flex; align-items: center; justify-content: flex-end; gap: 14px;">
            <span style="font-size: 13.5px; font-weight: 500;">Response language</span>
            <select class="kaji-select" id="ai-resp-lang-select" style="min-width: 140px;">
              ${LANGUAGE_OPTIONS.map((language) => `<option value="${language}" ${settings.response_language === language ? 'selected' : ''}>${language}</option>`).join('')}
            </select>
          </div>

          <div style="display: flex; align-items: center; justify-content: flex-end; gap: 14px;">
            <span style="font-size: 13.5px; font-weight: 500;">Response style</span>
            <div class="segmented-control" id="ai-resp-style-seg">
              <button class="segmented-btn ${settings.response_style === 'concise' ? 'active' : ''}" data-val="concise">
                Concise
              </button>
              <button class="segmented-btn ${settings.response_style === 'balanced' ? 'active' : ''}" data-val="balanced">
                Balanced
              </button>
              <button class="segmented-btn ${settings.response_style === 'detailed' ? 'active' : ''}" data-val="detailed">
                Detailed
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Attach event handlers
  const providerBtns = container.querySelectorAll('#ai-provider-seg .segmented-btn');
  providerBtns.forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const val = btn.getAttribute('data-val') as 'cloud' | 'local' | 'custom';
      store.setDraftField('ai_provider', val);
      providerBtns.forEach((b) => {
        const bVal = b.getAttribute('data-val');
        b.className = `segmented-btn ${bVal === val ? 'active' : ''}`;
        if (bVal === 'cloud') b.textContent = 'Cloud';
        if (bVal === 'local') b.textContent = 'Local';
        if (bVal === 'custom') b.textContent = 'Custom';
      });
    };
  });

  const modelSelect = container.querySelector('#ai-model-select') as HTMLSelectElement;
  modelSelect.onchange = () => store.setDraftField('model', modelSelect.value);

  const screenToggle = container.querySelector('#cap-screen-toggle') as HTMLInputElement;
  const screenCard = container.querySelector('#cap-screen-card') as HTMLElement;
  screenToggle.onchange = () => {
    store.setDraftField('capabilities_screen', screenToggle.checked);
    screenCard.className = `capability-card ${screenToggle.checked ? 'active' : ''}`;
  };

  const visionToggle = container.querySelector('#cap-vision-toggle') as HTMLInputElement;
  const visionCard = container.querySelector('#cap-vision-card') as HTMLElement;
  visionToggle.onchange = () => {
    store.setDraftField('capabilities_vision', visionToggle.checked);
    visionCard.className = `capability-card ${visionToggle.checked ? 'active' : ''}`;
  };

  const actionsToggle = container.querySelector('#cap-actions-toggle') as HTMLInputElement;
  const actionsCard = container.querySelector('#cap-actions-card') as HTMLElement;
  actionsToggle.onchange = () => {
    store.setDraftField('capabilities_actions', actionsToggle.checked);
    actionsCard.className = `capability-card ${actionsToggle.checked ? 'active' : ''}`;
  };

  const respLangSelect = container.querySelector('#ai-resp-lang-select') as HTMLSelectElement;
  respLangSelect.onchange = () => store.setDraftField('response_language', respLangSelect.value);

  const styleBtns = container.querySelectorAll('#ai-resp-style-seg .segmented-btn');
  styleBtns.forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const val = btn.getAttribute('data-val') as 'concise' | 'balanced' | 'detailed';
      store.setDraftField('response_style', val);
      styleBtns.forEach((b) => {
        const bVal = b.getAttribute('data-val');
        b.className = `segmented-btn ${bVal === val ? 'active' : ''}`;
        b.textContent = `${bVal?.charAt(0).toUpperCase()}${bVal?.slice(1)}`;
      });
    };
  });

  return container;
}
