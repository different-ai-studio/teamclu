//! `AgentHandle` impl: bridges `teamclu_gateway` channels to amuxd's
//! in-process `RuntimeManager` so a chat message arriving over Discord /
//! WeCom / Feishu / etc. drives an agent turn without going through the
//! deprecated opencode HTTP server.
//!
//! ## Logical vs real ACP session ids
//!
//! Channels persist the SQL-minted `acp_session_id` (random hex from
//! `ensure_gateway_session`) on the `sessions` row and then pass it to
//! `send_prompt`. That string is a *logical* id — it was never registered
//! with amuxd's `RuntimeManager`, which only knows real ACP UUIDs returned
//! by `session/new`.
//!
//! To bridge the two, this handle keeps an in-memory `logical_to_acp` map.
//! On `send_prompt`, if the logical id has no entry, we lazy-spawn a fresh
//! agent via `create_gateway_session` and remember the mapping. On amuxd
//! restart the map is empty, so the first prompt for each persisted session
//! re-spawns; old conversation history stays in the cloud backend regardless.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use teamclu_gateway::{
    AgentCommand, AgentError, AgentHandle, AmuxSessionId, ModelInfo, ParticipantInfo, SessionInfo,
    TurnOutcome, WorkspaceInfo,
};

/// How many of a chat's past sessions `/sessions` offers. A long-lived WeCom
/// conversation accumulates one row per `/new`, and a chat bubble listing
/// hundreds of them is unreadable — the newest are the ones anyone switches
/// back to.
const GATEWAY_SESSION_LIST_LIMIT: u32 = 20;
/// Fallback for a caller that does not state its own patience. The real bound
/// comes from the channel's `ChannelCaps::turn_timeout_secs`: 120s was a
/// daemon-wide constant that a WeCom "search the top 10 headlines" turn blew
/// through every time, and no channel could say otherwise.
const GATEWAY_TURN_TIMEOUT_SECS: u64 = 120;

use crate::backend::Backend;
use crate::channels::reply_token;
use crate::proto::amux;
use crate::runtime::execution_context::{ExecutionContext, IsolationDomainKey, WorkspaceIdentity};
use crate::runtime::RuntimeManager;
use crate::runtime::SpawnRuntimeEnv;

/// Cached per-session state that lets `send_prompt` decide whether the
/// incoming prompt is the FIRST one for a freshly-spawned runtime (and
/// therefore should be prefixed with the one-shot system note about the
/// `send` MCP tool). Once `was_primed` flips true we never prepend the
/// preamble again for that logical session — even across restarts the
/// `logical_to_acp` map is in-memory only, so the next spawn re-issues
/// the preamble naturally.
#[derive(Clone)]
pub struct ResolvedSession {
    real_acp_sid: String,
    binding: String,
    /// The cloud session this chat's turns run in. Cached here so every turn
    /// can hand it to the reply token without another backend round trip —
    /// an outbound send needs it to write the file back into the session.
    remote_session_id: Option<String>,
    was_primed: bool,
}

/// Per-bot runtime defaults, keyed by WeCom `bot_id`. Seeded from
/// `daemon.toml` when the handle is built, and updated in place by
/// `/workspace` (which also writes the new default back to that file).
#[derive(Clone, Default)]
pub struct BotRuntimeConfig {
    /// Configured workspace ID, retained even when its path lookup fails so a
    /// scoped bot cannot silently degrade to an unscoped spawn.
    pub workspace_id: Option<String>,
    /// Already-resolved local workspace directory (workspace_id -> path).
    pub workspace_dir: Option<String>,
    pub agent_type: Option<amux::AgentType>,
    pub system_prompt: Option<String>,
}

/// The pieces of daemon state a gateway spawn needs to build the SAME runtime
/// environment a desktop session gets — team secrets, `tc_api_key`, and the
/// team LLM provider written into `opencode.json`.
///
/// Without this the gateway spawned with an empty env, so a device whose first
/// post-launch activity was a WeCom message launched the shared `opencode
/// serve` with no provider credentials at all. `serve` is one global process
/// and its env is first-writer-wins applied at spawn, so that unauthenticated
/// launch then poisoned every later turn: the model catalog held only
/// unauthenticated entries, the MRU pick resolved against it, and the first
/// prompt died on "No provider available". Opening a desktop session
/// re-assembled the env and respawned `serve`, which is why doing that
/// "fixed" it.
#[derive(Clone)]
pub struct GatewaySpawnEnv {
    /// Shared TTL-cached resolver, so a gateway spawn and a provider read
    /// share one throttled cloud fetch.
    pub managed_llm: Arc<crate::runtime::managed_llm::ManagedLlmResolver>,
    pub actor_id: String,
    pub actor_name: String,
    /// Suppresses the refresh watcher for the `opencode.json` writes this
    /// assembly performs, so materializing `provider.team` does not surface as
    /// a spurious "OpenCode config changed" banner in the desktop UI.
    pub refresh_coordinator: Option<Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
}

pub struct AmuxdAgentHandle {
    pub manager: Arc<Mutex<RuntimeManager>>,
    /// See [`GatewaySpawnEnv`]. Gateway runtimes get the same LLM credentials
    /// as desktop ones; without it a gateway-first cold start has no providers.
    pub spawn_env: GatewaySpawnEnv,
    /// Logical (SQL-minted) acp_session_id → resolved runtime metadata.
    /// Created on first `send_prompt` after a daemon start; in-memory only.
    pub logical_to_acp: Arc<Mutex<HashMap<String, ResolvedSession>>>,
    /// Team id used when lazy-spawning a runtime on first `send_prompt`.
    /// Set by the F4 wiring layer when the handle is constructed.
    pub team_id: String,
    /// Per-session model override: logical_session_id → (provider, model).
    /// Set by `set_model`; consulted at lazy-spawn time so the spawned
    /// runtime starts on the user-chosen model. In-memory only — cleared
    /// across daemon restarts (same caveat as `logical_to_acp`).
    pub model_override: Arc<Mutex<HashMap<String, (String, String)>>>,
    /// Gateway-wide model (`channels.model` in team.toml), pre-split into the
    /// `(provider, model)` shape `model_override` uses.
    ///
    /// Consulted when a chat has not set its own with `/model`. Without it the
    /// spawn went out unpinned and the model came from the device MRU — exactly
    /// the implicit resolution ADR-0007 removes. `None` keeps the unpinned
    /// behaviour for a team that has not set one.
    pub gateway_model: Option<(String, String)>,
    /// Backend client used to look up `sessions.binding` from the
    /// SQL-minted `acp_session_id` when lazy-spawning a runtime. The
    /// binding is required to write the per-session MCP config file
    /// that mounts the send tool.
    pub backend: Arc<dyn Backend>,
    /// The daemon agent's own `default_agent_type`, resolved once when the
    /// channel manager is built (`GET /v1/runtime/agent-defaults`). Gateway
    /// runtimes spawn on this backend type instead of the daemon-wide default.
    /// `None` → fall back to the daemon default agent type.
    pub default_agent_type: Option<amux::AgentType>,
    /// Configured daemon default workspace ID, retained even when its startup
    /// path lookup fails so a scoped gateway cannot silently degrade to an
    /// unscoped spawn.
    pub default_workspace_id: Option<String>,
    /// Local filesystem path of the daemon agent's `default_workspace_id`,
    /// resolved via the `WorkspaceResolver` cache (backed by the cloud
    /// `amux.workspaces` table). Used as the gateway runtime's working
    /// directory instead of a throwaway `/tmp` scratch dir.
    pub default_workspace_dir: Option<String>,
    /// Resolves a cloud workspace_id → local path (`amux.workspaces` is the
    /// sole source of truth). Used by `workspace_dir_for_id` for per-session
    /// spawn-target resolution.
    pub workspace_resolver: Arc<crate::config::WorkspaceResolver>,
    /// Per-session workspace override: logical_session_id → workspace_id.
    /// In-memory only — cleared across daemon restarts.
    pub workspace_override: Arc<Mutex<HashMap<String, String>>>,
    /// Per-bot (WeCom) runtime config keyed by bot_id, consulted in
    /// `resolve_or_spawn` and `send_prompt`.
    ///
    /// Read-only from a chat's point of view since #933: `/workspace` no longer
    /// rewrites it (or `daemon.toml`) — it scopes to the session instead.
    pub bot_configs: Arc<Mutex<HashMap<String, BotRuntimeConfig>>>,
}

/// Returned by `resolve_or_spawn`. `spawned` is true iff this call was
/// the one that lazy-spawned the runtime — used by `send_prompt` to
/// decide whether to prepend the system preamble.
struct ResolveOutcome {
    real_acp_sid: String,
    binding: String,
    remote_session_id: Option<String>,
    spawned: bool,
}

impl AmuxdAgentHandle {
    /// Resolve the workspace dir + agent type for a spawn, applying priority
    /// **per-session override > per-bot config > daemon global default**.
    /// `workspace_override` stores a workspace_id, resolved to a path here;
    /// `bot_configs` already store a resolved path.
    async fn resolve_spawn_target(
        &self,
        session: &str,
        binding: &str,
    ) -> Result<(Option<String>, Option<amux::AgentType>), AgentError> {
        let bot = {
            let configs = self.bot_configs.lock().await;
            bot_id_from_binding(binding)
                .and_then(|b| configs.get(b))
                .cloned()
                .unwrap_or_default()
        };

        let agent_type = bot.agent_type.or(self.default_agent_type);

        let session_ws_id = {
            let ov = self.workspace_override.lock().await;
            ov.get(session).cloned()
        };
        let workspace_dir = if let Some(workspace_id) = session_ws_id {
            Some(self.workspace_dir_for_id(&workspace_id).await?)
        } else if let Some(workspace_id) = bot.workspace_id.as_deref() {
            match bot.workspace_dir {
                Some(path) => Some(path),
                None => Some(self.workspace_dir_for_id(workspace_id).await?),
            }
        } else if bot.workspace_dir.is_some() {
            bot.workspace_dir
        } else if let Some(workspace_id) = self.default_workspace_id.as_deref() {
            match self.default_workspace_dir.clone() {
                Some(path) => Some(path),
                None => Some(self.workspace_dir_for_id(workspace_id).await?),
            }
        } else {
            self.default_workspace_dir.clone()
        };

        Ok((workspace_dir, agent_type))
    }

