//! Shared skill-creation policy injected into OpenCode, Pi, and Claude Code.

use std::path::Path;

use super::workspace_control::WorkspaceControlError;

pub const SKILL_CREATION_POLICY_VERSION: &str = "2026-08-28-v1";

pub const SKILL_CREATION_POLICY: &str = r#"TeamClu skill creation policy:
- To create a normal reusable skill, call manage_skills with action=create.
- New normal skills are stored under ~/.agents/skills/<slug>/.
- Do not create normal skills under .opencode/skills, .pi/skills, or .claude/skills.
- Do not overwrite an existing, built-in, or team-managed skill.
- Role-specific skills must continue through the role-management workflow."#;

const POLICY_REL: &str = "instructions/skill-creation-policy.txt";

pub fn append_policy_to_prompt(base: &str) -> String {
    if base.contains("manage_skills with action=create") {
        return base.to_string();
    }
    if base.trim().is_empty() {
        return SKILL_CREATION_POLICY.to_string();
    }
    format!("{base}\n\n{SKILL_CREATION_POLICY}")
}

pub fn materialize_policy_file(workspace_path: &Path) -> Result<(), WorkspaceControlError> {
    let path = teamclu_runtime_env::workspace_meta_write_path_from_env(workspace_path, POLICY_REL);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            WorkspaceControlError::Io(format!("create instructions dir: {e}"))
        })?;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing == SKILL_CREATION_POLICY {
        return Ok(());
    }
    std::fs::write(&path, SKILL_CREATION_POLICY.as_bytes()).map_err(|e| {
        WorkspaceControlError::Io(format!("write skill creation policy: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_policy_is_idempotent() {
        let once = append_policy_to_prompt("Hello");
        assert!(once.contains("manage_skills"));
        assert_eq!(once, append_policy_to_prompt(&once));
    }

    #[test]
    fn materialize_policy_uses_brand_meta_dir() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("copilot361");
        let ws = tempfile::tempdir().unwrap();
        materialize_policy_file(ws.path()).unwrap();
        let path = ws.path().join(".copilot361/instructions/skill-creation-policy.txt");
        assert!(path.is_file(), "expected {}", path.display());
        assert!(!ws.path().join(".teamclu/instructions/skill-creation-policy.txt").exists());
    }
}
