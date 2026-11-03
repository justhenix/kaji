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
use windows::Win32::{
    Foundation::HWND,
    Graphics::Gdi::{CombineRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_OR},
    UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER},
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
    use std::cell::RefCell;
    use windows::{
        core::w,
        Win32::{
            Foundation::{LPARAM, LRESULT, RECT, WPARAM},
            System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::*,
            Graphics::Gdi::{CreateRectRgn, GetWindowRgn, PtInRegion},
        },
    };

    thread_local! { static BOUNDS: RefCell<Vec<(i32, i32)>> = const { RefCell::new(Vec::new()) }; }

    unsafe extern "system" fn bounds_proc(hwnd: HWND, message: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
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
                hInstance: instance.into(), lpszClassName: w!("KajiComposerBoundsCheck"),
                lpfnWndProc: Some(bounds_proc), ..Default::default()
            };
            assert_ne!(RegisterClassW(&class), 0);
            let window = CreateWindowExW(WS_EX_NOACTIVATE, class.lpszClassName, w!(""), WS_POPUP,
                0, 0, 472, 92, None, None, Some(instance.into()), None).unwrap();
            for (width, height) in [(472, 92), (544, 302), (472, 92), (555, 308), (472, 92)] {
                BOUNDS.with(|frames| frames.borrow_mut().clear());
                set_composer_bounds(window, 1000 - width, 800 - height, width, height).unwrap();
                BOUNDS.with(|frames| assert_eq!(*frames.borrow(), [(1000, 800)], "Native bounds exposed a moving anchor"));
            }
            for unit in [0.75, 1.0, 1.02, 1.5] {
                let px = |value: f64| (value * unit).round() as i32;
                set_composer_bounds(window, 0, 0, px(544.0), px(500.0)).unwrap();
                for top in [false, true] {
                    for expanded in [false, true, false, true, false] {
                        set_composer_region(window, px(544.0), px(500.0), px(if expanded { 544.0 } else { 472.0 }), px(if expanded { 302.0 } else { 92.0 }), unit, top).unwrap();
                        let mut rect = RECT::default();
                        GetWindowRect(window, &mut rect).unwrap();
                        assert_eq!((rect.left, rect.top, rect.right, rect.bottom), (0, 0, px(544.0), px(500.0)), "Toggling the input resized the native viewport");
                        let region = CreateRectRgn(0, 0, 0, 0);
                        assert_ne!(GetWindowRgn(window, region).0, 0);
                        assert!(PtInRegion(region, px(300.0), px(if top { 46.0 } else { 454.0 })).as_bool(), "Pill disappeared from the visible region");
                        assert_eq!(PtInRegion(region, px(300.0), px(if top { 140.0 } else { 300.0 })).as_bool(), expanded, "Editor region did not follow its state");
                        assert!(!PtInRegion(region, px(20.0), px(if top { 46.0 } else { 454.0 })).as_bool(), "Invisible area intercepts the desktop");
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
fn gui_set_view(app: tauri::AppHandle, state: State<'_, Arc<GuiManager>>, view: String, width: Option<f64>, height: Option<f64>) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window not found")?;
    configure_gui_view(&window, &view, &state.get_settings()?, width, height)
}

fn set_composer_bounds(hwnd: HWND, x: i32, y: i32, width: i32, height: i32) -> windows::core::Result<()> {
    // Commit size and position together so the anchored pill has no intermediate frame.
    unsafe { SetWindowPos(hwnd, None, x, y, width, height, SWP_NOACTIVATE | SWP_NOZORDER) }
}

fn set_composer_region(hwnd: HWND, frame_width: i32, frame_height: i32, width: i32, height: i32, unit: f64, top: bool) -> Result<(), String> {
    let px = |value: f64| (value * unit).round() as i32;
    let right = frame_width - px(12.0);
    let pill_top = if top { px(12.0) } else { frame_height - px(80.0) };
    unsafe {
        let region = CreateRoundRectRgn((right - px(448.0)).max(px(12.0)), pill_top, right + 1, pill_top + px(68.0) + 1, px(68.0), px(68.0));
        if region.is_invalid() { return Err("couldn’t create composer region".into()); }
        if height > px(100.0) {
            let panel_height = (height - px(100.0)).min(frame_height - px(100.0)).max(0);
            let panel_top = if top { pill_top + px(76.0) } else { pill_top - px(8.0) - panel_height };
            let panel = CreateRoundRectRgn((frame_width - width + px(12.0)).max(px(12.0)), panel_top,
                right + 1, panel_top + panel_height + 1, px(36.0), px(36.0));
            if panel.is_invalid() { let _ = DeleteObject(region.into()); return Err("couldn’t create composer panel region".into()); }
            let combined = CombineRgn(Some(region), Some(region), Some(panel), RGN_OR);
            let _ = DeleteObject(panel.into());
            if combined.0 == 0 { let _ = DeleteObject(region.into()); return Err("couldn’t combine composer regions".into()); }
        }
        // Windows owns the successful region; everything outside it remains click-through.
        if SetWindowRgn(hwnd, Some(region), true) == 0 {
            let _ = DeleteObject(region.into());
            return Err("couldn’t apply composer region".into());
        }
    }
    Ok(())
}

fn configure_gui_view(window: &tauri::WebviewWindow, view: &str, settings: &AppSettings, width: Option<f64>, height: Option<f64>) -> Result<(), String> {
    let was_composer = !window.is_resizable().map_err(|e| e.to_string())?;
    if view == "composer" {
        let width = width.unwrap_or(472.0);
        let height = height.unwrap_or(92.0);
        if !width.is_finite() || !height.is_finite() || !(200.0..=900.0).contains(&width) || !(40.0..=900.0).contains(&height) {
            return Err("invalid composer dimensions".into());
        }
        let monitor = window.current_monitor().map_err(|e| e.to_string())?.ok_or("monitor not found")?;
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
        let old_size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
        let old_position = window.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
        let (x, y) = if was_composer {
            (old_position.x + old_size.width - width,
             if settings.composer_position == "top" { old_position.y } else { old_position.y + old_size.height - height })
        } else {
            let pill_width = (472.0 * composer_scale).min(work_width);
            let pill_height = (92.0 * composer_scale).min(work_height);
            (left + (work_width + pill_width) / 2.0 - width, match settings.composer_position.as_str() {
                "top" => top + 8.0,
                "taskbar" => top + work_height - height - 8.0,
                _ => top + (work_height - pill_height) * 0.68 + pill_height - height,
            })
        };
        if !was_composer {
            window.set_min_size(None::<tauri::LogicalSize<f64>>).map_err(|e| e.to_string())?;
            window.set_shadow(false).map_err(|e| e.to_string())?;
            window.set_always_on_top(true).map_err(|e| e.to_string())?;
            window.set_resizable(false).map_err(|e| e.to_string())?;
        }
        let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
        if !was_composer || (old_size.width - width).abs() > 0.5 || (old_size.height - height).abs() > 0.5 {
            set_composer_bounds(hwnd,
                (x.clamp(left, left + work_width - width) * scale).round() as i32,
                (y.clamp(top, top + work_height - height) * scale).round() as i32,
                (width * scale).round() as i32, (height * scale).round() as i32,
            ).map_err(|e| e.to_string())?;
        }
        set_composer_region(hwnd, (width * scale).round() as i32, (height * scale).round() as i32,
            (content_width * scale).ceil() as i32, (content_height * scale).ceil() as i32,
            composer_scale * scale, settings.composer_position == "top")?;
    } else {
        let (width, height, min_width, min_height) = match view {
            "main" => (980.0, 700.0, 880.0, 620.0),
            "settings" => (1100.0, 760.0, 920.0, 680.0),
            _ => return Err("view must be main, settings, or composer".into()),
        };
        if unsafe { SetWindowRgn(HWND(window.hwnd().map_err(|e| e.to_string())?.0), None, true) } == 0 {
            return Err("couldn’t restore main window region".into());
        }
        window.set_always_on_top(false).map_err(|e| e.to_string())?;
        window.set_shadow(true).map_err(|e| e.to_string())?;
        window.set_resizable(true).map_err(|e| e.to_string())?;
        window.set_min_size(Some(tauri::LogicalSize::new(min_width, min_height))).map_err(|e| e.to_string())?;
        window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
        if was_composer { window.center().map_err(|e| e.to_string())?; }
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
                let settings = gui_mgr.get_settings()?;
                let composer = settings.startup_open == "composer";
                let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(if composer { "composer.html" } else { "index.html" }.into()))
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
                    .build()?;
                if composer {
                    let scale = f64::from(settings.composer_size) / 100.0;
                    configure_gui_view(&window, "composer", &settings, Some(472.0 * scale), Some(92.0 * scale))?;
                }
                let close_window = window.clone();
                let close_gui = gui_mgr.clone();
                window.on_window_event(move |event| {
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
                                let url = window.url().map_err(|e| e.to_string())?.join("composer.html").map_err(|e| e.to_string())?;
                                configure_gui_view(&window, "composer", &settings, Some(472.0 * scale), Some(92.0 * scale))?;
                                window.navigate(url).map_err(|e| e.to_string())?;
                                window.unminimize().map_err(|e| e.to_string())?;
                                window.show().map_err(|e| e.to_string())
                            };
                            if let Err(error) = restore() { eprintln!("Couldn’t return to composer: {error}"); }
                        });
                    }
                });
                window.show()?;

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
