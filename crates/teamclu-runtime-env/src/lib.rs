pub mod active_session;
pub mod session_context;
pub mod amuxd_layout;
pub mod atomic_write;
pub mod env_activation;
pub mod env_catalog;
pub mod mcp_resolve;
pub mod merge;
pub mod opencode_config;
pub mod opencode_db;
pub mod personal_secrets;
pub mod resolved_env;
pub mod storage_namespace;
pub mod team_crypto;
pub mod team_provider;
pub mod team_provider_sync;
pub mod version;
pub mod workspace_instructions;

/// Ratchet keeping home-directory names spelled in `storage_namespace` only.
/// Test-only: it scans the repo and has no runtime surface.
#[cfg(test)]
mod storage_lint;
#[cfg(test)]
pub mod test_util;

use std::collections::HashMap;
use std::path::Path;

pub use active_session::{
    clear_active_session_id_if_matches, read_active_session_id, write_active_session_id,
    ACTIVE_SESSION_ID_FILE, TEAMCLU_SESSION_ID_ENV,
};
pub use session_context::{
    is_session_scoped_mcp_tool, require_explicit_session_id_from_env,
    SESSION_SCOPED_MCP_TOOLS, TEAMCLU_AGENT_BACKEND_ENV, TEAMCLU_HOST_GENERATION_ID_ENV,
    TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID_ENV, TEAMCLU_RUNTIME_CONTEXT_TOKEN_ENV,
    TEAMCLU_RUNTIME_CONTEXT_URL_ENV,
};
pub use env_activation::{
    analyze_env_activation, find_unresolved_config_placeholders, EnvActivationAnalysis,
    EnvActivationInput, EnvKeyActivationStatus, UnresolvedConfigPlaceholder,
};
pub use merge::{host_shadowed_env_keys, secrets_for_team_provider, tc_api_key_for_actor};
pub use personal_secrets::{
    count_user_personal_env_keys, diagnose_personal_env_store,
    diagnose_personal_env_store_for_brand, is_internal_personal_blob_key,
    merge_personal_env_index, personal_env_index_path_for_brand,
    read_personal_env_index_for_brand, write_personal_env_index_for_brand,
    PersonalEnvIndexEntry, PersonalEnvStoreDiagnostics,
};
pub use resolved_env::{
    resolve_runtime_env, EnvOverride, EnvOverrideKind, EnvProvenance, EnvScope, EnvSource,
    ResolvedEnvSnapshot, UnresolvedEnv, UnresolvedReason,
};
pub use team_provider::{
    managed_llm_provider_from_disk_team, read_global_team_provider,
    stabilize_managed_llm_for_spawn, team_provider_env_payload, ManagedLlmModel,
    ManagedLlmProvider, ManagedLlmState,
};
pub use team_provider_sync::{
    resolve_workspace_runtime_config, sync_global_team_provider, SecretResolveScope,
    TeamProviderSyncResult,
};

pub use amuxd_layout::{active_team as active_amuxd_team, team_state_dir as amuxd_team_state_dir};
pub use workspace_instructions::{
    claude_md_block_present, load_system_prompt, sync_teamclu_claude_md,
};
pub use storage_namespace::{
    amuxd_home_for_brand, amuxd_home_from_env, brand_display_name_from_env, brand_home_dir,
    brand_short_name_from_env, is_official_brand, resolve_amuxd_dir_name, resolve_storage_dir_name,
    resolve_workspace_config_path, resolve_workspace_config_path_from_env,
    resolve_workspace_meta_path, resolve_workspace_meta_path_from_env, workspace_config_file_name,
    workspace_config_path, workspace_config_path_from_env, workspace_meta_dir,
    workspace_meta_dir_from_env, workspace_meta_dir_name, workspace_meta_read_roots,
    workspace_meta_write_path, workspace_meta_write_path_from_env, AMUXD_HOME_ENV,
    APP_DISPLAY_NAME_ENV, BRAND_SHORT_NAME_ENV, LEGACY_BRAND_CONFIG_FILE, LEGACY_BRAND_STORAGE_DIR,
    LEGACY_BRAND_TEAM_SHARED_DIR_NAME, LEGACY_BRAND_WORKSPACE_META_DIR,
    LEGACY_OFFICIAL_DEV_CONFIG_FILE, LEGACY_OFFICIAL_DEV_STORAGE_DIR, OFFICIAL_AMUXD_DIR_NAME,
    OFFICIAL_STORAGE_DIR, REBRAND_NAMESPACE_MIGRATION_MARKER, ROOT_ALLOWLIST,
    STORAGE_NAMESPACE_MIGRATION_MARKER, TEAM_SHARED_DIR_NAME, WORKSPACE_CONFIG_FILE,
    WORKSPACE_META_DIR,
};

