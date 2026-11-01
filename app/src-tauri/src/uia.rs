use crate::{
    Result,
    control::Point,
    native::{self, Rect},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Seek, SeekFrom},
    os::windows::io::AsRawHandle,
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::Win32::{
    Foundation::{HWND, LPARAM, POINT, WPARAM},
    System::{
        Com::*,
        JobObjects::*,
        Ole::*,
        Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    },
    UI::{Accessibility::*, Input::KeyboardAndMouse::IsWindowEnabled, WindowsAndMessaging::*},
};

const LIMIT: usize = 512;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Identity {
    pub hwnd: isize,
    pub pid: u32,
    pub process_started: String,
    pub root_runtime_id: Vec<i32>,
    pub runtime_id: Vec<i32>,
    pub automation_id: String,
    pub control_type: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Element {
    pub id: String,
    pub name: String,
    pub value: Option<String>,
    pub automation_id: String,
    pub control_type: i32,
    pub rect: Option<Rect>,
    pub clickable: Option<Point>,
    pub enabled: bool,
    pub offscreen: bool,
    pub supports_invoke: bool,
    pub identity: Option<Identity>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
    pub captured_unix_ms: u64,
    pub monitors: Vec<Rect>,
    pub elements: Vec<Element>,
    pub truncated: bool,
    pub skipped: usize,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Inspect { hwnd: isize },
    Resolve { identity: Identity },
    Invoke { identity: Identity },
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    Snapshot(Snapshot),
    Element(Element),
    Invoked { element: Element, backend: String },
}

pub struct Inspector {
    registry: Mutex<HashMap<String, (Identity, Instant)>>,
    cancel: AtomicU64,
}
impl Default for Inspector {
    fn default() -> Self {
        Self {
            registry: Mutex::new(HashMap::new()),
            cancel: AtomicU64::new(0),
        }
    }
}
impl Inspector {
    pub fn cancel(&self) {
        self.cancel.fetch_add(1, Ordering::SeqCst);
    }
    pub fn inspect(&self, hwnd: Option<isize>) -> Result<Snapshot> {
        self.inspect_checked(hwnd, || Ok(()))
    }
    pub(crate) fn inspect_checked(
        &self,
        hwnd: Option<isize>,
        authorize: impl Fn() -> Result<()>,
    ) -> Result<Snapshot> {
        let mut registry = self
            .registry
            .try_lock()
            .map_err(|_| "UIA inspection busy")?;
        registry.clear();
        let hwnd = hwnd.unwrap_or_else(native::foreground);
        let Response::Snapshot(snapshot) =
            self.call_checked(Request::Inspect { hwnd }, Duration::from_secs(5), authorize)?
        else {
            return Err("invalid UIA response".into());
        };
        for e in &snapshot.elements {
            if let Some(identity) = &e.identity {
                registry.insert(e.id.clone(), (identity.clone(), Instant::now()));
            }
        }
        Ok(snapshot)
    }
    pub fn resolve(&self, id: &str) -> Result<Element> {
        self.resolve_checked(id, || Ok(()))
    }
    pub(crate) fn resolve_checked(
        &self,
        id: &str,
        authorize: impl Fn() -> Result<()>,
    ) -> Result<Element> {
        let registry = self
            .registry
            .try_lock()
            .map_err(|_| "UIA inspection busy")?;
        let (identity, created) = registry
            .get(id)
            .ok_or("unknown or superseded element; inspect again")?;
        if created.elapsed() > Duration::from_secs(15) {
            return Err("element lease expired; inspect again".into());
        }
        let Response::Element(element) = self.call_checked(
            Request::Resolve {
                identity: identity.clone(),
            },
            Duration::from_secs(3),
            authorize,
        )?
        else {
            return Err("invalid UIA response".into());
        };
        Ok(element)
    }
    pub(crate) fn invoke(&self, id: &str, authorize: impl Fn() -> Result<()>) -> Result<String> {
        let identity = {
            let mut registry = self
                .registry
                .try_lock()
                .map_err(|_| "UIA inspection busy")?;
            let (identity, created) = registry
                .remove(id)
                .ok_or("unknown, consumed or superseded element; inspect again")?;
            if created.elapsed() > Duration::from_secs(15) {
                return Err("element lease expired; inspect again".into());
            }
            identity
        };
        let Response::Invoked { backend, .. } = self.call_checked(
            Request::Invoke { identity },
            Duration::from_secs(3),
            authorize,
        )?
        else {
            return Err("invalid UIA invocation response".into());
        };
        Ok(backend)
    }
    fn call_checked(
        &self,
        request: Request,
        timeout: Duration,
        authorize: impl Fn() -> Result<()>,
    ) -> Result<Response> {
        authorize()?;
        let action = matches!(request, Request::Invoke { .. });
        let epoch = self.cancel.load(Ordering::SeqCst);
        let mut output = tempfile::tempfile().map_err(|e| e.to_string())?;
        let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
            .arg("--uia-worker")
            .arg(serde_json::to_string(&request).map_err(|e| e.to_string())?)
            .args(if action {
                vec!["--enable-actions"]
            } else {
                vec![]
            })
            .stdin(Stdio::null())
            .stdout(output.try_clone().map_err(|e| e.to_string())?)
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("UIA worker launch: {e}"))?;
        let _job = match WorkerJob::attach(&child) {
            Ok(job) => job,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let start = Instant::now();
        loop {
            let authorization = authorize();
            if authorization.is_err()
                || epoch != self.cancel.load(Ordering::SeqCst)
                || start.elapsed() > timeout
            {
                let _ = child.kill();
                let _ = child.wait();
                authorization?;
                return Err(if epoch != self.cancel.load(Ordering::SeqCst) {
                    "UIA inspection cancelled"
                } else {
                    "UIA provider timed out; worker terminated"
                }
                .into());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return Err(format!("UIA worker exited: {status}"));
                    }
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e.to_string());
                }
            }
        }
        output.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        output
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("UIA response exceeds limit".into());
        }
        serde_json::from_slice::<Result<Response>>(&bytes)
            .map_err(|e| format!("invalid UIA worker response: {e}"))?
    }
}

