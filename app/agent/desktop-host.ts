import { createInterface } from "node:readline";
import type { DesktopHostInput, DesktopHostOutput, Mode, PendingQuestion, TaskPhase } from "../shared/runtime";
import { gatewayProvider } from "./gateway";
import { Harness } from "./harness";
import { NativeSession, type Transport } from "./native-session";
import { desktopTools, type Executor } from './desktop-tools';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { GATEWAY_MODELS, type GatewayModelId } from '../shared/models';

const NATIVE_TIMEOUT_MS = 30000;
const MAX_INPUT_LINE = 4 * 1024 * 1024;
const NATIVE_COMMANDS = new Set(["begin", "inspect", "point", "invoke", "act", "status", "confirm", "pause", "resume", "stop", "task_context", "select_executor", "list_windows", "list_applications", "bind_window", "document_inspect", "document_edit", "document_create", 'activate_window', 'capture_window', 'propose_physical', 'execute_physical']);

type PendingNative = { taskId: string; command: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type TaskQuestion = Omit<PendingQuestion, "taskId"> & { nativeConfirmationId?: string; desktopApprovalId?: string; guideCheck?: boolean };
type ActiveTask = {
  taskId: string;
  conversationId: string;
  mode: Mode;
  transport: DesktopTransport;
  native?: NativeSession;
  harness?: Harness;
  question: TaskQuestion | null;
  startingActions: number;
  stopped: boolean;
  managed: boolean;
};
type HarnessFactory = (native: NativeSession, askUser: (title: string) => void, tools?: AgentTool[], model?: GatewayModelId) => Harness;
type TaskControl = { type: "continue" | "pause" | "resume" | "stop"; taskId: string };

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const validId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128;

function defaultHarness(native: NativeSession, askUser: (title: string) => void, tools: AgentTool[] = [], model?: GatewayModelId): Harness {
  const provider = gatewayProvider(process.env.KAJI_GATEWAY_TOKEN ?? "", process.env.KAJI_GATEWAY_URL, model);
  return new Harness(native, provider.model, provider.streamFn, undefined, askUser, tools);
}

function validateAction(value: unknown): boolean {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case "invoke": case "select": return Object.keys(value).length === 1;
    case "set_value": return Object.keys(value).length === 2 && typeof value.value === "string" && value.value.length <= 4096;
    case "set_toggle": return Object.keys(value).length === 2 && typeof value.on === "boolean";
    case "scroll": return Object.keys(value).length === 3 && [value.horizontal, value.vertical].every(v => v === null || typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100);
    default: return false;
  }
}

function validateNativeCommand(value: unknown, sessionId: number | null, confirmationPermit: string | null): asserts value is Record<string, unknown> {
  if (!isObject(value) || typeof value.command !== "string" || !NATIVE_COMMANDS.has(value.command)) throw new Error("Native command is not allowed");
  const command = value.command;
  const fields: Record<string, string[]> = {
    begin: ["command", "hwnd", "mode"], inspect: ["command", "session"], point: ["command", "session", "element_id"],
    invoke: ["command", "session", "revision"], act: ["command", "session", "revision", "action"],
    status: ["command"], confirm: ["command", "session", "confirmation_id"],
    pause: ["command"], resume: ["command", "session"], stop: ["command"],
    task_context: ['command'], select_executor: ['command', 'executor_id'], list_windows: ['command'], list_applications: ['command'],
    bind_window: ['command', 'window_id'], document_inspect: ['command'], document_edit: ['command', 'operations'], document_create: ['command', 'blocks'],
    activate_window: ['command','window_id'], capture_window: ['command','window_id'], propose_physical: ['command','capture_id','action'], execute_physical: ['command','approval_id'],
  };
  if (Object.keys(value).some(key => !fields[command]!.includes(key))) throw new Error("Native command contains unsupported fields");
  if (['task_context', 'list_windows', 'list_applications', 'document_inspect', 'status', 'pause', 'stop'].includes(command)) return;
  if (command === 'select_executor') { if (!validId(value.executor_id)) throw new Error('Invalid executor'); return; }
  if (['bind_window','activate_window','capture_window'].includes(command)) { if (!validId(value.window_id)) throw new Error('Invalid window'); return; }
  if (command === 'propose_physical') { if (!validId(value.capture_id) || !isObject(value.action)) throw new Error('Invalid physical proposal'); return; }
  if (command === 'execute_physical') { if (value.approval_id !== confirmationPermit) throw new Error('Exact user approval is required'); return; }
  if (command === 'document_edit' || command === 'document_create') {
    const payload = command === 'document_edit' ? value.operations : value.blocks;
    if (!Array.isArray(payload) || payload.length < 1 || payload.length > 100 || JSON.stringify(payload).length > 1024 * 1024) throw new Error('Invalid document payload');
    return;
  }
  if (command === 'resume' && sessionId === null && value.session === 0) return;
  if (command === "begin") {
    if (sessionId !== null || !Number.isSafeInteger(value.hwnd) || (value.hwnd as number) <= 0 || !["guide", "assist", "agent"].includes(String(value.mode))) throw new Error("Invalid native session start");
    return;
  }
  if (sessionId === null) throw new Error("Native session is not initialized");
  if (["status", "pause", "stop"].includes(command)) return;
  if (value.session !== sessionId) throw new Error("Native session ownership mismatch");
  if (["invoke", "act"].includes(command) && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)) throw new Error("Invalid native revision");
  if (command === "point" && (typeof value.element_id !== "string" || !value.element_id || value.element_id.length > 512)) throw new Error("Invalid native target");
  if (command === "act" && !validateAction(value.action)) throw new Error("Invalid semantic action");
  if (command === "confirm") {
    if (typeof value.confirmation_id !== "string" || !value.confirmation_id || value.confirmation_id !== confirmationPermit) throw new Error("Only the matching user approval can confirm this action");
  }
}

