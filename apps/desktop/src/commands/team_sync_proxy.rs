//! Plan B Task 5 — loopback HTTP client for the daemon's team-sync endpoints.
//!
//! The daemon owns team-sync now: it stores team secrets, materializes the
//! global team directory + per-workspace `teamclu-team` symlink, runs the
//! actual OSS sync, and surfaces conflicts/versions. The desktop only
//! *delivers* the secrets and *triggers* link/sync over the daemon's local
//! HTTP server.
//!
//! Discovery, the shared HTTP client and the root→session token exchange (with
//! its cache — one exchange per scope set, not one per call) live in
//! [`crate::daemon_client`]. This file knows the routes:
//!   - `POST /v1/team/sync`              `{ workspacePath?, forceSync, allowBulkAdd }` scope `workspace:write`
//!   - `GET  /v1/team/sync/status?teamId`                              scope `workspace:read`
//!   - `POST /v1/team/secrets`           `{ teamId, ossTeamSecret? }`   scope `workspace:write`
//!   - `POST /v1/team/link`              `{ path }`                    scope `workspace:write`
//!   - `GET  /v1/team/conflicts?teamId`                               scope `workspace:read`
//!   - `GET  /v1/team/remote-pending?teamId`                          scope `workspace:read`
//!   - `POST /v1/team/conflicts/resolve` `{ teamId, path, sidecar?, choice }` scope `workspace:write`
//!   - `GET  /v1/team/versions?teamId&path[&cursor]`                  scope `workspace:read`
//!   - `POST /v1/team/versions/restore`  `{ teamId, path, contentHash }` scope `workspace:write`
//!
//! Request bodies are the shared wire structs in `teamclu_types::daemon_http`.

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::daemon_client::{self as daemon, wire, RequestSpec, NO_BODY};

const READ: &[&str] = &["workspace:read"];
const WRITE: &[&str] = &["workspace:write"];

/// Discover the daemon, take a session token for `scopes` (cached), issue
/// `method base/path/query`, decode the JSON answer. Non-2xx and undecodable
/// bodies both map to `Err(String)`.
///
/// `query` is appended verbatim (already-encoded, leading `?` included).
async fn daemon_request<B: Serialize, R: DeserializeOwned>(
    method: reqwest::Method,
    path: &str,
    query: &str,
    scopes: &[&str],
    body: Option<&B>,
) -> Result<R, String> {
    let spec = RequestSpec::new(method, path, scopes).query(query);
    Ok(daemon::call_discovered(spec, body).await?)
}

/// Like [`daemon_request`] but for endpoints whose body the caller ignores.
async fn daemon_request_unit<B: Serialize>(
    method: reqwest::Method,
    path: &str,
    query: &str,
    scopes: &[&str],
    body: Option<&B>,
) -> Result<(), String> {
    let spec = RequestSpec::new(method, path, scopes).query(query);
    Ok(daemon::call_unit_discovered(spec, body).await?)
}

/// `?teamId=<id>` — the query every team-scoped GET here carries.
fn team_id_query(team_id: &str) -> String {
    format!("?teamId={}", urlencode(team_id))
}

/// `?teamId=<id>&path=<path>[&cursor=<cursor>]` for `GET /v1/team/versions`.
fn team_versions_query(team_id: &str, path: &str, cursor: Option<&str>) -> String {
    let mut query = format!("?teamId={}&path={}", urlencode(team_id), urlencode(path));
    if let Some(c) = cursor {
        query.push_str(&format!("&cursor={}", urlencode(c)));
    }
    query
}

