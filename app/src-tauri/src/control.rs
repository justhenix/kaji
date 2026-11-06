use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
impl Point {
    pub fn distance(self, other: Self) -> f64 {
        (self.x - other.x).hypot(self.y - other.y)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub session: u64,
    pub sequence: u64,
    pub captured_ms: f64,
    pub yaw: f64,
    pub pitch: f64,
    pub faces: u8,
    #[serde(default)]
    pub candidates: Option<Vec<crate::face::Face>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub dwell_ms: u64,
    pub dwell_radius: f64,
    pub max_speed: f64,
    pub dead_zone: f64,
    pub range: f64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            dwell_ms: 1200,
            dwell_radius: 9.,
            max_speed: 1100.,
            dead_zone: 0.035,
            range: 0.28,
        }
    }
}
impl Config {
    pub fn validate(&self) -> crate::Result<()> {
        if !(500..=5000).contains(&self.dwell_ms)
            || !self.dwell_radius.is_finite()
            || !(3. ..=30.).contains(&self.dwell_radius)
            || !self.max_speed.is_finite()
            || !(100. ..=2500.).contains(&self.max_speed)
            || !self.dead_zone.is_finite()
            || !(0.01..=0.12).contains(&self.dead_zone)
            || !self.range.is_finite()
            || !(0.15..=0.6).contains(&self.range)
            || self.range <= self.dead_zone
        {
            return Err("invalid head control configuration".into());
        }
        Ok(())
    }
}

#[derive(Default, Debug)]
pub struct PoseFilter {
    value: Option<Point>,
    raw: Option<Point>,
    derivative: Point,
    samples: Vec<Point>,
    time: f64,
}
impl PoseFilter {
    pub fn update(
        &mut self,
        now: f64,
        raw: Point,
        neutral: Option<Point>,
        _dead_zone: f64,
    ) -> Point {
        let dt = (now - self.time).max(0.);
        if dt > 1000. {
            self.samples.clear();
            self.raw = None;
            self.derivative = Point::default();
        }
        self.samples.push(raw);
        if self.samples.len() > 3 {
            self.samples.remove(0);
        }
        let median = |axis: fn(&Point) -> f64| {
            let mut values: Vec<_> = self.samples.iter().map(axis).collect();
            values.sort_by(f64::total_cmp);
            if values.len() == 2 {
                (values[0] + values[1]) / 2.
            } else {
                values[values.len() / 2]
            }
        };
        let raw = Point {
            x: median(|p| p.x),
            y: median(|p| p.y),
        };
        let value = if let Some(previous) = self.value.filter(|_| dt <= 1000.) {
            let seconds = dt / 1000.;
            let alpha =
                |cutoff: f64| seconds / (seconds + 1. / (2. * std::f64::consts::PI * cutoff));
            if let Some(last) = self.raw
                && seconds > 0.
            {
                let a = alpha(1.);
                self.derivative.x += ((raw.x - last.x) / seconds - self.derivative.x) * a;
                self.derivative.y += ((raw.y - last.y) / seconds - self.derivative.y) * a;
            }
            let smooth = |value: f64, previous: f64, speed: f64| {
                let a = if neutral.is_some() {
                    alpha(0.8 + speed.abs())
                } else {
                    1. - (-dt / 120.).exp()
                };
                previous + (value - previous) * a
            };
            Point {
                x: smooth(raw.x, previous.x, self.derivative.x),
                y: smooth(raw.y, previous.y, self.derivative.y),
            }
        } else {
            raw
        };
        self.raw = Some(raw);
        self.value = Some(value);
        self.time = now;
        value
    }
}

#[derive(Default, Debug)]
pub struct Calibration {
    samples: Vec<(f64, f64, f64)>,
}
impl Calibration {
    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }
    pub fn update(&mut self, now: f64, yaw: f64, pitch: f64) -> Option<Point> {
        if self
            .samples
            .last()
            .is_some_and(|s| now - s.0 > 1000. || now <= s.0)
        {
            self.samples.clear();
        }
        self.samples.retain(|s| now - s.0 <= 1500.);
        self.samples.push((now, yaw, pitch));
        // The window must still span one second at the executor's maximum observation rate.
        if self.samples.len() > 256 {
            self.samples.remove(0);
        }
        if self.samples.len() < 20 || now - self.samples[0].0 < 1000. {
            return None;
        }
        let mut xs: Vec<_> = self.samples.iter().map(|s| s.1).collect();
        let mut ys: Vec<_> = self.samples.iter().map(|s| s.2).collect();
        xs.sort_by(f64::total_cmp);
        ys.sort_by(f64::total_cmp);
        let neutral = Point {
            x: xs[xs.len() / 2],
            y: ys[ys.len() / 2],
        };
        let stable =
            |x: f64, y: f64| (x - neutral.x).abs() <= 0.025 && (y - neutral.y).abs() <= 0.025;
        let inliers: Vec<_> = self.samples.iter().filter(|s| stable(s.1, s.2)).collect();
        if inliers.len() < 20
            || inliers.len() * 5 < self.samples.len() * 4
            || now - inliers[0].0 < 1000.
            || !stable(yaw, pitch)
        {
            return None;
        }
        Some(neutral)
    }
}

