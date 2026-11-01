use crate::{Result, control::Point};
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
use windows::Win32::{
    Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, HWND, LPARAM, LRESULT, POINT,
        WPARAM,
    },
    Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO},
    System::{
        LibraryLoader::GetModuleHandleW,
        StationsAndDesktops::{
            CloseDesktop, DESKTOP_READOBJECTS, GetUserObjectInformationW, OpenInputDesktop,
            UOI_NAME,
        },
        Threading::{CreateMutexW, GetCurrentThreadId},
    },
    UI::{
        HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext},
        Input::KeyboardAndMouse::*,
        WindowsAndMessaging::*,
    },
};

const INPUT_TAG: usize = 0x4b414a49;
static SIGNALS: OnceLock<Arc<Signals>> = OnceLock::new();

#[derive(Default)]
pub struct Signals {
    pub emergency: AtomicBool,
    pub manual: AtomicU64,
    pub observer_alive: AtomicBool,
    pub observer_pulse: AtomicU64,
}

pub struct InputLease(HANDLE);
// The handle is an owned kernel mutex object, never a thread-affine window or COM pointer.
unsafe impl Send for InputLease {}
unsafe impl Sync for InputLease {}
impl InputLease {
    pub fn acquire() -> Result<Self> {
        unsafe {
            let handle = CreateMutexW(None, false, windows::core::w!("Local\\Kaji.P0.InputOwner"))
                .map_err(|e| e.to_string())?;
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let _ = CloseHandle(handle);
                return Err("another Kaji process already owns native input".into());
            }
            Ok(Self(handle))
        }
    }
}
impl Drop for InputLease {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}
impl Rect {
    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.left as f64
            && p.y >= self.top as f64
            && p.x < self.right as f64
            && p.y < self.bottom as f64
    }
    pub fn center(&self) -> Point {
        Point {
            x: (self.left as f64 + self.right as f64) / 2.,
            y: (self.top as f64 + self.bottom as f64) / 2.,
        }
    }
    pub fn valid(&self) -> bool {
        self.right > self.left && self.bottom > self.top
    }
}

pub fn dpi_aware() {
    // Each native worker uses physical pixels, regardless of the host's manifest/context.
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}
pub fn cursor() -> Result<Point> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.map_err(|e| format!("GetCursorPos: {e}"))?;
    Ok(Point {
        x: p.x as f64,
        y: p.y as f64,
    })
}
pub fn foreground() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}
pub fn window_pid(hwnd: isize) -> u32 {
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(HWND(hwnd as _), Some(&mut pid));
    }
    pid
}
pub fn window_at(p: Point) -> isize {
    unsafe {
        GetAncestor(
            WindowFromPoint(POINT {
                x: p.x as i32,
                y: p.y as i32,
            }),
            GA_ROOT,
        )
        .0 as isize
    }
}
pub fn interactive_desktop() -> Result<()> {
    unsafe {
        let desktop = OpenInputDesktop(Default::default(), false, DESKTOP_READOBJECTS)
            .map_err(|e| format!("input desktop unavailable: {e}"))?;
        let mut name = [0u16; 64];
        let result = GetUserObjectInformationW(
            windows::Win32::Foundation::HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            128,
            None,
        );
        let _ = CloseDesktop(desktop);
        result.map_err(|e| format!("desktop identity unavailable: {e}"))?;
        let name = String::from_utf16_lossy(
            &name[..name.iter().position(|c| *c == 0).unwrap_or(name.len())],
        );
        if name != "Default" || foreground() == 0 {
            return Err("non-interactive or secure desktop".into());
        }
    }
    Ok(())
}
pub fn modifiers_down() -> bool {
    [
        VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN, VK_LBUTTON, VK_RBUTTON, VK_MBUTTON,
    ]
    .iter()
    .any(|k| unsafe { GetAsyncKeyState(k.0 as i32) } < 0)
}
pub fn monitors() -> Result<Vec<Rect>> {
    unsafe extern "system" fn collect(
        h: HMONITOR,
        _: HDC,
        _: *mut windows::Win32::Foundation::RECT,
        data: LPARAM,
    ) -> windows::core::BOOL {
        let output = unsafe { &mut *(data.0 as *mut Vec<Rect>) };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetMonitorInfoW(h, &mut info) }.as_bool() {
            let r = info.rcMonitor;
            output.push(Rect {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
            });
        }
        true.into()
    }
    let mut list: Vec<Rect> = Vec::new();
    if !unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(collect),
            LPARAM(&mut list as *mut _ as isize),
        )
    }
    .as_bool()
        || list.is_empty()
    {
        return Err("monitor enumeration failed".into());
    }
    list.sort_by_key(|r| (r.left, r.top));
    Ok(list)
}
pub fn clamp_to_monitors(p: Point, list: &[Rect]) -> Result<Point> {
    list.iter()
        .map(|r| Point {
            x: p.x.clamp(r.left as f64, (r.right - 1) as f64),
            y: p.y.clamp(r.top as f64, (r.bottom - 1) as f64),
        })
        .min_by(|a, b| a.distance(p).total_cmp(&b.distance(p)))
        .ok_or_else(|| "no display".into())
}
pub fn absolute_axis(value: f64, origin: i32, size: i32) -> Result<i32> {
    if !value.is_finite() || size <= 1 {
        return Err("invalid absolute pointer coordinate".into());
    }
    Ok(((value - origin as f64) * 65535. / (size - 1) as f64)
        .round()
        .clamp(0., 65535.) as i32)
}
fn mouse(flags: MOUSE_EVENT_FLAGS, x: i32, y: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x,
                dy: y,
                dwFlags: flags,
                dwExtraInfo: INPUT_TAG,
                ..Default::default()
            },
        },
    }
}
fn send(events: &[INPUT]) -> Result<()> {
    let count = unsafe { SendInput(events, std::mem::size_of::<INPUT>() as i32) };
    if count != events.len() as u32 {
        return Err(format!(
            "SendInput sent {count}/{} events (UIPI or desktop access may deny input)",
            events.len()
        ));
    }
    Ok(())
}
pub(crate) fn move_to(p: Point, list: &[Rect]) -> Result<()> {
    let left = list.iter().map(|r| r.left).min().ok_or("no monitors")?;
    let top = list.iter().map(|r| r.top).min().ok_or("no monitors")?;
    let right = list.iter().map(|r| r.right).max().ok_or("no monitors")?;
    let bottom = list.iter().map(|r| r.bottom).max().ok_or("no monitors")?;
    send(&[mouse(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        absolute_axis(p.x, left, right - left)?,
        absolute_axis(p.y, top, bottom - top)?,
    )])
}
pub(crate) fn click() -> Result<()> {
    let result = send(&[
        mouse(MOUSEEVENTF_LEFTDOWN, 0, 0),
        mouse(MOUSEEVENTF_LEFTUP, 0, 0),
    ]);
    if result.is_err() {
        let _ = send(&[mouse(MOUSEEVENTF_LEFTUP, 0, 0)]);
    }
    result
}

