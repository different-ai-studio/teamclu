//! Claude Code CLI discovery for `amuxd doctor`.
//!
//! The claude backend spawns the `claude` binary named by
//! `AgentLaunchConfig` — `[agents.claude_code].binary` when configured, else the
//! literal `"claude"` from `RuntimeManager::default_launch_configs`. Unlike
//! opencode there is nothing for us to install or update, and unlike cursor
//! there is no API key we hold: `claude` owns its own auth on the host. So the
//! only question worth answering is whether the binary is reachable at all.
//!
//! Without this, a claude-configured daemon reported *opencode's* install status
//! as its primary runtime, which the desktop then labelled "OpenCode 运行时" — a
//! pass/fail about the wrong program.

use crate::process_util::CommandNoWindow;
use serde::Serialize;
use std::path::PathBuf;

/// Directories Claude Code's own installers use, searched before the shared
/// well-known list.
fn claude_own_dirs() -> Vec<PathBuf> {
    dirs::home_dir()
        .map(|h| vec![h.join(".claude").join("local")])
        .unwrap_or_default()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    /// The binary the runtime would spawn (configured path or bare `claude`).
    pub binary: String,
    /// True when `[agents.claude_code].binary` names it explicitly.
    pub binary_configured: bool,
    pub binary_present: bool,
    /// Version string from `<binary> --version`, when it answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub satisfied: bool,
}

pub fn doctor() -> ClaudeStatus {
    let configured =
        crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
            .ok()
            .and_then(|c| c.agents.claude_code)
            .map(|c| c.binary)
            .filter(|b| !b.trim().is_empty());
    let binary_configured = configured.is_some();
    // Resolve an absolute path before falling back to the bare name: the
    // official installer puts claude in `~/.local/bin` (and older installs in
    // `~/.claude/local`), neither of which is on the PATH a GUI-launched daemon
    // inherits — so `claude --version` failed and the app said "not installed"
    // for a claude that works fine in a terminal. See runtime::well_known_bin.
    let binary = configured.unwrap_or_else(|| {
        crate::runtime::well_known_bin::resolve_binary("claude", None, &claude_own_dirs())
    });

    let version = claude_version(&binary);
    let binary_present = version.is_some();

    ClaudeStatus {
        binary,
        binary_configured,
        binary_present,
        version,
        satisfied: binary_present,
    }
}

/// `<binary> --version` → its first line, or `None` when it cannot be run.
///
/// Invoking it is the check: an absolute path can exist without being
/// executable, and a bare name has to be resolved through PATH anyway.
fn claude_version(binary: &str) -> Option<String> {
    // Same PATH augmentation as the other probes: a node-shebang shim needs
    // node reachable, not just itself.
    let out = std::process::Command::new(binary)
        .no_window()
        .arg("--version")
        .env("PATH", crate::runtime::well_known_bin::augmented_path())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| line.to_string())
}
