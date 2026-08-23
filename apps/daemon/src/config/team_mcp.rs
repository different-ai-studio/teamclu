//! Team-shared MCP definitions, mirrored from the Cloud API into
//! `~/.amuxd/teams/<id>/cloud/.mcp/` by `runtime::team_cloud_config`.
//!
//! The file format is unchanged (Cursor `mcpServers`) because the server hands
//! back exactly that shape — see `docs/architecture/team-mcp-and-env-cloud.md`.
//! The synced `teamclu-team/.mcp/` directory is no longer synced and is only a
//! fallback before the daemon has a valid cloud cache. Once that cache exists,
//! it is authoritative — including when it is empty after an uninstall.
//!
//! Merged at read time with workspace `opencode.json` entries. On name
//! collision the workspace layer wins (user local override).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::global_team_store::{resolve_team_dir, TEAM_LINK_NAME};
use super::workspace_control::{McpServerConfig, WorkspaceControlError};
use teamclu_runtime_env::opencode_config::OpencodeConfigError;

pub const INHERENT_MCP_NAMES: &[&str] = &[
    "playwright",
    "chrome-control",
    "autoui",
    "teamclu-introspect",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpSource {
    Workspace,
    Team,
    Inherent,
}

impl McpSource {
    pub fn as_str(self) -> &'static str {
        match self {
            McpSource::Workspace => "workspace",
            McpSource::Team => "team",
            McpSource::Inherent => "inherent",
        }
    }
}

