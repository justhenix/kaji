pub mod agent_process;
pub mod assist;
pub mod composer;
pub mod control;
pub mod desktop;
pub mod diagnostics;
pub mod document_worker;
pub mod engine;
pub mod face;
pub mod gateway_client;
pub mod gui;
pub mod history;
pub mod native;
pub mod offline_voice;
pub mod overlay;
pub mod review;
pub mod runtime;
pub mod sensor;
pub mod uia;
pub mod updates;
pub mod voice_commands;

pub type Result<T> = std::result::Result<T, String>;

pub fn helper_entry() -> bool {
    if let Some(request) = std::env::args().nth(1).filter(|s| s == "--uia-worker") {
        let _ = request;
        let result = std::env::args()
            .nth(2)
            .ok_or_else(|| "missing UIA request".to_owned())
            .and_then(|s| serde_json::from_str::<uia::Request>(&s).map_err(|e| e.to_string()))
            .and_then(|request| {
                uia::execute_with_permission(
                    request,
                    std::env::args().any(|a| a == "--enable-actions"),
                )
            });
        println!("{}", serde_json::to_string(&result).unwrap());
        return true;
    }
    false
}