fn urlencode(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

// ─── typed helpers ─────────────────────────────────────────────────────────

/// `POST /v1/team/sync` `{ workspacePath?, forceSync? }` — trigger a team sync.
///
/// The workspace is optional and never decides what is synced — the daemon
/// syncs the team's own tree under its amuxd home. Passing one only asks the
/// daemon to repair that workspace's team links on the way through.
pub async fn daemon_team_sync(
    workspace_path: Option<&str>,
    force_sync: bool,
    allow_bulk_add: bool,
) -> Result<serde_json::Value, String> {
    let body = wire::TeamSyncRequest {
        workspace_path: workspace_path
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_owned),
        force_sync,
        allow_bulk_add,
    };
    daemon_request(
        reqwest::Method::POST,
        "/v1/team/sync",
        "",
        WRITE,
        Some(&body),
    )
    .await
}

/// `POST /v1/team/cloud-config/reconcile` — pull team MCP/env into the daemon
/// cache now. Called after a successful Cloud API env-secret write/delete so
/// the agent runtime does not wait up to 5 minutes for the background tick.
pub async fn daemon_team_cloud_reconcile(team_id: &str) -> Result<(), String> {
    let body = wire::ReconcileCloudConfigRequest {
        team_id: Some(team_id.to_owned()),
    };
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/cloud-config/reconcile",
        "",
        WRITE,
        Some(&body),
    )
    .await
}

/// `GET /v1/team/sync/status?teamId=<id>` — current sync status.
pub async fn daemon_team_sync_status(team_id: &str) -> Result<serde_json::Value, String> {
    let query = team_id_query(team_id);
    daemon_request(
        reqwest::Method::GET,
        "/v1/team/sync/status",
        &query,
        READ,
        NO_BODY,
    )
    .await
}

/// Whether the local daemon holds this team's OSS secret.
///
/// The daemon deliberately returns only whether the secret is present (and a
/// masked fingerprint); this desktop surface further reduces that to a boolean
/// for the Environment Variables settings panel.
pub async fn daemon_team_env_available(team_id: &str) -> Result<bool, String> {
    let query = team_id_query(team_id);
    let status: wire::TeamSecretsStatusResponse = daemon_request(
        reqwest::Method::GET,
        "/v1/team/secrets",
        &query,
        READ,
        NO_BODY,
    )
    .await?;
    Ok(status.oss_team_secret.set)
}

/// `POST /v1/team/secrets` — deliver team secret material to the daemon.
///
/// `None` fields are omitted from the body.
pub async fn daemon_team_secrets(
    team_id: &str,
    oss_team_secret: Option<&str>,
) -> Result<(), String> {
    let body = wire::TeamSecretsRequest {
        team_id: team_id.to_owned(),
        oss_team_secret: oss_team_secret.map(str::to_owned),
    };
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/secrets",
        "",
        WRITE,
        Some(&body),
    )
    .await
}

/// `POST /v1/team/link` `{ path }` — materialize the global team dir + symlink.
pub async fn daemon_team_link(workspace_path: &str) -> Result<serde_json::Value, String> {
    let body = wire::TeamLinkRequest {
        path: Some(workspace_path.to_owned()),
    };
    daemon_request(
        reqwest::Method::POST,
        "/v1/team/link",
        "",
        WRITE,
        Some(&body),
    )
    .await
}

/// `POST /v1/team/unlink` `{ path }` — drop workspace symlink + empty global scaffold.
pub async fn daemon_team_unlink(workspace_path: &str) -> Result<(), String> {
    let body = wire::TeamLinkRequest {
        path: Some(workspace_path.to_owned()),
    };
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/unlink",
        "",
        WRITE,
        Some(&body),
    )
    .await
}

// ─── conflict / version helpers (used by Task 7) ────────────────────────────

/// `GET /v1/team/conflicts?teamId=<id>`.
pub async fn daemon_team_conflicts(team_id: &str) -> Result<serde_json::Value, String> {
    let query = team_id_query(team_id);
    daemon_request(
        reqwest::Method::GET,
        "/v1/team/conflicts",
        &query,
        READ,
        NO_BODY,
    )
    .await
}

