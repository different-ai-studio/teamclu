//! Backend abstraction over the daemon's persistent store.
//!
//! The only production implementation is `CloudApiBackend` in
//! `crate::backend::cloud_api`; `MockBackend` (in `mock`) is the test-side
//! impl. Callers bind to `Arc<dyn Backend>` so the daemon's runtime/
//! channel/session machinery can be exercised against an in-memory backend
//! without going through HTTP.
use async_trait::async_trait;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Reconnect transport this long before the cached JWT expires so the broker
/// never serves traffic on a connection whose ACL has silently gone stale.
pub const PROACTIVE_CREDENTIAL_BUFFER: Duration = Duration::from_secs(5 * 60);

/// Current wall-clock time as epoch seconds. JWT expiry from the auth backend is
/// wall-clock based; do not use `Instant` for credential TTL (macOS suspends
/// the monotonic clock while the laptop sleeps).
pub fn epoch_secs_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64
}

/// How long to wait before tearing down the current transport connection and
/// fetching a fresh JWT. Returns zero when a cached expiry is within
/// [`PROACTIVE_CREDENTIAL_BUFFER`]; uses a conservative 50-minute fallback
/// when expiry is unknown.
pub fn proactive_reconnect_delay(expires_at_epoch: Option<i64>) -> Duration {
    match expires_at_epoch {
        Some(exp) => {
            let until_reconnect =
                exp - epoch_secs_now() - PROACTIVE_CREDENTIAL_BUFFER.as_secs() as i64;
            if until_reconnect <= 0 {
                Duration::ZERO
            } else {
                Duration::from_secs(until_reconnect as u64)
            }
        }
        None => Duration::from_secs(50 * 60),
    }
}

/// True when the cached JWT should be refreshed before opening transport.
pub fn credential_in_proactive_refresh_window(expires_at_epoch: Option<i64>) -> bool {
    expires_at_epoch.is_some() && proactive_reconnect_delay(expires_at_epoch) == Duration::ZERO
}

pub mod error;
pub use error::{BackendError, BackendResult};

pub mod cloud_api;
pub mod deferred;

pub mod records;
pub use records::{
    ActorDirectoryRow, BackendParticipantRow, BackendSessionAndParticipants, BackendSessionRow,
    ClaimResult, GatewaySessionRow, SessionRoster, SessionRosterEntry, SessionRosterSelfAgent,
    StoredMessage, WorkspaceRow,
    WorkspaceUpsert,
};

/// MQTT settings delivered by `/v1/config/bootstrap`. The full broker URL
/// (with scheme + port) is the canonical field; credentials are optional and
/// override the values from the local daemon config when present.
#[derive(Debug, Clone)]
pub struct BootstrapMqttOverride {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[cfg(test)]
pub mod mock;

/// One model exposed by the team's managed LLM gateway.
#[derive(Debug, Clone)]
pub struct ManagedLlmModelInfo {
    pub id: String,
    pub name: String,
}

/// One team env secret as the Cloud API returns it: a key id plus the
/// client-encrypted envelope. The daemon never receives plaintext — it writes
/// the envelope to its cache and decrypts locally with the team key.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEnvSecretRow {
    pub key_id: String,
    /// `{v, nonce, ciphertext}`, kept as raw JSON so the cache file is
    /// byte-identical to the `_secrets/<key_id>.enc.json` format the decrypter
    /// already reads.
    pub envelope: serde_json::Value,
}

/// One row of the team skills registry, decorated with the calling actor's
/// install state (`GET /v1/teams/:id/skills`).
///
/// The daemon reads the registry list rather than `/skill-installs` because it
/// needs the metadata too: the frontmatter rewrite that makes a skill legible
/// to an agent (`when_to_use`, `when_not_to_use`, owner) is fed from these
/// fields, and the install list carries only versions.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillRow {
    pub slug: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub when_to_use: String,
    #[serde(default)]
    pub when_not_to_use: String,
    /// jsonb — shape is not fixed, so it stays raw and is flattened to strings
    /// only where the frontmatter needs a list.
    #[serde(default)]
    pub requires: Option<serde_json::Value>,
    #[serde(default)]
    pub owner_actor_id: Option<String>,
    #[serde(default)]
    pub latest_version: i64,
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub installed_version: Option<i64>,
}

