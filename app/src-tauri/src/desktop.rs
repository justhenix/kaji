use crate::{
    Result,
    native::{self, Rect},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::{HWND, LPARAM, RECT},
    Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
        DeleteDC, DeleteObject, HBITMAP, HGDIOBJ, SelectObject,
    },
    Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow},
    UI::WindowsAndMessaging::{
        EnumWindows, GWL_EXSTYLE, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW,
        GetWindowPlacement, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsIconic,
        IsWindow, IsWindowVisible, SW_RESTORE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOZORDER,
        SetForegroundWindow, SetWindowPlacement, SetWindowPos, ShowWindowAsync, WINDOWPLACEMENT,
        WS_EX_TOOLWINDOW,
    },
};

static NEXT_WINDOW_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowEntry {
    pub id: String,
    pub title: String,
    pub application: String,
    pub bounds: Rect,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationEntry {
    pub id: String,
    pub name: String,
    pub windows: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct WindowIdentity {
    hwnd: isize,
    pid: u32,
    process_started: u64,
}

#[derive(Clone)]
struct RegisteredWindow {
    identity: WindowIdentity,
    entry: WindowEntry,
}

struct FoundWindow {
    identity: WindowIdentity,
    title: String,
    application: String,
    bounds: Rect,
}

#[derive(Clone)]
struct SavedWindow {
    identity: WindowIdentity,
    placement: WINDOWPLACEMENT,
}

#[derive(Clone)]
struct SavedLayout {
    left: SavedWindow,
    right: SavedWindow,
}

pub struct DesktopManager {
    windows: Mutex<HashMap<String, RegisteredWindow>>,
    layout: Mutex<Option<SavedLayout>>,
}

impl Default for DesktopManager {
    fn default() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
            layout: Mutex::new(None),
        }
    }
}

impl DesktopManager {
    pub fn layout_active(&self) -> bool {
        self.layout
            .lock()
            .map(|layout| layout.is_some())
            .unwrap_or(false)
    }

