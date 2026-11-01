use crate::{
    control::{Config, Frame},
    engine::Engine,
    uia::Inspector,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{BufRead, Read, Write},
    sync::{Arc, Mutex},
};

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Inspect {
        hwnd: Option<isize>,
    },
    Resolve {
        element_id: String,
    },
    Begin {
        config: Option<Config>,
        hwnd: Option<isize>,
    },
    Frame {
        frame: Frame,
    },
    Stop,
    Status,
    CancelInspection,
    Shutdown,
}
#[derive(Deserialize)]
struct Envelope {
    id: Value,
    #[serde(flatten)]
    command: Command,
}

pub fn serve(engine: Arc<Engine>, inspector: Arc<Inspector>, allow_replay: bool) {
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let reply = |out: &Arc<Mutex<std::io::Stdout>>, id: Value, result: crate::Result<Value>| {
        if let Ok(mut out) = out.lock() {
            let _ = writeln!(out, "{}", json!({"id":id,"result":result}));
            let _ = out.flush();
        }
    };
    std::thread::scope(|scope| {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        loop {
            let mut line = String::new();
            match input.by_ref().take(65537).read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            if line.len() > 65536 {
                reply(
                    &output,
                    Value::Null,
                    Err("diagnostic request exceeds 64 KiB".into()),
                );
                break;
            }
            let value = match serde_json::from_str::<Value>(&line) {
                Ok(value) => value,
                Err(e) => {
                    reply(&output, Value::Null, Err(e.to_string()));
                    continue;
                }
            };
            let request_id = value.get("id").cloned().unwrap_or(Value::Null);
            let request = match serde_json::from_value::<Envelope>(value) {
                Ok(r) => r,
                Err(e) => {
                    reply(&output, request_id, Err(e.to_string()));
                    continue;
                }
            };
            let id = request.id;
            match request.command {
                Command::Inspect { hwnd } => {
                    let out = output.clone();
                    let service = inspector.clone();
                    scope.spawn(move || {
                        reply(
                            &out,
                            id,
                            service
                                .inspect(hwnd)
                                .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
                        )
                    });
                }
                Command::Resolve { element_id } => {
                    let out = output.clone();
                    let service = inspector.clone();
                    scope.spawn(move || {
                        reply(
                            &out,
                            id,
                            service
                                .resolve(&element_id)
                                .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
                        )
                    });
                }
                Command::Begin { config, hwnd } => reply(
                    &output,
                    id,
                    engine
                        .begin(config.unwrap_or_default(), hwnd)
                        .map(|s| json!(s)),
                ),
                Command::Frame { frame } => {
                    reply(
                        &output,
                        id,
                        if allow_replay {
                            engine.submit(frame).map(|_| Value::Null)
                        } else {
                            Err("frame injection requires --allow-replay; webcam uses the sensor IPC".into())
                        },
                    )
                }
                Command::Stop => reply(
                    &output,
                    id,
                    engine.stop("diagnostic stop").map(|s| json!(s)),
                ),
                Command::Status => reply(&output, id, engine.status().map(|s| json!(s))),
                Command::CancelInspection => {
                    inspector.cancel();
                    reply(&output, id, Ok(Value::Null));
                }
                Command::Shutdown => {
                    inspector.cancel();
                    reply(
                        &output,
                        id,
                        engine.stop("diagnostic shutdown").map(|s| json!(s)),
                    );
                    break;
                }
            }
        }
        inspector.cancel();
        let _ = engine.stop("diagnostic input closed");
    });
}
