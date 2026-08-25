//! Channel manager: boot and shut down `teamclu_gateway` channels based on
//! `[channels.*]` entries in `daemon.toml`. Each gateway is constructed with
//! shared `AgentHandle` + `ChannelStore` adapters, populated with its per-channel
//! config (translated from `DaemonConfig`'s primitive fields into the gateway
//! crate's own config structs), and then started.
//!
//! The manager owns the gateway instances and tears them down via consuming
//! `shutdown(self)` calls when the daemon stops.

use std::sync::Arc;
use tokio::sync::Mutex;

use teamclu_gateway::{
    AgentHandle, ChannelStore, DiscordConfig, DiscordGateway, EmailConfig, EmailGateway,
    EmailGatewayStatus, EmailProvider, FeishuConfig, FeishuGateway, FeishuGatewayStatus,
    GatewayStatus, KookConfig, KookDmConfig, KookGateway, KookGatewayStatus, SeaTalkConfig,
    SeaTalkGateway, SeaTalkGatewayStatus, WeChatConfig, WeChatGateway, WeChatGatewayStatus,
    WeComConfig, WeComGateway, WeComGatewayStatus,
};

use crate::config::{
    DaemonConfig, DiscordChannel, EmailChannel, FeishuChannel, KookChannel, SeaTalkChannel,
    WeChatChannel, WeComChannel,
};

#[derive(Default)]
struct RunningChannels {
    discord: Option<DiscordGateway>,
    wecom: Vec<WeComGateway>,
    feishu: Option<FeishuGateway>,
    kook: Option<KookGateway>,
    wechat: Option<WeChatGateway>,
    email: Option<EmailGateway>,
    seatalk: Option<SeaTalkGateway>,
}

/// A file on its way out to a chat, already uploaded and recorded as a session
/// attachment.
///
/// The bytes are carried rather than re-read from disk so there is exactly one
/// read per send, and — more to the point — so `dispatch_send` cannot be handed
/// a path it would push without the session ever knowing (#933).
pub struct OutboundMedia {
    pub bytes: Vec<u8>,
    pub filename: String,
}

pub struct ChannelManager {
    cfg: DaemonConfig,
    acp: Arc<dyn AgentHandle>,
    store: Arc<dyn ChannelStore>,
    team_id: String,
    primary_agent_actor_id: String,
    agent_owner_actor_ids: Vec<String>,
    /// Filesystem root that gateways may use for per-workspace state
    /// (`.teamclu/email.db`, persisted iLink context tokens, etc.). For the
    /// amuxd-managed case this defaults to the amux config dir.
    workspace_path: String,
    running: Mutex<RunningChannels>,
}

impl ChannelManager {
    pub fn new(
        cfg: DaemonConfig,
        acp: Arc<dyn AgentHandle>,
        store: Arc<dyn ChannelStore>,
        team_id: String,
        primary_agent_actor_id: String,
        agent_owner_actor_ids: Vec<String>,
    ) -> Self {
        // The team's own worktree, not the daemon home. Passing the home here
        // made every workspace-meta write land inside it — that is where the
        // stray `~/.amuxd/.teamclaw/teamclaw.json` came from.
        let workspace_path = crate::config::layout::team_workspace_dir(&team_id)
            .to_string_lossy()
            .into_owned();
        Self {
            cfg,
            acp,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
            workspace_path,
            running: Mutex::new(RunningChannels::default()),
        }
    }

    /// The session store the channels write through. Exposed so the MCP send
    /// path can record what it sends: a file the agent pushes to a chat has to
    /// become a message in that chat's session too, or it exists only in the
    /// chat app.
    pub fn store(&self) -> &Arc<dyn ChannelStore> {
        &self.store
    }

    /// The actor gateway replies are attributed to.
    pub fn agent_actor_id(&self) -> &str {
        &self.primary_agent_actor_id
    }