/// `POST /v1/team/conflicts/resolve` `{ teamId, path, sidecar?, choice }`.
///
/// `sidecar` names WHICH conflict is being decided — one document can carry
/// several, each its own decision. Omitting it lets the daemon pick the newest,
/// which is what the pre-sidecar callers implicitly meant.
pub async fn daemon_team_resolve_conflict(
    team_id: &str,
    path: &str,
    sidecar: Option<&str>,
    choice: &str,
) -> Result<(), String> {
    let body = wire::ResolveConflictRequest {
        team_id: team_id.to_owned(),
        path: path.to_owned(),
        sidecar: sidecar
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        choice: choice.to_owned(),
    };
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/conflicts/resolve",
        "",
        WRITE,
        Some(&body),
    )
    .await
}

/// `GET /v1/team/versions?teamId=<id>&path=<path>[&cursor=<cursor>]`.
pub async fn daemon_team_versions(
    team_id: &str,
    path: &str,
    cursor: Option<&str>,
) -> Result<serde_json::Value, String> {
    let query = team_versions_query(team_id, path, cursor);
    daemon_request(
        reqwest::Method::GET,
        "/v1/team/versions",
        &query,
        READ,
        NO_BODY,
    )
    .await
}

/// `POST /v1/team/versions/restore` `{ teamId, path, contentHash }`.
pub async fn daemon_team_restore_version(
    team_id: &str,
    path: &str,
    content_hash: &str,
) -> Result<(), String> {
    let body = wire::RestoreVersionRequest {
        team_id: team_id.to_owned(),
        path: path.to_owned(),
        content_hash: content_hash.to_owned(),
    };
    daemon_request_unit(
        reqwest::Method::POST,
        "/v1/team/versions/restore",
        "",
        WRITE,
        Some(&body),
    )
    .await
}

// ─── Tauri command surface (Plan B Task 7) ──────────────────────────────────
//
// These `#[tauri::command]` fns REPLACE the old engine-backed commands of the
// same name in `oss_sync/mod.rs`, `team_shared_git.rs`, and `team.rs`. The
// command names + parameter names are kept identical so the frontend `invoke`
// sites need no change (Tauri binds args by name). The daemon now owns the
// actual sync/conflict/version engine; the desktop is a thin proxy.
//
// The daemon self-supplies the OSS JWT, so there is no `set-jwt` anymore.

/// Whether this daemon can decrypt Team Shared environment variables for the
/// supplied team. No secret material is returned to the renderer.
///
/// When the daemon reports the secret unset but the desktop has a local copy
/// (common after daemon restart or a deferred delivery at enable time), the
/// secret is re-pushed once before returning — same self-heal as `oss_sync_now`.
#[tauri::command]
pub async fn team_env_runtime_status(
    team_id: String,
    workspace_path: Option<String>,
) -> Result<bool, String> {
    if team_id.trim().is_empty() {
        return Ok(false);
    }
    if daemon_team_env_available(&team_id).await? {
        return Ok(true);
    }
    if let Some(wp) = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if redeliver_local_team_secret(&team_id, Some(wp)).await {
            return daemon_team_env_available(&team_id).await;
        }
    }
    Ok(false)
}

/// True when a daemon error / status `lastError` means the daemon has no OSS
/// team secret stored (see `secret_store::resolve_team_secret`). The daemon can
/// end up in this state if secret delivery was deferred (daemon unreachable) at
/// enable/join time, even though the desktop persisted the secret locally.
fn is_missing_team_secret_error(msg: &str) -> bool {
    msg.contains("no OSS team secret")
}

/// Resolve the team secret from desktop-local storage (`team_secret_store` blob
/// key, then inline `team.envSecret` / blob fallback via `resolve_team_env_secret`).
fn local_team_secret_for_redelivery(workspace_path: &str, team_id: &str) -> Option<String> {
    if let Ok(secret) =
        crate::commands::team_secret_store::load_team_secret(workspace_path, team_id)
    {
        if !secret.trim().is_empty() {
            return Some(secret);
        }
    }
    teamclu_runtime_env::env_catalog::resolve_team_env_secret(
        std::path::Path::new(workspace_path),
        Some(team_id),
        Some(crate::commands::APP_SHORT_NAME),
    )
}

