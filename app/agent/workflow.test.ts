import { expect, test } from "bun:test";
import { NativeSession, type NativeStatus, type Transport } from "./native-session";
import { Workflow, type Step } from "./workflow";

const step: Step = { instruction: "Press 7", target: { name: "7", control_type: 50000 }, action: { kind: "invoke" }, expect: { target: { automation_id: "result" }, property: "value", equals: "7" } };
async function fixture(mode: "guide" | "assist") {
  let value = "0", generation = 0;
  const calls: Record<string, unknown>[] = [];
  const status: NativeStatus = { session: 7, phase: "active", reason: "", hwnd: 123, mode, confirmation: null, cursor: null, physical_cursor: null, foreground_hwnd: 0, last_backend: null, actions: 0, inspection_required: true, verification_pending: false, last_outcome: null };
  const button = { name: "7", control_type: 50000, automation_id: "seven", identity: {}, enabled: true, offscreen: false, rect: { left: 0, top: 0, right: 20, bottom: 20 } };
  let duplicate = false;
  const transport: Transport = { async request(c) {
    calls.push(c);
    if (c.command === "inspect") {
      generation++; status.confirmation = null; status.inspection_required = false;
      return { elements: [{ ...button, id: `b${generation}` }, ...(duplicate ? [{ ...button, id: "duplicate" }] : []), { id: "result", automation_id: "result", name: "Result", value, control_type: 50004 }], truncated: false };
    }
    if (c.command === "point") return { revision: generation, point: { x: 10, y: 10 } };
    if (c.command === "act") status.confirmation = { id: `approval${generation}`, revision: generation, element_id: `b${generation}`, target_name: "7", action: { kind: "invoke" } };
    if (c.command === "confirm") { status.actions++; value = "7"; status.confirmation = null; status.verification_pending = true; }
    if (c.command === "pause") { status.phase = "paused"; status.confirmation = null; }
    if (c.command === "resume") status.phase = "active";
    if (c.command === "stop") status.phase = "stopped";
    return structuredClone(status);
  }, async close() {} };
  const native = await NativeSession.open(123, mode === "assist", transport, mode);
  return { workflow: new Workflow(native), native, calls, transport, status, setValue: (v: string) => { value = v; }, duplicate: () => { duplicate = true; } };
}

test("Guide observes the user effect, never executes and cannot advance early", async () => {
  const f = await fixture("guide");
  expect((await f.workflow.start([step])).phase).toBe("awaiting_user");
  expect((await f.workflow.verify()).phase).toBe("awaiting_user");
  f.setValue("7");
  const verified = await f.workflow.verify();
  expect(verified.evidence).toEqual({ before: "0", after: "7", outcome: "changed" });
  expect((await f.workflow.advance()).phase).toBe("complete");
  expect(f.calls.some(c => ["act", "invoke", "confirm"].includes(c.command as string))).toBeFalse();
});
test("Assist stages, confirms once, verifies separately and rejects replay", async () => {
  const f = await fixture("assist");
  const ready = await f.workflow.start([step]);
  expect(ready.phase).toBe("awaiting_confirmation"); expect(f.status.actions).toBe(0);
  expect((await f.workflow.confirm(ready.confirmation!.id)).phase).toBe("verifying");
  expect(f.status.actions).toBe(1);
  expect((await f.workflow.verify()).phase).toBe("verified");
  expect((await f.workflow.advance()).phase).toBe("complete");
  await expect(f.workflow.confirm(ready.confirmation!.id)).rejects.toThrow();
  expect(f.status.actions).toBe(1);
});
test("postconditions already satisfied are reported without dispatch", async () => {
  const f = await fixture("assist"); f.setValue("7");
  const state = await f.workflow.start([step]);
  expect(state.phase).toBe("verified"); expect(state.evidence?.outcome).toBe("already_satisfied");
  expect(f.calls.some(c => c.command === "act")).toBeFalse();
});
test("ambiguous grounding and unverified step advancement fail closed", async () => {
  const f = await fixture("guide"); f.duplicate();
  await expect(f.workflow.start([step])).rejects.toThrow("ambiguous");
  expect(f.workflow.status().phase).toBe("blocked");
  expect(f.calls.some(c => c.command === "point")).toBeFalse();
  const another = await fixture("guide"); await another.workflow.start([step]);
  await expect(another.workflow.advance()).rejects.toThrow("Verify");
});
test("resuming a dispatched but unverified effect never executes it again", async () => {
  const f = await fixture("assist"); const ready = await f.workflow.start([step]);
  await f.workflow.confirm(ready.confirmation!.id); f.setValue("0");
  await f.workflow.pause(); expect((await f.workflow.resume()).phase).toBe("verifying");
  expect((await f.workflow.verify()).phase).toBe("verifying");
  expect(f.calls.filter(c => c.command === "act")).toHaveLength(1);
  expect(f.calls.filter(c => c.command === "confirm")).toHaveLength(1);
});
test("stop during delayed inspection cannot publish a late active workflow", async () => {
  const f = await fixture("guide"), original = f.transport.request;
  let finish!: (value: unknown) => void;
  f.transport.request = async c => c.command === "inspect" ? new Promise(r => { finish = r; }) : original(c);
  const starting = f.workflow.start([step]);
  while (!finish) await Bun.sleep(1);
  await f.workflow.stop(); finish({ elements: [], truncated: false });
  await expect(starting).rejects.toThrow("cancelled");
  expect(f.workflow.status().phase).toBe("stopped");
  expect(f.calls.some(c => c.command === "point")).toBeFalse();
});
