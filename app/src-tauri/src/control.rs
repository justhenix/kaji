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
    time: f64,
}
impl PoseFilter {
    pub fn update(
        &mut self,
        now: f64,
        raw: Point,
        neutral: Option<Point>,
        dead_zone: f64,
    ) -> Point {
        let dt = (now - self.time).max(0.);
        let mut value = if let Some(previous) = self.value.filter(|_| dt <= 1000.) {
            let alpha = 1. - (-dt / 120.).exp();
            Point {
                x: previous.x + (raw.x - previous.x) * alpha,
                y: previous.y + (raw.y - previous.y) * alpha,
            }
        } else {
            raw
        };
        if let Some(neutral) = neutral {
            if (raw.x - neutral.x).abs() <= dead_zone {
                value.x = neutral.x;
            }
            if (raw.y - neutral.y).abs() <= dead_zone {
                value.y = neutral.y;
            }
        }
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
    filtered: Point,
    remainder: Point,
}
impl Motion {
    pub fn step(&mut self, pose: Point, neutral: Point, dt: f64, c: &Config) -> Point {
        let axis = |v: f64| {
            if v.abs() <= c.dead_zone {
                0.
            } else {
                v.signum()
                    * ((v.abs() - c.dead_zone) / (c.range - c.dead_zone))
                        .clamp(0., 1.)
                        .powf(1.8)
                    * c.max_speed
            }
        };
        let raw = Point {
            x: axis(neutral.x - pose.x),
            y: axis(pose.y - neutral.y),
        };
        let alpha = 1. - (-dt / 0.065).exp();
        self.filtered.x = if raw.x == 0. {
            0.
        } else {
            self.filtered.x + (raw.x - self.filtered.x) * alpha
        };
        self.filtered.y = if raw.y == 0. {
            0.
        } else {
            self.filtered.y + (raw.y - self.filtered.y) * alpha
        };
        self.remainder.x += self.filtered.x * dt;
        self.remainder.y += self.filtered.y * dt;
        let step = Point {
            x: self.remainder.x.trunc(),
            y: self.remainder.y.trunc(),
        };
        self.remainder.x -= step.x;
        self.remainder.y -= step.y;
        step
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
    fn raw_neutral_stops_pose_filter_without_a_smoothing_tail() {
        let mut filter = PoseFilter::default();
        filter.update(0., Point { x: 0.3, y: 0.3 }, None, 0.035);
        assert_eq!(
            filter.update(60., Point::default(), Some(Point::default()), 0.035),
            Point::default()
        );
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
                .map(|_| {
                    m.step(
                        Point { x: -0.16, y: 0. },
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
