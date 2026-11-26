//! Workspace configuration control — provider, MCP, runtime APIs.
//!
//! `WorkspaceControlStore` is the daemon-internal abstraction that owns
//! all reads and writes to workspace-scoped settings. HTTP handlers call
//! into this trait; they never touch the config files directly. The single
//! production implementation is `LocalControlStore`, over the daemon-owned
//! files in `teamclu_runtime_env::config_store`. Future replacements only
//! require a new `WorkspaceControlStore` implementation.

pub use super::roles_skills::{
    delete_role, delete_skill, scan_roles_skills_state, upsert_role, upsert_skill, ManagedSkillDto,
    RoleRecordDto, RolesSkillsStateDto, UpsertRoleRequest, UpsertSkillRequest,
};

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

// ── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum WorkspaceControlError {
    WorkspaceNotFound(String),
    NotFound(String),
    Io(String),
    Parse(String),
    /// Caller supplied an unsafe or out-of-bounds path/segment. Maps to 400.
    InvalidInput(String),
    /// Workspace has an active agent turn; runtime reload/stop is rejected.
    ActiveTurn(String),
}

impl std::fmt::Display for WorkspaceControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkspaceNotFound(id) => write!(f, "workspace not found: {id}"),
            Self::NotFound(msg) => write!(f, "not found: {msg}"),
            Self::Io(e) => write!(f, "io error: {e}"),
            Self::Parse(e) => write!(f, "parse error: {e}"),
            Self::InvalidInput(msg) => write!(f, "invalid input: {msg}"),
            Self::ActiveTurn(id) => write!(f, "workspace has active turn: {id}"),
        }
    }
}

impl std::error::Error for WorkspaceControlError {}

// ── Apply outcome ─────────────────────────────────────────────────────────────

/// What happened after a workspace config mutation. Clients use this to
/// decide whether to surface a "restart required" banner.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyOutcome {
    /// Change took effect immediately (no agent restart needed).
    AppliedLive,
    /// OpenCode will pick up the change on next workspace reload.
    ReloadRequired,
    /// The running agent must be restarted for the change to take effect.
    RestartRequired,
}

// ── Provider types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub display_name: String,
    /// True when an api_key (or ${ref}) is stored for this provider.
    pub authenticated: bool,
    pub base_url: Option<String>,
    /// Model IDs advertised by this provider.
    pub models: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ProviderAuthRequest {
    pub api_key: String,
    pub base_url: Option<String>,
    pub display_name: Option<String>,
    #[serde(default)]
    pub models: Vec<ProviderModelConfig>,
}

#[derive(Debug, Deserialize)]
pub struct ProviderModelConfig {
    pub model_id: String,
    pub model_name: Option<String>,
}

// ── MCP types ─────────────────────────────────────────────────────────────────

/// One MCP server entry (device `mcp.json`, team cloud MCP, or the workspace's own layer).
/// Field names intentionally match the frontend `MCPServerConfig` and the
/// existing `mcp.rs` Tauri command type so JSON round-trips are lossless.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Server kind: `"local"` (stdio) or `"remote"` (HTTP). Defaults to `""` when
    /// not present in the JSON so we can safely round-trip entries written by
    /// other tools that omit the field.
    #[serde(rename = "type", default, skip_serializing_if = "String::is_empty")]
    pub server_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Command + args for `type = "local"` stdio servers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub environment: HashMap<String, String>,
    /// Base URL for `type = "remote"` HTTP servers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    /// Provenance for merged MCP views (`workspace` | `team` | `inherent`). Omitted on disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Unknown fields are preserved so the daemon never silently drops
    /// Keys this struct does not yet understand, kept on round-trip.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

// ── Runtime status ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct RuntimeRefreshDto {
    pub status: String,
    pub change_kinds: Vec<String>,
    pub recommended_action: String,
    pub auto_apply_blocked_by_active_runtime: bool,
    pub last_detected_at: Option<String>,
    pub last_error: Option<String>,
}

