//! The app control plane, as an agent drives it: `amuxd app …`
//! (`apps/daemon/src/cli/app.rs` over `apps/daemon/src/http/app_ops.rs`),
//! acting as the daemon's own agent account. Every agent — the ones amuxd
//! runs, Claude Code, Codex, a script — manages apps through it (P2.5; the
//! desktop's MCP tools that used to share this crate are gone).
//!
//! What a deploy or a create *is* — which calls, in which order, what goes
//! back to the cloud when a leg fails — lives here, behind three seams:
//!
//! - [`Cloud`]: one Cloud API request, on the daemon's bearer;
//! - [`LocalDaemon`]: the local amuxd's checkout and build endpoints,
//!   in-process inside amuxd;
//! - [`Host`]: hooks of the process running the flow (a change to report,
//!   who commits a seed).
//!
//! Permissions are the Cloud API's: nothing here checks or escalates past what
//! the bearer may do.

mod access;
mod checkout;
mod cloud;
mod daemon;
mod deploy;
mod error;
mod files;
mod local;
mod logs;
mod redact;
mod resolve;
mod resources;
mod row;
mod settings;
mod status;
#[cfg(test)]
mod test_support;

use std::time::Duration;

use serde_json::Value;

pub use access::{access_level, GateRule, GateSet, ACCESS_LEVELS};
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
pub use error::{ErrorKind, OpError};
pub use files::{
    encode_file_path, guess_content_type, storage_path, upload_destination, FilesQuery,
    MAX_LIST_LIMIT, MAX_UPLOAD_BYTES,
};
pub use local::RUNTIME_LANGUAGES;
pub use logs::LogsArgs;
pub use redact::{redact_deploy_secrets, redact_url_credentials};
pub use resolve::{app_owning_path, canonical_path, AppSelector};
pub use resources::{data_row_key, pick_by_name, CronFields, Named, RowRef, RowsQuery};
pub use row::{
    add_checkout_snapshot, app_brief, app_path, app_settings, describe_code_version,
    is_gitea_managed, items_of, row_id, row_str, APP_TYPES,
};
pub use settings::{update_notes, UpdateArgs};
pub use status::dir_has_files;

/// How to run a step, as a hint names it: `step("checkout reseed")` is
/// "`amuxd app checkout reseed`".
pub fn step(command: &str) -> String {
    format!("`amuxd app {command}`")
}

/// The same step as a bare command, for the machine-readable `next` field
/// of an error: something an agent can run as is, with no Markdown quoting.
pub fn next_cmd(command: &str) -> String {
    format!("amuxd app {command}")
}

/// Whose permissions a call ran under.
pub const PRINCIPAL: &str = "this daemon's agent account";

/// What to do when the daemon's cloud session is no longer accepted.
pub const REAUTH: &str = "this daemon's cloud session has expired — check `amuxd status`, and onboard it again with `amuxd init` if it stays signed out";

/// What the process running a flow contributes to it.
pub trait Host: Send + Sync {
    /// An app was created, changed or deployed — refresh whatever shows it.
    fn app_changed(&self, _row: &Value) {}

    /// The git author a seed commits as, `(name, email)`. Either half may be
    /// missing; the daemon has its own default.
    fn git_identity(&self) -> (Option<String>, Option<String>) {
        (None, None)
    }
}

/// The control plane over its three seams: cloud, daemon, host.
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

    /// One request, its failure as a sentence naming `what` was being done.
    pub async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Option<Duration>,
        what: &str,
    ) -> Result<Value, OpError> {
        self.cloud
            .send(method, path, body, timeout)
            .await
            .map_err(|e| OpError::from_cloud(what, &e))
    }

    pub async fn get(&self, path: &str, what: &str) -> Result<Value, OpError> {
        self.call(Method::Get, path, None, None, what).await
    }

    pub async fn post(&self, path: &str, body: &Value, what: &str) -> Result<Value, OpError> {
        self.call(Method::Post, path, Some(body), None, what).await
    }

    pub async fn put(&self, path: &str, body: &Value, what: &str) -> Result<Value, OpError> {
        self.call(Method::Put, path, Some(body), None, what).await
    }

    pub async fn patch(&self, path: &str, body: &Value, what: &str) -> Result<Value, OpError> {
        self.call(Method::Patch, path, Some(body), None, what).await
    }

    pub async fn del(&self, path: &str, what: &str) -> Result<Value, OpError> {
        self.call(Method::Delete, path, None, None, what).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_is_the_cli_command() {
        assert_eq!(step("checkout reseed"), "`amuxd app checkout reseed`");
    }
}