#[derive(Default, Debug)]
pub struct Motion {
    anchor: Option<Point>,
    pending: Point,
    remainder: Point,
}
impl Motion {
    pub fn step(&mut self, pose: Point, _neutral: Point, dt: f64, c: &Config) -> Point {
        if !dt.is_finite() || dt <= 0. {
            return Point::default();
        }
        let Some(anchor) = self.anchor.as_mut() else {
            self.anchor = Some(pose);
            return Point::default();
        };
        // Head displacement, rather than held tilt, drives the pointer. A still head never cruises.
        let gain = c.max_speed / c.range;
        let noise = 2. / gain * (c.dead_zone / 0.035);
        let alpha = 1. - (-dt.max(0.) / 0.016).exp();
        let advance = |value: f64, anchor: &mut f64, direction: f64| {
            let delta = value - *anchor;
            if delta.abs() > noise {
                let movement = delta - noise.copysign(delta);
                *anchor += movement;
                movement * gain * direction
            } else {
                0.
            }
        };
        self.pending.x += advance(pose.x, &mut anchor.x, -1.);
        self.pending.y += advance(pose.y, &mut anchor.y, 1.);
        // Discard excess motion debt: a tracking spike must not turn into a long cursor chase.
        let pending_distance = self.pending.x.hypot(self.pending.y);
        let pending_limit = c.max_speed * 0.060;
        if pending_distance > pending_limit {
            self.pending.x *= pending_limit / pending_distance;
            self.pending.y *= pending_limit / pending_distance;
        }
        let distance = pending_distance.min(pending_limit) * alpha;
        let fraction = if distance > 0. {
            (c.max_speed * dt.max(0.) / distance).min(1.) * alpha
        } else {
            0.
        };
        let step = |pending: &mut f64, remainder: &mut f64| {
            let movement = if pending.abs() < 0.01 {
                *pending
            } else {
                *pending * fraction
            };
            *pending -= movement;
            *remainder += movement;
            let step = remainder.trunc();
            *remainder -= step;
            step
        };
        Point {
            x: step(&mut self.pending.x, &mut self.remainder.x),
            y: step(&mut self.pending.y, &mut self.remainder.y),
        }
    }
}