    pub fn list_windows(&self) -> Result<Vec<WindowEntry>> {
        native::dpi_aware();
        unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> windows::core::BOOL {
            let windows = unsafe { &mut *(data.0 as *mut Vec<FoundWindow>) };
            let taskbar = is_shell_taskbar(hwnd);
            if !unsafe { IsWindowVisible(hwnd) }.as_bool()
                || hwnd.0 as isize == 0
                || (!taskbar
                    && unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) }
                        & WS_EX_TOOLWINDOW.0 as isize
                        != 0)
            {
                return true.into();
            }
            let length = unsafe { GetWindowTextLengthW(hwnd) }.clamp(0, 4096) as usize;
            if length == 0 && !taskbar {
                return true.into();
            }
            let mut title = vec![0u16; length + 1];
            let read = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;
            if read == 0 && !taskbar {
                return true.into();
            }
            title.truncate(read);
            let title = if taskbar {
                "Windows taskbar".to_owned()
            } else {
                String::from_utf16_lossy(&title).trim().to_owned()
            };
            let pid = native::window_pid(hwnd.0 as isize);
            if pid == 0 || pid == native::current_process_id() {
                return true.into();
            }
            let Ok(process_started) = native::process_started(pid) else {
                return true.into();
            };
            let Ok(path) = native::process_path(pid) else {
                return true.into();
            };
            let application = Path::new(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Application")
                .to_owned();
            let mut bounds = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut bounds) }.is_err() {
                return true.into();
            }
            let bounds = Rect {
                left: bounds.left,
                top: bounds.top,
                right: bounds.right,
                bottom: bounds.bottom,
            };
            if !bounds.valid() || title.chars().count() > 4096 {
                return true.into();
            }
            windows.push(FoundWindow {
                identity: WindowIdentity {
                    hwnd: hwnd.0 as isize,
                    pid,
                    process_started,
                },
                title,
                application,
                bounds,
            });
            true.into()
        }

        let mut found: Vec<FoundWindow> = Vec::new();
        if unsafe { EnumWindows(Some(collect), LPARAM(&mut found as *mut _ as isize)) }.is_err() {
            return Err("Windows window enumeration failed".into());
        }
        let mut registry = self
            .windows
            .lock()
            .map_err(|_| "window catalog lock poisoned")?;
        let previous: HashMap<WindowIdentity, String> = registry
            .iter()
            .map(|(id, window)| (window.identity.clone(), id.clone()))
            .collect();
        let mut current = HashMap::with_capacity(found.len());
        let mut entries = Vec::with_capacity(found.len());
        for window in found {
            let id = previous.get(&window.identity).cloned().unwrap_or_else(|| {
                format!("w-{:016x}", NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed))
            });
            let entry = WindowEntry {
                id: id.clone(),
                title: window.title,
                application: window.application,
                bounds: window.bounds,
            };
            entries.push(entry.clone());
            current.insert(
                id,
                RegisteredWindow {
                    identity: window.identity,
                    entry,
                },
            );
        }
        *registry = current;
        entries.sort_by_key(|entry| entry.title.to_lowercase());
        Ok(entries)
    }

    pub fn list_applications(&self) -> Result<Vec<ApplicationEntry>> {
        let windows = self.list_windows()?;
        let mut grouped = std::collections::BTreeMap::<String, Vec<String>>::new();
        for window in windows {
            grouped
                .entry(window.application)
                .or_default()
                .push(window.id);
        }
        Ok(grouped
            .into_iter()
            .map(|(name, windows)| ApplicationEntry {
                id: format!("a-{:016x}", NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed)),
                name,
                windows,
            })
            .collect())
    }

    pub fn foreground_window(&self) -> Result<WindowEntry> {
        let hwnd = unsafe { GetForegroundWindow() }.0 as isize;
        self.list_windows()?
            .into_iter()
            .find(|entry| {
                self.windows
                    .lock()
                    .ok()
                    .and_then(|registry| registry.get(&entry.id).cloned())
                    .is_some_and(|window| window.identity.hwnd == hwnd)
            })
            .ok_or_else(|| "foreground window is unavailable".into())
    }

    pub fn window_by_handle(&self, hwnd: isize) -> Result<WindowEntry> {
        let entries = self.list_windows()?;
        entries
            .into_iter()
            .find(|entry| {
                self.windows
                    .lock()
                    .ok()
                    .and_then(|registry| registry.get(&entry.id).cloned())
                    .is_some_and(|window| window.identity.hwnd == hwnd)
            })
            .ok_or_else(|| "window is no longer in the native catalog".into())
    }

    pub fn switch_window(&self, id: &str) -> Result<WindowEntry> {
        let window = self.resolve(id)?;
        let hwnd = HWND(window.identity.hwnd as _);
        native::interactive_desktop()?;
        if unsafe { IsIconic(hwnd) }.as_bool() {
            unsafe {
                let _ = ShowWindowAsync(hwnd, SW_RESTORE);
            }
        }
        if !unsafe { SetForegroundWindow(hwnd) }.as_bool() {
            return Err("Windows declined the requested application switch".into());
        }
        let deadline = Instant::now() + Duration::from_millis(750);
        while Instant::now() < deadline {
            if unsafe { GetForegroundWindow() }.0 as isize == window.identity.hwnd {
                if !self.identity_is_current(&window.identity) {
                    return Err("target window changed during application switch".into());
                }
                return Ok(window.entry);
            }
            thread::sleep(Duration::from_millis(10));
        }
        Err("requested application did not become foreground".into())
    }

    pub fn bind_window(&self, id: &str) -> Result<WindowEntry> {
        let window = self.resolve(id)?;
        if self.identity_is_current(&window.identity) {
            Ok(window.entry)
        } else {
            Err("window identity expired; refresh the application catalog".into())
        }
    }

    pub fn is_taskbar(&self, id: &str) -> Result<bool> {
        let window = self.resolve(id)?;
        Ok(is_shell_taskbar(HWND(window.identity.hwnd as _)))
    }

    pub(crate) fn native_handle(&self, id: &str) -> Result<isize> {
        Ok(self.resolve(id)?.identity.hwnd)
    }

    pub fn apply_split(&self, user_window: &str, task_window: &str) -> Result<()> {
        if user_window == task_window {
            return Err("split screen requires two different windows".into());
        }
        let mut active_layout = self
            .layout
            .lock()
            .map_err(|_| "window layout lock poisoned")?;
        if active_layout.is_some() {
            return Err("a split layout is already active".into());
        }
        let left = self.resolve(user_window)?;
        let right = self.resolve(task_window)?;
        let left_hwnd = HWND(left.identity.hwnd as _);
        let right_hwnd = HWND(right.identity.hwnd as _);
        let mut left_placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        let mut right_placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        unsafe {
            GetWindowPlacement(left_hwnd, &mut left_placement).map_err(|e| e.to_string())?;
            GetWindowPlacement(right_hwnd, &mut right_placement).map_err(|e| e.to_string())?;
        }
        let saved = SavedLayout {
            left: SavedWindow {
                identity: left.identity.clone(),
                placement: left_placement,
            },
            right: SavedWindow {
                identity: right.identity.clone(),
                placement: right_placement,
            },
        };
        let work_area = native::displays()?
            .into_iter()
            .find(|display| display.bounds.contains(left.entry.bounds.center()))
            .map(|display| display.work_area)
            .ok_or("user window is not on an available monitor")?;
        let (left_bounds, right_bounds) = split_bounds(work_area)?;
        let result = (|| {
            native::interactive_desktop()?;
            for (hwnd, bounds, identity) in [
                (left_hwnd, left_bounds, &left.identity),
                (right_hwnd, right_bounds, &right.identity),
            ] {
                if !self.identity_is_current(identity) {
                    return Err("window identity changed before split placement".into());
                }
                if unsafe { IsIconic(hwnd) }.as_bool() {
                    unsafe {
                        let _ = ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE);
                    }
                }
                unsafe {
                    SetWindowPos(
                        hwnd,
                        None,
                        bounds.left,
                        bounds.top,
                        bounds.right - bounds.left,
                        bounds.bottom - bounds.top,
                        SWP_NOACTIVATE | SWP_NOZORDER,
                    )
                    .map_err(|e| format!("split placement failed: {e}"))?;
                }
            }
            if !matches_bounds(left_hwnd, left_bounds)?
                || !matches_bounds(right_hwnd, right_bounds)?
            {
                return Err("Windows did not apply the approved split layout".into());
            }
            if !self.identity_is_current(&left.identity)
                || !self.identity_is_current(&right.identity)
            {
                return Err("window identity changed during split placement".into());
            }
            Ok(())
        })();
        if let Err(error) = result {
            if self.identity_is_current(&saved.left.identity) {
                let _ = restore_window(&saved.left);
            }
            if self.identity_is_current(&saved.right.identity) {
                let _ = restore_window(&saved.right);
            }
            return Err(error);
        }
        *active_layout = Some(saved);
        Ok(())
    }

    pub fn restore_layout(&self) -> Result<bool> {
        let mut active_layout = self
            .layout
            .lock()
            .map_err(|_| "window layout lock poisoned")?;
        let Some(saved) = active_layout.as_ref().cloned() else {
            return Ok(false);
        };
        let mut errors = Vec::new();
        for window in [&saved.left, &saved.right] {
            if self.identity_is_current(&window.identity)
                && let Err(error) = restore_window(window)
            {
                errors.push(error);
            }
        }
        *active_layout = None;
        if let Some(error) = errors.into_iter().next() {
            return Err(error);
        }
        Ok(true)
    }

    pub fn capture_target(&self, id: &str) -> Result<Vec<u8>> {
        let window = self.resolve(id)?;
        let hwnd = HWND(window.identity.hwnd as _);
        native::interactive_desktop()?;
        if unsafe { IsIconic(hwnd) }.as_bool() {
            return Err("target window is minimized".into());
        }
        let mut bounds = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut bounds) }.map_err(|e| e.to_string())?;
        let width = bounds.right - bounds.left;
        let height = bounds.bottom - bounds.top;
        let pixels = i64::from(width) * i64::from(height);
        if width <= 0 || height <= 0 || width > 8192 || height > 8192 || pixels > 16_777_216 {
            return Err("target window capture dimensions are outside the supported range".into());
        }
        let image = capture_png(hwnd, width, height)?;
        if !self.identity_is_current(&window.identity) {
            return Err("target window changed during capture".into());
        }
        Ok(image)
    }

    fn resolve(&self, id: &str) -> Result<RegisteredWindow> {
        let window = self
            .windows
            .lock()
            .map_err(|_| "window catalog lock poisoned")?
            .get(id)
            .cloned()
            .ok_or("unknown or expired window catalog entry")?;
        if !self.identity_is_current(&window.identity) {
            return Err("window identity expired; refresh the application catalog".into());
        }
        Ok(window)
    }

    fn identity_is_current(&self, identity: &WindowIdentity) -> bool {
        let hwnd = HWND(identity.hwnd as _);
        unsafe { IsWindow(Some(hwnd)) }.as_bool()
            && native::window_pid(identity.hwnd) == identity.pid
            && native::process_started(identity.pid)
                .is_ok_and(|started| started == identity.process_started)
    }
}

