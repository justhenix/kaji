import { NativeSession, type Confirmation, type NativeAction } from "./native-session";

export type Selector = { automation_id?: string; name?: string; control_type?: number };
export type Expectation = { target: Selector; property: "name" | "value" | "toggle_state" | "selected" | "horizontal_scroll_percent" | "vertical_scroll_percent"; equals: string | boolean | number };
export type Step = { instruction: string; target: Selector; action: NativeAction; expect: Expectation };
export type WorkflowState = {
  phase: "idle" | "preparing" | "awaiting_user" | "awaiting_confirmation" | "verifying" | "verified" | "complete" | "paused" | "blocked" | "stopped";
  index: number; total: number; instruction: string; reason: string;
  target: { name: string; rect: unknown; point: unknown } | null;
  confirmation: Confirmation | null;
  evidence: { before: unknown; after: unknown; outcome: "changed" | "already_satisfied" } | null;
};
type Element = { id: string; name: string; automation_id: string; control_type: number; identity: unknown; enabled: boolean; offscreen: boolean; rect: unknown; value?: string | null; toggle_state?: string | null; selected?: boolean | null; horizontal_scroll_percent?: number | null; vertical_scroll_percent?: number | null };
type Snapshot = { elements: Element[]; truncated: boolean };

function selector(value: Selector) {
  if (!value || typeof value !== "object" || !Object.keys(value).length || Object.keys(value).some(k => !["automation_id", "name", "control_type"].includes(k))
    || [value.automation_id, value.name].some(v => v !== undefined && (typeof v !== "string" || !v.length || v.length > 512))
    || value.control_type !== undefined && (!Number.isInteger(value.control_type) || value.control_type < 50000 || value.control_type > 50100)) throw new Error("Use a specific control selector");
}
function find(snapshot: Snapshot, query: Selector, actionable = false) {
  const matches = snapshot.elements.filter(e => Object.entries(query).every(([key, value]) => e[key as keyof Element] === value)
    && (!actionable || e.identity && e.enabled && !e.offscreen && e.rect));
  if (matches.length !== 1) throw new Error(matches.length ? "Target is ambiguous; refine the selector" : "Target is unavailable; inspect and recover explicitly");
  return matches[0]!;
}
function validate(steps: Step[]) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 50) throw new Error("A workflow requires 1–50 steps");
  for (const step of steps) {
    if (typeof step.instruction !== "string" || !step.instruction.trim() || step.instruction.length > 2000 || !step.action) throw new Error("Each step requires an instruction and semantic action");
    selector(step.target); selector(step.expect?.target);
    if (!["name", "value", "toggle_state", "selected", "horizontal_scroll_percent", "vertical_scroll_percent"].includes(step.expect.property)
      || (step.expect.property === "selected" ? typeof step.expect.equals !== "boolean" : step.expect.property.endsWith("scroll_percent") ? typeof step.expect.equals !== "number" || !Number.isFinite(step.expect.equals) || step.expect.equals < 0 || step.expect.equals > 100 : typeof step.expect.equals !== "string" || step.expect.equals.length > 4096)) throw new Error("Use an explicit observable postcondition");
  }
}

