use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

const ALLOWED_EXTENSIONS: &[&str] = &[
    "md", "txt", "html", "htm", "csv", "json", "yaml", "yml", "pdf", "docx", "pptx", "xlsx",
];

#[derive(Debug, Clone)]
struct ActiveRun {
    run_id: String,
    team_id: String,
    input_path: PathBuf,
    lock_path: PathBuf,
    requires_cost_acceptance: bool,
}

#[derive(Default)]
pub struct KbMaintainerState {
    active: Mutex<Option<ActiveRun>>,
}

impl KbMaintainerState {
    fn set_active(&self, run: ActiveRun) -> Result<(), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Wiki maintenance state is unavailable".to_string())?;
        if active.is_some() {
            return Err("A Wiki maintenance run is already active on this computer.".to_string());
        }
        *active = Some(run);
        Ok(())
    }

    fn take_for_publish(&self, run_id: &str) -> Result<ActiveRun, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Wiki maintenance state is unavailable".to_string())?;
        let matches = active
            .as_ref()
            .map(|run| run.run_id == run_id)
            .unwrap_or(false);
        if !matches {
            return Err(
                "This Wiki summary is no longer active. Run maintenance again.".to_string(),
            );
        }
        active
            .take()
            .ok_or_else(|| "This Wiki summary is no longer active.".to_string())
    }

    fn clear(&self, run_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            if active
                .as_ref()
                .map(|run| run.run_id == run_id)
                .unwrap_or(false)
            {
                *active = None;
            }
        }
    }

    fn set_requires_cost_acceptance(&self, run_id: &str, required: bool) -> Result<(), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Wiki maintenance state is unavailable".to_string())?;
        let run = active
            .as_mut()
            .filter(|run| run.run_id == run_id)
            .ok_or_else(|| "This Wiki summary is no longer active.".to_string())?;
        run.requires_cost_acceptance = required;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownDocument {
    path: String,
    version: u64,
    size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRequest {
    team_id: String,
    source_directories: Vec<String>,
    acl_prefixes: Vec<String>,
    known: Vec<KnownDocument>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDirectory {
    path: String,
    label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverResponse {
    directories: Vec<SourceDirectory>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareSummary {
    run_id: String,
    source_count: usize,
    #[serde(default)]
    retract_count: usize,
    added: usize,
    updated: usize,
    deleted: usize,
    failed: usize,
    vision_pages: usize,
    estimated_cost: Option<f64>,
    currency: String,
    can_publish: bool,
    blockers: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    sync_status: String,
}

fn safe_team_id(team_id: &str) -> Result<&str, String> {
    let valid = !team_id.is_empty()
        && team_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-');
    valid
        .then_some(team_id)
        .ok_or_else(|| "Invalid team id.".to_string())
}

fn normalize_source_directory(input: &str) -> Result<String, String> {
    let normalized = input.replace('\\', "/");
    if !normalized.starts_with("documents/") {
        return Err("Source folders must be inside team documents.".to_string());
    }
    if normalized
        .split('/')
        .any(|part| part == ".." || part == "." || part.is_empty() && !normalized.ends_with('/'))
    {
        return Err("Source folder contains an unsafe path.".to_string());
    }
    let relative = normalized.trim_start_matches("documents/");
    if relative.is_empty() {
        return Ok("documents/".to_string());
    }
    if relative.split('/').any(|part| {
        matches!(
            part,
            "_secrets" | ".git" | "personnel" | "discipline" | "insurance"
        )
    }) {
        return Err("This folder is protected and cannot be used as a Wiki source.".to_string());
    }
    let mut out = normalized.trim_end_matches('/').to_string();
    out.push('/');
    Ok(out)
}

fn team_paths(team_id: &str) -> Result<(PathBuf, PathBuf), String> {
    let team_id = safe_team_id(team_id)?;
    let shared = super::amuxd_home_dir()
        .join("teams")
        .join(team_id)
        .join("shared")
        .join("team-sync");
    Ok((shared.join("documents"), shared.join("knowledge")))
}

fn first_directory(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let relative = normalized.strip_prefix("documents/")?;
    let first = relative.split('/').next()?;
    if first.is_empty() {
        return None;
    }
    Some(format!("documents/{first}/"))
}

#[tauri::command]
pub async fn kb_maintainer_discover(
    team_id: String,
    known_paths: Vec<String>,
) -> Result<DiscoverResponse, String> {
    let (documents_root, _) = team_paths(&team_id)?;
    let mut paths = BTreeSet::new();
    if documents_root.is_dir() {
        for entry in fs::read_dir(&documents_root)
            .map_err(|e| format!("Cannot inspect team documents: {e}"))?
        {
            let entry = entry.map_err(|e| format!("Cannot inspect team documents: {e}"))?;
            if entry
                .file_type()
                .map_err(|e| format!("Cannot inspect team documents: {e}"))?
                .is_dir()
            {
                let name = entry.file_name().to_string_lossy().to_string();
                paths.insert(format!("documents/{name}/"));
            } else {
                paths.insert("documents/".to_string());
            }
        }
    }
    for known in known_paths {
        if let Some(directory) = first_directory(&known) {
            paths.insert(directory);
        }
    }
    let directories = paths
        .into_iter()
        .filter_map(|path| {
            normalize_source_directory(&path).ok().map(|path| {
                let label = path
                    .trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .unwrap_or("documents")
                    .to_string();
                SourceDirectory { path, label }
            })
        })
        .collect();
    Ok(DiscoverResponse { directories })
}

fn walk_document_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = fs::read_dir(&current)
            .map_err(|e| format!("Cannot inspect team documents: {e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Cannot inspect team documents: {e}"))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|e| format!("Cannot inspect team documents: {e}"))?;
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                out.push(path);
            }
        }
    }
    out.sort();
    Ok(out)
}

