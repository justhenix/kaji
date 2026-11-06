import { listen } from '@tauri-apps/api/event';
import { createKeywordSpotter, type KeywordSpotter, type KeywordSpotterConfig } from '@sherpaw/kws';
import { AUDIO_CONTROL_EVENT, RUNTIME_UPDATE_EVENT, type AudioControl, type RuntimeSnapshot } from '../shared/runtime';
import { dispatchRuntime, fetchRuntime, fetchSettings } from './gui/ipc';
import { playSendCue } from './audio-cue';

const KEYWORD = {
  label: 'Hey Kaji',
  matches: [{ tokens: ['HH', 'EY1', 'K', 'AA1', 'JH', 'IY0'] }],
};
const MODEL_DATA = '/wake/preload.data';
const MODEL_METADATA = '/wake/preload.js.metadata';
const MAX_UTTERANCE_MS = 30_000;
const END_SILENCE_MS = 3_000;
const NO_SPEECH_TIMEOUT_MS = 9_000;
const MIC_START_TIMEOUT_MS = 8_000;

interface ModelMetadata {
  remote_package_size: number;
  files: { filename: string; start: number; end: number }[];
}

export function shouldRestoreWake(snapshot: RuntimeSnapshot | null): boolean {
  return snapshot?.voice.enabled === true && snapshot.voice.phase === 'wake';
}

export function shouldStartWake(snapshot: RuntimeSnapshot | null, enabled: boolean): boolean {
  return enabled && snapshot?.voice.sessionId === 0 && !snapshot.voice.enabled && snapshot.voice.phase === 'off';
}

export function utteranceRoute(snapshot: RuntimeSnapshot | null): { taskId?: string; questionId?: string; conversationId?: string; voiceSessionId: number } {
  const question = snapshot?.question;
  return { voiceSessionId: snapshot?.voice.sessionId ?? 0, ...(snapshot?.activeConversationId ? { conversationId: snapshot.activeConversationId } : {}), ...(question ? { taskId: question.taskId, questionId: question.id } : {}) };
}

export async function createWakeSpotter(signal?: AbortSignal): Promise<KeywordSpotter> {
  const [dataResponse, metadataResponse] = await Promise.all([fetch(MODEL_DATA, { signal }), fetch(MODEL_METADATA, { signal })]);
  if (!dataResponse.ok || !metadataResponse.ok) throw new Error('Local wake model is unavailable');
  const data = await dataResponse.arrayBuffer();
  const metadata = await metadataResponse.json() as ModelMetadata;
  const tokensFile = metadata.files.find((file) => file.filename === '/tokens.txt');
  if (!tokensFile || tokensFile.end > data.byteLength) throw new Error('Wake model token map is invalid');
  const tokens = new Set(new TextDecoder().decode(data.slice(tokensFile.start, tokensFile.end)).split(/\r?\n/).map((line) => line.split(' ')[0]));
  if (KEYWORD.matches[0].tokens.some((token) => !tokens.has(token))) throw new Error('Wake phrase does not match bundled model tokens');
  const worker = new Worker(new URL('/wake.worker.js', location.href), { type: 'module' });
  const config: KeywordSpotterConfig = { model: { data, metadata }, keywords: [KEYWORD], maxActivePaths: 4, maxPendingAudio: 1, signal };
  return createKeywordSpotter(config, { worker });
}

export function encodeWav(chunks: Float32Array[], gain = 1): Uint8Array {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) {
    const value = Math.max(-1, Math.min(1, sample * gain));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block) binary += String.fromCharCode(...bytes.subarray(i, i + block));
  return btoa(binary);
}

export function downsample(input: Float32Array, sourceRate: number): Float32Array {
  const bounded = (sample: number) => Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
  if (sourceRate === 16_000) return Float32Array.from(input, bounded);
  const outputLength = Math.floor(input.length * 16_000 / sourceRate);
  const output = new Float32Array(outputLength);
  const scale = sourceRate / 16_000;
  for (let i = 0; i < outputLength; i++) {
    const position = i * scale;
    const left = Math.floor(position);
    const fraction = position - left;
    output[i] = bounded(input[left] * (1 - fraction) + input[Math.min(left + 1, input.length - 1)] * fraction);
  }
  return output;
}

