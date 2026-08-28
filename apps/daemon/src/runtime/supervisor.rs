//! Workspace runtime supervisor - bootstrap + RuntimeManager lifecycle.
//!
//! Replaces the desktop `start_opencode` sidecar path: workspace prep runs
//! here before agent spawn, and `/v1/workspaces/:id/runtime/*` handlers
//! delegate reload/status to the shared `RuntimeManager`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::process_util::CommandNoWindow;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tracing::{info, warn};

/// Matches `apps/desktop/src/commands/introspect_api.rs` — desktop Tauri hosts the API.
pub(crate) const INTROSPECT_API_PORT: u16 = 13144;
const TEAM_SKILLS_PATH: &str = "teamclu-team/skills";
const REMOTE_TOOLS_MCP_SERVER_NAME: &str = "amuxd-remote-tools";

/// Inherent MCP servers that older builds wrote into workspace configs under a
/// name this build no longer maintains. Removed on sight — see the call site.
/// Names no runtime should load any more. `teamclaw-introspect` is the
/// pre-rename sidecar; `amuxd-send` is the retired second daemon MCP server
/// whose `send` tool now lives in `teamclu-introspect`. Both are removed from
/// any workspace config that still carries a copy — leaving one means spawning
/// a server that no longer exists, and under pi a failed bridge spawn used to
/// take the whole runtime down.
const LEGACY_MCP_NAMES: &[&str] = &["teamclaw-introspect", "amuxd-send"];
const INSTRUCTION_PLUGIN_TEMPLATE: &str = include_str!(
    "../../../../packages/app/src/lib/opencode/templates/teamclu-instruction-plugin.mjs.txt"
);
const SESSION_CONTEXT_PLUGIN_TEMPLATE: &str = include_str!(
    "../../../../packages/app/src/lib/opencode/templates/teamclu-session-context-plugin.mjs.txt"
);
const SESSION_CONTEXT_CLIENT_TEMPLATE: &str = include_str!("../../shared/session-context-client.mjs");

use crate::config::workspace_control::{
    ApplyOutcome, EnvActivationBlocker, EnvActivationDiagnostics, RuntimeStatus,
    WorkspaceControlError,
};
use crate::proto::amux;
use crate::runtime::{
    refresh::{
        RefreshChangeKind, RuntimeRefreshCoordinator, WorkspaceRefreshState,
        APPLY_REFRESH_SUPPRESS, INTERNAL_PREPARE_KINDS, INTERNAL_WRITE_SUPPRESS,
    },
    AgentLaunchConfig, RuntimeManager,
};

struct InherentSkill {
    dirname: &'static str,
    content: &'static str,
}

fn inherent_desktop_control_skill() -> Option<InherentSkill> {
    #[cfg(target_os = "macos")]
    return Some(InherentSkill {
        dirname: "macos-control",
        content: include_str!("../../../../packages/app/src/lib/skills/macos-control/SKILL.md"),
    });

    #[cfg(target_os = "windows")]
    return Some(InherentSkill {
        dirname: "windows-control",
        content: include_str!("../../../../packages/app/src/lib/skills/windows-control/SKILL.md"),
    });

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    None
}

fn inherent_skills() -> Vec<InherentSkill> {
    let mut out = vec![InherentSkill {
        dirname: "create-role",
        content: include_str!("../../../../packages/app/src/lib/skills/create-role/SKILL.md"),
    }];
    if let Some(skill) = inherent_desktop_control_skill() {
        out.push(skill);
    }
    out
}

fn opencode_json_path(workspace_path: &Path) -> PathBuf {
    workspace_path.join("opencode.json")
}

fn map_store_err(
    e: teamclu_runtime_env::opencode_config::OpencodeConfigError,
) -> WorkspaceControlError {
    WorkspaceControlError::Io(e.to_string())
}

fn ws_to_store_err(
    e: WorkspaceControlError,
) -> teamclu_runtime_env::opencode_config::OpencodeConfigError {
    match e {
        WorkspaceControlError::Io(s) => {
            teamclu_runtime_env::opencode_config::OpencodeConfigError::Io(s)
        }
        WorkspaceControlError::Parse(s) => {
            teamclu_runtime_env::opencode_config::OpencodeConfigError::Parse(s)
        }
        other => {
            teamclu_runtime_env::opencode_config::OpencodeConfigError::Parse(other.to_string())
        }
    }
}

fn mutate_default_permissions(
    config: &mut serde_json::Value,
) -> Result<bool, WorkspaceControlError> {
    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;
    if obj.contains_key("permission") {
        return Ok(false);
    }
    obj.insert(
        "permission".to_string(),
        serde_json::json!({
            "bash": "ask",
            "edit": "ask",
            "write": "ask",
            "external_directory": "ask",
            "doom_loop": "ask"
        }),
    );
    Ok(true)
}

fn mutate_inherent_mcp(
    workspace_path: &Path,
    config: &mut serde_json::Value,
) -> Result<bool, WorkspaceControlError> {
    if config.as_object().map(|o| o.is_empty()).unwrap_or(true) && config.get("$schema").is_none() {
        if let Some(obj) = config.as_object_mut() {
            obj.insert(
                "$schema".to_string(),
                serde_json::json!("https://opencode.ai/config.json"),
            );
        }
    }

    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    let mcp = obj.entry("mcp").or_insert_with(|| serde_json::json!({}));
    let mcp_obj = mcp
        .as_object_mut()
        .ok_or_else(|| WorkspaceControlError::Parse("mcp is not an object".into()))?;

    let mut changed = false;

    // Auto-inject of `amuxd-remote-tools` is paused — keep the stdio server
    // (`amuxd remote-tools-mcp`) but do not surface it in workspace MCP.
    // Strip leftovers from earlier builds so GET /mcp and Team Share go quiet.
    if mcp_obj.remove(REMOTE_TOOLS_MCP_SERVER_NAME).is_some() {
        changed = true;
    }

    // `amuxd-send`, `playwright`, `chrome-control` and `autoui` are device-level
    // and live in `~/.amuxd/mcp.json` (see `config::device_mcp`). They used to be
    // written here, once per workspace, each copy carrying this machine's
    // absolute binary paths. Drop any such copy: it outranks the device file, so
    // leaving it pins the workspace to whatever was current when it was written.
    let device_names: Vec<String> = mcp_obj
        .keys()
        .filter(|name| crate::config::device_mcp::is_device_scoped(name))
        .cloned()
        .collect();
    for name in device_names {
        mcp_obj.remove(&name);
        changed = true;
    }

    // Renamed inherent servers. The 2026-08-09 teamclaw→teamclu rename changed
    // the sidecar's binary name; the entries already written into every
    // workspace kept the old name AND an absolute path into the app bundle, and
    // nothing owned them afterwards: `is_device_scoped` does not list them and
    // the introspect self-heal below matches the new name only. Under opencode
    // a dead server is merely ignored, so they sat there until someone switched
    // to pi — where the extension's bridge spawn took the whole runtime down.
    for name in LEGACY_MCP_NAMES {
        if mcp_obj.remove(*name).is_some() {
            info!(
                workspace = %workspace_path.display(),
                server = name,
                "dropping renamed inherent MCP entry from workspace config"
            );
            changed = true;
        }
    }

    ensure_extended_inherent_config(config, &mut changed)?;
    Ok(changed)
}

fn mutate_instruction_plugin(
    config: &mut serde_json::Value,
) -> Result<bool, WorkspaceControlError> {
    use crate::runtime::workspace_runtime::INSTRUCTION_PLUGIN_CONFIG_ENTRY;

    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    if obj.get("$schema").is_none() {
        obj.insert(
            "$schema".to_string(),
            serde_json::json!("https://opencode.ai/config.json"),
        );
    }

    let plugins = obj.entry("plugin").or_insert_with(|| serde_json::json!([]));
    let plugin_list = plugins.as_array_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json plugin field is not an array".into())
    })?;

    let already_registered = plugin_list.iter().any(|entry| {
        entry
            .as_str()
            .map(|value| value.contains("teamclu-instruction"))
            .unwrap_or(false)
    });
    if already_registered {
        return Ok(false);
    }
    plugin_list.push(serde_json::json!(INSTRUCTION_PLUGIN_CONFIG_ENTRY));
    Ok(true)
}

fn mutate_session_context_plugin(
    config: &mut serde_json::Value,
) -> Result<bool, WorkspaceControlError> {
    use crate::runtime::workspace_runtime::SESSION_CONTEXT_PLUGIN_CONFIG_ENTRY;

    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    let plugins = obj.entry("plugin").or_insert_with(|| serde_json::json!([]));
    let plugin_list = plugins.as_array_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json plugin field is not an array".into())
    })?;

    let already_registered = plugin_list.iter().any(|entry| {
        entry
            .as_str()
            .map(|value| value.contains("teamclu-session-context"))
            .unwrap_or(false)
    });
    if already_registered {
        return Ok(false);
    }
    plugin_list.push(serde_json::json!(SESSION_CONTEXT_PLUGIN_CONFIG_ENTRY));
    Ok(true)
}

/// One read-modify-write for prepare/reload paths.
pub fn materialize_opencode_for_prepare(
    workspace_path: &Path,
) -> Result<(), WorkspaceControlError> {
    ensure_device_layers();
    teamclu_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace_path, |config| {
        let mut changed = false;
        changed |= mutate_default_permissions(config).map_err(ws_to_store_err)?;
        changed |= mutate_inherent_mcp(workspace_path, config).map_err(ws_to_store_err)?;
        changed |= mutate_instruction_plugin(config).map_err(ws_to_store_err)?;
        changed |= mutate_session_context_plugin(config).map_err(ws_to_store_err)?;
        Ok(changed)
    })
    .map_err(map_store_err)?;
    Ok(())
}

/// One read-modify-write for spawn: inherent MCP only.
///
/// Cloud `provider.team` materialization and secret resolution run in
/// [`teamclu_runtime_env::assemble_runtime_env`] via
/// [`teamclu_runtime_env::sync_global_team_provider`].
pub fn materialize_inherent_mcp_for_spawn(
    workspace_path: &Path,
) -> Result<(), WorkspaceControlError> {
    ensure_device_layers();
    teamclu_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace_path, |config| {
        mutate_inherent_mcp(workspace_path, config).map_err(ws_to_store_err)
    })
    .map_err(map_store_err)?;
    Ok(())
}

/// Seed the device MCP file for a read that is not a spawn.
///
/// The MCP inventory RPC reports what this machine has; `ensure_device_mcp` is
/// what puts the device servers there. Exposed separately from
/// [`ensure_device_layers`] because an inventory read has no business touching
/// the team's `skills.paths`.
pub(crate) fn ensure_device_mcp_for_inventory() {
    if let Err(e) = crate::config::device_mcp::ensure_device_mcp() {
        warn!(error = %e, "seeding device MCP config failed");
    }
}

