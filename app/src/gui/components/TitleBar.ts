import { windowClose, windowMinimize } from '../ipc';

export interface TitleBarOptions {
  windowLabel: string;
  title: string;
  subtitle?: string;
  showVersion?: boolean;
  onBack?: () => void;
  onClose?: () => void | Promise<void>;
}

export function createTitleBar(options: TitleBarOptions): HTMLElement {
  const header = document.createElement('header');
  header.className = 'window-titlebar';
  header.setAttribute('data-tauri-drag-region', '');

  const brand = document.createElement('div');
  brand.className = 'titlebar-brand';
  brand.setAttribute('data-tauri-drag-region', '');

  if (options.onBack) {
    const back = document.createElement('button');
    back.className = 'window-control-btn titlebar-back';
    back.setAttribute('aria-label', 'Back to Kaji');
    back.innerHTML = '<i class="ri-arrow-left-line" aria-hidden="true"></i>';
    back.onclick = options.onBack;
    brand.appendChild(back);
  }

  const logoBox = document.createElement('div');
  logoBox.className = 'titlebar-logo';
  logoBox.innerHTML = `<img src="/logo/kaji-mark.svg" alt="Kaji" width="20" height="20" />`;
  brand.appendChild(logoBox);

  const titleSpan = document.createElement('span');
  titleSpan.textContent = options.title;
  brand.appendChild(titleSpan);

  if (options.showVersion) {
    const versionSpan = document.createElement('span');
    versionSpan.className = 'titlebar-version';
    versionSpan.textContent = 'v0.1.5';
    brand.appendChild(versionSpan);
  }

  if (options.subtitle) {
    const sep = document.createElement('span');
    sep.className = 'titlebar-separator';
    sep.textContent = '|';
    brand.appendChild(sep);

    const sub = document.createElement('span');
    sub.className = 'titlebar-subtitle';
    sub.textContent = options.subtitle;
    brand.appendChild(sub);
  }

  const controls = document.createElement('div');
  controls.className = 'titlebar-controls';

  // Minimize button
  const minBtn = document.createElement('button');
  minBtn.className = 'window-control-btn min';
  minBtn.setAttribute('title', 'Minimize');
  minBtn.setAttribute('aria-label', 'Minimize');
  minBtn.innerHTML = `<i class="ri-subtract-line"></i>`;
  minBtn.onclick = () => windowMinimize(options.windowLabel);
  controls.appendChild(minBtn);

  // Maximize button (STRICT: disabled per design spec)
  const maxBtn = document.createElement('button');
  maxBtn.className = 'window-control-btn disabled';
  maxBtn.setAttribute('disabled', 'true');
  maxBtn.setAttribute('title', 'Maximize disabled');
  maxBtn.setAttribute('aria-label', 'Maximize disabled');
  maxBtn.innerHTML = `<i class="ri-checkbox-blank-line"></i>`;
  controls.appendChild(maxBtn);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'window-control-btn close';
  closeBtn.setAttribute('title', 'Close');
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = `<i class="ri-close-line"></i>`;
  closeBtn.onclick = () => options.onClose ? options.onClose() : windowClose(options.windowLabel);
  controls.appendChild(closeBtn);

  header.appendChild(brand);
  header.appendChild(controls);

  return header;
}
