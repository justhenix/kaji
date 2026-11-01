use kaji_engine::control::{Calibration, Point, PoseFilter};
fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("pass a recorded verification JSON path");
    let trace: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut calibration = Calibration::default();
    let mut filter = PoseFilter::default();
    let mut valid = 0;
    let mut first = None;
    for row in trace["observations"].as_array().unwrap() {
        if let (Some(time), Some(x), Some(y)) = (
            row["now_ms"].as_f64(),
            row["pose"]["x"].as_f64(),
            row["pose"]["y"].as_f64(),
        ) {
            valid += 1;
            let pose = filter.update(time, Point { x, y }, None, 0.035);
            if let Some(neutral) = calibration.update(time, pose.x, pose.y) {
                first = Some(
                    serde_json::json!({"time_ms":time,"neutral":neutral,"samples":calibration.sample_count()}),
                );
                break;
            }
        }
    }
    println!(
        "{}",
        serde_json::json!({"valid_observations":valid,"first_calibration":first})
    );
}
