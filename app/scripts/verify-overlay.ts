import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { OverlayState } from '../shared/runtime';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium } from '../../web/node_modules/@playwright/test/index';

const dist = resolve(import.meta.dir, '../dist');
const output = resolve(import.meta.dir, '../verification/screenshots');
await mkdir(output, { recursive: true });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = resolve(dist, new URL(request.url).pathname.slice(1));
  if (!path.startsWith(dist + sep)) return new Response(null, { status: 404 });
  const file = Bun.file(path);
  return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
} });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 260 }, reducedMotion: 'reduce' });
  await page.goto(`http://127.0.0.1:${server.port}/overlay.html`);
  await page.locator('.doppelganger-overlay').waitFor({ state: 'attached' });
  for (const theme of ['dark', 'light']) {
    await page.addStyleTag({ content: `body { background: ${theme === 'dark' ? '#181818' : '#fafafa'} !important; }` });
    for (const mode of ['follow', 'task'] as const) {
      await page.evaluate(async (mode: 'follow' | 'task') => {
        const { renderOverlay } = await import('/overlay.js' as string);
        renderOverlay(document.getElementById('app'), {
          mode, point: { x: 290, y: 115 }, target: null, targetLabel: '', dwellProgress: 0,
          cursorEnabled: true, highlightEnabled: true,
          viewport: { left: 0, top: 0, width: 640, height: 260, scaleFactor: 1 }, monitorScaleFactor: 1,
        });
      }, mode);
      const cursor = page.locator('.doppelganger-cursor');
      assert.equal(await cursor.isVisible(), mode === 'task');
      if(mode === 'task') assert.equal(await cursor.evaluate((element: Element) => getComputedStyle(element).opacity), '1');
      assert.equal(await page.locator('.doppelganger-identity').isVisible(), mode === 'task');
      assert.equal(await cursor.evaluate((element: Element) => getComputedStyle(element).transitionDuration), '0s');
      await page.screenshot({ path: resolve(output, `doppel-${theme}-${mode}.png`) });
    }
    await page.evaluate(() => {
      const control = document.createElement('button');
      control.id = 'target-control';
      control.textContent = 'Align Center';
      control.style.cssText = 'position:absolute;left:260px;top:100px;width:140px;height:48px;border:1px solid #777;border-radius:4px;font:14px sans-serif';
      control.onclick = () => { control.dataset.clicked = 'true'; };
      document.body.prepend(control);
    });
    const bounds = (await page.locator('#target-control').boundingBox())!;
    const state: OverlayState = {
      mode: 'task', point: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      target: { left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height },
      targetLabel: 'Next: Align Center', dwellProgress: 0, cursorEnabled: true, highlightEnabled: true,
      viewport: { left: 0, top: 0, width: 640, height: 260, scaleFactor: 1 },
    };
    const render = (state: OverlayState) => page.evaluate(async (state: OverlayState) => {
      const { renderOverlay } = await import('/overlay.js' as string);
      renderOverlay(document.getElementById('app'), state);
    }, state);
    await render(state);
    assert.deepEqual(await page.locator('.doppelganger-target').boundingBox(), bounds);
    assert.equal(await page.locator('.target-corner:visible').count(), 4);
    assert.equal(await page.locator('.doppelganger-label').textContent(), 'Next: Align Center');
    await page.locator('#target-control').click();
    assert.equal(await page.locator('#target-control').getAttribute('data-clicked'), 'true', 'Overlay blocked the underlying control');
    await page.screenshot({ path: resolve(output, `target-${theme}-guide.png`) });
    for (const scale of [1.5, 2]) {
      await render({
        ...state, cursorEnabled: false,
        target: { left: -1920 + bounds.x * scale, top: bounds.y * scale, right: -1920 + (bounds.x + bounds.width) * scale, bottom: (bounds.y + bounds.height) * scale },
        viewport: { left: -1920, top: 0, width: 640 * scale, height: 260 * scale, scaleFactor: scale },
      });
      assert.deepEqual(await page.locator('.doppelganger-target').boundingBox(), bounds, 'Scaled display shifted the target box');
      assert(!await page.locator('.doppelganger-cursor').isVisible());
    }
    await render({ ...state, mode: 'follow', dwellProgress: 0.6, targetLabel: 'Hold still to click' });
    assert(await page.locator('.doppelganger-target').isVisible());
    assert(!await page.locator('.doppelganger-cursor').isVisible());
    assert(!await page.locator('.doppelganger-identity').isVisible());
    await page.screenshot({ path: resolve(output, `target-${theme}-dwell.png`) });
    for (const [x, y] of [[0, 0], [590, 0], [590, 220], [0, 220]]) {
      await render({ ...state, target: { left: x!, top: y!, right: x! + 50, bottom: y! + 40 }, targetLabel: 'Next: A long control name that stays inside the screen' });
      const label = (await page.locator('.doppelganger-label').boundingBox())!;
      assert(label.x >= 0 && label.y >= 0 && label.x + label.width <= 640 && label.y + label.height <= 260, 'Target label exceeds the viewport');
    }
    await render({ ...state, mode: 'follow', point: null, target: null, targetLabel: '', dwellProgress: 0 });
    assert(!await page.locator('.doppelganger-overlay').isVisible(), 'Stale target survived clearing');
    await render({ ...state, cursorEnabled: false, highlightEnabled: false });
    assert(!await page.locator('.doppelganger-overlay').isVisible(), 'Disabled overlay still visible');
    await page.locator('#target-control').evaluate((element: Element) => element.remove());
  }
  await page.goto(`http://127.0.0.1:${server.port}/composer.html`);
  await page.locator('.composer-pill').waitFor();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kaji:composer-update',{detail:{state:'working',message:'Working'}})));
  await page.getByRole('button',{name:'Show task details',exact:true}).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kaji:composer-update',{detail:{state:'ready',message:'Done'}})));
  await page.getByRole('button',{name:'Type a request',exact:true}).click();
  assert(await page.getByRole('textbox',{name:'Your request'}).isVisible(),'Completed reply needs more than one click to start the next request');
  await page.getByRole('button',{name:'Type a request',exact:true}).click();
  for (const [headPhase, dwellReady, expected] of [
    ['initializing',false,'Starting'], ['calibrating',false,'Calibrate'], ['tracking',false,'Aim'],
    ['tracking',true,'Ready'], ['mouse',false,'Paused'], ['tracking',false,'Aim'], ['tracking',true,'Ready'],
  ] as const) {
    await page.evaluate(({headPhase,dwellReady}: {headPhase:string;dwellReady:boolean}) => window.dispatchEvent(new CustomEvent('kaji:composer-update',{detail:{state:'ready',dwellEnabled:true,headPhase,dwellReady}})),{headPhase,dwellReady});
    assert.equal(await page.locator('.composer-dwell-status').textContent(),expected);
    assert.equal(await page.getByRole('button',{name:'Stop dwell',exact:true}).getAttribute('aria-pressed'),'true');
    if(dwellReady) assert.equal(await page.locator('.agent-mark').getAttribute('data-dwell-check'),'true','Ready confirmation did not reappear after yielding');
    const bounds=await page.locator('.composer-dwell').boundingBox(),copy=await page.locator('.composer-dwell-copy').boundingBox();
    assert(bounds&&copy&&copy.x+copy.width<=bounds.x+bounds.width,'Dwell status overflows its button');
  }
  for(const theme of ['dark','light']) {
    await page.evaluate((theme:string) => {document.documentElement.dataset.theme=theme},theme);
    await page.screenshot({path:resolve(output,`composer-dwell-${theme}.png`)});
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kaji:composer-update',{detail:{state:'failed',failureSettings:'head',dwellEnabled:false,headPhase:'stopped',headReason:'sensor: Camera could not start.',message:'Camera could not start.'}})));
  assert.equal(await page.getByRole('button',{name:'Show error details',exact:true}).textContent(),'Dwell unavailable');
  await page.getByRole('button',{name:'Show error details',exact:true}).click();
  assert(await page.getByRole('button',{name:'Try dwell again',exact:true}).isVisible());
  console.log('PASS: exact target bounds, corner markers, click-through, edge labels and clearing in both themes; no duplicate head pointer; dwell readiness and reduced motion verified.');
} finally {
  await browser.close();
  server.stop(true);
}