/// Seed the two device-level layers the workspace config no longer carries:
/// `~/.amuxd/mcp.json` (device MCP) and the active team's global `skills.paths`.
///
/// Best-effort on purpose — both are read with a "missing means empty" fallback,
/// so a failure here degrades to "no device MCP this run" rather than blocking a
/// spawn. It logs, which is what makes that visible.
fn ensure_device_layers() {
    if let Err(e) = crate::config::device_mcp::ensure_device_mcp() {
        warn!(error = %e, "seeding device MCP config failed");
    }
    if let Err(e) = ensure_global_skill_paths() {
        warn!(error = %e, "seeding global skill paths failed");
    }
}

/// Seed inherent MCP entries that TeamClu expects (non-destructive).
pub fn ensure_inherent_mcp(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    ensure_device_layers();
    let config_path = opencode_json_path(workspace_path);
    let changed = teamclu_runtime_env::opencode_config::OpencodeConfigStore::apply(
        workspace_path,
        |config| mutate_inherent_mcp(workspace_path, config).map_err(ws_to_store_err),
    )
    .map_err(map_store_err)?;
    if changed {
        info!(
            workspace = %workspace_path.display(),
            config_path = %config_path.display(),
            "ensure_inherent_mcp: opencode.json updated"
        );
    }
    Ok(())
}

// The gateway `send` bridge moved to `config::device_mcp`: nothing in its argv is
// workspace-specific, so one registration per machine replaces one per workspace.

fn resolve_executable(path: PathBuf) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path);
    }
    #[cfg(windows)]
    {
        let with_exe = path.with_extension("exe");
        if with_exe.is_file() {
            return Some(with_exe);
        }
    }
    None
}

fn runtime_target_triple() -> &'static str {
    #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
    {
        return "aarch64-apple-darwin";
    }
    #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
    {
        return "x86_64-apple-darwin";
    }
    #[cfg(all(target_arch = "aarch64", target_os = "linux"))]
    {
        return "aarch64-unknown-linux-gnu";
    }
    #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
    {
        return "x86_64-unknown-linux-gnu";
    }
    #[cfg(all(target_arch = "x86_64", target_os = "windows"))]
    {
        return "x86_64-pc-windows-msvc";
    }
    #[allow(unreachable_code)]
    "unknown-unknown-unknown"
}

fn introspect_candidates_in_dir(dir: &Path) -> Option<PathBuf> {
    for candidate in [
        dir.join(format!("teamclu-introspect-{}", runtime_target_triple())),
        dir.join("teamclu-introspect"),
    ] {
        if let Some(resolved) = resolve_executable(candidate) {
            return Some(resolved);
        }
    }
    None
}

/// Production daemons run from `~/.amuxd/bin/amuxd`, but `teamclu-introspect`
/// stays in the desktop app bundle (or dev `apps/desktop/binaries/`). Search
/// those locations after the current-exe directory.
fn find_introspect_in_installed_app_bundles() -> Option<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/Applications"));
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            roots.push(PathBuf::from(pf));
        }
        if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
            roots.push(PathBuf::from(pf86));
        }
    }
    if let Some(home) = dirs::home_dir() {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            roots.push(home.join("Applications"));
        }
        #[cfg(target_os = "linux")]
        {
            roots.push(home.join(".local/share/applications"));
        }
    }

    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let bundle = entry.path();
            #[cfg(target_os = "macos")]
            {
                if bundle.extension().and_then(|e| e.to_str()) != Some("app") {
                    continue;
                }
                if let Some(found) = introspect_candidates_in_dir(&bundle.join("Contents/MacOS")) {
                    return Some(found);
                }
            }
            #[cfg(target_os = "windows")]
            {
                if !bundle.is_dir() {
                    continue;
                }
                if let Some(found) = introspect_candidates_in_dir(&bundle) {
                    return Some(found);
                }
            }
        }
    }
    None
}

pub(crate) fn resolve_introspect_binary() -> Option<String> {
    // Desktop-managed mode injects the bundled sidecar absolute path.
    if let Ok(path) = std::env::var("TEAMCLU_INTROSPECT_BIN") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let p = std::path::Path::new(trimmed);
            if p.is_file() {
                return Some(trimmed.to_string());
            }
            tracing::warn!(
                path = trimmed,
                "TEAMCLU_INTROSPECT_BIN set but file missing; falling back"
            );
        }
    }

    if std::process::Command::new("sh")
        .no_window()
        .arg("-lc")
        .arg("command -v teamclu-introspect")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some("teamclu-introspect".to_string());
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(resolved) = introspect_candidates_in_dir(dir) {
                return Some(resolved.to_string_lossy().into_owned());
            }
        }
    }

    let amuxd_bin = crate::config::DaemonConfig::config_dir().join("bin");
    if let Some(resolved) = introspect_candidates_in_dir(&amuxd_bin) {
        return Some(resolved.to_string_lossy().into_owned());
    }

    if let Some(resolved) = find_introspect_in_installed_app_bundles() {
        return Some(resolved.to_string_lossy().into_owned());
    }

    if let Ok(cwd) = std::env::current_dir() {
        for root in [
            cwd.clone(),
            cwd.join(".."),
            cwd.join("../.."),
            cwd.join("../../.."),
        ] {
            let candidate = root
                .join("apps/desktop/binaries")
                .join(format!("teamclu-introspect-{}", runtime_target_triple()));
            if let Some(resolved) = resolve_executable(candidate) {
                return Some(resolved.to_string_lossy().into_owned());
            }
        }
    }

    None
}

pub(crate) fn introspect_command_stale(existing: &serde_json::Value) -> bool {
    existing
        .get("command")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(|p| !Path::new(p).exists())
        .unwrap_or(true)
}

/// Port of desktop `ensure_inherent_config`, now down to pruning stale
/// `skills.paths`: every inherent MCP server it used to seed here is written
/// once per machine instead, so nothing in it depends on the workspace any more.
fn ensure_extended_inherent_config(
    config: &mut serde_json::Value,
    changed: &mut bool,
) -> Result<(), WorkspaceControlError> {
    let obj = config.as_object_mut().ok_or_else(|| {
        WorkspaceControlError::Parse("opencode.json root is not an object".into())
    })?;

    // No MCP server is seeded here any more. teamclu-introspect / autoui /
    // playwright / chrome-control / amuxd-send are all written once per machine
    // by `config::device_mcp::ensure_device_mcp`. Introspect was the last one
    // written per workspace, for the sake of a `--workspace` argument it does
    // not need: the flag defaults to `.` and MCP children are spawned with the
    // worktree as cwd.

    // `skills.paths` is not workspace state either. It used to be seeded here as
    // `["teamclu-team/skills", "<home>/.agents/skills"]`:
    //
    // - `teamclu-team/skills` is workspace-*relative*, and under the v2 home
    //   layout the team share lives in `~/.amuxd/teams/<id>/shared/teamclu-team`.
    //   It resolved only through the symlink a fully-onboarded workspace happens
    //   to have; in a workspace without one it silently pointed at nothing.
    // - `<home>/.agents/skills` is the same directory for every workspace.
    //
    // Both now go into the active team's global config as absolute paths, which
    // `sync_opencode_generated` copies wholesale into `OPENCODE_CONFIG`. Stale
    // workspace copies are dropped so the relative form cannot outrank them.
    {
        let dropped = obj
            .get_mut("skills")
            .and_then(|skills| skills.as_object_mut())
            .and_then(|skills| skills.get_mut("paths"))
            .and_then(|paths| paths.as_array_mut())
            .map(|paths| {
                let before = paths.len();
                paths.retain(|value| !is_migrated_skill_path(value.as_str()));
                before != paths.len()
            })
            .unwrap_or(false);
        if dropped {
            *changed = true;
        }
        // Drop an emptied `skills` object rather than leaving `{"paths": []}`,
        // which reads as "this workspace deliberately has no skill paths".
        let empty = obj
            .get("skills")
            .and_then(|skills| skills.as_object())
            .map(|skills| {
                skills.len() <= 1
                    && skills
                        .get("paths")
                        .and_then(|paths| paths.as_array())
                        .map(|paths| paths.is_empty())
                        .unwrap_or(true)
            })
            .unwrap_or(false);
        if empty {
            obj.remove("skills");
            *changed = true;
        }
    }

    Ok(())
}

/// Skill paths that moved to the global config — the ones older builds seeded
/// into every workspace. Both the `~`-prefixed and the expanded form of the
/// agents dir count: older builds wrote either.
fn is_migrated_skill_path(path: Option<&str>) -> bool {
    let Some(path) = path else { return false };
    if path == TEAM_SKILLS_PATH || path == "~/.agents/skills" {
        return true;
    }
    dirs::home_dir()
        .map(|home| home.join(".agents").join("skills"))
        .map(|agents| path == agents.to_string_lossy())
        .unwrap_or(false)
}

/// Seed the real skill roots into the active team's global config, absolutely —
/// so no workspace has to be standing in the right place for them to resolve.
///
/// The two roots that actually receive skills, in the same order
/// `config::team_skill_roots` uses:
///
/// 1. `~/.amuxd/teams/<id>/state/cloud/skills` — what an admin assigned to this
///    hosted agent. First, so a member's private edit of the same slug cannot
///    decide what a team agent executes.
/// 2. `~/.agents/skills` — the member-side registry install dir.
///
/// Notably NOT the team share's `teamclu-team/skills`: file sync carries
/// documents only, so nothing is ever installed there (see the note on
/// `config::team_skill_roots`). The relative `teamclu-team/skills` that older
/// builds wrote into every workspace pointed at that empty directory — and only
/// resolved at all in a workspace whose team-share symlink existed.
pub fn ensure_global_skill_paths() -> Result<bool, WorkspaceControlError> {
    use teamclu_runtime_env::opencode_config::{OpencodeConfigError, OpencodeConfigStore};

    let mut wanted: Vec<String> = Vec::new();
    if let Some(team_id) = crate::config::team_mcp::onboarded_team_id() {
        wanted.push(
            crate::runtime::team_skills::team_cloud_skills_dir(&team_id)
                .to_string_lossy()
                .into_owned(),
        );
    }
    if let Some(home) = dirs::home_dir() {
        wanted.push(
            home.join(".agents")
                .join("skills")
                .to_string_lossy()
                .into_owned(),
        );
    }
    if wanted.is_empty() {
        return Ok(false);
    }

    OpencodeConfigStore::apply_global(|config| {
        let obj = config.as_object_mut().ok_or_else(|| {
            OpencodeConfigError::Parse("global opencode.json root is not an object".to_string())
        })?;
        if !obj.contains_key("$schema") {
            obj.insert(
                "$schema".to_string(),
                serde_json::json!("https://opencode.ai/config.json"),
            );
        }
        let skills = obj.entry("skills").or_insert_with(|| serde_json::json!({}));
        let skills_obj = skills.as_object_mut().ok_or_else(|| {
            OpencodeConfigError::Parse("global opencode.json skills is not an object".to_string())
        })?;
        let paths_val = skills_obj
            .entry("paths")
            .or_insert_with(|| serde_json::json!([]));
        let paths = paths_val.as_array_mut().ok_or_else(|| {
            OpencodeConfigError::Parse(
                "global opencode.json skills.paths is not an array".to_string(),
            )
        })?;
        let mut changed = false;
        for path in wanted {
            if !paths.iter().any(|v| v.as_str() == Some(path.as_str())) {
                paths.push(serde_json::json!(path));
                changed = true;
            }
        }
        Ok(changed)
    })
    .map_err(map_store_err)
}