    /// Build the runtime environment for a gateway spawn: team secrets,
    /// `tc_api_key`, and the team LLM provider materialized into the
    /// workspace's `opencode.json` — the same assembly a desktop session runs
    /// (`Daemon::assemble_spawn_runtime_env_for_worktree`).
    ///
    /// A genuinely unscoped gateway may use a bare environment. Once a
    /// workspace resolves, env/config assembly is mandatory and failures are
    /// surfaced to the caller rather than silently dropping credentials.
    async fn assemble_execution_context(
        &self,
        workspace_dir: Option<&str>,
    ) -> Result<ExecutionContext, AgentError> {
        let bare = SpawnRuntimeEnv {
            is_gateway: true,
            ..SpawnRuntimeEnv::default()
        };
        // No resolvable workspace means the spawn lands in a throwaway scratch
        // dir, which has no team config to assemble from.
        let Some(worktree) = workspace_dir else {
            return Ok(ExecutionContext {
                isolation_domain: IsolationDomainKey::UnscopedAgent {
                    team_id: self.team_id.clone(),
                    actor_id: self.spawn_env.actor_id.clone(),
                },
                workspace: None,
                working_directory: std::path::PathBuf::new(),
                spawn_env: bare,
            });
        };
        let workspace = self
            .workspace_resolver
            .resolve_identity_for_path(
                std::path::Path::new(worktree),
                (!self.team_id.trim().is_empty()).then_some(self.team_id.as_str()),
            )
            .await
            .map_err(|e| {
                AgentError::Create(format!(
                    "gateway workspace identity resolution failed for {worktree}: {e}"
                ))
            })?
            .ok_or_else(|| {
                AgentError::Create(format!(
                    "gateway workspace identity resolution failed for {worktree}"
                ))
            })?;

        let env_team_id = workspace
            .team_id
            .as_deref()
            .or((!self.team_id.trim().is_empty()).then_some(self.team_id.as_str()));
        let managed_llm = if let Some(team_id) = env_team_id {
            self.spawn_env.managed_llm.resolve(team_id).await
        } else {
            teamclu_runtime_env::ManagedLlmState::Unknown
        };
        let cloud_token_file = self
            .backend
            .cloud_auth_health()
            .map(|_| crate::config::DaemonConfig::cloud_token_path())
            .map(|p| p.to_string_lossy().into_owned());

        // Suppress immediately before the sync disk writes, never before the
        // awaits above: the managed-LLM fetch can outlast the suppress window
        // and the `opencode.json` rewrite would leak as a Pending banner.
        if let Some(ref refresh) = self.spawn_env.refresh_coordinator {
            crate::runtime::refresh::refresh_watch::suppress_for_workspace_path(
                refresh,
                std::path::Path::new(worktree),
                &crate::runtime::refresh::INTERNAL_OPENCODE_KINDS,
                crate::runtime::refresh::INTERNAL_WRITE_SUPPRESS,
            );
        }
        crate::runtime::supervisor::materialize_inherent_mcp_for_spawn(std::path::Path::new(
            worktree,
        ))
        .map_err(|e| AgentError::Create(format!("materialize inherent gateway MCP config: {e}")))?;

        let spawn_env = crate::runtime::env_assembly::assemble_spawn_runtime_env_for_execution(
            &workspace.workspace_root,
            std::path::Path::new(worktree),
            env_team_id,
            &self.spawn_env.actor_id,
            &self.spawn_env.actor_name,
            cloud_token_file.as_deref(),
            &managed_llm,
        )
        .map(|env| SpawnRuntimeEnv {
            is_gateway: true,
            ..env
        })
        .map_err(|e| AgentError::Create(format!("gateway runtime env assembly failed: {e}")))?;

        Ok(ExecutionContext {
            isolation_domain: IsolationDomainKey::Workspace(workspace.workspace_id.clone()),
            workspace: Some(WorkspaceIdentity {
                workspace_id: workspace.workspace_id,
                workspace_root: workspace.workspace_root,
                team_id: workspace.team_id,
            }),
            working_directory: std::path::PathBuf::from(worktree),
            spawn_env,
        })
    }

    /// Live model catalog for the workspace this session runs in, as gateway
    /// `ModelInfo`s (`provider/model` split out of the backend's flat id).
    ///
    /// Probes the backend rather than reading a static table: with opencode
    /// there is one global `serve` instance whose `/config/providers` is the
    /// only thing that knows which providers are configured and authenticated
    /// on this device. A failed probe degrades to an empty list — callers
    /// treat that as "catalog unknown", never as "no models exist".
    async fn catalog_for(&self, session: &AmuxSessionId) -> Result<Vec<ModelInfo>, AgentError> {
        let binding = {
            let map = self.logical_to_acp.lock().await;
            map.get(session).map(|s| s.binding.clone())
        }
        .unwrap_or_default();
        let (workspace_dir, _) = self.resolve_spawn_target(session, &binding).await?;
        let Some(dir) = workspace_dir else {
            // No resolvable workspace — a spawn would run in a throwaway
            // scratch dir, which tells us nothing useful about the catalog.
            return Ok(Vec::new());
        };
        let context = self.assemble_execution_context(Some(&dir)).await?;
        let catalog = {
            let mut mgr = self.manager.lock().await;
            mgr.probe_catalog_models_with_context(context).await
        };
        let catalog = match catalog {
            Ok(models) => models,
            Err(e) => {
                tracing::warn!(error = %e, workspace = %dir, "gateway model catalog probe failed");
                return Ok(Vec::new());
            }
        };
        Ok(catalog
            .into_iter()
            .filter_map(|m| {
                let (provider, model) = m.id.split_once('/')?;
                Some(ModelInfo {
                    provider: provider.to_string(),
                    model: model.to_string(),
                    display_name: m.display_name,
                })
            })
            .collect())
    }

