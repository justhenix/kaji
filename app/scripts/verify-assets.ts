import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
// @ts-ignore Playwright is installed in the web workspace.
import { chromium, type Route } from '../../web/node_modules/@playwright/test/index';

const root = resolve(import.meta.dir, '..');
const dist = resolve(root, 'dist');
const wasm = [...new Bun.Glob('wasm/*').scanSync({ cwd: dist })].map(path => path.replaceAll('\\', '/')).sort();
assert.deepEqual(wasm, [
  'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm',
  'wasm/vision_wasm_nosimd_internal.js', 'wasm/vision_wasm_nosimd_internal.wasm',
]);
assert.equal([...new Bun.Glob('**/*.{map,pdb,test.*,spec.*}').scanSync({ cwd: dist })].length, 0);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/') return new Response('<!doctype html><html><body></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (path === '/vision-bundle.mjs') return new Response(Bun.file(resolve(root, 'node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')));
  const target = resolve(dist, path.slice(1));
  if (!target.startsWith(dist + sep)) return new Response(null, { status: 404 });
  const file = Bun.file(target);
  return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const fallback of [false, true]) {
    const page = await browser.newPage();
    const missing: string[] = [];
    page.on('response', (response: { status(): number; url(): string }) => { if (response.status() >= 400) missing.push(response.url()); });
    await page.route('**/*', (route: Route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    const result = await page.evaluate(async ({ origin, fallback }: { origin: string; fallback: boolean }) => {
      const { FaceLandmarker, FilesetResolver } = await import(`${origin}/vision-bundle.mjs`);
      const files = fallback ? {
        wasmLoaderPath: `${origin}/wasm/vision_wasm_nosimd_internal.js`,
        wasmBinaryPath: `${origin}/wasm/vision_wasm_nosimd_internal.wasm`,
      } : await FilesetResolver.forVisionTasks(`${origin}/wasm`);
      const detector = await FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: `${origin}/face_landmarker.task`, delegate: 'CPU' },
        runningMode: 'VIDEO', numFaces: 2,
      });
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        canvas.getContext('2d')!.fillRect(0, 0, 128, 128);
        return { faces: detector.detectForVideo(canvas, performance.now()).faceLandmarks.length, loader: files.wasmLoaderPath };
      } finally { detector.close(); }
    }, { origin, fallback });
    assert.equal(result.faces, 0);
    assert.deepEqual(missing, []);
    console.log(`PASS: packaged ${fallback ? 'non-SIMD fallback' : 'default'} vision loader initializes and runs inference without a camera.`);
    await page.close();
  }
} finally {
  await browser.close();
  server.stop(true);
}