pub(crate) fn is_shell_taskbar(hwnd: HWND) -> bool {
    let mut class = [0u16; 64];
    let length = unsafe { GetClassNameW(hwnd, &mut class) }.max(0) as usize;
    if !matches!(
        String::from_utf16_lossy(&class[..length]).as_str(),
        "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    ) {
        return false;
    }
    native::process_path(native::window_pid(hwnd.0 as isize)).is_ok_and(|path| {
        Path::new(&path)
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("explorer.exe"))
    })
}

pub fn split_bounds(work_area: Rect) -> Result<(Rect, Rect)> {
    let width = work_area.right - work_area.left;
    let height = work_area.bottom - work_area.top;
    if width < 640 || height < 400 {
        return Err("monitor work area is too small for two application windows".into());
    }
    let left_width = width / 2;
    let midpoint = work_area.left + left_width;
    Ok((
        Rect {
            left: work_area.left,
            top: work_area.top,
            right: midpoint,
            bottom: work_area.bottom,
        },
        Rect {
            left: midpoint,
            top: work_area.top,
            right: work_area.right,
            bottom: work_area.bottom,
        },
    ))
}

fn matches_bounds(hwnd: HWND, expected: Rect) -> Result<bool> {
    let mut actual = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut actual) }.map_err(|e| e.to_string())?;
    Ok((actual.left - expected.left).abs() <= 2
        && (actual.top - expected.top).abs() <= 2
        && (actual.right - expected.right).abs() <= 2
        && (actual.bottom - expected.bottom).abs() <= 2)
}

