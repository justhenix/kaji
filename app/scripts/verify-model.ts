import { NativeSession } from "../agent/native-session";
import { Harness } from "../agent/harness";
import { gatewayProvider } from "../agent/gateway";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const index = Bun.argv.indexOf("--hwnd"), hwnd = Number(Bun.argv[index + 1]);
if (index < 0 || !Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error("Pass a current Calculator --hwnd");
const provider = gatewayProvider(process.env.KAJI_GATEWAY_TOKEN ?? "", process.env.KAJI_GATEWAY_URL);
const native = await NativeSession.open(hwnd, true, undefined, "agent");
const harness = new Harness(native, provider.model, provider.streamFn, { turns: 8, calls: 16, milliseconds: 120000 });
const report: any = { time: new Date().toISOString(), model: provider.model.id, providerInference: true, checks: [] };
const display = (snapshot: any) => {
  const result = snapshot.elements.find((e: any) => e.automation_id === "150" || e.automation_id === "CalculatorResults");
  if (!result) throw new Error("Calculator result control was not found");
  return String(result.value ?? result.name).trim();
};
try {
  const before = await native.request("inspect");
  if (before.title !== "Calculator") throw new Error("Only the test Calculator window may be used");
  const initial = display(before), status = await native.status();
  const result = await harness.prompt("On this authorized Calculator window only: inspect, point at button 7, invoke it exactly once, then inspect and report the observed display change. Do not invoke any other button or retry an action. Use the native semantic action, no physical cursor movement.");
  const after = await native.request("inspect"), final = await native.status();
  const observed = display(after);
  report.result = { state: result.state, answer: result.answer, error: result.error };
  report.checks.push({ check: "real model, native action, independently verified Calculator effect", status: final.actions === 1 && initial !== observed && observed.replace(/[,.\s]/g, "").endsWith("7") && result.state === "finished" ? "PASS" : "FAIL", evidence: { initial, observed, actions: final.actions, backend: final.last_backend } });
  report.checks.push({ check: "physical cursor and foreground preserved", status: JSON.stringify(status.physical_cursor) === JSON.stringify(final.physical_cursor) && status.foreground_hwnd === final.foreground_hwnd ? "PASS" : "FAIL", evidence: { before: { cursor: status.physical_cursor, foreground: status.foreground_hwnd }, after: { cursor: final.physical_cursor, foreground: final.foreground_hwnd } } });
  if (report.checks.some((c: any) => c.status !== "PASS")) process.exitCode = 1;
} catch (e) { report.checks.push({ status: "FAIL", error: String(e) }); process.exitCode = 1; }
finally {
  const stopped = await harness.close(); report.checks.push({ check: "safe stop", status: stopped.phase === "stopped" ? "PASS" : "FAIL", session: stopped.session });
  await mkdir(resolve(import.meta.dir, "../verification"), { recursive: true });
  await Bun.write(resolve(import.meta.dir, "../verification/model.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