    /// The inbound edge for one channel: its driver plus the shared pipeline.
    ///
    /// A fresh `Core` per channel is deliberate — the dedup store is
    /// per-channel-keyed anyway, and sharing one would make a channel's restart
    /// silently inherit another's memory of what it had already seen.
    fn core_sink_for(
        &self,
        driver: Arc<dyn teamclu_gateway::driver::ChannelDriver>,
    ) -> Arc<dyn teamclu_gateway::driver::InboundSink> {
        use crate::channels::core::{adapters, dedup, sink, Core};
        let core = Core {
            dedup: Arc::new(dedup::MemoryDedup::default()),
            router: Arc::new(adapters::StoreRouter {
                store: self.store.clone(),
                team_id: self.team_id.clone(),
                primary_agent_actor_id: self.primary_agent_actor_id.clone(),
                agent_owner_actor_ids: self.agent_owner_actor_ids.clone(),
            }),
            identity: Arc::new(adapters::StoreIdentity {
                store: self.store.clone(),
                team_id: self.team_id.clone(),
                source: driver.id(),
            }),
            writer: Arc::new(adapters::StoreWriter {
                store: self.store.clone(),
                agent_actor_id: self.primary_agent_actor_id.clone(),
                team_id: self.team_id.clone(),
            }),
            turns: Arc::new(adapters::AgentTurns {
                agent: self.acp.clone(),
                turn_timeout: std::time::Duration::from_secs(driver.caps().turn_timeout_secs),
            }),
            commands: Arc::new(adapters::GatewayCommands {
                agent: self.acp.clone(),
                store: self.store.clone(),
            }),
        };
        Arc::new(sink::CoreSink {
            core: Arc::new(core),
            // A queued message is given one full turn to reach the front. Any
            // shorter and a message waiting behind a healthy long turn gets
            // dropped for being late.
            queue: Arc::new(
                teamclu_gateway::session_queue::SessionQueue::with_message_timeout(
                    std::time::Duration::from_secs(driver.caps().turn_timeout_secs),
                ),
            ),
            driver,
        })
    }

    /// The team these channels belong to. Used to build attachment bucket
    /// paths, which are team-scoped.
    pub fn team_id(&self) -> &str {
        &self.team_id
    }

    /// Override the workspace path the gateways will use (e.g. for tests or
    /// when the daemon wants channels to share a specific workspace's state).
    #[allow(dead_code)]
    pub fn with_workspace_path(mut self, workspace_path: impl Into<String>) -> Self {
        self.workspace_path = workspace_path.into();
        self
    }

    /// Start every channel whose `[channels.<name>]` section has `enabled = true`.
    ///
    /// Errors from individual channels are logged but do not abort startup of
    /// the remaining channels — running 4 out of 5 is better than 0 out of 5.
    pub async fn start_enabled(&self) -> anyhow::Result<()> {
        let mut running = self.running.lock().await;

        if let Some(c) = &self.cfg.channels.discord {
            if c.enabled {
                match self.start_discord(c).await {
                    Ok(g) => {
                        println!("[ChannelManager] discord started");
                        running.discord = Some(g);
                    }
                    Err(e) => eprintln!("[ChannelManager] discord start failed: {e}"),
                }
            }
        }

        if let Some(c) = &self.cfg.channels.wecom {
            if c.enabled {
                running.wecom = self.start_wecom_bots(c).await;
            }
        }

        if let Some(c) = &self.cfg.channels.feishu {
            if c.enabled {
                match self.start_feishu(c).await {
                    Ok(g) => {
                        println!("[ChannelManager] feishu started");
                        running.feishu = Some(g);
                    }
                    Err(e) => eprintln!("[ChannelManager] feishu start failed: {e}"),
                }
            }
        }

        if let Some(c) = &self.cfg.channels.kook {
            if c.enabled {
                match self.start_kook(c).await {
                    Ok(g) => {
                        println!("[ChannelManager] kook started");
                        running.kook = Some(g);
                    }
                    Err(e) => eprintln!("[ChannelManager] kook start failed: {e}"),
                }
            }
        }

        if let Some(c) = &self.cfg.channels.wechat {
            if c.enabled {
                match self.start_wechat(c).await {
                    Ok(g) => {
                        println!("[ChannelManager] wechat started");
                        running.wechat = Some(g);
                    }
                    Err(e) => eprintln!("[ChannelManager] wechat start failed: {e}"),
                }
            }
        }

        if let Some(c) = &self.cfg.channels.email {
            if c.enabled {
                match self.start_email(c).await {
                    Ok(g) => {
                        println!("[ChannelManager] email started");
                        running.email = Some(g);
                    }
                    Err(e) => eprintln!("[ChannelManager] email start failed: {e}"),
                }
            }
        }

        if let Some(c) = &self.cfg.channels.seatalk {
            if c.enabled {
                match self.start_seatalk(c).await {
                    Ok(g) => {
                        println!("[ChannelManager] seatalk started");
                        running.seatalk = Some(g);
                    }
                    Err(e) => eprintln!("[ChannelManager] seatalk start failed: {e}"),
                }
            }
        }

        Ok(())
    }

