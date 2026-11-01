use kaji_engine::{
    control::{Config, Frame},
    engine::{Engine, Session},
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
fn main() {
    if kaji_engine::helper_entry() {
        return;
    }
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--help") {
        println!(
            "kaji --camera --enable-input [--seconds 120] [--hwnd N] [--stdio]\nLocal webcam sensor; no product GUI. Escape stops input. Camera access is explicit and local."
        );
        return;
    }
    let camera = args.iter().any(|a| a == "--camera");
    if !camera {
        eprintln!(
            "Use --camera to opt into local webcam access, or kaji-diag for native inspection."
        );
        return;
    }
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
    if let Err(error) = engine.sensor_initializing() {
        eprintln!("{error}");
        std::process::exit(1);
    }
    let stdio = args.iter().any(|a| a == "--stdio");
    let runtime = tauri::Builder::default()
        .manage(SensorState {
            engine: engine.clone(),
            session: Mutex::new(SensorSession::default()),
            target,
        })
        .invoke_handler(tauri::generate_handler![
            sensor_ready,
            sensor_frame,
            sensor_fault
        ])
        .setup(move |app| {
            // Camera permission applies only to this bundled, navigation-locked sensor view.
            WebviewWindowBuilder::new(app, "sensor", WebviewUrl::App("index.html".into()))
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
                let started=Instant::now();
                loop {
                    std::thread::sleep(Duration::from_millis(50));
                    let status=timeout_engine.status();
                    let finished=status.as_ref().is_ok_and(|s|s.session>0 && s.phase=="stopped");
                    let startup_expired=started.elapsed()>Duration::from_secs(15) && status.as_ref().is_ok_and(|s|s.session==0);
                    if finished || status.is_err() || startup_expired || started.elapsed()>Duration::from_secs(seconds) {
                        if !finished { let _=timeout_engine.stop(if startup_expired {"camera initialization timed out"}else{"host session ended"}); }
                        if let Ok(status)=timeout_engine.status() { eprintln!("native-stop: {}",serde_json::to_string(&status).unwrap_or_default()); }
                        if let Some(sensor)=handle.get_webview_window("sensor") { let _=sensor.close(); }
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
                    if let Some(sensor)=handle.get_webview_window("sensor") { let _=sensor.close(); }
                    else { handle.exit(0); }
                });
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