export class AudioHost {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | null = null;
  private spotter: KeywordSpotter | null = null;
  private mode: 'wake' | 'utterance' | null = null;
  private wakeEnabled = false;
  private soundEffects = false;
  private knownInputs: Set<string> | undefined;
  private recentInput: string | undefined;
  private inputDeviceId: string | undefined;
  private noiseSuppression = true;
  private deviceScan = 0;
  private sensitivity = 50;
  private speaking = false;
  private recording: Float32Array[] = [];
  private recordingMs = 0;
  private captureElapsedMs = 0;
  private quietMs = 0;
  private noiseFloor = 0;
  private micLabel = '';
  private captureRoute: Promise<ReturnType<typeof utteranceRoute>> = Promise.resolve({ voiceSessionId: 0 });
  private heardSpeech = false;
  private capturing = false;
  private finishingUtterance = false;
  private transcriptionPending = false;
  private chain = Promise.resolve();
  private lastLevelAt = 0;
  private peakLevel = 0;
  private micStartTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private playbackGeneration = 0;
  private playbackRequest = 0;
  private playbackSession: number | undefined;
  private startAbort: AbortController | null = null;
  private stopPlayback: (() => void) | undefined;
  private runtimeSnapshot: RuntimeSnapshot | null = null;
  private transcriptionWaiter: { afterRevision: number; generation: number; resolve: () => void } | undefined;
  private readonly playedUtterances = new Set<string>();
  private readonly audio = new Audio();
  private unlisten: (() => void) | undefined;
  private unlistenRuntime: (() => void) | undefined;

  async mount(): Promise<void> {
    const devices = navigator.mediaDevices;
    const onDeviceChange = () => {
      const generation = this.generation;
      const previous = this.recentInput;
      void this.refreshInputDevices().then((inputs) => {
        if (generation !== this.generation || previous === this.recentInput
          || this.mode !== 'wake' || this.capturing || this.transcriptionPending || this.speaking
          || inputs.some(device => device.deviceId === this.inputDeviceId)) return;
        void this.start('wake', this.inputDeviceId, this.noiseSuppression);
      });
    };
    devices?.addEventListener('devicechange', onDeviceChange);
    void this.refreshInputDevices();
    [this.unlisten, this.unlistenRuntime] = await Promise.all([
      listen<AudioControl>(AUDIO_CONTROL_EVENT, (event) => { void this.control(event.payload); }).catch(() => undefined),
      listen<RuntimeSnapshot>(RUNTIME_UPDATE_EVENT, (event) => this.acceptRuntime(event.payload)).catch(() => undefined),
    ]);
    window.addEventListener('pagehide', () => {
      devices?.removeEventListener('devicechange', onDeviceChange);
      this.unlisten?.(); this.unlistenRuntime?.();
      void this.stop();
    }, { once: true });
    const snapshot = await fetchRuntime().catch(() => null);
    if (snapshot) this.acceptRuntime(snapshot);
    if (shouldRestoreWake(snapshot)) {
      const settings = await fetchSettings();
      this.wakeEnabled = settings.voice_activation;
      this.soundEffects = settings.sound_effects;
      this.sensitivity = settings.input_sensitivity;
      await this.start('wake', settings.microphone, settings.noise_suppression);
    } else if (snapshot?.voice.enabled && ['starting', 'listening', 'transcribing', 'speaking'].includes(snapshot.voice.phase)) {
      await this.setPhase('error', 'Audio session restarted. Start listening again.');
    } else if (snapshot?.voice.sessionId === 0) {
      const settings = await fetchSettings();
      if (shouldStartWake(snapshot, settings.voice_activation)) await dispatchRuntime({ type: 'audio.ready' });
    }
  }