fn remove_non_native_desktop_control_skills(skills_dir: &Path) {
    let remove_if_dir = |name: &str| {
        let path = skills_dir.join(name);
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        }
    };

    #[cfg(target_os = "macos")]
    remove_if_dir("windows-control");
    #[cfg(target_os = "windows")]
    remove_if_dir("macos-control");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        remove_if_dir("macos-control");
        remove_if_dir("windows-control");
    }
}

/// Where the skills that ship with the binary are written: `~/.agents/skills`.
///
/// Not a workspace directory, and not brand-namespaced. They used to be seeded
/// per workspace into the brand meta dir *and* `.opencode/skills` — two copies
/// per project, of which only the meta one was ever read, and neither is a
/// scanned root any more (`config::roles_skills::skill_dir_specs`). One copy in
/// the root every runtime already reads replaces both, and it is where the
/// Agent-side inventory has always looked for them
/// (`daemon::server::rpc::skill_inventory`).
fn inherent_skills_dir() -> Result<PathBuf, WorkspaceControlError> {
    let home = dirs::home_dir()
        .ok_or_else(|| WorkspaceControlError::Io("home directory not found".to_owned()))?;
    Ok(home.join(".agents/skills"))
}

fn ensure_inherent_skills_in_dir(skills_dir: &Path) -> Result<(), WorkspaceControlError> {
    std::fs::create_dir_all(skills_dir).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    remove_non_native_desktop_control_skills(skills_dir);

    for skill in inherent_skills() {
        let skill_dir = skills_dir.join(skill.dirname);
        let skill_md = skill_dir.join("SKILL.md");
        if skill_md.exists() {
            continue;
        }
        std::fs::create_dir_all(&skill_dir)
            .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
        std::fs::write(&skill_md, skill.content)
            .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    }
    Ok(())
}

fn render_instruction_plugin_template() -> String {
    let brand = teamclu_runtime_env::brand_short_name_from_env();
    INSTRUCTION_PLUGIN_TEMPLATE
        .replace(
            "__WORKSPACE_META_DIR__",
            &teamclu_runtime_env::workspace_meta_dir_name(&brand),
        )
        .replace(
            "__WORKSPACE_CONFIG_FILE__",
            &teamclu_runtime_env::workspace_config_file_name(&brand),
        )
}

fn install_instruction_plugin_file(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    use crate::runtime::workspace_runtime::INSTRUCTION_PLUGIN_REL;

    let plugin_path = workspace_path.join(INSTRUCTION_PLUGIN_REL);
    if let Some(parent) = plugin_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    }

    let rendered = render_instruction_plugin_template();
    let should_write = match std::fs::read_to_string(&plugin_path) {
        Ok(existing) => existing != rendered,
        Err(_) => true,
    };
    if should_write {
        std::fs::write(&plugin_path, rendered)
            .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    }
    Ok(())
}

fn install_session_context_plugin_file(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    use crate::runtime::workspace_runtime::{SESSION_CONTEXT_CLIENT_REL, SESSION_CONTEXT_PLUGIN_REL};

    let plugin_path = workspace_path.join(SESSION_CONTEXT_PLUGIN_REL);
    let client_path = workspace_path.join(SESSION_CONTEXT_CLIENT_REL);
    if let Some(parent) = plugin_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
    }

    let write_if_changed =
        |path: &Path, template: &str| -> Result<(), WorkspaceControlError> {
            let should_write = match std::fs::read_to_string(path) {
                Ok(existing) => existing != template,
                Err(_) => true,
            };
            if should_write {
                std::fs::write(path, template).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
            }
            Ok(())
        };

    write_if_changed(&client_path, SESSION_CONTEXT_CLIENT_TEMPLATE)?;
    write_if_changed(&plugin_path, SESSION_CONTEXT_PLUGIN_TEMPLATE)?;
    Ok(())
}

/// Install the TeamClu session-context OpenCode plugin and register it in `opencode.json`.
pub fn ensure_session_context_plugin(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    install_session_context_plugin_file(workspace_path)?;

    teamclu_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace_path, |config| {
        mutate_session_context_plugin(config).map_err(ws_to_store_err)
    })
    .map_err(map_store_err)?;
    Ok(())
}

/// Install the TeamClu instruction OpenCode plugin and register it in `opencode.json`.
pub fn ensure_instruction_plugin(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    install_instruction_plugin_file(workspace_path)?;

    teamclu_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace_path, |config| {
        mutate_instruction_plugin(config).map_err(ws_to_store_err)
    })
    .map_err(map_store_err)?;
    Ok(())
}

/// Rebuild `<workspace>/team-knowledge` on every workspace init, so a stale,
/// dangling or missing link never survives one.
///
/// Two attempts, in order. The workspace-derived one chains through this
/// workspace's own `teamclu-team` link; when THAT link is the thing that went
/// missing it can derive nothing, and the workspace was previously stuck
/// without a knowledge link until something else re-linked the team. So fall
/// back to the daemon's active team, which is where the knowledge dir lives
/// anyway.
///
/// The fallback only ever re-points at a directory that already exists: it is
/// gated on the team's synced `knowledge/` dir being there, so it cannot
/// resurrect a link for a team whose share was torn down (which would fight
/// `team_link::materialize_team_link`), and it skips app checkouts for the
/// same reason `ensure_team_link` does.
fn ensure_workspace_knowledge_link(workspace_path: &Path) {
    use crate::config::workspace_link::{
        ensure_team_knowledge_link, ensure_team_knowledge_link_from_workspace, LinkStatus,
    };

    let mut status = ensure_team_knowledge_link_from_workspace(workspace_path);
    if matches!(status, LinkStatus::Fallback) {
        let team_id = crate::config::layout::active_team();
        // Same target `ensure_team_knowledge_link` would link to.
        let knowledge_dir =
            crate::config::global_team_store::sync_content_root(&team_id).join("knowledge");
        let is_app = workspace_path
            .to_str()
            .is_some_and(crate::team_link::is_app_workspace);
        if team_id != crate::config::layout::UNCLAIMED_TEAM && !is_app && knowledge_dir.is_dir() {
            status = ensure_team_knowledge_link(workspace_path, &team_id);
        }
    }
    tracing::debug!(
        workspace = %workspace_path.display(),
        "workspace team-knowledge link: {status:?}"
    );
}

/// Prepare a workspace directory for OpenCode/ACP agent use.
pub fn prepare_workspace(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    if !workspace_path.is_dir() {
        return Err(WorkspaceControlError::WorkspaceNotFound(
            workspace_path.display().to_string(),
        ));
    }

    ensure_workspace_knowledge_link(workspace_path);

    install_instruction_plugin_file(workspace_path)?;
    install_session_context_plugin_file(workspace_path)?;
    crate::config::materialize_policy_file(workspace_path)?;
    materialize_opencode_for_prepare(workspace_path)?;
    ensure_inherent_skills_in_dir(&inherent_skills_dir()?)?;
    crate::runtime::claude_skills::ensure_claude_team_skills(workspace_path)?;

    if let Ok(Some(result)) =
        teamclu_runtime_env::opencode_db::maybe_migrate_legacy_opencode_db(workspace_path)
    {
        if result.migrated {
            tracing::info!(workspace = %workspace_path.display(), "migrated legacy isolated OpenCode DB to global");
        }
    }

    info!(workspace = %workspace_path.display(), "workspace runtime prepared");
    Ok(())
}

