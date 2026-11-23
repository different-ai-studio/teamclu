//! The `idea` table — the idea board. (`claim` and `submission` rows are still
//! created by the schema and wiped per team, but nothing reads or writes them.)

use super::rows::IdeaRow;
use super::{opt_val, run_write_batch, text, LocalCacheStore};
use libsql::{params, Value};

impl LocalCacheStore {
    pub async fn idea_upsert_batch(&self, rows: &[IdeaRow]) -> Result<(), String> {
        let conn = self.conn.lock().await;
        run_write_batch(
            &conn,
            "idea_upsert_batch",
            "INSERT INTO idea
                (id, team_id, workspace_id, parent_id, title, description, status,
                 created_by, archived, sort_order, metadata_json, created_at, updated_at, deleted_at, synced_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
             ON CONFLICT(id) DO UPDATE SET
                team_id       = excluded.team_id,
                workspace_id  = excluded.workspace_id,
                parent_id     = excluded.parent_id,
                title         = excluded.title,
                description   = excluded.description,
                status        = excluded.status,
                created_by    = excluded.created_by,
                archived      = excluded.archived,
                sort_order    = excluded.sort_order,
                metadata_json = excluded.metadata_json,
                created_at    = excluded.created_at,
                updated_at    = excluded.updated_at,
                deleted_at    = excluded.deleted_at,
                synced_at     = excluded.synced_at
             WHERE excluded.updated_at >= idea.updated_at",
            rows,
            |r| {
                vec![
                    text(&r.id),
                    text(&r.team_id),
                    opt_val(&r.workspace_id),
                    opt_val(&r.parent_id),
                    text(&r.title),
                    opt_val(&r.description),
                    opt_val(&r.status),
                    opt_val(&r.created_by),
                    Value::Integer(r.archived),
                    Value::Integer(r.sort_order.unwrap_or(0)),
                    opt_val(&r.metadata_json),
                    text(&r.created_at),
                    text(&r.updated_at),
                    opt_val(&r.deleted_at),
                    text(&r.synced_at),
                ]
            },
        )
        .await
    }

    pub async fn idea_load_team(
        &self,
        team_id: &str,
        include_deleted: bool,
    ) -> Result<Vec<IdeaRow>, String> {
        let conn = self.conn.lock().await;
        let sql = if include_deleted {
            "SELECT id, team_id, workspace_id, parent_id, title, description, status,
                    created_by, archived, sort_order, metadata_json, created_at, updated_at, deleted_at, synced_at
             FROM idea WHERE team_id = ?1"
        } else {
            "SELECT id, team_id, workspace_id, parent_id, title, description, status,
                    created_by, archived, sort_order, metadata_json, created_at, updated_at, deleted_at, synced_at
             FROM idea WHERE team_id = ?1 AND deleted_at IS NULL"
        };
        let mut rows = conn
            .query(sql, params![team_id.to_string()])
            .await
            .map_err(|e| format!("idea_load_team: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("idea_load_team row: {}", e))?
        {
            result.push(IdeaRow {
                id: row.get::<String>(0).unwrap_or_default(),
                team_id: row.get::<String>(1).unwrap_or_default(),
                workspace_id: row.get::<String>(2).ok().filter(|s| !s.is_empty()),
                parent_id: row.get::<String>(3).ok().filter(|s| !s.is_empty()),
                title: row.get::<String>(4).unwrap_or_default(),
                description: row.get::<String>(5).ok().filter(|s| !s.is_empty()),
                status: row.get::<String>(6).ok().filter(|s| !s.is_empty()),
                created_by: row.get::<String>(7).ok().filter(|s| !s.is_empty()),
                archived: row.get::<i64>(8).unwrap_or(0),
                sort_order: Some(row.get::<i64>(9).unwrap_or(0)),
                metadata_json: row.get::<String>(10).ok().filter(|s| !s.is_empty()),
                created_at: row.get::<String>(11).unwrap_or_default(),
                updated_at: row.get::<String>(12).unwrap_or_default(),
                deleted_at: row.get::<String>(13).ok().filter(|s| !s.is_empty()),
                synced_at: row.get::<String>(14).unwrap_or_default(),
            });
        }
        Ok(result)
    }
}