/// A short-lived signed URL for one version's package
/// (`GET /v1/teams/:id/skills/:slug/versions/:v/download`).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkillDownload {
    pub url: String,
    #[serde(default)]
    pub content_hash: String,
    #[serde(default)]
    pub size: u64,
}

/// The team's managed (shared) LLM, as sourced from
/// `GET /v1/teams/:id/workspace-config` (`llm.*`). This replaces the old
/// disk-mirrored `_meta/provider.json` so the shared provider converges on first
/// install without waiting for the team git clone. The secret API key is NOT part
/// of this struct — it is derived locally from `actor_id` (`sk-tc-{actor_id[..40]}`)
/// at env-assembly time and never written to disk.
#[derive(Debug, Clone, Default)]
pub struct ManagedLlmConfig {
    /// `false` when the team has no managed LLM enabled (or team-share is unset).
    pub enabled: bool,
    /// Gateway base URL (`llm.baseUrl`, falling back to `llm.aiGatewayEndpoint`).
    pub base_url: Option<String>,
    /// Provider display name; `None` falls back to "Team".
    pub name: Option<String>,
    /// Stored, authoritative per-team model list (`llm.models`).
    pub models: Vec<ManagedLlmModelInfo>,
}

/// The daemon's own agent defaults, sourced from `GET /v1/runtime/agent-defaults`.
/// The gateway path uses these to spawn the daemon's agent with its configured
/// backend type and working directory instead of the daemon-wide fallback type
/// and a throwaway scratch dir. All-`None` means "no override; use defaults".
#[derive(Debug, Clone, Default)]
pub struct AgentDefaults {
    /// `"claude" | "opencode" | "codex"`; `None` when unset.
    pub default_agent_type: Option<String>,
    /// The agent's default workspace UUID (the daemon resolves it to a local
    /// path via `WorkspaceResolver`); `None` when unset.
    pub default_workspace_id: Option<String>,
}

/// Health of the cloud-auth session, surfaced over the local HTTP `/v1/info`
/// endpoint so the desktop can detect a terminally-expired daemon session and
/// auto re-onboard it.
///
/// `terminal_failure == true` means a token refresh was rejected by the auth
/// backend (HTTP 400/401 from `/v1/auth/refresh` — e.g. `refresh_token_not_found`
/// / `invalid_grant`): the stored refresh token will never work again and the
/// daemon needs fresh credentials. Transient failures (network errors, 5xx,
/// rate limits) do NOT set this flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloudAuthSnapshot {
    pub terminal_failure: bool,
}

#[async_trait]
pub trait Backend: Send + Sync {
    // ── Identity ──────────────────────────────────────────────────────────
    /// The team this backend is authenticated against.
    fn team_id(&self) -> &str;

    /// The actor (member or agent) this backend acts as.
    fn actor_id(&self) -> &str;

    // ── Credentials ───────────────────────────────────────────────────────
    /// Current auth token for downstream services (MQTT, etc.). Implementations
    /// are expected to refresh as needed and return a usable bearer string.
    async fn auth_token(&self) -> BackendResult<String>;

    /// Wall-clock expiry of the cached credential (epoch seconds) without
    /// forcing a refresh. `None` if no credential has been fetched yet or the
    /// impl doesn't expose one.
    fn cached_credential_expiry_epoch(&self) -> Option<i64> {
        None
    }

    /// Drop any cached access token so the next [`auth_token`] call refreshes.
    fn invalidate_cached_credential(&self) {}

    /// Snapshot of the cloud-auth session health. `Some` for HTTP-backed cloud
    /// backends; `None` for backends with no remote auth surface (mock). Read by
    /// the local HTTP `/v1/info` handler so the desktop can detect a terminally
    /// expired session and trigger auto re-onboarding. Diagnostic only — callers
    /// must not gate request behavior on it.
    fn cloud_auth_health(&self) -> Option<CloudAuthSnapshot> {
        None
    }

