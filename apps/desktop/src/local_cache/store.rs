use libsql::{params, Builder, Connection, TransactionBehavior, Value};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Convert an `Option<String>` to a libsql `Value`, producing `Value::Null` for `None`
/// and `Value::Text(s)` for `Some(s)`.  This is the correct way to insert nullable
/// TEXT columns so that SQLite sees NULL (not an empty string).
fn opt_val(v: &Option<String>) -> Value {
    match v {
        Some(s) => Value::Text(s.clone()),
        None => Value::Null,
    }
}

fn text(s: &str) -> Value {
    Value::Text(s.to_string())
}

/// How long a writer waits on a locked database before giving up. The store
/// runs every command through one connection, so contention here only comes
/// from another process (a second window, the introspect sidecar) — a short
/// wait beats a spurious `database is locked`.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Largest `IN (...)` list we hand SQLite in one statement. The compiled-in
/// variable limit is far higher, but chunking keeps a pathological session
/// from building a multi-megabyte statement.
const MAX_IN_LIST: usize = 500;

/// The runtime whose private database `enrich_*` reads. Every other runtime
/// (pi, cursor, claude-code) never writes it, so for them the lookup is a
/// guaranteed miss and is skipped up front.
const OPENCODE_RUNTIME: &str = "opencode";

/// Run one write statement for every row inside a single `BEGIN IMMEDIATE`
/// transaction, preparing the statement once.
///
/// Before this, each batch was N autocommit statements — N journal writes and
/// 2N fsyncs on the default rollback journal — executed while holding the
/// store-wide mutex, so a 500-message history replay stalled every other
/// cache command for the duration. One transaction is one commit, and a
/// failure mid-batch rolls the whole batch back (libsql's local transaction
/// rolls back on drop) instead of leaving a half-applied page.
async fn run_write_batch<T>(
    conn: &Connection,
    label: &str,
    sql: &str,
    rows: &[T],
    bind: impl Fn(&T) -> Vec<Value>,
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .await
        .map_err(|e| format!("{label}: begin: {e}"))?;
    let stmt = tx
        .prepare(sql)
        .await
        .map_err(|e| format!("{label}: prepare: {e}"))?;
    for row in rows {
        // libsql binds without resetting; a second `execute` on a stepped
        // statement is a misuse error, so reset explicitly between rows.
        stmt.reset();
        stmt.execute(bind(row))
            .await
            .map_err(|e| format!("{label}: {e}"))?;
    }
    tx.commit()
        .await
        .map_err(|e| format!("{label}: commit: {e}"))
}

/// `?1,?2,...,?n` for an `IN` list of `n` entries starting at `?{offset+1}`.
fn placeholders(count: usize, offset: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", i + offset + 1))
        .collect::<Vec<_>>()
        .join(",")
}

fn opencode_db_paths(workspace_path: Option<&str>) -> Vec<PathBuf> {
    crate::opencode_paths::opencode_db_candidates(workspace_path, dirs::home_dir().as_deref())
}

/// Whether the tool-output lookup in opencode's private database can ever hit
/// for this message. `None` means the caller does not know the runtime (older
/// frontends, `enrich_parts` with no message row) — then only the on-disk
/// existence of the database gates the lookup, as before.
fn opencode_enrichment_applies(runtime: Option<&str>) -> bool {
    match runtime.map(str::trim).filter(|r| !r.is_empty()) {
        Some(runtime) => runtime.eq_ignore_ascii_case(OPENCODE_RUNTIME),
        None => true,
    }
}

fn string_at<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|v| v.as_str())
}

fn collect_description_values(args: Option<&serde_json::Value>) -> HashSet<String> {
    let mut values = HashSet::new();
    let Some(args) = args.and_then(|v| v.as_object()) else {
        return values;
    };

    for key in ["description", "summary", "title", "action"] {
        if let Some(value) = args.get(key).and_then(|v| v.as_str()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                values.insert(trimmed.to_string());
            }
        }
    }

    if let Some(raw) = args.get("_description").and_then(|v| v.as_str()) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) {
            for key in ["description", "summary", "title", "action"] {
                if let Some(value) = parsed.get(key).and_then(|v| v.as_str()) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        values.insert(trimmed.to_string());
                    }
                }
            }
        } else {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                values.insert(trimmed.to_string());
            }
        }
    }

    values
}

fn tool_call_id_from_part(part: &serde_json::Value) -> Option<String> {
    string_at(part, "toolCallId")
        .or_else(|| part.pointer("/toolCall/id").and_then(|v| v.as_str()))
        .map(ToString::to_string)
}

fn tool_call_part_needs_output(part: &serde_json::Value) -> bool {
    let result = part.pointer("/toolCall/result").and_then(|v| v.as_str());
    let Some(result) = result.map(str::trim).filter(|s| !s.is_empty()) else {
        return true;
    };
    let args = part.pointer("/toolCall/arguments");
    collect_description_values(args).contains(result)
}

fn collect_opencode_tool_ids_from_parts_json(parts_json: &str) -> HashSet<String> {
    let Ok(parts) = serde_json::from_str::<serde_json::Value>(parts_json) else {
        return HashSet::new();
    };
    let Some(parts) = parts.as_array() else {
        return HashSet::new();
    };
    parts
        .iter()
        .filter(|part| string_at(part, "type") == Some("tool-call"))
        .filter(|part| tool_call_part_needs_output(part))
        .filter_map(tool_call_id_from_part)
        .collect()
}

/// JSON key on an opencode `part` row that carries the tool-call id. The
/// `json_extract` in [`load_opencode_tool_outputs_from_paths`] and the
/// post-filter here must agree on it.
const OPENCODE_CALL_ID_KEY: &str = "callID";

/// `(callID, output)` of an opencode tool part, if it has a non-empty output.
fn opencode_part_call_output(data: &str) -> Option<(String, String)> {
    let value = serde_json::from_str::<serde_json::Value>(data).ok()?;
    let call_id = string_at(&value, OPENCODE_CALL_ID_KEY)?.to_string();
    let state = value.get("state")?;
    let output = string_at(state, "output")
        .or_else(|| state.pointer("/metadata/output").and_then(|v| v.as_str()))
        .map(ToString::to_string)
        .filter(|text| !text.trim().is_empty())?;
    Some((call_id, output))
}

fn enrich_parts_json_with_opencode_outputs(
    parts_json: &str,
    outputs: &HashMap<String, String>,
) -> Option<String> {
    let mut parts = serde_json::from_str::<serde_json::Value>(parts_json).ok()?;
    let parts_array = parts.as_array_mut()?;
    let mut changed = false;

    for part in parts_array {
        if string_at(part, "type") != Some("tool-call") || !tool_call_part_needs_output(part) {
            continue;
        }
        let Some(tool_call_id) = tool_call_id_from_part(part) else {
            continue;
        };
        let Some(output) = outputs.get(&tool_call_id) else {
            continue;
        };
        let Some(tool_call) = part.get_mut("toolCall").and_then(|v| v.as_object_mut()) else {
            continue;
        };
        tool_call.insert(
            "result".to_string(),
            serde_json::Value::String(output.clone()),
        );
        changed = true;
    }

    if changed {
        serde_json::to_string(&parts).ok()
    } else {
        None
    }
}

