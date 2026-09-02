//! The `message` table.

use super::opencode::{enrich_message_rows_from_opencode, enrich_parts_json_from_opencode};
use super::rows::{MessageLoadOptions, MessageRow};
use super::{opt_val, run_write_batch, text, LocalCacheStore};
use libsql::{params, Value};

impl LocalCacheStore {
    pub async fn message_upsert_batch(&self, rows: &[MessageRow]) -> Result<(), String> {
        let conn = self.conn.lock().await;
        run_write_batch(
            &conn,
            "message_upsert_batch",
            "INSERT INTO message
                (id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id,
                 kind, content, metadata_json, model, mentions_json, origin,
                 created_at, updated_at, deleted_at, synced_at, parts_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
             ON CONFLICT(id) DO UPDATE SET
                team_id             = excluded.team_id,
                session_id          = excluded.session_id,
                turn_id             = excluded.turn_id,
                sender_actor_id     = excluded.sender_actor_id,
                reply_to_message_id = excluded.reply_to_message_id,
                kind                = excluded.kind,
                content             = excluded.content,
                metadata_json       = excluded.metadata_json,
                model               = excluded.model,
                mentions_json       = excluded.mentions_json,
                origin              = excluded.origin,
                created_at          = excluded.created_at,
                updated_at          = excluded.updated_at,
                deleted_at          = excluded.deleted_at,
                synced_at           = excluded.synced_at,
                parts_json          = COALESCE(excluded.parts_json, message.parts_json)
             WHERE excluded.updated_at >= message.updated_at",
            rows,
            |r| {
                vec![
                    text(&r.id),
                    text(&r.team_id),
                    text(&r.session_id),
                    opt_val(&r.turn_id),
                    opt_val(&r.sender_actor_id),
                    opt_val(&r.reply_to_message_id),
                    text(&r.kind),
                    text(&r.content),
                    opt_val(&r.metadata_json),
                    opt_val(&r.model),
                    opt_val(&r.mentions_json),
                    text(&r.origin),
                    text(&r.created_at),
                    text(&r.updated_at),
                    opt_val(&r.deleted_at),
                    text(&r.synced_at),
                    opt_val(&r.parts_json),
                ]
            },
        )
        .await
    }

    /// Merge parts_json into an existing message row. Used when the streaming
    /// pipeline finalizes after the persisted AGENT_REPLY has already landed —
    /// we need to attach thinking/tool_call parts without bumping updated_at
    /// (so subsequent cloud backend syncs with the same updated_at still apply).
    pub async fn message_set_parts(
        &self,
        message_id: &str,
        parts_json: &str,
        workspace_path: Option<&str>,
        runtime: Option<&str>,
    ) -> Result<String, String> {
        let parts_json = enrich_parts_json_from_opencode(parts_json, workspace_path, runtime).await;
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE message SET parts_json = ?1 WHERE id = ?2",
            params![parts_json.clone(), message_id.to_string()],
        )
        .await
        .map_err(|e| format!("message_set_parts: {}", e))?;
        Ok(parts_json)
    }

    /// Every message of a session, oldest first, with opencode tool outputs
    /// merged in where the runtime is unknown or opencode. Callers that know
    /// more use [`Self::message_load_session_with`].
    pub async fn message_load_session(
        &self,
        session_id: &str,
        include_deleted: bool,
        workspace_path: Option<&str>,
    ) -> Result<Vec<MessageRow>, String> {
        self.message_load_session_with(
            session_id,
            include_deleted,
            workspace_path,
            MessageLoadOptions::default(),
        )
        .await
    }

