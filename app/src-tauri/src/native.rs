use crate::{Result, control::Point};
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc, Mutex, OnceLock, Weak,
    atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
use std::{ffi::OsString, fs, os::windows::ffi::OsStringExt, path::PathBuf};
use windows::Win32::{
    Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, FILETIME, GetLastError, HANDLE, HLOCAL, HWND, LPARAM,
        LRESULT, LocalFree, POINT, WPARAM,
    },
    Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO},
    Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom, CRYPT_INTEGER_BLOB,
        CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    },
    System::{
        Com::CoTaskMemFree,
        LibraryLoader::GetModuleHandleW,
        StationsAndDesktops::{
            CloseDesktop, DESKTOP_READOBJECTS, GetUserObjectInformationW, OpenInputDesktop,
            UOI_NAME,
        },
        Threading::{
            CreateMutexW, GetCurrentProcessId, GetCurrentThreadId, GetProcessTimes, OpenProcess,
            PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
        },
    },
    UI::{
        HiDpi::{
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForMonitor, MDT_EFFECTIVE_DPI,
            SetThreadDpiAwarenessContext,
        },
        Input::KeyboardAndMouse::*,
        Shell::{FOLDERID_LocalAppData, KF_FLAG_DEFAULT, SHGetKnownFolderPath},
        WindowsAndMessaging::*,
    },
};

const INPUT_TAG: usize = 0x4b414a49;
static SIGNALS: OnceLock<Mutex<Weak<Signals>>> = OnceLock::new();
static HOOKS_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
pub struct Signals {
    pub emergency: AtomicBool,
    pub emergency_epoch: AtomicU64,
    pub manual: AtomicU64,
    pub observer_alive: AtomicBool,
    pub observer_pulse: AtomicU64,
    pub shared_target: AtomicIsize,
    pub target_activity: AtomicU64,
    pub last_external_foreground: AtomicIsize,
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

#[derive(Default)]
pub struct PhysicalArbiter(Mutex<()>);
impl PhysicalArbiter {
    pub fn run<T>(&self, action: impl FnOnce() -> Result<T>) -> Result<T> {
        let _lease = self
            .0
            .lock()
            .map_err(|_| "physical input arbiter poisoned")?;
        action()
    }
}

pub struct InputHost {
    pub signals: Arc<Signals>,
    pub physical: Arc<PhysicalArbiter>,
    pub input_permission: bool,
    _hooks: Hooks,
    _lease: Option<InputLease>,
}
impl InputHost {
    pub fn new(input_permission: bool) -> Result<Arc<Self>> {
        dpi_aware();
        let lease = input_permission.then(InputLease::acquire).transpose()?;
        let signals = Arc::new(Signals::default());
        let hooks = Hooks::start(signals.clone())?;
        Ok(Arc::new(Self {
            signals,
            physical: Arc::new(PhysicalArbiter::default()),
            input_permission,
            _hooks: hooks,
            _lease: lease,
        }))
    }
    pub fn with_physical_action<T>(&self, action: impl FnOnce() -> Result<T>) -> Result<T> {
        self.physical.run(action)
    }
}
impl Drop for InputLease {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub bounds: Rect,
    pub work_area: Rect,
    pub scale_factor: f64,
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
pub fn process_started(pid: u32) -> Result<u64> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|e| format!("open process: {e}"))?;
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let result = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user)
            .map_err(|e| format!("process identity: {e}"));
        let _ = CloseHandle(process);
        result?;
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
}
pub fn process_path(pid: u32) -> Result<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|e| format!("open process: {e}"))?;
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(path.as_mut_ptr()),
            &mut length,
        )
        .map_err(|e| format!("process path: {e}"));
        let _ = CloseHandle(process);
        result?;
        path.truncate(length as usize);
        Ok(String::from_utf16_lossy(&path))
    }
}
pub fn current_process_id() -> u32 {
    unsafe { GetCurrentProcessId() }
}

