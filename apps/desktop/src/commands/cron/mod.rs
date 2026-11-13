//! Scheduled jobs — settings-page proxy to the daemon (ADR-0010).
//!
//! The scheduler, storage, execution and delivery live in amuxd now
//! (`apps/daemon/src/cron/`, served at `/v1/cron/*`). What is left here:
//!
//! - the `cron_*` Tauri commands, kept under their old names and arguments so
//!   the settings page did not change, each a call to the daemon;
//! - a one-shot import of the job files this app used to keep itself
//!   (`<config_dir>/<brand>/cron-global/<TEAMCLU_DIR>/cron-jobs.json` and
//!   `<workspace>/<TEAMCLU_DIR>/cron-jobs.json`). Jobs only: run history stays
//!   behind. A file is renamed `*.migrated` once the daemon has it;
//! - a poll of `GET /v1/cron/status` that turns the daemon's change counters
//!   into the `cron:jobs-updated` / `cron:cron-sessions-updated` events the
//!   page listens for, whoever made the change (the page, an agent, the
//!   scheduler itself).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::daemon_client::{self as daemon, RequestSpec, NO_BODY};

const READ: &[&str] = &["workspace:read"];
const WRITE: &[&str] = &["workspace:write"];
const LEGACY_JOBS_FILE: &str = "cron-jobs.json";
const STATUS_POLL_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CronScope {
    #[default]
    Global,
    Workspace,
}

/// Legacy files already handed to the daemon by this process.
#[derive(Default)]
pub struct CronState {
    imported: Mutex<HashSet<PathBuf>>,
}

// ==================== daemon calls ====================

async fn call<B: Serialize + ?Sized, R: serde::de::DeserializeOwned>(
    method: reqwest::Method,
    path: &str,
    query: &str,
    scopes: &[&str],
    body: Option<&B>,
) -> Result<R, String> {
    let spec = RequestSpec::new(method, path, scopes).query(query);
    Ok(daemon::call_discovered(spec, body).await?)
}

pub(crate) fn urlencode(value: &str) -> String {
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

fn job_path(job_id: &str, suffix: &str) -> String {
    format!("/v1/cron/jobs/{}{suffix}", urlencode(job_id))
}

/// `?workspacePath=…` for a workspace scope, empty for global.
fn scope_query(workspace: Option<&str>) -> String {
    workspace
        .map(|p| format!("?workspacePath={}", urlencode(p)))
        .unwrap_or_default()
}

/// The workspace a scope names: `None` for global; for workspace scope the
/// explicit path, else the calling window's workspace.
fn resolve_scope(
    scope: Option<CronScope>,
    workspace_path: Option<String>,
    window: &tauri::Window,
    registry: &State<'_, crate::commands::window::WindowRegistry>,
) -> Result<Option<String>, String> {
    match scope.unwrap_or_default() {
        CronScope::Global => Ok(None),
        CronScope::Workspace => match workspace_path.filter(|p| !p.is_empty()) {
            Some(p) => Ok(Some(p)),
            None => {
                crate::commands::window::current_workspace_for_window(window, registry).map(Some)
            }
        },
    }
}

// ==================== legacy import ====================

fn legacy_global_root() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(crate::commands::home_storage_dir_name())
        .join("cron-global")
}

fn legacy_jobs_file(root: &std::path::Path) -> PathBuf {
    root.join(crate::commands::TEAMCLU_DIR)
        .join(LEGACY_JOBS_FILE)
}

/// Hand one legacy jobs file to the daemon, then rename it out of the way.
/// No-op when the file is absent or this process already imported it.
async fn import_legacy_file(
    state: &CronState,
    file: PathBuf,
    workspace_path: Option<&str>,
) -> Result<(), String> {
    if state
        .imported
        .lock()
        .map(|s| s.contains(&file))
        .unwrap_or(false)
    {
        return Ok(());
    }
    let content = match std::fs::read_to_string(&file) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read {}: {e}", file.display())),
    };
    let parsed: Value =
        serde_json::from_str(&content).map_err(|e| format!("parse {}: {e}", file.display()))?;
    let jobs = parsed.get("jobs").cloned().unwrap_or(Value::Array(vec![]));
    let count = jobs.as_array().map(Vec::len).unwrap_or(0);
    if count > 0 {
        let body = serde_json::json!({ "jobs": jobs, "workspacePath": workspace_path });
        let resp: Value = call(
            reqwest::Method::POST,
            "/v1/cron/import",
            "",
            WRITE,
            Some(&body),
        )
        .await?;
        log::info!(
            "[Cron] Imported {} of {} legacy job(s) from {} into amuxd",
            resp.get("added").and_then(Value::as_u64).unwrap_or(0),
            count,
            file.display()
        );
    }
    // The daemon has them (import is idempotent by id). Rename rather than
    // delete, so a bad import can still be recovered by hand.
    let migrated = file.with_extension("json.migrated");
    if let Err(e) = std::fs::rename(&file, &migrated) {
        log::warn!(
            "[Cron] Imported {} but could not rename it: {e}",
            file.display()
        );
    }
    if let Ok(mut s) = state.imported.lock() {
        s.insert(file);
    }
    Ok(())
}