fn to_documents_path(documents_root: &Path, abs: &Path) -> Result<String, String> {
    let rel = abs
        .strip_prefix(documents_root)
        .map_err(|_| "Document path escaped the team documents root.".to_string())?;
    let relative = rel
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!("documents/{relative}"))
}

#[tauri::command]
pub async fn kb_maintainer_list_local_documents(
    team_id: String,
    source_directories: Vec<String>,
) -> Result<Vec<String>, String> {
    if source_directories.is_empty() {
        return Err("Choose at least one source folder.".to_string());
    }
    let prefixes: Vec<String> = source_directories
        .iter()
        .map(|path| normalize_source_directory(path))
        .collect::<Result<_, _>>()?;
    let (documents_root, _) = team_paths(&team_id)?;
    let mut paths = BTreeSet::new();
    for abs in walk_document_files(&documents_root)? {
        let documents_path = to_documents_path(&documents_root, &abs)?;
        if prefixes
            .iter()
            .any(|prefix| documents_path.starts_with(prefix.as_str()))
        {
            paths.insert(documents_path);
        }
    }
    Ok(paths.into_iter().collect())
}

#[tauri::command]
pub async fn kb_maintainer_imported_source_paths(team_id: String) -> Result<Vec<String>, String> {
    let root = work_root(&team_id)?;
    let state_path = root.join("state/state.json");
    if !state_path.is_file() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_slice(
        &fs::read(&state_path).map_err(|e| format!("Cannot read Wiki state: {e}"))?,
    )
    .map_err(|e| format!("Invalid Wiki state: {e}"))?;
    let Some(sources) = value.get("sources").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut paths = sources
        .iter()
        .filter_map(|(path, entry)| {
            let status = entry.get("status").and_then(Value::as_str)?;
            (status == "imported").then(|| path.clone())
        })
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn work_root(team_id: &str) -> Result<PathBuf, String> {
    let team_id = safe_team_id(team_id)?;
    let config =
        dirs::config_dir().ok_or_else(|| "No application config directory.".to_string())?;
    Ok(config
        .join(super::home_storage_dir_name())
        .join("kb-maintainer")
        .join(team_id))
}

fn validate_existing_directory(path: &Path, expected_parent: &Path) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Required team folder is unavailable: {e}"))?;
    let parent = expected_parent
        .canonicalize()
        .map_err(|e| format!("Team sync folder is unavailable: {e}"))?;
    if !canonical.starts_with(parent) {
        return Err("Team folder escaped the local team sync root.".to_string());
    }
    Ok(())
}