fn restore_window(saved: &SavedWindow) -> Result<()> {
    let hwnd = HWND(saved.identity.hwnd as _);
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool()
        || native::window_pid(saved.identity.hwnd) != saved.identity.pid
        || native::process_started(saved.identity.pid).ok() != Some(saved.identity.process_started)
    {
        return Err("window identity changed; saved placement was not applied".into());
    }
    unsafe {
        SetWindowPlacement(hwnd, &saved.placement)
            .map_err(|e| format!("restore window placement failed: {e}"))?;
    }
    Ok(())
}

fn capture_png(hwnd: HWND, width: i32, height: i32) -> Result<Vec<u8>> {
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits = std::ptr::null_mut();
    let dc = unsafe { CreateCompatibleDC(None) };
    if dc.is_invalid() {
        return Err("target capture device context unavailable".into());
    }
    let mut bitmap = HBITMAP::default();
    let mut old_bitmap = HGDIOBJ::default();
    let result = (|| {
        bitmap = unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0) }
            .map_err(|e| format!("target capture bitmap: {e}"))?;
        if bits.is_null() {
            return Err("target capture bitmap memory unavailable".into());
        }
        old_bitmap = unsafe { SelectObject(dc, bitmap.into()) };
        if old_bitmap.is_invalid() {
            return Err("target capture bitmap selection failed".into());
        }
        if !unsafe { PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(2)) }.as_bool() {
            return Err("target window does not support off-screen capture".into());
        }
        let byte_count = usize::try_from(width)
            .ok()
            .and_then(|w| w.checked_mul(height as usize))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or("target capture size overflow")?;
        let source = unsafe { std::slice::from_raw_parts(bits.cast::<u8>(), byte_count) };
        let mut rgba = Vec::with_capacity(byte_count);
        for bgra in source.as_chunks::<4>().0 {
            rgba.extend_from_slice(&[bgra[2], bgra[1], bgra[0], 255]);
        }
        encode_png_rgba(width as u32, height as u32, &rgba)
    })();
    unsafe {
        if !old_bitmap.is_invalid() {
            SelectObject(dc, old_bitmap);
        }
        if !bitmap.is_invalid() {
            let _ = DeleteObject(bitmap.into());
        }
        let _ = DeleteDC(dc);
    }
    let _ = &mut info;
    result
}

