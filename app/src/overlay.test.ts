import { expect, test } from 'bun:test';
import { overlayGeometry } from './overlay';

test('overlay maps negative desktop coordinates through native viewport and monitor scales', () => {
  const geometry = overlayGeometry({
    mode: 'task', point: { x: -1620, y: 150 }, target: { left: -1800, top: 60, right: -1500, bottom: 210 },
    targetLabel: 'Mail', dwellProgress: 0.5, cursorEnabled: true, highlightEnabled: true,
    viewport: { left: -1920, top: 0, width: 2880, height: 1620, scaleFactor: 1.5 }, monitorScaleFactor: 2,
  });
  expect(geometry?.width).toBe(1920);
  expect(geometry?.height).toBe(1080);
  expect(geometry?.cursor?.width).toBe(32);
  expect(geometry?.cursor?.left).toBeCloseTo(195.68);
  expect(geometry?.cursor?.top).toBeCloseTo(97.28);
  expect(geometry?.target).toEqual({ left: 80, top: 40, width: 200, height: 100 });
});

test('overlay stays hidden until native supplies coordinate origin and scale', () => {
  expect(overlayGeometry({
    mode: 'follow', point: { x: 10, y: 20 }, target: null, targetLabel: '', dwellProgress: 0,
    cursorEnabled: true, highlightEnabled: true,
  })).toBeNull();
});

test('following cursor sits beside the physical pointer at every monitor scale', () => {
  for (const scale of [1, 1.5, 2]) {
    const geometry = overlayGeometry({
      mode: 'follow', point: { x: -1200, y: 300 }, target: null, targetLabel: '', dwellProgress: 0,
      cursorEnabled: true, highlightEnabled: true,
      viewport: { left: -1920, top: 0, width: 1920, height: 1080, scaleFactor: scale }, monitorScaleFactor: scale,
    });
    expect(geometry?.cursor?.left).toBeCloseTo(720 / scale + 24 - 24 * 54 / 400);
    expect(geometry?.cursor?.top).toBeCloseTo(300 / scale - 24 * 34 / 400);
  }
});

test('following cursor switches sides at the display edge and keeps its glow visible', () => {
  const state = {
    mode: 'follow' as const, point: { x: 1915, y: 1075 }, target: null, targetLabel: '', dwellProgress: 0,
    cursorEnabled: true, highlightEnabled: true,
    viewport: { left: 0, top: 0, width: 1920, height: 1080, scaleFactor: 1 }, monitorScaleFactor: 1,
  };
  const follow = overlayGeometry(state)!;
  expect(follow.cursor!.left + follow.cursor!.width + 8).toBeLessThan(1915);
  expect(follow.cursor!.top + follow.cursor!.height + 8).toBeLessThanOrEqual(1080);
  const task = overlayGeometry({ ...state, mode: 'task' })!;
  expect(task.cursor!.left + task.cursor!.width * 54 / 400).toBeCloseTo(1915);
  expect(task.cursor!.top + task.cursor!.width * 34 / 400).toBeCloseTo(1075);
});
