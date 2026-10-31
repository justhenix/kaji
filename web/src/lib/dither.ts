export type Artwork = 'sweep' | 'cursor';
export const palette = [[9, 49, 141], [253, 145, 204]] as const;

const bayer = [
  0, 48, 12, 60, 3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
  8, 56, 4, 52, 11, 59, 7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58, 6, 54, 9, 57, 5, 53,
  42, 26, 38, 22, 41, 25, 37, 21,
];
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const t = clamp(v); return t * t * (3 - 2 * t); };

export function inCursor(x: number, y: number): boolean {
  const points = [[0, 0], [1, .44], [.59, .59], [.39, 1]];
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The same ordered thresholds generate the static fallback and interactive grains.
export function pixelAt(kind: Artwork, gx: number, gy: number, width: number, height: number): number {
  const x = gx * 2 / width;
  const y = gy * 2 / height;
  const fract = (value: number) => value - Math.floor(value);
  const threshold = fract(52.9829189 * fract(gx * .06711056 + gy * .00583715));
  const colorThreshold = (bayer[((gy + 3) & 7) * 8 + ((gx + 5) & 7)] + .5) / 64;
  let density = 0;
  let pink = 0;

  if (kind === 'cursor') {
    if (!inCursor((x - .13) / .74, (y - .07) / .86)) return 0;
    density = .98 - .12 * x;
    pink = smooth((x + y * .48 - .4) / .65);
  } else {
    const center = .22 + .48 * smooth(x / .95);
    const distance = (y - center) / .16;
    const taper = 1 - smooth((x - .32) / .53);
    density = .8 * Math.exp(-distance * distance * 1.5) * taper;
    pink = smooth(distance * .55 + .5);
  }

  if (density < 1 / 256 || density <= threshold) return 0;
  return pink > colorThreshold ? 2 : 1;
}

export function springGrain(position: number, velocity: number, home: number, force: number, dt: number) {
  const nextVelocity = (velocity + ((home - position) * 100 + force) * dt) * Math.exp(-10 * dt);
  return { position: position + nextVelocity * dt, velocity: nextVelocity };
}
