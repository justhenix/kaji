use crate::Result;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, PhysicalPosition};

static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Placement {
    Left,
    Right,
    Aside,
    Fade,
    Restore,
}

pub fn restore(window: &tauri::WebviewWindow) -> Result<()> {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    restore_window(window)
}

fn restore_window(window: &tauri::WebviewWindow) -> Result<()> {
    window
        .set_ignore_cursor_events(false)
        .map_err(|e| e.to_string())?;
    window
        .eval("delete document.documentElement.dataset.obscured")
        .map_err(|e| e.to_string())
}

pub fn control(app: &AppHandle, placement: Placement, seconds: u64) -> Result<serde_json::Value> {
    if !(5..=600).contains(&seconds) {
        return Err("composer duration must be 5–600 seconds".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("composer window unavailable")?;
    if !window
        .url()
        .map_err(|e| e.to_string())?
        .path()
        .ends_with("composer.html")
    {
        return Err("the floating composer must be open before moving it".into());
    }
    let ticket = GENERATION.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    restore_window(&window)?;
    if matches!(placement, Placement::Fade) {
        window
            .eval("document.documentElement.dataset.obscured = 'true'")
            .map_err(|e| e.to_string())?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|e| e.to_string())?;
        let restore = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(seconds));
            let app = restore.app_handle().clone();
            let _ = app.run_on_main_thread(move || {
                if GENERATION.load(Ordering::SeqCst) == ticket {
                    let _ = restore_window(&restore);
                }
            });
        });
    } else if !matches!(placement, Placement::Restore) {
        let monitor = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("monitor unavailable")?;
        let work = monitor.work_area();
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let old = window.outer_position().map_err(|e| e.to_string())?;
        let margin = (8. * monitor.scale_factor()).round() as i32;
        let left = work.position.x;
        let top = work.position.y;
        let right = left + (work.size.width.saturating_sub(size.width)) as i32;
        let bottom = top + (work.size.height.saturating_sub(size.height)) as i32;
        let placement = if matches!(placement, Placement::Aside) {
            if old.x - left < right - old.x {
                Placement::Right
            } else {
                Placement::Left
            }
        } else {
            placement
        };
        let (x, y) = match placement {
            Placement::Left => (left + margin, old.y),
            Placement::Right => (right - margin, old.y),
            _ => unreachable!(),
        };
        window
            .set_position(PhysicalPosition::new(
                x.clamp(left, right),
                y.clamp(top, bottom),
            ))
            .map_err(|e| e.to_string())?;
    }
    let position = window.outer_position().map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({"verified":true,"placement":placement,"x":position.x,"y":position.y,"clickThrough":matches!(placement, Placement::Fade),"restoreAfterSeconds":if matches!(placement, Placement::Fade) { Some(seconds) } else { None }}),
    )
}
