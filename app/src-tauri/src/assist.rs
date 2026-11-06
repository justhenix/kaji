use crate::{
    Result,
    control::Point,
    native::{self, InputHost, Rect, Signals},
    uia::{Action, ElementState, Inspector, Snapshot},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{BufRead, Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize)]
pub struct IntentCursor {
    pub revision: u64,
    pub element_id: String,
    pub point: Point,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Guide,
    #[default]
    Assist,
    Agent,
}
#[derive(Clone, Debug, Serialize)]
pub struct Confirmation {
    pub id: String,
    pub revision: u64,
    pub element_id: String,
    pub target_name: String,
    pub action: Action,
}
struct Pending {
    confirmation: Confirmation,
    expected: ElementState,
    created: Instant,
}
#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub session: u64,
    pub phase: String,
    pub reason: String,
    pub hwnd: isize,
    pub cursor: Option<IntentCursor>,
    pub physical_cursor: Option<Point>,
    pub foreground_hwnd: isize,
    pub actions: u64,
    pub inspection_required: bool,
    pub verification_pending: bool,
    pub last_outcome: Option<String>,
    pub last_backend: Option<String>,
    pub mode: Mode,
    pub confirmation: Option<Confirmation>,
}
struct State {
    status: Status,
    pid: u32,
    monitors: Vec<Rect>,
    revision: u64,
    activity: u64,
    pulse: u64,
    pulse_at: Instant,
    pending: Option<Pending>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            status: Status {
                session: 0,
                phase: "stopped".into(),
                reason: "session has not started".into(),
                hwnd: 0,
                cursor: None,
                physical_cursor: None,
                foreground_hwnd: 0,
                actions: 0,
                inspection_required: true,
                verification_pending: false,
                last_outcome: None,
                last_backend: None,
                mode: Mode::default(),
                confirmation: None,
            },
            pid: 0,
            monitors: vec![],
            revision: 0,
            activity: 0,
            pulse: 0,
            pulse_at: Instant::now(),
            pending: None,
        }
    }
}
impl State {
    fn clear_confirmation(&mut self) {
        self.pending = None;
        self.status.confirmation = None;
    }
    fn revoke(&mut self, reason: &str) {
        if self.status.phase != "stopped" || self.status.session == 0 {
            self.status.reason = reason.into();
        }
        self.status.session = self.status.session.wrapping_add(1);
        self.status.phase = "stopped".into();
        self.status.cursor = None;
        self.clear_confirmation();
        self.status.inspection_required = true;
    }
    fn pause(&mut self, reason: &str) {
        self.status.phase = "paused".into();
        self.status.reason = reason.into();
        self.status.cursor = None;
        self.clear_confirmation();
        self.status.inspection_required = true;
    }
    fn observe_input(&mut self, signals: &Signals, now: Instant) {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| now.duration_since(p.created) > Duration::from_secs(15))
        {
            self.clear_confirmation();
            self.status.cursor = None;
            self.status.inspection_required = true;
            self.status.reason = "confirmation expired; inspect again".into();
        }
        if !matches!(
            self.status.phase.as_str(),
            "initializing" | "active" | "paused"
        ) {
            return;
        }
        let pulse = signals.observer_pulse.load(Ordering::SeqCst);
        if pulse != self.pulse {
            self.pulse = pulse;
            self.pulse_at = now;
        }
        if signals.emergency.load(Ordering::SeqCst) {
            self.revoke("emergency stop (Escape)");
        } else if !signals.observer_alive.load(Ordering::SeqCst)
            || now.duration_since(self.pulse_at) > Duration::from_millis(300)
        {
            self.revoke("native observer unavailable or heartbeat expired");
        } else if signals.target_activity.load(Ordering::SeqCst) != self.activity {
            self.activity = signals.target_activity.load(Ordering::SeqCst);
            if self.status.mode == Mode::Guide {
                self.status.cursor = None;
                self.status.inspection_required = true;
                self.status.reason = "user action observed; inspect the expected effect".into();
            } else {
                self.pause("user is interacting with the shared target; explicit resume and inspection required");
            }
        }
    }
}