/// Re-deliver the locally-stored team secret to the daemon and re-link the
/// workspace. Best-effort self-heal for the "no OSS team secret" state: the
/// desktop is the source of truth for the secret (persisted in
/// `team_secret_store`), so if the daemon is missing it we push it back.
///
/// Needs a workspace: the secret lookup reads the legacy per-workspace stores,
/// and the re-link is per-workspace by definition. With no folder open there is
/// nothing to recover from, so the caller's sync simply reports the daemon's
/// own error instead.
///
/// Returns `true` if a secret existed locally and was delivered, `false`
/// otherwise (no workspace, no local secret, or delivery failed).
async fn redeliver_local_team_secret(team_id: &str, workspace_path: Option<&str>) -> bool {
    let Some(workspace_path) = workspace_path.map(str::trim).filter(|p| !p.is_empty()) else {
        return false;
    };
    let Some(secret) = local_team_secret_for_redelivery(workspace_path, team_id) else {
        return false;
    };
    if daemon_team_secrets(team_id, Some(&secret)).await.is_err() {
        return false;
    }
    // Re-link is non-fatal — the secret is what unblocks sync.
    let _ = daemon_team_link(workspace_path).await;
    true
}

/// `oss_sync_now(workspacePath?, teamId)` — trigger a team sync via the daemon.
///
/// `workspacePath` is optional: team sync is per team, not per workspace, so
/// this works with no folder open. When one is given it also gets its team
/// links repaired, and it is what the secret self-heal below reads.
///
/// The frontend only reads back fresh status afterwards (it does not depend on
/// the exact `{pulled,pushed,conflicts}` numbers), so we map the daemon's sync
/// response into that shape, defaulting any missing field to `0`.
#[tauri::command]
pub async fn oss_sync_now(
    workspace_path: Option<String>,
    team_id: String,
    allow_bulk_add: Option<bool>,
) -> Result<serde_json::Value, String> {
    let workspace_path = workspace_path.as_deref();
    // Defaults to false: this flag is a person's answer to "you added N files
    // at once — send them?", so it has to be passed explicitly every time.
    let allow_bulk_add = allow_bulk_add.unwrap_or(false);
    let mut status = daemon_team_sync(workspace_path, true, allow_bulk_add).await?;
    // Self-heal: if the daemon reports it has no team secret, re-deliver the
    // locally-stored one and retry the sync once.
    if status
        .get("lastError")
        .and_then(|v| v.as_str())
        .is_some_and(is_missing_team_secret_error)
        && redeliver_local_team_secret(&team_id, workspace_path).await
    {
        status = daemon_team_sync(workspace_path, true, allow_bulk_add).await?;
    }
    Ok(map_sync_result(&status))
}

/// Reshape the daemon's sync response into what the frontend reads.
///
/// Extracted so it can be tested: two of the fields here are load-bearing in a
/// way that is invisible from the call site.
fn map_sync_result(status: &serde_json::Value) -> serde_json::Value {
    let pick = |k: &str| status.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    serde_json::json!({
        "pulled": pick("pulled"),
        "pushed": pick("pushed"),
        "conflicts": pick("conflicts"),
        // Dropping this was how "every file failed" reached the app as a clean
        // run: the frontend defaults the missing field to 0.
        "failed": pick("failed"),
        // The two size/count guards. Passed through verbatim: a skipped file
        // the user is not told about is worse than a slow sync, because they
        // believe it went up.
        "oversize": status.get("oversize").cloned().unwrap_or(serde_json::Value::Array(vec![])),
        "blockedNewFiles": status.get("blockedNewFiles").cloned().unwrap_or(serde_json::Value::Null),
    })
}

