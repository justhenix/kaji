pub mod control;
pub mod diagnostics;
pub mod engine;
pub mod face;
pub mod native;
pub mod uia;

pub type Result<T> = std::result::Result<T, String>;

pub fn helper_entry() -> bool {
    if let Some(request) = std::env::args().nth(1).filter(|s| s == "--uia-worker") {
        let _ = request;
        let result = std::env::args()
            .nth(2)
            .ok_or_else(|| "missing UIA request".to_owned())
            .and_then(|s| serde_json::from_str::<uia::Request>(&s).map_err(|e| e.to_string()))
            .and_then(uia::execute);
        println!("{}", serde_json::to_string(&result).unwrap());
        return true;
    }
    false
}