pub fn gateway_credential_path() -> Result<PathBuf> {
    Ok(match std::env::var_os("KAJI_GATEWAY_CREDENTIAL_PATH") {
        Some(path) => PathBuf::from(path),
        None => unsafe {
            let folder = SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, None)
                .map_err(|_| "Kaji gateway credential folder is unavailable")?;
            let path = PathBuf::from(OsString::from_wide(folder.as_wide()));
            CoTaskMemFree(Some(folder.0.cast()));
            path.join("Kaji").join("gateway-token.dpapi")
        },
    })
}

pub fn load_gateway_token() -> Result<String> {
    let path = gateway_credential_path()?;
    let mut encoded = fs::read_to_string(&path)
        .map_err(|_| "Kaji gateway credential is unavailable for this Windows account")?;
    let decoded = decode_hex(encoded.trim())?;
    encoded.clear();
    if decoded.is_empty() || decoded.len() > 64 * 1024 {
        return Err("Kaji gateway credential has invalid encrypted size".into());
    }
    unprotect_gateway_token(decoded)
}

pub fn new_device_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }
        .ok()
        .map_err(|_| "Could not create a private device login")?;
    let token = format!(
        "kd_{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    wipe(&mut bytes);
    Ok(token)
}

pub fn save_gateway_token(token: &str) -> Result<()> {
    validate_gateway_token(token)?;
    let path = gateway_credential_path()?;
    let parent = path.parent().ok_or("Device login folder is unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create the device login folder")?;
    let mut plaintext = token.as_bytes().to_vec();
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let protected = unsafe {
        CryptProtectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    wipe(&mut plaintext);
    protected.map_err(|_| "Could not protect the device login for this Windows account")?;
    let encrypted = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let encoded = encrypted
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    use std::io::Write;
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Could not save the device login")?;
    file.write_all(encoded.as_bytes())
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Could not save the device login")?;
    file.persist(&path)
        .map_err(|_| "Could not save the device login")?;
    Ok(())
}

fn decode_hex(value: &str) -> Result<Vec<u8>> {
    if !value.len().is_multiple_of(2) || value.is_empty() || value.len() > 128 * 1024 {
        return Err("Kaji gateway credential format is invalid".into());
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().as_chunks::<2>().0 {
        let digit = |byte: u8| match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        };
        let high = digit(pair[0]).ok_or("Kaji gateway credential format is invalid")?;
        let low = digit(pair[1]).ok_or("Kaji gateway credential format is invalid")?;
        bytes.push((high << 4) | low);
    }
    Ok(bytes)
}

fn unprotect_gateway_token(mut ciphertext: Vec<u8>) -> Result<String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    wipe(&mut ciphertext);
    result.map_err(|_| "Kaji gateway credential could not be decrypted for this Windows user")?;
    let plaintext = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let token_result = decode_gateway_token(plaintext);
    unsafe {
        wipe(std::slice::from_raw_parts_mut(
            output.pbData,
            output.cbData as usize,
        ));
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    token_result
}

fn decode_gateway_token(plaintext: &[u8]) -> Result<String> {
    let decoded = if plaintext.iter().all(|byte| byte.is_ascii_graphic()) {
        String::from_utf8(plaintext.to_vec())
            .map_err(|_| "Kaji gateway credential encoding is invalid")?
    } else if plaintext.len().is_multiple_of(2)
        && plaintext.as_chunks::<2>().0.iter().all(|pair| pair[1] == 0)
    {
        String::from_utf8(
            plaintext
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| pair[0])
                .collect::<Vec<_>>(),
        )
        .map_err(|_| "Kaji gateway credential encoding is invalid")?
    } else if plaintext.len() >= 2 && plaintext[0..2] == [0xff, 0xfe] {
        let units = plaintext[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
        String::from_utf16(&units.collect::<Vec<_>>())
            .map_err(|_| "Kaji gateway credential encoding is invalid")?
    } else {
        return Err("Kaji gateway credential encoding is invalid".into());
    };
    validate_gateway_token(decoded.trim_matches('\0').trim())
}

pub fn validate_gateway_token(token: &str) -> Result<String> {
    if !(32..=128).contains(&token.len())
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("Kaji gateway credential is invalid".into());
    }
    Ok(token.to_owned())
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    std::sync::atomic::compiler_fence(Ordering::SeqCst);
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
    Ok(displays()?
        .into_iter()
        .map(|display| display.bounds)
        .collect())
}

