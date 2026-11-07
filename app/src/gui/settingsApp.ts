import { createDitherAccents } from './components/DitherAccent';
import { prepareControls } from './components/Controls';
import { createTitleBar } from './components/TitleBar';
import { openMainWindow, windowClose } from './ipc';
import { renderAiModelsPage } from './pages/AiModelsPage';
import { renderAppearancePage } from './pages/AppearancePage';
import { renderGeneralPage } from './pages/GeneralPage';
import { renderHeadControlPage } from './pages/HeadControlPage';
import { renderPermissionsSafetyPage } from './pages/PermissionsSafetyPage';
import { renderPrivacyDataPage } from './pages/PrivacyDataPage';
import { renderShortcutsPage } from './pages/ShortcutsPage';
import { renderVoiceAudioPage } from './pages/VoiceAudioPage';
import { store } from './store';
import { SETTINGS_CATEGORIES, type SettingsTabId } from './types';

let currentTab: SettingsTabId = 'general';

export async function initSettingsApp(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;

  await store.init();

  // Parse query param if opened with ?page=appearance
  const params = new URLSearchParams(window.location.search);
  const initialPage = params.get('page') as SettingsTabId;
  if (initialPage && SETTINGS_CATEGORIES.some((c) => c.id === initialPage)) {
    currentTab = initialPage;
  }

  store.subscribe((source) => {
    if (source === 'external') renderCurrentPage();
  });

  renderApp();
}

function renderApp(): void {
  const root = document.getElementById('app')!;
  root.innerHTML = '';

  const shell = document.createElement('div');
  shell.className = 'window-shell';

  // Corner Dither Accents
  shell.appendChild(createDitherAccents());

  // Window Titlebar
  shell.appendChild(
    createTitleBar({
      windowLabel: 'main',
      title: 'Kaji',
      subtitle: 'Settings',
      showVersion: false,
      onBack: () => { store.discardDraft(); void openMainWindow(); },
      onClose: async () => {
        try {
          await store.waitForPendingSave();
          await windowClose('main');
        } catch (error) {
          console.error('Could not finish saving settings', error);
        }
      },
    })
  );

  // Settings Layout (Sidebar + Main Content)
  const layout = document.createElement('div');
  layout.className = 'settings-layout';

  // Sidebar
  const sidebar = document.createElement('aside');
  sidebar.className = 'settings-sidebar';
  sidebar.id = 'settings-sidebar';
  layout.appendChild(sidebar);

  // Main Right Panel
  const main = document.createElement('main');
  main.className = 'settings-main';

  // Content Area
  const contentWrapper = document.createElement('div');
  contentWrapper.id = 'settings-page-container';
  contentWrapper.className = 'settings-page-wrapper';
  main.appendChild(contentWrapper);

  // Sticky Footer
  const footer = document.createElement('footer');
  footer.className = 'settings-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => {
    store.discardDraft();
    renderCurrentPage();
    void openMainWindow();
  };

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-primary';
  saveBtn.id = 'settings-save-btn';
  saveBtn.textContent = 'Save changes';
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<i class="ri-loader-4-line" aria-hidden="true"></i> Saving...`;
    try {
      await store.saveDraft();
      saveBtn.innerHTML = `<i class="ri-check-line" aria-hidden="true"></i> Saved`;
      setTimeout(() => {
        saveBtn.innerHTML = `Save changes`;
        saveBtn.disabled = false;
      }, 1200);
    } catch (e) {
      saveBtn.textContent = 'Error saving';
      saveBtn.disabled = false;
      console.error(e);
    }
  };

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  main.appendChild(footer);

  layout.appendChild(main);
  shell.appendChild(layout);
  root.appendChild(shell);

  renderSidebar();
  renderCurrentPage();
}

function renderSidebar(): void {
  const sidebar = document.getElementById('settings-sidebar');
  if (!sidebar) return;

  sidebar.innerHTML = '';

  for (const cat of SETTINGS_CATEGORIES) {
    const btn = document.createElement('button');
    btn.className = `nav-item ${currentTab === cat.id ? 'active' : ''}`;
    btn.onclick = () => {
      currentTab = cat.id;
      renderSidebar();
      renderCurrentPage();
    };

    btn.innerHTML = `
      <i class="${cat.icon} nav-icon"></i>
      <span class="nav-label">${cat.label}</span>
    `;

    sidebar.appendChild(btn);
  }
  prepareControls(sidebar);
}

function renderCurrentPage(): void {
  const container = document.getElementById('settings-page-container');
  if (!container) return;

  container.innerHTML = '';

  switch (currentTab) {
    case 'general':
      container.appendChild(renderGeneralPage());
      break;
    case 'voice':
      container.appendChild(renderVoiceAudioPage());
      break;
    case 'head':
      container.appendChild(renderHeadControlPage());
      break;
    case 'ai':
      container.appendChild(renderAiModelsPage());
      break;
    case 'permissions':
      container.appendChild(renderPermissionsSafetyPage());
      break;
    case 'appearance':
      container.appendChild(renderAppearancePage());
      break;
    case 'privacy':
      container.appendChild(renderPrivacyDataPage());
      break;
    case 'shortcuts':
      container.appendChild(renderShortcutsPage());
      break;
  }
  container.scrollTop = 0;
  prepareControls(container);
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initSettingsApp();
  });
}
