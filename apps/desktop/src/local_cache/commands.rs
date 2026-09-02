use super::store::{
    enrich_parts_json_from_opencode, ActorRow, AgentRuntimeEventRow, ClaimRow, IdeaRow,
    LocalCacheStore, MessageLoadOptions, MessageRow, OutboxRow, SessionParticipantRow, SessionRow,
    SessionWorkspaceRow, SubmissionRow,
};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

// ─── Managed state ────────────────────────────────────────────────────────
//
// `current_team_id` is the "current-team gate": when Some(team), every
// local-cache command must touch rows belonging to that team. The gate is
// permissive when None (boot phase, sign-out) so initial hydration works.
// Frontend wires `local_cache_set_current_team` into the team-switch flow.

pub struct LocalCacheState {
    pub db: Arc<Mutex<Option<LocalCacheStore>>>,
    pub current_team_id: Arc<RwLock<Option<String>>>,
}

impl Default for LocalCacheState {
    fn default() -> Self {
        Self {
            db: Arc::new(Mutex::new(None)),
            current_team_id: Arc::new(RwLock::new(None)),
        }
    }
}

/// Lazily open the LocalCacheStore on first call.
async fn get_db(state: &LocalCacheState) -> Result<LocalCacheStore, String> {
    let mut db_lock = state.db.lock().await;
    if let Some(ref db) = *db_lock {
        return Ok(db.clone());
    }
    let db_path = crate::commands::brand_home_dir().join("local-cache.db");
    let db = LocalCacheStore::new(&db_path).await?;
    *db_lock = Some(db.clone());
    Ok(db)
}

// ─── Gate helpers ─────────────────────────────────────────────────────────

async fn current_team(state: &LocalCacheState) -> Option<String> {
    state.current_team_id.read().await.clone()
}

/// Machine-readable prefix for a gate rejection. The frontend classifies on
/// this token, so it must not drift; the parenthesised detail is for humans.
pub(crate) const ERR_TEAM_GATE_MISMATCH: &str = "local_cache: team_gate_mismatch";
/// A caller handed a team-scoped command an empty team id. That is a bug in
/// the caller, not a gate rejection, and reporting it as one sent us chasing
/// the wrong thing — keep it a separate code.
pub(crate) const ERR_EMPTY_TEAM_ID: &str = "local_cache: empty_team_id";

fn gate_mismatch(scope: &str, current: &str, found: &str) -> String {
    format!(
        "{} ({}: current={}, found={})",
        ERR_TEAM_GATE_MISMATCH, scope, current, found
    )
}

async fn assert_team(state: &LocalCacheState, team_id: &str) -> Result<(), String> {
    if team_id.is_empty() {
        return Err(format!("{} (requested)", ERR_EMPTY_TEAM_ID));
    }
    if let Some(current) = current_team(state).await {
        if current != team_id {
            return Err(gate_mismatch("requested", &current, team_id));
        }
    }
    Ok(())
}

async fn assert_team_opt(state: &LocalCacheState, looked_up: Option<&str>) -> Result<(), String> {
    let Some(current) = current_team(state).await else {
        return Ok(());
    };
    match looked_up {
        None => Ok(()),
        Some(t) if t == current => Ok(()),
        Some(t) => Err(gate_mismatch("row", &current, t)),
    }
}

/// Which table a child row's parent id points at.
#[derive(Debug, Clone, Copy)]
enum ParentKind {
    Session,
    Idea,
}

/// Gate for rows that carry a parent id (session or idea) instead of a
/// `team_id`. One owner lookup for all distinct parents, then a comparison in
/// memory — the previous shape was a `team_for_*` query, and a store-lock
/// acquisition, per distinct parent in the batch.
///
/// Parents the cache has not seen are allowed through, exactly as before: a
/// participant can arrive ahead of the session sync that would let us judge it.
async fn gate_parent_rows<'a>(
    db: &LocalCacheStore,
    current: Option<&str>,
    scope: &str,
    kind: ParentKind,
    parent_ids: impl IntoIterator<Item = &'a str>,
) -> Result<(), String> {
    let Some(current) = current else {
        return Ok(());
    };
    let mut seen = HashSet::new();
    let ids = parent_ids
        .into_iter()
        .filter(|id| seen.insert(*id))
        .map(str::to_string)
        .collect::<Vec<_>>();
    let owners = match kind {
        ParentKind::Session => db.teams_for_sessions(&ids).await?,
        ParentKind::Idea => db.teams_for_ideas(&ids).await?,
    };
    // Walk in batch order so the reported offender is the first one, not
    // whichever the map happened to yield.
    for id in &ids {
        if let Some(owner) = owners.get(id) {
            if owner != current {
                return Err(gate_mismatch(scope, current, owner));
            }
        }
    }
    Ok(())
}

