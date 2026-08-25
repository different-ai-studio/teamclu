//! Extracted from `server.rs` — methods of `DaemonServer` grouped by concern.
//! See `server.rs` for the struct definition and core lifecycle.

use super::*;

impl DaemonServer {
    /// Build a `ChannelManager` from the given config and call
    /// `start_enabled()`. Returns `None` when the daemon has no `team_id`
    /// yet (not onboarded) — caller logs and skips. Per-channel start
    /// failures are logged inside `start_enabled` and do NOT abort the
    /// whole boot.
    pub(crate) async fn build_and_start_channel_manager(
        &self,
        cfg: DaemonConfig,
    ) -> Option<ChannelManager> {
        let Some(team_id) = cfg.team_id.clone() else {
            info!("channels: daemon has no team_id (run `amuxd init`); skipping channel start");
            return None;
        };

        // Gateway reply language: device-wide, from daemon.toml. Applied here so
        // a restart (and every channel reload) picks up whatever the desktop app
        // last reported; live changes come in over `gateway-locale`.
        apply_gateway_locale(cfg.locale.as_deref());

        // The daemon's own actor_id (persisted in backend.toml during `init`)
        // is the agent participant the gateway-port channels speak as. Admin
        // owners are looked up from agent_member_access so they appear in
        // session_participants and can see gateway-originated DMs via RLS.
        let primary_agent_actor_id = self.actor_id.clone();
        let agent_owner_actor_ids: Vec<String> = match self
            .backend
            .list_agent_admin_member_actor_ids(&primary_agent_actor_id)
            .await
        {
            Ok(ids) => {
                tracing::info!(
                    "channel manager: {} admin owner(s) found for agent {}",
                    ids.len(),
                    primary_agent_actor_id
                );
                ids
            }
            Err(e) => {
                tracing::error!(
                    "channel manager: failed to resolve agent owners: {:?}; continuing with empty owner list",
                    e
                );
                Vec::new()
            }
        };

        // Resolve the daemon agent's own configured defaults so gateway
        // (WeCom/etc.) sessions spawn on its default agent type + default
        // workspace instead of the daemon-wide fallback type and a /tmp scratch
        // dir. Retain an explicitly configured workspace ID when its startup
        // lookup fails so the eventual gateway spawn fails closed instead of
        // silently becoming unscoped.
        let (default_agent_type, default_workspace_id, default_workspace_dir) = match self
            .backend
            .get_agent_defaults(&primary_agent_actor_id)
            .await
        {
            Ok(defaults) => {
                let agent_type = defaults
                    .default_agent_type
                    .as_deref()
                    .and_then(agent_type_from_name);
                let workspace_dir = match defaults.default_workspace_id.as_deref() {
                    Some(id) => {
                        let path = self
                            .workspace_resolver
                            .resolve(id)
                            .await
                            .ok()
                            .map(|w| w.path);
                        if path.is_none() {
                            warn!(
                                workspace_id = %id,
                                "channel manager: agent default workspace could not be resolved; \
                                 gateway sessions will reject scoped spawns"
                            );
                        }
                        path
                    }
                    None => None,
                };
                info!(
                    ?agent_type,
                    workspace_dir = ?workspace_dir,
                    "channel manager: resolved gateway agent defaults"
                );
                (agent_type, defaults.default_workspace_id, workspace_dir)
            }
            Err(e) => {
                warn!(
                    "channel manager: failed to fetch agent defaults: {e:?}; \
                     gateway sessions use daemon-wide defaults"
                );
                (None, None, None)
            }
        };

        // Per-bot runtime registry: resolve each WeCom bot's workspace dir +
        // agent type from `daemon.toml` so a bot's sessions spawn on its own
        // workspace/agent instead of the daemon-wide gateway defaults. Retain
        // the configured ID when resolution fails so spawning fails closed.
        let bot_configs: std::collections::HashMap<String, crate::channels::BotRuntimeConfig> = {
            use crate::channels::BotRuntimeConfig;
            let mut m = std::collections::HashMap::new();
            if let Some(wecom) = &cfg.channels.wecom {
                for bot in wecom.resolved_bots() {
                    let workspace_dir = match bot.workspace_id.as_deref() {
                        Some(id) => {
                            let path = self
                                .workspace_resolver
                                .resolve(id)
                                .await
                                .ok()
                                .map(|w| w.path);
                            if path.is_none() {
                                warn!(
                                    bot_id = %bot.bot_id,
                                    workspace_id = %id,
                                    "wecom bot workspace could not be resolved; \
                                     its sessions will reject scoped spawns"
                                );
                            }
                            path
                        }
                        None => None,
                    };
                    let agent_type = bot.agent_type.as_deref().and_then(agent_type_from_name);
                    m.insert(
                        bot.bot_id.clone(),
                        BotRuntimeConfig {
                            workspace_id: bot.workspace_id.clone(),
                            workspace_dir,
                            agent_type,
                            system_prompt: bot.system_prompt.clone(),
                        },
                    );
                }
            }
            m
        };

        let agent_handle: Arc<dyn AgentHandle> = Arc::new(AmuxdAgentHandle {
            manager: self.agents.clone(),
            spawn_env: crate::channels::GatewaySpawnEnv {
                managed_llm: self.managed_llm.clone(),
                actor_id: self.config.actor.id.clone(),
                actor_name: self.config.actor.name.clone(),
                refresh_coordinator: self.refresh_coordinator.clone(),
            },
            logical_to_acp: Arc::new(AsyncMutex::new(HashMap::new())),
            team_id: team_id.clone(),
            model_override: Arc::new(AsyncMutex::new(HashMap::new())),
            gateway_model: split_gateway_model(self.config.channels.model.as_deref()),
            backend: self.backend.clone(),
            default_agent_type,
            default_workspace_id,
            default_workspace_dir,
            workspace_resolver: self.workspace_resolver.clone(),
            workspace_override: Arc::new(AsyncMutex::new(HashMap::new())),
            bot_configs: Arc::new(AsyncMutex::new(bot_configs)),
        });
        // Everything this store writes gets announced on `session/{id}/live`.
        // Without it a gateway conversation exists only in the cloud table, and
        // clients find out about it the next time they happen to refetch.
        let live = self.teamclu.as_ref().map(|tc| {
            crate::channels::live_notify::GatewayLiveNotifier::new(
                tc.live_publisher_handle(),
                tc.message_dedup(),
            )
        });
        if live.is_none() {
            warn!("channels: no teamclu client yet; gateway messages will not broadcast live");
        }
        let store: Arc<dyn ChannelStore> = Arc::new(AmuxdChannelStore {
            client: self.backend.clone(),
            live,
        });

        let mgr = ChannelManager::new(
            cfg,
            agent_handle,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
        );
        match mgr.start_enabled().await {
            Ok(()) => info!("channel manager: start_enabled() completed"),
            Err(e) => warn!("channel manager: start_enabled() failed: {e:?}"),
        }
        Some(mgr)
    }

