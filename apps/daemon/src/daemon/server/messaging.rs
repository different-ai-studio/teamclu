//! Extracted from `server.rs` — methods of `DaemonServer` grouped by concern.
//! See `server.rs` for the struct definition and core lifecycle.

use super::*;
use crate::runtime::acp_event_frame::AcpEventFrame;
use teamclu_transport::PublisherError;

/// One-way latency probe (dev-only). When the daemon is started with
/// AMUX_LATENCY_PROBE=1, outgoing ACP envelopes carry a `probe:<ms>` marker in
/// the otherwise-unused `source_peer_id` field; the desktop webview computes
/// `Date.now() - ms` on receipt (same machine → same clock).
fn latency_probe_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED
        .get_or_init(|| std::env::var("AMUX_LATENCY_PROBE").is_ok_and(|v| v == "1" || v == "true"))
}

impl DaemonServer {
    /// Build merged agent list: active agents + historical (non-active) sessions.
    /// Now only used by `publish_all_agent_states` to iterate startup/reconnect state.
    /// Per-agent updates should go through `publish_runtime_state_by_id`.
    pub(crate) async fn merged_agent_list(&self) -> amux::AgentList {
        let agents = self.agents.lock().await;
        agents.to_proto_agent_list()
    }

    /// Publish the actor snapshot after attachment changes. Per-spawn
    /// `runtime/{id}/state` retains are no longer published — clients read
    /// `{actor}/state` only (ADR-0004 phase 7, iOS out of scope).
    pub(crate) async fn publish_runtime_state_by_id(&self, _agent_id: &str) {
        let _ = self.publish_actor_state().await;
    }

    /// Re-publish the actor snapshot on startup / MQTT reconnect.
    pub(crate) async fn publish_all_agent_states(&self) {
        let _ = self.publish_actor_state().await;
    }

    /// Publish the whole actor snapshot on the one retained topic this actor
    /// already owns: presence, active backend, its catalogs, and the sessions
    /// currently attached.
    ///
    /// This is the replacement for the per-spawn `runtime/{id}/state` fan-out.
    /// That fan-out could not be bounded — `runtime_id` is minted fresh on every
    /// spawn and the clear only runs on the idle-eviction path — whereas this is
    /// one message per actor with every field bounded (ADR-0004).
    ///
    /// Gateway and cron attachments are covered for free: they never reach
    /// `apply_start_runtime` (which is why they never got a spawn-time retain),
    /// but they do live in `RuntimeManager.agents`, so they appear here as soon
    /// as this fires on attach.
    pub(crate) async fn publish_actor_state(&self) -> Result<(), PublisherError> {
        let (default_workspace_id, default_worktree) =
            self.resolve_default_workspace_for_publish().await;

        let default_workspace_models = if default_worktree.is_empty() {
            Vec::new()
        } else {
            match self
                .assemble_execution_context(
                    &default_worktree,
                    Some(&default_worktree),
                    Some(&default_workspace_id),
                    false,
                    None,
                )
                .await
            {
                Ok(context) => {
                    RuntimeManager::probe_default_workspace_catalog(
                        Arc::clone(&self.agents),
                        context,
                    )
                    .await
                }
                Err(error) => {
                    tracing::warn!(
                        workspace_id = %default_workspace_id,
                        workspace = %default_worktree,
                        %error,
                        "default workspace catalog context resolution failed"
                    );
                    Vec::new()
                }
            }
        };

        let (active_agent_type, catalog_models, live_sessions, actor_available_commands) = {
            let agents = self.agents.lock().await;
            (
                agents.default_agent_type() as i32,
                agents.catalog_models(),
                agents.live_sessions(),
                agents.actor_available_commands(),
            )
        };

        let state = amux::ActorPresence {
            online: true,
            display_name: self.config.actor.name.clone(),
            timestamp: chrono::Utc::now().timestamp(),
            active_agent_type,
            // The host is reachable by construction here: we only publish from
            // inside a running daemon that just serviced an attach or detach.
            // STARTING/FAILED are wired where the supervisor learns them.
            backend_health: amux::AgentHostHealth::Ready as i32,
            // The CATALOG stays. It is this actor's capability, and for a
            // remote client it is the only source there is — iOS has no
            // loopback fallback at all, so an empty list here means "no models
            // to pick from", which is the #742 bug. ADR-0007 retires the
            // *preference* fields below, never this one.
            catalog_models,
            // Retired (ADR-0007). `worktrees` carried a per-directory catalog +
            // default that #742 disproved; `default_model` was the daemon's MRU
            // head. Both fields stay in the proto so an older client still
            // parses the message — they are simply no longer filled, and every
            // client on or past the P3 release resolves the model itself.
            worktrees: Vec::new(),
            live_sessions,
            default_workspace_id,
            default_worktree,
            default_workspace_models,
            default_model: String::new(),
            available_commands: actor_available_commands,
        };

        let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
        publisher.publish_actor_presence(&state).await
    }

    /// Returns the single collab session_id this runtime should publish
    /// ACP events to. Each runtime is bound at spawn time to one session
    /// via `RuntimeHandle.session_id` (set from
    /// `apply_start_runtime`'s remote_session_id), so fanout has to be
    /// scoped to that one session.
    ///
    /// Earlier versions of this function unioned in
    /// `teamclu.sessions_for_agent(daemon_actor_id)` — the set of
    /// sessions where the daemon (as agent participant) lives. That set
    /// is "all collab sessions this daemon serves," not "the session
    /// this turn belongs to," so every agent event got fanned out to
    /// every session — bug observed 2026-04-27 where one user message
    /// in session A produced agent reply copies in 8 unrelated sessions
    /// (and 9× the broker traffic on every turn). The runtime's own
    /// `session_id` is the only correct destination.
    ///
    /// Returns an empty vec for ambient/bare-agent spawns where
    /// `session_id` was never set; callers fall back to the
    /// legacy per-runtime events topic in that case.
    ///
    /// Gateway-spawned runtimes never reach `apply_start_runtime` and
    /// therefore have no entry in the local SessionStore. They carry the
    /// cloud session UUID on their in-memory `RuntimeHandle` instead,
    /// so when the persisted lookup misses we fall back to RuntimeManager.
    pub(crate) async fn target_sessions(&self, agent_id: &str) -> Vec<String> {
        // RuntimeManager keys attachments by cloud session id.
        if !agent_id.is_empty() {
            return vec![agent_id.to_string()];
        }
        let live = self
            .agents
            .lock()
            .await
            .get_handle(agent_id)
            .map(|h| h.session_id.clone())
            .unwrap_or_default();
        if live.is_empty() {
            Vec::new()
        } else {
            vec![live]
        }
    }

