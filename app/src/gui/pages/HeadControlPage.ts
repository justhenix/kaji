import { calibrate, setupSliderFill } from '../ipc';
import { store } from '../store';

export function renderHeadControlPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';

  const settings = store.settings;

  container.innerHTML = `
    <!-- Header -->
    <div class="settings-page-header">
      <div class="header-icon-box">
        <i class="ri-cursor-line"></i>
      </div>
      <div class="header-text-group">
        <h2 class="header-title">Head Control</h2>

      </div>
    </div>

    <!-- Enable Head Control Card -->
    <div class="kaji-card">
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-label" style="font-size: 15px;">Enable head control</div>

        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="hc-enable-toggle" ${settings.enable_head_control ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- Camera Selection Card -->
    <div class="kaji-card">
      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-icon"><i class="ri-camera-line"></i></div>
          <div class="settings-row-text">
            <div class="settings-row-label">Camera</div>
          </div>
        </div>
        <select class="kaji-select" id="hc-camera-select" style="min-width: 260px;">
          <option value="Integrated Camera (RGB)" selected>Integrated Camera (RGB)</option>
        </select>
      </div>
    </div>

    <!-- Calibration Card -->
    <div class="kaji-card">
      <div class="calibration-card-inner">
        <!-- Preview Box -->
        <div class="calibration-preview-box">
          <div class="calibration-backdrop"></div>
          <div class="bracket bracket-tl"></div>
          <div class="bracket bracket-tr"></div>
          <div class="bracket bracket-bl"></div>
          <div class="bracket bracket-br"></div>
          <svg class="head-silhouette-svg" viewBox="0 0 100 86" width="96" height="82" fill="none">
            <path d="M14 84 C14 68 28 60 38 58 L40 50 C38 48 37 45 37 40 L37 36 C37 36 36 36 36 33 C36 30 38 30 38 30 C37 20 42 8 50 8 C58 8 63 20 62 30 C62 30 64 30 64 33 C64 36 63 36 63 36 L63 40 C63 45 62 48 60 50 L62 58 C72 60 86 68 86 84" fill="rgba(255, 255, 255, 0.42)" stroke="rgba(255, 255, 255, 0.85)" stroke-width="1.5" />
            <ellipse cx="50" cy="32" rx="14" ry="17" fill="rgba(255, 255, 255, 0.48)" stroke="rgba(255, 255, 255, 0.9)" stroke-width="1.5" />
          </svg>
        </div>

        <!-- Calibration Controls -->
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <div style="font-family: var(--font-heading); font-weight: 700; font-size: 16px; color: var(--text-primary);">Calibration</div>

          <div style="margin-top: 4px;">
            <button class="btn-secondary" id="hc-calibrate-btn" style="background: var(--kaji-blue-light); border-color: rgba(9, 49, 141, 0.2); color: var(--kaji-blue); font-weight: 600; padding: 10px 24px;">
              <i class="ri-crosshair-2-line"></i> Calibrate
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Motion & Dwell Parameters Card -->
    <div class="kaji-card">
      <div class="settings-group">
        <!-- Row 1: Sensitivity -->
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-pulse-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Sensitivity</div>
            </div>
          </div>
          <div class="kaji-slider-wrap">
            <input type="range" min="10" max="100" value="${settings.sensitivity}" class="kaji-slider" id="hc-sens-slider" />
            <div class="slider-val-box" id="hc-sens-val">${settings.sensitivity}%</div>
          </div>
        </div>

        <!-- Row 2: Dwell time -->
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-time-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Dwell time</div>

            </div>
          </div>
          <div class="kaji-slider-wrap">
            <input type="range" min="5" max="30" value="${Math.round(settings.dwell_time * 10)}" class="kaji-slider" id="hc-dwell-slider" />
            <select class="kaji-select" id="hc-dwell-select">
              <option value="0.5" ${settings.dwell_time === 0.5 ? 'selected' : ''}>0.5 s</option>
              <option value="0.8" ${settings.dwell_time === 0.8 ? 'selected' : ''}>0.8 s</option>
              <option value="1.0" ${settings.dwell_time === 1.0 ? 'selected' : ''}>1.0 s</option>
              <option value="1.2" ${settings.dwell_time === 1.2 ? 'selected' : ''}>1.2 s</option>
              <option value="1.5" ${settings.dwell_time === 1.5 ? 'selected' : ''}>1.5 s</option>
              <option value="2.0" ${settings.dwell_time === 2.0 ? 'selected' : ''}>2.0 s</option>
              <option value="3.0" ${settings.dwell_time === 3.0 ? 'selected' : ''}>3.0 s</option>
            </select>
          </div>
        </div>

        <!-- Row 3: Click behavior -->
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-icon"><i class="ri-mouse-line"></i></div>
            <div class="settings-row-text">
              <div class="settings-row-label">Click behavior</div>
            </div>
          </div>
          <div class="segmented-control" id="hc-click-seg">
            <button class="segmented-btn ${settings.click_behavior === 'dwell' ? 'active' : ''}" data-val="dwell">
              Dwell to click
            </button>
            <button class="segmented-btn ${settings.click_behavior === 'hold' ? 'active' : ''}" data-val="hold">
              Hold to click
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Detect camera hardware if available
  if (navigator.mediaDevices?.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const cameraSelect = container.querySelector('#hc-camera-select') as HTMLSelectElement;
      const videoInputs = devices.filter((d) => d.kind === 'videoinput' && d.label);
      if (cameraSelect && videoInputs.length > 0) {
        cameraSelect.innerHTML = videoInputs
          .map((d) => `<option value="${d.label}" ${d.label === settings.camera ? 'selected' : ''}>${d.label}</option>`)
          .join('');
      }
    }).catch(() => {});
  }

  // Hook up event handlers
  const enableToggle = container.querySelector('#hc-enable-toggle') as HTMLInputElement;
  enableToggle.onchange = () => store.setDraftField('enable_head_control', enableToggle.checked);

  const cameraSelect = container.querySelector('#hc-camera-select') as HTMLSelectElement;
  cameraSelect.onchange = () => store.setDraftField('camera', cameraSelect.value);

  const sensSlider = container.querySelector('#hc-sens-slider') as HTMLInputElement;
  const sensVal = container.querySelector('#hc-sens-val') as HTMLElement;
  setupSliderFill(sensSlider);
  sensSlider.oninput = () => {
    const val = parseInt(sensSlider.value, 10);
    sensVal.textContent = `${val}%`;
    store.setDraftField('sensitivity', val);
  };

  const dwellSlider = container.querySelector('#hc-dwell-slider') as HTMLInputElement;
  const dwellSelect = container.querySelector('#hc-dwell-select') as HTMLSelectElement;
  setupSliderFill(dwellSlider);
  dwellSlider.oninput = () => {
    const val = parseFloat((parseInt(dwellSlider.value, 10) / 10).toFixed(1));
    store.setDraftField('dwell_time', val);
    let matched = false;
    for (let i = 0; i < dwellSelect.options.length; i++) {
      if (parseFloat(dwellSelect.options[i].value) === val) {
        dwellSelect.selectedIndex = i;
        matched = true;
        break;
      }
    }
    if (!matched) {
      dwellSelect.add(new Option(`${val} s`, String(val), false, true));
    }
    dwellSelect.dispatchEvent(new Event('value-updated'));
  };

  dwellSelect.onchange = () => {
    const val = parseFloat(dwellSelect.value);
    dwellSlider.value = String(Math.round(val * 10));
    dwellSlider.dispatchEvent(new Event('input'));
    store.setDraftField('dwell_time', val);
  };

  const clickBtns = container.querySelectorAll('#hc-click-seg .segmented-btn');
  clickBtns.forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const val = btn.getAttribute('data-val') as 'dwell' | 'hold';
      store.setDraftField('click_behavior', val);
      clickBtns.forEach((b) => {
        const bVal = b.getAttribute('data-val');
        b.className = `segmented-btn ${bVal === val ? 'active' : ''}`;
        b.textContent = bVal === 'dwell' ? 'Dwell to click' : 'Hold to click';
      });
    };
  });

  const calibrateBtn = container.querySelector('#hc-calibrate-btn') as HTMLButtonElement;
  calibrateBtn.onclick = async () => {
    calibrateBtn.innerHTML = `<i class="ri-loader-4-line"></i> Calibrating...`;
    calibrateBtn.disabled = true;
    try {
      await calibrate();
    } catch {}
    setTimeout(() => {
      calibrateBtn.innerHTML = `<i class="ri-check-line"></i> Calibrated`;
      setTimeout(() => {
        calibrateBtn.innerHTML = `<i class="ri-crosshair-2-line"></i> Calibrate`;
        calibrateBtn.disabled = false;
      }, 1500);
    }, 1200);
  };

  return container;
}