    /// Construct the channel manager from `[channels.*]` entries in
    /// `daemon.toml` and call `start_enabled()` so every gateway whose
    /// section has `enabled = true` boots alongside the daemon. Best-effort:
    /// missing team_id (daemon not yet onboarded) or per-channel start
    /// failures are logged but do NOT abort daemon startup.
    pub(crate) async fn start_channels(&mut self) {
        let cfg = self.config.clone();
        self.channel_mgr = self.build_and_start_channel_manager(cfg).await;
    }

    /// Re-read `daemon.toml` from disk, tear down the running channel
    /// manager (if any), and bring up a fresh one. Used by the
    /// `channel-reload` control command. Failures are logged but never
    /// crash the daemon — partial reloads (e.g. config parsed but one
    /// channel fails to start) are acceptable.
    pub(crate) async fn reload_channels(&mut self) {
        let mut fresh_cfg = match DaemonConfig::load(&self.config_path) {
            Ok(c) => c,
            Err(e) => {
                error!("channel-reload: failed to read config: {e:?}");
                return;
            }
        };
        // daemon.toml no longer carries the team half; without this the reload
        // would replace a working channel config with the empty default. An
        // unreadable team.toml aborts the reload for the same reason — the
        // running manager keeps running rather than being replaced by nothing.
        if let Err(e) = crate::config::team_config::hydrate(&mut fresh_cfg) {
            error!("channel-reload: team.toml unreadable, keeping the running channels: {e:?}");
            return;
        }
        fresh_cfg.actor.id = self.config.actor.id.clone();

        if let Some(mgr) = self.channel_mgr.take() {
            info!("channel-reload: shutting down current channel manager");
            mgr.shutdown().await;
        }

        // Update the in-memory copy so subsequent paths that read
        // `self.config` see the new values.
        self.config = fresh_cfg.clone();
        self.channel_mgr = self.build_and_start_channel_manager(fresh_cfg).await;
        info!("channel-reload: ok");
    }

    /// Build the JSON response payload for the `channel-status` sock command.
    /// Walks the six known channel platforms and reports each one's
    /// `enabled` (from `daemon.toml`) and `connected` (running gateway slot
    /// is `Some(_)`). `last_error` is always `None` for now — richer per-
    /// channel error tracking is intentionally out of scope here.
    pub(crate) async fn channel_status_payload(&self) -> String {
        #[derive(serde::Serialize)]
        struct ChannelStatus {
            platform: &'static str,
            enabled: bool,
            connected: bool,
            last_error: Option<String>,
        }

        let cfg = &self.config.channels;
        let enabled_flag = |platform: &str| -> bool {
            match platform {
                "discord" => cfg.discord.as_ref().map(|c| c.enabled).unwrap_or(false),
                "wecom" => cfg.wecom.as_ref().map(|c| c.enabled).unwrap_or(false),
                "feishu" => cfg.feishu.as_ref().map(|c| c.enabled).unwrap_or(false),
                "kook" => cfg.kook.as_ref().map(|c| c.enabled).unwrap_or(false),
                "wechat" => cfg.wechat.as_ref().map(|c| c.enabled).unwrap_or(false),
                "email" => cfg.email.as_ref().map(|c| c.enabled).unwrap_or(false),
                "seatalk" => cfg.seatalk.as_ref().map(|c| c.enabled).unwrap_or(false),
                _ => false,
            }
        };

        let connected: Vec<(&'static str, bool, Option<String>)> = match self.channel_mgr.as_ref() {
            Some(mgr) => mgr.status_snapshot().await,
            None => vec![
                ("discord", false, None),
                ("wecom", false, None),
                ("feishu", false, None),
                ("kook", false, None),
                ("wechat", false, None),
                ("email", false, None),
                ("seatalk", false, None),
            ],
        };

        let statuses: Vec<ChannelStatus> = connected
            .into_iter()
            .map(|(platform, connected, last_error)| ChannelStatus {
                platform,
                enabled: enabled_flag(platform),
                connected,
                last_error,
            })
            .collect();

        serde_json::to_string(&statuses).unwrap_or_else(|_| "[]".to_string())
    }

