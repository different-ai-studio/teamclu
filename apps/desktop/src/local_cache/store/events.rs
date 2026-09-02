//! The `agent_runtime_event` table: the agent's own progress log.

use super::rows::AgentRuntimeEventRow;
use super::{opt_val, LocalCacheStore};
use libsql::params;

impl LocalCacheStore {
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
}