fn binary_available(cfg: &AgentLaunchConfig) -> bool {
    let path = Path::new(&cfg.binary);
    if path.is_absolute() && path.exists() {
        return true;
    }
    std::process::Command::new("sh")
        .no_window()
        .arg("-lc")
        .arg(format!("command -v {}", shell_escape(&cfg.binary)))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn shell_escape(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-:".contains(c))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn backend_label(agent_type: amux::AgentType) -> &'static str {
    match agent_type {
        amux::AgentType::Opencode => "opencode",
        amux::AgentType::ClaudeCode => "claude-code",
        amux::AgentType::Codex => "codex",
        amux::AgentType::Pi => "pi",
        amux::AgentType::Cursor => "cursor",
        _ => "unknown",
    }
}

/// Whether the configured backend can actually be launched.
///
/// [`binary_available`] alone only answers this for backends whose
/// `AgentLaunchConfig.binary` really is an executable on PATH. It is wrong for
/// the other two:
///
/// - **pi** declares the literal `"pi"`, but `pi_rpc::resolve_binary` also
///   accepts `~/.pi/bin/pi`, which `command -v pi` does not see.
/// - **cursor** declares `"cursor-bridge"`, which is not an executable at all —
///   the backend runs `node <daemon>/cursor-bridge/src/main.mjs`.
///
/// So both reported "not available" on machines where they run perfectly well,
/// which failed the model-catalog probe before it could reach the backend.
fn backend_launchable(agent_type: amux::AgentType, cfg: &AgentLaunchConfig) -> bool {
    match agent_type {
        amux::AgentType::Pi => {
            let resolved = crate::runtime::pi_rpc::process::resolve_binary(None);
            binary_available(&AgentLaunchConfig::new(resolved, Vec::new(), "pi"))
        }
        amux::AgentType::Cursor => {
            let cmd = crate::runtime::cursor_sdk::process::default_bridge_command();
            let node_ok = cmd
                .first()
                .map(|bin| {
                    binary_available(&AgentLaunchConfig::new(bin.clone(), Vec::new(), "cursor"))
                })
                .unwrap_or(false);
            node_ok && crate::runtime::cursor_sdk::process::default_bridge_main().exists()
        }
        _ => binary_available(cfg),
    }
}

pub async fn prewarm_workspace_domains(
    pool: Arc<crate::runtime::opencode_http::host_pool::OpenCodeHostPool>,
    workspaces: Vec<(String, std::collections::HashMap<String, String>)>,
) {
    for (workspace_id, env) in workspaces.into_iter().take(2) {
        let domain =
            crate::runtime::execution_context::IsolationDomainKey::Workspace(workspace_id.clone());
        let revision = crate::runtime::execution_context::ProcessEnvRevision::from_bindings(&env);
        if let Err(error) = pool
            .acquire(
                domain,
                revision,
                env,
                std::time::Instant::now() + Duration::from_secs(30),
            )
            .await
        {
            warn!(workspace_id, %error, "workspace host prewarm failed");
        }
    }
}

pub struct RuntimeSupervisor {
    agents: Arc<AsyncMutex<RuntimeManager>>,
    refresh: Arc<RuntimeRefreshCoordinator>,
    host_pool: Option<Arc<crate::runtime::opencode_http::host_pool::OpenCodeHostPool>>,
    context_resolver: Option<Arc<dyn crate::opencode_settings::WorkspaceSettingsContextResolver>>,
    /// When set, `reload_workspace` reports each provider-host evict as
    /// `(workspace_id, workspace_path)` so the daemon can re-prewarm the
    /// evicted hosts off the critical path. Without this, the first session
    /// after a provider/env change always paid the full cold start.
    prewarm_notify: parking_lot::Mutex<Option<tokio::sync::mpsc::Sender<(String, String)>>>,
}

impl RuntimeSupervisor {
    pub fn new(agents: Arc<AsyncMutex<RuntimeManager>>) -> Arc<Self> {
        Arc::new(Self {
            agents,
            refresh: RuntimeRefreshCoordinator::new(),
            host_pool: None,
            context_resolver: None,
            prewarm_notify: parking_lot::Mutex::new(None),
        })
    }

    pub fn new_with_host_pool(
        agents: Arc<AsyncMutex<RuntimeManager>>,
        host_pool: Arc<crate::runtime::opencode_http::host_pool::OpenCodeHostPool>,
    ) -> Arc<Self> {
        Arc::new(Self {
            agents,
            refresh: RuntimeRefreshCoordinator::new(),
            host_pool: Some(host_pool),
            context_resolver: None,
            prewarm_notify: parking_lot::Mutex::new(None),
        })
    }

    pub fn new_with_workspace_services(
        agents: Arc<AsyncMutex<RuntimeManager>>,
        host_pool: Arc<crate::runtime::opencode_http::host_pool::OpenCodeHostPool>,
        context_resolver: Arc<dyn crate::opencode_settings::WorkspaceSettingsContextResolver>,
    ) -> Arc<Self> {
        Arc::new(Self {
            agents,
            refresh: RuntimeRefreshCoordinator::new(),
            host_pool: Some(host_pool),
            context_resolver: Some(context_resolver),
            prewarm_notify: parking_lot::Mutex::new(None),
        })
    }

    pub async fn request_workspace_host_refresh(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> usize {
        let Some(pool) = self.host_pool.as_ref() else {
            // No pooled opencode host, but the active backend may still key
            // children by isolation domain (pi does): route the refresh
            // through the backend trait so a workspace env/config change
            // respawns that workspace's child instead of leaking the old env
            // into it — while other workspaces' children keep running.
            let mut agents = self.agents.lock().await;
            let stopped = agents
                .stop_idle_runtimes_for_workspace(&workspace_path.to_string_lossy(), workspace_id)
                .await;
            agents.request_workspace_host_refresh(workspace_id).await;
            return stopped;
        };
        let stopped = self
            .agents
            .lock()
            .await
            .stop_idle_runtimes_for_workspace(&workspace_path.to_string_lossy(), workspace_id)
            .await;
        pool.invalidate_domain(
            &crate::runtime::execution_context::IsolationDomainKey::Workspace(
                workspace_id.to_string(),
            ),
        );
        if stopped > 0 {
            info!(
                workspace_id,
                workspace = %workspace_path.display(),
                stopped,
                "detached idle workspace runtimes before pooled host refresh"
            );
        }
        stopped
    }

    pub fn request_all_workspace_host_refreshes(&self) -> usize {
        self.host_pool
            .as_ref()
            .map_or(0, |pool| pool.invalidate_all_domains())
    }

    /// Install the channel that receives `(workspace_id, path)` whenever a
    /// reload evicted the pooled provider hosts (see `prewarm_notify`).
    pub fn set_prewarm_notifier(&self, tx: tokio::sync::mpsc::Sender<(String, String)>) {
        *self.prewarm_notify.lock() = Some(tx);
    }

    pub fn refresh_coordinator(&self) -> Arc<RuntimeRefreshCoordinator> {
        Arc::clone(&self.refresh)
    }

    pub fn start_refresh_auto_applier(self: Arc<Self>) -> JoinHandle<()> {
        self.start_refresh_auto_applier_with_interval(Duration::from_secs(1))
    }

    pub fn start_refresh_auto_applier_with_interval(
        self: Arc<Self>,
        interval: Duration,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                self.auto_apply_pending_refreshes().await;
            }
        })
    }

    /// Probe the configured local backend for its live model catalog.
    ///
    /// Dispatches through the backend trait, so opencode reaches `serve.ensure()`
    /// and `/config/providers`, pi reaches `get_available_models`, and cursor and
    /// claude-code reach `list_models` — each spawning a child if none is live.
    /// There is no static fallback — an unavailable binary is an error, not a
    /// phantom list.
    ///
    /// This used to claim claude-code "returns its static table". It never had
    /// one: the claude bridge answers `list_models` off a live query, and with
    /// no session it used to answer `[]`. Believing the comment is how switching
    /// the local agent to claude-code ended up with a permanently empty picker —
    /// the probe tier looked covered, so nothing else was. The bridge now starts
    /// a session to answer, which is what makes this dispatch meaningful.
    pub async fn probe_catalog_models(
        &self,
        workspace_path: &Path,
    ) -> Result<Vec<amux::ModelInfo>, String> {
        let context = match self.context_resolver.as_ref() {
            Some(resolver) => Some(
                resolver
                    .resolve_settings_context(workspace_path)
                    .await
                    .map_err(|error| format!("workspace catalog context: {error}"))?,
            ),
            None => None,
        };
        let mut manager = self.agents.lock().await;
        let agent_type = manager.default_agent_type();
        let launch = manager.launch_config_for(agent_type);
        if !backend_launchable(agent_type, &launch) {
            return Err(format!(
                "{} binary not available",
                backend_label(agent_type)
            ));
        }
        if let Some(context) = context {
            manager
                .probe_catalog_models_with_context(context)
                .await
                .map_err(|e| e.to_string())
        } else {
            manager
                .probe_catalog_models(workspace_path)
                .await
                .map_err(|e| e.to_string())
        }
    }

    /// This device's last-known catalog for `workspace_path` under the
    /// configured backend, as persisted by `config::model_catalog`.
    ///
    /// The MQTT path already falls back to this via `RuntimeManager::fill_catalog`;
    /// the HTTP catalog endpoint needs the same fallback so a slow or failed
    /// live probe serves the last-known list instead of nothing. pi and cursor
    /// have no provider-file fallback of their own, so for them this is the only
    /// thing standing between a cold probe and a permanently empty picker.
    pub async fn cached_catalog_models(&self, workspace_path: &Path) -> Vec<amux::ModelInfo> {
        self.agents
            .lock()
            .await
            .catalog_for_worktree(&workspace_path.to_string_lossy())
    }

    /// Backend id for the configured local agent (`"opencode"` / `"pi"` /
    /// `"cursor"` / `"claude"`).
    pub async fn local_backend_type(&self) -> &'static str {
        self.agents.lock().await.local_backend_type()
    }

    pub async fn runtime_status(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Result<RuntimeStatus, WorkspaceControlError> {
        // NOTE: status reads must be side-effect free. Workspace bootstrap
        // (writing opencode.json defaults, syncing skill dirs) happens at
        // runtime start (`runtime_adapter` spawn) and on explicit
        // `reload_workspace`, not here - otherwise polling this GET endpoint
        // would silently rewrite config and delete/recreate skill dirs.
        let manager = self.agents.lock().await;
        let agent_type = manager.default_agent_type();
        let backend = backend_label(agent_type).to_owned();
        let launch = manager.launch_config_for(agent_type);
        let backend_ready = backend_launchable(agent_type, &launch);

        let workspace_path_str = workspace_path.to_string_lossy();
        let active: Vec<_> = manager
            .active_handles_for_workspace(&workspace_path_str, workspace_id)
            .collect();

        let current_model = active
            .iter()
            .find_map(|(agent_id, _)| manager.current_model(agent_id).cloned());

        Ok(RuntimeStatus {
            workspace_id: workspace_id.to_owned(),
            ready: backend_ready,
            backend,
            current_model,
            refresh: self
                .refresh
                .runtime_refresh_dto_for_path(workspace_id, workspace_path)
                .await,
        })
    }

    /// Diagnostics for env-var activation: storage readable, daemon runtime state,
    /// and human-readable blockers. Contains no secret values.
    pub async fn env_activation_diagnostics(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        team_id: Option<&str>,
    ) -> EnvActivationDiagnostics {
        let store = teamclu_runtime_env::diagnose_personal_env_store();
        let personal_env_result = teamclu_runtime_env::personal_secrets::load_personal_env();
        let loaded_user_count = personal_env_result
            .as_ref()
            .map(teamclu_runtime_env::count_user_personal_env_keys)
            .unwrap_or(0);
        let personal_blob_user_var_count = store.user_stored_var_count;
        let personal_env_var_count = if loaded_user_count > 0 {
            loaded_user_count
        } else if store.blob_readable {
            personal_blob_user_var_count
        } else {
            0
        };
        let personal_env = personal_env_result.as_ref().cloned().unwrap_or_default();
        let personal_load_error = personal_env_result.err().map(|e| e.to_string());

        let team_env =
            crate::team_shared_env::load_team_env_for_workspace_detailed(workspace_path, team_id);

        let workspace_path_str = workspace_path.to_string_lossy();
        let (
            active_runtime_count,
            workspace_has_active_turn,
            opencode_serve_running,
            cached_env_count,
            served_env_keys,
            active_env_fingerprint,
            active_snapshot,
        ) = {
            let manager = self.agents.lock().await;
            let active_runtime_count = manager
                .active_handles_for_workspace(&workspace_path_str, workspace_id)
                .count();
            let workspace_has_active_turn =
                manager.workspace_has_active_turn(&workspace_path_str, workspace_id);
            let active_snapshot = manager
                .workspace_env_snapshot(&workspace_path_str, workspace_id)
                .map(|(snapshot, _)| snapshot);
            let domain = crate::runtime::execution_context::IsolationDomainKey::Workspace(
                workspace_id.to_string(),
            );
            let serve_stats = self
                .host_pool
                .as_ref()
                .and_then(|pool| pool.current_generation(&domain))
                .map(|generation| {
                    (
                        generation.serve.is_running(),
                        generation.serve.cached_env_key_count(),
                        generation.serve.cached_env_keys(),
                        generation.serve.active_env_fingerprint(),
                    )
                })
                .unwrap_or((false, 0, Vec::new(), None));
            (
                active_runtime_count,
                workspace_has_active_turn,
                serve_stats.0,
                serve_stats.1,
                serve_stats.2,
                serve_stats.3,
                active_snapshot,
            )
        };
        let active_handle_env_fingerprint = active_snapshot
            .as_ref()
            .map(|snapshot| snapshot.fingerprint.clone());

        let system_ctx = active_snapshot
            .as_ref()
            .map(|snapshot| teamclu_runtime_env::SystemEnvContext {
                actor_id: snapshot
                    .bindings
                    .get("actor_id")
                    .cloned()
                    .unwrap_or_default(),
                display_name: snapshot
                    .bindings
                    .get("display_name")
                    .cloned()
                    .unwrap_or_default(),
                cloud_token_file: snapshot.bindings.get("TC_ACCESS_TOKEN_FILE").cloned(),
                gateway_token: None,
            })
            .unwrap_or(teamclu_runtime_env::SystemEnvContext {
                actor_id: String::new(),
                display_name: String::new(),
                cloud_token_file: None,
                gateway_token: None,
            });
        let resolved = teamclu_runtime_env::resolve_runtime_env(
            personal_env.clone(),
            team_env.values.clone(),
            system_ctx,
        );
        let host_env_shadowed_keys =
            teamclu_runtime_env::host_shadowed_env_keys(&resolved.bindings);
        let mut override_keys: Vec<String> = resolved
            .overrides
            .iter()
            .filter(|entry| entry.kind == teamclu_runtime_env::EnvOverrideKind::Layer)
            .map(|entry| entry.key.clone())
            .chain(team_env.overridden_keys.iter().cloned())
            .collect();
        override_keys.sort();
        override_keys.dedup();
        let mut alias_collision_keys: Vec<String> = resolved
            .overrides
            .iter()
            .filter(|entry| entry.kind == teamclu_runtime_env::EnvOverrideKind::AliasCollision)
            .map(|entry| entry.key.clone())
            .collect();
        alias_collision_keys.sort();
        alias_collision_keys.dedup();
        let mut unresolved_env_keys = team_env.unresolved_keys.clone();
        unresolved_env_keys.extend(resolved.unresolved.iter().map(|entry| entry.key.clone()));
        unresolved_env_keys.sort();
        unresolved_env_keys.dedup();
        let resolved_env_fingerprint = Some(resolved.fingerprint.clone());

        if let Some(snapshot) = active_snapshot.as_ref() {
            override_keys.extend(
                snapshot
                    .overrides
                    .iter()
                    .filter(|entry| entry.kind == teamclu_runtime_env::EnvOverrideKind::Layer)
                    .map(|entry| entry.key.clone()),
            );
            alias_collision_keys.extend(
                snapshot
                    .overrides
                    .iter()
                    .filter(|entry| {
                        entry.kind == teamclu_runtime_env::EnvOverrideKind::AliasCollision
                    })
                    .map(|entry| entry.key.clone()),
            );
            override_keys.sort();
            override_keys.dedup();
            alias_collision_keys.sort();
            alias_collision_keys.dedup();
        }
        let system_env_var_count = active_snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .provenance
                    .iter()
                    .filter(|entry| {
                        entry.scope == teamclu_runtime_env::EnvScope::System
                            && entry.alias_of.is_none()
                    })
                    .count()
            })
            .unwrap_or(0);

        let refresh = self
            .refresh
            .runtime_refresh_dto_for_path(workspace_id, workspace_path)
            .await;
        let mut blockers: Vec<EnvActivationBlocker> = Vec::new();

        if !store.blob_readable {
            blockers.push(EnvActivationBlocker {
                code: if store.blob_exists {
                    "personal_blob_undecryptable".to_string()
                } else if store.master_key_exists {
                    "personal_blob_missing".to_string()
                } else {
                    "personal_store_uninitialized".to_string()
                },
                detail: if store.blob_exists {
                    store.blob_error.clone()
                } else {
                    None
                },
            });
        }
        if refresh.status == "failed" {
            blockers.push(EnvActivationBlocker {
                code: "refresh_failed".to_string(),
                detail: refresh.last_error.clone(),
            });
        } else if refresh.status == "pending" || refresh.status == "applying" {
            if refresh.change_kinds.iter().any(|k| k == "env_vars") {
                blockers.push(EnvActivationBlocker {
                    code: "env_vars_pending".to_string(),
                    detail: None,
                });
            }
        }
        if refresh.auto_apply_blocked_by_active_runtime {
            blockers.push(EnvActivationBlocker {
                code: "refresh_deferred_active_turn".to_string(),
                detail: None,
            });
        }
        if active_runtime_count > 0 {
            blockers.push(EnvActivationBlocker {
                code: "active_runtimes".to_string(),
                detail: Some(active_runtime_count.to_string()),
            });
        }
        if workspace_has_active_turn {
            blockers.push(EnvActivationBlocker {
                code: "turn_in_progress".to_string(),
                detail: None,
            });
        }
        if opencode_serve_running
            && cached_env_count == 0
            && (personal_env_var_count > 0 || !team_env.values.is_empty())
        {
            blockers.push(EnvActivationBlocker {
                code: "opencode_serve_no_cached_env".to_string(),
                detail: None,
            });
        }
        if !host_env_shadowed_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "host_env_shadowed".to_string(),
                detail: Some(host_env_shadowed_keys.join(", ")),
            });
        }
        if !unresolved_env_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "unresolved_env_keys".to_string(),
                detail: Some(unresolved_env_keys.join(", ")),
            });
        }
        if !alias_collision_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "alias_collision".to_string(),
                detail: Some(alias_collision_keys.join(", ")),
            });
        }
        if !override_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "env_layer_override".to_string(),
                detail: Some(override_keys.join(", ")),
            });
        }
        let activation_status =
            if resolved_env_fingerprint.as_deref() == active_env_fingerprint.as_deref() {
                "active"
            } else {
                "pending"
            }
            .to_string();
        if activation_status == "pending" {
            blockers.push(EnvActivationBlocker {
                code: "env_snapshot_pending".to_string(),
                detail: None,
            });
        }

        let brand = teamclu_runtime_env::brand_short_name_from_env();
        let team_secret_configured = teamclu_runtime_env::env_catalog::resolve_team_env_secret(
            workspace_path,
            team_id,
            Some(brand.as_str()),
        )
        .is_some();
        let team_secret_files_present = !team_env.source_paths.is_empty()
            || !team_env.unresolved_keys.is_empty()
            || !team_env.values.is_empty();
        if team_secret_files_present && !team_secret_configured {
            blockers.push(EnvActivationBlocker {
                code: "team_secret_missing".to_string(),
                detail: None,
            });
        }

        let activation_status_for_analysis = activation_status.as_str();
        let active_snapshot_ref = active_snapshot.as_ref();
        let mut analysis =
            teamclu_runtime_env::analyze_env_activation(&teamclu_runtime_env::EnvActivationInput {
                personal_env: &personal_env,
                team_env: &team_env.values,
                resolved: &resolved,
                unresolved_keys: &unresolved_env_keys,
                override_keys: &override_keys,
                host_shadowed_keys: &host_env_shadowed_keys,
                activation_status: activation_status_for_analysis,
                active_runtime_count,
                active_snapshot: active_snapshot_ref,
                served_env_keys: &served_env_keys,
                opencode_serve_running,
            });
        analysis.mcp_unresolved_placeholders =
            teamclu_runtime_env::find_unresolved_config_placeholders(
                workspace_path,
                &resolved.bindings,
            );
        if !analysis.mcp_unresolved_placeholders.is_empty() {
            let keys: Vec<String> = analysis
                .mcp_unresolved_placeholders
                .iter()
                .map(|entry| entry.key.clone())
                .collect();
            blockers.push(EnvActivationBlocker {
                code: "mcp_placeholder_unresolved".to_string(),
                detail: Some(keys.join(", ")),
            });
        }
        if !analysis.missing_expected_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "missing_expected_env_keys".to_string(),
                detail: Some(analysis.missing_expected_keys.join(", ")),
            });
        }
        if !analysis.missing_served_env_keys.is_empty() {
            blockers.push(EnvActivationBlocker {
                code: "env_not_served".to_string(),
                detail: Some(analysis.missing_served_env_keys.join(", ")),
            });
        }

        EnvActivationDiagnostics {
            personal_env_var_count,
            personal_blob_user_var_count,
            personal_blob_readable: store.blob_readable,
            personal_load_error,
            team_env_var_count: team_env.values.len(),
            system_env_var_count,
            opencode_serve_running,
            opencode_serve_cached_env_count: cached_env_count,
            active_runtime_count,
            workspace_has_active_turn,
            refresh,
            host_pool: self
                .host_pool
                .as_ref()
                .map(|pool| {
                    pool.stats_for(
                        &crate::runtime::execution_context::IsolationDomainKey::Workspace(
                            workspace_id.to_string(),
                        ),
                    )
                })
                .unwrap_or_default(),
            host_env_shadowed_keys,
            resolved_env_fingerprint,
            override_keys,
            alias_collision_keys,
            unresolved_env_keys,
            activation_status,
            blockers,
            expected_env_keys: analysis.expected_env_keys,
            effective_env_keys: analysis.effective_env_keys,
            missing_expected_keys: analysis.missing_expected_keys,
            key_statuses: analysis.key_statuses,
            mcp_unresolved_placeholders: analysis.mcp_unresolved_placeholders,
            active_handle_env_fingerprint,
            team_secret_configured,
            opencode_serve_cached_env_keys: analysis.served_env_keys,
            missing_served_env_keys: analysis.missing_served_env_keys,
            active_handle_env_keys: analysis.active_handle_env_keys,
        }
    }

    pub async fn reload_workspace(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        evict_provider_hosts: bool,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let workspace_path_str = workspace_path.to_string_lossy();
        let busy = {
            let manager = self.agents.lock().await;
            manager.workspace_has_active_turn(&workspace_path_str, workspace_id)
        };
        if busy {
            return Err(WorkspaceControlError::ActiveTurn(workspace_id.to_owned()));
        }

        self.refresh.suppress_workspace_watch(
            workspace_id,
            &INTERNAL_PREPARE_KINDS,
            INTERNAL_WRITE_SUPPRESS,
        );
        prepare_workspace(workspace_path)?;

        let stopped = if self.host_pool.is_some() {
            if evict_provider_hosts {
                self.request_workspace_host_refresh(workspace_id, workspace_path)
                    .await
            } else {
                0
            }
        } else {
            let mut manager = self.agents.lock().await;
            let stopped = manager
                .stop_runtimes_for_workspace(&workspace_path_str, workspace_id)
                .await;
            if evict_provider_hosts {
                manager.evict_acp_hosts_after_provider_auth_change().await;
            }
            stopped
        };

        // Re-prewarm the just-evicted hosts in the background so the next
        // session doesn't pay the full cold start. Best-effort: dropped when no
        // notifier is installed (tests) or the queue is full.
        if evict_provider_hosts {
            if let Some(tx) = self.prewarm_notify.lock().clone() {
                let _ = tx.try_send((
                    workspace_id.to_string(),
                    workspace_path.to_string_lossy().into_owned(),
                ));
            }
        }

        if stopped > 0 {
            info!(
                workspace = %workspace_path.display(),
                stopped,
                "stopped workspace runtimes for reload"
            );
            Ok(ApplyOutcome::RestartRequired)
        } else {
            Ok(ApplyOutcome::ReloadRequired)
        }
    }

    pub async fn apply_refresh(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        evict_provider_hosts: bool,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        self.refresh.suppress_workspace_watch(
            workspace_id,
            &INTERNAL_PREPARE_KINDS,
            APPLY_REFRESH_SUPPRESS,
        );
        let attempt = self
            .refresh
            .mark_applying(workspace_id, workspace_path)
            .await;
        match self
            .reload_workspace(workspace_id, workspace_path, evict_provider_hosts)
            .await
        {
            Ok(outcome) => {
                self.refresh.clear_applied(workspace_id, attempt).await;
                Ok(outcome)
            }
            Err(err) => {
                self.refresh
                    .mark_apply_failed(workspace_id, workspace_path, attempt, err.to_string())
                    .await;
                Err(err)
            }
        }
    }

    pub async fn auto_apply_pending_refreshes(&self) -> usize {
        let pending = self.refresh.pending_workspace_states().await;
        let mut applied = 0usize;
        for state in pending {
            if self.auto_apply_pending_refresh_state(state).await {
                applied += 1;
            }
        }
        applied
    }

    async fn env_snapshot_unchanged(&self, workspace_id: &str, workspace_path: &Path) -> bool {
        let workspace_path_str = workspace_path.to_string_lossy();
        let previous = {
            let manager = self.agents.lock().await;
            manager.workspace_env_snapshot(&workspace_path_str, workspace_id)
        };
        let Some((previous, team_id)) = previous else {
            return false;
        };
        let Ok(personal) = teamclu_runtime_env::personal_secrets::load_personal_env() else {
            return false;
        };
        let team =
            crate::team_shared_env::load_team_env_for_workspace(workspace_path, team_id.as_deref());
        let current = teamclu_runtime_env::resolve_runtime_env(
            personal,
            team,
            teamclu_runtime_env::SystemEnvContext {
                actor_id: previous
                    .bindings
                    .get("actor_id")
                    .cloned()
                    .unwrap_or_default(),
                display_name: previous
                    .bindings
                    .get("display_name")
                    .cloned()
                    .unwrap_or_default(),
                cloud_token_file: previous.bindings.get("TC_ACCESS_TOKEN_FILE").cloned(),
                gateway_token: None,
            },
        );
        current.fingerprint == previous.fingerprint
    }

    async fn auto_apply_pending_refresh_state(&self, state: WorkspaceRefreshState) -> bool {
        if !auto_applicable_refresh(&state) {
            self.refresh
                .set_auto_apply_blocked_by_active_runtime(&state.workspace_id, false)
                .await;
            return false;
        }

        let workspace_path = PathBuf::from(&state.workspace_path);
        let env_only = state
            .change_kinds
            .iter()
            .all(|kind| matches!(kind, RefreshChangeKind::EnvVars));
        if env_only
            && self
                .env_snapshot_unchanged(&state.workspace_id, &workspace_path)
                .await
        {
            let attempt = self
                .refresh
                .mark_applying(&state.workspace_id, &workspace_path)
                .await;
            self.refresh
                .set_auto_apply_blocked_by_active_runtime(&state.workspace_id, false)
                .await;
            self.refresh
                .clear_applied(&state.workspace_id, attempt)
                .await;
            info!(
                workspace_id = %state.workspace_id,
                workspace_path = %state.workspace_path,
                "cleared env refresh because the resolved fingerprint is unchanged"
            );
            return true;
        }
        let busy = {
            let manager = self.agents.lock().await;
            manager.workspace_has_active_turn(&state.workspace_path, &state.workspace_id)
        };
        if busy {
            self.refresh
                .set_auto_apply_blocked_by_active_runtime(&state.workspace_id, true)
                .await;
            info!(
                workspace_id = %state.workspace_id,
                workspace_path = %state.workspace_path,
                change_kinds = ?state.change_kinds,
                "deferred runtime refresh auto-apply because workspace has active turn"
            );
            return false;
        }

        self.refresh
            .set_auto_apply_blocked_by_active_runtime(&state.workspace_id, false)
            .await;
        let evict_provider_hosts = state
            .change_kinds
            .iter()
            .any(|kind| kind.requires_provider_host_evict());
        match self
            .apply_refresh(&state.workspace_id, &workspace_path, evict_provider_hosts)
            .await
        {
            Ok(outcome) => {
                info!(
                    workspace_id = %state.workspace_id,
                    workspace_path = %state.workspace_path,
                    change_kinds = ?state.change_kinds,
                    outcome = ?outcome,
                    "auto-applied pending runtime refresh"
                );
                true
            }
            Err(error) => {
                warn!(
                    workspace_id = %state.workspace_id,
                    workspace_path = %state.workspace_path,
                    change_kinds = ?state.change_kinds,
                    error = %error,
                    "failed to auto-apply pending runtime refresh"
                );
                false
            }
        }
    }
}