    /// Build the JSON response payload for the `wecom-bots-status` sock command:
    /// `[{botId, connected, error}, ...]`, one entry per resolved WeCom bot.
    /// Mirrors `channel_status_payload`'s shape; returns `[]` when no channel
    /// manager is running.
    pub(crate) async fn wecom_bots_status_payload(&self) -> String {
        let rows = match self.channel_mgr.as_ref() {
            Some(mgr) => mgr.wecom_bots_status().await,
            None => vec![],
        };
        let json: Vec<serde_json::Value> = rows
            .into_iter()
            .map(|(bot_id, connected, error)| {
                serde_json::json!({ "botId": bot_id, "connected": connected, "error": error })
            })
            .collect();
        serde_json::to_string(&json).unwrap_or_else(|_| "[]".to_string())
    }

    /// Build the JSON response for the `wecom-chat-list` sock command:
    /// `{"chats":[{botId, chatId, chatName, chatType, lastMsgTime}, ...]}`.
    ///
    /// One request per configured bot that has an api key. A bot without one is
    /// skipped rather than failed: the key is optional, and a second bot that
    /// has it should still fill the picker. Errors ride along per bot so the
    /// settings UI can say *which* key was refused.
    pub(crate) async fn wecom_chat_list_payload(&self) -> String {
        let bots = self
            .config
            .channels
            .wecom
            .as_ref()
            .map(|w| w.resolved_bots())
            .unwrap_or_default();
        let mut chats: Vec<serde_json::Value> = Vec::new();
        let mut errors: Vec<serde_json::Value> = Vec::new();
        for bot in bots.into_iter().filter(|b| b.enabled) {
            let Some(key) = bot
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|k| !k.is_empty())
            else {
                continue;
            };
            match crate::channels::wecom_mcp::list_chats(key).await {
                Ok(rows) => chats.extend(rows.into_iter().map(|c| {
                    serde_json::json!({
                        "botId": bot.bot_id,
                        "botName": bot.bot_name,
                        "chatId": c.chat_id,
                        "chatName": c.chat_name,
                        "chatType": c.chat_type,
                        "lastMsgTime": c.last_msg_time,
                    })
                })),
                Err(e) => {
                    tracing::warn!(bot_id = %bot.bot_id, error = %e, "wecom chat list failed");
                    errors.push(serde_json::json!({ "botId": bot.bot_id, "error": e }));
                }
            }
        }
        serde_json::to_string(&serde_json::json!({ "chats": chats, "errors": errors }))
            .unwrap_or_else(|_| "{\"chats\":[],\"errors\":[]}".to_string())
    }

    /// Which credential fields already have a stored value, as dotted paths.
    ///
    /// The settings form reads credentials back empty (they live in the
    /// encrypted store, not in `team.toml`), which is indistinguishable from
    /// never having set one. This is the missing half — presence only, never
    /// the value.
    pub(crate) fn channel_secret_keys_payload(&self) -> String {
        let team = crate::config::layout::active_team();
        let keys = crate::config::team_config::stored_secret_keys(&team).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "channel-secret-keys: secret store unreadable");
            Vec::new()
        });
        serde_json::to_string(&serde_json::json!({ "keys": keys }))
            .unwrap_or_else(|_| "{\"keys\":[]}".to_string())
    }

    /// Handle a `channel-send` envelope: push text (and optionally one file)
    /// at a channel, full stop.
    ///
    /// No reply token, and no session write. The callers are the desktop app's
    /// own cron delivery and its `introspect` send tool, announcing something
    /// that already has its own session — there is no chat being replied to, so
    /// there is nothing for a token to authorize and nothing to attach to.
    ///
    /// Kept separate from `mcp-send` rather than relaxing that path: a token is
    /// exactly what stops an agent from addressing a chat it was never part of,
    /// and the two callers have opposite trust stories — one is a model, the
    /// other is the application that owns this daemon.
    ///
    /// #933: `media_base64` exists so the desktop stopped calling
    /// `teamclu_gateway::wecom::*` straight from `introspect_api.rs`. That path
    /// reached the chat without the daemon knowing, using workspace credentials
    /// instead of the daemon's. It still does not write a session row — the
    /// caller has no session to write to — but channel I/O now happens in
    /// exactly one process.
    pub(crate) async fn handle_channel_send(
        &self,
        payload: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let channel = payload
            .get("channel")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let target = payload
            .get("target")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let message = payload
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if channel.is_empty() {
            anyhow::bail!("channel-send: 'channel' is required");
        }
        if target.is_empty() {
            anyhow::bail!("channel-send: 'target' is required");
        }
        // Decoded before the emptiness check: a file with no caption is a
        // legitimate send, so "message is required" only holds without one.
        let media = decode_channel_send_media(payload)?;
        if message.trim().is_empty() && media.is_none() {
            anyhow::bail!("channel-send: 'message' or 'media_base64' is required");
        }
        // Same guard as the agent path: a half-resolved route delivers nowhere
        // while reporting success.
        if let Some(reason) = placeholder_target_reason(target) {
            anyhow::bail!("channel-send: refusing placeholder target '{target}' ({reason})");
        }
        let mgr = self
            .channel_mgr
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("channel manager not running"))?;
        let media_sent = media.is_some();
        let text = (!message.trim().is_empty()).then_some(message);
        mgr.dispatch_send(channel, target, text, media).await?;
        Ok(serde_json::json!({
            "channel": channel,
            "target": target,
            "media_sent": media_sent,
        }))
    }

    /// Handle a `mcp-send` JSON envelope from the `amuxd mcp-server` bridge.
    /// Resolves the caller's reply token to a chat binding, parses that
    /// binding (e.g. `wecom://{corp}/{agent}/{kind}/{id}`) into the default
    /// channel + target, applies any explicit overrides, then routes the send
    /// through `ChannelManager::dispatch_send`. Returns a JSON-friendly
    /// success/error value (the listener serializes it).
    ///
    /// The token is the whole authorization story. The tool is registered
    /// per workspace now, so every session in that workspace can see it —
    /// including desktop conversations that were never bound to a chat. Those
    /// have no token, so they resolve to no target and cannot send, and an
    /// explicit `target` does not rescue them: overrides are only honoured
    /// once a token has established which chat the caller belongs to.
    pub(crate) async fn handle_mcp_send(
        &self,
        payload: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let binding_owned = binding_from_reply_token(payload)?;
        let binding = binding_owned.as_str();
        let message = payload.get("message").and_then(|v| v.as_str());
        let file_path = payload.get("file_path").and_then(|v| v.as_str());
        let target_override = payload.get("target_override").and_then(|v| v.as_str());
        let channel_override = payload.get("channel_override").and_then(|v| v.as_str());

        if message.map(|s| s.is_empty()).unwrap_or(true) && file_path.is_none() {
            anyhow::bail!("mcp-send: at least one of 'message' or 'file_path' is required");
        }

        let (default_channel, default_target) = parse_binding_to_target(binding)?;
        let channel = channel_override.unwrap_or(default_channel);
        let target_owned: String;
        let target = match target_override {
            Some(t) => t,
            None => match default_target {
                Some(t) => {
                    target_owned = t;
                    target_owned.as_str()
                }
                None => anyhow::bail!(
                    "mcp-send: binding '{binding}' has no default target — pass an explicit 'target' override"
                ),
            },
        };

        // Fail closed on placeholder / half-resolved routes (issue #549). A
        // target like `current`, `chat:current`, or `chat:` (empty id) means
        // the originating chat was never resolved; dispatching it would send
        // the attachment nowhere useful while still reporting success, so the
        // agent's watchdog cleans up a "delivered" send that never arrived.
        // Reject before dispatch so the tool surfaces a real error instead.
        if let Some(reason) = placeholder_target_reason(target) {
            anyhow::bail!(
                "mcp-send: refusing to send to placeholder target '{target}' ({reason}) \
                 for binding '{binding}' — the originating chat was not resolved"
            );
        }

        let mgr = self
            .channel_mgr
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("channel manager not running"))?;

        // A file sent while this chat's own turn is running belongs TO that
        // reply, not beside it. Attaching it means the user sees one message —
        // the answer with its file — instead of the file and then a paragraph
        // describing the file it just sent.
        //
        // Only for the originating chat: an explicit target override is a
        // deliberate push somewhere else and keeps the direct path.
        if target_override.is_none() {
            let resolved = payload
                .get("reply_token")
                .and_then(|v| v.as_str())
                .and_then(crate::channels::reply_token::session_for);
            // The no-session case is warned about (and still delivered) by
            // `record_outbound_send` below, which is the one place that knows
            // whether there was anything to record.
            if let Some(session_id) = resolved {
                let open = crate::channels::core::turn_attachments::is_open(&session_id);
                // Which of the two paths ran is otherwise invisible, and they
                // differ in whether the file ends up on the session message.
                tracing::info!(
                    session_id,
                    turn_open = open,
                    has_file = file_path.is_some(),
                    "mcp-send: routing"
                );
                if open {
                    return self
                        .attach_to_running_turn(mgr, &session_id, message, file_path, binding)
                        .await;
                }
            }
        }

        // Record first, render second (#933). The old order pushed to the
        // channel and then mirrored into the session, so a push that succeeded
        // followed by a failed mirror put the message in WeCom and nowhere
        // else — invisible on the desktop and unrecoverable. Writing first
        // inverts which failure is possible: a session row whose delivery
        // failed is at least visible, and the error is returned to the agent.
        let media = self
            .record_outbound_send(mgr, payload, message, file_path)
            .await?;

        mgr.dispatch_send(channel, target, message, media).await?;

        // `dispatch_send` returned Ok, so the channel adapter confirmed the
        // send. Echo the resolved binding/target so the caller's ACK can be
        // matched against the originating chat rather than trusting a bare
        // success flag (issue #549).
        Ok(serde_json::json!({
            "channel": channel,
            "target": target,
            "binding": binding,
            "message_sent": message.map(|s| !s.is_empty()).unwrap_or(false),
            "file_sent": file_path.is_some(),
        }))
    }

    /// Park a file against the in-flight turn instead of pushing it now.
    ///
    /// Nothing is recorded here: the core writes one message when the turn
    /// finishes, carrying the reply text and every file attached during it.
    /// Recording separately is what produced two rows — and, with the reply
    /// text usually describing the file, two copies of the same answer.
    async fn attach_to_running_turn(
        &self,
        mgr: &ChannelManager,
        session_id: &str,
        message: Option<&str>,
        file_path: Option<&str>,
        binding: &str,
    ) -> anyhow::Result<serde_json::Value> {
        let Some(path) = file_path else {
            // Text-only, to the chat this turn already answers into: the reply
            // is on its way there, so sending it again would duplicate it.
            // Reported as handled so the agent does not retry.
            return Ok(serde_json::json!({
                "binding": binding,
                "message_sent": false,
                "file_sent": false,
                "note": "text goes back as this turn's reply; `send` is for files, or for a different chat",
            }));
        };

        let bytes = tokio::fs::read(path)
            .await
            .map_err(|e| anyhow::anyhow!("read {path}: {e}"))?;
        let filename = std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let mime = teamclu_gateway::wecom::resolve_mime(&bytes, Some(&filename));
        let bucket_path = format!(
            "{}/{}/{}-{}",
            mgr.team_id(),
            session_id,
            uuid::Uuid::new_v4(),
            filename
        );
        let stored = mgr
            .store()
            .upload_attachment(&bucket_path, bytes, &mime)
            .await;
        if let Err(e) = &stored {
            warn!(session_id, filename, error = %e, "mcp-send: upload failed; attaching local copy only");
        }

        let attached = crate::channels::core::turn_attachments::attach(
            session_id,
            teamclu_gateway::driver::SessionAttachment {
                filename: filename.clone(),
                mime,
                bucket_path: stored.unwrap_or_default(),
                local_path: Some(path.to_string()),
            },
        );
        // The turn can finish between the check above and here; then there is
        // no reply left to ride out on and the caller must be told, rather than
        // having the file disappear.
        if !attached {
            anyhow::bail!(
                "mcp-send: the turn finished before the file was attached — send it again"
            );
        }

        let _ = message;
        Ok(serde_json::json!({
            "binding": binding,
            "message_sent": false,
            "file_sent": true,
            "note": "attached to this turn's reply",
        }))
    }

    /// Write an outbound `send` into the session, and hand back the bytes for
    /// the channel to render.
    ///
    /// Runs BEFORE `dispatch_send`, not after (#933). It returns the media
    /// rather than letting the transport re-read the path, so the file is read
    /// once and cannot reach a chat without this having run first.
    ///
    /// A missing session is not fatal: cron bindings and pre-token turns have
    /// none, and refusing to deliver would be a worse answer than delivering
    /// something the desktop cannot show. That case warns and sends anyway.
    async fn record_outbound_send(
        &self,
        mgr: &ChannelManager,
        payload: &serde_json::Value,
        message: Option<&str>,
        file_path: Option<&str>,
    ) -> anyhow::Result<Option<crate::channels::manager::OutboundMedia>> {
        let session_id = payload
            .get("reply_token")
            .and_then(|v| v.as_str())
            .and_then(crate::channels::reply_token::session_for);

        let store = mgr.store();
        let sender = mgr.agent_actor_id().to_string();
        let caption = message.unwrap_or("").trim().to_string();

        let Some(path) = file_path else {
            // A text-only proactive send. The gateway records its own replies,
            // but a `send` with no file is a message the session has not seen.
            if let Some(session_id) = session_id {
                if !caption.is_empty() {
                    if let Err(e) = store
                        .record_agent_reply(&session_id, &sender, &caption, None)
                        .await
                    {
                        warn!(session_id, error = %e, "mcp-send: recording the sent text failed");
                    }
                }
            }
            return Ok(None);
        };

        // Read before anything else: a file we cannot read is a send that
        // cannot happen, and failing here means the agent is told so instead
        // of getting a success for a delivery that never left.
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|e| anyhow::anyhow!("mcp-send: read {path}: {e}"))?;
        let filename = std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let media = crate::channels::manager::OutboundMedia {
            bytes: bytes.clone(),
            filename: filename.clone(),
        };

        let Some(session_id) = session_id else {
            // Pre-dates this turn's token, or a cron binding with no cloud
            // session. The file still goes out, but nothing will show it in
            // the app — which is the hole #933 opened with, narrowed to the
            // one case that has nowhere to write.
            warn!(
                filename,
                "mcp-send: reply token carries no session; sending without recording"
            );
            return Ok(Some(media));
        };

        let mime = teamclu_gateway::wecom::resolve_mime(&bytes, Some(&filename));
        let size = bytes.len();
        // Same team/session-scoped layout the inbound path uses, so both
        // directions land in one place.
        let bucket_path = format!(
            "{}/{}/{}-{}",
            mgr.team_id(),
            session_id,
            uuid::Uuid::new_v4(),
            filename
        );
        let uploaded = store
            .upload_attachment(&bucket_path, bytes, &mime)
            .await
            .is_ok();
        if !uploaded {
            warn!(
                session_id,
                filename, "mcp-send: attachment upload failed; recording it without a download"
            );
        }

        let content = if caption.is_empty() {
            format!("[Attachment: {filename}]")
        } else {
            format!("{caption}\n[Attachment: {filename}]")
        };
        if let Err(e) = store
            .record_agent_reply_with_attachments(
                &session_id,
                &sender,
                &content,
                None,
                vec![teamclu_gateway::AttachmentRecord {
                    filename,
                    mime,
                    size,
                    // Empty means "no download available" — same convention the
                    // inbound path uses when its upload fails.
                    bucket_path: if uploaded { bucket_path } else { String::new() },
                    local_path: Some(path.to_string()),
                }],
            )
            .await
        {
            warn!(session_id, error = %e, "mcp-send: recording the sent attachment failed");
        }

        Ok(Some(media))
    }

    // `handle_prompt_await` (cron-style ACP turn) lives in `server/cron.rs`.

    /// Persist a new per-platform channel config (parsed from the second line
    /// of a `channel-save` sock message) into `daemon.toml`, update the
    /// in-memory `self.config`, and reload the channel manager so the change
    /// takes effect immediately. Errors are logged but never crash the daemon.
    pub(crate) async fn save_channel_config(&mut self, platform: &str, config_json: &str) {
        let parsed: Result<(), String> = (|| -> Result<(), String> {
            match platform {
                "discord" => {
                    let v: crate::config::DiscordChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse discord: {e}"))?;
                    self.config.channels.discord = Some(v);
                }
                "wecom" => {
                    let v: crate::config::WeComChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse wecom: {e}"))?;
                    self.config.channels.wecom = Some(v);
                }
                "feishu" => {
                    let v: crate::config::FeishuChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse feishu: {e}"))?;
                    self.config.channels.feishu = Some(v);
                }
                "kook" => {
                    let v: crate::config::KookChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse kook: {e}"))?;
                    self.config.channels.kook = Some(v);
                }
                "wechat" => {
                    let v: crate::config::WeChatChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse wechat: {e}"))?;
                    self.config.channels.wechat = Some(v);
                }
                "email" => {
                    let v: crate::config::EmailChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse email: {e}"))?;
                    self.config.channels.email = Some(v);
                }
                "seatalk" => {
                    let v: crate::config::SeaTalkChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse seatalk: {e}"))?;
                    self.config.channels.seatalk = Some(v);
                }
                other => {
                    return Err(format!("unknown platform '{other}'"));
                }
            }
            Ok(())
        })();

        if let Err(e) = parsed {
            error!("channel-save: {e}");
            return;
        }

        // Channels are team-scoped: the structure lands in team.toml and the
        // credentials in the team's secret store, never in daemon.toml.
        if let Err(e) = crate::config::team_config::persist_from(&self.config) {
            error!("channel-save: failed to persist team.toml: {e:?}");
            return;
        }

        info!("channel-save: persisted {platform}, reloading channel manager");
        self.reload_channels().await;
    }

    /// Persist the gateway-wide model (`channels.model`) and reload channels so
    /// the next spawn picks it up.
    ///
    /// An empty string clears the setting rather than storing `""` — that is
    /// how the UI expresses "back to unpinned", and an empty ref would spawn on
    /// a nameless model.
    pub(crate) async fn save_gateway_model(&mut self, model: &str) {
        let trimmed = model.trim();
        self.config.channels.model = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };

        // Same destination as the per-platform sections: team-scoped team.toml,
        // never daemon.toml.
        if let Err(e) = crate::config::team_config::persist_from(&self.config) {
            error!("gateway-model: failed to persist team.toml: {e:?}");
            return;
        }

        info!(
            model = trimmed,
            "gateway-model: persisted, reloading channel manager"
        );
        self.reload_channels().await;
    }

    /// Persist the device-wide gateway reply language (`locale` in daemon.toml)
    /// and apply it to the running gateways.
    ///
    /// Unlike the model, this does **not** reload channels: the language is read
    /// per reply, so a live update is enough and a WeCom reconnect for a UI
    /// language toggle would be a needless disconnect. An empty string clears
    /// the setting, which reads back as English.
    pub(crate) fn save_gateway_locale(&mut self, locale: &str) {
        let trimmed = locale.trim();
        self.config.locale = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
        apply_gateway_locale(self.config.locale.as_deref());

        if let Err(e) = self
            .config
            .save(&crate::config::DaemonConfig::default_path())
        {
            error!("gateway-locale: failed to persist daemon.toml: {e:?}");
            return;
        }
        info!(locale = trimmed, "gateway-locale: persisted and applied");
    }

    /// Tear down any running channels. Idempotent — safe to call when
    /// `channel_mgr` is `None`.
    pub(crate) async fn shutdown_channels(&mut self) {
        if let Some(mgr) = self.channel_mgr.take() {
            info!("shutting down channels...");
            mgr.shutdown().await;
        }
    }

    /// Full graceful exit: channels + local runtimes (`opencode serve` tree)
    /// + discovery files (sock / http.port). Pidfile is removed by `PidfileGuard`
    /// when main returns; `amuxd stop` also calls `finalize_stop` as a safety net.
    pub(crate) async fn shutdown_for_exit(&mut self) {
        info!("daemon shutdown: draining channels and local runtimes");
        self.shutdown_channels().await;
        {
            let mut agents = self.agents.lock().await;
            agents.shutdown_for_exit().await;
        }
        // Clear discovery files before the process exits so a racing desktop
        // health probe cannot treat a dying daemon as healthy.
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(crate::config::DaemonConfig::sock_path());
        }
        let _ = std::fs::remove_file(crate::config::DaemonConfig::http_port_path());
    }
}

