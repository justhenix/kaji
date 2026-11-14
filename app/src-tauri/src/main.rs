#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod shortcuts;

use kaji_engine::{
    control::Frame,
    engine::{Engine, Session},
    gui::{AppSettings, EngineGuiStatus, GuiManager},
    history::{ConversationRecord, ConversationSummary, HistoryStore, Retention},
    native::InputHost,
    runtime::{RuntimeAction, RuntimeManager, RuntimeSnapshot},
    sensor::SensorSession,
    uia::Inspector,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    Manager, State, WebviewUrl, WebviewWindowBuilder,
    webview::{PermissionKind, PermissionResponse},
};
use windows::Win32::{
    Foundation::HWND,
    Graphics::Gdi::{CombineRgn, CreateRoundRectRgn, DeleteObject, RGN_OR, SetWindowRgn},
    UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GWL_STYLE, GetWindowLongPtrW, SW_SHOWNOACTIVATE, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetWindowLongPtrW, SetWindowPos,
        ShowWindow, WS_CAPTION, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
        WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
    },
};

struct SensorState {
    engine: Arc<Engine>,
    session: Arc<Mutex<SensorSession>>,
    runtime: Arc<RuntimeManager>,
    target: Option<isize>,
}
const SHARED_BROWSER_ARGS: &str = "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";
static COMPOSER_POSITION: Mutex<Option<ComposerPosition>> = Mutex::new(None);

#[derive(Clone, Copy, PartialEq, Eq)]
enum ComposerPosition {
    Top,
    Floating,
    Taskbar,
}

