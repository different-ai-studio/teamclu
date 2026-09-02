//! Extracted from `server.rs` — methods of `DaemonServer` grouped by concern.
//! See `server.rs` for the struct definition and core lifecycle.

use super::*;

/// The local fast-path starts before cloud workspace resolution and therefore
/// legitimately has no workspace id. A concurrent focus/ensure request for
/// the same directory has the canonical id; it must reuse that runtime rather
/// than interrupting its active turn.
fn same_runtime_workspace(
    existing_worktree: &str,
    existing_workspace_id: &str,
    requested_worktree: &str,
    requested_workspace_id: &str,
) -> bool {
    existing_workspace_id == requested_workspace_id
        || (!existing_worktree.is_empty()
            && existing_worktree == requested_worktree
            && (existing_workspace_id.is_empty() || requested_workspace_id.is_empty()))
}

impl DaemonServer {
    /// Bind remote-tool routing metadata to a live runtime.
    /// Route selection is message-level via `remote_context_id`; this binding is
    /// retained only for compatibility/diagnostics and must not trigger ACP resume.
    pub(crate) async fn bind_remote_tool_member(
        &self,
        runtime_id: &str,
        session_id: &str,
        member_actor_id: &str,
        _team_id: &str,
    ) {
        if session_id.is_empty() || member_actor_id.is_empty() {
            return;
        }
        {
            let mut agents = self.agents.lock().await;
            if let Some(h) = agents.get_handle_mut(runtime_id) {
                h.remote_tool_member_id = member_actor_id.to_string();
            }
        }
        {
            let mut targets = self.session_remote_targets.lock().await;
            targets.prune_expired();
            targets.set(session_id, member_actor_id);
        }
        // Host-level `amuxd-remote-tools` injection is paused.
    }

    /// Legacy no-op. Remote-tools MCP is now a host baseline; reattaching a
    /// session can perturb OpenCode's shared MCP registry.
    pub(crate) async fn flush_pending_remote_tools_mcp_refresh(&self, runtime_id: &str) {
        let mut agents = self.agents.lock().await;
        if let Some(h) = agents.get_handle_mut(runtime_id) {
            h.remote_tools_mcp_refresh_pending = false;
        }
    }

    /// Legacy no-op. Host-level MCP baseline removes the need to refresh peers
    /// by ACP resume.
    async fn sync_peer_remote_tools_on_worktree(
        &self,
        _worktree: &str,
        _workspace_id: &str,
        _exclude_runtime_id: &str,
        _team_id: &str,
    ) {
    }

    /// Keep remote-tools routing metadata on a live collab runtime while MCP
    /// auto-injection is paused. This does not claim that the runtime has the MCP.
    pub(crate) async fn ensure_live_runtime_remote_tools(
        &self,
        runtime_id: &str,
        session_id: &str,
        requester_actor_id: &str,
        team_id: &str,
    ) {
        if session_id.is_empty() || requester_actor_id.is_empty() {
            return;
        }

        self.bind_remote_tool_member(runtime_id, session_id, requester_actor_id, team_id)
            .await;
    }

    /// Spawns a Claude Code subprocess and publishes lifecycle state
    /// transitions on the retained runtime state topic. Shared by legacy
    /// AcpCommand::StartAgent and RPC RuntimeStart handlers.
    ///
    /// Lifecycle publishes:
    ///   - STARTING (stage "spawning_process") published retained right after
    ///     start_runtime returns the new runtime_id, before StoredSession upsert.
    ///   - ACTIVE published retained via publish_runtime_state_by_id after
    ///     StoredSession upsert (that call reads the now-populated RuntimeHandle).
    ///   - No FAILED publish here — start_runtime error path returns before any
    ///     runtime_id is allocated, so there is no retained topic to write to.
    ///     Callers may surface the error via their wire envelope.
    ///
    /// Load a collab session + participants from the backend, cache them in
    /// the teamclu session manager, and subscribe to `session/{sid}/live`.
    /// Idempotent — safe on every RuntimeStart, including dedup reuse.
    pub(crate) async fn ensure_collab_session_registered(
        &mut self,
        session_id: &str,
    ) -> Result<(), StartRuntimeError> {
        if session_id.is_empty() {
            return Ok(());
        }
        match self
            .backend
            .fetch_session_with_participants(session_id)
            .await
        {
            Ok(snap) => {
                if let Some(tc) = self.teamclu.as_mut() {
                    if let Err(e) = tc
                        .insert_session_from_backend(&snap.session, &snap.participants)
                        .await
                    {
                        return Err(StartRuntimeError {
                            error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                            error_message: format!("insert_session_from_backend failed: {}", e),
                            failed_stage: "session_subscribe".to_string(),
                        });
                    }
                } else {
                    return Err(StartRuntimeError {
                        error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                        error_message:
                            "teamclu session manager is not available for session runtime"
                                .to_string(),
                        failed_stage: "session_subscribe".to_string(),
                    });
                }
            }
            Err(e) => {
                return Err(StartRuntimeError {
                    error_code: "SESSION_LOOKUP_FAILED".to_string(),
                    error_message: format!("fetch_session_with_participants failed: {}", e),
                    failed_stage: "session_lookup".to_string(),
                });
            }
        }
        Ok(())
    }