/// Push the configured language into the gateway crate's device-wide locale.
///
/// `None` (and any tag we do not translate) means English — the same fallback
/// `Locale::parse_or_default` applies, kept in one place so the daemon never
/// invents its own notion of "unset".
fn apply_gateway_locale(locale: Option<&str>) {
    let resolved = locale
        .map(teamclu_gateway::i18n::Locale::parse_or_default)
        .unwrap_or(teamclu_gateway::i18n::Locale::En);
    teamclu_gateway::i18n::set_locale(resolved);
}

/// Detect placeholder / half-resolved send targets that must never reach a
/// channel adapter (issue #549). Returns `Some(reason)` when the target is
/// unusable, `None` when it looks like a real `user:<id>` / `chat:<id>`
/// (optionally `bot:<bot_id>/` prefixed) route.
///
/// Guards against the observed failure where an unresolved originating chat
/// produced a target such as `current` or `chat:current`, which WeCom would
/// silently misroute while the send was still reported as delivered.
/// Pull an optional single attachment out of a `channel-send` envelope.
///
/// Base64 because the control channel is one line of JSON — the same shape the
/// desktop's `introspect_api` already spoke, so moving that caller onto the
/// daemon did not need a new transport.
fn decode_channel_send_media(
    payload: &serde_json::Value,
) -> anyhow::Result<Option<crate::channels::manager::OutboundMedia>> {
    use base64::Engine as _;

    let Some(b64) = payload.get("media_base64").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    if b64.is_empty() {
        return Ok(None);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| anyhow::anyhow!("channel-send: invalid media_base64: {e}"))?;
    let filename = payload
        .get("media_filename")
        .and_then(|v| v.as_str())
        .filter(|f| !f.trim().is_empty())
        .unwrap_or("file")
        .to_string();
    Ok(Some(crate::channels::manager::OutboundMedia {
        bytes,
        filename,
    }))
}

