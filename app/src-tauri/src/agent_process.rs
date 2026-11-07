use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::os::windows::process::CommandExt;
use std::{
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
};

const GATEWAY_URL: &str = "https://kaji-gateway.relanta.workers.dev/v1";
const MAX_HOST_LINE: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DesktopHostInput {
    Start {
        task_id: String,
        conversation_id: String,
        text: String,
        mode: crate::assist::Mode,
        model: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        hwnd: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        native_session_id: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        method: Option<String>,
    },
    Answer {
        task_id: String,
        question_id: String,
        answer: String,
    },
    Method {
        task_id: String,
        question_id: String,
        method: String,
        split_screen: bool,
    },
    Continue {
        task_id: String,
    },
    Pause {
        task_id: String,
    },
    Resume {
        task_id: String,
    },
    Stop {
        task_id: String,
    },
    NativeResponse {
        id: String,
        task_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Shutdown,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DesktopHostOutput {
    Ready,
    NativeRequest {
        id: String,
        task_id: String,
        command: Value,
    },
    Update {
        task_id: String,
        phase: Option<crate::runtime::TaskPhase>,
        message: Option<String>,
        question: Option<Box<crate::runtime::HostQuestion>>,
        step: Option<Box<crate::runtime::TaskStep>>,
    },
    Result {
        task_id: String,
        phase: crate::runtime::TerminalPhase,
        message: String,
        verified: bool,
    },
    Error {
        task_id: Option<String>,
        message: String,
    },
}

pub struct AgentProcess {
    input: Mutex<BufWriter<ChildStdin>>,
    child: Mutex<Child>,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl AgentProcess {
    pub fn spawn(
        on_output: impl Fn(DesktopHostOutput) + Send + Sync + 'static,
    ) -> Result<Arc<Self>> {
        let binary = resolve_agent_binary()?;
        let mut token = crate::gateway_client::connected_token()?;
        let mut command = Command::new(binary);
        command
            .env_clear()
            .env("KAJI_GATEWAY_TOKEN", &token)
            .env("KAJI_GATEWAY_URL", GATEWAY_URL)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        let spawn = command.spawn();
        drop(command);
        clear_secret(&mut token);
        let mut child = spawn.map_err(|e| format!("managed Kaji agent launch failed: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or("managed Kaji agent stdin is unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("managed Kaji agent stdout is unavailable")?;
        let callback = Arc::new(on_output);
        let reader = thread::Builder::new()
            .name("kaji-agent-output".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut line = String::new();
                    let length = match reader
                        .by_ref()
                        .take((MAX_HOST_LINE + 1) as u64)
                        .read_line(&mut line)
                    {
                        Ok(0) | Err(_) => break,
                        Ok(length) => length,
                    };
                    if length > MAX_HOST_LINE {
                        callback(DesktopHostOutput::Error {
                            task_id: None,
                            message: "Desktop host output exceeds 4 MiB".into(),
                        });
                        break;
                    }
                    match serde_json::from_str::<DesktopHostOutput>(&line) {
                        Ok(output) => callback(output),
                        Err(error) => {
                            callback(DesktopHostOutput::Error {
                                task_id: None,
                                message: format!("Invalid desktop host output: {error}"),
                            });
                            break;
                        }
                    }
                }
            })
            .map_err(|e| format!("managed Kaji agent reader failed: {e}"))?;
        Ok(Arc::new(Self {
            input: Mutex::new(BufWriter::new(stdin)),
            child: Mutex::new(child),
            reader: Mutex::new(Some(reader)),
        }))
    }

    pub fn send(&self, input: &DesktopHostInput) -> Result<()> {
        let line = serde_json::to_string(input).map_err(|e| e.to_string())?;
        if line.len() > MAX_HOST_LINE {
            return Err("Desktop host input exceeds 4 MiB".into());
        }
        let mut output = self
            .input
            .lock()
            .map_err(|_| "desktop host stdin lock poisoned")?;
        output
            .write_all(line.as_bytes())
            .and_then(|_| output.write_all(b"\n"))
            .and_then(|_| output.flush())
            .map_err(|e| format!("Desktop host input failed: {e}"))
    }

    pub fn shutdown(&self) {
        let _ = self.send(&DesktopHostInput::Shutdown);
        if let Ok(mut child) = self.child.lock() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
            while std::time::Instant::now() < deadline {
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                thread::sleep(std::time::Duration::from_millis(10));
            }
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Ok(mut reader) = self.reader.lock()
            && let Some(reader) = reader.take()
        {
            let _ = reader.join();
        }
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(reader) = self.reader.get_mut()
            && let Some(reader) = reader.take()
        {
            let _ = reader.join();
        }
    }
}

fn resolve_agent_binary() -> Result<PathBuf> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let sibling = executable
        .parent()
        .ok_or("native application has no executable directory")?
        .join("kaji-agent.exe");
    if sibling.is_file() {
        return Ok(sibling);
    }
    if cfg!(debug_assertions) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let fallback = manifest
            .join("binaries")
            .join("kaji-agent-x86_64-pc-windows-msvc.exe");
        if fallback.is_file() {
            return Ok(fallback);
        }
    }
    Err("managed kaji-agent.exe is not staged beside Kaji".into())
}

fn clear_secret(secret: &mut String) {
    unsafe {
        let bytes = secret.as_mut_vec();
        for byte in bytes {
            std::ptr::write_volatile(byte, 0);
        }
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    secret.clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn desktop_host_input_uses_canonical_camel_case_envelope() {
        let input = DesktopHostInput::Start {
            task_id: "task-1".into(),
            conversation_id: "conversation-1".into(),
            text: "Inspect the current task context".into(),
            mode: crate::assist::Mode::Assist,
            model: "deepseek-v4.1-flash".into(),
            hwnd: Some(42),
            native_session_id: None,
            method: None,
        };
        let value = serde_json::to_value(input).unwrap();
        assert_eq!(value["type"], "start");
        assert_eq!(value["taskId"], "task-1");
        assert_eq!(value["conversationId"], "conversation-1");
        assert_eq!(value["hwnd"], 42);
        assert!(value.get("task_id").is_none());
    }

    #[test]
    fn desktop_host_update_reads_dynamic_method_and_window_choices() {
        let output: DesktopHostOutput = serde_json::from_value(json!({
            "type": "update",
            "taskId": "task-1",
            "phase": "awaiting_method",
            "question": {
                "id": "question-1",
                "kind": "method",
                "title": "Choose an available executor",
                "options": [{ "id": "native-ui", "label": "Use the current app", "value": "native-ui" }],
                "allowCustom": false,
                "optional": false,
                "splitScreen": {
                    "available": true,
                    "enabled": false,
                    "userWindow": "opaque-user-window",
                    "taskWindow": "opaque-task-window"
                }
            }
        }))
        .unwrap();
        let DesktopHostOutput::Update {
            task_id,
            question: Some(question),
            ..
        } = output
        else {
            panic!("expected a task update with a method question")
        };
        assert_eq!(task_id, "task-1");
        assert_eq!(
            question.split_screen.as_ref().unwrap().task_window,
            "opaque-task-window"
        );
    }
}
