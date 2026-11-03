import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureModel } from "./assets";

const root = resolve(import.meta.dir, "..");
const out = resolve(root, "dist");

// 1. Directories
await mkdir(resolve(out, "wasm"), { recursive: true });
await mkdir(resolve(out, "fonts"), { recursive: true });
await mkdir(resolve(out, "art"), { recursive: true });
await mkdir(resolve(out, "logo"), { recursive: true });
await mkdir(resolve(out, "styles"), { recursive: true });

// 2. MediaPipe WASM and model
await cp(resolve(root, "node_modules/@mediapipe/tasks-vision/wasm"), resolve(out, "wasm"), { recursive: true });
await cp(await ensureModel(), resolve(out, "face_landmarker.task"));

// 3. Fonts and Icons
await cp(
  resolve(root, "../node_modules/.bun/@fontsource-variable+figtree@5.3.0/node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2"),
  resolve(out, "fonts/figtree-latin-wght-normal.woff2")
);
await cp(
  resolve(root, "../node_modules/.bun/@fontsource-variable+inter@5.3.0/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
  resolve(out, "fonts/inter-latin-wght-normal.woff2")
);
await cp(
  resolve(root, "../node_modules/.bun/remixicon@4.9.1/node_modules/remixicon/fonts/remixicon.css"),
  resolve(out, "fonts/remixicon.css")
);
await cp(
  resolve(root, "../node_modules/.bun/remixicon@4.9.1/node_modules/remixicon/fonts/remixicon.woff2"),
  resolve(out, "fonts/remixicon.woff2")
);

// 4. Art and Logos
await cp(resolve(root, "../web/public/art/sweep.png"), resolve(out, "art/sweep.png"));
await cp(resolve(root, "../logo/kaji-mark.svg"), resolve(out, "logo/kaji-mark.svg"));
await cp(resolve(root, "../logo/kaji-logo.svg"), resolve(out, "logo/kaji-logo.svg"));

// 5. Styles
await cp(resolve(root, "src/gui/styles"), resolve(out, "styles"), { recursive: true });

// 6. Bundled JavaScript Entry Points
const buildSensor = await Bun.build({
  entrypoints: [resolve(root, "src/sensor.ts")],
  outdir: out,
  target: "browser",
  minify: false,
});
if (!buildSensor.success) throw new AggregateError(buildSensor.logs, "Sensor build failed");

const buildWorker = await Bun.build({
  entrypoints: [resolve(root, "src/vision.worker.ts")],
  outdir: out,
  target: "browser",
  format: "iife",
  minify: false,
});
if (!buildWorker.success) throw new AggregateError(buildWorker.logs, "Vision worker build failed");

const buildMain = await Bun.build({
  entrypoints: [resolve(root, "src/gui/mainApp.ts")],
  outdir: out,
  naming: "main.[ext]",
  target: "browser",
  minify: false,
});
if (!buildMain.success) throw new AggregateError(buildMain.logs, "Main app build failed");

const buildSettings = await Bun.build({
  entrypoints: [resolve(root, "src/gui/settingsApp.ts")],
  outdir: out,
  naming: "settings.[ext]",
  target: "browser",
  minify: false,
});
if (!buildSettings.success) throw new AggregateError(buildSettings.logs, "Settings app build failed");

const buildComposer = await Bun.build({
  entrypoints: [resolve(root, "src/gui/composerApp.ts")],
  outdir: out,
  naming: "composer.[ext]",
  target: "browser",
  minify: false,
});
if (!buildComposer.success) throw new AggregateError(buildComposer.logs, "Composer build failed");

// 7. HTML Entry Points
await Bun.write(
  resolve(out, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Kaji</title>
  <link rel="icon" href="/logo/kaji-mark.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/fonts/remixicon.css" />
  <link rel="stylesheet" href="/styles/theme.css" />
  <link rel="stylesheet" href="/styles/main-window.css" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/main.js"></script>
</body>
</html>`
);

await Bun.write(
  resolve(out, "settings.html"),
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Kaji - Settings</title>
  <link rel="icon" href="/logo/kaji-mark.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/fonts/remixicon.css" />
  <link rel="stylesheet" href="/styles/theme.css" />
  <link rel="stylesheet" href="/styles/settings-window.css" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/settings.js"></script>
</body>
</html>`
);

await Bun.write(
  resolve(out, "sensor.html"),
  `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Kaji sensor</title>
</head>
<body>
  <script type="module" src="/sensor.js"></script>
</body>
</html>`
);

await Bun.write(resolve(out, 'composer.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Kaji</title>
  <link rel="icon" href="/logo/kaji-mark.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/fonts/remixicon.css" />
  <link rel="stylesheet" href="/styles/theme.css" />
  <link rel="stylesheet" href="/styles/composer.css" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/composer.js"></script>
</body>
</html>`);

console.log("Built composer, main and settings GUI, sensor, MediaPipe WASM, and design assets.");
