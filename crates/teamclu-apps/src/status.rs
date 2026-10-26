//! `status` — every setting on the row, plus what the control panel's 应用
//! group shows that the row does not carry.

use serde_json::{json, Value};

use crate::row::{
    add_checkout_snapshot, app_path, app_settings, describe_code_version, is_gitea_managed, row_str,
};
use crate::{AppOps, Method};

/// Whether a directory exists and has anything in it — the web app's test for
/// "this machine already holds a checkout" (`localWorkdirHasCheckout`).
pub fn dir_has_files(dir: &str) -> bool {
    std::fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

impl AppOps<'_> {
    /// Where the checkout is, what it declares about how it runs, and how far
    /// the branch is ahead of what is live — next to every setting on the row.
    pub async fn status(&self, row: &Value) -> Value {
        let mut out = app_settings(row);
        let f = |k: &str| row.get(k).cloned().unwrap_or(Value::Null);
        out["slug"] = f("slug");
        out["created_by_actor_id"] = f("createdByActorId");
        out["git_remote_url"] = f("gitRemoteUrl");
        out["git_managed"] = json!(is_gitea_managed(row));
        out["custom_domain"] = f("customDomain");
        out["custom_domain_verified"] = json!(row_str(row, "customDomainVerifiedAt").is_some());
        // What the last successful deploy recorded, next to what the checkout
        // declares now. These disagree exactly when the declaration changed since.
        out["deployed_build_kind"] = f("runtime");
        out["deployed_start_spec"] = f("startSpec");

        let app_id = row_str(row, "id").unwrap_or_default().to_string();
        let team_id = row_str(row, "teamId").unwrap_or_default().to_string();
        if let Some((workdir, device)) = self.app_workdir_on_this_machine(row).await {
            out["checkout_present"] = json!(dir_has_files(&workdir));
            out["workdir"] = json!(workdir);
            out["device_name"] = json!(device);
        }
        if let Ok(manifest) = self.daemon.manifest(&app_id, &team_id).await {
            add_checkout_snapshot(&mut out, &manifest);
            let declaration = &manifest["declaration"];
            out["checkout_declaration"] = json!({
                "build": declaration.get("build").cloned().unwrap_or(Value::Null),
                "start": declaration.get("start").cloned().unwrap_or(Value::Null),
                "note": "Read from the required build + start blocks in teamclu.app.json. This is a hard-cut contract: legacy declaration shapes are rejected. Edit that file and deploy to change how the app is built and started.",
            });
        }

        let head = if is_gitea_managed(row) && !app_id.is_empty() {
            self.cloud
                .send(
                    Method::Get,
                    &app_path(&app_id, "/git-head?compare=1"),
                    None,
                    None,
                )
                .await
                .ok()
        } else {
            None
        };
        out["code_version"] = json!({
            "summary": describe_code_version(row, head.as_ref()),
            "branch": head.as_ref().and_then(|h| h.get("branch")).cloned(),
            "head_sha": head.as_ref().and_then(|h| h.get("sha")).cloned(),
            "deployed_sha": head.as_ref().and_then(|h| h.get("deployedSha")).cloned(),
            "undeployed_commits": head.as_ref().and_then(|h| h.get("undeployedCommits")).cloned(),
        });
        out
    }
}
