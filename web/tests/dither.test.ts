import { describe, expect, test } from 'bun:test';
import { pixelAt, inCursor, springGrain } from '../src/lib/dither';

describe('dither artwork', () => {
  test('uses only transparent, brand blue and pink square cells', () => {
    const counts = [0, 0, 0];
    for (let y = 0; y < 440; y++) for (let x = 0; x < 800; x++) counts[pixelAt('hero', x, y, 1600, 880)]++;
    expect(counts[0]).toBeGreaterThan(counts[1] + counts[2]);
    expect(counts[1]).toBeGreaterThan(10000);
    expect(counts[2]).toBeGreaterThan(10000);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(800 * 440);
  });
  test('keeps the text and CTA area clear', () => {
    for (let y = 20; y < 200; y++) for (let x = 200; x < 600; x++) expect(pixelAt('hero', x, y, 1600, 880)).toBe(0);
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
