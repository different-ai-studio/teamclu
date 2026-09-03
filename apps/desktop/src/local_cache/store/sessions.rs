//! The `session`, `session_workspace` and `session_participant` tables.

use super::rows::{SessionParticipantRow, SessionRow, SessionWorkspaceRow};
use super::{opt_val, run_write_batch, text, LocalCacheStore};
use libsql::params;

impl LocalCacheStore {
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
}

#[cfg(test)]
mod tests {
    use crate::local_cache::store::test_support::{new_store, session};
    use crate::local_cache::store::SessionWorkspaceRow;

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
}