export class Workflow {
  private steps: Step[] = [];
  private busy = false;
  private epoch = 0;
  private before: unknown;
  private dispatched = false;
  private state: WorkflowState = { phase: "idle", index: 0, total: 0, instruction: "", reason: "", target: null, confirmation: null, evidence: null };
  constructor(readonly native: NativeSession) {}
  status() { return structuredClone(this.state); }
  private async checked<T>(request: Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const value = await request;
    if (epoch !== this.epoch) throw new Error("Workflow operation was cancelled");
    return value;
  }
  private async run(operation: () => Promise<void>) {
    if (this.busy) throw new Error("A workflow operation is already active");
    const epoch = this.epoch; this.busy = true;
    try { await operation(); }
    catch (error) {
      if (epoch === this.epoch) { this.state.phase = "blocked"; this.state.reason = String(error); this.state.confirmation = null; }
      throw error;
    } finally { this.busy = false; }
    if (epoch !== this.epoch) throw new Error("Workflow operation was cancelled");
    return this.status();
  }
  private async prepare(signal?: AbortSignal) {
    const step = this.steps[this.state.index]!;
    const status = await this.checked(this.native.status());
    if (status.phase !== "active" || !["guide", "assist"].includes(status.mode)) throw new Error("Workflow requires an active Guide or Assist native session");
    this.state.phase = "preparing"; this.state.instruction = step.instruction;
    this.state.confirmation = null; this.state.evidence = null; this.dispatched = false;
    const snapshot = await this.checked(this.native.request<Snapshot>("inspect", {}, signal));
    const expected = find(snapshot, step.expect.target);
    this.before = expected[step.expect.property];
    if (this.before === step.expect.equals) {
      this.state.phase = "verified"; this.state.target = null; this.state.reason = "Postcondition was already satisfied; no action dispatched";
      this.state.evidence = { before: this.before, after: this.before, outcome: "already_satisfied" }; return;
    }
    const target = find(snapshot, step.target, true);
    const cursor = await this.checked(this.native.request("point", { element_id: target.id }, signal));
    this.state.target = { name: target.name, rect: target.rect, point: cursor.point };
    if (status.mode === "guide") {
      this.state.phase = "awaiting_user"; this.state.reason = "User acts; verify the application effect before advancing"; return;
    }
    const staged = await this.checked(this.native.request("act", { revision: cursor.revision, action: step.action }, signal));
    if (!staged.confirmation || staged.actions !== status.actions) throw new Error("Native Assist did not stage a confirmation without dispatch");
    this.state.confirmation = staged.confirmation;
    this.state.phase = "awaiting_confirmation"; this.state.reason = "Exact native action requires host confirmation within 15 seconds";
  }
  start(steps: Step[], signal?: AbortSignal) {
    validate(steps);
    if (!["idle", "complete", "blocked"].includes(this.state.phase)) throw new Error("Finish or stop the current workflow first");
    return this.run(async () => {
      this.steps = structuredClone(steps); this.state.index = 0; this.state.total = steps.length;
      await this.prepare(signal);
    });
  }
  confirm(id: string) {
    return this.run(async () => {
      if (this.state.phase !== "awaiting_confirmation" || !id || this.state.confirmation?.id !== id) throw new Error("Confirmation does not match the current step");
      // A cancelled external effect can be unknown. Never automatically dispatch this step again.
      this.dispatched = true;
      await this.checked(this.native.confirm(id));
      this.state.confirmation = null; this.state.phase = "verifying"; this.state.reason = "Action requested once; application effect remains unverified";
    });
  }
  verify(signal?: AbortSignal) {
    return this.run(async () => {
      if (!["awaiting_user", "verifying"].includes(this.state.phase)) throw new Error("No user/action effect awaits verification");
      const native = await this.checked(this.native.status());
      if (!["active", "paused"].includes(native.phase)) throw new Error("Native session stopped");
      const snapshot = await this.checked(this.native.request<Snapshot>("inspect", {}, signal));
      const step = this.steps[this.state.index]!;
      const after = find(snapshot, step.expect.target)[step.expect.property];
      if (after === step.expect.equals && after !== this.before) {
        this.state.phase = "verified"; this.state.reason = "Observed the expected application change"; this.state.target = null;
        this.state.evidence = { before: this.before, after, outcome: "changed" }; return;
      }
      this.state.reason = "Expected application change has not been observed; no retry dispatched";
      if (!this.dispatched && native.phase === "active") {
        const target = find(snapshot, step.target, true);
        const cursor = await this.checked(this.native.request("point", { element_id: target.id }, signal));
        this.state.target = { name: target.name, rect: target.rect, point: cursor.point };
      }
    });
  }
  advance(signal?: AbortSignal) {
    return this.run(async () => {
      if (this.state.phase !== "verified") throw new Error("Verify the current postcondition before advancing");
      if (this.state.index + 1 === this.steps.length) { this.state.phase = "complete"; this.state.reason = "All explicit postconditions verified"; return; }
      this.state.index++; await this.prepare(signal);
    });
  }
  async pause() {
    this.epoch++; await this.native.pause();
    this.state.phase = "paused"; this.state.confirmation = null; this.state.target = null; this.state.reason = "Explicitly paused";
    return this.status();
  }
  resume(signal?: AbortSignal) {
    return this.run(async () => {
      if (!["paused", "blocked"].includes(this.state.phase)) throw new Error("Workflow is not paused or blocked");
      const native = await this.checked(this.native.status());
      if (native.phase === "paused") await this.checked(this.native.resume());
      else if (native.phase !== "active") throw new Error("Stopped sessions cannot resume");
      if (this.dispatched) { this.state.phase = "verifying"; this.state.reason = "Previous action may have executed; inspect its effect before any new step"; }
      else await this.prepare(signal);
    });
  }
  async stop() {
    this.epoch++; const native = await this.native.stop();
    this.state.phase = "stopped"; this.state.confirmation = null; this.state.target = null; this.state.reason = native.reason;
    return this.status();
  }
}
