//! Daemon-facing helpers for workspace static instructions.
//!
//! The implementation lives in `teamclu-runtime-env` — it moved out of the
//! gateway crate in #933, since a transport adapter should not be the owner of
//! a workspace's agent instructions.

use std::path::Path;

pub use teamclu_runtime_env::{
    claude_md_block_present, load_system_prompt as load_system_prompt_str,
    sync_teamclu_claude_md as sync_teamclu_claude_md_str,
};

pub fn load_system_prompt(workspace: &Path) -> String {
    load_system_prompt_str(&path_to_string(workspace))
}

pub fn sync_teamclu_claude_md(workspace: &Path, prompt: &str) -> Result<(), String> {
    sync_teamclu_claude_md_str(&path_to_string(workspace), prompt)
}

pub fn claude_md_block_present_at(workspace: &Path) -> bool {
    claude_md_block_present(&path_to_string(workspace))
}

fn path_to_string(workspace: &Path) -> String {
    workspace.to_string_lossy().into_owned()
}