// ─── Gate config commands ─────────────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_set_current_team(
    state: tauri::State<'_, LocalCacheState>,
    team_id: Option<String>,
) -> Result<(), String> {
    let mut guard = state.current_team_id.write().await;
    *guard = team_id.filter(|s| !s.is_empty());
    Ok(())
}

#[tauri::command]
pub async fn local_cache_get_current_team(
    state: tauri::State<'_, LocalCacheState>,
) -> Result<Option<String>, String> {
    Ok(state.current_team_id.read().await.clone())
}

// ─── actor commands ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_actor_upsert_batch(
    state: tauri::State<'_, LocalCacheState>,
    rows: Vec<ActorRow>,
) -> Result<(), String> {
    if let Some(current) = current_team(&state).await {
        if let Some(bad) = rows.iter().find(|r| r.team_id != current) {
            return Err(gate_mismatch("actor", &current, bad.team_id.as_str()));
        }
    }
    let db = get_db(&state).await?;
    db.actor_upsert_batch(&rows).await
}

#[tauri::command]
pub async fn local_cache_actor_load_team(
    state: tauri::State<'_, LocalCacheState>,
    team_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<ActorRow>, String> {
    assert_team(&state, &team_id).await?;
    let db = get_db(&state).await?;
    db.actor_load_team(&team_id, include_deleted.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn local_cache_actor_soft_delete(
    state: tauri::State<'_, LocalCacheState>,
    id: String,
    deleted_at: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_actor(&id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.actor_soft_delete(&id, &deleted_at).await
}

#[tauri::command]
pub async fn local_cache_actor_load_by_ids(
    state: tauri::State<'_, LocalCacheState>,
    ids: Vec<String>,
) -> Result<Vec<ActorRow>, String> {
    let db = get_db(&state).await?;
    let result = db.actor_load_by_ids(&ids).await?;
    if let Some(current) = current_team(&state).await {
        Ok(result
            .into_iter()
            .filter(|r| r.team_id == current)
            .collect())
    } else {
        Ok(result)
    }
}

// ─── session commands ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_session_upsert_batch(
    state: tauri::State<'_, LocalCacheState>,
    rows: Vec<SessionRow>,
) -> Result<(), String> {
    if let Some(current) = current_team(&state).await {
        if let Some(bad) = rows.iter().find(|r| r.team_id != current) {
            return Err(gate_mismatch("session", &current, bad.team_id.as_str()));
        }
    }
    let db = get_db(&state).await?;
    db.session_upsert_batch(&rows).await
}

#[tauri::command]
pub async fn local_cache_session_load_team(
    state: tauri::State<'_, LocalCacheState>,
    team_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<SessionRow>, String> {
    assert_team(&state, &team_id).await?;
    let db = get_db(&state).await?;
    db.session_load_team(&team_id, include_deleted.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn local_cache_session_soft_delete(
    state: tauri::State<'_, LocalCacheState>,
    id: String,
    deleted_at: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_session(&id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.session_soft_delete(&id, &deleted_at).await
}

/// Soft-delete without the current-team gate — used by introspect after a
/// successful Cloud API archive. Missing rows are fine (store update is a no-op).
pub async fn soft_delete_session_best_effort(
    state: &LocalCacheState,
    id: &str,
    deleted_at: &str,
) -> Result<(), String> {
    let db = get_db(state).await?;
    db.session_soft_delete(id, deleted_at).await
}

// ─── session_workspace commands ───────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_session_workspace_upsert_batch(
    state: tauri::State<'_, LocalCacheState>,
    rows: Vec<SessionWorkspaceRow>,
) -> Result<(), String> {
    if let Some(current) = current_team(&state).await {
        if let Some(bad) = rows.iter().find(|r| r.team_id != current) {
            return Err(gate_mismatch(
                "session_workspace",
                &current,
                bad.team_id.as_str(),
            ));
        }
    }
    let db = get_db(&state).await?;
    db.session_workspace_upsert_batch(&rows).await
}

#[tauri::command]
pub async fn local_cache_session_workspace_load_team(
    state: tauri::State<'_, LocalCacheState>,
    team_id: String,
    viewer_member_id: String,
) -> Result<Vec<SessionWorkspaceRow>, String> {
    assert_team(&state, &team_id).await?;
    let db = get_db(&state).await?;
    db.session_workspace_load_team(&team_id, &viewer_member_id)
        .await
}

// ─── session_participant commands ─────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_session_participant_upsert_batch(
    state: tauri::State<'_, LocalCacheState>,
    rows: Vec<SessionParticipantRow>,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    gate_parent_rows(
        &db,
        current_team(&state).await.as_deref(),
        "participant",
        ParentKind::Session,
        rows.iter().map(|r| r.session_id.as_str()),
    )
    .await?;
    db.session_participant_upsert_batch(&rows).await
}

#[tauri::command]
pub async fn local_cache_session_participant_load_session(
    state: tauri::State<'_, LocalCacheState>,
    session_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<SessionParticipantRow>, String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_session(&session_id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.session_participant_load_session(&session_id, include_deleted.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn local_cache_session_participant_load_actor(
    state: tauri::State<'_, LocalCacheState>,
    actor_id: String,
    team_id: String,
) -> Result<Vec<String>, String> {
    assert_team(&state, &team_id).await?;
    let db = get_db(&state).await?;
    db.session_participant_load_actor(&actor_id, &team_id).await
}

#[tauri::command]
pub async fn local_cache_session_participant_soft_delete(
    state: tauri::State<'_, LocalCacheState>,
    id: String,
    deleted_at: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_participant(&id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.session_participant_soft_delete(&id, &deleted_at).await
}

// ─── message commands ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_message_upsert_batch(
    state: tauri::State<'_, LocalCacheState>,
    rows: Vec<MessageRow>,
) -> Result<(), String> {
    if let Some(current) = current_team(&state).await {
        if let Some(bad) = rows.iter().find(|r| r.team_id != current) {
            return Err(gate_mismatch("message", &current, bad.team_id.as_str()));
        }
    }
    let db = get_db(&state).await?;
    db.message_upsert_batch(&rows).await
}

/// `limit`: newest N messages only (chronological order preserved); omit for
/// the whole session. `runtime`: the agent runtime behind the session when the
/// caller knows it — anything but `opencode` skips the opencode tool-output
/// lookup, which can never hit for other runtimes.
#[tauri::command]
pub async fn local_cache_message_load_session(
    state: tauri::State<'_, LocalCacheState>,
    session_id: String,
    include_deleted: Option<bool>,
    workspace_path: Option<String>,
    limit: Option<i64>,
    runtime: Option<String>,
) -> Result<Vec<MessageRow>, String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_session(&session_id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.message_load_session_with(
        &session_id,
        include_deleted.unwrap_or(false),
        workspace_path.as_deref(),
        MessageLoadOptions {
            limit,
            runtime: runtime.as_deref(),
        },
    )
    .await
}

#[tauri::command]
pub async fn local_cache_message_soft_delete(
    state: tauri::State<'_, LocalCacheState>,
    id: String,
    deleted_at: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_message(&id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.message_soft_delete(&id, &deleted_at).await
}

/// `runtime`: see [`local_cache_message_load_session`].
#[tauri::command]
pub async fn local_cache_message_set_parts(
    state: tauri::State<'_, LocalCacheState>,
    message_id: String,
    parts_json: String,
    workspace_path: Option<String>,
    runtime: Option<String>,
) -> Result<String, String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_message(&message_id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.message_set_parts(
        &message_id,
        &parts_json,
        workspace_path.as_deref(),
        runtime.as_deref(),
    )
    .await
}

/// `runtime`: see [`local_cache_message_load_session`].
#[tauri::command]
pub async fn local_cache_message_enrich_parts(
    parts_json: String,
    workspace_path: Option<String>,
    runtime: Option<String>,
) -> Result<String, String> {
    Ok(
        enrich_parts_json_from_opencode(&parts_json, workspace_path.as_deref(), runtime.as_deref())
            .await,
    )
}

// ─── outbox commands ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_outbox_upsert(
    state: tauri::State<'_, LocalCacheState>,
    row: OutboxRow,
) -> Result<(), String> {
    assert_team(&state, &row.team_id).await?;
    let db = get_db(&state).await?;
    db.outbox_upsert(&row).await
}

#[tauri::command]
pub async fn local_cache_outbox_delete(
    state: tauri::State<'_, LocalCacheState>,
    message_id: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_outbox(&message_id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.outbox_delete(&message_id).await
}

#[tauri::command]
pub async fn local_cache_outbox_list_all(
    state: tauri::State<'_, LocalCacheState>,
) -> Result<Vec<OutboxRow>, String> {
    let db = get_db(&state).await?;
    match current_team(&state).await {
        Some(t) => db.outbox_list_team(&t).await,
        None => db.outbox_list_all().await,
    }
}

// ─── idea commands ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_idea_upsert_batch(
    state: tauri::State<'_, LocalCacheState>,
    rows: Vec<IdeaRow>,
) -> Result<(), String> {
    if let Some(current) = current_team(&state).await {
        if let Some(bad) = rows.iter().find(|r| r.team_id != current) {
            return Err(gate_mismatch("idea", &current, bad.team_id.as_str()));
        }
    }
    let db = get_db(&state).await?;
    db.idea_upsert_batch(&rows).await
}

#[tauri::command]
pub async fn local_cache_idea_load_team(
    state: tauri::State<'_, LocalCacheState>,
    team_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<IdeaRow>, String> {
    assert_team(&state, &team_id).await?;
    let db = get_db(&state).await?;
    db.idea_load_team(&team_id, include_deleted.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn local_cache_idea_soft_delete(
    state: tauri::State<'_, LocalCacheState>,
    id: String,
    deleted_at: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_idea(&id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.idea_soft_delete(&id, &deleted_at).await
}

// ─── claim commands ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_claim_upsert_batch(
    state: tauri::State<'_, LocalCacheState>,
    rows: Vec<ClaimRow>,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    gate_parent_rows(
        &db,
        current_team(&state).await.as_deref(),
        "claim",
        ParentKind::Idea,
        rows.iter().map(|r| r.idea_id.as_str()),
    )
    .await?;
    db.claim_upsert_batch(&rows).await
}

#[tauri::command]
pub async fn local_cache_claim_load_idea(
    state: tauri::State<'_, LocalCacheState>,
    idea_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<ClaimRow>, String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_idea(&idea_id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.claim_load_idea(&idea_id, include_deleted.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn local_cache_claim_soft_delete(
    state: tauri::State<'_, LocalCacheState>,
    id: String,
    deleted_at: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_claim(&id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.claim_soft_delete(&id, &deleted_at).await
}

// ─── submission commands ──────────────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_submission_upsert_batch(
    state: tauri::State<'_, LocalCacheState>,
    rows: Vec<SubmissionRow>,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    gate_parent_rows(
        &db,
        current_team(&state).await.as_deref(),
        "submission",
        ParentKind::Idea,
        rows.iter().map(|r| r.idea_id.as_str()),
    )
    .await?;
    db.submission_upsert_batch(&rows).await
}

#[tauri::command]
pub async fn local_cache_submission_load_idea(
    state: tauri::State<'_, LocalCacheState>,
    idea_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<SubmissionRow>, String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_idea(&idea_id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.submission_load_idea(&idea_id, include_deleted.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn local_cache_submission_soft_delete(
    state: tauri::State<'_, LocalCacheState>,
    id: String,
    deleted_at: String,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_submission(&id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.submission_soft_delete(&id, &deleted_at).await
}

// ─── agent_runtime_event commands ─────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_agent_runtime_event_insert(
    state: tauri::State<'_, LocalCacheState>,
    record: AgentRuntimeEventRow,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_session(&record.session_id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.agent_runtime_event_upsert(&record).await
}

#[tauri::command]
pub async fn local_cache_agent_runtime_event_load(
    state: tauri::State<'_, LocalCacheState>,
    session_id: String,
) -> Result<Vec<AgentRuntimeEventRow>, String> {
    let db = get_db(&state).await?;
    let owner = db.team_for_session(&session_id).await?;
    assert_team_opt(&state, owner.as_deref()).await?;
    db.agent_runtime_event_load_session(&session_id).await
}

#[tauri::command]
pub async fn local_cache_agent_runtime_event_prune(
    state: tauri::State<'_, LocalCacheState>,
    max_rows: Option<i64>,
) -> Result<(), String> {
    let db = get_db(&state).await?;
    db.agent_runtime_event_prune(max_rows.unwrap_or(5000)).await
}

// ─── sync watermark commands ──────────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_watermark_get(
    state: tauri::State<'_, LocalCacheState>,
    table_name: String,
    team_id: String,
) -> Result<Option<String>, String> {
    assert_team(&state, &team_id).await?;
    let db = get_db(&state).await?;
    db.watermark_get(&table_name, &team_id).await
}

#[tauri::command]
pub async fn local_cache_watermark_set(
    state: tauri::State<'_, LocalCacheState>,
    table_name: String,
    team_id: String,
    last_sync_at: String,
) -> Result<(), String> {
    assert_team(&state, &team_id).await?;
    let db = get_db(&state).await?;
    db.watermark_set(&table_name, &team_id, &last_sync_at).await
}

// ─── clear_team command ───────────────────────────────────────────────────

#[tauri::command]
pub async fn local_cache_clear_team(
    state: tauri::State<'_, LocalCacheState>,
    team_id: String,
) -> Result<(), String> {
    // Deliberately not gated: clear_team is invoked on team-switch / sign-out
    // to wipe stale data, which may target a team other than the current one.
    let db = get_db(&state).await?;
    db.clear_team(&team_id).await
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    async fn new_store() -> (LocalCacheStore, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let store = LocalCacheStore::new(&dir.path().join("test.db"))
            .await
            .unwrap();
        (store, dir)
    }

    fn session(id: &str, team: &str) -> SessionRow {
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

    fn idea(id: &str, team: &str) -> IdeaRow {
        IdeaRow {
            id: id.to_string(),
            team_id: team.to_string(),
            workspace_id: None,
            parent_id: None,
            title: "t".to_string(),
            description: None,
            status: None,
            created_by: None,
            archived: 0,
            sort_order: None,
            metadata_json: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            deleted_at: None,
            synced_at: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn assert_team_rejects_empty_and_foreign_team_ids() {
        let state = LocalCacheState::default();
        let err = assert_team(&state, "").await.unwrap_err();
        assert!(err.starts_with(ERR_EMPTY_TEAM_ID), "{err}");

        // No current team: permissive.
        assert_team(&state, "teamA").await.unwrap();

        *state.current_team_id.write().await = Some("teamA".to_string());
        assert_team(&state, "teamA").await.unwrap();
        let err = assert_team(&state, "teamB").await.unwrap_err();
        assert!(err.starts_with(ERR_TEAM_GATE_MISMATCH), "{err}");
        assert!(err.contains("current=teamA, found=teamB"), "{err}");
    }

    #[tokio::test]
    async fn parent_gate_is_permissive_without_a_current_team() {
        let (db, _dir) = new_store().await;
        db.session_upsert_batch(&[session("s-b", "teamB")])
            .await
            .unwrap();
        gate_parent_rows(&db, None, "participant", ParentKind::Session, ["s-b"])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn parent_gate_passes_matching_and_unknown_parents_in_one_lookup() {
        let (db, _dir) = new_store().await;
        db.session_upsert_batch(&[session("s-a1", "teamA"), session("s-a2", "teamA")])
            .await
            .unwrap();
        // Duplicates and a parent the cache has never seen are both fine.
        gate_parent_rows(
            &db,
            Some("teamA"),
            "participant",
            ParentKind::Session,
            ["s-a1", "s-a2", "s-a1", "ghost"],
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn parent_gate_rejects_the_first_foreign_parent() {
        let (db, _dir) = new_store().await;
        db.session_upsert_batch(&[session("s-a", "teamA"), session("s-b", "teamB")])
            .await
            .unwrap();
        let err = gate_parent_rows(
            &db,
            Some("teamA"),
            "participant",
            ParentKind::Session,
            ["s-a", "s-b"],
        )
        .await
        .unwrap_err();
        assert!(err.starts_with(ERR_TEAM_GATE_MISMATCH), "{err}");
        assert!(
            err.contains("participant: current=teamA, found=teamB"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn parent_gate_resolves_ideas_for_claims_and_submissions() {
        let (db, _dir) = new_store().await;
        db.idea_upsert_batch(&[idea("i-a", "teamA"), idea("i-b", "teamB")])
            .await
            .unwrap();
        gate_parent_rows(&db, Some("teamA"), "claim", ParentKind::Idea, ["i-a"])
            .await
            .unwrap();
        let err = gate_parent_rows(&db, Some("teamA"), "submission", ParentKind::Idea, ["i-b"])
            .await
            .unwrap_err();
        assert!(
            err.contains("submission: current=teamA, found=teamB"),
            "{err}"
        );
    }
}
