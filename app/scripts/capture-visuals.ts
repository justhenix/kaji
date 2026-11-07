import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
// @ts-ignore Playwright is already installed in the web workspace.
import { chromium, expect, type Page, type ConsoleMessage } from '../../web/node_modules/@playwright/test/index';

const root = resolve(import.meta.dir, '..');
const dist = resolve(root, 'dist');
const output = resolve(root, 'verification/screenshots');
await mkdir(output, { recursive: true });
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const target = resolve(dist, path === '/' ? 'index.html' : path.slice(1));
    if (!target.startsWith(dist + sep)) return new Response('Not found', { status: 404 });
    const file = Bun.file(target);
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const errors: string[] = [];
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 980, height: 700 }, deviceScaleFactor: 1.25, reducedMotion: 'reduce' });
const main: Page = await context.newPage();
const settings: Page = await context.newPage();
for (const page of [main, settings]) {
  page.on('pageerror', (error: Error) => errors.push(error.message));
  page.on('console', (message: ConsoleMessage) => { if (message.type() === 'error') errors.push(message.text()); });
}
const tabs = [
  ['general', 'General'], ['voice', 'Voice & Audio'], ['head', 'Head Control'],
  ['ai', 'AI & Models'], ['permissions', 'Permissions & Safety'], ['appearance', 'Appearance'],
  ['privacy', 'Privacy & Data'], ['shortcuts', 'Shortcuts'],
] as const;
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(output, `${name}.png`) });
}
async function choose(page: Page, id: string, value: string) {
  const text = await page.locator(`#${id}`).evaluate((select: HTMLSelectElement, value: string) => [...select.options].find((option) => option.value === value)!.text, value);
  await page.locator(`#${id}`).locator('..').getByRole('combobox').click();
  await page.getByRole('option', { name: text, exact: true }).click();
}
async function checkLayout(page: Page, name: string) {
  const problems = await page.evaluate(() => {
    const issues: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth) issues.push('Window overflows horizontally');
    for (const card of document.querySelectorAll<HTMLElement>('.kaji-card')) {
      const rect = card.getBoundingClientRect();
      for (const element of card.querySelectorAll<HTMLElement>('input, select, button, .segmented-control, .theme-card, .composer-pos-card')) {
        const item = element.getBoundingClientRect();
        if (item.width && (item.right > rect.right - 8 || item.left < rect.left + 8)) issues.push(`${element.id || element.className} escapes its card`);
      }
    }
    const footer = document.querySelector('.settings-footer')?.getBoundingClientRect();
    if (footer && Math.abs(footer.bottom - (innerHeight - 1)) > 1) issues.push('Footer is not docked');
    return issues;
  });
  assert.deepEqual(problems, [], `${name}: ${problems.join(', ')}`);
  await expect(page.locator('.header-desc, .settings-row-desc, .split-card-desc, .capability-desc, #app-subtitles-toggle')).toHaveCount(0);
  for (const control of await page.locator('.segmented-control').all()) assert(!/[✓✔]/.test(await control.innerText()), `${name}: segmented control has a checkmark`);
}
try {
  await main.goto(`${origin}/index.html`);
  await expect(main.locator('#hero-status-chip')).toHaveText('Ready');
  await expect(main.locator('#main-safety-policy-seg .active')).toHaveText('Auto Review');
  assert(!/Kaji is/i.test(await main.locator('h1').innerText()));
  await capture(main, 'main-app');
  await main.setViewportSize({ width: 880, height: 620 });
  await checkLayout(main, 'main minimum');
  await capture(main, 'main-app-min');
  await main.setViewportSize({ width: 980, height: 700 });
  await main.getByRole('button', { name: 'About', exact: true }).click();
  await expect(main.getByRole('dialog')).toContainText('Team: rotforclout');
  await expect(main.getByRole('dialog')).toContainText('by Gamma Assyafi F.A.R');
  await expect(main.getByRole('link', { name: 'Star on GitHub' })).toHaveAttribute('href', 'https://github.com/justhenix/kaji');
  assert(!(await main.getByRole('dialog').innerText()).includes('Invariants'));
  await capture(main, 'about');
  await main.getByRole('button', { name: 'Done', exact: true }).click();
  await settings.setViewportSize({ width: 1100, height: 760 });
  await settings.goto(`${origin}/settings.html`);
  for (const size of [{ width: 1100, height: 760 }, { width: 920, height: 680 }]) {
    await settings.setViewportSize(size);
    for (const [id, label] of tabs) {
      await settings.getByRole('button', { name: label, exact: true }).click();
      await expect(settings.locator('h2')).toHaveText(label);
      if (['general', 'voice', 'ai'].includes(id)) {
        const selector = id === 'general' ? '#general-lang-select' : id === 'voice' ? '#va-rec-lang-select' : '#ai-resp-lang-select';
        const language = id === 'general' ? settings.locator('select').first() : settings.locator(selector);
        assert.deepEqual(await language.locator('option').evaluateAll((options: HTMLOptionElement[]) => options.map((option: HTMLOptionElement) => option.value)), ['English (US)', 'Bahasa Indonesia', 'Adaptive']);
      }
      const suffix = size.width === 920 ? '-min' : '';
      await capture(settings, `settings-${id}${suffix}`);
      await checkLayout(settings, `${id} ${size.width}`);
      if (await settings.locator('.settings-page-wrapper').evaluate((element: HTMLElement) => element.scrollHeight > element.clientHeight + 1)) {
        await settings.locator('.settings-page-wrapper').evaluate((element: HTMLElement) => { element.scrollTop = element.scrollHeight; });
        await capture(settings, `settings-${id}${suffix}-bottom`);
      }
    }
  }
  await settings.setViewportSize({ width: 1100, height: 760 });
  await settings.getByRole('button', { name: 'AI & Models', exact: true }).click();
  assert.deepEqual(await settings.locator('#ai-model-select option').evaluateAll((options: HTMLOptionElement[]) => options.map((option: HTMLOptionElement) => (option as HTMLOptionElement).value)), ['Kaji Pro', 'Kaji Flash']);
  await choose(settings, 'ai-model-select', 'Kaji Flash');
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await settings.reload();
  await settings.getByRole('button', { name: 'AI & Models', exact: true }).click();
  await expect(settings.locator('#ai-model-select')).toHaveValue('Kaji Flash');
  await settings.getByRole('button', { name: 'Permissions & Safety', exact: true }).click();
  const slider = settings.locator('#ps-autonomy-slider');
  const initial = await slider.boundingBox();
  for (const value of ['0', '50', '100']) {
    await slider.evaluate((element: HTMLInputElement, next: string) => { (element as HTMLInputElement).value = next; element.dispatchEvent(new Event('input')); }, value);
    assert.deepEqual(await slider.boundingBox(), initial, `Slider moved at value ${value}`);
    assert.equal((await settings.locator('#ps-autonomy-val').boundingBox())?.width, 72);
  }
  await settings.locator('#ps-conf-policy-seg').getByRole('button', { name: 'Auto Review', exact: true }).click();
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(main.locator('#main-safety-policy-seg .active')).toHaveText('Auto Review');
  await main.locator('#main-safety-policy-seg').getByRole('button', { name: 'Full access', exact: true }).click();
  await expect(settings.locator('#ps-conf-policy-seg .active')).toHaveText('Full access');
  await settings.getByRole('button', { name: 'Head Control', exact: true }).click();
  const tracks = await settings.locator('#hc-sens-slider, #hc-dwell-slider').evaluateAll((elements: HTMLElement[]) => elements.map((element: HTMLElement) => { const rect = element.getBoundingClientRect(); return [rect.left, rect.right]; }));
  assert.deepEqual(tracks[0], tracks[1], 'Head control tracks do not align');
  await choose(settings, 'hc-dwell-select', '3.0');
  await expect(settings.locator('#hc-dwell-slider')).toHaveValue('30');
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(settings.locator('h1')).toBeVisible();
  await settings.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.getByRole('button', { name: 'Head Control', exact: true }).click();
  await expect(settings.locator('#hc-dwell-slider')).toHaveValue('12');
  await settings.getByRole('button', { name: 'Shortcuts', exact: true }).click();
  await settings.locator('[data-sc="composer"]').click();
  await settings.keyboard.press('Control+Alt+L');
  await expect(settings.locator('#conflict-msg')).toBeVisible();
  await expect(settings.locator('#rec-save-btn')).toBeDisabled();
  await capture(settings, 'shortcut-conflict');
  await settings.keyboard.press('Escape');
  await expect(settings.getByRole('dialog')).toHaveCount(0);
  await settings.locator('[data-sc="composer"]').click();
  await settings.keyboard.press('Control+Alt+K');
  await settings.getByRole('button', { name: 'Apply Shortcut', exact: true }).click();
  await expect(settings.locator('#badge-composer')).toHaveText('Ctrl+Alt+K');

  await settings.getByRole('button', { name: 'Privacy & Data', exact: true }).click();
  await settings.locator('#pd-manage-hist-btn').click();
  await settings.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings.getByRole('dialog')).toHaveCount(0);
  await settings.locator('#pd-manage-hist-btn').click();
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(settings.getByRole('dialog')).toHaveCount(0);
  await settings.locator('#pd-manage-hist-btn').click();
  await settings.keyboard.press('Escape');
  await expect(settings.getByRole('dialog')).toHaveCount(0);

  await settings.getByRole('button', { name: 'AI & Models', exact: true }).click();
  assert.deepEqual(await settings.locator('#ai-resp-lang-select option').evaluateAll((options: HTMLOptionElement[]) => options.map((option: HTMLOptionElement) => option.value)), ['English (US)', 'Bahasa Indonesia', 'Adaptive']);
  await choose(settings, 'ai-resp-lang-select', 'Bahasa Indonesia');
  await expect(settings.locator('#ai-resp-lang-select').locator('..').getByRole('combobox')).toContainText('Bahasa Indonesia');
  await settings.locator('#ai-resp-lang-select').locator('..').getByRole('combobox').click();
  await capture(settings, 'response-dropdown-light');
  await settings.keyboard.press('Escape');
  await expect(settings.getByRole('listbox')).toHaveCount(0);

  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(settings.locator('.composer-pos-card i')).toHaveCount(0);
  assert.deepEqual(await settings.locator('.composer-bar-pill').evaluateAll((bars: HTMLElement[]) => bars.map((bar: HTMLElement) => getComputedStyle(bar).backgroundColor)), Array(3).fill('rgb(253, 145, 204)'));
  for (const theme of ['light', 'dark']) {
    await settings.locator(`.theme-card[data-theme="${theme}"]`).click();
    await expect(settings.locator('html')).toHaveAttribute('data-theme', theme);
    const colors = new Set<string>();
    for (const accent of ['blue', 'purple', 'pink', 'cyan', 'green']) {
      await settings.locator(`.swatch-circle[data-color="${accent}"]`).click();
      colors.add(await settings.locator('#settings-save-btn').evaluate((button: HTMLElement) => getComputedStyle(button).backgroundColor));
      await capture(settings, `appearance-${theme}-${accent}`);
    }
    assert.equal(colors.size, 5, `${theme}: accents do not change the rendered primary color`);
  }
  await settings.locator('.swatch-circle[data-color="blue"]').click();
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await settings.reload();
  await expect(settings.locator('html')).toHaveAttribute('data-theme', 'dark');
  assert.equal(await settings.locator('.settings-main').evaluate((element: HTMLElement) => getComputedStyle(element).backgroundColor), 'rgb(23, 23, 23)', 'Dark surfaces must be neutral charcoal');
  for (const [id, label] of tabs) {
    await settings.getByRole('button', { name: label, exact: true }).click();
    await capture(settings, `settings-${id}-dark`);
    await checkLayout(settings, `${id} dark`);
  }
  await settings.getByRole('button', { name: 'AI & Models', exact: true }).click();
  await expect(settings.locator('#ai-resp-lang-select')).toHaveValue('Bahasa Indonesia');
  await settings.locator('#ai-resp-lang-select').locator('..').getByRole('combobox').click();
  await capture(settings, 'response-dropdown-dark');
  await settings.keyboard.press('End');
  await settings.keyboard.press('Enter');
  await expect(settings.locator('#ai-resp-lang-select')).toHaveValue('Adaptive');

  const pageCount = context.pages().length;
  await main.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(main).toHaveURL(/settings\.html$/);
  assert.equal(context.pages().length, pageCount, 'Settings opened another window');
  await main.getByRole('button', { name: 'Back to Kaji', exact: true }).click();
  await expect(main).toHaveURL(/index\.html$/);
  await expect(main.locator('html')).toHaveAttribute('data-theme', 'dark');
  await capture(main, 'main-app-dark');
  await main.getByRole('button', { name: 'Pause all actions', exact: true }).click();
  await expect(main.locator('#hero-status-chip')).toHaveText('Paused');
  await main.getByRole('button', { name: 'Resume all actions', exact: true }).click();
  await expect(main.locator('#hero-status-chip')).toHaveText('Ready');
  await main.getByRole('button', { name: 'Emergency stop', exact: true }).click();
  await expect(main.locator('#hero-status-chip')).toHaveText('Paused');
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`);
  console.log('PASS: eight pages at default/minimum sizes and dark mode; five accents in both themes; pink previews; three response languages; custom dropdown mouse/keyboard/Escape; modal Close/X/Escape; same-window Settings/back; persistence; slider geometry; safety sync; Cancel; shortcut conflicts; pause/resume/stop; no browser errors.');
} catch (error) {
  await capture(settings, 'failure');
  throw error;
} finally {
  await context.close();
  await browser.close();
  server.stop();
}
