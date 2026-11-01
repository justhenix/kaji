import { DiagnosticClient } from "./diagnostic-client";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const hwnd = Number(Bun.argv[Bun.argv.indexOf("--hwnd") + 1]);
if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error("Pass --hwnd with Calculator's current HWND; keep it in the foreground.");
const replay = Bun.argv.includes("--replay");
const client = new DiagnosticClient("kaji-diag", replay ? ["--enable-input", "--allow-replay"] : []);
const results: { check: string; status: string; evidence: unknown }[] = [];
const record = (check: string, status: string, evidence: unknown) => { const row = { check, status, evidence }; results.push(row); console.log(JSON.stringify(row)); };
try {
  let snapshot = await client.request({ command: "inspect", hwnd });
  if (snapshot.title !== "Calculator") throw new Error("Target is not Calculator");
  const beforeDisplay = snapshot.elements.find((e: any) => e.automation_id === "150" || e.automation_id === "CalculatorResults");
  const beforeValue = String(beforeDisplay?.value ?? beforeDisplay?.name ?? "").trim();
  const button = snapshot.elements.find((e: any) => e.control_type === 50000 && (e.name === "7" || /seven/i.test(e.name)) && e.clickable);
  if (!button) throw new Error("A real clickable 7 button was not found");
  record("Calculator discovery", "PASS", { title: snapshot.title, nodes: snapshot.elements.length, truncated: snapshot.truncated, button });
  const fresh = await client.request({ command: "resolve", element_id: button.id });
  record("fresh element resolution", "PASS", { name: fresh.name, rect: fresh.rect, clickable: fresh.clickable });
  await client.request({ command: "inspect", hwnd });
  try { await client.request({ command: "resolve", element_id: button.id }); throw new Error("superseded token was accepted"); }
  catch (error) { if (!String(error).includes("superseded")) throw error; record("superseded token rejected", "PASS", String(error)); }
  const inspection = client.request({ command: "inspect", hwnd }).then(() => "completed", e => String(e));
  await Bun.sleep(30);
  const stopAt = performance.now(); await client.request({ command: "stop" });
  const stopMs = performance.now() - stopAt;
  await client.request({ command: "cancel_inspection" });
  const cancelled = await inspection;
  if (!cancelled.includes("cancelled") || stopMs > 150) throw new Error(`inspection did not cancel independently: ${cancelled}, stop ${stopMs}ms`);
  record("stop during inspection and UIA cancellation", "PASS", { stopMs, cancelled });
  if (!replay) {
    try { await client.request({ command: "begin" }); throw new Error("input permission was bypassed"); }
    catch (error) { if (!String(error).includes("--enable-input")) throw error; record("native input defaults to denied", "PASS", String(error)); }
  } else {
    // Replay tests native motion/dwell/application effects, without claiming webcam validation.
    const session = await client.request({ command: "begin", hwnd, config: { dwell_ms: 1200, dwell_radius: 9, max_speed: 400, dead_zone: 0.035, range: 0.28 } });
    const offset = session.now_ms - performance.now(); let sequence = 0;
    const send = async (yaw = 0, pitch = 0, faces = 1) => {
      try { return await client.request({ command: "frame", frame: { session: session.id, sequence: ++sequence, captured_ms: performance.now() + offset, yaw, pitch, faces } }); }
      catch (error) { throw new Error(`${String(error)}; native status: ${JSON.stringify(await client.request({command:"status"}))}`); }
    };
    const start = performance.now();
    while (performance.now() - start < 1150) { await Bun.sleep(33); await send(); }
    let status = await client.request({ command: "status" });
    if (status.phase !== "tracking") throw new Error(`calibration failed: ${JSON.stringify(status)}`);
    const departureStart = performance.now();
    while (performance.now() - departureStart < 400) { await Bun.sleep(33); await send(-0.19, 0); }
    const position = (await client.request({command:"status"})).cursor;
    const root = snapshot.elements[0]?.rect;
    if (root && (position.x < root.left || position.x >= root.right || position.y < root.top || position.y >= root.bottom)) {
      const hoverStart = performance.now();
      while(performance.now()-hoverStart<1500) {await Bun.sleep(33);await send();}
      const outside=await client.request({command:"status"});
      if(outside.phase!=="tracking" || outside.clicks!==0) throw new Error(`outside-target hover must preserve tracking and suppress clicks: ${JSON.stringify(outside)}`);
      record("outside-target dwell is suppressed without stopping tracking","PASS",outside);
    }
    const target = fresh.clickable;
    const movementStart = performance.now();
    while (performance.now() - movementStart < 15000) {
      status = await client.request({ command: "status" });
      if (status.phase !== "tracking") throw new Error(JSON.stringify(status));
      const dx = target.x - status.cursor.x, dy = target.y - status.cursor.y;
      if (Math.hypot(dx, dy) <= 4) break;
      const axis = (distance: number) => Math.abs(distance) < 3 ? 0 : Math.sign(distance) * (Math.abs(distance) < 25 ? 0.095 : 0.19);
      await Bun.sleep(33); await send(-axis(dx), axis(dy));
    }
    status = await client.request({ command: "status" });
    if (Math.hypot(target.x - status.cursor.x, target.y - status.cursor.y) > 5 || status.moves === 0) throw new Error(`cursor did not reach real button: ${JSON.stringify(status)}`);
    record("native movement from replayed head poses", "PASS", status);
    const settle = performance.now();
    while (performance.now() - settle < 1700) { await Bun.sleep(33); await send(); }
    status = await client.request({ command: "status" });
    if (status.clicks !== 1) throw new Error(`expected exactly one dwell click: ${JSON.stringify(status)}`);
    await client.request({ command: "stop" });
    snapshot = await client.request({ command: "inspect", hwnd });
    const display = snapshot.elements.find((e: any) => e.automation_id === "150" || e.automation_id === "CalculatorResults");
    const afterValue = String(display?.value ?? display?.name ?? "").trim();
    if (!display || !afterValue.endsWith("7") || afterValue === beforeValue) throw new Error(`Calculator display did not change after 7: ${JSON.stringify(display)}`);
    record("dwell changes Calculator through Win32 input", "PASS", { clicks: status.clicks, beforeValue, afterValue, display });
    try { await send(); throw new Error("stopped session accepted input"); }
    catch (error) { if (!String(error).includes("superseded")) throw error; record("stop rejects late pose samples", "PASS", String(error)); }
    const heartbeatSession = await client.request({command: "begin", hwnd});
    await client.request({command: "frame", frame: {session:heartbeatSession.id, sequence:1, captured_ms:heartbeatSession.now_ms + 1, yaw:0, pitch:0, faces:1}});
    await Bun.sleep(350);
    const expired = await client.request({command:"status"});
    if (expired.phase !== "stopped" || !expired.reason.includes("heartbeat")) throw new Error(`watchdog did not stop: ${JSON.stringify(expired)}`);
    record("native heartbeat expires without frontend help", "PASS", expired);
  }
} catch (error) { record("Windows verification", "FAIL", String(error)); process.exitCode = 1; }
finally {
  await client.close();
  await mkdir(resolve(import.meta.dir, "../verification"), { recursive: true });
  await Bun.write(resolve(import.meta.dir, `../verification/${replay ? "replay" : "inspection"}.json`), JSON.stringify({ time: new Date().toISOString(), results }, null, 2));
}