pub struct Assist {
    state: Mutex<State>,
    serial: Mutex<()>,
    inspector: Inspector,
    signals: Arc<Signals>,
    permission: bool,
    _input_host: Arc<InputHost>,
}
impl Assist {
    pub fn new(permission: bool) -> Result<Self> {
        Self::with_input_host(InputHost::new(permission)?)
    }
    pub fn with_input_host(input: Arc<InputHost>) -> Result<Self> {
        native::dpi_aware();
        let signals = input.signals.clone();
        let permission = input.input_permission;
        Ok(Self {
            state: Mutex::new(State::default()),
            serial: Mutex::new(()),
            inspector: Inspector::default(),
            signals,
            permission,
            _input_host: input,
        })
    }
    pub fn begin(&self, hwnd: isize) -> Result<Status> {
        self.begin_at(hwnd, self.status()?.session, Mode::default())
    }
    pub fn begin_with_mode(&self, hwnd: isize, mode: Mode) -> Result<Status> {
        self.begin_at(hwnd, self.status()?.session, mode)
    }
    fn begin_at(&self, hwnd: isize, expected: u64, mode: Mode) -> Result<Status> {
        let _serial = self.serial.lock().map_err(|_| "assist executor poisoned")?;
        native::interactive_desktop()?;
        self.inspector.cancel();
        let session = {
            let mut s = self.state.lock().map_err(|_| "assist state poisoned")?;
            if s.status.session != expected {
                return Err("queued initialization was cancelled".into());
            }
            let session = s.status.session.wrapping_add(1);
            *s = State::default();
            s.status.session = session;
            s.status.mode = mode;
            s.status.phase = "initializing".into();
            self.signals.shared_target.store(0, Ordering::SeqCst);
            s.activity = self.signals.target_activity.load(Ordering::SeqCst);
            s.pulse = self.signals.observer_pulse.load(Ordering::SeqCst);
            self.signals.emergency.store(false, Ordering::SeqCst);
            session
        };
        let snapshot = self.inspector.inspect_checked(Some(hwnd), || {
            let status = self.status()?;
            if status.session != session || status.phase != "initializing" {
                return Err("initialization cancelled".into());
            }
            Ok(())
        })?;
        let mut s = self.state.lock().map_err(|_| "assist state poisoned")?;
        if s.status.session != session
            || s.status.phase != "initializing"
            || self.signals.emergency.load(Ordering::SeqCst)
        {
            return Err("initialization cancelled".into());
        }
        s.status.hwnd = hwnd;
        s.pid = snapshot.pid;
        s.monitors = snapshot.monitors;
        s.pulse = self.signals.observer_pulse.load(Ordering::SeqCst);
        s.pulse_at = Instant::now();
        self.signals.shared_target.store(hwnd, Ordering::SeqCst);
        s.activity = self.signals.target_activity.load(Ordering::SeqCst);
        s.status.phase = "active".into();
        s.status.reason = "background UIA session; physical cursor is independent".into();
        Ok(s.status.clone())
    }
    pub fn status(&self) -> Result<Status> {
        let mut s = self.state.lock().map_err(|_| "assist state poisoned")?;
        s.observe_input(&self.signals, Instant::now());
        if s.status.phase == "stopped" {
            self.signals.shared_target.store(0, Ordering::SeqCst);
        }
        let mut status = s.status.clone();
        status.physical_cursor = native::cursor().ok();
        status.foreground_hwnd = native::foreground();
        Ok(status)
    }
    fn authorize(&self, session: u64, allow_paused: bool) -> Result<Status> {
        let status = self.status()?;
        if status.session != session
            || !(status.phase == "active" || allow_paused && status.phase == "paused")
        {
            return Err(format!(
                "session unavailable: {}: {}",
                status.phase, status.reason
            ));
        }
        native::interactive_desktop()?;
        let s = self.state.lock().map_err(|_| "assist state poisoned")?;
        if native::window_pid(status.hwnd) != s.pid || native::monitors()? != s.monitors {
            drop(s);
            self.revoke("target identity or display topology changed")?;
            return Err("target identity or display topology changed".into());
        }
        Ok(status)
    }
    pub fn inspect(&self, session: u64) -> Result<Snapshot> {
        let _serial = self.serial.lock().map_err(|_| "assist executor poisoned")?;
        let status = self.authorize(session, true)?;
        let snapshot = self.inspector.inspect_checked(Some(status.hwnd), || {
            self.authorize(session, true).map(|_| ())
        })?;
        self.authorize(session, true)?;
        let mut s = self.state.lock().map_err(|_| "assist state poisoned")?;
        if s.status.session != session {
            return Err("inspection cancelled".into());
        }
        s.status.cursor = None;
        s.clear_confirmation();
        s.status.inspection_required = false;
        s.status.verification_pending = false;
        Ok(snapshot)
    }
    pub fn point(&self, session: u64, element_id: &str) -> Result<IntentCursor> {
        let _serial = self.serial.lock().map_err(|_| "assist executor poisoned")?;
        let status = self.authorize(session, false)?;
        if status.inspection_required {
            return Err("fresh inspection required".into());
        }
        let element = self
            .inspector
            .resolve_checked(element_id, || self.authorize(session, false).map(|_| ()))?;
        self.authorize(session, false)?;
        if element
            .identity
            .as_ref()
            .is_none_or(|i| i.hwnd != status.hwnd)
            || !element.enabled
            || element.offscreen
        {
            return Err("target is unavailable or belongs to another window".into());
        }
        let point = element.rect.ok_or("target has no bounds")?.center();
        if !native::monitors()?.iter().any(|r| r.contains(point)) {
            return Err("target is outside available monitors".into());
        }
        let mut s = self.state.lock().map_err(|_| "assist state poisoned")?;
        if s.status.session != session || s.status.phase != "active" {
            return Err("point cancelled".into());
        }
        s.revision += 1;
        s.clear_confirmation();
        let cursor = IntentCursor {
            revision: s.revision,
            element_id: element_id.into(),
            point,
        };
        s.status.cursor = Some(cursor.clone());
        Ok(cursor)
    }
    pub fn invoke(&self, session: u64, revision: u64) -> Result<Status> {
        self.act(session, revision, Action::Invoke {})
    }
    pub fn act(&self, session: u64, revision: u64, action: Action) -> Result<Status> {
        self.act_reviewed(session, revision, action, None)
    }
    pub fn act_reviewed(
        &self,
        session: u64,
        revision: u64,
        action: Action,
        policy: Option<crate::review::ReviewPolicy>,
    ) -> Result<Status> {
        if !self.permission {
            return Err("native actions require --enable-actions".into());
        }
        action.validate()?;
        let _serial = self.serial.lock().map_err(|_| "assist executor poisoned")?;
        let status = self.authorize(session, false)?;
        if status.mode == Mode::Guide {
            return Err("Guide mode cannot execute actions".into());
        }
        if status.confirmation.is_some() {
            return Err("an action already awaits explicit host confirmation".into());
        }
        if status.inspection_required {
            return Err("fresh inspection required".into());
        }
        let cursor = status
            .cursor
            .filter(|c| c.revision == revision)
            .ok_or("intent cursor is missing or superseded")?;
        let review = match policy {
            None => status.mode == Mode::Assist,
            Some(crate::review::ReviewPolicy::FullAccess) => false,
            Some(crate::review::ReviewPolicy::Auto) => true,
        };
        if review {
            let element = self.inspector.resolve_checked(&cursor.element_id, || {
                self.authorize(session, false).map(|_| ())
            })?;
            self.authorize(session, false)?;
            if matches!(policy, Some(crate::review::ReviewPolicy::Auto))
                && !crate::review::requires_confirmation(
                    &action,
                    &element.name,
                    &element.automation_id,
                    element.control_type,
                )
            {
                return self.execute_action(
                    session,
                    &cursor.element_id,
                    action,
                    Some(element.state()),
                );
            }
            let id = format!(
                "{:?}",
                unsafe { windows::Win32::System::Com::CoCreateGuid() }.map_err(|e| e.to_string())?
            );
            let confirmation = Confirmation {
                id,
                revision,
                element_id: cursor.element_id,
                target_name: element.name.clone(),
                action,
            };
            let mut s = self.state.lock().map_err(|_| "assist state poisoned")?;
            if s.status.session != session || s.status.phase != "active" {
                return Err("proposal cancelled".into());
            }
            s.pending = Some(Pending {
                confirmation: confirmation.clone(),
                expected: element.state(),
                created: Instant::now(),
            });
            s.status.confirmation = Some(confirmation);
            s.status.reason =
                "exact action awaits explicit host confirmation; no effect dispatched".into();
            return Ok(s.status.clone());
        }
        self.execute_action(session, &cursor.element_id, action, None)
    }
    pub fn confirm(&self, session: u64, confirmation_id: &str) -> Result<Status> {
        if !self.permission {
            return Err("native actions require --enable-actions".into());
        }
        let _serial = self.serial.lock().map_err(|_| "assist executor poisoned")?;
        let status = self.authorize(session, false)?;
        if status.mode == Mode::Guide || status.inspection_required {
            return Err("confirmation is unavailable; inspect again".into());
        }
        let pending = {
            let mut s = self.state.lock().map_err(|_| "assist state poisoned")?;
            let pending = s.pending.as_ref().ok_or("no action awaits confirmation")?;
            if pending.confirmation.id != confirmation_id
                || pending.created.elapsed() > Duration::from_secs(15)
            {
                return Err("confirmation is incorrect or expired".into());
            }
            let pending = s.pending.take().ok_or("confirmation consumed")?;
            s.status.confirmation = None;
            pending
        };
        self.execute_action(
            session,
            &pending.confirmation.element_id,
            pending.confirmation.action,
            Some(pending.expected),
        )
    }
    fn execute_action(
        &self,
        session: u64,
        element_id: &str,
        action: Action,
        expected: Option<ElementState>,
    ) -> Result<Status> {
        self.authorize(session, false)?;
        {
            let mut s = self.state.lock().map_err(|_| "assist state poisoned")?;
            if s.status.session != session || s.status.phase != "active" {
                return Err("invocation cancelled".into());
            }
            s.status.cursor = None;
            s.status.inspection_required = true;
            s.status.verification_pending = true;
            s.status.last_outcome = Some("unknown".into());
        }
        let foreground = native::foreground();
        let taskbar_activation = matches!(action, Action::Invoke {})
            && crate::desktop::is_shell_taskbar(windows::Win32::Foundation::HWND(
                self.status()?.hwnd as _,
            ));
        let result = self.inspector.act(element_id, action, expected, || {
            self.authorize(session, false).map(|_| ())
        });
        let mut s = self.state.lock().map_err(|_| "assist state poisoned")?;
        if let Ok(backend) = &result {
            s.status.actions += 1;
            s.status.last_backend = Some(backend.clone());
            s.status.last_outcome = Some("requested; inspect application state to verify".into());
            s.status.reason = "action requested; inspect application state to verify".into();
        }
        if let Err(error) = &result
            && s.status.phase == "active"
        {
            s.pause(&format!("{error}; inspect before explicitly resuming"));
        }
        if native::foreground() != foreground
            && native::foreground() != s.status.hwnd
            && s.status.phase == "active"
            && !taskbar_activation
        {
            s.pause("provider changed foreground focus; inspect before resuming");
        }
        drop(s);
        result.map_err(|e| {
            format!("{e}; action outcome may be unknown; do not retry without inspection")
        })?;
        self.status()
    }
    fn revoke(&self, reason: &str) -> Result<()> {
        self.state
            .lock()
            .map_err(|_| "assist state poisoned")?
            .revoke(reason);
        self.signals.shared_target.store(0, Ordering::SeqCst);
        self.inspector.cancel();
        Ok(())
    }
    pub fn stop(&self, reason: &str) -> Result<Status> {
        self.revoke(reason)?;
        let _serial = self.serial.lock().map_err(|_| "assist executor poisoned")?;
        self.status()
    }
    pub fn pause(&self) -> Result<Status> {
        {
            let mut s = self.state.lock().map_err(|_| "assist state poisoned")?;
            if !matches!(s.status.phase.as_str(), "active" | "paused") {
                return Err("no active session to pause".into());
            }
            s.pause("explicit pause; resume and inspect before acting");
        }
        self.inspector.cancel();
        let _serial = self.serial.lock().map_err(|_| "assist executor poisoned")?;
        self.status()
    }
    pub fn resume(&self, session: u64) -> Result<Status> {
        let _serial = self.serial.lock().map_err(|_| "assist executor poisoned")?;
        let status = self.authorize(session, true)?;
        if status.phase != "paused" {
            return Err("session is not paused".into());
        }
        let mut s = self.state.lock().map_err(|_| "assist state poisoned")?;
        s.status.phase = "active".into();
        s.status.reason = "resumed; fresh inspection required".into();
        s.status.cursor = None;
        s.status.inspection_required = true;
        s.activity = self.signals.target_activity.load(Ordering::SeqCst);
        Ok(s.status.clone())
    }
}
impl Drop for Assist {
    fn drop(&mut self) {
        let _ = self.stop("assist shutdown");
    }
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Begin {
        hwnd: isize,
        #[serde(default)]
        mode: Mode,
    },
    Inspect {
        session: u64,
    },
    Point {
        session: u64,
        element_id: String,
    },
    Invoke {
        session: u64,
        revision: u64,
    },
    Act {
        session: u64,
        revision: u64,
        action: Action,
    },
    Confirm {
        session: u64,
        confirmation_id: String,
    },
    Status,
    Pause,
    Resume {
        session: u64,
    },
    Stop,
    Shutdown,
}
#[derive(Deserialize)]
struct Envelope {
    id: Value,
    #[serde(flatten)]
    command: Command,
}