fn placeholder_target_reason(target: &str) -> Option<&'static str> {
    let target = target.trim();
    if target.is_empty() {
        return Some("empty target");
    }
    // Peel an optional `bot:<bot_id>/` bot selector so we validate the real
    // `user:`/`chat:` route underneath it.
    let route = match target.strip_prefix("bot:") {
        Some(rest) => match rest.split_once('/') {
            Some((bot, r)) if !bot.is_empty() && !r.is_empty() => r,
            _ => return Some("malformed bot selector"),
        },
        None => target,
    };
    let (kind, id) = match route.split_once(':') {
        Some(pair) => pair,
        // No `kind:id` shape — a bare `current` / free string is a placeholder.
        None => return Some("missing 'user:'/'chat:' prefix"),
    };
    if !matches!(kind, "user" | "chat") {
        return Some("unknown target kind");
    }
    let id = id.trim();
    if id.is_empty() {
        return Some("empty id");
    }
    if id.eq_ignore_ascii_case("current") {
        return Some("unresolved 'current' placeholder");
    }
    None
}

/// Split `channels.model` into the `(provider, model)` pair the spawn path
/// wants, mirroring how `/model` stores a chat's own choice.
///
/// Splits on the **first** slash only: `resolve_initial_model` rejoins with a
/// single `/`, so an id whose model segment contains slashes must keep them on
/// the model side to survive the round trip.
///
/// A ref with no slash yields an empty provider, which `resolve_initial_model`
/// already treats as "pass the model through unchanged".
fn split_gateway_model(raw: Option<&str>) -> Option<(String, String)> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(match raw.split_once('/') {
        Some((provider, model)) if !model.trim().is_empty() => {
            (provider.trim().to_string(), model.trim().to_string())
        }
        // "provider/" is a half-written setting, not a model — treat the whole
        // thing as a bare model id rather than spawning on an empty name.
        _ => (String::new(), raw.trim_end_matches('/').to_string()),
    })
}