impl From<&str> for ComposerPosition {
    fn from(value: &str) -> Self {
        match value {
            "top" => Self::Top,
            "taskbar" => Self::Taskbar,
            _ => Self::Floating,
        }
    }
}
#[tauri::command]
fn sensor_ready(state: State<'_, SensorState>, warmup_ms: f64) -> Result<Session, String> {
    if !warmup_ms.is_finite() || !(0. ..=15000.).contains(&warmup_ms) {
        return Err("invalid sensor warm-up duration".into());
    }
    let mut session = state
        .session
        .lock()
        .map_err(|_| "sensor session poisoned")?;
    let config = state.runtime.head_config()?;
    let result = session.start(|| state.engine.begin_sensor(config, state.target));
    if result.is_ok() {
        eprintln!(
            "sensor warm-up: first inference round-trip {warmup_ms:.3} ms; pre-session observation discarded"
        );
        if let Ok(session) = &result {
            state.runtime.sensor_started(session);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use windows::{
        Win32::{
            Foundation::{LPARAM, LRESULT, RECT, WPARAM},
            Graphics::Gdi::{CreateRectRgn, GetWindowRgn, PtInRegion},
            System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::*,
        },
        core::w,
    };

    thread_local! { static BOUNDS: RefCell<Vec<(i32, i32)>> = const { RefCell::new(Vec::new()) }; }

    unsafe extern "system" fn bounds_proc(
        hwnd: HWND,
        message: u32,
        wp: WPARAM,
        lp: LPARAM,
    ) -> LRESULT {
        unsafe {
            if message == WM_WINDOWPOSCHANGED {
                let mut rect = RECT::default();
                if GetWindowRect(hwnd, &mut rect).is_ok() {
                    BOUNDS.with(|frames| frames.borrow_mut().push((rect.right, rect.bottom)));
                }
            }
            DefWindowProcW(hwnd, message, wp, lp)
        }
    }

    #[test]
    fn composer_toggles_keep_viewport_and_pill_visible() {
        unsafe {
            let instance = GetModuleHandleW(None).unwrap();
            let class = WNDCLASSW {
                hInstance: instance.into(),
                lpszClassName: w!("KajiComposerBoundsCheck"),
                lpfnWndProc: Some(bounds_proc),
                ..Default::default()
            };
            assert_ne!(RegisterClassW(&class), 0);
            let window = CreateWindowExW(
                WS_EX_NOACTIVATE,
                class.lpszClassName,
                w!(""),
                WS_POPUP
                    | WS_CAPTION
                    | WS_THICKFRAME
                    | WS_MINIMIZEBOX
                    | WS_MAXIMIZEBOX
                    | WS_SYSMENU,
                0,
                0,
                472,
                92,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .unwrap();
            remove_composer_frame(window).unwrap();
            assert_eq!(
                GetWindowLongPtrW(window, GWL_STYLE) & WS_CAPTION.0 as isize,
                0
            );
            for (width, height) in [(472, 92), (544, 302), (472, 92), (555, 308), (472, 92)] {
                BOUNDS.with(|frames| frames.borrow_mut().clear());
                set_composer_bounds(window, 1000 - width, 800 - height, width, height).unwrap();
                BOUNDS.with(|frames| {
                    assert_eq!(
                        *frames.borrow(),
                        [(1000, 800)],
                        "Native bounds exposed a moving anchor"
                    )
                });
            }
            for unit in [0.75, 1.0, 1.02, 1.5] {
                let px = |value: f64| (value * unit).round() as i32;
                set_composer_bounds(window, 0, 0, px(544.0), px(500.0)).unwrap();
                for top in [false, true] {
                    for expanded in [false, true, false, true, false] {
                        set_composer_region(
                            window,
                            px(544.0),
                            px(500.0),
                            px(if expanded { 544.0 } else { 472.0 }),
                            px(if expanded { 302.0 } else { 92.0 }),
                            unit,
                            top,
                        )
                        .unwrap();
                        let mut rect = RECT::default();
                        GetWindowRect(window, &mut rect).unwrap();
                        assert_eq!(
                            (rect.left, rect.top, rect.right, rect.bottom),
                            (0, 0, px(544.0), px(500.0)),
                            "Toggling the input resized the native viewport"
                        );
                        let region = CreateRectRgn(0, 0, 0, 0);
                        assert_ne!(GetWindowRgn(window, region).0, 0);
                        assert!(
                            PtInRegion(region, px(300.0), px(if top { 46.0 } else { 454.0 }))
                                .as_bool(),
                            "Pill disappeared from the visible region"
                        );
                        assert_eq!(
                            PtInRegion(region, px(300.0), px(if top { 140.0 } else { 300.0 }))
                                .as_bool(),
                            expanded,
                            "Editor region did not follow its state"
                        );
                        assert!(
                            !PtInRegion(region, px(20.0), px(if top { 46.0 } else { 454.0 }))
                                .as_bool(),
                            "Invisible area intercepts the desktop"
                        );
                        let _ = DeleteObject(region.into());
                    }
                }
            }
            DestroyWindow(window).unwrap();
            UnregisterClassW(class.lpszClassName, Some(instance.into())).unwrap();
        }
    }
    #[test]
    fn cancelled_sensor_cannot_arm_after_late_warmup() {
        let mut gate = SensorSession::default();
        gate.authorize_reset();
        gate.cancel();
        assert!(
            gate.start(|| panic!("cancelled warm-up must never begin native input"))
                .is_err()
        );
    }
    #[test]
    fn sensor_can_only_initialize_once_and_after_success() {
        let mut gate = SensorSession::default();
        gate.authorize_reset();
        assert!(gate.start(|| Err("camera failed".into())).is_err());
        gate.authorize_reset();
        assert_eq!(
            gate.start(|| Ok(Session {
                id: 7,
                now_ms: 1200.
            }))
            .unwrap()
            .id,
            7
        );
        assert!(
            gate.start(|| panic!("duplicate initialization must not rearm input"))
                .is_err()
        );
    }

    #[test]
    fn sensor_start_requires_native_enable_authorization() {
        let mut gate = SensorSession::default();
        assert!(
            gate.start(|| panic!("an unrequested renderer must not begin capture"))
                .is_err()
        );
    }

    #[test]
    fn hidden_audio_host_cannot_dispatch_general_runtime_actions() {
        let request: RuntimeAction =
            serde_json::from_value(json!({ "type": "request", "text": "Find a file" })).unwrap();
        let transcribe: RuntimeAction = serde_json::from_value(json!({
            "type": "audio.transcribe",
            "utteranceId": "utterance-1",
            "wavBase64": "AQID",
            "voiceSessionId": 1
        }))
        .unwrap();
        let head: RuntimeAction =
            serde_json::from_value(json!({ "type": "head", "enabled": true })).unwrap();
        assert!(!runtime_action_allowed("audio", &request));
        assert!(runtime_action_allowed("audio", &transcribe));
        assert!(runtime_action_allowed("audio", &RuntimeAction::AudioReady));
        assert!(!runtime_action_allowed("audio", &head));
        assert!(!runtime_action_allowed("overlay", &transcribe));
        assert!(runtime_action_allowed("main", &request));
    }
}
#[tauri::command]
fn sensor_frame(state: State<'_, SensorState>, frame: Frame) -> Result<(), String> {
    if frame.candidates.is_none() {
        return Err("live sensor must provide operator observations".into());
    }
    state.engine.submit(frame)
}
#[tauri::command]
fn sensor_fault(state: State<'_, SensorState>, reason: String) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "sensor session poisoned")?;
    if !session.cancel() {
        return Ok(());
    }
    eprintln!(
        "sensor stopped: {}",
        reason.chars().take(512).collect::<String>()
    );
    let status = state.engine.stop_head(&format!(
        "sensor: {}",
        reason.chars().take(512).collect::<String>()
    ))?;
    state.runtime.sensor_stopped(&status.reason);
    Ok(())
}

#[tauri::command]
fn gui_get_settings(state: State<'_, Arc<GuiManager>>) -> Result<AppSettings, String> {
    state.get_settings()
}

#[tauri::command]
fn gui_save_settings(
    app: tauri::AppHandle,
    state: State<'_, Arc<GuiManager>>,
    runtime: State<'_, Arc<RuntimeManager>>,
    settings: AppSettings,
) -> Result<(), String> {
    use tauri::Emitter;
    let previous = state.get_settings()?;
    state.save_settings(settings.clone())?;
    runtime.update_history_settings(&settings)?;
    if let Some(shortcuts) = app.try_state::<shortcuts::Shortcuts>() {
        shortcuts.configure(settings.clone())?;
    }
    if previous.voice_activation != settings.voice_activation {
        runtime.dispatch(RuntimeAction::Listen {
            enabled: settings.voice_activation,
            immediate: false,
        })?;
    }
    let _ = app.emit("settings-updated", &settings);
    Ok(())
}

#[tauri::command]
fn gui_get_engine_status(state: State<'_, Arc<GuiManager>>) -> Result<EngineGuiStatus, String> {
    state.get_status()
}

#[tauri::command]
fn gui_shortcut_status(app: tauri::AppHandle) -> Result<Vec<shortcuts::ShortcutStatus>, String> {
    app.try_state::<shortcuts::Shortcuts>()
        .ok_or("Keyboard shortcuts are unavailable.")?
        .status()
}

#[tauri::command]
fn gui_set_mode(state: State<'_, Arc<GuiManager>>, mode: String) -> Result<(), String> {
    state.set_mode(&mode)
}

#[tauri::command]
fn gui_toggle_head_control(state: State<'_, Arc<GuiManager>>, enable: bool) -> Result<(), String> {
    state.toggle_head_control(enable)
}

#[tauri::command]
fn gui_toggle_voice(state: State<'_, Arc<GuiManager>>, enable: bool) -> Result<(), String> {
    state.toggle_voice(enable)
}

#[tauri::command]
fn gui_pause_all(state: State<'_, Arc<GuiManager>>) -> Result<(), String> {
    state.pause_all()
}

#[tauri::command]
fn gui_emergency_stop(runtime: State<'_, Arc<RuntimeManager>>) -> Result<(), String> {
    runtime.emergency_stop()
}

#[tauri::command]
fn gui_dispatch(
    webview: tauri::WebviewWindow,
    state: State<'_, Arc<RuntimeManager>>,
    action: RuntimeAction,
) -> Result<RuntimeSnapshot, String> {
    if !runtime_action_allowed(webview.label(), &action) {
        return Err("runtime action is unavailable to this window".into());
    }
    project_runtime_snapshot(webview.label(), state.dispatch(action)?)
}

#[tauri::command]
fn gui_get_runtime(
    webview: tauri::WebviewWindow,
    state: State<'_, Arc<RuntimeManager>>,
) -> Result<RuntimeSnapshot, String> {
    match webview.label() {
        "main" | "audio" | "overlay" => project_runtime_snapshot(webview.label(), state.snapshot()),
        _ => Err("runtime state is unavailable to this window".into()),
    }
}

#[tauri::command]
fn gui_history_list(
    state: State<'_, Arc<RuntimeManager>>,
    query: Option<String>,
) -> Result<Vec<ConversationSummary>, String> {
    state.history_list(query.as_deref())
}

#[tauri::command]
fn gui_history_get(
    state: State<'_, Arc<RuntimeManager>>,
    conversation_id: String,
) -> Result<Option<ConversationRecord>, String> {
    state.history_get(&conversation_id)
}

fn runtime_action_allowed(window_label: &str, action: &RuntimeAction) -> bool {
    match window_label {
        "main" => true,
        "audio" => matches!(
            action,
            RuntimeAction::AudioReady
                | RuntimeAction::AudioState { .. }
                | RuntimeAction::AudioTranscribe { .. }
        ),
        _ => false,
    }
}

fn project_runtime_snapshot(
    window_label: &str,
    mut snapshot: RuntimeSnapshot,
) -> Result<RuntimeSnapshot, String> {
    match window_label {
        "main" => Ok(snapshot),
        "audio" => Ok(kaji_engine::runtime::audio_snapshot(snapshot)),
        "overlay" => {
            snapshot.attachments.clear();
            snapshot.active_conversation_id = None;
            snapshot.task = None;
            snapshot.question = None;
            snapshot.message.clear();
            snapshot.head.cursor = None;
            snapshot.head.reason.clear();
            snapshot.voice.enabled = false;
            snapshot.voice.phase = kaji_engine::runtime::VoicePhase::Off;
            snapshot.voice.reason.clear();
            snapshot.voice.audio_level = 0.0;
            snapshot.voice.transcript.clear();
            snapshot.services = None;
            Ok(snapshot)
        }
        _ => Err("runtime state is unavailable to this window".into()),
    }
}

#[tauri::command]
fn gui_set_view(
    app: tauri::AppHandle,
    state: State<'_, Arc<GuiManager>>,
    view: String,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<WindowMetrics, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    configure_gui_view(&window, &view, &state.get_settings()?, width, height)?;
    let client = window.inner_size().map_err(|error| error.to_string())?;
    let outer = window.outer_size().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let hwnd = HWND(window.hwnd().map_err(|error| error.to_string())?.0);
    Ok(WindowMetrics {
        native_caption: unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } & WS_CAPTION.0 as isize != 0,
        client_width: client.width,
        client_height: client.height,
        outer_width: outer.width,
        outer_height: outer.height,
        outer_x: position.x,
        outer_y: position.y,
        ignores_cursor: unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) }
            & WS_EX_TRANSPARENT.0 as isize
            != 0,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowMetrics {
    native_caption: bool,
    client_width: u32,
    client_height: u32,
    outer_width: u32,
    outer_height: u32,
    outer_x: i32,
    outer_y: i32,
    ignores_cursor: bool,
}

fn remove_composer_frame(hwnd: HWND) -> Result<(), String> {
    let mask =
        (WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU).0 as isize;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        if style & mask != 0 {
            SetWindowLongPtrW(hwnd, GWL_STYLE, style & !mask);
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .map_err(|error| error.to_string())?;
        }
        if GetWindowLongPtrW(hwnd, GWL_STYLE) & mask != 0 {
            return Err("composer native frame could not be removed".into());
        }
    }
    Ok(())
}

fn set_composer_bounds(
    hwnd: HWND,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> windows::core::Result<()> {
    // Commit size and position together so the anchored pill has no intermediate frame.
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
    }
}

fn set_composer_region(
    hwnd: HWND,
    frame_width: i32,
    frame_height: i32,
    width: i32,
    height: i32,
    unit: f64,
    top: bool,
) -> Result<(), String> {
    let px = |value: f64| (value * unit).round() as i32;
    let right = frame_width - px(12.0);
    let pill_top = if top {
        px(12.0)
    } else {
        frame_height - px(80.0)
    };
    unsafe {
        let region = CreateRoundRectRgn(
            (right - px(448.0)).max(px(12.0)),
            pill_top,
            right + 1,
            pill_top + px(68.0) + 1,
            px(68.0),
            px(68.0),
        );
        if region.is_invalid() {
            return Err("couldn’t create composer region".into());
        }
        if height > px(100.0) {
            let panel_height = (height - px(100.0)).min(frame_height - px(100.0)).max(0);
            let panel_top = if top {
                pill_top + px(76.0)
            } else {
                pill_top - px(8.0) - panel_height
            };
            let panel = CreateRoundRectRgn(
                (frame_width - width + px(12.0)).max(px(12.0)),
                panel_top,
                right + 1,
                panel_top + panel_height + 1,
                px(36.0),
                px(36.0),
            );
            if panel.is_invalid() {
                let _ = DeleteObject(region.into());
                return Err("couldn’t create composer panel region".into());
            }
            let combined = CombineRgn(Some(region), Some(region), Some(panel), RGN_OR);
            let _ = DeleteObject(panel.into());
            if combined.0 == 0 {
                let _ = DeleteObject(region.into());
                return Err("couldn’t combine composer regions".into());
            }
        }
        // Windows owns the successful region; everything outside it remains click-through.
        if SetWindowRgn(hwnd, Some(region), true) == 0 {
            let _ = DeleteObject(region.into());
            return Err("couldn’t apply composer region".into());
        }
    }
    Ok(())
}

fn configure_gui_view(
    window: &tauri::WebviewWindow,
    view: &str,
    settings: &AppSettings,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let was_composer = !window.is_resizable().map_err(|e| e.to_string())?;
    if view != "composer" {
        kaji_engine::composer::restore(window)?;
    }
    if view == "composer" {
        let width = width.unwrap_or(472.0);
        let height = height.unwrap_or(92.0);
        if !width.is_finite()
            || !height.is_finite()
            || !(200.0..=900.0).contains(&width)
            || !(40.0..=900.0).contains(&height)
        {
            return Err("invalid composer dimensions".into());
        }
        let monitor = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("monitor not found")?;
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        let left = f64::from(work.position.x) / scale;
        let top = f64::from(work.position.y) / scale;
        let work_width = f64::from(work.size.width) / scale;
        let work_height = f64::from(work.size.height) / scale;
        let composer_scale = f64::from(settings.composer_size) / 100.0;
        let content_width = width;
        let content_height = height;
        // Keep WebView2's viewport fixed while opening/closing the input.
        let width = (544.0 * composer_scale).min(work_width);
        let height = (500.0 * composer_scale).min(work_height);
        let old_size = window
            .inner_size()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(scale);
        let old_position = window
            .outer_position()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(scale);
        let position = ComposerPosition::from(settings.composer_position.as_str());
        let mut applied_position = COMPOSER_POSITION
            .lock()
            .map_err(|_| "composer position lock poisoned")?;
        let place = !was_composer || *applied_position != Some(position);
        let (x, y) = if !place {
            (
                old_position.x + old_size.width - width,
                if position == ComposerPosition::Top {
                    old_position.y
                } else {
                    old_position.y + old_size.height - height
                },
            )
        } else {
            let pill_width = (472.0 * composer_scale).min(work_width);
            let pill_height = (92.0 * composer_scale).min(work_height);
            (
                left + (work_width + pill_width) / 2.0 - width,
                match position {
                    ComposerPosition::Top => top + 8.0,
                    ComposerPosition::Taskbar => top + work_height - height - 8.0,
                    ComposerPosition::Floating => {
                        top + (work_height - pill_height) * 0.68 + pill_height - height
                    }
                },
            )
        };
        if !was_composer {
            window
                .set_min_size(None::<tauri::LogicalSize<f64>>)
                .map_err(|e| e.to_string())?;
            window.set_shadow(false).map_err(|e| e.to_string())?;
            window.set_always_on_top(true).map_err(|e| e.to_string())?;
            window.set_resizable(false).map_err(|e| e.to_string())?;
        }
        let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
        remove_composer_frame(hwnd)?;
        if place || (old_size.width - width).abs() > 0.5 || (old_size.height - height).abs() > 0.5 {
            set_composer_bounds(
                hwnd,
                (x.clamp(left, left + work_width - width) * scale).round() as i32,
                (y.clamp(top, top + work_height - height) * scale).round() as i32,
                (width * scale).round() as i32,
                (height * scale).round() as i32,
            )
            .map_err(|e| e.to_string())?;
        }
        set_composer_region(
            hwnd,
            (width * scale).round() as i32,
            (height * scale).round() as i32,
            (content_width * scale).ceil() as i32,
            (content_height * scale).ceil() as i32,
            composer_scale * scale,
            position == ComposerPosition::Top,
        )?;
        *applied_position = Some(position);
    } else {
        let (width, height, min_width, min_height) = match view {
            "main" | "history" => (980.0, 700.0, 880.0, 620.0),
            "settings" => (1100.0, 760.0, 920.0, 680.0),
            _ => return Err("view must be main, history, settings, or composer".into()),
        };
        if unsafe {
            SetWindowRgn(
                HWND(window.hwnd().map_err(|e| e.to_string())?.0),
                None,
                true,
            )
        } == 0
        {
            return Err("couldn’t restore main window region".into());
        }
        window.set_always_on_top(false).map_err(|e| e.to_string())?;
        window.set_shadow(true).map_err(|e| e.to_string())?;
        window.set_resizable(true).map_err(|e| e.to_string())?;
        window
            .set_min_size(Some(tauri::LogicalSize::new(min_width, min_height)))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        if was_composer {
            window.center().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn is_local_app_url(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}

fn configure_overlay_host(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    let mask = (WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW).0 as isize;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | mask);
        if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & mask != mask {
            return Err("overlay window could not be made click-through and nonactivating".into());
        }
    }
    Ok(())
}

#[tauri::command]
fn gui_open_github() -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg("https://github.com/justhenix/kaji")
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn gui_calibrate(_state: State<'_, Arc<GuiManager>>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn gui_window_minimize(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.minimize().map_err(|e| e.to_string())
    } else {
        Err(format!("window {label} not found"))
    }
}

#[tauri::command]
fn gui_window_close(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())
    } else {
        Err(format!("window {label} not found"))
    }
}