pub fn displays() -> Result<Vec<DisplayInfo>> {
    unsafe extern "system" fn collect(
        h: HMONITOR,
        _: HDC,
        _: *mut windows::Win32::Foundation::RECT,
        data: LPARAM,
    ) -> windows::core::BOOL {
        let output = unsafe { &mut *(data.0 as *mut Vec<DisplayInfo>) };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetMonitorInfoW(h, &mut info) }.as_bool() {
            let r = info.rcMonitor;
            let work = info.rcWork;
            let mut dpi_x = 96;
            let mut dpi_y = 96;
            let scale_factor = if unsafe {
                GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y)
            }
            .is_ok()
            {
                f64::from(dpi_x) / 96.0
            } else {
                1.0
            };
            output.push(DisplayInfo {
                bounds: Rect {
                    left: r.left,
                    top: r.top,
                    right: r.right,
                    bottom: r.bottom,
                },
                work_area: Rect {
                    left: work.left,
                    top: work.top,
                    right: work.right,
                    bottom: work.bottom,
                },
                scale_factor,
            });
        }
        true.into()
    }
    let mut list: Vec<DisplayInfo> = Vec::new();
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
    list.sort_by_key(|display| (display.bounds.left, display.bounds.top));
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

fn key_event(key: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                dwExtraInfo: INPUT_TAG,
                ..Default::default()
            },
        },
    }
}

pub(crate) fn type_text(text: &str, check: impl Fn() -> Result<()>) -> Result<()> {
    for code in text.encode_utf16() {
        check()?;
        let event = |up| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: code,
                    dwFlags: KEYEVENTF_UNICODE
                        | if up {
                            KEYEVENTF_KEYUP
                        } else {
                            Default::default()
                        },
                    dwExtraInfo: INPUT_TAG,
                    ..Default::default()
                },
            },
        };
        send(&[event(false), event(true)])?;
    }
    Ok(())
}

pub(crate) fn press_key(name: &str) -> Result<()> {
    let (modifier, key) = match name {
        "Enter" => (None, VK_RETURN),
        "Tab" => (None, VK_TAB),
        "Backspace" => (None, VK_BACK),
        "ArrowLeft" => (None, VK_LEFT),
        "ArrowRight" => (None, VK_RIGHT),
        "ArrowUp" => (None, VK_UP),
        "ArrowDown" => (None, VK_DOWN),
        "Control+A" => (Some(VK_CONTROL), VIRTUAL_KEY(0x41)),
        "Control+C" => (Some(VK_CONTROL), VIRTUAL_KEY(0x43)),
        "Control+V" => (Some(VK_CONTROL), VIRTUAL_KEY(0x56)),
        _ => return Err("unsupported physical key".into()),
    };
    if let Some(modifier) = modifier {
        send(&[key_event(modifier, false)])?;
    }
    let result = send(&[key_event(key, false), key_event(key, true)]);
    let _ = send(&[key_event(key, true)]);
    if let Some(modifier) = modifier {
        let _ = send(&[key_event(modifier, true)]);
    }
    result
}

pub(crate) fn activate_taskbar_slot(slot: u8) -> Result<()> {
    if modifiers_down() {
        return Err("taskbar shortcut is unavailable while a modifier is held".into());
    }
    interactive_desktop()?;
    let events = taskbar_shortcut_inputs(slot)?;
    let result = send(&events);
    if result.is_err() {
        let _ = send(&events[3..]);
    }
    result
}

