//! MCP server tool discovery for workspace HTTP APIs.

use crate::config::workspace_control::McpServerConfig;
use crate::process_util::CommandNoWindow;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::time::timeout;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// A configured `timeout` cannot stall the settings page indefinitely.
const PROBE_TIMEOUT_MAX: Duration = Duration::from_secs(120);

/// Per-server `timeout` (seconds) when set, otherwise [`PROBE_TIMEOUT`].
/// Clamped so a typo cannot hang tool discovery.
fn probe_timeout(config: &McpServerConfig) -> Duration {
    let secs = config.timeout.unwrap_or(PROBE_TIMEOUT.as_secs());
    Duration::from_secs(secs.clamp(1, PROBE_TIMEOUT_MAX.as_secs()))
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// One stdio command after Node/npx resolution.
struct ProbeLaunch {
    program: String,
    args: Vec<String>,
    /// Directory of the Node (or shim) we chose. Prepended to the child PATH
    /// so grandchildren (`#!/usr/bin/env node`) see that same Node.
    lead: Option<PathBuf>,
    /// `program` is an absolute path. Unix `command -v` must not run again.
    resolved: bool,
}

/// Where a probe may find Node and `npx`. Production fills this from the
/// managed install, `node_candidates` (PATH, well-known dirs, version
/// managers) and the enriched PATH. Tests pass fixtures.
struct NpxSources {
    managed_node: Option<PathBuf>,
    other_nodes: Vec<PathBuf>,
    shim_dirs: Vec<PathBuf>,
    /// Official Windows zip layout (`node.exe` beside `node_modules`) and
    /// `.cmd` shims. Unix prefix layout otherwise.
    windows: bool,
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn is_explicit_path(program: &str) -> bool {
    Path::new(program).is_absolute() || program.contains('/') || program.contains('\\')
}

fn strip_windows_ext(name: &str) -> &str {
    for ext in [".cmd", ".exe", ".bat", ".CMD", ".EXE", ".BAT"] {
        if let Some(stripped) = name.strip_suffix(ext) {
            return stripped;
        }
    }
    name
}

/// `npx` / `npm`, including a bare `npx.cmd`. Absolute paths are left alone:
/// the user named a file.
fn npm_tool(program: &str) -> Option<&'static str> {
    if is_explicit_path(program) {
        return None;
    }
    let base = Path::new(program)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(program);
    match strip_windows_ext(base) {
        "npx" => Some("npx"),
        "npm" => Some("npm"),
        _ => None,
    }
}

fn executable_names(name: &str, windows: bool) -> Vec<String> {
    if windows {
        // Same order as `teamclu_binpath`: a real exe beats the cmd shim.
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    } else {
        vec![name.to_string()]
    }
}

/// Bare name Rust will search for. On Windows, `Command` appends `.exe` only,
/// so npm's shims have to be spelled `.cmd` or the lookup is "program not
/// found" even when `npx.cmd` is on PATH.
fn bare_spawn_name(name: &str, windows: bool) -> String {
    if windows && matches!(name, "npm" | "npx" | "pnpm" | "yarn") {
        format!("{name}.cmd")
    } else {
        name.to_string()
    }
}

fn find_shim(dir: &Path, name: &str, windows: bool) -> Option<PathBuf> {
    executable_names(name, windows)
        .into_iter()
        .map(|file| dir.join(file))
        .find(|candidate| candidate.is_file())
}

fn launch_for_node(node: &Path, tool: &str, rest: &[String], windows: bool) -> Option<ProbeLaunch> {
    if !node.is_file() {
        return None;
    }
    // `npx_cli_for` / `npm_cli_for` are the production layout (`cfg!(windows)`).
    // Tests pass the other layout explicitly, so both shapes are checked on
    // one OS.
    let cli = if windows == cfg!(windows) {
        if tool == "npm" {
            crate::node_install::npm_cli_for(node)
        } else {
            crate::node_install::npx_cli_for(node)
        }
    } else {
        let file = if tool == "npm" {
            "npm-cli.js"
        } else {
            "npx-cli.js"
        };
        crate::node_install::distribution_cli(node, windows, file)
    };
    if cli.is_file() {
        let mut args = Vec::with_capacity(rest.len() + 1);
        args.push(path_string(&cli));
        args.extend(rest.iter().cloned());
        return Some(ProbeLaunch {
            program: path_string(node),
            args,
            lead: node.parent().map(Path::to_path_buf),
            resolved: true,
        });
    }
    // A Node directory that has the shim but not the unpacked cli (some
    // version-manager shims). An absolute `.cmd` is runnable; Rust wraps it
    // in `cmd.exe`. A bare `npx` is not.
    if let Some(parent) = node.parent() {
        if let Some(shim) = find_shim(parent, tool, windows) {
            return Some(ProbeLaunch {
                program: path_string(&shim),
                args: rest.to_vec(),
                lead: Some(parent.to_path_buf()),
                resolved: true,
            });
        }
    }
    None
}

/// Resolve `argv` without spawning and without `sh`.
///
/// `npx`/`npm` prefer `node <npx-cli.js>`, the same shape as `npm_command`:
/// the managed Node pi runs on, then every other Node `node_candidates`
/// would return, then an absolute shim on the probe PATH. Nothing found
/// leaves the bare platform name so the spawn fails with "program not found"
/// instead of a guessed path.
fn resolve_probe_launch(argv: &[String], sources: &NpxSources) -> ProbeLaunch {
    let Some(program) = argv.first() else {
        return ProbeLaunch {
            program: String::new(),
            args: Vec::new(),
            lead: None,
            resolved: false,
        };
    };
    let rest = &argv[1..];
    if is_explicit_path(program) {
        return ProbeLaunch {
            program: program.clone(),
            args: rest.to_vec(),
            lead: Path::new(program).parent().map(Path::to_path_buf),
            resolved: true,
        };
    }
    if let Some(tool) = npm_tool(program) {
        let nodes = sources
            .managed_node
            .iter()
            .chain(sources.other_nodes.iter());
        for node in nodes {
            if let Some(launch) = launch_for_node(node, tool, rest, sources.windows) {
                return launch;
            }
        }
        for dir in &sources.shim_dirs {
            if let Some(shim) = find_shim(dir, tool, sources.windows) {
                return ProbeLaunch {
                    program: path_string(&shim),
                    args: rest.to_vec(),
                    lead: Some(dir.clone()),
                    resolved: true,
                };
            }
        }
        return ProbeLaunch {
            program: bare_spawn_name(tool, sources.windows),
            args: rest.to_vec(),
            lead: None,
            resolved: false,
        };
    }
    for dir in &sources.shim_dirs {
        if let Some(shim) = find_shim(dir, program, sources.windows) {
            return ProbeLaunch {
                program: path_string(&shim),
                args: rest.to_vec(),
                lead: Some(dir.clone()),
                resolved: true,
            };
        }
    }
    ProbeLaunch {
        program: bare_spawn_name(program, sources.windows),
        args: rest.to_vec(),
        lead: None,
        resolved: false,
    }
}

fn probe_extra_dirs() -> Vec<PathBuf> {
    let mut dirs = crate::runtime::well_known_bin::search_dirs();
    dirs.extend(crate::runtime::well_known_bin::node_manager_dirs());
    dirs
}

fn child_path(lead: Option<&Path>) -> String {
    crate::runtime::spawn_path::mcp_probe_path(
        std::env::var("PATH").ok().as_deref(),
        dirs::home_dir().as_deref(),
        lead,
        &probe_extra_dirs(),
    )
}

fn live_npx_sources() -> NpxSources {
    let managed = crate::node_install::node_binary();
    let managed_node = managed.is_file().then_some(managed);
    let other_nodes = crate::runtime::well_known_bin::node_candidates()
        .into_iter()
        .filter(|path| managed_node.as_ref() != Some(path))
        .collect::<Vec<_>>();
    let mut shim_dirs = Vec::new();
    let inherited = crate::runtime::spawn_path::enriched_spawn_path(
        std::env::var("PATH").ok().as_deref(),
        dirs::home_dir().as_deref(),
    );
    if !inherited.is_empty() {
        shim_dirs.extend(std::env::split_paths(&inherited));
    }
    shim_dirs.extend(probe_extra_dirs());
    if let Some(node) = &managed_node {
        if let Some(parent) = node.parent() {
            shim_dirs.push(parent.to_path_buf());
        }
    }
    for node in &other_nodes {
        if let Some(parent) = node.parent() {
            shim_dirs.push(parent.to_path_buf());
        }
    }
    NpxSources {
        managed_node,
        other_nodes,
        shim_dirs,
        windows: cfg!(windows),
    }
}

/// `command -v` against an explicit PATH. macOS launchd and a systemd unit
/// hand the daemon a PATH that does not contain Homebrew; the shell lookup
/// is what makes a bare name work there. Windows never calls this: `sh` is
/// not part of the install, and Git Bash would turn the PATH into one
/// directory because it splits on `:`.
fn shell_resolve(program: &str, path: &str) -> String {
    let script = format!(
        "PATH={} command -v {}",
        shell_escape(path),
        shell_escape(program)
    );
    let out = match std::process::Command::new("sh")
        .no_window()
        .arg("-lc")
        .arg(&script)
        .output()
    {
        Ok(out) if out.status.success() => out,
        _ => return program.to_string(),
    };
    let resolved = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if resolved.is_empty() {
        program.to_string()
    } else {
        resolved
    }
}

fn resolve_live_probe(argv: &[String]) -> (ProbeLaunch, String) {
    let sources = live_npx_sources();
    let mut launch = resolve_probe_launch(argv, &sources);
    if launch.resolved || cfg!(windows) {
        let path = child_path(launch.lead.as_deref());
        return (launch, path);
    }
    // Unix only: a bare name the file search missed may still be on the
    // enriched PATH via `command -v` (the pre-existing launchd behavior).
    let path = child_path(None);
    let program = shell_resolve(&launch.program, &path);
    if is_explicit_path(&program) {
        launch.lead = Path::new(&program).parent().map(Path::to_path_buf);
        launch.resolved = true;
        launch.program = program;
        let path = child_path(launch.lead.as_deref());
        return (launch, path);
    }
    launch.program = program;
    (launch, path)
}

fn format_spawn_error(err: &std::io::Error) -> String {
    format!("spawn failed: {err}")
}
const CACHE_TTL: Duration = Duration::from_secs(300);
const INITIALIZE_PROTOCOL_VERSION: &str = "2024-11-05";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProbeStatus {
    Skipped,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServerProbeResult {
    pub probe_status: ProbeStatus,
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpToolsResponse {
    pub servers: HashMap<String, McpServerProbeResult>,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    fingerprint: String,
    response: McpToolsResponse,
    stored_at: Instant,
}

static MCP_TOOLS_CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    MCP_TOOLS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Extract tool names from a `tools/list` JSON-RPC response value.
pub fn extract_tool_names(response: &serde_json::Value) -> Vec<String> {
    response
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn config_fingerprint(servers: &HashMap<String, McpServerConfig>) -> String {
    let mut entries: Vec<(&String, &McpServerConfig)> = servers.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    let payload = serde_json::to_vec(&entries).unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    payload.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

pub async fn probe_local_stdio(
    workspace_path: &Path,
    config: &McpServerConfig,
) -> Result<Vec<String>, String> {
    if config.command.is_empty() || config.command.iter().all(|part| part.is_empty()) {
        return Err("no command configured".to_string());
    }

    let (launch, path) = resolve_live_probe(&config.command);
    let mut cmd = Command::new(&launch.program);
    cmd.no_window();
    cmd.args(&launch.args)
        .current_dir(workspace_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let home = dirs::home_dir();
    cmd.env("PATH", path);
    if let Some(home) = home {
        if std::env::var_os("HOME").is_none() {
            cmd.env("HOME", home);
        }
    }
    for (k, v) in &config.environment {
        cmd.env(k, v);
    }

    let mut child = cmd.spawn().map_err(|e| format_spawn_error(&e))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout unavailable".to_string())?;

    let probe_timeout = probe_timeout(config);
    let result = timeout(probe_timeout, mcp_stdio_tools_exchange(stdin, stdout)).await;
    let _ = child.kill().await;

    match result {
        Ok(Ok(tools)) => Ok(tools),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!("timeout after {}s", probe_timeout.as_secs())),
    }
}

async fn write_json_line(stdin: &mut ChildStdin, value: &serde_json::Value) -> Result<(), String> {
    let mut msg = serde_json::to_string(value).map_err(|e| e.to_string())?;
    msg.push('\n');
    stdin
        .write_all(msg.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    stdin.flush().await.map_err(|e| format!("flush: {e}"))
}

async fn read_jsonrpc_response(
    reader: &mut BufReader<ChildStdout>,
    expected_id: u64,
) -> Result<serde_json::Value, String> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("read error: {e}"))?;
        if n == 0 {
            return Err("server closed stdout".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let json: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if let Some(id) = json.get("id") {
            let expected_id_string = expected_id.to_string();
            let matches =
                id.as_u64() == Some(expected_id) || id.as_str() == Some(&expected_id_string);
            if matches {
                return Ok(json);
            }
        }
    }
}

async fn mcp_stdio_tools_exchange(
    mut stdin: ChildStdin,
    stdout: ChildStdout,
) -> Result<Vec<String>, String> {
    let mut reader = BufReader::new(stdout);

    write_json_line(
        &mut stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": INITIALIZE_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "teamclu", "version": "1.0.0" }
            }
        }),
    )
    .await?;
    read_jsonrpc_response(&mut reader, 1).await?;

    write_json_line(
        &mut stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }),
    )
    .await?;

    write_json_line(
        &mut stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }),
    )
    .await?;

    let response = read_jsonrpc_response(&mut reader, 2).await?;
    Ok(extract_tool_names(&response))
}

