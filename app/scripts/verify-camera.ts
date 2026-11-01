import { DiagnosticClient } from "./diagnostic-client";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const seconds = 20;
const client = new DiagnosticClient("kaji", ["--camera", "--enable-input", "--seconds", String(seconds + 5), "--stdio"]);
const observations: unknown[] = [];
let maximumFrames = 0;
try {
  for (let i = 0; i < seconds; i++) {
    await Bun.sleep(1000);
    const status = await client.request({ command: "status" });
    observations.push(status); maximumFrames = Math.max(maximumFrames, status.frames);
    console.log(JSON.stringify(status));
    if (status.session > 0 && status.phase === "stopped") break;
  }
  const status = await client.request({command:"stop"});
  observations.push({ check: "native stop", status });
  if (maximumFrames < 10) { process.exitCode = 1; console.error("Camera inference verification failed: fewer than ten frames reached Rust"); }
} catch (error) { observations.push({ error: String(error) }); process.exitCode = 1; }
finally {
  await client.close();
  const stderr = await client.stderr;
  console.error(stderr);
  await mkdir(resolve(import.meta.dir, "../verification"), { recursive: true });
  await Bun.write(resolve(import.meta.dir, "../verification/camera.json"), JSON.stringify({ time: new Date().toISOString(), maximumFrames, observations, stderr }, null, 2));
}
