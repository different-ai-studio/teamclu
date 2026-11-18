//! The team-lookup helpers behind the current-team gate in `commands.rs`.

use super::{placeholders, text, LocalCacheStore, MAX_IN_LIST};
use libsql::params;
use std::collections::HashMap;

impl LocalCacheStore {
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
}

#[cfg(test)]
mod tests {
    use crate::local_cache::store::test_support::{actor, new_store, outbox, session};

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
    async fn teams_for_sessions_map_only_known_ids() {
        let (store, _dir) = new_store().await;
        store
            .session_upsert_batch(&[session("s1", "teamA"), session("s2", "teamB")])
            .await
            .unwrap();
        let owners = store
            .teams_for_sessions(&["s1".into(), "s2".into(), "ghost".into()])
            .await
            .unwrap();
        assert_eq!(owners.len(), 2);
        assert_eq!(owners.get("s1").map(String::as_str), Some("teamA"));
        assert_eq!(owners.get("s2").map(String::as_str), Some("teamB"));
    }
}