    /// Fetch runtime MQTT broker overrides from the cloud backend. Default
    /// implementation is a no-op for backends that have no remote config
    /// surface (e.g. mock, Supabase).
    async fn fetch_bootstrap_mqtt(&self) -> BackendResult<Option<BootstrapMqttOverride>> {
        Ok(None)
    }

    /// Fetch the team's managed (shared) LLM config from the Cloud API
    /// (`GET /v1/teams/:id/workspace-config` → `llm.*`). Used to materialize
    /// `opencode.json`'s `provider.team` without any disk dependency. Backends
    /// with no HTTP surface (mock) return a disabled config.
    async fn managed_llm_config(&self, _team_id: &str) -> BackendResult<ManagedLlmConfig> {
        Ok(ManagedLlmConfig::default())
    }

    /// Fetch the team MCP servers the calling actor has installed, in the
    /// on-disk Cursor `mcpServers` shape
    /// (`GET /v1/teams/:id/mcp-servers/config`).
    ///
    /// Returned verbatim as JSON rather than parsed into a typed struct
    /// on purpose: `runtime::team_cloud_config` writes the body straight to its
    /// cache file, which `config::team_mcp` then parses with the same code path
    /// it has always used for `.mcp/*.json`. Round-tripping through a Rust type
    /// here would add a second schema to keep in sync for no gain.
    async fn team_mcp_config(&self, _team_id: &str) -> BackendResult<serde_json::Value> {
        Ok(serde_json::json!({ "mcpServers": {} }))
    }

    /// Install a team MCP server for the calling actor
    /// (`PUT /v1/teams/:id/mcp-servers/:name/install`).
    ///
    /// Installing means "run this command on this machine", and the daemon *is*
    /// the actor that spawns/probes it — so the daemon installs for its own
    /// agent actor, never on a human's behalf. Default errors: a backend that
    /// has not wired this up must not let an install silently no-op, because
    /// the merged MCP view would then never contain the server and the UI would
    /// keep reporting zero tools.
    async fn install_team_mcp(&self, _team_id: &str, _name: &str) -> BackendResult<()> {
        Err(BackendError::NotFound(
            "team MCP install unavailable on this backend".to_string(),
        ))
    }

    /// Uninstall a team MCP server for the calling actor
    /// (`DELETE /v1/teams/:id/mcp-servers/:name/install`).
    async fn uninstall_team_mcp(&self, _team_id: &str, _name: &str) -> BackendResult<()> {
        Err(BackendError::NotFound(
            "team MCP uninstall unavailable on this backend".to_string(),
        ))
    }

    /// Fetch the team's env secrets (`GET /v1/teams/:id/env-secrets`).
    ///
    /// Ciphertext only — the envelope is opaque here and stays that way until
    /// the team key decrypts it locally.
    async fn team_env_secrets(&self, _team_id: &str) -> BackendResult<Vec<TeamEnvSecretRow>> {
        Ok(Vec::new())
    }

    /// Fetch the team skills registry decorated with this actor's install state
    /// (`GET /v1/teams/:id/skills`).
    ///
    /// No `actorId` parameter: the endpoint decorates for the caller, and the
    /// daemon's caller *is* the agent actor whose skills it has to materialise.
    ///
    /// The default errors rather than returning an empty list. A backend that
    /// has not implemented this knows nothing about the team's skills, and the
    /// reconcile reads an empty list as "the team removed everything" and
    /// clears the agent's skill root — the one interpretation that must never
    /// be reachable by forgetting to wire something up.
    async fn team_skills(&self, _team_id: &str) -> BackendResult<Vec<TeamSkillRow>> {
        Err(BackendError::NotFound(
            "team skills unavailable on this backend".to_string(),
        ))
    }

    /// Resolve one version's package to a short-lived signed URL
    /// (`GET /v1/teams/:id/skills/:slug/versions/:v/download`).
    async fn team_skill_download(
        &self,
        _team_id: &str,
        _slug: &str,
        _version: i64,
    ) -> BackendResult<TeamSkillDownload> {
        Err(BackendError::NotFound(
            "team skill download unavailable on this backend".to_string(),
        ))
    }