fn script_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("scripts/kb-maintainer/desktop-runner.js");
    if cfg!(debug_assertions) && development.is_file() {
        return Ok(development);
    }
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot locate application resources: {e}"))?
        .join("kb-maintainer/desktop-runner.js");
    resource
        .is_file()
        .then_some(resource)
        .ok_or_else(|| "Wiki maintenance resources are missing from this build.".to_string())
}

fn node_path() -> Result<PathBuf, String> {
    let lock: Value = serde_json::from_str(include_str!("../../../daemon/pi.lock.json"))
        .map_err(|e| format!("Invalid bundled Node lock: {e}"))?;
    let version = lock
        .get("node")
        .and_then(Value::as_str)
        .ok_or_else(|| "Bundled Node version is missing.".to_string())?;
    let binary = super::amuxd_home_dir()
        .join("cache/node")
        .join(version)
        .join(if cfg!(windows) {
            "node.exe"
        } else {
            "bin/node"
        });
    binary.is_file().then_some(binary).ok_or_else(|| {
        "The managed Agent runtime is not installed. Finish local Agent setup, then try again."
            .to_string()
    })
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid Wiki maintenance path.".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Cannot create Wiki work folder: {e}"))?;
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| format!("Cannot encode Wiki input: {e}"))?;
    fs::write(path, bytes).map_err(|e| format!("Cannot write Wiki input: {e}"))
}

fn process_is_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

fn acquire_run_lock(path: &Path) -> Result<(), String> {
    let create = || {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| error.kind())?;
        write!(file, "{{\"pid\":{}}}", std::process::id())
            .map_err(|_| std::io::ErrorKind::Other)?;
        Ok::<(), std::io::ErrorKind>(())
    };
    match create() {
        Ok(()) => Ok(()),
        Err(std::io::ErrorKind::AlreadyExists) => {
            let owner = fs::read_to_string(path)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|value| value.get("pid").and_then(Value::as_u64))
                .and_then(|pid| u32::try_from(pid).ok());
            if owner.map(process_is_alive).unwrap_or(false) {
                return Err(
                    "A Wiki maintenance run is already active on this computer.".to_string()
                );
            }
            fs::remove_file(path)
                .map_err(|_| "The previous Wiki run lock could not be recovered.".to_string())?;
            create().map_err(|_| {
                "A Wiki maintenance run is already active on this computer.".to_string()
            })
        }
        Err(_) => Err("Cannot create the Wiki maintenance run lock.".to_string()),
    }
}

fn humanize_compiler_error(stderr: &str) -> String {
    if stderr.contains("whitelist intersects restricted documents ACL") {
        return "A selected source folder is restricted. Choose only folders visible to the whole team."
            .to_string();
    }
    if stderr.contains("knowledge/_schema.md is missing")
        || stderr.contains("knowledge/_schema.md is empty")
    {
        return "Set up the team knowledge base before maintaining Wiki.".to_string();
    }
    if stderr.contains("ACL state unknown") {
        return "Team folder permissions could not be verified. Check your connection and try again."
            .to_string();
    }
    if stderr.contains("vision estimate") || stderr.contains("vision is unavailable") {
        return "Some pages need visual recognition. Review the estimated cost before continuing."
            .to_string();
    }
    if (stderr.contains("unpublished external content") || stderr.contains("already has files")) {
        return "Team Wiki already has older pages. Run maintenance again, then publish to replace them."
            .to_string();
    }
    if (stderr.contains("publish destination changed") || stderr.contains("unexplained vault edits")
        || stderr.contains("modified externally"))
    {
        return "Wiki changed after this run started. Run maintenance again before publishing."
            .to_string();
    }
    if stderr.contains("Team AI gateway") {
        return gateway_unavailable();
    }
    if stderr.contains("managed Agent runtime is not installed") {
        return "The managed Agent runtime is not installed. Finish local Agent setup, then try again."
            .to_string();
    }
    stderr
        .lines()
        .find_map(|line| line.trim().strip_prefix("Error: "))
        .filter(|line| !line.is_empty())
        .unwrap_or("Wiki maintenance stopped unexpectedly.")
        .to_string()
}

fn gateway_unavailable() -> String {
    "Team AI is not available. Open a team session once, then maintain Wiki again.".to_string()
}

