import { setupSliderFill } from '../ipc';
import { store } from '../store';

export function renderAppearancePage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';

  const settings = store.settings;

  container.innerHTML = `
    <!-- Header -->
    <div class="settings-page-header">
      <div class="header-icon-box">
        <i class="ri-macbook-line"></i>
      </div>
      <div class="header-text-group">
        <h2 class="header-title">Appearance</h2>

      </div>
    </div>

    <!-- Theme & Accent Card -->
    <div class="kaji-card">
      <div class="appearance-theme-grid">
        <!-- Left: Theme Selection -->
        <div>
          <div class="kaji-card-title" >Theme</div>

          <div class="theme-options-row">
            <div class="theme-card ${settings.theme === 'light' ? 'active' : ''}" data-theme="light">
              <div class="theme-preview light"></div>
              <div class="theme-label">Light</div>
            </div>
            <div class="theme-card ${settings.theme === 'dark' ? 'active' : ''}" data-theme="dark">
              <div class="theme-preview dark"></div>
              <div class="theme-label">Dark</div>
            </div>
            <div class="theme-card ${settings.theme === 'system' ? 'active' : ''}" data-theme="system">
              <div class="theme-preview system"></div>
              <div class="theme-label">System</div>
            </div>
          </div>
        </div>

        <!-- Right: Accent Color -->
        <div class="appearance-accent">
          <div class="kaji-card-title" >Accent color</div>

          <div class="swatches-row">
            <div class="swatch-circle swatch-blue ${settings.accent_color === 'blue' ? 'active' : ''}" data-color="blue"></div>
            <div class="swatch-circle swatch-purple ${settings.accent_color === 'purple' ? 'active' : ''}" data-color="purple"></div>
            <div class="swatch-circle swatch-pink ${settings.accent_color === 'pink' ? 'active' : ''}" data-color="pink"></div>
            <div class="swatch-circle swatch-cyan ${settings.accent_color === 'cyan' ? 'active' : ''}" data-color="cyan"></div>
            <div class="swatch-circle swatch-green ${settings.accent_color === 'green' ? 'active' : ''}" data-color="green"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Composer (Control Bar) Card -->
    <div class="kaji-card">
      <div class="kaji-card-title" >Composer (control bar)</div>


      <!-- Position Choices -->
      <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 10px;">
        <span style="font-size: 13.5px; font-weight: 500; min-width: 60px;">Position</span>
        <div class="composer-pos-grid" style="flex: 1;">
          <div class="composer-pos-card ${settings.composer_position === 'top' ? 'active' : ''}" data-pos="top">
            <div class="composer-preview-box">
              <div class="composer-bar-pill top"></div>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="position-radio"></span>

              <span style="font-size: 13px; font-weight: 600;">Top island</span>
            </div>
          </div>

          <div class="composer-pos-card ${settings.composer_position === 'floating' ? 'active' : ''}" data-pos="floating">
            <div class="composer-preview-box">
              <div class="composer-bar-pill floating"></div>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="position-radio"></span>

              <span style="font-size: 13px; font-weight: 600;">Floating window</span>
            </div>
          </div>

          <div class="composer-pos-card ${settings.composer_position === 'taskbar' ? 'active' : ''}" data-pos="taskbar">
            <div class="composer-preview-box">
              <div class="composer-bar-pill taskbar"></div>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="position-radio"></span>

              <span style="font-size: 13px; font-weight: 600;">Taskbar dock</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Size and Opacity Sliders -->
      <div class="appearance-sliders settings-group">
        <div style="display: flex; align-items: center; gap: 12px;">
          <i class="ri-aspect-ratio-line" style="color: var(--kaji-blue); font-size: 18px;"></i>
          <span style="font-size: 13.5px; font-weight: 500; min-width: 40px;">Size</span>
          <div class="kaji-slider-wrap" style="flex: 1;">
            <input type="range" min="50" max="150" value="${settings.composer_size}" class="kaji-slider" id="app-size-slider" aria-label="Composer size" />
            <div class="slider-val-box" id="app-size-val">${settings.composer_size}%</div>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 12px;">
          <i class="ri-drop-line" style="color: var(--kaji-blue); font-size: 18px;"></i>
          <span style="font-size: 13.5px; font-weight: 500; min-width: 50px;">Opacity</span>
          <div class="kaji-slider-wrap" style="flex: 1;">
            <input type="range" min="20" max="100" value="${settings.composer_opacity}" class="kaji-slider" id="app-opacity-slider" aria-label="Composer opacity" />
            <div class="slider-val-box" id="app-opacity-val">${settings.composer_opacity}%</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Overlay & Cursor Card -->
    <div class="kaji-card">
      <div class="kaji-card-title" >Overlay & Cursor</div>


      <!-- Row 1: Action highlight | Cursor effect -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding-bottom: 10px; border-bottom: 1px solid var(--divider);">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-focus-3-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Action highlight</div>

            </div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="app-highlight-toggle" aria-label="Action highlight" ${settings.action_highlight ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-cursor-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Cursor effect</div>

            </div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="app-cursor-toggle" aria-label="Cursor effect" ${settings.cursor_effect ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <!-- Overlay style -->
      <div style="display: flex; align-items: center; justify-content: space-between; padding-top: 10px; gap: 24px;">
        <div style="display: flex; align-items: center; gap: 14px;">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-eye-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Overlay style</div>
            </div>
          </div>
          <div class="segmented-control" id="app-overlay-seg">
            <button class="segmented-btn ${settings.overlay_style === 'subtle' ? 'active' : ''}" data-val="subtle">
              Subtle
            </button>
            <button class="segmented-btn ${settings.overlay_style === 'clear' ? 'active' : ''}" data-val="clear">
              Clear
            </button>
            <button class="segmented-btn ${settings.overlay_style === 'off' ? 'active' : ''}" data-val="off">
              Off
            </button>
          </div>
        </div>


      </div>
    </div>
  `;

  // Attach event handlers
  const themeCards = container.querySelectorAll('.theme-card');
  themeCards.forEach((card) => {
    (card as HTMLElement).onclick = () => {
      const themeVal = card.getAttribute('data-theme') as 'light' | 'dark' | 'system';
      store.setDraftField('theme', themeVal);
      themeCards.forEach((c) => {
        const cVal = c.getAttribute('data-theme');
        c.className = `theme-card ${cVal === themeVal ? 'active' : ''}`;
        const lbl = c.querySelector('.theme-label');
        if (lbl) lbl.textContent = `${cVal?.charAt(0).toUpperCase()}${cVal?.slice(1)}`;
      });
    };
  });

  const swatches = container.querySelectorAll('.swatch-circle');
  swatches.forEach((sw) => {
    (sw as HTMLElement).onclick = () => {
      const col = sw.getAttribute('data-color') as 'blue' | 'purple' | 'pink' | 'cyan' | 'green';
      store.setDraftField('accent_color', col);
      swatches.forEach((s) => {
        const sCol = s.getAttribute('data-color');
        s.className = `swatch-circle swatch-${sCol} ${sCol === col ? 'active' : ''}`;
      });
    };
  });

  const posCards = container.querySelectorAll('.composer-pos-card');
  posCards.forEach((card) => {
    (card as HTMLElement).onclick = () => {
      const posVal = card.getAttribute('data-pos') as 'top' | 'floating' | 'taskbar';
      store.setDraftField('composer_position', posVal);
      posCards.forEach((c) => {
        const cVal = c.getAttribute('data-pos');
        c.className = `composer-pos-card ${cVal === posVal ? 'active' : ''}`;
      });
    };
  });

  const sizeSlider = container.querySelector('#app-size-slider') as HTMLInputElement;
  const sizeVal = container.querySelector('#app-size-val') as HTMLElement;
  setupSliderFill(sizeSlider);
  sizeSlider.oninput = () => {
    const val = parseInt(sizeSlider.value, 10);
    sizeVal.textContent = `${val}%`;
    store.setDraftField('composer_size', val);
  };

  const opacitySlider = container.querySelector('#app-opacity-slider') as HTMLInputElement;
  const opacityVal = container.querySelector('#app-opacity-val') as HTMLElement;
  setupSliderFill(opacitySlider);
  opacitySlider.oninput = () => {
    const val = parseInt(opacitySlider.value, 10);
    opacityVal.textContent = `${val}%`;
    store.setDraftField('composer_opacity', val);
  };

  const highlightToggle = container.querySelector('#app-highlight-toggle') as HTMLInputElement;
  highlightToggle.onchange = () => store.setDraftField('action_highlight', highlightToggle.checked);

  const cursorToggle = container.querySelector('#app-cursor-toggle') as HTMLInputElement;
  cursorToggle.onchange = () => store.setDraftField('cursor_effect', cursorToggle.checked);

  const overlayBtns = container.querySelectorAll('#app-overlay-seg .segmented-btn');
  overlayBtns.forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const val = btn.getAttribute('data-val') as 'subtle' | 'clear' | 'off';
      store.setDraftField('overlay_style', val);
      overlayBtns.forEach((b) => {
        const bVal = b.getAttribute('data-val');
        b.className = `segmented-btn ${bVal === val ? 'active' : ''}`;
        b.textContent = `${bVal?.charAt(0).toUpperCase()}${bVal?.slice(1)}`;
      });
    };
  });

  return container;
}
