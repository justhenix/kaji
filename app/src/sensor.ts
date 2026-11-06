import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { SENSOR_CONTROL_EVENT } from '../shared/runtime';
import type { SensorControl } from '../shared/runtime';
type Session = { id: number; now_ms: number };
const FRAME_BUDGET_MS = 155;

function sensorError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
}

export class SensorHost {
  private stream: MediaStream | undefined;
  private worker: Worker | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private generation = 0;
  private sequence = 0;
  private inFlight = false;
  private session: Session | undefined;
  private clockOffset = 0;
  private lastDecodedFrame = -1;
  private cameraDeviceId: string | undefined;
  private readonly video = document.createElement('video');
  private unlisten: (() => void) | undefined;

  constructor() {
    this.video.muted = true;
    this.video.playsInline = true;
  }

  async mount(): Promise<void> {
    this.unlisten = await listen<SensorControl>(SENSOR_CONTROL_EVENT, (event) => { void this.control(event.payload); }).catch(() => undefined);
    window.addEventListener('pagehide', () => {
      this.unlisten?.();
      void this.stop().then(() => this.notifyFault('sensor page closed'));
    }, { once: true });
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('standalone')) await this.control({ type: 'start' });
  }

  async control(control: SensorControl): Promise<void> {
    if (control.type === 'start') {
      await this.start(control.cameraDeviceId);
    } else if (control.type === 'stop') {
      await this.stop();
    } else if (control.type === 'reset') {
      const camera = control.cameraDeviceId ?? this.cameraDeviceId;
      await this.stop();
      await this.start(camera);
    } else {
      await this.start(control.cameraDeviceId);
    }
  }

  private async start(cameraDeviceId?: string): Promise<void> {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    this.cameraDeviceId = cameraDeviceId;
    this.sequence = 0;
    this.inFlight = false;
    this.session = undefined;
    this.lastDecodedFrame = -1;
    try {
      const worker = new Worker('/vision.worker.js');
      this.worker = worker;
      await new Promise<void>((resolve, reject) => {
        worker.onerror = (event) => reject(new Error(event.message || 'Camera worker failed'));
        worker.onmessage = (event) => {
          if (event.data.type === 'ready') resolve();
          if (event.data.type === 'error') reject(new Error(event.data.error));
        };
        worker.postMessage({ type: 'init', wasm: new URL('/wasm', location.href).href, model: new URL('/face_landmarker.task', location.href).href });
      });
      if (!this.active || generation !== this.generation) return;
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (!this.active || generation !== this.generation) return;
      const selectedCameraId = cameraDeviceId && devices.some((device) => device.kind === 'videoinput' && device.deviceId === cameraDeviceId)
        ? cameraDeviceId
        : undefined;
      this.cameraDeviceId = selectedCameraId;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {}),
          width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
      if (!this.active || generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      this.stream.getVideoTracks()[0]?.addEventListener('ended', () => { void this.fail('Camera disconnected', generation); }, { once: true });
      this.video.srcObject = this.stream;
      await this.video.play();
      worker.onmessage = (event) => { void this.onWorkerMessage(event, generation); };
      void this.frame(generation);
    } catch (error) {
      await this.fail(sensorError(error, 'Camera unavailable'), generation);
    }
  }

  private async onWorkerMessage(event: MessageEvent, generation: number): Promise<void> {
    if (!this.active || generation !== this.generation) return;
    const message = event.data;
    if (message.type === 'error') { await this.fail(message.error, generation); return; }
    if (message.type !== 'pose') return;
    try {
      if (!this.session) {
        const session = await invoke<Session>('sensor_ready', { warmupMs: performance.now() - message.captured });
        if (!this.active || generation !== this.generation) return;
        this.session = session;
        this.clockOffset = this.session.now_ms - performance.now();
      } else if (performance.now() - message.captured <= FRAME_BUDGET_MS) {
        await invoke('sensor_frame', { frame: {
          session: this.session.id, sequence: ++this.sequence,
          captured_ms: message.captured + this.clockOffset,
          yaw: message.yaw, pitch: message.pitch, faces: message.faces, candidates: message.candidates,
        } });
        if (!this.active || generation !== this.generation) return;
      }
      this.inFlight = false;
      this.timer = setTimeout(() => { void this.frame(generation); }, 0);
    } catch (error) {
      await this.fail(sensorError(error, 'Sensor frame rejected'), generation);
    }
  }

  private async frame(generation: number): Promise<void> {
    if (!this.active || generation !== this.generation || this.inFlight) return;
    if (this.video.readyState < 2) { this.timer = setTimeout(() => { void this.frame(generation); }, 20); return; }
    const decodedFrame = this.video.getVideoPlaybackQuality().totalVideoFrames;
    if (decodedFrame === this.lastDecodedFrame) { this.timer = setTimeout(() => { void this.frame(generation); }, 8); return; }
    this.lastDecodedFrame = decodedFrame;
    this.inFlight = true;
    const captured = performance.now();
    try {
      const bitmap = await createImageBitmap(this.video);
      if (!this.active || generation !== this.generation) { bitmap.close(); return; }
      this.worker?.postMessage({ type: 'frame', bitmap, captured, timestamp: captured }, [bitmap]);
    } catch (error) {
      await this.fail(error instanceof Error ? error.message : 'Could not read camera frame', generation);
    }
  }

  private async fail(reason: string, generation: number): Promise<void> {
    if (!this.active || generation !== this.generation) return;
    await this.stop();
    await this.notifyFault(reason);
  }

  private async notifyFault(reason: string): Promise<void> {
    await invoke('sensor_fault', { reason: reason.slice(0, 512) }).catch(() => {});
  }

  private async stop(): Promise<void> {
    this.active = false;
    this.generation++;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
    this.worker?.postMessage({ type: 'stop' });
    this.worker?.terminate();
    this.worker = undefined;
    this.inFlight = false;
    this.session = undefined;
  }
}

async function initSensorHost(): Promise<void> {
  await new SensorHost().mount();
}

if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', () => { void initSensorHost(); });