#[derive(Debug, Deserialize)]
struct TeamMcpFile {
    #[serde(rename = "mcpServers", default)]
    mcp_servers: HashMap<String, CursorMcpServer>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CursorMcpServer {
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
}

fn io_err(e: std::io::Error) -> WorkspaceControlError {
    WorkspaceControlError::Io(e.to_string())
}

fn parse_err(e: serde_json::Error) -> WorkspaceControlError {
    WorkspaceControlError::Parse(e.to_string())
}

fn is_inherent(name: &str) -> bool {
    INHERENT_MCP_NAMES.contains(&name) || super::device_mcp::is_device_scoped(name)
}

pub(crate) fn onboarded_team_id() -> Option<String> {
    super::DaemonConfig::load(&super::DaemonConfig::default_path())
        .ok()
        .and_then(|cfg| {
            cfg.team_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
}

/// Directories holding team MCP definitions, **least** preferred first.
///
/// The legacy synced `teamclu-team/.mcp/` is used only when there is no valid
/// cloud cache yet. That preserves pre-migration offline checkouts without
/// allowing a stale legacy file to resurrect a server that this actor removed.
fn team_mcp_dirs(workspace: &Path) -> Vec<PathBuf> {
    let team_id = onboarded_team_id();
    let legacy = match &team_id {
        Some(id) => resolve_team_dir(workspace, id).join(".mcp"),
        None => workspace.join(TEAM_LINK_NAME).join(".mcp"),
    };
    match &team_id {
        Some(id) => vec![
            legacy,
            crate::runtime::team_cloud_config::team_cloud_mcp_dir(id),
        ],
        // Without an onboarded team there is no cloud cache to read.
        None => vec![legacy],
    }
}

pub(crate) fn convert_cursor_server(server: &CursorMcpServer) -> McpServerConfig {
    if server.url.is_some() {
        McpServerConfig {
            server_type: "remote".to_owned(),
            enabled: Some(true),
            command: vec![],
            environment: HashMap::new(),
            url: server.url.clone(),
            headers: server.headers.clone().unwrap_or_default(),
            timeout: None,
            source: None,
            extra: HashMap::new(),
        }
    } else {
        let mut command = Vec::new();
        if let Some(cmd) = &server.command {
            command.push(cmd.clone());
        }
        if let Some(args) = &server.args {
            command.extend(args.clone());
        }
        McpServerConfig {
            server_type: "local".to_owned(),
            enabled: Some(true),
            command,
            environment: server.env.clone().unwrap_or_default(),
            url: None,
            headers: HashMap::new(),
            timeout: None,
            source: None,
            extra: HashMap::new(),
        }
    }
}

/// Scan every team MCP source for `*.json` in Cursor `mcpServers` format.
///
/// A valid cloud cache is authoritative. Only when it is absent or malformed do
/// we fall back to the legacy directories for pre-migration offline support.
pub fn scan_team_mcp(workspace: &Path) -> HashMap<String, McpServerConfig> {
    if let Some(team_id) = onboarded_team_id() {
        let mut cloud_servers = HashMap::new();
        if read_cloud_mcp_file_into(
            &crate::runtime::team_cloud_config::team_cloud_mcp_file(&team_id),
            &mut cloud_servers,
        ) {
            return cloud_servers;
        }
    }

    let mut team_servers = HashMap::new();
    for mcp_dir in team_mcp_dirs(workspace) {
        scan_team_mcp_dir_into(&mcp_dir, &mut team_servers);
    }
    team_servers
}

/// Read the cloud file in Cursor `{ "mcpServers": … }` shape.
/// Returns `true` only when the cache has a valid MCP map, including an empty
/// one. In that case it replaces rather than augments `out` so a legacy server
/// cannot survive a successful uninstall.
fn read_cloud_mcp_file_into(path: &Path, out: &mut HashMap<String, McpServerConfig>) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    let Some(map) = json
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .or_else(|| json.get("mcp").and_then(|v| v.as_object()))
    else {
        return false;
    };
    out.clear();
    for (name, raw) in map {
        if let Ok(parsed) = serde_json::from_value::<CursorMcpServer>(raw.clone()) {
            out.insert(name.clone(), convert_cursor_server(&parsed));
        } else if let Ok(cfg) = serde_json::from_value::<McpServerConfig>(raw.clone()) {
            out.insert(name.clone(), cfg);
        }
    }
    true
}

fn scan_team_mcp_dir_into(mcp_dir: &Path, out: &mut HashMap<String, McpServerConfig>) {
    if !mcp_dir.is_dir() {
        return;
    }

    let entries = match std::fs::read_dir(mcp_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let team_file: TeamMcpFile = match serde_json::from_str(&content) {
            Ok(file) => file,
            Err(_) => continue,
        };
        for (name, server) in team_file.mcp_servers {
            out.insert(name, convert_cursor_server(&server));
        }
    }
}

pub fn read_persisted_mcp(
    workspace: &Path,
) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError> {
    let path = workspace.join("opencode.json");
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = std::fs::read_to_string(&path).map_err(io_err)?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(parse_err)?;
    Ok(json
        .get("mcp")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default())
}

fn configs_equal(a: &McpServerConfig, b: &McpServerConfig) -> bool {
    a.server_type == b.server_type
        && a.enabled == b.enabled
        && a.command == b.command
        && a.environment == b.environment
        && a.url == b.url
        && a.headers == b.headers
        && a.timeout == b.timeout
}

fn classify_source(
    name: &str,
    persisted: Option<&McpServerConfig>,
    team: &HashMap<String, McpServerConfig>,
) -> McpSource {
    if is_inherent(name) {
        return McpSource::Inherent;
    }
    match (team.get(name), persisted) {
        (Some(team_cfg), Some(disk_cfg)) if configs_equal(team_cfg, disk_cfg) => McpSource::Team,
        (Some(_), Some(_)) => McpSource::Workspace,
        (Some(_), None) => McpSource::Team,
        (None, Some(_)) => McpSource::Workspace,
        (None, None) => McpSource::Workspace,
    }
}

fn with_source(mut cfg: McpServerConfig, source: McpSource) -> McpServerConfig {
    cfg.source = Some(source.as_str().to_owned());
    cfg
}

/// Merge team + workspace layers. Workspace `opencode.json` wins on conflicts.
pub fn merge_mcp_layers(
    team: &HashMap<String, McpServerConfig>,
    persisted: &HashMap<String, McpServerConfig>,
) -> HashMap<String, McpServerConfig> {
    let mut names: HashSet<String> = team.keys().cloned().collect();
    names.extend(persisted.keys().cloned());

    let mut merged = HashMap::new();
    for name in names {
        let source = classify_source(&name, persisted.get(&name), team);
        let cfg = match (team.get(&name), persisted.get(&name)) {
            (_, Some(disk)) => disk.clone(),
            (Some(team_cfg), None) => team_cfg.clone(),
            (None, None) => continue,
        };
        merged.insert(name, with_source(cfg, source));
    }
    merged
}

pub fn load_merged_mcp(
    workspace: &Path,
) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError> {
    // Device layer first, team over it, workspace last. Device and team never
    // collide in practice (the device names are ours), but if a team ever ships
    // a server called `playwright` the team's definition is the one that should
    // win — it is the deliberate choice, ours is a default.
    let mut overlay = super::device_mcp::load_device_mcp();
    overlay.extend(scan_team_mcp(workspace));
    let persisted = read_persisted_mcp(workspace)?;
    Ok(merge_mcp_layers(&overlay, &persisted))
}

/// Split a PUT body into (workspace-owned, device-owned).
///
/// Team entries are dropped entirely — they are read from the team's own file,
/// and a workspace copy would outrank it forever. Device-scoped entries are
/// handed back separately so the caller can persist them once per machine
/// instead of once per workspace.
pub fn split_put_body(
    workspace: &Path,
    body: HashMap<String, McpServerConfig>,
) -> (
    HashMap<String, McpServerConfig>,
    HashMap<String, McpServerConfig>,
) {
    let mut device = HashMap::new();
    let mut workspace_owned = HashMap::new();
    for (name, cfg) in filter_put_body(workspace, body) {
        if super::device_mcp::is_device_scoped(&name) {
            device.insert(name, cfg);
        } else {
            workspace_owned.insert(name, cfg);
        }
    }
    (workspace_owned, device)
}

/// Strip team/inherent overlay entries from a PUT body; persist workspace-owned only.
pub fn filter_put_body(
    workspace: &Path,
    body: HashMap<String, McpServerConfig>,
) -> HashMap<String, McpServerConfig> {
    let team_names: HashSet<String> = scan_team_mcp(workspace).into_keys().collect();
    body.into_iter()
        .filter(|(name, cfg)| match cfg.source.as_deref() {
            Some("team") => false,
            Some("workspace") | Some("inherent") => true,
            _ => is_inherent(name) || !team_names.contains(name),
        })
        .map(|(name, mut cfg)| {
            cfg.source = None;
            (name, cfg)
        })
        .collect()
}

/// Result of reconciling a workspace's `opencode.json` against the team set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PruneTeamMcpOutcome {
    /// Whether `opencode.json` was rewritten.
    pub changed: bool,
    /// Leftover team copies removed.
    pub removed_count: usize,
}

/// Remove team MCP entries an older build copied into `opencode.json`.
///
/// Team servers used to be *materialised* into every workspace's config so the
/// runtimes could see them. They are now read straight from
/// `~/.amuxd/teams/<id>/cloud/mcp.json` by all four, which makes those copies
/// worse than redundant: a workspace entry outranks the team's, so a leftover
/// copy silently pins that server at whatever the team shipped the day it was
/// written, and no team update can ever reach the machine again.
///
/// Only byte-identical copies go. An entry that differs from the team's is a
/// deliberate local override — the one thing the workspace layer exists for —
/// and outranking the team is exactly what it should keep doing.
/// Move device-scoped MCP entries out of a workspace `opencode.json`.
///
/// Same failure mode as the team prune above, one layer down: these four servers
/// are now written once per machine (`~/.amuxd/mcp.json`), and a workspace copy
/// outranks it — so a leftover copy pins this workspace to whatever binary path
/// and enable-flag were current the day it was written. Reinstall the app and
/// `amuxd-send` in that copy points at a binary that no longer exists.
///
/// A copy whose settings differ from the device file is carried over before it
/// is dropped, so a `chrome-control` the user had disabled in this workspace
/// ends up disabled machine-wide rather than silently re-enabled. Anything that
/// matches is just removed.
pub fn prune_device_mcp(workspace: &Path) -> Result<PruneTeamMcpOutcome, WorkspaceControlError> {
    let device = super::device_mcp::load_device_mcp();
    let mut carry_over: HashMap<String, McpServerConfig> = HashMap::new();
    let mut removed_count = 0usize;

    let changed =
        teamclu_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace, |json| {
            let Some(obj) = json.as_object_mut() else {
                return Ok(false);
            };
            let Some(mcp_obj) = obj.get_mut("mcp").and_then(|m| m.as_object_mut()) else {
                return Ok(false);
            };

            let names: Vec<String> = mcp_obj
                .keys()
                .filter(|name| super::device_mcp::is_device_scoped(name))
                .cloned()
                .collect();

            for name in &names {
                if let Some(raw) = mcp_obj.remove(name) {
                    removed_count += 1;
                    // Only a *user* difference is worth carrying. `amuxd-send`
                    // and `teamclu-introspect` both bake an absolute binary
                    // path into their argv, which differs on every reinstall and
                    // (for introspect) still carries the `--workspace` of the
                    // workspace it was written in. The device file's copy is the
                    // fresh one, so never let a stale local copy win — carrying
                    // one back would reintroduce exactly the pinning that moving
                    // these to the device layer removes.
                    if name == "amuxd-send" || name == "teamclu-introspect" {
                        continue;
                    }
                    if let Ok(local) = serde_json::from_value::<McpServerConfig>(raw) {
                        let differs = device
                            .get(name)
                            .map(|current| !configs_equal(current, &local))
                            .unwrap_or(true);
                        if differs {
                            carry_over.insert(name.clone(), local);
                        }
                    }
                }
            }
            Ok(removed_count > 0)
        })
        .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;

