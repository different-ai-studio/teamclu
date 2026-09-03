//! The `outbox` table: messages queued for send, with their retry state.

use super::rows::OutboxRow;
use super::{opt_val, LocalCacheStore};
use libsql::params;

impl LocalCacheStore {
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
}

#[cfg(test)]
mod tests {
    use crate::local_cache::store::test_support::{new_store, outbox, session};

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
}
