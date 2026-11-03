let closeCurrent: (() => void) | undefined;
let nextId = 0;

export function createDropdown(select: HTMLSelectElement): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'select-field';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'kaji-select dropdown-trigger';
  trigger.style.minWidth = select.style.minWidth;
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const name = select.getAttribute('aria-label') || select.previousElementSibling?.querySelector('.settings-row-label')?.textContent
    || select.previousElementSibling?.textContent?.trim() || select.closest('.settings-row')?.querySelector('.settings-row-label')?.textContent
    || select.closest('.kaji-card')?.querySelector('.kaji-card-title')?.textContent || 'Choose an option';
  trigger.setAttribute('aria-label', name.replace(/\s+/g, ' ').trim());
  const label = document.createElement('span');
  const chevron = document.createElement('i');
  chevron.className = 'ri-arrow-down-s-line';
  chevron.setAttribute('aria-hidden', 'true');
  trigger.append(label, chevron);
  select.before(wrapper);
  select.hidden = true;
  wrapper.append(select, trigger);
  const sync = () => {
    label.textContent = select.selectedOptions[0]?.textContent || '';
    trigger.disabled = select.disabled;
  };
  select.addEventListener('change', sync);
  select.addEventListener('value-updated', sync);
  sync();

  function open(keyboard = false) {
    closeCurrent?.();
    sync();
    const list = document.createElement('div');
    list.id = `kaji-options-${++nextId}`;
    list.className = 'dropdown-options';
    if (keyboard) list.dataset.keyboard = 'true';
    list.setAttribute('role', 'listbox');
    const events = new AbortController();
    const close = (restoreFocus = false) => {
      events.abort();
      list.remove();
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-controls');
      if (closeCurrent === close) closeCurrent = undefined;
      if (restoreFocus) trigger.focus();
    };
    closeCurrent = close;
    const options = [...select.options].map((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dropdown-option';
      button.textContent = option.textContent;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.selected));
      button.tabIndex = -1;
      button.disabled = option.disabled;
      button.onclick = () => {
        select.selectedIndex = index;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
        close(true);
      };
      list.appendChild(button);
      return button;
    });
    document.body.appendChild(list);
    const rect = trigger.getBoundingClientRect();
    const below = innerHeight - rect.bottom;
    const above = rect.top;
    const flip = below < 180 && above > below;
    list.style.transformOrigin = flip ? 'bottom left' : 'top left';
    const width = Math.min(innerWidth - 24, Math.max(rect.width, list.getBoundingClientRect().width, 120));
    list.style.width = `${width}px`;
    list.style.left = `${Math.min(rect.left, innerWidth - width - 12)}px`;
    list.style.maxHeight = `${Math.min(260, (flip ? above : below) - 16)}px`;
    if (flip) list.style.bottom = `${innerHeight - rect.top + 6}px`;
    else list.style.top = `${rect.bottom + 6}px`;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', list.id);
    (options[select.selectedIndex] || options[0])?.focus();
    document.addEventListener('pointerdown', (event) => {
      if (!wrapper.contains(event.target as Node) && !list.contains(event.target as Node)) close();
    }, { signal: events.signal, capture: true });
    document.addEventListener('scroll', (event) => { if (!list.contains(event.target as Node)) close(); }, { signal: events.signal, capture: true });
    window.addEventListener('resize', () => close(), { signal: events.signal });
    list.onkeydown = (event) => {
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape' || event.key === 'Tab') {
        close(event.key === 'Escape');
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }
    };
  }
  trigger.onclick = (event) => trigger.getAttribute('aria-expanded') === 'true' ? closeCurrent?.() : open(event.detail === 0);
  trigger.onkeydown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(true); }
  };
  return wrapper;
}