/// Look up tool outputs for `tool_call_ids` in the opencode databases at
/// `paths` (first hit per id wins; later paths only fill the gaps).
///
/// One statement per database: `json_extract(data, '$.callID') IN (...)`.
/// The previous shape was one `LIKE '%<id>%'` scan of the whole `part` table
/// *per tool call*, so a turn with 30 tool calls scanned the table 30 times —
/// and the table holds every opencode session on the machine, not just this
/// one. `json_valid` guards `json_extract`, which errors (aborting the query)
/// on a malformed row instead of skipping it.
async fn load_opencode_tool_outputs_from_paths(
    tool_call_ids: &HashSet<String>,
    paths: &[PathBuf],
) -> HashMap<String, String> {
    let mut outputs: HashMap<String, String> = HashMap::new();
    if tool_call_ids.is_empty() {
        return outputs;
    }

    for path in paths {
        if tokio::fs::metadata(path).await.is_err() {
            continue;
        }
        let db = match Builder::new_local(path.to_string_lossy().to_string())
            .build()
            .await
        {
            Ok(db) => db,
            Err(_) => continue,
        };
        let conn = match db.connect() {
            Ok(conn) => conn,
            Err(_) => continue,
        };

        let missing = tool_call_ids
            .iter()
            .filter(|id| !outputs.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>();
        for chunk in missing.chunks(MAX_IN_LIST) {
            let sql = format!(
                "SELECT data FROM part
                 WHERE json_valid(data)
                   AND json_extract(data, '$.{OPENCODE_CALL_ID_KEY}') IN ({})
                 ORDER BY time_updated DESC, time_created DESC",
                placeholders(chunk.len(), 0)
            );
            let binds = chunk.iter().map(|id| text(id)).collect::<Vec<_>>();
            let mut rows = match conn.query(&sql, binds).await {
                Ok(rows) => rows,
                Err(_) => continue,
            };
            while let Ok(Some(row)) = rows.next().await {
                let data = row.get::<String>(0).unwrap_or_default();
                let Some((call_id, output)) = opencode_part_call_output(&data) else {
                    continue;
                };
                // Rows arrive newest first; keep the first output per id.
                if tool_call_ids.contains(&call_id) {
                    outputs.entry(call_id).or_insert(output);
                }
            }
        }

        if outputs.len() == tool_call_ids.len() {
            break;
        }
    }
    outputs
}

async fn load_opencode_tool_outputs(
    tool_call_ids: &HashSet<String>,
    workspace_path: Option<&str>,
    runtime: Option<&str>,
) -> HashMap<String, String> {
    if tool_call_ids.is_empty() || !opencode_enrichment_applies(runtime) {
        return HashMap::new();
    }
    load_opencode_tool_outputs_from_paths(tool_call_ids, &opencode_db_paths(workspace_path)).await
}

async fn enrich_message_rows_from_opencode(
    rows: &mut [MessageRow],
    workspace_path: Option<&str>,
    runtime: Option<&str>,
) {
    if !opencode_enrichment_applies(runtime) {
        return;
    }
    let tool_call_ids = rows
        .iter()
        .filter_map(|row| row.parts_json.as_deref())
        .flat_map(collect_opencode_tool_ids_from_parts_json)
        .collect::<HashSet<_>>();
    let outputs = load_opencode_tool_outputs(&tool_call_ids, workspace_path, runtime).await;
    if outputs.is_empty() {
        return;
    }

    for row in rows {
        let Some(parts_json) = row.parts_json.as_deref() else {
            continue;
        };
        if let Some(enriched) = enrich_parts_json_with_opencode_outputs(parts_json, &outputs) {
            row.parts_json = Some(enriched);
        }
    }
}

/// Fill tool-call results from opencode's own database. `runtime` is the
/// agent runtime that produced the parts when the caller knows it; anything
/// but opencode short-circuits without touching the disk.
pub async fn enrich_parts_json_from_opencode(
    parts_json: &str,
    workspace_path: Option<&str>,
    runtime: Option<&str>,
) -> String {
    if !opencode_enrichment_applies(runtime) {
        return parts_json.to_string();
    }
    let tool_call_ids = collect_opencode_tool_ids_from_parts_json(parts_json);
    let outputs = load_opencode_tool_outputs(&tool_call_ids, workspace_path, runtime).await;
    if outputs.is_empty() {
        return parts_json.to_string();
    }
    enrich_parts_json_with_opencode_outputs(parts_json, &outputs)
        .unwrap_or_else(|| parts_json.to_string())
}

// ─── Row types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorRow {
    pub id: String,
    pub team_id: String,
    pub actor_type: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub member_status: Option<String>,
    pub agent_status: Option<String>,
    pub last_active_at: Option<String>,
    pub metadata_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
    // Display hints cached so the list's first (offline) paint matches the
    // network paint — avoids the subtitle popping in. Member: team_role
    // (owner/admin/member). Agent: agent_visibility (team/personal).
    #[serde(default)]
    pub team_role: Option<String>,
    #[serde(default)]
    pub agent_visibility: Option<String>,
    /// Agent owner member actor id — for personal-agent delete gating on cache first paint.
    #[serde(default)]
    pub owner_member_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub team_id: String,
    pub title: Option<String>,
    pub mode: Option<String>,
    pub primary_agent_id: Option<String>,
    pub idea_id: Option<String>,
    pub summary: Option<String>,
    pub last_message_preview: Option<String>,
    pub last_message_at: Option<String>,
    pub created_by: Option<String>,
    pub metadata_json: Option<String>,
    /// How the session was created: 'user' | 'cron' | 'gateway'.
    pub source: Option<String>,
    /// For source='cron', the cron job id that created it.
    pub cron_job_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionParticipantRow {
    pub id: String,
    pub session_id: String,
    pub actor_id: String,
    pub joined_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub team_id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub sender_actor_id: Option<String>,
    pub reply_to_message_id: Option<String>,
    pub kind: String,
    pub content: String,
    pub metadata_json: Option<String>,
    pub model: Option<String>,
    pub mentions_json: Option<String>,
    pub origin: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
    /// Serialized `MessagePart[]` (thinking / tool_call / text). Populated when
    /// streaming finalize merges runtime events into the persisted message so
    /// that reloading the session restores the full conversation, not just
    /// the AGENT_REPLY text body. NULL for plain messages with no merged parts.
    pub parts_json: Option<String>,
}

/// Outbox row — mirrors iOS `OutboxMessage` SwiftData model. Tracks one
/// pending/in-flight send through the cloud backend + MQTT with exponential backoff
/// retry. `message_id` is the same UUID used in `Message.id` so optimistic
/// UI bubbles can match the live echo by id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxRow {
    pub message_id: String,
    pub team_id: String,
    pub session_id: String,
    pub sender_actor_id: String,
    pub content: String,
    pub mention_actor_ids_json: Option<String>,
    pub display_mention_actor_ids_json: Option<String>,
    pub attachment_urls_json: Option<String>,
    pub state: String,
    pub attempt_count: i64,
    pub last_attempt_at: Option<String>,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaRow {
    pub id: String,
    pub team_id: String,
    pub workspace_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub created_by: Option<String>,
    pub archived: i64,
    pub sort_order: Option<i64>,
    pub metadata_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorkspaceRow {
    pub session_id: String,
    pub team_id: String,
    pub viewer_member_id: String,
    pub agent_id: String,
    pub workspace_id: Option<String>,
    pub workspace_path: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRow {
    pub id: String,
    pub idea_id: String,
    pub actor_id: String,
    pub claimed_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionRow {
    pub id: String,
    pub idea_id: String,
    pub actor_id: String,
    pub content: Option<String>,
    pub submitted_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeEventRow {
    pub id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub sender_actor_id: Option<String>,
    pub kind: String,
    pub content: String,
    pub metadata_json: Option<String>,
    pub model: Option<String>,
    pub created_at: String,
}

/// Optional knobs for [`LocalCacheStore::message_load_session_with`].
#[derive(Debug, Clone, Copy, Default)]
pub struct MessageLoadOptions<'a> {
    /// Newest N rows only (`None` or `<= 0` = everything).
    pub limit: Option<i64>,
    /// Agent runtime that produced the session's messages, when known.
    pub runtime: Option<&'a str>,
}

// ─── Store ────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct LocalCacheStore {
    conn: Arc<Mutex<Connection>>,
}

impl LocalCacheStore {
    // TODO(migrate-orphan): The old ~/.teamclu/agent-events.db is left alone.
    // A future cleanup pass can delete it once all users have updated past this version.

    /// Create (or open) the local cache database at the given path.
    pub async fn new(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create local-cache db directory: {}", e))?;
        }

        let db_path_str = db_path.to_string_lossy().to_string();
        let db = Builder::new_local(db_path_str)
            .build()
            .await
            .map_err(|e| format!("Failed to open local-cache database: {}", e))?;
        let conn = db
            .connect()
            .map_err(|e| format!("Failed to connect to local-cache database: {}", e))?;
        Self::configure_connection(&conn).await;

        let instance = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        instance.migrate().await?;
        Ok(instance)
    }

    /// Per-connection SQLite tuning. libsql only turns WAL on for its (unused)
    /// `sync` feature, so without this the cache ran on SQLite's defaults —
    /// rollback journal plus `synchronous=FULL`, i.e. two fsyncs per statement
    /// and readers blocked behind every writer. WAL + `NORMAL` is the standard
    /// desktop-app setting: durable across application crashes, at most the
    /// last transaction lost on power failure, readers never block on a write.
    ///
    /// Best effort: a filesystem that refuses WAL (some network mounts) still
    /// gets a working, merely slower, cache.
    async fn configure_connection(conn: &Connection) {
        if let Err(e) = conn.busy_timeout(BUSY_TIMEOUT) {
            log::warn!("local-cache: busy_timeout not applied: {e}");
        }
        // journal_mode returns a row (the resulting mode), so it goes through
        // `query`; `execute` rejects statements that return rows.
        match conn.query("PRAGMA journal_mode=WAL", ()).await {
            Ok(mut rows) => {
                let mode = rows
                    .next()
                    .await
                    .ok()
                    .flatten()
                    .and_then(|row| row.get::<String>(0).ok())
                    .unwrap_or_default();
                if !mode.eq_ignore_ascii_case("wal") {
                    log::warn!("local-cache: journal_mode stayed {mode:?}, wanted wal");
                }
            }
            Err(e) => log::warn!("local-cache: journal_mode=WAL not applied: {e}"),
        }
        if let Err(e) = conn.execute("PRAGMA synchronous=NORMAL", ()).await {
            log::warn!("local-cache: synchronous=NORMAL not applied: {e}");
        }
    }

    /// Get a locked reference to the raw connection (rarely needed externally).
    pub async fn conn(&self) -> tokio::sync::MutexGuard<'_, Connection> {
        self.conn.lock().await
    }

    /// Run all DDL migrations (idempotent).
    async fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock().await;

        // ── actor ─────────────────────────────────────────────────────────
        conn.execute(
            "CREATE TABLE IF NOT EXISTS actor (
                id            TEXT PRIMARY KEY,
                team_id       TEXT NOT NULL,
                actor_type    TEXT NOT NULL,
                display_name  TEXT NOT NULL,
                avatar_url    TEXT,
                member_status TEXT,
                agent_status  TEXT,
                last_active_at TEXT,
                metadata_json TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL,
                deleted_at    TEXT,
                synced_at     TEXT NOT NULL,
                team_role     TEXT,
                agent_visibility TEXT,
                owner_member_id TEXT
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create actor table: {}", e))?;
        conn.execute("ALTER TABLE actor ADD COLUMN last_active_at TEXT", ())
            .await
            .ok();
        // Additive migrations for existing DBs (idempotent; ignore errors).
        conn.execute("ALTER TABLE actor ADD COLUMN team_role TEXT", ())
            .await
            .ok();
        conn.execute("ALTER TABLE actor ADD COLUMN agent_visibility TEXT", ())
            .await
            .ok();
        conn.execute("ALTER TABLE actor ADD COLUMN owner_member_id TEXT", ())
            .await
            .ok();

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_actor_team ON actor(team_id)",
            (),
        )
        .await
        .ok();

        // ── session ───────────────────────────────────────────────────────
        conn.execute(
            "CREATE TABLE IF NOT EXISTS session (
                id                   TEXT PRIMARY KEY,
                team_id              TEXT NOT NULL,
                title                TEXT,
                mode                 TEXT,
                primary_agent_id     TEXT,
                idea_id              TEXT,
                summary              TEXT,
                last_message_preview TEXT,
                last_message_at      TEXT,
                created_by           TEXT,
                metadata_json        TEXT,
                source               TEXT,
                cron_job_id          TEXT,
                created_at           TEXT NOT NULL,
                updated_at           TEXT NOT NULL,
                deleted_at           TEXT,
                synced_at            TEXT NOT NULL
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create session table: {}", e))?;

        // Additive migrations for existing DBs (idempotent; ignore errors).
        conn.execute("ALTER TABLE session ADD COLUMN source TEXT", ())
            .await
            .ok();
        conn.execute("ALTER TABLE session ADD COLUMN cron_job_id TEXT", ())
            .await
            .ok();

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_session_team ON session(team_id, last_message_at)",
            (),
        )
        .await
        .ok();

        // ── session_viewer_workspace ───────────────────────────────────────
        // Viewer-scoped session → agent → workspace bindings. Synced from the
        // current member's agent_runtimes; used offline for list labels/filter.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS session_viewer_workspace (
                session_id         TEXT NOT NULL,
                team_id            TEXT NOT NULL,
                viewer_member_id   TEXT NOT NULL,
                agent_id           TEXT NOT NULL,
                workspace_id       TEXT,
                workspace_path     TEXT,
                updated_at         TEXT NOT NULL,
                PRIMARY KEY (session_id, viewer_member_id, agent_id)
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create session_viewer_workspace table: {}", e))?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_svw_team_viewer
             ON session_viewer_workspace(team_id, viewer_member_id)",
            (),
        )
        .await
        .ok();
        // Legacy 1:1 table stored foreign paths — drop after new table exists.
        conn.execute("DROP TABLE IF EXISTS session_workspace", ())
            .await
            .ok();

        // ── session_participant ────────────────────────────────────────────
        conn.execute(
            "CREATE TABLE IF NOT EXISTS session_participant (
                id         TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                actor_id   TEXT NOT NULL,
                joined_at  TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT,
                synced_at  TEXT NOT NULL,
                UNIQUE(session_id, actor_id)
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create session_participant table: {}", e))?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sp_session ON session_participant(session_id)",
            (),
        )
        .await
        .ok();

        // ── message ───────────────────────────────────────────────────────
        conn.execute(
            "CREATE TABLE IF NOT EXISTS message (
                id                  TEXT PRIMARY KEY,
                team_id             TEXT NOT NULL,
                session_id          TEXT NOT NULL,
                turn_id             TEXT,
                sender_actor_id     TEXT,
                reply_to_message_id TEXT,
                kind                TEXT NOT NULL,
                content             TEXT NOT NULL,
                metadata_json       TEXT,
                model               TEXT,
                mentions_json       TEXT,
                origin              TEXT NOT NULL,
                created_at          TEXT NOT NULL,
                updated_at          TEXT NOT NULL,
                deleted_at          TEXT,
                synced_at           TEXT NOT NULL,
                parts_json          TEXT
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create message table: {}", e))?;

        // Additive migration for users on older schema. Idempotent; ignores
        // "duplicate column" errors from a previously-applied add.
        conn.execute("ALTER TABLE message ADD COLUMN parts_json TEXT", ())
            .await
            .ok();

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id, created_at)",
            (),
        )
        .await
        .ok();

        // ── outbox ────────────────────────────────────────────────────────
        conn.execute(
            "CREATE TABLE IF NOT EXISTS outbox (
                message_id              TEXT PRIMARY KEY,
                team_id                 TEXT NOT NULL,
                session_id              TEXT NOT NULL,
                sender_actor_id         TEXT NOT NULL,
                content                 TEXT NOT NULL,
                mention_actor_ids_json  TEXT,
                display_mention_actor_ids_json TEXT,
                attachment_urls_json    TEXT,
                state                   TEXT NOT NULL,
                attempt_count           INTEGER NOT NULL DEFAULT 0,
                last_attempt_at         TEXT,
                next_attempt_at         TEXT,
                last_error              TEXT,
                created_at              TEXT NOT NULL,
                updated_at              TEXT NOT NULL
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create outbox table: {}", e))?;

        conn.execute(
            "ALTER TABLE outbox ADD COLUMN display_mention_actor_ids_json TEXT",
            (),
        )
        .await
        .ok();

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(state, next_attempt_at)",
            (),
        )
        .await
        .ok();

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_outbox_session ON outbox(session_id, created_at)",
            (),
        )
        .await
        .ok();

        // ── idea ──────────────────────────────────────────────────────────
        conn.execute(
            "CREATE TABLE IF NOT EXISTS idea (
                id            TEXT PRIMARY KEY,
                team_id       TEXT NOT NULL,
                workspace_id  TEXT,
                parent_id     TEXT,
                title         TEXT NOT NULL,
                description   TEXT,
                status        TEXT,
                created_by    TEXT,
                archived      INTEGER NOT NULL DEFAULT 0,
                sort_order    INTEGER NOT NULL DEFAULT 0,
                metadata_json TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL,
                deleted_at    TEXT,
                synced_at     TEXT NOT NULL
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create idea table: {}", e))?;
        conn.execute(
            "ALTER TABLE idea ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
            (),
        )
        .await
        .ok();

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_idea_team ON idea(team_id)",
            (),
        )
        .await
        .ok();

        // ── claim ─────────────────────────────────────────────────────────
        conn.execute(
            "CREATE TABLE IF NOT EXISTS claim (
                id         TEXT PRIMARY KEY,
                idea_id    TEXT NOT NULL,
                actor_id   TEXT NOT NULL,
                claimed_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT,
                synced_at  TEXT NOT NULL
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create claim table: {}", e))?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_claim_idea ON claim(idea_id)",
            (),
        )
        .await
        .ok();

        // ── submission ────────────────────────────────────────────────────
        conn.execute(
            "CREATE TABLE IF NOT EXISTS submission (
                id           TEXT PRIMARY KEY,
                idea_id      TEXT NOT NULL,
                actor_id     TEXT NOT NULL,
                content      TEXT,
                submitted_at TEXT NOT NULL,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL,
                deleted_at   TEXT,
                synced_at    TEXT NOT NULL
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create submission table: {}", e))?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_submission_idea ON submission(idea_id)",
            (),
        )
        .await
        .ok();

        // ── agent_runtime_event ───────────────────────────────────────────
        conn.execute(
            "CREATE TABLE IF NOT EXISTS agent_runtime_event (
                id              TEXT PRIMARY KEY,
                session_id      TEXT NOT NULL,
                turn_id         TEXT,
                sender_actor_id TEXT,
                kind            TEXT NOT NULL,
                content         TEXT NOT NULL,
                metadata_json   TEXT,
                model           TEXT,
                created_at      TEXT NOT NULL
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create agent_runtime_event table: {}", e))?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_are_session ON agent_runtime_event(session_id, created_at)",
            (),
        )
        .await
        .ok();

        // ── sync_state ────────────────────────────────────────────────────
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sync_state (
                table_name   TEXT NOT NULL,
                team_id      TEXT NOT NULL,
                last_sync_at TEXT NOT NULL,
                PRIMARY KEY (table_name, team_id)
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create sync_state table: {}", e))?;

        Ok(())
    }

    // ─── actor ────────────────────────────────────────────────────────────

    pub async fn actor_upsert_batch(&self, rows: &[ActorRow]) -> Result<(), String> {
        let conn = self.conn.lock().await;
        run_write_batch(
            &conn,
            "actor_upsert_batch",
            "INSERT INTO actor
                (id, team_id, actor_type, display_name, avatar_url, member_status,
                 agent_status, last_active_at, metadata_json, created_at, updated_at, deleted_at, synced_at,
                 team_role, agent_visibility, owner_member_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
             ON CONFLICT(id) DO UPDATE SET
                team_id       = excluded.team_id,
                actor_type    = excluded.actor_type,
                display_name  = excluded.display_name,
                avatar_url    = excluded.avatar_url,
                member_status = excluded.member_status,
                agent_status  = excluded.agent_status,
                last_active_at = excluded.last_active_at,
                metadata_json = excluded.metadata_json,
                created_at    = excluded.created_at,
                updated_at    = excluded.updated_at,
                deleted_at    = excluded.deleted_at,
                synced_at     = excluded.synced_at,
                team_role     = excluded.team_role,
                agent_visibility = excluded.agent_visibility,
                owner_member_id = excluded.owner_member_id
             WHERE excluded.updated_at >= actor.updated_at",
            rows,
            |r| {
                vec![
                    text(&r.id),
                    text(&r.team_id),
                    text(&r.actor_type),
                    text(&r.display_name),
                    opt_val(&r.avatar_url),
                    opt_val(&r.member_status),
                    opt_val(&r.agent_status),
                    opt_val(&r.last_active_at),
                    opt_val(&r.metadata_json),
                    text(&r.created_at),
                    text(&r.updated_at),
                    opt_val(&r.deleted_at),
                    text(&r.synced_at),
                    opt_val(&r.team_role),
                    opt_val(&r.agent_visibility),
                    opt_val(&r.owner_member_id),
                ]
            },
        )
        .await
    }

    pub async fn actor_load_team(
        &self,
        team_id: &str,
        include_deleted: bool,
    ) -> Result<Vec<ActorRow>, String> {
        let conn = self.conn.lock().await;
        let sql = if include_deleted {
            "SELECT id, team_id, actor_type, display_name, avatar_url, member_status,
                    agent_status, last_active_at, metadata_json, created_at, updated_at, deleted_at, synced_at,
                    team_role, agent_visibility, owner_member_id
             FROM actor WHERE team_id = ?1"
        } else {
            "SELECT id, team_id, actor_type, display_name, avatar_url, member_status,
                    agent_status, last_active_at, metadata_json, created_at, updated_at, deleted_at, synced_at,
                    team_role, agent_visibility, owner_member_id
             FROM actor WHERE team_id = ?1 AND deleted_at IS NULL"
        };
        let mut rows = conn
            .query(sql, params![team_id.to_string()])
            .await
            .map_err(|e| format!("actor_load_team: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("actor_load_team row: {}", e))?
        {
            result.push(ActorRow {
                id: row.get::<String>(0).unwrap_or_default(),
                team_id: row.get::<String>(1).unwrap_or_default(),
                actor_type: row.get::<String>(2).unwrap_or_default(),
                display_name: row.get::<String>(3).unwrap_or_default(),
                avatar_url: row.get::<String>(4).ok().filter(|s| !s.is_empty()),
                member_status: row.get::<String>(5).ok().filter(|s| !s.is_empty()),
                agent_status: row.get::<String>(6).ok().filter(|s| !s.is_empty()),
                last_active_at: row.get::<String>(7).ok().filter(|s| !s.is_empty()),
                metadata_json: row.get::<String>(8).ok().filter(|s| !s.is_empty()),
                created_at: row.get::<String>(9).unwrap_or_default(),
                updated_at: row.get::<String>(10).unwrap_or_default(),
                deleted_at: row.get::<String>(11).ok().filter(|s| !s.is_empty()),
                synced_at: row.get::<String>(12).unwrap_or_default(),
                team_role: row.get::<String>(13).ok().filter(|s| !s.is_empty()),
                agent_visibility: row.get::<String>(14).ok().filter(|s| !s.is_empty()),
                owner_member_id: row.get::<String>(15).ok().filter(|s| !s.is_empty()),
            });
        }
        Ok(result)
    }

    /// Load actor rows by a list of IDs (non-deleted only).
    /// Returns an empty vec if `ids` is empty or none match.
    pub async fn actor_load_by_ids(&self, ids: &[String]) -> Result<Vec<ActorRow>, String> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().await;
        // Build "?,?,?" placeholders
        let placeholders = ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, team_id, actor_type, display_name, avatar_url, member_status,
                    agent_status, last_active_at, metadata_json, created_at, updated_at, deleted_at, synced_at,
                    team_role, agent_visibility, owner_member_id
             FROM actor WHERE id IN ({}) AND deleted_at IS NULL",
            placeholders
        );
        let bind_vals: Vec<Value> = ids.iter().map(|s| Value::Text(s.clone())).collect();
        let mut rows = conn
            .query(&sql, bind_vals)
            .await
            .map_err(|e| format!("actor_load_by_ids: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("actor_load_by_ids row: {}", e))?
        {
            result.push(ActorRow {
                id: row.get::<String>(0).unwrap_or_default(),
                team_id: row.get::<String>(1).unwrap_or_default(),
                actor_type: row.get::<String>(2).unwrap_or_default(),
                display_name: row.get::<String>(3).unwrap_or_default(),
                avatar_url: row.get::<String>(4).ok().filter(|s| !s.is_empty()),
                member_status: row.get::<String>(5).ok().filter(|s| !s.is_empty()),
                agent_status: row.get::<String>(6).ok().filter(|s| !s.is_empty()),
                last_active_at: row.get::<String>(7).ok().filter(|s| !s.is_empty()),
                metadata_json: row.get::<String>(8).ok().filter(|s| !s.is_empty()),
                created_at: row.get::<String>(9).unwrap_or_default(),
                updated_at: row.get::<String>(10).unwrap_or_default(),
                deleted_at: row.get::<String>(11).ok().filter(|s| !s.is_empty()),
                synced_at: row.get::<String>(12).unwrap_or_default(),
                team_role: row.get::<String>(13).ok().filter(|s| !s.is_empty()),
                agent_visibility: row.get::<String>(14).ok().filter(|s| !s.is_empty()),
                owner_member_id: row.get::<String>(15).ok().filter(|s| !s.is_empty()),
            });
        }
        Ok(result)
    }

    pub async fn actor_soft_delete(&self, id: &str, deleted_at: &str) -> Result<(), String> {
        let now = deleted_at.to_string();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE actor SET deleted_at = ?1, updated_at = ?1, synced_at = ?1 WHERE id = ?2",
            params![now, id.to_string()],
        )
        .await
        .map_err(|e| format!("actor_soft_delete: {}", e))?;
        Ok(())
    }

    // ─── session ──────────────────────────────────────────────────────────

    pub async fn session_upsert_batch(&self, rows: &[SessionRow]) -> Result<(), String> {
        let conn = self.conn.lock().await;
        run_write_batch(
            &conn,
            "session_upsert_batch",
            "INSERT INTO session
                (id, team_id, title, mode, primary_agent_id, idea_id, summary,
                 last_message_preview, last_message_at, created_by, metadata_json,
                 source, cron_job_id,
                 created_at, updated_at, deleted_at, synced_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
             ON CONFLICT(id) DO UPDATE SET
                team_id              = excluded.team_id,
                title                = excluded.title,
                mode                 = excluded.mode,
                primary_agent_id     = excluded.primary_agent_id,
                idea_id              = excluded.idea_id,
                summary              = excluded.summary,
                last_message_preview = excluded.last_message_preview,
                last_message_at      = excluded.last_message_at,
                created_by           = excluded.created_by,
                metadata_json        = excluded.metadata_json,
                source               = excluded.source,
                cron_job_id          = excluded.cron_job_id,
                created_at           = excluded.created_at,
                updated_at           = excluded.updated_at,
                deleted_at           = excluded.deleted_at,
                synced_at            = excluded.synced_at
             WHERE excluded.updated_at >= session.updated_at",
            rows,
            |r| {
                vec![
                    text(&r.id),
                    text(&r.team_id),
                    opt_val(&r.title),
                    opt_val(&r.mode),
                    opt_val(&r.primary_agent_id),
                    opt_val(&r.idea_id),
                    opt_val(&r.summary),
                    opt_val(&r.last_message_preview),
                    opt_val(&r.last_message_at),
                    opt_val(&r.created_by),
                    opt_val(&r.metadata_json),
                    opt_val(&r.source),
                    opt_val(&r.cron_job_id),
                    text(&r.created_at),
                    text(&r.updated_at),
                    opt_val(&r.deleted_at),
                    text(&r.synced_at),
                ]
            },
        )
        .await
    }

    pub async fn session_load_team(
        &self,
        team_id: &str,
        include_deleted: bool,
    ) -> Result<Vec<SessionRow>, String> {
        let conn = self.conn.lock().await;
        let sql = if include_deleted {
            "SELECT id, team_id, title, mode, primary_agent_id, idea_id, summary,
                    last_message_preview, last_message_at, created_by, metadata_json,
                    source, cron_job_id,
                    created_at, updated_at, deleted_at, synced_at
             FROM session WHERE team_id = ?1 ORDER BY last_message_at DESC"
        } else {
            "SELECT id, team_id, title, mode, primary_agent_id, idea_id, summary,
                    last_message_preview, last_message_at, created_by, metadata_json,
                    source, cron_job_id,
                    created_at, updated_at, deleted_at, synced_at
             FROM session WHERE team_id = ?1 AND deleted_at IS NULL ORDER BY last_message_at DESC"
        };
        let mut rows = conn
            .query(sql, params![team_id.to_string()])
            .await
            .map_err(|e| format!("session_load_team: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("session_load_team row: {}", e))?
        {
            result.push(SessionRow {
                id: row.get::<String>(0).unwrap_or_default(),
                team_id: row.get::<String>(1).unwrap_or_default(),
                title: row.get::<String>(2).ok().filter(|s| !s.is_empty()),
                mode: row.get::<String>(3).ok().filter(|s| !s.is_empty()),
                primary_agent_id: row.get::<String>(4).ok().filter(|s| !s.is_empty()),
                idea_id: row.get::<String>(5).ok().filter(|s| !s.is_empty()),
                summary: row.get::<String>(6).ok().filter(|s| !s.is_empty()),
                last_message_preview: row.get::<String>(7).ok().filter(|s| !s.is_empty()),
                last_message_at: row.get::<String>(8).ok().filter(|s| !s.is_empty()),
                created_by: row.get::<String>(9).ok().filter(|s| !s.is_empty()),
                metadata_json: row.get::<String>(10).ok().filter(|s| !s.is_empty()),
                source: row.get::<String>(11).ok().filter(|s| !s.is_empty()),
                cron_job_id: row.get::<String>(12).ok().filter(|s| !s.is_empty()),
                created_at: row.get::<String>(13).unwrap_or_default(),
                updated_at: row.get::<String>(14).unwrap_or_default(),
                deleted_at: row.get::<String>(15).ok().filter(|s| !s.is_empty()),
                synced_at: row.get::<String>(16).unwrap_or_default(),
            });
        }
        Ok(result)
    }

    pub async fn session_workspace_upsert_batch(
        &self,
        rows: &[SessionWorkspaceRow],
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        run_write_batch(
            &conn,
            "session_workspace_upsert_batch",
            "INSERT INTO session_viewer_workspace
                (session_id, team_id, viewer_member_id, agent_id,
                 workspace_id, workspace_path, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(session_id, viewer_member_id, agent_id) DO UPDATE SET
                team_id        = excluded.team_id,
                workspace_id   = excluded.workspace_id,
                workspace_path = excluded.workspace_path,
                updated_at     = excluded.updated_at
             WHERE excluded.updated_at >= session_viewer_workspace.updated_at",
            rows,
            |r| {
                vec![
                    text(&r.session_id),
                    text(&r.team_id),
                    text(&r.viewer_member_id),
                    text(&r.agent_id),
                    opt_val(&r.workspace_id),
                    opt_val(&r.workspace_path),
                    text(&r.updated_at),
                ]
            },
        )
        .await
    }

    pub async fn session_workspace_load_team(
        &self,
        team_id: &str,
        viewer_member_id: &str,
    ) -> Result<Vec<SessionWorkspaceRow>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT session_id, team_id, viewer_member_id, agent_id,
                        workspace_id, workspace_path, updated_at
                 FROM session_viewer_workspace
                 WHERE team_id = ?1 AND viewer_member_id = ?2",
                params![team_id.to_string(), viewer_member_id.to_string()],
            )
            .await
            .map_err(|e| format!("session_workspace_load_team: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("session_workspace_load_team row: {}", e))?
        {
            result.push(SessionWorkspaceRow {
                session_id: row.get::<String>(0).unwrap_or_default(),
                team_id: row.get::<String>(1).unwrap_or_default(),
                viewer_member_id: row.get::<String>(2).unwrap_or_default(),
                agent_id: row.get::<String>(3).unwrap_or_default(),
                workspace_id: row.get::<String>(4).ok().filter(|s| !s.is_empty()),
                workspace_path: row.get::<String>(5).ok().filter(|s| !s.is_empty()),
                updated_at: row.get::<String>(6).unwrap_or_default(),
            });
        }
        Ok(result)
    }

    pub async fn session_soft_delete(&self, id: &str, deleted_at: &str) -> Result<(), String> {
        let now = deleted_at.to_string();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE session SET deleted_at = ?1, updated_at = ?1, synced_at = ?1 WHERE id = ?2",
            params![now, id.to_string()],
        )
        .await
        .map_err(|e| format!("session_soft_delete: {}", e))?;
        Ok(())
    }

    // ─── session_participant ──────────────────────────────────────────────

    pub async fn session_participant_upsert_batch(
        &self,
        rows: &[SessionParticipantRow],
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        run_write_batch(
            &conn,
            "session_participant_upsert_batch",
            // Conflict on the natural key (session_id, actor_id) because
            // session-create writes a synthesized "sess:actor" id locally
            // before the cloud backend sync brings the real UUID. Both refer to
            // the same logical participant — keep the latest id.
            "INSERT INTO session_participant
                (id, session_id, actor_id, joined_at, created_at, updated_at, deleted_at, synced_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(session_id, actor_id) DO UPDATE SET
                id         = excluded.id,
                joined_at  = excluded.joined_at,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at,
                synced_at  = excluded.synced_at
             WHERE excluded.updated_at >= session_participant.updated_at",
            rows,
            |r| {
                vec![
                    text(&r.id),
                    text(&r.session_id),
                    text(&r.actor_id),
                    opt_val(&r.joined_at),
                    text(&r.created_at),
                    text(&r.updated_at),
                    opt_val(&r.deleted_at),
                    text(&r.synced_at),
                ]
            },
        )
        .await
    }

    pub async fn session_participant_load_session(
        &self,
        session_id: &str,
        include_deleted: bool,
    ) -> Result<Vec<SessionParticipantRow>, String> {
        let conn = self.conn.lock().await;
        let sql = if include_deleted {
            "SELECT id, session_id, actor_id, joined_at, created_at, updated_at, deleted_at, synced_at
             FROM session_participant WHERE session_id = ?1"
        } else {
            "SELECT id, session_id, actor_id, joined_at, created_at, updated_at, deleted_at, synced_at
             FROM session_participant WHERE session_id = ?1 AND deleted_at IS NULL"
        };
        let mut rows = conn
            .query(sql, params![session_id.to_string()])
            .await
            .map_err(|e| format!("session_participant_load_session: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("session_participant_load_session row: {}", e))?
        {
            result.push(SessionParticipantRow {
                id: row.get::<String>(0).unwrap_or_default(),
                session_id: row.get::<String>(1).unwrap_or_default(),
                actor_id: row.get::<String>(2).unwrap_or_default(),
                joined_at: row.get::<String>(3).ok().filter(|s| !s.is_empty()),
                created_at: row.get::<String>(4).unwrap_or_default(),
                updated_at: row.get::<String>(5).unwrap_or_default(),
                deleted_at: row.get::<String>(6).ok().filter(|s| !s.is_empty()),
                synced_at: row.get::<String>(7).unwrap_or_default(),
            });
        }
        Ok(result)
    }

    /// Return the active session ids for one actor inside one team. The local
    /// cache is team-scoped, so callers must use this instead of treating the
    /// entire team cache as the current actor's session list.
    pub async fn session_participant_load_actor(
        &self,
        actor_id: &str,
        team_id: &str,
    ) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT participant.session_id
                 FROM session_participant participant
                 JOIN session s ON s.id = participant.session_id
                 WHERE participant.actor_id = ?1
                   AND participant.deleted_at IS NULL
                   AND s.team_id = ?2
                   AND s.deleted_at IS NULL",
                params![actor_id.to_string(), team_id.to_string()],
            )
            .await
            .map_err(|e| format!("session_participant_load_actor: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("session_participant_load_actor row: {}", e))?
        {
            result.push(row.get::<String>(0).unwrap_or_default());
        }
        Ok(result)
    }

    pub async fn session_participant_soft_delete(
        &self,
        id: &str,
        deleted_at: &str,
    ) -> Result<(), String> {
        let now = deleted_at.to_string();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE session_participant SET deleted_at = ?1, updated_at = ?1, synced_at = ?1 WHERE id = ?2",
            params![now, id.to_string()],
        )
        .await
        .map_err(|e| format!("session_participant_soft_delete: {}", e))?;
        Ok(())
    }

    // ─── message ──────────────────────────────────────────────────────────

    pub async fn message_upsert_batch(&self, rows: &[MessageRow]) -> Result<(), String> {
        let conn = self.conn.lock().await;
        run_write_batch(
            &conn,
            "message_upsert_batch",
            "INSERT INTO message
                (id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id,
                 kind, content, metadata_json, model, mentions_json, origin,
                 created_at, updated_at, deleted_at, synced_at, parts_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
             ON CONFLICT(id) DO UPDATE SET
                team_id             = excluded.team_id,
                session_id          = excluded.session_id,
                turn_id             = excluded.turn_id,
                sender_actor_id     = excluded.sender_actor_id,
                reply_to_message_id = excluded.reply_to_message_id,
                kind                = excluded.kind,
                content             = excluded.content,
                metadata_json       = excluded.metadata_json,
                model               = excluded.model,
                mentions_json       = excluded.mentions_json,
                origin              = excluded.origin,
                created_at          = excluded.created_at,
                updated_at          = excluded.updated_at,
                deleted_at          = excluded.deleted_at,
                synced_at           = excluded.synced_at,
                parts_json          = COALESCE(excluded.parts_json, message.parts_json)
             WHERE excluded.updated_at >= message.updated_at",
            rows,
            |r| {
                vec![
                    text(&r.id),
                    text(&r.team_id),
                    text(&r.session_id),
                    opt_val(&r.turn_id),
                    opt_val(&r.sender_actor_id),
                    opt_val(&r.reply_to_message_id),
                    text(&r.kind),
                    text(&r.content),
                    opt_val(&r.metadata_json),
                    opt_val(&r.model),
                    opt_val(&r.mentions_json),
                    text(&r.origin),
                    text(&r.created_at),
                    text(&r.updated_at),
                    opt_val(&r.deleted_at),
                    text(&r.synced_at),
                    opt_val(&r.parts_json),
                ]
            },
        )
        .await
    }

    /// Merge parts_json into an existing message row. Used when the streaming
    /// pipeline finalizes after the persisted AGENT_REPLY has already landed —
    /// we need to attach thinking/tool_call parts without bumping updated_at
    /// (so subsequent cloud backend syncs with the same updated_at still apply).
    pub async fn message_set_parts(
        &self,
        message_id: &str,
        parts_json: &str,
        workspace_path: Option<&str>,
        runtime: Option<&str>,
    ) -> Result<String, String> {
        let parts_json = enrich_parts_json_from_opencode(parts_json, workspace_path, runtime).await;
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE message SET parts_json = ?1 WHERE id = ?2",
            params![parts_json.clone(), message_id.to_string()],
        )
        .await
        .map_err(|e| format!("message_set_parts: {}", e))?;
        Ok(parts_json)
    }

    /// Every message of a session, oldest first, with opencode tool outputs
    /// merged in where the runtime is unknown or opencode. Callers that know
    /// more use [`Self::message_load_session_with`].
    pub async fn message_load_session(
        &self,
        session_id: &str,
        include_deleted: bool,
        workspace_path: Option<&str>,
    ) -> Result<Vec<MessageRow>, String> {
        self.message_load_session_with(
            session_id,
            include_deleted,
            workspace_path,
            MessageLoadOptions::default(),
        )
        .await
    }

    /// Like [`Self::message_load_session`], but `limit` caps the result to the
    /// newest N rows (still returned oldest first) and `runtime` lets the
    /// opencode lookup be skipped for runtimes that never write that database.
    pub async fn message_load_session_with(
        &self,
        session_id: &str,
        include_deleted: bool,
        workspace_path: Option<&str>,
        options: MessageLoadOptions<'_>,
    ) -> Result<Vec<MessageRow>, String> {
        let limit = options.limit.filter(|n| *n > 0);
        let conn = self.conn.lock().await;
        let mut sql = String::from(
            "SELECT id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id,
                    kind, content, metadata_json, model, mentions_json, origin,
                    created_at, updated_at, deleted_at, synced_at, parts_json
             FROM message WHERE session_id = ?1",
        );
        if !include_deleted {
            sql.push_str(" AND deleted_at IS NULL");
        }
        // With a limit we want the newest N, which means scanning from the
        // end; the vector is flipped back to chronological order below.
        let mut binds = vec![text(session_id)];
        match limit {
            Some(n) => {
                sql.push_str(" ORDER BY created_at DESC LIMIT ?2");
                binds.push(Value::Integer(n));
            }
            None => sql.push_str(" ORDER BY created_at ASC"),
        }
        let mut rows = conn
            .query(&sql, binds)
            .await
            .map_err(|e| format!("message_load_session: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("message_load_session row: {}", e))?
        {
            result.push(MessageRow {
                id: row.get::<String>(0).unwrap_or_default(),
                team_id: row.get::<String>(1).unwrap_or_default(),
                session_id: row.get::<String>(2).unwrap_or_default(),
                turn_id: row.get::<String>(3).ok().filter(|s| !s.is_empty()),
                sender_actor_id: row.get::<String>(4).ok().filter(|s| !s.is_empty()),
                reply_to_message_id: row.get::<String>(5).ok().filter(|s| !s.is_empty()),
                kind: row.get::<String>(6).unwrap_or_default(),
                content: row.get::<String>(7).unwrap_or_default(),
                metadata_json: row.get::<String>(8).ok().filter(|s| !s.is_empty()),
                model: row.get::<String>(9).ok().filter(|s| !s.is_empty()),
                mentions_json: row.get::<String>(10).ok().filter(|s| !s.is_empty()),
                origin: row.get::<String>(11).unwrap_or_default(),
                created_at: row.get::<String>(12).unwrap_or_default(),
                updated_at: row.get::<String>(13).unwrap_or_default(),
                deleted_at: row.get::<String>(14).ok().filter(|s| !s.is_empty()),
                synced_at: row.get::<String>(15).unwrap_or_default(),
                parts_json: row.get::<String>(16).ok().filter(|s| !s.is_empty()),
            });
        }
        drop(rows);
        drop(conn);
        if limit.is_some() {
            result.reverse();
        }
        enrich_message_rows_from_opencode(&mut result, workspace_path, options.runtime).await;
        Ok(result)
    }

    pub async fn message_soft_delete(&self, id: &str, deleted_at: &str) -> Result<(), String> {
        let now = deleted_at.to_string();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE message SET deleted_at = ?1, updated_at = ?1, synced_at = ?1 WHERE id = ?2",
            params![now, id.to_string()],
        )
        .await
        .map_err(|e| format!("message_soft_delete: {}", e))?;
        Ok(())
    }

    // ─── idea ─────────────────────────────────────────────────────────────

    pub async fn idea_upsert_batch(&self, rows: &[IdeaRow]) -> Result<(), String> {
        let conn = self.conn.lock().await;
        run_write_batch(
            &conn,
            "idea_upsert_batch",
            "INSERT INTO idea
                (id, team_id, workspace_id, parent_id, title, description, status,
                 created_by, archived, sort_order, metadata_json, created_at, updated_at, deleted_at, synced_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
             ON CONFLICT(id) DO UPDATE SET
                team_id       = excluded.team_id,
                workspace_id  = excluded.workspace_id,
                parent_id     = excluded.parent_id,
                title         = excluded.title,
                description   = excluded.description,
                status        = excluded.status,
                created_by    = excluded.created_by,
                archived      = excluded.archived,
                sort_order    = excluded.sort_order,
                metadata_json = excluded.metadata_json,
                created_at    = excluded.created_at,
                updated_at    = excluded.updated_at,
                deleted_at    = excluded.deleted_at,
                synced_at     = excluded.synced_at
             WHERE excluded.updated_at >= idea.updated_at",
            rows,
            |r| {
                vec![
                    text(&r.id),
                    text(&r.team_id),
                    opt_val(&r.workspace_id),
                    opt_val(&r.parent_id),
                    text(&r.title),
                    opt_val(&r.description),
                    opt_val(&r.status),
                    opt_val(&r.created_by),
                    Value::Integer(r.archived),
                    Value::Integer(r.sort_order.unwrap_or(0)),
                    opt_val(&r.metadata_json),
                    text(&r.created_at),
                    text(&r.updated_at),
                    opt_val(&r.deleted_at),
                    text(&r.synced_at),
                ]
            },
        )
        .await
    }

    pub async fn idea_load_team(
        &self,
        team_id: &str,
        include_deleted: bool,
    ) -> Result<Vec<IdeaRow>, String> {
        let conn = self.conn.lock().await;
        let sql = if include_deleted {
            "SELECT id, team_id, workspace_id, parent_id, title, description, status,
                    created_by, archived, sort_order, metadata_json, created_at, updated_at, deleted_at, synced_at
             FROM idea WHERE team_id = ?1"
        } else {
            "SELECT id, team_id, workspace_id, parent_id, title, description, status,
                    created_by, archived, sort_order, metadata_json, created_at, updated_at, deleted_at, synced_at
             FROM idea WHERE team_id = ?1 AND deleted_at IS NULL"
        };
        let mut rows = conn
            .query(sql, params![team_id.to_string()])
            .await
            .map_err(|e| format!("idea_load_team: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("idea_load_team row: {}", e))?
        {
            result.push(IdeaRow {
                id: row.get::<String>(0).unwrap_or_default(),
                team_id: row.get::<String>(1).unwrap_or_default(),
                workspace_id: row.get::<String>(2).ok().filter(|s| !s.is_empty()),
                parent_id: row.get::<String>(3).ok().filter(|s| !s.is_empty()),
                title: row.get::<String>(4).unwrap_or_default(),
                description: row.get::<String>(5).ok().filter(|s| !s.is_empty()),
                status: row.get::<String>(6).ok().filter(|s| !s.is_empty()),
                created_by: row.get::<String>(7).ok().filter(|s| !s.is_empty()),
                archived: row.get::<i64>(8).unwrap_or(0),
                sort_order: Some(row.get::<i64>(9).unwrap_or(0)),
                metadata_json: row.get::<String>(10).ok().filter(|s| !s.is_empty()),
                created_at: row.get::<String>(11).unwrap_or_default(),
                updated_at: row.get::<String>(12).unwrap_or_default(),
                deleted_at: row.get::<String>(13).ok().filter(|s| !s.is_empty()),
                synced_at: row.get::<String>(14).unwrap_or_default(),
            });
        }
        Ok(result)
    }

    pub async fn idea_soft_delete(&self, id: &str, deleted_at: &str) -> Result<(), String> {
        let now = deleted_at.to_string();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE idea SET deleted_at = ?1, updated_at = ?1, synced_at = ?1 WHERE id = ?2",
            params![now, id.to_string()],
        )
        .await
        .map_err(|e| format!("idea_soft_delete: {}", e))?;
        Ok(())
    }

    // ─── claim ────────────────────────────────────────────────────────────

    pub async fn claim_upsert_batch(&self, rows: &[ClaimRow]) -> Result<(), String> {
        let conn = self.conn.lock().await;
        run_write_batch(
            &conn,
            "claim_upsert_batch",
            "INSERT INTO claim
                (id, idea_id, actor_id, claimed_at, created_at, updated_at, deleted_at, synced_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET
                idea_id    = excluded.idea_id,
                actor_id   = excluded.actor_id,
                claimed_at = excluded.claimed_at,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at,
                synced_at  = excluded.synced_at
             WHERE excluded.updated_at >= claim.updated_at",
            rows,
            |r| {
                vec![
                    text(&r.id),
                    text(&r.idea_id),
                    text(&r.actor_id),
                    text(&r.claimed_at),
                    text(&r.created_at),
                    text(&r.updated_at),
                    opt_val(&r.deleted_at),
                    text(&r.synced_at),
                ]
            },
        )
        .await
    }

    pub async fn claim_load_idea(
        &self,
        idea_id: &str,
        include_deleted: bool,
    ) -> Result<Vec<ClaimRow>, String> {
        let conn = self.conn.lock().await;
        let sql = if include_deleted {
            "SELECT id, idea_id, actor_id, claimed_at, created_at, updated_at, deleted_at, synced_at
             FROM claim WHERE idea_id = ?1"
        } else {
            "SELECT id, idea_id, actor_id, claimed_at, created_at, updated_at, deleted_at, synced_at
             FROM claim WHERE idea_id = ?1 AND deleted_at IS NULL"
        };
        let mut rows = conn
            .query(sql, params![idea_id.to_string()])
            .await
            .map_err(|e| format!("claim_load_idea: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("claim_load_idea row: {}", e))?
        {
            result.push(ClaimRow {
                id: row.get::<String>(0).unwrap_or_default(),
                idea_id: row.get::<String>(1).unwrap_or_default(),
                actor_id: row.get::<String>(2).unwrap_or_default(),
                claimed_at: row.get::<String>(3).unwrap_or_default(),
                created_at: row.get::<String>(4).unwrap_or_default(),
                updated_at: row.get::<String>(5).unwrap_or_default(),
                deleted_at: row.get::<String>(6).ok().filter(|s| !s.is_empty()),
                synced_at: row.get::<String>(7).unwrap_or_default(),
            });
        }
        Ok(result)
    }

    pub async fn claim_soft_delete(&self, id: &str, deleted_at: &str) -> Result<(), String> {
        let now = deleted_at.to_string();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE claim SET deleted_at = ?1, updated_at = ?1, synced_at = ?1 WHERE id = ?2",
            params![now, id.to_string()],
        )
        .await
        .map_err(|e| format!("claim_soft_delete: {}", e))?;
        Ok(())
    }

    // ─── submission ───────────────────────────────────────────────────────

    pub async fn submission_upsert_batch(&self, rows: &[SubmissionRow]) -> Result<(), String> {
        let conn = self.conn.lock().await;
        run_write_batch(
            &conn,
            "submission_upsert_batch",
            "INSERT INTO submission
                (id, idea_id, actor_id, content, submitted_at, created_at, updated_at, deleted_at, synced_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET
                idea_id      = excluded.idea_id,
                actor_id     = excluded.actor_id,
                content      = excluded.content,
                submitted_at = excluded.submitted_at,
                created_at   = excluded.created_at,
                updated_at   = excluded.updated_at,
                deleted_at   = excluded.deleted_at,
                synced_at    = excluded.synced_at
             WHERE excluded.updated_at >= submission.updated_at",
            rows,
            |r| {
                vec![
                    text(&r.id),
                    text(&r.idea_id),
                    text(&r.actor_id),
                    opt_val(&r.content),
                    text(&r.submitted_at),
                    text(&r.created_at),
                    text(&r.updated_at),
                    opt_val(&r.deleted_at),
                    text(&r.synced_at),
                ]
            },
        )
        .await
    }

    pub async fn submission_load_idea(
        &self,
        idea_id: &str,
        include_deleted: bool,
    ) -> Result<Vec<SubmissionRow>, String> {
        let conn = self.conn.lock().await;
        let sql = if include_deleted {
            "SELECT id, idea_id, actor_id, content, submitted_at, created_at, updated_at, deleted_at, synced_at
             FROM submission WHERE idea_id = ?1"
        } else {
            "SELECT id, idea_id, actor_id, content, submitted_at, created_at, updated_at, deleted_at, synced_at
             FROM submission WHERE idea_id = ?1 AND deleted_at IS NULL"
        };
        let mut rows = conn
            .query(sql, params![idea_id.to_string()])
            .await
            .map_err(|e| format!("submission_load_idea: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("submission_load_idea row: {}", e))?
        {
            result.push(SubmissionRow {
                id: row.get::<String>(0).unwrap_or_default(),
                idea_id: row.get::<String>(1).unwrap_or_default(),
                actor_id: row.get::<String>(2).unwrap_or_default(),
                content: row.get::<String>(3).ok().filter(|s| !s.is_empty()),
                submitted_at: row.get::<String>(4).unwrap_or_default(),
                created_at: row.get::<String>(5).unwrap_or_default(),
                updated_at: row.get::<String>(6).unwrap_or_default(),
                deleted_at: row.get::<String>(7).ok().filter(|s| !s.is_empty()),
                synced_at: row.get::<String>(8).unwrap_or_default(),
            });
        }
        Ok(result)
    }

    pub async fn submission_soft_delete(&self, id: &str, deleted_at: &str) -> Result<(), String> {
        let now = deleted_at.to_string();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE submission SET deleted_at = ?1, updated_at = ?1, synced_at = ?1 WHERE id = ?2",
            params![now, id.to_string()],
        )
        .await
        .map_err(|e| format!("submission_soft_delete: {}", e))?;
        Ok(())
    }

    // ─── agent_runtime_event ──────────────────────────────────────────────

    pub async fn agent_runtime_event_upsert(
        &self,
        row: &AgentRuntimeEventRow,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO agent_runtime_event
                (id, session_id, turn_id, sender_actor_id, kind, content, metadata_json, model, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET
                session_id      = excluded.session_id,
                turn_id         = excluded.turn_id,
                sender_actor_id = excluded.sender_actor_id,
                kind            = excluded.kind,
                content         = excluded.content,
                metadata_json   = excluded.metadata_json,
                model           = excluded.model,
                created_at      = excluded.created_at",
            params![
                row.id.clone(),
                row.session_id.clone(),
                opt_val(&row.turn_id),
                opt_val(&row.sender_actor_id),
                row.kind.clone(),
                row.content.clone(),
                opt_val(&row.metadata_json),
                opt_val(&row.model),
                row.created_at.clone()
            ],
        )
        .await
        .map_err(|e| format!("agent_runtime_event_upsert: {}", e))?;
        Ok(())
    }

    pub async fn agent_runtime_event_load_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<AgentRuntimeEventRow>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT id, session_id, turn_id, sender_actor_id, kind, content,
                        metadata_json, model, created_at
                 FROM agent_runtime_event
                 WHERE session_id = ?1
                 ORDER BY created_at ASC",
                params![session_id.to_string()],
            )
            .await
            .map_err(|e| format!("agent_runtime_event_load_session: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("agent_runtime_event_load_session row: {}", e))?
        {
            result.push(AgentRuntimeEventRow {
                id: row.get::<String>(0).unwrap_or_default(),
                session_id: row.get::<String>(1).unwrap_or_default(),
                turn_id: row.get::<String>(2).ok().filter(|s| !s.is_empty()),
                sender_actor_id: row.get::<String>(3).ok().filter(|s| !s.is_empty()),
                kind: row.get::<String>(4).unwrap_or_default(),
                content: row.get::<String>(5).unwrap_or_default(),
                metadata_json: row.get::<String>(6).ok().filter(|s| !s.is_empty()),
                model: row.get::<String>(7).ok().filter(|s| !s.is_empty()),
                created_at: row.get::<String>(8).unwrap_or_default(),
            });
        }
        Ok(result)
    }

    pub async fn agent_runtime_event_prune(&self, max_rows: i64) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM agent_runtime_event WHERE id IN (
                SELECT id FROM agent_runtime_event ORDER BY created_at DESC LIMIT -1 OFFSET ?1
            )",
            params![max_rows],
        )
        .await
        .ok();
        Ok(())
    }

    // ─── outbox ───────────────────────────────────────────────────────────

    /// Upsert an outbox row. Used both for initial enqueue (state="pending",
    /// attempt_count=0) and for state transitions after a send attempt
    /// (state, attempt_count, last_attempt_at, next_attempt_at, last_error).
    pub async fn outbox_upsert(&self, row: &OutboxRow) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO outbox
                (message_id, team_id, session_id, sender_actor_id, content,
                 mention_actor_ids_json, display_mention_actor_ids_json, attachment_urls_json,
                 state, attempt_count, last_attempt_at, next_attempt_at, last_error,
                 created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
             ON CONFLICT(message_id) DO UPDATE SET
                state            = excluded.state,
                attempt_count    = excluded.attempt_count,
                last_attempt_at  = excluded.last_attempt_at,
                next_attempt_at  = excluded.next_attempt_at,
                last_error       = excluded.last_error,
                updated_at       = excluded.updated_at",
            params![
                row.message_id.clone(),
                row.team_id.clone(),
                row.session_id.clone(),
                row.sender_actor_id.clone(),
                row.content.clone(),
                opt_val(&row.mention_actor_ids_json),
                opt_val(&row.display_mention_actor_ids_json),
                opt_val(&row.attachment_urls_json),
                row.state.clone(),
                row.attempt_count,
                opt_val(&row.last_attempt_at),
                opt_val(&row.next_attempt_at),
                opt_val(&row.last_error),
                row.created_at.clone(),
                row.updated_at.clone()
            ],
        )
        .await
        .map_err(|e| format!("outbox_upsert: {}", e))?;
        Ok(())
    }

    /// Delete an outbox row by message_id. Called after `delivered` rows have
    /// been observed by the UI (or by a periodic GC pass).
    pub async fn outbox_delete(&self, message_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM outbox WHERE message_id = ?1",
            params![message_id.to_string()],
        )
        .await
        .map_err(|e| format!("outbox_delete: {}", e))?;
        Ok(())
    }

    /// Load all outbox rows ordered by created_at ASC. Frontend uses this on
    /// boot to rehydrate the outbox store and resume retry loop.
    pub async fn outbox_list_all(&self) -> Result<Vec<OutboxRow>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT message_id, team_id, session_id, sender_actor_id, content,
                        mention_actor_ids_json, display_mention_actor_ids_json, attachment_urls_json,
                        state, attempt_count, last_attempt_at, next_attempt_at, last_error,
                        created_at, updated_at
                 FROM outbox ORDER BY created_at ASC",
                (),
            )
            .await
            .map_err(|e| format!("outbox_list_all: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("outbox_list_all row: {}", e))?
        {
            result.push(OutboxRow {
                message_id: row.get::<String>(0).unwrap_or_default(),
                team_id: row.get::<String>(1).unwrap_or_default(),
                session_id: row.get::<String>(2).unwrap_or_default(),
                sender_actor_id: row.get::<String>(3).unwrap_or_default(),
                content: row.get::<String>(4).unwrap_or_default(),
                mention_actor_ids_json: row.get::<String>(5).ok().filter(|s| !s.is_empty()),
                display_mention_actor_ids_json: row.get::<String>(6).ok().filter(|s| !s.is_empty()),
                attachment_urls_json: row.get::<String>(7).ok().filter(|s| !s.is_empty()),
                state: row.get::<String>(8).unwrap_or_default(),
                attempt_count: row.get::<i64>(9).unwrap_or(0),
                last_attempt_at: row.get::<String>(10).ok().filter(|s| !s.is_empty()),
                next_attempt_at: row.get::<String>(11).ok().filter(|s| !s.is_empty()),
                last_error: row.get::<String>(12).ok().filter(|s| !s.is_empty()),
                created_at: row.get::<String>(13).unwrap_or_default(),
                updated_at: row.get::<String>(14).unwrap_or_default(),
            });
        }
        Ok(result)
    }

    // ─── team-lookup helpers (used by the current-team gate) ──────────────
    //
    // Each helper resolves the `team_id` of a row identified by some non-team
    // key (session_id, idea_id, etc). Returns Ok(None) if the row does not
    // exist, so the caller can decide whether to fail open or closed.

    pub async fn team_for_session(&self, session_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT team_id FROM session WHERE id = ?1",
                params![session_id.to_string()],
            )
            .await
            .map_err(|e| format!("team_for_session: {}", e))?;
        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("team_for_session row: {}", e))?
        {
            return Ok(row.get::<String>(0).ok());
        }
        Ok(None)
    }

    /// `id -> team_id` for every session in `ids` that exists locally. One
    /// statement per 500 ids under one lock acquisition, instead of the
    /// per-row `team_for_session` round trip the batch gates used to make.
    pub async fn teams_for_sessions(
        &self,
        ids: &[String],
    ) -> Result<HashMap<String, String>, String> {
        self.owner_lookup("session", "teams_for_sessions", ids)
            .await
    }

    /// `id -> team_id` for every idea in `ids` that exists locally.
    pub async fn teams_for_ideas(&self, ids: &[String]) -> Result<HashMap<String, String>, String> {
        self.owner_lookup("idea", "teams_for_ideas", ids).await
    }

    async fn owner_lookup(
        &self,
        table: &str,
        label: &str,
        ids: &[String],
    ) -> Result<HashMap<String, String>, String> {
        let mut owners = HashMap::new();
        if ids.is_empty() {
            return Ok(owners);
        }
        let conn = self.conn.lock().await;
        for chunk in ids.chunks(MAX_IN_LIST) {
            let sql = format!(
                "SELECT id, team_id FROM {table} WHERE id IN ({})",
                placeholders(chunk.len(), 0)
            );
            let binds = chunk.iter().map(|id| text(id)).collect::<Vec<_>>();
            let mut rows = conn
                .query(&sql, binds)
                .await
                .map_err(|e| format!("{label}: {e}"))?;
            while let Some(row) = rows.next().await.map_err(|e| format!("{label} row: {e}"))? {
                if let (Ok(id), Ok(team)) = (row.get::<String>(0), row.get::<String>(1)) {
                    owners.insert(id, team);
                }
            }
        }
        Ok(owners)
    }

    pub async fn team_for_idea(&self, idea_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT team_id FROM idea WHERE id = ?1",
                params![idea_id.to_string()],
            )
            .await
            .map_err(|e| format!("team_for_idea: {}", e))?;
        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("team_for_idea row: {}", e))?
        {
            return Ok(row.get::<String>(0).ok());
        }
        Ok(None)
    }

    pub async fn team_for_actor(&self, actor_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT team_id FROM actor WHERE id = ?1",
                params![actor_id.to_string()],
            )
            .await
            .map_err(|e| format!("team_for_actor: {}", e))?;
        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("team_for_actor row: {}", e))?
        {
            return Ok(row.get::<String>(0).ok());
        }
        Ok(None)
    }

    pub async fn team_for_message(&self, message_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT team_id FROM message WHERE id = ?1",
                params![message_id.to_string()],
            )
            .await
            .map_err(|e| format!("team_for_message: {}", e))?;
        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("team_for_message row: {}", e))?
        {
            return Ok(row.get::<String>(0).ok());
        }
        Ok(None)
    }

    pub async fn team_for_outbox(&self, message_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT team_id FROM outbox WHERE message_id = ?1",
                params![message_id.to_string()],
            )
            .await
            .map_err(|e| format!("team_for_outbox: {}", e))?;
        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("team_for_outbox row: {}", e))?
        {
            return Ok(row.get::<String>(0).ok());
        }
        Ok(None)
    }

    pub async fn team_for_participant(&self, id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT s.team_id FROM session_participant sp \
                 JOIN session s ON s.id = sp.session_id WHERE sp.id = ?1",
                params![id.to_string()],
            )
            .await
            .map_err(|e| format!("team_for_participant: {}", e))?;
        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("team_for_participant row: {}", e))?
        {
            return Ok(row.get::<String>(0).ok());
        }
        Ok(None)
    }

    pub async fn team_for_claim(&self, id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT i.team_id FROM claim c JOIN idea i ON i.id = c.idea_id WHERE c.id = ?1",
                params![id.to_string()],
            )
            .await
            .map_err(|e| format!("team_for_claim: {}", e))?;
        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("team_for_claim row: {}", e))?
        {
            return Ok(row.get::<String>(0).ok());
        }
        Ok(None)
    }

    pub async fn team_for_submission(&self, id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT i.team_id FROM submission s JOIN idea i ON i.id = s.idea_id WHERE s.id = ?1",
                params![id.to_string()],
            )
            .await
            .map_err(|e| format!("team_for_submission: {}", e))?;
        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("team_for_submission row: {}", e))?
        {
            return Ok(row.get::<String>(0).ok());
        }
        Ok(None)
    }

    /// Variant of `outbox_list_all` that filters to a single team.
    pub async fn outbox_list_team(&self, team_id: &str) -> Result<Vec<OutboxRow>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT message_id, team_id, session_id, sender_actor_id, content,
                        mention_actor_ids_json, display_mention_actor_ids_json, attachment_urls_json,
                        state, attempt_count, last_attempt_at, next_attempt_at, last_error,
                        created_at, updated_at
                 FROM outbox WHERE team_id = ?1 ORDER BY created_at ASC",
                params![team_id.to_string()],
            )
            .await
            .map_err(|e| format!("outbox_list_team: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("outbox_list_team row: {}", e))?
        {
            result.push(OutboxRow {
                message_id: row.get::<String>(0).unwrap_or_default(),
                team_id: row.get::<String>(1).unwrap_or_default(),
                session_id: row.get::<String>(2).unwrap_or_default(),
                sender_actor_id: row.get::<String>(3).unwrap_or_default(),
                content: row.get::<String>(4).unwrap_or_default(),
                mention_actor_ids_json: row.get::<String>(5).ok().filter(|s| !s.is_empty()),
                display_mention_actor_ids_json: row.get::<String>(6).ok().filter(|s| !s.is_empty()),
                attachment_urls_json: row.get::<String>(7).ok().filter(|s| !s.is_empty()),
                state: row.get::<String>(8).unwrap_or_default(),
                attempt_count: row.get::<i64>(9).unwrap_or(0),
                last_attempt_at: row.get::<String>(10).ok().filter(|s| !s.is_empty()),
                next_attempt_at: row.get::<String>(11).ok().filter(|s| !s.is_empty()),
                last_error: row.get::<String>(12).ok().filter(|s| !s.is_empty()),
                created_at: row.get::<String>(13).unwrap_or_default(),
                updated_at: row.get::<String>(14).unwrap_or_default(),
            });
        }
        Ok(result)
    }

    // ─── sync watermark ───────────────────────────────────────────────────

    pub async fn watermark_get(
        &self,
        table_name: &str,
        team_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT last_sync_at FROM sync_state WHERE table_name = ?1 AND team_id = ?2",
                params![table_name.to_string(), team_id.to_string()],
            )
            .await
            .map_err(|e| format!("watermark_get: {}", e))?;
        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("watermark_get row: {}", e))?
        {
            return Ok(row.get::<String>(0).ok());
        }
        Ok(None)
    }

    pub async fn watermark_set(
        &self,
        table_name: &str,
        team_id: &str,
        last_sync_at: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO sync_state (table_name, team_id, last_sync_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(table_name, team_id) DO UPDATE SET last_sync_at = excluded.last_sync_at",
            params![
                table_name.to_string(),
                team_id.to_string(),
                last_sync_at.to_string()
            ],
        )
        .await
        .map_err(|e| format!("watermark_set: {}", e))?;
        Ok(())
    }

    // ─── clear_team ───────────────────────────────────────────────────────

    /// Wipe all cached data for a given team (used by global ↻ refresh in Settings).
    pub async fn clear_team(&self, team_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().await;
        // Cascade order: leaf tables before parent tables
        conn.execute(
            "DELETE FROM claim WHERE idea_id IN (SELECT id FROM idea WHERE team_id = ?1)",
            params![team_id.to_string()],
        )
        .await
        .map_err(|e| format!("clear_team claim: {}", e))?;

        conn.execute(
            "DELETE FROM submission WHERE idea_id IN (SELECT id FROM idea WHERE team_id = ?1)",
            params![team_id.to_string()],
        )
        .await
        .map_err(|e| format!("clear_team submission: {}", e))?;

        conn.execute(
            "DELETE FROM session_participant WHERE session_id IN (SELECT id FROM session WHERE team_id = ?1)",
            params![team_id.to_string()],
        )
        .await
        .map_err(|e| format!("clear_team session_participant: {}", e))?;

        conn.execute(
            "DELETE FROM message WHERE team_id = ?1",
            params![team_id.to_string()],
        )
        .await
        .map_err(|e| format!("clear_team message: {}", e))?;

        conn.execute(
            "DELETE FROM outbox WHERE team_id = ?1",
            params![team_id.to_string()],
        )
        .await
        .map_err(|e| format!("clear_team outbox: {}", e))?;

        conn.execute(
            "DELETE FROM idea WHERE team_id = ?1",
            params![team_id.to_string()],
        )
        .await
        .map_err(|e| format!("clear_team idea: {}", e))?;

        conn.execute(
            "DELETE FROM session WHERE team_id = ?1",
            params![team_id.to_string()],
        )
        .await
        .map_err(|e| format!("clear_team session: {}", e))?;

        conn.execute(
            "DELETE FROM actor WHERE team_id = ?1",
            params![team_id.to_string()],
        )
        .await
        .map_err(|e| format!("clear_team actor: {}", e))?;

        conn.execute(
            "DELETE FROM sync_state WHERE team_id = ?1",
            params![team_id.to_string()],
        )
        .await
        .map_err(|e| format!("clear_team sync_state: {}", e))?;

        Ok(())
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Returns (store, tempdir). Caller must hold `_dir` to keep the temp directory alive.
    async fn new_store() -> (LocalCacheStore, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.db");
        let store = LocalCacheStore::new(&path).await.unwrap();
        (store, dir)
    }

    fn actor(id: &str, team: &str, updated_at: &str) -> ActorRow {
        ActorRow {
            id: id.to_string(),
            team_id: team.to_string(),
            actor_type: "member".to_string(),
            display_name: "Test".to_string(),
            avatar_url: None,
            member_status: None,
            agent_status: None,
            last_active_at: None,
            metadata_json: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: updated_at.to_string(),
            deleted_at: None,
            synced_at: "2024-01-01T00:00:00Z".to_string(),
            team_role: None,
            agent_visibility: None,
            owner_member_id: None,
        }
    }

    #[tokio::test]
    async fn upsert_and_load_actor() {
        let (store, _dir) = new_store().await;
        let a = actor("a1", "team1", "2024-01-01T00:00:00Z");
        store.actor_upsert_batch(&[a.clone()]).await.unwrap();
        let loaded = store.actor_load_team("team1", false).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "a1");
    }

    #[tokio::test]
    async fn actor_caches_role_and_visibility() {
        let (store, _dir) = new_store().await;
        let mut a = actor("a1", "team1", "2024-01-01T00:00:00Z");
        a.team_role = Some("owner".to_string());
        a.agent_visibility = Some("personal".to_string());
        a.owner_member_id = Some("member-1".to_string());
        store.actor_upsert_batch(&[a]).await.unwrap();
        let loaded = store.actor_load_team("team1", false).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].team_role.as_deref(), Some("owner"));
        assert_eq!(loaded[0].agent_visibility.as_deref(), Some("personal"));
        assert_eq!(loaded[0].owner_member_id.as_deref(), Some("member-1"));
        // Same fields must survive the by-ids load path too.
        let by_ids = store.actor_load_by_ids(&["a1".to_string()]).await.unwrap();
        assert_eq!(by_ids[0].agent_visibility.as_deref(), Some("personal"));
        assert_eq!(by_ids[0].owner_member_id.as_deref(), Some("member-1"));
    }

    #[tokio::test]
    async fn upsert_newer_wins_older_doesnt() {
        let (store, _dir) = new_store().await;
        // Insert with updated_at=2
        let new = actor("a2", "team1", "2024-01-02T00:00:00Z");
        store.actor_upsert_batch(&[new]).await.unwrap();
        // Now try to overwrite with updated_at=1 (should be ignored)
        let old = ActorRow {
            display_name: "OldName".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            ..actor("a2", "team1", "2024-01-01T00:00:00Z")
        };
        store.actor_upsert_batch(&[old]).await.unwrap();
        let loaded = store.actor_load_team("team1", false).await.unwrap();
        assert_eq!(loaded.len(), 1);
        // Should still have the newer name ("Test"), not "OldName"
        assert_eq!(loaded[0].display_name, "Test");
    }

    #[tokio::test]
    async fn soft_delete_hides_by_default() {
        let (store, _dir) = new_store().await;
        let a = actor("a3", "team1", "2024-01-01T00:00:00Z");
        store.actor_upsert_batch(&[a]).await.unwrap();

        store
            .actor_soft_delete("a3", "2024-01-02T00:00:00Z")
            .await
            .unwrap();

        // exclude deleted (default)
        let visible = store.actor_load_team("team1", false).await.unwrap();
        assert_eq!(visible.len(), 0);

        // include deleted
        let all = store.actor_load_team("team1", true).await.unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].deleted_at.is_some());
    }

    #[tokio::test]
    async fn watermark_round_trip() {
        let (store, _dir) = new_store().await;
        let before = store.watermark_get("actor", "team1").await.unwrap();
        assert!(before.is_none());

        store
            .watermark_set("actor", "team1", "2024-06-01T12:00:00Z")
            .await
            .unwrap();

        let after = store.watermark_get("actor", "team1").await.unwrap();
        assert_eq!(after.unwrap(), "2024-06-01T12:00:00Z");
    }

    fn session(id: &str, team: &str) -> SessionRow {
        SessionRow {
            id: id.to_string(),
            team_id: team.to_string(),
            title: None,
            mode: None,
            primary_agent_id: None,
            idea_id: None,
            summary: None,
            last_message_preview: None,
            last_message_at: None,
            created_by: None,
            metadata_json: None,
            source: None,
            cron_job_id: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            deleted_at: None,
            synced_at: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    fn idea(id: &str, team: &str) -> IdeaRow {
        IdeaRow {
            id: id.to_string(),
            team_id: team.to_string(),
            workspace_id: None,
            parent_id: None,
            title: "T".to_string(),
            description: None,
            status: None,
            created_by: None,
            archived: 0,
            sort_order: Some(0),
            metadata_json: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            deleted_at: None,
            synced_at: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    fn outbox(message_id: &str, team: &str, session_id: &str) -> OutboxRow {
        OutboxRow {
            message_id: message_id.to_string(),
            team_id: team.to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: "actor1".to_string(),
            content: "hi".to_string(),
            mention_actor_ids_json: None,
            display_mention_actor_ids_json: None,
            attachment_urls_json: None,
            state: "pending".to_string(),
            attempt_count: 0,
            last_attempt_at: None,
            next_attempt_at: None,
            last_error: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn team_for_lookups_resolve_owner() {
        let (store, _dir) = new_store().await;
        store
            .actor_upsert_batch(&[actor("a1", "teamA", "2024-01-01T00:00:00Z")])
            .await
            .unwrap();
        store
            .session_upsert_batch(&[session("s1", "teamA")])
            .await
            .unwrap();
        store
            .idea_upsert_batch(&[idea("i1", "teamB")])
            .await
            .unwrap();
        store
            .outbox_upsert(&outbox("m1", "teamA", "s1"))
            .await
            .unwrap();

        assert_eq!(
            store.team_for_actor("a1").await.unwrap().as_deref(),
            Some("teamA")
        );
        assert_eq!(
            store.team_for_session("s1").await.unwrap().as_deref(),
            Some("teamA")
        );
        assert_eq!(
            store.team_for_idea("i1").await.unwrap().as_deref(),
            Some("teamB")
        );
        assert_eq!(
            store.team_for_outbox("m1").await.unwrap().as_deref(),
            Some("teamA")
        );
        assert!(store
            .team_for_session("does-not-exist")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn session_source_and_cron_job_id_round_trip() {
        let (store, _dir) = new_store().await;
        let mut cron = session("s-cron", "teamA");
        cron.source = Some("cron".to_string());
        cron.cron_job_id = Some("job-42".to_string());
        store
            .session_upsert_batch(&[cron, session("s-user", "teamA")])
            .await
            .unwrap();

        let rows = store.session_load_team("teamA", false).await.unwrap();
        let loaded_cron = rows.iter().find(|r| r.id == "s-cron").unwrap();
        assert_eq!(loaded_cron.source.as_deref(), Some("cron"));
        assert_eq!(loaded_cron.cron_job_id.as_deref(), Some("job-42"));

        // A plain session has no source/cron marker after the round-trip.
        let loaded_user = rows.iter().find(|r| r.id == "s-user").unwrap();
        assert_eq!(loaded_user.source, None);
        assert_eq!(loaded_user.cron_job_id, None);
    }

    #[tokio::test]
    async fn outbox_list_team_filters_by_team() {
        let (store, _dir) = new_store().await;
        store
            .session_upsert_batch(&[session("s1", "teamA"), session("s2", "teamB")])
            .await
            .unwrap();
        store
            .outbox_upsert(&outbox("m1", "teamA", "s1"))
            .await
            .unwrap();
        store
            .outbox_upsert(&outbox("m2", "teamB", "s2"))
            .await
            .unwrap();

        let only_a = store.outbox_list_team("teamA").await.unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].message_id, "m1");

        let all = store.outbox_list_all().await.unwrap();
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn clear_team_wipes_only_that_team() {
        let (store, _dir) = new_store().await;
        let a = actor("a_teamA", "teamA", "2024-01-01T00:00:00Z");
        let b = actor("b_teamB", "teamB", "2024-01-01T00:00:00Z");
        store.actor_upsert_batch(&[a, b]).await.unwrap();

        store.clear_team("teamA").await.unwrap();

        let team_a = store.actor_load_team("teamA", true).await.unwrap();
        let team_b = store.actor_load_team("teamB", true).await.unwrap();

        assert_eq!(team_a.len(), 0, "teamA should be wiped");
        assert_eq!(team_b.len(), 1, "teamB should be untouched");
    }

    #[test]
    fn opencode_part_call_output_reads_real_tool_stdout() {
        let data = serde_json::json!({
            "type": "tool",
            "tool": "bash",
            "callID": "call_1",
            "state": {
                "status": "completed",
                "input": {
                    "command": "ps -o pid,%cpu,%mem,comm -r | head -10",
                    "description": "Top 10 processes by CPU"
                },
                "output": "PID %CPU COMM\n1 launchd\n",
                "metadata": {
                    "output": "metadata output",
                    "description": "Top 10 processes by CPU"
                }
            }
        })
        .to_string();

        let (call_id, output) = opencode_part_call_output(&data).expect("completed tool part");
        assert_eq!(call_id, "call_1");
        assert_eq!(output, "PID %CPU COMM\n1 launchd\n");
    }

    #[test]
    fn collect_opencode_tool_ids_only_when_result_is_description() {
        let parts_json = serde_json::json!([
            {
                "type": "tool-call",
                "toolCallId": "call_needs_output",
                "toolCall": {
                    "id": "call_needs_output",
                    "result": "Top 10 processes by CPU",
                    "arguments": {
                        "description": "Top 10 processes by CPU"
                    }
                }
            },
            {
                "type": "tool-call",
                "toolCallId": "call_has_output",
                "toolCall": {
                    "id": "call_has_output",
                    "result": "PID %CPU COMM\n1 launchd\n",
                    "arguments": {
                        "description": "Top 10 processes by CPU"
                    }
                }
            }
        ])
        .to_string();

        let ids = collect_opencode_tool_ids_from_parts_json(&parts_json);
        assert!(ids.contains("call_needs_output"));
        assert!(!ids.contains("call_has_output"));
    }

    #[test]
    fn enrich_parts_json_with_opencode_output_replaces_title_result() {
        let parts_json = serde_json::json!([
            {
                "id": "stream:tool:call_1",
                "type": "tool-call",
                "toolCallId": "call_1",
                "toolCall": {
                    "id": "call_1",
                    "name": "bash",
                    "status": "completed",
                    "arguments": {
                        "_description": "{\"command\":\"ps -o pid,%cpu,%mem,comm -r | head -10\",\"description\":\"Top 10 processes by CPU\"}",
                        "command": "ps -o pid,%cpu,%mem,comm -r | head -10",
                        "description": "Top 10 processes by CPU"
                    },
                    "result": "Top 10 processes by CPU"
                }
            }
        ])
        .to_string();
        let outputs = HashMap::from([(
            "call_1".to_string(),
            "PID %CPU COMM\n50369 opencode\n".to_string(),
        )]);

        let enriched = enrich_parts_json_with_opencode_outputs(&parts_json, &outputs).unwrap();
        let parsed = serde_json::from_str::<serde_json::Value>(&enriched).unwrap();
        assert_eq!(
            parsed
                .pointer("/0/toolCall/result")
                .and_then(|v| v.as_str()),
            Some("PID %CPU COMM\n50369 opencode\n")
        );
    }

    #[tokio::test]
    async fn session_workspace_upsert_and_load_roundtrip() {
        let (store, _dir) = new_store().await;
        store
            .session_workspace_upsert_batch(&[
                SessionWorkspaceRow {
                    session_id: "s1".into(),
                    team_id: "teamA".into(),
                    viewer_member_id: "member-a".into(),
                    agent_id: "agent-a".into(),
                    workspace_id: Some("ws1".into()),
                    workspace_path: Some("/Users/me/proj".into()),
                    updated_at: "2026-06-04T00:00:00Z".into(),
                },
                SessionWorkspaceRow {
                    session_id: "s2".into(),
                    team_id: "teamB".into(),
                    viewer_member_id: "member-b".into(),
                    agent_id: "agent-b".into(),
                    workspace_id: Some("ws2".into()),
                    workspace_path: None,
                    updated_at: "2026-06-04T00:00:00Z".into(),
                },
            ])
            .await
            .unwrap();
        let rows = store
            .session_workspace_load_team("teamA", "member-a")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "s1");
        assert_eq!(rows[0].agent_id, "agent-a");
        assert_eq!(rows[0].workspace_id.as_deref(), Some("ws1"));
        assert_eq!(rows[0].workspace_path.as_deref(), Some("/Users/me/proj"));
        store
            .session_workspace_upsert_batch(&[SessionWorkspaceRow {
                session_id: "s1".into(),
                team_id: "teamA".into(),
                viewer_member_id: "member-a".into(),
                agent_id: "agent-a".into(),
                workspace_id: Some("ws9".into()),
                workspace_path: Some("/Users/me/other".into()),
                updated_at: "2026-06-05T00:00:00Z".into(),
            }])
            .await
            .unwrap();
        let rows = store
            .session_workspace_load_team("teamA", "member-a")
            .await
            .unwrap();
        assert_eq!(rows[0].workspace_id.as_deref(), Some("ws9"));
        // Second agent in the same session is stored independently.
        store
            .session_workspace_upsert_batch(&[SessionWorkspaceRow {
                session_id: "s1".into(),
                team_id: "teamA".into(),
                viewer_member_id: "member-a".into(),
                agent_id: "agent-a2".into(),
                workspace_id: Some("ws2".into()),
                workspace_path: Some("/Users/me/other2".into()),
                updated_at: "2026-06-06T00:00:00Z".into(),
            }])
            .await
            .unwrap();
        let rows = store
            .session_workspace_load_team("teamA", "member-a")
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
    }

    fn message(id: &str, session: &str, created_at: &str) -> MessageRow {
        MessageRow {
            id: id.to_string(),
            team_id: "teamA".to_string(),
            session_id: session.to_string(),
            turn_id: None,
            sender_actor_id: None,
            reply_to_message_id: None,
            kind: "text".to_string(),
            content: format!("body of {id}"),
            metadata_json: None,
            model: None,
            mentions_json: None,
            origin: "test".to_string(),
            created_at: created_at.to_string(),
            updated_at: created_at.to_string(),
            deleted_at: None,
            synced_at: created_at.to_string(),
            parts_json: None,
        }
    }

    #[tokio::test]
    async fn store_opens_in_wal_with_normal_sync() {
        let (store, _dir) = new_store().await;
        let conn = store.conn().await;
        let mut rows = conn.query("PRAGMA journal_mode", ()).await.unwrap();
        let mode: String = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let mut rows = conn.query("PRAGMA synchronous", ()).await.unwrap();
        let sync: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(sync, 1, "synchronous should be NORMAL (1)");
    }

    #[tokio::test]
    async fn run_write_batch_rolls_back_the_whole_batch_on_error() {
        let (store, _dir) = new_store().await;
        let conn = store.conn().await;
        conn.execute(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL CHECK(length(v) > 0))",
            (),
        )
        .await
        .unwrap();

        let rows = vec!["a".to_string(), String::new(), "b".to_string()];
        let err = run_write_batch(&conn, "t", "INSERT INTO t (v) VALUES (?1)", &rows, |v| {
            vec![text(v)]
        })
        .await
        .unwrap_err();
        assert!(err.starts_with("t: "), "{err}");

        // The row before the failure is gone too: one transaction, not three.
        let mut rows = conn.query("SELECT COUNT(*) FROM t", ()).await.unwrap();
        let n: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(n, 0);
        assert!(
            conn.is_autocommit(),
            "failed batch must not leave a tx open"
        );

        // And the connection is usable for the next batch.
        let rows = vec!["x".to_string(), "y".to_string()];
        run_write_batch(&conn, "t", "INSERT INTO t (v) VALUES (?1)", &rows, |v| {
            vec![text(v)]
        })
        .await
        .unwrap();
        let mut rows = conn.query("SELECT COUNT(*) FROM t", ()).await.unwrap();
        let n: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(n, 2);
        assert!(conn.is_autocommit());
    }

    #[tokio::test]
    async fn message_upsert_batch_lands_every_row_and_keeps_newest_duplicate() {
        let (store, _dir) = new_store().await;
        let mut rows = (0..300)
            .map(|i| {
                message(
                    &format!("m{i:03}"),
                    "s1",
                    &format!("2024-01-01T00:{:02}:{:02}Z", i / 60, i % 60),
                )
            })
            .collect::<Vec<_>>();
        // Same id twice in one batch: the later, newer row must win.
        let mut dup = message("m000", "s1", "2024-01-02T00:00:00Z");
        dup.content = "newer".to_string();
        rows.push(dup);
        store.message_upsert_batch(&rows).await.unwrap();

        let loaded = store.message_load_session("s1", false, None).await.unwrap();
        assert_eq!(loaded.len(), 300);
        assert_eq!(loaded.first().unwrap().id, "m001");
        assert_eq!(loaded.last().unwrap().id, "m000", "m000 now sorts last");
        assert_eq!(loaded.last().unwrap().content, "newer");
    }

    #[tokio::test]
    async fn message_load_session_limit_returns_newest_in_chronological_order() {
        let (store, _dir) = new_store().await;
        let rows = (1..=5)
            .map(|i| message(&format!("m{i}"), "s1", &format!("2024-01-01T00:00:0{i}Z")))
            .collect::<Vec<_>>();
        store.message_upsert_batch(&rows).await.unwrap();

        let ids = |rows: Vec<MessageRow>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
        let newest_two = store
            .message_load_session_with(
                "s1",
                false,
                None,
                MessageLoadOptions {
                    limit: Some(2),
                    runtime: Some("pi"),
                },
            )
            .await
            .unwrap();
        assert_eq!(ids(newest_two), vec!["m4", "m5"]);

        for limit in [None, Some(0), Some(-1), Some(10)] {
            let all = store
                .message_load_session_with(
                    "s1",
                    false,
                    None,
                    MessageLoadOptions {
                        limit,
                        runtime: Some("pi"),
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                ids(all),
                vec!["m1", "m2", "m3", "m4", "m5"],
                "limit {limit:?}"
            );
        }
    }

    #[test]
    fn opencode_enrichment_applies_only_to_opencode_or_unknown_runtime() {
        assert!(opencode_enrichment_applies(None));
        assert!(opencode_enrichment_applies(Some("")));
        assert!(opencode_enrichment_applies(Some("opencode")));
        assert!(opencode_enrichment_applies(Some(" OpenCode ")));
        assert!(!opencode_enrichment_applies(Some("pi")));
        assert!(!opencode_enrichment_applies(Some("cursor")));
        assert!(!opencode_enrichment_applies(Some("claude-code")));
    }

    #[tokio::test]
    async fn enrich_parts_json_leaves_non_opencode_runtimes_untouched() {
        let parts_json = serde_json::json!([{
            "type": "tool-call",
            "toolCallId": "call_1",
            "toolCall": { "id": "call_1", "result": "", "arguments": {} }
        }])
        .to_string();
        let out = enrich_parts_json_from_opencode(&parts_json, None, Some("pi")).await;
        assert_eq!(out, parts_json);
    }

    fn opencode_part(call_id: &str, output: &str) -> String {
        serde_json::json!({
            "type": "tool",
            "tool": "bash",
            "callID": call_id,
            "state": { "status": "completed", "output": output }
        })
        .to_string()
    }

    #[tokio::test]
    async fn opencode_outputs_resolve_all_ids_with_one_json_extract_query() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        {
            let db = Builder::new_local(path.to_string_lossy().to_string())
                .build()
                .await
                .unwrap();
            let conn = db.connect().unwrap();
            conn.execute(
                "CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT,
                                    time_created INTEGER, time_updated INTEGER, data TEXT)",
                (),
            )
            .await
            .unwrap();
            let rows: Vec<(&str, i64, String)> =
                vec![
                ("p1", 10, opencode_part("call_1", "older")),
                ("p2", 20, opencode_part("call_1", "newer")),
                ("p3", 15, opencode_part("call_2", "two")),
                // Completed tool without any output: must not count as a hit.
                (
                    "p4",
                    30,
                    serde_json::json!({ "callID": "call_3", "state": { "status": "completed" } })
                        .to_string(),
                ),
                // Not a tool part at all, and one malformed row json_valid must skip.
                ("p5", 40, serde_json::json!({ "type": "text", "text": "call_1" }).to_string()),
                ("p6", 50, "not json {".to_string()),
            ];
            for (id, t, data) in rows {
                conn.execute(
                    "INSERT INTO part (id, session_id, message_id, time_created, time_updated, data)
                     VALUES (?1, 'ses', 'msg', ?2, ?2, ?3)",
                    params![id.to_string(), t, data],
                )
                .await
                .unwrap();
            }
        }

        let ids = ["call_1", "call_2", "call_3", "missing"]
            .into_iter()
            .map(str::to_string)
            .collect::<HashSet<_>>();
        // A path that does not exist first: it is skipped, not fatal.
        let paths = vec![dir.path().join("nope.db"), path];
        let outputs = load_opencode_tool_outputs_from_paths(&ids, &paths).await;

        assert_eq!(outputs.get("call_1").map(String::as_str), Some("newer"));
        assert_eq!(outputs.get("call_2").map(String::as_str), Some("two"));
        assert!(!outputs.contains_key("call_3"));
        assert!(!outputs.contains_key("missing"));
        assert_eq!(outputs.len(), 2);
    }

    #[tokio::test]
    async fn teams_for_sessions_and_ideas_map_only_known_ids() {
        let (store, _dir) = new_store().await;
        store
            .session_upsert_batch(&[session("s1", "teamA"), session("s2", "teamB")])
            .await
            .unwrap();
        store
            .idea_upsert_batch(&[idea("i1", "teamA")])
            .await
            .unwrap();

        let owners = store
            .teams_for_sessions(&["s1".into(), "s2".into(), "ghost".into()])
            .await
            .unwrap();
        assert_eq!(owners.len(), 2);
        assert_eq!(owners.get("s1").map(String::as_str), Some("teamA"));
        assert_eq!(owners.get("s2").map(String::as_str), Some("teamB"));

        let owners = store.teams_for_ideas(&["i1".into()]).await.unwrap();
        assert_eq!(owners.get("i1").map(String::as_str), Some("teamA"));
        assert!(store.teams_for_ideas(&[]).await.unwrap().is_empty());
    }
}