    pub(crate) async fn apply_start_runtime(
        &mut self,
        agent_type: amux::AgentType,
        workspace_id: &str,
        worktree: &str,
        session_id: &str,
        initial_prompt: &str,
        initial_model_override: Option<String>,
        requester_actor_id: &str,
        reset_backend_binding: bool,
        fork_from: Option<(String, String)>,
    ) -> Result<StartRuntimeOutcome, StartRuntimeError> {
        info!(workspace_id, worktree, session_id, "apply_start_runtime");

        let team_id = self.config.team_id.clone().unwrap_or_default();
        let wants_remote_mcp = !session_id.is_empty() && !requester_actor_id.is_empty();

        // Resolve workspace + worktree via the cloud-backed WorkspaceResolver.
        // The cloud UUID (`workspace_id`) IS the workspace id now — there is
        // no separate local/remote id split.
        let (mut resolved_worktree, mut ws_id): (String, String) = if !workspace_id.is_empty() {
            match self.workspace_resolver.resolve(workspace_id).await {
                // A workspace row can exist with no path — an app's 1:1
                // workspace is created by the cloud API, which never sees a
                // local path. Falling through to the client's worktree beats
                // handing env setup an empty directory.
                Ok(ws) if ws.path.trim().is_empty() && !worktree.is_empty() => {
                    (worktree.to_string(), workspace_id.to_string())
                }
                Ok(ws) => (ws.path, workspace_id.to_string()),
                Err(_) if !worktree.is_empty() => {
                    // Intentional (cloud-source-of-truth design): resolve()
                    // failing here almost always means the cloud is
                    // unreachable (offline), not that the workspace doesn't
                    // exist. The client-supplied `workspace_id` is still a
                    // real cloud UUID we simply can't confirm right now, so
                    // we deliberately keep stamping it into `ws_id` (which
                    // flows into `agent_runtimes.workspace_id`) rather than
                    // clearing it. This preserves the workspace association;
                    // the row self-corrects once the cloud becomes reachable
                    // and a subsequent resolve() succeeds. Not a bug.
                    (worktree.to_string(), workspace_id.to_string())
                }
                Err(e) => {
                    return Err(StartRuntimeError {
                        error_code: "WORKSPACE_NOT_FOUND".to_string(),
                        error_message: format!("resolve {workspace_id}: {e:?}"),
                        failed_stage: "validation".to_string(),
                    });
                }
            }
        } else {
            // Bare-agent spawn: empty workspace_id. Use worktree if provided,
            // else the onboarded team's default worktree
            // (`~/.amuxd/teams/<id>/workspace`), falling back to "." only when
            // not onboarded. Production daemons run with cwd `/` (read-only, set
            // by the desktop app), so a "." worktree fails env setup with a
            // read-only-filesystem error — this drove the offline-session
            // auto-restart into a permanent failure loop.
            let wt = if !worktree.is_empty() {
                worktree.to_string()
            } else {
                crate::config::global_team_store::onboarded_default_workspace_dir()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|| ".".to_string())
            };
            (wt, String::new())
        };

        // Fallback: when ws_id stayed empty (bare-agent spawn), try to
        // reverse-resolve resolved_worktree against the resolver's cache so
        // the runtime row, persisted session, and downstream agent_runtimes
        // upsert all carry the right workspace_id instead of stomping it
        // null on idle transitions.
        // Note: `id_for_path` only consults the resolver's in-memory,
        // lazily-populated cache — it does not itself hit the cloud. This is
        // the intended end-state under the cloud-source-of-truth design (no
        // local workspace store persists the path->id mapping anymore), but
        // it means that immediately after a daemon restart, with a cold
        // cache, a bare spawn may fail to backfill `ws_id` here. That's
        // acceptable: downstream tolerates an empty `ws_id`, and the mapping
        // self-heals as soon as any `resolve()` call runs and populates the
        // cache.
        if ws_id.is_empty() {
            if let Some(id) = self
                .workspace_resolver
                .id_for_path(&resolved_worktree)
                .await
            {
                ws_id = id;
            }
        }

