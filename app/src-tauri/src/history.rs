use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use crate::Result;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Docx,
    File,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReference {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: ArtifactKind,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub id: String,
    pub role: MessageRole,
    pub text: String,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<ArtifactReference>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    Local,
    Automatic,
    Manual,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub title_source: TitleSource,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRecord {
    pub id: String,
    pub title: String,
    pub title_source: TitleSource,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<ConversationMessage>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retention {
    Days(u16),
    Forever,
}
impl Retention {
    pub fn from_setting(value: &str) -> Result<Self> {
        match value {
            "7 days" => Ok(Self::Days(7)),
            "30 days" => Ok(Self::Days(30)),
            "90 days" => Ok(Self::Days(90)),
            "Forever" => Ok(Self::Forever),
            _ => Err("retention must be 7 days, 30 days, 90 days, or Forever".into()),
        }
    }
}

pub struct HistoryStore {
    connection: Mutex<Connection>,
    enabled: AtomicBool,
    retention: Mutex<Retention>,
}

impl HistoryStore {
    pub fn open(path: impl AsRef<Path>, enabled: bool, retention: Retention) -> Result<Self> {
        let path = path.as_ref();
        if path != Path::new(":memory:")
            && let Some(parent) = path.parent()
        {
            std::fs::create_dir_all(parent).map_err(|e| format!("history directory: {e}"))?;
        }
        let connection = Connection::open(path).map_err(|e| format!("history database: {e}"))?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 CREATE TABLE IF NOT EXISTS conversations (
                     id TEXT PRIMARY KEY NOT NULL,
                     title TEXT NOT NULL,
                     title_source TEXT NOT NULL CHECK(title_source IN ('local','automatic','manual')),
                     title_attempted INTEGER NOT NULL DEFAULT 0,
                     created_at INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS messages (
                     id TEXT PRIMARY KEY NOT NULL,
                     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                     role TEXT NOT NULL CHECK(role IN ('user','assistant')),
                     text TEXT NOT NULL,
                     created_at INTEGER NOT NULL,
                     task_id TEXT,
                     artifacts_json TEXT NOT NULL DEFAULT '[]'
                 );
                 CREATE INDEX IF NOT EXISTS messages_conversation_time
                     ON messages(conversation_id, created_at, id);
                 PRAGMA user_version = 2;",
            )
            .map_err(|e| format!("initialize history database: {e}"))?;
        let has_title_attempted = {
            let mut statement = connection
                .prepare("PRAGMA table_info(conversations)")
                .map_err(db_error)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(db_error)?;
            rows.filter_map(|row| row.ok())
                .any(|name| name == "title_attempted")
        };
        if !has_title_attempted {
            connection
                .execute_batch("ALTER TABLE conversations ADD COLUMN title_attempted INTEGER NOT NULL DEFAULT 0;")
                .map_err(db_error)?;
        }
        let store = Self {
            connection: Mutex::new(connection),
            enabled: AtomicBool::new(enabled),
            retention: Mutex::new(retention),
        };
        store.prune()?;
        Ok(store)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
    }

    pub fn set_retention(&self, retention: Retention) -> Result<()> {
        *self
            .retention
            .lock()
            .map_err(|_| "history retention lock poisoned")? = retention;
        self.prune()
    }

    pub fn create_from_request(&self, id: &str, task_id: &str, request: &str) -> Result<()> {
        validate_id(id, "conversation")?;
        validate_id(task_id, "task")?;
        let text = request.trim();
        if text.is_empty() || text.len() > 32_000 {
            return Err("conversation request must contain 1-32000 bytes".into());
        }
        if !self.enabled.load(Ordering::SeqCst) {
            return Ok(());
        }
        let now = now_ms();
        let title = local_title(text);
        let connection = self.lock()?;
        let transaction = connection.unchecked_transaction().map_err(db_error)?;
        transaction
            .execute(
                "INSERT INTO conversations(id,title,title_source,created_at,updated_at)
                 VALUES (?1,?2,'local',?3,?3)",
                params![id, title, now],
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "INSERT INTO messages(id,conversation_id,role,text,created_at,task_id)
                 VALUES (?1,?2,'user',?3,?4,?5)",
                params![new_id("m"), id, text, now, task_id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(())
    }

    pub fn append_message(
        &self,
        conversation_id: &str,
        task_id: Option<&str>,
        role: MessageRole,
        text: &str,
        artifacts: &[ArtifactReference],
    ) -> Result<bool> {
        validate_id(conversation_id, "conversation")?;
        if let Some(task_id) = task_id {
            validate_id(task_id, "task")?;
        }
        if !self.enabled.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let text = text.trim();
        if text.is_empty() || text.len() > 32_000 {
            return Err("message must contain 1-32000 bytes".into());
        }
        if artifacts.len() > 32 {
            return Err("message has too many artifact references".into());
        }
        for artifact in artifacts {
            validate_id(&artifact.id, "artifact")?;
            validate_text(&artifact.name, 512, "artifact name")?;
            validate_text(&artifact.path, 4096, "artifact path")?;
        }
        let artifacts = serde_json::to_string(artifacts).map_err(|e| e.to_string())?;
        let now = now_ms();
        let connection = self.lock()?;
        let transaction = connection.unchecked_transaction().map_err(db_error)?;
        let inserted = transaction
            .execute(
                "INSERT INTO messages(id,conversation_id,role,text,created_at,task_id,artifacts_json)
                 SELECT ?1,id,?2,?3,?4,?5,?6 FROM conversations WHERE id=?7",
                params![
                    new_id("m"),
                    role.as_str(),
                    text,
                    now,
                    task_id,
                    artifacts,
                    conversation_id
                ],
            )
            .map_err(db_error)?;
        if inserted == 0 {
            return Err("conversation was deleted or does not exist".into());
        }
        transaction
            .execute(
                "UPDATE conversations SET updated_at=?1 WHERE id=?2",
                params![now, conversation_id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(true)
    }

    pub fn set_automatic_title(&self, conversation_id: &str, title: &str) -> Result<bool> {
        validate_id(conversation_id, "conversation")?;
        let title = normalize_title(title)?;
        let changed = self
            .lock()?
            .execute(
                "UPDATE conversations SET title=?1,title_source='automatic',updated_at=?2
                 WHERE id=?3 AND title_source='local'",
                params![title, now_ms(), conversation_id],
            )
            .map_err(db_error)?;
        Ok(changed == 1)
    }

    pub fn claim_title_generation(&self, conversation_id: &str) -> Result<bool> {
        validate_id(conversation_id, "conversation")?;
        let changed = self
            .lock()?
            .execute(
                "UPDATE conversations SET title_attempted=1
                 WHERE id=?1 AND title_source='local' AND title_attempted=0",
                [conversation_id],
            )
            .map_err(db_error)?;
        Ok(changed == 1)
    }

    pub fn rename(&self, conversation_id: &str, title: &str) -> Result<bool> {
        validate_id(conversation_id, "conversation")?;
        let title = normalize_title(title)?;
        let changed = self
            .lock()?
            .execute(
                "UPDATE conversations SET title=?1,title_source='manual',updated_at=?2 WHERE id=?3",
                params![title, now_ms(), conversation_id],
            )
            .map_err(db_error)?;
        Ok(changed == 1)
    }

    pub fn delete(&self, conversation_id: &str) -> Result<bool> {
        validate_id(conversation_id, "conversation")?;
        let changed = self
            .lock()?
            .execute("DELETE FROM conversations WHERE id=?1", [conversation_id])
            .map_err(db_error)?;
        Ok(changed == 1)
    }

    pub fn get(&self, conversation_id: &str) -> Result<Option<ConversationRecord>> {
        validate_id(conversation_id, "conversation")?;
        self.prune()?;
        let connection = self.lock()?;
        let summary = connection
            .query_row(
                "SELECT id,title,title_source,created_at,updated_at FROM conversations WHERE id=?1",
                [conversation_id],
                read_summary,
            )
            .optional()
            .map_err(db_error)?;
        let Some(summary) = summary else {
            return Ok(None);
        };
        let mut statement = connection
            .prepare(
                "SELECT id,role,text,created_at,task_id,artifacts_json
                 FROM messages WHERE conversation_id=?1 ORDER BY created_at,id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([conversation_id], read_message)
            .map_err(db_error)?;
        let mut messages = Vec::new();
        for row in rows {
            messages.push(row.map_err(db_error)?);
        }
        Ok(Some(ConversationRecord {
            id: summary.id,
            title: summary.title,
            title_source: summary.title_source,
            created_at: summary.created_at,
            updated_at: summary.updated_at,
            messages,
        }))
    }

    pub fn list(&self, query: Option<&str>) -> Result<Vec<ConversationSummary>> {
        self.prune()?;
        let query = query.unwrap_or_default().trim();
        if query.len() > 128 {
            return Err("history search must not exceed 128 bytes".into());
        }
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT c.id,c.title,c.title_source,c.created_at,c.updated_at
                 FROM conversations c
                 WHERE (?1='' OR instr(lower(c.title),lower(?1))>0 OR EXISTS (
                     SELECT 1 FROM messages m WHERE m.conversation_id=c.id
                     AND instr(lower(m.text),lower(?1))>0
                 ))
                 ORDER BY c.updated_at DESC,c.id DESC LIMIT 200",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([query], read_summary)
            .map_err(db_error)?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(db_error)?);
        }
        Ok(results)
    }

    fn prune(&self) -> Result<()> {
        let retention = *self
            .retention
            .lock()
            .map_err(|_| "history retention lock poisoned")?;
        let Retention::Days(days) = retention else {
            return Ok(());
        };
        let cutoff = now_ms().saturating_sub(i64::from(days) * 24 * 60 * 60 * 1000);
        self.lock()?
            .execute("DELETE FROM conversations WHERE updated_at < ?1", [cutoff])
            .map_err(db_error)?;
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| "history database lock poisoned".into())
    }
}

impl MessageRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "user" => Ok(Self::User),
            "assistant" => Ok(Self::Assistant),
            _ => Err(rusqlite::Error::InvalidColumnType(
                1,
                "role".into(),
                rusqlite::types::Type::Text,
            )),
        }
    }
}

impl TitleSource {
    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "local" => Ok(Self::Local),
            "automatic" => Ok(Self::Automatic),
            "manual" => Ok(Self::Manual),
            _ => Err(rusqlite::Error::InvalidColumnType(
                2,
                "title_source".into(),
                rusqlite::types::Type::Text,
            )),
        }
    }
}

