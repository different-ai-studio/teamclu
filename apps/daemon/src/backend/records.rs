/// Returned by `claim_team_invite` — both member and agent branches.
/// `refresh_token` is `None` for member claims.
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(dead_code)]
pub struct ClaimResult {
    pub actor_id: String,
    pub team_id: String,
    pub actor_type: String,
    pub display_name: String,
    pub refresh_token: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct WorkspaceUpsert<'a> {
    pub team_id: &'a str,
    pub agent_id: &'a str,
    pub name: &'a str,
    pub path: Option<&'a str>,
    pub archived: bool,
    /// Existing cloud workspace UUID — when set, FC upserts in place instead of
    /// inserting a duplicate orphan row on every daemon sync.
    pub cloud_id: Option<&'a str>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct WorkspaceRow {
    pub id: String,
    #[serde(default)]
    pub team_id: String,
    #[serde(default)]
    pub path: Option<String>,
    /// `GET /v1/workspaces` returns archived rows too — the desktop hides them
    /// client-side, so anything else enumerating workspaces has to as well or
    /// it shows every workspace the team ever retired.
    #[serde(default)]
    pub archived: bool,
    /// Which agent (device daemon) registered this row. The same path is
    /// registered once per agent, so this is what distinguishes "my
    /// workspaces" from every other device's copy of the same directory.
    #[serde(default)]
    pub agent_id: Option<String>,
}

/// A single `messages` table row returned from the backend.
#[derive(Debug, Clone)]
pub struct StoredMessage {
    pub id: String,
    pub session_id: String,
    pub sender_actor_id: String,
    #[allow(dead_code)]
    pub kind: String,
    pub content: String,
    /// Raw JSON string of the `metadata` column.
    pub metadata_json: String,
    /// Unix epoch seconds derived from the `created_at` timestamp.
    pub created_at: i64,
}

/// One row of `GET /v1/sessions/gateway` — a session belonging to a single
/// gateway chat. `is_current` marks the one the chat is bound to right now;
/// the rest are earlier generations of the same conversation, kept listable so
/// `/sessions <n>` can switch back into them.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct GatewaySessionRow {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "acpSessionId", default)]
    pub acp_session_id: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(rename = "isCurrent", default)]
    pub is_current: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct BackendSessionRow {
    pub id: String,
    pub team_id: String,
    #[serde(default)]
    pub created_by_actor_id: Option<String>,
    #[serde(default)]
    pub primary_agent_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub mode: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub idea_id: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct BackendParticipantRow {
    #[allow(dead_code)]
    pub session_id: String,
    pub actor_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub role: Option<String>,
    pub joined_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub struct BackendSessionAndParticipants {
    pub session: BackendSessionRow,
    pub participants: Vec<BackendParticipantRow>,
}

/// One seated actor returned by `GET /v1/sessions/{sessionId}/roster`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRosterEntry {
    pub actor_id: String,
    pub display_name: Option<String>,
    pub kind: Option<String>,
    pub is_self: bool,
}

/// Session-scoped participant labels from `GET /v1/sessions/{sessionId}/roster`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRoster {
    pub session_id: String,
    pub caller_actor_id: String,
    pub items: Vec<SessionRosterEntry>,
}

/// A directory entry for one actor, as `POST /v1/actors/by-ids` returns it.
///
/// Only the two fields a roster needs: `session_participants` stores actor ids
/// and nothing else, so naming a participant means asking the directory who
/// that id is.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ActorDirectoryRow {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    /// `actors.actor_type`: `member`, `agent`, `external`.
    #[serde(default)]
    pub kind: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_session_row_defaults_for_optional_fields() {
        let json = r#"{
            "id": "sess-1",
            "team_id": "team-1",
            "created_at": "2024-01-01T00:00:00Z"
        }"#;
        let row: BackendSessionRow = serde_json::from_str(json).unwrap();
        assert_eq!(row.id, "sess-1");
        assert!(row.created_by_actor_id.is_none());
        assert!(row.primary_agent_id.is_none());
        assert_eq!(row.mode, "");
        assert_eq!(row.title, "");
        assert_eq!(row.summary, "");
        assert!(row.idea_id.is_none());
    }

    #[test]
    fn claim_result_optional_refresh_token() {
        let json = r#"{
            "actor_id": "a1",
            "team_id": "t1",
            "actor_type": "agent",
            "display_name": "Bot"
        }"#;
        let r: ClaimResult = serde_json::from_str(json).unwrap();
        assert!(r.refresh_token.is_none());
    }

    #[test]
    fn workspace_row_deserializes() {
        let json = r#"{"id":"ws-abc"}"#;
        let row: WorkspaceRow = serde_json::from_str(json).unwrap();
        assert_eq!(row.id, "ws-abc");
    }

    #[test]
    fn backend_participant_row_default_role() {
        let json = r#"{
            "session_id": "s1",
            "actor_id": "a1",
            "joined_at": "2024-01-01T00:00:00Z"
        }"#;
        let row: BackendParticipantRow = serde_json::from_str(json).unwrap();
        assert!(row.role.is_none());
    }
}
