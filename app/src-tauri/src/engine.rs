use crate::{
    Result,
    control::{Calibration, Config, Dwell, Frame, Motion, Point, PoseFilter},
    native::{self, Hooks, Rect, Signals},
};
use serde::Serialize;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize)]
pub struct Session {
    pub id: u64,
    pub now_ms: f64,
}
#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub phase: String,
    pub reason: String,
    pub session: u64,
    pub frames: u64,
    pub moves: u64,
    pub clicks: u64,
    pub last_click: Option<Point>,
    pub cursor: Option<Point>,
    pub now_ms: f64,
    pub faces: u8,
    pub operator_visible: bool,
    pub pose: Option<Point>,
    pub raw_pose: Option<Point>,
    pub neutral_pose: Option<Point>,
    pub calibration_samples: usize,
    pub operator_center: Option<Point>,
}
struct State {
    status: Status,
    pending: Option<Frame>,
    config: Config,
    neutral: Option<Point>,
    calibration: Calibration,
    motion: Motion,
    dwell: Dwell,
    sequence: u64,
    captured: f64,
    motion_at: f64,
    received: f64,
    started: f64,
    expected: Option<Point>,
    pending_destination: Option<(Point, f64)>,
    manual: u64,
    observer_pulse: u64,
    pulse_seen: f64,
    monitors: Vec<Rect>,
    last_environment: f64,
    target: Option<(isize, u32)>,
    operator: crate::face::Operator,
    operator_seen_ms: f64,
    pose_filter: PoseFilter,
}
impl State {
    fn stopped() -> Self {
        Self {
            status: Status {
                phase: "stopped".into(),
                reason: "input has not been armed".into(),
                session: 0,
                frames: 0,
                moves: 0,
                clicks: 0,
                last_click: None,
                cursor: None,
                now_ms: 0.,
                faces: 0,
                operator_visible: false,
                pose: None,
                raw_pose: None,
                neutral_pose: None,
                calibration_samples: 0,
                operator_center: None,
            },
            pending: None,
            config: Config::default(),
            neutral: None,
            calibration: Calibration::default(),
            motion: Motion::default(),
            dwell: Dwell::default(),
            sequence: 0,
            captured: 0.,
            motion_at: 0.,
            received: 0.,
            started: 0.,
            expected: None,
            pending_destination: None,
            manual: 0,
            observer_pulse: 0,
            pulse_seen: 0.,
            monitors: vec![],
            last_environment: 0.,
            target: None,
            operator: crate::face::Operator::default(),
            operator_seen_ms: 0.,
            pose_filter: PoseFilter::default(),
        }
    }
    fn running(&self) -> bool {
        self.status.session > 0
            && matches!(
                self.status.phase.as_str(),
                "initializing" | "no_face" | "calibrating" | "tracking"
            )
    }
    fn stop(&mut self, reason: &str) {
        if self.status.phase == "stopped" && self.status.session > 0 {
            return;
        }
        self.status.session = self.status.session.wrapping_add(1);
        self.status.phase = "stopped".into();
        self.status.reason = reason.into();
        self.pending = None;
        self.neutral = None;
        self.dwell = Dwell::default();
        self.motion = Motion::default();
    }
    fn accept(&mut self, frame: Frame, now: f64) -> Result<()> {
        if !self.running() || frame.session != self.status.session {
            return Err("session stopped or superseded".into());
        }
        let rejection =
            if !frame.captured_ms.is_finite() || !frame.yaw.is_finite() || !frame.pitch.is_finite()
            {
                Some("non-finite tracking sample")
            } else if frame.yaw.abs() > 1.5
                || frame.pitch.abs() > 1.5
                || frame.faces > 2
                || frame
                    .candidates
                    .as_ref()
                    .is_some_and(|c| c.len() > frame.faces as usize || c.iter().any(|f| !f.valid()))
            {
                Some("invalid tracking geometry or face count")
            } else if frame.captured_ms > now + 20. {
                Some("future capture timestamp")
            } else if frame.captured_ms < self.started {
                Some("capture predates session")
            } else if frame.sequence <= self.sequence || frame.captured_ms <= self.captured {
                Some("out-of-order tracking sample")
            } else if now - frame.captured_ms > 180. {
                Some("stale tracking sample")
            } else {
                None
            };
        if let Some(rejection) = rejection {
            self.stop(&format!("{rejection}: sequence={}, previous_sequence={}, capture_ms={:.3}, native_ms={now:.3}, age_ms={:.3}, session_start_ms={:.3}", frame.sequence, self.sequence, frame.captured_ms, now-frame.captured_ms, self.started));
            return Err(self.status.reason.clone());
        }
        self.sequence = frame.sequence;
        self.captured = frame.captured_ms;
        self.received = now;
        self.pending = Some(frame);
        Ok(())
    }
    fn observe(&mut self, frame: &Frame, current: Point) -> Result<Option<Point>> {
        let pose = if let Some(candidates) = &frame.candidates {
            self.operator
                .observe(candidates, frame.captured_ms)
                .map(|face| {
                    self.status.operator_center = Some(Point {
                        x: face.center_x,
                        y: face.center_y,
                    });
                    Point {
                        x: face.yaw,
                        y: face.pitch,
                    }
                })
        } else if frame.faces == 1 {
            Some(Point {
                x: frame.yaw,
                y: frame.pitch,
            })
        } else {
            None
        };
        self.status.faces = frame.faces;
        self.status.operator_visible = pose.is_some();
        self.status.pose = pose;
        self.status.raw_pose = pose;
        let Some(pose) = pose else {
            if self.neutral.is_some() && frame.candidates.is_none() {
                return Err("face lost or multiple faces detected; recalibrate".into());
            }
            if self.neutral.is_some() && frame.captured_ms - self.operator_seen_ms > 1000. {
                self.neutral = None;
                self.calibration = Calibration::default();
            }
            self.status.neutral_pose = self.neutral;
            self.status.calibration_samples = self.calibration.sample_count();
            self.motion = Motion::default();
            self.status.phase = "no_face".into();
            self.status.reason = "cursor disarmed; waiting for the same foreground operator".into();
            return Ok(None);
        };
        if self.neutral.is_some() && frame.captured_ms - self.operator_seen_ms > 1000. {
            self.neutral = None;
            self.calibration = Calibration::default();
        }
        self.operator_seen_ms = frame.captured_ms;
        let pose =
            self.pose_filter
                .update(frame.captured_ms, pose, self.neutral, self.config.dead_zone);
        self.status.pose = Some(pose);
        if self.neutral.is_none() {
            self.status.phase = "calibrating".into();
            self.status.reason =
                "collecting 20 stable neutral observations over at least one second".into();
            self.neutral = self.calibration.update(frame.captured_ms, pose.x, pose.y);
            self.status.calibration_samples = self.calibration.sample_count();
            self.status.neutral_pose = self.neutral;
            if self.neutral.is_some() {
                self.dwell = Dwell::require_departure(current, frame.captured_ms);
                self.status.phase = "tracking".into();
                self.status.reason = "native head control active".into();
            }
            return Ok(None);
        }
        self.status.phase = "tracking".into();
        self.status.reason = "native head control active".into();
        Ok(Some(pose))
    }
    fn advance_motion(&mut self, now: f64) -> Option<Point> {
        let dt = ((now - self.motion_at) / 1000.).clamp(0., 0.024);
        self.motion_at = now;
        if self.status.phase != "tracking" || now - self.captured > 180. {
            self.motion = Motion::default();
            return None;
        }
        Some(
            self.motion
                .step(self.status.pose?, self.neutral?, dt, &self.config),
        )
    }
}
struct Shared {
    state: Mutex<State>,
    signals: Arc<Signals>,
    shutdown: AtomicBool,
    origin: Instant,
    permission: bool,
}
pub struct Engine {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
    _hooks: Hooks,
    _input_lease: Option<native::InputLease>,
}
impl Engine {
    pub fn new(input_permission: bool) -> Result<Self> {
        native::dpi_aware();
        let input_lease = if input_permission {
            Some(native::InputLease::acquire()?)
        } else {
            None
        };
        let signals = Arc::new(Signals::default());
        let hooks = Hooks::start(signals.clone())?;
        let shared = Arc::new(Shared {
            state: Mutex::new(State::stopped()),
            signals,
            shutdown: AtomicBool::new(false),
            origin: Instant::now(),
            permission: input_permission,
        });
        let run = shared.clone();
        let worker = thread::Builder::new()
            .name("kaji-native-executor".into())
            .spawn(move || {
                native::dpi_aware();
                while !run.shutdown.load(Ordering::SeqCst) {
                    if let Ok(mut state) = run.state.lock() {
                        let now = run.origin.elapsed().as_secs_f64() * 1000.;
                        if state.running()
                            && let Err(reason) = tick(&run, &mut state, now)
                        {
                            state.stop(&reason);
                        }
                    } else {
                        run.signals.emergency.store(true, Ordering::SeqCst);
                        break;
                    }
                    thread::sleep(Duration::from_millis(8));
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            shared,
            worker: Some(worker),
            _hooks: hooks,
            _input_lease: input_lease,
        })
    }
    pub fn now_ms(&self) -> f64 {
        self.shared.origin.elapsed().as_secs_f64() * 1000.
    }
    pub fn sensor_initializing(&self) -> Result<()> {
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| "native executor state poisoned")?;
        if state.status.session != 0 {
            return Err("sensor initialization requires a new host".into());
        }
        state.status.phase = "initializing".into();
        state.status.reason =
            "opening camera and warming local inference; input is disarmed".into();
        state.manual = self.shared.signals.manual.load(Ordering::SeqCst);
        Ok(())
    }
    pub fn begin(&self, config: Config, target: Option<isize>) -> Result<Session> {
        self.begin_session(config, target, false)
    }
    pub fn begin_sensor(&self, config: Config, target: Option<isize>) -> Result<Session> {
        self.begin_session(config, target, true)
    }
    fn begin_session(
        &self,
        config: Config,
        target: Option<isize>,
        sensor: bool,
    ) -> Result<Session> {
        if !self.shared.permission {
            return Err("native input requires --enable-input at process startup".into());
        }
        config.validate()?;
        native::interactive_desktop()?;
        let list = native::monitors()?;
        let cursor = native::cursor()?;
        let target = target.map(|h| (h, native::window_pid(h)));
        if target.is_some_and(|(h, pid)| h == 0 || pid == 0) {
            return Err("target window no longer exists".into());
        }
        let mut s = self
            .shared
            .state
            .lock()
            .map_err(|_| "native executor state poisoned")?;
        if sensor
            && (s.status.session != 0
                || s.status.phase != "initializing"
                || self.shared.signals.emergency.load(Ordering::SeqCst)
                || self.shared.signals.manual.load(Ordering::SeqCst) != s.manual)
        {
            return Err("sensor initialization cancelled by native stop or manual input".into());
        }
        let id = s.status.session.wrapping_add(1);
        let now = self.now_ms();
        *s = State::stopped();
        s.config = config;
        s.monitors = list;
        s.target = target;
        s.started = now;
        s.received = now;
        s.motion_at = now;
        s.status.session = id;
        s.status.phase = "initializing".into();
        s.status.reason = "waiting for a fresh post-initialization camera frame".into();
        s.expected = Some(cursor);
        s.manual = self.shared.signals.manual.load(Ordering::SeqCst);
        s.observer_pulse = self.shared.signals.observer_pulse.load(Ordering::SeqCst);
        s.pulse_seen = now;
        self.shared.signals.emergency.store(false, Ordering::SeqCst);
        Ok(Session { id, now_ms: now })
    }
    pub fn submit(&self, frame: Frame) -> Result<()> {
        self.shared
            .state
            .lock()
            .map_err(|_| "native executor state poisoned")?
            .accept(frame, self.now_ms())
    }
    pub fn stop(&self, reason: &str) -> Result<Status> {
        self.shared.signals.emergency.store(true, Ordering::SeqCst);
        let mut s = self
            .shared
            .state
            .lock()
            .map_err(|_| "native executor state poisoned")?;
        s.stop(reason);
        s.status.now_ms = self.now_ms();
        Ok(s.status.clone())
    }
    pub fn status(&self) -> Result<Status> {
        let mut s = self
            .shared
            .state
            .lock()
            .map_err(|_| "native executor state poisoned")?;
        s.status.now_ms = self.now_ms();
        Ok(s.status.clone())
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.stop("engine shutdown");
        self.shared.shutdown.store(true, Ordering::SeqCst);
        if let Some(t) = self.worker.take() {
            let _ = t.join();
        }
    }
}
fn authorized(shared: &Shared, s: &State) -> Result<()> {
    if !shared.signals.observer_alive.load(Ordering::SeqCst) {
        return Err("native input observer unavailable".into());
    }
    if shared.signals.emergency.load(Ordering::SeqCst) {
        return Err("emergency stop (Escape or native stop)".into());
    }
    if shared.signals.manual.load(Ordering::SeqCst) != s.manual {
        return Err("manual takeover; explicit begin required".into());
    }
    Ok(())
}
fn tick(shared: &Shared, s: &mut State, now: f64) -> Result<()> {
    authorized(shared, s)?;
    let pulse = shared.signals.observer_pulse.load(Ordering::SeqCst);
    if pulse != s.observer_pulse {
        s.observer_pulse = pulse;
        s.pulse_seen = now;
    }
    if now - s.pulse_seen > 300. {
        return Err("native input observer heartbeat expired".into());
    }
    if now - s.received > 250. && s.sequence > 0 {
        return Err("tracking heartbeat expired".into());
    }
    if s.sequence == 0 && now - s.started > 15000. {
        return Err("camera startup timed out".into());
    }
    if now - s.last_environment >= 100. {
        native::interactive_desktop()?;
        if native::monitors()? != s.monitors {
            return Err("display topology changed; recalibrate".into());
        }
        if s.target
            .is_some_and(|(hwnd, pid)| native::window_pid(hwnd) != pid)
        {
            return Err("target window identity changed".into());
        }
        s.last_environment = now;
    }
    let current = native::cursor()?;
    s.status.cursor = Some(current);
    if let Some((destination, sent_at)) = s.pending_destination {
        if current.distance(destination) <= 2. {
            s.expected = Some(current);
            s.pending_destination = None;
        } else if now - sent_at > 80. {
            return Err("injected cursor movement was not observed".into());
        } else {
            return Ok(());
        }
    }
    if s.expected.is_some_and(|p| p.distance(current) > 3.) {
        return Err("cursor moved outside native executor; manual takeover".into());
    }
    if let Some(frame) = s.pending.take() {
        if now - frame.captured_ms > 200. {
            return Err("tracking sample expired before execution".into());
        }
        s.status.frames += 1;
        if s.observe(&frame, current)?.is_none() {
            s.motion_at = now;
            s.dwell.suspend(now);
            return Ok(());
        }
    }
    let Some(delta) = s.advance_motion(now) else {
        s.dwell.suspend(now);
        return Ok(());
    };
    if delta.x != 0. || delta.y != 0. {
        s.dwell.update_allowed(now, current, &s.config, false);
        let next = native::clamp_to_monitors(
            Point {
                x: current.x + delta.x,
                y: current.y + delta.y,
            },
            &s.monitors,
        )?;
        if next.distance(current) >= 1. {
            authorized(shared, s)?;
            native::move_to(next, &s.monitors)?;
            s.status.moves += 1;
            s.pending_destination = Some((next, now));
            return Ok(());
        }
        s.dwell.reset_progress(now, current, &s.config);
        return Ok(());
    }
    let actual = native::cursor()?;
    s.expected = Some(actual);
    s.status.cursor = Some(actual);
    if let Some((hwnd, pid)) = s.target {
        if native::window_pid(hwnd) != pid {
            return Err("dwell target window is stale".into());
        }
        if native::window_at(actual) != hwnd {
            s.dwell.reset_progress(now, actual, &s.config);
            return Ok(());
        }
    }
    if s.dwell.update(now, actual, &s.config) {
        authorized(shared, s)?;
        native::interactive_desktop()?;
        if native::modifiers_down() {
            return Err("physical button or modifier held; click refused".into());
        }
        if let Some((hwnd, pid)) = s.target {
            if native::window_pid(hwnd) != pid {
                return Err("dwell target window is stale".into());
            }
            if native::window_at(actual) != hwnd {
                s.dwell.reset_progress(now, actual, &s.config);
                return Ok(());
            }
        }
        authorized(shared, s)?;
        native::click()?;
        s.status.clicks += 1;
        s.status.last_click = Some(actual);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn moving() -> State {
        let mut s = active();
        s.status.phase = "tracking".into();
        s.neutral = Some(Point::default());
        s.status.pose = Some(Point { x: -0.2, y: 0. });
        s.captured = 1000.;
        s.motion_at = 1000.;
        s
    }
    #[test]
    fn native_ticks_smooth_motion_between_camera_observations() {
        let mut s = moving();
        let steps: Vec<_> = (1..=7)
            .map(|i| s.advance_motion(1000. + i as f64 * 8.).unwrap().x)
            .collect();
        assert!(steps.iter().filter(|x| **x > 0.).count() >= 4);
        assert!(steps.iter().all(|x| *x <= s.config.max_speed * 0.008 + 1.));
        assert!(steps.iter().sum::<f64>() > 0.);
    }
    #[test]
    fn interpolation_never_extends_the_fresh_pose_lifetime() {
        let mut s = moving();
        assert!(s.advance_motion(1180.).is_some());
        assert!(s.advance_motion(1180.001).is_none());
        s.stop("cancelled");
        assert!(s.advance_motion(1181.).is_none());
    }
    #[test]
    fn neutral_pose_stops_without_coasting() {
        let mut s = moving();
        for i in 1..=7 {
            s.advance_motion(1000. + i as f64 * 8.);
        }
        s.status.pose = Some(Point::default());
        assert_eq!(s.advance_motion(1064.), Some(Point::default()));
    }
    #[test]
    fn late_sensor_shutdown_preserves_the_original_native_stop_reason() {
        let mut s = active();
        s.stop("manual takeover");
        let session = s.status.session;
        s.stop("sensor: session stopped or superseded");
        assert_eq!(s.status.reason, "manual takeover");
        assert_eq!(s.status.session, session);
    }
    fn face() -> crate::face::Face {
        crate::face::Face {
            yaw: 0.,
            pitch: 0.4,
            center_x: 0.5,
            center_y: 0.5,
            eye_span: 0.2,
        }
    }
    fn painting() -> crate::face::Face {
        crate::face::Face {
            center_x: 0.15,
            center_y: 0.25,
            eye_span: 0.055,
            ..face()
        }
    }
    fn live_observation(
        s: &mut State,
        sequence: u64,
        captured_ms: f64,
        candidates: Vec<crate::face::Face>,
    ) -> Result<Option<Point>> {
        let f = Frame {
            session: 7,
            sequence,
            captured_ms,
            faces: candidates.len() as u8,
            candidates: Some(candidates),
            ..frame()
        };
        s.accept(f.clone(), captured_ms + 5.)?;
        s.pending = None;
        s.observe(&f, Point::default())
    }
    #[test]
    fn startup_no_face_first_valid_frame_and_calibration_are_distinct() {
        let mut s = active();
        s.status.phase = "initializing".into();
        assert!(live_observation(&mut s, 1, 10., vec![]).unwrap().is_none());
        assert_eq!(s.status.phase, "no_face");
        assert!(s.neutral.is_none());
        for i in 0..26 {
            assert!(
                live_observation(
                    &mut s,
                    i + 2,
                    50. + i as f64 * 40.,
                    vec![face(), painting()]
                )
                .unwrap()
                .is_none()
            );
        }
        assert_eq!(s.status.phase, "tracking");
        assert!(s.status.operator_visible);
        assert_eq!(s.status.faces, 2);
    }
    #[test]
    fn operator_loss_disarms_and_recovers_without_adopting_background() {
        let mut s = active();
        for i in 0..26 {
            live_observation(
                &mut s,
                i + 1,
                10. + i as f64 * 40.,
                vec![face(), painting()],
            )
            .unwrap();
        }
        assert!(s.neutral.is_some());
        for i in 0..30 {
            assert!(
                live_observation(&mut s, i + 27, 1050. + i as f64 * 40., vec![painting()])
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(s.status.phase, "no_face");
        assert!(s.neutral.is_none());
        for i in 0..26 {
            assert!(
                live_observation(
                    &mut s,
                    i + 57,
                    2250. + i as f64 * 40.,
                    vec![face(), painting()]
                )
                .unwrap()
                .is_none()
            );
        }
        assert_eq!(s.status.phase, "tracking");
        assert!(!s.dwell.update(3400., Point::default(), &s.config));
        assert_eq!(s.status.moves, 0);
        assert_eq!(s.status.clicks, 0);
    }
    #[test]
    fn brief_operator_loss_pauses_motion_without_erasing_neutral() {
        let mut s = active();
        for i in 0..26 {
            live_observation(
                &mut s,
                i + 1,
                10. + i as f64 * 40.,
                vec![face(), painting()],
            )
            .unwrap();
        }
        let neutral = s.neutral.unwrap();
        assert!(
            live_observation(&mut s, 27, 1050., vec![])
                .unwrap()
                .is_none()
        );
        assert_eq!(s.neutral, Some(neutral));
        assert!(s.advance_motion(1055.).is_none());
        let turned = crate::face::Face {
            yaw: 0.12,
            ..face()
        };
        assert!(
            live_observation(&mut s, 28, 1110., vec![turned, painting()])
                .unwrap()
                .is_some()
        );
        assert_eq!(s.neutral, Some(neutral));
        assert_eq!(s.status.phase, "tracking");
    }
    #[test]
    fn first_delayed_frame_is_still_rejected_and_cannot_refresh_a_watchdog() {
        let mut s = active();
        assert!(
            s.accept(frame(), 220.)
                .unwrap_err()
                .contains("stale tracking sample")
        );
        assert_eq!(s.received, 0.);
        assert!(s.pending.is_none());
        assert!(!s.running());
    }
    #[test]
    fn exact_frame_age_boundary_is_unchanged() {
        let mut s = active();
        s.accept(frame(), 190.).unwrap();
        let mut s = active();
        assert!(s.accept(frame(), 190.001).is_err());
    }
    #[test]
    fn malformed_operator_geometry_is_never_used() {
        let mut s = active();
        assert!(
            live_observation(
                &mut s,
                1,
                10.,
                vec![crate::face::Face {
                    eye_span: f64::NAN,
                    ..face()
                }]
            )
            .is_err()
        );
        assert!(!s.running());
        assert!(s.neutral.is_none());
    }
    fn active() -> State {
        let mut s = State::stopped();
        s.status.phase = "calibrating".into();
        s.status.session = 7;
        s.started = 1.;
        s
    }
    fn frame() -> Frame {
        Frame {
            session: 7,
            sequence: 1,
            captured_ms: 10.,
            yaw: 0.,
            pitch: 0.,
            faces: 1,
            candidates: None,
        }
    }
    #[test]
    fn old_session_cannot_execute_after_stop() {
        let mut s = active();
        s.stop("test");
        assert!(s.accept(frame(), 20.).is_err());
    }
    #[test]
    fn reordered_frames_stop_instead_of_teleporting() {
        let mut s = active();
        s.accept(frame(), 20.).unwrap();
        assert!(s.accept(frame(), 25.).is_err());
        assert!(!s.running());
    }
    #[test]
    fn stale_nan_and_future_samples_fail_closed() {
        for f in [
            Frame {
                captured_ms: -500.,
                ..frame()
            },
            Frame {
                yaw: f64::NAN,
                ..frame()
            },
            Frame {
                captured_ms: 999.,
                ..frame()
            },
        ] {
            let mut s = active();
            assert!(s.accept(f, 20.).is_err());
            assert!(!s.running());
        }
    }
    #[test]
    fn mailbox_keeps_only_latest_sample() {
        let mut s = active();
        s.accept(frame(), 20.).unwrap();
        s.accept(
            Frame {
                sequence: 2,
                captured_ms: 25.,
                ..frame()
            },
            30.,
        )
        .unwrap();
        assert_eq!(s.pending.unwrap().sequence, 2);
    }
    #[test]
    fn emergency_is_independent_of_tracking_queue() {
        let shared = Shared {
            state: Mutex::new(active()),
            signals: Arc::new(Signals::default()),
            shutdown: AtomicBool::new(false),
            origin: Instant::now(),
            permission: true,
        };
        shared.signals.emergency.store(true, Ordering::SeqCst);
        shared.signals.observer_alive.store(true, Ordering::SeqCst);
        assert!(authorized(&shared, &active()).is_err());
    }
}
