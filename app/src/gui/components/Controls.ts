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
  root.querySelectorAll<HTMLSelectElement>('select.kaji-select').forEach((select) => {
    if (!select.closest('.select-field')) createDropdown(select);
  });
}
