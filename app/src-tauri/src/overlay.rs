use crate::{
    Result,
    control::Point,
    native::{self, DisplayInfo},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub left: i32,
    pub top: i32,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverlayCoordinates {
    pub viewport: Viewport,
    pub monitor_scale_factor: f64,
}

pub fn coordinates_for_point(point: Point, webview_scale: f64) -> Result<OverlayCoordinates> {
    coordinates_for_display(point, webview_scale, &native::displays()?)
}

pub fn coordinates_for_display(
    point: Point,
    webview_scale: f64,
    displays: &[DisplayInfo],
) -> Result<OverlayCoordinates> {
    if !point.x.is_finite()
        || !point.y.is_finite()
        || !webview_scale.is_finite()
        || webview_scale <= 0.0
    {
        return Err("invalid physical overlay coordinates".into());
    }
    let display = displays
        .iter()
        .copied()
        .min_by(|left, right| {
            distance_squared(point, left.bounds).total_cmp(&distance_squared(point, right.bounds))
        })
        .ok_or("no display available for overlay")?;
    let bounds = display.bounds;
    Ok(OverlayCoordinates {
        viewport: Viewport {
            left: bounds.left,
            top: bounds.top,
            width: f64::from(bounds.right - bounds.left),
            height: f64::from(bounds.bottom - bounds.top),
            scale_factor: webview_scale,
        },
        monitor_scale_factor: display.scale_factor,
    })
}

pub fn point_to_css(point: Point, viewport: Viewport) -> Point {
    Point {
        x: (point.x - f64::from(viewport.left)) / viewport.scale_factor,
        y: (point.y - f64::from(viewport.top)) / viewport.scale_factor,
    }
}

pub fn cursor_width_css(coordinates: OverlayCoordinates) -> f64 {
    24.0 * coordinates.monitor_scale_factor / coordinates.viewport.scale_factor
}

fn distance_squared(point: Point, rect: native::Rect) -> f64 {
    let right = f64::from(rect.right - 1);
    let bottom = f64::from(rect.bottom - 1);
    let dx = (f64::from(rect.left) - point.x).max(0.0) + (point.x - right).max(0.0);
    let dy = (f64::from(rect.top) - point.y).max(0.0) + (point.y - bottom).max(0.0);
    dx * dx + dy * dy
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::Rect;

    #[test]
    fn negative_monitor_origin_maps_physical_pointer_to_css_origin() {
        let display = DisplayInfo {
            bounds: Rect {
                left: -1920,
                top: -200,
                right: 0,
                bottom: 880,
            },
            work_area: Rect {
                left: -1920,
                top: -160,
                right: 0,
                bottom: 880,
            },
            scale_factor: 1.0,
        };
        let coordinates = coordinates_for_display(
            Point {
                x: -1800.0,
                y: -80.0,
            },
            1.0,
            &[display],
        )
        .unwrap();
        assert_eq!(
            point_to_css(
                Point {
                    x: -1800.0,
                    y: -80.0
                },
                coordinates.viewport
            ),
            Point { x: 120.0, y: 120.0 }
        );
        assert_eq!(coordinates.viewport.left, -1920);
    }

    #[test]
    fn mixed_dpi_uses_selected_monitor_origin_and_explicit_scale() {
        let displays = [
            DisplayInfo {
                bounds: Rect {
                    left: -1920,
                    top: 0,
                    right: 0,
                    bottom: 1080,
                },
                work_area: Rect {
                    left: -1920,
                    top: 0,
                    right: 0,
                    bottom: 1040,
                },
                scale_factor: 1.0,
            },
            DisplayInfo {
                bounds: Rect {
                    left: 0,
                    top: 0,
                    right: 2560,
                    bottom: 1440,
                },
                work_area: Rect {
                    left: 0,
                    top: 0,
                    right: 2560,
                    bottom: 1400,
                },
                scale_factor: 1.5,
            },
        ];
        let coordinates =
            coordinates_for_display(Point { x: 150.0, y: 300.0 }, 1.5, &displays).unwrap();
        assert_eq!(coordinates.viewport.left, 0);
        assert_eq!(coordinates.viewport.width, 2560.0);
        assert_eq!(
            point_to_css(Point { x: 150.0, y: 300.0 }, coordinates.viewport),
            Point { x: 100.0, y: 200.0 }
        );
        assert_eq!(cursor_width_css(coordinates), 24.0);
    }

    #[test]
    fn point_in_monitor_gap_uses_nearest_display() {
        let displays = [
            DisplayInfo {
                bounds: Rect {
                    left: -100,
                    top: 0,
                    right: 0,
                    bottom: 100,
                },
                work_area: Rect {
                    left: -100,
                    top: 0,
                    right: 0,
                    bottom: 100,
                },
                scale_factor: 1.0,
            },
            DisplayInfo {
                bounds: Rect {
                    left: 20,
                    top: 0,
                    right: 120,
                    bottom: 100,
                },
                work_area: Rect {
                    left: 20,
                    top: 0,
                    right: 120,
                    bottom: 100,
                },
                scale_factor: 1.25,
            },
        ];
        let coordinates =
            coordinates_for_display(Point { x: 10.0, y: 40.0 }, 1.25, &displays).unwrap();
        assert_eq!(coordinates.viewport.left, 20);
        assert_eq!(coordinates.monitor_scale_factor, 1.25);
    }
}
