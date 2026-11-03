import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
// @ts-ignore Playwright is already installed in the web workspace.
import { chromium, expect } from '../../web/node_modules/@playwright/test/index';
import type { ComposerQuestion, ComposerUpdate } from '../src/gui/composerApp';

const dist = resolve(import.meta.dir, '../dist');
const output = resolve(import.meta.dir, '../verification/screenshots');
await mkdir(output, { recursive: true });
const server = Bun.serve({ port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const target = resolve(dist, path === '/' ? 'index.html' : path.slice(1));
  if (!target.startsWith(dist + sep)) return new Response('Not found', { status: 404 });
  const file = Bun.file(target);
  return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 680, height: 620 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error: Error) => errors.push(error.message));
const question: ComposerQuestion = {
  id: 'flavor-count', title: 'How many flavors should we launch?', allowCustom: true, step: 1, total: 3,
  options: [{ id: 'three', label: 'Three', value: '3' }, { id: 'five', label: 'Five', value: '5' }, { id: 'one', label: 'One', value: '1' }],
};
async function update(detail: ComposerUpdate) {
  await page.evaluate((value: ComposerUpdate) => window.dispatchEvent(new CustomEvent('kaji:composer-update', { detail: value })), detail);
}
async function screenshot(name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.composer-stage').screenshot({ path: resolve(output, `composer-${name}.png`) });
}
async function assertInside() {
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.composer-pill button, .composer-panel:not([hidden])')].flatMap((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1
      ? [{ element: element.className, rect: rect.toJSON(), viewport: [innerWidth, innerHeight], placement: document.querySelector<HTMLElement>('.composer-stage')?.dataset.placement }] : [];
  })), { message: 'Composer clips controls after layout settles' }).toEqual([]);
}
async function fitNativeFrame(panelWidth: number, scale: number) {
  const panelHeight = await page.locator('.composer-panel').evaluate((element: HTMLElement) => Math.min(element.scrollHeight + 2, 400));
  await page.setViewportSize({ width: Math.ceil((panelWidth + 24) * scale), height: Math.ceil((100 + panelHeight) * scale) });
  await assertInside();
  await expect.poll(() => page.locator('.composer-panel').evaluate((element: HTMLElement) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
}
try {
  await page.goto(`${origin}/index.html`);
  await page.getByRole('button', { name: 'Composer', exact: true }).click();
  await expect(page).toHaveURL(/composer\.html$/);
  await expect(page.getByRole('button', { name: 'Start listening', exact: true })).toBeVisible();
  await page.evaluate(() => { localStorage.setItem('kaji_settings', JSON.stringify({ theme: 'dark', composer_size: 100, composer_opacity: 100 })); });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const pill = await page.locator('.composer-pill').boundingBox();
  assert.equal(pill!.width, 448); assert.equal(pill!.height, 68);
  for (const button of await page.locator('.composer-pill button').all()) {
    const box = (await button.boundingBox())!;
    assert.ok(box.width >= 44 && box.height >= 44, 'Control target is too small');
  }
  await screenshot('idle-dark');
  await page.evaluate(() => { (window as any).composerActions = []; window.addEventListener('kaji:composer-action', (event) => (window as any).composerActions.push((event as CustomEvent).detail)); });
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.locator('.agent-mark')).toHaveAttribute('data-state', 'listening');
  await update({ transcript: 'Summarize this page', audioLevel: 0.7 });
  await screenshot('listening-dark');
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
  await page.getByRole('button', { name: 'Pause dwell', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume dwell', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Resume dwell', exact: true }).click();
  const controls = await page.locator('.composer-pill button:not(.composer-prompt)').evaluateAll((elements: HTMLElement[]) => elements.map((element) => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }));
  await page.getByRole('button', { name: 'Type a request', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your request', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Your request', exact: true }).fill('Summarize this page');
  await screenshot('editor-dark');
  assert.deepEqual(await page.locator('.composer-pill button:not(.composer-prompt)').evaluateAll((elements: HTMLElement[]) => elements.map((element) => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; })), controls, 'Expansion moved the controls');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Type a request', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Open Kaji', exact: true }).click();
  await expect(page.locator('h1')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/composer\.html$/);
  await page.getByRole('button', { name: 'Open Kaji', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/settings\.html/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/composer\.html$/);
  assert.equal(context.pages().length, 1);
  await page.getByRole('button', { name: 'Type a request', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your request', exact: true })).toHaveValue('Summarize this page');
  await page.evaluate(() => { (window as any).composerActions = []; window.addEventListener('kaji:composer-action', (event) => (window as any).composerActions.push((event as CustomEvent).detail)); });
  await page.keyboard.press('Enter');
  await expect(page.locator('.agent-mark')).toHaveAttribute('data-state', 'thinking');
  assert.deepEqual(await page.evaluate(() => (window as any).composerActions), [{ type: 'request', text: 'Summarize this page' }]);
  await screenshot('thinking-dark');
  await update({ state: 'working', message: 'Reading the current document…' });
  await page.getByRole('button', { name: 'Show task details', exact: true }).click();
  await screenshot('working-dark');
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(page.locator('.agent-mark')).toHaveAttribute('data-state', 'ready');
  await update({ state: 'listening', transcript: 'The previous request' });
  await update({ question });
  await expect(page.locator('.composer-prompt span')).toHaveText('Your answer…');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'B Five', exact: true }).click();
  await expect(page.locator('.composer-answer')).toHaveText('Your answer: Five');
  await update({ questionId: question.id, answer: '3' });
  await update({ questionId: question.id, answer: '5' });
  await update({ questionId: question.id, answer: '10' });
  await update({ questionId: 'old-question', answer: '3' });
  await expect(page.locator('.composer-answer')).toHaveText('Your answer: 10');
  assert.equal((await page.evaluate(() => (window as any).composerActions)).filter((action: any) => action.type === 'answer').length, 0);
  await screenshot('question-dark');
  await assertInside();
  await page.getByRole('button', { name: 'Dismiss question', exact: true }).click();
  await expect(page.locator('.composer-question')).toBeHidden();
  await page.getByRole('button', { name: 'Open question', exact: true }).click();
  await expect(page.locator('.composer-answer')).toHaveText('Your answer: 10');
  await page.getByRole('button', { name: 'Open Kaji', exact: true }).click();
  await page.getByRole('button', { name: 'Composer', exact: true }).click();
  await expect(page.locator('.composer-answer')).toHaveText('Your answer: 10');
  await page.evaluate(() => { (window as any).answers = []; window.addEventListener('kaji:composer-action', (event) => (window as any).answers.push((event as CustomEvent).detail)); });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).answers), [{ type: 'answer', questionId: question.id, answer: '10' }]);
  await update({ question: { ...question, id: 'approval', kind: 'approval', allowCustom: false } });
  await update({ questionId: 'approval', answer: '10' });
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'A Three', exact: true }).click();
  await screenshot('approval-dark');
  await update({ question: { ...question, id: 'optional', optional: true } });
  await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(page.locator('.composer-question')).toBeHidden();
  await update({ state: 'failed', message: 'Couldn’t read this window. Choose another window and try again.' });
  await screenshot('failed-dark');
  await update({ state: 'ready' });
  await page.getByRole('button', { name: 'Collapse details', exact: true }).click();
  await update({ dwellTarget: 'voice', dwellProgress: 0.65 });
  await screenshot('dwell-dark');
  for (const placement of ['top', 'floating', 'taskbar']) {
    for (const size of [75, 100, 102, 150]) {
      await page.setViewportSize({ width: 680, height: 620 });
      await page.evaluate(({ placement, size }: { placement: string; size: number }) => {
        localStorage.setItem('kaji_settings', JSON.stringify({ theme: 'light', composer_position: placement, composer_size: size, composer_opacity: 100 }));
        sessionStorage.removeItem('kaji-composer-question');
      }, { placement, size });
      await page.reload();
      await page.getByRole('button', { name: 'Type a request', exact: true }).click();
      await assertInside();
      if (size === 100) await screenshot(`editor-${placement}-light`);
      await fitNativeFrame(520, size / 100);
      await update({ question });
      await fitNativeFrame(448, size / 100);
    }
  }
  await page.evaluate(() => { localStorage.setItem('kaji_settings', JSON.stringify({ theme: 'light', composer_position: 'floating', composer_size: 100, composer_opacity: 100 })); sessionStorage.removeItem('kaji-composer-question'); });
  await page.reload();
  await page.setViewportSize({ width: 680, height: 620 });
  await screenshot('idle-light');
  await update({ question });
  await screenshot('question-light');
  await page.setViewportSize({ width: 360, height: 480 });
  await assertInside();
  await screenshot('question-narrow');
  const motionContext = await browser.newContext({ viewport: { width: 680, height: 620 }, reducedMotion: 'no-preference' });
  const motionPage = await motionContext.newPage();
  await motionPage.goto(`${origin}/composer.html`);
  const prompt = motionPage.getByRole('button', { name: 'Type a request', exact: true });
  await motionPage.evaluate(() => document.fonts.ready);
  async function inputGeometry(selector: string) {
    return motionPage.locator(selector).evaluate((element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const text = element.querySelector('span');
      const textRect = text?.getBoundingClientRect();
      return { width: rect.width, height: rect.height, padding: style.padding, font: style.font,
        transform: style.transform, textX: textRect ? textRect.x - rect.x : null, textWidth: textRect?.width };
    });
  }
  await motionPage.mouse.move(0, 0);
  const idleGeometry = await inputGeometry('.composer-prompt');
  await prompt.hover();
  for (let frame = 0; frame < 12; frame++) {
    await motionPage.evaluate(() => new Promise(requestAnimationFrame));
    assert.deepEqual(await inputGeometry('.composer-prompt'), idleGeometry, 'Hover changed the input geometry');
  }
  await motionPage.mouse.down();
  assert.deepEqual(await inputGeometry('.composer-prompt'), idleGeometry, 'Press scaled the input text');
  await motionPage.mouse.up();
  await expect(motionPage.getByRole('textbox', { name: 'Your request', exact: true })).toBeFocused();
  await motionPage.locator('.composer-panel').evaluate((element: HTMLElement) => {
    for (const animation of element.getAnimations()) {
      animation.pause();
      const widths: number[] = [];
      for (const time of [0, 50, 125, 195, 250]) {
        animation.currentTime = time;
        widths.push(element.querySelector('textarea')!.getBoundingClientRect().width);
      }
      if (new Set(widths).size !== 1) throw new Error(`Editor text scales during expansion: ${widths}`);
      animation.finish();
    }
  });
  await motionPage.mouse.move(0, 0);
  const editorGeometry = await inputGeometry('#composer-input');
  await motionPage.locator('#composer-input').hover();
  assert.deepEqual(await inputGeometry('#composer-input'), editorGeometry, 'Editor hover changed the input geometry');
  await motionPage.keyboard.press('Escape');
  await prompt.click();
  await expect(motionPage.getByRole('textbox', { name: 'Your request', exact: true })).toBeFocused();
  await prompt.click();
  await prompt.click();
  await expect(motionPage.locator('.composer-panel')).toBeVisible();
  await expect(prompt).toHaveAttribute('aria-expanded', 'true');
  await motionPage.keyboard.press('Escape');
  await expect(motionPage.locator('.composer-panel')).toBeHidden();
  await prompt.focus();
  await motionPage.keyboard.press('Enter');
  assert.equal(await motionPage.locator('.composer-panel').evaluate((element: HTMLElement) => element.getAnimations().length), 0, 'Keyboard expansion should be instant');
  await motionContext.close();
  const nativeContext = await browser.newContext({ viewport: { width: 544, height: 500 }, screen: { width: 1920, height: 1080 }, reducedMotion: 'no-preference' });
  const nativePage = await nativeContext.newPage();
  await nativePage.exposeFunction('updateNativeComposerRegion', async ({ height }: { height: number }) => {
    // The native viewport stays fixed; only its visible/hit-test region changes.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await nativePage.evaluate((expanded: boolean) => { (window as any).nativeRegionExpanded = expanded; }, height > 100);
    // Windows applies its region before the IPC acknowledgement reaches JavaScript.
    await new Promise((resolve) => setTimeout(resolve, 32));
  });
  await nativePage.addInitScript(() => {
    const fixture = window as any;
    fixture.pendingFrames = 0;
    fixture.transitionFrames = [];
    fixture.pillFrames = [];
    fixture.nativeRegionExpanded = false;
    fixture.dragRequests = 0;
    fixture.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command: string, args: any) => {
        if (command === 'gui_get_settings') return { theme: 'dark', composer_size: 100, composer_opacity: 100, composer_position: 'floating' };
        if (command === 'gui_get_engine_status') return { phase: 'ready', mode: 'assist', head_control_active: true, voice_active: false, is_paused: false, session_id: 0 };
        if (command === 'plugin:window|start_dragging') fixture.dragRequests++;
        if (command === 'gui_set_view') {
          fixture.pendingFrames++;
          try { await fixture.updateNativeComposerRegion(args); }
          finally { fixture.pendingFrames--; }
        }
        return 1;
      },
    };
    function sample() {
      const panel = document.querySelector<HTMLElement>('.composer-panel');
      const input = document.querySelector<HTMLTextAreaElement>('#composer-input');
      const pill = document.querySelector<HTMLElement>('.composer-pill');
      if (pill) {
        const rect = pill.getBoundingClientRect();
        fixture.pillFrames.push([rect.x, rect.y, rect.width, rect.height, getComputedStyle(pill).opacity, getComputedStyle(pill).visibility]);
      }
      if (fixture.nativeRegionExpanded && panel && input && !panel.hidden && !input.closest<HTMLElement>('[hidden]') && getComputedStyle(panel).visibility === 'visible') {
        const rect = input.getBoundingClientRect();
        fixture.transitionFrames.push({ opacity: Number(getComputedStyle(panel).opacity), width: rect.width, height: rect.height, padding: getComputedStyle(input).padding });
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  nativePage.on('pageerror', (error: Error) => errors.push(error.message));
  await nativePage.goto(`${origin}/composer.html`);
  await expect.poll(() => nativePage.evaluate(() => (window as any).pendingFrames)).toBe(0);
  const nativePrompt = nativePage.getByRole('button', { name: 'Type a request', exact: true });
  for (let cycle = 0; cycle < 3; cycle++) {
    await nativePage.evaluate(() => { (window as any).transitionFrames = []; });
    await nativePrompt.click();
    await expect(nativePage.getByRole('textbox', { name: 'Your request', exact: true })).toBeFocused();
    await expect.poll(() => nativePage.locator('.composer-panel').evaluate((element: HTMLElement) => element.getAnimations().length)).toBe(0);
    const opening = await nativePage.evaluate(() => (window as any).transitionFrames) as { opacity: number }[];
    assert.ok(opening.every((frame, index) => index === 0 || frame.opacity >= opening[index - 1].opacity), 'Editor flashed visible, disappeared, then faded back in');
    await nativePrompt.click();
    await expect(nativePage.locator('.composer-panel')).toBeHidden();
    await expect.poll(() => nativePage.evaluate(() => (window as any).pendingFrames)).toBe(0);
    const frames = await nativePage.evaluate(() => (window as any).transitionFrames) as { width: number; height: number; padding: string }[];
    assert.ok(frames.length > 3, 'Did not sample expansion and collapse');
    assert.equal(new Set(frames.map(({ width, height, padding }) => `${width}:${height}:${padding}`)).size, 1, 'Editor reflowed during expansion/collapse');
    assert.equal(frames[0].width, 478, 'Editor initially painted at the collapsed window width');
    assert.deepEqual(nativePage.viewportSize(), { width: 544, height: 500 }, 'Expansion changed the native viewport');
  }
  const pillFrames = await nativePage.evaluate(() => (window as any).pillFrames) as any[][];
  assert.equal(new Set(pillFrames.map((frame) => JSON.stringify(frame))).size, 1, 'Pill moved, resized or disappeared during a toggle');
  assert.deepEqual(pillFrames[0].slice(4), ['1', 'visible']);
  await nativePage.locator('.composer-brand img').dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => nativePage.evaluate(() => (window as any).dragRequests)).toBe(1);
  await nativeContext.close();
  assert.deepEqual(errors, []);
  console.log('Composer checks passed: fixed native viewport, pill visible in every sampled frame, no fade reset, logo dragging, stable input geometry, close-to-pill navigation, questions and sizing.');
} finally {
  await browser.close();
  server.stop(true);
}