    /// Send a proactive message and/or file to a channel target. Called by
    /// `DaemonServer::handle_mcp_send` after parsing the binding URI from
    /// the bridging `amuxd mcp-server` subcommand.
    ///
    /// `target` shape is `user:<id>` or `chat:<id>`; per-channel adapters
    /// translate that into native IDs (for WeCom, `user` → single chat with
    /// chat_type=1, `chat` → group chat with chat_type=2; for SeaTalk,
    /// `user` → employee_code DM, `chat` → group_id). WeCom and SeaTalk are
    /// wired; other channels return an explanatory error until ported.
    ///
    /// Takes bytes, not a path (#933): this used to read the file off disk
    /// itself, which is how a file could reach a chat without ever becoming a
    /// session attachment. Now the only way to get an `OutboundMedia` is to
    /// have gone through the session write first, so the ordering is a
    /// property of the signature rather than of the caller remembering.
    pub async fn dispatch_send(
        &self,
        channel: &str,
        target: &str,
        message: Option<&str>,
        media: Option<OutboundMedia>,
    ) -> anyhow::Result<()> {
        let running = self.running.lock().await;
        match channel {
            "wecom" => {
                if running.wecom.is_empty() {
                    anyhow::bail!("wecom not running");
                }
                let (want_bot, target) = select_wecom_target(target);
                let g = match want_bot {
                    Some(want) => {
                        let mut found = None;
                        for gw in running.wecom.iter() {
                            if gw.bot_id().await == want {
                                found = Some(gw);
                                break;
                            }
                        }
                        found.ok_or_else(|| anyhow::anyhow!("no running wecom bot '{want}'"))?
                    }
                    None => &running.wecom[0],
                };
                let (kind, id) = parse_send_target(target)?;
                let media: Option<(Vec<u8>, String)> = media.map(|m| (m.bytes, m.filename));
                let text = message.unwrap_or("");
                let result = match kind {
                    "user" => g.send_to_user_with_optional_media(id, text, media).await,
                    "chat" => g.send_to_chat_with_optional_media(id, text, media).await,
                    other => anyhow::bail!("unknown target kind: {other}"),
                };
                result.map_err(|e| anyhow::anyhow!("wecom send: {e}"))
            }
            "seatalk" => {
                let g = running
                    .seatalk
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("seatalk not running"))?;
                let (kind, id) = parse_send_target(target)?;
                let text = message.unwrap_or("");
                if media.is_some() {
                    anyhow::bail!("seatalk: file send not supported yet");
                }
                let result = match kind {
                    "user" => g.send_to_user(id, text).await,
                    "chat" => g.send_to_chat(id, text).await,
                    other => anyhow::bail!("unknown target kind: {other}"),
                };
                result.map_err(|e| anyhow::anyhow!("seatalk send: {e}"))
            }
            "feishu" | "discord" | "kook" | "wechat" | "email" => {
                anyhow::bail!(
                    "{channel}: send not yet implemented in v2; only WeCom/SeaTalk are wired"
                )
            }
            other => anyhow::bail!("unknown channel: {other}"),
        }
    }

    /// Snapshot which channels have reached their native connected state.
    /// Returned as a tuple of `(platform, connected, last_error)` in a stable order
    /// matching the six supported channels. Used by the `channel-status`
    /// sock command so the desktop UI can show per-channel state without
    /// reaching into gateway internals.
    pub async fn status_snapshot(&self) -> Vec<(&'static str, bool, Option<String>)> {
        let running = self.running.lock().await;
        let discord = match running.discord.as_ref() {
            Some(g) => {
                let status = g.get_status().await;
                (
                    status.status == GatewayStatus::Connected,
                    status.error_message,
                )
            }
            None => (false, None),
        };
        let wecom = {
            let mut connected = false;
            let mut err = None;
            for g in running.wecom.iter() {
                let s = g.get_status().await;
                connected |= s.status == WeComGatewayStatus::Connected;
                if err.is_none() {
                    err = s.error_message;
                }
            }
            (connected, err)
        };
        let feishu = match running.feishu.as_ref() {
            Some(g) => {
                let status = g.get_status().await;
                (
                    status.status == FeishuGatewayStatus::Connected,
                    status.error_message,
                )
            }
            None => (false, None),
        };
        let kook = match running.kook.as_ref() {
            Some(g) => {
                let status = g.get_status().await;
                (
                    status.status == KookGatewayStatus::Connected,
                    status.error_message,
                )
            }
            None => (false, None),
        };
        let wechat = match running.wechat.as_ref() {
            Some(g) => {
                let status = g.get_status().await;
                (
                    status.status == WeChatGatewayStatus::Connected,
                    status.error_message,
                )
            }
            None => (false, None),
        };
        let email = match running.email.as_ref() {
            Some(g) => {
                let status = g.get_status().await;
                (
                    status.status == EmailGatewayStatus::Connected,
                    status.error_message,
                )
            }
            None => (false, None),
        };
        let seatalk = match running.seatalk.as_ref() {
            Some(g) => {
                let status = g.get_status().await;
                (
                    status.status == SeaTalkGatewayStatus::Connected,
                    status.error_message,
                )
            }
            None => (false, None),
        };

        vec![
            ("discord", discord.0, discord.1),
            ("wecom", wecom.0, wecom.1),
            ("feishu", feishu.0, feishu.1),
            ("kook", kook.0, kook.1),
            ("wechat", wechat.0, wechat.1),
            ("email", email.0, email.1),
            ("seatalk", seatalk.0, seatalk.1),
        ]
    }

    /// Per-bot WeCom status: `(bot_id, connected, last_error)`.
    pub async fn wecom_bots_status(&self) -> Vec<(String, bool, Option<String>)> {
        let running = self.running.lock().await;
        let mut out = Vec::new();
        for g in running.wecom.iter() {
            let s = g.get_status().await;
            out.push((
                g.bot_id().await,
                s.status == WeComGatewayStatus::Connected,
                s.error_message,
            ));
        }
        out
    }

    /// Stop every running channel. Takes `self` by value so each gateway's
    /// consuming `shutdown(self)` can be invoked.
    pub async fn shutdown(self) {
        let mut running = self.running.into_inner();
        if let Some(g) = running.discord.take() {
            g.shutdown().await;
        }
        for g in std::mem::take(&mut running.wecom) {
            g.shutdown().await;
        }
        if let Some(g) = running.feishu.take() {
            g.shutdown().await;
        }
        if let Some(g) = running.kook.take() {
            g.shutdown().await;
        }
        if let Some(g) = running.wechat.take() {
            g.shutdown().await;
        }
        if let Some(g) = running.email.take() {
            g.shutdown().await;
        }
        if let Some(g) = running.seatalk.take() {
            g.shutdown().await;
        }
    }

    // ----- per-channel constructors -----

    async fn start_discord(&self, c: &DiscordChannel) -> anyhow::Result<DiscordGateway> {
        let gw = DiscordGateway::new(
            self.acp.clone(),
            self.store.clone(),
            self.team_id.clone(),
            self.primary_agent_actor_id.clone(),
            self.agent_owner_actor_ids.clone(),
        );
        let mut cfg = DiscordConfig {
            enabled: true,
            token: c.bot_token.clone(),
            ..Default::default()
        };
        // Plumb optional default DM username into the DM allow-list when provided
        // so the operator can verify the bot answers DMs from at least themselves
        // without editing teamclu.json directly. Leave alone otherwise.
        if let Some(name) = &c.default_username {
            if !name.is_empty() {
                cfg.dm.allow_from.push(name.clone());
            }
        }
        gw.set_config(cfg).await;
        // Discord gains dedup, commands and long-answer splitting from the
        // core; the inline path had its own tracker and its own filters.
        gw.use_core_pipeline(self.core_sink_for(Arc::new(gw.as_driver().await)))
            .await;
        gw.start().await.map_err(|e| anyhow::anyhow!(e))?;
        Ok(gw)
    }

    /// Boot one `WeComGateway` (one WSS connection) per enabled bot. Per-bot
    /// workspace/agent/prompt are applied inside the shared `AgentHandle` via
    /// the bot_configs registry; the gateway itself only needs
    /// bot_id/secret/encoding_aes_key to connect.
    async fn start_wecom_bots(&self, c: &WeComChannel) -> Vec<WeComGateway> {
        let mut started = Vec::new();
        for bot in c.resolved_bots().into_iter().filter(|b| b.enabled) {
            let gw = WeComGateway::new(
                self.acp.clone(),
                self.store.clone(),
                self.team_id.clone(),
                self.primary_agent_actor_id.clone(),
                self.agent_owner_actor_ids.clone(),
                self.workspace_path.clone(),
            );
            let cfg = WeComConfig {
                enabled: true,
                bot_id: bot.bot_id.clone(),
                secret: bot.secret.clone(),
                encoding_aes_key: bot.encoding_aes_key.clone(),
                owner_id: None,
                bot_name: bot.bot_name.clone(),
            };
            gw.set_config(cfg).await;
            // One pipeline for every channel; the gateway is left with the
            // protocol.
            gw.use_core_pipeline(self.core_sink_for(Arc::new(gw.as_driver())))
                .await;
            match gw.start().await {
                Ok(()) => {
                    println!("[ChannelManager] wecom bot {} started", bot.bot_id);
                    started.push(gw);
                }
                Err(e) => eprintln!(
                    "[ChannelManager] wecom bot {} start failed: {e}",
                    bot.bot_id
                ),
            }
        }
        started
    }

    async fn start_feishu(&self, c: &FeishuChannel) -> anyhow::Result<FeishuGateway> {
        let gw = FeishuGateway::new(
            self.acp.clone(),
            self.store.clone(),
            self.team_id.clone(),
            self.primary_agent_actor_id.clone(),
            self.agent_owner_actor_ids.clone(),
        );
        let cfg = FeishuConfig {
            enabled: true,
            app_id: c.app_id.clone(),
            app_secret: c.app_secret.clone(),
            chats: Default::default(),
        };
        gw.set_config(cfg).await;
        // Feishu gains streaming from this: it always could edit a sent
        // message, the inline path just never did.
        gw.use_core_pipeline(self.core_sink_for(Arc::new(gw.as_driver().await)))
            .await;
        gw.start().await.map_err(|e| anyhow::anyhow!(e))?;
        Ok(gw)
    }

    async fn start_kook(&self, c: &KookChannel) -> anyhow::Result<KookGateway> {
        let gw = KookGateway::new(
            self.acp.clone(),
            self.store.clone(),
            self.team_id.clone(),
            self.primary_agent_actor_id.clone(),
            self.agent_owner_actor_ids.clone(),
            self.workspace_path.clone(),
        );
        let cfg = KookConfig {
            enabled: true,
            token: c.bot_token.clone(),
            // Default DM mode = open; the operator can lock down via the
            // gateway crate's `teamclu.json` if desired. Until the manager
            // is wired to a richer config we let DMs through.
            dm: KookDmConfig {
                enabled: true,
                policy: "open".to_string(),
                allow_from: Vec::new(),
            },
            guilds: Default::default(),
        };
        gw.set_config(cfg).await;
        // KOOK gains dedup, commands and a per-channel turn timeout here; the
        // inline path had its own tracker and its own command handling.
        gw.use_core_pipeline(self.core_sink_for(Arc::new(gw.as_driver().await)))
            .await;
        gw.start().await.map_err(|e| anyhow::anyhow!(e))?;
        Ok(gw)
    }

    async fn start_wechat(&self, c: &WeChatChannel) -> anyhow::Result<WeChatGateway> {
        let gw = WeChatGateway::new(
            self.acp.clone(),
            self.store.clone(),
            self.team_id.clone(),
            self.primary_agent_actor_id.clone(),
            self.agent_owner_actor_ids.clone(),
            self.workspace_path.clone(),
        );
        let cfg = WeChatConfig {
            enabled: true,
            account_id: c.ilink_account.clone(),
            bot_token: c.ilink_token.clone(),
            ..Default::default()
        };
        gw.set_config(cfg).await;
        // WeChat gains dedup (it had none — iLink redelivery meant a repeat
        // turn), commands and a per-channel turn timeout.
        gw.use_core_pipeline(self.core_sink_for(Arc::new(gw.as_driver().await)))
            .await;
        gw.start().await.map_err(|e| anyhow::anyhow!(e))?;
        Ok(gw)
    }

    async fn start_email(&self, c: &EmailChannel) -> anyhow::Result<EmailGateway> {
        let gw = EmailGateway::new(
            self.acp.clone(),
            self.store.clone(),
            self.team_id.clone(),
            self.primary_agent_actor_id.clone(),
            self.agent_owner_actor_ids.clone(),
        );
        // EmailGateway's IMAP/SMTP "Custom" provider mode maps directly onto
        // the daemon-side EmailChannel primitive fields. Gmail OAuth flow
        // remains a Tauri-side concern and is not exposed via daemon.toml.
        let cfg = EmailConfig {
            enabled: true,
            provider: EmailProvider::Custom,
            imap_server: c.imap_host.clone(),
            imap_port: c.imap_port,
            smtp_server: c.smtp_host.clone(),
            smtp_port: c.smtp_port,
            username: c.imap_user.clone(),
            password: c.imap_pass.clone(),
            allowed_senders: c.allowed_senders.clone(),
            ..Default::default()
        };
        gw.set_workspace_path(&self.workspace_path).await;
        gw.set_config(cfg).await;
        // Email gains commands, one dedup mechanism instead of its own UID
        // watermark, and a 900s turn timeout — the IM-shaped 180s would abandon
        // a normal mail round trip.
        gw.use_core_pipeline(self.core_sink_for(Arc::new(gw.as_driver().await)))
            .await;
        gw.start().await.map_err(|e| anyhow::anyhow!(e))?;
        Ok(gw)
    }

    async fn start_seatalk(&self, c: &SeaTalkChannel) -> anyhow::Result<SeaTalkGateway> {
        let gw = SeaTalkGateway::new(
            self.acp.clone(),
            self.store.clone(),
            self.team_id.clone(),
            self.primary_agent_actor_id.clone(),
            self.agent_owner_actor_ids.clone(),
        );
        let cfg = SeaTalkConfig {
            enabled: true,
            app_id: c.app_id.clone(),
            app_secret: c.app_secret.clone(),
            mode: if c.mode.is_empty() {
                "websocket".to_string()
            } else {
                c.mode.clone()
            },
            dm_policy: if c.dm_policy.is_empty() {
                "open".to_string()
            } else {
                c.dm_policy.clone()
            },
            allow_from: c.allow_from.clone(),
            group_policy: if c.group_policy.is_empty() {
                "open".to_string()
            } else {
                c.group_policy.clone()
            },
            group_allow_from: c.group_allow_from.clone(),
            ..Default::default()
        };
        let dm_thread = cfg.dm_thread_session;
        let group_thread = cfg.group_thread_session;
        gw.set_config(cfg).await;
        // SeaTalk gains dedup, commands, attachments-as-text and a per-channel
        // turn timeout from this; it had none of them on the inline path.
        gw.use_core_pipeline(
            self.core_sink_for(Arc::new(
                gw.as_driver()
                    .await
                    .with_thread_sessions(dm_thread, group_thread),
            )),
        )
        .await;
        gw.start().await.map_err(|e| anyhow::anyhow!(e))?;
        Ok(gw)
    }
}

