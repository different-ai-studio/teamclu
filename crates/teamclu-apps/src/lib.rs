//! The app control plane, as an agent drives it — shared by every surface
//! that offers it.
//!
//! Two surfaces today:
//!
//! - the desktop's `teamclu-introspect` tools (`manage_app`, in
//!   `apps/desktop/src/commands/introspect_api/apps.rs`), which act as the
//!   signed-in user and ask them to approve a deploy;
//! - `amuxd app …` (`apps/daemon/src/cli/app.rs` over
//!   `apps/daemon/src/http/app_ops.rs`), which acts as the daemon's own agent
//!   account so an agent amuxd did not start — Claude Code, Codex, a script —
//!   can create and publish apps.
//!
//! Covered so far: list, status, create, reseed, download, update, deploy,
//! logs and delete. The desktop's other app tools (access, env, cron, domain,
//! data, files, move_workdir) are still only in the desktop.
//!
//! What a deploy or a create *is* — which calls, in which order, what goes
//! back to the cloud when a leg fails — lives here once. Each surface supplies
//! three things:
//!
//! - [`Cloud`]: one Cloud API request, on whatever bearer that surface holds;
//! - [`LocalDaemon`]: the local amuxd's checkout and build endpoints, over
//!   loopback from the desktop or in-process inside amuxd;
//! - [`Host`]: how it names its own commands in a hint, and the hooks only it
//!   has (an approval dialog, a window to refresh, who commits a seed).
//!
//! Permissions are the Cloud API's: nothing here checks or escalates past what
//! the bearer may do.

mod checkout;
mod cloud;
mod daemon;
mod deploy;
mod logs;
mod redact;
mod resolve;
mod row;
mod settings;
mod status;
#[cfg(test)]
mod test_support;

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

pub use checkout::{
    bind_workspace_fields, run_seed, workspace_paths_match, write_provision_status, CreateArgs,
    CreateSource, SEED_TIMEOUT,
};
pub use cloud::{explain, Cloud, CloudError, Method};
pub use daemon::{daemon_error_text, DaemonError, LocalDaemon, DAEMON_DOWN};
pub use deploy::{
    deploy_failure_request, mint_git_credential, require_artifact_verification,
    return_git_credential, DeployArgs, GitCredential,
};
pub use logs::LogsArgs;
pub use redact::{redact_deploy_secrets, redact_url_credentials};
pub use resolve::{app_owning_path, canonical_path, AppSelector};
pub use row::{
    add_checkout_snapshot, app_brief, app_path, app_settings, describe_code_version,
    is_gitea_managed, items_of, row_id, row_str, APP_TYPES,
};
pub use settings::{update_notes, UpdateArgs};
pub use status::dir_has_files;

/// Which surface is speaking — decides how a hint names the next step.
///
/// An agent told "run manage_app action \"reseed\"" from a shell has no such
/// tool, and one told "run `amuxd app deploy`" inside TeamClu has no shell
/// command to reach for. Each failure message names the step in the caller's
/// own vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    /// The `teamclu-introspect` MCP tools, as the signed-in desktop user.
    Mcp,
    /// `amuxd app …`, as the daemon's agent account.
    Cli,
}

impl Surface {
    /// How to run `action` of `tool` (`manage_app`, `manage_app_files`, …).
    pub fn step(self, tool: &str, action: &str) -> String {
        match self {
            Surface::Mcp => format!("{tool} action \"{action}\""),
            Surface::Cli => {
                let group = tool
                    .strip_prefix("manage_app")
                    .unwrap_or(tool)
                    .trim_start_matches('_');
                let action = action.replace('_', "-");
                if group.is_empty() {
                    format!("`amuxd app {action}`")
                } else {
                    format!("`amuxd app {group} {action}`")
                }
            }
        }
    }

    /// Whose permissions a call ran under.
    pub fn principal(self) -> &'static str {
        match self {
            Surface::Mcp => "the signed-in user",
            Surface::Cli => "this daemon's agent account",
        }
    }

    /// What to do when the bearer is no longer accepted.
    pub fn reauth(self) -> &'static str {
        match self {
            Surface::Mcp => {
                "the desktop's sign-in has expired — ask the user to open TeamClu and sign in again"
            }
            Surface::Cli => {
                "this daemon's cloud session has expired — check `amuxd status`, and onboard it again with `amuxd init` if it stays signed out"
            }
        }
    }
}

/// What the surface itself contributes to a flow.
#[async_trait]
pub trait Host: Send + Sync {
    fn surface(&self) -> Surface;

    /// Called once the server has previewed what a deploy changes, before
    /// anything is uploaded. An `Err` stops the deploy and withdraws the
    /// preflight; its text is the reply. `Ok(true)` also switches an app still
    /// on its old domain to its app-code domain once the deploy succeeds; a
    /// host with nobody to ask leaves that to [`DeployArgs`].
    async fn approve_deploy(&self, _row: &Value, _preview: &Value) -> Result<bool, String> {
        Ok(false)
    }

    /// An app was created, changed or deployed — refresh whatever shows it.
    fn app_changed(&self, _row: &Value) {}

    /// The git author a seed commits as, `(name, email)`. Either half may be
    /// missing; the daemon has its own default.
    fn git_identity(&self) -> (Option<String>, Option<String>) {
        (None, None)
    }
}

/// One surface's view of the control plane: its cloud, its daemon, itself.
#[derive(Clone, Copy)]
pub struct AppOps<'a> {
    pub cloud: &'a dyn Cloud,
    pub daemon: &'a dyn LocalDaemon,
    pub host: &'a dyn Host,
}

impl<'a> AppOps<'a> {
    pub fn new(cloud: &'a dyn Cloud, daemon: &'a dyn LocalDaemon, host: &'a dyn Host) -> Self {
        Self {
            cloud,
            daemon,
            host,
        }
    }

    pub fn surface(&self) -> Surface {
        self.host.surface()
    }

    /// One request, its failure as a sentence naming `what` was being done.
    pub async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Option<Duration>,
        what: &str,
    ) -> Result<Value, String> {
        self.cloud
            .send(method, path, body, timeout)
            .await
            .map_err(|e| explain(self.surface(), what, &e))
    }

    pub async fn get(&self, path: &str, what: &str) -> Result<Value, String> {
        self.call(Method::Get, path, None, None, what).await
    }

    pub async fn post(&self, path: &str, body: &Value, what: &str) -> Result<Value, String> {
        self.call(Method::Post, path, Some(body), None, what).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_surface_names_the_step_in_its_own_vocabulary() {
        assert_eq!(
            Surface::Mcp.step("manage_app", "reseed"),
            "manage_app action \"reseed\""
        );
        assert_eq!(
            Surface::Cli.step("manage_app", "reseed"),
            "`amuxd app reseed`"
        );
        assert_eq!(
            Surface::Cli.step("manage_app_files", "set_quota"),
            "`amuxd app files set-quota`"
        );
    }
}
