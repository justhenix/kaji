export type Mode = 'guide' | 'assist' | 'agent';
export type TaskPhase = 'planning' | 'working' | 'awaiting_method' | 'awaiting_user' | 'awaiting_confirmation' | 'verifying' | 'paused' | 'blocked' | 'complete' | 'stopped' | 'error';
// Runtime validates this executor ID against the methods offered for the current task.
export type ExecutionMethod = string;
export type Point = { x: number; y: number };
export type ScreenRect = { left: number; top: number; right: number; bottom: number };

export interface ArtifactReference {
  id: string;
  name: string;
  path: string;
  kind: 'docx' | 'file';
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  taskId?: string;
  artifacts?: ArtifactReference[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  titleSource: 'local' | 'automatic' | 'manual';
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRecord extends ConversationSummary {
  messages: ConversationMessage[];
}

export interface PendingQuestion {
  id: string;
  taskId: string;
  kind: 'clarification' | 'approval' | 'method';
  title: string;
  options: { id: string; label: string; value: string }[];
  allowCustom: boolean;
  optional: boolean;
  splitScreen?: { available: boolean; enabled: boolean; userWindow: string; taskWindow: string };
  expiresAt?: number;
}

export interface TaskState {
  id: string;
  conversationId: string;
  phase: TaskPhase;
  mode: Mode;
  request: string;
  message: string;
  verified: boolean;
  method: ExecutionMethod | null;
  targetWindow: { id: string; title: string } | null;
  artifacts: ArtifactReference[];
}

export interface HeadState {
  enabled: boolean;
  active: boolean;
  phase: string;
  reason: string;
  sessionId: number;
  dwellEnabled: boolean;
  dwellReady: boolean;
  dwellProgress: number;
  cursor: Point | null;
  calibrationSamples: number;
}

export interface VoiceState {
  sessionId: number;
  enabled: boolean;
  phase: 'off' | 'starting' | 'wake' | 'listening' | 'transcribing' | 'speaking' | 'error';
  reason: string;
  audioLevel: number;
  transcript: string;
}

export type AudioControl =
  | { type: 'start'; mode: 'wake' | 'utterance'; wakeEnabled: boolean; inputDeviceId?: string; noiseSuppression: boolean; sensitivity: number; soundEffects?: boolean }
  | { type: 'stop' }
  | { type: 'push-to-talk'; active: boolean }
  | { type: 'play'; utteranceId: string; voiceSessionId: number; conversationId: string; audioBase64: string; mimeType: 'audio/mpeg' | 'audio/wav'; outputDeviceId?: string; volume: number };

export type SensorControl =
  | { type: 'start'; cameraDeviceId?: string }
  | { type: 'stop' | 'reset' | 'calibrate'; cameraDeviceId?: string };

export interface OverlayState {
  mode: 'follow' | 'task' | 'hidden';
  point: Point | null;
  target: ScreenRect | null;
  targetLabel: string;
  dwellProgress: number;
  cursorEnabled: boolean;
  highlightEnabled: boolean;
  viewport?: { left: number; top: number; width: number; height: number; scaleFactor: number };
  monitorScaleFactor?: number;
}

export interface ServiceCapability {
  available: boolean;
  model: string;
  reason?: string;
  remaining?: number;
  resetAt?: number;
  models?: { id: string; label: string; available: boolean }[];
}

export interface ServiceCapabilities {
  reasoning: ServiceCapability;
  vision: ServiceCapability;
  stt: ServiceCapability;
  tts: ServiceCapability & { voices: { id: string; name: string }[] };
  titles: ServiceCapability;
}

export interface RuntimeSnapshot {
  revision: number;
  historyRevision: number;
  mode: Mode;
  activeConversationId: string | null;
  task: TaskState | null;
  question: PendingQuestion | null;
  message: string;
  head: HeadState;
  voice: VoiceState;
  overlay: OverlayState;
  layout: { active: boolean };
  services: ServiceCapabilities | null;
}

export type RuntimeAction =
  | { type: 'request'; text: string; conversationId?: string; source?: 'text' | 'voice' }
  | { type: 'answer'; taskId: string; questionId: string; answer: string }
  | { type: 'confirm'; taskId: string; questionId: string; approved: boolean }
  | { type: 'method'; taskId: string; questionId: string; method: ExecutionMethod | 'rephrase'; splitScreen: boolean }
  | { type: 'skip' | 'dismiss'; taskId: string; questionId: string }
  | { type: 'pause' | 'resume' | 'stop'; taskId?: string }
  | { type: 'mode'; mode: Mode }
  | { type: 'head' | 'dwell'; enabled: boolean }
  | { type: 'listen'; enabled: boolean; immediate?: boolean }
  | { type: 'calibrate' | 'file.select' | 'document.select' | 'layout.restore' | 'services.refresh' }
  | { type: 'conversation.new' }
  | { type: 'conversation.open'; conversationId: string }
  | { type: 'conversation.rename'; conversationId: string; title: string }
  | { type: 'conversation.delete'; conversationId: string }
  | { type: 'artifact.open'; artifactId: string }
  | { type: 'audio.ready' }
  | { type: 'audio.state'; phase: VoiceState['phase']; audioLevel?: number; reason?: string }
  | { type: 'audio.transcribe'; utteranceId: string; wavBase64: string; taskId?: string; questionId?: string; conversationId?: string; voiceSessionId: number };

export interface TaskStep {
  instruction: string;
  target: Record<string, unknown>;
  action: Record<string, unknown>;
  expect: Record<string, unknown>;
}

export type DesktopHostInput =
  | { type: 'start'; taskId: string; conversationId: string; text: string; mode: Mode; model?: string; hwnd?: number; nativeSessionId?: number; method?: ExecutionMethod }
  | { type: 'answer'; taskId: string; questionId: string; answer: string }
  | { type: 'method'; taskId: string; questionId: string; method: ExecutionMethod | 'rephrase'; splitScreen: boolean }
  | { type: 'continue' | 'pause' | 'resume' | 'stop'; taskId: string }
  | { type: 'native_response'; id: string; taskId: string; result?: unknown; error?: string }
  | { type: 'shutdown' };

export type DesktopHostOutput =
  | { type: 'ready' }
  | { type: 'native_request'; id: string; taskId: string; command: Record<string, unknown> }
  | { type: 'update'; taskId: string; phase?: TaskPhase; message?: string; question?: Omit<PendingQuestion, 'taskId'> | null; step?: TaskStep }
  | { type: 'result'; taskId: string; phase: 'complete' | 'blocked' | 'stopped' | 'error'; message: string; verified: boolean }
  | { type: 'error'; taskId?: string; message: string };

export const RUNTIME_UPDATE_EVENT = 'kaji:runtime-update';
export const AUDIO_CONTROL_EVENT = 'kaji:audio-control';
export const SENSOR_CONTROL_EVENT = 'kaji:sensor-control';
export const OVERLAY_UPDATE_EVENT = 'kaji:overlay-update';
