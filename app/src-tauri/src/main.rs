use kaji_engine::{
    control::{Config, Frame},
    engine::{Engine, Session},
    gui::{AppSettings, EngineGuiStatus, GuiManager},
    uia::Inspector,
};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    Manager, State, WebviewUrl, WebviewWindowBuilder,
    webview::{PermissionKind, PermissionResponse},
};

struct SensorState {
    engine: Arc<Engine>,
    session: Mutex<SensorSession>,
    target: Option<isize>,
}
#[derive(Default)]
struct SensorSession {
    started: Option<Session>,
    cancelled: bool,
}
impl SensorSession {
    fn start(
        &mut self,
        begin: impl FnOnce() -> Result<Session, String>,
    ) -> Result<Session, String> {
        if self.cancelled {
            return Err("sensor session cancelled".into());
        }
        if self.started.is_some() {
            return Err("sensor session is already initialized".into());
        }
        let session = begin()?;
        self.started = Some(session.clone());
        Ok(session)
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
    let result = session.start(|| state.engine.begin_sensor(Config::default(), state.target));
    if result.is_ok() {
        eprintln!(
            "sensor warm-up: first inference round-trip {warmup_ms:.3} ms; pre-session observation discarded"
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_sensor_cannot_arm_after_late_warmup() {
        let mut gate = SensorSession {
            cancelled: true,
            ..Default::default()
        };
        assert!(
            gate.start(|| panic!("cancelled warm-up must never begin native input"))
                .is_err()
        );
    }
    #[test]
    fn sensor_can_only_initialize_once_and_after_success() {
        let mut gate = SensorSession::default();
        assert!(gate.start(|| Err("camera failed".into())).is_err());
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
    session.cancelled = true;
    eprintln!(
        "sensor stopped: {}",
        reason.chars().take(512).collect::<String>()
    );
    state.engine.stop(&format!(
        "sensor: {}",
        reason.chars().take(512).collect::<String>()
    ))?;
    Ok(())
}

#[tauri::command]
fn gui_get_settings(state: State<'_, Arc<GuiManager>>) -> Result<AppSettings, String> {
    state.get_settings()
}

#[tauri::command]
fn gui_save_settings(app: tauri::AppHandle, state: State<'_, Arc<GuiManager>>, settings: AppSettings) -> Result<(), String> {
    use tauri::Emitter;
    state.save_settings(settings.clone())?;
    let _ = app.emit("settings-updated", &settings);
    Ok(())
}

#[tauri::command]
fn gui_get_engine_status(state: State<'_, Arc<GuiManager>>) -> Result<EngineGuiStatus, String> {
    state.get_status()
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
fn gui_emergency_stop(state: State<'_, Arc<GuiManager>>) -> Result<(), String> {
    state.emergency_stop()
}

#[tauri::command]
fn gui_set_view(app: tauri::AppHandle, view: String) -> Result<(), String> {
    let (width, height, min_width, min_height) = match view.as_str() {
        "main" => (980.0, 700.0, 880.0, 620.0),
        "settings" => (1100.0, 760.0, 920.0, 680.0),
        _ => return Err("view must be main or settings".into()),
    };
    let window = app.get_webview_window("main").ok_or("main window not found")?;
    window.set_min_size(Some(tauri::LogicalSize::new(min_width, min_height))).map_err(|e| e.to_string())?;
    window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
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
    if label == "settings" {
        if let Some(win) = app.get_webview_window("settings") {
            win.hide().map_err(|e| e.to_string())
        } else {
            Err("settings window not found".into())
        }
    } else if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())
    } else {
        Err(format!("window {label} not found"))
    }
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
    let engine = match Engine::new(args.iter().any(|a| a == "--enable-input")) {
        Ok(e) => Arc::new(e),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let native = engine.clone();
    if camera {
        if let Err(error) = engine.sensor_initializing() {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
    let stdio = args.iter().any(|a| a == "--stdio");
    let gui_mgr = Arc::new(GuiManager::new(engine.clone()));
    let runtime = tauri::Builder::default()
        .manage(SensorState {
            engine: engine.clone(),
            session: Mutex::new(SensorSession::default()),
            target,
        })
        .manage(gui_mgr.clone())
        .invoke_handler(tauri::generate_handler![
            sensor_ready,
            sensor_frame,
            sensor_fault,
            gui_get_settings,
            gui_save_settings,
            gui_get_engine_status,
            gui_set_mode,
            gui_toggle_head_control,
            gui_toggle_voice,
            gui_pause_all,
            gui_emergency_stop,
            gui_set_view,
            gui_open_github,
            gui_calibrate,
            gui_window_minimize,
            gui_window_close
        ])
        .setup(move |app| {
            if camera {
                // Standalone sensor view for camera harness / diagnostic testing
                WebviewWindowBuilder::new(app, "sensor", WebviewUrl::App("sensor.html".into()))
                    .visible(false)
                    .focused(false)
                    .skip_taskbar(true)
                    .additional_browser_args("--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows")
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
                        let finished = status.as_ref().is_ok_and(|s| s.session > 0 && s.phase == "stopped");
                        let startup_expired = started.elapsed() > Duration::from_secs(15) && status.as_ref().is_ok_and(|s| s.session == 0);
                        if finished || status.is_err() || startup_expired || started.elapsed() > Duration::from_secs(seconds) {
                            if !finished { let _ = timeout_engine.stop(if startup_expired { "camera initialization timed out" } else { "host session ended" }); }
                            if let Ok(status) = timeout_engine.status() { eprintln!("native-stop: {}", serde_json::to_string(&status).unwrap_or_default()); }
                            if let Some(sensor) = handle.get_webview_window("sensor") { let _ = sensor.close(); }
                            else { handle.exit(0); }
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
                        if let Some(sensor) = handle.get_webview_window("sensor") { let _ = sensor.close(); }
                        else { handle.exit(0); }
                    });
                }
            } else {
                // Desktop GUI and background sensor
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Kaji")
                    .inner_size(980.0, 700.0)
                    .min_inner_size(880.0, 620.0)
                    .resizable(true)
                    .maximizable(false)
                    .decorations(false)
                    .center()
                    .build()?;

                // Background sensor window for head-control capability
                let _ = WebviewWindowBuilder::new(app, "sensor", WebviewUrl::App("sensor.html".into()))
                    .visible(false)
                    .focused(false)
                    .skip_taskbar(true)
                    .additional_browser_args("--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows")
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
                    .build();
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    match runtime {
        Ok(app) => app.run(move |_app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
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
