//! Fixtures shared by the store's per-table test modules.

use super::{ActorRow, IdeaRow, LocalCacheStore, MessageRow, OutboxRow, SessionRow};
use tempfile::tempdir;

/// Returns (store, tempdir). Caller must hold `_dir` to keep the temp directory alive.
pub(super) async fn new_store() -> (LocalCacheStore, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let path = dir.path().join("test.db");
    let store = LocalCacheStore::new(&path).await.unwrap();
    (store, dir)
}

pub(super) fn actor(id: &str, team: &str, updated_at: &str) -> ActorRow {
    ActorRow {
        id: id.to_string(),
        team_id: team.to_string(),
        actor_type: "member".to_string(),
        display_name: "Test".to_string(),
        avatar_url: None,
        member_status: None,
        agent_status: None,
        last_active_at: None,
        metadata_json: None,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        updated_at: updated_at.to_string(),
        deleted_at: None,
        synced_at: "2024-01-01T00:00:00Z".to_string(),
        team_role: None,
        agent_visibility: None,
        owner_member_id: None,
    }
}

pub(super) fn session(id: &str, team: &str) -> SessionRow {
    SessionRow {
        id: id.to_string(),
        team_id: team.to_string(),
        title: None,
        mode: None,
        primary_agent_id: None,
        idea_id: None,
        summary: None,
        last_message_preview: None,
        last_message_at: None,
        created_by: None,
        metadata_json: None,
        source: None,
        cron_job_id: None,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        updated_at: "2024-01-01T00:00:00Z".to_string(),
        deleted_at: None,
        synced_at: "2024-01-01T00:00:00Z".to_string(),
    }
}

pub(super) fn idea(id: &str, team: &str) -> IdeaRow {
    IdeaRow {
        id: id.to_string(),
        team_id: team.to_string(),
        workspace_id: None,
        parent_id: None,
        title: "T".to_string(),
        description: None,
        status: None,
        created_by: None,
        archived: 0,
        sort_order: Some(0),
        metadata_json: None,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        updated_at: "2024-01-01T00:00:00Z".to_string(),
        deleted_at: None,
        synced_at: "2024-01-01T00:00:00Z".to_string(),
    }
}

pub(super) fn outbox(message_id: &str, team: &str, session_id: &str) -> OutboxRow {
    OutboxRow {
        message_id: message_id.to_string(),
        team_id: team.to_string(),
        session_id: session_id.to_string(),
        sender_actor_id: "actor1".to_string(),
        content: "hi".to_string(),
        mention_actor_ids_json: None,
        display_mention_actor_ids_json: None,
        attachment_urls_json: None,
        state: "pending".to_string(),
        attempt_count: 0,
        last_attempt_at: None,
        next_attempt_at: None,
        last_error: None,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        updated_at: "2024-01-01T00:00:00Z".to_string(),
    }
}

pub(super) fn message(id: &str, session: &str, created_at: &str) -> MessageRow {
    MessageRow {
        id: id.to_string(),
        team_id: "teamA".to_string(),
        session_id: session.to_string(),
        turn_id: None,
        sender_actor_id: None,
        reply_to_message_id: None,
        kind: "text".to_string(),
        content: format!("body of {id}"),
        metadata_json: None,
        model: None,
        mentions_json: None,
        origin: "test".to_string(),
        created_at: created_at.to_string(),
        updated_at: created_at.to_string(),
        deleted_at: None,
        synced_at: created_at.to_string(),
        parts_json: None,
    }
}
