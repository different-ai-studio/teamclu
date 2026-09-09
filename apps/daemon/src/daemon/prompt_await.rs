/// Keep in sync with `apps/desktop/src/commands/cron/types.rs`.
pub(crate) const DEFAULT_CRON_WALL_TIMEOUT_SECS: u64 = 3600;
pub(crate) const MAX_CRON_WALL_TIMEOUT_SECS: u64 = 3600;
pub(crate) const MIN_CRON_WALL_TIMEOUT_SECS: u64 = 60;
pub(crate) const DEFAULT_CRON_IDLE_TIMEOUT_SECS: u64 = 300;
pub(crate) const MAX_CRON_IDLE_TIMEOUT_SECS: u64 = 1800;

#[derive(Debug)]
pub(crate) struct PromptAwaitPayload<'a> {
    pub session_key: &'a str,
    pub message: &'a str,
    /// Human-readable name of the cron job. Used to construct the cloud
    /// session title ("Cron: <job_name>"). Optional; when absent the daemon
    /// falls back to "Cron job".
    pub job_name: Option<&'a str>,
    pub working_directory: Option<&'a str>,
    pub workspace_root: Option<&'a str>,
    pub model_override: Option<(String, String)>,
    // Backend the cron job should run on, e.g. "opencode" | "claude" | "codex".
    // Optional: when absent the daemon falls back to default_agent_type, which
    // is the desktop's "auto" selection. The string is resolved against the
    // daemon's configured backends by the caller (handle_prompt_await).
    pub agent_type: Option<&'a str>,
    /// Permission mode the job runs under: `"full_access"` (no approvals, the
    /// desktop default for cron) or `"default"` (ask, which for an unattended
    /// run means the turn waits until the timeout). Absent for jobs saved by a
    /// desktop that predates the field — those keep full access.
    pub permission_mode: Option<&'a str>,
    /// Hard wall-clock cap for the whole turn, in seconds.
    pub timeout_secs: u64,
    /// Silence budget: how long the turn may go without ACP progress. Reset on
    /// every event inside `drive_cron_turn`.
    pub idle_timeout_secs: u64,
}

