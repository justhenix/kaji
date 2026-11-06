export function renderShortcutsPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';
  container.innerHTML = `
    <div class="settings-page-header">
      <div class="header-icon-box"><i class="ri-keyboard-line" aria-hidden="true"></i></div>
      <div class="header-text-group"><h2 class="header-title">Shortcuts</h2></div>
    </div>
    <div class="kaji-card">
      <div class="settings-row">
        <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-stop-circle-line" aria-hidden="true"></i></div><span class="settings-row-label">Stop all actions</span></div>
        <kbd class="keycap-badge">Esc</kbd>
      </div>
    </div>`;
  return container;
}
