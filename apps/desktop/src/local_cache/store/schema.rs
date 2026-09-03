//! Connection tuning and the DDL migrations.
//!
//! `migrate` is idempotent (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` with
//! the error swallowed when the column is already there), so it runs on every
//! open.

use super::LocalCacheStore;
use libsql::Connection;
use std::time::Duration;

/// How long a writer waits on a locked database before giving up. The store
/// runs every command through one connection, so contention here only comes
/// from another process (a second window, the introspect sidecar) — a short
/// wait beats a spurious `database is locked`.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

impl LocalCacheStore {
    /// Per-connection SQLite tuning. libsql only turns WAL on for its (unused)
    /// `sync` feature, so without this the cache ran on SQLite's defaults —
    /// rollback journal plus `synchronous=FULL`, i.e. two fsyncs per statement
    /// and readers blocked behind every writer. WAL + `NORMAL` is the standard
    /// desktop-app setting: durable across application crashes, at most the
    /// last transaction lost on power failure, readers never block on a write.
    ///
    /// Best effort: a filesystem that refuses WAL (some network mounts) still
    /// gets a working, merely slower, cache.
    pub(super) async fn configure_connection(conn: &Connection) {
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

    /// Run all DDL migrations (idempotent).
    pub(super) async fn migrate(&self) -> Result<(), String> {
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
}

#[cfg(test)]
mod tests {
    use crate::local_cache::store::test_support::new_store;

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
}