        // RuntimeStart's worktree is the directory OpenCode actually uses and
        // therefore the authoritative target for cache invalidation.
        if let Some(registry) = self.refresh_watch_registry.as_ref() {
            let refresh_workspace_id = if ws_id.is_empty() {
                crate::runtime::refresh::refresh_watch::workspace_runtime_id(Path::new(
                    &resolved_worktree,
                ))
            } else {
                ws_id.clone()
            };
            registry
                .upsert_workspace(crate::runtime::refresh::refresh_watch::WatchedWorkspace {
                    workspace_id: refresh_workspace_id,
                    workspace_path: PathBuf::from(&resolved_worktree),
                })
                .await;
        }

        // Invariant: a conversation has at most one live runtime *on this
        // daemon*. The daemon is a single actor/participant in the session, so
        // it must answer an @mention exactly once. Historically each desktop
        // session-start / model-switch / workspace-change spawned a fresh
        // runtime_id keyed by (session_id, agent_type, workspace_id); several
        // could end up live at the same time (e.g. one resumed-on-restart in
        // workspace A plus one freshly started in workspace B) and *each* then
        // replied to the same prompt — the duplicate-reply bug.
        //
        // Collapse to one: among this session's live runtimes, reuse the one
        // that exactly matches the requested (agent_type, workspace_id) and
        // supersede (stop) every other one so the latest client intent wins
        // and only a single runtime remains to answer. Also protects against
        // misbehaving clients that fire RuntimeStart twice (picker + inline
        // mention race on the desktop client pre-4210aad8).
        // One runtime is spared that collapse: whichever is mid-turn. Cron's
        // "Run Now" navigates the desktop straight into the run's session, and
        // the RuntimeStart that follows arrives while the cron runtime is still
        // answering — in a different workspace, so it never matches the reuse
        // key. Superseding it there stopped the runtime mid-answer, and the run
        // ended as a prompt with no reply. A busy runtime is left running to
        // finish; it is not routed to (it is not `reuse`), and the next
        // routing-time `coalesce_session_runtimes` reaps it once it is idle.
        let (existing_runtime, superseded, in_flight): (Option<String>, Vec<String>, Vec<String>) =
            if session_id.is_empty() {
                (None, Vec::new(), Vec::new())
            } else {
                let agents = self.agents.lock().await;
                let mut reuse: Option<String> = None;
                let mut stale: Vec<String> = Vec::new();
                let mut busy: Vec<String> = Vec::new();
                for rid in agents.runtime_ids_for_session(session_id) {
                    match agents.get_handle(&rid) {
                        Some(h)
                            if reuse.is_none()
                                && h.agent_type == agent_type
                                && same_runtime_workspace(
                                    &h.worktree,
                                    &h.workspace_id,
                                    &resolved_worktree,
                                    &ws_id,
                                ) =>
                        {
                            reuse = Some(rid);
                        }
                        _ if agents.turn_in_flight(&rid) => busy.push(rid),
                        _ => stale.push(rid),
                    }
                }
                (reuse, stale, busy)
            };

        if !in_flight.is_empty() {
            info!(
                session_id,
                in_flight = ?in_flight,
                "apply_start_runtime: left mid-turn runtimes running rather than superseding them"
            );
        }

        if !superseded.is_empty() {
            for rid in &superseded {
                self.agents.lock().await.stop_runtime(rid).await;
                self.remote_tool_turn_contexts
                    .lock()
                    .await
                    .clear_runtime(rid);
            }
            info!(
                session_id,
                superseded = ?superseded,
                "apply_start_runtime: superseded stale runtimes for session (one live runtime per session)"
            );
        }

