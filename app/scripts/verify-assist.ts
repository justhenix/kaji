import { NativeSession } from "../agent/native-session";
import { Harness } from "../agent/harness";
import { scriptedStream, toolCall, lastToolValue } from "../agent/test-support";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const hwndIndex = Bun.argv.indexOf("--hwnd");
const hwnd = hwndIndex < 0 ? NaN : Number(Bun.argv[hwndIndex + 1]);
if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error("Pass Calculator's current --hwnd");
const results: unknown[] = [];
const record = (check: string, evidence: unknown) => { const result = { check, status: "PASS", evidence }; results.push(result); console.log(JSON.stringify(result)); };
let native: NativeSession | undefined, harness: Harness | undefined;
try {
  native = await NativeSession.open(hwnd);
  let snapshot = await native.request("inspect");
  if (snapshot.title !== "Calculator") throw new Error("Target must be Calculator");
  const find7 = (s: any) => s.elements.find((e: any) => e.control_type === 50000 && (e.name === "7" || /seven/i.test(e.name)) && e.identity && e.rect && e.supports_invoke);
  const display = (s: any) => {
    const e = s.elements.find((e: any) => e.automation_id === "150" || e.automation_id === "CalculatorResults");
    return String(e?.value ?? e?.name ?? "").trim();
  };
  let button = find7(snapshot);
  if (!button) throw new Error("Calculator 7 does not expose UIA Invoke");
  const original = await native.status();
  const cursor = await native.request("point", { element_id: button.id });
  const pointed = await native.status();
  if (JSON.stringify(original.physical_cursor) !== JSON.stringify(pointed.physical_cursor)) throw new Error("Pointing moved the physical cursor");
  record("logical cursor does not move Windows cursor", { intent: cursor, physical: pointed.physical_cursor });
  try { await native.request("invoke", { revision: cursor.revision }); throw new Error("permission was bypassed"); }
  catch (error) { if (!String(error).includes("--enable-actions")) throw error; record("default actions denied", String(error)); }
  await native.close(); native = undefined;

  native = await NativeSession.open(hwnd, true);
  const before = await native.status();
  let beforeValue = "", afterValue = "";
  const model = groqProvider().getModels()[0]!;
  harness = new Harness(native, model, scriptedStream((context, turn) => {
    if (turn === 0) return toolCall("desktop_inspect");
    if (turn === 1) {
      snapshot = lastToolValue(context); beforeValue = display(snapshot); button = find7(snapshot);
      if (!button) throw new Error("7 became unavailable");
      return toolCall("cursor_point", { element_id: button.id });
    }
    if (turn === 2) return toolCall("cursor_invoke", { revision: lastToolValue(context).revision });
    if (turn === 3) return toolCall("desktop_inspect");
    afterValue = display(lastToolValue(context));
    if (beforeValue === afterValue || !afterValue.endsWith("7")) throw new Error(`Calculator did not change as expected: ${beforeValue} -> ${afterValue}`);
    return [{ type: "text", text: `Observed Calculator change ${beforeValue} -> ${afterValue}` }];
  }));
  const result = await harness.prompt("Invoke Calculator's 7 once and verify its result");
  const after = await native.status();
  if (result.state !== "finished" || after.actions !== 1 || after.verification_pending) throw new Error(`Pi/native completion failed: ${JSON.stringify(result)}`);
  if (JSON.stringify(before.physical_cursor) !== JSON.stringify(after.physical_cursor)) throw new Error("Background operation moved the physical cursor");
  if (before.foreground_hwnd !== after.foreground_hwnd) throw new Error("Background operation changed foreground focus");
  record("real Pi loop with scripted provider, native Invoke, real Calculator effect", { beforeValue, afterValue, actions: after.actions, physicalCursor: after.physical_cursor, foreground: after.foreground_hwnd, backgroundTarget: before.foreground_hwnd !== hwnd, providerInference: "NOT TESTED: scripted provider" });
  await native.pause();
  const paused = await native.status();
  if (paused.phase !== "paused" || paused.session !== native.id) throw new Error("Pause discarded the task's session");
  await native.resume();
  try { await native.request("point", { element_id: button.id }); throw new Error("resume reused stale grounding"); }
  catch (error) { if (!String(error).includes("inspection required")) throw error; }
  record("pause retains session; resume requires fresh inspection", await native.status());
  const stopped = await harness.close(); harness = undefined; native = undefined;
  if (stopped.phase !== "stopped") throw new Error("Stop did not revoke native execution");
  record("native stopped safely", stopped);
} catch (error) { results.push({ status: "FAIL", error: String(error) }); console.error(error); process.exitCode = 1; }
finally {
  if (harness) await harness.close(); else if (native) { await native.stop(); await native.close(); }
  await mkdir(resolve(import.meta.dir, "../verification"), { recursive: true });
  await Bun.write(resolve(import.meta.dir, "../verification/assist.json"), JSON.stringify({ time: new Date().toISOString(), results }, null, 2));
}
