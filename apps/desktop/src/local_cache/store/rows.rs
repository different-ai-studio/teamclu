//! Row structs shared by the store and the Tauri commands.
//!
//! These are the wire shape the frontend sees: `serde(rename_all = "camelCase")`
//! on every one, so a field rename here is a breaking change for
//! `packages/app/src/lib/local-cache/*`.

use serde::{Deserialize, Serialize};

// ─── Row types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorRow {
    pub id: String,
    pub team_id: String,
    pub actor_type: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub member_status: Option<String>,
    pub agent_status: Option<String>,
    pub last_active_at: Option<String>,
    pub metadata_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
    // Display hints cached so the list's first (offline) paint matches the
    // network paint — avoids the subtitle popping in. Member: team_role
    // (owner/admin/member). Agent: agent_visibility (team/personal).
    #[serde(default)]
    pub team_role: Option<String>,
    #[serde(default)]
    pub agent_visibility: Option<String>,
    /// Agent owner member actor id — for personal-agent delete gating on cache first paint.
    #[serde(default)]
    pub owner_member_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub team_id: String,
    pub title: Option<String>,
    pub mode: Option<String>,
    pub primary_agent_id: Option<String>,
    pub idea_id: Option<String>,
    pub summary: Option<String>,
    pub last_message_preview: Option<String>,
    pub last_message_at: Option<String>,
    pub created_by: Option<String>,
    pub metadata_json: Option<String>,
    /// How the session was created: 'user' | 'cron' | 'gateway'.
    pub source: Option<String>,
    /// For source='cron', the cron job id that created it.
    pub cron_job_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionParticipantRow {
    pub id: String,
    pub session_id: String,
    pub actor_id: String,
    pub joined_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub team_id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub sender_actor_id: Option<String>,
    pub reply_to_message_id: Option<String>,
    pub kind: String,
    pub content: String,
    pub metadata_json: Option<String>,
    pub model: Option<String>,
    pub mentions_json: Option<String>,
    pub origin: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
    /// Serialized `MessagePart[]` (thinking / tool_call / text). Populated when
    /// streaming finalize merges runtime events into the persisted message so
    /// that reloading the session restores the full conversation, not just
    /// the AGENT_REPLY text body. NULL for plain messages with no merged parts.
    pub parts_json: Option<String>,
}

/// Outbox row — mirrors iOS `OutboxMessage` SwiftData model. Tracks one
/// pending/in-flight send through the cloud backend + MQTT with exponential backoff
/// retry. `message_id` is the same UUID used in `Message.id` so optimistic
/// UI bubbles can match the live echo by id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxRow {
    pub message_id: String,
    pub team_id: String,
    pub session_id: String,
    pub sender_actor_id: String,
    pub content: String,
    pub mention_actor_ids_json: Option<String>,
    pub display_mention_actor_ids_json: Option<String>,
    pub attachment_urls_json: Option<String>,
    pub state: String,
    pub attempt_count: i64,
    pub last_attempt_at: Option<String>,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaRow {
    pub id: String,
    pub team_id: String,
    pub workspace_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub created_by: Option<String>,
    pub archived: i64,
    pub sort_order: Option<i64>,
    pub metadata_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorkspaceRow {
    pub session_id: String,
    pub team_id: String,
    pub viewer_member_id: String,
    pub agent_id: String,
    pub workspace_id: Option<String>,
    pub workspace_path: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRow {
    pub id: String,
    pub idea_id: String,
    pub actor_id: String,
    pub claimed_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionRow {
    pub id: String,
    pub idea_id: String,
    pub actor_id: String,
    pub content: Option<String>,
    pub submitted_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeEventRow {
    pub id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub sender_actor_id: Option<String>,
    pub kind: String,
    pub content: String,
    pub metadata_json: Option<String>,
    pub model: Option<String>,
    pub created_at: String,
}

/// Optional knobs for [`LocalCacheStore::message_load_session_with`].
#[derive(Debug, Clone, Copy, Default)]
pub struct MessageLoadOptions<'a> {
    /// Newest N rows only (`None` or `<= 0` = everything).
    pub limit: Option<i64>,
    /// Agent runtime that produced the session's messages, when known.
    pub runtime: Option<&'a str>,
}