#[cfg(test)]
mod gateway_model_tests {
    use super::split_gateway_model;

    #[test]
    fn splits_provider_and_model_on_the_first_slash() {
        assert_eq!(
            split_gateway_model(Some("anthropic/claude-sonnet-4-6")),
            Some(("anthropic".into(), "claude-sonnet-4-6".into()))
        );
        // Model segments can carry slashes; only the first one is the provider
        // boundary, or `resolve_initial_model` would rejoin a different id.
        assert_eq!(
            split_gateway_model(Some("openrouter/meta/llama-4")),
            Some(("openrouter".into(), "meta/llama-4".into()))
        );
    }

    #[test]
    fn unset_stays_unset_so_the_old_unpinned_spawn_is_preserved() {
        assert_eq!(split_gateway_model(None), None);
        assert_eq!(split_gateway_model(Some("")), None);
        assert_eq!(split_gateway_model(Some("   ")), None);
    }

    #[test]
    fn a_bare_model_id_gets_an_empty_provider() {
        // `resolve_initial_model` passes the model through untouched when the
        // provider is empty, which is what a claude-style short name needs.
        assert_eq!(
            split_gateway_model(Some("claude-sonnet-4-6")),
            Some((String::new(), "claude-sonnet-4-6".into()))
        );
        // Half-written "provider/" must not spawn on an empty model name.
        assert_eq!(
            split_gateway_model(Some("anthropic/")),
            Some((String::new(), "anthropic".into()))
        );
    }
}