        if let Some(existing) = existing_runtime {
            let (existing_acp_session_id, existing_worktree, existing_remote_member) = {
                let agents = self.agents.lock().await;
                agents
                    .get_handle(&existing)
                    .map(|h| {
                        (
                            h.acp_session_id.clone(),
                            h.worktree.clone(),
                            h.remote_tool_member_id.clone(),
                        )
                    })
                    .unwrap_or_default()
            };
            info!(
                session_id,
                workspace_id = %ws_id,
                runtime_id = %existing,
                acp_session_id = %existing_acp_session_id,
                handle_worktree = %existing_worktree,
                remote_tool_member_id = %existing_remote_member,
                wants_remote_mcp,
                "apply_start_runtime: dedup hit; reusing existing runtime"
            );
            // TODO(perf-runtime-start-throttle): See the same id on the client
            // (`ensureAgentRuntimesForSession` in packages/app). Dedup still runs
            // ensure_collab_session_registered, refresh_membership MQTT, reconcile
            // (full `messages_after_cursor`), and catchup — costly on large sessions.
            // Do NOT implement unless the user explicitly asks — ignore routinely.
            // 无用户明确指令时不要实现本 TODO，日常开发请忽略。
            // Still register the session + subscribe to session/live. The
            // spawn path does this before returning; skipping it on dedup left
            // runtimes that were reused without a live subscription, so
            // @-mention prompts published to MQTT never reached send_prompt.
            self.ensure_collab_session_registered(session_id).await?;
            if let Some(desired_model) = initial_model_override
                .as_deref()
                .map(str::trim)
                .filter(|model| !model.is_empty())
            {
                let current = self
                    .agents
                    .lock()
                    .await
                    .current_model(&existing)
                    .cloned()
                    .unwrap_or_default();
                // Only seed a model when the runtime has none. Ensure calls
                // fire repeatedly (session focus, MQTT reconnect) with
                // whatever model the caller last knew, so treating the
                // override as "desired" here silently reverts a pick the
                // user made via SetModel in between.
                if current.is_empty() && desired_model != current {
                    let mut agents = self.agents.lock().await;
                    match agents.send_set_model(&existing, desired_model).await {
                        Ok(()) => {
                            agents.set_current_model(&existing, desired_model);
                        }
                        Err(e) => {
                            warn!(
                                runtime_id = %existing,
                                session_id,
                                model_id = %desired_model,
                                err = %e,
                                "apply_start_runtime: dedup reuse send_set_model failed"
                            );
                        }
                    }
                }
            }
            if wants_remote_mcp {
                self.ensure_live_runtime_remote_tools(
                    &existing,
                    session_id,
                    requester_actor_id,
                    &team_id,
                )
                .await;
            }
            if !initial_prompt.trim().is_empty() {
                self.prepare_remote_tool_context_for_turn(
                    &existing,
                    session_id,
                    requester_actor_id,
                )
                .await;
                if let Err(e) = self
                    .agents
                    .lock()
                    .await
                    .send_prompt(&existing, initial_prompt, vec![])
                    .await
                {
                    warn!(
                        runtime_id = %existing,
                        session_id,
                        err = %e,
                        "apply_start_runtime: dedup reuse send_prompt failed"
                    );
                } else {
                    info!(
                        runtime_id = %existing,
                        session_id,
                        "apply_start_runtime: dedup reuse delivered initial_prompt"
                    );
                }
            }
            // Re-publish retained RuntimeInfo so clients that missed the
            // original retain (late subscribe, reconnect) still populate the
            // model picker without spawning a duplicate process.
            let _ = self.publish_actor_state().await;
            if !session_id.is_empty() {
                if let Some(tc) = self.teamclu.as_mut() {
                    if let Err(e) = tc.ensure_session_live_subscription(session_id).await {
                        warn!(
                            session_id,
                            err = %e,
                            "apply_start_runtime: ensure_session_live_subscription failed (dedup)"
                        );
                    }
                }
            }
            // Live MQTT can miss messages that landed in the backend after the
            // initial attach catchup (e.g. client dedup runtimeStart on send).
            // Replay from the cursor so @-mentioned rows still reach send_prompt.
            self.catchup_runtime(&existing).await;
            return Ok(StartRuntimeOutcome {
                runtime_id: existing,
                session_id: session_id.to_string(),
            });
        }

