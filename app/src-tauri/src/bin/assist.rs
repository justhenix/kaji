use kaji_engine::assist::{self, Assist};
use std::sync::Arc;
fn main() {
    if kaji_engine::helper_entry() {
        return;
    }
    let args: Vec<_> = std::env::args().collect();
    if args.iter().any(|a| a == "--help") {
        println!(
            "kaji-assist [--enable-actions]\nJSONL: begin(hwnd), inspect(session), point(session,element_id), invoke(session,revision), status, pause, resume(session), stop, shutdown.\nLogical cursor; UIA-grounded semantic actions and standard Win32 pushbutton notifications. No SendInput fallback. Escape revokes the session."
        );
        return;
    }
    match Assist::new(args.iter().any(|a| a == "--enable-actions")) {
        Ok(service) => assist::serve(Arc::new(service)),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
