import { openGitHub } from '../ipc';
import { prepareControls } from './Controls';

export function showModal(title: string, contentNode: HTMLElement, onClose?: () => void): () => void {
  const previousFocus = document.activeElement as HTMLElement | null;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';

  const header = document.createElement('div');
  header.className = 'modal-header';

  const titleEl = document.createElement('h3');
  titleEl.className = 'modal-title';
  titleEl.textContent = title;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close-btn';
  closeBtn.innerHTML = `<i class="ri-close-line"></i>`;
  closeBtn.setAttribute('aria-label', 'Close dialog');
  closeBtn.onclick = () => close();
  contentNode.querySelectorAll<HTMLElement>('[data-modal-close]').forEach((button) => {
    button.onclick = () => close();
  });

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  dialog.appendChild(header);
  dialog.appendChild(contentNode);
  overlay.appendChild(dialog);

  function close() {
    onClose?.();
    window.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    previousFocus?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      close();
    }
    if (e.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, [tabindex="0"]')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }

  window.addEventListener('keydown', onKeyDown);
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };

  document.body.appendChild(overlay);
  prepareControls(overlay);
  closeBtn.focus();
  return close;
}

export function showAboutModal(): void {
  const content = document.createElement('div');
  content.style.display = 'flex';
  content.style.flexDirection = 'column';
  content.style.gap = '14px';

  content.innerHTML = `
    <div style="display: flex; align-items: center; gap: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--divider);">
      <img src="/logo/kaji-mark.svg" alt="Kaji" width="40" height="40" />
      <div>
        <div style="font-family: var(--font-heading); font-weight: 700; font-size: 18px; color: var(--kaji-blue);">Kaji Desktop</div>
        <div style="font-size: 13px; color: var(--text-secondary);">Version 0.1.4 (Windows Native)</div>
      </div>
    </div>
    <p style="font-size: 13.5px; line-height: 1.5; color: var(--text-primary);">
      Kaji is an assistive desktop companion providing voice guidance, computer control, and head-tracking interaction without chat clutter.
    </p>
    <div class="about-credits">
      <span>Team: <strong>rotforclout</strong></span>
      <span>by Gamma Assyafi F.A.R</span>
    </div>
    <div class="about-actions">
      <button class="btn-secondary" id="about-ok-btn">Done</button>
      <a class="btn-primary" href="https://github.com/justhenix/kaji" target="_blank" rel="noopener noreferrer"><i class="ri-github-line"></i> Star on GitHub</a>
    </div>
  `;

  const close = showModal('About Kaji', content);
  const github = content.querySelector('a')!;
  github.onclick = (event) => {
    event.preventDefault();
    void openGitHub().catch(console.error);
  };

  const okBtn = content.querySelector('#about-ok-btn') as HTMLButtonElement;
  if (okBtn) {
    okBtn.onclick = close;
  }
}

export function showShortcutRecorderModal(
  actionName: string,
  currentShortcut: string,
  existingShortcuts: Record<string, string>,
  onSave: (newShortcut: string) => void
): void {
  const content = document.createElement('div');
  content.style.display = 'flex';
  content.style.flexDirection = 'column';
  content.style.gap = '16px';

  let recordedKeys: string[] = currentShortcut.split(' + ').map((s) => s.trim());
  let conflictName: string | null = null;

  content.innerHTML = `
    <p style="font-size: 13.5px; color: var(--text-secondary);">
      Press the desired key combination for <strong>${actionName}</strong>.
    </p>
    <div id="key-record-box" style="padding: 16px; border: 2px dashed var(--kaji-blue); border-radius: 10px; background: var(--surface-bg); text-align: center; font-family: var(--font-keycap); font-weight: 600; font-size: 16px; color: var(--kaji-blue);">
      ${currentShortcut}
    </div>
    <div id="conflict-msg" style="color: #DC2626; font-size: 12.5px; display: none; align-items: center; gap: 6px;">
      <i class="ri-error-warning-line"></i> <span id="conflict-text"></span>
    </div>
    <div style="display: flex; justify-content: flex-end; gap: 10px;">
      <button class="btn-secondary" id="rec-cancel-btn">Cancel</button>
      <button class="btn-primary" id="rec-save-btn">Apply Shortcut</button>
    </div>
  `;

  const close = showModal('Edit Shortcut', content, () => {
    window.removeEventListener('keydown', handleKeyDown, true);
  });

  const box = content.querySelector('#key-record-box') as HTMLElement;
  const conflictMsg = content.querySelector('#conflict-msg') as HTMLElement;
  const conflictText = content.querySelector('#conflict-text') as HTMLElement;
  const cancelBtn = content.querySelector('#rec-cancel-btn') as HTMLButtonElement;
  const saveBtn = content.querySelector('#rec-save-btn') as HTMLButtonElement;

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Tab') return;
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      close();
      return;
    }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();

    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Win');

    const key = e.key;
    if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
      const formattedKey = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
      if (!parts.includes(formattedKey)) {
        parts.push(formattedKey);
      }
    }

    if (parts.length > 0) {
      recordedKeys = parts;
      const str = recordedKeys.join(' + ');
      box.textContent = str;

      // Check conflict
      conflictName = null;
      for (const [name, sc] of Object.entries(existingShortcuts)) {
        if (name !== actionName && sc.toLowerCase() === str.toLowerCase()) {
          conflictName = name;
          break;
        }
      }

      if (conflictName) {
        conflictText.textContent = `Conflict: This shortcut is already assigned to "${conflictName}".`;
        conflictMsg.style.display = 'flex';
        saveBtn.disabled = true;
      } else {
        conflictMsg.style.display = 'none';
        saveBtn.disabled = false;
      }
    }
  }

  window.addEventListener('keydown', handleKeyDown, true);

  cancelBtn.onclick = () => {
    close();
  };

  saveBtn.onclick = () => {
    onSave(recordedKeys.join(' + '));
    close();
  };
}
