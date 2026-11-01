use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Face {
    pub yaw: f64,
    pub pitch: f64,
    pub center_x: f64,
    pub center_y: f64,
    pub eye_span: f64,
}
impl Face {
    pub fn valid(&self) -> bool {
        [
            self.yaw,
            self.pitch,
            self.center_x,
            self.center_y,
            self.eye_span,
        ]
        .iter()
        .all(|v| v.is_finite())
            && self.yaw.abs() <= 1.5
            && self.pitch.abs() <= 1.5
            && (0. ..=1.).contains(&self.center_x)
            && (0. ..=1.).contains(&self.center_y)
            && (0.04..=0.65).contains(&self.eye_span)
    }
    fn distance(&self, other: &Self) -> f64 {
        (self.center_x - other.center_x).hypot(self.center_y - other.center_y)
    }
}

#[derive(Default)]
pub struct Operator {
    locked: Option<Face>,
    reference_span: f64,
    last_seen_ms: f64,
    backgrounds: Vec<Face>,
}
impl Operator {
    fn same_background(a: &Face, b: &Face) -> bool {
        a.distance(b) < b.eye_span * 0.5
            && a.eye_span >= b.eye_span * 0.75
            && a.eye_span <= b.eye_span * 1.33
    }
    pub fn observe(&mut self, candidates: &[Face], captured_ms: f64) -> Option<Face> {
        let selected = if let Some(previous) = self.locked {
            let gap = (captured_ms - self.last_seen_ms).max(0.) / 1000.;
            let radius = self.reference_span * (0.75 + gap * 3.).min(2.5);
            let mut matches = candidates.iter().filter(|face| {
                face.eye_span >= self.reference_span * 0.65
                    && face.eye_span <= self.reference_span * 1.6
                    && face.distance(&previous) <= radius
                    && !self
                        .backgrounds
                        .iter()
                        .any(|background| Self::same_background(face, background))
            });
            let selected = *matches.next()?;
            if matches.next().is_some() {
                return None;
            }
            selected
        } else {
            let first = *candidates
                .iter()
                .max_by(|a, b| a.eye_span.total_cmp(&b.eye_span))?;
            // Eye span selects a clearly closer operator, never an arbitrary detection index.
            if candidates
                .iter()
                .filter(|f| f.eye_span > first.eye_span / 1.5)
                .count()
                != 1
            {
                return None;
            }
            self.reference_span = first.eye_span;
            first
        };
        for face in candidates {
            if face.distance(&selected) < 0.000001 {
                continue;
            }
            if let Some(background) = self
                .backgrounds
                .iter_mut()
                .find(|background| Self::same_background(face, background))
            {
                *background = *face;
            } else if self.backgrounds.len() < 4 {
                self.backgrounds.push(*face);
            }
        }
        // Losing the lock does not automatically adopt another/background face.
        self.locked = Some(selected);
        self.last_seen_ms = captured_ms;
        self.reference_span = selected.eye_span;
        Some(selected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn person() -> Face {
        Face {
            yaw: 0.,
            pitch: 0.4,
            center_x: 0.5,
            center_y: 0.5,
            eye_span: 0.2,
        }
    }
    fn painting() -> Face {
        Face {
            center_x: 0.18,
            center_y: 0.25,
            eye_span: 0.055,
            ..person()
        }
    }
    #[test]
    fn foreground_operator_with_background_painting() {
        let mut operator = Operator::default();
        assert_eq!(
            operator
                .observe(&[painting(), person()], 0.)
                .unwrap()
                .eye_span,
            0.2
        );
        assert_eq!(
            operator
                .observe(&[person(), painting()], 60.)
                .unwrap()
                .eye_span,
            0.2
        );
    }
    #[test]
    fn comparable_initial_faces_are_ambiguous() {
        let mut operator = Operator::default();
        assert!(
            operator
                .observe(
                    &[
                        person(),
                        Face {
                            center_x: 0.8,
                            eye_span: 0.19,
                            ..person()
                        }
                    ],
                    0.
                )
                .is_none()
        );
    }
    #[test]
    fn operator_loss_never_promotes_the_painting() {
        let mut operator = Operator::default();
        operator.observe(&[person(), painting()], 0.).unwrap();
        for _ in 0..100 {
            assert!(operator.observe(&[painting()], 1000.).is_none());
        }
    }
    #[test]
    fn small_background_cannot_take_over_at_the_same_position() {
        let mut operator = Operator::default();
        operator.observe(&[person()], 0.).unwrap();
        assert!(
            operator
                .observe(
                    &[Face {
                        eye_span: 0.055,
                        ..person()
                    }],
                    1000.
                )
                .is_none()
        );
    }
    #[test]
    fn crossing_faces_fail_closed() {
        let mut operator = Operator::default();
        operator.observe(&[person()], 0.).unwrap();
        assert!(
            operator
                .observe(
                    &[
                        person(),
                        Face {
                            center_x: 0.52,
                            ..person()
                        }
                    ],
                    60.
                )
                .is_none()
        );
    }
    #[test]
    fn gradual_operator_motion_keeps_its_identity() {
        let mut operator = Operator::default();
        operator.observe(&[person(), painting()], 0.).unwrap();
        for i in 1..10 {
            assert_eq!(
                operator
                    .observe(
                        &[
                            painting(),
                            Face {
                                center_x: 0.5 + i as f64 * 0.01,
                                ..person()
                            }
                        ],
                        i as f64 * 60.
                    )
                    .unwrap()
                    .eye_span,
                0.2
            );
        }
    }
    #[test]
    fn operator_reacquires_after_bounded_motion_during_a_detection_gap() {
        let mut operator = Operator::default();
        let original = Face {
            center_x: 0.625,
            eye_span: 0.09,
            ..person()
        };
        let moved = Face {
            center_x: 0.423,
            ..original
        };
        operator.observe(&[original], 0.).unwrap();
        assert!(operator.observe(&[], 100.).is_none());
        assert!(operator.observe(&[moved], 160.).is_none());
        assert!(operator.observe(&[moved], 600.).is_some());
        assert!(
            operator
                .observe(
                    &[Face {
                        eye_span: 0.045,
                        ..moved
                    }],
                    2000.
                )
                .is_none()
        );
    }
    #[test]
    fn gradual_distance_changes_do_not_freeze_the_initial_face_size() {
        let mut operator = Operator::default();
        let foreground = Face {
            eye_span: 0.0926,
            ..person()
        };
        let background = Face {
            eye_span: 0.055,
            center_x: 0.4,
            ..painting()
        };
        operator.observe(&[foreground, background], 0.).unwrap();
        for (i, span) in [0.085, 0.075, 0.0645, 0.055].iter().enumerate() {
            assert!(
                operator
                    .observe(
                        &[
                            Face {
                                eye_span: *span,
                                ..foreground
                            },
                            background
                        ],
                        (i + 1) as f64 * 60.
                    )
                    .is_some()
            );
        }
        assert!(operator.observe(&[background], 2000.).is_none());
    }
}
