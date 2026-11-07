use kaji_engine::{
    assist::Mode,
    gui::{AppSettings, GuiManager},
    native,
    runtime::{RuntimeAction, RuntimeManager},
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::{
    Foundation::{LPARAM, WPARAM},
    System::Threading::GetCurrentThreadId,
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

const RECONFIGURE: u32 = WM_APP + 41;
const FIRST_ID: i32 = 0x4b00;
pub const STATUS_EVENT: &str = "kaji:shortcuts-updated";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub id: usize,
    pub label: &'static str,
    pub keys: String,
    pub available: bool,
    pub reason: Option<String>,
}

fn bindings(settings: &AppSettings) -> [(&'static str, String); 6] {
    [
        ("Show Kaji", settings.shortcut_open_composer.clone()),
        (
            "Start or stop voice input",
            settings.shortcut_toggle_listening.clone(),
        ),
        (
            "Turn Dwell on or off",
            settings.shortcut_toggle_head_control.clone(),
        ),
        (
            "Switch Guide, Assist or Agent",
            settings.shortcut_switch_mode.clone(),
        ),
        ("Pause or resume", settings.shortcut_pause_all.clone()),
        ("Stop all actions", settings.shortcut_emergency_stop.clone()),
    ]
}

fn parse_keys(keys: &str) -> Result<(HOT_KEY_MODIFIERS, u32), String> {
    let mut modifiers = MOD_NOREPEAT;
    let mut key = None;
    for token in keys.split('+').map(str::trim) {
        match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers |= MOD_CONTROL,
            "alt" => modifiers |= MOD_ALT,
            "shift" => modifiers |= MOD_SHIFT,
            "win" | "super" => modifiers |= MOD_WIN,
            value => {
                let vk = match value {
                    "space" => VK_SPACE.0 as u32,
                    "esc" | "escape" => VK_ESCAPE.0 as u32,
                    _ if value.len() == 1 && value.as_bytes()[0].is_ascii_alphanumeric() => {
                        value.as_bytes()[0].to_ascii_uppercase() as u32
                    }
                    _ => return Err("Choose a letter, number, Space or Escape.".into()),
                };
                if key.replace(vk).is_some() {
                    return Err("Use one key with modifiers.".into());
                }
            }
        }
    }
    if modifiers == MOD_NOREPEAT {
        return Err("Use Ctrl, Alt, Shift or Win with the key.".into());
    }
    Ok((modifiers, key.ok_or("Choose a key with the modifiers.")?))
}

pub struct Shortcuts {
    state: Arc<Mutex<Vec<ShortcutStatus>>>,
    changes: mpsc::Sender<AppSettings>,
    thread_id: u32,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Shortcuts {
    pub fn start(
        app: AppHandle,
        gui: Arc<GuiManager>,
        runtime: Arc<RuntimeManager>,
    ) -> Result<Self, String> {
        let settings = gui.get_settings()?;
        let state = Arc::new(Mutex::new(Vec::new()));
        let output = state.clone();
        let (changes, updates) = mpsc::channel();
        let (ready, wait) = mpsc::sync_channel(1);
        let thread = thread::Builder::new().name("kaji-shortcuts".into()).spawn(move || unsafe {
            let mut message = MSG::default();
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
            let mut registered = Vec::new();
            let register = |settings: &AppSettings, registered: &mut Vec<i32>| {
                for id in registered.drain(..) { let _ = UnregisterHotKey(None, id); }
                let statuses = bindings(settings).into_iter().enumerate().map(|(index, (label, keys))| {
                    let id = FIRST_ID + index as i32;
                    let result = if !settings.enable_shortcuts { Err("Keyboard shortcuts are off.".into()) }
                        else { parse_keys(&keys).and_then(|(modifiers, key)| RegisterHotKey(None, id, modifiers, key).map_err(|_| "Windows could not register this shortcut. Another app may be using it.".into())) };
                    if result.is_ok() { registered.push(id); }
                    ShortcutStatus {id: index, label, keys, available: result.is_ok(), reason: result.err()}
                }).collect::<Vec<_>>();
                if let Ok(mut output) = output.lock() { *output = statuses.clone(); }
                let _ = app.emit_to("main", STATUS_EVENT, statuses);
            };
            register(&settings, &mut registered);
            let _ = ready.send(GetCurrentThreadId());
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                if message.message == RECONFIGURE {
                    let mut latest = None;
                    while let Ok(settings) = updates.try_recv() { latest = Some(settings); }
                    if let Some(settings) = latest { register(&settings, &mut registered); }
                } else if message.message == WM_HOTKEY && registered.contains(&(message.wParam.0 as i32)) {
                    let action = message.wParam.0 as i32 - FIRST_ID;
                    let key = (message.lParam.0 as usize >> 16) & 0xffff;
                    // Starting head control before key-up would count its own shortcut as manual takeover.
                    let started = Instant::now();
                    while action != 5 && (native::modifiers_down() || GetAsyncKeyState(key as i32) < 0) && started.elapsed() < Duration::from_secs(2) {
                        thread::sleep(Duration::from_millis(10));
                    }
                    if action != 5 && (native::modifiers_down() || GetAsyncKeyState(key as i32) < 0) { continue; }
                    let app = app.clone(); let runtime = runtime.clone();
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Err(error) = activate(action, &handle, &runtime) {
                            let _ = handle.emit_to("main", "kaji:shortcut-error", error);
                        }
                    });
                }
            }
            for id in registered { let _ = UnregisterHotKey(None, id); }
        }).map_err(|error| error.to_string())?;
        let thread_id = wait
            .recv_timeout(Duration::from_secs(3))
            .map_err(|error| error.to_string())?;
        Ok(Self {
            state,
            changes,
            thread_id,
            thread: Mutex::new(Some(thread)),
        })
    }

    pub fn configure(&self, settings: AppSettings) -> Result<(), String> {
        self.changes
            .send(settings)
            .map_err(|error| error.to_string())?;
        unsafe {
            PostThreadMessageW(self.thread_id, RECONFIGURE, WPARAM(0), LPARAM(0))
                .map_err(|error| error.to_string())
        }
    }

    pub fn status(&self) -> Result<Vec<ShortcutStatus>, String> {
        self.state
            .lock()
            .map(|state| state.clone())
            .map_err(|_| "Shortcut status is unavailable.".into())
    }
    pub fn shutdown(&self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Ok(mut thread) = self.thread.lock()
            && let Some(thread) = thread.take()
        {
            let _ = thread.join();
        }
    }
}