    /// Adopt an agent-generated session title, but only over a default one.
    /// A user-set title ("人工自己设定") must never be overwritten.
    async fn maybe_adopt_generated_session_title(&mut self, session_id: &str, title: &str) {
        let title = title.trim();
        if session_id.is_empty() || title.is_empty() {
            return;
        }
        let current = self
            .teamclu
            .as_ref()
            .and_then(|tc| tc.sessions.find_by_id(session_id))
            .map(|s| s.title.trim().to_string())
            .unwrap_or_default();
        if current == title || !is_default_session_title(&current) {
            return;
        }
        tracing::info!(
            session_id,
            old_title = %current,
            new_title = %title,
            "adopting opencode-generated session title"
        );
        if let Err(e) = self.backend.update_session_title(session_id, title).await {
            tracing::warn!(session_id, error = %e, "session title update failed");
            return;
        }
        let actor_id = self.backend.actor_id().to_string();
        if let Some(tc) = self.teamclu.as_mut() {
            if let Some(session) = tc.sessions.find_by_id_mut(session_id) {
                session.title = title.to_string();
            }
            tc.publish_session_title(session_id, &actor_id, title).await;
            tracing::info!(session_id, "session title adopted: patched + published");
        }
    }

    pub(crate) async fn forward_agent_event(&mut self, agent_id: &str, frame: AcpEventFrame) {
        let acp_session_id = frame.acp_session_id.clone();
        // Sync turn-scoped reply_to from the prompt worker (bound at dequeue).
        if let Some(reply_to) = frame
            .turn_reply_to_message_id
            .as_deref()
            .filter(|id| !id.is_empty())
        {
            let mut agents = self.agents.lock().await;
            if let Some(handle) = agents.get_handle_mut(agent_id) {
                handle.pending_reply_to_message_id = Some(reply_to.to_string());
            }
        }
        let is_child_event = {
            let agents = self.agents.lock().await;
            agents
                .get_handle(agent_id)
                .map(|h| !acp_session_id.is_empty() && acp_session_id != h.acp_session_id)
                .unwrap_or(false)
        };
        let mut acp_event = frame.event;
        // Stamp the current model on agent-reply events (Output, Thinking) so iOS
        // bubbles can show which model produced the response. Other event types
        // (status changes, tool calls, permission requests, raw control messages)
        // are not model-attributable and stay empty. Safe to read current_model
        // here for the same reason as the collab publish path: the daemon event
        // loop is single-threaded, so no SetModel can interleave between the
        // agent's reply and this lookup.
        if matches!(
            acp_event.event,
            Some(amux::acp_event::Event::Output(_)) | Some(amux::acp_event::Event::Thinking(_))
        ) {
            if let Some(model) = self.agents.lock().await.current_model(agent_id).cloned() {
                acp_event.model = model;
            }
        }

        // Register permission requests for later resolution
        if let Some(amux::acp_event::Event::PermissionRequest(ref pr)) = acp_event.event {
            self.permissions.register_pending(&pr.request_id);
        }

        if let Some(amux::acp_event::Event::Error(ref err)) = acp_event.event {
            let message = if err.message.is_empty() {
                "ACP runtime error".to_string()
            } else {
                err.message.clone()
            };
            let details = if err.details.is_empty() {
                message.clone()
            } else {
                err.details.clone()
            };
            {
                let mut agents = self.agents.lock().await;
                if let Some(handle) = agents.get_handle_mut(agent_id) {
                    handle.status = amux::AgentStatus::Error;
                }
            }
            let _ = self.publish_actor_state().await;
        }

        // Handle internal RawJson events (session_title, tool_title_update)
        if let Some(amux::acp_event::Event::Raw(ref raw)) = acp_event.event {
            if raw.method == "session_title" {
                let title = String::from_utf8_lossy(&raw.json_payload).to_string();
                let session_id = {
                    let mut agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle_mut(agent_id) {
                        handle.session_title = title.clone();
                        Some(handle.session_id.clone())
                    } else {
                        None
                    }
                };
                if let Some(session_id) = session_id {
                    self.publish_runtime_state_by_id(agent_id).await;
                    self.maybe_adopt_generated_session_title(&session_id, &title)
                        .await;
                }
                return;
            }
            if raw.method == "tool_title_update" {
                // Format: "tool_id|new_title"
                let payload = String::from_utf8_lossy(&raw.json_payload);
                if let Some((_tool_id, _new_title)) = payload.split_once('|') {
                    // Forward as a ToolUse event so iOS updates the tool name
                    let update_event = amux::AcpEvent {
                        event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
                            method: "tool_title_update".into(),
                            json_payload: raw.json_payload.clone(),
                        })),
                        model: String::new(),
                    };
                    let (seq, turn_id) = {
                        let mut agents = self.agents.lock().await;
                        let seq = agents
                            .get_handle_mut(agent_id)
                            .map(|h| h.next_sequence())
                            .unwrap_or(0);
                        let turn_id = agents
                            .aggregator(agent_id)
                            .and_then(|a| a.current_turn_id())
                            .unwrap_or("")
                            .to_string();
                        (seq, turn_id)
                    };
                    let envelope = amux::Envelope {
                        runtime_id: agent_id.into(),
                        actor_id: self.config.actor.id.clone(),
                        source_peer_id: String::new(),
                        timestamp: chrono::Utc::now().timestamp(),
                        sequence: seq,
                        turn_id,
                        acp_session_id: if is_child_event {
                            acp_session_id.clone()
                        } else {
                            String::new()
                        },
                        payload: Some(amux::envelope::Payload::AcpEvent(update_event)),
                    };
                    self.history.append(agent_id, &envelope);
                    self.publish_envelope_to_sessions(agent_id, &envelope).await;
                }
                return;
            }
        }

        // Update agent status if this is a status change event
        if let Some(amux::acp_event::Event::StatusChange(ref sc)) = acp_event.event {
            let became_idle = sc.old_status == amux::AgentStatus::Active as i32
                && sc.new_status == amux::AgentStatus::Idle as i32;
            {
                let mut agents = self.agents.lock().await;
                if let Some(handle) = agents.get_handle_mut(agent_id) {
                    handle.status = amux::AgentStatus::try_from(sc.new_status)
                        .unwrap_or(amux::AgentStatus::Unknown);
                }
            }
            self.publish_runtime_state_by_id(agent_id).await;
            if became_idle {
                self.remote_tool_turn_contexts
                    .lock()
                    .await
                    .clear_runtime(agent_id);
                self.flush_pending_remote_tools_mcp_refresh(agent_id).await;
                // No `learn_session_model` here any more. It existed to give a
                // fresh install's device MRU a first entry by asking the backend
                // what an unpinned start had settled on — and ADR-0007 removes
                // both the MRU and unpinned starts, since every entry point now
                // pins a model when it is created.
            }

            // Status transitions used to upsert `agent_runtimes` here. The
            // actor snapshot carries live status now, published off the manager
            // whenever `agents` changes (ADR-0004), so there is nothing to
            // mirror into a second store.
        }

        // Update session on tool use
        if let Some(amux::acp_event::Event::ToolUse(_)) = acp_event.event {
            let mut agents = self.agents.lock().await;
            if let Some(handle) = agents.get_handle_mut(agent_id) {
                handle.tool_use_count += 1;
            }
        }

        // Drive the per-agent TurnAggregator. Emitted logical messages are
        // appended to local TOML, published to session/live as
        // `message.created`, and (for AGENT_REPLY only) persisted to
        // cloud `messages`. ACP `acp.event` envelopes still flow through
        // the unchanged publish path below for streaming UI.
        let collab_sessions = self.target_sessions(agent_id).await;
        // Allocate the envelope sequence up front so it can also stamp
        // emitted messages (cloud `messages.sequence`). The envelope
        // append below uses the same value, keeping a 1:1 link between an
        // ACP event boundary and the messages that flowed from it.
        let (mut emitted, turn_id, seq, reply_to_message_id, clear_reply_to) = {
            let mut agents = self.agents.lock().await;
            let seq = agents
                .get_handle_mut(agent_id)
                .map(|h| h.next_sequence())
                .unwrap_or(0);
            let reply_to_message_id = agents
                .get_handle(agent_id)
                .and_then(|h| h.pending_reply_to_message_id.clone())
                .unwrap_or_default();
            let clear_reply_to = matches!(
                acp_event.event.as_ref(),
                Some(amux::acp_event::Event::StatusChange(sc))
                    if sc.old_status == amux::AgentStatus::Active as i32
                        && sc.new_status == amux::AgentStatus::Idle as i32
            );
            let turn_id_before = agents
                .aggregator(agent_id)
                .and_then(|a| a.current_turn_id())
                .map(str::to_string);
            let violations = if !is_child_event {
                agents
                    .get_handle_mut(agent_id)
                    .map(|h| {
                        crate::runtime::prepare_guard_for_acp_event(
                            &mut h.native_skill_turn_guard,
                            std::path::Path::new(&h.worktree),
                            &h.acp_session_id,
                            is_child_event,
                            &acp_event,
                            turn_id_before.as_deref(),
                        )
                    })
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            let mut emitted = match agents.aggregator_mut(agent_id) {
                Some(agg) if !is_child_event => agg.ingest(&acp_event),
                _ => Vec::new(),
            };
            if !violations.is_empty() {
                if let Some(handle) = agents.get_handle(agent_id) {
                    tracing::warn!(
                        agent_id = %agent_id,
                        workspace = %handle.worktree,
                        count = violations.len(),
                        slugs = ?violations.iter().map(|v| v.slug.as_str()).collect::<Vec<_>>(),
                        "native skill written to unsupported directory during turn"
                    );
                }
                let tid = turn_id_before.clone().unwrap_or_default();
                crate::runtime::apply_violations_to_emitted(&mut emitted, &violations, &tid);
            }
            let turn_id = turn_id_before.unwrap_or_default();
            (emitted, turn_id, seq, reply_to_message_id, clear_reply_to)
        };
        if !collab_sessions.is_empty() && !emitted.is_empty() {
            if let Some(tc) = self.teamclu.as_ref() {
                let actor_id = self.actor_id.clone();
                let model = self
                    .agents
                    .lock()
                    .await
                    .current_model(agent_id)
                    .cloned()
                    .unwrap_or_default();
                for msg in emitted {
                    // Thinking / tool rows stay ACP-only. AgentReply always
                    // lands on live + local TOML; cloud insert only for the
                    // turn-final slice (Idle / interrupted).
                    if msg.kind != crate::proto::teamclu::MessageKind::AgentReply {
                        continue;
                    }
                    let persist =
                        crate::runtime::turn_aggregator::TurnAggregator::cloud_persistent(&msg);
                    let kind = msg.kind;
                    let content = msg.content;
                    let mut metadata_json = msg.metadata_json;
                    let turn_id = msg.turn_id;
                    let interrupted = metadata_json.contains("\"turn_status\":\"interrupted\"");
                    if persist {
                        let agents = self.agents.lock().await;
                        if let Some(handle) = agents.get_handle(agent_id) {
                            let backend_handle = agents.agent_backend_handle();
                            let mut backend = backend_handle.lock().await;
                            if handle.acp_session_id.starts_with("pi:") {
                                let leaf = backend
                                    .completed_turn_leaf_id(&handle.acp_session_id);
                                metadata_json =
                                    crate::runtime::backend_session_metadata::stamp_pi_backend_session_metadata(
                                        &metadata_json,
                                        &handle.acp_session_id,
                                        leaf.as_deref(),
                                    );
                            } else if handle.agent_type == amux::AgentType::Opencode {
                                let message_id = backend
                                    .completed_turn_opencode_message_id(&handle.acp_session_id);
                                metadata_json =
                                    crate::runtime::backend_session_metadata::stamp_opencode_backend_session_metadata(
                                        &metadata_json,
                                        &handle.acp_session_id,
                                        message_id.as_deref(),
                                    );
                            }
                        }
                    }
                    let mut cloud_ok = true;
                    for sid in &collab_sessions {
                        let ok = tc
                            .emit_agent_message(
                                sid,
                                &actor_id,
                                kind,
                                &content,
                                &metadata_json,
                                &model,
                                &turn_id,
                                &reply_to_message_id,
                                seq,
                                persist,
                                Some(&self.backend),
                            )
                            .await;
                        cloud_ok = cloud_ok && ok;
                    }
                    // Harden cursor when a turn ends as interrupted: send_prompt
                    // may have returned Err and skipped persist_runtime_cursor.
                    // Only advance when cloud insert succeeded — otherwise
                    // catchup would skip an unanswered @mention with no row.
                    if interrupted && persist && cloud_ok && !reply_to_message_id.is_empty() {
                        self.persist_runtime_cursor(agent_id, &reply_to_message_id)
                            .await;
                    }
                }
            }
        }
        if clear_reply_to {
            if let Some(handle) = self.agents.lock().await.get_handle_mut(agent_id) {
                handle.pending_reply_to_message_id = None;
            }
        }

        // Ambient state variants (replaced wholesale on each push) should not
        // be persisted into the history buffer — replaying stale lists on
        // reconnect wastes bandwidth and contradicts the "in-memory only"
        // contract iOS assumes.
        let is_ambient = matches!(
            acp_event.event,
            Some(amux::acp_event::Event::AvailableCommands(_))
        );

        // Keep publishes under a conservative 10 KB budget. Claude Code's
        // AvailableCommands list with full descriptions routinely lands at
        // ~12 KB, which can trip broker packet limits and knock the daemon's
        // MQTT session offline mid-session-start. Trim descriptions (and as a
        // last resort commands themselves) in-place until the envelope fits.
        if let Some(amux::acp_event::Event::AvailableCommands(ref mut ac)) = acp_event.event {
            fit_available_commands_in_budget(ac);
            // Cache the trimmed list so the retained `runtime/{id}/state`
            // publish carries the same commands a fresh subscriber would
            // otherwise miss (events stream is not retained). Republish
            // immediately — ACP's AvailableCommandsUpdate fires after spawn
            // but typically before any status transition, so without this
            // bump the retained state would stay empty until the next
            // unrelated transition.
            self.agents
                .lock()
                .await
                .set_available_commands(agent_id, ac.commands.clone());
            self.publish_runtime_state_by_id(agent_id).await;
        }

        let envelope = amux::Envelope {
            runtime_id: agent_id.into(),
            actor_id: self.config.actor.id.clone(),
            // Agent-initiated events leave this empty. Under AMUX_LATENCY_PROBE=1
            // we borrow the (otherwise never-read) field to carry the publish-side
            // ms timestamp so the desktop can measure one-way transport latency
            // (daemon publish → webview receive) without a proto change. The
            // probe measures exactly the segment a local SSE fast-path would
            // eliminate: it stamps AFTER the 50ms drain pump and BEFORE the
            // frontend rAF buffer, both of which are transport-independent.
            source_peer_id: if latency_probe_enabled() {
                format!("probe:{}", chrono::Utc::now().timestamp_millis())
            } else {
                String::new()
            },
            timestamp: chrono::Utc::now().timestamp(),
            sequence: seq,
            turn_id,
            acp_session_id: if is_child_event {
                acp_session_id
            } else {
                String::new()
            },
            payload: Some(amux::envelope::Payload::AcpEvent(acp_event)),
        };

        if !is_ambient {
            self.history.append(agent_id, &envelope);
        }
        self.publish_envelope_to_sessions(agent_id, &envelope).await;
    }

    /// Enforce the one-live-runtime-per-session invariant at message-routing
    /// time. If multiple handles leaked into memory (race, stale resume, etc.),
    /// keep the newest and stop the rest before fanning out a prompt.
    pub(crate) async fn coalesce_session_runtimes(&mut self, session_id: &str) -> Vec<String> {
        let ids = self.agents.lock().await.runtime_ids_for_session(session_id);
        if ids.len() <= 1 {
            return ids;
        }
        let keep = self
            .agents
            .lock()
            .await
            .newest_runtime_id_for_session(session_id);
        let Some(keep) = keep else {
            return ids;
        };
        // Same carve-out as `apply_start_runtime`: a runtime that is mid-turn
        // keeps running. It is still dropped from the routing set, so the
        // prompt goes to `keep` alone — but stopping it here would kill an
        // in-flight cron/gateway answer just because a message arrived.
        let (in_flight, superseded): (Vec<String>, Vec<String>) = {
            let agents = self.agents.lock().await;
            ids.into_iter()
                .filter(|id| id != &keep)
                .partition(|id| agents.turn_in_flight(id))
        };
        if !in_flight.is_empty() {
            info!(
                session_id = %session_id,
                in_flight = ?in_flight,
                "coalesce_session_runtimes: left mid-turn runtimes running rather than stopping them"
            );
        }
        if !superseded.is_empty() {
            warn!(
                session_id = %session_id,
                keep = %keep,
                superseded = ?superseded,
                "coalesce_session_runtimes: stopping duplicate live runtimes before fanout"
            );
        }
        for rid in &superseded {
            self.agents.lock().await.stop_runtime(rid).await;
            self.remote_tool_turn_contexts
                .lock()
                .await
                .clear_runtime(rid);
        }
        vec![keep]
    }

    /// Decode a `LiveEventEnvelope` (same bytes MQTT `session/{id}/live`
    /// carries) and route `message.created` through [`Self::route_session_message`].
    /// Shared by the MQTT subscriber and `POST /v1/session-live/ingest` so
    /// local loopback delivery and the broker copy share one `message_id` dedup
    /// gate. Non-`message.created` events are ignored here (HTTP ingest only
    /// sends user messages); the MQTT path still handles ideas itself.
    pub(crate) async fn ingest_session_live(
        &mut self,
        session_id: &str,
        payload: &[u8],
    ) -> Result<(), String> {
        use prost::Message as _;

        let envelope = crate::proto::teamclu::LiveEventEnvelope::decode(payload)
            .map_err(|e| format!("LiveEventEnvelope decode failed: {e}"))?;
        if envelope.event_type != "message.created" {
            return Ok(());
        }
        let env = crate::proto::teamclu::SessionMessageEnvelope::decode(envelope.body.as_slice())
            .map_err(|e| format!("SessionMessageEnvelope decode failed: {e}"))?;
        let Some(msg) = env.message.as_ref() else {
            return Err("SessionMessageEnvelope without inner message".into());
        };
        self.route_session_message(
            session_id,
            msg,
            &resolve_mention_actor_ids(&env.mention_actor_ids, &msg.metadata_json),
        )
        .await;
        Ok(())
    }

    /// Route an inbound `message.created` from `session/{sid}/live` to the
    /// appropriate runtimes: mentioned runtimes receive a real prompt (which
    /// flushes any queued silent context first); un-mentioned runtimes have
    /// the message appended to `pending_silent` for delivery on next mention.
    ///
    /// Self-authored messages (i.e. sent by this daemon's own actor_id) are
    /// silently dropped to prevent feedback loops.
    pub(crate) async fn route_session_message(
        &mut self,
        session_id: &str,
        message: &crate::proto::teamclu::Message,
        mention_actor_ids: &[String],
    ) {
        // Skip messages this daemon authored — those are the agent reply we
        // just emitted; routing them back into our own runtimes would loop.
        if message.sender_actor_id == self.actor_id {
            return;
        }

        let runtime_ids = self.coalesce_session_runtimes(session_id).await;
        if runtime_ids.is_empty() {
            if self
                .resume_historical_runtimes_for_session(
                    session_id,
                    (!message.sender_actor_id.is_empty())
                        .then_some(message.sender_actor_id.as_str()),
                )
                .await
            {
                return;
            }

            let runtime_ids = self.coalesce_session_runtimes(session_id).await;
            if !runtime_ids.is_empty() {
                self.route_session_message_to_runtimes(
                    session_id,
                    message,
                    mention_actor_ids,
                    runtime_ids,
                )
                .await;
                return;
            }

            // We're subscribed to session/{sid}/live but have no runtime
            // for it and no resumable historical runtime on disk. The daemon
            // cannot infer worktree/backend session details from the live
            // message alone, so this message cannot be routed locally.
            warn!(
                session_id = %session_id,
                message_id = %message.message_id,
                sender_actor_id = %message.sender_actor_id,
                "route_session_message: no runtime for session; dropping message"
            );
            return;
        }

        self.route_session_message_to_runtimes(session_id, message, mention_actor_ids, runtime_ids)
            .await;
    }

    pub(crate) async fn route_session_message_to_runtimes(
        &mut self,
        session_id: &str,
        message: &crate::proto::teamclu::Message,
        mention_actor_ids: &[String],
        runtime_ids: Vec<String>,
    ) {
        use crate::runtime::PendingMessage;

        if message.sender_actor_id == self.actor_id {
            return;
        }

        // Single dedup gate for ALL ingestion paths. A freshly-sent message
        // reaches the daemon twice — once via live MQTT `message.created` and
        // once via the runtimeStart→catchup replay (it is already persisted by
        // the time the client fires runtimeStart). Both funnel through this
        // sink, so deduping here (keyed by message_id) guarantees each message
        // is prompted/queued exactly once regardless of which path wins the
        // race. Cross-restart dedup relies on `last_processed_message_id` and
        // catchup reconcile (see `reconcile_runtime_cursor`), not this cache.
        if !message.message_id.is_empty() {
            if let Some(tc) = self.teamclu.as_mut() {
                if !tc.should_process_message(session_id, &message.message_id) {
                    debug!(
                        session_id = %session_id,
                        message_id = %message.message_id,
                        "route_session_message: already processed; skipping (dedup gate)"
                    );
                    return;
                }
            }
        }

        let sender_display = self
            .display_name_for_actor(&message.sender_actor_id)
            .unwrap_or_else(|| message.sender_actor_id.chars().take(8).collect());

        // @-ing the person on the other end of a gateway chat sends them the
        // message. Runs before runtime routing because it is independent of
        // it: the push happens whether or not an agent was also mentioned.
        self.push_message_to_mentioned_externals(
            session_id,
            message,
            mention_actor_ids,
            &sender_display,
        )
        .await;

        // Each runtime in this list belongs to this daemon, so a mention of
        // this daemon's actor engages the runtime. The handle's `agent_id`
        // is the 8-char runtime key (per CLAUDE.md glossary), NOT the actor
        // id that mention_actor_ids encodes — matching against it would
        // never hit and every message would fall through to silent queue.
        let mentioned_actor = mention_actor_ids.iter().any(|m| m == &self.actor_id);
        if mention_actor_ids.is_empty() {
            warn!(
                message_id = %message.message_id,
                daemon_actor_id = %self.actor_id,
                "route_session_message: empty mention_actor_ids; message will be silent-queued"
            );
        } else if !mentioned_actor {
            debug!(
                message_id = %message.message_id,
                daemon_actor_id = %self.actor_id,
                mention_actor_ids = ?mention_actor_ids,
                "route_session_message: mention_actor_ids present but not this daemon; silent-queued"
            );
        }
        let attachment_urls = message_attachment_urls(message);
        for runtime_id in runtime_ids {
            if self.agents.lock().await.get_handle(&runtime_id).is_none() {
                continue;
            }
            let mentioned = mentioned_actor;

            if mentioned {
                let prompt_body = message.content.trim();
                if prompt_body.is_empty() && attachment_urls.is_empty() {
                    warn!(
                        runtime_id = %runtime_id,
                        message_id = %message.message_id,
                        "route_session_message: mentioned but empty content; skipping send_prompt"
                    );
                    continue;
                }
                info!(
                    runtime_id = %runtime_id,
                    message_id = %message.message_id,
                    mention_actor_ids = ?mention_actor_ids,
                    "route_session_message: @ mention matched; sending prompt"
                );
                // Real prompt — flush_pending_silent inside send_prompt does the prefix work.
                info!(
                    runtime_id = %runtime_id,
                    message_id = %message.message_id,
                    session_id = %session_id,
                    "route_session_message: delivering mentioned prompt to runtime"
                );
                if let Some(desired_model) = session_message_model_override(message) {
                    // Apply unconditionally: the manager's current_model cache
                    // can go stale across daemon restarts/re-attaches (route
                    // seeded from the opencode config default), silently
                    // running a different model than the message declares.
                    // set_model is a cheap local command; idempotence is fine.
                    {
                        let mut agents = self.agents.lock().await;
                        match agents.send_set_model(&runtime_id, &desired_model).await {
                            Ok(()) => {
                                agents.set_current_model(&runtime_id, &desired_model);
                            }
                            Err(e) => {
                                warn!(
                                    runtime_id = %runtime_id,
                                    message_id = %message.message_id,
                                    model_id = %desired_model,
                                    err = %e,
                                    "route_session_message: send_set_model failed"
                                );
                            }
                        }
                    }
                }
                self.prepare_remote_tool_context_for_turn(
                    &runtime_id,
                    session_id,
                    &message.sender_actor_id,
                )
                .await;
                let requester =
                    (!message.sender_actor_id.is_empty()).then(|| message.sender_actor_id.clone());
                let reply_to = (!message.message_id.is_empty()).then(|| message.message_id.clone());
                let send_res = self
                    .agents
                    .lock()
                    .await
                    .send_prompt_with_requester(
                        &runtime_id,
                        message.content.as_str(),
                        attachment_urls.clone(),
                        requester,
                        reply_to,
                    )
                    .await;
                let _drained = match send_res {
                    Ok(d) => {
                        info!(
                            runtime_id = %runtime_id,
                            message_id = %message.message_id,
                            drained_silent = d.len(),
                            "route_session_message: send_prompt ok"
                        );
                        // reply_to is bound when the prompt worker starts this
                        // turn (via AcpEventFrame) — do not stamp handle here
                        // or a queued second prompt overwrites the in-flight turn.
                        d
                    }
                    Err(e) => {
                        warn!(runtime_id = %runtime_id, err = ?e, "send_prompt failed");
                        continue;
                    }
                };

                self.persist_runtime_cursor(&runtime_id, &message.message_id)
                    .await;
            } else {
                // Silent: queue for next real prompt.
                {
                    let mut agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle_mut(&runtime_id) {
                        handle.pending_silent.push(PendingMessage {
                            message_id: message.message_id.clone(),
                            sender_display: sender_display.clone(),
                            content: message.content.clone(),
                            created_at: message.created_at,
                        });
                    }
                }
                self.persist_runtime_cursor(&runtime_id, &message.message_id)
                    .await;
            }
        }
    }

    /// Advance in-memory cursor immediately; persist to Cloud before returning
    /// when a backend row id is known (catchup after restart must see it).
    pub(crate) async fn persist_runtime_cursor(&self, runtime_id: &str, message_id: &str) {
        if message_id.is_empty() {
            return;
        }
        {
            let mut agents = self.agents.lock().await;
            agents.advance_message_cursor(runtime_id, message_id);
        }
        // The cursor lives on the participant row, addressed by (session,
        // actor) — no per-spawn row id to resolve first (ADR-0005).
        let session_id = self.agents.lock().await.session_id_for_runtime(runtime_id);
        if let Some(session_id) = session_id {
            if let Err(e) = self
                .backend
                .update_session_cursor(&session_id, &self.actor_id, message_id)
                .await
            {
                warn!(?e, runtime_id, "update_session_cursor failed");
            }
        }
    }

    /// Align in-memory and persisted cursor with messages that already have an
    /// agent reply, so catchup does not re-prompt completed @mentions.
    ///
    /// Returns the full session message list when fetch succeeds so
    /// [`Self::catchup_runtime`] can slice locally instead of refetching.
    pub(crate) async fn reconcile_runtime_cursor(
        &mut self,
        runtime_id: &str,
    ) -> Option<Vec<crate::backend::StoredMessage>> {
        let (session_id, floor) = {
            let agents = self.agents.lock().await;
            let h = agents.get_handle(runtime_id)?;
            (h.session_id.clone(), h.last_processed_message_id.clone())
        };
        if session_id.is_empty() {
            return None;
        }

        let messages = match self.backend.messages_after_cursor(&session_id, None).await {
            Ok(m) => m,
            Err(e) => {
                warn!(
                    ?e,
                    runtime_id, "reconcile_runtime_cursor: messages fetch failed"
                );
                return None;
            }
        };
        if messages.is_empty() {
            return None;
        }

        let floor = floor.as_deref().filter(|s| !s.is_empty());
        let effective = compute_effective_cursor_from_messages(&messages, &self.actor_id, floor);
        if let Some(id) = effective {
            info!(
                runtime_id,
                cursor = %id,
                "reconcile_runtime_cursor: advanced from message history"
            );
            self.persist_runtime_cursor(runtime_id, &id).await;
        }
        Some(messages)
    }

    /// Replay any session messages that arrived before this runtime was spawned.
    ///
    /// Fetches all messages after the runtime's `last_processed_message_id`
    /// cursor (None → fetch all) and routes each through the no-resume message
    /// router so live and catchup share identical semantics (mentioned → real
    /// prompt, un-mentioned → pending_silent queue).
    ///
    /// **Stale-mention compaction** (offline-replay-specific): when the
    /// daemon comes back online after missing N messages, only the *last*
    /// `@daemon` mention in the replay slice triggers a fresh turn — earlier
    /// `@daemon` rows are compacted into `pending_silent` even though they
    /// nominally mention us.
    pub async fn catchup_runtime(&mut self, runtime_id: &str) -> bool {
        let session_id = {
            let agents = self.agents.lock().await;
            let Some(h) = agents.get_handle(runtime_id) else {
                return false;
            };
            h.session_id.clone()
        };
        if session_id.is_empty() {
            return false;
        }

        let reconciled_all = self.reconcile_runtime_cursor(runtime_id).await;

        let last_processed_message_id = self
            .agents
            .lock()
            .await
            .get_handle(runtime_id)
            .and_then(|h| h.last_processed_message_id.clone());

        let messages = if let Some(all) = reconciled_all {
            messages_strictly_after_cursor(&all, last_processed_message_id.as_deref())
        } else {
            match self
                .backend
                .messages_after_cursor(&session_id, last_processed_message_id.as_deref())
                .await
            {
                Ok(m) => m,
                Err(e) => {
                    warn!(?e, runtime_id, "catchup messages_after_cursor failed");
                    return false;
                }
            }
        };
        if messages.is_empty() {
            return false;
        }

        let my_actor = self.actor_id.clone();
        if !slice_has_actionable_inbound(&messages, &my_actor) {
            debug!(
                runtime_id,
                session_id = %session_id,
                "catchup_runtime: no actionable inbound messages after reconcile"
            );
            return false;
        }

        // Only the last *unanswered* @mention triggers a real prompt; earlier
        // @-mentions (including already-answered ones) are silent context.
        let last_mention_idx = last_unanswered_mention_idx(&messages, &my_actor);

        info!(
            runtime_id,
            count = messages.len(),
            last_mention_idx,
            "catching up runtime"
        );

        for (idx, m) in messages.iter().enumerate() {
            if self.agents.lock().await.get_handle(runtime_id).is_none() {
                warn!(
                    runtime_id,
                    session_id, "catchup found no runtime after resume"
                );
                return false;
            }
            let mention_ids = parse_mention_actor_ids(&m.metadata_json);
            let proto = crate::proto::teamclu::Message {
                message_id: m.id.clone(),
                session_id: m.session_id.clone(),
                sender_actor_id: m.sender_actor_id.clone(),
                kind: 0,
                content: m.content.clone(),
                created_at: m.created_at,
                ..Default::default()
            };
            let effective_mentions: &[String] = if Some(idx) == last_mention_idx {
                &mention_ids
            } else {
                &[]
            };
            self.route_session_message_to_runtimes(
                &session_id,
                &proto,
                effective_mentions,
                vec![runtime_id.to_string()],
            )
            .await;
        }
        true
    }

    /// Deliver a session message to the chats of the external people it
    /// @-mentions.
    ///
    /// This is the desktop side of a gateway chat: the agent answers inbound
    /// messages by itself, but a human typing in the session had no way to
    /// reach the other end at all — the only outbound path in the daemon is
    /// the `send` MCP tool, which needs a runtime that has MCP and an agent
    /// willing to call it. Naming someone is the intent, so it is the trigger.
    ///
    /// Deliberately narrow:
    ///
    /// * Only the session's own binding is used as the target. An external
    ///   actor is only ever a participant of the chat they wrote from, so the
    ///   chat is the address; reconstructing a DM route from the actor alone
    ///   would let a desktop session open a conversation nobody asked for.
    /// * A message from an external actor never pushes. Otherwise an inbound
    ///   WeCom message that happened to mention someone would be echoed
    ///   straight back into the chat it came from.
    async fn push_message_to_mentioned_externals(
        &self,
        session_id: &str,
        message: &crate::proto::teamclu::Message,
        mention_actor_ids: &[String],
        sender_display: &str,
    ) {
        if mention_actor_ids.is_empty() || message.content.trim().is_empty() {
            return;
        }
        let Some(mgr) = self.channel_mgr.as_ref() else {
            return;
        };

        // One directory read covers both questions: which mentions are
        // external, and whether the sender is one of them.
        let mut ids: Vec<String> = mention_actor_ids.to_vec();
        if !message.sender_actor_id.is_empty() {
            ids.push(message.sender_actor_id.clone());
        }
        let rows = match self.backend.get_actors_by_ids(&ids).await {
            Ok(r) => r,
            Err(e) => {
                warn!(session_id, error = %e, "external mention: actor lookup failed; not pushed");
                return;
            }
        };
        let mentioned = externals_to_notify(&rows, mention_actor_ids, &message.sender_actor_id);
        if mentioned.is_empty() {
            return;
        }

        let binding = match self.backend.get_session_binding(session_id).await {
            Ok(Some(b)) => b,
            Ok(None) => {
                warn!(
                    session_id,
                    "external mention: session is not bound to a chat; nothing to push to"
                );
                return;
            }
            Err(e) => {
                warn!(session_id, error = %e, "external mention: binding lookup failed; not pushed");
                return;
            }
        };
        let (channel, target) =
            match crate::daemon::binding_target::parse_binding_to_target(&binding) {
                Ok((channel, Some(target))) => (channel, target),
                Ok((channel, None)) => {
                    warn!(
                        session_id,
                        channel, "external mention: channel has no outbound target shape yet"
                    );
                    return;
                }
                Err(e) => {
                    warn!(session_id, error = %e, "external mention: unparseable binding");
                    return;
                }
            };

        // Prefixed with who typed it: this arrives in a chat where every
        // previous message came from the bot, so an unattributed line reads as
        // the agent suddenly speaking on its own.
        let body = outbound_body(sender_display, &message.content);
        match mgr.dispatch_send(channel, &target, Some(&body), None).await {
            Ok(()) => info!(
                session_id,
                channel,
                mentioned = mentioned.len(),
                "external mention: pushed to chat"
            ),
            Err(e) => warn!(session_id, channel, error = %e, "external mention: push failed"),
        }
    }

    /// Look up a display name for an actor_id from the in-memory peer tracker.
    /// Returns `None` if the actor is unknown; the caller falls back to the
    /// first 8 chars of the actor_id.
    pub(crate) fn display_name_for_actor(&self, actor_id: &str) -> Option<String> {
        // PeerTracker is keyed by peer_id (session-scoped), not actor_id.
        // Search linearly for a matching member_id / peer entry.
        // If no match is found, return None and let the caller use the fallback.
        self.peers
            .get_peer(actor_id)
            .map(|p| p.display_name.clone())
    }

    /// Single sink for agent-originated envelopes. Fans out to
    /// `session/{sid}/live` for every session the agent is bound to.
    /// Returns silently when the agent has no session — every iOS
    /// session is session-backed today, so a bound-less agent is a
    /// legacy bare-runtime spawn whose `runtime/{rid}/events` topic
    /// has no subscriber. Logs a warn so it shows up if regression
    /// reintroduces session-less spawns.
    pub(crate) async fn publish_envelope_to_sessions(
        &self,
        agent_id: &str,
        envelope: &amux::Envelope,
    ) {
        let Some(tc) = self.teamclu.as_ref() else {
            warn!(agent_id, "no teamclu client; dropping envelope");
            return;
        };
        let sessions = self.target_sessions(agent_id).await;
        if sessions.is_empty() {
            warn!(agent_id, "agent has no bound session; dropping envelope");
            return;
        }
        let actor_id = self.actor_id.clone();
        for sid in &sessions {
            tc.publish_agent_acp_event(sid, &actor_id, envelope).await;
        }
    }

    /// Returns the primary (first running) agent ID for this daemon.
    /// Used to stamp new sessions with the host's agent without passing
    /// RuntimeManager into SessionManager.
    pub(crate) async fn primary_agent_id(&self) -> Option<String> {
        self.agents.lock().await.first_running_agent_id()
    }

    pub(crate) async fn runtime_id_for_agent_actor_in_session(
        &self,
        agent_actor_id: &str,
        session_id: &str,
    ) -> Option<String> {
        let agents = self.agents.lock().await;
        if agents.get_handle(agent_actor_id).is_some() {
            return Some(agent_actor_id.to_string());
        }
        if agent_actor_id == self.backend.actor_id() {
            return agents.running_agent_id_for_collab_session(session_id);
        }
        None
    }
}

