import { invoke } from "@tauri-apps/api/core";

type Session = { id: number; now_ms: number };
let stream: MediaStream | undefined;
let worker: Worker | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let sequence = 0;
let inFlight = false;
let session: Session | undefined;
let clockOffset = 0;
let lastDecodedFrame = -1;
const video = document.createElement("video");
video.muted = true;
video.playsInline = true;

async function stop(reason: string) {
  if (stopped) return;
  stopped = true;
  clearTimeout(timer);
  stream?.getTracks().forEach(track => track.stop());
  video.pause(); video.srcObject = null;
  worker?.postMessage({ type: "stop" });
  worker?.terminate();
  await invoke("sensor_fault", { reason: reason.slice(0, 512) }).catch(console.error);
}
async function frame() {
  if (stopped || inFlight) return;
  if (video.readyState < 2) { timer = setTimeout(frame, 20); return; }
  const decodedFrame = video.getVideoPlaybackQuality().totalVideoFrames;
  if (decodedFrame === lastDecodedFrame) { timer = setTimeout(frame, 8); return; }
  lastDecodedFrame = decodedFrame;
  inFlight = true;
  const captured = performance.now();
  try {
    const bitmap = await createImageBitmap(video);
    if (stopped) { bitmap.close(); return; }
    worker!.postMessage({ type: "frame", bitmap, captured, timestamp: captured }, [bitmap]);
  } catch (error) { await stop(String(error)); }
}
async function start() {
  worker = new Worker("/vision.worker.js");
  worker.onerror = e => { void stop(e.message); };
  await new Promise<void>((resolve, reject) => {
    worker!.onmessage = event => {
      if (event.data.type === "ready") resolve();
      if (event.data.type === "error") reject(new Error(event.data.error));
    };
    worker!.postMessage({ type: "init", wasm: new URL("/wasm", location.href).href, model: new URL("/face_landmarker.task", location.href).href });
  });
  if (stopped) return;
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
  if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
  stream.getVideoTracks()[0].addEventListener("ended", () => { void stop("camera disconnected"); });
  video.srcObject = stream;
  await video.play();
  worker.onmessage = async event => {
    if (stopped) return;
    const message = event.data;
    if (message.type === "error") { await stop(message.error); return; }
    if (message.type !== "pose") return;
    try {
      if (!session) {
        // createFromOptions does not warm inference. Discard the pre-session warm-up image.
        session = await invoke<Session>("sensor_ready", { warmupMs: performance.now() - message.captured });
        clockOffset = session.now_ms - performance.now();
        if (stopped) return;
        inFlight = false;
        timer = setTimeout(frame, 0);
        return;
      }
      await invoke("sensor_frame", { frame: { session: session.id, sequence: ++sequence, captured_ms: message.captured + clockOffset, yaw: message.yaw, pitch: message.pitch, faces: message.faces, candidates: message.candidates } });
      inFlight = false;
      timer = setTimeout(frame, 0);
    } catch (error) { await stop(String(error)); }
  };
  void frame();
}
window.addEventListener("pagehide", () => { void stop("sensor page closed"); });
void start().catch(error => stop(String(error)));