fn create_runtime_manager(
    engine: Arc<Engine>,
    gui: Arc<GuiManager>,
    sensor_session: Arc<Mutex<SensorSession>>,
) -> Result<Arc<RuntimeManager>, String> {
    let data_dir = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or("LOCALAPPDATA is unavailable")?
        .join("Kaji");
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("Kaji data directory: {e}"))?;
    let settings = gui.get_settings()?;
    let retention = Retention::from_setting(&settings.retention)?;
    let history = Arc::new(HistoryStore::open(
        data_dir.join("history.sqlite3"),
        settings.save_history,
        retention,
    )?);
    RuntimeManager::new(
        engine,
        gui,
        history,
        data_dir.join("artifacts"),
        sensor_session,
    )
}

fn main() {
    if kaji_engine::helper_entry() {
        return;
    }
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--help") {
        println!(
            "kaji [--camera] [--enable-input] [--seconds 120] [--hwnd N] [--stdio]\nDesktop GUI application for Kaji. Use --camera to opt into standalone camera sensor harness."
        );
        return;
    }
    let camera = args.iter().any(|a| a == "--camera");
    let target = args
        .iter()
        .position(|a| a == "--hwnd")
        .and_then(|i| args.get(i + 1))
        .and_then(|a| a.parse().ok());
    let seconds = args
        .iter()
        .position(|a| a == "--seconds")
        .and_then(|i| args.get(i + 1))
        .and_then(|a| a.parse::<u64>().ok())
        .unwrap_or(120)
        .clamp(1, 3600);
    let startup_settings = (!camera).then(GuiManager::load_saved_settings);
    let input_permission = args.iter().any(|a| a == "--enable-input")
        || startup_settings
            .as_ref()
            .is_some_and(|settings| settings.permission_input);
    let engine = match InputHost::new(input_permission).and_then(Engine::with_input_host) {
        Ok(e) => Arc::new(e),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let sensor_session = Arc::new(Mutex::new(SensorSession::default()));
    let native = engine.clone();
    if camera {
        if let Err(error) = engine.sensor_initializing() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        sensor_session
            .lock()
            .expect("new sensor session mutex poisoned")
            .authorize_reset();
    }
    let stdio = args.iter().any(|a| a == "--stdio");
    let gui_mgr = Arc::new(match startup_settings {
        Some(settings) => GuiManager::new_with_settings(engine.clone(), settings),
        None => GuiManager::new(engine.clone()),
    });
    let runtime_mgr =
        match create_runtime_manager(engine.clone(), gui_mgr.clone(), sensor_session.clone()) {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("Could not initialize Kaji runtime: {error}");
                std::process::exit(1);
            }
        };
    let shutdown_runtime = runtime_mgr.clone();
    let runtime = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::new(kaji_engine::updates::UpdateManager::default()))
        .manage(SensorState {
            engine: engine.clone(),
            session: sensor_session.clone(),
            runtime: runtime_mgr.clone(),
            target,
        })
        .manage(gui_mgr.clone())
        .manage(runtime_mgr.clone())
        .invoke_handler(tauri::generate_handler![
            kaji_engine::updates::gui_update_status,
            kaji_engine::updates::gui_update_check,
            kaji_engine::updates::gui_update_install,
            sensor_ready,
            sensor_frame,
            sensor_fault,
            gui_get_settings,
            gui_save_settings,
            gui_get_engine_status,
            gui_shortcut_status,
            gui_set_mode,
            gui_toggle_head_control,
            gui_toggle_voice,
            gui_pause_all,
            gui_emergency_stop,
            gui_dispatch,
            gui_get_runtime,
            gui_history_list,
            gui_history_get,
            gui_set_view,
            gui_open_github,
            gui_calibrate,
            gui_window_minimize,
            gui_window_close
        ])
        .setup(move |app| {
            runtime_mgr.attach_app(app.handle().clone());
            if !camera {
                let _ = runtime_mgr.dispatch(RuntimeAction::ServicesRefresh);
            }
            if !camera && gui_mgr.get_settings()?.check_updates {
                kaji_engine::updates::start(app.handle().clone());
            }
            if camera {
                // Standalone sensor view for camera harness / diagnostic testing
                WebviewWindowBuilder::new(
                    app,
                    "sensor",
                    WebviewUrl::App("sensor.html?standalone=1".into()),
                )
                .visible(false)
                .focused(false)
                .skip_taskbar(true)
                .additional_browser_args(SHARED_BROWSER_ARGS)
                .on_navigation(|url| {
                    url.scheme() == "tauri"
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                })
                .on_permission_request(|_, kind| {
                    if matches!(kind, PermissionKind::Camera) {
                        PermissionResponse::Allow
                    } else {
                        PermissionResponse::Deny
                    }
                })
                .build()?;
                let handle = app.handle().clone();
                let timeout_engine = native.clone();
                std::thread::spawn(move || {
                    let started = Instant::now();
                    loop {
                        std::thread::sleep(Duration::from_millis(50));
                        let status = timeout_engine.status();
                        let finished = status
                            .as_ref()
                            .is_ok_and(|s| s.session > 0 && s.phase == "stopped");
                        let startup_expired = started.elapsed() > Duration::from_secs(15)
                            && status.as_ref().is_ok_and(|s| s.session == 0);
                        if finished
                            || status.is_err()
                            || startup_expired
                            || started.elapsed() > Duration::from_secs(seconds)
                        {
                            if !finished {
                                let _ = timeout_engine.stop(if startup_expired {
                                    "camera initialization timed out"
                                } else {
                                    "host session ended"
                                });
                            }
                            if let Ok(status) = timeout_engine.status() {
                                eprintln!(
                                    "native-stop: {}",
                                    serde_json::to_string(&status).unwrap_or_default()
                                );
                            }
                            if let Some(sensor) = handle.get_webview_window("sensor") {
                                let _ = sensor.close();
                            } else {
                                handle.exit(0);
                            }
                            break;
                        }
                    }
                });
                if stdio {
                    let handle = app.handle().clone();
                    let diagnostics_engine = native.clone();
                    std::thread::spawn(move || {
                        kaji_engine::diagnostics::serve(
                            diagnostics_engine,
                            Arc::new(Inspector::default()),
                            false,
                        );
                        if let Some(sensor) = handle.get_webview_window("sensor") {
                            let _ = sensor.close();
                        } else {
                            handle.exit(0);
                        }
                    });
                }
            } else {
                // Desktop GUI and background sensor
                let settings = gui_mgr.get_settings()?;
                let composer = settings.startup_open == "composer";
                let window = WebviewWindowBuilder::new(
                    app,
                    "main",
                    WebviewUrl::App(
                        if composer {
                            "composer.html"
                        } else {
                            "index.html"
                        }
                        .into(),
                    ),
                )
                .additional_browser_args(SHARED_BROWSER_ARGS)
                .title("Kaji")
                .inner_size(980.0, 700.0)
                .min_inner_size(880.0, 620.0)
                .resizable(true)
                .maximizable(false)
                .decorations(false)
                .transparent(true)
                .visible(false)
                .focused(!composer)
                .center()
                .on_navigation(is_local_app_url)
                .build()?;
                if composer {
                    let scale = f64::from(settings.composer_size) / 100.0;
                    configure_gui_view(
                        &window,
                        "composer",
                        &settings,
                        Some(472.0 * scale),
                        Some(92.0 * scale),
                    )?;
                }
                let close_window = window.clone();
                let close_gui = gui_mgr.clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Focused(true)) {
                        let _ = kaji_engine::composer::restore(&close_window);
                    }
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if !close_window.is_resizable().unwrap_or(false) {
                            close_window.app_handle().exit(0);
                            return;
                        }
                        let window = close_window.clone();
                        let gui = close_gui.clone();
                        tauri::async_runtime::spawn(async move {
                            let restore = || -> Result<(), String> {
                                let settings = gui.get_settings()?;
                                let scale = f64::from(settings.composer_size) / 100.0;
                                let url = window
                                    .url()
                                    .map_err(|e| e.to_string())?
                                    .join("composer.html")
                                    .map_err(|e| e.to_string())?;
                                configure_gui_view(
                                    &window,
                                    "composer",
                                    &settings,
                                    Some(472.0 * scale),
                                    Some(92.0 * scale),
                                )?;
                                window.navigate(url).map_err(|e| e.to_string())?;
                                window.unminimize().map_err(|e| e.to_string())?;
                                window.show().map_err(|e| e.to_string())
                            };
                            if let Err(error) = restore() {
                                eprintln!("Couldn’t return to composer: {error}");
                            }
                        });
                    }
                });
                if composer {
                    // Showing an idle composer must preserve the user's active application.
                    unsafe {
                        let _ = ShowWindow(HWND(window.hwnd()?.0), SW_SHOWNOACTIVATE);
                    }
                } else {
                    window.show()?;
                }

                // Background sensor window for head-control capability
                let _ =
                    WebviewWindowBuilder::new(app, "sensor", WebviewUrl::App("sensor.html".into()))
                        .visible(false)
                        .focused(false)
                        .skip_taskbar(true)
                        .additional_browser_args(SHARED_BROWSER_ARGS)
                        .on_navigation(is_local_app_url)
                        .on_permission_request(|_, kind| {
                            if matches!(kind, PermissionKind::Camera) {
                                PermissionResponse::Allow
                            } else {
                                PermissionResponse::Deny
                            }
                        })
                        .build()?;

                WebviewWindowBuilder::new(app, "audio", WebviewUrl::App("audio.html".into()))
                    .additional_browser_args(SHARED_BROWSER_ARGS)
                    .title("Kaji audio")
                    .visible(false)
                    .focused(false)
                    .skip_taskbar(true)
                    .resizable(false)
                    .decorations(false)
                    .on_navigation(is_local_app_url)
                    .on_permission_request(|_, kind| {
                        if matches!(kind, PermissionKind::Microphone) {
                            PermissionResponse::Allow
                        } else {
                            PermissionResponse::Deny
                        }
                    })
                    .build()?;

                let overlay = WebviewWindowBuilder::new(
                    app,
                    "overlay",
                    WebviewUrl::App("overlay.html".into()),
                )
                .additional_browser_args(SHARED_BROWSER_ARGS)
                .title("Kaji overlay")
                .inner_size(1.0, 1.0)
                .visible(false)
                .focused(false)
                .skip_taskbar(true)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .on_navigation(is_local_app_url)
                .build()?;
                configure_overlay_host(&overlay)?;
                app.manage(shortcuts::Shortcuts::start(
                    app.handle().clone(),
                    gui_mgr.clone(),
                    runtime_mgr.clone(),
                )?);
                runtime_mgr.start_overlay_follow();
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    match runtime {
        Ok(app) => app.run(move |app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                shutdown_runtime.shutdown();
                if let Some(shortcuts) = app.try_state::<shortcuts::Shortcuts>() {
                    shortcuts.shutdown();
                }
                let _ = engine.stop("Tauri host exit");
            }
        }),
        Err(e) => {
            let _ = engine.stop("Tauri startup failed");
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
