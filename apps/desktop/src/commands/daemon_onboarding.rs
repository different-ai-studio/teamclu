use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInitResult {
    pub actor_id: String,
    pub team_id: String,
}

/// Parse `amuxd init` stdout. Lines look like `  actor_id      = <uuid>` (multiple
/// spaces around `=`), so split on the FIRST `=` and trim both sides.
fn parse_init_outcome(stdout: &str) -> Option<DaemonInitResult> {
    let mut actor_id: Option<String> = None;
    let mut team_id: Option<String> = None;
    for line in stdout.lines() {
        if let Some((key, val)) = line.split_once('=') {
            let key = key.trim();
            let val = val.trim().to_string();
            if key == "actor_id" {
                actor_id = Some(val);
            } else if key == "team_id" {
                team_id = Some(val);
            }
        }
    }
    match (actor_id, team_id) {
        (Some(a), Some(t)) if !a.is_empty() && !t.is_empty() => Some(DaemonInitResult {
            actor_id: a,
            team_id: t,
        }),
        _ => None,
    }
}

/// Run the bundled `amuxd init <invite_url>`, capturing stdout to extract the
/// claimed actor/team ids. The daemon itself POSTs /v1/invites/claim.
#[tauri::command]
pub async fn daemon_init<R: Runtime>(
    app: AppHandle<R>,
    invite_url: String,
) -> Result<DaemonInitResult, String> {
    let command = super::with_amuxd_brand_env(
        app.shell()
            .sidecar("amuxd")
            .map_err(|e| format!("sidecar amuxd: {e}"))?
            .args(["init", &invite_url]),
    );
    let (mut rx, _child_guard) = command
        .spawn()
        .map_err(|e| format!("spawn amuxd init: {e}"))?;

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut exit_code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout_buf.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Stderr(bytes) => stderr_buf.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Terminated(payload) => exit_code = Some(payload.code.unwrap_or(-1)),
            _ => {}
        }
    }
    if exit_code != Some(0) {
        return Err(format!(
            "amuxd init failed (code {:?}): {}",
            exit_code,
            stderr_buf.trim()
        ));
    }
    parse_init_outcome(&stdout_buf)
        .ok_or_else(|| format!("could not parse amuxd init output: {}", stdout_buf.trim()))
}

/// Run `amuxd <args>` to completion, returning Err with stderr on non-zero exit.
async fn run_amuxd<R: Runtime>(app: &AppHandle<R>, args: &[&str]) -> Result<(), String> {
    let command = super::with_amuxd_brand_env(
        app.shell()
            .sidecar("amuxd")
            .map_err(|e| format!("sidecar amuxd: {e}"))?
            .args(args),
    );
    let (mut rx, _child_guard) = command
        .spawn()
        .map_err(|e| format!("spawn amuxd {}: {e}", args.join(" ")))?;
    let mut stderr_buf = String::new();
    let mut exit_code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => stderr_buf.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Terminated(payload) => exit_code = Some(payload.code.unwrap_or(-1)),
            _ => {}
        }
    }
    if exit_code != Some(0) {
        return Err(format!(
            "amuxd {} failed (code {:?}): {}",
            args.join(" "),
            exit_code,
            stderr_buf.trim()
        ));
    }
    Ok(())
}

/// Wipe local daemon state (daemon.toml/backend.toml/etc) for a clean re-onboard.
/// Stops the managed amuxd first so `clear` can take the lock.
#[tauri::command]
pub async fn daemon_clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::commands::amuxd_supervisor::AmuxdSupervisor::shutdown(&app).await;
    run_amuxd(&app, &["clear", "--force"]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_actor_and_team_from_init_stdout() {
        let stdout = "\n✓ Daemon onboarded.\n  actor_id      = 11111111-1111-1111-1111-111111111111\n  team_id       = 22222222-2222-2222-2222-222222222222\n  display_name  = Build Bot\n  backend.toml  = /home/x/.amuxd/backend.toml\n\nNext: `amuxd start`";
        let out = parse_init_outcome(stdout).unwrap();
        assert_eq!(out.actor_id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(out.team_id, "22222222-2222-2222-2222-222222222222");
    }

    #[test]
    fn returns_none_when_missing() {
        assert!(parse_init_outcome("nothing here").is_none());
    }
}
