import { describe, expect, test } from 'bun:test';
import { pixelAt, inCursor, springGrain } from '../src/lib/dither';

describe('dither artwork', () => {
  test('uses only transparent, brand blue and pink square cells', () => {
    const counts = [0, 0, 0];
    for (let y = 0; y < 320; y++) for (let x = 0; x < 480; x++) counts[pixelAt('sweep', x, y, 960, 640)]++;
    expect(counts[0]).toBeGreaterThan(counts[1] + counts[2]);
    expect(counts[1]).toBeGreaterThan(5000);
    expect(counts[2]).toBeGreaterThan(5000);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(480 * 320);
  });
  test('sweep tapers toward its interior edge', () => {
    let nearEdge = 0;
    let middle = 0;
    let atEnd = 0;
    for (let y = 0; y < 320; y++) for (let x = 0; x < 80; x++) {
      if (pixelAt('sweep', x, y, 960, 640)) nearEdge++;
      if (pixelAt('sweep', x + 240, y, 960, 640)) middle++;
      if (pixelAt('sweep', x + 400, y, 960, 640)) atEnd++;
    }
    expect(nearEdge).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(0);
    expect(atEnd).toBe(0);
  });
  test('cursor preserves a clear arrow silhouette', () => {
    expect(inCursor(.35, .35)).toBe(true);
    expect(inCursor(.1, .9)).toBe(false);
    expect(inCursor(.9, .9)).toBe(false);
    expect(inCursor(.9, .44)).toBe(true);
  });
  test('displaced grains settle back to their exact home without ongoing input', () => {
    let position = 40;
    let velocity = 200;
    for (let i = 0; i < 240; i++) ({ position, velocity } = springGrain(position, velocity, 0, 0, 1 / 60));
    expect(Math.abs(position)).toBeLessThan(.001);
    expect(Math.abs(velocity)).toBeLessThan(.001);
  });
});
