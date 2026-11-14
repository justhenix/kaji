use crate::{
    Result,
    agent_process::{AgentProcess, DesktopHostInput, DesktopHostOutput},
    assist::{Assist, Mode},
    desktop::DesktopManager,
    document_worker::{DocumentJob, DocumentOperation, DocumentWorker},
    engine::Engine,
    gateway_client,
    gui::{AppSettings, GuiManager},
    history::{
        self, ConversationRecord, ConversationSummary, HistoryStore, MessageRole, Retention,
    },
    native::{self, InputHost, Rect},
    offline_voice,
    overlay::{self, Viewport},
    sensor::SensorSession,
    uia::Action,
    voice_commands::{self, Command as VoiceCommand},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::{
    Foundation::{HWND, RECT},
    UI::Controls::Dialogs::{
        CommDlgExtendedError, GetOpenFileNameW, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_HIDEREADONLY,
        OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    },
    UI::WindowsAndMessaging::{GetWindowRect, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos},
};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn default_composer_duration() -> u64 {
    180
}
type SpeechCache = Arc<Mutex<HashMap<(String, String, String), Vec<u8>>>>;
pub const RUNTIME_UPDATE_EVENT: &str = "kaji:runtime-update";
pub const AUDIO_CONTROL_EVENT: &str = "kaji:audio-control";
pub const SENSOR_CONTROL_EVENT: &str = "kaji:sensor-control";
pub const OVERLAY_UPDATE_EVENT: &str = "kaji:overlay-update";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskPhase {
    Planning,
    Working,
    AwaitingMethod,
    AwaitingUser,
    AwaitingConfirmation,
    Verifying,
    Paused,
    Blocked,
    Complete,
    Stopped,
    Error,
}

impl TaskPhase {
    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Blocked | Self::Complete | Self::Stopped | Self::Error
        )
    }
    fn active(self) -> bool {
        !self.terminal()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalPhase {
    Complete,
    Blocked,
    Stopped,
    Error,
}

impl From<TerminalPhase> for TaskPhase {
    fn from(value: TerminalPhase) -> Self {
        match value {
            TerminalPhase::Complete => Self::Complete,
            TerminalPhase::Blocked => Self::Blocked,
            TerminalPhase::Stopped => Self::Stopped,
            TerminalPhase::Error => Self::Error,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReference {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: history::ArtifactKind,
}

impl From<history::ArtifactReference> for ArtifactReference {
    fn from(value: history::ArtifactReference) -> Self {
        Self {
            id: value.id,
            name: value.name,
            path: value.path,
            kind: value.kind,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskTargetWindow {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskState {
    pub id: String,
    pub conversation_id: String,
    pub phase: TaskPhase,
    pub mode: Mode,
    pub request: String,
    pub message: String,
    pub verified: bool,
    pub method: Option<String>,
    pub target_window: Option<TaskTargetWindow>,
    pub artifacts: Vec<ArtifactReference>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    Clarification,
    Approval,
    Method,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SplitScreenChoice {
    pub available: bool,
    pub enabled: bool,
    pub user_window: String,
    pub task_window: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    pub id: String,
    pub task_id: String,
    pub kind: QuestionKind,
    pub title: String,
    pub options: Vec<QuestionOption>,
    pub allow_custom: bool,
    pub optional: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split_screen: Option<SplitScreenChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostQuestion {
    pub id: String,
    pub kind: QuestionKind,
    pub title: String,
    pub options: Vec<QuestionOption>,
    pub allow_custom: bool,
    pub optional: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_screen: Option<SplitScreenChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

impl HostQuestion {
    fn into_pending(self, task_id: String) -> PendingQuestion {
        PendingQuestion {
            id: self.id,
            task_id,
            kind: self.kind,
            title: self.title,
            options: self.options,
            allow_custom: self.allow_custom,
            optional: self.optional,
            split_screen: self.split_screen,
            expires_at: self.expires_at,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub instruction: String,
    pub target: Value,
    pub action: Value,
    pub expect: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeadState {
    pub enabled: bool,
    pub active: bool,
    pub phase: String,
    pub reason: String,
    pub session_id: u64,
    pub dwell_enabled: bool,
    pub dwell_ready: bool,
    pub dwell_progress: f64,
    pub cursor: Option<crate::control::Point>,
    pub calibration_samples: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceState {
    pub session_id: u64,
    pub enabled: bool,
    pub phase: VoicePhase,
    pub reason: String,
    pub audio_level: f64,
    pub transcript: String,
    #[serde(default)]
    pub pending_speech: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VoicePhase {
    Off,
    Starting,
    Wake,
    Listening,
    Transcribing,
    Speaking,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    pub mode: OverlayMode,
    pub point: Option<crate::control::Point>,
    pub target: Option<Rect>,
    pub target_label: String,
    pub dwell_progress: f64,
    pub cursor_enabled: bool,
    pub highlight_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewport: Option<Viewport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitor_scale_factor: Option<f64>,
}

impl OverlayState {
    fn point_at(&mut self, cursor: &crate::assist::IntentCursor) {
        self.mode = OverlayMode::Task;
        self.point = Some(cursor.point);
        self.target = Some(cursor.target);
        let name = one_line(&cursor.target_name);
        self.target_label = if name.trim().is_empty() {
            "Next control".into()
        } else {
            format!("Next: {}", name.chars().take(100).collect::<String>())
        };
        self.dwell_progress = 0.;
    }

    fn clear_target(&mut self) {
        self.mode = if self.cursor_enabled || self.highlight_enabled {
            OverlayMode::Follow
        } else {
            OverlayMode::Hidden
        };
        self.point = None;
        self.target = None;
        self.target_label.clear();
        self.dwell_progress = 0.;
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OverlayMode {
    Follow,
    Task,
    Hidden,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCapability {
    pub available: bool,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ServiceModel>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ServiceModel {
    pub id: String,
    pub label: String,
    pub available: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCapabilities {
    pub reasoning: ServiceCapability,
    pub vision: ServiceCapability,
    pub stt: ServiceCapability,
    pub tts: TtsCapability,
    pub titles: ServiceCapability,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Guide => "guide",
            Self::Assist => "assist",
            Self::Agent => "agent",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceVoice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TtsCapability {
    #[serde(flatten)]
    pub service: ServiceCapability,
    pub voices: Vec<ServiceVoice>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub revision: u64,
    pub history_revision: u64,
    pub mode: Mode,
    pub active_conversation_id: Option<String>,
    pub task: Option<TaskState>,
    pub question: Option<PendingQuestion>,
    pub message: String,
    pub head: HeadState,
    pub attachments: Vec<ArtifactReference>,
    pub voice: VoiceState,
    pub overlay: OverlayState,
    pub layout: LayoutState,
    pub services: Option<ServiceCapabilities>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutState {
    pub active: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RuntimeAction {
    Request {
        text: String,
        conversation_id: Option<String>,
        source: Option<String>,
    },
    Answer {
        task_id: String,
        question_id: String,
        answer: String,
    },
    Confirm {
        task_id: String,
        question_id: String,
        approved: bool,
    },
    Method {
        task_id: String,
        question_id: String,
        method: String,
        split_screen: bool,
    },
    Skip {
        task_id: String,
        question_id: String,
    },
    Dismiss {
        task_id: String,
        question_id: String,
    },
    Pause {
        task_id: Option<String>,
    },
    Resume {
        task_id: Option<String>,
    },
    Stop {
        task_id: Option<String>,
    },
    Mode {
        mode: Mode,
    },
    Head {
        enabled: bool,
    },
    Listen {
        enabled: bool,
        #[serde(default)]
        immediate: bool,
    },
    Dwell {
        enabled: bool,
    },
    Calibrate,
    #[serde(rename = "file.select")]
    FileSelect,
    #[serde(rename = "file.remove")]
    FileRemove,
    #[serde(rename = "document.select")]
    DocumentSelect,
    #[serde(rename = "layout.restore")]
    LayoutRestore,
    #[serde(rename = "services.refresh")]
    ServicesRefresh,
    #[serde(rename = "conversation.new")]
    ConversationNew,
    #[serde(rename = "conversation.open")]
    ConversationOpen {
        conversation_id: String,
    },
    #[serde(rename = "conversation.rename")]
    ConversationRename {
        conversation_id: String,
        title: String,
    },
    #[serde(rename = "conversation.delete")]
    ConversationDelete {
        conversation_id: String,
    },
    #[serde(rename = "artifact.open")]
    ArtifactOpen {
        artifact_id: String,
    },
    #[serde(rename = "audio.state")]
    AudioState {
        phase: VoicePhase,
        audio_level: Option<f64>,
        reason: Option<String>,
    },
    #[serde(rename = "audio.ready")]
    AudioReady,
    #[serde(rename = "audio.transcribe")]
    AudioTranscribe {
        utterance_id: String,
        wav_base64: String,
        task_id: Option<String>,
        question_id: Option<String>,
        conversation_id: Option<String>,
        voice_session_id: u64,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum NativeCommand {
    Begin {
        hwnd: u64,
        mode: Mode,
    },
    Inspect {
        session: u64,
    },
    Point {
        session: u64,
        element_id: String,
    },
    Invoke {
        session: u64,
        revision: u64,
    },
    Act {
        session: u64,
        revision: u64,
        action: Action,
    },
    Status,
    Confirm {
        session: u64,
        confirmation_id: String,
    },
    Pause,
    Resume {
        session: u64,
    },
    Stop,
    TaskContext,
    SelectExecutor {
        executor_id: String,
    },
    ListWindows,
    ListApplications,
    BindWindow {
        window_id: String,
    },
    ActivateWindow {
        window_id: String,
    },
    ComposerControl {
        placement: crate::composer::Placement,
        #[serde(default = "default_composer_duration")]
        seconds: u64,
    },
    CaptureWindow {
        window_id: String,
    },
    ProposePhysical {
        capture_id: String,
        action: PhysicalAction,
    },
    ExecutePhysical {
        approval_id: String,
    },
    DocumentEdit {
        operations: Vec<DocumentOperation>,
    },
    DocumentInspect,
    DocumentCreate {
        blocks: Vec<crate::document_worker::DocumentBlock>,
    },
}

#[derive(Clone)]
struct PendingApproval {
    native_id: String,
    approved_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PhysicalAction {
    Activate,
    Click { x: f64, y: f64 },
    TypeText { text: String },
    Key { key: String },
    Scroll { x: f64, y: f64, delta: i32 },
}

#[derive(Clone)]
struct CaptureLease {
    id: String,
    window_id: String,
    bounds: Rect,
    png: Vec<u8>,
    created: Instant,
    activity: u64,
    foreground: isize,
}
#[derive(Clone)]
struct DesktopApproval {
    id: String,
    window_id: String,
    capture: Option<CaptureLease>,
    action: PhysicalAction,
    created: Instant,
}

struct RuntimeInner {
    snapshot: RuntimeSnapshot,
    active_target_id: Option<String>,
    native_session_id: Option<u64>,
    pending_approval: Option<PendingApproval>,
    task_generation: u64,
    step: Option<TaskStep>,
    selected_file: Option<PathBuf>,
    user_window_id: Option<String>,
    capture: Option<CaptureLease>,
    desktop_approval: Option<DesktopApproval>,
    physical_needs_verification: bool,
    uia_attempted: bool,
    resume_head: bool,
}

pub struct RuntimeManager {
    engine: Arc<Engine>,
    assist: Arc<Assist>,
    input: Arc<InputHost>,
    gui: Arc<GuiManager>,
    desktop: Arc<DesktopManager>,
    history: Arc<HistoryStore>,
    documents: DocumentWorker,
    sensor_session: Arc<Mutex<SensorSession>>,
    agent: Mutex<Option<Arc<AgentProcess>>>,
    app: Mutex<Option<AppHandle>>,
    audio_inflight: Mutex<HashSet<String>>,
    speech_cache: SpeechCache,
    inner: Mutex<RuntimeInner>,
}

impl RuntimeManager {
    pub fn new(
        engine: Arc<Engine>,
        gui: Arc<GuiManager>,
        history: Arc<HistoryStore>,
        artifacts_root: PathBuf,
        sensor_session: Arc<Mutex<SensorSession>>,
    ) -> Result<Arc<Self>> {
        let input = engine.input_host();
        let assist = Arc::new(Assist::with_input_host(input.clone())?);
        let settings = gui.get_settings()?;
        history.set_enabled(settings.save_history);
        history.set_retention(Retention::from_setting(&settings.retention)?)?;
        let mode = mode_from_setting(&gui.mode.lock().map_err(|_| "GUI mode lock poisoned")?);
        let cursor_enabled = settings.cursor_effect && settings.overlay_style != "off";
        let inner = RuntimeInner {
            snapshot: RuntimeSnapshot {
                revision: 1,
                history_revision: 0,
                mode,
                active_conversation_id: None,
                task: None,
                question: None,
                message: "Ready".into(),
                attachments: Vec::new(),
                head: HeadState {
                    enabled: false,
                    active: false,
                    phase: "stopped".into(),
                    reason: "Head control starts when enabled".into(),
                    session_id: 0,
                    dwell_enabled: true,
                    dwell_ready: false,
                    dwell_progress: 0.0,
                    cursor: None,
                    calibration_samples: 0,
                },
                voice: VoiceState {
                    session_id: 0,
                    enabled: false,
                    phase: VoicePhase::Off,
                    reason: "Voice starts when enabled".into(),
                    audio_level: 0.0,
                    transcript: String::new(),
                    pending_speech: None,
                },
                overlay: OverlayState {
                    mode: if cursor_enabled || settings.action_highlight {
                        OverlayMode::Follow
                    } else {
                        OverlayMode::Hidden
                    },
                    point: None,
                    target: None,
                    target_label: String::new(),
                    dwell_progress: 0.0,
                    cursor_enabled,
                    highlight_enabled: settings.action_highlight,
                    viewport: None,
                    monitor_scale_factor: None,
                },
                layout: LayoutState { active: false },
                services: None,
            },
            active_target_id: None,
            native_session_id: None,
            pending_approval: None,
            task_generation: 0,
            step: None,
            selected_file: None,
            user_window_id: None,
            capture: None,
            desktop_approval: None,
            physical_needs_verification: false,
            uia_attempted: false,
            resume_head: false,
        };
        Ok(Arc::new(Self {
            desktop: Arc::new(DesktopManager::default()),
            engine,
            assist,
            input,
            gui,
            history,
            documents: DocumentWorker::new(artifacts_root)?,
            sensor_session,
            agent: Mutex::new(None),
            app: Mutex::new(None),
            audio_inflight: Mutex::new(HashSet::new()),
            speech_cache: Arc::new(Mutex::new(HashMap::new())),
            inner: Mutex::new(inner),
        }))
    }

    pub fn attach_app(&self, app: AppHandle) {
        if let Ok(mut slot) = self.app.lock() {
            *slot = Some(app);
        }
    }

    pub fn start_overlay_follow(self: &Arc<Self>) {
        let runtime = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("kaji-overlay-follow".into())
            .spawn(move || {
                let frame = Duration::from_nanos(16_666_667);
                let mut next_display_check = Instant::now();
                let mut next_head_update = Instant::now();
                let mut emergency_epoch = 0;
                loop {
                    let tick = Instant::now();
                    let Some(runtime) = runtime.upgrade() else {
                        break;
                    };
                    let latest_emergency =
                        runtime.input.signals.emergency_epoch.load(Ordering::SeqCst);
                    if latest_emergency != emergency_epoch {
                        emergency_epoch = latest_emergency;
                        let _ = runtime.emergency_stop();
                    } else if runtime.input.signals.emergency.load(Ordering::SeqCst) {
                        let task = runtime.inner.lock().ok().and_then(|inner| {
                            inner
                                .snapshot
                                .task
                                .as_ref()
                                .filter(|task| task.phase.active())
                                .map(|task| task.id.clone())
                        });
                        if let Some(task) = task {
                            runtime
                                .invalidate_task(&task, "Stopped by Escape or native input safety");
                        }
                    }
                    let refresh_display = tick >= next_display_check;
                    if refresh_display {
                        next_display_check = tick + Duration::from_secs(1);
                    }
                    runtime.follow_overlay_tick(refresh_display);
                    if tick >= next_head_update {
                        next_head_update = tick + Duration::from_millis(100);
                        runtime.publish_head_state();
                    }
                    drop(runtime);
                    std::thread::sleep(frame.saturating_sub(tick.elapsed()));
                }
            })
            .ok();
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        let mut snapshot = match self.inner.lock() {
            Ok(inner) => inner.snapshot.clone(),
            Err(_) => return fallback_snapshot(),
        };
        snapshot.layout.active = self.desktop.layout_active();
        self.refresh_device_state(&mut snapshot);
        if snapshot.overlay.mode != OverlayMode::Follow || snapshot.overlay.viewport.is_none() {
            self.apply_overlay_geometry(&mut snapshot.overlay);
        }
        snapshot
    }

    pub fn dispatch(self: &Arc<Self>, action: RuntimeAction) -> Result<RuntimeSnapshot> {
        match action {
            RuntimeAction::Request {
                text,
                conversation_id,
                source,
            } => {
                self.start_request(&text, conversation_id, source.as_deref())?;
            }
            RuntimeAction::Answer {
                task_id,
                question_id,
                answer,
            } => {
                self.answer(&task_id, &question_id, &answer)?;
            }
            RuntimeAction::Confirm {
                task_id,
                question_id,
                approved,
            } => {
                self.confirm(&task_id, &question_id, approved)?;
            }
            RuntimeAction::Method {
                task_id,
                question_id,
                method,
                split_screen,
            } => {
                self.choose_method(&task_id, &question_id, &method, split_screen)?;
            }
            RuntimeAction::Skip {
                task_id,
                question_id,
            } => {
                self.skip_question(&task_id, &question_id, "skip")?;
            }
            RuntimeAction::Dismiss {
                task_id,
                question_id,
            } => {
                self.skip_question(&task_id, &question_id, "dismiss")?;
            }
            RuntimeAction::Pause { task_id } => self.control_all(task_id.as_deref(), "pause")?,
            RuntimeAction::Resume { task_id } => self.control_all(task_id.as_deref(), "resume")?,
            RuntimeAction::Stop { task_id } => self.control_task(task_id.as_deref(), "stop")?,
            RuntimeAction::Mode { mode } => self.set_mode(mode)?,
            RuntimeAction::Head { enabled } => self.set_head(enabled)?,
            RuntimeAction::Listen { enabled, immediate } => self.set_voice(enabled, immediate)?,
            RuntimeAction::AudioReady => {
                let initial = self
                    .inner
                    .lock()
                    .map_err(|_| "runtime state poisoned")?
                    .snapshot
                    .voice
                    .session_id
                    == 0;
                if initial && self.gui.get_settings()?.voice_activation {
                    self.configure_voice(true, false, false)?;
                }
            }
            RuntimeAction::Dwell { enabled } => self.set_dwell(enabled)?,
            RuntimeAction::Calibrate => self.calibrate()?,
            RuntimeAction::FileSelect => self.select_file(false)?,
            RuntimeAction::FileRemove => {
                let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
                if inner
                    .snapshot
                    .task
                    .as_ref()
                    .is_some_and(|task| task.phase.active())
                {
                    return Err("finish or stop the task before removing its file".into());
                }
                inner.selected_file = None;
                inner.snapshot.attachments.clear();
            }
            RuntimeAction::DocumentSelect => self.select_file(true)?,
            RuntimeAction::LayoutRestore => {
                let restored = self.desktop.restore_layout()?;
                self.set_message(if restored {
                    "Window layout restored"
                } else {
                    "No split layout to restore"
                });
            }
            RuntimeAction::ServicesRefresh => self.refresh_services()?,
            RuntimeAction::ConversationNew => self.new_conversation()?,
            RuntimeAction::ConversationOpen { conversation_id } => {
                self.open_conversation(&conversation_id)?
            }
            RuntimeAction::ConversationRename {
                conversation_id,
                title,
            } => self.rename_conversation(&conversation_id, &title)?,
            RuntimeAction::ConversationDelete { conversation_id } => {
                self.delete_conversation(&conversation_id)?
            }
            RuntimeAction::ArtifactOpen { artifact_id } => self.open_artifact(&artifact_id)?,
            RuntimeAction::AudioState {
                phase,
                audio_level,
                reason,
            } => {
                self.update_audio_state(phase, audio_level, reason)?;
            }
            RuntimeAction::AudioTranscribe {
                utterance_id,
                wav_base64,
                task_id,
                question_id,
                conversation_id,
                voice_session_id,
            } => {
                self.transcribe(
                    utterance_id,
                    wav_base64,
                    task_id,
                    question_id,
                    conversation_id,
                    voice_session_id,
                )?;
            }
        }
        self.bump_revision();
        let snapshot = self.snapshot();
        self.emit_current();
        Ok(snapshot)
    }

    pub fn history_list(&self, query: Option<&str>) -> Result<Vec<ConversationSummary>> {
        self.history.list(query)
    }

    pub fn history_get(&self, conversation_id: &str) -> Result<Option<ConversationRecord>> {
        self.history.get(conversation_id)
    }

    pub fn update_history_settings(&self, settings: &AppSettings) -> Result<()> {
        self.history.set_enabled(settings.save_history);
        self.history
            .set_retention(Retention::from_setting(&settings.retention)?)
    }

    pub fn shutdown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.task_generation = inner.task_generation.wrapping_add(1);
        }
        let _ = self.assist.stop("Tauri host exit");
        if let Ok(agent) = self.agent.lock()
            && let Some(agent) = agent.as_ref()
        {
            agent.shutdown();
        }
        let _ = self.desktop.restore_layout();
        let _ = self.engine.stop("Tauri host exit");
    }

    pub fn emergency_stop(&self) -> Result<()> {
        let native = self.gui.emergency_stop();
        let voice = self.set_voice(false, false);
        let head = self.set_head(false);
        let task = self.control_task(None, "stop");
        self.bump_revision();
        self.emit_current();
        native.and(voice).and(head).and(task)
    }

    fn start_request(
        self: &Arc<Self>,
        text: &str,
        requested_conversation: Option<String>,
        source: Option<&str>,
    ) -> Result<()> {
        let request = normalize_user_text(text, 16_000, "request")?;
        if source.is_some_and(|source| !matches!(source, "text" | "voice")) {
            return Err("request source must be text or voice".into());
        }
        if self.handle_app_command(&request, None, source == Some("voice"))? {
            return Ok(());
        }
        let (conversation_id, task_id, mode, target) = {
            let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            if inner
                .snapshot
                .task
                .as_ref()
                .is_some_and(|task| task.phase.active())
            {
                inner.snapshot.message =
                    "Finish or stop active task before starting another".into();
                return Ok(());
            }
            let conversation_id = requested_conversation
                .or_else(|| inner.snapshot.active_conversation_id.clone())
                .unwrap_or_else(|| new_id("c"));
            let task_id = new_id("t");
            if *self
                .gui
                .is_paused
                .lock()
                .map_err(|_| "GUI pause state poisoned")?
            {
                return Err("Resume Kaji before starting a task".into());
            }
            self.input.signals.emergency.store(false, Ordering::SeqCst);
            inner.snapshot.voice.session_id = inner.snapshot.voice.session_id.wrapping_add(1);
            let mode = inner.snapshot.mode;
            let foreground = self
                .input
                .signals
                .last_external_foreground
                .load(Ordering::SeqCst);
            let target = if foreground != 0 {
                self.desktop.window_by_handle(foreground).ok()
            } else {
                self.desktop.foreground_window().ok()
            };
            inner.task_generation = inner.task_generation.wrapping_add(1);
            inner.native_session_id = None;
            inner.pending_approval = None;
            inner.capture = None;
            inner.desktop_approval = None;
            inner.physical_needs_verification = false;
            inner.uia_attempted = false;
            inner.step = None;
            inner.active_target_id = None;
            inner.user_window_id = target.as_ref().map(|window| window.id.clone());
            inner.snapshot.active_conversation_id = Some(conversation_id.clone());
            inner.snapshot.question = None;
            inner.snapshot.message = "Checking current task context".into();
            inner.snapshot.attachments.clear();
            inner.snapshot.task = Some(TaskState {
                id: task_id.clone(),
                conversation_id: conversation_id.clone(),
                phase: TaskPhase::Planning,
                mode,
                request: request.clone(),
                message: "Checking current task context".into(),
                verified: false,
                method: None,
                target_window: None,
                artifacts: Vec::new(),
            });
            (conversation_id, task_id, mode, target)
        };

        if self.history.get(&conversation_id)?.is_some() {
            self.history.append_message(
                &conversation_id,
                Some(&task_id),
                MessageRole::User,
                &request,
                &[],
            )?;
        } else {
            self.history
                .create_from_request(&conversation_id, &task_id, &request)?;
        }
        self.bump_revision();
        self.emit_current();

        let agent = match self.ensure_agent() {
            Ok(agent) => agent,
            Err(error) => {
                self.finish_local_error(&task_id, error.clone());
                return Err(error);
            }
        };
        let _ = target;
        let input = DesktopHostInput::Start {
            task_id: task_id.clone(),
            conversation_id,
            text: request,
            mode,
            model: match self.gui.get_settings()?.model.as_str() {
                "ag/gemini-3.8-flash-medium" => "ag/gemini-3.8-flash-medium",
                "ag/gemini-3.8-flash-high" => "ag/gemini-3.8-flash-high",
                _ => "deepseek-v4.1-flash",
            }
            .into(),
            hwnd: None,
            native_session_id: None,
            method: None,
        };
        if let Err(error) = agent.send(&input) {
            self.finish_local_error(&task_id, error.clone());
            return Err(error);
        }
        Ok(())
    }

    fn skip_question(&self, task_id: &str, question_id: &str, answer: &str) -> Result<()> {
        {
            let inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            let question = inner
                .snapshot
                .question
                .as_ref()
                .ok_or("no pending question")?;
            if question.task_id != task_id || question.id != question_id || !question.optional {
                return Err("question cannot be skipped or dismissed".into());
            }
        }
        self.answer(task_id, question_id, answer)
    }

    fn answer(&self, task_id: &str, question_id: &str, answer: &str) -> Result<()> {
        let answer = normalize_user_text(answer, 2_000, "answer")?;
        let agent = self.current_agent()?;
        {
            let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            let question = inner
                .snapshot
                .question
                .as_ref()
                .ok_or("no pending question")?;
            if question.task_id != task_id || question.id != question_id {
                return Err("question is stale or belongs to another task".into());
            }
            if question.kind == QuestionKind::Method {
                return Err("choose an offered task method".into());
            }
            if question.kind == QuestionKind::Approval
                && !matches!(answer.as_str(), "approve" | "reject")
            {
                return Err("approval answer must match approve or reject".into());
            }
            inner.snapshot.question = None;
            if let Some(task) = inner.snapshot.task.as_mut() {
                task.phase = TaskPhase::Working;
                task.message = "Continuing task".into();
            }
            inner.snapshot.message = "Continuing task".into();
            if answer == "reject" {
                inner.pending_approval = None;
            }
        }
        agent.send(&DesktopHostInput::Answer {
            task_id: task_id.into(),
            question_id: question_id.into(),
            answer,
        })
    }

    fn confirm(&self, task_id: &str, question_id: &str, approved: bool) -> Result<()> {
        let agent = self.current_agent()?;
        {
            let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            let question = inner
                .snapshot
                .question
                .as_ref()
                .ok_or("no pending approval")?;
            if question.task_id != task_id
                || question.id != question_id
                || question.kind != QuestionKind::Approval
            {
                return Err("approval is stale or belongs to another task".into());
            }
            let approval = inner
                .pending_approval
                .as_mut()
                .ok_or("native approval expired")?;
            if approved {
                approval.approved_id = Some(approval.native_id.clone());
            } else {
                inner.pending_approval = None;
            }
            inner.snapshot.question = None;
            if let Some(task) = inner.snapshot.task.as_mut() {
                task.phase = if approved {
                    TaskPhase::Working
                } else {
                    TaskPhase::Stopped
                };
                task.message = if approved {
                    "Continuing approved action"
                } else {
                    "Action cancelled"
                }
                .into();
            }
            inner.snapshot.message = if approved {
                "Continuing approved action"
            } else {
                "Action cancelled"
            }
            .into();
        }
        agent.send(&DesktopHostInput::Answer {
            task_id: task_id.into(),
            question_id: question_id.into(),
            answer: if approved { "approve" } else { "reject" }.into(),
        })
    }

    fn choose_method(
        &self,
        task_id: &str,
        question_id: &str,
        method: &str,
        split: bool,
    ) -> Result<()> {
        if method != "rephrase"
            && !self.task_context()?["executors"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["id"] == method))
        {
            return Err("selected executor is no longer available".into());
        }
        let agent = self.current_agent()?;
        let split_choice = {
            let inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            let question = inner
                .snapshot
                .question
                .as_ref()
                .ok_or("no method choice is pending")?;
            if question.task_id != task_id
                || question.id != question_id
                || question.kind != QuestionKind::Method
            {
                return Err("method choice is stale or belongs to another task".into());
            }
            validate_method_choice(question, method, split)?
        };
        if split {
            let layout = split_choice.ok_or("split screen targets are unavailable")?;
            self.desktop
                .apply_split(&layout.user_window, &layout.task_window)?;
        }
        {
            let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            let question = inner
                .snapshot
                .question
                .as_ref()
                .ok_or("method choice expired")?;
            if question.id != question_id || question.task_id != task_id {
                let _ = self.desktop.restore_layout();
                return Err("method choice expired before dispatch".into());
            }
            inner.snapshot.question = None;
            if let Some(task) = inner.snapshot.task.as_mut() {
                task.method = (method != "rephrase").then(|| method.into());
                task.phase = if method == "rephrase" {
                    TaskPhase::Planning
                } else {
                    TaskPhase::Working
                };
            }
            inner.snapshot.message = if method == "rephrase" {
                "Revise the task request"
            } else {
                "Starting selected task method"
            }
            .into();
        }
        agent.send(&DesktopHostInput::Method {
            task_id: task_id.into(),
            question_id: question_id.into(),
            method: method.into(),
            split_screen: split,
        })
    }

    fn control_task(&self, task_id: Option<&str>, command: &str) -> Result<()> {
        let current_id = {
            let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            let Some(current_id) = inner.snapshot.task.as_ref().map(|task| task.id.clone()) else {
                return Ok(());
            };
            if task_id.is_some_and(|id| id != current_id) {
                return Err("task control belongs to a stale task".into());
            }
            if inner
                .snapshot
                .task
                .as_ref()
                .is_some_and(|task| task.phase.terminal())
            {
                return Ok(());
            }
            let task_message = match command {
                "pause" => "Task paused",
                "resume" => "Inspecting current task state",
                "stop" => "Task stopped",
                _ => return Err("unknown task control".into()),
            };
            if command != "resume" {
                inner.snapshot.voice.session_id = inner.snapshot.voice.session_id.wrapping_add(1);
            }
            if let Some(task) = inner.snapshot.task.as_mut() {
                task.phase = match command {
                    "pause" => TaskPhase::Paused,
                    "resume" => TaskPhase::Working,
                    _ => TaskPhase::Stopped,
                };
                task.message = task_message.into();
                if command == "stop" {
                    task.verified = false;
                }
            }
            match command {
                "pause" => {
                    inner.snapshot.question = None;
                    inner.pending_approval = None;
                    inner.desktop_approval = None;
                    inner.capture = None;
                    inner.snapshot.overlay.clear_target();
                }
                "resume" => {}
                "stop" => {
                    inner.task_generation = inner.task_generation.wrapping_add(1);
                    inner.snapshot.question = None;
                    inner.pending_approval = None;
                    inner.native_session_id = None;
                    inner.active_target_id = None;
                    inner.step = None;
                    inner.selected_file = None;
                    inner.snapshot.attachments.clear();
                    inner.snapshot.overlay.clear_target();
                }
                _ => unreachable!(),
            }
            current_id
        };
        let agent = self.current_agent()?;
        if command == "pause"
            && self
                .assist
                .status()
                .is_ok_and(|status| status.phase == "active")
        {
            self.assist.pause()?;
        }
        if command == "stop" {
            let _ = self.assist.stop("Task stopped by user");
        }
        let input = match command {
            "pause" => DesktopHostInput::Pause {
                task_id: current_id,
            },
            "resume" => DesktopHostInput::Resume {
                task_id: current_id,
            },
            _ => DesktopHostInput::Stop {
                task_id: current_id,
            },
        };
        agent.send(&input)
    }

    fn control_all(&self, task_id: Option<&str>, command: &str) -> Result<()> {
        let paused = *self
            .gui
            .is_paused
            .lock()
            .map_err(|_| "GUI pause state poisoned")?;
        if command == "pause" && !paused {
            let running = self
                .inner
                .lock()
                .map_err(|_| "runtime state poisoned")?
                .snapshot
                .head
                .enabled;
            if running {
                self.set_head(false)?;
            }
            self.inner
                .lock()
                .map_err(|_| "runtime state poisoned")?
                .resume_head = running;
            self.gui.pause_all()?;
        } else if command == "resume" && paused {
            self.gui.pause_all()?;
            let resume = self
                .inner
                .lock()
                .map_err(|_| "runtime state poisoned")?
                .resume_head;
            if resume {
                self.set_head(true)?;
            }
        }
        self.control_task(task_id, command)
    }

    pub fn head_config(&self) -> Result<crate::control::Config> {
        let settings = self.gui.get_settings()?;
        let config = crate::control::Config {
            dwell_ms: (settings.dwell_time * 1000.0).round() as u64,
            max_speed: 400.0 + 14.0 * f64::from(settings.sensitivity),
            range: (0.42 - 0.0028 * f64::from(settings.sensitivity)).max(0.15),
            ..Default::default()
        };
        config.validate()?;
        Ok(config)
    }

    fn ensure_agent(self: &Arc<Self>) -> Result<Arc<AgentProcess>> {
        let mut slot = self
            .agent
            .lock()
            .map_err(|_| "desktop host lock poisoned")?;
        if let Some(agent) = slot.as_ref() {
            return Ok(agent.clone());
        }
        let runtime = Arc::downgrade(self);
        let agent = AgentProcess::spawn(move |output| {
            if let Some(runtime) = runtime.upgrade() {
                runtime.handle_agent_output(output);
            }
        })?;
        *slot = Some(agent.clone());
        Ok(agent)
    }

    fn current_agent(&self) -> Result<Arc<AgentProcess>> {
        self.agent
            .lock()
            .map_err(|_| "desktop host lock poisoned")?
            .as_ref()
            .cloned()
            .ok_or_else(|| "desktop host is not running".into())
    }

    fn handle_agent_output(self: &Arc<Self>, output: DesktopHostOutput) {
        match output {
            DesktopHostOutput::Ready => {}
            DesktopHostOutput::NativeRequest {
                id,
                task_id,
                command,
            } => {
                if !valid_id(&id) || !valid_id(&task_id) || !self.task_is_current(&task_id, None) {
                    return;
                }
                let runtime = Arc::downgrade(self);
                thread::Builder::new()
                    .name("kaji-native-request".into())
                    .spawn(move || {
                        if let Some(runtime) = runtime.upgrade() {
                            runtime.execute_native_request(id, task_id, command);
                        }
                    })
                    .ok();
            }
            DesktopHostOutput::Update {
                task_id,
                phase,
                message,
                question,
                step,
            } => {
                self.handle_task_update(
                    &task_id,
                    phase,
                    message,
                    question.map(|question| *question),
                    step.map(|step| *step),
                );
            }
            DesktopHostOutput::Result {
                task_id,
                phase,
                message,
                verified,
            } => {
                self.handle_task_result(&task_id, phase, &message, verified);
            }
            DesktopHostOutput::Error { task_id, message } => {
                if let Some(task_id) = task_id {
                    self.finish_local_error(&task_id, one_line(&message));
                } else {
                    self.set_message(&one_line(&message));
                }
            }
        }
    }

    fn handle_task_update(
        self: &Arc<Self>,
        task_id: &str,
        phase: Option<TaskPhase>,
        message: Option<String>,
        question: Option<HostQuestion>,
        step: Option<TaskStep>,
    ) {
        if let Some(question) = &question
            && question.kind == QuestionKind::Method
        {
            let valid = self.task_context().is_ok_and(|context| {
                question.options.iter().all(|option| {
                    context["executors"]
                        .as_array()
                        .is_some_and(|items| items.iter().any(|item| item["id"] == option.value))
                })
            });
            if !valid {
                self.finish_local_error(task_id, "Task offered an unavailable executor".into());
                return;
            }
        }
        let mut changed = false;
        let mut spoken = None;
        if let Ok(mut inner) = self.inner.lock()
            && inner
                .snapshot
                .task
                .as_ref()
                .is_some_and(|task| task.id == task_id && task.phase.active())
        {
            if let Some(task) = inner.snapshot.task.as_mut() {
                if let Some(phase) = phase {
                    task.phase = phase;
                }
                if let Some(message) = message {
                    task.message = one_line(&message).chars().take(800).collect();
                    inner.snapshot.message = task.message.clone();
                }
            }
            if let Some(question) = question {
                if validate_host_question(&question).is_ok() {
                    let question = question.into_pending(task_id.into());
                    let mut task_phase = TaskPhase::AwaitingUser;
                    if question.kind == QuestionKind::Method {
                        task_phase = TaskPhase::AwaitingMethod;
                    } else if question.kind == QuestionKind::Approval {
                        task_phase = TaskPhase::AwaitingConfirmation;
                    }
                    if let Some(task) = inner.snapshot.task.as_mut() {
                        task.phase = task_phase;
                        task.message = question.title.clone();
                    }
                    inner.snapshot.message = question.title.clone();
                    spoken = Some(question.title.clone());
                    inner.snapshot.question = Some(question);
                } else {
                    inner.snapshot.message = "Task asked an invalid question".into();
                }
            } else if phase.is_some() {
                inner.snapshot.question = None;
            }
            if let Some(step) = step {
                inner.step = Some(step);
                if let Ok(status) = self.assist.status()
                    && let Some(cursor) = status.cursor
                {
                    inner.snapshot.overlay.point_at(&cursor);
                }
            }
            inner.snapshot.overlay.mode = if inner
                .snapshot
                .task
                .as_ref()
                .is_some_and(|task| task.phase == TaskPhase::Paused)
            {
                if inner.snapshot.overlay.cursor_enabled || inner.snapshot.overlay.highlight_enabled
                {
                    OverlayMode::Follow
                } else {
                    OverlayMode::Hidden
                }
            } else if inner.snapshot.overlay.mode == OverlayMode::Task
                && (inner.snapshot.overlay.target.is_some()
                    || !inner.snapshot.overlay.target_label.is_empty())
            {
                OverlayMode::Task
            } else {
                OverlayMode::Follow
            };
            inner.snapshot.revision = inner.snapshot.revision.wrapping_add(1);
            changed = true;
        }
        if changed {
            self.emit_current();
            if let (Some(task), Some(text)) = (
                self.inner.lock().ok().and_then(|inner| {
                    inner
                        .snapshot
                        .task
                        .as_ref()
                        .map(|task| task.conversation_id.clone())
                }),
                spoken,
            ) {
                self.speak(&task, &text);
            }
        }
    }

    fn handle_task_result(
        self: &Arc<Self>,
        task_id: &str,
        phase: TerminalPhase,
        message: &str,
        verified: bool,
    ) {
        let mut conversation_id = None;
        let mut request_text = None;
        let mut artifacts = Vec::new();
        let mut result_window = None;
        let text = one_line(message);
        let mut changed = false;
        if let Ok(mut inner) = self.inner.lock()
            && let Some(task) = inner
                .snapshot
                .task
                .as_mut()
                .filter(|task| task.id == task_id && task.phase.active())
        {
            task.phase = phase.into();
            task.message = text.chars().take(800).collect();
            task.verified = verified && phase == TerminalPhase::Complete;
            conversation_id = Some(task.conversation_id.clone());
            request_text = Some(task.request.clone());
            artifacts = task
                .artifacts
                .iter()
                .cloned()
                .map(history_artifact)
                .collect();
            inner.snapshot.message = task.message.clone();
            if phase == TerminalPhase::Complete {
                result_window = inner.active_target_id.clone();
            }
            inner.snapshot.question = None;
            inner.pending_approval = None;
            inner.native_session_id = None;
            inner.active_target_id = None;
            inner.step = None;
            inner.selected_file = None;
            inner.snapshot.attachments.clear();
            inner.snapshot.overlay.clear_target();
            inner.snapshot.revision = inner.snapshot.revision.wrapping_add(1);
            changed = true;
        }
        if let Some(conversation_id) = conversation_id {
            let _ = self.history.append_message(
                &conversation_id,
                Some(task_id),
                MessageRole::Assistant,
                &text,
                &artifacts,
            );
            if let Some(request) = request_text {
                self.maybe_title(&conversation_id, &request, &text);
            }
            self.speak(&conversation_id, &text);
        }
        if changed {
            if phase == TerminalPhase::Complete {
                let presented = if let Some(artifact) = artifacts.last() {
                    self.open_artifact(&artifact.id).is_ok()
                } else if let Some(window) = result_window {
                    self.desktop
                        .is_taskbar(&window)
                        .is_ok_and(|taskbar| !taskbar)
                        && self.desktop.switch_window(&window).is_ok()
                } else {
                    false
                };
                if !presented
                    && let Some(app) = self.app.lock().ok().and_then(|app| app.clone())
                    && let Some(window) = app.get_webview_window("main")
                {
                    let _ = window.unminimize();
                    let _ = window.show();
                }
            }
            self.emit_current();
        }
    }

    fn finish_local_error(self: &Arc<Self>, task_id: &str, message: String) {
        let user_message = if message.contains("gateway credential") {
            "Kaji can’t connect to its AI services. Check AI & Models in Settings."
        } else {
            &message
        };
        self.handle_task_result(task_id, TerminalPhase::Error, user_message, false);
    }

    fn execute_native_request(self: &Arc<Self>, id: String, task_id: String, raw: Value) {
        if raw == json!({"command":"stop"})
            && self.inner.lock().is_ok_and(|inner| {
                inner
                    .snapshot
                    .task
                    .as_ref()
                    .is_some_and(|task| task.id == task_id)
            })
        {
            let result = self
                .assist
                .stop("managed task ended")
                .and_then(|status| serde_json::to_value(status).map_err(|error| error.to_string()));
            let response = match result {
                Ok(result) => DesktopHostInput::NativeResponse {
                    id,
                    task_id,
                    result: Some(result),
                    error: None,
                },
                Err(error) => DesktopHostInput::NativeResponse {
                    id,
                    task_id,
                    result: None,
                    error: Some(error),
                },
            };
            if let Ok(agent) = self.current_agent() {
                let _ = agent.send(&response);
            }
            return;
        }
        let generation = match self.task_generation(&task_id) {
            Some(generation) => generation,
            None => return,
        };
        let response = serde_json::from_value::<NativeCommand>(raw)
            .map_err(|error| format!("Native command is invalid: {error}"))
            .and_then(|command| self.execute_native_command(&task_id, generation, command));
        if !self.task_is_current(&task_id, Some(generation)) {
            return;
        }
        if let Ok(mut inner) = self.inner.lock() {
            if response.is_err() {
                inner.snapshot.overlay.clear_target();
            }
            inner.snapshot.revision = inner.snapshot.revision.wrapping_add(1);
        }
        // Publish the target before the agent can dispatch its next command.
        self.emit_current();
        let input = match response {
            Ok(result) => DesktopHostInput::NativeResponse {
                id,
                task_id,
                result: Some(result),
                error: None,
            },
            Err(error) => DesktopHostInput::NativeResponse {
                id,
                task_id,
                result: None,
                error: Some(one_line(&error).chars().take(500).collect()),
            },
        };
        if let Ok(agent) = self.current_agent() {
            let _ = agent.send(&input);
        }
    }

    fn execute_native_command(
        &self,
        task_id: &str,
        generation: u64,
        command: NativeCommand,
    ) -> Result<Value> {
        if !self.task_is_current(task_id, Some(generation)) {
            return Err("native command belongs to an expired task".into());
        }
        let paused = self
            .inner
            .lock()
            .map_err(|_| "runtime state poisoned")?
            .snapshot
            .task
            .as_ref()
            .is_some_and(|task| task.phase == TaskPhase::Paused);
        if paused
            && !matches!(
                &command,
                NativeCommand::Status
                    | NativeCommand::Pause
                    | NativeCommand::Resume { .. }
                    | NativeCommand::Stop
            )
        {
            return Err("task is paused".into());
        }
        match command {
            NativeCommand::ComposerControl { placement, seconds } => {
                let app = self
                    .app
                    .lock()
                    .map_err(|_| "app state poisoned")?
                    .clone()
                    .ok_or("app unavailable")?;
                crate::composer::control(&app, placement, seconds)
            }
            NativeCommand::TaskContext => self.task_context(),
            NativeCommand::SelectExecutor { executor_id } => {
                if !self.task_context()?["executors"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item["id"] == executor_id))
                {
                    return Err("executor is unavailable".into());
                }
                let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
                if inner
                    .snapshot
                    .question
                    .as_ref()
                    .is_some_and(|question| question.kind == QuestionKind::Method)
                {
                    return Err("user method selection is pending".into());
                }
                let task = inner
                    .snapshot
                    .task
                    .as_mut()
                    .filter(|task| task.id == task_id)
                    .ok_or("task expired")?;
                if task
                    .method
                    .as_ref()
                    .is_some_and(|current| current != &executor_id)
                {
                    return Err("a different executor was selected for this task".into());
                }
                task.method = Some(executor_id.clone());
                Ok(json!({"executor": executor_id}))
            }
            NativeCommand::Begin { hwnd, mode } => {
                self.require_app_integration()?;
                let target_id = self
                    .inner
                    .lock()
                    .map_err(|_| "runtime state poisoned")?
                    .active_target_id
                    .clone()
                    .ok_or("task has no verified target window")?;
                let expected_hwnd = self.desktop.native_handle(&target_id)? as u64;
                if expected_hwnd != hwnd {
                    return Err("native session target does not match the verified window".into());
                }
                let expected_mode = self
                    .inner
                    .lock()
                    .map_err(|_| "runtime state poisoned")?
                    .snapshot
                    .task
                    .as_ref()
                    .map(|task| task.mode)
                    .ok_or("task no longer exists")?;
                if mode != expected_mode {
                    return Err("native session mode does not match active task".into());
                }
                if let Ok(mut inner) = self.inner.lock() {
                    inner.uia_attempted = true;
                }
                let status = self.assist.begin_with_mode(hwnd as isize, mode)?;
                if !self.task_is_current(task_id, Some(generation)) {
                    let _ = self
                        .assist
                        .stop("task expired during native initialization");
                    return Err("native session initialization was cancelled".into());
                }
                if let Ok(mut inner) = self.inner.lock() {
                    inner.native_session_id = Some(status.session);
                }
                serde_json::to_value(status).map_err(|e| e.to_string())
            }
            NativeCommand::Inspect { session } => {
                self.check_session(session)?;
                if let Ok(mut inner) = self.inner.lock() {
                    inner.uia_attempted = true;
                    inner.snapshot.overlay.clear_target();
                }
                serde_json::to_value(self.assist.inspect(session)?).map_err(|e| e.to_string())
            }
            NativeCommand::Point {
                session,
                element_id,
            } => {
                self.check_session(session)?;
                let cursor = self.assist.point(session, &element_id)?;
                if let Ok(mut inner) = self.inner.lock() {
                    inner.snapshot.overlay.point_at(&cursor);
                }
                serde_json::to_value(cursor).map_err(|e| e.to_string())
            }
            NativeCommand::Invoke { session, revision } => {
                self.require_executor(task_id, "native")?;
                self.check_session(session)?;
                let status = self.assist.act_reviewed(
                    session,
                    revision,
                    crate::uia::Action::Invoke {},
                    Some(self.review_policy()?),
                )?;
                self.capture_pending_approval(&status);
                serde_json::to_value(status).map_err(|e| e.to_string())
            }
            NativeCommand::Act {
                session,
                revision,
                action,
            } => {
                self.require_executor(task_id, "native")?;
                self.check_session(session)?;
                let status = self.assist.act_reviewed(
                    session,
                    revision,
                    action,
                    Some(self.review_policy()?),
                )?;
                self.capture_pending_approval(&status);
                serde_json::to_value(status).map_err(|e| e.to_string())
            }
            NativeCommand::Status => {
                let inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
                if inner.native_session_id.is_none() {
                    let task = inner.snapshot.task.as_ref().ok_or("task expired")?;
                    return Ok(
                        json!({"session":0,"phase":if task.phase == TaskPhase::Paused {"paused"} else {"active"},"reason":"Task executor ready","hwnd":0,"cursor":null,"physical_cursor":null,"foreground_hwnd":0,"last_backend":null,"actions":0,"inspection_required":false,"verification_pending":inner.physical_needs_verification,"last_outcome":null,"mode":task.mode,"confirmation":null}),
                    );
                }
                drop(inner);
                serde_json::to_value(self.assist.status()?).map_err(|e| e.to_string())
            }
            NativeCommand::Confirm {
                session,
                confirmation_id,
            } => {
                self.check_session(session)?;
                {
                    let inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
                    let approval = inner
                        .pending_approval
                        .as_ref()
                        .ok_or("native confirmation has no user approval")?;
                    if approval.native_id != confirmation_id
                        || approval.approved_id.as_deref() != Some(&confirmation_id)
                    {
                        return Err(
                            "native confirmation does not match the approved question".into()
                        );
                    }
                }
                if let Ok(mut inner) = self.inner.lock() {
                    inner.pending_approval = None;
                }
                serde_json::to_value(self.assist.confirm(session, &confirmation_id)?)
                    .map_err(|e| e.to_string())
            }
            NativeCommand::Pause => {
                if self
                    .inner
                    .lock()
                    .map_err(|_| "runtime state poisoned")?
                    .native_session_id
                    .is_none()
                {
                    return self.execute_native_command(task_id, generation, NativeCommand::Status);
                }
                serde_json::to_value(self.assist.pause()?).map_err(|e| e.to_string())
            }
            NativeCommand::Resume { session } => {
                if session == 0
                    && self
                        .inner
                        .lock()
                        .map_err(|_| "runtime state poisoned")?
                        .native_session_id
                        .is_none()
                {
                    if let Some(task) = self
                        .inner
                        .lock()
                        .map_err(|_| "runtime state poisoned")?
                        .snapshot
                        .task
                        .as_mut()
                    {
                        task.phase = TaskPhase::Working;
                    }
                    return self.execute_native_command(task_id, generation, NativeCommand::Status);
                }
                self.check_session(session)?;
                serde_json::to_value(self.assist.resume(session)?).map_err(|e| e.to_string())
            }
            NativeCommand::Stop => serde_json::to_value(self.assist.stop("task requested stop")?)
                .map_err(|e| e.to_string()),
            NativeCommand::ListWindows => {
                self.require_app_integration()?;
                let windows = self.desktop.list_windows()?;
                let foreground = self
                    .desktop
                    .foreground_window()
                    .ok()
                    .map(|window| window.id);
                serde_json::to_value(
                    json!({ "windows": windows, "foregroundWindowId": foreground }),
                )
                .map_err(|e| e.to_string())
            }
            NativeCommand::ListApplications => {
                self.require_app_integration()?;
                let applications = self.desktop.list_applications()?;
                serde_json::to_value(json!({ "applications": applications }))
                    .map_err(|e| e.to_string())
            }
            NativeCommand::BindWindow { window_id } => {
                self.require_app_integration()?;
                let _ = self.assist.stop("task target changed");
                let entry = self.desktop.bind_window(&window_id)?;
                let handle = self.desktop.native_handle(&entry.id)?;
                if let Ok(mut inner) = self.inner.lock() {
                    inner.active_target_id = Some(entry.id.clone());
                    inner.native_session_id = None;
                    inner.pending_approval = None;
                    inner.capture = None;
                    inner.desktop_approval = None;
                    inner.uia_attempted = false;
                    if let Some(task) = inner.snapshot.task.as_mut() {
                        task.target_window = Some(TaskTargetWindow {
                            id: entry.id.clone(),
                            title: entry.title.clone(),
                        });
                    }
                }
                serde_json::to_value(json!({ "window": entry, "hwnd": handle as u64 }))
                    .map_err(|e| e.to_string())
            }
            NativeCommand::ActivateWindow { window_id } => {
                self.require_executor(task_id, "native")?;
                self.require_app_integration()?;
                if !self.input.input_permission {
                    return Err("native input permission is disabled".into());
                }
                let inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
                if inner
                    .snapshot
                    .task
                    .as_ref()
                    .is_none_or(|task| task.mode == Mode::Guide)
                {
                    return Err("Guide mode cannot activate applications".into());
                }
                drop(inner);
                let window = self.desktop.switch_window(&window_id)?;
                Ok(json!({"executed":true,"verified":true,"window":window}))
            }
            NativeCommand::CaptureWindow { window_id } => {
                if !self.gui.get_settings()?.permission_screen {
                    return Err("screen capture permission is disabled".into());
                }
                self.require_app_integration()?;
                if !self.vision_available()? {
                    return Err("vision capability is unavailable".into());
                }
                let entry = self.desktop.bind_window(&window_id)?;
                {
                    let inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
                    if !inner.uia_attempted || inner.active_target_id.as_deref() != Some(&window_id)
                    {
                        return Err(
                            "attempt semantic inspection on this window before vision fallback"
                                .into(),
                        );
                    }
                }
                let png = self.desktop.capture_target(&window_id)?;
                if png.len() > 384 * 1024 {
                    return Err("window capture exceeds the vision image limit".into());
                }
                let id = new_id("capture");
                let foreground = native::foreground();
                let foreground_window = if self.desktop.is_taskbar(&window_id)? {
                    self.desktop.window_by_handle(foreground).ok()
                } else {
                    None
                };
                let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
                let changed = inner.physical_needs_verification
                    && inner.capture.as_ref().is_some_and(|capture| {
                        capture.window_id == window_id
                            && (capture.png != png
                                || (capture.foreground != foreground
                                    && foreground_window
                                        .as_ref()
                                        .is_some_and(|window| window.id != window_id)))
                    });
                inner.physical_needs_verification = !changed && inner.physical_needs_verification;
                inner.capture = Some(CaptureLease {
                    id: id.clone(),
                    window_id: window_id.clone(),
                    bounds: entry.bounds,
                    png: png.clone(),
                    created: Instant::now(),
                    activity: self.input.signals.target_activity.load(Ordering::SeqCst),
                    foreground,
                });
                Ok(
                    json!({"captureId":id,"windowId":window_id,"bounds":entry.bounds,"pngBase64":base64_encode(&png),"changedAfterAction":changed,"foregroundWindow":foreground_window}),
                )
            }
            NativeCommand::ProposePhysical { capture_id, action } => {
                let capture = self
                    .inner
                    .lock()
                    .map_err(|_| "runtime state poisoned")?
                    .capture
                    .clone()
                    .filter(|capture| capture.id == capture_id)
                    .ok_or("capture expired")?;
                self.propose_desktop_action(
                    task_id,
                    capture.window_id.clone(),
                    Some(capture),
                    action,
                )
            }
            NativeCommand::ExecutePhysical { approval_id } => {
                self.execute_desktop_action(task_id, generation, &approval_id)
            }
            NativeCommand::DocumentEdit { operations } => {
                self.require_document_write(task_id)?;
                if self.current_method(task_id).as_deref() != Some("python_docx") {
                    return Err("Python DOCX adapter was not selected for this task".into());
                }
                let source = self
                    .inner
                    .lock()
                    .map_err(|_| "runtime state poisoned")?
                    .selected_file
                    .clone()
                    .ok_or("select a DOCX before editing")?;
                let artifact = self.documents.execute(
                    task_id,
                    Some(&source),
                    DocumentJob::Edit {
                        source: source.clone(),
                        operations,
                    },
                    || self.work_is_current(task_id, generation),
                )?;
                self.add_artifact(task_id, artifact.clone())?;
                serde_json::to_value(artifact).map_err(|e| e.to_string())
            }
            NativeCommand::DocumentCreate { blocks } => {
                self.require_document_write(task_id)?;
                if self.current_method(task_id).as_deref() != Some("python_docx") {
                    return Err("Python DOCX adapter was not selected for this task".into());
                }
                let artifact = self.documents.execute(
                    task_id,
                    None,
                    DocumentJob::Create { blocks },
                    || self.work_is_current(task_id, generation),
                )?;
                self.add_artifact(task_id, artifact.clone())?;
                serde_json::to_value(artifact).map_err(|e| e.to_string())
            }
            NativeCommand::DocumentInspect => {
                let source = self
                    .inner
                    .lock()
                    .map_err(|_| "runtime state poisoned")?
                    .selected_file
                    .clone()
                    .ok_or("select a document first")?;
                self.documents
                    .inspect(&source, || self.task_is_current(task_id, Some(generation)))
            }
        }
    }

    fn require_executor(&self, task_id: &str, executor: &str) -> Result<()> {
        if executor == "native" {
            let settings = self.gui.get_settings()?;
            if !settings.permission_input || !settings.capabilities_actions {
                return Err("native actions are disabled in settings".into());
            }
        }
        if self.current_method(task_id).as_deref() == Some(executor) {
            Ok(())
        } else {
            Err("select an applicable executor before acting".into())
        }
    }

    fn vision_available(&self) -> Result<bool> {
        let settings = self.gui.get_settings()?;
        Ok(settings.permission_screen
            && settings.capabilities_vision
            && self
                .inner
                .lock()
                .map_err(|_| "runtime state poisoned")?
                .snapshot
                .services
                .as_ref()
                .is_some_and(|services| services.vision.available))
    }

    fn propose_desktop_action(
        &self,
        task_id: &str,
        window_id: String,
        capture: Option<CaptureLease>,
        action: PhysicalAction,
    ) -> Result<Value> {
        self.require_executor(task_id, "native")?;
        if !self.input.input_permission {
            return Err("native input permission is disabled".into());
        }
        let window = self.desktop.bind_window(&window_id)?;
        if !matches!(action, PhysicalAction::Activate)
            && (!self.vision_available()? || capture.is_none())
        {
            return Err("a fresh vision capture is required".into());
        }
        match &action {
            PhysicalAction::Click { x, y } | PhysicalAction::Scroll { x, y, .. }
                if !x.is_finite()
                    || !y.is_finite()
                    || !window
                        .bounds
                        .contains(crate::control::Point { x: *x, y: *y }) =>
            {
                return Err("physical target is outside the captured window".into());
            }
            PhysicalAction::TypeText { text }
                if text.is_empty() || text.len() > 120 || text.contains('\0') =>
            {
                return Err("physical text exceeds its bound".into());
            }
            PhysicalAction::Scroll { delta, .. } if *delta == 0 || delta.unsigned_abs() > 1200 => {
                return Err("physical scroll exceeds its bound".into());
            }
            _ => {}
        }
        let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
        if inner
            .snapshot
            .task
            .as_ref()
            .is_none_or(|task| task.id != task_id || task.mode == Mode::Guide)
        {
            return Err("Guide mode cannot use physical actions".into());
        }
        if inner.pending_approval.is_some() {
            return Err("an action approval is already pending".into());
        }
        let id = new_id("desktop-approval");
        inner.pending_approval = Some(PendingApproval {
            native_id: id.clone(),
            approved_id: None,
        });
        inner.desktop_approval = Some(DesktopApproval {
            id: id.clone(),
            window_id,
            capture,
            action: action.clone(),
            created: Instant::now(),
        });
        if let PhysicalAction::Click { x, y } | PhysicalAction::Scroll { x, y, .. } = action {
            inner.snapshot.overlay.point = Some(crate::control::Point { x, y });
            inner.snapshot.overlay.target = None;
            inner.snapshot.overlay.dwell_progress = 0.;
            inner.snapshot.overlay.target_label = window.title.clone();
            inner.snapshot.overlay.mode = OverlayMode::Task;
        }
        Ok(
            json!({"approvalId":id,"title":format!("Approve {:?} in {}?",action,window.title.chars().take(40).collect::<String>())}),
        )
    }

    fn execute_desktop_action(
        &self,
        task_id: &str,
        generation: u64,
        approval_id: &str,
    ) -> Result<Value> {
        let pending = {
            let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            let approval = inner
                .pending_approval
                .take()
                .ok_or("desktop approval expired")?;
            let pending = inner
                .desktop_approval
                .take()
                .ok_or("desktop action expired")?;
            if approval.native_id != approval_id
                || approval.approved_id.as_deref() != Some(approval_id)
                || pending.id != approval_id
                || pending.created.elapsed() > Duration::from_secs(30)
            {
                return Err("desktop approval is missing, expired or mismatched".into());
            }
            pending
        };
        self.input.with_physical_action(|| {
            let target = self.desktop.bind_window(&pending.window_id)?;
            if let Some(capture) = &pending.capture
                && (capture.created.elapsed()>Duration::from_secs(30) || capture.bounds!=target.bounds || capture.activity!=self.input.signals.target_activity.load(Ordering::SeqCst) || capture.png!=self.desktop.capture_target(&pending.window_id)?) {
                return Err("captured target changed; inspect again".into());
            }
            let manual = self.input.signals.manual.load(Ordering::SeqCst);
            let check = || {
                if !self.work_is_current(task_id,generation) || self.input.signals.emergency.load(Ordering::SeqCst) || !self.input.signals.observer_alive.load(Ordering::SeqCst) || self.input.signals.manual.load(Ordering::SeqCst)!=manual || native::modifiers_down() { return Err("physical action cancelled by operator or native state".into()); }
                native::interactive_desktop()
            };
            check()?;
            if self.engine.status().is_ok_and(|state| state.phase != "stopped") { return Err("pause head control before physical input handoff".into()); }
            let taskbar_click = matches!(pending.action, PhysicalAction::Click { .. })
                && self.desktop.is_taskbar(&pending.window_id)?;
            if !taskbar_click {
                self.desktop.switch_window(&pending.window_id)?;
            }
            check()?;
            match &pending.action {
                PhysicalAction::Activate => {},
                PhysicalAction::Click{x,y} => {
                    let point = crate::control::Point{x:*x,y:*y};
                    native::move_to(point,&native::monitors()?)?;
                    check()?;
                    if native::window_at(point) != self.desktop.native_handle(&pending.window_id)? {
                        return Err("click target is covered by another window; inspect again".into());
                    }
                    native::click()?;
                },
                PhysicalAction::TypeText{text} => native::type_text(text,check)?,
                PhysicalAction::Key{key} => native::press_key(key)?,
                PhysicalAction::Scroll{x,y,delta} => {native::move_to(crate::control::Point{x:*x,y:*y},&native::monitors()?)?;check()?;native::scroll(*delta)?;},
            }
            if let Ok(mut inner)=self.inner.lock() { inner.physical_needs_verification = !matches!(pending.action,PhysicalAction::Activate); inner.native_session_id=None; }
            Ok(json!({"executed":true,"verified":matches!(pending.action,PhysicalAction::Activate),"requiresFreshObservation":!matches!(pending.action,PhysicalAction::Activate)}))
        })
    }

    fn require_document_write(&self, task_id: &str) -> Result<()> {
        let inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
        if inner
            .snapshot
            .task
            .as_ref()
            .is_none_or(|task| task.id != task_id || task.mode == Mode::Guide)
        {
            return Err("Guide mode cannot write documents".into());
        }
        Ok(())
    }

    fn task_context(&self) -> Result<Value> {
        let settings = self.gui.get_settings()?;
        let response_language = settings.response_language.clone();
        let mode = self
            .inner
            .lock()
            .map_err(|_| "runtime state poisoned")?
            .snapshot
            .mode;
        let mut executors = Vec::new();
        if settings.permission_apps {
            let mut capabilities = vec!["uia.read", "applications.bind"];
            if mode != Mode::Guide
                && self.input.input_permission
                && settings.permission_input
                && settings.capabilities_actions
            {
                capabilities.push("uia.write");
            }
            executors.push(json!({"id":"native","label":"Native computer use","capabilities":capabilities,"background":true}));
        }
        if self.documents.is_available() {
            let mut capabilities = vec!["docx.inspect"];
            if mode != Mode::Guide {
                capabilities.extend(["docx.edit_copy", "docx.create"]);
            }
            executors.push(json!({"id":"python_docx","label":"Python document processing","capabilities":capabilities,"background":true}));
        }
        let inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
        Ok(
            json!({"executors":executors,"responseLanguage":response_language,"userWindow":inner.user_window_id,"targetWindow":inner.active_target_id,"selectedFile":inner.selected_file.as_ref().map(|path|json!({"name":path.file_name().map(|name|name.to_string_lossy()),"extension":path.extension().map(|name|name.to_string_lossy())})),"vision":inner.snapshot.services.as_ref().is_some_and(|services|services.vision.available),
                "mode":mode,
                "voice":{
                    "wakePhrase":"Hey Kaji", "wakeEnabled":settings.voice_activation,
                    "listening":inner.snapshot.voice.enabled && matches!(inner.snapshot.voice.phase, VoicePhase::Wake | VoicePhase::Listening),
                    "recognitionLanguage":settings.recognition_language,
                    "recognitionLanguages":["English", "Bahasa Indonesia"],
                    "transcriptionAvailable":inner.snapshot.services.as_ref().is_some_and(|services|services.stt.available),
                    "spokenFeedbackEnabled":settings.voice_feedback,
                    "spokenFeedbackAvailable":inner.snapshot.services.as_ref().is_some_and(|services|services.tts.service.available)
                },
                "headControl":{"enabled":inner.snapshot.head.enabled,"active":inner.snapshot.head.active,"dwellEnabled":inner.snapshot.head.dwell_enabled}
            }),
        )
    }

    fn capture_pending_approval(&self, status: &crate::assist::Status) {
        if let Some(confirmation) = &status.confirmation
            && let Ok(mut inner) = self.inner.lock()
        {
            inner.pending_approval = Some(PendingApproval {
                native_id: confirmation.id.clone(),
                approved_id: None,
            });
        }
    }

    fn review_policy(&self) -> Result<crate::review::ReviewPolicy> {
        Ok(
            if self.gui.get_settings()?.confirmation_policy == "full_access" {
                crate::review::ReviewPolicy::FullAccess
            } else {
                crate::review::ReviewPolicy::Auto
            },
        )
    }

    fn check_session(&self, session: u64) -> Result<()> {
        if self
            .inner
            .lock()
            .map_err(|_| "runtime state poisoned")?
            .native_session_id
            == Some(session)
        {
            Ok(())
        } else {
            Err("native session is stale or belongs to another task".into())
        }
    }

    fn require_app_integration(&self) -> Result<()> {
        if self.gui.get_settings()?.permission_apps {
            Ok(())
        } else {
            Err("application integration permission is disabled".into())
        }
    }

    fn current_method(&self, task_id: &str) -> Option<String> {
        self.inner
            .lock()
            .ok()?
            .snapshot
            .task
            .as_ref()
            .filter(|task| task.id == task_id && task.phase.active())
            .and_then(|task| task.method.clone())
    }

    fn add_artifact(
        &self,
        task_id: &str,
        artifact: crate::document_worker::DocxArtifact,
    ) -> Result<()> {
        let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
        let task = inner
            .snapshot
            .task
            .as_mut()
            .filter(|task| task.id == task_id && task.phase.active())
            .ok_or("document task expired before artifact registration")?;
        task.artifacts.push(ArtifactReference {
            id: artifact.id,
            name: artifact.name,
            path: artifact.path,
            kind: history::ArtifactKind::Docx,
        });
        Ok(())
    }

    fn task_generation(&self, task_id: &str) -> Option<u64> {
        let inner = self.inner.lock().ok()?;
        inner
            .snapshot
            .task
            .as_ref()
            .filter(|task| task.id == task_id && task.phase.active())
            .map(|_| inner.task_generation)
    }

    fn task_is_current(&self, task_id: &str, generation: Option<u64>) -> bool {
        self.task_generation(task_id)
            .is_some_and(|current| generation.is_none_or(|expected| expected == current))
    }

    fn work_is_current(&self, task_id: &str, generation: u64) -> bool {
        if self.input.signals.emergency.load(Ordering::SeqCst) {
            return false;
        }
        self.inner.lock().is_ok_and(|inner| {
            inner.task_generation == generation
                && inner.snapshot.task.as_ref().is_some_and(|task| {
                    task.id == task_id && task.phase.active() && task.phase != TaskPhase::Paused
                })
        })
    }

    fn invalidate_task(&self, task_id: &str, reason: &str) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(task) = inner
                .snapshot
                .task
                .as_mut()
                .filter(|task| task.id == task_id && task.phase.active())
        {
            task.phase = TaskPhase::Stopped;
            task.message = one_line(reason);
            task.verified = false;
            inner.snapshot.question = None;
            inner.pending_approval = None;
            inner.native_session_id = None;
            inner.active_target_id = None;
            inner.selected_file = None;
            inner.snapshot.attachments.clear();
            inner.step = None;
            inner.task_generation = inner.task_generation.wrapping_add(1);
            inner.snapshot.voice.session_id = inner.snapshot.voice.session_id.wrapping_add(1);
            inner.snapshot.overlay.clear_target();
        }
        if let Ok(agent) = self.current_agent() {
            let _ = agent.send(&DesktopHostInput::Stop {
                task_id: task_id.into(),
            });
        }
    }

    fn set_message(&self, message: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.snapshot.message = one_line(message).chars().take(800).collect();
            inner.snapshot.revision = inner.snapshot.revision.wrapping_add(1);
        }
        self.emit_current();
    }

    fn bump_revision(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.snapshot.revision = inner.snapshot.revision.wrapping_add(1);
        }
    }

    fn emit_current(&self) {
        let Some(app) = self.app.lock().ok().and_then(|app| app.clone()) else {
            return;
        };
        let snapshot = self.snapshot();
        let _ = app.emit_to("main", RUNTIME_UPDATE_EVENT, &snapshot);
        let _ = app.emit_to(
            "audio",
            RUNTIME_UPDATE_EVENT,
            audio_snapshot(snapshot.clone()),
        );
        let _ = app.emit_to("overlay", OVERLAY_UPDATE_EVENT, &snapshot.overlay);
    }

    fn follow_overlay_tick(&self, refresh_display: bool) {
        // User input invalidates a Guide target without another agent command.
        let invalidated = self.inner.lock().is_ok_and(|mut inner| {
            if inner.snapshot.overlay.mode == OverlayMode::Task
                && inner.snapshot.overlay.target.is_some()
                && inner.native_session_id.is_some()
                && self
                    .assist
                    .status()
                    .is_ok_and(|status| status.cursor.is_none())
            {
                inner.snapshot.overlay.clear_target();
                true
            } else {
                false
            }
        });
        if invalidated {
            self.emit_current();
        }
        let Ok(inner) = self.inner.lock() else {
            return;
        };
        if inner.snapshot.overlay.mode != OverlayMode::Follow
            || (!inner.snapshot.overlay.cursor_enabled && !inner.snapshot.overlay.highlight_enabled)
        {
            return;
        }
        let mut overlay = inner.snapshot.overlay.clone();
        let head_enabled = inner.snapshot.head.enabled;
        drop(inner);
        let point = if head_enabled {
            match native::cursor() {
                Ok(point) => Some(point),
                Err(_) => return,
            }
        } else {
            None
        };
        let previous = overlay.clone();
        overlay.point = point;
        let status = head_enabled.then(|| self.engine.status().ok()).flatten();
        overlay.target = status.as_ref().and_then(|status| status.dwell_target);
        overlay.dwell_progress = status.as_ref().map_or(0., |status| status.dwell_progress);
        overlay.target_label = if overlay.target.is_some() {
            "Hold still to click".into()
        } else {
            String::new()
        };
        if previous == overlay && !refresh_display {
            return;
        }
        if !head_enabled
            || refresh_display
            || overlay.viewport.is_none_or(|viewport| {
                let Some(point) = point else {
                    return false;
                };
                point.x < f64::from(viewport.left)
                    || point.y < f64::from(viewport.top)
                    || point.x >= f64::from(viewport.left) + viewport.width
                    || point.y >= f64::from(viewport.top) + viewport.height
            })
        {
            self.apply_overlay_geometry(&mut overlay);
        }
        if previous == overlay {
            return;
        }
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.snapshot.overlay.mode != OverlayMode::Follow
            || (!inner.snapshot.overlay.cursor_enabled && !inner.snapshot.overlay.highlight_enabled)
        {
            return;
        }
        inner.snapshot.overlay = overlay.clone();
        drop(inner);
        if let Some(app) = self.app.lock().ok().and_then(|app| app.clone()) {
            let _ = app.emit_to("overlay", OVERLAY_UPDATE_EVENT, &overlay);
        }
    }

    fn publish_head_state(&self) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if !inner.snapshot.head.enabled {
            return;
        }
        let Ok(status) = self.engine.status() else {
            return;
        };
        let head = &mut inner.snapshot.head;
        let samples = status.calibration_samples.min(u32::MAX as usize) as u32;
        if (
            head.phase.as_str(),
            head.reason.as_str(),
            head.calibration_samples,
            head.dwell_ready,
        ) == (
            status.phase.as_str(),
            status.reason.as_str(),
            samples,
            status.dwell_ready,
        ) {
            return;
        }
        head.phase = status.phase;
        head.reason = status.reason;
        head.calibration_samples = samples;
        head.dwell_ready = status.dwell_ready;
        head.enabled = head.phase != "stopped";
        if !head.enabled && head.reason.starts_with("Camera startup timed out before") {
            let _ = self.emit_sensor_control(json!({ "type": "stop" }));
        }
        inner.snapshot.revision = inner.snapshot.revision.wrapping_add(1);
        drop(inner);
        self.emit_current();
    }

    fn refresh_device_state(&self, snapshot: &mut RuntimeSnapshot) {
        if let Ok(status) = self.engine.status() {
            snapshot.head.session_id = status.session;
            snapshot.head.phase = status.phase.clone();
            snapshot.head.reason = status.reason.clone();
            snapshot.head.active = status.phase == "tracking" || status.phase == "calibrating";
            snapshot.head.cursor = status.cursor;
            snapshot.head.dwell_progress = status.dwell_progress;
            snapshot.head.dwell_ready = status.dwell_ready;
            snapshot.head.enabled &= status.phase != "stopped";
            snapshot.head.calibration_samples =
                status.calibration_samples.min(u32::MAX as usize) as u32;
        }
        if self.gui.is_paused.lock().is_ok_and(|paused| *paused) {
            snapshot.head.phase = "paused".into();
            snapshot.head.active = false;
            snapshot.head.dwell_ready = false;
            snapshot.head.reason = "All actions paused".into();
        }
    }

    fn apply_overlay_geometry(&self, overlay_state: &mut OverlayState) {
        let Some(app) = self.app.lock().ok().and_then(|app| app.clone()) else {
            return;
        };
        let Some(window) = app.get_webview_window("overlay") else {
            return;
        };
        if overlay_state.mode == OverlayMode::Hidden
            || (!overlay_state.cursor_enabled && !overlay_state.highlight_enabled)
        {
            overlay_state.mode = OverlayMode::Hidden;
            overlay_state.viewport = None;
            overlay_state.monitor_scale_factor = None;
            let _ = window.hide();
            return;
        }
        let reference = overlay_state
            .point
            .or_else(|| overlay_state.target.map(|rect| rect.center()));
        let Some(point) = reference else {
            let _ = window.hide();
            return;
        };
        let Ok(displays) = native::displays() else {
            return;
        };
        let Some(display) = displays.iter().copied().min_by(|left, right| {
            display_distance(point, left.bounds).total_cmp(&display_distance(point, right.bounds))
        }) else {
            return;
        };
        let bounds = display.bounds;
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let mut rect = RECT::default();
                let hwnd = HWND(hwnd.0);
                if GetWindowRect(hwnd, &mut rect).is_err()
                    || (rect.left, rect.top, rect.right, rect.bottom)
                        != (bounds.left, bounds.top, bounds.right, bounds.bottom)
                {
                    let _ = SetWindowPos(
                        hwnd,
                        None,
                        bounds.left,
                        bounds.top,
                        bounds.right - bounds.left,
                        bounds.bottom - bounds.top,
                        SWP_NOACTIVATE | SWP_NOZORDER,
                    );
                }
            }
        }
        let scale = window.scale_factor().unwrap_or(display.scale_factor);
        if let Ok(coordinates) = overlay::coordinates_for_display(point, scale, &displays) {
            overlay_state.viewport = Some(coordinates.viewport);
            overlay_state.monitor_scale_factor = Some(coordinates.monitor_scale_factor);
        }
        if !window.is_visible().unwrap_or(false) {
            let _ = window.show();
        }
    }

    fn select_file(&self, docx_only: bool) -> Result<()> {
        let path = match self.show_file_picker(docx_only)? {
            Some(path) => path,
            None => {
                self.set_message("File selection cancelled");
                return Ok(());
            }
        };
        if docx_only
            && path
                .extension()
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("docx"))
        {
            return Err("select a DOCX file".into());
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("selected file name is invalid")?
            .to_owned();
        let clarification = {
            let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            inner.snapshot.attachments = vec![ArtifactReference {
                id: new_id("attachment"),
                name: name.clone(),
                path: path.to_string_lossy().into_owned(),
                kind: if path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("docx"))
                {
                    history::ArtifactKind::Docx
                } else {
                    history::ArtifactKind::File
                },
            }];
            inner.selected_file = Some(path);
            inner
                .snapshot
                .question
                .clone()
                .filter(|question| question.kind == QuestionKind::Clarification)
        };
        self.set_message(&format!("Selected {name}"));
        if let Some(question) = clarification {
            self.answer(
                &question.task_id,
                &question.id,
                &format!("Selected file: {name}"),
            )?;
        }
        Ok(())
    }

    fn show_file_picker(&self, docx_only: bool) -> Result<Option<PathBuf>> {
        native::interactive_desktop()?;
        let app = self
            .app
            .lock()
            .map_err(|_| "runtime app handle lock poisoned")?
            .clone()
            .ok_or("Kaji window is unavailable")?;
        let owner = app
            .get_webview_window("main")
            .ok_or("main window not found")?;
        let owner = HWND(owner.hwnd().map_err(|e| e.to_string())?.0);
        let filter: Vec<u16> = if docx_only {
            "Word documents (*.docx)\0*.docx\0\0"
                .encode_utf16()
                .collect()
        } else {
            "All files (*.*)\0*.*\0\0".encode_utf16().collect()
        };
        let title: Vec<u16> = if docx_only {
            "Select a Word document\0"
        } else {
            "Select a file\0"
        }
        .encode_utf16()
        .collect();
        let mut selected = vec![0u16; 32768];
        let flags = OFN_EXPLORER
            | OFN_FILEMUSTEXIST
            | OFN_PATHMUSTEXIST
            | OFN_HIDEREADONLY
            | OFN_NOCHANGEDIR;
        let mut dialog = OPENFILENAMEW {
            lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
            hwndOwner: owner,
            lpstrFilter: windows::core::PCWSTR(filter.as_ptr()),
            nFilterIndex: 1,
            lpstrFile: windows::core::PWSTR(selected.as_mut_ptr()),
            nMaxFile: selected.len() as u32,
            lpstrTitle: windows::core::PCWSTR(title.as_ptr()),
            Flags: flags,
            ..Default::default()
        };
        if !unsafe { GetOpenFileNameW(&mut dialog) }.as_bool() {
            let error = unsafe { CommDlgExtendedError() };
            if error.0 == 0 {
                return Ok(None);
            }
            return Err(format!("file picker failed: 0x{:08x}", error.0));
        }
        let end = selected
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(selected.len());
        let path = PathBuf::from(String::from_utf16_lossy(&selected[..end]));
        let path = path
            .canonicalize()
            .map_err(|e| format!("selected file path: {e}"))?;
        if !path.is_file() {
            return Err("selected path is not a file".into());
        }
        Ok(Some(path))
    }

    fn set_mode(&self, mode: Mode) -> Result<()> {
        self.gui.set_mode(mode.as_str())?;
        if let Ok(mut inner) = self.inner.lock() {
            inner.snapshot.mode = mode;
            inner.snapshot.message = format!("{} mode selected", mode.as_str());
        }
        Ok(())
    }

    fn set_head(&self, enabled: bool) -> Result<()> {
        if enabled {
            if !self.input.input_permission {
                return Err(
                    "head control needs native input permission enabled before app launch".into(),
                );
            }
            let mut session = self
                .sensor_session
                .lock()
                .map_err(|_| "sensor session lock poisoned")?;
            self.engine.sensor_initializing()?;
            session.authorize_reset();
            drop(session);
            let settings = self.gui.get_settings()?;
            self.emit_sensor_control(json!({
                "type": "reset",
                "cameraDeviceId": settings.camera,
            }))?;
            self.gui.toggle_head_control(true)?;
            self.engine.set_dwell_enabled(true)?;
            if let Ok(mut inner) = self.inner.lock() {
                inner.snapshot.head.enabled = true;
                inner.snapshot.head.dwell_enabled = true;
                inner.snapshot.head.active = false;
                inner.snapshot.head.phase = "initializing".into();
                inner.snapshot.head.reason = "Opening camera and waiting for fresh frames".into();
            }
        } else {
            self.engine.set_dwell_enabled(false)?;
            self.engine.stop_head("Head control disabled")?;
            self.sensor_session
                .lock()
                .map_err(|_| "sensor session lock poisoned")?
                .cancel();
            self.emit_sensor_control(json!({ "type": "stop" }))?;
            self.gui.toggle_head_control(false)?;
            if let Ok(mut inner) = self.inner.lock() {
                inner.snapshot.head.enabled = false;
                inner.snapshot.head.active = false;
                inner.snapshot.head.dwell_enabled = false;
                inner.snapshot.head.dwell_ready = false;
                inner.snapshot.head.dwell_progress = 0.;
                inner.snapshot.head.phase = "stopped".into();
                inner.snapshot.head.reason = "Head control is off".into();
            }
        }
        Ok(())
    }

    fn set_voice(&self, enabled: bool, immediate: bool) -> Result<()> {
        self.configure_voice(enabled, immediate, true)
    }

    fn configure_voice(&self, enabled: bool, immediate: bool, notify_audio: bool) -> Result<()> {
        if enabled {
            let settings = self.gui.get_settings()?;
            let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            let wake_armed = immediate
                && inner.snapshot.voice.enabled
                && inner.snapshot.voice.phase == VoicePhase::Wake;
            let wait_for_wake = settings.voice_activation && !immediate;
            if notify_audio {
                self.emit_audio_control(if wake_armed {
                    json!({ "type": "push-to-talk", "active": true })
                } else {
                    json!({
                        "type": "start",
                        "mode": if wait_for_wake { "wake" } else { "utterance" },
                        "wakeEnabled": settings.voice_activation,
                        "inputDeviceId": settings.microphone,
                        "noiseSuppression": settings.noise_suppression,
                        "sensitivity": settings.input_sensitivity,
                        "soundEffects": settings.sound_effects,
                    })
                })?;
            }
            self.gui.toggle_voice(true)?;
            let voice = &mut inner.snapshot.voice;
            voice.session_id = voice.session_id.wrapping_add(1);
            voice.enabled = true;
            voice.phase = if wake_armed {
                VoicePhase::Listening
            } else {
                VoicePhase::Starting
            };
            voice.audio_level = 0.;
            voice.transcript.clear();
            voice.reason.clear();
            voice.pending_speech = None;
        } else {
            self.emit_audio_control(json!({ "type": "stop" }))?;
            self.gui.toggle_voice(false)?;
            if let Ok(mut inner) = self.inner.lock() {
                inner.snapshot.voice.session_id = inner.snapshot.voice.session_id.wrapping_add(1);
                inner.snapshot.voice.enabled = false;
                inner.snapshot.voice.phase = VoicePhase::Off;
                inner.snapshot.voice.audio_level = 0.0;
                inner.snapshot.voice.reason = "Voice is off".into();
                inner.snapshot.voice.pending_speech = None;
            }
        }
        Ok(())
    }

    fn set_dwell(&self, enabled: bool) -> Result<()> {
        if !enabled {
            return self.set_head(false);
        }
        if enabled && self.engine.status()?.phase == "stopped" {
            self.set_head(true)?;
        }
        self.engine.set_dwell_enabled(enabled)?;
        if let Ok(mut inner) = self.inner.lock() {
            inner.snapshot.head.dwell_enabled = enabled;
        }
        Ok(())
    }

    fn calibrate(&self) -> Result<()> {
        let enabled = self
            .inner
            .lock()
            .map_err(|_| "runtime state poisoned")?
            .snapshot
            .head
            .enabled;
        if !enabled {
            return Err("enable head control before calibration".into());
        }
        let mut session = self
            .sensor_session
            .lock()
            .map_err(|_| "sensor session lock poisoned")?;
        self.engine.stop_head("Head control recalibration")?;
        self.engine.sensor_initializing()?;
        session.authorize_reset();
        drop(session);
        let settings = self.gui.get_settings()?;
        self.emit_sensor_control(json!({
            "type": "reset",
            "cameraDeviceId": settings.camera,
        }))?;
        if let Ok(mut inner) = self.inner.lock() {
            inner.snapshot.head.active = false;
            inner.snapshot.head.phase = "calibrating".into();
            inner.snapshot.head.reason = "Reopening camera for calibration".into();
        }
        Ok(())
    }

    pub fn sensor_started(&self, session: &crate::engine::Session) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.snapshot.head.enabled = true;
            inner.snapshot.head.session_id = session.id;
            inner.snapshot.head.phase = "initializing".into();
            inner.snapshot.head.reason = "Waiting for fresh camera frames".into();
            inner.snapshot.revision = inner.snapshot.revision.wrapping_add(1);
        }
        self.emit_current();
    }

    pub fn sensor_stopped(&self, reason: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.snapshot.head.enabled = false;
            inner.snapshot.head.active = false;
            inner.snapshot.head.phase = "stopped".into();
            inner.snapshot.head.reason = one_line(reason).chars().take(512).collect();
            inner.snapshot.revision = inner.snapshot.revision.wrapping_add(1);
        }
        self.emit_current();
    }

    fn emit_sensor_control(&self, payload: Value) -> Result<()> {
        let app = self
            .app
            .lock()
            .map_err(|_| "runtime app handle lock poisoned")?
            .clone()
            .ok_or("Kaji window is unavailable")?;
        if app.get_webview_window("sensor").is_none() {
            return Err("sensor host is unavailable".into());
        }
        app.emit_to("sensor", SENSOR_CONTROL_EVENT, payload)
            .map_err(|e| e.to_string())
    }

    fn emit_audio_control(&self, payload: Value) -> Result<()> {
        let app = self
            .app
            .lock()
            .map_err(|_| "runtime app handle lock poisoned")?
            .clone()
            .ok_or("Kaji window is unavailable")?;
        if app.get_webview_window("audio").is_none() {
            return Err("audio host is unavailable".into());
        }
        app.emit_to("audio", AUDIO_CONTROL_EVENT, payload)
            .map_err(|e| e.to_string())
    }

    fn refresh_services(self: &Arc<Self>) -> Result<()> {
        {
            let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            inner.snapshot.message = "Checking speech and reasoning services".into();
        }
        let runtime = Arc::downgrade(self);
        thread::Builder::new()
            .name("kaji-service-check".into())
            .spawn(move || {
                let result = gateway_client::capabilities().and_then(|value| {
                    serde_json::from_value::<ServiceCapabilities>(value).map_err(|e| e.to_string())
                });
                if let Some(runtime) = runtime.upgrade() {
                    if let Ok(mut inner) = runtime.inner.lock() {
                        inner.snapshot.services =
                            Some(result.unwrap_or_else(|error| unavailable_services(&error)));
                        inner.snapshot.message = "Service status updated".into();
                    }
                    runtime.bump_revision();
                    runtime.emit_current();
                }
            })
            .map_err(|e| format!("service check could not start: {e}"))?;
        Ok(())
    }

    fn new_conversation(&self) -> Result<()> {
        let id = new_id("c");
        let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
        inner.snapshot.voice.session_id = inner.snapshot.voice.session_id.wrapping_add(1);
        inner.snapshot.active_conversation_id = Some(id);
        inner.snapshot.message.clear();
        Ok(())
    }

    fn open_conversation(&self, conversation_id: &str) -> Result<()> {
        validate_id(conversation_id, "conversation")?;
        if self.history.get(conversation_id)?.is_none() {
            return Err("conversation no longer exists".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
        inner.snapshot.voice.session_id = inner.snapshot.voice.session_id.wrapping_add(1);
        inner.snapshot.active_conversation_id = Some(conversation_id.into());
        inner.snapshot.message.clear();
        Ok(())
    }

    fn rename_conversation(&self, conversation_id: &str, title: &str) -> Result<()> {
        validate_id(conversation_id, "conversation")?;
        if !self.history.rename(conversation_id, title)? {
            return Err("conversation no longer exists".into());
        }
        self.set_message("Conversation renamed");
        Ok(())
    }

    fn delete_conversation(&self, conversation_id: &str) -> Result<()> {
        validate_id(conversation_id, "conversation")?;
        let stop_task = {
            let inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            inner
                .snapshot
                .task
                .as_ref()
                .filter(|task| task.conversation_id == conversation_id && task.phase.active())
                .map(|task| task.id.clone())
        };
        if let Some(task_id) = stop_task {
            self.invalidate_task(&task_id, "Conversation deleted");
        }
        if !self.history.delete(conversation_id)?
            && self
                .inner
                .lock()
                .map_err(|_| "runtime state poisoned")?
                .snapshot
                .active_conversation_id
                .as_deref()
                != Some(conversation_id)
        {
            return Err("conversation no longer exists".into());
        }
        if let Ok(mut inner) = self.inner.lock()
            && inner.snapshot.active_conversation_id.as_deref() == Some(conversation_id)
        {
            inner.snapshot.active_conversation_id = None;
        }
        self.set_message("Conversation deleted");
        Ok(())
    }

    fn open_artifact(&self, artifact_id: &str) -> Result<()> {
        validate_id(artifact_id, "artifact")?;
        let (artifact, conversation_id) = {
            let inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            (
                inner
                    .snapshot
                    .task
                    .as_ref()
                    .and_then(|task| {
                        task.artifacts
                            .iter()
                            .find(|artifact| artifact.id == artifact_id)
                    })
                    .cloned(),
                inner.snapshot.active_conversation_id.clone(),
            )
        };
        let artifact = artifact
            .or_else(|| {
                let record = self.history.get(conversation_id.as_deref()?).ok()??;
                record
                    .messages
                    .into_iter()
                    .flat_map(|message| message.artifacts)
                    .find(|artifact| artifact.id == artifact_id)
                    .map(|artifact| ArtifactReference {
                        id: artifact.id,
                        name: artifact.name,
                        path: artifact.path,
                        kind: artifact.kind,
                    })
            })
            .ok_or("artifact is not available in this conversation")?;
        let path = PathBuf::from(&artifact.path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let root = self
            .documents
            .artifact_root()
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !path.starts_with(root) || !path.is_file() {
            return Err("artifact path is outside Kaji's generated files".into());
        }
        std::process::Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|e| format!("could not open generated file: {e}"))?;
        Ok(())
    }

    fn update_audio_state(
        &self,
        phase: VoicePhase,
        audio_level: Option<f64>,
        reason: Option<String>,
    ) -> Result<()> {
        if audio_level.is_some_and(|level| !level.is_finite() || !(0.0..=1.0).contains(&level)) {
            return Err("audio level must be between 0 and 1".into());
        }
        let reason = reason.map(|value| one_line(&value).chars().take(512).collect::<String>());
        let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
        if !inner.snapshot.voice.enabled
            && matches!(
                phase,
                VoicePhase::Wake | VoicePhase::Listening | VoicePhase::Transcribing
            )
        {
            return Ok(());
        }
        inner.snapshot.voice.phase = phase;
        if matches!(phase, VoicePhase::Off | VoicePhase::Error) {
            inner.snapshot.voice.pending_speech = None;
            if inner.snapshot.voice.enabled {
                inner.snapshot.voice.session_id = inner.snapshot.voice.session_id.wrapping_add(1);
            }
            inner.snapshot.voice.enabled = false;
            inner.snapshot.voice.audio_level = 0.;
        }
        if let Some(level) = audio_level {
            inner.snapshot.voice.audio_level = level;
        }
        if let Some(reason) = reason {
            inner.snapshot.voice.reason = reason;
        }
        Ok(())
    }

    fn transcribe(
        self: &Arc<Self>,
        utterance_id: String,
        wav_base64: String,
        task_id: Option<String>,
        question_id: Option<String>,
        captured_conversation: Option<String>,
        voice_session_id: u64,
    ) -> Result<()> {
        validate_id(&utterance_id, "utterance")?;
        let settings = self.gui.get_settings()?;
        let language = match settings.recognition_language.as_str() {
            "English (US)" => "en",
            "Bahasa Indonesia" => "id",
            _ => "auto",
        };
        if wav_base64.len() > 3 * 1024 * 1024
            || wav_base64.is_empty()
            || !wav_base64.len().is_multiple_of(4)
            || !wav_base64
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        {
            return Err("audio utterance encoding is invalid or oversized".into());
        }
        let conversation_id = {
            let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            if !inner.snapshot.voice.enabled
                || inner.snapshot.voice.session_id != voice_session_id
                || inner.snapshot.active_conversation_id != captured_conversation
            {
                return Err("voice session changed during recording".into());
            }
            match (
                &task_id,
                &question_id,
                inner.snapshot.task.as_ref(),
                inner.snapshot.question.as_ref(),
            ) {
                (Some(task), Some(question), Some(current_task), Some(current_question))
                    if current_task.id == *task
                        && current_question.id == *question
                        && current_question.task_id == *task => {}
                (None, None, task, None) if task.is_none_or(|task| !task.phase.active()) => {}
                _ => return Err("voice utterance belongs to stale task state".into()),
            }
            if !self
                .audio_inflight
                .lock()
                .map_err(|_| "audio request lock poisoned")?
                .insert(utterance_id.clone())
            {
                return Err("audio utterance was already submitted".into());
            }
            inner.snapshot.voice.phase = VoicePhase::Transcribing;
            inner.snapshot.voice.reason.clear();
            inner.snapshot.active_conversation_id.clone()
        };
        let runtime = Arc::downgrade(self);
        let pending_id = utterance_id.clone();
        thread::Builder::new()
            .name("kaji-stt-request".into())
            .spawn(move || {
                let result = gateway_client::transcribe(&wav_base64, language);
                if let Some(runtime) = runtime.upgrade() {
                    if let Ok(mut pending) = runtime.audio_inflight.lock() {
                        pending.remove(&pending_id);
                    }
                    if runtime.inner.lock().is_ok_and(|inner| {
                        inner.snapshot.voice.enabled
                            && inner.snapshot.voice.session_id == voice_session_id
                    }) {
                        runtime.finish_transcription(task_id, question_id, conversation_id, result);
                    }
                }
            })
            .map_err(|e| {
                if let Ok(mut pending) = self.audio_inflight.lock() {
                    pending.remove(&utterance_id);
                }
                format!("speech request could not start: {e}")
            })?;
        Ok(())
    }

    fn finish_transcription(
        self: &Arc<Self>,
        task_id: Option<String>,
        question_id: Option<String>,
        conversation_id: Option<String>,
        result: Result<gateway_client::Transcript>,
    ) {
        if !self.transcription_still_matches(
            task_id.as_deref(),
            question_id.as_deref(),
            conversation_id.as_deref(),
        ) {
            return;
        }
        let transcript = match result {
            Ok(transcript) => transcript,
            Err(error) => {
                if let Ok(mut inner) = self.inner.lock() {
                    inner.snapshot.voice.phase = VoicePhase::Error;
                    inner.snapshot.voice.enabled = false;
                    inner.snapshot.voice.reason = one_line(&error).chars().take(512).collect();
                    inner.snapshot.message = inner.snapshot.voice.reason.clone();
                }
                self.bump_revision();
                self.emit_current();
                return;
            }
        };
        if !self.transcription_still_matches(
            task_id.as_deref(),
            question_id.as_deref(),
            conversation_id.as_deref(),
        ) {
            return;
        }
        let text = normalize_user_text(&transcript.text, 8_000, "transcript");
        let Ok(text) = text else { return };
        if let Ok(mut inner) = self.inner.lock() {
            inner.snapshot.voice.transcript = text.clone();
            inner.snapshot.voice.phase = if inner.snapshot.voice.enabled {
                VoicePhase::Wake
            } else {
                VoicePhase::Off
            };
            inner.snapshot.voice.reason.clear();
        }
        let result = match (task_id, question_id) {
            (Some(task_id), Some(question_id)) => {
                let question = self
                    .inner
                    .lock()
                    .ok()
                    .and_then(|inner| inner.snapshot.question.clone());
                match question {
                    Some(question) if question.kind == QuestionKind::Approval => {
                        match approval_word(&text) {
                            Some(true) => self.confirm(&task_id, &question_id, true),
                            Some(false) => self.confirm(&task_id, &question_id, false),
                            None => Err("say approve or reject to answer this approval".into()),
                        }
                    }
                    Some(question) if question.kind == QuestionKind::Method => {
                        let method = question.options.iter().find(|option| {
                            option.value.eq_ignore_ascii_case(&text)
                                || option.id.eq_ignore_ascii_case(&text)
                                || option.label.eq_ignore_ascii_case(&text)
                        });
                        match method {
                            Some(option) => {
                                self.choose_method(&task_id, &question_id, &option.value, false)
                            }
                            None => Err("say one of the offered task methods".into()),
                        }
                    }
                    Some(_) => self.answer(&task_id, &question_id, &text),
                    None => Err("voice answer arrived after its question expired".into()),
                }
            }
            (None, None) => self
                .handle_app_command(&text, transcript.language.as_deref(), true)
                .and_then(|handled| {
                    if handled {
                        Ok(())
                    } else {
                        self.start_request(&text, conversation_id, Some("voice"))
                    }
                }),
            _ => Err("voice answer is missing its task or question id".into()),
        };
        if let Err(error) = result
            && let Ok(mut inner) = self.inner.lock()
        {
            inner.snapshot.voice.phase = VoicePhase::Error;
            inner.snapshot.voice.enabled = false;
            inner.snapshot.voice.reason = one_line(&error).chars().take(512).collect();
            inner.snapshot.message = inner.snapshot.voice.reason.clone();
        }
        self.bump_revision();
        self.emit_current();
    }

    fn transcription_still_matches(
        &self,
        task_id: Option<&str>,
        question_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            match (
                task_id,
                question_id,
                inner.snapshot.task.as_ref(),
                inner.snapshot.question.as_ref(),
            ) {
                (Some(task), Some(question), Some(current_task), Some(current_question)) => {
                    current_task.id == task
                        && current_question.id == question
                        && current_question.task_id == task
                }
                (None, None, task, None) if task.is_none_or(|task| !task.phase.active()) => {
                    inner.snapshot.active_conversation_id.as_deref() == conversation_id
                }
                _ => false,
            }
        })
    }

    fn maybe_title(self: &Arc<Self>, conversation_id: &str, request: &str, response: &str) {
        if !self
            .history
            .claim_title_generation(conversation_id)
            .unwrap_or(false)
        {
            return;
        }
        let history = self.history.clone();
        let runtime = Arc::downgrade(self);
        let conversation_id = conversation_id.to_owned();
        let request = request.chars().take(4_000).collect::<String>();
        let response = response.chars().take(4_000).collect::<String>();
        thread::Builder::new()
            .name("kaji-title-request".into())
            .spawn(move || {
                if let Ok(title) = gateway_client::title(&request, &response)
                    && history
                        .set_automatic_title(&conversation_id, &title)
                        .unwrap_or(false)
                    && let Some(runtime) = runtime.upgrade()
                {
                    if let Ok(mut inner) = runtime.inner.lock() {
                        inner.snapshot.history_revision =
                            inner.snapshot.history_revision.wrapping_add(1);
                    }
                    runtime.bump_revision();
                    runtime.emit_current();
                }
            })
            .ok();
    }

    fn handle_app_command(
        self: &Arc<Self>,
        text: &str,
        language: Option<&str>,
        spoken: bool,
    ) -> Result<bool> {
        let command = if spoken {
            voice_commands::parse_spoken(text)
        } else {
            voice_commands::parse(text)
        };
        let Some(command) = command else {
            return Ok(false);
        };
        let mut settings = self.gui.get_settings()?;
        let mut confirmation = None;
        let reply = match command {
            VoiceCommand::Mode(mode) => {
                self.set_mode(mode)?;
                match mode {
                    Mode::Agent => "agent_mode",
                    Mode::Assist => "assist_mode",
                    Mode::Guide => "guide_mode",
                }
            }
            VoiceCommand::Theme(theme) => {
                settings = self.change_app_settings(|settings| settings.theme = theme.into())?;
                match theme {
                    "light" => "light_mode",
                    "dark" => "dark_mode",
                    _ => "system_mode",
                }
            }
            VoiceCommand::Dwell(enabled) => {
                self.set_dwell(enabled)?;
                confirmation = Some(if enabled {
                    "Dwell enabled.".into()
                } else {
                    "Dwell disabled.".into()
                });
                "acknowledged"
            }
            VoiceCommand::Head(enabled) => {
                self.set_head(enabled)?;
                confirmation = Some(if enabled {
                    "Head control enabled.".into()
                } else {
                    "Head control disabled.".into()
                });
                "acknowledged"
            }
            VoiceCommand::ComposerPosition(position) => {
                settings = self
                    .change_app_settings(|settings| settings.composer_position = position.into())?;
                let label = match position {
                    "top" => "Top island",
                    "taskbar" => "Taskbar dock",
                    _ => "Floating window",
                };
                confirmation = Some(format!("Command bar moved to {label}."));
                "acknowledged"
            }
            VoiceCommand::VoiceFeedback(enabled) => {
                settings =
                    self.change_app_settings(|settings| settings.voice_feedback = enabled)?;
                confirmation = Some(if enabled {
                    "Spoken feedback enabled.".into()
                } else {
                    "Spoken feedback disabled.".into()
                });
                "acknowledged"
            }
            VoiceCommand::ResponseVolume(volume) => {
                settings =
                    self.change_app_settings(|settings| settings.response_volume = volume)?;
                confirmation = Some(format!("Response volume set to {volume}%."));
                "acknowledged"
            }
            VoiceCommand::Reply(reply) => reply,
        };
        let indonesian = match settings.response_language.as_str() {
            "Bahasa Indonesia" => true,
            "English (US)" => false,
            _ => language.map_or(settings.language == "Bahasa Indonesia", |language| {
                matches!(language, "id" | "indonesian")
            }),
        };
        let clip = offline_voice::clip(reply, indonesian).ok_or("offline reply is unavailable")?;
        let message = confirmation.as_deref().unwrap_or(clip.text);
        let conversation_id = {
            let mut inner = self.inner.lock().map_err(|_| "runtime state poisoned")?;
            inner.snapshot.message = message.into();
            inner.snapshot.active_conversation_id.clone()
        };
        if let Some(id) = &conversation_id
            && self.history.get(id)?.is_some()
        {
            self.history
                .append_message(id, None, MessageRole::User, text, &[])?;
            self.history
                .append_message(id, None, MessageRole::Assistant, message, &[])?;
            if let Ok(mut inner) = self.inner.lock() {
                inner.snapshot.history_revision = inner.snapshot.history_revision.wrapping_add(1);
            }
        }
        if settings.voice_feedback {
            // Queue instant speech before publishing transcription completion to the audio host.
            self.play_offline(conversation_id.as_deref(), clip, &settings);
        }
        Ok(true)
    }

    fn change_app_settings(&self, change: impl FnOnce(&mut AppSettings)) -> Result<AppSettings> {
        let settings = self.gui.change_settings(change)?;
        if let Some(app) = self.app.lock().ok().and_then(|app| app.clone()) {
            app.emit("settings-updated", &settings)
                .map_err(|error| error.to_string())?;
        }
        Ok(settings)
    }

    fn play_offline(
        &self,
        conversation_id: Option<&str>,
        clip: offline_voice::Clip,
        settings: &AppSettings,
    ) {
        let Ok(inner) = self.inner.lock() else { return };
        if inner.snapshot.active_conversation_id.as_deref() != conversation_id {
            return;
        }
        let session_id = inner.snapshot.voice.session_id;
        drop(inner);
        if let Some(app) = self.app.lock().ok().and_then(|app| app.clone()) {
            let _ = app.emit_to(
                "audio",
                AUDIO_CONTROL_EVENT,
                json!({
                    "type": "play",
                    "utteranceId": new_id("speech"),
                    "voiceSessionId": session_id,
                    "conversationId": conversation_id,
                    "audioBase64": base64_encode(clip.audio),
                    "mimeType": "audio/mpeg",
                    "volume": settings.response_volume as f64 / 100.0,
                    "outputDeviceId": settings.speaker,
                }),
            );
        }
    }

    fn speak(self: &Arc<Self>, conversation_id: &str, text: &str) {
        let Ok(settings) = self.gui.get_settings() else {
            return;
        };
        if !settings.voice_feedback {
            return;
        }
        let text = one_line(text).chars().take(1_000).collect::<String>();
        if text.is_empty() {
            return;
        }
        if let Some(clip) = offline_voice::find(&text) {
            self.play_offline(Some(conversation_id), clip, &settings);
            return;
        }
        let app = self.app.lock().ok().and_then(|app| app.clone());
        let Some(app) = app else { return };
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.snapshot.active_conversation_id.as_deref() != Some(conversation_id) {
            return;
        }
        let voice_session_id = inner.snapshot.voice.session_id;
        let utterance_id = new_id("speech");
        inner.snapshot.voice.pending_speech = Some(utterance_id.clone());
        let conversation_id = conversation_id.to_owned();
        drop(inner);
        self.bump_revision();
        self.emit_current();
        let runtime = Arc::downgrade(self);
        let voice_id = settings.speech_voice_id;
        let key = (conversation_id.to_owned(), text.clone(), voice_id.clone());
        let cached = self
            .speech_cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(&key).cloned());
        let volume = settings.response_volume as f64 / 100.0;
        let output_device = settings.speaker;
        let cache = self.speech_cache.clone();
        let pending_id = utterance_id.clone();
        let spawned = thread::Builder::new()
            .name("kaji-tts-request".into())
            .spawn(move || {
                let audio = cached.or_else(|| gateway_client::speech(&text, Some(&voice_id)).ok());
                let Some(runtime) = runtime.upgrade() else {
                    return;
                };
                let Some(audio) = audio else {
                    runtime.finish_synthesis(&utterance_id);
                    return;
                };
                if !runtime.inner.lock().is_ok_and(|inner| {
                    inner.snapshot.voice.session_id == voice_session_id
                        && inner.snapshot.voice.pending_speech.as_deref() == Some(&utterance_id)
                        && inner.snapshot.active_conversation_id.as_deref()
                            == Some(conversation_id.as_str())
                }) || !runtime.gui.get_settings().is_ok_and(|settings| {
                    settings.voice_feedback && settings.speech_voice_id == voice_id
                }) {
                    runtime.finish_synthesis(&utterance_id);
                    return;
                }
                if audio.len() <= 2 * 1024 * 1024
                    && let Ok(mut cache) = cache.lock()
                {
                    if cache.len() >= 32
                        && let Some(old) = cache.keys().next().cloned()
                    {
                        cache.remove(&old);
                    }
                    cache.insert(key, audio.clone());
                }
                let payload = json!({
                    "type": "play",
                    "utteranceId": utterance_id,
                    "voiceSessionId": voice_session_id,
                    "conversationId": conversation_id,
                    "audioBase64": base64_encode(&audio),
                    "mimeType": "audio/mpeg",
                    "volume": volume,
                    "outputDeviceId": output_device,
                });
                let _ = app.emit_to("audio", AUDIO_CONTROL_EVENT, payload);
                runtime.finish_synthesis(&utterance_id);
            });
        if spawned.is_err() {
            self.finish_synthesis(&pending_id);
        }
    }

    fn finish_synthesis(&self, utterance_id: &str) {
        let changed = self.inner.lock().is_ok_and(|mut inner| {
            if inner.snapshot.voice.pending_speech.as_deref() != Some(utterance_id) {
                return false;
            }
            inner.snapshot.voice.pending_speech = None;
            true
        });
        if changed {
            self.bump_revision();
            self.emit_current();
        }
    }
}

pub fn audio_snapshot(mut snapshot: RuntimeSnapshot) -> RuntimeSnapshot {
    snapshot.attachments.clear();
    snapshot.message.clear();
    snapshot.head.cursor = None;
    snapshot.head.reason.clear();
    snapshot.services = None;
    if let Some(task) = &mut snapshot.task {
        task.conversation_id.clear();
        task.request.clear();
        task.message.clear();
        task.method = None;
        task.target_window = None;
        task.artifacts.clear();
    }
    if let Some(question) = &mut snapshot.question {
        question.title.clear();
        question.options.clear();
        question.allow_custom = false;
        question.optional = false;
        question.split_screen = None;
        question.expires_at = None;
    }
    snapshot.overlay = OverlayState {
        mode: OverlayMode::Hidden,
        point: None,
        target: None,
        target_label: String::new(),
        dwell_progress: 0.0,
        cursor_enabled: false,
        highlight_enabled: false,
        viewport: None,
        monitor_scale_factor: None,
    };
    snapshot
}

fn mode_from_setting(mode: &str) -> Mode {
    match mode {
        "guide" => Mode::Guide,
        "agent" => Mode::Agent,
        _ => Mode::Assist,
    }
}

fn fallback_snapshot() -> RuntimeSnapshot {
    RuntimeSnapshot {
        revision: 0,
        history_revision: 0,
        mode: Mode::Assist,
        active_conversation_id: None,
        task: None,
        question: None,
        message: "Runtime state unavailable".into(),
        attachments: Vec::new(),
        head: HeadState {
            enabled: false,
            active: false,
            phase: "error".into(),
            reason: "Runtime state unavailable".into(),
            session_id: 0,
            dwell_enabled: false,
            dwell_ready: false,
            dwell_progress: 0.0,
            cursor: None,
            calibration_samples: 0,
        },
        voice: VoiceState {
            session_id: 0,
            enabled: false,
            phase: VoicePhase::Off,
            reason: "Runtime state unavailable".into(),
            audio_level: 0.0,
            transcript: String::new(),
            pending_speech: None,
        },
        overlay: OverlayState {
            mode: OverlayMode::Hidden,
            point: None,
            target: None,
            target_label: String::new(),
            dwell_progress: 0.0,
            cursor_enabled: false,
            highlight_enabled: false,
            viewport: None,
            monitor_scale_factor: None,
        },
        layout: LayoutState { active: false },
        services: None,
    }
}

fn validate_id(id: &str, kind: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err(format!("invalid {kind} id"));
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control)
}

fn normalize_user_text(text: &str, maximum: usize, kind: &str) -> Result<String> {
    let value = text.trim();
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(format!("{kind} must contain 1-{maximum} bytes"));
    }
    Ok(value.to_owned())
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn new_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        unix_ms(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn validate_host_question(question: &HostQuestion) -> Result<()> {
    validate_id(&question.id, "question")?;
    if question.title.trim().is_empty() || question.title.len() > 240 || question.options.len() > 16
    {
        return Err("invalid task question".into());
    }
    let mut ids = HashSet::new();
    for option in &question.options {
        validate_id(&option.id, "question option")?;
        if option.label.trim().is_empty()
            || option.label.len() > 160
            || option.value.len() > 512
            || !ids.insert(option.id.clone())
        {
            return Err("invalid task question option".into());
        }
    }
    if question.kind == QuestionKind::Method && question.options.is_empty() {
        return Err("method question has no available executor".into());
    }
    Ok(())
}

fn validate_method_choice(
    question: &PendingQuestion,
    method: &str,
    split: bool,
) -> Result<Option<SplitScreenChoice>> {
    if question.kind != QuestionKind::Method {
        return Err("no method choice is pending".into());
    }
    if question
        .expires_at
        .is_some_and(|expires_at| expires_at < unix_ms())
    {
        return Err("method choice expired".into());
    }
    let offered = method == "rephrase"
        || question
            .options
            .iter()
            .any(|option| option.id == method || option.value == method);
    if !offered {
        return Err("method was not offered for this task".into());
    }
    if method == "rephrase" && split {
        return Err("split screen cannot be applied when revising the task".into());
    }
    let choice = question.split_screen.clone();
    if split
        && !choice.as_ref().is_some_and(|choice| {
            choice.available
                && valid_id(&choice.user_window)
                && valid_id(&choice.task_window)
                && choice.user_window != choice.task_window
        })
    {
        return Err("split screen is unavailable for this task".into());
    }
    Ok(choice)
}

fn history_artifact(artifact: ArtifactReference) -> history::ArtifactReference {
    history::ArtifactReference {
        id: artifact.id,
        name: artifact.name,
        path: artifact.path,
        kind: artifact.kind,
    }
}

fn approval_word(text: &str) -> Option<bool> {
    match one_line(text).to_lowercase().as_str() {
        "approve" | "approve action" => Some(true),
        "reject" | "cancel action" => Some(false),
        _ => None,
    }
}

fn display_distance(point: crate::control::Point, rect: native::Rect) -> f64 {
    let right = f64::from(rect.right - 1);
    let bottom = f64::from(rect.bottom - 1);
    let dx = (f64::from(rect.left) - point.x).max(0.0) + (point.x - right).max(0.0);
    let dy = (f64::from(rect.top) - point.y).max(0.0) + (point.y - bottom).max(0.0);
    dx.hypot(dy)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn unavailable_services(reason: &str) -> ServiceCapabilities {
    let capability = |model: &str| ServiceCapability {
        available: false,
        model: model.into(),
        reason: Some(one_line(reason).chars().take(240).collect()),
        remaining: None,
        reset_at: None,
        models: Vec::new(),
    };
    ServiceCapabilities {
        reasoning: capability("deepseek-v4.1-flash"),
        vision: capability("deepseek-v4.1-flash"),
        stt: capability("whisper-large-v3-turbo"),
        tts: TtsCapability {
            service: capability("eleven_v4_turbo"),
            voices: Vec::new(),
        },
        titles: capability("qwen/qwen3.8-27b"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_overlay_uses_validated_bounds_and_a_readable_name_then_clears() {
        let mut overlay = fallback_snapshot().overlay;
        overlay.highlight_enabled = true;
        let bounds = Rect {
            left: -1400,
            top: 10,
            right: -1280,
            bottom: 50,
        };
        let mut cursor = crate::assist::IntentCursor {
            revision: 4,
            element_id: "opaque-uia-id".into(),
            point: bounds.center(),
            target: bounds,
            target_name: "Align Center".into(),
        };
        overlay.point_at(&cursor);
        assert_eq!(overlay.mode, OverlayMode::Task);
        assert_eq!(overlay.target, Some(bounds));
        assert_eq!(overlay.point, Some(bounds.center()));
        assert_eq!(overlay.target_label, "Next: Align Center");
        cursor.target_name.clear();
        overlay.point_at(&cursor);
        assert_eq!(overlay.target_label, "Next control");
        overlay.clear_target();
        assert_eq!(overlay.mode, OverlayMode::Follow);
        assert!(overlay.target.is_none());
        assert!(overlay.point.is_none());
        assert!(overlay.target_label.is_empty());
    }

    fn method_question() -> PendingQuestion {
        PendingQuestion {
            id: "method-question".into(),
            task_id: "task-1".into(),
            kind: QuestionKind::Method,
            title: "Which method should Kaji use?".into(),
            options: ["native-ui", "local-search"]
                .into_iter()
                .map(|id| QuestionOption {
                    id: id.into(),
                    label: id.into(),
                    value: id.into(),
                })
                .collect(),
            allow_custom: false,
            optional: false,
            split_screen: Some(SplitScreenChoice {
                available: true,
                enabled: true,
                user_window: "window-opaque-user".into(),
                task_window: "window-opaque-task".into(),
            }),
            expires_at: None,
        }
    }

    #[test]
    fn runtime_action_envelopes_match_camel_case_and_dotted_tags() {
        let action: RuntimeAction = serde_json::from_value(json!({
            "type": "audio.transcribe",
            "utteranceId": "utterance-1",
            "wavBase64": "AQID",
            "voiceSessionId": 1,
            "taskId": "task-1",
            "questionId": "question-1"
        }))
        .unwrap();
        assert!(matches!(action, RuntimeAction::AudioTranscribe { .. }));

        let action: RuntimeAction = serde_json::from_value(json!({
            "type": "conversation.open",
            "conversationId": "conversation-1"
        }))
        .unwrap();
        assert!(matches!(action, RuntimeAction::ConversationOpen { .. }));

        let action: RuntimeAction =
            serde_json::from_value(json!({ "type": "file.select" })).unwrap();
        assert!(matches!(action, RuntimeAction::FileSelect));

        let action: RuntimeAction = serde_json::from_value(json!({
            "type": "method",
            "taskId": "task-1",
            "questionId": "question-1",
            "method": "calendar-adapter",
            "splitScreen": true
        }))
        .unwrap();
        assert!(matches!(
            action,
            RuntimeAction::Method {
                split_screen: true,
                ..
            }
        ));

        assert!(
            serde_json::from_value::<RuntimeAction>(json!({
                "type": "audio.transcribe",
                "utterance_id": "utterance-1",
                "wav_base64": "AQID"
            }))
            .is_err()
        );
    }

    #[test]
    fn runtime_layout_state_matches_shared_snapshot_shape() {
        let value = serde_json::to_value(LayoutState { active: true }).unwrap();
        assert_eq!(value, json!({ "active": true }));
        let fallback = serde_json::to_value(fallback_snapshot()).unwrap();
        assert_eq!(fallback["layout"], json!({ "active": false }));
    }

    #[test]
    fn generic_method_selection_uses_offered_ids_and_dynamic_windows() {
        let question = method_question();
        let split = validate_method_choice(&question, "native-ui", true).unwrap();
        let split = split.unwrap();
        assert_eq!(split.user_window, "window-opaque-user");
        assert_eq!(split.task_window, "window-opaque-task");
        assert!(validate_method_choice(&question, "unoffered-adapter", false).is_err());
        assert!(validate_method_choice(&question, "rephrase", true).is_err());

        let mut unavailable = question;
        unavailable.split_screen.as_mut().unwrap().available = false;
        assert!(validate_method_choice(&unavailable, "local-search", true).is_err());
    }
}