/// `oss_sync_status(workspacePath?, teamId)` — current sync status from the daemon.
///
/// Returns the daemon status JSON verbatim. The daemon keys status by team; the
/// optional `workspacePath` only feeds the secret self-heal below.
#[tauri::command]
pub async fn oss_sync_status(
    workspace_path: Option<String>,
    team_id: String,
) -> Result<serde_json::Value, String> {
    let workspace_path = workspace_path.as_deref();
    let status = daemon_team_sync_status(&team_id).await?;
    // Self-heal a stale "no OSS team secret" state: the desktop holds the secret
    // locally, so re-deliver it and run a sync so the daemon clears its
    // `last_error` (a bare status re-read would keep showing the stale error,
    // since `last_error` only updates when a sync actually runs). Then return
    // the fresh status so the panel clears the red banner.
    if status
        .get("lastError")
        .and_then(|v| v.as_str())
        .is_some_and(is_missing_team_secret_error)
        && redeliver_local_team_secret(&team_id, workspace_path).await
    {
        let _ = daemon_team_sync(workspace_path, true, false).await;
        return daemon_team_sync_status(&team_id).await;
    }
    Ok(status)
}

/// `oss_sync_list_versions(workspacePath, teamId, path, cursor?)`.
#[tauri::command]
pub async fn oss_sync_list_versions(
    workspace_path: String,
    team_id: String,
    path: String,
    cursor: Option<String>,
) -> Result<serde_json::Value, String> {
    let _ = &workspace_path;
    daemon_team_versions(&team_id, &path, cursor.as_deref()).await
}

/// `oss_sync_restore_version(workspacePath, teamId, path, contentHash)`.
#[tauri::command]
pub async fn oss_sync_restore_version(
    workspace_path: String,
    team_id: String,
    path: String,
    content_hash: String,
) -> Result<(), String> {
    let _ = &workspace_path;
    daemon_team_restore_version(&team_id, &path, &content_hash).await
}

/// `oss_sync_resolve_conflict(workspacePath, teamId, path, choice)`.
///
/// `choice` is the camelCase string the frontend already sends
/// (`keepRemote` | `keepLocal`); forwarded verbatim to the daemon.
#[tauri::command]
pub async fn oss_sync_resolve_conflict(
    workspace_path: String,
    team_id: String,
    path: String,
    choice: String,
) -> Result<(), String> {
    let _ = &workspace_path;
    daemon_team_resolve_conflict(&team_id, &path, None, &choice).await
}

// The `sync_mode` get/set pair lived here, "moved so they survive the Task 8
// deletion of oss_sync/mod.rs". They did not survive contact with the product:
// share mode became a one-shot switch with `oss` as its only value, so there
// was nothing left to read or toggle, and nothing called them.

// ─── unified team file/versions/changed proxies (Task 3) ────────────────────

/// `GET /v1/team/versions` — mode-agnostic per-file version list.
#[tauri::command]
pub async fn team_file_versions(
    team_id: String,
    path: String,
    cursor: Option<String>,
) -> Result<serde_json::Value, String> {
    daemon_team_versions(&team_id, &path, cursor.as_deref()).await
}