        // If iOS handed us a cloud session_id, pull the row + participants
        // so we (a) populate the teamclu cache that `agents_to_activate`
        // reads, and (b) subscribe to `session/{sid}/live` so inbound
        // `message.created` events from iOS actually reach us.
        // iOS creates these sessions directly in the cloud backend, so this is the
        // only place the daemon learns about them.
        if !session_id.is_empty() {
            match self
                .backend
                .fetch_session_with_participants(session_id)
                .await
            {
                Ok(mut snap) => {
                    if !snap
                        .participants
                        .iter()
                        .any(|p| p.actor_id == self.actor_id)
                    {
                        snap.participants
                            .push(crate::backend::BackendParticipantRow {
                                session_id: session_id.to_string(),
                                actor_id: self.actor_id.clone(),
                                role: Some("agent".to_string()),
                                joined_at: chrono::Utc::now(),
                            });
                    }
                    if let Some(tc) = self.teamclu.as_mut() {
                        if let Err(e) = tc
                            .insert_session_from_backend(&snap.session, &snap.participants)
                            .await
                        {
                            return Err(StartRuntimeError {
                                error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                                error_message: format!("insert_session_from_backend failed: {}", e),
                                failed_stage: "session_subscribe".to_string(),
                            });
                        }
                        if let Err(e) = tc.ensure_session_live_subscription(session_id).await {
                            warn!(
                                session_id,
                                err = %e,
                                "apply_start_runtime: ensure_session_live_subscription failed"
                            );
                        }
                    } else {
                        return Err(StartRuntimeError {
                            error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                            error_message:
                                "teamclu session manager is not available for session runtime"
                                    .to_string(),
                            failed_stage: "session_subscribe".to_string(),
                        });
                    }
                }
                Err(e) => {
                    return Err(StartRuntimeError {
                        error_code: "SESSION_LOOKUP_FAILED".to_string(),
                        error_message: format!("fetch_session_with_participants failed: {}", e),
                        failed_stage: "session_lookup".to_string(),
                    });
                }
            }
        }

        if !session_id.is_empty() && !ws_id.is_empty() {
            if reset_backend_binding {
                self.sessions.delete(session_id, &ws_id, agent_type as i32);
                let _ = self.sessions.save(&self.sessions_path);
            } else if self
                .sessions
                .lookup(session_id, &ws_id, agent_type as i32)
                .is_some()
            {
                if let Some(outcome) = self
                    .try_resume_runtime_for_start(
                        session_id,
                        agent_type,
                        &ws_id,
                        initial_prompt,
                        initial_model_override.as_deref(),
                        requester_actor_id,
                    )
                    .await?
                {
                    return Ok(outcome);
                }
            }
        }

        let mut resume_acp_session_id: Option<String> = None;

        let workspace_team_id = self.resolve_workspace_team_id(&ws_id).await;

        if let Some(ref team_id) = workspace_team_id {
            crate::team_link::materialize_team_link(team_id, &resolved_worktree);
        }

        // Refresh-watch suppression remains inside execution-context assembly,
        // after the managed-LLM lookup has completed.
        let context = self
            .assemble_execution_context(&resolved_worktree, None, Some(&ws_id), false, None)
            .await
            .map_err(|e| StartRuntimeError {
                error_code: "ENV_ASSEMBLE_FAILED".to_string(),
                error_message: format!("assemble_runtime_env failed: {e}"),
                failed_stage: "env_setup".to_string(),
            })?;

        if let Some((parent_session_id, root_message_id)) = fork_from {
            // Lazy fork runs only when runtimes.toml has no binding for this thread.
            // Normal path: first start forks; later starts resume via try_resume above.
            //
            // Risk (accepted): if a binding row exists but try_resume returned None
            // (soft failure — workspace resolve, etc.), needs_fork stays false and
            // spawn may attach a blank backend instead of re-forking. Rare; same class
            // as main-session fall-through. Recovery: client resetBackendBinding + forkFrom.
            let needs_fork = !session_id.is_empty()
                && !ws_id.is_empty()
                && self
                    .sessions
                    .lookup(session_id, &ws_id, agent_type as i32)
                    .is_none();
            if needs_fork
                && matches!(
                    agent_type,
                    amux::AgentType::Pi | amux::AgentType::Opencode
                )
            {
                let forked = {
                    let agents = self.agents.lock().await;
                    let backend_handle = agents.agent_backend_handle();
                    let mut agent_backend = backend_handle.lock().await;
                    crate::daemon::thread_runtime::fork_thread_binding(
                        &self.sessions,
                        &self.backend,
                        agent_backend.as_mut(),
                        &context,
                        &crate::daemon::thread_runtime::ThreadForkParams {
                            thread_session_id: session_id.to_string(),
                            parent_session_id,
                            root_message_id,
                            workspace_id: ws_id.clone(),
                            worktree: resolved_worktree.clone(),
                            agent_type,
                        },
                    )
                    .await?
                };
                resume_acp_session_id = Some(forked.clone());
                self.upsert_session_binding(session_id, &ws_id, agent_type, &forked);
            }
        }

        let forbid_new_session_fallback = resume_acp_session_id.is_some();

        // Do not write / pass `remote-tools-host.json` — auto-inject of
        // `amuxd-remote-tools` is paused. Re-enable via write_remote_tools_mcp_config.
        let mcp_config_path = None;
        let should_bind_remote_target = !session_id.is_empty() && !requester_actor_id.is_empty();

