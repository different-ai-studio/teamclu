//! Wire types for amuxd's loopback HTTP API (`http://127.0.0.1:<port>/v1/*`),
//! as the desktop client speaks them.
//!
//! Field names and casing follow the daemon's handlers in
//! `apps/daemon/src/http/{auth,setup,workspaces,team,team_sync}.rs`: the
//! `/v1/team/*` bodies are camelCase, the workspace records snake_case. The
//! daemon does not use these structs yet — it keeps its own definitions —
//! so a change on either side must be mirrored here by hand until it does.
//! Every response type defaults optional fields so an older daemon that omits
//! a newer field still decodes.

use serde::{Deserialize, Serialize};

// ─── auth ───────────────────────────────────────────────────────────────────

/// `POST /v1/auth/exchange` body. Root bearer in, scoped session token out.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthExchangeRequest {
    pub scopes: Vec<String>,
    /// 1..=86400; the daemon defaults to 3600 when omitted.
    pub ttl_seconds: u64,
    /// Free-text label shown by `GET /v1/auth/tokens`, at most 128 chars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthExchangeResponse {
    pub token: String,
    #[serde(default)]
    pub token_id: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    /// RFC 3339 timestamp.
    #[serde(default)]
    pub expires_at: Option<String>,
}

// ─── setup ──────────────────────────────────────────────────────────────────

/// `GET /v1/setup/status` — unauthenticated; identity is only present once claimed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatusResponse {
    pub claimed: bool,
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub team_id: Option<String>,
}

// ─── workspaces ─────────────────────────────────────────────────────────────

/// One row of `GET /v1/workspaces` (`ListedWorkspace` daemon-side).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceRecord {
    /// Cloud `amux.workspaces` row id.
    pub workspace_id: String,
    pub path: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ListWorkspacesResponse {
    #[serde(default)]
    pub workspaces: Vec<WorkspaceRecord>,
}

/// `POST /v1/workspaces` body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RegisterWorkspaceRequest {
    /// Absolute, `~`-expanded path.
    pub path: String,
}

/// `POST /v1/workspaces` response (`RegisterWorkspaceResponseBody` daemon-side).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RegisterWorkspaceResponse {
    pub workspace_id: String,
    pub path: String,
    #[serde(default)]
    pub display_name: String,
}

/// `GET /v1/agent/default-workspace`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DefaultWorkspaceResponse {
    #[serde(default)]
    pub path: Option<String>,
}

/// `POST /v1/workspaces/:id/mcp/materialize-team`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MaterializeTeamMcpResponse {
    pub changed: bool,
    pub added_count: usize,
}

/// One entry of `GET /v1/workspaces/:id/providers`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderInfo {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub authenticated: bool,
    #[serde(default)]
    pub base_url: Option<String>,
    /// Model ids advertised by this provider.
    #[serde(default)]
    pub models: Vec<String>,
}

/// One model in `GET /v1/workspaces/:id/model-catalog`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogModel {
    /// `"<provider>/<modelId>"`, the form cron stores.
    #[serde(rename = "ref")]
    pub model_ref: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackendCatalog {
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub models: Vec<CatalogModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ModelCatalog {
    #[serde(default)]
    pub automation_default_backend: Option<String>,
    #[serde(default)]
    pub backends: Vec<BackendCatalog>,
}

// ─── team sync ──────────────────────────────────────────────────────────────

/// `POST /v1/team/sync`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncRequest {
    /// Only asks the daemon to repair that workspace's team links; never
    /// decides what is synced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub force_sync: bool,
    #[serde(default)]
    pub allow_bulk_add: bool,
}

/// `POST /v1/team/cloud-config/reconcile`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileCloudConfigRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
}

/// `POST /v1/team/secrets`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamSecretsRequest {
    pub team_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oss_team_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub set: bool,
    /// Masked fingerprint, never the value.
    #[serde(default)]
    pub display: String,
}

/// `GET /v1/team/secrets?teamId=`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamSecretsStatusResponse {
    #[serde(default)]
    pub team_id: String,
    #[serde(default)]
    pub oss_team_secret: SecretStatus,
    #[serde(default)]
    pub user_jwt: Option<SecretStatus>,
}

/// `POST /v1/team/link` and `POST /v1/team/unlink`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamLinkRequest {
    /// Omit to materialize the team directory alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// `POST /v1/team/conflicts/resolve`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConflictRequest {
    pub team_id: String,
    pub path: String,
    /// Which sidecar; the daemon picks the newest when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidecar: Option<String>,
    /// `keepLocal` | `keepRemote`.
    pub choice: String,
}

/// `POST /v1/team/versions/restore`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreVersionRequest {
    pub team_id: String,
    pub path: String,
    pub content_hash: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_bodies_are_camel_case_and_skip_absent_options() {
        let body = TeamSyncRequest {
            workspace_path: None,
            force_sync: true,
            allow_bulk_add: false,
        };
        assert_eq!(
            serde_json::to_value(&body).unwrap(),
            serde_json::json!({ "forceSync": true, "allowBulkAdd": false })
        );
        let body = ResolveConflictRequest {
            team_id: "t".into(),
            path: "a.md".into(),
            sidecar: None,
            choice: "keepLocal".into(),
        };
        assert_eq!(
            serde_json::to_value(&body).unwrap(),
            serde_json::json!({ "teamId": "t", "path": "a.md", "choice": "keepLocal" })
        );
    }

    #[test]
    fn workspace_records_stay_snake_case_and_tolerate_missing_fields() {
        let listed: ListWorkspacesResponse =
            serde_json::from_str(r#"{"workspaces":[{"workspace_id":"w1","path":"/p"}]}"#).unwrap();
        assert_eq!(listed.workspaces[0].workspace_id, "w1");
        assert!(!listed.workspaces[0].is_default);
        let status: SetupStatusResponse =
            serde_json::from_str(r#"{"claimed":true,"actorId":"a","teamId":"t"}"#).unwrap();
        assert_eq!(status.actor_id.as_deref(), Some("a"));
    }
}
