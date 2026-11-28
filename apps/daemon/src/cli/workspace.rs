//! `amuxd workspace …` — this machine's workspaces and the agent runtime in
//! each, for agents first: "is it running, on which model", "why does it not
//! see my env vars", "apply the change I just made".
//!
//! A thin client over the daemon's `/v1/workspaces*`, the same endpoints the
//! desktop's workspace settings use. MCP is read-only here on purpose: agents
//! do not change a workspace's MCP servers. Output: the `amuxd app` contract.

use clap::{Args, Subcommand};
use serde_json::json;

use super::envelope::{call_http, emit, workspace_id};

#[derive(Args, Debug)]
pub struct WorkspaceArgs {
    /// json (default), table, or file:<path>.
    #[arg(
        short = 'o',
        long = "output",
        global = true,
        default_value = "json",
        hide_default_value = true
    )]
    pub output: String,
    /// The workspace. Default: the current directory.
    #[arg(long, global = true)]
    pub workspace: Option<std::path::PathBuf>,
    #[command(subcommand)]
    pub action: WorkspaceAction,
}

#[derive(Subcommand, Debug)]
pub enum WorkspaceAction {
    /// This agent's workspaces on this machine.
    ///
    /// Example: amuxd workspace ls -o table
    #[command(alias = "list")]
    Ls,
    /// This workspace's runtime: running or not, backend, current model,
    /// changes waiting to be applied.
    ///
    /// Example: amuxd workspace show
    #[command(alias = "status")]
    Show,
    /// Apply pending changes (env, skills, providers) by restarting the
    /// runtime between turns.
    ///
    /// Example: amuxd workspace reload
    Reload,
    /// Why env vars or team settings may not reach this workspace's runtime.
    ///
    /// Example: amuxd workspace diagnose
    Diagnose,
    /// The models this workspace's runtime can use. Pick a model from this,
    /// not from memory.
    ///
    /// Example: amuxd workspace models
    Models,
    /// This workspace's MCP servers and their tools (read-only).
    ///
    /// Example: amuxd workspace mcp --refresh
    Mcp {
        /// Probe the servers again instead of the cached answer.
        #[arg(long)]
        refresh: bool,
    },
}

/// Run one command; returns the process exit status.
pub fn run(args: WorkspaceArgs) -> anyhow::Result<i32> {
    use reqwest::Method;
    if matches!(args.action, WorkspaceAction::Ls) {
        let mut envelope = call_http("workspace-cli", Method::GET, "/v1/workspaces", None, None)?;
        // `{workspaces: [...]}` → `{items: [...]}`, as every other `ls`.
        if envelope["ok"] == true {
            let items = envelope["data"]["workspaces"].take();
            envelope["data"] = json!({ "items": items });
        }
        return Ok(emit(&args.output, envelope));
    }
    let id = match workspace_id(args.workspace.as_deref()) {
        Ok(id) => id,
        Err(u) => return Ok(emit(&args.output, u.envelope())),
    };
    let base = format!("/v1/workspaces/{id}");
    let (method, path) = match &args.action {
        WorkspaceAction::Ls => unreachable!("handled above"),
        WorkspaceAction::Show => (Method::GET, format!("{base}/runtime")),
        WorkspaceAction::Reload => (Method::POST, format!("{base}/runtime/reload")),
        WorkspaceAction::Diagnose => (Method::GET, format!("{base}/runtime/env-diagnostics")),
        WorkspaceAction::Models => (Method::GET, format!("{base}/model-catalog")),
        WorkspaceAction::Mcp { refresh } => (
            Method::GET,
            if *refresh {
                format!("{base}/mcp/tools?refresh=true")
            } else {
                format!("{base}/mcp/tools")
            },
        ),
    };
    let envelope = call_http(
        "workspace-cli",
        method,
        &path,
        None,
        Some("amuxd workspace ls"),
    )?;
    Ok(emit(&args.output, envelope))
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    #[test]
    fn workspace_flag_works_before_or_after_the_command() {
        for words in [
            &["amuxd", "workspace", "--workspace", "/w", "show"][..],
            &["amuxd", "workspace", "show", "--workspace", "/w"][..],
        ] {
            match crate::cli::Cli::try_parse_from(words).unwrap().command {
                crate::cli::Commands::Workspace(args) => {
                    assert_eq!(args.workspace.unwrap(), std::path::PathBuf::from("/w"));
                }
                _ => unreachable!(),
            }
        }
    }
}