pub async fn probe_remote_http(config: &McpServerConfig) -> Result<Vec<String>, String> {
    let url = config
        .url
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| "no url configured".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(probe_timeout(config))
        .build()
        .map_err(|e| format!("build client failed: {e}"))?;

    let initialize_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": INITIALIZE_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "teamclu", "version": "1.0.0" }
        }
    });

    let mut initialize_request = client.post(url).json(&initialize_body);
    for (k, v) in &config.headers {
        initialize_request = initialize_request.header(k, v);
    }
    let initialize_response = initialize_request
        .send()
        .await
        .map_err(|e| format!("initialize request failed: {e}"))?;
    if !initialize_response.status().is_success() {
        return Err(format!("initialize HTTP {}", initialize_response.status()));
    }
    let session_id = initialize_response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let initialize_json: serde_json::Value = initialize_response
        .json()
        .await
        .map_err(|e| format!("initialize parse failed: {e}"))?;

    let tools_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    });
    let mut tools_request = client.post(url).json(&tools_body);
    for (k, v) in &config.headers {
        tools_request = tools_request.header(k, v);
    }
    if let Some(ref sid) = session_id {
        tools_request = tools_request.header("mcp-session-id", sid);
    }
    let tools_response = tools_request
        .send()
        .await
        .map_err(|e| format!("tools/list request failed: {e}"))?;
    if !tools_response.status().is_success() {
        return Err(format!("tools/list HTTP {}", tools_response.status()));
    }
    let tools_json: serde_json::Value = tools_response
        .json()
        .await
        .map_err(|e| format!("tools/list parse failed: {e}"))?;

    let mut tool_names = extract_tool_names(&tools_json);
    if tool_names.is_empty() {
        tool_names = extract_tool_names(&initialize_json);
    }
    Ok(tool_names)
}

