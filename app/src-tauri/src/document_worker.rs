use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::os::windows::process::CommandExt;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_SOURCE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_WORKER_LINE: usize = 1_048_576;
const WORKER_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DocumentOperation {
    NormalizeSpacing {
        #[serde(skip_serializing_if = "Option::is_none")]
        after_pt: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        line_spacing: Option<f64>,
    },
    TrimWhitespace,
    ReplaceText {
        find: String,
        replace: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        match_case: Option<bool>,
    },
    SetHeading {
        paragraph_index: usize,
        level: u8,
    },
    SetTitle {
        text: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DocumentBlock {
    Title { text: String },
    Heading { text: String, level: u8 },
    Paragraph { text: String },
    Bullet { text: String },
    Numbered { text: String },
    Table { rows: Vec<Vec<String>> },
}

#[derive(Clone, Debug)]
pub enum DocumentJob {
    Edit {
        source: PathBuf,
        operations: Vec<DocumentOperation>,
    },
    Create {
        blocks: Vec<DocumentBlock>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub paragraphs: usize,
    pub tables: usize,
    pub bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxArtifact {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub changed_items: usize,
    pub verification: Verification,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerResponse {
    id: String,
    ok: bool,
    output_path: Option<String>,
    name: Option<String>,
    changed_items: Option<usize>,
    verification: Option<Verification>,
    error: Option<String>,
    content: Option<Value>,
}

pub struct DocumentWorker {
    artifacts_root: PathBuf,
    availability: std::sync::OnceLock<bool>,
}

impl DocumentWorker {
    pub fn new(artifacts_root: impl Into<PathBuf>) -> Result<Self> {
        let artifacts_root = artifacts_root.into();
        std::fs::create_dir_all(&artifacts_root)
            .map_err(|e| format!("document artifact directory: {e}"))?;
        Ok(Self {
            artifacts_root,
            availability: std::sync::OnceLock::new(),
        })
    }

    pub fn artifact_root(&self) -> &Path {
        &self.artifacts_root
    }

    pub fn inspect(&self, source: &Path, mut current: impl FnMut() -> bool) -> Result<Value> {
        let id = format!("inspect-{}", unix_ms());
        let request = json!({"id": id, "operation": "inspect", "sourcePath": source});
        let response = self.request_worker(&request, &mut current)?;
        if response.id != id || !current() {
            return Err("document inspection expired".into());
        }
        response
            .content
            .ok_or("document inspection omitted content".into())
    }

    pub fn is_available(&self) -> bool {
        *self.availability.get_or_init(probe_worker)
    }

    pub fn execute(
        &self,
        task_id: &str,
        selected_source: Option<&Path>,
        job: DocumentJob,
        mut current: impl FnMut() -> bool,
    ) -> Result<DocxArtifact> {
        if task_id.is_empty() || task_id.len() > 128 {
            return Err("invalid document task id".into());
        }
        if !current() {
            return Err("document task is no longer active".into());
        }
        let artifact_id = format!(
            "docx-{}-{}",
            unix_ms(),
            NEXT_DOCUMENT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let task_dir = self.artifacts_root.join(&artifact_id);
        std::fs::create_dir(&task_dir).map_err(|e| format!("document task directory: {e}"))?;
        let output = task_dir.join("result.docx");
        let request = match job {
            DocumentJob::Edit { source, operations } => {
                let selected = selected_source.ok_or("select a DOCX before editing")?;
                let source = source
                    .canonicalize()
                    .map_err(|e| format!("selected DOCX path: {e}"))?;
                let selected = selected
                    .canonicalize()
                    .map_err(|e| format!("selected DOCX path: {e}"))?;
                if source != selected
                    || source
                        .extension()
                        .is_none_or(|ext| !ext.eq_ignore_ascii_case("docx"))
                {
                    return Err("document task source must match the user-selected DOCX".into());
                }
                let metadata =
                    std::fs::metadata(&source).map_err(|e| format!("selected DOCX: {e}"))?;
                if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
                    return Err("selected DOCX is outside the supported file size".into());
                }
                json!({
                    "id": artifact_id,
                    "operation": "edit",
                    "sourcePath": source,
                    "outputPath": output,
                    "operations": operations,
                })
            }
            DocumentJob::Create { blocks } => json!({
                "id": artifact_id,
                "operation": "create",
                "outputPath": output,
                "blocks": blocks,
            }),
        };
        let result = self.run_worker(&request, &output, &artifact_id, &mut current);
        if result.is_err() || !current() {
            let _ = std::fs::remove_dir_all(&task_dir);
        }
        result
    }

    fn run_worker(
        &self,
        request: &Value,
        output: &Path,
        artifact_id: &str,
        current: &mut impl FnMut() -> bool,
    ) -> Result<DocxArtifact> {
        let response = self.request_worker(request, current)?;
        if response.id != artifact_id
            || response.output_path.as_deref() != Some(&output.to_string_lossy())
            || !output.is_file()
        {
            return Err("DOCX worker returned an unverified artifact".into());
        }
        let name = response.name.ok_or("DOCX worker omitted artifact name")?;
        if name != "result.docx" {
            return Err("DOCX worker returned an invalid artifact name".into());
        }
        if !current() {
            return Err("document task was cancelled after generation".into());
        }
        Ok(DocxArtifact {
            id: artifact_id.into(),
            name,
            path: output.to_string_lossy().into_owned(),
            kind: "docx".into(),
            changed_items: response.changed_items.unwrap_or_default(),
            verification: response
                .verification
                .ok_or("DOCX worker omitted verification")?,
        })
    }

    fn request_worker(
        &self,
        request: &Value,
        current: &mut impl FnMut() -> bool,
    ) -> Result<WorkerResponse> {
        let (mut command, script) = worker_command()?;
        command
            .arg("-u")
            .arg(script)
            .env_clear()
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PYTHONUTF8", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("DOCX worker launch failed: {e}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or("DOCX worker stdout is unavailable")?;
        let (tx, rx) = mpsc::sync_channel(1);
        let reader = thread::Builder::new()
            .name("kaji-docx-output".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                let result = reader
                    .by_ref()
                    .take((MAX_WORKER_LINE + 1) as u64)
                    .read_line(&mut line)
                    .map_err(|e| e.to_string())
                    .and_then(|size| {
                        if size == 0 || size > MAX_WORKER_LINE {
                            Err("DOCX worker returned an invalid response size".into())
                        } else {
                            serde_json::from_str::<WorkerResponse>(&line).map_err(|e| e.to_string())
                        }
                    });
                let _ = tx.send(result);
            })
            .map_err(|e| format!("DOCX worker reader failed: {e}"))?;
        let body = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        if body.len() > MAX_WORKER_LINE {
            let _ = child.kill();
            let _ = reader.join();
            return Err("DOCX worker request exceeds 1 MiB".into());
        }
        let mut stdin = child
            .stdin
            .take()
            .ok_or("DOCX worker stdin is unavailable")?;
        let write = stdin.write_all(&body).and_then(|_| stdin.write_all(b"\n"));
        drop(stdin);
        if let Err(error) = write {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(format!("DOCX worker input failed: {error}"));
        }

        let deadline = Instant::now() + WORKER_TIMEOUT;
        loop {
            if !current() {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("document task was cancelled".into());
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("DOCX worker timed out".into());
            }
            if let Ok(response) = rx.recv_timeout(Duration::from_millis(10)) {
                let response = response.map_err(|e| format!("DOCX worker response: {e}"))?;
                let status = child.wait().map_err(|e| e.to_string())?;
                let _ = reader.join();
                if !status.success() {
                    return Err("DOCX worker exited with an error".into());
                }
                if !response.ok {
                    return Err(response
                        .error
                        .unwrap_or_else(|| "DOCX worker failed".into()));
                }
                return Ok(response);
            }
        }
    }
}

fn worker_command() -> Result<(Command, PathBuf)> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let app_dir = executable
        .parent()
        .ok_or("native application has no executable directory")?;
    let app_dir = if cfg!(test) && app_dir.file_name().is_some_and(|name| name == "deps") {
        app_dir
            .parent()
            .ok_or("test binary has no profile directory")?
    } else {
        app_dir
    };
    let bundled_dir = app_dir.join("python");
    let bundled_python = bundled_dir.join("python.exe");
    let bundled_worker = bundled_dir.join("worker.py");
    if bundled_python.is_file() && bundled_worker.is_file() {
        let mut command = Command::new(bundled_python);
        command.arg("-I");
        return Ok((command, bundled_worker));
    }
    if cfg!(debug_assertions) {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../python/worker.py");
        if script.is_file() {
            let mut command = Command::new("py.exe");
            command.args(["-3"]);
            return Ok((command, script));
        }
    }
    Err("bundled Python DOCX worker is unavailable".into())
}

fn probe_worker() -> bool {
    let Ok((mut command, script)) = worker_command() else {
        return false;
    };
    if !script.is_file() {
        return false;
    }
    command
        .arg("-c")
        .arg("import docx, lxml, typing_extensions")
        .env_clear()
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

static NEXT_DOCUMENT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_operations_serialize_worker_field_names_in_camel_case() {
        let operation = DocumentOperation::NormalizeSpacing {
            after_pt: Some(5.0),
            line_spacing: Some(1.2),
        };
        let value = serde_json::to_value(operation).unwrap();
        assert_eq!(value["kind"], "normalize_spacing");
        assert_eq!(value["afterPt"], 5.0);
        assert_eq!(value["lineSpacing"], 1.2);
        assert!(value.get("after_pt").is_none());

        let operation = DocumentOperation::ReplaceText {
            find: "draft".into(),
            replace: "final".into(),
            match_case: Some(false),
        };
        assert_eq!(serde_json::to_value(operation).unwrap()["matchCase"], false);

        let operation = DocumentOperation::SetHeading {
            paragraph_index: 2,
            level: 1,
        };
        assert_eq!(
            serde_json::to_value(operation).unwrap()["paragraphIndex"],
            2
        );
    }

    #[test]
    #[ignore = "spawns the isolated Python DOCX worker"]
    fn rust_request_roundtrips_through_python_docx_worker() {
        let temporary = tempfile::tempdir().unwrap();
        let worker = DocumentWorker::new(temporary.path().join("artifacts")).unwrap();
        assert!(
            worker.is_available(),
            "Python DOCX worker dependencies missing"
        );

        let created = worker
            .execute(
                "task-create",
                None,
                DocumentJob::Create {
                    blocks: vec![
                        DocumentBlock::Title {
                            text: "Daily Brief".into(),
                        },
                        DocumentBlock::Paragraph {
                            text: "Draft status".into(),
                        },
                    ],
                },
                || true,
            )
            .unwrap();
        let source = PathBuf::from(&created.path);
        assert!(source.is_file());

        let edited = worker
            .execute(
                "task-edit",
                Some(&source),
                DocumentJob::Edit {
                    source: source.clone(),
                    operations: vec![
                        DocumentOperation::NormalizeSpacing {
                            after_pt: Some(4.0),
                            line_spacing: Some(1.1),
                        },
                        DocumentOperation::ReplaceText {
                            find: "Draft".into(),
                            replace: "Final".into(),
                            match_case: Some(true),
                        },
                        DocumentOperation::SetHeading {
                            paragraph_index: 1,
                            level: 1,
                        },
                    ],
                },
                || true,
            )
            .unwrap();
        assert!(Path::new(&edited.path).is_file());
        assert!(source.is_file(), "the selected source must remain intact");
        assert!(edited.changed_items >= 3);
        assert!(edited.verification.paragraphs >= 2);
    }
}
