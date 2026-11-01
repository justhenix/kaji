import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureModel } from "./assets";

const root = resolve(import.meta.dir, "..");
const out = resolve(root, "dist");
await mkdir(resolve(out, "wasm"), { recursive: true });
await cp(resolve(root, "node_modules/@mediapipe/tasks-vision/wasm"), resolve(out, "wasm"), { recursive: true });
await cp(await ensureModel(), resolve(out, "face_landmarker.task"));
const build = await Bun.build({ entrypoints: [resolve(root, "src/sensor.ts")], outdir: out, target: "browser", minify: false });
if (!build.success) throw new AggregateError(build.logs, "Sensor build failed");
const worker = await Bun.build({ entrypoints: [resolve(root, "src/vision.worker.ts")], outdir: out, target: "browser", format: "iife", minify: false });
if (!worker.success) throw new AggregateError(worker.logs, "Vision worker build failed");
await Bun.write(resolve(out, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><title>Kaji sensor</title></head><body><script type="module" src="/sensor.js"></script></body></html>');
console.log("Built bundled sensor, MediaPipe WASM, and verified model.");
