//! The `actor` table: the people and agents of a team.

use super::rows::ActorRow;
use super::{opt_val, run_write_batch, text, LocalCacheStore};
use libsql::{params, Value};

impl LocalCacheStore {
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
}

#[cfg(test)]
mod tests {
    use crate::local_cache::store::test_support::{actor, new_store};
    use crate::local_cache::store::ActorRow;

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
}