pub(crate) fn parse_prompt_await_payload(
    payload: &serde_json::Value,
) -> anyhow::Result<PromptAwaitPayload<'_>> {
    let session_key = payload
        .get("session_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("prompt-await: missing 'session_key'"))?;
    if !session_key.starts_with("cron/") {
        anyhow::bail!("prompt-await: session_key must start with 'cron/' (got {session_key:?})");
    }
    let message = payload
        .get("message")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("prompt-await: missing 'message'"))?;
    if message.is_empty() {
        anyhow::bail!("prompt-await: 'message' must not be empty");
    }
    let job_name = payload
        .get("job_name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let working_directory = payload
        .get("working_directory")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let workspace_root = payload
        .get("workspace_root")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let model_override = payload
        .get("model_override")
        .and_then(|v| v.as_object())
        .and_then(|m| {
            let p = m.get("provider").and_then(|v| v.as_str())?;
            let mo = m.get("model").and_then(|v| v.as_str())?;
            Some((p.to_string(), mo.to_string()))
        });
    let agent_type = payload
        .get("agent_type")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let permission_mode = payload
        .get("permission_mode")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let timeout_secs = payload
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_CRON_WALL_TIMEOUT_SECS)
        .clamp(MIN_CRON_WALL_TIMEOUT_SECS, MAX_CRON_WALL_TIMEOUT_SECS);
    let idle_timeout_secs = payload
        .get("idle_timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_CRON_IDLE_TIMEOUT_SECS)
        .clamp(30, MAX_CRON_IDLE_TIMEOUT_SECS)
        .min(timeout_secs);

    Ok(PromptAwaitPayload {
        session_key,
        message,
        job_name,
        working_directory,
        workspace_root,
        model_override,
        agent_type,
        permission_mode,
        timeout_secs,
        idle_timeout_secs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_rejects_missing_session_key() {
        let p = json!({ "message": "hi" });
        let err = parse_prompt_await_payload(&p).unwrap_err();
        assert!(err.to_string().contains("session_key"), "got: {err}");
    }

    #[test]
    fn parse_rejects_non_cron_session_key() {
        let p = json!({ "session_key": "wecom/x/y", "message": "hi" });
        let err = parse_prompt_await_payload(&p).unwrap_err();
        assert!(
            err.to_string().contains("must start with 'cron/'"),
            "got: {err}"
        );
    }

    #[test]
    fn parse_rejects_empty_message() {
        let p = json!({ "session_key": "cron/j1/r1", "message": "" });
        let err = parse_prompt_await_payload(&p).unwrap_err();
        assert!(err.to_string().contains("message"), "got: {err}");
    }

    #[test]
    fn parse_accepts_minimal_valid_payload() {
        let p = json!({ "session_key": "cron/j1/r1", "message": "hello" });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.session_key, "cron/j1/r1");
        assert_eq!(parsed.message, "hello");
        assert!(parsed.job_name.is_none());
        assert!(parsed.working_directory.is_none());
        assert!(parsed.workspace_root.is_none());
        assert!(parsed.model_override.is_none());
        assert!(parsed.agent_type.is_none());
        assert!(parsed.permission_mode.is_none());
        assert_eq!(parsed.timeout_secs, DEFAULT_CRON_WALL_TIMEOUT_SECS);
        assert_eq!(parsed.idle_timeout_secs, DEFAULT_CRON_IDLE_TIMEOUT_SECS);
    }

    #[test]
    fn parse_accepts_full_payload() {
        let p = json!({
            "session_key": "cron/j1/r1",
            "message": "hello",
            "job_name": "Nightly digest",
            "working_directory": "/repo/.worktrees/cron-j1-r1",
            "workspace_root": "/repo",
            "model_override": { "provider": "anthropic", "model": "sonnet" },
            "agent_type": "claude",
            "timeout_secs": 120
        });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.job_name, Some("Nightly digest"));
        assert_eq!(
            parsed.working_directory,
            Some("/repo/.worktrees/cron-j1-r1")
        );
        assert_eq!(parsed.workspace_root, Some("/repo"));
        assert_eq!(parsed.agent_type, Some("claude"));
        assert_eq!(
            parsed.model_override.as_ref().map(|m| m.0.as_str()),
            Some("anthropic")
        );
        assert_eq!(
            parsed.model_override.as_ref().map(|m| m.1.as_str()),
            Some("sonnet")
        );
        assert_eq!(parsed.timeout_secs, 120);
        assert_eq!(parsed.idle_timeout_secs, 120);
    }

    #[test]
    fn parse_clamps_wall_timeout_to_sixty_minutes() {
        let p = json!({
            "session_key": "cron/j1/r1",
            "message": "hi",
            "timeout_secs": 7200
        });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.timeout_secs, MAX_CRON_WALL_TIMEOUT_SECS);
    }

    #[test]
    fn parse_idle_timeout_never_exceeds_wall_timeout() {
        let p = json!({
            "session_key": "cron/j1/r1",
            "message": "hi",
            "timeout_secs": 120,
            "idle_timeout_secs": 600
        });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.timeout_secs, 120);
        assert_eq!(parsed.idle_timeout_secs, 120);
    }

    #[test]
    fn parse_accepts_optional_job_name() {
        // Empty string is treated as absent (consistent with working_directory).
        let p = json!({ "session_key": "cron/j1/r1", "message": "hi", "job_name": "" });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert!(parsed.job_name.is_none());

        // Non-empty string is preserved.
        let p = json!({ "session_key": "cron/j1/r1", "message": "hi", "job_name": "My Job" });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.job_name, Some("My Job"));
    }

    // ── Regression: cron × backend model override round-trip ──────────────
    //
    // The desktop cron scheduler splits `payload.model` ("provider/model") into
    // (provider, model) and serialises them as separate JSON fields.  The parse
    // layer must capture BOTH so `create_gateway_session_with_model` can pass
    // the full tuple to `resolve_initial_model`.
    //
    // For OpenCode the full re-joined id ("scnet/MiniMax-M2.5") is what the
    // ACP `set_session_model` call expects.  Dropping the provider caused silent
    // fallback to the workspace default — this test documents the contract.

    #[test]
    fn parse_preserves_provider_for_opencode_style_model() {
        // Simulates a cron payload for an OpenCode workspace that has a custom
        // provider "scnet" with model "MiniMax-M2.5".  The provider must NOT be
        // discarded; `resolve_initial_model` will later re-join it.
        let p = json!({
            "session_key": "cron/job-opencode/run-1",
            "message": "summarise PRs",
            "model_override": { "provider": "scnet", "model": "MiniMax-M2.5" }
        });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        let (provider, model) = parsed.model_override.unwrap();
        assert_eq!(provider, "scnet");
        assert_eq!(model, "MiniMax-M2.5");
    }

    #[test]
    fn parse_preserves_provider_for_claude_style_model() {
        // Simulates a cron payload for a Claude Code workspace using a short
        // name. `resolve_initial_model` will expand "sonnet" to the full ACP id
        // on the daemon side; the parse layer must just preserve both fields.
        let p = json!({
            "session_key": "cron/job-claude/run-1",
            "message": "run tests",
            "model_override": { "provider": "anthropic", "model": "sonnet" }
        });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        let (provider, model) = parsed.model_override.unwrap();
        assert_eq!(provider, "anthropic");
        assert_eq!(model, "sonnet");
    }

    #[test]
    fn parse_treats_empty_agent_type_as_absent() {
        // The desktop sends `agent_type: ""` for the "auto" selection; it must
        // be treated as absent so the daemon falls back to default_agent_type.
        let p = json!({
            "session_key": "cron/j1/r1",
            "message": "hi",
            "agent_type": ""
        });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert!(parsed.agent_type.is_none());
    }

    #[test]
    fn parse_reads_permission_mode() {
        let p = json!({
            "session_key": "cron/j1/r1",
            "message": "hi",
            "permission_mode": "default"
        });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.permission_mode, Some("default"));

        // Empty string is treated as absent, like the other optional strings.
        let p = json!({ "session_key": "cron/j1/r1", "message": "hi", "permission_mode": "" });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert!(parsed.permission_mode.is_none());
    }

    #[test]
    fn parse_preserves_explicit_agent_type() {
        let p = json!({
            "session_key": "cron/j1/r1",
            "message": "hi",
            "agent_type": "opencode"
        });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.agent_type, Some("opencode"));
    }
}
