use std::path::Path;

use super::instruction_delivery::{resolve_instruction_delivery, skips_buffered_inject};
use super::RuntimeManager;
use crate::config::{
    append_policy_to_prompt, claude_md_block_present_at, load_system_prompt, sync_teamclu_claude_md,
};
use crate::proto::amux;

/// OpenCode plugins are gone (pi-only). System instructions always use buffered inject.
pub fn instruction_plugin_installed(_worktree: &Path) -> bool {
    false
}

pub fn apply_workspace_system_instructions(
    agents: &mut RuntimeManager,
    runtime_id: &str,
    worktree: &Path,
    agent_type: amux::AgentType,
) -> crate::error::Result<()> {
    let prompt = load_system_prompt(worktree);
    let prompt_with_policy = append_policy_to_prompt(&prompt);
    let delivery = resolve_instruction_delivery(
        agent_type,
        instruction_plugin_installed(worktree),
        claude_md_block_present_at(worktree),
    );

    if matches!(
        delivery,
        super::instruction_delivery::InstructionDelivery::NativeClaudeMd
    ) {
        let _ = sync_teamclu_claude_md(worktree, &prompt_with_policy);
    }

    if let Some(handle) = agents.get_handle_mut(runtime_id) {
        handle.instruction_delivery = delivery;
    }

    if !skips_buffered_inject(delivery) && !prompt_with_policy.is_empty() {
        agents.inject_context_for_runtime(runtime_id, "system", &prompt_with_policy)?;
    }

    Ok(())
}
