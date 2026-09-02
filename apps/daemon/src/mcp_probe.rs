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

/// MCP configs commonly say "npx"/"npm"; those are .cmd shims on Windows.
/// One rule for the whole daemon lives in `well_known_bin::spawn_name`.
fn platform_program(program: &str) -> String {
    crate::runtime::well_known_bin::spawn_name(program)
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Resolve bare command names (e.g. `npx`) against the enriched PATH used for
/// agent spawns. launchd keeps a minimal PATH, so a direct `Command::new("npx")`
/// fails with ENOENT even after PATH enrichment on some macOS setups.
fn resolve_spawn_program(program: &str) -> String {
    let program = platform_program(program);
    if program.contains('/') {
        return program;
    }
    let path = crate::runtime::adapter::enriched_spawn_path(
        std::env::var("PATH").ok().as_deref(),
        dirs::home_dir().as_deref(),
    );
    let script = format!(
        "PATH={} command -v {}",
        shell_escape(&path),
        shell_escape(&program)
    );
    let out = match std::process::Command::new("sh")
        .no_window()
        .arg("-lc")
        .arg(&script)
        .output()
    {
        Ok(out) if out.status.success() => out,
        _ => return program,
    };
    let resolved = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if resolved.is_empty() {
        program
    } else {
        resolved
    }
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
    let command = config
        .command
        .first()
        .ok_or_else(|| "no command configured".to_string())?;
    if config.command.is_empty() {
        return Err("empty command".to_string());
    }

    let spawn_bin = resolve_spawn_program(command);
    let mut cmd = Command::new(&spawn_bin);
    cmd.no_window();
    cmd.args(&config.command[1..])
        .current_dir(workspace_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let home = dirs::home_dir();
    cmd.env(
        "PATH",
        crate::runtime::adapter::enriched_spawn_path(
            std::env::var("PATH").ok().as_deref(),
            home.as_deref(),
        ),
    );
    if let Some(home) = home {
        if std::env::var_os("HOME").is_none() {
            cmd.env("HOME", home);
        }
    }
    for (k, v) in &config.environment {
        cmd.env(k, v);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout unavailable".to_string())?;

    let result = timeout(PROBE_TIMEOUT, mcp_stdio_tools_exchange(stdin, stdout)).await;
    let _ = child.kill().await;

    match result {
        Ok(Ok(tools)) => Ok(tools),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!("timeout after {}s", PROBE_TIMEOUT.as_secs())),
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
        .timeout(PROBE_TIMEOUT)
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

    #[test]
    fn resolve_spawn_program_finds_npx_on_minimal_path() {
        // `PATH` is process-global, and ~1260 tests share this process. While
        // it is narrowed here, any concurrent test that spawns a program by
        // name gets `NotFound` — which is how this one took down
        // `managed_skill_three_runtime`'s `node` spawn on CI. Same lock as the
        // `HOME` / `AMUXD_HOME` movers: one mutex for process-global path
        // resolution, whichever variable is doing the resolving.
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var("PATH").ok();
        unsafe {
            std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        }
        let resolved = resolve_spawn_program("npx");
        if let Some(prev) = previous {
            unsafe {
                std::env::set_var("PATH", prev);
            }
        }
        assert!(
            resolved.ends_with("npx") || resolved.ends_with("npx.cmd"),
            "expected npx path, got {resolved}"
        );
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