fn gateway_from_disk_team(team: &Value) -> Result<(String, String), String> {
    let token = team
        .get("options")
        .and_then(|options| options.get("apiKey"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .filter(|key| !key.contains("${"))
        .filter(|key| !key.starts_with(teamclu_runtime_env::LEGACY_VIRTUAL_KEY_PREFIX))
        .ok_or_else(gateway_unavailable)?
        .to_string();
    let provider = teamclu_runtime_env::managed_llm_provider_from_disk_team(team)
        .ok_or_else(gateway_unavailable)?;
    Ok((
        teamclu_runtime_env::team_provider_env_payload(&provider, None),
        token,
    ))
}

fn load_team_gateway() -> Result<(String, String), String> {
    let team = teamclu_runtime_env::read_global_team_provider().ok_or_else(gateway_unavailable)?;
    gateway_from_disk_team(&team)
}

async fn run_node(
    app: &tauri::AppHandle,
    command: &str,
    input_path: &Path,
    gateway: Option<&(String, String)>,
) -> Result<Value, String> {
    let node = node_path()?;
    let script = script_path(app)?;
    let command = command.to_string();
    let input_path = input_path.to_path_buf();
    let amuxd_home = super::amuxd_home_dir();
    let gateway = gateway.cloned();
    let app = app.clone();

    tokio::task::spawn_blocking(move || {
        let mut cmd = StdCommand::new(node);
        cmd.arg(&script)
            .arg(&command)
            .arg(&input_path)
            .env(teamclu_runtime_env::AMUXD_HOME_ENV, amuxd_home)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some((payload, token)) = gateway.as_ref() {
            cmd.env("TEAMCLU_TEAM_PROVIDER", payload)
                .env("tc_gateway_token", token);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Cannot start Wiki compiler: {e}"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Wiki compiler stderr is unavailable.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Wiki compiler stdout is unavailable.".to_string())?;

        let progress_app = app.clone();
        let stderr_thread = thread::spawn(move || {
            let mut other = String::new();
            for line in BufReader::new(stderr).lines().flatten() {
                if let Some(payload) = line.strip_prefix("KB_PROGRESS ") {
                    if let Ok(value) = serde_json::from_str::<Value>(payload) {
                        let _ = progress_app.emit("kb-maintainer:progress", value);
                        continue;
                    }
                }
                if !other.is_empty() {
                    other.push('\n');
                }
                other.push_str(&line);
            }
            other
        });

        let stdout_text = {
            let mut buf = String::new();
            for line in BufReader::new(stdout).lines().flatten() {
                if !buf.is_empty() {
                    buf.push('\n');
                }
                buf.push_str(&line);
            }
            buf
        };
        let status = child
            .wait()
            .map_err(|e| format!("Wiki compiler stopped unexpectedly: {e}"))?;
        let stderr_text = stderr_thread
            .join()
            .unwrap_or_else(|_| "Wiki compiler stderr reader failed.".to_string());

        if !status.success() {
            let stderr = stderr_text.trim();
            return Err(if stderr.is_empty() {
                "Wiki compiler stopped unexpectedly.".to_string()
            } else {
                humanize_compiler_error(stderr)
            });
        }
        let line = stdout_text
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .ok_or_else(|| "Wiki compiler returned no result.".to_string())?;
        serde_json::from_str(line).map_err(|e| format!("Invalid Wiki compiler result: {e}"))
    })
    .await
    .map_err(|e| format!("Wiki compiler task failed: {e}"))?
}

#[tauri::command]
pub async fn kb_maintainer_prepare(
    app: tauri::AppHandle,
    state: tauri::State<'_, KbMaintainerState>,
    request: PrepareRequest,
) -> Result<PrepareSummary, String> {
    if request.source_directories.is_empty() {
        return Err("Choose at least one source folder.".to_string());
    }
    let sources: Vec<String> = request
        .source_directories
        .iter()
        .map(|path| normalize_source_directory(path))
        .collect::<Result<_, _>>()?;
    let (documents_root, knowledge_root) = team_paths(&request.team_id)?;
    validate_existing_directory(&documents_root, &documents_root)?;
    validate_existing_directory(&knowledge_root, &knowledge_root)?;
    let gateway = load_team_gateway()?;

    let root = work_root(&request.team_id)?;
    fs::create_dir_all(root.join("state"))
        .map_err(|e| format!("Cannot create Wiki work folder: {e}"))?;
    let lock_path = root.join("state/run.lock");
    let run_id = uuid::Uuid::new_v4().to_string();
    let node_id = gethostname::gethostname().to_string_lossy().to_string();
    let config_path = root.join("config.json");
    let input_path = root.join(format!("state/run-{run_id}.json"));
    state.set_active(ActiveRun {
        run_id: run_id.clone(),
        team_id: request.team_id.clone(),
        input_path: input_path.clone(),
        lock_path: lock_path.clone(),
        requires_cost_acceptance: false,
    })?;
    if let Err(error) = acquire_run_lock(&lock_path) {
        state.clear(&run_id);
        return Err(error);
    }
    let config = json!({
        "schemaVersion": 1,
        "teamId": request.team_id,
        "maintainerNodeId": node_id,
        "sources": sources.iter().enumerate().map(|(index, prefix)| json!({
            "prefix": prefix,
            "class": "process",
            "priority": index + 1,
            "allowExtensions": ALLOWED_EXTENSIONS,
        })).collect::<Vec<_>>(),
        "deny": { "pathPatterns": [
            "**/_secrets/**", "**/personnel/**", "**/discipline/**", "**/insurance/**"
        ]},
        "models": { "compiler": "default", "vision": "", "visionPagePrice": 0.12, "currency": "CNY" }
    });
    if let Err(error) = write_json(&config_path, &config) {
        let _ = fs::remove_file(&lock_path);
        state.clear(&run_id);
        return Err(error);
    }
    let input = json!({
        "runId": run_id,
        "configPath": config_path,
        "statePath": root.join("state/state.json"),
        "documentsRoot": documents_root,
        "knowledgeRoot": knowledge_root,
        "workRoot": root,
        "nodeId": node_id,
        "aclPrefixes": request.acl_prefixes,
        "known": request.known.into_iter().map(|item| json!({
            "path": item.path, "version": item.version, "size": item.size
        })).collect::<Vec<_>>()
    });
    if let Err(error) = write_json(&input_path, &input) {
        let _ = fs::remove_file(&lock_path);
        state.clear(&run_id);
        return Err(error);
    }

    let result = run_node(&app, "prepare", &input_path, Some(&gateway)).await;
    let summary: PrepareSummary = match result {
        Ok(value) => match serde_json::from_value(value) {
            Ok(summary) => summary,
            Err(error) => {
                let _ = fs::remove_file(&lock_path);
                state.clear(&run_id);
                return Err(format!("Invalid Wiki summary: {error}"));
            }
        },
        Err(error) => {
            let _ = fs::remove_file(&lock_path);
            state.clear(&run_id);
            return Err(error);
        }
    };
    if !summary.can_publish {
        let _ = fs::remove_file(lock_path);
        let _ = fs::remove_file(input_path);
        state.clear(&run_id);
    } else {
        state.set_requires_cost_acceptance(
            &run_id,
            summary.estimated_cost.unwrap_or_default() > 0.0,
        )?;
    }
    Ok(summary)
}

#[tauri::command]
pub async fn kb_maintainer_publish(
    app: tauri::AppHandle,
    state: tauri::State<'_, KbMaintainerState>,
    run_id: String,
    accept_vision_cost: bool,
) -> Result<PublishResult, String> {
    let run = state.take_for_publish(&run_id)?;
    if run.requires_cost_acceptance && !accept_vision_cost {
        let _ = state.set_active(run);
        return Err("Confirm the estimated visual recognition cost before publishing.".to_string());
    }
    let publish = run_node(&app, "publish", &run.input_path, None).await;
    if let Err(error) = publish {
        let _ = state.set_active(run);
        return Err(error);
    }
    let sync_status = match super::team_sync_proxy::daemon_team_sync(None, true, false).await {
        Ok(_) => "synced",
        Err(_) => "published_local_sync_pending",
    };
    let _ = fs::remove_file(&run.lock_path);
    let _ = fs::remove_file(&run.input_path);
    let _ = run.team_id;
    state.clear(&run_id);
    Ok(PublishResult {
        sync_status: sync_status.to_string(),
    })
}

#[tauri::command]
pub async fn kb_maintainer_cancel(
    state: tauri::State<'_, KbMaintainerState>,
    run_id: String,
) -> Result<(), String> {
    let run = state.take_for_publish(&run_id)?;
    let _ = fs::remove_file(run.lock_path);
    let _ = fs::remove_file(run.input_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_directories_are_normalized_under_documents() {
        assert_eq!(
            normalize_source_directory("documents/handbook/").unwrap(),
            "documents/handbook/"
        );
        assert!(normalize_source_directory("../secrets").is_err());
        assert!(normalize_source_directory("knowledge/wiki").is_err());
        assert!(normalize_source_directory("documents/_secrets/").is_err());
    }

    #[test]
    fn documents_path_stays_under_documents_root() {
        let root = PathBuf::from("/tmp/team/documents");
        let abs = root.join("handbook").join("leave.md");
        assert_eq!(
            to_documents_path(&root, &abs).unwrap(),
            "documents/handbook/leave.md"
        );
        assert!(to_documents_path(&root, Path::new("/tmp/elsewhere/a.md")).is_err());
    }

    #[test]
    fn publish_stage_cannot_be_skipped_or_replayed() {
        let state = KbMaintainerState::default();
        let run = ActiveRun {
            run_id: "run-1".into(),
            team_id: "team-1".into(),
            input_path: std::path::PathBuf::from("/tmp/input.json"),
            lock_path: std::path::PathBuf::from("/tmp/lock"),
            requires_cost_acceptance: false,
        };
        state.set_active(run).unwrap();
        assert!(state.take_for_publish("wrong-run").is_err());
        assert!(state.take_for_publish("run-1").is_ok());
        assert!(state.take_for_publish("run-1").is_err());
    }

    fn disk_team(api_key: &str) -> Value {
        json!({
            "name": "Team",
            "options": {
                "baseURL": "http://127.0.0.1:43111/ai/v1/teams/abc",
                "apiKey": api_key
            },
            "models": {
                "default": { "name": "default" },
                "max": { "name": "max" }
            }
        })
    }

    #[test]
    fn compiler_errors_are_presented_without_pipeline_terms() {
        assert_eq!(
            humanize_compiler_error(
                "Error: whitelist intersects restricted documents ACL: documents/hr/"
            ),
            "A selected source folder is restricted. Choose only folders visible to the whole team."
        );
        assert_eq!(
            humanize_compiler_error("Error: knowledge/_schema.md is missing\n at dryRun"),
            "Set up the team knowledge base before maintaining Wiki."
        );
        assert_eq!(
            humanize_compiler_error(
                "Error: Team AI gateway is not available. Open a team session once, then maintain Wiki again.\n    at loadTeamGateway"
            ),
            "Team AI is not available. Open a team session once, then maintain Wiki again."
        );
        assert_eq!(
            humanize_compiler_error(
                "Error: The managed Agent runtime is not installed. Finish local Agent setup, then try again."
            ),
            "The managed Agent runtime is not installed. Finish local Agent setup, then try again."
        );
    }

    #[test]
    fn gateway_token_comes_from_resolved_provider_team() {
        let (payload, token) = gateway_from_disk_team(&disk_team("tok_live_ai_invoke")).unwrap();
        assert_eq!(token, "tok_live_ai_invoke");
        let parsed: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(
            parsed["baseUrl"],
            "http://127.0.0.1:43111/ai/v1/teams/abc"
        );
        assert_eq!(parsed["apiKeyEnv"], "tc_gateway_token");
        assert_eq!(parsed["models"][0]["id"], "default");
        assert!(!payload.contains("tok_live_ai_invoke"));
    }

    #[test]
    fn gateway_token_rejects_placeholder_and_legacy_virtual_keys() {
        assert!(gateway_from_disk_team(&disk_team("${tc_gateway_token}")).is_err());
        assert!(gateway_from_disk_team(&disk_team("sk-tc-actor-leftover")).is_err());
        assert!(gateway_from_disk_team(&disk_team("")).is_err());
    }

    #[test]
    fn run_lock_recovers_after_a_crash_but_rejects_a_live_owner() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("run.lock");
        fs::write(&lock, b"").unwrap();
        acquire_run_lock(&lock).unwrap();
        assert!(acquire_run_lock(&lock).is_err());
    }
}