        if let Some(supervisor) = self.runtime_supervisor.as_ref() {
            supervisor
                .require_skills_refresh_for_attach(&ws_id, std::path::Path::new(&resolved_worktree))
                .await
                .map_err(|error| StartRuntimeError {
                    error_code: match &error {
                        crate::config::workspace_control::WorkspaceControlError::ActiveTurn(_) => {
                            "WORKSPACE_BUSY".to_string()
                        }
                        _ => "SKILLS_REFRESH_FAILED".to_string(),
                    },
                    error_message: error.to_string(),
                    failed_stage: "skills_refresh".to_string(),
                })?;
        }

        // Spawn.
        let spawn_res = self
            .agents
            .lock()
            .await
            .start_runtime_with_model(
                agent_type,
                "",
                &ws_id,
                (!ws_id.is_empty()).then_some(ws_id.as_str()),
                session_id,
                initial_model_override,
                mcp_config_path,
                resume_acp_session_id,
                forbid_new_session_fallback,
                context,
            )
            .await;
        let new_id = match spawn_res {
            Ok(id) => id,
            Err(e) => {
                error!("start_runtime failed: {}", e);
                // We never allocated a retained topic (start_runtime failed before
                // returning an id), so there's no retain to publish FAILED to.
                // The caller formats the error into its wire envelope; no state
                // topic is involved.
                return Err(StartRuntimeError {
                    error_code: "SPAWN_FAILED".to_string(),
                    error_message: format!("start_runtime failed: {}", e),
                    failed_stage: "spawning_process".to_string(),
                });
            }
        };

        // Belt-and-suspenders: env snapshot usually stamps owner_actor_id, but
        // gateway / bare spawns may omit it. Command resolve keys on this field.
        {
            let mut agents = self.agents.lock().await;
            if let Some(h) = agents.get_handle_mut(&new_id) {
                if h.owner_actor_id.is_empty() {
                    h.owner_actor_id = self.actor_id.clone();
                }
            }
        }

        if !session_id.is_empty() {
            // Phase 2: daemon-managed runtimes resolve session context via the
            // runtime context registry; do not stamp ambient worktree state.
            tracing::debug!(
                session_id,
                worktree = %resolved_worktree,
                "apply_start_runtime: session context registry owns active session binding"
            );
        }

        if should_bind_remote_target {
            self.bind_remote_tool_member(&new_id, session_id, requester_actor_id, &team_id)
                .await;
        }

        if !initial_prompt.trim().is_empty() {
            self.prepare_remote_tool_context_for_turn(&new_id, session_id, requester_actor_id)
                .await;
            if let Err(e) = self
                .agents
                .lock()
                .await
                .send_prompt(&new_id, initial_prompt, vec![])
                .await
            {
                warn!(
                    runtime_id = %new_id,
                    session_id,
                    err = %e,
                    "apply_start_runtime: initial_prompt send_prompt failed"
                );
            }
        }

        {
            let mut agents = self.agents.lock().await;
            if let Err(e) = apply_workspace_system_instructions(
                &mut agents,
                &new_id,
                Path::new(&resolved_worktree),
                agent_type,
            ) {
                warn!(
                    runtime_id = %new_id,
                    session_id,
                    err = %e,
                    "apply_start_runtime: workspace system instructions failed"
                );
            }
        }

        // Persist session + transition to ACTIVE.
        let acp_sid = self
            .agents
            .lock()
            .await
            .get_handle(&new_id)
            .map(|h| h.acp_session_id.clone())
            .unwrap_or_default();
        if !session_id.is_empty() && !acp_sid.is_empty() {
            self.upsert_session_binding(session_id, &ws_id, agent_type, &acp_sid);
        }

        // ACTIVE — refresh the actor snapshot so clients see the attachment.
        let _ = self.publish_actor_state().await;

        // Replay any messages the runtime missed before it was spawned.
        // Uses Option B (event loop hook is not needed here because
        // apply_start_runtime already has `&mut self` access and runs
        // synchronously after start_runtime returns). This is the cleanest
        // insertion point — the handle is fully populated (session_id)
        // and state is ACTIVE.
        self.catchup_runtime(&new_id).await;

        if should_bind_remote_target {
            self.sync_peer_remote_tools_on_worktree(&resolved_worktree, &ws_id, &new_id, &team_id)
                .await;
        }