fn read_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationSummary> {
    let source: String = row.get(2)?;
    Ok(ConversationSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        title_source: TitleSource::parse(&source)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn read_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationMessage> {
    let role: String = row.get(1)?;
    let artifacts: String = row.get(5)?;
    Ok(ConversationMessage {
        id: row.get(0)?,
        role: MessageRole::parse(&role)?,
        text: row.get(2)?,
        created_at: row.get(3)?,
        task_id: row.get(4)?,
        artifacts: serde_json::from_str(&artifacts).map_err(|_| rusqlite::Error::InvalidQuery)?,
    })
}

fn normalize_title(title: &str) -> Result<String> {
    let title = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| {
            c.is_whitespace() || matches!(c, '"' | '\'' | '.' | '!' | '?' | ',')
        })
        .to_owned();
    if title.is_empty() || title.chars().count() > 80 || title.contains('\0') {
        return Err("title must contain 1-80 characters".into());
    }
    Ok(title)
}

fn local_title(request: &str) -> String {
    let words: Vec<String> = request
        .split_whitespace()
        .take(6)
        .map(|word| {
            word.trim_matches(|c: char| matches!(c, '"' | '\'' | '.' | '!' | '?' | ',' | ':' | ';'))
                .to_owned()
        })
        .filter(|word| !word.is_empty())
        .collect();
    let title = words.join(" ");
    title.chars().take(80).collect::<String>()
}

fn validate_id(value: &str, kind: &str) -> Result<()> {
    if value.is_empty() || value.len() > 128 || value.chars().any(|c| c.is_control()) {
        return Err(format!("invalid {kind} id"));
    }
    Ok(())
}

fn validate_text(value: &str, max: usize, kind: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') {
        return Err(format!("invalid {kind}"));
    }
    Ok(())
}