fn auto_applicable_refresh(_state: &WorkspaceRefreshState) -> bool {
    // Capability config changes activate on the next runtime start; nothing
    // pending in the coordinator should trigger reload/stop via the scheduler.
    false
}

#[cfg(test)]
mod inherent_mcp_tests {
    use super::*;

    fn inherent_mcp_map(
        config: &mut serde_json::Value,
    ) -> serde_json::Map<String, serde_json::Value> {
        let dir = tempfile::tempdir().unwrap();
        mutate_inherent_mcp(dir.path(), config).unwrap();
        config
            .get("mcp")
            .and_then(|m| m.as_object())
            .cloned()
            .unwrap_or_default()
    }

    // Device-level servers are no longer written per workspace — the send bridge,
    // the npx bridges and their argv now live once in `~/.amuxd/mcp.json`
    // (`config::device_mcp`, which owns the tests for their contents).
    #[test]
    fn device_scoped_servers_are_not_written_into_a_workspace() {
        let mut config = serde_json::json!({});
        let mcp = inherent_mcp_map(&mut config);
        for name in crate::config::device_mcp::DEVICE_MCP_NAMES {
            assert!(!mcp.contains_key(*name), "{name} leaked into the workspace");
        }
    }

    #[test]
    fn a_device_scoped_copy_left_by_an_older_build_is_removed() {
        // The copy outranks the device file, so leaving it pins this workspace to
        // whatever binary path was current the day it was written — after a
        // reinstall, a path that no longer exists.
        let mut config = serde_json::json!({
            "mcp": {
                "amuxd-send": { "type": "local", "enabled": true, "command": ["/old/amuxd", "mcp-server"] },
                "chrome-control": { "type": "local", "enabled": true, "command": ["npx", "chrome"] },
                // Introspect copies additionally pin `--workspace` to whichever
                // workspace happened to write them.
                "teamclu-introspect": { "type": "local", "enabled": true, "command": [
                    "/old/bundle/teamclu-introspect", "--workspace", "/some/other/repo"
                ] }
            }
        });
        let mcp = inherent_mcp_map(&mut config);
        assert!(!mcp.contains_key("amuxd-send"));
        assert!(!mcp.contains_key("chrome-control"));
        assert!(!mcp.contains_key("teamclu-introspect"));
    }