impl RuntimeRefreshDto {
    pub fn clean() -> Self {
        Self {
            status: "clean".to_owned(),
            change_kinds: Vec::new(),
            recommended_action: "none".to_owned(),
            auto_apply_blocked_by_active_runtime: false,
            last_detected_at: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RuntimeStatus {
    pub workspace_id: String,
    /// Whether an agent runtime is currently running for this workspace.
    pub ready: bool,
    pub backend: String,
    pub current_model: Option<String>,
    pub refresh: RuntimeRefreshDto,
}

/// Non-secret diagnostics for why personal/team env vars may not reach a runtime.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvActivationBlocker {
    pub code: String,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvActivationDiagnostics {
    /// User-configured personal keys the daemon can load for spawn (excludes
    /// `tc_api_key` / `_team_secret.*` seeded into the blob by the desktop).
    pub personal_env_var_count: usize,
    /// Same count read directly from the encrypted blob metadata.
    pub personal_blob_user_var_count: usize,
    pub personal_blob_readable: bool,
    pub personal_load_error: Option<String>,
    pub team_env_var_count: usize,
    pub system_env_var_count: usize,
    pub opencode_serve_running: bool,
    pub opencode_serve_cached_env_count: usize,
    pub active_runtime_count: usize,
    pub workspace_has_active_turn: bool,
    pub refresh: RuntimeRefreshDto,
    /// Workspace-scoped OpenCode host generation and capacity state.
    pub host_pool: crate::runtime::host_pool_stats::DomainHostStats,
    /// Personal keys shadowed by the host OS env at opencode serve spawn.
    pub host_env_shadowed_keys: Vec<String>,
    /// Fingerprint most recently resolved/requested for this workspace.
    pub resolved_env_fingerprint: Option<String>,
    /// Keys whose final value overrides an earlier personal/team/system layer.
    pub override_keys: Vec<String>,
    /// Alias keys that collided with an explicitly configured key.
    pub alias_collision_keys: Vec<String>,
    /// Keys known to the catalog but unavailable for runtime injection.
    pub unresolved_env_keys: Vec<String>,
    /// `active`, `pending`, or `blocked`.
    pub activation_status: String,
    /// Structured blockers for client-side i18n.
    pub blockers: Vec<EnvActivationBlocker>,
    /// User-configured personal + team keys expected to resolve for this workspace.
    pub expected_env_keys: Vec<String>,
    /// Personal/team keys present in the latest resolved snapshot (non-alias).
    pub effective_env_keys: Vec<String>,
    /// Expected keys absent from the resolved snapshot and not marked unresolved.
    pub missing_expected_keys: Vec<String>,
    /// Per-key activation status for settings UI badges.
    pub key_statuses: Vec<teamclu_runtime_env::EnvKeyActivationStatus>,
    /// `${KEY}` placeholders in the workspace MCP layer with no binding.
    pub mcp_unresolved_placeholders: Vec<teamclu_runtime_env::UnresolvedConfigPlaceholder>,
    /// Fingerprint captured on the newest active runtime handle, if any.
    pub active_handle_env_fingerprint: Option<String>,
    /// Whether a team env secret is configured for decrypting `_secrets/`.
    pub team_secret_configured: bool,
    /// Key names queued on the global OpenCode serve host (no values).
    pub opencode_serve_cached_env_keys: Vec<String>,
    /// Resolved personal/team keys absent from the serve host queue.
    pub missing_served_env_keys: Vec<String>,
    /// Personal/team keys on the newest active runtime handle snapshot.
    pub active_handle_env_keys: Vec<String>,
}

// ── WorkspaceControlStore trait ───────────────────────────────────────────────

pub trait WorkspaceControlStore: Send + Sync {
    fn get_providers(&self, workspace_id: &str)
        -> Result<Vec<ProviderInfo>, WorkspaceControlError>;

    fn put_provider_auth(
        &self,
        workspace_id: &str,
        provider_id: &str,
        req: ProviderAuthRequest,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn delete_provider_auth(
        &self,
        workspace_id: &str,
        provider_id: &str,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn get_mcp(
        &self,
        workspace_id: &str,
    ) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError>;

    fn put_mcp(
        &self,
        workspace_id: &str,
        servers: HashMap<String, McpServerConfig>,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn get_roles_skills_state(
        &self,
        workspace_id: &str,
    ) -> Result<RolesSkillsStateDto, WorkspaceControlError>;

    fn get_skills(&self, workspace_id: &str)
        -> Result<Vec<ManagedSkillDto>, WorkspaceControlError>;

    fn get_roles(&self, workspace_id: &str) -> Result<Vec<RoleRecordDto>, WorkspaceControlError>;

    fn put_skill(
        &self,
        workspace_id: &str,
        slug: &str,
        req: UpsertSkillRequest,
    ) -> Result<ManagedSkillDto, WorkspaceControlError>;

    fn delete_skill(
        &self,
        workspace_id: &str,
        slug: &str,
        dir_path: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn put_role(
        &self,
        workspace_id: &str,
        slug: &str,
        req: UpsertRoleRequest,
    ) -> Result<RoleRecordDto, WorkspaceControlError>;

    fn delete_role(
        &self,
        workspace_id: &str,
        slug: &str,
        file_path: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError>;

    fn get_runtime_status(
        &self,
        workspace_id: &str,
    ) -> Result<RuntimeStatus, WorkspaceControlError>;

    fn reload_runtime(&self, workspace_id: &str) -> Result<ApplyOutcome, WorkspaceControlError>;
}

// ── providers.json schema ────────────────────────────────────────────────────

/// The `provider` map of a providers file (`<state>/providers.json`, or the
/// legacy workspace-root `teamclu.json`). Other keys are ignored on read; the
/// writers below edit `provider.<id>` in place and never rewrite the rest.
#[derive(Debug, Deserialize, Default)]
struct ProvidersFile {
    #[serde(default)]
    provider: HashMap<String, ProviderEntry>,
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
struct ProviderEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// npm package name (e.g. `@ai-sdk/openai-compatible`)
    #[serde(skip_serializing_if = "Option::is_none")]
    npm: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    options: HashMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    models: HashMap<String, serde_json::Value>,
}

// ── LocalControlStore ───────────────────────────────────────────────────────

/// Production implementation of `WorkspaceControlStore`, over the
/// daemon-owned files in `teamclu_runtime_env::config_store`: providers in the
/// active team's `providers.json`, workspace MCP in that workspace's own
/// `mcp.json`. Nothing is written into the workspace directory itself.
/// Stateless workspace-control store. The workspace identity is the
/// **base64url-encoded absolute filesystem path** — no registration step
/// required. Clients (frontend, desktop Tauri bridge) call
/// `base64url(workspacePath)` and pass the result as the `:id` URL segment.
pub struct LocalControlStore {
    /// Coarse write mutex: one workspace write at a time per process.
    write_lock: Mutex<()>,
}

/// Decode a base64url workspace-ID to an absolute filesystem path.
pub fn decode_workspace_path(workspace_id: &str) -> Result<PathBuf, WorkspaceControlError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let bytes = URL_SAFE_NO_PAD
        .decode(workspace_id)
        .map_err(|_| WorkspaceControlError::WorkspaceNotFound(workspace_id.to_owned()))?;
    let path_str = String::from_utf8(bytes)
        .map_err(|_| WorkspaceControlError::WorkspaceNotFound(workspace_id.to_owned()))?;
    let path = PathBuf::from(&path_str);
    if path.is_dir() {
        Ok(path)
    } else {
        Err(WorkspaceControlError::WorkspaceNotFound(path_str))
    }
}

/// Encode an absolute workspace path as the base64url `:id` used by HTTP routes.
pub fn encode_workspace_path(path: &std::path::Path) -> Result<String, WorkspaceControlError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let s = path
        .to_str()
        .ok_or_else(|| WorkspaceControlError::InvalidInput("workspace path is not UTF-8".into()))?;
    if !path.is_dir() {
        return Err(WorkspaceControlError::WorkspaceNotFound(s.to_owned()));
    }
    Ok(URL_SAFE_NO_PAD.encode(s))
}

impl LocalControlStore {
    pub fn new() -> Self {
        Self {
            write_lock: Mutex::new(()),
        }
    }

    fn workspace_path(&self, workspace_id: &str) -> Result<PathBuf, WorkspaceControlError> {
        decode_workspace_path(workspace_id)
    }

    fn teamclu_json_path(workspace_path: &std::path::Path) -> PathBuf {
        // Legacy workspace-root config; brand meta config is resolved separately
        // via teamclu_runtime_env helpers where needed.
        workspace_path.join("teamclu.json")
    }

    /// True when `options.apiKey` is a non-empty literal or `${env_ref}` placeholder.
    fn provider_entry_authenticated(entry: &ProviderEntry) -> bool {
        entry
            .options
            .get("apiKey")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty())
    }

    /// Legacy workspace-root `teamclu.json` may still define custom providers.
    fn read_teamclu_json(
        workspace_path: &std::path::Path,
    ) -> Result<ProvidersFile, WorkspaceControlError> {
        let path = Self::teamclu_json_path(workspace_path);
        if !path.exists() {
            return Ok(ProvidersFile::default());
        }
        let content =
            std::fs::read_to_string(&path).map_err(|e| WorkspaceControlError::Io(e.to_string()))?;
        serde_json::from_str(&content).map_err(|e| WorkspaceControlError::Parse(e.to_string()))
    }

    /// The active team's `providers.json` (`teamclu_runtime_env::config_store`):
    /// the daemon-reconciled `provider.team` plus every provider the user
    /// configured. Missing file reads as empty.
    fn read_providers_file() -> Result<ProvidersFile, WorkspaceControlError> {
        let value = teamclu_runtime_env::config_store::ConfigStore::load_providers()
            .map_err(|e| WorkspaceControlError::Parse(e.to_string()))?;
        serde_json::from_value(value).map_err(|e| WorkspaceControlError::Parse(e.to_string()))
    }

    /// Provider view = legacy workspace-root `teamclu.json`, then the active
    /// team's `providers.json` last so its entries win.
    fn merged_provider_entries(
        workspace_path: &std::path::Path,
    ) -> Result<HashMap<String, ProviderEntry>, WorkspaceControlError> {
        let mut merged = Self::read_teamclu_json(workspace_path)?.provider;
        merged.extend(Self::read_providers_file()?.provider);
        Ok(merged)
    }

    /// Write one provider entry into `providers.json`, leaving every other key
    /// in that file untouched.
    fn put_global_provider(
        provider_id: &str,
        entry: &ProviderEntry,
    ) -> Result<(), WorkspaceControlError> {
        let entry_value =
            serde_json::to_value(entry).map_err(|e| WorkspaceControlError::Parse(e.to_string()))?;
        teamclu_runtime_env::config_store::ConfigStore::apply_providers(|cfg| {
            let obj = cfg.as_object_mut().ok_or_else(|| {
                teamclu_runtime_env::config_store::ConfigStoreError::Parse(
                    "providers.json is not an object".to_owned(),
                )
            })?;
            let providers = obj
                .entry("provider")
                .or_insert_with(|| serde_json::Value::Object(Default::default()));
            let providers = providers.as_object_mut().ok_or_else(|| {
                teamclu_runtime_env::config_store::ConfigStoreError::Parse(
                    "providers.json `provider` is not an object".to_owned(),
                )
            })?;
            providers.insert(provider_id.to_owned(), entry_value);
            Ok(true)
        })
        .map(|_| ())
        .map_err(|e| WorkspaceControlError::Io(e.to_string()))
    }

    /// Remove a provider entry from `providers.json`. Returns without error
    /// when the file or the entry is absent.
    fn remove_global_provider(provider_id: &str) -> Result<(), WorkspaceControlError> {
        teamclu_runtime_env::config_store::ConfigStore::apply_providers(|cfg| {
            let Some(obj) = cfg.as_object_mut() else {
                return Ok(false);
            };
            let Some(providers) = obj.get_mut("provider").and_then(|p| p.as_object_mut()) else {
                return Ok(false);
            };
            Ok(providers.remove(provider_id).is_some())
        })
        .map(|_| ())
        .map_err(|e| WorkspaceControlError::Io(e.to_string()))
    }
}

impl Default for LocalControlStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Fold a save request into the entry to persist, seeded from whatever is
/// already configured for that provider.
///
/// An empty `api_key` means "leave the stored key alone" — the settings UI
/// sends it that way when the user edits a base URL or model list without
/// re-typing their secret.
fn build_provider_entry(
    seed: Option<ProviderEntry>,
    req: ProviderAuthRequest,
) -> Result<ProviderEntry, WorkspaceControlError> {
    let mut entry = seed.unwrap_or_default();

    let api_key = if req.api_key.trim().is_empty() {
        entry
            .options
            .get("apiKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned()
    } else {
        req.api_key
    };
    if api_key.trim().is_empty() {
        return Err(WorkspaceControlError::InvalidInput(
            "api_key must not be empty".to_owned(),
        ));
    }

    if let Some(name) = req.display_name.as_ref() {
        entry.name = Some(name.clone());
    }
    if entry.npm.is_none() && (req.display_name.is_some() || req.base_url.is_some()) {
        entry.npm = Some("@ai-sdk/openai-compatible".to_owned());
    }
    entry
        .options
        .insert("apiKey".to_owned(), serde_json::Value::String(api_key));
    if let Some(base_url) = req.base_url {
        entry
            .options
            .insert("baseURL".to_owned(), serde_json::Value::String(base_url));
    }
    for model in req.models {
        let model_val = serde_json::json!({
            "name": model.model_name.unwrap_or_else(|| model.model_id.clone()),
        });
        entry.models.insert(model.model_id, model_val);
    }
    Ok(entry)
}

/// Device-level provider API (#742) — no workspace involved.
///
/// This is what lets the desktop configure a model provider *before* a
/// workspace exists, which first-run onboarding needs: the user picks a
/// provider and pastes a key on their way in, long before any project
/// directory has been resolved.
///
/// Unlike the workspace-scoped view these functions deliberately do NOT merge
/// the daemon-reconciled `provider.team` entry: team credentials are not the
/// user's to configure, and there is no team context here anyway.
pub fn device_providers() -> Result<Vec<ProviderInfo>, WorkspaceControlError> {
    let entries = LocalControlStore::read_providers_file()?.provider;
    Ok(entries
        .iter()
        .map(|(id, entry)| ProviderInfo {
            id: id.clone(),
            display_name: entry.name.clone().unwrap_or_else(|| id.clone()),
            authenticated: LocalControlStore::provider_entry_authenticated(entry),
            base_url: entry
                .options
                .get("baseURL")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            models: entry.models.keys().cloned().collect(),
        })
        .collect())
}

pub fn put_device_provider_auth(
    provider_id: &str,
    req: ProviderAuthRequest,
) -> Result<ApplyOutcome, WorkspaceControlError> {
    let seed = LocalControlStore::read_providers_file()?
        .provider
        .get(provider_id)
        .cloned();
    let entry = build_provider_entry(seed, req)?;
    LocalControlStore::put_global_provider(provider_id, &entry)?;
    Ok(ApplyOutcome::RestartRequired)
}

pub fn delete_device_provider_auth(
    provider_id: &str,
) -> Result<ApplyOutcome, WorkspaceControlError> {
    LocalControlStore::remove_global_provider(provider_id)?;
    Ok(ApplyOutcome::RestartRequired)
}

impl WorkspaceControlStore for LocalControlStore {
    fn get_providers(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ProviderInfo>, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let merged = Self::merged_provider_entries(&wpath)?;

        let providers = merged
            .iter()
            .map(|(id, entry)| {
                let base_url = entry
                    .options
                    .get("baseURL")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                let authenticated = Self::provider_entry_authenticated(entry);
                let models = entry.models.keys().cloned().collect();
                ProviderInfo {
                    id: id.clone(),
                    display_name: entry.name.clone().unwrap_or_else(|| id.clone()),
                    authenticated,
                    base_url,
                    models,
                }
            })
            .collect();

        Ok(providers)
    }

    fn put_provider_auth(
        &self,
        workspace_id: &str,
        provider_id: &str,
        req: ProviderAuthRequest,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        // Seed from the merged view so a legacy `teamclu.json` entry is carried
        // forward (base URL, model list) rather than silently reset when the
        // user re-saves it into `providers.json`.
        let seed = Self::merged_provider_entries(&wpath)?
            .get(provider_id)
            .cloned();
        let entry = build_provider_entry(seed, req)?;

        // #742: provider credentials are device-level, never per-workspace — the
        // workspace copy is a git repo and used to leak API keys into commits.
        Self::put_global_provider(provider_id, &entry)?;
        Ok(ApplyOutcome::RestartRequired)
    }

    fn delete_provider_auth(
        &self,
        workspace_id: &str,
        provider_id: &str,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let _wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        Self::remove_global_provider(provider_id)?;
        Ok(ApplyOutcome::RestartRequired)
    }

    fn get_runtime_status(
        &self,
        workspace_id: &str,
    ) -> Result<RuntimeStatus, WorkspaceControlError> {
        let _wpath = self.workspace_path(workspace_id)?;
        Ok(RuntimeStatus {
            workspace_id: workspace_id.to_owned(),
            // Runtime readiness is owned by RuntimeManager; the compat store
            // reports a static view. Phase D wires in the real status.
            ready: false,
            backend: "opencode".to_owned(),
            current_model: None,
            refresh: RuntimeRefreshDto::clean(),
        })
    }

    fn reload_runtime(&self, workspace_id: &str) -> Result<ApplyOutcome, WorkspaceControlError> {
        let _wpath = self.workspace_path(workspace_id)?;
        // Reload is driven by RuntimeManager; this stub records intent.
        // Phase D wires in the real reload signal.
        Ok(ApplyOutcome::ReloadRequired)
    }

    fn get_mcp(
        &self,
        workspace_id: &str,
    ) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        super::team_mcp::load_merged_mcp(&wpath)
    }

    fn put_mcp(
        &self,
        workspace_id: &str,
        servers: HashMap<String, McpServerConfig>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        // The four device-scoped servers are the same on every workspace of this
        // machine, so a toggle on one of them is a machine-wide decision and is
        // persisted once, in `~/.amuxd/mcp.json`.
        let (workspace_only, device) = super::team_mcp::split_put_body(&wpath, servers);
        let device_changed = super::device_mcp::put_device_entries(device)?;
        super::team_mcp::write_persisted_mcp(&wpath, &workspace_only)?;
        // Running pi hosts watch their effective MCP file and re-bridge in
        // place. A device toggle reaches every workspace; a workspace edit
        // only this one.
        crate::runtime::pi_rpc::refresh_effective_mcp((!device_changed).then_some(wpath.as_path()));
        Ok(ApplyOutcome::AppliedLive)
    }

    fn get_roles_skills_state(
        &self,
        workspace_id: &str,
    ) -> Result<RolesSkillsStateDto, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        scan_roles_skills_state(&wpath)
    }

    fn get_skills(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ManagedSkillDto>, WorkspaceControlError> {
        Ok(self.get_roles_skills_state(workspace_id)?.skills)
    }

    fn get_roles(&self, workspace_id: &str) -> Result<Vec<RoleRecordDto>, WorkspaceControlError> {
        Ok(self.get_roles_skills_state(workspace_id)?.roles)
    }

    fn put_skill(
        &self,
        workspace_id: &str,
        slug: &str,
        req: UpsertSkillRequest,
    ) -> Result<ManagedSkillDto, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        upsert_skill(&wpath, slug, &req)
    }

    fn delete_skill(
        &self,
        workspace_id: &str,
        slug: &str,
        dir_path: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        delete_skill(&wpath, slug, dir_path)?;
        Ok(ApplyOutcome::ReloadRequired)
    }

    fn put_role(
        &self,
        workspace_id: &str,
        slug: &str,
        req: UpsertRoleRequest,
    ) -> Result<RoleRecordDto, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        upsert_role(&wpath, slug, &req)
    }

    fn delete_role(
        &self,
        workspace_id: &str,
        slug: &str,
        file_path: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        let wpath = self.workspace_path(workspace_id)?;
        let _lock = self.write_lock.lock().unwrap();
        delete_role(&wpath, slug, file_path)?;
        Ok(ApplyOutcome::ReloadRequired)
    }
}

// ── NullWorkspaceControlStore ─────────────────────────────────────────────────

/// Default no-op store used when no workspace control is configured (e.g.
/// in tests that don't exercise workspace routes). Every method returns
/// `WorkspaceNotFound` so workspace routes respond 404 gracefully.
pub struct NullWorkspaceControlStore;

impl WorkspaceControlStore for NullWorkspaceControlStore {
    fn get_providers(&self, id: &str) -> Result<Vec<ProviderInfo>, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn put_provider_auth(
        &self,
        id: &str,
        _: &str,
        _: ProviderAuthRequest,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn delete_provider_auth(
        &self,
        id: &str,
        _: &str,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_mcp(&self, id: &str) -> Result<HashMap<String, McpServerConfig>, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn put_mcp(
        &self,
        id: &str,
        _: HashMap<String, McpServerConfig>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_roles_skills_state(
        &self,
        id: &str,
    ) -> Result<RolesSkillsStateDto, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_skills(&self, id: &str) -> Result<Vec<ManagedSkillDto>, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_roles(&self, id: &str) -> Result<Vec<RoleRecordDto>, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn put_skill(
        &self,
        id: &str,
        _: &str,
        _: UpsertSkillRequest,
    ) -> Result<ManagedSkillDto, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn delete_skill(
        &self,
        id: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn put_role(
        &self,
        id: &str,
        _: &str,
        _: UpsertRoleRequest,
    ) -> Result<RoleRecordDto, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn delete_role(
        &self,
        id: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn get_runtime_status(&self, id: &str) -> Result<RuntimeStatus, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
    fn reload_runtime(&self, id: &str) -> Result<ApplyOutcome, WorkspaceControlError> {
        Err(WorkspaceControlError::WorkspaceNotFound(id.to_owned()))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn make_store() -> LocalControlStore {
        LocalControlStore::new()
    }

    /// Point the active-team config (#742) at a throwaway home.
    ///
    /// Without this, provider tests read and write the developer's real
    /// active team's `state/providers.json` — they would leak into each other and their
    /// results would depend on whatever that machine happens to have
    /// configured. The inner guard holds `TEST_HOME_LOCK`, so these tests also
    /// serialize against every other test that moves `HOME` / `AMUXD_HOME` /
    /// the brand name.
    struct GlobalConfigIsolation {
        _guard: crate::test_brand_env::BrandEnvGuard,
        _home: tempfile::TempDir,
    }

    fn isolate_global_config() -> GlobalConfigIsolation {
        let home = tempfile::tempdir().unwrap();
        let guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        GlobalConfigIsolation {
            _guard: guard,
            _home: home,
        }
    }

    /// Encode an absolute path as a base64url workspace ID (mirrors the
    /// frontend `encodeWorkspaceId` helper in daemon-local-client.ts).
    fn ws_id(path: &std::path::Path) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        URL_SAFE_NO_PAD.encode(path.to_str().unwrap())
    }

    #[test]
    fn get_providers_empty_workspace_returns_empty_list() {
        let _iso = isolate_global_config();
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let providers = store.get_providers(&ws_id(dir.path())).unwrap();
        assert!(providers.is_empty());
    }

    #[test]
    fn get_providers_merges_teamclu_json_with_providers_json() {
        let _iso = isolate_global_config();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("teamclu.json"),
            r#"{
  "provider": {
    "scnet": {
      "name": "scnet",
      "options": { "baseURL": "https://api.example.com/v1", "apiKey": "${scnet_api_key}" },
      "models": { "MiniMax-M2.5": { "name": "MiniMax-M2.5" } }
    }
  }
}"#,
        )
        .unwrap();
        let providers_path = teamclu_runtime_env::config_store::providers_config_path();
        std::fs::create_dir_all(providers_path.parent().unwrap()).unwrap();
        std::fs::write(
            &providers_path,
            r#"{
  "provider": {
    "team": {
      "name": "Team",
      "options": { "baseURL": "https://team.example/v1", "apiKey": "sk-team" },
      "models": { "gpt-5.2": { "name": "gpt-5.2" } }
    }
  }
}"#,
        )
        .unwrap();
        // A leftover workspace `opencode.json` is not read any more.
        std::fs::write(
            root.join("opencode.json"),
            r#"{ "provider": { "legacy": { "options": { "apiKey": "sk-old" } } } }"#,
        )
        .unwrap();

        let store = make_store();
        let providers = store.get_providers(&ws_id(root)).unwrap();
        assert_eq!(providers.len(), 2);
        let scnet = providers.iter().find(|p| p.id == "scnet").unwrap();
        assert!(scnet.authenticated);
        assert!(scnet.models.contains(&"MiniMax-M2.5".to_owned()));
        let team = providers.iter().find(|p| p.id == "team").unwrap();
        assert!(team.authenticated);
    }

    #[test]
    fn put_provider_auth_creates_entry_and_get_returns_it() {
        let _iso = isolate_global_config();
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        let outcome = store
            .put_provider_auth(
                &wid,
                "my-llm",
                ProviderAuthRequest {
                    api_key: "sk-test".to_owned(),
                    base_url: Some("https://api.example.com/v1".to_owned()),
                    display_name: Some("My LLM".to_owned()),
                    models: vec![ProviderModelConfig {
                        model_id: "my-llm/gpt-4".to_owned(),
                        model_name: Some("GPT-4".to_owned()),
                    }],
                },
            )
            .unwrap();

        assert!(matches!(outcome, ApplyOutcome::RestartRequired));

        let providers = store.get_providers(&wid).unwrap();
        assert_eq!(providers.len(), 1);
        let p = &providers[0];
        assert_eq!(p.id, "my-llm");
        assert_eq!(p.display_name, "My LLM");
        assert!(p.authenticated);
        assert_eq!(p.base_url.as_deref(), Some("https://api.example.com/v1"));
        assert!(p.models.contains(&"my-llm/gpt-4".to_owned()));
    }

    #[test]
    fn put_provider_auth_merges_existing_teamclu_provider_when_connecting_api_key() {
        let _iso = isolate_global_config();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("teamclu.json"),
            r#"{
  "provider": {
    "scnet": {
      "name": "scnet",
      "options": { "baseURL": "https://api.example.com/v1" },
      "models": { "MiniMax-M2.5": { "name": "MiniMax-M2.5" } }
    }
  }
}"#,
        )
        .unwrap();

        let store = make_store();
        let wid = ws_id(root);

        store
            .put_provider_auth(
                &wid,
                "scnet",
                ProviderAuthRequest {
                    api_key: "sk-live".to_owned(),
                    base_url: None,
                    display_name: None,
                    models: vec![],
                },
            )
            .unwrap();

        let providers = store.get_providers(&wid).unwrap();
        let scnet = providers.iter().find(|p| p.id == "scnet").unwrap();
        assert!(scnet.authenticated);
        assert_eq!(
            scnet.base_url.as_deref(),
            Some("https://api.example.com/v1")
        );
        assert!(scnet.models.contains(&"MiniMax-M2.5".to_owned()));

        // #742: the key lands in the device-level config, and the workspace —
        // which is usually a git repo — is left alone entirely.
        assert!(!root.join("opencode.json").exists());
        let global =
            std::fs::read_to_string(teamclu_runtime_env::config_store::providers_config_path())
                .unwrap();
        assert!(global.contains("sk-live"));
        assert!(!global.contains("@ai-sdk/openai-compatible"));
    }

    #[test]
    fn put_provider_auth_preserves_existing_api_key_when_update_omits_it() {
        let _iso = isolate_global_config();
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        store
            .put_provider_auth(
                &wid,
                "my-llm",
                ProviderAuthRequest {
                    api_key: "sk-test".to_owned(),
                    base_url: Some("https://api.example.com/v1".to_owned()),
                    display_name: Some("My LLM".to_owned()),
                    models: vec![ProviderModelConfig {
                        model_id: "gpt-4".to_owned(),
                        model_name: Some("GPT-4".to_owned()),
                    }],
                },
            )
            .unwrap();

        store
            .put_provider_auth(
                &wid,
                "my-llm",
                ProviderAuthRequest {
                    api_key: String::new(),
                    base_url: Some("https://api.example.com/v2".to_owned()),
                    display_name: Some("My LLM v2".to_owned()),
                    models: vec![ProviderModelConfig {
                        model_id: "gpt-4o".to_owned(),
                        model_name: Some("GPT-4o".to_owned()),
                    }],
                },
            )
            .unwrap();

        let providers = store.get_providers(&wid).unwrap();
        let provider = providers.iter().find(|p| p.id == "my-llm").unwrap();
        assert_eq!(provider.display_name, "My LLM v2");
        assert_eq!(
            provider.base_url.as_deref(),
            Some("https://api.example.com/v2")
        );
        assert!(provider.authenticated);
        assert!(provider.models.contains(&"gpt-4o".to_owned()));
    }

    #[test]
    fn delete_provider_auth_removes_entry() {
        let _iso = isolate_global_config();
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        store
            .put_provider_auth(
                &wid,
                "to-remove",
                ProviderAuthRequest {
                    api_key: "sk-x".to_owned(),
                    base_url: None,
                    display_name: None,
                    models: vec![],
                },
            )
            .unwrap();

        store.delete_provider_auth(&wid, "to-remove").unwrap();
        let providers = store.get_providers(&wid).unwrap();
        assert!(providers.is_empty());
    }

    /// #742: the whole point of the change. An API key must never land in the
    /// workspace, which is typically a git repo.
    #[test]
    fn put_provider_auth_writes_globally_not_into_the_workspace() {
        let home = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();

        store
            .put_provider_auth(
                &ws_id(dir.path()),
                "my-llm",
                ProviderAuthRequest {
                    api_key: "sk-secret".to_owned(),
                    base_url: None,
                    display_name: None,
                    models: vec![],
                },
            )
            .unwrap();

        assert!(
            !dir.path().join("opencode.json").exists(),
            "provider auth must not create a workspace opencode.json"
        );
        let global =
            std::fs::read_to_string(teamclu_runtime_env::config_store::providers_config_path())
                .unwrap();
        assert!(global.contains("sk-secret"));
    }

    /// The device-level API is what first-run onboarding uses, so it has to work
    /// with no workspace anywhere in sight.
    #[test]
    fn device_provider_auth_round_trips_without_a_workspace() {
        let _iso = isolate_global_config();

        assert!(device_providers().unwrap().is_empty());

        put_device_provider_auth(
            "my-llm",
            ProviderAuthRequest {
                api_key: "sk-device".to_owned(),
                base_url: Some("https://api.example.com/v1".to_owned()),
                display_name: Some("My LLM".to_owned()),
                models: vec![ProviderModelConfig {
                    model_id: "gpt-4".to_owned(),
                    model_name: Some("GPT-4".to_owned()),
                }],
            },
        )
        .unwrap();

        let providers = device_providers().unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "my-llm");
        assert_eq!(providers[0].display_name, "My LLM");
        assert!(providers[0].authenticated);
        assert!(providers[0].models.contains(&"gpt-4".to_owned()));

        delete_device_provider_auth("my-llm").unwrap();
        assert!(device_providers().unwrap().is_empty());
    }

    /// Team credentials are daemon-reconciled and not the user's to configure,
    /// so the device-level list must not surface them.
    #[test]
    fn device_providers_excludes_the_legacy_workspace_entries() {
        let _iso = isolate_global_config();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("teamclu.json"),
            r#"{ "provider": { "team": { "options": { "apiKey": "sk-team" } } } }"#,
        )
        .unwrap();

        put_device_provider_auth(
            "mine",
            ProviderAuthRequest {
                api_key: "sk-mine".to_owned(),
                base_url: None,
                display_name: None,
                models: vec![],
            },
        )
        .unwrap();

        let device = device_providers().unwrap();
        assert_eq!(device.len(), 1);
        assert_eq!(device[0].id, "mine");

        // The workspace-scoped view still shows both.
        let store = make_store();
        let ids: Vec<_> = store
            .get_providers(&ws_id(dir.path()))
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert!(ids.contains(&"team".to_owned()));
        assert!(ids.contains(&"mine".to_owned()));
    }

    #[test]
    fn providers_json_round_trip_preserves_unknown_fields() {
        let _iso = isolate_global_config();
        let dir = tempfile::tempdir().unwrap();
        let wid = ws_id(dir.path());

        // Since #742 this is a property of the *global* config: saving a
        // provider must not disturb anything else daemon or user put there.
        let global_path = teamclu_runtime_env::config_store::providers_config_path();
        std::fs::create_dir_all(global_path.parent().unwrap()).unwrap();
        std::fs::write(
            &global_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "provider": {},
                "someOtherKey": "preserved",
                "mcp": { "server1": {} }
            }))
            .unwrap(),
        )
        .unwrap();

        let store = make_store();
        store
            .put_provider_auth(
                &wid,
                "p1",
                ProviderAuthRequest {
                    api_key: "sk".to_owned(),
                    base_url: None,
                    display_name: None,
                    models: vec![],
                },
            )
            .unwrap();

        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&global_path).unwrap()).unwrap();
        assert_eq!(parsed["someOtherKey"], "preserved");
        assert_eq!(parsed["mcp"]["server1"], serde_json::json!({}));
        assert_eq!(parsed["provider"]["p1"]["options"]["apiKey"], "sk");
    }

    #[test]
    fn get_mcp_empty_workspace_returns_empty_map() {
        // `get_mcp` merges the device-scoped `~/.amuxd/mcp.json` into whatever
        // the workspace has, so "empty" is only true of an isolated home. This
        // was the one test in this module that skipped the isolation its
        // neighbours all take, which made it fail on any machine with device
        // MCP servers configured — CI has none, so it passed there and only
        // ever failed for whoever ran the suite locally.
        let _isolation = isolate_global_config();
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let servers = store.get_mcp(&ws_id(dir.path())).unwrap();
        assert!(servers.is_empty());
    }

    #[test]
    fn put_and_get_mcp_round_trips() {
        // `playwright` is device-scoped, so the PUT lands in `~/.amuxd/mcp.json`
        // and the isolation is what keeps this test off the real one.
        let _iso = isolate_global_config();
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        let mut servers = HashMap::new();
        servers.insert(
            "playwright".to_owned(),
            McpServerConfig {
                server_type: "local".to_owned(),
                enabled: Some(true),
                command: vec!["npx".to_owned(), "@playwright/mcp".to_owned()],
                environment: HashMap::new(),
                url: None,
                headers: HashMap::new(),
                timeout: None,
                source: None,
                extra: HashMap::new(),
            },
        );

        let outcome = store.put_mcp(&wid, servers.clone()).unwrap();
        assert!(matches!(outcome, ApplyOutcome::AppliedLive));

        let got = store.get_mcp(&wid).unwrap();
        assert_eq!(got.len(), 1);
        let s = got.get("playwright").unwrap();
        assert_eq!(s.server_type, "local");
        assert_eq!(s.command, vec!["npx", "@playwright/mcp"]);
        assert_eq!(s.enabled, Some(true));
        // Device-scoped: persisted once for the machine, and never copied into
        // the workspace config (a copy there would outrank the device file).
        assert_eq!(s.source.as_deref(), Some("inherent"));
        assert!(
            super::super::team_mcp::read_persisted_mcp(dir.path())
                .unwrap()
                .is_empty(),
            "device server must not be written into the workspace"
        );
        assert!(!dir.path().join("opencode.json").exists());
    }

    #[test]
    fn put_mcp_leaves_providers_alone() {
        let _iso = isolate_global_config();
        let dir = tempfile::tempdir().unwrap();
        let store = make_store();
        let wid = ws_id(dir.path());

        // Seed a provider entry first.
        store
            .put_provider_auth(
                &wid,
                "openai",
                ProviderAuthRequest {
                    api_key: "sk-seed".to_owned(),
                    base_url: None,
                    display_name: None,
                    models: vec![],
                },
            )
            .unwrap();

        // Write MCP config.
        let mut servers = HashMap::new();
        servers.insert(
            "my-server".to_owned(),
            McpServerConfig {
                server_type: "remote".to_owned(),
                enabled: None,
                command: vec![],
                environment: HashMap::new(),
                url: Some("http://localhost:8080".to_owned()),
                headers: HashMap::new(),
                timeout: Some(30),
                source: None,
                extra: HashMap::new(),
            },
        );
        store.put_mcp(&wid, servers).unwrap();

        // Provider section must still be intact.
        let providers = store.get_providers(&wid).unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "openai");
    }

    #[test]
    fn null_store_returns_workspace_not_found() {
        let store: Arc<dyn WorkspaceControlStore> = Arc::new(NullWorkspaceControlStore);
        assert!(matches!(
            store.get_providers("any"),
            Err(WorkspaceControlError::WorkspaceNotFound(_))
        ));
    }

    #[test]
    fn invalid_base64_workspace_id_returns_not_found() {
        let store = make_store();
        assert!(matches!(
            store.get_providers("!!!not-base64!!!"),
            Err(WorkspaceControlError::WorkspaceNotFound(_))
        ));
    }

    #[test]
    fn nonexistent_directory_returns_not_found() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let store = make_store();
        let bogus_id = URL_SAFE_NO_PAD.encode("/tmp/definitely-does-not-exist-xyz123");
        assert!(matches!(
            store.get_providers(&bogus_id),
            Err(WorkspaceControlError::WorkspaceNotFound(_))
        ));
    }
}
