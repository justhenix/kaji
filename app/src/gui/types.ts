export const LANGUAGE_OPTIONS = ['English (US)', 'Bahasa Indonesia', 'Adaptive'] as const;

export interface AppSettings {
  // 1. General
  language: string;
  launch_on_startup: boolean;
  minimize_to_tray: boolean;
  notifications: boolean;
  startup_open: 'composer' | 'mainWindow';

  // 2. Voice & Audio
  microphone: string;
  noise_suppression: boolean;
  voice_activation: boolean;
  wake_phrase: string;
  input_sensitivity: number;
  push_to_talk_shortcut: string;
  speaker: string;
  voice_feedback: boolean;
  sound_effects: boolean;
  response_volume: number;
  recognition_language: string;
  offline_voice_pack: string;
  transcription: string;

  // 3. Head Control
  enable_head_control: boolean;
  camera: string;
  sensitivity: number;
  dwell_time: number;
  click_behavior: 'dwell' | 'hold';
  smoothing: number;

  // 4. AI & Models
  ai_provider: 'cloud' | 'local' | 'custom';
  model: string;
  capabilities_screen: boolean;
  capabilities_vision: boolean;
  capabilities_actions: boolean;
  response_language: string;
  response_style: 'concise' | 'balanced' | 'detailed';

  // 5. Permissions & Safety
  permission_screen: boolean;
  permission_input: boolean;
  permission_apps: boolean;
  confirmation_policy: 'full_access' | 'auto_review';
  agent_autonomy: number;
  emergency_stop_shortcut: string;
  pause_on_lock_fullscreen: boolean;
  limit_to_allowed_apps: boolean;

  // 6. Appearance
  theme: 'light' | 'dark' | 'system';
  accent_color: 'blue' | 'purple' | 'pink' | 'cyan' | 'green';
  composer_position: 'top' | 'floating' | 'taskbar';
  composer_size: number;
  composer_opacity: number;
  action_highlight: boolean;
  cursor_effect: boolean;
  overlay_style: 'subtle' | 'clear' | 'off';

  // 7. Privacy & Data
  data_processing: 'local' | 'cloud';
  save_history: boolean;
  retention: string;
  capture_screenshots: boolean;
  process_image_content: boolean;
  store_captured_content: boolean;
  send_analytics: boolean;
  check_updates: boolean;

  // 8. Shortcuts
  enable_shortcuts: boolean;
  shortcut_open_composer: string;
  shortcut_toggle_listening: string;
  shortcut_toggle_head_control: string;
  shortcut_switch_mode: string;
  shortcut_pause_all: string;
  shortcut_emergency_stop: string;
}

export interface EngineGuiStatus {
  phase: string;
  reason: string;
  mode: 'guide' | 'assist' | 'agent';
  head_control_active: boolean;
  voice_active: boolean;
  is_paused: boolean;
  session_id: number;
}

export type SettingsTabId =
  | 'general'
  | 'voice'
  | 'head'
  | 'ai'
  | 'permissions'
  | 'appearance'
  | 'privacy'
  | 'shortcuts';

export interface SettingsNavCategory {
  id: SettingsTabId;
  label: string;
  icon: string;
}

export const SETTINGS_CATEGORIES: SettingsNavCategory[] = [
  {
    id: 'general',
    label: 'General',
    icon: 'ri-settings-3-line',
  },
  {
    id: 'voice',
    label: 'Voice & Audio',
    icon: 'ri-mic-line',
  },
  {
    id: 'head',
    label: 'Head Control',
    icon: 'ri-cursor-line',
  },
  {
    id: 'ai',
    label: 'AI & Models',
    icon: 'ri-stack-line',
  },
  {
    id: 'permissions',
    label: 'Permissions & Safety',
    icon: 'ri-shield-line',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'ri-macbook-line',
  },
  {
    id: 'privacy',
    label: 'Privacy & Data',
    icon: 'ri-lock-line',
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: 'ri-keyboard-line',
  },
];
