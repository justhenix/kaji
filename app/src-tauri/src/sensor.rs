use crate::engine::Session;

pub struct SensorSession {
    started: Option<Session>,
    cancelled: bool,
    reset_authorized: bool,
}

impl Default for SensorSession {
    fn default() -> Self {
        Self {
            started: None,
            cancelled: true,
            reset_authorized: false,
        }
    }
}

impl SensorSession {
    pub fn start(
        &mut self,
        begin: impl FnOnce() -> Result<Session, String>,
    ) -> Result<Session, String> {
        if !self.reset_authorized {
            return Err(if self.cancelled {
                "sensor session cancelled".into()
            } else {
                "sensor start is not authorized".into()
            });
        }
        if self.started.is_some() {
            return Err("sensor session is already initialized".into());
        }
        self.started = None;
        self.cancelled = false;
        self.reset_authorized = false;
        let session = begin()?;
        self.started = Some(session.clone());
        Ok(session)
    }

    pub fn cancel(&mut self) -> bool {
        let was_active = !self.cancelled;
        self.cancelled = true;
        self.reset_authorized = false;
        was_active
    }

    pub fn authorize_reset(&mut self) {
        self.reset_authorized = true;
        self.cancelled = false;
        self.started = None;
    }
}