    #[test]
    fn rewriting_an_existing_config_keeps_user_servers() {
        let mut config = serde_json::json!({
            "mcp": { "ctx7": { "type": "local", "enabled": true, "command": ["npx", "ctx7"] } }
        });
        let mcp = inherent_mcp_map(&mut config);
        assert!(mcp.contains_key("ctx7"), "user server survived");
        // Auto-injecting remote-tools is paused — it is stripped instead.
        assert!(!mcp.contains_key(REMOTE_TOOLS_MCP_SERVER_NAME));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
    use crate::runtime::opencode_http::host_pool::{
        GenerationFactory, HostGeneration, OpenCodeHostPool,
    };
    use crate::runtime::opencode_http::process_registry::ServeProcessRegistry;
    use crate::runtime::opencode_http::supervisor::{ServeSupervisor, ShutdownOutcome};
    use crate::runtime::refresh::{self, refresh_watch};
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct ServiceFactory {
        starts: AtomicUsize,
    }

    #[async_trait]
    impl GenerationFactory for ServiceFactory {
        async fn start(
            &self,
            generation_id: String,
            _domain: IsolationDomainKey,
            revision: ProcessEnvRevision,
            env: HashMap<String, String>,
        ) -> Result<Arc<ServeSupervisor>, String> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(ServeSupervisor::new(
                generation_id,
                Arc::new(ServeProcessRegistry::new(
                    tempfile::tempdir().unwrap().keep().join("pgids.json"),
                )),
                env,
                revision,
            )))
        }

