use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use crate::engine::Engine;

fn default_speech_voice_id() -> String {
    "CwhRBWXzGAHq8TQ4Fs17".into() // ElevenLabs Roger
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppSettings {
    // 1. General
    pub language: String,
    pub launch_on_startup: bool,
    pub minimize_to_tray: bool,
    pub notifications: bool,
    pub startup_open: String,

    // 2. Voice & Audio
    pub microphone: String,
    pub noise_suppression: bool,
    pub voice_activation: bool,
    pub wake_phrase: String,
    pub input_sensitivity: u32,
    pub push_to_talk_shortcut: String,
    pub speaker: String,
    pub voice_feedback: bool,
    #[serde(default = "default_speech_voice_id")]
    pub speech_voice_id: String,
    pub sound_effects: bool,
    pub response_volume: u32,
    pub recognition_language: String,
    pub offline_voice_pack: String,
    pub transcription: String,

    // 3. Head Control
    pub enable_head_control: bool,
    pub camera: String,
    pub sensitivity: u32,
    pub dwell_time: f64,
    pub click_behavior: String,
    pub smoothing: u32,

    // 4. AI & Models
    pub ai_provider: String,
    pub model: String,
    pub capabilities_screen: bool,
    pub capabilities_vision: bool,
    pub capabilities_actions: bool,
    pub response_language: String,
    pub response_style: String,

    // 5. Permissions & Safety
    pub permission_screen: bool,
    pub permission_input: bool,
    pub permission_apps: bool,
    pub confirmation_policy: String,
    pub agent_autonomy: u32,
    pub emergency_stop_shortcut: String,
    pub pause_on_lock_fullscreen: bool,
    pub limit_to_allowed_apps: bool,

    // 6. Appearance
    pub theme: String,
    pub accent_color: String,
    pub composer_position: String,
    pub composer_size: u32,
    pub composer_opacity: u32,
    pub action_highlight: bool,
    pub cursor_effect: bool,
    pub overlay_style: String,

    // 7. Privacy & Data
    pub data_processing: String,
    pub save_history: bool,
    pub retention: String,
    pub capture_screenshots: bool,
    pub process_image_content: bool,
    pub store_captured_content: bool,
    pub send_analytics: bool,
    pub check_updates: bool,

    // 8. Shortcuts
    pub enable_shortcuts: bool,
    pub shortcut_open_composer: String,
    pub shortcut_toggle_listening: String,
    pub shortcut_toggle_head_control: String,
    pub shortcut_switch_mode: String,
    pub shortcut_pause_all: String,
    pub shortcut_emergency_stop: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            // General
            language: "English (US)".into(),
            launch_on_startup: true,
            minimize_to_tray: true,
            notifications: true,
            startup_open: "composer".into(),

            // Voice & Audio
            microphone: "Microphone (Realtek Audio)".into(),
            noise_suppression: true,
            voice_activation: true,
            wake_phrase: "Hey Kaji".into(),
            input_sensitivity: 50,
            push_to_talk_shortcut: "Ctrl + Space".into(),
            speaker: "Speakers (Realtek Audio)".into(),
            voice_feedback: true,
            speech_voice_id: default_speech_voice_id(),
            sound_effects: true,
            response_volume: 75,
            recognition_language: "Adaptive".into(),
            offline_voice_pack: "Installed".into(),
            transcription: "Balanced".into(),

            // Head Control
            enable_head_control: true,
            camera: "Integrated Camera (RGB)".into(),
            sensitivity: 50,
            dwell_time: 1.2,
            click_behavior: "dwell".into(),
            smoothing: 50,

            // AI & Models
            ai_provider: "cloud".into(),
            model: "Kaji Pro".into(),
            capabilities_screen: true,
            capabilities_vision: true,
            capabilities_actions: true,
            response_language: "Adaptive".into(),
            response_style: "concise".into(),

            // Permissions & Safety
            permission_screen: true,
            permission_input: true,
            permission_apps: true,
            confirmation_policy: "auto_review".into(),
            agent_autonomy: 50,
            emergency_stop_shortcut: "Ctrl + Alt + Esc".into(),
            pause_on_lock_fullscreen: true,
            limit_to_allowed_apps: false,

            // Appearance
            theme: "light".into(),
            accent_color: "blue".into(),
            composer_position: "floating".into(),
            composer_size: 100,
            composer_opacity: 100,
            action_highlight: true,
            cursor_effect: true,
            overlay_style: "subtle".into(),

            // Privacy & Data
            data_processing: "local".into(),
            save_history: true,
            retention: "30 days".into(),
            capture_screenshots: true,
            process_image_content: true,
            store_captured_content: false,
            send_analytics: false,
            check_updates: true,

            // Shortcuts
            enable_shortcuts: true,
            shortcut_open_composer: "Ctrl + Alt + Space".into(),
            shortcut_toggle_listening: "Ctrl + Alt + L".into(),
            shortcut_toggle_head_control: "Ctrl + Alt + H".into(),
            shortcut_switch_mode: "Ctrl + Alt + M".into(),
            shortcut_pause_all: "Ctrl + Alt + P".into(),
            shortcut_emergency_stop: "Ctrl + Alt + Esc".into(),
        }
    }
}

