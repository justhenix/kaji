import { expect, test } from "bun:test";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import type { TranscriptContext } from '@earendil-works/pi-ai';
import type { DesktopHostOutput } from "../shared/runtime";
import { DesktopHost, parseInput } from "./desktop-host";
import { NativeSession, type NativeStatus } from "./native-session";
import { Harness } from "./harness";
import { scriptedStream, toolCall } from "./test-support";

const model = groqProvider().getModels()[0]!;
test('JSONL accepts the selected enabled model and rejects unregistered models', () => {
  const start = {type:'start',taskId:'wire',conversationId:'chat',text:'Hello',mode:'assist'};
  for (const model of ['deepseek-v4.1-flash','ag/gemini-3.8-flash-medium','ag/gemini-3.8-flash-high']) {
    expect(parseInput(JSON.stringify({...start,model}))).toMatchObject({model});
  }
  expect(()=>parseInput(JSON.stringify({...start,model:'arbitrary-provider'}))).toThrow();
  expect(()=>parseInput(JSON.stringify({...start,authorization:'forged'}))).toThrow();
});
const status = (): NativeStatus => ({
  session: 7, phase: "active", reason: "active", hwnd: 123, cursor: { revision: 1, element_id: "e1", point: { x: 10, y: 10 }, target: { left: 0, top: 0, right: 20, bottom: 20 }, target_name: "Result" },
  physical_cursor: null, foreground_hwnd: 123, last_backend: "uia", actions: 0, inspection_required: false,
  verification_pending: false, last_outcome: null, mode: "agent", confirmation: null,
});

function setup(script: (turn: number, context: TranscriptContext) => any, managed = false) {
  const output: DesktopHostOutput[] = [], native = status(), handled = new Set<string>();
  if (managed) native.session = 0;
  const host = new DesktopHost(message => output.push(message), (session, askUser, tools) => new Harness(session, model, scriptedStream((context, turn) => script(turn, context)), undefined, askUser, tools));
  const respond = (command: Record<string, any>) => {
    switch (command.command) {
      case "begin": native.session++; native.hwnd = command.hwnd; native.mode = command.mode; return structuredClone(native);
      case "status": return structuredClone(native);
      case "inspect": native.inspection_required = false; native.verification_pending = false; return { elements: [{ id: "e1", name: "Result", value: "7", control_type: 50004 }], truncated: false };
      case "point": return { revision: 1, point: { x: 10, y: 10 } };
      case "act": native.confirmation = { id: "private-approval-id", revision: 1, element_id: "e1", target_name: "Result", action: command.action }; return structuredClone(native);
      case "confirm": native.actions++; native.confirmation = null; native.verification_pending = true; native.inspection_required = true; return structuredClone(native);
      case "stop": native.phase = "stopped"; return structuredClone(native);
      case "pause": native.phase = "paused"; native.confirmation = null; return structuredClone(native);
      case "resume": native.phase = "active"; native.inspection_required = true; return structuredClone(native);
      case 'task_context': return { executors: [{id:'native',label:'Native computer use',capabilities:['uia.read','uia.write'],background:true},{id:'python_docx',label:'Python document processing',capabilities:['docx.edit_copy'],background:true}],userWindow:'w-user',targetWindow:null,selectedFile:{name:'notes.docx',extension:'docx'},vision:false };
      case 'list_windows': return {windows:[{id:'w-user',title:'Current activity'},{id:'w-task',title:'Project notes'}]};
      case 'select_executor': return {executor:command.executor_id};
      case 'document_edit': return {id:'artifact-1',name:'result.docx',verification:{bytes:1000,paragraphs:3,tables:0}};
      case 'activate_window': return {executed:true,verified:true,window:{id:command.window_id}};
      case 'composer_control': return {verified:true,placement:command.placement,clickThrough:command.placement==='fade'};
      case 'execute_physical': return {executed:true,verified:true};
      case 'bind_window': return {window:{id:command.window_id},hwnd:123};
      default: throw new Error(`Unexpected native command: ${command.command}`);
    }
  };
  async function pump(until: () => boolean) {
    for (let attempt = 0; attempt < 500 && !until(); attempt++) {
      const pending = output.find(message => message.type === "native_request" && !handled.has(message.id));
      if (pending?.type === "native_request") {
        handled.add(pending.id);
        host.dispatch({ type: "native_response", id: pending.id, taskId: pending.taskId, result: respond(pending.command) });
      } else await Bun.sleep(1);
    }
    expect(until()).toBeTrue();
  }
  return { host, output, native, pump };
}

