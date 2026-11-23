//! Sync watermarks, and the per-team wipe that clears every cached table.

use super::LocalCacheStore;
use libsql::{params, TransactionBehavior};

impl LocalCacheStore {
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
    ///
    /// One transaction: the wipe either happens or it does not. As separate
    /// autocommit statements a failure part-way left the cache half-cleared —
    /// sessions gone, their watermark still in place — so the next sync pulled
    /// only what changed since and the missing rows never came back.
    pub async fn clear_team(&self, team_id: &str) -> Result<(), String> {
        // Leaf tables before the tables their subqueries read.
        const STATEMENTS: &[(&str, &str)] = &[
            (
                "claim",
                "DELETE FROM claim WHERE idea_id IN (SELECT id FROM idea WHERE team_id = ?1)",
            ),
            (
                "submission",
                "DELETE FROM submission WHERE idea_id IN (SELECT id FROM idea WHERE team_id = ?1)",
            ),
            (
                "session_participant",
                "DELETE FROM session_participant WHERE session_id IN (SELECT id FROM session WHERE team_id = ?1)",
            ),
            (
                "agent_runtime_event",
                "DELETE FROM agent_runtime_event WHERE session_id IN (SELECT id FROM session WHERE team_id = ?1)",
            ),
            (
                "session_viewer_workspace",
                "DELETE FROM session_viewer_workspace WHERE team_id = ?1",
            ),
            ("message", "DELETE FROM message WHERE team_id = ?1"),
            ("outbox", "DELETE FROM outbox WHERE team_id = ?1"),
            ("idea", "DELETE FROM idea WHERE team_id = ?1"),
            ("session", "DELETE FROM session WHERE team_id = ?1"),
            ("actor", "DELETE FROM actor WHERE team_id = ?1"),
            ("sync_state", "DELETE FROM sync_state WHERE team_id = ?1"),
        ];

        let conn = self.conn.lock().await;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .await
            .map_err(|e| format!("clear_team: begin: {e}"))?;
        for (table, sql) in STATEMENTS {
            tx.execute(sql, params![team_id.to_string()])
                .await
                .map_err(|e| format!("clear_team {table}: {e}"))?;
        }
        tx.commit()
            .await
            .map_err(|e| format!("clear_team: commit: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use crate::local_cache::store::test_support::{actor, new_store};

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

    #[tokio::test]
    async fn clear_team_also_wipes_viewer_workspace_bindings() {
        let (store, _dir) = new_store().await;
        {
            let conn = store.conn().await;
            for team in ["teamA", "teamB"] {
                conn.execute(
                    "INSERT INTO session_viewer_workspace
                       (session_id, team_id, viewer_member_id, agent_id, updated_at)
                     VALUES (?1, ?2, 'm', 'a', '2024-01-01T00:00:00Z')",
                    libsql::params![format!("s_{team}"), team.to_string()],
                )
                .await
                .unwrap();
            }
        }

        store.clear_team("teamA").await.unwrap();

        let conn = store.conn().await;
        let mut rows = conn
            .query(
                "SELECT team_id FROM session_viewer_workspace ORDER BY team_id",
                (),
            )
            .await
            .unwrap();
        let mut left = Vec::new();
        while let Some(row) = rows.next().await.unwrap() {
            left.push(row.get::<String>(0).unwrap());
        }
        assert_eq!(left, vec!["teamB".to_string()]);
        assert!(conn.is_autocommit(), "the wipe must not leave a tx open");
    }
}