#[derive(Debug, Default)]
pub struct Dwell {
    anchor: Option<Point>,
    since: f64,
    last: f64,
    clicked: bool,
}
impl Dwell {
    pub fn require_departure(actual: Point, now: f64) -> Self {
        Self {
            anchor: Some(actual),
            since: now,
            last: now,
            clicked: true,
        }
    }
    pub fn update(&mut self, now: f64, actual: Point, config: &Config) -> bool {
        self.update_allowed(now, actual, config, true)
    }
    pub fn progress(&self, config: &Config) -> f64 {
        if !self.armed() {
            return 0.;
        }
        ((self.last - self.since) / config.dwell_ms.max(1) as f64).clamp(0., 1.)
    }
    pub fn armed(&self) -> bool {
        !self.clicked && self.anchor.is_some()
    }
    pub fn suspend(&mut self, now: f64) {
        self.since += (now - self.last).max(0.);
        self.last = now;
    }
    pub fn reset_progress(&mut self, now: f64, actual: Point, config: &Config) {
        self.update_allowed(now, actual, config, false);
        self.since = now;
    }
    pub fn update_allowed(
        &mut self,
        now: f64,
        actual: Point,
        config: &Config,
        allow_click: bool,
    ) -> bool {
        let gap = now - self.last;
        self.last = now;
        if self.anchor.is_none() {
            self.anchor = Some(actual);
            self.since = now;
            self.clicked = false;
            return false;
        }
        let distance = self.anchor.unwrap().distance(actual);
        if distance
            > if self.clicked {
                config.dwell_radius * 2.
            } else {
                config.dwell_radius
            }
        {
            self.anchor = Some(actual);
            self.since = now;
            self.clicked = false;
            return false;
        }
        if !(0. ..=200.).contains(&gap) {
            self.since = now;
            return false;
        }
        if allow_click && !self.clicked && now - self.since >= config.dwell_ms as f64 {
            self.clicked = true;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "replays a private local tracking measurement; never controls the desktop"]
    fn measured_trace_motion_is_bounded() {
        let path = std::env::var("KAJI_HEAD_MEASUREMENT").expect("set KAJI_HEAD_MEASUREMENT");
        let data: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let frames = data["samples"].as_array().unwrap();
        let c = Config::default();
        let mut filter = PoseFilter::default();
        let mut calibration = Calibration::default();
        let mut motion = Motion::default();
        let mut dwell = Dwell::default();
        let mut neutral = None;
        let mut pose = Point::default();
        let mut cursor = Point::default();
        let mut next = 0;
        let mut positions = Vec::new();
        let mut max_step: f64 = 0.;
        let mut clicks = 0;
        for tick in 0..1250 {
            let now = tick as f64 * 8.;
            while next < frames.len() && frames[next]["ms"].as_f64().unwrap() <= now {
                let f = &frames[next];
                next += 1;
                if f["faces"] != 1 || f["candidates"].as_array().unwrap().len() != 1 {
                    continue;
                }
                let p = &f["candidates"][0];
                pose = filter.update(
                    f["ms"].as_f64().unwrap(),
                    Point {
                        x: p["center_x"].as_f64().unwrap(),
                        y: p["center_y"].as_f64().unwrap(),
                    },
                    neutral,
                    c.dead_zone,
                );
                if neutral.is_none() {
                    neutral = calibration.update(now, pose.x, pose.y);
                }
            }
            if let Some(neutral) = neutral {
                let delta = motion.step(pose, neutral, 0.008, &c);
                max_step = max_step.max(delta.x.hypot(delta.y));
                cursor.x += delta.x;
                cursor.y += delta.y;
                if dwell.update_allowed(now, cursor, &c, delta == Point::default()) {
                    clicks += 1;
                }
                if now > 3000. {
                    positions.push(cursor);
                }
            }
        }
        assert!(positions.len() > 100, "measurement never calibrated");
        let span = |axis: fn(&Point) -> f64| {
            let mut values: Vec<_> = positions.iter().map(axis).collect();
            values.sort_by(f64::total_cmp);
            values[values.len() * 95 / 100] - values[values.len() * 5 / 100]
        };
        println!(
            "measurement: max_step_px={max_step:.2}, p90_width_px={:.2}, p90_height_px={:.2}, still_dwells={clicks}",
            span(|p| p.x),
            span(|p| p.y)
        );
        assert!(max_step <= c.max_speed * 0.008 + 1.5);
        assert!(
            clicks > 0,
            "the still-head recording never reached a stable dwell"
        );
    }
    #[test]
    fn a_tracking_jump_is_speed_limited_and_cannot_leave_a_long_motion_tail() {
        let c = Config::default();
        let mut motion = Motion::default();
        motion.step(Point::default(), Point::default(), 0.008, &c);
        let pose = Point { x: 1., y: 1. };
        let mut total = 0.;
        for _ in 0..40 {
            let delta = motion.step(pose, Point::default(), 0.008, &c);
            let distance = delta.x.hypot(delta.y);
            assert!(distance <= c.max_speed * 0.008 + 1.5);
            total += distance;
        }
        assert!(total <= c.max_speed * 0.060 + 2.);
        assert_eq!(
            motion.step(pose, Point::default(), 0.008, &c),
            Point::default()
        );
    }
    #[test]
    fn isolated_landmark_spikes_do_not_move_the_filtered_pose() {
        let mut filter = PoseFilter::default();
        let neutral = Point::default();
        for i in 0..100 {
            let raw = if i == 50 {
                Point { x: 0.2, y: -0.15 }
            } else {
                neutral
            };
            let filtered = filter.update(i as f64 * 32., raw, Some(neutral), 0.035);
            assert_eq!(filtered, neutral);
        }
    }
    #[test]
    fn calibration_completes_at_supported_camera_rates() {
        for fps in [15, 30, 60] {
            let mut calibration = Calibration::default();
            let mut completed = None;
            for i in 0..fps * 3 {
                let now = i as f64 * 1000. / fps as f64;
                completed = calibration.update(now, 0., 0.).or(completed);
            }
            assert_eq!(
                completed,
                Some(Point::default()),
                "{fps} FPS never calibrated"
            );
        }
    }
    #[test]
    fn continuous_departure_and_return_arms_the_first_dwell() {
        let c = Config::default();
        let mut d = Dwell::require_departure(Point::default(), 0.);
        for i in 1..=6 {
            assert!(!d.update_allowed(
                i as f64 * 40.,
                Point {
                    x: i as f64 * 5.,
                    y: 0.
                },
                &c,
                false
            ));
        }
        d.update_allowed(280., Point::default(), &c, false);
        let clicks = (1..=35)
            .filter(|i| d.update(280. + *i as f64 * 40., Point::default(), &c))
            .count();
        assert_eq!(clicks, 1);
    }
    #[test]
    fn missing_operator_time_never_counts_towards_dwell() {
        let c = Config::default();
        let mut d = Dwell::default();
        for i in 0..=20 {
            assert!(!d.update(i as f64 * 40., Point::default(), &c));
        }
        for i in 21..=30 {
            d.suspend(i as f64 * 40.);
        }
        for i in 31..40 {
            assert!(!d.update(i as f64 * 40., Point::default(), &c));
        }
        assert!(d.update(1600., Point::default(), &c));
        d.suspend(1640.);
        assert!(!d.update(1680., Point::default(), &c));
    }
    #[test]
    fn noisy_landmarks_are_filtered_before_calibration() {
        let mut filter = PoseFilter::default();
        let mut calibration = Calibration::default();
        let mut neutral = None;
        for i in 0..50 {
            let raw = Point {
                x: if i % 2 == 0 { 0.04 } else { -0.04 },
                y: 0.,
            };
            let pose = filter.update(i as f64 * 60., raw, None, 0.035);
            neutral = calibration
                .update(i as f64 * 60., pose.x, pose.y)
                .or(neutral);
        }
        assert!(neutral.is_some());
        assert!(neutral.unwrap().x.abs() < 0.025);
    }
    #[test]
    fn crossing_neutral_does_not_snap_the_head_pose() {
        let mut filter = PoseFilter::default();
        filter.update(0., Point { x: 0.3, y: 0.3 }, None, 0.035);
        let pose = filter.update(60., Point::default(), Some(Point::default()), 0.035);
        assert!(pose.x > 0. && pose.x < 0.3);
    }
    #[test]
    fn initial_tracking_requires_deliberate_departure() {
        let c = Config::default();
        let p = Point::default();
        let mut dwell = Dwell::require_departure(p, 0.);
        for i in 1..100 {
            assert!(!dwell.update(i as f64 * 40., p, &c));
        }
        let moved = Point { x: 25., y: 0. };
        dwell.update(4000., moved, &c);
        let clicks = (1..40)
            .filter(|i| dwell.update(4000. + *i as f64 * 40., moved, &c))
            .count();
        assert_eq!(clicks, 1);
    }
    #[test]
    fn frame_gap_does_not_rearm_a_completed_dwell() {
        let c = Config::default();
        let p = Point::default();
        let mut dwell = Dwell::default();
        for i in 0..40 {
            dwell.update(i as f64 * 40., p, &c);
        }
        assert!(!dwell.update(1800., p, &c));
        for i in 1..100 {
            assert!(!dwell.update(1800. + i as f64 * 40., p, &c));
        }
    }
    #[test]
    fn slow_drift_is_not_a_dwell() {
        let mut d = Dwell::default();
        let c = Config::default();
        for i in 0..200 {
            assert!(!d.update(i as f64 * 40., Point { x: i as f64, y: 0. }, &c));
        }
    }
    #[test]
    fn one_click_until_deliberate_departure() {
        let mut d = Dwell::default();
        let c = Config::default();
        let mut clicks = 0;
        for i in 0..200 {
            if d.update(i as f64 * 40., Point::default(), &c) {
                clicks += 1;
            }
        }
        assert_eq!(clicks, 1);
        d.update(8000., Point { x: 30., y: 0. }, &c);
        for i in 1..40 {
            if d.update(8000. + i as f64 * 40., Point { x: 30., y: 0. }, &c) {
                clicks += 1;
            }
        }
        assert_eq!(clicks, 2);
    }
    #[test]
    fn no_click_after_missing_frames() {
        let mut d = Dwell::default();
        let c = Config::default();
        d.update(0., Point::default(), &c);
        assert!(!d.update(1300., Point::default(), &c));
    }
    #[test]
    fn time_based_motion_matches_camera_rates() {
        let distance = |fps: u32| {
            let mut m = Motion::default();
            (0..fps * 3)
                .map(|i| {
                    m.step(
                        Point {
                            x: -0.16 * i as f64 / (fps * 3 - 1) as f64,
                            y: 0.,
                        },
                        Point::default(),
                        1. / fps as f64,
                        &Config::default(),
                    )
                    .x
                })
                .sum::<f64>()
        };
        assert!((distance(15) - distance(60)).abs() < 25.);
    }
    #[test]
    fn held_off_center_pose_and_small_tremor_do_not_drift() {
        let c = Config::default();
        let mut motion = Motion::default();
        motion.step(Point::default(), Point::default(), 0.008, &c);
        let aimed = Point { x: -0.12, y: 0.06 };
        let first = motion.step(aimed, Point::default(), 0.008, &c);
        assert!(first.x > 0. && first.x.hypot(first.y) <= c.max_speed * 0.008 + 1.5);
        for _ in 0..24 {
            motion.step(aimed, Point::default(), 0.008, &c);
        }
        for _ in 0..1500 {
            assert_eq!(
                motion.step(aimed, Point::default(), 0.008, &c),
                Point::default()
            );
        }
        let mut still = Motion::default();
        still.step(aimed, Point::default(), 0.008, &c);
        for i in 0..1500 {
            let pose = Point {
                x: aimed.x + if i % 2 == 0 { 0.0005 } else { -0.0005 },
                y: aimed.y,
            };
            assert_eq!(
                still.step(pose, Point::default(), 0.008, &c),
                Point::default()
            );
        }
    }
    #[test]
    fn filtered_camera_tremor_still_allows_one_stable_dwell() {
        let c = Config::default();
        let mut filter = PoseFilter::default();
        let mut motion = Motion::default();
        let mut dwell = Dwell::default();
        let neutral = Point::default();
        let mut pose = filter.update(0., neutral, Some(neutral), c.dead_zone);
        let mut cursor = Point { x: 100., y: 100. };
        let mut clicks = 0;
        for i in 0..400 {
            let now = i as f64 * 8.;
            if i % 4 == 0 {
                let raw = Point {
                    x: if i % 8 == 0 { 0.02 } else { -0.02 },
                    y: 0.,
                };
                pose = filter.update(now, raw, Some(neutral), c.dead_zone);
            }
            let delta = motion.step(pose, neutral, 0.008, &c);
            cursor.x += delta.x;
            cursor.y += delta.y;
            if dwell.update(now, cursor, &c) {
                clicks += 1;
            }
        }
        assert_eq!(clicks, 1);
    }
    #[test]
    fn calibration_requires_stable_time_window() {
        let mut c = Calibration::default();
        for i in 0..25 {
            assert!(c.update(i as f64 * 40., 0., 0.).is_none());
        }
        assert_eq!(c.update(1000., 0., 0.), Some(Point::default()));
    }
    #[test]
    fn calibration_can_bridge_one_missing_camera_frame_but_not_a_long_gap() {
        let mut c = Calibration::default();
        for i in 0..25 {
            assert!(c.update(i as f64 * 40., 0., 0.).is_none());
        }
        assert_eq!(c.update(1080., 0., 0.), Some(Point::default()));
        assert!(c.update(2200., 0., 0.).is_none());
        assert_eq!(c.sample_count(), 1);
    }
    #[test]
    fn calibration_rejects_isolated_spikes_without_discarding_stable_samples() {
        let mut c = Calibration::default();
        let mut calibrated = None;
        for i in 0..32 {
            let x = if i % 8 == 3 { 0.2 } else { 0. };
            calibrated = c.update(i as f64 * 50., x, 0.).or(calibrated);
        }
        assert_eq!(calibrated, Some(Point::default()));
    }
    #[test]
    fn moving_head_does_not_create_a_stable_calibration() {
        let mut c = Calibration::default();
        for i in 0..100 {
            assert!(c.update(i as f64 * 50., i as f64 * 0.01, 0.).is_none());
        }
    }
    #[test]
    fn invalid_config_is_rejected() {
        let c = Config {
            dead_zone: f64::NAN,
            ..Config::default()
        };
        assert!(c.validate().is_err());
    }
}