    /// Like [`Self::message_load_session`], but `limit` caps the result to the
    /// newest N rows (still returned oldest first) and `runtime` lets the
    /// opencode lookup be skipped for runtimes that never write that database.
    pub async fn message_load_session_with(
        &self,
        session_id: &str,
        include_deleted: bool,
        workspace_path: Option<&str>,
        options: MessageLoadOptions<'_>,
    ) -> Result<Vec<MessageRow>, String> {
        let limit = options.limit.filter(|n| *n > 0);
        let conn = self.conn.lock().await;
        let mut sql = String::from(
            "SELECT id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id,
                    kind, content, metadata_json, model, mentions_json, origin,
                    created_at, updated_at, deleted_at, synced_at, parts_json
             FROM message WHERE session_id = ?1",
        );
        if !include_deleted {
            sql.push_str(" AND deleted_at IS NULL");
        }
        // With a limit we want the newest N, which means scanning from the
        // end; the vector is flipped back to chronological order below.
        let mut binds = vec![text(session_id)];
        match limit {
            Some(n) => {
                sql.push_str(" ORDER BY created_at DESC LIMIT ?2");
                binds.push(Value::Integer(n));
            }
            None => sql.push_str(" ORDER BY created_at ASC"),
        }
        let mut rows = conn
            .query(&sql, binds)
            .await
            .map_err(|e| format!("message_load_session: {}", e))?;
        let mut result = Vec::new();
        while let Some(row) = rows
            .next()
            .await
            .map_err(|e| format!("message_load_session row: {}", e))?
        {
            result.push(MessageRow {
                id: row.get::<String>(0).unwrap_or_default(),
                team_id: row.get::<String>(1).unwrap_or_default(),
                session_id: row.get::<String>(2).unwrap_or_default(),
                turn_id: row.get::<String>(3).ok().filter(|s| !s.is_empty()),
                sender_actor_id: row.get::<String>(4).ok().filter(|s| !s.is_empty()),
                reply_to_message_id: row.get::<String>(5).ok().filter(|s| !s.is_empty()),
                kind: row.get::<String>(6).unwrap_or_default(),
                content: row.get::<String>(7).unwrap_or_default(),
                metadata_json: row.get::<String>(8).ok().filter(|s| !s.is_empty()),
                model: row.get::<String>(9).ok().filter(|s| !s.is_empty()),
                mentions_json: row.get::<String>(10).ok().filter(|s| !s.is_empty()),
                origin: row.get::<String>(11).unwrap_or_default(),
                created_at: row.get::<String>(12).unwrap_or_default(),
                updated_at: row.get::<String>(13).unwrap_or_default(),
                deleted_at: row.get::<String>(14).ok().filter(|s| !s.is_empty()),
                synced_at: row.get::<String>(15).unwrap_or_default(),
                parts_json: row.get::<String>(16).ok().filter(|s| !s.is_empty()),
            });
        }
        drop(rows);
        drop(conn);
        if limit.is_some() {
            result.reverse();
        }
        enrich_message_rows_from_opencode(&mut result, workspace_path, options.runtime).await;
        Ok(result)
    }

    pub async fn message_soft_delete(&self, id: &str, deleted_at: &str) -> Result<(), String> {
        let now = deleted_at.to_string();
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE message SET deleted_at = ?1, updated_at = ?1, synced_at = ?1 WHERE id = ?2",
            params![now, id.to_string()],
        )
        .await
        .map_err(|e| format!("message_soft_delete: {}", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::local_cache::store::test_support::{message, new_store};
    use crate::local_cache::store::MessageLoadOptions;
    use crate::local_cache::store::MessageRow;

    #[tokio::test]
    async fn message_upsert_batch_lands_every_row_and_keeps_newest_duplicate() {
        let (store, _dir) = new_store().await;
        let mut rows = (0..300)
            .map(|i| {
                message(
                    &format!("m{i:03}"),
                    "s1",
                    &format!("2024-01-01T00:{:02}:{:02}Z", i / 60, i % 60),
                )
            })
            .collect::<Vec<_>>();
        // Same id twice in one batch: the later, newer row must win.
        let mut dup = message("m000", "s1", "2024-01-02T00:00:00Z");
        dup.content = "newer".to_string();
        rows.push(dup);
        store.message_upsert_batch(&rows).await.unwrap();

        let loaded = store.message_load_session("s1", false, None).await.unwrap();
        assert_eq!(loaded.len(), 300);
        assert_eq!(loaded.first().unwrap().id, "m001");
        assert_eq!(loaded.last().unwrap().id, "m000", "m000 now sorts last");
        assert_eq!(loaded.last().unwrap().content, "newer");
    }

    #[tokio::test]
    async fn message_load_session_limit_returns_newest_in_chronological_order() {
        let (store, _dir) = new_store().await;
        let rows = (1..=5)
            .map(|i| message(&format!("m{i}"), "s1", &format!("2024-01-01T00:00:0{i}Z")))
            .collect::<Vec<_>>();
        store.message_upsert_batch(&rows).await.unwrap();

        let ids = |rows: Vec<MessageRow>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
        let newest_two = store
            .message_load_session_with(
                "s1",
                false,
                None,
                MessageLoadOptions {
                    limit: Some(2),
                    runtime: Some("pi"),
                },
            )
            .await
            .unwrap();
        assert_eq!(ids(newest_two), vec!["m4", "m5"]);

        for limit in [None, Some(0), Some(-1), Some(10)] {
            let all = store
                .message_load_session_with(
                    "s1",
                    false,
                    None,
                    MessageLoadOptions {
                        limit,
                        runtime: Some("pi"),
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                ids(all),
                vec!["m1", "m2", "m3", "m4", "m5"],
                "limit {limit:?}"
            );
        }
    }
}