        Ok(StartRuntimeOutcome {
            runtime_id: new_id,
            session_id: session_id.to_string(),
        })
    }

    pub(crate) async fn handle_stop_runtime(
        &mut self,
        request: &crate::proto::teamclu::RpcRequest,
        stop: &crate::proto::teamclu::RuntimeStopRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_response, RpcResponse, RuntimeStopResult};

        let addressed = stop.runtime_id.clone();
        if addressed.is_empty() {
            return reject_stop(request, "runtime_id required");
        }

        // The address may be a spawn key, a cloud session id, or the
        // `{actor}::{session}` composite (ADR-0004). Resolve before touching
        // the handle — `agents` is still keyed by the per-spawn id, which no
        // topic broadcasts any more, so clients cannot address by it.
        //
        // Use this daemon's actor id, not `request.requester_actor_id` (the
        // signed-in member). The RPC is already routed to `amux/{team}/{actor}/rpc/req`
        // for this agent; owner checks must match the attachment's owner.
        let resolve_actor = self.actor_id.as_str();
        let resolved = {
            let agents = self.agents.lock().await;
            agents.resolve_command_agent_id(&addressed, resolve_actor)
        };
        let Some(runtime_id) = resolved else {
            return reject_stop(request, &format!("unknown runtime address: {}", addressed));
        };
        if runtime_id != addressed {
            info!(
                %addressed,
                %runtime_id,
                "resolved runtime stop address to spawn key"
            );
        }

        // Terminate via RuntimeManager (same path as AcpCommand::StopAgent).
        let stopped_handle = self.agents.lock().await.stop_runtime(&runtime_id).await;
        if stopped_handle.is_none() {
            return reject_stop(
                request,
                &format!("stop failed for runtime_id: {}", runtime_id),
            );
        }

        self.remote_tool_turn_contexts
            .lock()
            .await
            .clear_runtime(&runtime_id);

        if stop.purge_binding {
            let cloud_session_id = runtime_id.clone();
            if !stop.workspace_id.trim().is_empty() {
                let agent_type = stopped_handle.unwrap().agent_type as i32;
                self.sessions
                    .delete(&cloud_session_id, stop.workspace_id.trim(), agent_type);
            } else {
                self.sessions.delete_for_session(&cloud_session_id);
            }
            let _ = self.sessions.save(&self.sessions_path);
        }

        self.publish_runtime_detached(&runtime_id).await;

        RpcResponse {
            request_id: request.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::RuntimeStopResult(RuntimeStopResult {
                accepted: true,
                rejected_reason: String::new(),
            })),
        }
    }

    /// Detach: refresh MQTT actor snapshot only — bindings stay in runtimes.toml.
    pub(crate) async fn publish_runtime_detached(&mut self, _runtime_id: &str) {
        let _ = self.publish_actor_state().await;
    }

    #[allow(dead_code)]
    pub(crate) async fn publish_runtime_stopped(&mut self, runtime_id: &str) {
        self.publish_runtime_detached(runtime_id).await;
    }

    pub(crate) async fn handle_start_runtime(
        &mut self,
        request: &crate::proto::teamclu::RpcRequest,
        start: &crate::proto::teamclu::RuntimeStartRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_response, RpcResponse, RuntimeStartResult};

        let requested =
            amux::AgentType::try_from(start.agent_type).unwrap_or(amux::AgentType::ClaudeCode);
        let at = resolve_requested_agent_type(&self.config, requested);
        if at != requested {
            info!(requested = ?requested, resolved = ?at, "runtimeStart agent_type overridden by daemon config");
        }

        let initial_model_override = runtime_start_initial_model_override(start);

        let fork_from = start.fork_from.as_ref().and_then(|f| {
            let parent = f.parent_session_id.trim();
            let root = f.root_message_id.trim();
            if parent.is_empty() || root.is_empty() {
                None
            } else {
                Some((parent.to_string(), root.to_string()))
            }
        });

        let outcome = self
            .apply_start_runtime(
                at,
                &start.workspace_id,
                &start.worktree,
                &start.session_id,
                &start.initial_prompt,
                initial_model_override.clone(),
                &request.requester_actor_id,
                start.reset_backend_binding,
                fork_from.clone(),
            )
            .await;

        // User-facing only: one idle-attachment eviction then a single retry.
        // Auto-recovery calls `apply_start_runtime` directly and must not
        // steal a host slot from a session the user still has open.
        let outcome = match outcome {
            Err(err) if err.error_message.contains("host_capacity_timeout") => {
                let evicted = self
                    .agents
                    .lock()
                    .await
                    .evict_one_idle_attachment_for_capacity(&start.session_id)
                    .await;
                match evicted {
                    Some(runtime_id) => {
                        info!(
                            session_id = %start.session_id,
                            evicted_runtime_id = %runtime_id,
                            "runtimeStart: evicted idle attachment after host_capacity_timeout; retrying once"
                        );
                        self.apply_start_runtime(
                            at,
                            &start.workspace_id,
                            &start.worktree,
                            &start.session_id,
                            &start.initial_prompt,
                            initial_model_override,
                            &request.requester_actor_id,
                            start.reset_backend_binding,
                            fork_from,
                        )
                        .await
                    }
                    None => Err(err),
                }
            }
            other => other,
        };

        match outcome {
            Ok(res) => RpcResponse {
                request_id: request.request_id.clone(),
                success: true,
                error: String::new(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: Some(rpc_response::Result::RuntimeStartResult(
                    RuntimeStartResult {
                        accepted: true,
                        runtime_id: res.runtime_id,
                        session_id: res.session_id,
                        rejected_reason: String::new(),
                        error_code: String::new(),
                    },
                )),
            },
            Err(err) => RpcResponse {
                request_id: request.request_id.clone(),
                success: false,
                error: err.error_message.clone(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: Some(rpc_response::Result::RuntimeStartResult(
                    RuntimeStartResult {
                        accepted: false,
                        runtime_id: String::new(),
                        session_id: String::new(),
                        rejected_reason: err.error_message,
                        error_code: err.error_code,
                    },
                )),
            },
        }
    }

    /// Forward a SetModel request to the matching runtime via ACP. On success
    /// the daemon's `current_model_per_agent` is bumped synchronously inside
    /// `RuntimeManager::set_model`, so we re-publish the runtime's retained
    /// state to fan the new `current_model` out to every subscriber.
    pub(crate) async fn handle_set_model(
        &mut self,
        request: &crate::proto::teamclu::RpcRequest,
        set: &crate::proto::teamclu::SetModelRequest,
    ) -> crate::proto::teamclu::RpcResponse {
        use crate::proto::teamclu::{rpc_response, RpcResponse, SetModelResult};

        let addressed = set.runtime_id.clone();
        let model_id = set.model_id.clone();
        if addressed.is_empty() {
            return reject_set_model(request, "runtime_id required");
        }
        if model_id.is_empty() {
            return reject_set_model(request, "model_id required");
        }

        // Same addressing contract as stop/cancel: spawn key, cloud session
        // id, or `{actor}::{session}` composite (ADR-0004). Without this the
        // raw map lookup in `send_set_model` fails for every client, because
        // the per-spawn key is no longer published anywhere.
        //
        // Match `handle_runtime_command_rpc`: resolve as this daemon's agent,
        // not the human member in `request.requester_actor_id`.
        let resolve_actor = self.actor_id.as_str();
        let resolved = {
            let agents = self.agents.lock().await;
            agents.resolve_command_agent_id(&addressed, resolve_actor)
        };
        let Some(runtime_id) = resolved else {
            return reject_set_model(request, &format!("unknown runtime address: {}", addressed));
        };
        if runtime_id != addressed {
            info!(
                %addressed,
                %runtime_id,
                "resolved set-model address to spawn key"
            );
        }

        let result = self
            .agents
            .lock()
            .await
            .set_model(&runtime_id, &model_id)
            .await;
        let (success, error) = match result {
            Ok(()) => (true, String::new()),
            Err(e) => (false, e.to_string()),
        };

        // On success, fan the new current_model out via the retained state
        // topics so subscribers see the change immediately. The mirror into
        // `agent_runtimes.current_model` this used to do is gone: the model
        // lives on the participant row and the actor snapshot (ADR-0004/0005).
        if success {
            let _ = self.publish_actor_state().await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::SetModelResult(SetModelResult {
                success,
                error,
            })),
        }
    }
}

#[cfg(test)]
mod workspace_binding_tests {
    use super::same_runtime_workspace;

    #[test]
    fn local_fast_path_and_canonical_workspace_id_share_one_runtime() {
        assert!(same_runtime_workspace(
            "/Users/test/project",
            "",
            "/Users/test/project",
            "workspace-1",
        ));
        assert!(same_runtime_workspace(
            "/Users/test/project",
            "workspace-1",
            "/Users/test/project",
            "",
        ));
    }

    #[test]
    fn different_known_workspace_ids_remain_distinct() {
        assert!(!same_runtime_workspace(
            "/Users/test/project",
            "workspace-1",
            "/Users/test/project",
            "workspace-2",
        ));
    }
}
