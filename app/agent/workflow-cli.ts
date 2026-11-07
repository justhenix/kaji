import { createInterface } from "node:readline";
import { NativeSession } from "./native-session";
import { Workflow } from "./workflow";

const args = Bun.argv.slice(2);
const option = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
if (args.includes("--help")) {
  console.log("bun run --cwd app workflow --hwnd N --mode guide|assist [--enable-actions]\nJSONL host commands: start {steps}, status, confirm {confirmation_id}, verify, advance, pause, resume, stop, shutdown. Only the trusted host can confirm. No model or GUI is started.");
} else {
  const mode = option("--mode") ?? "guide";
  if (mode !== "guide" && mode !== "assist") throw new Error("Workflow mode must be guide or assist");
  const native = await NativeSession.open(Number(option("--hwnd")), args.includes("--enable-actions"), undefined, mode);
  const workflow = new Workflow(native);
  const cancel = () => { void workflow.stop().catch(() => {}); };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      let id: unknown = null;
      try {
        if (line.length > 65536) throw new Error("Request exceeds 64 KiB");
        const r = JSON.parse(line); id = r.id;
        let result: unknown;
        switch (r.command) {
          case "start": result = await workflow.start(r.steps); break;
          case "status": result = workflow.status(); break;
          case "confirm": result = await workflow.confirm(r.confirmation_id); break;
          case "verify": result = await workflow.verify(); break;
          case "advance": result = await workflow.advance(); break;
          case "pause": result = await workflow.pause(); break;
          case "resume": result = await workflow.resume(); break;
          case "stop": case "shutdown": result = await workflow.stop(); break;
          default: throw new Error("Unknown workflow command");
        }
        console.log(JSON.stringify({ id, result: { Ok: result } }));
        if (r.command === "shutdown") break;
      } catch (e) { console.log(JSON.stringify({ id, result: { Err: String(e) } })); }
    }
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); await workflow.stop(); await native.close(); }
}