fn taskbar_shortcut_inputs(slot: u8) -> Result<[INPUT; 6]> {
    if !(1..=10).contains(&slot) {
        return Err("taskbar slot must be between 1 and 10".into());
    }
    let key = VIRTUAL_KEY(if slot == 10 {
        0x30
    } else {
        0x30 + u16::from(slot)
    });
    Ok([
        key_event(VK_LWIN, false),
        // Ctrl activates the last window instead of leaving a grouped app's previews open.
        key_event(VK_CONTROL, false),
        key_event(key, false),
        key_event(key, true),
        key_event(VK_CONTROL, true),
        key_event(VK_LWIN, true),
    ])
}

pub(crate) fn scroll(delta: i32) -> Result<()> {
    let mut event = mouse(MOUSEEVENTF_WHEEL, 0, 0);
    event.Anonymous.mi.mouseData = delta as u32;
    send(&[event])
}

unsafe extern "system" fn mouse_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = unsafe { &*(l.0 as *const MSLLHOOKSTRUCT) };
        if event.dwExtraInfo != INPUT_TAG
            && let Some(signals) = hook_signals()
        {
            signals.manual.fetch_add(1, Ordering::SeqCst);
            if w.0 as u32 != WM_MOUSEMOVE {
                let hwnd = window_at(Point {
                    x: event.pt.x as f64,
                    y: event.pt.y as f64,
                });
                if hwnd != 0 && hwnd == signals.shared_target.load(Ordering::SeqCst) {
                    signals.target_activity.fetch_add(1, Ordering::SeqCst);
                }
                if hwnd != 0 && window_pid(hwnd) != current_process_id() {
                    signals
                        .last_external_foreground
                        .store(hwnd, Ordering::SeqCst);
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, code, w, l) }
}
unsafe extern "system" fn keyboard_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = unsafe { &*(l.0 as *const KBDLLHOOKSTRUCT) };
        if let Some(signals) = hook_signals() {
            if event.vkCode == VK_ESCAPE.0 as u32
                && (w.0 as u32 == WM_KEYDOWN || w.0 as u32 == WM_SYSKEYDOWN)
            {
                signals.emergency.store(true, Ordering::SeqCst);
                signals.emergency_epoch.fetch_add(1, Ordering::SeqCst);
            }
            if event.dwExtraInfo != INPUT_TAG {
                signals.manual.fetch_add(1, Ordering::SeqCst);
                let hwnd = foreground();
                if hwnd != 0 && hwnd == signals.shared_target.load(Ordering::SeqCst) {
                    signals.target_activity.fetch_add(1, Ordering::SeqCst);
                }
                if hwnd != 0 && window_pid(hwnd) != current_process_id() {
                    signals
                        .last_external_foreground
                        .store(hwnd, Ordering::SeqCst);
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, code, w, l) }
}

fn hook_signals() -> Option<Arc<Signals>> {
    SIGNALS
        .get_or_init(|| Mutex::new(Weak::new()))
        .lock()
        .ok()
        .and_then(|signals| signals.upgrade())
}

fn attach_signals(signals: &Arc<Signals>) -> Result<()> {
    let mut target = SIGNALS
        .get_or_init(|| Mutex::new(Weak::new()))
        .lock()
        .map_err(|_| "input observer signal registry poisoned")?;
    *target = Arc::downgrade(signals);
    Ok(())
}

fn detach_signals() {
    if let Some(registry) = SIGNALS.get()
        && let Ok(mut target) = registry.lock()
    {
        *target = Weak::new();
    }
}