fn encode_png_rgba(width: u32, height: u32, pixels: &[u8]) -> Result<Vec<u8>> {
    let expected = usize::try_from(width)
        .ok()
        .and_then(|w| w.checked_mul(height as usize))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or("PNG image size overflow")?;
    if width == 0 || height == 0 || pixels.len() != expected {
        return Err("invalid PNG capture buffer".into());
    }
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("PNG header: {e}"))?;
        writer
            .write_image_data(pixels)
            .map_err(|e| format!("PNG encoding: {e}"))?;
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "presses Explorer on the live taskbar and changes foreground focus"]
    fn explorer_taskbar_semantic_action_opens_real_window() {
        use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
        use windows::core::w;
        let taskbar = unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }.unwrap();
        let crate::uia::Response::Snapshot(observation) =
            crate::uia::execute(crate::uia::Request::Inspect {
                hwnd: taskbar.0 as isize,
            })
            .unwrap()
        else {
            panic!("Expected taskbar observation");
        };
        let buttons: Vec<_> = observation
            .elements
            .iter()
            .filter(|element| {
                element.name.starts_with("File Explorer")
                    && element.control_type == 50000
                    && element.clickable.is_some()
            })
            .collect();
        assert_eq!(
            buttons.len(),
            1,
            "Expected exactly one grounded Explorer icon"
        );
        let point = buttons[0].clickable.unwrap();
        let before = native::foreground();
        let class_name = |hwnd: isize| {
            let mut class = [0u16; 128];
            let length = unsafe { GetClassNameW(HWND(hwnd as _), &mut class) }.max(0) as usize;
            String::from_utf16_lossy(&class[..length])
        };
        assert_ne!(
            class_name(before),
            "CabinetWClass",
            "Another app must be foreground before the test"
        );
        let desktop = DesktopManager::default();
        let window = desktop.window_by_handle(taskbar.0 as isize).unwrap();
        assert!(desktop.is_taskbar(&window.id).unwrap());
        let cursor_before = native::cursor().unwrap();
        assert!(buttons[0].supports_invoke);
        let result = crate::uia::execute_with_permission(
            crate::uia::Request::Act {
                identity: buttons[0].identity.clone().unwrap(),
                action: crate::uia::Action::Invoke {},
                expected: Some(buttons[0].state()),
            },
            true,
        )
        .unwrap();
        println!("Taskbar activation result: {result:?}");
        assert_eq!(
            native::cursor().unwrap(),
            cursor_before,
            "Semantic press moved the physical cursor"
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline && class_name(native::foreground()) != "CabinetWClass" {
            thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            class_name(native::foreground()),
            "CabinetWClass",
            "Explorer did not come forward"
        );
        assert_ne!(native::foreground(), before);
        let explorer_hwnd = native::foreground();
        let opened = loop {
            if let Ok(window) = desktop.window_by_handle(explorer_hwnd) {
                break window;
            }
            assert!(
                Instant::now() < deadline,
                "Explorer shell did not finish opening"
            );
            thread::sleep(Duration::from_millis(100));
        };
        assert!(opened.application.eq_ignore_ascii_case("explorer.exe"));
        println!(
            "PASS: one independent semantic press on {:?} at ({}, {}) opened real Explorer window {:?}; physical cursor unchanged.",
            buttons[0].name, point.x, point.y, opened.title
        );
    }

    #[test]
    #[ignore = "reads the live Windows taskbar without clicking or changing focus"]
    fn taskbar_catalog_inspection_and_capture() {
        use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
        use windows::core::w;
        let hwnd = unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }.unwrap();
        let desktop = DesktopManager::default();
        let entry = desktop.window_by_handle(hwnd.0 as isize).unwrap();
        assert_eq!(entry.title, "Windows taskbar");
        assert!(desktop.is_taskbar(&entry.id).unwrap());
        let crate::uia::Response::Snapshot(snapshot) =
            crate::uia::execute(crate::uia::Request::Inspect {
                hwnd: hwnd.0 as isize,
            })
            .unwrap()
        else {
            panic!("Expected a taskbar snapshot");
        };
        assert!(snapshot.elements.iter().any(|element| {
            element.name.starts_with("File Explorer")
                && element.control_type == 50000
                && element.clickable.is_some()
        }));
        let png = desktop.capture_target(&entry.id).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn split_uses_physical_work_area_and_keeps_negative_origin() {
        let (left, right) = split_bounds(Rect {
            left: -1920,
            top: 40,
            right: 0,
            bottom: 1040,
        })
        .unwrap();
        assert_eq!(
            left,
            Rect {
                left: -1920,
                top: 40,
                right: -960,
                bottom: 1040
            }
        );
        assert_eq!(
            right,
            Rect {
                left: -960,
                top: 40,
                right: 0,
                bottom: 1040
            }
        );
    }

    #[test]
    fn split_assigns_odd_pixel_to_right_window_without_gap() {
        let (left, right) = split_bounds(Rect {
            left: 10,
            top: 20,
            right: 1001,
            bottom: 820,
        })
        .unwrap();
        assert_eq!(left.right, right.left);
        assert_eq!(right.right, 1001);
        assert_eq!(left.right - left.left + right.right - right.left, 991);
    }

    #[test]
    fn too_small_monitor_is_rejected_before_any_placement() {
        assert!(
            split_bounds(Rect {
                left: 0,
                top: 0,
                right: 639,
                bottom: 600,
            })
            .is_err()
        );
    }

    #[test]
    fn app_catalog_entries_hide_native_handles() {
        let entry = WindowEntry {
            id: "w-0000000000000001".into(),
            title: "Calculator".into(),
            application: "Calculator.exe".into(),
            bounds: Rect {
                left: -100,
                top: 0,
                right: 100,
                bottom: 200,
            },
        };
        let value = serde_json::to_value(entry).unwrap();
        assert_eq!(value["id"], "w-0000000000000001");
        assert!(value.get("hwnd").is_none());
        assert_eq!(value["bounds"]["left"], -100);
    }

    #[test]
    fn png_encoder_writes_a_readable_rgba_image() {
        let png = encode_png_rgba(1, 1, &[255, 0, 0, 255]).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(png));
        let mut reader = decoder.read_info().unwrap();
        let mut output = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut output).unwrap();
        assert_eq!((info.width, info.height), (1, 1));
        assert_eq!(&output[..4], &[255, 0, 0, 255]);
    }
}
