import { createDitherAccents } from './components/DitherAccent';
import { prepareControls } from './components/Controls';
import { showAboutModal } from './components/Modal';
import { createTitleBar } from './components/TitleBar';
import { navigateMain, openComposer, openSettingsWindow, pauseAll, setMode, toggleHeadControl, toggleVoice } from './ipc';
import { store } from './store';
import { getStatusLabel } from './status';

const ADAPTIVE_MESSAGES = [
  'Tedious? I got you.',
  'Learn something new?',
  'Just say, will do.',
  'Help you anytime.',
  "What's the mood?",
];

export async function initMainApp(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;

  await store.init();

  store.subscribe(() => {
    updateDynamicElements();
  });

  renderMainApp();
}

function renderMainApp(): void {
  const root = document.getElementById('app')!;
  root.innerHTML = '';

  const shell = document.createElement('div');
  shell.className = 'window-shell';

  // Corner Dither Background Accents
  shell.appendChild(createDitherAccents());

  // Window Titlebar
  shell.appendChild(
    createTitleBar({
      windowLabel: 'main',
      title: 'Kaji',
      showVersion: true,
    })
  );

  // Main Container
  const container = document.createElement('main');
  container.className = 'main-container';

  const settings = store.settings;
  const status = store.status;

  const hour = new Date().getHours();
  const adaptiveIndex = Math.floor(hour / 5) % ADAPTIVE_MESSAGES.length;
  const currentAdaptive = ADAPTIVE_MESSAGES[adaptiveIndex];

  container.innerHTML = `
    <!-- Hero / Status Header -->
    <div class="main-hero">
      <div class="hero-title-group">
        <h1 class="hero-title" id="adaptive-msg-text">${currentAdaptive}</h1>
      </div>
      <span class="hero-status-chip" id="hero-status-chip" role="status">${getStatusLabel(status)}</span>
    </div>

    <!-- 2-Column Grid -->
    <div class="main-grid">
      <!-- Left Column -->
      <div class="main-col">
        <!-- Mode Card -->
        <div class="kaji-card">
          <div class="kaji-card-title">Mode</div>
          <div class="mode-options-row" id="mode-selector-row">
            <!-- Guide -->
            <button type="button" class="mode-card-option ${status.mode === 'guide' ? 'active' : ''}" data-mode="guide" aria-pressed="${status.mode === 'guide'}">
              <div class="mode-card-header">
                <i class="ri-navigation-line mode-icon"></i>
                <div class="mode-radio"></div>
              </div>
              <div class="mode-name">Guide</div>
            </button>

            <!-- Assist -->
            <button type="button" class="mode-card-option ${status.mode === 'assist' ? 'active' : ''}" data-mode="assist" aria-pressed="${status.mode === 'assist'}">
              <div class="mode-card-header">
                <i class="ri-check-line mode-icon"></i>
                <div class="mode-radio"></div>
              </div>
              <div class="mode-name">Assist</div>
            </button>

            <!-- Agent -->
            <button type="button" class="mode-card-option ${status.mode === 'agent' ? 'active' : ''}" data-mode="agent" aria-pressed="${status.mode === 'agent'}">
              <div class="mode-card-header">
                <i class="ri-robot-2-line mode-icon"></i>
                <div class="mode-radio"></div>
              </div>
              <div class="mode-name">Agent</div>
            </button>
          </div>
        </div>

        <!-- Input Card -->
        <div class="kaji-card">
          <div class="kaji-card-title">Input</div>
          <div class="input-toggle-row">
            <div class="input-info">
              <div class="input-icon-box">
                <i class="ri-mic-line"></i>
              </div>
              <span class="input-label">Voice</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" aria-label="Voice" id="main-voice-toggle" ${status.voice_active ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="input-toggle-row">
            <div class="input-info">
              <div class="input-icon-box">
                <i class="ri-cursor-line"></i>
              </div>
              <span class="input-label">Head control</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" aria-label="Head control" id="main-head-toggle" ${status.head_control_active ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- Right Column -->
      <div class="main-col">
        <!-- Command bar position Card -->
        <div class="kaji-card">
          <div class="kaji-card-title">Command bar position</div>
          <div class="position-options-list" id="pos-selector-list">
            <!-- Top island -->
            <button type="button" class="position-option ${settings.composer_position === 'top' ? 'active' : ''}" data-pos="top" aria-pressed="${settings.composer_position === 'top'}">
              <div class="position-left">
                <i class="ri-layout-bottom-line position-icon icon-flip-180"></i>
                <span class="position-name">Top island</span>
              </div>
              <div class="position-radio"></div>
            </button>

            <!-- Floating window -->
            <button type="button" class="position-option ${settings.composer_position === 'floating' ? 'active' : ''}" data-pos="floating" aria-pressed="${settings.composer_position === 'floating'}">
              <div class="position-left">
                <i class="ri-window-line position-icon"></i>
                <span class="position-name">Floating window</span>
              </div>
              <div class="position-radio"></div>
            </button>

            <!-- Taskbar dock -->
            <button type="button" class="position-option ${settings.composer_position === 'taskbar' ? 'active' : ''}" data-pos="taskbar" aria-pressed="${settings.composer_position === 'taskbar'}">
              <div class="position-left">
                <i class="ri-layout-bottom-line position-icon"></i>
                <span class="position-name">Taskbar dock</span>
              </div>
              <div class="position-radio"></div>
            </button>
          </div>
        </div>

        <!-- Safety Card -->
        <div class="kaji-card">
          <div class="safety-header-row">
            <div class="kaji-card-title" style="margin-bottom: 0;">Safety</div>
          </div>

          <button class="btn-pause-actions ${status.is_paused ? 'paused' : ''}" id="main-pause-btn">
            <span class="pause-icon-circle">
              <i class="${status.is_paused ? 'ri-play-circle-line' : 'ri-pause-circle-fill'}"></i>
            </span>
            <span id="pause-btn-text">${status.is_paused ? 'Resume all actions' : 'Pause all actions'}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <footer class="main-footer">
      <button class="footer-btn" id="footer-composer-btn">
        <i class="ri-layout-top-line"></i>
        <span>Composer</span>
      </button>

      <span class="footer-separator">|</span>

      <button class="footer-btn" id="footer-settings-btn">
        <i class="ri-settings-3-line"></i>
        <span>Settings</span>
      </button>

      <span class="footer-separator">|</span>

      <button class="footer-btn" id="footer-about-btn">
        <i class="ri-information-line"></i>
        <span>About</span>
      </button>

      <span class="footer-separator">|</span>

      <button class="footer-btn" id="footer-appearance-btn">
        <i class="ri-sun-line"></i>
        <span>Appearance</span>
      </button>
      <button class="footer-btn history-btn" id="footer-history-btn" type="button">
        <i class="ri-history-line" aria-hidden="true"></i>
        <span>History</span>
      </button>
    </footer>
  `;

  shell.appendChild(container);
  root.appendChild(shell);
  prepareControls(shell);

  // Hook up event handlers

  // Mode selection
  const modeCards = container.querySelectorAll('.mode-card-option');
  modeCards.forEach((card) => {
    (card as HTMLElement).onclick = async () => {
      const modeVal = card.getAttribute('data-mode') as 'guide' | 'assist' | 'agent';
      try {
        await setMode(modeVal);
        await store.refreshEngineStatus();
      } catch (e) {
        console.error('Failed to set mode in engine', e);
      }
    };
  });

  // Input toggles
  const voiceToggle = container.querySelector('#main-voice-toggle') as HTMLInputElement;
  voiceToggle.onchange = async () => {
    try {
      await toggleVoice(voiceToggle.checked);
    } catch (e) {
      console.error(e);
    } finally {
      await store.refreshEngineStatus();
    }
  };

  const headToggle = container.querySelector('#main-head-toggle') as HTMLInputElement;
  headToggle.onchange = async () => {
    try {
      await toggleHeadControl(headToggle.checked);
    } catch (e) {
      console.error(e);
    } finally {
      await store.refreshEngineStatus();
    }
  };

  // Position selection
  const posOptions = container.querySelectorAll('.position-option');
  posOptions.forEach((opt) => {
    (opt as HTMLElement).onclick = async () => {
      const posVal = opt.getAttribute('data-pos') as 'top' | 'floating' | 'taskbar';
      store.setDraftField('composer_position', posVal);
      await store.saveDraft();
      posOptions.forEach((o) => {
        o.className = `position-option ${o.getAttribute('data-pos') === posVal ? 'active' : ''}`;
        o.setAttribute('aria-pressed', String(o.getAttribute('data-pos') === posVal));
      });
    };
  });

  // Safety Pause button
  const pauseBtn = container.querySelector('#main-pause-btn') as HTMLButtonElement;
  pauseBtn.onclick = async () => {
    try {
      await pauseAll();
      await store.refreshEngineStatus();
    } catch (e) {
      console.error(e);
    }
  };

  // Footer Actions
  const composerBtn = container.querySelector('#footer-composer-btn') as HTMLButtonElement;
  composerBtn.onclick = () => { void openComposer(store.settings.composer_size / 100); };
  const settingsBtn = container.querySelector('#footer-settings-btn') as HTMLButtonElement;
  settingsBtn.onclick = () => {
    openSettingsWindow();
  };

  const aboutBtn = container.querySelector('#footer-about-btn') as HTMLButtonElement;
  aboutBtn.onclick = () => {
    showAboutModal();
  };

  const appearanceBtn = container.querySelector('#footer-appearance-btn') as HTMLButtonElement;
  appearanceBtn.onclick = () => {
    openSettingsWindow('appearance');
  };

  const historyBtn = container.querySelector('#footer-history-btn') as HTMLButtonElement;
  historyBtn.onclick = () => { void navigateMain('history.html?view=history'); };
}

