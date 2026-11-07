import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { AppSettings, EngineGuiStatus } from './types';
import type { ConversationRecord, ConversationSummary, RuntimeAction, RuntimeSnapshot } from '../../shared/runtime';
import { RUNTIME_UPDATE_EVENT } from '../../shared/runtime';
import { GATEWAY_MODELS } from '../../shared/models';

export const DEFAULT_SETTINGS: AppSettings = {
  // General
  language: 'English (US)',
  launch_on_startup: true,
  minimize_to_tray: true,
  notifications: true,
  startup_open: 'composer',

  // Voice & Audio
  microphone: 'Microphone (Realtek Audio)',
  noise_suppression: true,
  voice_activation: true,
  wake_phrase: 'Hey Kaji',
  input_sensitivity: 50,
  push_to_talk_shortcut: 'Ctrl + Space',
  speaker: 'Speakers (Realtek Audio)',
  voice_feedback: true,
  speech_voice_id: 'CwhRBWXzGAHq8TQ4Fs17',
  sound_effects: true,
  response_volume: 75,
  recognition_language: 'Adaptive',
  offline_voice_pack: 'Installed',
  transcription: 'Balanced',

  // Head Control
  enable_head_control: true,
  camera: 'Integrated Camera (RGB)',
  sensitivity: 50,
  dwell_time: 1.2,
  click_behavior: 'dwell',
  smoothing: 50,

  // AI & Models
  ai_provider: 'cloud',
  model: 'ag/gemini-3.8-flash-medium',
  capabilities_screen: true,
  capabilities_vision: true,
  capabilities_actions: true,
  response_language: 'Adaptive',
  response_style: 'concise',

  // Permissions & Safety
  permission_screen: true,
  permission_input: true,
  permission_apps: true,
  confirmation_policy: 'auto_review',
  agent_autonomy: 50,
  emergency_stop_shortcut: 'Ctrl + Alt + Esc',
  pause_on_lock_fullscreen: true,
  limit_to_allowed_apps: false,

  // Appearance
  theme: 'light',
  accent_color: 'blue',
  composer_position: 'floating',
  composer_size: 100,
  composer_opacity: 100,
  action_highlight: true,
  cursor_effect: true,
  overlay_style: 'subtle',

  // Privacy & Data
  data_processing: 'local',
  save_history: true,
  retention: '30 days',
  capture_screenshots: true,
  process_image_content: true,
  store_captured_content: false,
  send_analytics: false,
  check_updates: true,

  // Shortcuts
  enable_shortcuts: true,
  shortcut_open_composer: 'Ctrl + Alt + Space',
  shortcut_toggle_listening: 'Ctrl + Alt + L',
  shortcut_toggle_head_control: 'Ctrl + Alt + H',
  shortcut_switch_mode: 'Ctrl + Alt + M',
  shortcut_pause_all: 'Ctrl + Alt + P',
  shortcut_emergency_stop: 'Ctrl + Alt + Esc',
};

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let browserStatus: EngineGuiStatus = {
  phase: 'offline', reason: '', mode: 'assist', head_control_active: false,
  voice_active: false, is_paused: false, session_id: 0,
};

function normalizeLanguage(value: string): string {
  if (value === 'English' || value === 'English (US)') return 'English (US)';
  return value === 'Bahasa Indonesia' ? value : 'Adaptive';
}

export function normalizeSettings(settings: Partial<AppSettings>): AppSettings {
  const knownFields = Object.fromEntries(Object.keys(DEFAULT_SETTINGS)
    .filter((key) => key in settings)
    .map((key) => [key, settings[key as keyof AppSettings]]));
  return {
    ...DEFAULT_SETTINGS,
    ...knownFields,
    model: GATEWAY_MODELS.some(model => model.id === settings.model && model.id.startsWith('ag/')) ? settings.model! : settings.model?.startsWith('Kaji Flash') ? 'Kaji Flash' : 'Kaji Pro',
    confirmation_policy: settings.confirmation_policy === 'full_access' ? 'full_access' : 'auto_review',
    language: normalizeLanguage(settings.language ?? DEFAULT_SETTINGS.language),
    recognition_language: normalizeLanguage(settings.recognition_language ?? DEFAULT_SETTINGS.recognition_language),
    response_language: normalizeLanguage(settings.response_language ?? DEFAULT_SETTINGS.response_language),
  };
}