pub async fn probe_all_servers(
    workspace_path: &Path,
    servers: HashMap<String, McpServerConfig>,
    refresh: bool,
    workspace_id: &str,
) -> McpToolsResponse {
    let fingerprint = config_fingerprint(&servers);
    if !refresh {
        if let Ok(guard) = cache().lock() {
            if let Some(entry) = guard.get(workspace_id) {
                if entry.fingerprint == fingerprint && entry.stored_at.elapsed() < CACHE_TTL {
                    return entry.response.clone();
                }
            }
        }
    }

    let mut output: HashMap<String, McpServerProbeResult> = HashMap::new();
    let mut tasks = Vec::new();

    for (name, config) in servers {
        if config.enabled == Some(false) {
            output.insert(
                name,
                McpServerProbeResult {
                    probe_status: ProbeStatus::Skipped,
                    tools: Vec::new(),
                    error: None,
                    probed_at: None,
                },
            );
            continue;
        }

        let name_cloned = name.clone();
        let workspace = workspace_path.to_path_buf();
        tasks.push(tokio::spawn(async move {
            let result = probe_one_server(&workspace, &config).await;
            (name_cloned, result)
        }));
    }

    for task in tasks {
        if let Ok((name, result)) = task.await {
            output.insert(name, result);
        }
    }

    let response = McpToolsResponse { servers: output };
    if let Ok(mut guard) = cache().lock() {
        guard.insert(
            workspace_id.to_string(),
            CacheEntry {
                fingerprint,
                response: response.clone(),
                stored_at: Instant::now(),
            },
        );
    }
    response
}

