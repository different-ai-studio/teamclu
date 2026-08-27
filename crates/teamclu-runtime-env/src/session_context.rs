//! Request-scoped TeamClu session context for MCP tools under concurrent sessions.
//!
//! Backend adapters resolve a backend session to a TeamClu cloud session via the
//! daemon's internal loopback API instead of worktree-level ambient state.

pub const TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID_ENV: &str = "TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID";
pub const TEAMCLU_RUNTIME_CONTEXT_URL_ENV: &str = "TEAMCLU_RUNTIME_CONTEXT_URL";
pub const TEAMCLU_RUNTIME_CONTEXT_TOKEN_ENV: &str = "TEAMCLU_RUNTIME_CONTEXT_TOKEN";
pub const TEAMCLU_HOST_GENERATION_ID_ENV: &str = "TEAMCLU_HOST_GENERATION_ID";
pub const TEAMCLU_AGENT_BACKEND_ENV: &str = "TEAMCLU_AGENT_BACKEND";

/// Session-scoped TeamClu MCP tools that must receive an explicit `session_id`.
pub const SESSION_SCOPED_MCP_TOOLS: &[&str] = &[
    "get_session_deeplink",
    "manage_participants",
    "archive_session",
];

pub fn is_session_scoped_mcp_tool(name: &str) -> bool {
    let base = name
        .rsplit('/')
        .next()
        .unwrap_or(name)
        .trim();
    SESSION_SCOPED_MCP_TOOLS.contains(&base)
}

pub fn require_explicit_session_id_from_env() -> bool {
    matches!(
        std::env::var(TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID_ENV)
            .ok()
            .as_deref()
            .map(str::trim),
        Some("1" | "true" | "yes")
    )
}

/// Standalone CLI / legacy paths: warn once per process when falling back to the
/// workspace `active-session-id` file (Phase 2 deprecation).
pub fn warn_deprecated_active_session_file_fallback() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static WARNED: AtomicBool = AtomicBool::new(false);
    if WARNED
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
    {
        eprintln!(
            "warning: resolving session_id from workspace active-session-id is deprecated; \
             pass session_id explicitly or run under a daemon-managed agent runtime"
        );
    }
}