pub struct Hooks {
    thread: Option<JoinHandle<()>>,
    id: u32,
}
impl Hooks {
    pub fn start(signals: Arc<Signals>) -> Result<Self> {
        if HOOKS_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("input observer already initialized in this process".into());
        }
        if let Err(error) = attach_signals(&signals) {
            HOOKS_ACTIVE.store(false, Ordering::SeqCst);
            return Err(error);
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let thread_id = Arc::new(AtomicU32::new(0));
        let id_slot = thread_id.clone();
        let thread = thread::Builder::new()
            .name("kaji-input-observer".into())
            .spawn(move || unsafe {
                let mut msg = MSG::default();
                let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
                id_slot.store(GetCurrentThreadId(), Ordering::SeqCst);
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
                            detach_signals();
                            HOOKS_ACTIVE.store(false, Ordering::SeqCst);
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
                        detach_signals();
                        HOOKS_ACTIVE.store(false, Ordering::SeqCst);
                        let _ = tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| {
                detach_signals();
                HOOKS_ACTIVE.store(false, Ordering::SeqCst);
                e.to_string()
            })?;
        let id = match rx.recv_timeout(std::time::Duration::from_secs(3)) {
            Ok(Ok(id)) => id,
            Ok(Err(error)) => return Err(error),
            Err(error) => {
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
                let mut id = thread_id.load(Ordering::SeqCst);
                while id == 0 && std::time::Instant::now() < deadline {
                    thread::sleep(std::time::Duration::from_millis(1));
                    id = thread_id.load(Ordering::SeqCst);
                }
                if id != 0 {
                    unsafe {
                        let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
                    }
                }
                let _ = thread.join();
                detach_signals();
                HOOKS_ACTIVE.store(false, Ordering::SeqCst);
                return Err(error.to_string());
            }
        };
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
        if let Some(signals) = hook_signals() {
            signals.observer_alive.store(false, Ordering::SeqCst);
        }
        detach_signals();
        HOOKS_ACTIVE.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn taskbar_activation_never_generates_mouse_input_and_releases_keys() {
        for slot in 1..=10 {
            let events = taskbar_shortcut_inputs(slot).unwrap();
            assert!(events.iter().all(|event| event.r#type == INPUT_KEYBOARD));
            unsafe {
                assert_eq!(events[0].Anonymous.ki.wVk, VK_LWIN);
                assert_eq!(events[5].Anonymous.ki.wVk, VK_LWIN);
                assert_eq!(events[1].Anonymous.ki.wVk, VK_CONTROL);
                assert_eq!(events[4].Anonymous.ki.wVk, VK_CONTROL);
                assert_eq!(events[2].Anonymous.ki.wVk, events[3].Anonymous.ki.wVk);
                assert!(
                    events[..3].iter().all(|event| !event
                        .Anonymous
                        .ki
                        .dwFlags
                        .contains(KEYEVENTF_KEYUP))
                );
                assert!(
                    events[3..].iter().all(|event| event
                        .Anonymous
                        .ki
                        .dwFlags
                        .contains(KEYEVENTF_KEYUP))
                );
            }
        }
        assert!(taskbar_shortcut_inputs(0).is_err());
        assert!(taskbar_shortcut_inputs(11).is_err());
    }
    #[test]
    fn negative_virtual_desktop_coordinates() {
        assert_eq!(absolute_axis(-1920., -1920, 3840).unwrap(), 0);
        assert_eq!(absolute_axis(1919., -1920, 3840).unwrap(), 65535);
    }
    #[test]
    fn current_process_identity_uses_valid_win32_output_buffers() {
        let pid = current_process_id();
        let started = process_started(pid).unwrap();
        assert!(started > 0);
        assert_eq!(process_started(pid).unwrap(), started);
        assert!(!process_path(pid).unwrap().is_empty());
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

    #[test]
    fn physical_actions_share_one_serial_lease() {
        use std::sync::{Arc, Barrier, atomic::AtomicUsize};
        use std::time::Duration;

        let arbiter = Arc::new(PhysicalArbiter::default());
        let barrier = Arc::new(Barrier::new(3));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let arbiter = arbiter.clone();
            let barrier = barrier.clone();
            let active = active.clone();
            let peak = peak.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                arbiter
                    .run(|| {
                        let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(20));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .unwrap();
            }));
        }
        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }
}