/// Same as [`OFFICIAL_STORAGE_DIR`] — kept for existing call sites.
pub const APP_SECRETS_DIR: &str = OFFICIAL_STORAGE_DIR;
pub const DEFAULT_TEAM_REPO_DIR: &str = "teamclu-team";

#[derive(Debug, Clone, Default)]
pub struct RuntimeEnvBundle {
    pub extra_env: HashMap<String, String>,
    pub resolved_env: ResolvedEnvSnapshot,
    pub opencode_json_original: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SystemEnvContext {
    pub actor_id: String,
    pub display_name: String,
    /// Absolute path to a file the daemon keeps refreshed with the current
    /// cloud access token (JWT). Injected as `TC_ACCESS_TOKEN_FILE` so a
    /// long-running agent can re-read a *fresh* token whenever it needs one —
    /// the token itself is never injected into the env, since env values are
    /// frozen at spawn and the JWT expires (~1h) well before a multi-day
    /// session ends. `None` when there is no cloud backend to source it from.
    pub cloud_token_file: Option<String>,
}

pub fn assemble_runtime_env(
    workspace: &Path,
    team_env: HashMap<String, String>,
    system: SystemEnvContext,
    managed_llm: &ManagedLlmState,
) -> anyhow::Result<RuntimeEnvBundle> {
    opencode_db::maybe_migrate_legacy_opencode_db(workspace)?;

    let personal = personal_secrets::load_personal_env()?;
    let resolved_env = resolved_env::resolve_runtime_env(personal, team_env, system);
    sync_global_team_provider(managed_llm, &resolved_env.bindings)?;
    let sync = resolve_workspace_runtime_config(
        workspace,
        &resolved_env.bindings,
        SecretResolveScope::FullConfig,
    )?;
    Ok(RuntimeEnvBundle {
        extra_env: resolved_env.bindings.clone(),
        resolved_env,
        opencode_json_original: sync.opencode_json_original,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_provider::{ManagedLlmModel, ManagedLlmProvider};

    #[test]
    fn assemble_runtime_env_materializes_team_provider_on_spawn() {
        let _lock = crate::test_util::home_env_lock();
        let global_dir = tempfile::tempdir().unwrap();
        let _amuxd_home = crate::test_util::AmuxdHomeGuard::set(global_dir.path());
        std::fs::write(
            global_dir.path().join("daemon.toml"),
            "active_team = \"team-test\"\n",
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("opencode.json"), "{}").unwrap();

        let managed = ManagedLlmState::Enabled(ManagedLlmProvider {
            name: "Team".to_string(),
            base_url: "https://gateway.example/v1".to_string(),
            models: vec![ManagedLlmModel {
                id: "model-a".to_string(),
                name: "Model A".to_string(),
            }],
        });

        let bundle = assemble_runtime_env(
            dir.path(),
            HashMap::new(),
            SystemEnvContext {
                actor_id: "spawn-actor".to_string(),
                display_name: String::new(),
                cloud_token_file: None,
            },
            &managed,
        )
        .unwrap();

        assert_eq!(
            bundle.extra_env.get("tc_api_key").map(String::as_str),
            Some("sk-tc-spawn-actor")
        );

        let raw = std::fs::read_to_string(
            global_dir
                .path()
                .join("teams/team-test/state/opencode.json"),
        )
        .unwrap();
        assert!(raw.contains("sk-tc-spawn-actor"));
        assert!(raw.contains("model-a"));
        let workspace_raw = std::fs::read_to_string(dir.path().join("opencode.json")).unwrap();
        assert!(!workspace_raw.contains("\"team\""));
        assert!(bundle.opencode_json_original.is_none());
    }
}
