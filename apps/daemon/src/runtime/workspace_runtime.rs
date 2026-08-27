use std::path::Path;

use super::instruction_delivery::{resolve_instruction_delivery, skips_buffered_inject};
use super::RuntimeManager;
use crate::config::{claude_md_block_present_at, load_system_prompt};
use crate::proto::amux;

pub const INSTRUCTION_PLUGIN_REL: &str = ".opencode/plugins/teamclu-instruction.mjs";
pub const INSTRUCTION_PLUGIN_CONFIG_ENTRY: &str = "./.opencode/plugins/teamclu-instruction.mjs";
pub const SESSION_CONTEXT_PLUGIN_REL: &str = ".opencode/plugins/teamclu-session-context.mjs";
pub const SESSION_CONTEXT_CLIENT_REL: &str = ".opencode/plugins/teamclu-session-context-client.mjs";
pub const SESSION_CONTEXT_PLUGIN_CONFIG_ENTRY: &str =
    "./.opencode/plugins/teamclu-session-context.mjs";

pub fn instruction_plugin_installed(worktree: &Path) -> bool {
    if !worktree.join(INSTRUCTION_PLUGIN_REL).is_file() {
        return false;
    }
    let config_path = worktree.join("opencode.json");
    let Ok(raw) = std::fs::read_to_string(config_path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    value
        .get("plugin")
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries.iter().any(|entry| {
                entry
                    .as_str()
                    .map(|s| s.contains("teamclu-instruction"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

pub fn apply_workspace_system_instructions(
    agents: &mut RuntimeManager,
    runtime_id: &str,
    worktree: &Path,
    agent_type: amux::AgentType,
) -> crate::error::Result<()> {
    let prompt = load_system_prompt(worktree);
    let delivery = resolve_instruction_delivery(
        agent_type,
        instruction_plugin_installed(worktree),
        claude_md_block_present_at(worktree),
    );

    if let Some(handle) = agents.get_handle_mut(runtime_id) {
        handle.instruction_delivery = delivery;
    }

    if !skips_buffered_inject(delivery) && !prompt.is_empty() {
        agents.inject_context_for_runtime(runtime_id, "system", &prompt)?;
    }

    Ok(())
}
