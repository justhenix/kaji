use crate::{
    Result,
    runtime::{RuntimeManager, TaskPhase},
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    phase: String,
    current_version: String,
    version: Option<String>,
    downloaded: usize,
    total: Option<u64>,
    message: String,
}
impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            current_version: env!("CARGO_PKG_VERSION").into(),
            version: None,
            downloaded: 0,
            total: None,
            message: String::new(),
        }
    }
}
#[derive(Default)]
pub struct UpdateManager {
    inner: Mutex<(UpdateStatus, Option<Update>)>,
}
impl UpdateManager {
    fn status(&self) -> Result<UpdateStatus> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| "Update state unavailable")?
            .0
            .clone())
    }
    fn error(&self, message: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.0.phase = "error".into();
            inner.0.message = message.into();
        }
    }
}

#[tauri::command]
pub fn gui_update_status(manager: State<'_, Arc<UpdateManager>>) -> Result<UpdateStatus> {
    manager.status()
}

pub async fn check(app: AppHandle, manager: Arc<UpdateManager>) -> Result<UpdateStatus> {
    {
        let mut inner = manager
            .inner
            .lock()
            .map_err(|_| "Update state unavailable")?;
        if matches!(
            inner.0.phase.as_str(),
            "checking" | "downloading" | "installing"
        ) {
            return Ok(inner.0.clone());
        }
        inner.0.phase = "checking".into();
        inner.0.message.clear();
    }
    let result = async {
        app.updater_builder()
            .timeout(Duration::from_secs(180))
            .build()?
            .check()
            .await
    }
    .await;
    match result {
        Ok(update) => {
            let mut inner = manager
                .inner
                .lock()
                .map_err(|_| "Update state unavailable")?;
            inner.0.phase = if update.is_some() {
                "available"
            } else {
                "current"
            }
            .into();
            inner.0.version = update.as_ref().map(|update| update.version.clone());
            inner.1 = update;
            Ok(inner.0.clone())
        }
        Err(_) => {
            manager.error("Couldn’t check for updates. Try again when connected.");
            manager.status()
        }
    }
}

#[tauri::command]
pub async fn gui_update_check(
    app: AppHandle,
    manager: State<'_, Arc<UpdateManager>>,
) -> Result<UpdateStatus> {
    check(app, manager.inner().clone()).await
}

fn idle(runtime: &RuntimeManager) -> bool {
    runtime.snapshot().task.is_none_or(|task| {
        matches!(
            task.phase,
            TaskPhase::Complete | TaskPhase::Stopped | TaskPhase::Error
        )
    })
}

#[tauri::command]
pub async fn gui_update_install(
    manager: State<'_, Arc<UpdateManager>>,
    runtime: State<'_, Arc<RuntimeManager>>,
) -> Result<UpdateStatus> {
    if !idle(&runtime) {
        return Err("Finish or stop the current task before updating Kaji.".into());
    }
    let update = {
        let mut inner = manager
            .inner
            .lock()
            .map_err(|_| "Update state unavailable")?;
        if inner.0.phase != "available" {
            return Err("Check for updates first.".into());
        }
        let update = inner.1.clone().ok_or("No update is available")?;
        inner.0.phase = "downloading".into();
        inner.0.downloaded = 0;
        inner.0.message.clear();
        update
    };
    let progress = manager.inner().clone();
    let result = async {
        let bytes = update
            .download(
                move |chunk, total| {
                    if let Ok(mut inner) = progress.inner.lock() {
                        inner.0.downloaded += chunk;
                        inner.0.total = total;
                    }
                },
                || {},
            )
            .await
            .map_err(|_| "Couldn’t download and verify the update. Try again.".to_owned())?;
        if !idle(&runtime) {
            return Err("A task started. Finish or stop it, then check for updates again.".into());
        }
        manager
            .inner
            .lock()
            .map_err(|_| "Update state unavailable")?
            .0
            .phase = "installing".into();
        update
            .install(&bytes)
            .map_err(|_| "Couldn’t install the update. Try again.".to_owned())?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = result {
        manager.error(&error);
    }
    // Windows updater exits this process and restarts through the signed installer.
    manager.status()
}

pub fn start(app: AppHandle) {
    let manager = app.state::<Arc<UpdateManager>>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let _ = check(app, manager).await;
    });
}
