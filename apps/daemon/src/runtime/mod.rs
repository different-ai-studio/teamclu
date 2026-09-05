pub mod acp_envelope;
pub mod acp_event_frame;
pub mod acp_live_transport;
pub mod acp_translate;
pub mod backend;
pub mod backend_session_metadata;
pub mod execution_context;
pub mod host_pool_stats;
pub mod pi_rpc;
pub mod spawn_path;
mod agent_runtime_state;
mod agent_trace;
pub mod context_registry;
pub mod context_service;
pub mod env_assembly;
pub mod gateway_token;
mod handle;
mod instruction_delivery;
pub mod managed_llm;
mod manager;
mod native_skill_fallback_guard;
pub(crate) mod skills_bridge;
pub(crate) use native_skill_fallback_guard::{
    apply_violations_to_emitted, ensure_turn_guard, event_may_open_implicit_turn, guard_enabled,
    prepare_guard_for_acp_event, snapshot_baseline, take_violations_for_turn_end,
    violations_after_turn, NativeSkillBaseline, NativeSkillTurnGuard, NativeSkillViolation,
    AGENT_REPLY_CONTENT,
};
pub mod permission_policy;
pub mod prompt_attachments;
pub mod refresh;
pub mod session_prompt;
pub mod supervisor;
pub mod team_cloud_config;
pub mod team_skills;
#[cfg(test)]
pub(crate) mod test_support;
pub mod turn_aggregator;
pub mod well_known_bin;
mod workspace_runtime;

pub use backend::{
    create_backend, AcpCommand, AcpStartupMetadata, AgentBackend, ForkSpec,
};
pub use context_service::RuntimeContextService;
pub use handle::{InjectedContextItem, PendingMessage, RuntimeHandle};
pub use instruction_delivery::{
    resolve_instruction_delivery, skips_buffered_inject, InstructionDelivery,
};
pub use manager::{
    is_gateway_workspace_id, restore_gateway_shape_for_resume, AgentLaunchConfig, CheckedOutTurn,
    RuntimeManager, SpawnRuntimeEnv, WorkspaceOccupancy,
};
pub use permission_policy::PermissionPolicy;
pub use session_prompt::{SessionPromptResponse, SessionPromptService};
pub use supervisor::RuntimeSupervisor;
pub use workspace_runtime::{apply_workspace_system_instructions, instruction_plugin_installed};

/// A credential from the user's personal secret store
/// (`~/.{brand}/secrets/personal-secrets.json.enc`, desktop-owned, daemon
/// read-only). Where `agents.{cursor,claude}.api_key` went: an API key is a
/// personal credential, not machine configuration, so it lives with the rest
/// of the user's personal env instead of in plaintext daemon.toml.
#[allow(dead_code)]
pub(crate) fn personal_api_key(name: &str) -> Option<String> {
    teamclu_runtime_env::personal_secrets::load_personal_env()
        .ok()
        .and_then(|mut env| env.remove(name))
        .filter(|v| !v.trim().is_empty())
}