/// The chat a `mcp-send` envelope is allowed to reach.
///
/// The token is the whole authorization story, which is why an envelope
/// without one is rejected before anything else is even parsed. `send` is
/// registered per workspace now, so every session there can see the tool —
/// including desktop conversations that were never bound to a chat. Those have
/// no token, so they have no destination, and an explicit `target` does not
/// rescue them: overrides only narrow within a chat a token already proved the
/// caller belongs to.
fn binding_from_reply_token(payload: &serde_json::Value) -> anyhow::Result<String> {
    let reply_token = payload
        .get("reply_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if reply_token.is_empty() {
        anyhow::bail!(
            "mcp-send: missing 'reply_token' — pass the reply token from this chat's prompt; \
             a session that is not bound to a chat cannot send"
        );
    }
    crate::channels::reply_token::binding_for(reply_token).ok_or_else(|| {
        anyhow::anyhow!(
            "mcp-send: unknown 'reply_token' — use the token from the most recent \
             message in this chat"
        )
    })
}

#[cfg(test)]
mod reply_token_gate_tests {
    use super::binding_from_reply_token;
    use crate::channels::reply_token;
    use serde_json::json;

    #[test]
    fn a_registered_token_resolves_to_its_chat() {
        let binding = "wecom://bot/bot/single/gate-ok";
        let token = reply_token::register(binding);
        let resolved = binding_from_reply_token(&json!({ "reply_token": token })).unwrap();
        assert_eq!(resolved, binding);
    }