/// Choose which WeCom bot gateway handles a send. A `bot:<bot_id>/<rest>`
/// prefix pins a specific bot; otherwise the first running bot is used.
/// Returns the optional bot id and the remaining target string.
fn select_wecom_target(target: &str) -> (Option<&str>, &str) {
    if let Some(rest) = target.strip_prefix("bot:") {
        if let Some((bot_id, rest)) = rest.split_once('/') {
            return (Some(bot_id), rest);
        }
    }
    (None, target)
}

/// Parse a `user:<id>` / `chat:<id>` target string into `(kind, id)`.
///
/// Rejects an empty id as defense-in-depth: `handle_mcp_send` already gates
/// placeholder routes (issue #549), but this is the last hop before the WeCom
/// API and must never forward a `chat:`/`user:` with no id.
fn parse_send_target(target: &str) -> anyhow::Result<(&str, &str)> {
    let (kind, id) = target.split_once(':').ok_or_else(|| {
        anyhow::anyhow!("target must be 'user:<id>' or 'chat:<id>', got: {target}")
    })?;
    if id.trim().is_empty() {
        anyhow::bail!("target '{target}' has an empty id");
    }
    Ok((kind, id))
}

#[cfg(test)]
mod tests {
    use super::{parse_send_target, select_wecom_target};

    #[test]
    fn select_wecom_target_strips_bot_prefix() {
        let (bot, rest) = select_wecom_target("bot:botA/user:alice");
        assert_eq!(bot, Some("botA"));
        assert_eq!(parse_send_target(rest).unwrap(), ("user", "alice"));
        let (bot2, rest2) = select_wecom_target("user:bob");
        assert_eq!(bot2, None);
        assert_eq!(rest2, "user:bob");
    }

    #[test]
    fn parses_user_target() {
        assert_eq!(parse_send_target("user:alice").unwrap(), ("user", "alice"));
    }

    #[test]
    fn parses_chat_target() {
        assert_eq!(
            parse_send_target("chat:wrkgrp_123").unwrap(),
            ("chat", "wrkgrp_123")
        );
    }

    #[test]
    fn rejects_unstructured_target() {
        assert!(parse_send_target("alice").is_err());
    }
}
