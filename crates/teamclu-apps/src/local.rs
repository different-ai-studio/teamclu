//! The app as this machine sees it: where its checkout is (`checkout where`),
//! pointing it at a folder (`checkout bind`) or moving it (`checkout move`),
//! what this machine can build (`runtime`), and the sessions opened on it
//! (`sessions`). Moved here from the desktop's MCP handlers so `amuxd app`
//! answers the same way (P2.5 S2).

use std::path::Path;

use serde_json::{json, Value};

use crate::checkout::bind_workspace_fields;
use crate::daemon::{daemon_error_text, DAEMON_DOWN};
use crate::resolve::canonical_path;
use crate::row::{app_path, items_of, row_id, row_str};
use crate::{AppOps, OpError};

/// The languages `runtime --language` narrows to.
pub const RUNTIME_LANGUAGES: [&str; 5] = ["node", "python", "go", "php", "java"];

/// `path` with symlinks resolved as far as it exists: the nearest existing
/// ancestor canonicalized, the rest appended. [`canonical_path`] leaves a
/// path that does not exist untouched, so a missing child of a symlinked root
/// (`/var` → `/private/var` on macOS) would never compare equal to its
/// resolved parent.
fn resolved(path: &str) -> std::path::PathBuf {
    let raw = Path::new(path);
    for ancestor in raw.ancestors() {
        if let Ok(real) = std::fs::canonicalize(ancestor) {
            let rest = raw.strip_prefix(ancestor).unwrap_or(Path::new(""));
            return real.join(rest);
        }
    }
    canonical_path(path)
}

/// Whether moving `checkout` would pull the caller's own working directory
/// out from under it.
fn holds(checkout: &Path, caller_workspace: &Path) -> bool {
    caller_workspace.starts_with(checkout)
}

/// The daemon's facts about this machine, kept as the daemon gave them — not
/// replaced by the caller's own OS or the platform's target runtime.
fn host_facts(response: &Value) -> Result<Value, OpError> {
    let facts = response.get("hostFacts").filter(|facts| {
        ["os", "arch", "buildShell"].iter().all(|key| {
            facts[*key]
                .as_str()
                .is_some_and(|value| !value.trim().is_empty())
        }) && facts["docker"].is_boolean()
            && ["pnpm", "python3", "go", "java", "docker"]
                .iter()
                .all(|key| facts["buildTools"][*key].is_boolean())
            && facts["buildTools"]["docker"] == facts["docker"]
    });
    facts.cloned().ok_or_else(|| {
        OpError::upstream(
            "no_host_facts",
            "the local amuxd returned no usable facts about this machine",
        )
    })
}

