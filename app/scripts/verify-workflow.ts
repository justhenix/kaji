import { NativeSession } from "../agent/native-session";
import { Workflow, type Step } from "../agent/workflow";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const index = Bun.argv.indexOf("--hwnd"), hwnd = Number(Bun.argv[index + 1]);
if (index < 0 || !Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error("Pass a current Calculator --hwnd");
const sessions: NativeSession[] = [], checks: unknown[] = [];
const open = async (actions: boolean, mode: "guide" | "assist" | "agent") => { const native = await NativeSession.open(hwnd, actions, undefined, mode); sessions.push(native); return native; };
const record = (check: string, evidence: unknown) => { checks.push({ check, status: "PASS", evidence }); };
try {
  const native = await open(true, "assist");
  const initial = await native.request("inspect");
  if (initial.title !== "Calculator") throw new Error("Only the test Calculator may be used");
  const seven = initial.elements.find((e: any) => e.control_type === 50000 && (e.name === "7" || /seven/i.test(e.name)) && e.supports_invoke);
  const clear = initial.elements.find((e: any) => e.control_type === 50000 && (e.name === "C" || /^clear$/i.test(e.name)) && e.supports_invoke);
  const result = initial.elements.find((e: any) => e.automation_id === "158");
  if (!seven?.automation_id || !clear?.automation_id || !result?.automation_id) throw new Error("Test requires legacy Calculator's C, 7 and numeric display control");
  const step = (instruction: string, button: any, value: string): Step => ({ instruction, target: { automation_id: button.automation_id, control_type: 50000 }, action: { kind: "invoke" }, expect: { target: { automation_id: result.automation_id }, property: "name", equals: value } });
  const workflow = new Workflow(native);
  let state = await workflow.start([step("Clear the test Calculator", clear, "0"), step("Press Calculator 7 exactly once", seven, "7")]);
  let confirmations = 0;
  for (let attempts = 0; attempts < 20 && state.phase !== "complete"; attempts++) {
    if (state.phase === "awaiting_confirmation") {
      if ((await native.status()).actions !== confirmations) throw new Error("Assist executed before a host confirmation");
      state = await workflow.confirm(state.confirmation!.id); confirmations++;
    } else if (state.phase === "verifying") { state = await workflow.verify(); if (state.phase === "verifying") await Bun.sleep(100); }
    else if (state.phase === "verified") state = await workflow.advance();
    else throw new Error(`Unexpected workflow state: ${JSON.stringify(state)}`);
  }
  if (state.phase !== "complete") throw new Error("Assist workflow did not verify all postconditions");
  record("real Assist workflow: no effect before confirmation, execute once, verify, advance", { state, confirmations, native: await native.status() });
  await workflow.stop(); await native.close();

  const guideNative = await open(false, "guide"), guide = new Workflow(guideNative);
  const ready = await guide.start([step("Press Calculator 7", seven, "77")]);
  if (ready.phase !== "awaiting_user") throw new Error("Guide did not await an external action");
  const unchanged = await guide.verify(); if (unchanged.phase !== "awaiting_user") throw new Error("Guide advanced before observing the effect");
  const external = await open(true, "agent"), snapshot = await external.request("inspect");
  const target = snapshot.elements.find((e: any) => e.automation_id === seven.automation_id);
  const cursor = await external.request("point", { element_id: target.id });
  await external.request("invoke", { revision: cursor.revision });
  await external.stop(); await external.close();
  state = await guide.verify(); if (state.phase !== "verified" || state.evidence?.after !== "77") throw new Error("Guide did not observe the actual external Calculator effect");
  state = await guide.advance();
  if ((await guideNative.status()).actions !== 0 || state.phase !== "complete") throw new Error("Guide executed or failed to finish");
  record("real Guide workflow observes external effect without executing", { state, source: "separate explicitly scoped native test executor; human interaction NOT TESTED", actions: (await guideNative.status()).actions });
  await guide.stop();
} catch (e) { checks.push({ status: "FAIL", error: String(e) }); process.exitCode = 1; }
finally {
  for (const native of sessions.reverse()) { try { await native.stop(); } catch {} await native.close(); }
  await mkdir(resolve(import.meta.dir, "../verification"), { recursive: true });
  await Bun.write(resolve(import.meta.dir, "../verification/workflow.json"), JSON.stringify({ time: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify(checks, null, 2));
}