        fn stop(&self, _generation: &HostGeneration) -> ShutdownOutcome {
            ShutdownOutcome::Stopped
        }
    }

    fn service_pool() -> (Arc<OpenCodeHostPool>, Arc<ServiceFactory>) {
        let factory = Arc::new(ServiceFactory {
            starts: AtomicUsize::new(0),
        });
        (OpenCodeHostPool::new(factory.clone()), factory)
    }

    async fn seed_domain(
        pool: &Arc<OpenCodeHostPool>,
        workspace_id: &str,
        env_value: &str,
    ) -> (
        ProcessEnvRevision,
        crate::runtime::opencode_http::host_pool::HostLease,
    ) {
        let env = HashMap::from([("SENTINEL".to_string(), env_value.to_string())]);
        let revision = ProcessEnvRevision::from_bindings(&env);
        let lease = pool
            .acquire(
                IsolationDomainKey::Workspace(workspace_id.to_string()),
                revision.clone(),
                env,
                std::time::Instant::now() + std::time::Duration::from_secs(1),
            )
            .await
            .unwrap();
        (revision, lease)
    }

    #[tokio::test]
    async fn workspace_provider_refresh_rolls_only_selected_domain() {
        let (pool, factory) = service_pool();
        let (revision_a, lease_a) = seed_domain(&pool, "ws-a", "a").await;
        let (revision_b, lease_b) = seed_domain(&pool, "ws-b", "b").await;
        let manager = Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        )));
        let supervisor = RuntimeSupervisor::new_with_host_pool(manager, pool.clone());

        supervisor
            .request_workspace_host_refresh("ws-a", Path::new("/tmp/ws-a"))
            .await;
        let replacement_a = pool
            .acquire(
                IsolationDomainKey::Workspace("ws-a".into()),
                revision_a,
                HashMap::from([("SENTINEL".into(), "a".into())]),
                std::time::Instant::now() + std::time::Duration::from_secs(1),
            )
            .await
            .unwrap();
        let reused_b = pool
            .acquire(
                IsolationDomainKey::Workspace("ws-b".into()),
                revision_b,
                HashMap::from([("SENTINEL".into(), "b".into())]),
                std::time::Instant::now() + std::time::Duration::from_secs(1),
            )
            .await
            .unwrap();

        assert_ne!(
            replacement_a.generation.generation_id,
            lease_a.generation.generation_id
        );
        assert_eq!(
            reused_b.generation.generation_id,
            lease_b.generation.generation_id
        );
        assert_eq!(factory.starts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn device_provider_auth_rolls_every_domain_without_killing_active_routes() {
        let (pool, factory) = service_pool();
        let (revision_a, lease_a) = seed_domain(&pool, "ws-a", "a").await;
        let (revision_b, lease_b) = seed_domain(&pool, "ws-b", "b").await;
        let manager = Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        )));
        let supervisor = RuntimeSupervisor::new_with_host_pool(manager, pool.clone());

        assert_eq!(supervisor.request_all_workspace_host_refreshes(), 2);
        let replacement_a = pool
            .acquire(
                IsolationDomainKey::Workspace("ws-a".into()),
                revision_a,
                HashMap::from([("SENTINEL".into(), "a".into())]),
                std::time::Instant::now() + std::time::Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert_eq!(
            lease_a.generation.lifecycle(),
            crate::runtime::opencode_http::host_pool::HostLifecycle::Draining
        );
        drop(lease_a);
        let replacement_b = pool
            .acquire(
                IsolationDomainKey::Workspace("ws-b".into()),
                revision_b,
                HashMap::from([("SENTINEL".into(), "b".into())]),
                std::time::Instant::now() + std::time::Duration::from_secs(1),
            )
            .await
            .unwrap();

        assert_eq!(factory.starts.load(Ordering::SeqCst), 4);
        assert_eq!(
            lease_b.generation.lifecycle(),
            crate::runtime::opencode_http::host_pool::HostLifecycle::Draining
        );
        assert_eq!(replacement_a.generation.route_count(), 1);
        assert_eq!(replacement_b.generation.route_count(), 1);
    }

    #[tokio::test]
    async fn provider_refresh_does_not_stop_active_workspace_routes() {
        let (pool, _factory) = service_pool();
        let workspace_a = tempfile::tempdir().unwrap();
        let workspace_b = tempfile::tempdir().unwrap();
        let path_a = workspace_a.path().to_string_lossy().into_owned();
        let path_b = workspace_b.path().to_string_lossy().into_owned();
        let manager = Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        )));
        {
            let mut manager = manager.lock().await;
            manager.add_test_workspace_runtime("rt-a", &path_a, "ws-a", amux::AgentStatus::Active);
            manager.add_test_workspace_runtime("rt-b", &path_b, "ws-b", amux::AgentStatus::Active);
        }
        let supervisor = RuntimeSupervisor::new_with_host_pool(manager.clone(), pool);

        let err = supervisor
            .reload_workspace("ws-a", workspace_a.path(), true)
            .await
            .expect_err("reload must reject while workspace has an active turn");
        assert!(matches!(
            err,
            WorkspaceControlError::ActiveTurn(ref id) if id == "ws-a"
        ));

        let manager = manager.lock().await;
        let ids = manager.agent_ids();
        assert!(ids.iter().any(|id| id == "rt-a"));
        assert!(ids.iter().any(|id| id == "rt-b"));
    }

    #[tokio::test]
    async fn pooled_refresh_detaches_idle_route_before_starting_replacement() {
        let (pool, factory) = service_pool();
        let workspace = tempfile::tempdir().unwrap();
        let workspace_id = "ws-idle";
        let workspace_path = workspace.path().to_string_lossy().into_owned();
        let (revision, lease) = seed_domain(&pool, workspace_id, "before").await;
        let old_generation = Arc::clone(&lease.generation);
        let (generation, route_lease) = lease.into_route_parts();
        let manager = Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        )));
        {
            let mut manager = manager.lock().await;
            manager.add_test_workspace_runtime(
                "rt-idle",
                &workspace_path,
                workspace_id,
                amux::AgentStatus::Idle,
            );
            let handle = manager.get_handle_mut("rt-idle").unwrap();
            handle.host_generation_id = generation.generation_id.clone();
            handle.route_lease = Some(route_lease);
        }
        let supervisor = RuntimeSupervisor::new_with_host_pool(manager.clone(), pool.clone());

        let outcome = supervisor
            .reload_workspace(workspace_id, workspace.path(), true)
            .await
            .unwrap();
        assert!(matches!(outcome, ApplyOutcome::RestartRequired));
        assert!(manager.lock().await.agent_ids().is_empty());

        let replacement = pool
            .acquire(
                IsolationDomainKey::Workspace(workspace_id.into()),
                revision,
                HashMap::from([("SENTINEL".into(), "before".into())]),
                std::time::Instant::now() + std::time::Duration::from_secs(1),
            )
            .await
            .unwrap();

        assert_ne!(
            replacement.generation.generation_id,
            old_generation.generation_id
        );
        assert_eq!(factory.starts.load(Ordering::SeqCst), 2);
        assert_eq!(
            pool.stats_for(&IsolationDomainKey::Workspace(workspace_id.into()))
                .draining_generations,
            0,
            "the detached idle route must not leave a draining generation"
        );
    }

    #[tokio::test]
    async fn diagnostics_report_workspace_domain_generation_state() {
        let (pool, _factory) = service_pool();
        let (revision_a, old) = seed_domain(&pool, "ws-a", "old").await;
        pool.invalidate_domain(&IsolationDomainKey::Workspace("ws-a".into()));
        let replacement = pool
            .acquire(
                IsolationDomainKey::Workspace("ws-a".into()),
                revision_a,
                HashMap::from([("SENTINEL".into(), "old".into())]),
                std::time::Instant::now() + std::time::Duration::from_secs(1),
            )
            .await
            .unwrap();

        let workspace = tempfile::tempdir().unwrap();
        let supervisor = RuntimeSupervisor::new_with_host_pool(
            Arc::new(AsyncMutex::new(RuntimeManager::new(
                RuntimeManager::default_launch_configs(),
                None,
            ))),
            pool,
        );
        let diagnostics = supervisor
            .env_activation_diagnostics("ws-a", workspace.path(), None)
            .await;
        let stats = diagnostics.host_pool;
        assert_eq!(
            stats.current_generation,
            Some(replacement.generation.generation_id.clone())
        );
        assert_eq!(stats.current_routes, 1);
        assert_eq!(stats.draining_generations, 1);
        assert_eq!(stats.draining_routes, 1);
        assert!(stats.current_revision.is_some());
        assert!(stats.requested_revision.is_some());
        drop(old);
    }

    #[tokio::test]
    async fn startup_prewarm_keeps_two_workspace_currents() {
        let (pool, factory) = service_pool();
        prewarm_workspace_domains(
            pool.clone(),
            vec![
                (
                    "ws-default".into(),
                    HashMap::from([("W".into(), "default".into())]),
                ),
                (
                    "ws-second".into(),
                    HashMap::from([("W".into(), "second".into())]),
                ),
                (
                    "ws-third".into(),
                    HashMap::from([("W".into(), "third".into())]),
                ),
            ],
        )
        .await;

        assert_eq!(factory.starts.load(Ordering::SeqCst), 2);
        assert!(pool
            .stats_for(&IsolationDomainKey::Workspace("ws-default".into()))
            .current_generation
            .is_some());
        assert!(pool
            .stats_for(&IsolationDomainKey::Workspace("ws-second".into()))
            .current_generation
            .is_some());
        assert!(pool
            .stats_for(&IsolationDomainKey::Workspace("ws-third".into()))
            .current_generation
            .is_none());
    }

    #[tokio::test]
    async fn apply_refresh_clears_pending_despite_internal_writes() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));

        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::OpencodeJson,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        supervisor
            .apply_refresh(&workspace_id, dir.path(), true)
            .await
            .expect("apply_refresh");

        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "clean", "pending should clear after apply");
    }

    #[tokio::test]
    async fn skills_refresh_stays_pending_without_auto_apply() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));

        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::Skills,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        let applied = supervisor.auto_apply_pending_refreshes().await;

        assert_eq!(applied, 0);
        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "pending");
        assert!(!dto.auto_apply_blocked_by_active_runtime);
        assert_eq!(dto.recommended_action, "none");
    }

    #[tokio::test]
    async fn reload_workspace_rejects_active_turn() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));
        {
            let mut manager = supervisor.agents.lock().await;
            manager.add_test_workspace_runtime(
                "rt-busy",
                &dir.path().to_string_lossy(),
                &workspace_id,
                amux::AgentStatus::Active,
            );
        }

        let err = supervisor
            .reload_workspace(&workspace_id, dir.path(), true)
            .await
            .expect_err("reload must fail while a turn is active");
        assert!(matches!(
            err,
            WorkspaceControlError::ActiveTurn(ref id) if id == &workspace_id
        ));
    }

    #[tokio::test]
    async fn env_vars_refresh_stays_pending_without_auto_apply() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));
        let snapshot = teamclu_runtime_env::resolve_runtime_env(
            teamclu_runtime_env::personal_secrets::load_personal_env().unwrap_or_default(),
            std::collections::HashMap::new(),
            teamclu_runtime_env::SystemEnvContext {
                actor_id: "actor-test".to_string(),
                display_name: "Agent Test".to_string(),
                cloud_token_file: None,
                gateway_token: None,
            },
        );
        {
            let mut manager = supervisor.agents.lock().await;
            manager.add_test_workspace_runtime(
                "rt-idle",
                &dir.path().to_string_lossy(),
                &workspace_id,
                amux::AgentStatus::Idle,
            );
            manager.set_test_runtime_env_snapshot("rt-idle", snapshot, None);
        }
        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::EnvVars,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        assert_eq!(supervisor.auto_apply_pending_refreshes().await, 0);
        let manager = supervisor.agents.lock().await;
        assert_eq!(
            manager
                .active_handles_for_workspace(&dir.path().to_string_lossy(), &workspace_id)
                .count(),
            1,
            "env refresh pending must not evict an idle runtime"
        );
        drop(manager);
        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "pending");
        assert_eq!(dto.recommended_action, "none");
    }

    #[tokio::test]
    async fn skills_refresh_stays_pending_even_when_workspace_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));
        {
            let mut manager = supervisor.agents.lock().await;
            manager.add_test_workspace_runtime(
                "rt-busy",
                &dir.path().to_string_lossy(),
                &workspace_id,
                amux::AgentStatus::Active,
            );
        }

        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::Skills,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        let applied = supervisor.auto_apply_pending_refreshes().await;

        assert_eq!(applied, 0);
        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "pending");
        // Not auto-applicable at all — busy gating must not mark it blocked.
        assert!(!dto.auto_apply_blocked_by_active_runtime);
    }

    #[tokio::test]
    async fn skills_refresh_stays_pending_after_workspace_becomes_idle() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));
        {
            let mut manager = supervisor.agents.lock().await;
            manager.add_test_workspace_runtime(
                "rt-busy",
                &dir.path().to_string_lossy(),
                &workspace_id,
                amux::AgentStatus::Active,
            );
        }

        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::Skills,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();
        assert_eq!(supervisor.auto_apply_pending_refreshes().await, 0);

        {
            let mut manager = supervisor.agents.lock().await;
            manager.set_test_runtime_status("rt-busy", amux::AgentStatus::Idle);
        }

        let applied = supervisor.auto_apply_pending_refreshes().await;

        assert_eq!(applied, 0);
        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "pending");
        assert_eq!(dto.recommended_action, "none");
    }

    #[tokio::test]
    async fn skills_plus_env_refresh_is_not_auto_applicable() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));

        for kind in [
            refresh::RefreshChangeKind::Skills,
            refresh::RefreshChangeKind::EnvVars,
        ] {
            supervisor
                .refresh_coordinator()
                .record_change(
                    &workspace_id,
                    dir.path(),
                    kind,
                    refresh::RefreshSource::FilesystemWatch,
                )
                .await
                .unwrap();
        }

        assert_eq!(supervisor.auto_apply_pending_refreshes().await, 0);
        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "pending");
        assert!(dto.change_kinds.contains(&"skills".to_string()));
        assert!(dto.change_kinds.contains(&"env_vars".to_string()));
    }

    #[tokio::test]
    async fn auto_applier_loop_leaves_idle_pending_permissions_refresh() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));
        let handle = supervisor
            .clone()
            .start_refresh_auto_applier_with_interval(std::time::Duration::from_millis(20));

        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::Permissions,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "pending");
        assert_eq!(dto.recommended_action, "none");

        handle.abort();
    }

    #[tokio::test]
    async fn auto_applier_loop_leaves_idle_pending_skills_refresh() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = refresh_watch::workspace_runtime_id(dir.path());
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(RuntimeManager::new(
            RuntimeManager::default_launch_configs(),
            None,
        ))));
        let handle = supervisor
            .clone()
            .start_refresh_auto_applier_with_interval(std::time::Duration::from_millis(20));

        supervisor
            .refresh_coordinator()
            .record_change(
                &workspace_id,
                dir.path(),
                refresh::RefreshChangeKind::Skills,
                refresh::RefreshSource::FilesystemWatch,
            )
            .await
            .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        let dto = supervisor
            .refresh_coordinator()
            .runtime_refresh_dto(&workspace_id)
            .await;
        assert_eq!(dto.status, "pending");
        assert_eq!(dto.recommended_action, "none");

        handle.abort();
    }

    #[test]
    fn prepare_workspace_creates_defaults() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let dir = tempfile::tempdir().unwrap();
        prepare_workspace(dir.path()).unwrap();

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        assert!(cfg.get("permission").is_some());
        assert!(
            cfg["mcp"].get(REMOTE_TOOLS_MCP_SERVER_NAME).is_none(),
            "amuxd-remote-tools must not be auto-injected"
        );

        assert!(home
            .path()
            .join(".agents/skills/create-role/SKILL.md")
            .is_file());
        assert!(
            !dir.path().join(".teamclu/skills/create-role").exists(),
            "inherent skills are no longer seeded per workspace"
        );
        assert!(!dir.path().join(".opencode/skills").exists());
        assert!(!dir.path().join(".opencode/data").exists());
    }

    /// A workspace can lose `teamclu-team` (never linked, torn down, deleted by
    /// hand). The workspace-derived repair then has nothing to chain through,
    /// and before this the workspace stayed without a knowledge link until
    /// something else re-linked the team. Every init rebuilds it now.
    #[test]
    fn prepare_workspace_rebuilds_team_knowledge_without_the_team_link() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let amuxd = home.path().join(".amuxd");
        std::fs::create_dir_all(&amuxd).unwrap();
        std::fs::write(amuxd.join("daemon.toml"), "active_team = \"team-abc\"\n").unwrap();
        let knowledge = amuxd.join("teams/team-abc/shared/knowledge");
        std::fs::create_dir_all(&knowledge).unwrap();

        let ws = tempfile::tempdir().unwrap();
        assert!(!ws.path().join("teamclu-team").exists());

        prepare_workspace(ws.path()).unwrap();

        let link = ws.path().join("team-knowledge");
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "team-knowledge must be rebuilt from the active team"
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), knowledge);
    }

    /// The fallback re-points at a directory that exists; it never materializes
    /// one. A team whose share was torn down has no `shared/knowledge`, and
    /// re-creating a link into it would fight the explicit unlink path.
    #[test]
    fn prepare_workspace_leaves_team_knowledge_alone_when_the_team_dir_is_gone() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let amuxd = home.path().join(".amuxd");
        std::fs::create_dir_all(&amuxd).unwrap();
        std::fs::write(amuxd.join("daemon.toml"), "active_team = \"team-abc\"\n").unwrap();

        let ws = tempfile::tempdir().unwrap();
        prepare_workspace(ws.path()).unwrap();

        assert!(!ws.path().join("team-knowledge").exists());
    }

    #[test]
    fn prepare_workspace_strips_paused_remote_tools_mcp() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("opencode.json"),
            r#"{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "amuxd-remote-tools": {
      "type": "local",
      "enabled": true,
      "command": ["amuxd", "remote-tools-mcp"]
    }
  }
}"#,
        )
        .unwrap();
        prepare_workspace(dir.path()).unwrap();
        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        assert!(cfg["mcp"].get("amuxd-remote-tools").is_none());
    }

    #[test]
    /// A white-label build seeds the same shared root as the official one:
    /// skills are not brand-namespaced any more.
    fn prepare_workspace_white_label_seeds_the_shared_agents_dir() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("copilot361", home.path());

        let dir = tempfile::tempdir().unwrap();
        prepare_workspace(dir.path()).unwrap();
        assert!(home
            .path()
            .join(".agents/skills/create-role/SKILL.md")
            .is_file());
        assert!(!dir
            .path()
            .join(".copilot361/skills/create-role/SKILL.md")
            .exists());
    }

    #[test]
    fn ensure_instruction_plugin_creates_file_and_registers() {
        let dir = tempfile::tempdir().unwrap();
        ensure_instruction_plugin(dir.path()).unwrap();

        let plugin_path = dir
            .path()
            .join(crate::runtime::workspace_runtime::INSTRUCTION_PLUGIN_REL);
        assert!(plugin_path.is_file());
        assert!(std::fs::read_to_string(plugin_path)
            .unwrap()
            .contains("experimental.chat.system.transform"));

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        let plugins = cfg["plugin"].as_array().unwrap();
        assert!(plugins.iter().any(|entry| {
            entry
                .as_str()
                .map(|value| value.contains("teamclu-instruction"))
                .unwrap_or(false)
        }));
        assert!(crate::runtime::instruction_plugin_installed(dir.path()));
    }

    #[test]
    fn ensure_session_context_plugin_creates_file_and_registers() {
        let dir = tempfile::tempdir().unwrap();
        ensure_session_context_plugin(dir.path()).unwrap();

        let plugin_path = dir
            .path()
            .join(crate::runtime::workspace_runtime::SESSION_CONTEXT_PLUGIN_REL);
        let client_path = dir
            .path()
            .join(crate::runtime::workspace_runtime::SESSION_CONTEXT_CLIENT_REL);
        assert!(plugin_path.is_file());
        assert!(client_path.is_file());
        assert!(std::fs::read_to_string(plugin_path)
            .unwrap()
            .contains("teamclu-session-context-client.mjs"));
        assert!(std::fs::read_to_string(client_path)
            .unwrap()
            .contains("normalizeSessionScopedToolName"));

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        let plugins = cfg["plugin"].as_array().unwrap();
        assert!(plugins.iter().any(|entry| {
            entry
                .as_str()
                .map(|value| value.contains("teamclu-session-context"))
                .unwrap_or(false)
        }));
    }

    #[test]
    fn instruction_plugin_white_label_reads_brand_policy_path() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("copilot361");
        let dir = tempfile::tempdir().unwrap();
        ensure_instruction_plugin(dir.path()).unwrap();

        let plugin = std::fs::read_to_string(
            dir.path()
                .join(crate::runtime::workspace_runtime::INSTRUCTION_PLUGIN_REL),
        )
        .unwrap();
        assert!(plugin.contains(".copilot361"));
        assert!(plugin.contains("skill-creation-policy.txt"));
        assert!(!plugin.contains("__WORKSPACE_META_DIR__"));
        assert!(!plugin.contains(r#"".teamclu", "instructions", "skill-creation-policy.txt""#));
    }

    #[test]
    fn prepare_workspace_drops_renamed_inherent_mcp_entry() {
        // A workspace written before the 2026-08-09 teamclaw→teamclu rename
        // carries `teamclaw-introspect` with an absolute path into an app
        // bundle that no longer ships that binary. Nothing owned the old name
        // afterwards, and under pi the extension's bridge spawn took the whole
        // runtime down with it, so every session in the workspace failed with
        // "process exited before responding".
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_with_home("teamclu", home.path());
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("opencode.json"),
            r#"{"mcp":{"teamclaw-introspect":{"type":"local","enabled":true,
                 "command":["/Applications/Old.app/Contents/MacOS/teamclaw-introspect"]},
                 "user-server":{"type":"local","enabled":true,"command":["npx","-y","x"]}}}"#,
        )
        .unwrap();

        prepare_workspace(dir.path()).unwrap();

        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        assert!(
            cfg["mcp"].get("teamclaw-introspect").is_none(),
            "the renamed inherent entry must be dropped"
        );
        assert!(
            cfg["mcp"].get("user-server").is_some(),
            "a user's own server must survive the migration"
        );
    }
}