    /// The chat binding this session is bound to, if any.
    ///
    /// Reads the cached binding first and falls back to the `sessions` row,
    /// because a command usually arrives before the session has ever spawned a
    /// runtime — at which point nothing is cached yet. `Ok(None)` means the
    /// session is not gateway-bound, which callers treat as "no chat history to
    /// speak of".
    ///
    /// A lookup *failure* is returned as an error rather than folded into
    /// `None`: the two used to be indistinguishable, so an unreachable backend
    /// reported itself to the user as an empty session list — the least
    /// alarming, least true thing it could have said.
    async fn binding_for_session(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Option<String>, AgentError> {
        let cached = {
            let map = self.logical_to_acp.lock().await;
            map.get(session).map(|s| s.binding.clone())
        };
        if let Some(b) = cached {
            if !b.is_empty() {
                return Ok(Some(b));
            }
        }
        let looked_up = self
            .backend
            .get_gateway_session_by_acp_id(session)
            .await
            .map_err(|e| AgentError::Internal(format!("session lookup: {e}")))?;
        Ok(looked_up
            .and_then(|(_, binding)| binding)
            .filter(|b| !b.is_empty()))
    }

    /// Resolve a workspace_id to its local path via the `WorkspaceResolver`
    /// cache (`amux.workspaces` is the sole source of truth). Resolution
    /// failures remain errors so configured workspace scope cannot be erased.
    async fn workspace_dir_for_id(&self, workspace_id: &str) -> Result<String, AgentError> {
        self.workspace_resolver
            .resolve(workspace_id)
            .await
            .map_err(|error| {
                AgentError::Create(format!(
                    "gateway workspace '{workspace_id}' resolution failed: {error}"
                ))
            })
            .map(|w| w.path)
    }

    /// Return the cached `logical → real ACP` mapping for `session`, but only
    /// if the mapped runtime is still live in the `RuntimeManager`.
    ///
    /// A cached `real_acp_sid` can outlive its runtime: once a gateway turn
    /// finishes and the agent stops / detaches (`agent stopped`,
    /// `ACP session detached from host`), `stop_runtime` removes the handle from
    /// `RuntimeManager.agents`, but this in-memory map still points at the
    /// dead UUID. Reusing it makes the next turn fail with
    /// `no agent for acp_session_id` (issue #548). So we probe liveness via
    /// `agent_id_by_acp_session` — `None` means the runtime is gone — and evict
    /// the stale entry so the caller lazy-spawns a fresh runtime under the same
    /// logical id. Eviction is guarded by a real_acp_sid re-check so a
    /// concurrent spawn that already replaced the entry is left untouched.
    async fn cached_session_if_live(&self, session: &AmuxSessionId) -> Option<ResolvedSession> {
        let existing = {
            let map = self.logical_to_acp.lock().await;
            map.get(session).cloned()?
        };
        let alive = {
            let mgr = self.manager.lock().await;
            mgr.agent_id_by_acp_session(&existing.real_acp_sid)
                .is_some()
        };
        if alive {
            return Some(existing);
        }
        let mut map = self.logical_to_acp.lock().await;
        if let Some(cur) = map.get(session) {
            if cur.real_acp_sid == existing.real_acp_sid {
                map.remove(session);
                tracing::info!(
                    logical_session = %session,
                    stale_acp_sid = %existing.real_acp_sid,
                    "evicted stale gateway ACP session mapping; will re-spawn on this turn"
                );
            }
        }
        None
    }

    /// Resolve the caller-supplied `session` (a logical id persisted on the
    /// `sessions` row) to a real ACP UUID, spawning a runtime on first use.
    /// On a fresh spawn, the matching `sessions.binding` is looked up from
    /// the backend so it can be baked into the per-session MCP config.
    async fn resolve_or_spawn(
        &self,
        session: &AmuxSessionId,
    ) -> Result<ResolveOutcome, AgentError> {
        if let Some(existing) = self.cached_session_if_live(session).await {
            return Ok(ResolveOutcome {
                real_acp_sid: existing.real_acp_sid,
                binding: existing.binding,
                remote_session_id: existing.remote_session_id,
                spawned: false,
            });
        }

        // Recover the remote session UUID + chat URI for this logical session.
        // The UUID is needed so the spawned runtime can carry it on its handle,
        // which is what daemon::server::target_sessions falls back to when
        // routing agent envelopes (otherwise gateway-spawned runtimes — which
        // never get written into the local SessionStore — appear bound-less and
        // their envelopes get dropped). The chat URI identifies which
        // conversation this runtime belongs to, and is what the turn's reply
        // token is minted from. A missing row is non-fatal; we still spawn so
        // basic prompt/reply works.
        let (remote_session_id, binding) = match self
            .backend
            .get_gateway_session_by_acp_id(session)
            .await
            .map_err(|e| AgentError::Create(format!("session lookup: {e}")))?
        {
            Some((id, bind)) => (Some(id), bind.unwrap_or_default()),
            None => (None, String::new()),
        };

        // Consult per-session override so the spawn picks up the desired
        // model. Stored as (provider, model); both fields are forwarded to
        // `create_gateway_session_with_model`, which calls `resolve_initial_model`
        // to build the correct model id per backend:
        //   - ClaudeCode: maps short names (sonnet→claude-sonnet-4-6), drops provider
        //   - OpenCode (and similar provider/model backends): rejoins as
        //     "provider/model"
        // Chat's own `/model` first, then the gateway-wide setting. Falling
        // through to `None` means an unpinned spawn, which used to resolve
        // against the device MRU — the implicit behaviour ADR-0007 removes.
        let model_arg: Option<(String, String)> = {
            let overrides = self.model_override.lock().await;
            overrides
                .get(session)
                .cloned()
                .or_else(|| self.gateway_model.clone())
        };
        let (workspace_dir, agent_type) = self.resolve_spawn_target(session, &binding).await?;
        let context = self
            .assemble_execution_context(workspace_dir.as_deref())
            .await?;
        let real = {
            let mut mgr = self.manager.lock().await;
            mgr.create_gateway_session_with_model(
                &self.team_id,
                session,
                &binding,
                "Gateway session",
                model_arg,
                remote_session_id.as_deref(),
                context,
                agent_type,
            )
            .await
            .map_err(|e| AgentError::Create(e.to_string()))?
        };

        // Durable persona for ClaudeCode: write CLAUDE.local.md into the
        // bot's workspace. Non-fatal; the preamble already delivered it.
        if matches!(agent_type, Some(amux::AgentType::ClaudeCode) | None) {
            if let (Some(ws), Some(bot_id)) =
                (workspace_dir.as_deref(), bot_id_from_binding(&binding))
            {
                let bot_prompt = {
                    let configs = self.bot_configs.lock().await;
                    configs.get(bot_id).and_then(|c| c.system_prompt.clone())
                };
                if let Some(prompt) = bot_prompt.as_deref() {
                    if let Err(e) = super::bot_prompt_file::write_bot_instruction_file(
                        std::path::Path::new(ws),
                        prompt,
                    ) {
                        tracing::warn!(bot_id, error = %e, "write CLAUDE.local.md failed");
                    }
                }
            }
        }

        // Insert under a write lock; if a concurrent spawn raced ahead we
        // keep the existing entry so `was_primed` reflects whichever call
        // actually delivered the preamble first.
        let mut map = self.logical_to_acp.lock().await;
        let entry = map
            .entry(session.to_string())
            .or_insert_with(|| ResolvedSession {
                real_acp_sid: real.clone(),
                binding: binding.clone(),
                remote_session_id: remote_session_id.clone(),
                was_primed: false,
            });
        let outcome = ResolveOutcome {
            real_acp_sid: entry.real_acp_sid.clone(),
            binding: entry.binding.clone(),
            remote_session_id: entry.remote_session_id.clone(),
            spawned: true,
        };
        Ok(outcome)
    }

    /// Mark a logical session as having received its priming system
    /// preamble so subsequent `send_prompt` calls don't repeat it.
    async fn mark_primed(&self, session: &str) {
        let mut map = self.logical_to_acp.lock().await;
        if let Some(entry) = map.get_mut(session) {
            entry.was_primed = true;
        }
    }

    /// Returns true if the logical session has already received its
    /// priming preamble. Lock is held briefly — callers that want a
    /// consistent decision should pair this with `mark_primed`.
    async fn already_primed(&self, session: &str) -> bool {
        let map = self.logical_to_acp.lock().await;
        map.get(session).map(|e| e.was_primed).unwrap_or(false)
    }
}

/// Extract the channel scheme from a binding URI (`wecom://…` →
/// `wecom`). Used in the priming preamble so the agent knows which
/// gateway it's talking through. Falls back to `gateway` when the URI
/// doesn't parse cleanly.
fn channel_name_from_binding(binding: &str) -> &str {
    if binding.is_empty() {
        return "gateway";
    }
    match binding.split_once("://") {
        Some((scheme, _)) if !scheme.is_empty() => scheme,
        _ => "gateway",
    }
}

/// Extract the WeCom bot id from a `wecom://<bot_id>/...` binding so the
/// handle can pick the per-bot runtime config. Returns None for non-wecom
/// or malformed bindings (callers fall back to the global default).
pub fn bot_id_from_binding(binding: &str) -> Option<&str> {
    let rest = binding.strip_prefix("wecom://")?;
    rest.split('/').next().filter(|s| !s.is_empty())
}

/// Build the first-turn prompt for a freshly-spawned gateway session: the
/// per-bot persona (if any), then the standard send-tool note, then the
/// user's message. Subsequent turns use `[sender] text` plus the reply-token
/// line from [`reply_channel_note`].
pub fn build_first_turn_prompt(
    channel: &str,
    bot_system_prompt: Option<&str>,
    sender_display: &str,
    text: &str,
) -> String {
    let persona = match bot_system_prompt {
        Some(p) if !p.trim().is_empty() => format!("[SYSTEM] {p}\n\n"),
        _ => String::new(),
    };
    // What this does NOT say any more: "call `send` to reply". Your reply is
    // already delivered to the chat — telling the model otherwise made it push
    // the answer through `send` AND return it as the turn text, so the user
    // read the same answer twice.
    format!(
        "{persona}[SYSTEM] You are connected to a {channel} chat via amuxd. Your reply is \
delivered to that chat automatically — just answer normally, and do not re-send your own text.\n\
To attach a FILE to your reply, call the `send` MCP tool (server name `amuxd-send`) with the \
reply token below and a `file_path`; it rides out with the same message. The same tool, with an \
explicit target, is also how you reach a DIFFERENT chat.\n\n\
[{sender_display}] {text}"
    )
}

/// The line that carries the chat's reply token into a turn.
///
/// Repeated on *every* turn rather than only the first: the token is what
/// gives the send tool a destination, and a model that has to reach back many turns
/// for it will sooner or later reach for something else. Repeating a derived
/// (hence unchanging) value costs a line and removes that failure mode.
fn reply_channel_note(token: &str) -> String {
    format!(
        "[SYSTEM] Reply token for this chat: {token}\n\
Pass it as `reply_token` to attach a FILE to your reply, e.g. \
`send_channel_message(reply_token=\"{token}\", file_path=\"/tmp/report.pdf\")`. \
Your text reply needs no tool — it is delivered on its own."
    )
}

/// How often a streamed turn may push a cumulative-text update to the
/// caller. The agent emits output far faster than any chat UI wants to
/// redraw, and each update costs a WebSocket round-trip on the channel
/// side, so updates are coalesced into at most one per interval.
const STREAM_UPDATE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(700);

/// Decide what a timed-out gateway turn should return (issue #555). If the
/// agent already produced reply text, hand it back as the turn result rather
/// than failing — OpenCode may have finished while the ACP adapter never sent
/// the Active→Idle completion. Empty accumulation stays a `Timeout` error.
fn salvage_timeout_reply(segments: &[String], live: &str) -> Result<String, AgentError> {
    let acc = compose_reply(segments, live);
    if acc.trim().is_empty() {
        Err(AgentError::Timeout)
    } else {
        Ok(acc)
    }
}

/// Join the reply segments a turn has produced so far into the text a
/// channel should display. `live` is the not-yet-flushed tail (output that
/// has arrived but hasn't hit a tool-call or turn-end boundary).
///
/// Segments are the runs of prose between tool calls, so blank-line joining
/// matches how Tauri renders them as separate messages.
fn compose_reply(segments: &[String], live: &str) -> String {
    let mut parts: Vec<&str> = segments.iter().map(String::as_str).collect();
    if !live.trim().is_empty() {
        parts.push(live);
    }
    parts.join("\n\n")
}

/// Fold one event's aggregator output into the reply being accumulated.
/// Returns true if a segment was flushed (i.e. the visible text jumped),
/// which the streaming path uses to push an update immediately rather than
/// waiting out the throttle interval.
fn absorb_emitted(
    emitted: Vec<crate::runtime::turn_aggregator::EmittedMessage>,
    segments: &mut Vec<String>,
    live: &mut String,
) -> bool {
    let mut flushed = false;
    for m in emitted {
        if matches!(m.kind, crate::proto::teamclu::MessageKind::AgentReply) {
            // Empty anchors and English status notices (no_final_reply /
            // interrupt instruction) must not become WeCom/channel reply text.
            if !m.content.is_empty()
                && !crate::runtime::turn_aggregator::TurnAggregator::is_agent_facing_status_notice(
                    &m.content,
                )
            {
                segments.push(m.content);
            }
            live.clear();
            flushed = true;
        }
    }
    flushed
}

impl AmuxdAgentHandle {
    /// Drive one ACP turn to completion and return the agent's full reply.
    ///
    /// Shared by `send_prompt` and `send_prompt_streamed`; `on_update` is
    /// `None` for the former. See `send_prompt_streamed` on the trait for the
    /// cumulative-text/best-effort contract.
    async fn run_turn(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
        on_update: Option<tokio::sync::mpsc::Sender<String>>,
        turn_timeout: std::time::Duration,
    ) -> Result<TurnOutcome, AgentError> {
        let outcome = self.resolve_or_spawn(session).await?;

        // First prompt after a fresh spawn gets a one-shot system preamble
        // explaining the `send` MCP tool and its defaults. `resolve_or_spawn`
        // tells us whether this call did the spawning, but a concurrent
        // caller may have already primed the session — `already_primed`
        // settles the race so we never double-prime.
        let needs_preamble = outcome.spawned && !self.already_primed(session).await;
        let body = if needs_preamble {
            let channel = channel_name_from_binding(&outcome.binding);
            let bot_prompt = {
                let configs = self.bot_configs.lock().await;
                bot_id_from_binding(&outcome.binding)
                    .and_then(|b| configs.get(b))
                    .and_then(|c| c.system_prompt.clone())
            };
            build_first_turn_prompt(channel, bot_prompt.as_deref(), sender_display, text)
        } else {
            format!("[{sender_display}] {text}")
        };

        // Registering here rather than at spawn is what makes the send tool
        // survive a reused attachment: this runs on every turn, including the
        // ones whose session was attached by somebody else.
        let prompt = if outcome.binding.is_empty() {
            body
        } else {
            let token = reply_token::register_with_session(
                &outcome.binding,
                outcome.remote_session_id.as_deref(),
            );
            format!("{}\n\n{body}", reply_channel_note(&token))
        };

        if needs_preamble {
            self.mark_primed(session).await;
        }

        // Per-session concurrency model:
        //
        //   1. Grab the per-agent `turn_lock` Arc under a brief manager
        //      lock and immediately release the manager mutex.
        //   2. Acquire `turn_lock` — serialises only *this* agent's turns.
        //      Different agents have different locks, so two concurrent
        //      wecom sessions never block each other here.
        //   3. Re-acquire the manager mutex *briefly* to send the prompt
        //      and check the agent's `event_rx` out of the handle. With
        //      `turn_lock` held the checkout cannot race.
        //   4. Drive the aggregator off the local `event_rx.recv().await`
        //      *without* holding the manager mutex. Re-lock only for the
        //      sub-millisecond `aggregator.ingest(&event)` call after each
        //      event. While we're waiting on the model, the manager mutex
        //      stays free so other sessions can poll events / spawn / etc.
        //   5. Always check the receiver back in (success or error) before
        //      dropping the turn_lock guard so `poll_events` resumes
        //      draining the next round.

        let turn_lock = {
            let mgr = self.manager.lock().await;
            let agent_id = mgr
                .agent_id_by_acp_session(&outcome.real_acp_sid)
                .ok_or_else(|| {
                    AgentError::Send(format!(
                        "no agent for acp_session_id {}",
                        outcome.real_acp_sid
                    ))
                })?;
            let handle = mgr.get_handle(&agent_id).ok_or_else(|| {
                AgentError::Send(format!("agent {agent_id} disappeared before turn"))
            })?;
            handle.turn_lock.clone()
        };
        let _turn_guard = turn_lock.lock().await;

        let (agent_id, mut event_rx) = {
            let mut mgr = self.manager.lock().await;
            let (turn, _again) = mgr
                .checkout_turn_for_acp(&outcome.real_acp_sid)
                .map_err(|e| AgentError::Send(e.to_string()))?;
            // A `?` here would drop `turn` — destroying the receiver instead of
            // returning it — and `handle.event_rx` would stay None forever.
            // `evict_idle` skips handles with a checked-out receiver, so a single
            // send failure would exempt this runtime from idle eviction for the
            // rest of the daemon's life. Check in before propagating.
            if let Err(e) = mgr
                .send_prompt_raw(&turn.agent_id, &prompt, vec![], None, None)
                .await
            {
                mgr.checkin_turn(turn);
                return Err(AgentError::Send(e.to_string()));
            }
            (turn.agent_id, turn.event_rx)
        };

        // A turn is only over on Active -> Idle. The aggregator also emits an
        // `AgentReply` *mid-turn*, every time a tool call interrupts buffered
        // output (`turn_aggregator.rs` `flush_reply_into`), so returning on
        // the first one truncates every tool-using turn to whatever preamble
        // the agent wrote before reaching for its first tool. Accumulate the
        // segments instead and only return once the runtime goes idle.
        let mut segments: Vec<String> = Vec::new();
        let mut live = String::new();
        let mut last_update = std::time::Instant::now();
        let mut sent_update = String::new();

        let deadline = std::time::Instant::now() + turn_timeout;
        // On a turn-level timeout, salvage any reply text the agent already
        // produced instead of failing the whole turn (issue #555): OpenCode can
        // finish and persist its final assistant text while the ACP adapter
        // never emits the Active→Idle completion, which otherwise leaves the
        // WeCom card stuck "thinking" even though the answer exists.
        let salvage_on_timeout = |segments: &[String], live: &str| -> Result<String, AgentError> {
            let out = salvage_timeout_reply(segments, live);
            if out.is_ok() {
                tracing::warn!(
                    session = %session,
                    "gateway turn timed out with no Active→Idle; returning accumulated reply text"
                );
            }
            out
        };
        let mut timed_out = false;
        let result: Result<String, AgentError> = loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                timed_out = true;
                break salvage_on_timeout(&segments, &live);
            }
            let next = tokio::time::timeout(remaining, event_rx.recv()).await;
            let event = match next {
                Ok(Some(ev)) => ev,
                Ok(None) => {
                    // The agent detached mid-turn (event channel closed) before
                    // any Active→Idle. If it had already produced reply text,
                    // return it rather than stranding the user (issue #552);
                    // otherwise surface the detach as an error.
                    break match salvage_timeout_reply(&segments, &live) {
                        Ok(reply) => {
                            tracing::warn!(
                                session = %session,
                                "gateway turn detached before Active→Idle; returning accumulated reply text"
                            );
                            Ok(reply)
                        }
                        Err(_) => Err(AgentError::Send(
                            "agent event channel closed before reply".into(),
                        )),
                    };
                }
                Err(_) => break salvage_on_timeout(&segments, &live),
            };
            if let Some(crate::proto::amux::acp_event::Event::Error(err)) = &event.event.event {
                let details = if err.details.is_empty() {
                    err.message.clone()
                } else {
                    err.details.clone()
                };
                break Err(AgentError::Send(format!("agent turn failed: {details}")));
            }

