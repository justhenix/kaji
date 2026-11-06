import { createDropdown } from './Dropdown';

export function prepareControls(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.theme-card, .composer-pos-card, .swatch-circle, .mode-card-option, .position-option').forEach((control) => {
    control.setAttribute('role', 'button');
    control.tabIndex = 0;
    if (control.dataset.color) control.setAttribute('aria-label', `${control.dataset.color} accent`);
    control.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); control.click(); }
    };
  });
  root.querySelectorAll<HTMLElement>('.split-card-left > div').forEach((heading) => {
    if (heading.querySelector('.split-card-title')) heading.classList.add('section-heading');
  });
  root.querySelectorAll('i').forEach((icon) => icon.setAttribute('aria-hidden', 'true'));
  root.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
    if (input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby') || [...input.labels ?? []].some(label => label.textContent?.trim())) return;
    const label = input.closest('.settings-row')?.querySelector('.settings-row-label')?.textContent?.trim();
    if (label) input.setAttribute('aria-label', label);
  });
  root.querySelectorAll<HTMLSelectElement>('select.kaji-select').forEach((select) => {
    if (!select.closest('.select-field')) createDropdown(select);
  });
}