function updateDynamicElements(): void {
  const status = store.status;

  const chip = document.getElementById('hero-status-chip');
  if (chip) {
    const label = getStatusLabel(status);
    if (chip.textContent !== label) chip.textContent = label;
    const reason = status.reason || label;
    if (chip.title !== reason) chip.title = reason;
  }

  document.querySelectorAll<HTMLElement>('.mode-card-option').forEach((card) => {
    card.classList.toggle('active', card.dataset.mode === status.mode);
    card.setAttribute('aria-pressed', String(card.dataset.mode === status.mode));
  });
  document.querySelectorAll<HTMLElement>('.position-option').forEach((card) => {
    card.classList.toggle('active', card.dataset.pos === store.settings.composer_position);
    card.setAttribute('aria-pressed', String(card.dataset.pos === store.settings.composer_position));
  });
  const voiceToggle = document.getElementById('main-voice-toggle') as HTMLInputElement | null;
  const headToggle = document.getElementById('main-head-toggle') as HTMLInputElement | null;
  if (voiceToggle) voiceToggle.checked = status.voice_active;
  if (headToggle) headToggle.checked = status.head_control_active;

  const pauseBtn = document.getElementById('main-pause-btn') as HTMLButtonElement;
  const pauseText = document.getElementById('pause-btn-text');
  if (pauseBtn && pauseText) {
    pauseBtn.className = `btn-pause-actions ${status.is_paused ? 'paused' : ''}`;
    pauseBtn.querySelector('.pause-icon-circle')!.innerHTML = `<i aria-hidden="true" class="${status.is_paused ? 'ri-play-circle-line' : 'ri-pause-circle-fill'}"></i>`;
    pauseText.textContent = status.is_paused ? 'Resume all actions' : 'Pause all actions';
  }

}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initMainApp();
  });
}