fn new_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        now_ms(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn db_error(error: rusqlite::Error) -> String {
    format!("history database: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(enabled: bool, retention: Retention) -> HistoryStore {
        HistoryStore::open(":memory:", enabled, retention).unwrap()
    }

    #[test]
    fn saves_messages_searches_and_returns_camel_case_records() {
        let store = store(true, Retention::Forever);
        store
            .create_from_request("c-1", "t-1", "Please tidy this DOCX document")
            .unwrap();
        store
            .append_message(
                "c-1",
                Some("t-1"),
                MessageRole::Assistant,
                "I cleaned the headings.",
                &[],
            )
            .unwrap();
        let rows = store.list(Some("docx")).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Please tidy this DOCX document");
        let record = store.get("c-1").unwrap().unwrap();
        assert_eq!(record.messages.len(), 2);
        let value = serde_json::to_value(record).unwrap();
        assert!(value.get("createdAt").is_some());
        assert!(value["messages"][0].get("taskId").is_some());
    }

    #[test]
    fn disabled_history_leaves_existing_records_readable_and_skips_new_writes() {
        let store = store(true, Retention::Forever);
        store
            .create_from_request("c-1", "t-1", "Keep this history")
            .unwrap();
        store.set_enabled(false);
        assert!(
            !store
                .append_message("c-1", Some("t-1"), MessageRole::Assistant, "Not saved", &[])
                .unwrap()
        );
        assert_eq!(store.get("c-1").unwrap().unwrap().messages.len(), 1);
        assert!(
            store
                .create_from_request("c-2", "t-2", "Do not persist")
                .is_ok()
        );
        assert!(store.get("c-2").unwrap().is_none());
    }

    #[test]
    fn manual_title_wins_over_delayed_automatic_title() {
        let store = store(true, Retention::Forever);
        store
            .create_from_request("c-1", "t-1", "Tidy my project brief")
            .unwrap();
        assert!(store.rename("c-1", "Final project brief").unwrap());
        assert!(
            !store
                .set_automatic_title("c-1", "Tidying the project brief")
                .unwrap()
        );
        assert_eq!(
            store.get("c-1").unwrap().unwrap().title,
            "Final project brief"
        );
    }

    #[test]
    fn deleted_conversation_rejects_delayed_title_and_message() {
        let store = store(true, Retention::Forever);
        store
            .create_from_request("c-1", "t-1", "Tidy document")
            .unwrap();
        assert!(store.delete("c-1").unwrap());
        assert!(
            !store
                .set_automatic_title("c-1", "Tidying document")
                .unwrap()
        );
        assert!(
            store
                .append_message(
                    "c-1",
                    Some("t-1"),
                    MessageRole::Assistant,
                    "Late result",
                    &[]
                )
                .is_err()
        );
    }

    #[test]
    fn title_generation_can_be_claimed_only_once_and_manual_rename_skips_it() {
        let store = store(true, Retention::Forever);
        store
            .create_from_request("c-1", "t-1", "Tidy this report")
            .unwrap();
        assert!(store.claim_title_generation("c-1").unwrap());
        assert!(!store.claim_title_generation("c-1").unwrap());
        store
            .create_from_request("c-2", "t-2", "Tidy another report")
            .unwrap();
        store.rename("c-2", "My report").unwrap();
        assert!(!store.claim_title_generation("c-2").unwrap());
    }

    #[test]
    fn title_and_search_inputs_are_bounded() {
        let store = store(true, Retention::Forever);
        store
            .create_from_request("c-1", "t-1", "Tidy document")
            .unwrap();
        assert!(store.rename("c-1", &"x".repeat(81)).is_err());
        assert!(store.list(Some(&"x".repeat(129))).is_err());
        assert_eq!(store.list(Some("tidy")).unwrap().len(), 1);
    }

    #[test]
    fn retention_prunes_expired_conversations() {
        let store = store(true, Retention::Days(7));
        store
            .create_from_request("c-1", "t-1", "Old history")
            .unwrap();
        store
            .lock()
            .unwrap()
            .execute(
                "UPDATE conversations SET updated_at=?1 WHERE id='c-1'",
                [now_ms().saturating_sub(8_i64 * 24 * 60 * 60 * 1000)],
            )
            .unwrap();
        assert!(store.list(None).unwrap().is_empty());
    }
}