impl AppOps<'_> {
    /// `checkout where` — this machine's checkout of the app, if it has one.
    pub async fn checkout_where(&self, row: &Value) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let here = self.app_workdir_on_this_machine(row).await;
        let exists = here
            .as_ref()
            .is_some_and(|(dir, _)| Path::new(dir).is_dir());
        let mut out = json!({
            "action": "checkout_where",
            "app_id": app_id,
            "workdir": here.as_ref().map(|(dir, _)| dir),
            "device_name": here.as_ref().and_then(|(_, device)| device.clone()),
            "exists": exists,
        });
        if !exists {
            out["next"] = json!(format!(
                "No checkout on this machine yet: {} puts the code here, {} uses a folder that already has it.",
                crate::step("checkout clone"),
                crate::step("checkout bind"),
            ));
        }
        Ok(out)
    }

    /// `checkout bind <dir>` — take a folder already on this machine as the
    /// app's checkout, where it is.
    pub async fn checkout_bind(&self, row: &Value, dir: &str) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        if !Path::new(dir).is_absolute() {
            return Err(OpError::invalid(
                "relative_dir",
                format!("checkout bind needs an absolute path (got {dir:?})"),
            ));
        }
        if !Path::new(dir).is_dir() {
            return Err(OpError::not_found(
                "dir_not_found",
                format!("{dir} is not a directory on this machine"),
            ));
        }
        let origin = self.folder_origin(dir).await?;
        let workdir = self.bind_workdir(row, dir).await?;
        let mut out = json!({
            "ok": true,
            "action": "checkout_bind",
            "app_id": app_id,
            "workdir": workdir,
            "git_origin": origin,
        });
        bind_workspace_fields(self, row, &workdir, &mut out).await;
        self.host.app_changed(row);
        Ok(out)
    }

    /// `checkout move <dest>` — relocate this machine's checkout, whole.
    ///
    /// Not the checkout the caller stands in: that would pull the working
    /// directory out from under the session that asked, mid-turn.
    pub async fn checkout_move(
        &self,
        row: &Value,
        dest: &str,
        caller_workspace: Option<&str>,
    ) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        if !Path::new(dest).is_absolute() {
            return Err(OpError::invalid(
                "relative_dir",
                format!("checkout move needs an absolute destination (got {dest:?})"),
            ));
        }
        let current = self.app_workdir_on_this_machine(row).await.map(|(w, _)| w);
        if let (Some(current), Some(caller)) = (current.as_deref(), caller_workspace) {
            if holds(&resolved(current), &resolved(caller)) {
                return Err(OpError::conflict(
                    "moves_own_checkout",
                    format!("{current} is the directory this command runs in; moving it would pull it out from under the caller. Run it from somewhere else."),
                ));
            }
        }
        let team_id = row_str(row, "teamId").unwrap_or("");
        let moved = self
            .daemon
            .move_workdir(&app_id, team_id, dest)
            .await
            .map_err(|e| {
                if e.unreachable {
                    OpError::daemon_down(DAEMON_DOWN)
                } else {
                    OpError::daemon_failed(format!(
                        "Moving the checkout failed: {}. The original directory was left where it was.",
                        daemon_error_text(&e)
                    ))
                }
            })?;
        let workdir = row_str(&moved, "workdir").unwrap_or(dest).to_string();
        // The cloud row too: runtime-start resolves a session's path from
        // it, and an old path keeps open sessions on a directory now gone.
        let mut out = json!({
            "ok": true,
            "action": "checkout_move",
            "app_id": app_id,
            "from": current,
            "workdir": workdir,
        });
        bind_workspace_fields(self, row, &workdir, &mut out).await;
        self.host.app_changed(row);
        Ok(out)
    }

    /// `runtime [--language L]` — the deployment contract and the regional
    /// runtimes from the platform, and what this machine can build.
    pub async fn runtime_info(
        &self,
        row: &Value,
        language: Option<&str>,
    ) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let mut path = app_path(&app_id, "/runtime-info");
        if let Some(language) = language {
            if !RUNTIME_LANGUAGES.contains(&language) {
                return Err(OpError::invalid(
                    "invalid_language",
                    format!(
                        "language must be one of {} (got {language:?})",
                        RUNTIME_LANGUAGES.join(", ")
                    ),
                ));
            }
            path.push_str(&format!("?language={language}"));
        }
        let runtime = self.get(&path, "Reading the runtime facts").await?;
        let team_id = row_str(row, "teamId").unwrap_or("");
        let this_machine = match self.daemon.workdir(&app_id, team_id).await {
            Ok(out) => host_facts(&out)?,
            Err(e) if e.unreachable => return Err(OpError::daemon_down(DAEMON_DOWN)),
            Err(e) => return Err(OpError::daemon_failed(daemon_error_text(&e))),
        };
        Ok(json!({
            "action": "runtime",
            "app_id": app_id,
            "runtime": runtime,
            "this_machine": this_machine,
        }))
    }

    /// `sessions` — the conversations opened on the app.
    pub async fn sessions(&self, row: &Value) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let page = self
            .get(
                &app_path(&app_id, "/sessions"),
                "Listing the app's sessions",
            )
            .await?;
        let sessions: Vec<Value> = items_of(&page)
            .iter()
            .map(|s| {
                json!({
                    "id": s.get("id"),
                    "title": s.get("title"),
                    "last_message_at": s.get("lastMessageAt"),
                    "created_at": s.get("createdAt"),
                })
            })
            .collect();
        Ok(json!({ "action": "sessions", "app_id": app_id, "sessions": sessions }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moving_the_callers_own_checkout_is_refused_but_not_a_sibling() {
        let checkout = Path::new("/home/u/.amuxd/teams/t/apps/a1");
        assert!(holds(checkout, checkout));
        assert!(holds(checkout, &checkout.join("src")));
        assert!(!holds(
            checkout,
            Path::new("/home/u/.amuxd/teams/t/apps/a10")
        ));
    }

    #[test]
    fn a_missing_path_resolves_through_its_existing_ancestor() {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        let missing = dir.path().join("src/deep");
        assert_eq!(resolved(missing.to_str().unwrap()), real.join("src/deep"));
        assert!(holds(
            &resolved(dir.path().to_str().unwrap()),
            &resolved(missing.to_str().unwrap())
        ));
    }

    #[test]
    fn host_facts_must_be_whole() {
        let good = json!({ "hostFacts": {
            "os": "macos", "arch": "aarch64", "buildShell": "zsh", "docker": false,
            "buildTools": { "pnpm": true, "python3": true, "go": false, "java": false, "docker": false },
        }});
        assert_eq!(host_facts(&good).unwrap()["os"], "macos");
        assert_eq!(host_facts(&json!({})).unwrap_err().code, "no_host_facts");
    }
}
