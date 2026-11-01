use kaji_engine::{diagnostics, engine::Engine, uia::Inspector};
use std::sync::Arc;
fn main() {
    if kaji_engine::helper_entry() {
        return;
    }
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|s| s == "--inspect") {
        let hwnd = args
            .iter()
            .position(|s| s == "--hwnd")
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.parse().ok());
        let result = Inspector::default().inspect(hwnd);
        println!("{}", serde_json::to_string(&result).unwrap());
        if result.is_err() {
            std::process::exit(1);
        }
        return;
    }
    if args.iter().any(|s| s == "--help") {
        println!(
            "kaji-diag [--inspect [--hwnd N]] | [--enable-input] [--allow-replay]\nJSONL commands: inspect, resolve, begin, frame, status, stop, cancel_inspection, shutdown.\nEvery request has an id and command. Escape is a global emergency stop."
        );
        return;
    }
    match Engine::new(args.iter().any(|s| s == "--enable-input")) {
        Ok(engine) => diagnostics::serve(
            Arc::new(engine),
            Arc::new(Inspector::default()),
            args.iter().any(|s| s == "--allow-replay"),
        ),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