impl AppSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.language.trim().is_empty() {
            return Err("language cannot be empty".into());
        }
        if self.startup_open != "composer" && self.startup_open != "mainWindow" {
            return Err("startup_open must be composer or mainWindow".into());
        }
        if self.input_sensitivity > 100 {
            return Err("input_sensitivity must be 0-100".into());
        }
        if self.response_volume > 100 {
            return Err("response_volume must be 0-100".into());
        }
        if self.speech_voice_id.is_empty()
            || self.speech_voice_id.len() > 128
            || !self
                .speech_voice_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("invalid ElevenLabs voice ID".into());
        }
        if self.sensitivity > 100 {
            return Err("sensitivity must be 0-100".into());
        }
        if !self.dwell_time.is_finite() || !(0.5..=5.0).contains(&self.dwell_time) {
            return Err("dwell_time must be between 0.5s and 5.0s".into());
        }
        if self.click_behavior != "dwell" && self.click_behavior != "hold" {
            return Err("click_behavior must be dwell or hold".into());
        }
        if self.ai_provider != "cloud"
            && self.ai_provider != "local"
            && self.ai_provider != "custom"
        {
            return Err("ai_provider must be cloud, local, or custom".into());
        }
        if self.response_style != "concise"
            && self.response_style != "balanced"
            && self.response_style != "detailed"
        {
            return Err("response_style must be concise, balanced, or detailed".into());
        }
        if !matches!(
            self.model.as_str(),
            "Kaji Pro" | "Kaji Flash" | "ag/gemini-3.8-flash-medium" | "ag/gemini-3.8-flash-high"
        ) {
            return Err("selected model is not enabled".into());
        }
        if !matches!(
            self.response_language.as_str(),
            "English (US)" | "Bahasa Indonesia" | "Adaptive"
        ) {
            return Err(
                "response_language must be English (US), Bahasa Indonesia, or Adaptive".into(),
            );
        }
        if self.confirmation_policy != "full_access" && self.confirmation_policy != "auto_review" {
            return Err("confirmation_policy must be full_access or auto_review".into());
        }
        if self.agent_autonomy > 100 {
            return Err("agent_autonomy must be 0-100".into());
        }
        if self.theme != "light" && self.theme != "dark" && self.theme != "system" {
            return Err("theme must be light, dark, or system".into());
        }
        if self.accent_color != "blue"
            && self.accent_color != "purple"
            && self.accent_color != "pink"
            && self.accent_color != "cyan"
            && self.accent_color != "green"
        {
            return Err("accent_color must be blue, purple, pink, cyan, or green".into());
        }
        if self.composer_position != "top"
            && self.composer_position != "floating"
            && self.composer_position != "taskbar"
        {
            return Err("composer_position must be top, floating, or taskbar".into());
        }
        if !(50..=150).contains(&self.composer_size) {
            return Err("composer_size must be 50-150%".into());
        }
        if !(20..=100).contains(&self.composer_opacity) {
            return Err("composer_opacity must be 20-100%".into());
        }
        if self.overlay_style != "subtle"
            && self.overlay_style != "clear"
            && self.overlay_style != "off"
        {
            return Err("overlay_style must be subtle, clear, or off".into());
        }
        if self.data_processing != "local" && self.data_processing != "cloud" {
            return Err("data_processing must be local or cloud".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct EngineGuiStatus {
    pub phase: String,
    pub reason: String,
    pub mode: String,
    pub head_control_active: bool,
    pub voice_active: bool,
    pub is_paused: bool,
    pub session_id: u64,
}

pub struct GuiManager {
    pub engine: Arc<Engine>,
    pub settings_path: PathBuf,
    pub settings: Mutex<AppSettings>,
    pub mode: Mutex<String>,
    pub head_control_active: Mutex<bool>,
    pub voice_active: Mutex<bool>,
    pub is_paused: Mutex<bool>,
}

impl GuiManager {
    pub fn new(engine: Arc<Engine>) -> Self {
        Self::new_with_settings(engine, Self::load_saved_settings())
    }

    pub fn load_saved_settings() -> AppSettings {
        let path = get_settings_file_path();
        load_settings(&path)
    }

    pub fn new_with_settings(engine: Arc<Engine>, settings: AppSettings) -> Self {
        let settings_path = get_settings_file_path();
        let mut loaded_settings = settings;
        if loaded_settings.confirmation_policy != "full_access"
            && loaded_settings.confirmation_policy != "auto_review"
        {
            loaded_settings.confirmation_policy = "auto_review".into();
        }
        loaded_settings.model = if matches!(
            loaded_settings.model.as_str(),
            "ag/gemini-3.8-flash-medium" | "ag/gemini-3.8-flash-high"
        ) {
            loaded_settings.model.clone()
        } else if loaded_settings.model.starts_with("Kaji Flash") {
            "Kaji Flash".into()
        } else {
            "Kaji Pro".into()
        };
        for value in [
            &mut loaded_settings.language,
            &mut loaded_settings.recognition_language,
            &mut loaded_settings.response_language,
        ] {
            *value = match value.as_str() {
                "English" | "English (US)" => "English (US)",
                "Bahasa Indonesia" => "Bahasa Indonesia",
                _ => "Adaptive",
            }
            .into();
        }

        let initial_mode = "assist".to_string();
        let initial_head = false;
        let initial_voice = false;

        Self {
            engine,
            settings_path,
            settings: Mutex::new(loaded_settings),
            mode: Mutex::new(initial_mode),
            head_control_active: Mutex::new(initial_head),
            voice_active: Mutex::new(initial_voice),
            is_paused: Mutex::new(false),
        }
    }
}

fn load_settings(settings_path: &Path) -> AppSettings {
    if settings_path.exists() {
        match fs::read_to_string(settings_path) {
            Ok(content) => serde_json::from_str::<AppSettings>(&content).unwrap_or_default(),
            Err(_) => AppSettings::default(),
        }
    } else {
        AppSettings::default()
    }
}

impl GuiManager {
    pub fn get_settings(&self) -> Result<AppSettings, String> {
        let lock = self
            .settings
            .lock()
            .map_err(|_| "settings mutex poisoned")?;
        Ok(lock.clone())
    }

    pub fn save_settings(&self, new_settings: AppSettings) -> Result<(), String> {
        new_settings.validate()?;
        if let Some(parent) = self.settings_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let serialized = serde_json::to_string_pretty(&new_settings).map_err(|e| e.to_string())?;
        fs::write(&self.settings_path, serialized).map_err(|e| e.to_string())?;

        let mut lock = self
            .settings
            .lock()
            .map_err(|_| "settings mutex poisoned")?;
        *lock = new_settings.clone();

        // Sync operational toggles
        if let Ok(mut h) = self.head_control_active.lock() {
            *h = new_settings.enable_head_control;
        }
        if let Ok(mut v) = self.voice_active.lock() {
            *v = new_settings.voice_activation;
        }

        Ok(())
    }

    pub fn get_status(&self) -> Result<EngineGuiStatus, String> {
        let engine_status = self.engine.status().ok();
        let phase = engine_status
            .as_ref()
            .map(|s| s.phase.clone())
            .unwrap_or_else(|| "ready".into());
        let reason = engine_status
            .as_ref()
            .map(|s| s.reason.clone())
            .unwrap_or_else(|| "Kaji engine ready".into());
        let session_id = engine_status.as_ref().map(|s| s.session).unwrap_or(0);

        let mode = self
            .mode
            .lock()
            .map(|m| m.clone())
            .unwrap_or_else(|_| "assist".into());
        let head_control_active = *self.head_control_active.lock().map_err(|_| "poisoned")?;
        let voice_active = *self.voice_active.lock().map_err(|_| "poisoned")?;
        let is_paused = *self.is_paused.lock().map_err(|_| "poisoned")?;

        Ok(EngineGuiStatus {
            phase,
            reason,
            mode,
            head_control_active,
            voice_active,
            is_paused,
            session_id,
        })
    }

    pub fn set_mode(&self, new_mode: &str) -> Result<(), String> {
        if new_mode != "guide" && new_mode != "assist" && new_mode != "agent" {
            return Err("mode must be guide, assist, or agent".into());
        }
        let mut mode = self.mode.lock().map_err(|_| "poisoned")?;
        *mode = new_mode.to_string();
        Ok(())
    }

    pub fn toggle_head_control(&self, enable: bool) -> Result<(), String> {
        let mut h = self.head_control_active.lock().map_err(|_| "poisoned")?;
        *h = enable;
        if !enable {
            let _ = self.engine.stop_head("Head control disabled from GUI");
        }
        Ok(())
    }

    pub fn toggle_voice(&self, enable: bool) -> Result<(), String> {
        let mut v = self.voice_active.lock().map_err(|_| "poisoned")?;
        *v = enable;
        Ok(())
    }

    pub fn pause_all(&self) -> Result<(), String> {
        let mut p = self.is_paused.lock().map_err(|_| "poisoned")?;
        *p = !*p;
        let _ = self.engine.stop_head(if *p {
            "GUI pause all actions"
        } else {
            "GUI resume actions"
        });
        Ok(())
    }

    pub fn emergency_stop(&self) -> Result<(), String> {
        let mut p = self.is_paused.lock().map_err(|_| "poisoned")?;
        *p = true;
        self.engine.stop("Emergency stop triggered from GUI")?;
        Ok(())
    }
}

fn get_settings_file_path() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata).join("Kaji").join("settings.json")
    } else {
        PathBuf::from(".kaji-settings.json")
    }
}
#[cfg(test)]
mod tests {
    use super::AppSettings;

    #[test]
    fn defaults_use_auto_review_and_adaptive_response() {
        let settings = AppSettings::default();
        assert_eq!(settings.confirmation_policy, "auto_review");
        assert_eq!(settings.response_language, "Adaptive");
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn settings_accept_only_current_models_policies_and_response_languages() {
        let mut settings = AppSettings::default();
        for value in ["full_access", "auto_review"] {
            settings.confirmation_policy = value.into();
            assert!(settings.validate().is_ok());
        }
        settings.confirmation_policy = "always".into();
        assert!(settings.validate().is_err());
        settings.confirmation_policy = "auto_review".into();
        for value in ["English (US)", "Bahasa Indonesia", "Adaptive"] {
            settings.response_language = value.into();
            assert!(settings.validate().is_ok());
        }
        settings.response_language = "Spanish".into();
        assert!(settings.validate().is_err());
        settings.response_language = "Adaptive".into();
        settings.model = "Kaji Flash".into();
        assert!(settings.validate().is_ok());
        settings.model = "legacy".into();
        assert!(settings.validate().is_err());
        for model in ["ag/gemini-3.8-flash-medium", "ag/gemini-3.8-flash-high"] {
            settings.model = model.into();
            assert!(settings.validate().is_ok());
        }
    }
}