    /// Tell the server which version this actor is now on
    /// (`PUT /v1/teams/:id/skills/:slug/install`).
    ///
    /// Auto-follow moves packs without anyone asking, so without this the
    /// server's `installed_version` freezes at whatever was last installed by
    /// hand and `hasUpdate` stays true forever — the UI then shows a permanent
    /// "updating…" for a pack that is already current.
    async fn record_team_skill_install(
        &self,
        _team_id: &str,
        _slug: &str,
        _version: i64,
    ) -> BackendResult<()> {
        Ok(())
    }

    /// Drop the desired-state record so the reconciler stops reinstalling the
    /// pack. Required, not defaulted: a defaulted `Ok(())` here is a silent
    /// no-op that reports a successful uninstall while the server still says
    /// installed, so the next reconcile puts the pack straight back.
    async fn remove_team_skill_install(&self, team_id: &str, slug: &str) -> BackendResult<()>;

    /// Idempotently ensure the caller's LiteLLM member key is provisioned via
    /// `POST /v1/teams/:id/litellm/member-key`. The key value itself is
    /// deterministic (`sk-tc-{actor_id[..40]}`) and derived locally; this call
    /// only guarantees LiteLLM has actually minted it. Called fire-and-forget as
    /// a self-heal, so failures are non-fatal. No-op default for mock backends.
    async fn ensure_llm_member_key(&self, _team_id: &str) -> BackendResult<()> {
        Ok(())
    }

    /// Fetch the calling member's effective default agent for a team
    /// (member default, else team default, else None) via
    /// `GET /v1/teams/:id/members/me/effective-default-agent`.
    async fn get_effective_default_agent(&self, team_id: &str) -> BackendResult<Option<String>>;

    /// The cloud base URL this backend targets (e.g. `https://cloud.ucar.cc`),
    /// trailing slash trimmed. Used by the sync dispatcher to point the OSS
    /// `FcClient` at the same FC the daemon authenticates against. `None` for
    /// backends with no HTTP surface (mock), so the dispatcher falls back to a
    /// default endpoint.
    fn cloud_base_url(&self) -> Option<String> {
        None
    }

    // ── Business operations ───────────────────────────────────────────────
    /// Claim a team invite token. Used both by the human onboarding path
    /// and by the daemon's `claim_daemon_invite` flow.
    #[allow(dead_code)]
    async fn claim_team_invite(&self, token: &str) -> BackendResult<ClaimResult>;