async fn import_legacy_for_scope(state: &CronState, workspace: Option<&str>) {
    let file = match workspace {
        None => legacy_jobs_file(&legacy_global_root()),
        Some(ws) => legacy_jobs_file(std::path::Path::new(ws)),
    };
    if let Err(e) = import_legacy_file(state, file, workspace).await {
        log::warn!("[Cron] Legacy job import failed (will retry): {e}");
    }
}

/// Import every legacy file this machine has: the global one and each of the
/// daemon's local workspaces. Retries until the daemon answers, so jobs from
/// before the upgrade start running without anyone opening the settings page.
async fn import_all_legacy(app: &AppHandle) {
    use tauri::Manager;
    for attempt in 0..60u32 {
        if daemon::discover().is_ok() {
            let state = app.state::<CronState>();
            import_legacy_for_scope(&state, None).await;
            match crate::commands::daemon_http::list_local_daemon_workspaces().await {
                Ok(workspaces) => {
                    for ws in workspaces {
                        import_legacy_for_scope(&state, Some(&ws.path)).await;
                    }
                    return;
                }
                Err(e) => log::debug!("[Cron] Workspace list not ready ({e}), attempt {attempt}"),
            }
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

// ==================== change events ====================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Revisions {
    jobs_revision: u64,
    runs_revision: u64,
}

/// Background work for the life of the app: the legacy import, then the
/// status poll that drives the settings page's refresh events.
pub fn spawn_background(app: AppHandle) {
    let import_app = app.clone();
    tauri::async_runtime::spawn(async move { import_all_legacy(&import_app).await });
    tauri::async_runtime::spawn(async move {
        let mut last: Option<Revisions> = None;
        loop {
            tokio::time::sleep(STATUS_POLL_INTERVAL).await;
            let Ok(now) =
                call::<(), Revisions>(reqwest::Method::GET, "/v1/cron/status", "", READ, NO_BODY)
                    .await
            else {
                continue;
            };
            if let Some(prev) = last {
                if prev.jobs_revision != now.jobs_revision {
                    let _ = app.emit("cron:jobs-updated", ());
                }
                if prev.runs_revision != now.runs_revision {
                    let _ = app.emit("cron:cron-sessions-updated", ());
                }
            }
            last = Some(now);
        }
    });
}

// ==================== Tauri commands ====================

/// The settings page calls this before listing. Imports the scope's legacy
/// file if it has not been yet; the daemon's scheduler is always running.
#[tauri::command]
pub async fn cron_init(
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    cron_state: State<'_, CronState>,
    scope: Option<CronScope>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace = resolve_scope(scope, workspace_path, &window, &registry)?;
    if let Some(ws) = workspace.as_deref() {
        if !std::path::Path::new(ws).is_dir() {
            return Err(format!("Workspace not found: {ws}"));
        }
    }
    import_legacy_for_scope(&cron_state, workspace.as_deref()).await;
    Ok(())
}

#[tauri::command]
pub async fn cron_list_jobs(
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    scope: Option<CronScope>,
    workspace_path: Option<String>,
) -> Result<Value, String> {
    let workspace = resolve_scope(scope, workspace_path, &window, &registry)?;
    call(
        reqwest::Method::GET,
        "/v1/cron/jobs",
        &scope_query(workspace.as_deref()),
        READ,
        NO_BODY,
    )
    .await
}

#[tauri::command]
pub async fn cron_add_job(
    request: Value,
    window: tauri::Window,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    scope: Option<CronScope>,
    workspace_path: Option<String>,
) -> Result<Value, String> {
    let workspace = resolve_scope(scope, workspace_path, &window, &registry)?;
    let body = serde_json::json!({ "request": request, "workspacePath": workspace });
    call(
        reqwest::Method::POST,
        "/v1/cron/jobs",
        "",
        WRITE,
        Some(&body),
    )
    .await
}

#[tauri::command]
pub async fn cron_update_job(request: Value) -> Result<Value, String> {
    let job_id = request
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("Missing field: id")?
        .to_string();
    call(
        reqwest::Method::PATCH,
        &job_path(&job_id, ""),
        "",
        WRITE,
        Some(&request),
    )
    .await
}

#[tauri::command]
pub async fn cron_remove_job(job_id: String) -> Result<(), String> {
    let _: Value = call(
        reqwest::Method::DELETE,
        &job_path(&job_id, ""),
        "",
        WRITE,
        NO_BODY,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn cron_toggle_enabled(job_id: String, enabled: bool) -> Result<(), String> {
    let body = serde_json::json!({ "enabled": enabled });
    let _: Value = call(
        reqwest::Method::POST,
        &job_path(&job_id, "/enabled"),
        "",
        WRITE,
        Some(&body),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn cron_run_job(job_id: String) -> Result<(), String> {
    let _: Value = call(
        reqwest::Method::POST,
        &job_path(&job_id, "/run"),
        "",
        WRITE,
        NO_BODY,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn cron_get_runs(job_id: String, limit: Option<usize>) -> Result<Value, String> {
    let query = format!("?limit={}", limit.unwrap_or(50));
    call(
        reqwest::Method::GET,
        &job_path(&job_id, "/runs"),
        &query,
        READ,
        NO_BODY,
    )
    .await
}

/// Kept for the settings page; delivery reads its config on demand.
#[tauri::command]
pub async fn cron_refresh_delivery() -> Result<(), String> {
    Ok(())
}

/// True when the daemon is mid-run. The desktop's auto-restart waits on it:
/// restarting the app restarts its bundled daemon too.
#[tauri::command]
pub async fn cron_any_job_running() -> Result<bool, String> {
    #[derive(Deserialize)]
    struct Status {
        running: bool,
    }
    // An unreachable daemon is running nothing this restart could interrupt.
    match call::<(), Status>(reqwest::Method::GET, "/v1/cron/status", "", READ, NO_BODY).await {
        Ok(s) => Ok(s.running),
        Err(_) => Ok(false),
    }
}

/// Arm/disarm the daemon's "start no new run" flag ahead of an auto-restart.
#[tauri::command]
pub async fn cron_set_restart_imminent(imminent: bool) -> Result<(), String> {
    let body = serde_json::json!({ "imminent": imminent });
    let _: Value = call(
        reqwest::Method::POST,
        "/v1/cron/restart-imminent",
        "",
        WRITE,
        Some(&body),
    )
    .await?;
    Ok(())
}

// ==================== introspect ====================

/// `/cron-manage` body, forwarded as-is (`action`, `scope`, …).
pub(crate) async fn mcp_manage(body: &Value) -> Result<Value, String> {
    call(
        reqwest::Method::POST,
        "/v1/cron/manage",
        "",
        WRITE,
        Some(body),
    )
    .await
}

/// `/cron-run`: fire a job now, whatever scope it belongs to.
pub(crate) async fn run_job(job_id: &str) -> Result<(), String> {
    cron_run_job(job_id.to_string()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_query_encodes_the_workspace_path() {
        assert_eq!(scope_query(None), "");
        assert_eq!(
            scope_query(Some("/Users/a b/ws")),
            "?workspacePath=%2FUsers%2Fa%20b%2Fws"
        );
    }

    #[test]
    fn job_path_encodes_the_id() {
        assert_eq!(job_path("abc", "/run"), "/v1/cron/jobs/abc/run");
        assert_eq!(job_path("a/b", ""), "/v1/cron/jobs/a%2Fb");
    }

    #[test]
    fn legacy_file_sits_under_the_brand_dir() {
        let f = legacy_jobs_file(std::path::Path::new("/ws"));
        assert!(f.ends_with(format!("{}/cron-jobs.json", crate::commands::TEAMCLU_DIR)));
    }

    #[tokio::test]
    async fn a_missing_legacy_file_is_a_quiet_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let state = CronState::default();
        import_legacy_file(&state, dir.path().join("nope.json"), None)
            .await
            .unwrap();
    }
}