  async control(control: AudioControl): Promise<void> {
    if (control.type === 'stop') { await this.stop(); return; }
    if (control.type === 'start') {
      this.wakeEnabled = control.wakeEnabled;
      this.soundEffects = control.soundEffects === true;
      this.sensitivity = Math.max(0, Math.min(100, control.sensitivity));
      await this.start(control.mode, control.inputDeviceId, control.noiseSuppression);
      return;
    }
    if (control.type === 'push-to-talk') {
      if (control.active) await this.beginUtterance();
      else await this.finishUtterance();
      return;
    }
    await this.play(control);
  }

  private async start(mode: 'wake' | 'utterance', inputDeviceId: string | undefined, noiseSuppression: boolean): Promise<void> {
    const stopping = this.stop(false);
    const generation = this.generation;
    await stopping;
    if (generation !== this.generation) return;
    const controller = new AbortController();
    this.startAbort = controller;
    this.mode = mode;
    this.inputDeviceId = inputDeviceId;
    this.noiseSuppression = noiseSuppression;
    this.lastLevelAt = -Infinity;
    this.peakLevel = 0;
    this.micStartTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      const stopping = this.stop(false);
      void this.setPhase('error', 'The microphone didn’t send audio. Check Voice & Audio settings and try again.');
      void stopping;
    }, MIC_START_TIMEOUT_MS);
    try {
      if (!this.spotter && this.wakeEnabled) {
        const spotter = await createWakeSpotter(controller.signal);
        if (generation !== this.generation) { spotter.dispose(); return; }
        this.spotter = spotter;
      }
      if (generation !== this.generation) return;
      await this.spotter?.reset();
      if (generation !== this.generation) return;
      if (this.mode === 'utterance') await this.beginUtterance();
      await this.ensureCapture(inputDeviceId, noiseSuppression, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error && error.name === 'NotAllowedError'
        ? 'Microphone access was denied. Check your Windows microphone settings.'
        : error instanceof Error && error.name === 'NotFoundError'
          ? 'No microphone was found.'
          : error instanceof Error ? error.message : 'Microphone unavailable';
      await this.stop(false);
      await this.setPhase('error', message);
    }
  }

  private async refreshInputDevices(): Promise<MediaDeviceInfo[]> {
    const scan = ++this.deviceScan;
    const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => null);
    const inputs = devices?.filter(device => device.kind === 'audioinput') ?? [];
    if (!devices || scan !== this.deviceScan) return inputs;
    const ids = new Set(inputs.map(device => device.deviceId).filter(id => id && id !== 'default' && id !== 'communications'));
    if (this.knownInputs) {
      this.recentInput = [...ids].find(id => !this.knownInputs!.has(id))
        ?? (this.recentInput && ids.has(this.recentInput) ? this.recentInput : undefined);
    }
    if (ids.size || this.knownInputs) this.knownInputs = ids;
    return inputs;
  }

  private async ensureCapture(inputDeviceId: string | undefined, noiseSuppression: boolean, generation: number): Promise<void> {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable');
    const devices = await this.refreshInputDevices();
    if (!this.mode || generation !== this.generation) return;
    const pinned = inputDeviceId && devices.some(device => device.deviceId === inputDeviceId) ? inputDeviceId : undefined;
    const selected = pinned ?? this.recentInput;
    const capture = (deviceId?: string) => navigator.mediaDevices.getUserMedia({ audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      noiseSuppression,
      autoGainControl: true,
      echoCancellation: this.mode === 'wake',
      channelCount: 1,
      sampleRate: 16_000,
    } });
    let stream: MediaStream;
    try {
      stream = await capture(selected);
    } catch (error) {
      if (!selected || pinned || generation !== this.generation || !this.mode
        || !['NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes((error as DOMException)?.name)) throw error;
      stream = await capture();
    }
    if (!this.mode || generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    void this.refreshInputDevices();
    this.micLabel = stream.getAudioTracks()[0]?.label.replace(/^Default - /, '') || 'the selected microphone';
    this.stream.getAudioTracks()[0]?.addEventListener('ended', () => { void this.stop().then(() => this.setPhase('error', 'Microphone disconnected')); }, { once: true });
    try { this.context = new AudioContext({ sampleRate: 16_000 }); }
    catch { this.context = new AudioContext(); }
    const context = this.context;
    await context.audioWorklet.addModule(new URL('/audio.capture.worklet.js', location.href));
    if (!this.mode || generation !== this.generation) return;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = new AudioWorkletNode(this.context, 'kaji-audio-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (generation !== this.generation || !this.mode) return;
      const samples = downsample(event.data, context.sampleRate);
      this.chain = this.chain.then(() => {
        if (generation === this.generation && this.mode) return this.handleSamples(samples);
      }).catch((error) => {
        if (generation === this.generation && this.mode) return this.setPhase('error', error instanceof Error ? error.message : 'Audio processing failed');
      });
    };
    this.source.connect(this.processor);
    this.processor.connect(this.context.destination);
    await this.context.resume();
  }

  private async handleSamples(samples: Float32Array): Promise<void> {
    if (!this.mode || this.speaking || this.transcriptionPending || !samples.length) return;
    if (this.micStartTimer !== undefined) {
      clearTimeout(this.micStartTimer);
      this.micStartTimer = undefined;
    }
    const level = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    this.peakLevel = Math.max(this.peakLevel, level);
    if (performance.now() - this.lastLevelAt >= 50) {
      this.lastLevelAt = performance.now();
      void this.setPhase(this.mode === 'wake' && !this.capturing ? 'wake' : 'listening', undefined, this.peakLevel);
      this.peakLevel = 0;
    }
    if (this.capturing) {
      await this.recordUtterance(samples, level);
      return;
    }
    if (this.mode !== 'wake' || !this.wakeEnabled || !this.spotter) return;
    const generation = this.generation;
    const hits = await this.spotter.processAudio(samples, 16_000);
    if (generation !== this.generation || this.mode !== 'wake') return;
    if (hits.some((hit) => hit.label === 'Hey Kaji')) void this.beginUtterance();
  }

  private async beginUtterance(): Promise<void> {
    if (!this.mode || this.capturing || this.transcriptionPending || this.speaking) return;
    this.recording = [];
    this.recordingMs = 0;
    this.captureElapsedMs = 0;
    this.quietMs = 0;
    this.noiseFloor = 0;
    this.heardSpeech = false;
    this.capturing = true;
    this.finishingUtterance = false;
    const generation = this.generation;
    this.captureRoute = fetchRuntime()
      .then((snapshot) => generation === this.generation ? utteranceRoute(snapshot) : { voiceSessionId: 0 })
      .catch(() => ({ voiceSessionId: 0 }));
    await this.captureRoute;
    if (generation !== this.generation || !this.mode || !this.capturing) return;
    if (this.micStartTimer === undefined) void this.setPhase('listening');
  }

  private async recordUtterance(samples: Float32Array, level: number): Promise<void> {
    const durationMs = samples.length / 16_000 * 1000;
    this.captureElapsedMs += durationMs;
    const threshold = Math.max(0.00012 + (100 - this.sensitivity) * 0.000004, this.noiseFloor * 4);
    const quiet = level < threshold;
    if (quiet && !this.heardSpeech) {
      this.noiseFloor += (level - this.noiseFloor) * Math.min(1, durationMs / 250);
    }
    if (!this.heardSpeech && quiet) {
      if (this.captureElapsedMs >= NO_SPEECH_TIMEOUT_MS) {
        this.capturing = false;
        if (this.mode === 'wake') await this.resumeWakeOrStop();
        else {
          await this.stop(false);
          await this.setPhase('error', `No speech detected on ${this.micLabel}. Check the input device in Voice & Audio.`);
        }
      }
      return;
    }
    this.heardSpeech = true;
    this.recording.push(samples.slice());
    this.recordingMs += durationMs;
    this.quietMs = quiet ? this.quietMs + durationMs : 0;
    if (this.quietMs >= END_SILENCE_MS || this.recordingMs >= MAX_UTTERANCE_MS) await this.finishUtterance();
  }

  private async finishUtterance(): Promise<void> {
    if (this.finishingUtterance || this.transcriptionPending) return;
    if (!this.recording.length) { this.capturing = false; await this.resumeWakeOrStop(); return; }
    this.finishingUtterance = true;
    this.capturing = false;
    this.transcriptionPending = true;
    const generation = this.generation;
    const chunks = this.recording;
    const hadSpeech = this.heardSpeech;
    const route = await this.captureRoute;
    if (generation !== this.generation || !this.mode) return;
    this.recording = [];
    this.capturing = false;
    this.heardSpeech = false;
    this.recordingMs = 0;
    this.captureElapsedMs = 0;
    this.quietMs = 0;
    if (!hadSpeech) { if (this.mode === 'wake') await this.setPhase('wake'); return; }
    const id = crypto.randomUUID();
    if (this.soundEffects && this.context?.state === 'running') {
      try { playSendCue(this.context); } catch {}
    }
    let failed = false;
    try {
      await this.setPhase('transcribing');
      let peak = 0;
      for (const chunk of chunks) for (const sample of chunk) peak = Math.max(peak, Math.abs(sample));
      const gain = Math.max(1, Math.min(64, 0.6 / peak));
      const accepted = await dispatchRuntime({ type: 'audio.transcribe', utteranceId: id, wavBase64: toBase64(encodeWav(chunks, gain)), ...route });
      if (generation !== this.generation || !this.mode) return;
      await this.waitForTranscription(accepted.revision, generation);
      failed = (this.runtimeSnapshot ?? accepted).voice.phase === 'error';
    } catch (error) {
      if (generation !== this.generation || !this.mode) return;
      failed = true;
      await this.setPhase('error', error instanceof Error ? error.message : 'Speech service unavailable');
    } finally {
      if (generation === this.generation) {
        this.finishingUtterance = false;
        this.transcriptionPending = false;
        this.captureRoute = Promise.resolve({ voiceSessionId: 0 });
        if (failed) await this.stop(false);
        else await this.resumeWakeOrStop();
      }
    }
  }

  private acceptRuntime(snapshot: RuntimeSnapshot): void {
    if (snapshot.revision <= (this.runtimeSnapshot?.revision ?? -1)) return;
    this.runtimeSnapshot = snapshot;
    if (this.playbackSession !== undefined && this.playbackSession !== snapshot.voice.sessionId) {
      this.playbackGeneration++;
      this.stopPlayback?.();
      this.audio.pause();
      this.speaking = false;
      this.playbackSession = undefined;
    }
    const waiter = this.transcriptionWaiter;
    if (waiter && waiter.generation === this.generation && snapshot.revision > waiter.afterRevision && snapshot.voice.phase !== 'transcribing') {
      this.transcriptionWaiter = undefined;
      waiter.resolve();
    }
  }

  private waitForTranscription(afterRevision: number, generation: number): Promise<void> {
    const current = this.runtimeSnapshot;
    if (current && current.revision >= afterRevision && current.voice.phase !== 'transcribing') return Promise.resolve();
    return new Promise((resolve) => {
      this.transcriptionWaiter = { afterRevision, generation, resolve };
      if (generation !== this.generation) {
        this.transcriptionWaiter = undefined;
        resolve();
      }
    });
  }

  private async resumeWakeOrStop(): Promise<void> {
    const generation = this.generation;
    if (this.wakeEnabled && this.spotter && this.mode) {
      this.mode = 'wake';
      await this.spotter.reset().catch(() => {});
      if (generation !== this.generation || !this.mode) return;
      await this.setPhase('wake');
    } else if (this.mode) await this.stop();
  }

  private async play(control: Extract<AudioControl, { type: 'play' }>): Promise<void> {
    if (this.playedUtterances.has(control.utteranceId)) return;
    const generation = this.generation;
    const request = ++this.playbackRequest;
    const snapshot = await fetchRuntime().catch(() => null);
    if (generation !== this.generation || request !== this.playbackRequest || !snapshot) return;
    this.acceptRuntime(snapshot);
    if (this.runtimeSnapshot?.voice.sessionId !== control.voiceSessionId || this.runtimeSnapshot.activeConversationId !== control.conversationId) return;
    const playbackGeneration = ++this.playbackGeneration;
    this.stopPlayback?.();
    const current = () => generation === this.generation && playbackGeneration === this.playbackGeneration;
    this.playbackSession = control.voiceSessionId;
    this.playedUtterances.add(control.utteranceId);
    if (this.playedUtterances.size > 64) this.playedUtterances.delete(this.playedUtterances.values().next().value!);
    this.speaking = true;
    await this.setPhase('speaking');
    if (!current()) return;
    let url: string | undefined;
    let failed = false;
    try {
      const bytes = Uint8Array.from(atob(control.audioBase64), (char) => char.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes.buffer], { type: control.mimeType }));
      this.audio.src = url;
      this.audio.volume = Math.max(0, Math.min(1, control.volume));
      const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [];
      if (!current()) return;
      if (control.outputDeviceId && devices.some((device) => device.kind === 'audiooutput' && device.deviceId === control.outputDeviceId) && 'setSinkId' in this.audio) {
        await (this.audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(control.outputDeviceId);
      }
      if (!current()) return;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          this.audio.onended = null;
          this.audio.onerror = null;
          this.stopPlayback = undefined;
          if (error) reject(error); else resolve();
        };
        this.stopPlayback = () => { this.audio.pause(); finish(); };
        this.audio.onended = () => finish();
        this.audio.onerror = () => finish(new Error('Speech playback failed'));
        void this.audio.play().catch((error: unknown) => finish(error instanceof Error ? error : new Error('Speech playback failed')));
      });
    } catch (error) {
      failed = true;
      if (current()) await this.setPhase('error', error instanceof Error ? error.message : 'Speech playback failed');
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (!current()) return;
      this.speaking = false;
      this.playbackSession = undefined;
      await this.spotter?.reset().catch(() => {});
      if (!current() || failed) return;
      if (this.mode === 'wake') await this.setPhase('wake');
      else if (this.mode) await this.setPhase('listening');
      else await this.setPhase('off');
    }
  }

  private async stop(report = true): Promise<void> {
    const generation = ++this.generation;
    this.playbackRequest++;
    this.playbackGeneration++;
    this.startAbort?.abort();
    this.startAbort = null;
    if (this.micStartTimer !== undefined) clearTimeout(this.micStartTimer);
    this.micStartTimer = undefined;
    this.stopPlayback?.();
    this.audio.pause();
    this.mode = null;
    this.capturing = false;
    this.finishingUtterance = false;
    this.transcriptionPending = false;
    this.speaking = false;
    this.playbackSession = undefined;
    this.recording = [];
    const waiter = this.transcriptionWaiter;
    this.transcriptionWaiter = undefined;
    waiter?.resolve();
    this.processor?.disconnect(); this.processor?.port.close(); this.processor = null;
    this.source?.disconnect(); this.source = null;
    this.stream?.getTracks().forEach((track) => track.stop()); this.stream = null;
    const context = this.context;
    this.context = null;
    this.spotter?.dispose(); this.spotter = null;
    await context?.close().catch(() => {});
    if (report && generation === this.generation) await this.setPhase('off');
  }

  private async setPhase(phase: 'off' | 'wake' | 'listening' | 'transcribing' | 'speaking' | 'error', reason?: string, audioLevel?: number): Promise<void> {
    try {
      await dispatchRuntime({ type: 'audio.state', phase, ...(reason ? { reason } : {}), ...(audioLevel !== undefined ? { audioLevel } : {}) });
    } catch {
      if (phase === 'error') this.audio.title = reason ?? 'Audio unavailable';
    }
  }
}

async function initAudioHost(): Promise<void> {
  const host = new AudioHost();
  await host.mount();
}

if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', () => { void initAudioHost(); });