            // Mirror the aggregator's unflushed reply buffer so streamed
            // updates can show prose as it arrives rather than only at tool
            // boundaries. Cleared below whenever the aggregator flushes.
            if let Some(crate::proto::amux::acp_event::Event::Output(o)) = &event.event.event {
                live.push_str(&o.text);
            }

            let turn_ended = matches!(
                &event.event.event,
                Some(crate::proto::amux::acp_event::Event::StatusChange(sc))
                    if sc.old_status == crate::proto::amux::AgentStatus::Active as i32
                        && sc.new_status == crate::proto::amux::AgentStatus::Idle as i32
            );

            let emitted = {
                let mut mgr = self.manager.lock().await;
                mgr.aggregator_mut(&agent_id)
                    .map(|agg| agg.ingest(&event.event))
                    .unwrap_or_default()
            };
            let flushed = absorb_emitted(emitted, &mut segments, &mut live);

            if turn_ended {
                break Ok(compose_reply(&segments, &live));
            }

            // Best-effort progress updates: coalesced by interval, skipped
            // when nothing changed, and never allowed to fail the turn.
            if let Some(tx) = &on_update {
                let due = flushed || last_update.elapsed() >= STREAM_UPDATE_INTERVAL;
                if due {
                    let text = compose_reply(&segments, &live);
                    if !text.trim().is_empty() && text != sent_update {
                        if tx.try_send(text.clone()).is_ok() {
                            sent_update = text;
                        }
                        last_update = std::time::Instant::now();
                    }
                }
            }
        };

        {
            let mut mgr = self.manager.lock().await;
            mgr.checkin_turn(crate::runtime::CheckedOutTurn { agent_id, event_rx });
        }

        // The gateway has stopped waiting; the runtime has not. A turn left
        // running keeps the session's lock, so every following message queues
        // behind work whose answer nobody will ever see and times out in turn —
        // one slow question used to take the chat down until the daemon was
        // restarted.
        if timed_out {
            if let Err(e) = self.cancel(session).await {
                tracing::warn!(session = %session, error = %e, "gateway turn timed out; cancel failed");
            } else {
                tracing::warn!(session = %session, "gateway turn timed out; runtime cancelled");
            }
        }

        let reply_text = result?;
        Ok(TurnOutcome {
            reply_text,
            completed: true,
        })
    }
}

#[async_trait]
impl AgentHandle for AmuxdAgentHandle {
    async fn create_session(
        &self,
        _team_id: &str,
        binding: &str,
        _title: &str,
    ) -> Result<AmuxSessionId, AgentError> {
        // Channels never call this in the gateway-port architecture — the
        // SQL store mints the logical acp_session_id via
        // `ensure_gateway_session`. We keep a consistent implementation in
        // case future callers use it: hand back the binding as the logical
        // id; `send_prompt` will lazy-spawn on first use.
        Ok(binding.to_string())
    }

    async fn send_prompt(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
        timeout: std::time::Duration,
    ) -> Result<TurnOutcome, AgentError> {
        self.run_turn(session, sender_display, text, None, timeout)
            .await
    }

    async fn send_prompt_streamed(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
        on_update: tokio::sync::mpsc::Sender<String>,
        timeout: std::time::Duration,
    ) -> Result<TurnOutcome, AgentError> {
        self.run_turn(session, sender_display, text, Some(on_update), timeout)
            .await
    }

    async fn inject_context(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
    ) -> Result<(), AgentError> {
        let outcome = self.resolve_or_spawn(session).await?;
        let mut mgr = self.manager.lock().await;
        mgr.inject_context(&outcome.real_acp_sid, sender_display, text)
            .await
            .map_err(|e| AgentError::Send(e.to_string()))
    }

    async fn cancel(&self, session: &AmuxSessionId) -> Result<(), AgentError> {
        let map = self.logical_to_acp.lock().await;
        let real = match map.get(session) {
            Some(s) => s.real_acp_sid.clone(),
            None => return Ok(()), // never spawned, nothing to cancel
        };
        drop(map);
        let mut mgr = self.manager.lock().await;
        mgr.cancel_by_acp_session(&real)
            .await
            .map_err(|e| AgentError::Send(format!("cancel failed: {e}")))
    }

    async fn reset_session(&self, session: &AmuxSessionId) -> Result<(), AgentError> {
        // Cancel + drop from map. Next send_prompt re-spawns under the
        // same logical id with a fresh runtime — preserves the gateway-side
        // identity so persisted `sessions.binding` keeps working.
        let _ = self.cancel(session).await; // best-effort
        let mut map = self.logical_to_acp.lock().await;
        map.remove(session);
        Ok(())
    }

    async fn start_new_session(&self, session: &AmuxSessionId) -> Result<bool, AgentError> {
        // Detach the chat's binding so the next inbound message makes
        // `ensure_gateway_session` miss and mint a new row. Without this step
        // `/new` only swaps the runtime: same session, same history, same
        // entry in the session list — "Started a new session" would be
        // describing something the user cannot observe.
        //
        // A backend that reports nothing detached (unknown id, a channel whose
        // sessions are not gateway-bound, or one deployed before the detach
        // endpoint existed) leaves us with the runtime reset below, which is
        // the best that can be done there. Either way the outcome is returned
        // rather than swallowed, so the reply matches what actually happened.
        let detached = match self.backend.rpc_detach_gateway_session(session).await {
            Ok(detached) => {
                if detached {
                    tracing::info!(
                        logical_session = %session,
                        "gateway session detached; next message opens a new one"
                    );
                } else {
                    tracing::warn!(
                        logical_session = %session,
                        "backend detached nothing; the chat stays on the same session"
                    );
                }
                detached
            }
            Err(e) => {
                // Do not fail /new over this: the context reset below still
                // gives the user a fresh runtime, just under the old row.
                tracing::warn!(error = %e, "detach gateway session failed; clearing runtime only");
                false
            }
        };
        self.reset_session(session).await?;
        Ok(detached)
    }

    async fn list_models(&self, session: &AmuxSessionId) -> Result<Vec<ModelInfo>, AgentError> {
        // The live backend catalog is the only source of truth: this used to
        // be a hardcoded anthropic/{sonnet,opus,haiku} table from the
        // claude-code adapter era, which named models the daemon cannot run.
        let mut models = self.catalog_for(session).await?;

        // Order the way the picker surfaces do: current model first, then the
        // device MRU, then everything else. A chat channel shows a prefix of
        // this list, so the useful entries have to be at the front.
        let current = self.current_model(session).await?;
        // Ranking used to put this device's recently-used models next, off the
        // daemon MRU. ADR-0007 deletes that store, so the chat's own current
        // model is the only thing left to promote — everything else keeps the
        // catalog's order.
        let rank = |id: &str| -> usize {
            if current.as_deref() == Some(id) {
                0
            } else {
                usize::MAX
            }
        };
        // Stable sort: entries the device has no history for keep the
        // catalog's own (alphabetical) order.
        models.sort_by(|a, b| {
            let (ka, kb) = (
                rank(&format!("{}/{}", a.provider, a.model)),
                rank(&format!("{}/{}", b.provider, b.model)),
            );
            ka.cmp(&kb)
        });
        Ok(models)
    }

    async fn current_model(&self, session: &AmuxSessionId) -> Result<Option<String>, AgentError> {
        // A pinned override wins even before the runtime respawns onto it;
        // otherwise report what the live runtime settled on.
        if let Some((provider, model)) = {
            let overrides = self.model_override.lock().await;
            overrides.get(session).cloned()
        } {
            return Ok(Some(format!("{provider}/{model}")));
        }
        let Some(existing) = self.cached_session_if_live(session).await else {
            return Ok(None);
        };
        let mgr = self.manager.lock().await;
        Ok(mgr
            .agent_id_by_acp_session(&existing.real_acp_sid)
            .and_then(|agent_id| mgr.current_model(&agent_id).cloned()))
    }