test("desktop host yields a generic clarification with opaque question ID, then resumes same task", async () => {
  const f = setup(turn => turn === 0 ? toolCall("ask_user", { title: "Which report should I inspect?" }) : [{ type: "text", text: "I will inspect the blue report." }]);
  f.host.dispatch({ type: "start", taskId: "task-a", conversationId: "chat-a", text: "Summarize the report", mode: "agent", hwnd: 123, method: "native-ui" });
  await f.pump(() => f.output.some(message => message.type === "update" && message.question?.kind === "clarification"));
  const update = f.output.find(message => message.type === "update" && message.question?.kind === "clarification");
  expect(update?.type).toBe("update");
  if (update?.type !== "update" || !update.question) throw new Error("Expected clarification");
  expect(update.question.title).toBe("Which report should I inspect?");
  expect(update.question.options).toEqual([]); expect(update.question.allowCustom).toBeTrue();
  expect(JSON.stringify(update)).not.toContain("confirmation");
  f.host.dispatch({ type: "answer", taskId: "task-a", questionId: "stale-question", answer: "wrong" });
  expect(f.output.some(message => message.type === "result" && message.taskId === "task-a")).toBeFalse();
  f.host.dispatch({ type: "answer", taskId: "task-a", questionId: update.question.id, answer: "the blue report" });
  await f.pump(() => f.output.some(message => message.type === "result" && message.taskId === "task-a"));
  expect(f.output.find(message => message.type === "result")?.type).toBe("result");
});

test("native approval stays private until host maps user choice to exact confirmation", async () => {
  const f = setup((turn, context) => {
    if (turn === 0) return toolCall("cursor_act", { revision: 1, action: { kind: "invoke" } });
    if (turn === 1) {
      expect(JSON.stringify(context.messages.filter(message => message.role === 'user'))).toContain('The host approved and dispatched the exact semantic action once');
      return toolCall("desktop_inspect");
    }
    return [{ type: "text", text: "The result is verified." }];
  });
  f.host.dispatch({ type: "start", taskId: "task-b", conversationId: "chat-b", text: "Press the result button", mode: "assist", hwnd: 123 });
  await f.pump(() => f.output.some(message => message.type === "update" && message.question?.kind === "approval"));
  const update = f.output.find(message => message.type === "update" && message.question?.kind === "approval");
  if (update?.type !== "update" || !update.question) throw new Error("Expected approval");
  expect(JSON.stringify(update.question)).not.toContain("private-approval-id");
  expect(update.question.options.map(option => option.value)).toEqual(["approve", "reject"]);
  f.host.dispatch({ type: "answer", taskId: "task-b", questionId: update.question.id, answer: "approve" });
  await f.pump(() => f.output.some(message => message.type === "result" && message.taskId === "task-b"));
  const confirm = f.output.find(message => message.type === "native_request" && message.command.command === "confirm");
  expect(confirm?.type).toBe("native_request");
  if (confirm?.type === "native_request") expect(confirm.command.confirmation_id).toBe("private-approval-id");
  expect(f.output.find(message => message.type === "result")).toMatchObject({ phase: "complete", verified: true });
  expect(f.native.actions).toBe(1);
});

test("stale native responses from another task cannot advance the active task", async () => {
  const f = setup(() => [{ type: "text", text: "Current view checked." }]);
  f.host.dispatch({ type: "start", taskId: "task-c", conversationId: "chat-c", text: "Check the current view", mode: "agent", hwnd: 123 });
  await f.pump(() => f.output.some(message => message.type === "native_request" && message.command.command === "begin"));
  const begin = f.output.find(message => message.type === "native_request" && message.command.command === "begin");
  if (begin?.type !== "native_request") throw new Error("Expected begin request");
  f.host.dispatch({ type: "native_response", id: begin.id, taskId: "task-other", result: status() });
  expect(f.output.some(message => message.type === "result" && message.taskId === "task-c")).toBeFalse();
  f.host.dispatch({ type: "native_response", id: begin.id, taskId: "task-c", result: status() });
  await f.pump(() => f.output.some(message => message.type === "result" && message.taskId === "task-c"));
});

test('a text reply completes without claiming a verified desktop action', async () => {
  const f = setup(turn => turn === 0 ? toolCall('task_context') : [{ type: 'text', text: 'Kaji demo ready.' }], true);
  f.host.dispatch({ type: 'start', taskId: 'reply-1', conversationId: 'chat-1', text: 'Reply with Kaji demo ready.', mode: 'guide' });
  await f.pump(() => f.output.some(message => message.type === 'result'));
  expect(f.output.find(message => message.type === 'result')).toMatchObject({
    phase: 'complete', message: 'Kaji demo ready.', verified: false,
  });
});

test('routine document task picks the background executor without prompting', async () => {
  const f = setup(turn => turn === 0 ? toolCall('choose_method',{executorIds:['python_docx','native'],recommended:'python_docx'}) : turn === 1 ? toolCall('document_edit',{operations:[{kind:'normalize_spacing',afterPt:6,lineSpacing:1.15}]}) : [{type:'text',text:'Saved the formatted copy.'}],true);
  f.host.dispatch({type:'start',taskId:'routine',conversationId:'chat-1',text:'Format the selected project notes',mode:'assist'});
  await f.pump(()=>f.output.some(message=>message.type==='result'));
  expect(f.output.some(message=>message.type==='update'&&message.question)).toBeFalse();
  expect(f.output.find(message=>message.type==='result')).toMatchObject({phase:'complete',verified:true});
});

