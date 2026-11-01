import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("./sensor.ts", import.meta.url), "utf8").replace('import { invoke } from "@tauri-apps/api/core";', "const invoke = globalThis.nativeInvoke;")
);
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function harness(options: { ready?: boolean; delaySession?: boolean; rejectFrame?: boolean } = {}) {
  let now = 0, decoded = 1, openCalls = 0, trackStops = 0;
  let pagehide!: () => void;
  let resolveSession!: (value: unknown) => void;
  const calls: { command: string; args: any }[] = [];
  const frames: any[] = [], timers: (() => void)[] = [];
  class Worker {
    static instance: Worker;
    onmessage: ((event: any) => any) | null = null;
    onerror: any;
    terminated = false;
    constructor() { Worker.instance = this; }
    postMessage(message: any) {
      if (message.type === "init" && options.ready !== false) queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
      if (message.type === "frame") frames.push(message);
    }
    terminate() { this.terminated = true; }
  }
  const stream = {
    getTracks: () => [{ stop() { trackStops++; } }],
    getVideoTracks: () => [{ addEventListener() {} }],
  };
  runInNewContext(source, {
    Worker, URL, console, queueMicrotask,
    location: { href: "http://tauri.localhost/" },
    performance: { now: () => now },
    window: { addEventListener: (_: string, fn: () => void) => { pagehide = fn; } },
    document: { createElement: () => ({ readyState: 2, getVideoPlaybackQuality: () => ({ totalVideoFrames: decoded }), play: async () => {}, pause() {} }) },
    navigator: { mediaDevices: { getUserMedia: async () => { openCalls++; return stream; } } },
    createImageBitmap: async () => ({ close() {} }),
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    nativeInvoke: async (command: string, args: any) => {
      calls.push({ command, args });
      if (command === "sensor_ready") {
        if (options.delaySession) return new Promise(resolve => { resolveSession = resolve; });
        return { id: 7, now_ms: 5000 };
      }
      if (command === "sensor_frame" && options.rejectFrame) throw new Error("stale tracking sample");
    },
  });
  return {
    calls, frames, timers,
    get openCalls() { return openCalls; }, get trackStops() { return trackStops; },
    setNow(value: number) { now = value; },
    async nextFrame(time: number) { now = time; decoded++; timers.shift()?.(); await flush(); },
    async pose(frame: any, faces = 1) {
      const candidates = faces ? [{ yaw: 0, pitch: 0.4, center_x: 0.5, center_y: 0.5, eye_span: 0.1 }] : [];
      await Worker.instance.onmessage?.({ data: { type: "pose", captured: frame.captured, faces, candidates, yaw: 0, pitch: 0 } });
      await flush();
    },
    async cancel() { pagehide(); await flush(); },
    async initialized() { Worker.instance.onmessage?.({ data: { type: "ready" } }); await flush(); },
    finishSession() { resolveSession({ id: 7, now_ms: 5000 }); },
    get terminated() { return Worker.instance.terminated; },
  };
}

test("slow first inference is warm-up, never a stale native pose", async () => {
  const h = harness(); await flush();
  expect(h.frames).toHaveLength(1); expect(h.calls).toHaveLength(0);
  h.setNow(650); await h.pose(h.frames[0]);
  expect(h.calls.map(c => c.command)).toEqual(["sensor_ready"]);
  expect(h.calls[0].args.warmupMs).toBe(650);
  await h.nextFrame(680); h.setNow(720); await h.pose(h.frames[1]);
  const frame = h.calls.find(c => c.command === "sensor_frame")!.args.frame;
  expect(frame).toEqual({ session: 7, sequence: 1, captured_ms: 5030, yaw: 0, pitch: 0, faces: 1, candidates: [{ yaw: 0, pitch: 0.4, center_x: 0.5, center_y: 0.5, eye_span: 0.1 }] });
});
test("warm-up may have no face; later observations retain timestamps and sequence", async () => {
  const h = harness(); await flush();
  h.setNow(200); await h.pose(h.frames[0], 0);
  await h.nextFrame(240); h.setNow(260); await h.pose(h.frames[1], 0);
  await h.nextFrame(300); h.setNow(310); await h.pose(h.frames[2], 1);
  const frames = h.calls.filter(c => c.command === "sensor_frame").map(c => c.args.frame);
  expect(frames.map(f => [f.sequence, f.captured_ms, f.faces])).toEqual([[1, 5040, 0], [2, 5100, 1]]);
  expect(frames[0].candidates).toEqual([]);
  expect(frames[1].candidates[0].eye_span).toBe(0.1);
  expect(h.trackStops).toBe(0);
});
test("late post-startup frames are not restamped to bypass native freshness", async () => {
  const h = harness({ rejectFrame: true }); await flush();
  h.setNow(200); await h.pose(h.frames[0]);
  await h.nextFrame(240); h.setNow(600); await h.pose(h.frames[1]);
  expect(h.calls.find(c => c.command === "sensor_frame")!.args.frame.captured_ms).toBe(5040);
  expect(h.calls.at(-1)!.command).toBe("sensor_fault");
  expect(h.trackStops).toBe(1); expect(h.terminated).toBe(true);
});
test("cancellation while loading the model cannot open the camera later", async () => {
  const h = harness({ ready: false }); await h.cancel(); await h.initialized();
  expect(h.openCalls).toBe(0); expect(h.calls.map(c => c.command)).toEqual(["sensor_fault"]);
});
test("cancellation during native initialization cannot publish a late frame", async () => {
  const h = harness({ delaySession: true }); await flush();
  h.setNow(200); const warming = h.pose(h.frames[0]); await flush();
  await h.cancel(); h.finishSession(); await warming;
  expect(h.calls.map(c => c.command)).toEqual(["sensor_ready", "sensor_fault"]);
  expect(h.timers).toHaveLength(0); expect(h.trackStops).toBe(1);
});