/// Whether `title` looks like a client-minted default rather than something a
/// person typed. Defaults are `<agent name> (HH:MM)` (desktop new-chat),
/// `Session <id>` and `New session…` placeholders. An unknown/empty title is
/// NOT treated as default — when in doubt, never overwrite.
pub(crate) fn is_default_session_title(title: &str) -> bool {
    let title = title.trim();
    if title.is_empty() {
        return false;
    }
    if title.starts_with("New session") || title.starts_with("Session ") {
        return true;
    }
    // `<something> (H:MM)` / `<something> (HH:MM)`
    let Some(rest) = title.strip_suffix(')') else {
        return false;
    };
    let Some((head, time)) = rest.rsplit_once('(') else {
        return false;
    };
    if !head.ends_with(' ') {
        return false;
    }
    match time.split_once(':') {
        Some((h, m)) => {
            (1..=2).contains(&h.len())
                && m.len() == 2
                && h.bytes().all(|b| b.is_ascii_digit())
                && m.bytes().all(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

#[cfg(test)]
mod default_title_tests {
    use super::is_default_session_title;

    #[test]
    fn detects_desktop_default_titles() {
        assert!(is_default_session_title("Mac-mini-8 (10:50)"));
        assert!(is_default_session_title("Mac-mini-8 (9:05)"));
        assert!(is_default_session_title("Session 2a0c5336"));
        assert!(is_default_session_title(
            "New session - 2026-07-22T01:57:19.776Z"
        ));
    }

    #[test]
    fn keeps_user_titles() {
        assert!(!is_default_session_title(""));
        assert!(!is_default_session_title("Launch Plan"));
        assert!(!is_default_session_title("Cron: Test"));
        assert!(!is_default_session_title("发布计划 (v2)"));
        assert!(!is_default_session_title("standup (today)"));
    }
}

/// Which of a message's mentions name someone reachable only through a chat.
///
/// Returns nothing when the sender is themselves external: that message came
/// *from* a chat, and pushing it back would echo the conversation into itself.
/// Unknown ids (the directory did not answer for them) are not assumed
/// external — a lookup gap must not turn into an outbound message.
fn externals_to_notify(
    rows: &[crate::backend::records::ActorDirectoryRow],
    mention_actor_ids: &[String],
    sender_actor_id: &str,
) -> Vec<String> {
    let is_external = |id: &str| {
        !id.is_empty()
            && rows
                .iter()
                .any(|r| r.id == id && r.kind.as_deref() == Some("external"))
    };
    if is_external(sender_actor_id) {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for id in mention_actor_ids {
        if is_external(id) && !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// Drop the `[Mentioned agents: …]` / `[Mentioned humans: …]` headers the
/// composer prepends to a message.
///
/// They are routing scaffolding — the desktop renders them as pills and never
/// shows the raw text — so forwarding them verbatim would put the plumbing in
/// front of the reader in the one place nothing strips it again.
fn strip_mention_headers(content: &str) -> &str {
    let mut rest = content.trim_start();
    while let Some(body) = rest.strip_prefix("[Mentioned") {
        let Some(end) = body.find(']') else { break };
        rest = body[end + 1..].trim_start();
    }
    rest
}

/// What the chat sees. The name is not decoration: every other message in that
/// conversation came from the bot, so an unattributed line reads as the agent
/// having spoken on its own.
fn outbound_body(sender_display: &str, content: &str) -> String {
    let content = strip_mention_headers(content).trim_end();
    if sender_display.is_empty() {
        return content.to_string();
    }
    format!("{sender_display}：{content}")
}

#[cfg(test)]
mod external_mention_tests {
    use super::{externals_to_notify, outbound_body};
    use crate::backend::records::ActorDirectoryRow;

    fn actor(id: &str, kind: &str) -> ActorDirectoryRow {
        ActorDirectoryRow {
            id: id.into(),
            display_name: Some(id.into()),
            kind: Some(kind.into()),
        }
    }

    fn directory() -> Vec<ActorDirectoryRow> {
        vec![
            actor("member-1", "member"),
            actor("agent-1", "agent"),
            actor("ext-1", "external"),
            actor("ext-2", "external"),
        ]
    }

    #[test]
    fn a_member_mentioning_an_external_pushes_to_them() {
        let mentions = vec!["agent-1".to_string(), "ext-1".to_string()];
        assert_eq!(
            externals_to_notify(&directory(), &mentions, "member-1"),
            vec!["ext-1".to_string()]
        );
    }

    #[test]
    fn a_message_from_a_chat_never_pushes_back_into_one() {
        // The inbound WeCom message is written into the session like any
        // other. Without this the gateway would answer its own sender.
        let mentions = vec!["ext-2".to_string()];
        assert!(externals_to_notify(&directory(), &mentions, "ext-1").is_empty());
    }

    #[test]
    fn mentions_that_are_not_external_are_not_pushed() {
        let mentions = vec!["agent-1".to_string(), "member-1".to_string()];
        assert!(externals_to_notify(&directory(), &mentions, "member-1").is_empty());
    }

    #[test]
    fn an_actor_the_directory_does_not_know_is_left_alone() {
        // A failed or partial lookup must not become an outbound message.
        let mentions = vec!["who-1".to_string()];
        assert!(externals_to_notify(&directory(), &mentions, "member-1").is_empty());
        // ...and an unknown sender still counts as "not external", so a
        // desktop message routes normally.
        let mentions = vec!["ext-1".to_string()];
        assert_eq!(
            externals_to_notify(&directory(), &mentions, "who-2"),
            vec!["ext-1".to_string()]
        );
    }

    #[test]
    fn the_same_person_mentioned_twice_is_notified_once() {
        let mentions = vec!["ext-1".to_string(), "ext-1".to_string()];
        assert_eq!(
            externals_to_notify(&directory(), &mentions, "member-1"),
            vec!["ext-1".to_string()]
        );
    }

    #[test]
    fn the_pushed_text_says_who_typed_it() {
        assert_eq!(outbound_body("周金亮", "  下班了吗  "), "周金亮：下班了吗");
        assert_eq!(outbound_body("", "hi"), "hi");
    }

    #[test]
    fn the_composers_routing_headers_do_not_reach_the_chat() {
        // The desktop renders these as pills; WeCom would render them as text.
        assert_eq!(
            outbound_body(
                "周金亮",
                "[Mentioned agents: Mac-mini-3]\n\n[Mentioned humans: LiangLiang]\n开会了"
            ),
            "周金亮：开会了"
        );
        // A bracket that is not a header is content and stays put.
        assert_eq!(outbound_body("A", "[TODO] ship it"), "A：[TODO] ship it");
    }
}
