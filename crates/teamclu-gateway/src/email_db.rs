use libsql::{params, Builder, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Email channel database for persistent state management
#[derive(Clone)]
pub struct EmailDb {
    conn: Arc<Mutex<Connection>>,
}

/// Message thread mapping
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct MessageThread {
    pub id: i64,
    pub account_key: String,
    pub message_id: String,
    pub subject: Option<String>,
    pub session_id: Option<String>,
    pub created_at: String,
}

impl EmailDb {
    /// Create a new EmailDb at the given path (e.g. ~/.teamclu/email.db)
    pub async fn new(db_path: &Path) -> Result<Self, String> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create email db directory: {}", e))?;
        }

        let db_path_str = db_path.to_string_lossy().to_string();
        let db = Builder::new_local(db_path_str)
            .build()
            .await
            .map_err(|e| format!("Failed to open email database: {}", e))?;
        let conn = db
            .connect()
            .map_err(|e| format!("Failed to connect to email database: {}", e))?;

        let instance = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        instance.migrate().await?;
        Ok(instance)
    }

    /// Run database migrations (idempotent)
    async fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock().await;

        // Table: email_accounts - stores UID watermark per account
        conn.execute(
            "CREATE TABLE IF NOT EXISTS email_accounts (
                account_key TEXT PRIMARY KEY,
                uid_watermark INTEGER NOT NULL DEFAULT 0,
                last_check_at TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create email_accounts table: {}", e))?;

        // Table: processed_uids - deduplication tracking
        conn.execute(
            "CREATE TABLE IF NOT EXISTS processed_uids (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_key TEXT NOT NULL,
                uid INTEGER NOT NULL,
                processed_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(account_key, uid)
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create processed_uids table: {}", e))?;

        // Table: message_threads - Message-ID to session mapping
        conn.execute(
            "CREATE TABLE IF NOT EXISTS message_threads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_key TEXT NOT NULL,
                message_id TEXT NOT NULL,
                subject TEXT,
                session_id TEXT,
                binding TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(account_key, message_id)
            )",
            (),
        )
        .await
        .map_err(|e| format!("Failed to create message_threads table: {}", e))?;

        // Idempotent column add for databases created before the binding
        // column existed (CREATE TABLE IF NOT EXISTS leaves old schemas
        // untouched). ALTER ... ADD COLUMN errors out on existing column,
        // so we swallow that specific error and treat other failures fatal.
        match conn
            .execute("ALTER TABLE message_threads ADD COLUMN binding TEXT", ())
            .await
        {
            Ok(_) => {}
            Err(e) => {
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    return Err(format!(
                        "Failed to add binding column to message_threads: {}",
                        msg
                    ));
                }
            }
        }

        // Indexes for performance
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_processed_uids_account ON processed_uids(account_key, uid)",
            (),
        )
        .await
        .ok();

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_message_threads_account ON message_threads(account_key, message_id)",
            (),
        )
        .await
        .ok();

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_processed_uids_time ON processed_uids(processed_at)",
            (),
        )
        .await
        .ok();

        Ok(())
    }

    // ──────────────────────────────────────────────────────────────────────
    // Account State (UID Watermark)
    // ──────────────────────────────────────────────────────────────────────

    /// Get UID watermark for an account
    pub async fn get_uid_watermark(&self, account_key: &str) -> Result<u32, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT uid_watermark FROM email_accounts WHERE account_key = ?1",
                params![account_key.to_string()],
            )
            .await
            .map_err(|e| format!("Failed to query uid_watermark: {}", e))?;

        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read uid_watermark row: {}", e))?
        {
            let watermark = row
                .get::<i64>(0)
                .map_err(|e| format!("Failed to read uid_watermark value: {}", e))?;
            return Ok(watermark as u32);
        }

        // Account doesn't exist yet, return 0
        Ok(0)
    }

    /// Update UID watermark for an account
    pub async fn update_uid_watermark(
        &self,
        account_key: &str,
        uid_watermark: u32,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO email_accounts (account_key, uid_watermark, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(account_key) DO UPDATE SET
                uid_watermark = ?2,
                last_check_at = datetime('now'),
                updated_at = datetime('now')",
            params![account_key.to_string(), uid_watermark as i64],
        )
        .await
        .map_err(|e| format!("Failed to update uid_watermark: {}", e))?;
        Ok(())
    }

    // ──────────────────────────────────────────────────────────────────────
    // Processed UIDs (Deduplication)
    // ──────────────────────────────────────────────────────────────────────

    /// Check if a UID has been processed
    pub async fn is_uid_processed(&self, account_key: &str, uid: u32) -> Result<bool, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT 1 FROM processed_uids WHERE account_key = ?1 AND uid = ?2 LIMIT 1",
                params![account_key.to_string(), uid as i64],
            )
            .await
            .map_err(|e| format!("Failed to check processed uid: {}", e))?;

        Ok(rows
            .next()
            .await
            .map_err(|e| format!("Failed to read processed uid row: {}", e))?
            .is_some())
    }

    /// Mark a UID as processed
    pub async fn mark_uid_processed(&self, account_key: &str, uid: u32) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR IGNORE INTO processed_uids (account_key, uid) VALUES (?1, ?2)",
            params![account_key.to_string(), uid as i64],
        )
        .await
        .map_err(|e| format!("Failed to mark uid as processed: {}", e))?;
        Ok(())
    }

    /// Get count of processed UIDs for an account
    pub async fn count_processed_uids(&self, account_key: &str) -> Result<usize, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT COUNT(*) FROM processed_uids WHERE account_key = ?1",
                params![account_key.to_string()],
            )
            .await
            .map_err(|e| format!("Failed to count processed uids: {}", e))?;

        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read count row: {}", e))?
        {
            let count = row
                .get::<i64>(0)
                .map_err(|e| format!("Failed to read count value: {}", e))?;
            return Ok(count as usize);
        }

        Ok(0)
    }

    /// Cleanup old processed UIDs (FIFO, keep only the most recent MAX_PROCESSED_UIDS)
    pub async fn cleanup_processed_uids(
        &self,
        account_key: &str,
        max_keep: usize,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            &format!(
                "DELETE FROM processed_uids WHERE account_key = ?1 AND id IN (
                    SELECT id FROM processed_uids WHERE account_key = ?1
                    ORDER BY processed_at ASC
                    LIMIT MAX(0, (SELECT COUNT(*) FROM processed_uids WHERE account_key = ?1) - {})
                )",
                max_keep
            ),
            params![account_key.to_string()],
        )
        .await
        .map_err(|e| format!("Failed to cleanup processed uids: {}", e))?;
        Ok(())
    }

    // ──────────────────────────────────────────────────────────────────────
    // Message Threads (Message-ID Index)
    // ──────────────────────────────────────────────────────────────────────

    /// Look up the `(session_id, binding)` pair previously stored for a
    /// Message-ID. Returns `None` if the message is unknown, or
    /// `Some((sid, None))` when the row pre-dates the `binding` column.
    pub async fn get_session_by_message_id(
        &self,
        account_key: &str,
        message_id: &str,
    ) -> Result<Option<(String, Option<String>)>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT session_id, binding FROM message_threads
                 WHERE account_key = ?1 AND message_id = ?2",
                params![account_key.to_string(), message_id.to_string()],
            )
            .await
            .map_err(|e| format!("Failed to query message thread: {}", e))?;

        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read message thread row: {}", e))?
        {
            let sid: Option<String> = row.get::<String>(0).ok();
            let binding: Option<String> = row.get::<String>(1).ok().filter(|b| !b.is_empty());
            return Ok(sid.map(|s| (s, binding)));
        }

        Ok(None)
    }

    /// Store / upsert a Message-ID → (session_id, binding) mapping. Called
    /// once for each inbound email we persist and once for each outbound
    /// reply we send; storing both lets future inbound emails in the same
    /// thread find the right backend session by either side of the
    /// `In-Reply-To` / `References` chain.
    pub async fn store_message_thread(
        &self,
        account_key: &str,
        message_id: &str,
        subject: Option<&str>,
        session_id: Option<&str>,
        binding: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO message_threads (account_key, message_id, subject, session_id, binding)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_key, message_id) DO UPDATE SET
                subject = ?3,
                session_id = COALESCE(?4, session_id),
                binding = COALESCE(?5, binding)",
            params![
                account_key.to_string(),
                message_id.to_string(),
                subject.map(|s| s.to_string()).unwrap_or_default(),
                session_id.map(|s| s.to_string()).unwrap_or_default(),
                binding.map(|s| s.to_string()).unwrap_or_default(),
            ],
        )
        .await
        .map_err(|e| format!("Failed to store message thread: {}", e))?;
        Ok(())
    }

    /// Subject-based fallback when In-Reply-To / References are missing.
    /// Returns `(session_id, binding)` for the most recent thread that
    /// matches the normalised subject. `binding` is `None` for rows
    /// pre-dating the column.
    pub async fn find_session_by_subject(
        &self,
        account_key: &str,
        subject: &str,
    ) -> Result<Option<(String, Option<String>)>, String> {
        let conn = self.conn.lock().await;
        let mut rows = conn
            .query(
                "SELECT session_id, binding FROM message_threads
                 WHERE account_key = ?1 AND subject = ?2
                 AND session_id IS NOT NULL
                 ORDER BY created_at DESC LIMIT 1",
                params![account_key.to_string(), subject.to_string()],
            )
            .await
            .map_err(|e| format!("Failed to query message thread by subject: {}", e))?;

        if let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("Failed to read message thread row: {}", e))?
        {
            let sid: Option<String> = row.get::<String>(0).ok();
            let binding: Option<String> = row.get::<String>(1).ok().filter(|b| !b.is_empty());
            return Ok(sid.map(|s| (s, binding)));
        }

        Ok(None)
    }

    // ──────────────────────────────────────────────────────────────────────
    // Utilities
    // ──────────────────────────────────────────────────────────────────────
}