struct WorkerJob(windows::Win32::Foundation::HANDLE);
impl WorkerJob {
    fn attach(child: &std::process::Child) -> Result<Self> {
        unsafe {
            let job = Self(CreateJobObjectW(None, None).map_err(|e| e.to_string())?);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            )
            .map_err(|e| e.to_string())?;
            AssignProcessToJobObject(
                job.0,
                windows::Win32::Foundation::HANDLE(child.as_raw_handle()),
            )
            .map_err(|e| e.to_string())?;
            Ok(job)
        }
    }
}
impl Drop for WorkerJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

struct Apartment;
impl Apartment {
    fn new() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|e| e.to_string())?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}
struct Array(*mut SAFEARRAY);
impl Drop for Array {
    fn drop(&mut self) {
        unsafe {
            let _ = SafeArrayDestroy(self.0);
        }
    }
}
fn runtime_id(element: &IUIAutomationElement) -> Result<Vec<i32>> {
    unsafe {
        let array = Array(element.GetRuntimeId().map_err(|e| e.to_string())?);
        if array.0.is_null() {
            return Err("missing UIA runtime ID".into());
        }
        if SafeArrayGetDim(array.0) != 1 {
            return Err("invalid runtime ID dimensions".into());
        }
        let lower = SafeArrayGetLBound(array.0, 1).map_err(|e| e.to_string())?;
        let upper = SafeArrayGetUBound(array.0, 1).map_err(|e| e.to_string())?;
        let length = (upper as i64 - lower as i64 + 1) as usize;
        if length == 0 || length > 256 || SafeArrayGetElemsize(array.0) != 4 {
            return Err("invalid runtime ID length/type".into());
        }
        let mut data = std::ptr::null_mut();
        SafeArrayAccessData(array.0, &mut data).map_err(|e| e.to_string())?;
        let id = if data.is_null() {
            vec![]
        } else {
            std::slice::from_raw_parts(data as *const i32, length).to_vec()
        };
        SafeArrayUnaccessData(array.0).map_err(|e| e.to_string())?;
        if id.is_empty() {
            return Err("missing runtime ID".into());
        }
        Ok(id)
    }
}
fn process_started(pid: u32) -> Result<u64> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|e| e.to_string())?;
        let (mut created, mut exited, mut kernel, mut user) = Default::default();
        let result = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user);
        let _ = windows::Win32::Foundation::CloseHandle(process);
        result.map_err(|e| e.to_string())?;
        Ok((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64)
    }
}
fn same_or_child(
    automation: &IUIAutomation,
    parent: &IUIAutomationElement,
    mut hit: IUIAutomationElement,
) -> bool {
    unsafe {
        let Ok(walker) = automation.ControlViewWalker() else {
            return false;
        };
        for _ in 0..12 {
            if automation
                .CompareElements(parent, &hit)
                .is_ok_and(|b| b.as_bool())
            {
                return true;
            }
            let Ok(next) = walker.GetParentElement(&hit) else {
                break;
            };
            hit = next;
        }
        false
    }
}
fn read_element(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
    base: &Identity,
    displays: &[Rect],
) -> Result<Element> {
    unsafe {
        let password = element
            .CurrentIsPassword()
            .map_err(|e| e.to_string())?
            .as_bool();
        let name = if password {
            String::new()
        } else {
            element
                .CurrentName()
                .map(|s| s.to_string())
                .unwrap_or_default()
                .chars()
                .take(512)
                .collect()
        };
        let value = if password {
            None
        } else {
            element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .and_then(|pattern| pattern.CurrentValue())
                .or_else(|_| {
                    element
                        .GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                            UIA_LegacyIAccessiblePatternId,
                        )
                        .and_then(|pattern| pattern.CurrentValue())
                })
                .ok()
                .map(|s| s.to_string().chars().take(4096).collect())
        };
        let automation_id = element
            .CurrentAutomationId()
            .map(|s| s.to_string())
            .unwrap_or_default()
            .chars()
            .take(256)
            .collect::<String>();
        let control_type = element.CurrentControlType().map_err(|e| e.to_string())?.0;
        let enabled = element
            .CurrentIsEnabled()
            .map_err(|e| e.to_string())?
            .as_bool();
        let offscreen = element
            .CurrentIsOffscreen()
            .map_err(|e| e.to_string())?
            .as_bool();
        let rect = element
            .CurrentBoundingRectangle()
            .ok()
            .map(|r| Rect {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
            })
            .filter(Rect::valid);
        let identity = runtime_id(element).ok().map(|runtime_id| Identity {
            runtime_id,
            automation_id: automation_id.clone(),
            control_type,
            ..base.clone()
        });
        let clickable = if !password && enabled && !offscreen && identity.is_some() {
            rect.and_then(|rect| {
                let mut p = POINT::default();
                let candidate = if element.GetClickablePoint(&mut p).is_ok_and(|b| b.as_bool()) {
                    Point {
                        x: p.x as f64,
                        y: p.y as f64,
                    }
                } else {
                    rect.center()
                };
                if !rect.contains(candidate)
                    || !displays.iter().any(|r| r.contains(candidate))
                    || native::window_at(candidate) != base.hwnd
                {
                    return None;
                }
                automation
                    .ElementFromPoint(POINT {
                        x: candidate.x as i32,
                        y: candidate.y as i32,
                    })
                    .ok()
                    .filter(|hit| same_or_child(automation, element, hit.clone()))
                    .map(|_| candidate)
            })
        } else {
            None
        };
        Ok(Element {
            id: String::new(),
            name,
            value,
            automation_id,
            control_type,
            rect,
            clickable,
            enabled,
            offscreen,
            supports_invoke: !password
                && element
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .is_ok(),
            identity,
        })
    }
}
pub fn execute(request: Request) -> Result<Response> {
    execute_with_permission(request, false)
}
fn invoke_pushbutton(element: &IUIAutomationElement, identity: &Identity) -> Result<bool> {
    unsafe {
        let Ok(hwnd) = element.CurrentNativeWindowHandle() else {
            return Ok(false);
        };
        if hwnd.0.is_null() {
            return Ok(false);
        }
        let mut class = [0u16; 64];
        let count = GetClassNameW(hwnd, &mut class);
        let style = GetWindowLongW(hwnd, GWL_STYLE) & BS_TYPEMASK;
        if String::from_utf16_lossy(&class[..count.max(0) as usize]) != "Button"
            || !matches!(style, BS_PUSHBUTTON | BS_DEFPUSHBUTTON)
        {
            return Ok(false);
        }
        let parent = GetParent(hwnd).map_err(|e| e.to_string())?;
        if native::window_pid(hwnd.0 as isize) != identity.pid
            || native::window_pid(parent.0 as isize) != identity.pid
            || GetAncestor(hwnd, GA_ROOT).0 as isize != identity.hwnd
            || !IsWindowEnabled(hwnd).as_bool()
        {
            return Err("Win32 pushbutton identity changed".into());
        }
        let id = GetDlgCtrlID(hwnd);
        if !(1..=u16::MAX as i32).contains(&id) {
            return Err("invalid button control identifier".into());
        }
        // UIA's legacy proxy focuses the app; a pushbutton notification avoids pointer/focus side effects.
        let result = SendMessageTimeoutW(
            parent,
            WM_COMMAND,
            WPARAM(id as usize | ((BN_CLICKED as usize) << 16)),
            LPARAM(hwnd.0 as isize),
            SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
            500,
            None,
        );
        if result.0 == 0 {
            return Err("button notification failed or timed out; effect may be unknown".into());
        }
        Ok(true)
    }
}
pub(crate) fn execute_with_permission(request: Request, allow_actions: bool) -> Result<Response> {
    if matches!(request, Request::Invoke { .. }) && !allow_actions {
        return Err("UIA invocation requires --enable-actions".into());
    }
    native::dpi_aware();
    native::interactive_desktop()?;
    let _apartment = Apartment::new()?;
    unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("UIA unavailable: {e}"))?;
        let hwnd = match &request {
            Request::Inspect { hwnd } => *hwnd,
            Request::Resolve { identity } | Request::Invoke { identity } => identity.hwnd,
        };
        if hwnd == 0 {
            return Err("no target window".into());
        }
        let root = automation
            .ElementFromHandle(HWND(hwnd as _))
            .map_err(|e| format!("stale window: {e}"))?;
        let pid = native::window_pid(hwnd);
        if pid == 0 {
            return Err("target process is gone".into());
        }
        let root_runtime_id = runtime_id(&root)?;
        let base = Identity {
            hwnd,
            pid,
            process_started: process_started(pid)?.to_string(),
            root_runtime_id,
            runtime_id: vec![],
            automation_id: String::new(),
            control_type: 0,
        };
        if let Request::Resolve { identity } | Request::Invoke { identity } = &request
            && (identity.pid != pid
                || identity.process_started != base.process_started
                || identity.root_runtime_id != base.root_runtime_id
                || identity.runtime_id.is_empty())
        {
            return Err("stale window or process identity; inspect again".into());
        }
        let walker = automation.ControlViewWalker().map_err(|e| e.to_string())?;
        let displays = native::monitors()?;
        let mut queue = VecDeque::from([(root.clone(), 0usize)]);
        let mut elements = Vec::new();
        let mut visited = 0;
        let mut skipped = 0;
        let mut truncated = false;
        let snapshot_id = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        while let Some((element, depth)) = queue.pop_front() {
            if visited >= LIMIT {
                truncated = true;
                break;
            }
            visited += 1;
            if let Request::Resolve { identity } | Request::Invoke { identity } = &request {
                if runtime_id(&element).is_ok_and(|id| id == identity.runtime_id) {
                    let mut current = read_element(&automation, &element, &base, &displays)?;
                    if current.automation_id != identity.automation_id
                        || current.control_type != identity.control_type
                    {
                        return Err("stale element identity".into());
                    }
                    current.id = "resolved".into();
                    if matches!(request, Request::Invoke { .. }) {
                        if !current.enabled || current.offscreen || !current.supports_invoke {
                            return Err("control does not support background Invoke; physical input fallback is disabled".into());
                        }
                        native::interactive_desktop()?;
                        let backend = if current.control_type == 50000
                            && invoke_pushbutton(&element, identity)?
                        {
                            "win32_pushbutton_notification"
                        } else {
                            element
                                .GetCurrentPatternAs::<IUIAutomationInvokePattern>(
                                    UIA_InvokePatternId,
                                )
                                .and_then(|pattern| pattern.Invoke())
                                .map_err(|e| format!("UIA Invoke failed: {e}"))?;
                            "uia_invoke"
                        };
                        return Ok(Response::Invoked {
                            element: current,
                            backend: backend.into(),
                        });
                    }
                    return Ok(Response::Element(current));
                }
            } else {
                match read_element(&automation, &element, &base, &displays) {
                    Ok(mut e) => {
                        e.id = format!("{snapshot_id}:{}", elements.len());
                        elements.push(e);
                    }
                    Err(_) => skipped += 1,
                }
            }
            if depth >= 24 {
                truncated = true;
                continue;
            }
            if let Ok(first) = walker.GetFirstChildElement(&element) {
                let mut child = first;
                loop {
                    if queue.len() + visited >= LIMIT {
                        truncated = true;
                        break;
                    }
                    queue.push_back((child.clone(), depth + 1));
                    match walker.GetNextSiblingElement(&child) {
                        Ok(next) => child = next,
                        Err(_) => break,
                    }
                }
            }
        }
        if matches!(request, Request::Resolve { .. } | Request::Invoke { .. }) {
            return Err("element is stale or outside bounded tree; inspect again".into());
        }
        Ok(Response::Snapshot(Snapshot {
            id: snapshot_id,
            hwnd,
            pid,
            title: root
                .CurrentName()
                .map(|s| s.to_string())
                .unwrap_or_default(),
            captured_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            monitors: displays,
            elements,
            truncated,
            skipped,
        }))
    }
}
