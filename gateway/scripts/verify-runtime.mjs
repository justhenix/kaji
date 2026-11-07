import { unstable_dev } from "wrangler";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = { config: resolve(root, "wrangler.jsonc"), vars: { REASONING_DAILY_REQUEST_CAP: "200" }, local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0,
  persistTo: resolve(root, ".wrangler", `runtime-${randomUUID()}`), logLevel: "error", experimental: { disableExperimentalWarning: true, disableDevRegistry: true, forceLocal: true } };
const start = () => unstable_dev(resolve(root, "tests/budget-worker.ts"), options);
let worker = await start();
try {
  const call = (path, body) => worker.fetch(`http://budget${path}`, { method: "POST", body }).then(r => r.json());
  const pair = await Promise.all([call("/acquire"), call("/acquire")]);
  assert.deepEqual(pair.map(r => r.status).sort(), ["allowed", "busy"]);
  const first = pair.find(r => r.status === "allowed");
  await call("/release", "wrong"); assert.equal((await call("/acquire")).status, "busy");
  await call("/release", first.lease);
  for (let i = 1; i < 200; i++) {
    const acquired = await call("/acquire"); assert.equal(acquired.status, "allowed");
    await call("/release", acquired.lease);
  }
  assert.equal((await call("/acquire")).status, "daily_limit");
  await worker.stop(); worker = await start();
  assert.equal((await call("/acquire")).status, "daily_limit");
  const stt = await call("/service/reserve", JSON.stringify({ service: "stt", units: 30 }));
  assert.equal(stt.status, "allowed");
  const sttStatus = await call("/service/status", JSON.stringify({ service: "stt" }));
  assert.equal(sttStatus.requestsDay, 1); assert.equal(sttStatus.secondsDay, 30);
  const usage = { service: "tts", observedUsed: 9990, resetAt: Math.floor(Date.now() / 1000) + 86400, subscriptionCap: 10000 };
  const credits = await Promise.all([
    call("/service/reserve", JSON.stringify({ ...usage, units: 6 })),
    call("/service/reserve", JSON.stringify({ ...usage, units: 5 })),
  ]);
  assert.equal(credits.filter(result => result.status === "allowed").length, 1);
  assert.equal(credits.filter(result => result.status === "monthly_limit").length, 1);
  await worker.stop(); worker = await start();
  const persisted = await call("/service/status", JSON.stringify({ service: "tts", ...usage }));
  assert.equal(persisted.used, 9996);
  console.log("PASS: actual workerd/SQLite binding serializes owner and service quotas, rejects forged release, and persists reservations across restart. No model requests.");
} finally { await worker.stop(); }