export async function fetchSettings(): Promise<AppSettings> {
  if (!isTauri) {
    const raw = localStorage.getItem('kaji_settings');
    if (raw) {
      try {
        return normalizeSettings(JSON.parse(raw));
      } catch {}
    }
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const settings = await invoke<AppSettings>('gui_get_settings');
    return normalizeSettings(settings);
  } catch (e) {
    console.error('Failed to get settings from Tauri, using default', e);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function persistSettings(settings: AppSettings): Promise<void> {
  if (!isTauri) {
    localStorage.setItem('kaji_settings', JSON.stringify(settings));
    return;
  }
  await invoke('gui_save_settings', { settings });
}

export async function fetchEngineStatus(): Promise<EngineGuiStatus> {
  if (!isTauri) {
    return { ...browserStatus };
  }
  const runtime = await fetchRuntime();
  return {
    phase: runtime.task?.phase ?? (runtime.head.active ? 'doing' : 'ready'),
    reason: runtime.message || runtime.head.reason || runtime.voice.reason,
    mode: runtime.mode,
    head_control_active: runtime.head.enabled,
    voice_active: runtime.voice.enabled,
    is_paused: runtime.task?.phase === 'paused' || runtime.head.phase === 'paused',
    session_id: runtime.head.sessionId,
  };
}

export async function setMode(mode: 'guide' | 'assist' | 'agent'): Promise<void> {
  await dispatchRuntime({ type: 'mode', mode });
}

export async function toggleHeadControl(enable: boolean): Promise<void> {
  await dispatchRuntime({ type: 'head', enabled: enable });
}

export async function toggleVoice(enable: boolean): Promise<void> {
  await dispatchRuntime({ type: 'listen', enabled: enable });
}

export async function pauseAll(): Promise<void> {
  const runtime = await fetchRuntime();
  await dispatchRuntime({ type: runtime.task?.phase === 'paused' || runtime.head.phase === 'paused' ? 'resume' : 'pause', taskId: runtime.task?.id });
}

export async function emergencyStop(): Promise<void> {
  if (isTauri) {
    await invoke('gui_emergency_stop');
  } else browserStatus.is_paused = true;
}

export async function openSettingsWindow(page?: string): Promise<void> {
  if (isTauri) await invoke('gui_set_view', { view: 'settings' });
  window.location.href = `settings.html${page ? `?page=${page}` : ''}`;
}

export async function openMainWindow(): Promise<void> {
  if (isTauri) await invoke('gui_set_view', { view: 'main' });
  window.location.href = 'index.html';
}

export async function openComposer(scale = 1): Promise<void> {
  if (isTauri) await invoke('gui_set_view', { view: 'composer', width: Math.ceil(472 * scale), height: Math.ceil(92 * scale) });
  window.location.href = 'composer.html';
}

export async function setComposerFrame(width: number, height: number): Promise<void> {
  if (isTauri) await invoke('gui_set_view', { view: 'composer', width: Math.ceil(width), height: Math.ceil(height) });
}

export async function startWindowDrag(): Promise<void> {
  if (isTauri) await getCurrentWindow().startDragging();
}

export async function openGitHub(): Promise<void> {
  if (isTauri) await invoke('gui_open_github');
  else window.open('https://github.com/justhenix/kaji', '_blank', 'noopener,noreferrer');
}

export async function calibrate(): Promise<void> {
  await dispatchRuntime({ type: 'calibrate' });
}

export async function windowMinimize(label: string): Promise<void> {
  if (isTauri) {
    await invoke('gui_window_minimize', { label });
  }
}

export async function windowClose(label: string): Promise<void> {
  if (isTauri) {
    await invoke('gui_window_close', { label });
  } else await openComposer((await fetchSettings()).composer_size / 100);
}

export async function dispatchRuntime(action: RuntimeAction): Promise<RuntimeSnapshot> {
  if (!isTauri) throw new Error('Kaji runtime is unavailable');
  try {
    return await invoke<RuntimeSnapshot>('gui_dispatch', { action });
  } catch (error) {
    if (typeof error === 'string') {
      throw new Error(error.includes('gateway credential')
        ? 'Kaji can’t connect to its AI services. Check AI & Models in Settings.'
        : error);
    }
    throw error;
  }
}

export async function fetchRuntime(): Promise<RuntimeSnapshot> {
  if (!isTauri) throw new Error('Kaji runtime is unavailable');
  return invoke<RuntimeSnapshot>('gui_get_runtime');
}

export type RuntimeUnlisten = (() => void) & { ready: Promise<void> };

export function onRuntimeUpdate(callback: (snapshot: RuntimeSnapshot) => void, onInitialError?: (error: unknown) => void): RuntimeUnlisten {
  let active = true;
  let revision = -1;
  let unlistenFn: (() => void) | undefined;
  const deliver = (snapshot: RuntimeSnapshot) => {
    if (!active || snapshot.revision <= revision) return;
    revision = snapshot.revision;
    callback(snapshot);
  };
  const ready = listen<RuntimeSnapshot>(RUNTIME_UPDATE_EVENT, (event) => deliver(event.payload)).then(async (unlisten) => {
    if (active) unlistenFn = unlisten;
    else unlisten();
    if (!active) return;
    try { deliver(await fetchRuntime()); }
    catch (error) { if (active) onInitialError?.(error); }
  }).catch((error) => { if (active) onInitialError?.(error); });
  const stop = (() => {
    active = false;
    unlistenFn?.();
  }) as RuntimeUnlisten;
  stop.ready = ready;
  return stop;
}

export async function listConversations(query?: string): Promise<ConversationSummary[]> {
  if (!isTauri) throw new Error('Conversation history is unavailable');
  return invoke<ConversationSummary[]>('gui_history_list', query ? { query } : {});
}

export async function getConversation(conversationId: string): Promise<ConversationRecord | null> {
  if (!isTauri) throw new Error('Conversation history is unavailable');
  return invoke<ConversationRecord | null>('gui_history_get', { conversationId });
}

export async function navigateMain(url = 'index.html'): Promise<void> {
  if (isTauri) await invoke('gui_set_view', { view: 'main' });
  window.location.href = url;
}

export function onNavigateSettings(callback: (page: string) => void): () => void {
  if (isTauri) {
    let unlistenFn: (() => void) | null = null;
    listen<string>('navigate-settings', (event) => {
      callback(event.payload);
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }
  return () => {};
}

export function setupSliderFill(slider: HTMLInputElement): void {
  const update = () => {
    const min = Number(slider.min) || 0;
    const max = Number(slider.max) || 100;
    const val = Number(slider.value);
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    slider.style.setProperty('--fill-percent', `${pct}%`);
  };
  update();
  slider.addEventListener('input', update);
}

export function onSettingsUpdated(callback: (settings: AppSettings) => void): () => void {
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('kaji-settings-sync') : null;
  if (channel) {
    channel.onmessage = (event) => {
      if (event.data) {
        callback(normalizeSettings(event.data));
      }
    };
  }

  const storageHandler = (e: StorageEvent) => {
    if (e.key === 'kaji_settings' && e.newValue) {
      try {
        callback(normalizeSettings(JSON.parse(e.newValue)));
      } catch {}
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', storageHandler);
  }

  let unlistenFn: (() => void) | null = null;
  if (isTauri) {
    listen<AppSettings>('settings-updated', (event) => {
      callback(normalizeSettings(event.payload));
    }).then((unlisten) => {
      unlistenFn = unlisten;
    }).catch(() => {});
  }

  return () => {
    if (channel) channel.close();
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', storageHandler);
    }
    if (unlistenFn) unlistenFn();
  };
}

export function broadcastSettings(settings: AppSettings): void {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('kaji-settings-sync');
      channel.postMessage(settings);
      channel.close();
    }
  } catch {}
}