unsafe extern "system" fn mouse_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = unsafe { &*(l.0 as *const MSLLHOOKSTRUCT) };
        if event.dwExtraInfo != INPUT_TAG
            && let Some(signals) = SIGNALS.get()
        {
            signals.manual.fetch_add(1, Ordering::SeqCst);
        }
    }
    unsafe { CallNextHookEx(None, code, w, l) }
}
unsafe extern "system" fn keyboard_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = unsafe { &*(l.0 as *const KBDLLHOOKSTRUCT) };
        if let Some(signals) = SIGNALS.get() {
            if event.vkCode == VK_ESCAPE.0 as u32
                && (w.0 as u32 == WM_KEYDOWN || w.0 as u32 == WM_SYSKEYDOWN)
            {
                signals.emergency.store(true, Ordering::SeqCst);
            }
            if event.dwExtraInfo != INPUT_TAG {
                signals.manual.fetch_add(1, Ordering::SeqCst);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, w, l) }
}

pub struct Hooks {
    thread: Option<JoinHandle<()>>,
    id: u32,
}
impl Hooks {
    pub fn start(signals: Arc<Signals>) -> Result<Self> {
        if SIGNALS.set(signals.clone()).is_err() {
            return Err("input observer already initialized in this process".into());
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("kaji-input-observer".into())
            .spawn(move || unsafe {
                let mut msg = MSG::default();
                let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
                let setup = (|| -> Result<_> {
                    let module = GetModuleHandleW(None).map_err(|e| e.to_string())?;
                    let mouse =
                        SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), Some(module.into()), 0)
                            .map_err(|e| e.to_string())?;
                    let keyboard = match SetWindowsHookExW(
                        WH_KEYBOARD_LL,
                        Some(keyboard_hook),
                        Some(module.into()),
                        0,
                    ) {
                        Ok(k) => k,
                        Err(e) => {
                            let _ = UnhookWindowsHookEx(mouse);
                            return Err(e.to_string());
                        }
                    };
                    Ok((mouse, keyboard))
                })();
                match setup {
                    Ok((mouse, keyboard)) => {
                        let timer = SetTimer(None, 0, 50, None);
                        if timer == 0 {
                            let _ = UnhookWindowsHookEx(keyboard);
                            let _ = UnhookWindowsHookEx(mouse);
                            let _ = tx
                                .send(Err("input observer heartbeat initialization failed".into()));
                            return;
                        }
                        signals.observer_alive.store(true, Ordering::SeqCst);
                        let _ = tx.send(Ok(GetCurrentThreadId()));
                        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                            signals.observer_pulse.fetch_add(1, Ordering::SeqCst);
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                        signals.observer_alive.store(false, Ordering::SeqCst);
                        let _ = KillTimer(None, timer);
                        let _ = UnhookWindowsHookEx(keyboard);
                        let _ = UnhookWindowsHookEx(mouse);
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let id = rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|e| e.to_string())??;
        Ok(Self {
            thread: Some(thread),
            id,
        })
    }
}
impl Drop for Hooks {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negative_virtual_desktop_coordinates() {
        assert_eq!(absolute_axis(-1920., -1920, 3840).unwrap(), 0);
        assert_eq!(absolute_axis(1919., -1920, 3840).unwrap(), 65535);
    }
    #[test]
    fn pointer_never_lands_in_monitor_gap() {
        let list = [
            Rect {
                left: -100,
                top: 0,
                right: 0,
                bottom: 100,
            },
            Rect {
                left: 20,
                top: 0,
                right: 120,
                bottom: 100,
            },
        ];
        let p = clamp_to_monitors(Point { x: 5., y: 30. }, &list).unwrap();
        assert!(list.iter().any(|r| r.contains(p)));
    }
}