    if !carry_over.is_empty() {
        super::device_mcp::put_device_entries(carry_over)?;
    }

    Ok(PruneTeamMcpOutcome {
        changed,
        removed_count,
    })
}

pub fn prune_materialised_team_mcp(
    workspace: &Path,
) -> Result<PruneTeamMcpOutcome, WorkspaceControlError> {
    prune_materialised_team_mcp_entries(workspace, &scan_team_mcp(workspace))
}

/// The applying half, taking the team map explicitly so it is testable without
/// a daemon config dir.
pub fn prune_materialised_team_mcp_entries(
    workspace: &Path,
    team: &HashMap<String, McpServerConfig>,
) -> Result<PruneTeamMcpOutcome, WorkspaceControlError> {
    if team.is_empty() {
        return Ok(PruneTeamMcpOutcome {
            changed: false,
            removed_count: 0,
        });
    }

    let mut removed_count = 0usize;
    let changed =
        teamclu_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace, |json| {
            let Some(obj) = json.as_object_mut() else {
                return Ok(false);
            };
            let Some(mcp_obj) = obj.get_mut("mcp").and_then(|m| m.as_object_mut()) else {
                return Ok(false);
            };

            let stale: Vec<String> = mcp_obj
                .iter()
                .filter(|(name, raw)| {
                    if is_inherent(name) {
                        return false;
                    }
                    let Some(team_cfg) = team.get(name.as_str()) else {
                        return false;
                    };
                    serde_json::from_value::<McpServerConfig>((*raw).clone())
                        .map(|local| configs_equal(&local, team_cfg))
                        .unwrap_or(false)
                })
                .map(|(name, _)| name.clone())
                .collect();

            for name in &stale {
                mcp_obj.remove(name);
                removed_count += 1;
            }
            Ok(removed_count > 0)
        })
        .map_err(|e| WorkspaceControlError::Io(e.to_string()))?;

    Ok(PruneTeamMcpOutcome {
        changed,
        removed_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_cfg(command: &[&str]) -> McpServerConfig {
        McpServerConfig {
            server_type: "local".to_owned(),
            enabled: Some(true),
            command: command.iter().map(|s| (*s).to_owned()).collect(),
            environment: HashMap::new(),
            url: None,
            headers: HashMap::new(),
            timeout: None,
            source: None,
            extra: HashMap::new(),
        }
    }

    /// The dual-source merge, exercised on the directory scanner directly.
    ///
    /// `scan_team_mcp` itself resolves the cloud cache through the daemon's real
    /// config dir (via the onboarded team id), which a unit test has no business
    /// reaching into. `scan_team_mcp_dir_into` is the part that actually decides
    /// precedence, and it takes explicit paths.
    #[test]
    fn later_dirs_override_earlier_ones_on_name_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("legacy");
        let cloud = tmp.path().join("cloud");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&cloud).unwrap();
        std::fs::write(
            legacy.join("a.json"),
            r#"{"mcpServers":{"shared":{"command":"stale"},"legacy-only":{"command":"keep"}}}"#,
        )
        .unwrap();
        std::fs::write(
            cloud.join("team.json"),
            r#"{"mcpServers":{"shared":{"command":"fresh"}}}"#,
        )
        .unwrap();

        let mut merged = HashMap::new();
        scan_team_mcp_dir_into(&legacy, &mut merged);
        scan_team_mcp_dir_into(&cloud, &mut merged);

        // Cloud reflects what this member actually installed; the synced dir is
        // whatever the team repo still happens to carry.
        assert_eq!(merged.get("shared").unwrap().command, vec!["fresh"]);
        // ...but it does not erase entries the cloud never mentioned.
        assert_eq!(merged.get("legacy-only").unwrap().command, vec!["keep"]);
    }

    #[test]
    fn an_empty_cloud_cache_removes_legacy_team_servers() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("legacy");
        let cloud = tmp.path().join("mcp.json");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            legacy.join("stale.json"),
            r#"{"mcpServers":{"stale":{"command":"npx","args":["stale-mcp"]}}}"#,
        )
        .unwrap();
        std::fs::write(&cloud, r#"{"mcpServers":{}}"#).unwrap();

        let mut merged = HashMap::new();
        scan_team_mcp_dir_into(&legacy, &mut merged);
        read_cloud_mcp_file_into(&cloud, &mut merged);

        assert!(merged.is_empty());
    }

    #[test]
    fn a_missing_dir_contributes_nothing_and_does_not_clear_the_map() {
        let tmp = tempfile::tempdir().unwrap();
        let present = tmp.path().join("present");
        std::fs::create_dir_all(&present).unwrap();
        std::fs::write(
            present.join("a.json"),
            r#"{"mcpServers":{"team-db":{"command":"npx"}}}"#,
        )
        .unwrap();

        let mut merged = HashMap::new();
        scan_team_mcp_dir_into(&present, &mut merged);
        // The offline case: no cloud cache yet. It must be a no-op, not a wipe —
        // an empty team map would reclassify materialized servers as workspace-owned.
        scan_team_mcp_dir_into(&tmp.path().join("absent"), &mut merged);

        assert_eq!(merged.len(), 1);
        assert!(merged.contains_key("team-db"));
    }

    /// Parses the Cursor `mcpServers` shape the Cloud API hands back verbatim.
    ///
    /// Exercises the directory scanner directly rather than `scan_team_mcp`:
    /// that one resolves the cloud cache through the daemon's real config dir,
    /// which a unit test has no business reaching into.
    #[test]
    fn scan_team_mcp_parses_cursor_json_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("team.json"),
            r#"{
  "mcpServers": {
    "team-db": {
      "command": "npx",
      "args": ["-y", "team-db-mcp"]
    }
  }
}"#,
        )
        .unwrap();

        let mut team = HashMap::new();
        scan_team_mcp_dir_into(dir.path(), &mut team);
        assert_eq!(team.len(), 1);
        let cfg = team.get("team-db").unwrap();
        assert_eq!(cfg.server_type, "local");
        assert_eq!(cfg.command, vec!["npx", "-y", "team-db-mcp"]);
    }

    #[test]
    fn cloud_mcp_file_parses_cursor_mcp_servers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        std::fs::write(
            &path,
            r#"{
  "mcpServers": {
    "team-db": { "command": "npx", "args": ["-y", "team-db-mcp"] },
    "remote": { "url": "https://example.invalid/mcp" }
  }
}"#,
        )
        .unwrap();
        let mut team = HashMap::new();
        read_cloud_mcp_file_into(&path, &mut team);
        assert_eq!(team["team-db"].command, vec!["npx", "-y", "team-db-mcp"]);
        assert_eq!(team["remote"].server_type, "remote");
        assert_eq!(
            team["remote"].url.as_deref(),
            Some("https://example.invalid/mcp")
        );
    }

    /// The legacy directory is still read, but never last — so a stale copy in a
    /// synced team repo cannot shadow what the member actually installed.
    #[test]
    fn legacy_team_mcp_directory_is_read_but_never_wins() {
        let ws = tempfile::tempdir().unwrap();
        let dirs = team_mcp_dirs(ws.path());
        assert!(!dirs.is_empty());
        assert!(dirs[0].starts_with(ws.path()), "legacy dir comes first");
    }

    #[test]
    fn merge_workspace_overrides_team_on_name_collision() {
        let mut team = HashMap::new();
        team.insert("supabase".to_owned(), local_cfg(&["npx", "team-supabase"]));

        let mut persisted = HashMap::new();
        persisted.insert("supabase".to_owned(), local_cfg(&["npx", "local-supabase"]));

        let merged = merge_mcp_layers(&team, &persisted);
        let cfg = merged.get("supabase").unwrap();
        assert_eq!(cfg.command, vec!["npx", "local-supabase"]);
        assert_eq!(cfg.source.as_deref(), Some("workspace"));
    }

    #[test]
    fn merge_team_only_entry_has_team_source() {
        let mut team = HashMap::new();
        team.insert("team-only".to_owned(), local_cfg(&["npx", "team-only"]));

        let merged = merge_mcp_layers(&team, &HashMap::new());
        assert_eq!(
            merged.get("team-only").unwrap().source.as_deref(),
            Some("team")
        );
    }

    #[test]
    fn filter_put_body_strips_team_entries() {
        let ws = tempfile::tempdir().unwrap();
        let mcp_dir = ws.path().join(TEAM_LINK_NAME).join(".mcp");
        std::fs::create_dir_all(&mcp_dir).unwrap();
        std::fs::write(
            mcp_dir.join("shared.json"),
            r#"{"mcpServers":{"team-srv":{"command":"npx","args":["team"]}}}"#,
        )
        .unwrap();

        let mut body = HashMap::new();
        body.insert(
            "team-srv".to_owned(),
            with_source(local_cfg(&["npx", "team"]), McpSource::Team),
        );
        body.insert(
            "custom".to_owned(),
            with_source(local_cfg(&["npx", "custom"]), McpSource::Workspace),
        );

        let filtered = filter_put_body(ws.path(), body);
        assert!(!filtered.contains_key("team-srv"));
        assert!(filtered.contains_key("custom"));
    }

    #[test]
    fn pruning_drops_a_leftover_team_copy_but_keeps_a_real_override() {
        // The migration. An older build copied every team server into this file;
        // the runtimes now read the team's own file, so a copy that still
        // matches is dead weight that would outrank the source forever. A copy
        // the user changed is the local override the workspace layer is for.
        let ws = tempfile::tempdir().unwrap();
        std::fs::write(
            ws.path().join("opencode.json"),
            r#"{"mcp":{
                "copied":{"type":"local","enabled":true,"command":["npx","team"]},
                "overridden":{"type":"local","enabled":true,"command":["npx","mine"]},
                "mine-only":{"type":"local","enabled":true,"command":["npx","solo"]}
            }}"#,
        )
        .unwrap();

        let mut team = HashMap::new();
        team.insert("copied".to_owned(), local_cfg(&["npx", "team"]));
        team.insert("overridden".to_owned(), local_cfg(&["npx", "team"]));

        let outcome = prune_materialised_team_mcp_entries(ws.path(), &team).unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.removed_count, 1);

        let persisted = read_persisted_mcp(ws.path()).unwrap();
        assert!(
            !persisted.contains_key("copied"),
            "an unmodified copy of the team entry is removed"
        );
        assert_eq!(
            persisted.get("overridden").unwrap().command,
            vec!["npx", "mine"],
            "a changed entry is a deliberate override and stays"
        );
        assert_eq!(
            persisted.get("mine-only").unwrap().command,
            vec!["npx", "solo"],
            "a server the team never had is untouched"
        );
    }

    #[test]
    fn pruning_leaves_an_inherent_server_alone_even_if_the_team_ships_one() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::write(
            ws.path().join("opencode.json"),
            r#"{"mcp":{"playwright":{"type":"local","enabled":true,"command":["npx","pw"]}}}"#,
        )
        .unwrap();
        let mut team = HashMap::new();
        team.insert("playwright".to_owned(), local_cfg(&["npx", "pw"]));

        let outcome = prune_materialised_team_mcp_entries(ws.path(), &team).unwrap();

        assert!(!outcome.changed);
        assert!(read_persisted_mcp(ws.path())
            .unwrap()
            .contains_key("playwright"));
    }

    /// `prune_device_mcp` carries a workspace copy back into the device file when
    /// it differs — which is right for a server a user actually configured, and
    /// wrong for the two whose argv is machine state. Introspect's copies also
    /// pin `--workspace`, so carrying one back would make every workspace on the
    /// machine introspect a directory the user has not opened.
    #[test]
    fn a_workspace_copy_of_introspect_is_dropped_rather_than_carried_to_the_device_file() {
        let home = tempfile::tempdir().unwrap();
        let _env = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            super::super::device_mcp::device_mcp_file(),
            r#"{"mcp":{"teamclu-introspect":{"type":"local","enabled":true,"command":["/current/teamclu-introspect","--api-port","13144"]}}}"#,
        )
        .unwrap();

        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(
            workspace.path().join("opencode.json"),
            r#"{"mcp":{"teamclu-introspect":{"type":"local","enabled":true,"command":["/old/bundle/teamclu-introspect","--workspace","/some/other/repo","--api-port","13144"]}}}"#,
        )
        .unwrap();

        let outcome = prune_device_mcp(workspace.path()).unwrap();
        assert_eq!(
            outcome.removed_count, 1,
            "the workspace copy must be removed"
        );

        let device = super::super::device_mcp::load_device_mcp();
        let command = device["teamclu-introspect"].command.join(" ");
        assert!(
            !command.contains("--workspace"),
            "the stale workspace-pinned copy won: {command}"
        );
        assert!(command.starts_with("/current/"), "got {command}");
    }
}