/// `GET /v1/team/file?ref=` — content of a file at a version-ref
/// ("baseline" = current synced/committed baseline).
#[tauri::command]
pub async fn team_file_content(
    team_id: String,
    path: String,
    r#ref: String,
) -> Result<serde_json::Value, String> {
    let query = format!(
        "?teamId={}&path={}&ref={}",
        urlencode(&team_id),
        urlencode(&path),
        urlencode(&r#ref)
    );
    daemon_request::<(), _>(reqwest::Method::GET, "/v1/team/file", &query, READ, NO_BODY).await
}

/// `GET /v1/team/changed` — files with local changes.
#[tauri::command]
pub async fn team_changed_files(team_id: String) -> Result<serde_json::Value, String> {
    let query = format!("?teamId={}", urlencode(&team_id));
    daemon_request::<(), _>(
        reqwest::Method::GET,
        "/v1/team/changed",
        &query,
        READ,
        NO_BODY,
    )
    .await
}

/// `GET /v1/team/remote-pending` — what the cloud has that this device has not
/// applied yet.
///
/// One FC round-trip per call and nothing cached on the daemon side, so callers
/// ask on an event (panel shown, window focused, manual refresh), never on a
/// timer.
#[tauri::command]
pub async fn team_remote_pending(team_id: String) -> Result<serde_json::Value, String> {
    let query = format!("?teamId={}", urlencode(&team_id));
    daemon_request::<(), _>(
        reqwest::Method::GET,
        "/v1/team/remote-pending",
        &query,
        READ,
        NO_BODY,
    )
    .await
}

/// `GET /v1/team/conflicts` — the conflicts waiting for a decision.
///
/// Each entry is one sidecar: `{ path, sidecar, conflictedAt, kind }`, where
/// `path` is the document and `sidecar` the local copy that lost. This scan is
/// the only durable record of a conflict — the counter in `oss_sync_status` is
/// per-tick and resets on the next one.
#[tauri::command]
pub async fn team_conflicts(team_id: String) -> Result<serde_json::Value, String> {
    daemon_team_conflicts(&team_id).await
}

/// `POST /v1/team/conflicts/resolve` — carry out one conflict decision.
///
/// `choice` is `keepLocal` (restore my copy over the document and push it) or
/// `keepRemote` (drop my copy; the document already holds the remote version).
#[tauri::command]
pub async fn team_resolve_conflict(
    team_id: String,
    path: String,
    sidecar: Option<String>,
    choice: String,
) -> Result<(), String> {
    daemon_team_resolve_conflict(&team_id, &path, sidecar.as_deref(), &choice).await
}

/// `POST /v1/team/versions/restore` — restore a file to a version-ref.
/// For the unified model the version-ref IS the oss contentHash (git uses the SHA).
#[tauri::command]
pub async fn team_restore_file_version(
    team_id: String,
    path: String,
    r#ref: String,
) -> Result<(), String> {
    daemon_team_restore_version(&team_id, &path, &r#ref).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // STR-5: this file was 751 lines with no tests at all. Everything that does
    // not need a running daemon is covered here — the query strings the daemon
    // parses, the request bodies it deserialises, the response reshaping the
    // frontend reads, and the error-string match that drives the secret
    // self-heal.

    #[test]
    fn urlencode_escapes_everything_outside_the_unreserved_set() {
        assert_eq!(urlencode("plain-id_1.2~3"), "plain-id_1.2~3");
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("docs/notes.md"), "docs%2Fnotes.md");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencode("?#"), "%3F%23");
        assert_eq!(urlencode("%"), "%25");
        // Non-ASCII is percent-encoded per UTF-8 byte, uppercase hex.
        assert_eq!(urlencode("笔记"), "%E7%AC%94%E8%AE%B0");
        assert_eq!(urlencode(""), "");
    }

    #[test]
    fn team_id_query_is_escaped() {
        assert_eq!(team_id_query("t1"), "?teamId=t1");
        // A team id is server-generated, but it reaches this function from the
        // renderer — escaping is what stops it terminating the query.
        assert_eq!(team_id_query("t1&admin=1"), "?teamId=t1%26admin%3D1");
    }

    #[test]
    fn team_versions_query_escapes_the_path_and_omits_an_absent_cursor() {
        assert_eq!(
            team_versions_query("t1", "knowledge/a b.md", None),
            "?teamId=t1&path=knowledge%2Fa%20b.md"
        );
        assert_eq!(
            team_versions_query("t1", "a.md", Some("c/1")),
            "?teamId=t1&path=a.md&cursor=c%2F1"
        );
    }

    // ── Wire bodies. These structs are what the daemon deserialises; a renamed
    //    field is a silent 400 at runtime and compiles fine on both sides.

    #[test]
    fn team_sync_request_body_shape() {
        let body = wire::TeamSyncRequest {
            workspace_path: Some("/w".into()),
            force_sync: true,
            allow_bulk_add: false,
        };
        assert_eq!(
            serde_json::to_value(&body).unwrap(),
            serde_json::json!({
                "workspacePath": "/w",
                "forceSync": true,
                "allowBulkAdd": false,
            })
        );
    }

    #[test]
    fn team_secrets_request_omits_an_absent_secret() {
        let with = wire::TeamSecretsRequest {
            team_id: "t1".into(),
            oss_team_secret: Some("s3cret".into()),
        };
        assert_eq!(
            serde_json::to_value(&with).unwrap(),
            serde_json::json!({ "teamId": "t1", "ossTeamSecret": "s3cret" })
        );
        let without = wire::TeamSecretsRequest {
            team_id: "t1".into(),
            oss_team_secret: None,
        };
        // Not `"ossTeamSecret": null` — that is how you *clear* a secret.
        assert_eq!(
            serde_json::to_value(&without).unwrap(),
            serde_json::json!({ "teamId": "t1" })
        );
    }

    #[test]
    fn resolve_conflict_request_drops_a_blank_sidecar() {
        for blank in [Some(""), Some("   "), None] {
            let body = wire::ResolveConflictRequest {
                team_id: "t1".into(),
                path: "a.md".into(),
                sidecar: blank
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
                choice: "keepLocal".into(),
            };
            let json = serde_json::to_value(&body).unwrap();
            assert!(
                json.get("sidecar").is_none(),
                "blank sidecar must be omitted so the daemon picks the newest, got {json}"
            );
        }
    }

    // ── Response reshaping.

    #[test]
    fn map_sync_result_defaults_missing_counters_to_zero() {
        let mapped = map_sync_result(&serde_json::json!({}));
        assert_eq!(mapped["pulled"], 0);
        assert_eq!(mapped["pushed"], 0);
        assert_eq!(mapped["conflicts"], 0);
        assert_eq!(mapped["failed"], 0);
        assert_eq!(mapped["oversize"], serde_json::json!([]));
        assert_eq!(mapped["blockedNewFiles"], serde_json::Value::Null);
    }

    #[test]
    fn map_sync_result_carries_failed_through() {
        // The regression this field exists for: a run where every file failed
        // used to reach the app as a clean run, because the frontend defaults a
        // missing `failed` to 0.
        let mapped = map_sync_result(&serde_json::json!({
            "pulled": 0, "pushed": 0, "conflicts": 0, "failed": 12
        }));
        assert_eq!(mapped["failed"], 12);
    }

    #[test]
    fn map_sync_result_passes_the_skip_guards_verbatim() {
        let mapped = map_sync_result(&serde_json::json!({
            "oversize": ["big.bin", "huge.zip"],
            "blockedNewFiles": { "count": 40, "sample": ["a", "b"] },
        }));
        assert_eq!(
            mapped["oversize"],
            serde_json::json!(["big.bin", "huge.zip"])
        );
        assert_eq!(
            mapped["blockedNewFiles"],
            serde_json::json!({ "count": 40, "sample": ["a", "b"] })
        );
    }

    #[test]
    fn map_sync_result_ignores_non_numeric_counters() {
        let mapped = map_sync_result(&serde_json::json!({ "pulled": "3", "pushed": null }));
        assert_eq!(mapped["pulled"], 0);
        assert_eq!(mapped["pushed"], 0);
    }

    // ── The cross-process error match.

    #[test]
    fn missing_team_secret_is_matched_on_the_daemon_phrase() {
        assert!(is_missing_team_secret_error(
            "no OSS team secret for team t1"
        ));
        assert!(is_missing_team_secret_error(
            "sync failed: no OSS team secret stored"
        ));
        assert!(!is_missing_team_secret_error("no team secret"));
        assert!(!is_missing_team_secret_error("upload failed: 403"));
        assert!(!is_missing_team_secret_error(""));
    }
}