test('a task with a layout decision offers methods and resumes the chosen adapter', async () => {
  const f = setup(turn => turn === 0 ? toolCall('choose_method',{executorIds:['python_docx','native'],recommended:'python_docx',taskWindow:'w-task'}) : turn === 1 ? toolCall('document_edit',{operations:[{kind:'normalize_spacing',afterPt:6,lineSpacing:1.15}]}) : [{type:'text',text:'Saved the formatted copy.'}],true);
  f.host.dispatch({type:'start',taskId:'generic-1',conversationId:'chat-1',text:'Format the selected project notes',mode:'assist'});
  await f.pump(()=>f.output.some(message=>message.type==='update'&&message.question?.kind==='method'));
  const offered=f.output.find(message=>message.type==='update'&&message.question?.kind==='method');
  if(offered?.type!=='update'||!offered.question) throw new Error('Missing method question');
  expect(offered.question.options.map(option=>option.value)).toEqual(['python_docx','native']);
  expect(offered.question.splitScreen).toMatchObject({ available: true, userWindow: 'w-user', taskWindow: 'w-task' });
  f.host.dispatch({type:'method',taskId:'generic-1',questionId:offered.question.id,method:'unregistered-shell',splitScreen:false});
  expect(f.output.some(message=>message.type==='native_request'&&message.command.command==='document_edit')).toBeFalse();
  f.host.dispatch({type:'method',taskId:'generic-1',questionId:offered.question.id,method:'python_docx',splitScreen:false});
  await f.pump(()=>f.output.some(message=>message.type==='result'));
  expect(f.output.find(message=>message.type==='result')).toMatchObject({phase:'complete',verified:true});
});

test('routine app activation runs without an approval question',async()=>{
  const f=setup(turn=>turn===0?toolCall('choose_method',{executorIds:['native'],recommended:'native'}):turn===1?toolCall('desktop_activate',{windowId:'w-task'}):[{type:'text',text:'The requested app is foreground.'}],true);
  f.host.dispatch({type:'start',taskId:'handoff-1',conversationId:'chat-1',text:'Bring project notes forward',mode:'agent'});
  await f.pump(()=>f.output.some(message=>message.type==='result'));
  expect(f.output.some(message=>message.type==='update'&&message.question)).toBeFalse();
  expect(f.output.filter(message=>message.type==='native_request'&&message.command.command==='activate_window')).toHaveLength(1);
  expect(f.output.find(message=>message.type==='result')).toMatchObject({phase:'complete',verified:true});
});

test('binding a native target selects its executor before opening the session', async () => {
  const f = setup(turn => turn === 0 ? toolCall('desktop_bind', {windowId:'w-task'}) : [{type:'text',text:'The target controls were inspected.'}], true);
  f.host.dispatch({type:'start',taskId:'bind-native',conversationId:'chat-1',text:'Inspect the project notes window',mode:'assist'});
  await f.pump(() => f.output.some(message => message.type === 'result'));
  const commands = f.output.flatMap(message => message.type === 'native_request' ? [message.command] : []);
  expect(commands.filter(command => ['select_executor','bind_window','begin','inspect'].includes(String(command.command)))).toEqual([
    {command:'select_executor',executor_id:'native'},
    {command:'bind_window',window_id:'w-task'},
    {command:'begin',hwnd:123,mode:'assist'},
    {command:'inspect',session:1},
  ]);
  expect(f.output.some(message => message.type === 'update' && message.question)).toBeFalse();
  expect(f.output.find(message => message.type === 'result')).toMatchObject({phase:'complete',verified:true});
});

test('moving or fading the composer runs without an executor or approval question', async () => {
  for (const placement of ['aside','left','right','fade','restore']) {
    const f = setup(turn => turn === 0 ? toolCall('composer_control', {placement,seconds:180}) : [{type:'text',text:'Moved out of your way.'}], true);
    f.host.dispatch({type:'start',taskId:'composer-1',conversationId:'chat-1',text:'You are in my way',mode:'assist'});
    await f.pump(() => f.output.some(message => message.type === 'result'));
    expect(f.output.some(message => message.type === 'update' && message.question)).toBeFalse();
    expect(f.output.filter(message => message.type === 'native_request' && message.command.command === 'composer_control')).toHaveLength(1);
    expect(f.output.some(message => message.type === 'native_request' && ['begin','select_executor','act'].includes(String(message.command.command)))).toBeFalse();
    expect(f.output.find(message => message.type === 'result')).toMatchObject({phase:'complete',verified:true});
  }
});
