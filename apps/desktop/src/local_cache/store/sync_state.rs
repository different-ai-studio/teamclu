//! Sync watermarks, and the per-team wipe that clears every cached table.

use super::LocalCacheStore;
use libsql::params;

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
}