    #[test]
    fn no_token_is_refused() {
        let err = binding_from_reply_token(&json!({}))
            .unwrap_err()
            .to_string();
        assert!(err.contains("reply_token"), "got: {err}");
        // Blank and whitespace are the same as absent — a model that echoed an
        // empty placeholder must not fall through to some default chat.
        assert!(binding_from_reply_token(&json!({ "reply_token": "" })).is_err());
        assert!(binding_from_reply_token(&json!({ "reply_token": "   " })).is_err());
    }

    #[test]
    fn an_unknown_token_is_refused() {
        assert!(binding_from_reply_token(&json!({ "reply_token": "not-a-real-token" })).is_err());
    }

    #[test]
    fn an_explicit_target_does_not_substitute_for_a_token() {
        // The decision this encodes: a session with no chat of its own cannot
        // address one by naming it. Overrides narrow, they do not authorize.
        let err = binding_from_reply_token(&json!({
            "target_override": "user:someone-else",
            "channel_override": "wecom",
        }))
        .unwrap_err()
        .to_string();
        assert!(err.contains("reply_token"), "got: {err}");
    }

    #[test]
    fn a_stale_binding_field_is_ignored() {
        // An older worktree config still passes `binding` in argv. Honouring it
        // would reopen the hole the token closes.
        assert!(binding_from_reply_token(&json!({
            "binding": "wecom://bot/bot/single/someone-else",
        }))
        .is_err());
    }
}

#[cfg(test)]
mod channel_send_tests {
    use serde_json::json;

    /// The validation `handle_channel_send` runs before it touches the channel
    /// manager, lifted out so it can be exercised without a running daemon.
    fn missing_field(payload: &serde_json::Value) -> Option<&'static str> {
        for (key, name) in [("channel", "channel"), ("target", "target")] {
            if payload
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                return Some(name);
            }
        }
        if payload
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            return Some("message");
        }
        None
    }

    #[test]
    fn cron_delivery_needs_no_reply_token() {
        // The whole point of the separate command: a cron announcement has no
        // chat behind it, so it cannot carry the token `mcp-send` demands.
        let payload = json!({
            "cmd": "channel-send",
            "channel": "wecom",
            "target": "chat:wrOOClYg",
            "message": "nightly build is green",
        });
        assert!(payload.get("reply_token").is_none());
        assert_eq!(missing_field(&payload), None);
    }

    #[test]
    fn an_incomplete_send_is_refused_before_dispatch() {
        assert_eq!(
            missing_field(&json!({"channel": "", "target": "chat:c", "message": "x"})),
            Some("channel")
        );
        assert_eq!(
            missing_field(&json!({"channel": "wecom", "target": "", "message": "x"})),
            Some("target")
        );
        // An empty announcement is a bug upstream, not a message worth sending.
        assert_eq!(
            missing_field(&json!({"channel": "wecom", "target": "chat:c", "message": "  "})),
            Some("message")
        );
    }

    #[test]
    fn the_old_placeholder_route_stays_refused() {
        // Cron used to send `wecom://cron/cron/single/placeholder`; if anything
        // reintroduces a stand-in target it must fail loudly, not deliver into
        // the void while reporting success.
        assert!(super::placeholder_target_reason("chat:current").is_some());
        assert!(super::placeholder_target_reason("chat:").is_some());
    }
}

#[cfg(test)]
mod mcp_send_target_tests {
    use super::placeholder_target_reason;

    #[test]
    fn accepts_real_routes() {
        assert!(placeholder_target_reason("user:u-123").is_none());
        assert!(placeholder_target_reason("chat:c-456").is_none());
        assert!(placeholder_target_reason("bot:botA/chat:c-456").is_none());
    }

    #[test]
    fn rejects_current_and_empty_placeholders() {
        // Bare / prefixed `current` — the core issue #549 misroute.
        assert!(placeholder_target_reason("current").is_some());
        assert!(placeholder_target_reason("chat:current").is_some());
        assert!(placeholder_target_reason("user:current").is_some());
        assert!(placeholder_target_reason("chat:CURRENT").is_some());
        assert!(placeholder_target_reason("bot:botA/chat:current").is_some());
        // Empty / half-resolved routes.
        assert!(placeholder_target_reason("").is_some());
        assert!(placeholder_target_reason("   ").is_some());
        assert!(placeholder_target_reason("chat:").is_some());
        assert!(placeholder_target_reason("chat: ").is_some());
        // Wrong / missing kind.
        assert!(placeholder_target_reason("room:x").is_some());
        assert!(placeholder_target_reason("bot:botA/").is_some());
    }
}