impl Drop for Shortcuts {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn activate(action: i32, app: &AppHandle, runtime: &Arc<RuntimeManager>) -> Result<(), String> {
    let state = runtime.snapshot();
    let task_id = state.task.as_ref().map(|task| task.id.clone());
    let command = match action {
        0 => {
            let window = app
                .get_webview_window("main")
                .ok_or("Kaji window is unavailable.")?;
            window.unminimize().map_err(|error| error.to_string())?;
            window.show().map_err(|error| error.to_string())?;
            return window.set_focus().map_err(|error| error.to_string());
        }
        1 => RuntimeAction::Listen {
            enabled: !state.voice.enabled,
            immediate: true,
        },
        2 => RuntimeAction::Dwell {
            enabled: !state.head.enabled,
        },
        3 => RuntimeAction::Mode {
            mode: match state.mode {
                Mode::Guide => Mode::Assist,
                Mode::Assist => Mode::Agent,
                Mode::Agent => Mode::Guide,
            },
        },
        4 => {
            if state
                .task
                .as_ref()
                .is_some_and(|task| task.phase == kaji_engine::runtime::TaskPhase::Paused)
                || state.head.phase == "paused"
            {
                RuntimeAction::Resume { task_id }
            } else {
                RuntimeAction::Pause { task_id }
            }
        }
        5 => return runtime.emergency_stop(),
        _ => return Err("Unknown keyboard shortcut.".into()),
    };
    runtime.dispatch(command).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_default_bindings_are_valid_and_distinct() {
        let mut keys = std::collections::HashSet::new();
        for (_, binding) in bindings(&AppSettings::default()) {
            let (modifiers, key) = parse_keys(&binding).unwrap();
            assert!(keys.insert((modifiers.0, key)));
            assert!(modifiers.contains(MOD_NOREPEAT));
        }
    }
    #[test]
    fn invalid_bindings_cannot_capture_bare_typing() {
        for value in ["L", "Ctrl +", "Ctrl + A + B", "Ctrl + Unknown", ""] {
            assert!(parse_keys(value).is_err(), "{value}");
        }
    }
}