pub fn serve(assist: Arc<Assist>) {
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let busy = Arc::new(AtomicBool::new(false));
    let reply = |out: &Arc<Mutex<std::io::Stdout>>, id: Value, result: Result<Value>| {
        if let Ok(mut out) = out.lock() {
            let _ = writeln!(out, "{}", json!({"id":id,"result":result}));
            let _ = out.flush();
        }
    };
    std::thread::scope(|scope| {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        loop {
            let mut line = String::new();
            match input.by_ref().take(65537).read_line(&mut line) {
                Ok(0) | Err(_) => break,
                _ => {}
            }
            if line.len() > 65536 {
                reply(&output, Value::Null, Err("request exceeds 64 KiB".into()));
                break;
            }
            let value = match serde_json::from_str::<Value>(&line) {
                Ok(v) => v,
                Err(e) => {
                    reply(&output, Value::Null, Err(e.to_string()));
                    continue;
                }
            };
            let id = value.get("id").cloned().unwrap_or(Value::Null);
            let request = match serde_json::from_value::<Envelope>(value) {
                Ok(r) => r,
                Err(e) => {
                    reply(&output, id, Err(e.to_string()));
                    continue;
                }
            };
            let id = request.id;
            let result = match request.command {
                Command::Status => assist.status(),
                Command::Stop => assist.stop("explicit stop"),
                Command::Pause => assist.pause(),
                Command::Shutdown => {
                    reply(
                        &output,
                        id,
                        assist.stop("assist shutdown").map(|s| json!(s)),
                    );
                    break;
                }
                command => {
                    if busy.swap(true, Ordering::SeqCst) {
                        reply(
                            &output,
                            id,
                            Err("native operation busy; commands are sequential".into()),
                        );
                        continue;
                    }
                    let service = assist.clone();
                    let epoch = match service.status() {
                        Ok(s) => s.session,
                        Err(e) => {
                            busy.store(false, Ordering::SeqCst);
                            reply(&output, id, Err(e));
                            continue;
                        }
                    };
                    let out = output.clone();
                    let busy = busy.clone();
                    scope.spawn(move || {
                        let result = match command {
                            Command::Begin { hwnd, mode } => {
                                service.begin_at(hwnd, epoch, mode).map(|s| json!(s))
                            }
                            Command::Inspect { session } => {
                                service.inspect(session).map(|s| json!(s))
                            }
                            Command::Point {
                                session,
                                element_id,
                            } => service.point(session, &element_id).map(|s| json!(s)),
                            Command::Invoke { session, revision } => {
                                service.invoke(session, revision).map(|s| json!(s))
                            }
                            Command::Act {
                                session,
                                revision,
                                action,
                            } => service.act(session, revision, action).map(|s| json!(s)),
                            Command::Confirm {
                                session,
                                confirmation_id,
                            } => service.confirm(session, &confirmation_id).map(|s| json!(s)),
                            Command::Resume { session } => {
                                service.resume(session).map(|s| json!(s))
                            }
                            _ => unreachable!(),
                        };
                        busy.store(false, Ordering::SeqCst);
                        reply(&out, id, result);
                    });
                    continue;
                }
            };
            reply(&output, id, result.map(|s| json!(s)));
        }
        let _ = assist.stop("assist input closed");
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_revokes_queued_initialization_even_before_first_begin() {
        let mut state = State::default();
        let queued = state.status.session;
        state.revoke("stop before worker starts");
        assert_ne!(state.status.session, queued);
        let stopped = state.status.session;
        state.revoke("shutdown cleanup");
        assert_ne!(state.status.session, stopped);
        assert_eq!(state.status.reason, "stop before worker starts");
    }
    fn active() -> (State, Signals) {
        let mut state = State::default();
        state.status.session = 7;
        state.status.phase = "active".into();
        let signals = Signals::default();
        signals.observer_alive.store(true, Ordering::SeqCst);
        (state, signals)
    }
    #[test]
    fn guide_user_input_keeps_observation_active_but_invalidates_grounding() {
        let (mut state, signals) = active();
        state.status.mode = Mode::Guide;
        signals.target_activity.store(1, Ordering::SeqCst);
        state.observe_input(&signals, Instant::now());
        assert_eq!(state.status.phase, "active");
        assert_eq!(state.status.session, 7);
        assert!(state.status.inspection_required);
    }
    #[test]
    fn confirmation_expires_and_cannot_survive_pause_or_stop() {
        for event in ["expire", "pause", "stop"] {
            let (mut state, signals) = active();
            let confirmation = Confirmation {
                id: "test".into(),
                revision: 1,
                element_id: "e1".into(),
                target_name: "7".into(),
                action: Action::Invoke {},
            };
            let created = Instant::now();
            state.status.confirmation = Some(confirmation.clone());
            state.pending = Some(Pending {
                confirmation,
                expected: ElementState {
                    name: "7".into(),
                    value: None,
                    rect: None,
                    toggle_state: None,
                    selected: None,
                    horizontal_scroll_percent: None,
                    vertical_scroll_percent: None,
                },
                created,
            });
            match event {
                "expire" => {
                    let now = created + Duration::from_secs(16);
                    state.pulse_at = now;
                    state.observe_input(&signals, now);
                }
                "pause" => state.pause("pause"),
                _ => state.revoke("stop"),
            }
            assert!(state.pending.is_none());
            assert!(state.status.confirmation.is_none());
            assert!(state.status.inspection_required);
        }
    }
    #[test]
    fn unrelated_mouse_activity_does_not_cancel_background_work() {
        let (mut state, signals) = active();
        signals.manual.store(100, Ordering::SeqCst);
        state.observe_input(&signals, Instant::now());
        assert_eq!(state.status.phase, "active");
        assert_eq!(state.status.session, 7);
    }
    #[test]
    fn target_activity_pauses_without_discarding_session() {
        let (mut state, signals) = active();
        signals.target_activity.store(1, Ordering::SeqCst);
        state.observe_input(&signals, Instant::now());
        assert_eq!(state.status.phase, "paused");
        assert_eq!(state.status.session, 7);
        assert!(state.status.inspection_required);
        assert!(state.status.cursor.is_none());
    }
    #[test]
    fn escape_revokes_even_a_paused_session() {
        let (mut state, signals) = active();
        state.pause("user active");
        signals.emergency.store(true, Ordering::SeqCst);
        state.observe_input(&signals, Instant::now());
        assert_eq!(state.status.phase, "stopped");
        assert_ne!(state.status.session, 7);
    }
    #[test]
    fn observer_watchdog_is_independent_of_manual_input() {
        let (mut state, signals) = active();
        state.observe_input(&signals, state.pulse_at + Duration::from_millis(301));
        assert_eq!(state.status.phase, "stopped");
    }
    #[test]
    fn initialization_observes_emergency_and_observer_loss() {
        for emergency in [false, true] {
            let (mut state, signals) = active();
            state.status.phase = "initializing".into();
            signals.emergency.store(emergency, Ordering::SeqCst);
            signals.observer_alive.store(emergency, Ordering::SeqCst);
            state.observe_input(&signals, Instant::now());
            assert_eq!(state.status.phase, "stopped");
        }
    }
}
