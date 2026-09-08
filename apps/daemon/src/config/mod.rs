mod daemon_config;
pub mod device_mcp;
pub mod edit;
pub mod global_team_store;
pub mod knowledge_scaffold;
pub mod layout;
mod managed_skill_writer;
mod member_store;
mod model_catalog;
mod model_resolution;
pub mod provider_auth;
mod roles_skills;
mod session_store;
mod skill_creation_policy;
pub mod team_config;
pub mod team_mcp;
mod team_skill_draft;
pub mod workspace_control;
mod workspace_instructions;
pub mod workspace_link;
pub mod workspace_path;
mod workspace_resolver;

pub use daemon_config::{
    daemon_host_label, daemon_machine_hostname, ChannelsConfig, ClaudeAgentConfig,
    CursorAgentConfig, DaemonConfig, DiscordChannel, EmailChannel, FeishuChannel, HttpConfig,
    KookChannel, SeaTalkChannel, TeamShareConfig, TransportKind, WeChatChannel, WeComChannel,
    BOOTSTRAP_ACTOR_NAME,
};
// Only test fixtures build a `DaemonConfig` field by field.
#[cfg(test)]
pub use daemon_config::{ActorConfig, AgentBackendConfig, AgentsConfig, MqttConfig};
pub use managed_skill_writer::{
    create_pack, get_pack, pack_digest, update_pack, ClaimedTeamContext, CreatePackRequest,
    ManageSkillResponse, ManagedSkillError, ManagedSkillErrorCode, UpdatePackRequest,
};
pub use member_store::{MemberStore, PendingInvite, StoredMember};
pub use model_catalog::DeviceModelCatalog;
pub use model_resolution::first_available;
pub use roles_skills::{
    find_managed_skill_in_session_inventory, is_inherent_skill, scan_roles_skills_state,
    team_skill_roots,
};
pub use session_store::{SessionBinding, SessionStore};
pub use skill_creation_policy::{
    append_policy_to_prompt, materialize_policy_file, SKILL_CREATION_POLICY,
};
pub use team_skill_draft::{
    get_team_skill_draft, update_team_skill_draft, TeamSkillDraftUpdateResult, TeamSkillDraftView,
};
pub use knowledge_scaffold::{domain_index_template, scaffold_knowledge, ScaffoldReport};
pub use workspace_control::{
    decode_workspace_path, encode_workspace_path, ApplyOutcome, OpenCodeCompatStore,
    ProviderAuthRequest, ProviderModelConfig, WorkspaceControlStore,
};
pub use workspace_instructions::{
    claude_md_block_present_at, load_system_prompt, sync_teamclu_claude_md,
};
pub use workspace_resolver::{resolve_default_workspace_path, WorkspaceResolver};
