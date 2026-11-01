import { DiagnosticClient } from "./diagnostic-client";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const hwnd = Number(Bun.argv[Bun.argv.indexOf("--hwnd") + 1]);
const secondsIndex=Bun.argv.indexOf("--seconds");
const seconds=secondsIndex<0?90:Number(Bun.argv[secondsIndex+1]);
if(!Number.isSafeInteger(seconds)||seconds<10||seconds>300)throw new Error("--seconds must be between 10 and 300");
if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error("Pass Calculator's --hwnd. This check needs a person at the webcam.");
const observations: unknown[] = [];
const inspector = new DiagnosticClient();
let sensor: DiagnosticClient | undefined;
let completed = false;
try {
  let before = await inspector.request({ command: "inspect", hwnd });
  if (before.title !== "Calculator") throw new Error("Target is not Calculator");
  const findButton = (snapshot: any) => snapshot.elements.find((e: any) => e.control_type === 50000 && (e.name === "7" || /seven/i.test(e.name)) && e.identity && e.rect);
  let button = findButton(before);
  if (!button) throw new Error("Calculator's 7 button was not discovered in UIA");
  if (!button.clickable) {
    console.log("Discovered Calculator's 7 button, but another window covers it. Waiting up to 30 seconds for it to become unobscured before opening the camera.");
    const deadline = performance.now() + 30000;
    while (!button.clickable && performance.now() < deadline) {
      await Bun.sleep(500);
      before = await inspector.request({ command: "inspect", hwnd });
      button = findButton(before);
      if (!button) throw new Error("Calculator's 7 button became unavailable");
    }
    if (!button.clickable) throw new Error("7 was discovered but remains covered; input was not armed");
  }
  const displayValue = (snapshot: any) => {
    const e = snapshot.elements.find((e: any) => e.automation_id === "150" || e.automation_id === "CalculatorResults");
    return String(e?.value ?? e?.name ?? "").trim();
  };
  console.log(`Real Calculator button: ${button.name}, screen point ${JSON.stringify(button.clickable)}.`);
  console.log("Hold your neutral head position until tracking activates. Then turn your head to move onto 7, return to neutral, and dwell for 1.2 seconds. Escape stops immediately. Keep hands off mouse and keyboard after capture starts.");
  sensor = new DiagnosticClient("kaji", ["--camera", "--enable-input", "--hwnd", String(hwnd), "--seconds", String(seconds), "--stdio"]);
  const started = performance.now(); let lastPhase = "";
  let observedClicks=0;
  while (performance.now() - started < (seconds-2)*1000) {
    await Bun.sleep(100);
    const state = await sensor.request({ command: "status" });
    if (state.phase !== lastPhase) { console.log(`${state.phase}: ${state.reason}`); lastPhase = state.phase; }
    observations.push(state);
    await Bun.write(resolve(import.meta.dir, "../verification/head-live.json"), JSON.stringify(state));
    if (state.session > 0 && state.phase === "stopped") throw new Error(state.reason);
    if (state.clicks > observedClicks) {
      const previousClicks=observedClicks;observedClicks=state.clicks;
      const point=state.last_click;
      const rect=button.rect;
      if(!point || point.x<rect.left || point.x>=rect.right || point.y<rect.top || point.y>=rect.bottom) {
        console.log(`Dwell at ${JSON.stringify(point)} was outside 7; tracking continues.`);
        before=await inspector.request({command:"inspect",hwnd});
        button=findButton(before);
        if(!button)throw new Error("Calculator's 7 button became unavailable");
        continue;
      }
      const stopped = await sensor.request({ command: "stop" });
      if (state.moves < 1 || !state.operator_visible || state.clicks-previousClicks !== 1 || stopped.phase !== "stopped") throw new Error("native movement, locked operator, dwell, or stop criteria were not met");
      const after = await inspector.request({ command: "inspect", hwnd });
      const beforeValue = displayValue(before), afterValue = displayValue(after);
      if (beforeValue === afterValue || !afterValue.endsWith("7")) throw new Error(`Calculator changed from ${beforeValue} to ${afterValue}; expected a real 7-button effect`);
      observations.push({ check: "webcam head movement -> dwell -> Calculator effect -> native stop", status: "PASS", button, state, stopped, beforeValue, afterValue, earlierNonTargetDwells:previousClicks });
      console.log(`PASS: head tracking moved the cursor, dwell clicked, Calculator changed ${beforeValue} -> ${afterValue}, and native execution stopped.`);
      completed = true; break;
    }
  }
  if (!completed) throw new Error("No completed human head-control demonstration before the session deadline");
} catch (error) { observations.push({ status: "FAIL", error: String(error) }); console.error(error); process.exitCode = 1; }
finally {
  if (sensor) {
    try {
      const stopped = await sensor.request({ command: "stop" });
      observations.push({ finalStop: stopped });
      console.log(`Stopped safely: ${stopped.reason}; ${stopped.frames} frames, ${stopped.moves} moves, ${stopped.clicks} clicks.`);
    } catch (error) { observations.push({ stopError: String(error) }); }
  }
  await sensor?.close().catch(() => {}); await inspector.close();
  const stderr = await sensor?.stderr;
  const finalLine = stderr?.split("\n").find(line => line.startsWith("native-stop: "));
  if (finalLine) { const nativeStop=JSON.parse(finalLine.slice("native-stop: ".length)); observations.push({nativeStop}); if(!completed) console.error(`Native stop reason: ${nativeStop.reason}`); }
  await mkdir(resolve(import.meta.dir, "../verification"), { recursive: true });
  await Bun.write(resolve(import.meta.dir, "../verification/head.json"), JSON.stringify({ time: new Date().toISOString(), completed, observations, stderr }, null, 2));
}