    async fn set_model(
        &self,
        session: &AmuxSessionId,
        provider: &str,
        model: &str,
    ) -> Result<(), AgentError> {
        // Validate against the live catalog so /model only accepts names the
        // backend actually offers. An empty catalog means the probe failed,
        // not that nothing is runnable — don't reject the pick over that.
        let valid = self.catalog_for(session).await?;
        if !valid.is_empty()
            && !valid
                .iter()
                .any(|m| m.provider == provider && m.model == model)
        {
            return Err(AgentError::Send(format!(
                "unknown model {provider}/{model}; use /model to list what this workspace offers"
            )));
        }

        // Store override before tearing down the runtime so the lazy-spawn
        // that follows on the next prompt picks up the new model.
        {
            let mut overrides = self.model_override.lock().await;
            overrides.insert(
                session.to_string(),
                (provider.to_string(), model.to_string()),
            );
        }

        // Cancel current runtime + drop logical→acp mapping so the next
        // send_prompt lazy-spawns under the new model. Conversation context
        // is lost — same semantics as v1 /model.
        let _ = self.cancel(session).await;
        let mut map = self.logical_to_acp.lock().await;
        map.remove(session);

        Ok(())
    }

    async fn available_commands(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<AgentCommand>, AgentError> {
        // ── 1. Agent-reported commands (only if session is already spawned) ────
        // Built-ins (step 2) and workspace skills (step 3) are always returned
        // regardless of whether a runtime has been spawned for this session.
        let mut result: Vec<AgentCommand> = {
            let map = self.logical_to_acp.lock().await;
            let real = map.get(session).map(|s| s.real_acp_sid.clone());
            drop(map);
            if let Some(real) = real {
                let mgr = self.manager.lock().await;
                if let Some(agent_id) = mgr.agent_id_by_acp_session(&real) {
                    mgr.get_available_commands(&agent_id)
                        .into_iter()
                        .map(|c| AgentCommand {
                            name: c.name,
                            description: c.description,
                            input_hint: if c.input_hint.is_empty() {
                                None
                            } else {
                                Some(c.input_hint)
                            },
                        })
                        .collect()
                } else {
                    vec![]
                }
            } else {
                vec![]
            }
        };

        // Resolve agent type: daemon default → ClaudeCode fallback.
        let agent_type = self.default_agent_type;

        // ── 2. Agent built-in commands ──
        // Step 1 above is dead weight now: `AvailableCommandsUpdate` has no
        // producer under the opencode HTTP runtime, so it always yields an
        // empty list and everything real comes from here. Shared with the
        // actor-state retain so both surfaces advertise the same set.
        for cmd in crate::runtime::builtin_commands::builtin_commands(
            agent_type.unwrap_or(amux::AgentType::ClaudeCode),
        ) {
            if !result.iter().any(|c| c.name == cmd.name) {
                result.push(AgentCommand {
                    name: cmd.name,
                    description: cmd.description,
                    input_hint: if cmd.input_hint.is_empty() {
                        None
                    } else {
                        Some(cmd.input_hint)
                    },
                });
            }
        }

        Ok(result)
    }

    async fn list_skills(
        &self,
        _session: &AmuxSessionId,
    ) -> Result<Vec<(String, String)>, AgentError> {
        use crate::config::scan_roles_skills_state;
        let Some(ws_dir) = &self.default_workspace_dir else {
            return Ok(vec![]);
        };
        let state = scan_roles_skills_state(std::path::Path::new(ws_dir))
            .map_err(|e| AgentError::Internal(format!("skill scan: {e}")))?;
        let mut skills: Vec<(String, String)> = state
            .skills
            .into_iter()
            .map(|s| {
                let name = s
                    .invocation_name
                    .unwrap_or_else(|| s.filename.trim_end_matches(".md").to_string());
                (name, s.description)
            })
            .collect();
        skills.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(skills)
    }

    /// The roster of the cloud session this chat is bound to.
    ///
    /// `session` is the logical/acp id the gateway holds; the participant rows
    /// hang off the cloud `sessions` row, so it is resolved through the gateway
    /// index first. A chat with no cloud row yet (nothing sent) has no roster,
    /// which reads as an empty list rather than an error.
    ///
    /// Names come from the actor directory: `session_participants` stores only
    /// actor ids. An id the directory does not return still lists — under its
    /// id, so a roster never silently drops a seat.
    async fn list_participants(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<ParticipantInfo>, AgentError> {
        let Some((remote_session_id, _binding)) = self
            .backend
            .get_gateway_session_by_acp_id(session)
            .await
            .map_err(|e| AgentError::Internal(format!("session lookup: {e}")))?
        else {
            return Ok(Vec::new());
        };

        let seated = self
            .backend
            .fetch_session_with_participants(&remote_session_id)
            .await
            .map_err(|e| AgentError::Internal(format!("fetch participants: {e}")))?;
        if seated.participants.is_empty() {
            return Ok(Vec::new());
        }

        let ids: Vec<String> = seated
            .participants
            .iter()
            .map(|p| p.actor_id.clone())
            .collect();
        // A directory outage costs names, not the roster: fall back to ids.
        let directory = self
            .backend
            .get_actors_by_ids(&ids)
            .await
            .unwrap_or_default();

        Ok(seated
            .participants
            .iter()
            .map(|p| {
                let row = directory.iter().find(|a| a.id == p.actor_id);
                ParticipantInfo {
                    actor_id: p.actor_id.clone(),
                    display_name: row
                        .and_then(|a| a.display_name.clone())
                        .filter(|n| !n.trim().is_empty()),
                    kind: row.and_then(|a| a.kind.clone()),
                }
            })
            .collect())
    }

    async fn send_slash_command(
        &self,
        session: &AmuxSessionId,
        name: &str,
        input: Option<&str>,
    ) -> Result<TurnOutcome, AgentError> {
        let text = match input {
            Some(inp) if !inp.is_empty() => format!("/{name} {inp}"),
            _ => format!("/{name}"),
        };
        // A slash command the runtime handles itself is a turn like any
        // other; give it the same fallback patience as a plain prompt.
        self.send_prompt(
            session,
            "user",
            &text,
            std::time::Duration::from_secs(GATEWAY_TURN_TIMEOUT_SECS),
        )
        .await
    }

    /// This chat's own session history, from the cloud store.
    ///
    /// It used to enumerate `logical_to_acp`, which is an in-memory runtime
    /// cache: it holds at most the currently-live session, forgets everything on
    /// restart, and is keyed by ACP hex ids that name nothing to a chat user. So
    /// `/sessions` printed one bare id, and right after `/new` printed "No
    /// sessions." while the history sat in the database.
    ///
    /// The persistent list is keyed on the chat's binding (`gateway_key`), which
    /// this handle resolves from the active session's row.
    async fn list_sessions(
        &self,
        active_session: &AmuxSessionId,
    ) -> Result<Vec<SessionInfo>, AgentError> {
        let Some(binding) = self.binding_for_session(active_session).await? else {
            return Ok(Vec::new());
        };
        let rows = self
            .backend
            .rpc_list_gateway_sessions(&self.team_id, &binding, GATEWAY_SESSION_LIST_LIMIT)
            .await
            .map_err(|e| AgentError::Internal(format!("list_gateway_sessions: {e}")))?;
        Ok(rows
            .into_iter()
            .map(|r| SessionInfo {
                session_id: r.session_id,
                title: r.title,
                is_current: r.is_current,
            })
            .collect())
    }

    /// Move this chat's binding onto one of its earlier sessions.
    ///
    /// The switch itself is a single server-side operation: sessions are keyed
    /// by (team, binding), so once the binding points at the target row, the
    /// next inbound message resolves to it through the same
    /// `ensure_gateway_session` path as any other message — nothing local needs
    /// to be rewritten. The runtime map is left alone deliberately: an entry for
    /// the target that is still live (switching back inside one daemon uptime)
    /// keeps its conversation context, and one that is gone lazy-spawns on the
    /// next message exactly as a restart would.
    async fn switch_session(
        &self,
        active_session: &AmuxSessionId,
        target_session_id: &str,
    ) -> Result<bool, AgentError> {
        let Some(binding) = self.binding_for_session(active_session).await? else {
            return Ok(false);
        };
        // Stop whatever the outgoing session is doing: its turn would otherwise
        // keep running and reply into a chat that has moved on.
        let _ = self.cancel(active_session).await;
        let attached = self
            .backend
            .rpc_attach_gateway_session(&binding, target_session_id)
            .await
            .map_err(|e| AgentError::Internal(format!("attach_gateway_session: {e}")))?;
        match attached {
            Some(acp) => {
                tracing::info!(
                    from_session = %active_session,
                    to_session = %target_session_id,
                    to_acp_session = %acp,
                    "gateway chat switched session"
                );
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Enumerates workspaces from the cloud `amux.workspaces` table
    /// (`Backend::get_workspaces_by_agent`), filtered down to rows that
    /// resolve to a linkable, on-disk path on *this* machine — the cloud
    /// list spans every device on the team, so most rows will not resolve
    /// locally. `amux.workspaces` is the sole source of truth; there is no
    /// more local `WorkspaceStore`/`workspaces.toml` to enumerate.
    async fn list_workspaces(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<WorkspaceInfo>, AgentError> {
        let rows = self
            .backend
            .get_workspaces_by_agent(&self.team_id, self.backend.actor_id())
            .await
            .map_err(|e| AgentError::Internal(format!("get_workspaces_by_agent: {e}")))?;
        let current_id = {
            let overrides = self.workspace_override.lock().await;
            overrides.get(session.as_str()).cloned()
        };
        let current_id = match current_id {
            Some(id) => Some(id),
            None => self
                .backend
                .get_agent_defaults(self.backend.actor_id())
                .await
                .ok()
                .and_then(|d| d.default_workspace_id),
        };
        let mut listed = rows
            .into_iter()
            .filter_map(|row| {
                let (_, display_name) =
                    crate::config::workspace_path::listable_local_workspace(&row)?;
                Some(WorkspaceInfo {
                    workspace_id: row.id.clone(),
                    display_name,
                    is_current: current_id.as_deref() == Some(row.id.as_str()),
                })
            })
            .collect::<Vec<_>>();
        // `/workspace <n>` resolves n against a fresh call to this method, so
        // the order has to be reproducible — the backend's own (updated_at
        // desc) ordering shifts under any write.
        listed.sort_by(|a, b| {
            a.display_name
                .cmp(&b.display_name)
                .then_with(|| a.workspace_id.cmp(&b.workspace_id))
        });
        Ok(listed)
    }

    async fn set_workspace(
        &self,
        session: &AmuxSessionId,
        workspace_id: &str,
    ) -> Result<(), AgentError> {
        let rows = self
            .backend
            .get_workspaces_by_agent(&self.team_id, self.backend.actor_id())
            .await
            .map_err(|e| AgentError::Internal(format!("get_workspaces_by_agent: {e}")))?;
        match rows.iter().find(|w| w.id == workspace_id) {
            None => {
                return Err(AgentError::NotFound(format!(
                    "workspace '{workspace_id}' not found"
                )))
            }
            // /workspaces never lists archived rows, so accepting one here
            // would only ever come from a stale id.
            Some(row) if row.archived => {
                return Err(AgentError::NotFound(format!(
                    "workspace '{workspace_id}' is archived"
                )))
            }
            Some(_) => {}
        }
        // Scoped to this session, always (#933).
        //
        // On a WeCom bot this used to write the bot's *default* into
        // `daemon.toml` and reset every one of that bot's sessions. There is no
        // permission model on a chat command, so that meant anyone who could
        // message the bot — in any chat it was in — could repoint everybody
        // else's workspace and drop their sessions. A transport adapter has no
        // business writing daemon config, and a chat command should change the
        // chat it was typed in.
        //
        // The cost is that the choice no longer survives a daemon restart for
        // WeCom; setting a bot's default is a settings operation, not a thing
        // a passer-by types into a group chat.
        {
            let mut overrides = self.workspace_override.lock().await;
            overrides.insert(session.to_string(), workspace_id.to_string());
        }

        // Atomically remove entry then cancel to avoid TOCTOU race.
        let real_sid = {
            let mut map = self.logical_to_acp.lock().await;
            let sid = map.get(session).map(|s| s.real_acp_sid.clone());
            map.remove(session);
            sid
        };
        if let Some(real) = real_sid {
            let mut mgr = self.manager.lock().await;
            let _ = mgr.cancel_by_acp_session(&real).await;
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::backend::mock::MockBackend;
    use crate::runtime::RuntimeManager;

    fn make_handle() -> AmuxdAgentHandle {
        make_handle_with_backend(Arc::new(MockBackend::default()))
    }

    /// Like `make_handle`, but wires the given backend Arc into BOTH
    /// `handle.backend` and `handle.workspace_resolver` so a test can seed
    /// `amux.workspaces` rows (via `backend.state().workspaces_by_id`) and
    /// have `resolve_spawn_target` -> `workspace_dir_for_id` -> the resolver
    /// actually see them, rather than a disconnected default backend.
    fn make_handle_with_backend(backend: Arc<MockBackend>) -> AmuxdAgentHandle {
        AmuxdAgentHandle {
            manager: Arc::new(Mutex::new(RuntimeManager::new(
                RuntimeManager::default_launch_configs(),
                None,
            ))),
            spawn_env: GatewaySpawnEnv {
                managed_llm: Arc::new(crate::runtime::managed_llm::ManagedLlmResolver::new(
                    backend.clone(),
                )),
                actor_id: "actor-test".to_string(),
                actor_name: "Test Agent".to_string(),
                refresh_coordinator: None,
            },
            logical_to_acp: Arc::new(Mutex::new(HashMap::new())),
            team_id: "team-test".to_string(),
            model_override: Arc::new(Mutex::new(HashMap::new())),
            // Unset, so these tests keep exercising the unpinned spawn.
            gateway_model: None,
            backend: backend.clone(),
            default_agent_type: None,
            default_workspace_id: None,
            default_workspace_dir: None,
            workspace_resolver: Arc::new(crate::config::WorkspaceResolver::new(backend)),
            workspace_override: Arc::new(Mutex::new(HashMap::new())),
            bot_configs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) async fn capture_workspace_and_unscoped_gateway_attaches(
        backend: Arc<MockBackend>,
        workspace: &std::path::Path,
    ) -> (
        crate::runtime::test_support::CapturedAttach,
        crate::runtime::test_support::CapturedAttach,
    ) {
        backend.state().gateway_session_index.insert(
            "cross-entry-scoped".into(),
            ("cloud-scoped".into(), Some("wecom://bot/chat".into())),
        );
        backend.state().gateway_session_index.insert(
            "cross-entry-bare".into(),
            ("cloud-bare".into(), Some("wecom://bot/chat".into())),
        );

        let mut scoped = make_handle_with_backend(backend.clone());
        scoped.team_id = "team-test".into();
        scoped.spawn_env.actor_id = "actor-config-test".into();
        scoped.spawn_env.actor_name = "test-host".into();
        scoped.default_agent_type = Some(amux::AgentType::Opencode);
        scoped.default_workspace_dir = Some(workspace.to_string_lossy().into_owned());
        let scoped_captures = {
            let mut manager = scoped.manager.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };
        scoped
            .resolve_or_spawn(&AmuxSessionId::from("cross-entry-scoped"))
            .await
            .unwrap();

        let mut bare = make_handle_with_backend(backend);
        bare.team_id = "team-test".into();
        bare.spawn_env.actor_id = "actor-config-test".into();
        bare.spawn_env.actor_name = "test-host".into();
        bare.default_agent_type = Some(amux::AgentType::Opencode);
        let bare_captures = {
            let mut manager = bare.manager.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };
        bare.resolve_or_spawn(&AmuxSessionId::from("cross-entry-bare"))
            .await
            .unwrap();

        let scoped = scoped_captures.lock().unwrap()[0].clone();
        let bare = bare_captures.lock().unwrap()[0].clone();
        (scoped, bare)
    }

    #[tokio::test]
    async fn gateway_without_workspace_is_the_only_bare_unscoped_context() {
        let handle = make_handle();

        let context = handle.assemble_execution_context(None).await.unwrap();

        assert_eq!(
            context.isolation_domain,
            IsolationDomainKey::UnscopedAgent {
                team_id: "team-test".into(),
                actor_id: "actor-test".into(),
            }
        );
        assert!(context.workspace.is_none());
        assert!(context.spawn_env.extra_env.is_empty());
        assert!(context.spawn_env.is_gateway);
    }

    #[tokio::test]
    async fn gateway_with_workspace_uses_workspace_domain_and_full_env() {
        use crate::backend::WorkspaceRow;

        let workspace = tempfile::tempdir().unwrap();
        let backend = Arc::new(MockBackend::default());
        backend.state().workspaces_by_id.insert(
            "ws-a".into(),
            WorkspaceRow {
                id: "ws-a".into(),
                team_id: "team-test".into(),
                path: Some(workspace.path().to_string_lossy().into_owned()),
                archived: false,
                agent_id: None,
            },
        );
        let handle = make_handle_with_backend(backend);

        let context = handle
            .assemble_execution_context(Some(workspace.path().to_string_lossy().as_ref()))
            .await
            .unwrap();

        assert_eq!(
            context.isolation_domain,
            IsolationDomainKey::Workspace("ws-a".into())
        );
        assert_eq!(context.working_directory, workspace.path());
        assert_eq!(
            context
                .spawn_env
                .resolved_env
                .as_ref()
                .and_then(|snapshot| snapshot.bindings.get("actor_id")),
            Some(&"actor-test".to_string())
        );
        assert!(context.spawn_env.is_gateway);
    }

    #[tokio::test]
    async fn agent_handle_spawn_propagates_scoped_and_bare_attach_contexts() {
        use crate::backend::WorkspaceRow;

        let workspace = tempfile::tempdir().unwrap();
        let backend = Arc::new(MockBackend::with_identity("team-a", "actor-a"));
        backend.state().workspaces_by_id.insert(
            "ws-a".into(),
            WorkspaceRow {
                id: "ws-a".into(),
                team_id: "team-a".into(),
                path: Some(workspace.path().to_string_lossy().into_owned()),
                archived: false,
                agent_id: None,
            },
        );
        backend.state().gateway_session_index.insert(
            "scoped".into(),
            ("cloud-scoped".into(), Some("wecom://bot/chat".into())),
        );
        backend.state().gateway_session_index.insert(
            "bare".into(),
            ("cloud-bare".into(), Some("wecom://bot/chat".into())),
        );

        let mut scoped = make_handle_with_backend(backend.clone());
        scoped.team_id = "team-a".into();
        scoped.spawn_env.actor_id = "actor-a".into();
        scoped.default_agent_type = Some(amux::AgentType::Opencode);
        scoped.default_workspace_dir = Some(workspace.path().to_string_lossy().into_owned());
        scoped.workspace_resolver.resolve("ws-a").await.unwrap();
        let scoped_captures = {
            let mut manager = scoped.manager.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };
        scoped
            .resolve_or_spawn(&AmuxSessionId::from("scoped"))
            .await
            .unwrap();

        let mut bare = make_handle_with_backend(backend);
        bare.team_id = "team-a".into();
        bare.spawn_env.actor_id = "actor-a".into();
        bare.default_agent_type = Some(amux::AgentType::Opencode);
        let bare_captures = {
            let mut manager = bare.manager.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };
        bare.resolve_or_spawn(&AmuxSessionId::from("bare"))
            .await
            .unwrap();

        let scoped_captures = scoped_captures.lock().unwrap();
        assert_eq!(scoped_captures.len(), 1);
        assert_eq!(
            scoped_captures[0].domain,
            IsolationDomainKey::Workspace("ws-a".into())
        );
        assert_eq!(scoped_captures[0].working_directory, workspace.path());
        assert_eq!(
            scoped_captures[0].process_env_revision,
            crate::runtime::execution_context::ProcessEnvRevision::from_bindings(
                &scoped_captures[0].extra_env
            )
        );

        let bare_captures = bare_captures.lock().unwrap();
        assert_eq!(bare_captures.len(), 1);
        assert_eq!(
            bare_captures[0].domain,
            IsolationDomainKey::UnscopedAgent {
                team_id: "team-a".into(),
                actor_id: "actor-a".into(),
            }
        );
    }

    #[tokio::test]
    async fn explicit_gateway_workspace_lookup_failure_does_not_attach_unscoped() {
        let backend = Arc::new(MockBackend::with_identity("team-a", "actor-a"));
        backend.state().gateway_session_index.insert(
            "scoped-missing".into(),
            (
                "cloud-scoped-missing".into(),
                Some("seatalk://app/dm/E001".into()),
            ),
        );

        let mut handle = make_handle_with_backend(backend);
        handle.team_id = "team-a".into();
        handle.spawn_env.actor_id = "actor-a".into();
        handle.default_agent_type = Some(amux::AgentType::Opencode);
        handle
            .workspace_override
            .lock()
            .await
            .insert("scoped-missing".into(), "ws-missing".into());
        let captures = {
            let mut manager = handle.manager.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };

        let err = match handle
            .resolve_or_spawn(&AmuxSessionId::from("scoped-missing"))
            .await
        {
            Ok(_) => panic!("configured workspace lookup failure must reject the spawn"),
            Err(err) => err,
        };

        assert!(
            err.to_string().contains("ws-missing"),
            "resolution error must identify the configured workspace: {err}"
        );
        assert!(
            captures.lock().unwrap().is_empty(),
            "failed scoped resolution must not attach as UnscopedAgent"
        );
    }

    #[tokio::test]
    async fn daemon_default_workspace_lookup_failure_does_not_attach_unscoped() {
        let backend = Arc::new(MockBackend::with_identity("team-a", "actor-a"));
        backend.state().gateway_session_index.insert(
            "daemon-default-missing".into(),
            (
                "cloud-daemon-default-missing".into(),
                Some("seatalk://app/dm/E001".into()),
            ),
        );

        let mut handle = make_handle_with_backend(backend);
        handle.team_id = "team-a".into();
        handle.spawn_env.actor_id = "actor-a".into();
        handle.default_agent_type = Some(amux::AgentType::Opencode);
        handle.default_workspace_id = Some("ws-daemon-default-missing".into());
        let captures = {
            let mut manager = handle.manager.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };

        let err = match handle
            .resolve_or_spawn(&AmuxSessionId::from("daemon-default-missing"))
            .await
        {
            Ok(_) => panic!("configured daemon workspace lookup failure must reject the spawn"),
            Err(err) => err,
        };

        assert!(
            err.to_string().contains("ws-daemon-default-missing"),
            "resolution error must identify the daemon default workspace: {err}"
        );
        assert!(
            captures.lock().unwrap().is_empty(),
            "failed daemon default resolution must not attach as UnscopedAgent"
        );
    }

    /// Drive a `TurnAggregator` and `absorb_emitted` — the same pair
    /// `run_turn` uses — over a scripted event stream.
    fn segments_from(events: &[amux::AcpEvent]) -> Vec<String> {
        use crate::runtime::turn_aggregator::TurnAggregator;
        let mut agg = TurnAggregator::new();
        let mut segments = Vec::new();
        let mut live = String::new();
        for ev in events {
            absorb_emitted(agg.ingest(ev), &mut segments, &mut live);
        }
        segments
    }

    fn output(text: &str) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                text: text.into(),
                is_complete: false,
            })),
            model: String::new(),
        }
    }

    fn tool_use(name: &str) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                tool_id: "t1".into(),
                tool_name: name.into(),
                description: String::new(),
                params: Default::default(),
                tool_kind: String::new(),
                raw_input_json: String::new(),
                raw_output_json: String::new(),
                content: vec![],
                locations: vec![],
                status: String::new(),
            })),
            model: String::new(),
        }
    }

    fn turn_end() -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(amux::acp_event::Event::StatusChange(
                amux::AcpStatusChange {
                    old_status: amux::AgentStatus::Active as i32,
                    new_status: amux::AgentStatus::Idle as i32,
                },
            )),
            model: String::new(),
        }
    }

    /// Regression: a tool call mid-turn makes the aggregator flush an
    /// `AgentReply` carrying only the prose written *before* the tool. Any
    /// consumer that stops at the first one ships the agent's "let me go look
    /// that up:" preamble as the whole answer and drops the real reply — which
    /// is what WeCom users saw.
    #[test]
    fn reply_keeps_every_segment_across_a_tool_call() {
        let segments = segments_from(&[
            output("让我再找一下 token 的来源："),
            tool_use("Read"),
            output("Token 还没过期！"),
            turn_end(),
        ]);

        assert_eq!(
            segments,
            vec!["让我再找一下 token 的来源：", "Token 还没过期！"],
            "the aggregator must surface the pre-tool preamble and the post-tool answer separately"
        );
        assert_eq!(
            compose_reply(&segments, ""),
            "让我再找一下 token 的来源：\n\nToken 还没过期！"
        );
    }

    #[test]
    fn reply_survives_several_tool_calls() {
        let segments = segments_from(&[
            output("first"),
            tool_use("Read"),
            tool_use("Grep"),
            output("second"),
            tool_use("Bash"),
            output("third"),
            turn_end(),
        ]);
        assert_eq!(compose_reply(&segments, ""), "first\n\nsecond\n\nthird");
    }

    /// Tool-only turns emit a `no_final_reply` AgentReply at Idle for cloud /
    /// catchup; channel absorb must still yield no user-visible segment.
    #[test]
    fn tool_only_turn_yields_empty_reply() {
        let segments = segments_from(&[tool_use("Bash"), turn_end()]);
        assert!(segments.is_empty());
        assert_eq!(compose_reply(&segments, ""), "");
    }

    #[test]
    fn salvage_timeout_returns_text_when_present_else_timeout() {
        // #555: text already produced → return it instead of failing.
        assert_eq!(
            salvage_timeout_reply(&["最终答案".to_string()], "").unwrap(),
            "最终答案"
        );
        assert_eq!(salvage_timeout_reply(&[], "partial").unwrap(), "partial");
        // Nothing produced → stays a Timeout error.
        assert!(matches!(
            salvage_timeout_reply(&[], "   "),
            Err(AgentError::Timeout)
        ));
        assert!(matches!(
            salvage_timeout_reply(&[], ""),
            Err(AgentError::Timeout)
        ));
    }

    #[test]
    fn compose_reply_appends_unflushed_tail() {
        let segments = vec!["done".to_string()];
        assert_eq!(compose_reply(&segments, "typing"), "done\n\ntyping");
        assert_eq!(compose_reply(&segments, "   "), "done");
        assert_eq!(compose_reply(&[], "typing"), "typing");
    }

    #[test]
    fn bot_id_parsed_from_wecom_binding() {
        assert_eq!(
            bot_id_from_binding("wecom://botX/botX/single/u1"),
            Some("botX")
        );
        assert_eq!(
            bot_id_from_binding("wecom://botY/botY/group/c9"),
            Some("botY")
        );
        assert_eq!(bot_id_from_binding("discord://g/c"), None);
        assert_eq!(bot_id_from_binding(""), None);
    }

    #[tokio::test]
    async fn resolution_priority_session_over_bot_over_global() {
        use amux::AgentType;
        let mut bots = HashMap::new();
        bots.insert(
            "botA".to_string(),
            BotRuntimeConfig {
                workspace_id: None,
                workspace_dir: Some("/ws/bot-a".into()),
                agent_type: Some(AgentType::Opencode),
                system_prompt: Some("A".into()),
            },
        );
        let mut handle = make_handle();
        handle.bot_configs = Arc::new(Mutex::new(bots));
        handle.default_workspace_dir = Some("/ws/global".into());
        handle.default_agent_type = Some(AgentType::ClaudeCode);

        let (ws, at) = handle
            .resolve_spawn_target("sess-A", "wecom://botA/botA/single/u")
            .await
            .unwrap();
        assert_eq!(ws.as_deref(), Some("/ws/bot-a"));
        assert_eq!(at, Some(AgentType::Opencode));

        let (ws2, at2) = handle
            .resolve_spawn_target("sess-Z", "wecom://botZ/botZ/single/u")
            .await
            .unwrap();
        assert_eq!(ws2.as_deref(), Some("/ws/global"));
        assert_eq!(at2, Some(AgentType::ClaudeCode));
    }

    /// The team-wide list registers the SAME path once per agent, so a shared
    /// directory name like `~/TeamClu` appears once per device — and every
    /// duplicate passes the "does this path exist locally" filter on a machine
    /// that happens to have that path. `/workspaces` showed 15 entries for two
    /// real workspaces until it started asking by agent. Archived rows are
    /// dropped on top of that.
    #[tokio::test]
    async fn list_workspaces_shows_only_this_agents_live_rows() {
        use crate::backend::WorkspaceRow;

        let live = tempfile::tempdir().unwrap();
        let retired = tempfile::tempdir().unwrap();
        let backend = Arc::new(MockBackend::with_identity("team-test", "agent-me"));
        {
            let mut st = backend.state();
            st.workspaces_by_id.insert(
                "ws-live".to_string(),
                WorkspaceRow {
                    id: "ws-live".to_string(),
                    team_id: "team-test".to_string(),
                    path: Some(live.path().to_string_lossy().to_string()),
                    archived: false,
                    agent_id: Some("agent-me".to_string()),
                },
            );
            st.workspaces_by_id.insert(
                "ws-retired".to_string(),
                WorkspaceRow {
                    id: "ws-retired".to_string(),
                    team_id: "team-test".to_string(),
                    path: Some(retired.path().to_string_lossy().to_string()),
                    archived: true,
                    agent_id: Some("agent-me".to_string()),
                },
            );
            // Another device registered the very same directory. Its path
            // resolves here, so only the agent check can exclude it.
            st.workspaces_by_id.insert(
                "ws-other-device".to_string(),
                WorkspaceRow {
                    id: "ws-other-device".to_string(),
                    team_id: "team-test".to_string(),
                    path: Some(live.path().to_string_lossy().to_string()),
                    archived: false,
                    agent_id: Some("agent-someone-else".to_string()),
                },
            );
        }
        let handle = make_handle_with_backend(backend);
        let listed = handle
            .list_workspaces(&AmuxSessionId::from("sess-1".to_string()))
            .await
            .unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|w| w.workspace_id.as_str())
                .collect::<Vec<_>>(),
            vec!["ws-live"]
        );

        // Archived / other-device rows are refused as switch targets rather
        // than silently accepted.
        let err = handle
            .set_workspace(&AmuxSessionId::from("sess-1".to_string()), "ws-retired")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("archived"), "got {err}");

        let err = handle
            .set_workspace(
                &AmuxSessionId::from("sess-1".to_string()),
                "ws-other-device",
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"), "got {err}");
    }

    /// Exercises the ASYNC workspace-resolution path end to end:
    /// `resolve_spawn_target` -> `workspace_dir_for_id` -> `WorkspaceResolver::resolve`
    /// -> `Backend::get_workspaces_by_ids`. Seeds a real workspace row in
    /// `MockBackend` (id -> path), wires that SAME backend Arc into the
    /// resolver via `make_handle_with_backend`, and asserts the
    /// session-level `workspace_override` (a workspace_id, not a raw path)
    /// resolves through to the seeded path — while a bot-level and a
    /// global-level workspace_dir (plain paths, no resolver involvement)
    /// remain configured but are correctly shadowed by the higher-priority
    /// session override, proving priority still holds through the resolver.
    #[tokio::test]
    async fn resolution_priority_session_override_resolves_via_workspace_resolver() {
        use crate::backend::WorkspaceRow;
        use amux::AgentType;

        let backend = Arc::new(MockBackend::default());
        let session_ws_id = "ws-session-1234";
        backend.state().workspaces_by_id.insert(
            session_ws_id.to_string(),
            WorkspaceRow {
                id: session_ws_id.to_string(),
                team_id: "team-test".to_string(),
                path: Some("/tmp/ws-session".to_string()),
                archived: false,
                agent_id: None,
            },
        );

        let mut handle = make_handle_with_backend(backend);

        // Bot-level and global-level defaults point at different, plain
        // (non-resolver) paths so we can prove they're shadowed.
        let mut bots = HashMap::new();
        bots.insert(
            "botA".to_string(),
            BotRuntimeConfig {
                workspace_id: None,
                workspace_dir: Some("/ws/bot-a".into()),
                agent_type: Some(AgentType::Opencode),
                system_prompt: None,
            },
        );
        handle.bot_configs = Arc::new(Mutex::new(bots));
        handle.default_workspace_dir = Some("/ws/global".into());

        handle
            .workspace_override
            .lock()
            .await
            .insert("sess-resolved".to_string(), session_ws_id.to_string());

        let (ws, _at) = handle
            .resolve_spawn_target("sess-resolved", "wecom://botA/botA/single/u")
            .await
            .unwrap();
        assert_eq!(
            ws.as_deref(),
            Some("/tmp/ws-session"),
            "session-level workspace_id override must resolve through WorkspaceResolver \
             and win over bot-level / global defaults"
        );

        // Pointing the override at an unseeded id must fail closed rather than
        // erasing the session scope and falling back to the bot-level default.
        handle
            .workspace_override
            .lock()
            .await
            .insert("sess-unseeded".to_string(), "ws-does-not-exist".to_string());
        let err = handle
            .resolve_spawn_target("sess-unseeded", "wecom://botA/botA/single/u")
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("ws-does-not-exist"),
            "unseeded workspace_id must return its resolution error: {err}"
        );
    }

    /// Regression for #548: a cached `logical → real ACP` mapping whose
    /// runtime has stopped (nothing in `RuntimeManager.agents` matches the
    /// UUID) must be treated as absent and evicted, so the next turn
    /// re-spawns instead of failing with `no agent for acp_session_id`.
    #[tokio::test]
    async fn stale_mapping_is_evicted_when_runtime_gone() {
        let handle = make_handle();
        handle.logical_to_acp.lock().await.insert(
            "sess-stale".to_string(),
            ResolvedSession {
                real_acp_sid: "dead-acp-uuid".to_string(),
                binding: "wecom://botA/botA/single/u".to_string(),
                remote_session_id: None,
                was_primed: true,
            },
        );

        // Manager is empty, so the mapped UUID has no live runtime.
        let live = handle
            .cached_session_if_live(&AmuxSessionId::from("sess-stale"))
            .await;
        assert!(
            live.is_none(),
            "dead runtime must not resolve as a live cache hit"
        );
        assert!(
            !handle
                .logical_to_acp
                .lock()
                .await
                .contains_key("sess-stale"),
            "the stale mapping must be evicted so the next turn re-spawns"
        );
    }

    #[test]
    fn preamble_includes_bot_system_prompt() {
        let p = build_first_turn_prompt(
            "wecom",
            Some("你是法务助手，只用中文回答。"),
            "Alice",
            "你好",
        );
        assert!(p.contains("你是法务助手"));
        assert!(p.contains("[Alice] 你好"));
        assert!(p.contains("amuxd-send"), "keeps the send-tool note");
    }

    #[test]
    fn preamble_without_bot_prompt_matches_legacy() {
        let p = build_first_turn_prompt("wecom", None, "Bob", "hi");
        assert!(p.contains("amuxd-send"));
        assert!(p.contains("[Bob] hi"));
    }

    /// Verify `set_model` stores `(provider, model)` as a tuple so the
    /// lazy-spawn in `resolve_or_spawn` forwards BOTH to
    /// `create_gateway_session_with_model`.  The provider must be preserved
    /// because `resolve_initial_model` needs it to reconstruct the full
    /// `provider/model` id for backends that use that form (e.g. OpenCode).
    #[tokio::test]
    async fn set_model_stores_provider_and_model_tuple() {
        let handle = make_handle();
        let session = AmuxSessionId::from("sess-1");

        // Simulate a user choosing a provider/model. set_model validates
        // against list_models() (live catalog via MockBackend here); pick a
        // model the mock serves so validation passes. The assertion is that
        // the provider/model tuple is stored intact.
        handle
            .set_model(&session, "anthropic", "sonnet")
            .await
            .unwrap();

        let overrides = handle.model_override.lock().await;
        let stored = overrides.get("sess-1").cloned().unwrap();
        assert_eq!(stored.0, "anthropic", "provider must be stored");
        assert_eq!(stored.1, "sonnet", "model must be stored");
    }

    #[tokio::test]
    async fn set_model_updates_existing_override() {
        let handle = make_handle();
        let session = AmuxSessionId::from("sess-2");

        handle
            .set_model(&session, "anthropic", "sonnet")
            .await
            .unwrap();
        handle
            .set_model(&session, "anthropic", "opus")
            .await
            .unwrap();

        let overrides = handle.model_override.lock().await;
        let stored = overrides.get("sess-2").cloned().unwrap();
        assert_eq!(stored.1, "opus", "second set_model must overwrite");
    }

    /// Seed a chat (`binding`) whose lineage is `rows`, bound to `acp` right now.
    fn seed_chat(
        backend: &Arc<MockBackend>,
        acp: &str,
        binding: &str,
        rows: Vec<crate::backend::GatewaySessionRow>,
    ) {
        let mut st = backend.state();
        st.gateway_session_index.insert(
            acp.to_string(),
            ("session-row".to_string(), Some(binding.to_string())),
        );
        st.gateway_sessions_by_key.insert(binding.to_string(), rows);
    }

    fn gw_row(
        session_id: &str,
        acp: &str,
        title: &str,
        is_current: bool,
    ) -> crate::backend::GatewaySessionRow {
        crate::backend::GatewaySessionRow {
            session_id: session_id.to_string(),
            acp_session_id: Some(acp.to_string()),
            title: title.to_string(),
            is_current,
        }
    }

    #[tokio::test]
    async fn list_sessions_returns_the_chats_persisted_lineage_not_the_runtime_map() {
        // The old impl enumerated `logical_to_acp`, so right after `/new` — when
        // nothing is spawned — `/sessions` answered "No sessions." while the
        // history sat in the cloud store.
        let backend = Arc::new(MockBackend::default());
        seed_chat(
            &backend,
            "acp-live",
            "wecom://bot-1/user/liang",
            vec![
                gw_row("s-2", "acp-live", "WeCom DM: LiangLiang", true),
                gw_row(
                    "s-1",
                    "acp-old",
                    "WeCom DM: LiangLiang (2026-07-26 09:12)",
                    false,
                ),
            ],
        );
        let handle = make_handle_with_backend(backend);

        let out = handle
            .list_sessions(&AmuxSessionId::from("acp-live"))
            .await
            .unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].session_id, "s-2");
        assert!(out[0].is_current);
        assert_eq!(out[0].title, "WeCom DM: LiangLiang");
        assert!(!out[1].is_current);
        assert!(handle.logical_to_acp.lock().await.is_empty());
    }

    /// Seat `actors` (id, display_name, kind) in the cloud session `seed_chat`
    /// points `acp` at, and register them in the actor directory.
    fn seed_participants(backend: &Arc<MockBackend>, actors: &[(&str, &str, &str)]) {
        use crate::backend::{
            ActorDirectoryRow, BackendParticipantRow, BackendSessionAndParticipants,
            BackendSessionRow,
        };
        let now = chrono::Utc::now();
        let mut st = backend.state();
        st.sessions.insert(
            "session-row".to_string(),
            BackendSessionAndParticipants {
                session: BackendSessionRow {
                    id: "session-row".to_string(),
                    team_id: "team-mock".to_string(),
                    created_by_actor_id: None,
                    primary_agent_id: None,
                    mode: "collab".to_string(),
                    title: "WeCom DM: LiangLiang".to_string(),
                    summary: String::new(),
                    idea_id: None,
                    created_at: now,
                },
                participants: actors
                    .iter()
                    .map(|(id, _, _)| BackendParticipantRow {
                        session_id: "session-row".to_string(),
                        actor_id: id.to_string(),
                        role: None,
                        joined_at: now,
                    })
                    .collect(),
            },
        );
        for (id, name, kind) in actors {
            st.actors_by_id.insert(
                id.to_string(),
                ActorDirectoryRow {
                    id: id.to_string(),
                    display_name: Some(name.to_string()),
                    kind: Some(kind.to_string()),
                },
            );
        }
    }

    #[tokio::test]
    async fn list_participants_names_every_seat_from_the_directory() {
        let backend = Arc::new(MockBackend::default());
        seed_chat(&backend, "acp-live", "wecom://bot-1/user/liang", vec![]);
        seed_participants(
            &backend,
            &[
                ("actor-liang", "LiangLiang", "member"),
                ("actor-mac", "Mac-mini-3", "agent"),
            ],
        );
        let handle = make_handle_with_backend(backend);

        let out = handle
            .list_participants(&AmuxSessionId::from("acp-live"))
            .await
            .unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].display_name.as_deref(), Some("LiangLiang"));
        assert_eq!(out[0].kind.as_deref(), Some("member"));
        assert_eq!(out[1].display_name.as_deref(), Some("Mac-mini-3"));
        assert_eq!(out[1].kind.as_deref(), Some("agent"));
    }

    #[tokio::test]
    async fn list_participants_keeps_a_seat_the_directory_cannot_name() {
        // Dropping the row would under-report who is in the chat, which is the
        // one thing this command must not do. The id is a poor label but a
        // truthful one.
        let backend = Arc::new(MockBackend::default());
        seed_chat(&backend, "acp-live", "wecom://bot-1/user/liang", vec![]);
        seed_participants(&backend, &[("actor-known", "LiangLiang", "member")]);
        {
            let mut st = backend.state();
            let seated = st.sessions.get_mut("session-row").unwrap();
            seated
                .participants
                .push(crate::backend::BackendParticipantRow {
                    session_id: "session-row".to_string(),
                    actor_id: "actor-missing".to_string(),
                    role: None,
                    joined_at: chrono::Utc::now(),
                });
        }
        let handle = make_handle_with_backend(backend);

        let out = handle
            .list_participants(&AmuxSessionId::from("acp-live"))
            .await
            .unwrap();
        assert_eq!(out.len(), 2);
        // The seat survives; only its labels are missing, and the id it is
        // rendered from is still carried.
        assert_eq!(out[1].actor_id, "actor-missing");
        assert!(out[1].display_name.is_none());
        assert!(out[1].kind.is_none());
    }

    #[tokio::test]
    async fn list_participants_is_empty_for_a_chat_with_no_cloud_session() {
        // Nothing has been sent yet, so there is no session row to have a
        // roster. `/participant` says "no one here", not an error.
        let handle = make_handle();
        let out = handle
            .list_participants(&AmuxSessionId::from("acp-unbound"))
            .await
            .unwrap();
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn list_sessions_is_empty_for_a_session_with_no_chat_binding() {
        // A session that is not gateway-bound has no chat history to list; the
        // command must say "No sessions." rather than fail.
        let handle = make_handle();
        let out = handle
            .list_sessions(&AmuxSessionId::from("acp-unbound"))
            .await
            .unwrap();
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn switch_session_moves_the_chats_binding_to_the_target() {
        let backend = Arc::new(MockBackend::default());
        seed_chat(
            &backend,
            "acp-live",
            "wecom://bot-1/user/liang",
            vec![
                gw_row("s-2", "acp-live", "now", true),
                gw_row("s-1", "acp-old", "earlier", false),
            ],
        );
        let handle = make_handle_with_backend(backend.clone());

        let switched = handle
            .switch_session(&AmuxSessionId::from("acp-live"), "s-1")
            .await
            .unwrap();
        assert!(switched);
        assert_eq!(
            backend.state().gateway_sessions_attached.as_slice(),
            &[("wecom://bot-1/user/liang".to_string(), "s-1".to_string())]
        );
    }

    #[tokio::test]
    async fn switch_session_declines_a_session_from_another_chat() {
        // The guard lives in the backend (`gateway_key` must match), so the
        // handle has to report the refusal rather than assume success.
        let backend = Arc::new(MockBackend::default());
        seed_chat(
            &backend,
            "acp-live",
            "wecom://bot-1/user/liang",
            vec![gw_row("s-2", "acp-live", "now", true)],
        );
        let handle = make_handle_with_backend(backend);

        let switched = handle
            .switch_session(&AmuxSessionId::from("acp-live"), "s-elsewhere")
            .await
            .unwrap();
        assert!(!switched);
    }
}
