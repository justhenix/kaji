import { expect, test } from "bun:test";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { NativeSession, type NativeStatus, type Transport } from "./native-session";
import { Harness, computerTools } from "./harness";
import { scriptedStream, toolCall } from "./test-support";

function transport() {
  const calls: Record<string, unknown>[] = [];
  const status: NativeStatus = { session: 7, phase: "active", reason: "active", hwnd: 123, cursor: null, physical_cursor: null, foreground_hwnd: 0, last_backend: null, actions: 0, inspection_required: false, verification_pending: false, last_outcome: null };
  const client: Transport = {
    request: async c => {
      calls.push(c);
      if (c.command === "pause") status.phase = "paused";
      if (c.command === "resume") { status.phase = "active"; status.inspection_required = true; }
      if (c.command === "stop") status.phase = "stopped";
      if (c.command === "invoke") { status.verification_pending = true; status.actions++; }
      if (c.command === "inspect") { status.verification_pending = false; status.inspection_required = false; }
      return { ...status };
    }, close: async () => {},
  };
  return { client, status, calls };
}
const model = groqProvider().getModels()[0]!;

test("already cancelled requests never dispatch native work", async () => {
  const t = transport(), native = await NativeSession.open(123, false, t.client);
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(native.request("invoke", { revision: 1 }, controller.signal)).rejects.toThrow("cancelled");
  expect(t.calls.map(c => c.command)).toEqual(["begin"]);
});
test("in-flight cancellation waits for native barrier even if action replies first", async () => {
  let finishAction!: (value: unknown) => void, finishPause!: (value: unknown) => void;
  const t = transport();
  t.client.request = async c => c.command === "begin" ? t.status : c.command === "pause" ? new Promise(r => { finishPause = r; }) : new Promise(r => { finishAction = r; });
  const native = await NativeSession.open(123, true, t.client), controller = new AbortController();
  let settled = false;
  const pending = native.request("invoke", { revision: 1 }, controller.signal).then(() => { settled = true; }, e => { settled = true; throw e; });
  controller.abort(new Error("cancelled")); finishAction({ accepted: true });
  await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
  finishPause({ phase: "paused" });
  await expect(pending).rejects.toThrow("cancelled");
});
test("native session fields cannot be overridden by tool arguments", async () => {
  const t = transport(), native = await NativeSession.open(123, false, t.client);
  await native.request("point", { session: 999, command: "begin", element_id: "token" });
  expect(t.calls.at(-1)).toEqual({ command: "point", session: 7, element_id: "token" });
  expect(computerTools(native).map(t => t.name)).toEqual(["desktop_inspect", "cursor_point", "cursor_invoke", "session_status"]);
});
test("real Pi loop reports accepted actions without observation as unverified", async () => {
  const t = transport(), native = await NativeSession.open(123, true, t.client);
  const harness = new Harness(native, model, scriptedStream((_context, turn) => turn === 0 ? toolCall("cursor_invoke", { revision: 1 }) : [{ type: "text", text: "Done" }]));
  const result = await harness.prompt("Invoke and verify");
  expect(result.state).toBe("unverified");
  expect(t.status.actions).toBe(1);
  await harness.close();
});
test("Pi tool budget terminates a repeated tool loop", async () => {
  const t = transport(), native = await NativeSession.open(123, false, t.client);
  const harness = new Harness(native, model, scriptedStream(() => toolCall("session_status")), { turns: 10, calls: 2, milliseconds: 3000 });
  expect((await harness.prompt("Inspect" )).state).toBe("budget_exhausted");
  expect(harness.agent.state.messages.filter(m => m.role === "toolResult")).toHaveLength(3);
  await harness.close();
});
test("paused Pi task retains transcript and explicitly resumes through inspection", async () => {
  const t = transport(), native = await NativeSession.open(123, false, t.client);
  let turn = 0;
  const harness = new Harness(native, model, scriptedStream(() => {
    if (turn++ === 0) { t.status.phase = "paused"; return toolCall("desktop_inspect"); }
    return turn === 2 ? toolCall("desktop_inspect") : [{ type: "text", text: "Observed the current state" }];
  }));
  expect((await harness.prompt("Inspect" )).state).toBe("paused");
  const count = harness.agent.state.messages.length;
  expect((await harness.resume()).state).toBe("finished");
  expect(harness.agent.state.messages.length).toBeGreaterThan(count);
  expect(t.calls.filter(c => c.command === "resume")).toHaveLength(1);
  expect(t.calls.some(c => c.command === "inspect")).toBe(true);
  await harness.close();
});