    /// The workspace `actor_id` works in for `session_id`, from its
    /// participant row. `None` when unset — callers fall back to the agent's
    /// default workspace, the same path a brand-new session takes.
    async fn fetch_session_workspace(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>>;

    /// How far `actor_id` has read in `session_id`, from its participant row.
    /// `None` when there is no participant row or no cursor recorded yet.
    async fn fetch_session_cursor(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>>;

    /// Advertise daemon-supported agent backend types on its `agents` row.
    ///
    /// An empty `supported_types` with `None` default is a real, meaningful
    /// advertise: "this device runs nothing right now". Skipping the call in
    /// that case leaves the last successful answer standing on the row, and
    /// clients keep badging a runtime this machine can no longer start.
    async fn ensure_agent_types(
        &self,
        supported_types: &[String],
        default_agent_type: Option<&str>,
    ) -> BackendResult<()>;

    /// Look up `agent_member_access.permission_level` for a caller.
    /// Returns `Some("admin" | "write" | "view")` or `None`.
    async fn check_agent_permission(
        &self,
        agent_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>>;

    /// Touch `actor_last_active` for the current daemon actor.
    async fn heartbeat(&self) -> BackendResult<()>;

    /// Report this daemon's version to the Cloud API once at startup.
    /// `device_id` is supplied by the caller (the bin crate owns the persisted
    /// device-id module) so this trait stays self-contained for test crates that
    /// pull `backend/` in via `#[path]`.
    async fn report_client_version(&self, device_id: &str) -> BackendResult<()>;

    /// Upsert a `workspaces` row, returning the canonical id.
    async fn upsert_workspace(&self, row: &WorkspaceUpsert<'_>) -> BackendResult<WorkspaceRow>;

    /// Resolve workspace UUIDs to their canonical rows (id/team_id/path). Used
    /// by the daemon to look up a workspace's filesystem path from the cloud
    /// `amux.workspaces` table instead of the local `workspaces.toml`.
    async fn get_workspaces_by_ids(&self, ids: &[String]) -> BackendResult<Vec<WorkspaceRow>>;

    /// List every workspace row (id/team_id/path) belonging to `team_id`,
    /// across all devices. Used by the daemon's team-link sweep, which then
    /// filters to paths that exist on *this* machine before symlinking.
    async fn get_workspaces_by_team(&self, team_id: &str) -> BackendResult<Vec<WorkspaceRow>>;

    /// The rows `agent_id` itself registered — i.e. *this* device's workspaces.
    ///
    /// The team-wide list is not a usable substitute: the same path is
    /// registered once per agent, so `/Users/me/Project` can appear a dozen
    /// times across devices, and filtering those by "does this path exist
    /// locally" keeps every duplicate whose path happens to match. Anything
    /// presenting a workspace list *for this machine* (the desktop settings
    /// panel, `/workspaces` in a channel, the daemon's own HTTP list) must ask
    /// by agent, which is what the desktop already does.
    ///
    /// The default impl filters the team list client-side; backends with a
    /// query surface should override it.
    async fn get_workspaces_by_agent(
        &self,
        team_id: &str,
        agent_id: &str,
    ) -> BackendResult<Vec<WorkspaceRow>> {
        Ok(self
            .get_workspaces_by_team(team_id)
            .await?
            .into_iter()
            .filter(|row| row.agent_id.as_deref() == Some(agent_id))
            .collect())
    }

    /// Set `agents.default_workspace_id` for the current daemon actor.
    async fn set_agent_default_workspace(&self, workspace_id: &str) -> BackendResult<()>;

    /// Fetch an agent's defaults (backend type + default workspace) from the
    /// Cloud API. Used by the gateway path to spawn the daemon's own agent with
    /// its configured type/workspace. Backends without an HTTP surface return
    /// all-`None` defaults (the gateway then falls back to daemon-wide defaults).
    async fn get_agent_defaults(&self, _agent_id: &str) -> BackendResult<AgentDefaults> {
        Ok(AgentDefaults::default())
    }

    /// Fetch a `sessions` row alongside its `session_participants`.
    async fn fetch_session_with_participants(
        &self,
        session_id: &str,
    ) -> BackendResult<BackendSessionAndParticipants>;

    /// Display names for seated session participants via
    /// `GET /v1/sessions/{sessionId}/roster`.
    async fn get_session_roster(&self, session_id: &str) -> BackendResult<SessionRoster>;

    /// Resolve actor UUIDs to their directory entries (name + actor type).
    ///
    /// Default impl returns nothing so a backend with no directory surface
    /// degrades to an unnamed roster instead of failing the caller.
    async fn get_actors_by_ids(&self, _ids: &[String]) -> BackendResult<Vec<ActorDirectoryRow>> {
        Ok(Vec::new())
    }

    /// Messages for `session_id` ordered ascending, with optional exclusive
    /// cursor — messages at or before `after_id` are dropped.
    async fn messages_after_cursor(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>>;

    /// Persist the read cursor on the participant row that owns it (ADR-0005),
    /// addressed by (session, actor) rather than by a per-spawn row id.
    async fn update_session_cursor(
        &self,
        session_id: &str,
        actor_id: &str,
        last_processed_message_id: &str,
    ) -> BackendResult<()>;

    /// Persist the model this agent runs on for this session — same participant
    /// row and same (session, actor) addressing as the cursor above.
    ///
    /// The daemon is the only writer: it is the only component that observes
    /// which model a runtime actually settled on, and the only one present for
    /// gateway and cron sessions, where no client is (ADR-0007).
    async fn update_participant_model(
        &self,
        session_id: &str,
        actor_id: &str,
        model: &str,
    ) -> BackendResult<()>;

    /// Upsert an `actors` row of type `external` keyed on
    /// `(team_id, source, source_id)`. Returns the actor's UUID.
    async fn rpc_upsert_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> BackendResult<String>;

    /// Look up `(sessions.id, chat URI)` for a gateway session by its
    /// SQL-minted `acp_session_id`. Returns `None` when no row matches.
    ///
    /// The chat URI is the row's `gateway_key` — the conversation the session
    /// belongs to for its whole life — falling back to `binding` on a server
    /// that predates the field. Deliberately not `binding` alone: that is
    /// released when `/new` moves the chat onto a fresh session, so asking a
    /// superseded session which chat it came from answered "none", and the
    /// caller reported the chat as having no history at all.
    async fn get_gateway_session_by_acp_id(
        &self,
        acp_session_id: &str,
    ) -> BackendResult<Option<(String, Option<String>)>>;

    /// The chat a session is bound to, by cloud session id.
    ///
    /// The by-ACP lookup above cannot answer this: a message arriving over
    /// `session/{id}/live` carries the cloud id and nothing else, and that is
    /// exactly when we need to know whether the session has a chat on the
    /// other end.
    ///
    /// Default impl reports "not bound" so a backend with no gateway surface
    /// treats every session as desktop-only rather than failing the caller.
    async fn get_session_binding(&self, _session_id: &str) -> BackendResult<Option<String>> {
        Ok(None)
    }

    /// Release a gateway chat's binding so the next inbound message opens a
    /// new session; the old row keeps its history. Returns whether anything
    /// was detached (`false` for an unknown id or a non-gateway session).
    ///
    /// Default impl reports "nothing detached" so backends without a gateway
    /// surface degrade to a plain runtime reset instead of failing `/clear`.
    async fn rpc_detach_gateway_session(&self, _acp_session_id: &str) -> BackendResult<bool> {
        Ok(false)
    }

    /// One gateway chat's own sessions, newest first: the currently-bound one
    /// plus every session `/new` detached from it. `gateway_key` is the chat's
    /// binding, which — unlike `binding` itself — survives a detach.
    ///
    /// Required, deliberately. This used to default to `Ok(Vec::new())` on the
    /// theory that a backend without a gateway surface should answer
    /// `/sessions` with "no sessions" rather than an error. What it actually
    /// did was hide a missing forward: `DeferredBackend` wraps the real client
    /// on *every* startup path and simply never implemented this, so every
    /// `/sessions` in every chat answered "no sessions" from the default body
    /// without one packet leaving the daemon — for weeks, with no error and no
    /// log line. An implementor that genuinely has no gateway surface can
    /// still return an empty vec; it just has to say so out loud.
    async fn rpc_list_gateway_sessions(
        &self,
        team_id: &str,
        gateway_key: &str,
        limit: u32,
    ) -> BackendResult<Vec<GatewaySessionRow>>;

    /// Point a chat's binding at one of that chat's existing sessions — the
    /// inverse of `rpc_detach_gateway_session`. Returns the target's
    /// `acp_session_id` on success, or `None` when the session is unknown or
    /// belongs to a different chat (which the caller must report as such rather
    /// than as a completed switch).
    ///
    /// Required for the same reason as `rpc_list_gateway_sessions` above: its
    /// `Ok(None)` default made `/sessions <n>` report "cannot switch" on a
    /// perfectly valid session id.
    async fn rpc_attach_gateway_session(
        &self,
        binding: &str,
        session_id: &str,
    ) -> BackendResult<Option<String>>;

    /// Resolve (or create) the `sessions` row for a gateway binding.
    /// Returns `(session_id, acp_session_id, created)`.
    #[allow(clippy::too_many_arguments)]
    async fn rpc_ensure_gateway_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
        primary_agent_actor_id: &str,
        owner_member_actor_ids: &[String],
        participant_actor_ids: &[String],
    ) -> BackendResult<(String, String, bool)>;

    /// Insert one row into `public.messages` from a gateway message.
    /// Idempotent on `(session_id, external_id)`.
    async fn insert_gateway_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String>;

    /// Same as `insert_gateway_message` but stored with the `agent_reply`
    /// message kind so clients render it as an assistant turn rather than a
    /// user message. The default delegates to `insert_gateway_message` (which
    /// stores `text`); real backends override to set the correct kind.
    async fn insert_gateway_agent_reply(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        self.insert_gateway_message(session_id, sender_actor_id, content, external_message_id)
            .await
    }

    /// Same as `insert_gateway_message`, with an `attachments` JSON array.
    async fn insert_gateway_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: serde_json::Value,
    ) -> BackendResult<String>;

    /// Same as `insert_gateway_agent_reply`, with an `attachments` JSON array.
    ///
    /// Separate from the message variant because the kind is what decides which
    /// side of the conversation a row renders on: a file the agent sent is not
    /// something the user said.
    async fn insert_gateway_agent_reply_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: serde_json::Value,
    ) -> BackendResult<String>;

    /// Upload bytes to the attachments bucket.
    async fn upload_attachment_bytes(
        &self,
        path: &str,
        bytes: Vec<u8>,
        mime: &str,
    ) -> BackendResult<String>;

    /// Return admin member actor ids granted access to `agent_actor_id`.
    async fn list_agent_admin_member_actor_ids(
        &self,
        agent_actor_id: &str,
    ) -> BackendResult<Vec<String>>;

    /// Ask Cloud API to validate a short-lived management grant. The Cloud
    /// caller is this daemon's own Agent identity, so the server can also prove
    /// the verifier is the grant's target instead of trusting the RPC payload.
    ///
    /// `request_id` is part of what is verified: a grant is minted for exactly
    /// one RPC request id, so a captured grant cannot be spent on a second
    /// call — the repeat lands on the id the Agent has already answered.
    ///
    /// Required, not defaulted. This method sits on the authorization path for
    /// every capability-management RPC, and `DeferredBackend` — the wrapper the
    /// daemon actually runs — forwards the trait method by method, by hand. A
    /// defaulted "unsupported" body there compiles clean and then rejects every
    /// request at runtime with an error that reads like a version mismatch.
    /// Leaving it required turns a forgotten forward into a compile error.
    async fn verify_agent_management_grant(
        &self,
        grant: &str,
        scope: &str,
        requester_actor_id: &str,
        request_id: &str,
    ) -> BackendResult<()>;

    /// Update a session's title. Default is a no-op so test doubles and
    /// backends without session storage don't have to care.
    async fn update_session_title(&self, _session_id: &str, _title: &str) -> BackendResult<()> {
        Ok(())
    }

    /// Add (or ignore-if-present) a participant on `session_participants`.
    async fn upsert_session_participant(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<()>;

    /// Create a `sessions` row for a cron-triggered turn and seed
    /// participants (primary agent + that agent's admin members).
    ///
    /// `cron_job_id` is the desktop-local cron job id (`cron/<jobId>/<runId>`
    /// middle segment), persisted as `sessions.cron_job_id` to mark
    /// scheduled-origin sessions.
    async fn create_cron_session(
        &self,
        team_id: &str,
        primary_agent_actor_id: &str,
        title: &str,
        cron_job_id: Option<&str>,
    ) -> BackendResult<String>;

    /// Insert one row into `public.messages` from the daemon's runtime.
    #[allow(clippy::too_many_arguments)]
    async fn insert_message(
        &self,
        id: &str,
        team_id: &str,
        session_id: &str,
        sender_actor_id: &str,
        kind: &str,
        content: &str,
        metadata_json: &str,
        model: &str,
        turn_id: &str,
        reply_to_message_id: &str,
        sequence: u64,
    ) -> BackendResult<()>;
}

#[cfg(test)]
mod proactive_refresh_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn proactive_delay_is_zero_inside_five_minute_buffer() {
        let expiry = epoch_secs_now() + 2 * 60;
        assert!(credential_in_proactive_refresh_window(Some(expiry)));
        assert_eq!(proactive_reconnect_delay(Some(expiry)), Duration::ZERO);
    }

    #[test]
    fn proactive_delay_is_positive_outside_buffer() {
        let expiry = epoch_secs_now() + 10 * 60;
        assert!(!credential_in_proactive_refresh_window(Some(expiry)));
        assert!(proactive_reconnect_delay(Some(expiry)) > Duration::from_secs(4 * 60));
    }

    #[test]
    fn unknown_expiry_uses_conservative_fallback() {
        assert!(!credential_in_proactive_refresh_window(None));
        assert_eq!(
            proactive_reconnect_delay(None),
            Duration::from_secs(50 * 60)
        );
    }
}