class DesktopTransport implements Transport {
  private nextId = 0;
  private pending = new Map<string, PendingNative>();
  private closed = false;
  private sessionId: number | null;
  private confirmationPermit: string | null = null;
  documentVerified = false;
  physicalVerified = false;
  requestedDesktopWork = false;
  constructor(private readonly taskId: string, private readonly emit: (message: DesktopHostOutput) => void, sessionId?: number) {
    this.sessionId = sessionId ?? null;
  }
  authorizeConfirmation(id: string) { this.confirmationPermit = id; }
  request(command: Record<string, unknown>): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Desktop task transport is closed"));
    try { validateNativeCommand(command, this.sessionId, this.confirmationPermit); }
    catch (error) { return Promise.reject(error); }
    if (command.command !== 'status' && command.command !== 'task_context') this.requestedDesktopWork = true;
    if (['confirm','execute_physical'].includes(String(command.command))) this.confirmationPermit = null;
    const id = `${this.taskId}:${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Native request timed out"));
      }, NATIVE_TIMEOUT_MS);
      this.pending.set(id, { taskId: this.taskId, command: String(command.command), resolve, reject, timer });
      this.emit({ type: "native_request", id, taskId: this.taskId, command });
    });
  }
  respond(input: Extract<DesktopHostInput, { type: "native_response" }>) {
    const pending = this.pending.get(input.id);
    if (!pending || input.taskId !== pending.taskId) return;
    clearTimeout(pending.timer); this.pending.delete(input.id);
    if (input.error !== undefined) { pending.reject(new Error(oneLine(input.error).slice(0, 500))); return; }
    if (input.result === undefined) { pending.reject(new Error("Native response omitted its result")); return; }
    if (pending.command === 'bind_window') this.sessionId = null;
    if (pending.command === 'begin' && isObject(input.result) && Number.isSafeInteger(input.result.session)) this.sessionId = input.result.session;
    if (['document_create', 'document_edit'].includes(pending.command) && isObject(input.result) && isObject(input.result.verification) && input.result.verification.bytes > 0) this.documentVerified = true;
    if (pending.command === 'capture_window' && isObject(input.result) && input.result.changedAfterAction === true) this.physicalVerified = true;
    if (pending.command === 'execute_physical' && isObject(input.result)) this.physicalVerified = input.result.verified === true;
    if (pending.command === 'activate_window' && isObject(input.result) && input.result.verified === true) this.physicalVerified = true;
    pending.resolve(input.result);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Desktop task transport closed")); }
    this.pending.clear();
  }
}

export class DesktopHost {
  private active: ActiveTask | null = null;
  constructor(private readonly emit: (message: DesktopHostOutput) => void, private readonly createHarness: HarnessFactory = defaultHarness) {}

  dispatch(value: unknown) {
    if (!isObject(value) || typeof value.type !== "string") { this.error(undefined, "Invalid desktop host message"); return; }
    switch (value.type) {
      case "start": void this.start(value as DesktopHostInput & { type: "start" }); return;
      case "native_response": this.nativeResponse(value as DesktopHostInput & { type: "native_response" }); return;
      case "answer": void this.answer(value as DesktopHostInput & { type: "answer" }); return;
      case 'method': void this.method(value as Extract<DesktopHostInput, { type: 'method' }>); return;
      case "continue": void this.continue(value as TaskControl & { type: "continue" }); return;
      case "pause": void this.pause(value as TaskControl & { type: "pause" }); return;
      case "resume": void this.resume(value as TaskControl & { type: "resume" }); return;
      case "stop": void this.stop(value as TaskControl & { type: "stop" }); return;
      case "shutdown": void this.shutdown(); return;
      default: this.error(undefined, "Unsupported desktop host message");
    }
  }

  private error(taskId: string | undefined, message: string) { this.emit({ type: "error", ...(taskId ? { taskId } : {}), message: oneLine(message).slice(0, 500) }); }
  private async start(input: Extract<DesktopHostInput, { type: "start" }>) {
    if (this.active) { this.error(input.taskId, "Finish or stop the active task first"); return; }
    if (!validId(input.taskId) || !validId(input.conversationId) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000
      || !["guide", "assist", "agent"].includes(input.mode)) { this.error(validId(input.taskId) ? input.taskId : undefined, "Invalid task start"); return; }
    const selectedModel = input.model ?? 'deepseek-v4.1-flash';
    if (!GATEWAY_MODELS.some(model => model.id === selectedModel)) { this.error(input.taskId, 'Selected model is not enabled'); return; }
    const transport = new DesktopTransport(input.taskId, this.emit, input.nativeSessionId);
    const current: ActiveTask = { taskId: input.taskId, conversationId: input.conversationId, mode: input.mode, transport, question: null, startingActions: 0, stopped: false, managed: input.hwnd === undefined && input.nativeSessionId === undefined };
    this.active = current;
    try {
      current.native = input.nativeSessionId !== undefined
        ? await NativeSession.attach(input.nativeSessionId, transport)
        : input.hwnd !== undefined ? await NativeSession.open(input.hwnd, true, transport, input.mode) : NativeSession.managed(transport);
      const status = await current.native.status();
      current.startingActions = status.actions;
      const tools = current.managed ? desktopTools(current.native, input.mode, (options, recommended, split) => this.offerMethods(current, options, recommended, split), (id, title) => this.offerApproval(current, id, title)) : [];
      current.harness = this.createHarness(current.native, title => this.ask(current, "clarification", title), tools, selectedModel as GatewayModelId);
      this.emit({ type: "update", taskId: current.taskId, phase: "working", message: "Checking the current task context." });
      const result = await current.harness.prompt(input.text);
      await this.finishRun(current, result);
    } catch (error) {
      if (this.active === current) {
        this.error(current.taskId, error instanceof Error ? error.message : "Desktop task failed");
        await this.dispose(current);
      }
    }
  }

  private nativeResponse(input: Extract<DesktopHostInput, { type: "native_response" }>) {
    if (!validId(input.id) || !validId(input.taskId)) return;
    if (this.active?.taskId !== input.taskId) return;
    this.active.transport.respond(input);
  }

  private ask(task: ActiveTask, kind: TaskQuestion["kind"], title: string, options: TaskQuestion["options"] = [], allowCustom = true, guideCheck = false, nativeConfirmationId?: string) {
    if (task.question) throw new Error("A task question is already pending");
    const question: TaskQuestion = {
      id: crypto.randomUUID(), kind, title: oneLine(title).slice(0, 240), options, allowCustom, optional: false,
      ...(guideCheck ? { guideCheck: true } : {}),
      ...(nativeConfirmationId ? { nativeConfirmationId } : {}),
    };
    task.question = question;
    this.emit({ type: "update", taskId: task.taskId, phase: kind === "approval" ? "awaiting_confirmation" : "awaiting_user", question: this.publicQuestion(question) });
  }

  private publicQuestion(question: TaskQuestion): Omit<PendingQuestion, "taskId"> {
    const { nativeConfirmationId: _private, desktopApprovalId: _desktop, guideCheck: _internal, ...publicQuestion } = question;
    return publicQuestion;
  }

  private offerApproval(task: ActiveTask, id: string, title: string) {
    task.harness!.holdQuestion(title);
    this.ask(task, 'approval', title, [{ id: 'approve', label: 'Approve', value: 'approve' }, { id: 'reject', label: 'Cancel action', value: 'reject' }], false);
    task.question!.desktopApprovalId = id;
  }

  private offerMethods(task: ActiveTask, options: Executor[], recommended: string, splitScreen?: PendingQuestion['splitScreen']) {
    if (task.question) throw new Error('A question is already pending');
    task.harness!.holdQuestion('Which method should Kaji use?');
    task.question = {
      id: crypto.randomUUID(), kind: 'method', title: 'Which method should Kaji use?',
      options: options.map(option => ({ id: option.id, value: option.id, label: `${option.label}${option.id === recommended ? ' (Recommended)' : ''}` })),
      allowCustom: false, optional: false, ...(splitScreen ? { splitScreen } : {}),
    };
    this.emit({ type: 'update', taskId: task.taskId, phase: 'awaiting_method', question: this.publicQuestion(task.question) });
  }

  private async method(input: Extract<DesktopHostInput, { type: 'method' }>) {
    const task = this.active;
    const question = task?.question;
    if (!task || task.taskId !== input.taskId || question?.id !== input.questionId || question.kind !== 'method') return this.error(input.taskId, 'Method choice expired');
    if (input.method !== 'rephrase' && !question.options.some(option => option.value === input.method)) return this.error(input.taskId, 'Method was not offered');
    if (input.splitScreen && (!question.splitScreen?.available || input.method === 'rephrase')) return this.error(input.taskId, 'Split screen was not offered');
    try {
      await task.harness!.waitForRun();
      if(this.active!==task || task.question?.id!==question.id || task.stopped) return;
      task.question = null;
      this.emit({ type: 'update', taskId: task.taskId, phase: 'working', question: null });
      const message = input.method === 'rephrase' ? 'The user wants to rephrase. Ask one concise question and wait.' : `The user selected executor ${input.method}. Use that method for the task; split-screen approval is ${input.splitScreen}.`;
      await this.finishRun(task, await task.harness!.answer(message));
    } catch (error) { this.error(task.taskId, String(error)); await this.dispose(task); }
  }

  private async finishRun(task: ActiveTask, result: Awaited<ReturnType<Harness["prompt"]>>) {
    if (this.active !== task || task.stopped) return;
    if (result.state === "awaiting_user") {
      if (!task.question) this.ask(task, "clarification", "What should Kaji do next?");
      else this.emit({ type: "update", taskId: task.taskId, phase: task.question.kind === 'method' ? 'awaiting_method' : task.question.kind === 'approval' ? 'awaiting_confirmation' : "awaiting_user", message: oneLine(result.answer), question: this.publicQuestion(task.question) });
      return;
    }
    if (result.state === "awaiting_confirmation" && result.native.confirmation) {
      const confirmation = result.native.confirmation;
      this.ask(task, "approval", `Allow ${oneLine(confirmation.target_name)}?`, [
        { id: "approve", label: "Approve", value: "approve" },
        { id: "reject", label: "Cancel action", value: "reject" },
      ], false, false, confirmation.id);
      this.emit({ type: "update", taskId: task.taskId, phase: "awaiting_confirmation", message: oneLine(result.answer), question: this.publicQuestion(task.question!) });
      return;
    }
    if (result.state === "paused" || result.native.phase === "paused") {
      this.emit({ type: "update", taskId: task.taskId, phase: "paused", message: oneLine(result.native.reason || "Task paused.") }); return;
    }
    const textReply = task.managed && !task.transport.requestedDesktopWork && !!oneLine(result.answer);
    if (task.mode === "guide" && result.state === "finished" && !textReply) {
      this.ask(task, "clarification", "Did the requested change happen?", [
        { id: "yes", label: "Yes", value: "yes" },
        { id: "not-yet", label: "Not yet", value: "not_yet" },
      ], true, true);
      this.emit({ type: "update", taskId: task.taskId, phase: "awaiting_user", message: oneLine(result.answer), question: this.publicQuestion(task.question!) });
      return;
    }
    const verified = result.state === "finished" && !result.native.verification_pending && !result.native.inspection_required && (!task.managed || task.transport.documentVerified || task.transport.physicalVerified || task.native!.id > 0);
    if (verified || (result.state === "finished" && textReply)) {
      await this.dispose(task);
      this.emit({ type: "result", taskId: task.taskId, phase: "complete", message: oneLine(result.answer || "Task complete."), verified });
      return;
    }
    const stopped = result.state === "stopped" || result.native.phase === "stopped";
    const failed = result.state === "error" || result.state === "timed_out";
    const message = result.state === "unverified" ? "Action was sent; its effect remains unverified. Inspect before retrying."
      : result.state === "budget_exhausted" ? "Task limits reached; inspect current state before continuing."
      : oneLine(result.error || result.answer || "Task needs attention.");
    await this.dispose(task);
    this.emit({ type: "result", taskId: task.taskId, phase: stopped ? "stopped" : failed ? "error" : "blocked", message, verified: false });
  }

  private async answer(input: Extract<DesktopHostInput, { type: "answer" }>) {
    const task = this.active;
    if (!task || task.taskId !== input.taskId || task.question?.id !== input.questionId || typeof input.answer !== "string"
      || !input.answer.trim() || input.answer.length > 2000) { this.error(input.taskId, "Question is stale or answer is invalid"); return; }
    const question = task.question;
    try {
      await task.harness!.waitForRun();
      if(this.active!==task || task.question?.id!==question.id || task.stopped) return;
      task.question = null;
      this.emit({ type: "update", taskId: task.taskId, question: null });
      if (question.kind === "approval") {
        if (question.desktopApprovalId) {
          if (input.answer !== 'approve') { this.emit({ type:'result',taskId:task.taskId,phase:'stopped',message:'Action cancelled.',verified:false }); await this.dispose(task); return; }
          task.transport.authorizeConfirmation(question.desktopApprovalId);
          await task.native!.desktop('execute_physical', {approval_id:question.desktopApprovalId});
          task.native!.id = 0;
          await this.finishRun(task, await task.harness!.answer('The exact action was approved and dispatched. Inspect its actual effect before continuing.'));
          return;
        }
        const confirmationId = question.nativeConfirmationId;
        if (!confirmationId || !task.native) throw new Error("Native approval expired");
        if (input.answer !== "approve") {
          await task.harness!.stop();
          this.emit({ type: "result", taskId: task.taskId, phase: "stopped", message: "Action cancelled.", verified: false });
          await this.dispose(task, false); return;
        }
        task.transport.authorizeConfirmation(confirmationId);
        await task.native.confirm(confirmationId);
        await this.finishRun(task, await task.harness!.continueWith('The host approved and dispatched the exact semantic action once. Your next tool must be desktop_inspect on the current bound window. Then verify the requested result from fresh observations; do not repeat the action.'));
        return;
      }
      if (question.guideCheck) {
        const instruction = input.answer === "yes"
          ? "The user reports the requested effect is visible. Inspect the current application, verify the effect from observations, and continue only if verified."
          : input.answer === "not_yet"
            ? "The user reports the requested effect is not visible. Inspect the current application, explain the next safe user action, then wait again."
            : `The user reports: ${oneLine(input.answer)}. Inspect current application state and determine the next safe step.`;
        await this.finishRun(task, await task.harness!.continueWith(instruction));
        return;
      }
      await this.finishRun(task, await task.harness!.answer(input.answer));
    } catch (error) {
      if (question.kind === "approval") {
        this.emit({ type: "result", taskId: task.taskId, phase: "blocked", message: "Approval expired or no longer matches the current action.", verified: false });
        await this.dispose(task);
      } else {
        this.emit({ type: "result", taskId: task.taskId, phase: "error", message: oneLine(error instanceof Error ? error.message : "Could not resume task"), verified: false });
        await this.dispose(task);
      }
    }
  }

  private async continue(input: TaskControl & { type: "continue" }) {
    const task = this.active;
    if (!task || task.taskId !== input.taskId || task.question) { this.error(input.taskId, "Task cannot continue yet"); return; }
    try { await this.finishRun(task, await task.harness!.continue()); }
    catch (error) { this.error(task.taskId, error instanceof Error ? error.message : "Could not continue task"); }
  }
  private async pause(input: TaskControl & { type: "pause" }) {
    const task = this.active;
    if (!task || task.taskId !== input.taskId) return;
    try {
      task.question = null;
      const status = await task.harness!.pause();
      this.emit({ type: "update", taskId: task.taskId, phase: "paused", message: oneLine(status.reason || "Task paused."), question: null });
    } catch (error) { this.error(task.taskId, error instanceof Error ? error.message : "Could not pause task"); }
  }
  private async resume(input: TaskControl & { type: "resume" }) {
    const task = this.active;
    if (!task || task.taskId !== input.taskId) return;
    try { await this.finishRun(task, await task.harness!.resume()); }
    catch (error) { this.error(task.taskId, error instanceof Error ? error.message : "Could not resume task"); }
  }
  private async stop(input: TaskControl & { type: "stop" }) {
    const task = this.active;
    if (!task || task.taskId !== input.taskId) return;
    task.stopped = true;
    try { await task.harness!.stop(); }
    catch (error) { this.error(task.taskId, error instanceof Error ? error.message : "Could not stop task"); }
    this.emit({ type: "result", taskId: task.taskId, phase: "stopped", message: "Task stopped.", verified: false });
    await this.dispose(task, false);
  }
  private async dispose(task: ActiveTask, stopNative = true) {
    if (this.active !== task) return;
    task.stopped = true;
    task.question = null;
    try { if (stopNative && task.harness) await task.harness.stop(); }
    catch {}
    await task.transport.close();
    if (this.active === task) this.active = null;
  }
  async shutdown() {
    if (this.active) {
      const task = this.active;
      task.stopped = true;
      await this.dispose(task);
    }
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every(key => keys.includes(key));
}
export function parseInput(line: string): DesktopHostInput {
  if (line.length > MAX_INPUT_LINE) throw new Error("Desktop host input exceeds 4 MiB");
  const value: unknown = JSON.parse(line);
  if (!isObject(value) || typeof value.type !== "string") throw new Error("Invalid desktop host input");
  switch (value.type) {
    case "start":
      if (!exactKeys(value, ["type", "taskId", "conversationId", "text", "mode", "model", "hwnd", "nativeSessionId", "method"])
        || !validId(value.taskId) || !validId(value.conversationId) || typeof value.text !== "string" || !value.text.trim() || value.text.length > 16000
        || !["guide", "assist", "agent"].includes(String(value.mode))
        || value.model !== undefined && !GATEWAY_MODELS.some(model => model.id === value.model)
        || value.hwnd !== undefined && (!Number.isSafeInteger(value.hwnd) || value.hwnd <= 0)
        || value.nativeSessionId !== undefined && (!Number.isSafeInteger(value.nativeSessionId) || value.nativeSessionId <= 0)
        || value.method !== undefined && (typeof value.method !== "string" || !value.method || value.method.length > 128)) throw new Error("Invalid task start");
      return value as DesktopHostInput;
    case "answer":
      if (!exactKeys(value, ["type", "taskId", "questionId", "answer"]) || !validId(value.taskId) || !validId(value.questionId) || typeof value.answer !== "string" || value.answer.length > 2000) throw new Error("Invalid task answer");
      return value as DesktopHostInput;
    case 'method':
      if (!exactKeys(value, ['type', 'taskId', 'questionId', 'method', 'splitScreen']) || !validId(value.taskId) || !validId(value.questionId) || !validId(value.method) || typeof value.splitScreen !== 'boolean') throw new Error('Invalid method choice');
      return value as DesktopHostInput;
    case "native_response":
      if (!exactKeys(value, ["type", "id", "taskId", "result", "error"]) || !validId(value.id) || !validId(value.taskId)
        || value.error !== undefined && (typeof value.error !== "string" || value.error.length > 500)
        || value.result === undefined && value.error === undefined) throw new Error("Invalid native response");
      return value as DesktopHostInput;
    case "continue": case "pause": case "resume": case "stop":
      if (!exactKeys(value, ["type", "taskId"]) || !validId(value.taskId)) throw new Error("Invalid task ID");
      return value as DesktopHostInput;
    case "shutdown":
      if (!exactKeys(value, ["type"])) throw new Error("Invalid shutdown request");
      return { type: "shutdown" };
    default: throw new Error("Unsupported desktop host input");
  }
}

export async function runDesktopHost(input: AsyncIterable<string>, write: (line: string) => void, createHarness: HarnessFactory = defaultHarness) {
  const host = new DesktopHost(message => write(JSON.stringify(message)), createHarness);
  write(JSON.stringify({ type: "ready" } satisfies DesktopHostOutput));
  for await (const line of input) {
    try { host.dispatch(parseInput(line)); }
    catch (error) { write(JSON.stringify({ type: "error", message: oneLine(error instanceof Error ? error.message : "Invalid desktop host input").slice(0, 500) } satisfies DesktopHostOutput)); }
  }
  await host.shutdown();
}

if (import.meta.main) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  await runDesktopHost(lines, line => { process.stdout.write(`${line}\n`); });
}