async fn probe_one_server(
    workspace_path: &PathBuf,
    config: &McpServerConfig,
) -> McpServerProbeResult {
    let probed_at = chrono::Utc::now().to_rfc3339();
    let transport = if config.server_type.is_empty() {
        "local"
    } else {
        config.server_type.as_str()
    };
    let probe_result = match transport {
        "remote" => probe_remote_http(config).await,
        _ => probe_local_stdio(workspace_path, config).await,
    };
    match probe_result {
        Ok(tools) => McpServerProbeResult {
            probe_status: ProbeStatus::Ready,
            tools,
            error: None,
            probed_at: Some(probed_at),
        },
        Err(error) => McpServerProbeResult {
            probe_status: ProbeStatus::Failed,
            tools: Vec::new(),
            error: Some(error),
            probed_at: Some(probed_at),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_timeout_defaults_to_ten_seconds_and_clamps() {
        assert_eq!(probe_timeout_secs(None), 10);
        assert_eq!(probe_timeout_secs(Some(45)), 45);
        assert_eq!(probe_timeout_secs(Some(0)), 1);
        assert_eq!(probe_timeout_secs(Some(10_000)), 120);
    }

    fn probe_timeout_secs(configured: Option<u64>) -> u64 {
        let config = McpServerConfig {
            server_type: String::new(),
            enabled: None,
            command: Vec::new(),
            environment: HashMap::new(),
            url: None,
            headers: HashMap::new(),
            timeout: configured,
            source: None,
            extra: HashMap::new(),
        };
        probe_timeout(&config).as_secs()
    }

    #[test]
    fn extract_tool_names_from_tools_list_response() {
        let json = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "tools": [
                    { "name": "browser_click", "description": "click" },
                    { "name": "browser_navigate" }
                ]
            }
        });
        assert_eq!(
            extract_tool_names(&json),
            vec!["browser_click".to_string(), "browser_navigate".to_string()]
        );
    }

    #[test]
    fn extract_tool_names_empty_when_missing_result() {
        assert!(extract_tool_names(&serde_json::json!({ "id": 2 })).is_empty());
    }

    fn npx_argv() -> Vec<String> {
        ["npx", "-y", "open-computer-use@1.1.4", "mcp"]
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, b"").unwrap();
    }

    /// Official Windows node zip: `node.exe` and `npx-cli.js` in one directory.
    fn plant_windows_node(dir: &Path) -> PathBuf {
        let node = dir.join("node.exe");
        touch(&node);
        touch(&crate::node_install::distribution_cli(
            &node,
            true,
            "npx-cli.js",
        ));
        node
    }

    /// Unix prefix: `bin/node` and `lib/node_modules/npm/bin/npx-cli.js`.
    fn plant_unix_node(prefix: &Path) -> PathBuf {
        let node = prefix.join("bin").join("node");
        touch(&node);
        touch(&crate::node_install::distribution_cli(
            &node,
            false,
            "npx-cli.js",
        ));
        node
    }

    fn sources(
        managed: Option<PathBuf>,
        others: Vec<PathBuf>,
        shims: Vec<PathBuf>,
        windows: bool,
    ) -> NpxSources {
        NpxSources {
            managed_node: managed,
            other_nodes: others,
            shim_dirs: shims,
            windows,
        }
    }

    #[test]
    fn managed_node_is_preferred_over_system_and_version_managers() {
        let tmp = tempfile::tempdir().unwrap();
        let managed = plant_windows_node(&tmp.path().join("amuxd").join("cache").join("node"));
        let system = plant_windows_node(&tmp.path().join("Program Files").join("nodejs"));
        let fnm = plant_windows_node(
            &tmp.path()
                .join("fnm")
                .join("node-versions")
                .join("v22")
                .join("installation"),
        );
        let launch = resolve_probe_launch(
            &npx_argv(),
            &sources(Some(managed.clone()), vec![system, fnm], vec![], true),
        );
        assert_eq!(launch.program, path_string(&managed));
        assert!(launch.args[0].ends_with("npx-cli.js"), "{}", launch.args[0]);
        assert_eq!(
            &launch.args[1..],
            &[
                "-y".to_string(),
                "open-computer-use@1.1.4".to_string(),
                "mcp".to_string()
            ]
        );
        assert_eq!(launch.lead.as_deref(), managed.parent());
        assert!(launch.resolved);
    }

    #[test]
    fn version_manager_node_is_used_when_no_managed_install_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let nvm = plant_windows_node(&tmp.path().join("AppData").join("nvm").join("v20.18.0"));
        let launch =
            resolve_probe_launch(&npx_argv(), &sources(None, vec![nvm.clone()], vec![], true));
        assert_eq!(launch.program, path_string(&nvm));
        assert!(
            launch.args[0].contains("node_modules"),
            "npx-cli.js, got {}",
            launch.args[0]
        );
        assert_eq!(launch.lead.as_deref(), nvm.parent());
    }

    #[test]
    fn system_nodejs_install_is_used_when_it_is_the_only_node() {
        let tmp = tempfile::tempdir().unwrap();
        let system = plant_windows_node(&tmp.path().join("Program Files").join("nodejs"));
        let launch = resolve_probe_launch(
            &npx_argv(),
            &sources(None, vec![system.clone()], vec![], true),
        );
        assert_eq!(launch.program, path_string(&system));
        assert!(launch.args[0].ends_with("npx-cli.js"), "{}", launch.args[0]);
    }

    #[test]
    fn windows_shim_beside_node_is_used_when_the_cli_is_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("volta").join("bin");
        let node = dir.join("node.exe");
        touch(&node);
        let shim = dir.join("npx.cmd");
        touch(&shim);
        let launch = resolve_probe_launch(&npx_argv(), &sources(None, vec![node], vec![], true));
        assert_eq!(launch.program, path_string(&shim));
        assert_eq!(
            launch.args,
            vec![
                "-y".to_string(),
                "open-computer-use@1.1.4".to_string(),
                "mcp".to_string()
            ]
        );
    }

    #[test]
    fn program_files_shim_is_found_without_a_node_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Program Files").join("nodejs");
        let shim = dir.join("npx.cmd");
        touch(&shim);
        let launch = resolve_probe_launch(&npx_argv(), &sources(None, vec![], vec![dir], true));
        assert_eq!(launch.program, path_string(&shim));
        assert!(launch.resolved);
    }

    #[test]
    fn unix_prefix_node_launches_npx_cli_without_a_bare_name() {
        let tmp = tempfile::tempdir().unwrap();
        let node = plant_unix_node(&tmp.path().join("managed"));
        let launch = resolve_probe_launch(
            &npx_argv(),
            &sources(Some(node.clone()), vec![], vec![], false),
        );
        assert_eq!(launch.program, path_string(&node));
        assert!(
            launch.args[0].ends_with("lib/node_modules/npm/bin/npx-cli.js"),
            "{}",
            launch.args[0]
        );
        assert_eq!(launch.lead.as_deref(), node.parent());
    }

    #[test]
    fn an_explicit_command_path_is_not_rewritten() {
        let tmp = tempfile::tempdir().unwrap();
        let node = plant_windows_node(&tmp.path().join("node"));
        let argv = vec![
            r"C:\sidecar\teamclu-introspect.exe".to_string(),
            "--api-port".to_string(),
            "13144".to_string(),
        ];
        let launch = resolve_probe_launch(&argv, &sources(Some(node), vec![], vec![], true));
        assert_eq!(launch.program, r"C:\sidecar\teamclu-introspect.exe");
        assert_eq!(
            launch.args,
            vec!["--api-port".to_string(), "13144".to_string()]
        );
    }

    #[test]
    fn missing_npx_stays_a_bare_name_and_spawn_reports_not_found() {
        let launch = resolve_probe_launch(&npx_argv(), &sources(None, vec![], vec![], true));
        assert_eq!(launch.program, "npx.cmd");
        assert!(!launch.resolved);
        assert_eq!(
            &launch.args,
            &[
                "-y".to_string(),
                "open-computer-use@1.1.4".to_string(),
                "mcp".to_string()
            ]
        );

        // Windows `Command` also searches the parent process PATH after the
        // child's, so the process PATH has to be empty too — otherwise a
        // machine that really has `npx.cmd` would hide the NotFound. The lock
        // is the one every other test uses while it mutates PATH.
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _path = RestorePath(std::env::var("PATH").ok());
        let empty = tempfile::tempdir().unwrap();
        std::env::set_var("PATH", empty.path());
        let err = std::process::Command::new(&launch.program)
            .env("PATH", empty.path())
            .spawn()
            .expect_err("a bare npx.cmd with an empty PATH is not a program");
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
        let text = format_spawn_error(&err);
        assert!(text.starts_with("spawn failed:"), "{text}");
        if cfg!(windows) {
            assert!(
                text.contains("program not found"),
                "Windows Command::spawn names this lookup failure, got {text}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_shell_lookup_still_resolves_npx_on_a_minimal_path() {
        // `sh` itself is resolved from the process PATH. Another test empties
        // that PATH; without this lock `command -v` never starts.
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let npx = dir.path().join("npx");
        std::fs::write(&npx, b"#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = std::fs::metadata(&npx).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o755);
        std::fs::set_permissions(&npx, perms).unwrap();
        let resolved = shell_resolve("npx", &dir.path().to_string_lossy());
        assert_eq!(resolved, path_string(&npx));
    }

    struct RestorePath(Option<String>);

    impl Drop for RestorePath {
        fn drop(&mut self) {
            match &self.0 {
                Some(value) => std::env::set_var("PATH", value),
                None => std::env::remove_var("PATH"),
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn probe_spawns_the_managed_node_instead_of_a_bare_npx() {
        // PATH and AMUXD_HOME are process-global. The brand guard holds the
        // same lock as the other home movers. PATH is restored by `RestorePath`
        // before that lock drops, including on panic. An empty PATH means a
        // missed resolution cannot fall through to a real `npx` and download.
        let root = tempfile::tempdir().unwrap();
        let _home = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(root.path());
        let _path = RestorePath(std::env::var("PATH").ok());
        let empty = tempfile::tempdir().unwrap();
        std::env::set_var("PATH", empty.path());

        let node = crate::node_install::node_binary();
        let cli = crate::node_install::npx_cli_for(&node);
        if let Some(parent) = node.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(
            &node,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$PROBE_ARGV_FILE\"\nexit 0\n",
        )
        .unwrap();
        let mut perms = std::fs::metadata(&node).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o755);
        std::fs::set_permissions(&node, perms).unwrap();
        touch(&cli);

        let argv_file = root.path().join("argv.txt");
        let workspace = root.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let config = McpServerConfig {
            server_type: "local".to_string(),
            enabled: Some(true),
            command: npx_argv(),
            environment: HashMap::from([("PROBE_ARGV_FILE".to_string(), path_string(&argv_file))]),
            url: None,
            headers: HashMap::new(),
            timeout: Some(5),
            source: None,
            extra: HashMap::new(),
        };
        let (launch, _) = resolve_live_probe(&config.command);
        assert_eq!(
            launch.program,
            path_string(&node),
            "probe must use the managed node"
        );
        assert_eq!(launch.args[0], path_string(&cli));

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt
            .block_on(probe_local_stdio(&workspace, &config))
            .expect_err("the stub node is not an MCP server");
        assert!(
            !err.starts_with("spawn failed"),
            "spawn itself failed: {err}"
        );
        let recorded = std::fs::read_to_string(&argv_file).unwrap_or_default();
        assert!(
            recorded.contains("npx-cli.js"),
            "node was not invoked with npx-cli.js: {recorded}"
        );
        assert!(recorded.contains("open-computer-use@1.1.4"), "{recorded}");
    }

    #[test]
    fn fingerprint_changes_when_server_set_changes() {
        let mut servers = HashMap::new();
        servers.insert(
            "playwright".to_string(),
            McpServerConfig {
                server_type: "local".to_string(),
                enabled: Some(true),
                command: vec!["npx".to_string(), "@playwright/mcp".to_string()],
                environment: HashMap::new(),
                url: None,
                headers: HashMap::new(),
                timeout: None,
                source: None,
                extra: HashMap::new(),
            },
        );
        let fingerprint_1 = config_fingerprint(&servers);

        servers.insert(
            "supabase".to_string(),
            McpServerConfig {
                server_type: "remote".to_string(),
                enabled: Some(true),
                command: Vec::new(),
                environment: HashMap::new(),
                url: Some("https://example.com/mcp".to_string()),
                headers: HashMap::new(),
                timeout: None,
                source: None,
                extra: HashMap::new(),
            },
        );
        let fingerprint_2 = config_fingerprint(&servers);
        assert_ne!(fingerprint_1, fingerprint_2);
    }
}
