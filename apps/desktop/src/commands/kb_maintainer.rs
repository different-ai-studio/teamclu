use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

const ALLOWED_EXTENSIONS: &[&str] = &[
    "md", "txt", "html", "htm", "csv", "json", "yaml", "yml", "pdf", "docx", "pptx", "xlsx", "png",
    "jpg", "jpeg", "webp",
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
    #[serde(default)]
    expected_generation: u64,
    #[serde(default = "default_config_version")]
    config_version: u64,
    #[serde(default)]
    compiler_model: Option<String>,
    acl_prefixes: Vec<String>,
    known: Vec<KnownDocument>,
    #[serde(default)]
    vision_choice: Option<String>,
}

fn default_config_version() -> u64 {
    1
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
    node_id: String,
    base_tree_hash: Option<String>,
    target_commit: String,
    target_tree_hash: String,
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
    #[serde(default)]
    needs_vision_acceptance: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    sync_status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointUploadRequest {
    team_id: String,
    checkpoint_path: PathBuf,
    url: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRestoreRequest {
    team_id: String,
    url: String,
    sha256: String,
    size: u64,
    published_commit: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCheckpointStatus {
    generation: u64,
    manifest: Option<Value>,
    published_commit: Option<String>,
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
        return Err(
            "Files placed directly in Documents are not a Wiki source. Choose a folder inside Documents."
                .to_string(),
        );
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
    let mut parts = relative.split('/');
    let first = parts.next()?;
    let nested = parts.next().is_some();
    if !nested || first.is_empty() || first == "." || first == ".." {
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
                if !name.is_empty() && name != "." && name != ".." {
                    paths.insert(format!("documents/{name}/"));
                }
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
        let entries =
            fs::read_dir(&current).map_err(|e| format!("Cannot inspect team documents: {e}"))?;
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

fn validate_checkpoint_file_path(work_root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let checkpoints = work_root.join("state/checkpoints");
    let allowed = checkpoints
        .canonicalize()
        .map_err(|e| format!("Wiki checkpoint folder is unavailable: {e}"))?;
    let candidate = candidate
        .canonicalize()
        .map_err(|e| format!("Wiki checkpoint is unavailable: {e}"))?;
    if !candidate.is_file() || !candidate.starts_with(&allowed) {
        return Err("Wiki checkpoint path escaped the team work folder.".to_string());
    }
    Ok(candidate)
}

fn validate_checkpoint_url(input: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(input).map_err(|_| "Invalid Wiki checkpoint URL.".to_string())?;
    let local_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    if url.scheme() != "https" && !local_http {
        return Err("Wiki checkpoint URL must use HTTPS.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Wiki checkpoint URL must not contain credentials.".to_string());
    }
    Ok(url)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_checkpoint_bytes(
    bytes: &[u8],
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    if bytes.len() as u64 != expected_size {
        return Err("Wiki checkpoint size did not match the Cloud API.".to_string());
    }
    if sha256_hex(bytes) != expected_sha256 {
        return Err("Wiki checkpoint hash did not match the Cloud API.".to_string());
    }
    Ok(())
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
    if stderr.contains("unpublished external content") || stderr.contains("already has files") {
        return "Team Wiki already has older pages. Run maintenance again, then publish to replace them."
            .to_string();
    }
    if stderr.contains("publish destination changed")
        || stderr.contains("unexplained vault edits")
        || stderr.contains("modified externally")
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
    if stderr.contains("source prefix escape is not allowed")
        || stderr.contains("Files placed directly in Documents")
    {
        return "Files placed directly in Documents are not a Wiki source. Choose a folder inside Documents."
            .to_string();
    }
    if stderr.contains("Upgrade TeamClu") {
        return "Upgrade TeamClu to restore this Wiki checkpoint.".to_string();
    }
    if stderr.contains("maintenance cancelled") {
        return "Wiki maintenance was cancelled. The unfinished source was discarded.".to_string();
    }
    if stderr.contains("missing sources") {
        return "Some published Wiki pages do not cite a source. Fix those pages before adopting the Wiki."
            .to_string();
    }
    if stderr.contains("quality check failed")
        || stderr.contains("dead wiki link")
        || stderr.contains("did not retract")
        || stderr.contains("compiler produced no wiki pages")
    {
        return "This Wiki compile needs another maintenance run before it can be published."
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

/// Bare ids and `team/…` compile through the team gateway. Any other
/// `provider/model` uses the model the user already signed in on this computer.
fn compiler_uses_team_gateway(model: &str) -> bool {
    let model = model.trim();
    if model.is_empty() || model == "default" {
        return true;
    }
    match model.split_once('/') {
        Some((provider, id)) if !provider.is_empty() && !id.is_empty() => provider == "team",
        _ => true,
    }
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
        let pid_path = input_path.with_file_name("compiler.pid");
        let _ = fs::write(&pid_path, child.id().to_string());
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
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
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
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
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

        let _ = fs::remove_file(&pid_path);
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
pub async fn kb_maintainer_upload_checkpoint(
    request: CheckpointUploadRequest,
) -> Result<(), String> {
    let root = work_root(&request.team_id)?;
    let checkpoint = validate_checkpoint_file_path(&root, &request.checkpoint_path)?;
    let url = validate_checkpoint_url(&request.url)?;
    tokio::task::spawn_blocking(move || {
        let bytes =
            fs::read(checkpoint).map_err(|e| format!("Cannot read Wiki checkpoint: {e}"))?;
        validate_checkpoint_bytes(&bytes, request.size, &request.sha256)?;
        reqwest::blocking::Client::new()
            .put(url)
            .body(bytes)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|e| format!("Cannot upload Wiki checkpoint: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Wiki checkpoint upload task failed: {e}"))?
}

#[tauri::command]
pub async fn kb_maintainer_ack_checkpoint(
    team_id: String,
    generation: u64,
    accepted: bool,
    manifest: Option<Value>,
) -> Result<(), String> {
    let root = work_root(&team_id)?;
    if accepted {
        let manifest = manifest
            .ok_or_else(|| "Accepted Wiki checkpoint is missing its manifest.".to_string())?;
        if manifest.get("generation").and_then(Value::as_u64) != Some(generation)
            || manifest.get("teamId").and_then(Value::as_str) != Some(team_id.as_str())
        {
            return Err("Wiki checkpoint acknowledgement does not match its manifest.".to_string());
        }
        write_json(&root.join("state/checkpoint-manifest.json"), &manifest)?;
    }
    let path = root
        .join("state")
        .join(format!("checkpoint-ack-{generation}.json"));
    write_json(&path, &json!({ "accepted": accepted }))
}

#[tauri::command]
pub async fn kb_maintainer_local_checkpoint_status(
    team_id: String,
) -> Result<LocalCheckpointStatus, String> {
    let root = work_root(&team_id)?;
    let published_commit = fs::read(root.join("state/state.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|state| {
            state
                .get("publishedCommit")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let path = root.join("state/checkpoint-manifest.json");
    if !path.is_file() {
        return Ok(LocalCheckpointStatus {
            generation: 0,
            manifest: None,
            published_commit,
        });
    }
    let manifest: Value = serde_json::from_slice(
        &fs::read(path).map_err(|e| format!("Cannot read local Wiki checkpoint: {e}"))?,
    )
    .map_err(|e| format!("Invalid local Wiki checkpoint: {e}"))?;
    let generation = manifest
        .get("generation")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Local Wiki checkpoint has no generation.".to_string())?;
    Ok(LocalCheckpointStatus {
        generation,
        manifest: Some(manifest),
        published_commit,
    })
}

#[tauri::command]
pub async fn kb_maintainer_recovered_summary(
    team_id: String,
) -> Result<Option<PrepareSummary>, String> {
    let path = work_root(&team_id)?.join("state/prepared-run.json");
    if !path.is_file() {
        return Ok(None);
    }
    let summary = serde_json::from_slice(
        &fs::read(path).map_err(|e| format!("Cannot read recovered Wiki summary: {e}"))?,
    )
    .map_err(|e| format!("Invalid recovered Wiki summary: {e}"))?;
    Ok(Some(summary))
}

#[tauri::command]
pub async fn kb_maintainer_restore_checkpoint(
    app: tauri::AppHandle,
    request: CheckpointRestoreRequest,
) -> Result<Value, String> {
    let root = work_root(&request.team_id)?;
    fs::create_dir_all(root.join("state/checkpoints"))
        .map_err(|e| format!("Cannot create Wiki checkpoint folder: {e}"))?;
    let url = validate_checkpoint_url(&request.url)?;
    let package_path = root
        .join("state/checkpoints")
        .join(format!("download-{}.zip", request.sha256));
    let package_for_download = package_path.clone();
    let expected_size = request.size;
    let expected_sha256 = request.sha256.clone();
    let expected_team_id = request.team_id.clone();
    tokio::task::spawn_blocking(move || {
        let response = reqwest::blocking::Client::new()
            .get(url)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|e| format!("Cannot download Wiki checkpoint: {e}"))?;
        let bytes = response
            .bytes()
            .map_err(|e| format!("Cannot read Wiki checkpoint download: {e}"))?;
        validate_checkpoint_bytes(&bytes, expected_size, &expected_sha256)?;
        fs::write(package_for_download, &bytes)
            .map_err(|e| format!("Cannot save Wiki checkpoint: {e}"))
    })
    .await
    .map_err(|e| format!("Wiki checkpoint download task failed: {e}"))??;

    let input_path = root.join("state/restore-input.json");
    write_json(
        &input_path,
        &json!({
            "teamId": request.team_id,
            "workRoot": root,
            "checkpointPath": package_path,
            "publishedCommit": request.published_commit,
        }),
    )?;
    let result = run_node(&app, "restore", &input_path, None).await;
    let _ = fs::remove_file(input_path);
    let _ = fs::remove_file(package_path);
    let manifest = result?;
    if manifest.get("teamId").and_then(Value::as_str) != Some(expected_team_id.as_str()) {
        return Err("Wiki checkpoint belongs to another team.".to_string());
    }
    Ok(manifest)
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
    let compiler_model = request
        .compiler_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .ok_or_else(|| "Choose a compiler model.".to_string())?
        .to_string();
    let (documents_root, knowledge_root) = team_paths(&request.team_id)?;
    validate_existing_directory(&documents_root, &documents_root)?;
    validate_existing_directory(&knowledge_root, &knowledge_root)?;
    let gateway = if compiler_uses_team_gateway(&compiler_model) {
        Some(load_team_gateway()?)
    } else {
        None
    };

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
        "sources": sources.iter().enumerate().map(|(index, prefix)| json!({
            "prefix": prefix,
            "class": "process",
            "priority": index + 1,
            "allowExtensions": ALLOWED_EXTENSIONS,
        })).collect::<Vec<_>>(),
        "deny": { "pathPatterns": [
            "**/_secrets/**", "**/personnel/**", "**/discipline/**", "**/insurance/**"
        ]},
        "models": { "compiler": compiler_model, "vision": "", "visionPagePrice": 0.12, "currency": "CNY" }
    });
    if let Err(error) = write_json(&config_path, &config) {
        let _ = fs::remove_file(&lock_path);
        state.clear(&run_id);
        return Err(error);
    }
    let input = json!({
        "runId": run_id,
        "expectedGeneration": request.expected_generation,
        "configVersion": request.config_version,
        "configPath": config_path,
        "statePath": root.join("state/state.json"),
        "documentsRoot": documents_root,
        "knowledgeRoot": knowledge_root,
        "workRoot": root,
        "nodeId": node_id,
        "compilerModel": compiler_model,
        "aclPrefixes": request.acl_prefixes,
        "known": request.known.into_iter().map(|item| json!({
            "path": item.path, "version": item.version, "size": item.size
        })).collect::<Vec<_>>(),
        "visionChoice": request.vision_choice.unwrap_or_else(|| "ask".to_string()),
    });
    if let Err(error) = write_json(&input_path, &input) {
        let _ = fs::remove_file(&lock_path);
        state.clear(&run_id);
        return Err(error);
    }

    let _ = fs::remove_file(root.join("state/cancel-requested"));
    let result = run_node(&app, "prepare", &input_path, gateway.as_ref()).await;
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
        state.set_requires_cost_acceptance(&run_id, false)?;
    }
    Ok(summary)
}

#[tauri::command]
pub async fn kb_maintainer_publish(
    app: tauri::AppHandle,
    state: tauri::State<'_, KbMaintainerState>,
    team_id: Option<String>,
    run_id: String,
    accept_vision_cost: bool,
    cloud_publishing_recovery: bool,
    target_commit: String,
    target_tree_hash: String,
    base_tree_hash: Option<String>,
) -> Result<PublishResult, String> {
    let run = match state.take_for_publish(&run_id) {
        Ok(run) => run,
        Err(original) => {
            let Some(team_id) = team_id else {
                return Err(original);
            };
            let root = work_root(&team_id)?;
            let prepared_path = root.join("state/prepared-run.json");
            let prepared: PrepareSummary = serde_json::from_slice(
                &fs::read(&prepared_path)
                    .map_err(|_| "No recovered Wiki summary is available.".to_string())?,
            )
            .map_err(|e| format!("Invalid recovered Wiki summary: {e}"))?;
            if prepared.run_id != run_id || !prepared.can_publish {
                return Err("The recovered Wiki summary is not publishable.".to_string());
            }
            let (_, knowledge_root) = team_paths(&team_id)?;
            let lock_path = root.join("state/run.lock");
            acquire_run_lock(&lock_path)?;
            let input_path = root.join(format!("state/recovered-publish-{run_id}.json"));
            if let Err(error) = write_json(
                &input_path,
                &json!({
                    "configPath": root.join("config.json"),
                    "statePath": root.join("state/state.json"),
                    "knowledgeRoot": knowledge_root,
                    "workRoot": root,
                }),
            ) {
                let _ = fs::remove_file(&lock_path);
                return Err(error);
            }
            ActiveRun {
                run_id: run_id.clone(),
                team_id,
                input_path,
                lock_path,
                requires_cost_acceptance: false,
            }
        }
    };
    if run.requires_cost_acceptance && !accept_vision_cost {
        let _ = state.set_active(run);
        return Err("Confirm the estimated visual recognition cost before publishing.".to_string());
    }
    let prepare_publish_input = || -> Result<(), String> {
        let mut publish_input: Value = serde_json::from_slice(
            &fs::read(&run.input_path)
                .map_err(|e| format!("Cannot read Wiki publish input: {e}"))?,
        )
        .map_err(|e| format!("Invalid Wiki publish input: {e}"))?;
        publish_input["cloudPublishingRecovery"] = Value::Bool(cloud_publishing_recovery);
        publish_input["expectedTargetCommit"] = Value::String(target_commit.clone());
        publish_input["expectedTargetTreeHash"] = Value::String(target_tree_hash.clone());
        publish_input["expectedBaseTreeHash"] = base_tree_hash
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null);
        write_json(&run.input_path, &publish_input)
    };
    if let Err(error) = prepare_publish_input() {
        let _ = state.set_active(run);
        return Err(error);
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
    let Ok(run) = state.take_for_publish(&run_id) else {
        // A summary restored from a cloud checkpoint has no in-memory
        // ActiveRun. Closing it is still an idempotent local operation.
        return Ok(());
    };
    let root = work_root(&run.team_id)?;
    let _ = fs::write(root.join("state/cancel-requested"), b"1");
    stop_compiler(&root.join("state/compiler.pid"));
    rollback_unfinished_wiki(&root.join("wiki"))?;
    let _ = fs::remove_file(run.lock_path);
    let _ = fs::remove_file(run.input_path);
    Ok(())
}

fn stop_compiler(pid_path: &Path) {
    let Ok(text) = fs::read_to_string(pid_path) else {
        return;
    };
    let Ok(pid) = text.trim().parse::<u32>() else {
        return;
    };
    #[cfg(unix)]
    {
        let _ = StdCommand::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
    #[cfg(windows)]
    {
        let _ = StdCommand::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
}

fn rollback_unfinished_wiki(wiki_root: &Path) -> Result<(), String> {
    if !wiki_root.join(".git").is_dir() {
        return Ok(());
    }
    let reset = StdCommand::new("git")
        .args(["reset", "--hard", "HEAD"])
        .current_dir(wiki_root)
        .status()
        .map_err(|error| format!("Cannot roll back the unfinished Wiki source: {error}"))?;
    if !reset.success() {
        return Err("Cannot roll back the unfinished Wiki source.".to_string());
    }
    let clean = StdCommand::new("git")
        .args(["clean", "-fd"])
        .current_dir(wiki_root)
        .status()
        .map_err(|error| format!("Cannot discard unfinished Wiki files: {error}"))?;
    if !clean.success() {
        return Err("Cannot discard unfinished Wiki files.".to_string());
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineRequest {
    team_id: String,
    expected_generation: u64,
    config_version: u64,
    node_id: String,
    compiler_model: String,
}

#[tauri::command]
pub async fn kb_maintainer_create_baseline(
    app: tauri::AppHandle,
    request: BaselineRequest,
) -> Result<Value, String> {
    let root = work_root(&request.team_id)?;
    let input_path = root.join("state/baseline-input.json");
    write_json(
        &input_path,
        &json!({
            "workRoot": root,
            "configPath": root.join("config.json"),
            "expectedGeneration": request.expected_generation,
            "configVersion": request.config_version,
            "nodeId": request.node_id,
            "compilerModel": request.compiler_model,
        }),
    )?;
    let result = run_node(&app, "baseline", &input_path, None).await;
    let _ = fs::remove_file(input_path);
    result
}

#[tauri::command]
pub async fn kb_maintainer_inspect_vault(
    app: tauri::AppHandle,
    team_id: String,
) -> Result<Value, String> {
    let (_documents, knowledge) = team_paths(&team_id)?;
    let root = work_root(&team_id)?;
    fs::create_dir_all(root.join("state"))
        .map_err(|error| format!("Cannot create Wiki work folder: {error}"))?;
    let input_path = root.join("state/inspect-input.json");
    write_json(&input_path, &json!({ "knowledgeRoot": knowledge }))?;
    let result = run_node(&app, "inspect-vault", &input_path, None).await;
    let _ = fs::remove_file(input_path);
    result
}

#[tauri::command]
pub async fn kb_maintainer_adopt_wiki(
    app: tauri::AppHandle,
    team_id: String,
) -> Result<Value, String> {
    let root = work_root(&team_id)?;
    let (_documents, knowledge) = team_paths(&team_id)?;
    fs::create_dir_all(root.join("state"))
        .map_err(|error| format!("Cannot create Wiki work folder: {error}"))?;
    let config_path = root.join("config.json");
    if !config_path.is_file() {
        write_json(
            &config_path,
            &json!({
                "schemaVersion": 1,
                "teamId": team_id,
                "sources": [],
            }),
        )?;
    }
    let input_path = root.join("state/adopt-input.json");
    write_json(
        &input_path,
        &json!({
            "knowledgeRoot": knowledge,
            "workRoot": root,
            "configPath": config_path,
            "teamId": team_id,
            "expectedGeneration": 0,
            "configVersion": 1,
            "nodeId": gethostname::gethostname().to_string_lossy().to_string(),
            "compilerModel": "default",
        }),
    )?;
    let result = run_node(&app, "adopt", &input_path, None).await;
    let _ = fs::remove_file(input_path);
    result
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
        assert!(normalize_source_directory("documents/").is_err());
        assert_eq!(
            first_directory("documents/features/leave.md").as_deref(),
            Some("documents/features/")
        );
        assert_eq!(first_directory("documents/readme.md"), None);
        assert_eq!(first_directory("documents/"), None);
    }

    #[test]
    fn device_compiler_models_skip_the_team_gateway() {
        assert!(compiler_uses_team_gateway("glm-4.6"));
        assert!(compiler_uses_team_gateway("team/glm-4.6"));
        assert!(compiler_uses_team_gateway("default"));
        assert!(!compiler_uses_team_gateway("anthropic/claude-sonnet"));
    }

    #[test]
    fn prepare_request_reads_compiler_model() {
        let parsed: PrepareRequest = serde_json::from_value(json!({
            "teamId": "team-1",
            "sourceDirectories": ["documents/handbook/"],
            "compilerModel": "glm-4.6",
            "aclPrefixes": [],
            "known": []
        }))
        .unwrap();
        assert_eq!(parsed.compiler_model.as_deref(), Some("glm-4.6"));
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
            humanize_compiler_error("Error: source prefix escape is not allowed"),
            "Files placed directly in Documents are not a Wiki source. Choose a folder inside Documents."
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
        assert_eq!(
            humanize_compiler_error(
                "Error: quality check failed: pages/knowledge-base.md: dead wiki link target"
            ),
            "This Wiki compile needs another maintenance run before it can be published."
        );
    }

    #[test]
    fn gateway_token_comes_from_resolved_provider_team() {
        let (payload, token) = gateway_from_disk_team(&disk_team("tok_live_ai_invoke")).unwrap();
        assert_eq!(token, "tok_live_ai_invoke");
        let parsed: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["baseUrl"], "http://127.0.0.1:43111/ai/v1/teams/abc");
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

    #[test]
    fn checkpoint_transfer_never_reads_outside_the_team_work_root() {
        let root = tempfile::tempdir().unwrap();
        let checkpoints = root.path().join("state/checkpoints");
        fs::create_dir_all(&checkpoints).unwrap();
        let inside = checkpoints.join("1-checkpoint.zip");
        fs::write(&inside, b"checkpoint").unwrap();
        assert_eq!(
            validate_checkpoint_file_path(root.path(), &inside).unwrap(),
            inside.canonicalize().unwrap()
        );

        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(validate_checkpoint_file_path(root.path(), outside.path()).is_err());
    }
}
