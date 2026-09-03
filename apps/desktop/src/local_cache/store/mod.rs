//! The local cache: one libsql (SQLite) file under the brand home mirroring
//! Cloud API rows so the app reads sessions, messages and people while offline.
//!
//! This file owns the connection and the SQL plumbing every table shares.
//! Each table's own reads and writes live in a sibling module that adds its
//! own `impl LocalCacheStore` block, so a query lives next to the table it
//! touches instead of in one 3,200-line file:
//!
//! | module        | covers                                                |
//! |---------------|-------------------------------------------------------|
//! | `schema`      | connection PRAGMAs and the DDL migrations             |
//! | `rows`        | the row structs crossing the IPC boundary             |
//! | `actors`      | `actor`                                                |
//! | `sessions`    | `session`, `session_workspace`, `session_participant`  |
//! | `messages`    | `message`                                              |
//! | `ideas`       | `idea`, `claim`, `submission`                          |
//! | `events`      | `agent_runtime_event`                                  |
//! | `outbox`      | `outbox`                                               |
//! | `ownership`   | the team-lookup helpers behind the current-team gate   |
//! | `sync_state`  | sync watermarks and the per-team wipe                  |
//! | `opencode`    | filling tool output from opencode's own database       |

use libsql::{Builder, Connection, TransactionBehavior, Value};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

mod actors;
mod events;
mod ideas;
mod messages;
mod opencode;
mod outbox;
mod ownership;
mod rows;
mod schema;
mod sessions;
mod sync_state;

#[cfg(test)]
mod test_support;

pub use opencode::enrich_parts_json_from_opencode;
pub use rows::{
    ActorRow, AgentRuntimeEventRow, ClaimRow, IdeaRow, MessageLoadOptions, MessageRow, OutboxRow,
    SessionParticipantRow, SessionRow, SessionWorkspaceRow, SubmissionRow,
};

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

/// Largest `IN (...)` list we hand SQLite in one statement. The compiled-in
/// variable limit is far higher, but chunking keeps a pathological session
/// from building a multi-megabyte statement.
const MAX_IN_LIST: usize = 500;

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

    /// Get a locked reference to the raw connection (rarely needed externally).
    pub async fn conn(&self) -> tokio::sync::MutexGuard<'_, Connection> {
        self.conn.lock().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_cache::store::test_support::new_store;

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
}
