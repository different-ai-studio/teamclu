use serenity::all::{
    async_trait, Client, Command, CommandOptionType, Context, CreateCommand, CreateCommandOption,
    CreateInteractionResponse, CreateInteractionResponseMessage, EditInteractionResponse,
    EditMessage, EventHandler, GatewayIntents, Http, Interaction, Message, Ready,
};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, RwLock};

use crate::config::{DiscordConfig, GatewayStatus, GatewayStatusResponse};

use crate::{
    i18n, AgentHandle, ChannelStore, FilterResult, ProcessedMessageTracker, MAX_PROCESSED_MESSAGES,
};

/// Discord bot handler
pub struct DiscordHandler {
    config: Arc<RwLock<DiscordConfig>>,
    agent: Arc<dyn AgentHandle>,
    store: Arc<dyn ChannelStore>,
    team_id: String,
    primary_agent_actor_id: String,
    agent_owner_actor_ids: Vec<String>,
    status_tx: mpsc::Sender<GatewayStatusResponse>,
    bot_user_id: Arc<RwLock<Option<u64>>>,
    /// Tracker for processed message IDs to prevent duplicate processing
    processed_messages: Arc<RwLock<ProcessedMessageTracker>>,
    /// Pending question store for question forwarding
    pending_questions: Arc<super::PendingQuestionStore>,
    /// Set once the daemon wires the core pipeline; the inline path is skipped.
    inbound_sink: Option<Arc<dyn crate::driver::InboundSink>>,
}

impl DiscordHandler {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: Arc<RwLock<DiscordConfig>>,
        agent: Arc<dyn AgentHandle>,
        store: Arc<dyn ChannelStore>,
        team_id: String,
        primary_agent_actor_id: String,
        agent_owner_actor_ids: Vec<String>,
        status_tx: mpsc::Sender<GatewayStatusResponse>,
        pending_questions: Arc<super::PendingQuestionStore>,
        inbound_sink: Option<Arc<dyn crate::driver::InboundSink>>,
    ) -> Self {
        Self {
            config,
            agent,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
            status_tx,
            bot_user_id: Arc::new(RwLock::new(None)),
            processed_messages: Arc::new(RwLock::new(ProcessedMessageTracker::new(
                MAX_PROCESSED_MESSAGES,
            ))),
            pending_questions,
            inbound_sink,
        }
    }

    /// Check if a message has already been processed, and mark it as processed if not
    async fn mark_message_processed(&self, message_id: u64) -> bool {
        let mut tracker = self.processed_messages.write().await;
        tracker.is_duplicate(&message_id.to_string())
    }

    /// Check if a message should be processed based on config
    async fn should_process_message(&self, msg: &Message, ctx: &Context) -> FilterResult {
        // Ignore bot messages
        if msg.author.bot {
            return FilterResult::Ignore;
        }

        let config = self.config.read().await;

        // Check if it's a DM
        if msg.guild_id.is_none() {
            return self
                .check_dm_allowed(&config, &msg.author.id.to_string())
                .await;
        }

        // It's a guild message
        let guild_id = msg.guild_id.unwrap().to_string();
        let channel_id = msg.channel_id.to_string();

        self.check_guild_allowed(&config, &guild_id, &channel_id, msg, ctx)
            .await
    }

    /// Check if DM is allowed for this user
    async fn check_dm_allowed(&self, config: &DiscordConfig, user_id: &str) -> FilterResult {
        if !config.dm.enabled {
            return FilterResult::Ignore;
        }

        match config.dm.policy.as_str() {
            "open" => FilterResult::Allow,
            "allowlist" => {
                if config.dm.allow_from.contains(&user_id.to_string())
                    || config.dm.allow_from.contains(&"*".to_string())
                {
                    FilterResult::Allow
                } else {
                    FilterResult::UserNotAllowed
                }
            }
            _ => FilterResult::Allow,
        }
    }

    /// Check if guild/channel message is allowed
    async fn check_guild_allowed(
        &self,
        config: &DiscordConfig,
        guild_id: &str,
        channel_id: &str,
        msg: &Message,
        _ctx: &Context,
    ) -> FilterResult {
        println!(
            "[Discord] check_guild_allowed: guild_id={}, channel_id={}",
            guild_id, channel_id
        );
        println!(
            "[Discord] Available guilds in config: {:?}",
            config.guilds.keys().collect::<Vec<_>>()
        );

        // Check wildcard guild config first
        let guild_config = config
            .guilds
            .get(guild_id)
            .or_else(|| config.guilds.get("*"));

        let guild_config = match guild_config {
            Some(c) => {
                println!("[Discord] Found guild config");
                c
            }
            None => {
                println!("[Discord] No guild config found for {}", guild_id);
                return FilterResult::ChannelNotConfigured;
            }
        };

        // Check if user is in guild allowlist (if specified)
        if !guild_config.users.is_empty() {
            let user_id = msg.author.id.to_string();
            println!(
                "[Discord] Checking user {} against allowlist: {:?}",
                user_id, guild_config.users
            );
            if !guild_config.users.contains(&user_id)
                && !guild_config.users.contains(&"*".to_string())
            {
                println!("[Discord] User not in allowlist");
                return FilterResult::UserNotAllowed;
            }
        }

        // Check channel config
        println!(
            "[Discord] Available channels in config: {:?}",
            guild_config.channels.keys().collect::<Vec<_>>()
        );
        let channel_config = guild_config
            .channels
            .get(channel_id)
            .or_else(|| guild_config.channels.get("*"));

        let (allow, require_mention) = match channel_config {
            Some(c) => {
                println!("[Discord] Found channel config: allow={}", c.allow);
                (
                    c.allow,
                    c.require_mention.unwrap_or(guild_config.require_mention),
                )
            }
            None => {
                println!("[Discord] No channel config found");
                // If no channel config and guild has channels specified, deny
                if !guild_config.channels.is_empty() {
                    println!("[Discord] Guild has channels but none match, denying");
                    return FilterResult::ChannelNotConfigured;
                }
                // Use guild-level require_mention
                (true, guild_config.require_mention)
            }
        };

        if !allow {
            println!("[Discord] Channel not allowed");
            return FilterResult::ChannelNotConfigured;
        }

        // Check if mention is required
        if require_mention {
            let bot_id = self.bot_user_id.read().await;
            if let Some(id) = *bot_id {
                let mentioned = msg.mentions_user_id(id);
                println!(
                    "[Discord] Require mention: bot_id={}, mentioned={}",
                    id, mentioned
                );
                if mentioned {
                    return FilterResult::Allow;
                } else {
                    return FilterResult::Ignore;
                }
            }
            println!("[Discord] Require mention but no bot_id");
            return FilterResult::Ignore;
        }

        println!("[Discord] Message allowed");
        FilterResult::Allow
    }

    /// Process a message via the amuxd agent runtime + ChannelStore.
    async fn process_message(&self, msg: &Message, ctx: &Context) {
        println!("[Discord] process_message called");
        let _config = self.config.read().await;
        let is_dm = msg.guild_id.is_none();
        println!("[Discord] is_dm: {}", is_dm);

        // Clean message content first (remove bot mention if present)
        let mut content = msg.content.clone();
        let bot_id_value = *self.bot_user_id.read().await;
        if let Some(id) = bot_id_value {
            content = content
                .replace(&format!("<@{}>", id), "")
                .replace(&format!("<@!{}>", id), "")
                .trim()
                .to_string();
        }

        if content.is_empty() {
            return;
        }

        let locale = i18n::locale();

        // Slash commands run off the one shared table. `/help` and `/skills`
        // need no session, so they answer here instead of opening one; the rest
        // fall through to the session-resolve path and dispatch there.
        let slash = crate::commands::parse_slash(&content);
        if let Some((cmd_name, cmd_arg)) = &slash {
            if !crate::commands::needs_session(cmd_name) {
                if let Ok(Some(reply_text)) = crate::commands::run_slash(
                    cmd_name,
                    cmd_arg.as_deref(),
                    self.agent.as_ref(),
                    self.store.as_ref(),
                    &String::new(),
                    locale,
                )
                .await
                {
                    let _ = msg.reply(&ctx.http, &reply_text).await;
                    return;
                }
            }
        }

        // Build the binding URI using application id (the bot's own user id)
        // and the channel id (works for both DMs and guild channels).
        // bot_user_id is populated in the `ready()` handler before any message
        // arrives, so this should always be Some by the time we get here.
        let application_id = match bot_id_value {
            Some(id) => id.to_string(),
            None => match ctx.http.get_current_user().await {
                Ok(user) => user.id.to_string(),
                Err(e) => {
                    eprintln!(
                        "[Discord] bot_user_id not initialized and get_current_user failed: {}",
                        e
                    );
                    let _ = msg
                        .reply(&ctx.http, format!("Error: bot not ready: {}", e))
                        .await;
                    return;
                }
            },
        };
        let binding = crate::binding::discord(&application_id, &msg.channel_id.to_string());

        // Resolve / create the external actor for the message author.
        let external_actor_id = match self
            .store
            .ensure_external_actor(
                &self.team_id,
                "discord",
                &crate::binding::urn_discord_user(&msg.author.id.to_string()),
                &msg.author.name,
            )
            .await
        {
            Ok(id) => id,
            Err(e) => {
                let _ = msg.reply(&ctx.http, format!("Error (actor): {}", e)).await;
                return;
            }
        };

        // Build a session title: DMs vs. channels.
        let session_title = if is_dm {
            format!("Discord DM: {}", msg.author.name)
        } else {
            format!("Discord: #{}", msg.channel_id)
        };

        let outcome = match self
            .store
            .ensure_session(
                &self.team_id,
                &binding,
                &session_title,
                &self.primary_agent_actor_id,
                &self.agent_owner_actor_ids,
                std::slice::from_ref(&external_actor_id),
            )
            .await
        {
            Ok(o) => o,
            Err(e) => {
                let _ = msg
                    .reply(&ctx.http, format!("Error (session): {}", e))
                    .await;
                return;
            }
        };

        if let Err(e) = self
            .store
            .add_participant(&outcome.session_id, &external_actor_id)
            .await
        {
            eprintln!("[Discord] add_participant failed: {}", e);
        }

        // Slash-command dispatch against the resolved session.
        if let Some((cmd_name, cmd_arg)) = &slash {
            let reply_text = crate::commands::run_slash(
                cmd_name,
                cmd_arg.as_deref(),
                self.agent.as_ref(),
                self.store.as_ref(),
                &outcome.acp_session_id,
                locale,
            )
            .await
            .unwrap_or(None)
            .unwrap_or_else(|| crate::commands::unknown_command_reply(cmd_name, locale));
            let _ = msg.reply(&ctx.http, &reply_text).await;
            return;
        }

        if let Err(e) = self
            .store
            .record_message(
                &outcome.session_id,
                &external_actor_id,
                &content,
                Some(&msg.id.to_string()),
            )
            .await
        {
            eprintln!("[Discord] record_message (user) failed: {}", e);
        }

        // Send immediate "Thinking..." reply so the user knows the bot is processing.
        let processing_msg = msg.reply(&ctx.http, "🤔 Thinking...").await.ok();
        let typing = msg.channel_id.start_typing(&ctx.http);

        // Drive a single agent turn through amuxd.
        let turn = self
            .agent
            .send_prompt(
                &outcome.acp_session_id,
                &msg.author.name,
                &content,
                crate::driver::ChannelCaps::MINIMAL.turn_timeout(),
            )
            .await;

        match turn {
            Ok(reply) => {
                if let Err(e) = self
                    .store
                    .record_agent_reply(
                        &outcome.session_id,
                        &self.primary_agent_actor_id,
                        &reply.reply_text,
                        None,
                    )
                    .await
                {
                    eprintln!("[Discord] record_agent_reply failed: {}", e);
                }

                let chunks = split_message(&reply.reply_text, 2000);
                if let Some(mut proc_msg) = processing_msg {
                    let edit = EditMessage::new().content(&chunks[0]);
                    let _ = proc_msg.edit(&ctx.http, edit).await;
                    for chunk in chunks.iter().skip(1) {
                        if let Err(e) = msg.channel_id.say(&ctx.http, chunk).await {
                            eprintln!("Failed to send Discord message: {}", e);
                        }
                    }
                } else {
                    let mut is_first = true;
                    for chunk in chunks {
                        let result = if is_first {
                            is_first = false;
                            msg.reply(&ctx.http, &chunk).await
                        } else {
                            msg.channel_id.say(&ctx.http, &chunk).await
                        };
                        if let Err(e) = result {
                            eprintln!("Failed to send Discord message: {}", e);
                        }
                    }
                }
            }
            Err(e) => {
                let err_text = format!("❌ Error: {}", e);
                if let Some(mut proc_msg) = processing_msg {
                    let edit = EditMessage::new().content(&err_text);
                    let _ = proc_msg.edit(&ctx.http, edit).await;
                } else {
                    let _ = msg.reply(&ctx.http, &err_text).await;
                }
            }
        }

        drop(typing);
    }

    /// Update gateway status
    async fn update_status(&self, status: GatewayStatusResponse) {
        let _ = self.status_tx.send(status).await;
    }
}

#[async_trait]
impl EventHandler for DiscordHandler {
    async fn message(&self, ctx: Context, msg: Message) {
        let message_id = msg.id.get();
        println!(
            "[Discord] Received message {} from {}: {}",
            message_id, msg.author.name, msg.content
        );

        // Check for duplicate message processing
        if self.mark_message_processed(message_id).await {
            println!(
                "[Discord] Message {} already processed, skipping",
                message_id
            );
            return;
        }

        // Check if this is a reply to a pending question
        if let Some(ref referenced) = msg.referenced_message {
            let ref_id = referenced.id.to_string();
            if let Some(entry) = self.pending_questions.take(&ref_id).await {
                let answer_text = msg.content.clone();
                let _ = entry.answer_tx.send(answer_text);
                println!(
                    "[Discord] Question {} answered via reply",
                    entry.question_id
                );
                return;
            }
        }

        // Check for /answer command — routes reply to the most recent pending question
        if let Some(answer_text) = super::PendingQuestionStore::parse_answer_command(&msg.content) {
            let locale = i18n::locale();
            if let Some(qid) = self.pending_questions.try_answer(answer_text).await {
                println!(
                    "[Discord] Question {} answered via /answer: {}",
                    qid, answer_text
                );
                let _ = msg
                    .reply(
                        &ctx.http,
                        &i18n::t(i18n::MsgKey::AnswerSubmitted(answer_text), locale),
                    )
                    .await;
            } else {
                let _ = msg
                    .reply(
                        &ctx.http,
                        &i18n::t(i18n::MsgKey::NoPendingQuestions, locale),
                    )
                    .await;
            }
            return;
        }

        // The core pipeline, when the daemon has wired it. Sits below the
        // pending-question branches (an answer is not a new turn) and above the
        // filter, because policy is the core's job now.
        if let Some(sink) = self.inbound_sink.clone() {
            let bot_id = *self.bot_user_id.read().await;
            if let Some(inbound) = normalize_message(&msg, bot_id) {
                sink.accept(inbound).await;
            }
            return;
        }

        let filter_result = self.should_process_message(&msg, &ctx).await;
        println!(
            "[Discord] Filter result: {:?}, guild_id: {:?}, channel_id: {}",
            filter_result, msg.guild_id, msg.channel_id
        );

        match filter_result {
            FilterResult::Allow => {
                println!("[Discord] Processing message {}...", message_id);
                self.process_message(&msg, &ctx).await;
                println!("[Discord] Message {} processed", message_id);
            }
            FilterResult::UserNotAllowed => {
                println!("[Discord] User not in whitelist, sending rejection");
                let _ = msg.reply(
                    &ctx.http,
                    "Sorry, you are not authorized to use this bot. Please contact the administrator to request access."
                ).await;
            }
            FilterResult::ChannelNotConfigured => {
                println!("[Discord] Channel not configured, sending hint");
                let _ = msg.reply(
                    &ctx.http,
                    "This channel is not configured for the bot. Please ask the administrator to add this server/channel in TeamClu settings."
                ).await;
            }
            FilterResult::Ignore => {
                println!("[Discord] Message filtered out (silent)");
            }
        }
    }

    async fn ready(&self, ctx: Context, ready: Ready) {
        println!("Discord bot connected as {}", ready.user.name);

        // Store bot user ID
        {
            let mut bot_id = self.bot_user_id.write().await;
            *bot_id = Some(ready.user.id.get());
        }

        // Register global slash commands
        println!("[Discord] Registering slash commands...");
        let commands = vec![
            CreateCommand::new("reset").description("Reset the current chat session with the AI"),
            CreateCommand::new("model")
                .description("View current model or switch to a different model")
                .add_option(
                    CreateCommandOption::new(
                        CommandOptionType::String,
                        "name",
                        "Model to switch to (format: provider/model)",
                    )
                    .required(false),
                ),
            CreateCommand::new("stop").description("Stop the current session's processing"),
            CreateCommand::new("sessions")
                .description("List recent sessions or switch to a session by number")
                .add_option(
                    CreateCommandOption::new(
                        CommandOptionType::Integer,
                        "number",
                        "Session number to switch to (from the list)",
                    )
                    .required(false),
                ),
            CreateCommand::new("help")
                .description("Show available commands and how to use the bot"),
        ];

        match Command::set_global_commands(&ctx.http, commands).await {
            Ok(cmds) => {
                println!(
                    "[Discord] Registered {} slash commands: {:?}",
                    cmds.len(),
                    cmds.iter().map(|c| &c.name).collect::<Vec<_>>()
                );
            }
            Err(e) => {
                println!("[Discord] Failed to register slash commands: {}", e);
            }
        }

        // Update status
        let guilds: Vec<String> = ready.guilds.iter().map(|g| g.id.to_string()).collect();

        self.update_status(GatewayStatusResponse {
            status: GatewayStatus::Connected,
            discord_connected: true,
            error_message: None,
            connected_guilds: guilds,
            bot_username: Some(ready.user.name.clone()),
        })
        .await;
    }

    async fn interaction_create(&self, ctx: Context, interaction: Interaction) {
        if let Interaction::Command(command) = interaction {
            println!("[Discord] Received slash command: {}", command.data.name);

            // Defer the response first to avoid the 3-second timeout.
            // This shows "Bot is thinking..." to the user.
            let defer = CreateInteractionResponse::Defer(
                CreateInteractionResponseMessage::new().ephemeral(true),
            );
            if let Err(e) = command.create_response(&ctx.http, defer).await {
                println!("[Discord] Failed to defer slash command: {}", e);
                return;
            }

            let locale = i18n::locale();

            // Registered application commands feed the same table as typed
            // ones: the command name is the command, and its single option (if
            // any) is the argument. Nothing here knows which commands exist —
            // that list lives in `commands::parse_meta`.
            let name = command.data.name.as_str();
            let arg = command
                .data
                .options
                .iter()
                .find_map(|opt| match &opt.value {
                    serenity::all::CommandDataOptionValue::String(s) => {
                        let t = s.trim();
                        (!t.is_empty()).then(|| t.to_string())
                    }
                    serenity::all::CommandDataOptionValue::Integer(n) => Some(n.to_string()),
                    _ => None,
                });

            let content = if crate::commands::needs_session(name) {
                // For /stop /reset /model we need a resolved acp_session_id.
                // Build the binding and ensure session exist.
                let bot_id_value = *self.bot_user_id.read().await;
                let application_id = match bot_id_value {
                    Some(id) => id.to_string(),
                    None => match ctx.http.get_current_user().await {
                        Ok(user) => user.id.to_string(),
                        Err(e) => {
                            let edit = EditInteractionResponse::new()
                                .content(format!("Error: bot not ready: {}", e));
                            let _ = command.edit_response(&ctx.http, edit).await;
                            return;
                        }
                    },
                };
                let binding =
                    crate::binding::discord(&application_id, &command.channel_id.to_string());
                let urn = crate::binding::urn_discord_user(&command.user.id.to_string());
                let display = command.user.name.clone();

                let external_actor_id = match self
                    .store
                    .ensure_external_actor(&self.team_id, "discord", &urn, &display)
                    .await
                {
                    Ok(id) => id,
                    Err(e) => {
                        let edit =
                            EditInteractionResponse::new().content(format!("Error (actor): {}", e));
                        let _ = command.edit_response(&ctx.http, edit).await;
                        return;
                    }
                };

                let is_dm = command.guild_id.is_none();
                let session_title = if is_dm {
                    format!("Discord DM: {}", display)
                } else {
                    format!("Discord: #{}", command.channel_id)
                };

                let outcome = match self
                    .store
                    .ensure_session(
                        &self.team_id,
                        &binding,
                        &session_title,
                        &self.primary_agent_actor_id,
                        &self.agent_owner_actor_ids,
                        std::slice::from_ref(&external_actor_id),
                    )
                    .await
                {
                    Ok(o) => o,
                    Err(e) => {
                        let edit = EditInteractionResponse::new()
                            .content(format!("Error (session): {}", e));
                        let _ = command.edit_response(&ctx.http, edit).await;
                        return;
                    }
                };

                crate::commands::run_slash(
                    name,
                    arg.as_deref(),
                    self.agent.as_ref(),
                    self.store.as_ref(),
                    &outcome.acp_session_id,
                    locale,
                )
                .await
                .unwrap_or(None)
                .unwrap_or_else(|| {
                    i18n::t(i18n::MsgKey::UnknownCommand(&format!("/{name}")), locale)
                })
            } else {
                crate::commands::run_slash(
                    name,
                    arg.as_deref(),
                    self.agent.as_ref(),
                    self.store.as_ref(),
                    &String::new(),
                    locale,
                )
                .await
                .unwrap_or(None)
                .unwrap_or_else(|| {
                    i18n::t(i18n::MsgKey::UnknownCommand(&format!("/{name}")), locale)
                })
            };

            // Edit the deferred response with the actual content
            let edit = EditInteractionResponse::new().content(content);
            if let Err(e) = command.edit_response(&ctx.http, edit).await {
                println!("[Discord] Failed to edit slash command response: {}", e);
            }
        }
    }
}

/// Split a message into chunks that fit Discord's limit
fn split_message(content: &str, max_len: usize) -> Vec<String> {
    if content.len() <= max_len {
        return vec![content.to_string()];
    }

    let mut chunks = Vec::new();
    let mut current = String::new();

    for line in content.lines() {
        if current.len() + line.len() + 1 > max_len {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            // If single line is too long, split it
            if line.len() > max_len {
                let mut remaining = line;
                while remaining.len() > max_len {
                    let (chunk, rest) = remaining.split_at(max_len);
                    chunks.push(chunk.to_string());
                    remaining = rest;
                }
                current = remaining.to_string();
            } else {
                current = line.to_string();
            }
        } else {
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(line);
        }
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

/// Discord gateway manager
pub struct DiscordGateway {
    config: Arc<RwLock<DiscordConfig>>,
    pub agent: Arc<dyn AgentHandle>,
    pub store: Arc<dyn ChannelStore>,
    pub team_id: String,
    pub primary_agent_actor_id: String,
    pub agent_owner_actor_ids: Vec<String>,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<GatewayStatusResponse>>,
    /// Track if gateway is currently running
    is_running: Arc<RwLock<bool>>,
    /// Pending question store for question forwarding
    pending_questions: Arc<super::PendingQuestionStore>,
    inbound_sink: Arc<RwLock<Option<Arc<dyn crate::driver::InboundSink>>>>,
}

impl DiscordGateway {
    pub fn new(
        agent: Arc<dyn AgentHandle>,
        store: Arc<dyn ChannelStore>,
        team_id: String,
        primary_agent_actor_id: String,
        agent_owner_actor_ids: Vec<String>,
    ) -> Self {
        Self {
            config: Arc::new(RwLock::new(DiscordConfig::default())),
            agent,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(GatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            pending_questions: Arc::new(super::PendingQuestionStore::new()),
            inbound_sink: Arc::new(RwLock::new(None)),
        }
    }

    /// Hand inbound messages to the core instead of the inline handler.
    pub async fn use_core_pipeline(&self, sink: Arc<dyn crate::driver::InboundSink>) {
        *self.inbound_sink.write().await = Some(sink);
    }

    /// A driver for the core to render replies through.
    pub async fn as_driver(&self) -> DiscordDriver {
        DiscordDriver::new(self.config.read().await.token.clone())
    }

    /// Update the configuration
    pub async fn set_config(&self, config: DiscordConfig) {
        let mut cfg = self.config.write().await;
        *cfg = config;
    }

    /// Get current configuration
    #[allow(dead_code)]
    pub async fn get_config(&self) -> DiscordConfig {
        self.config.read().await.clone()
    }

    /// Get current status
    pub async fn get_status(&self) -> GatewayStatusResponse {
        self.status.read().await.clone()
    }

    /// Start the Discord bot
    pub async fn start(&self) -> Result<(), String> {
        let config = self.config.read().await.clone();

        if !config.enabled {
            return Err("Discord is not enabled".to_string());
        }

        if config.token.is_empty() {
            return Err("Discord bot token is not configured".to_string());
        }

        // Check if already running using is_running flag
        {
            let mut is_running = self.is_running.write().await;
            if *is_running {
                return Err("Discord gateway is already running".to_string());
            }
            // Mark as running immediately to prevent race conditions
            *is_running = true;
        }

        // Update status to connecting
        {
            let mut status = self.status.write().await;
            status.status = GatewayStatus::Connecting;
        }

        // Create status channel
        let (status_tx, mut status_rx) = mpsc::channel::<GatewayStatusResponse>(10);
        let status_clone = Arc::clone(&self.status);

        // Spawn status updater
        tokio::spawn(async move {
            while let Some(new_status) = status_rx.recv().await {
                let mut status = status_clone.write().await;
                *status = new_status;
            }
        });

        // Create handler
        let handler = DiscordHandler::new(
            Arc::clone(&self.config),
            Arc::clone(&self.agent),
            Arc::clone(&self.store),
            self.team_id.clone(),
            self.primary_agent_actor_id.clone(),
            self.agent_owner_actor_ids.clone(),
            status_tx,
            Arc::clone(&self.pending_questions),
            self.inbound_sink.read().await.clone(),
        );

        // Build client
        let intents = GatewayIntents::GUILD_MESSAGES
            | GatewayIntents::DIRECT_MESSAGES
            | GatewayIntents::MESSAGE_CONTENT;

        let mut client = Client::builder(&config.token, intents)
            .event_handler(handler)
            .await
            .map_err(|e| format!("Failed to create Discord client: {}", e))?;

        // Create shutdown channel
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
        {
            let mut tx = self.shutdown_tx.write().await;
            *tx = Some(shutdown_tx);
        }

        let status_clone = Arc::clone(&self.status);
        let is_running_clone = Arc::clone(&self.is_running);

        // Clone shard_manager so we can shut down the websocket properly
        let shard_manager = client.shard_manager.clone();

        // Spawn the client
        tokio::spawn(async move {
            tokio::select! {
                result = client.start() => {
                    if let Err(e) = result {
                        eprintln!("Discord client error: {}", e);
                        let mut status = status_clone.write().await;
                        *status = GatewayStatusResponse {
                            status: GatewayStatus::Error,
                            discord_connected: false,
                            error_message: Some(e.to_string()),
                            connected_guilds: Vec::new(),
                            bot_username: None,
                        };
                    }
                }
                _ = &mut shutdown_rx => {
                    println!("[Discord] Gateway shutdown requested, closing shards...");
                    shard_manager.shutdown_all().await;
                    println!("[Discord] All shards shut down");
                    let mut status = status_clone.write().await;
                    *status = GatewayStatusResponse::default();
                }
            }
            // Mark as not running when client stops
            let mut is_running = is_running_clone.write().await;
            *is_running = false;
            println!("[Discord] Gateway stopped, is_running set to false");
        });

        Ok(())
    }

    /// Stop the Discord bot
    pub async fn stop(&self) -> Result<(), String> {
        // Check if running
        let running = *self.is_running.read().await;
        if !running {
            return Err("Discord gateway is not running".to_string());
        }

        let mut shutdown = self.shutdown_tx.write().await;
        if let Some(tx) = shutdown.take() {
            let _ = tx.send(());

            // Wait for the spawned task to finish (is_running becomes false)
            for _ in 0..50 {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                if !*self.is_running.read().await {
                    break;
                }
            }

            // Force reset state in case the wait timed out
            {
                let mut is_running = self.is_running.write().await;
                *is_running = false;
            }
            {
                let mut status = self.status.write().await;
                *status = GatewayStatusResponse::default();
            }

            println!("[Discord] Gateway fully stopped");
            Ok(())
        } else {
            // Shouldn't happen, but reset state anyway
            let mut is_running = self.is_running.write().await;
            *is_running = false;
            Err("Discord gateway shutdown channel not found".to_string())
        }
    }

    /// Consuming shutdown used by the amuxd channel manager.
    /// Delegates to `stop()`; failures are logged but not propagated since
    /// the manager is tearing the gateway down anyway.
    pub async fn shutdown(self) {
        if let Err(e) = self.stop().await {
            eprintln!("[Discord] shutdown: {e}");
        }
    }

    /// Test if a token is valid
    pub async fn test_token(token: &str) -> Result<String, String> {
        let http = Http::new(token);

        match http.get_current_user().await {
            Ok(user) => {
                // In newer Discord API, discriminator may be None (for users with new username system)
                match user.discriminator {
                    Some(d) => Ok(format!("{}#{:04}", user.name, d)),
                    None => Ok(user.name.to_string()),
                }
            }
            Err(e) => Err(format!("Invalid token: {}", e)),
        }
    }
}

impl Clone for DiscordGateway {
    fn clone(&self) -> Self {
        Self {
            config: Arc::clone(&self.config),
            agent: Arc::clone(&self.agent),
            store: Arc::clone(&self.store),
            team_id: self.team_id.clone(),
            primary_agent_actor_id: self.primary_agent_actor_id.clone(),
            agent_owner_actor_ids: self.agent_owner_actor_ids.clone(),
            shutdown_tx: Arc::clone(&self.shutdown_tx),
            status: Arc::clone(&self.status),
            is_running: Arc::clone(&self.is_running),
            pending_questions: Arc::clone(&self.pending_questions),
            inbound_sink: Arc::clone(&self.inbound_sink),
        }
    }
}

// ==================== Transport driver (core pipeline) ====================

fn discord_caps() -> crate::driver::ChannelCaps {
    crate::driver::ChannelCaps {
        // Discord can edit a message it sent, but this driver does not hold the
        // http context needed to do it from `update`. Claiming the capability
        // would stream edits into an error, so it stays false until it is real.
        streaming_edit: false,
        media_upload: false,
        interactive: false,
        threading: crate::driver::Threading::ReplyTo,
        // Discord's hard limit is 2000; `split_message` exists for exactly this.
        max_chars: 2000,
        turn_timeout_secs: 180,
    }
}

/// Normalize a Discord message into the shape the core consumes.
///
/// `bot_id` strips the bot's own mention — it is connection state (set in
/// `ready()`), not a property of the message.
fn normalize_message(msg: &Message, bot_id: Option<u64>) -> Option<crate::driver::InboundMessage> {
    if msg.author.bot {
        return None;
    }
    let mut content = msg.content.clone();
    if let Some(id) = bot_id {
        content = content
            .replace(&format!("<@{id}>",), "")
            .replace(&format!("<@!{id}>"), "")
            .trim()
            .to_string();
    }
    let is_dm = msg.guild_id.is_none();
    let application_id = bot_id.map(|id| id.to_string()).unwrap_or_default();

    Some(crate::driver::InboundMessage {
        conversation: crate::driver::Conversation {
            channel: "discord",
            // The application id is what the binding is scoped by, and it is
            // only known once connected — carry it rather than re-fetching.
            bot_id: Some(application_id),
            kind: if is_dm {
                crate::driver::ConversationKind::Direct
            } else {
                crate::driver::ConversationKind::Group
            },
            id: msg.channel_id.get().to_string(),
        },
        sender: crate::driver::ExternalSender {
            external_id: msg.author.id.get().to_string(),
            display_name: msg.author.name.clone(),
            email: None,
        },
        external_message_id: msg.id.get().to_string(),
        text: content,
        attachments: Vec::new(),
        // A DM is addressed by definition; in a guild the gateway only receives
        // what its intents allow, which is what the inline path relied on too.
        addressed_to_bot: true,
        quoted_text: msg
            .referenced_message
            .as_ref()
            .map(|r| r.content.clone())
            .filter(|c| !c.is_empty()),
        reply_context: Some(msg.id.get().to_string()),
    })
}

/// Discord as a transport driver.
pub struct DiscordDriver {
    token: String,
}

impl DiscordDriver {
    pub fn new(token: String) -> Self {
        Self { token }
    }
}

#[async_trait::async_trait]
impl crate::driver::ChannelDriver for DiscordDriver {
    fn id(&self) -> crate::driver::ChannelId {
        "discord"
    }

    fn caps(&self) -> crate::driver::ChannelCaps {
        discord_caps()
    }

    fn binding(&self, conversation: &crate::driver::Conversation) -> String {
        crate::binding::discord(
            conversation.bot_id.as_deref().unwrap_or_default(),
            &conversation.id,
        )
    }

    fn sender_urn(
        &self,
        _conversation: &crate::driver::Conversation,
        sender: &crate::driver::ExternalSender,
    ) -> String {
        crate::binding::urn_discord_user(&sender.external_id)
    }

    fn session_title(
        &self,
        conversation: &crate::driver::Conversation,
        sender: &crate::driver::ExternalSender,
    ) -> String {
        match conversation.kind {
            crate::driver::ConversationKind::Group => {
                format!("Discord: #{}", conversation.id)
            }
            _ => format!("Discord DM: {}", sender.display_name),
        }
    }

    async fn deliver(
        &self,
        to: &crate::driver::Conversation,
        _reply_context: Option<&str>,
        msg: &crate::driver::OutboundMessage,
    ) -> Result<crate::driver::DeliveryId, crate::driver::DriverError> {
        if msg.text.trim().is_empty() {
            return Ok(crate::driver::DeliveryId(to.id.clone()));
        }
        // Discord rejects anything over 2000 chars outright, so a long answer
        // goes out as several messages rather than being truncated.
        for chunk in split_message(&msg.text, discord_caps().max_chars) {
            send_channel_message(&self.token, &to.id, &chunk)
                .await
                .map_err(crate::driver::DriverError::Transport)?;
        }
        Ok(crate::driver::DeliveryId(to.id.clone()))
    }
}

// ==================== Reusable Send Utilities ====================
// Standalone functions for sending Discord messages via REST API.
// Used by both the gateway handler and cron delivery.

/// Send a message to a Discord channel via REST API.
pub async fn send_channel_message(
    token: &str,
    channel_id: &str,
    content: &str,
) -> Result<(), String> {
    let client = crate::http_client_secs(30);
    let url = format!(
        "https://discord.com/api/v10/channels/{}/messages",
        channel_id
    );
    let body = serde_json::json!({ "content": content });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bot {}", token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Discord API error: {}", e))?;

    if !response.status().is_success() {
        let err = response.text().await.unwrap_or_default();
        return Err(format!("Discord send failed: {}", err));
    }
    Ok(())
}

/// Create a DM channel with a Discord user. Returns the DM channel ID.
pub async fn create_dm_channel(token: &str, user_id: &str) -> Result<String, String> {
    let client = crate::http_client_secs(30);
    let url = "https://discord.com/api/v10/users/@me/channels";
    let body = serde_json::json!({ "recipient_id": user_id });

    let response = client
        .post(url)
        .header("Authorization", format!("Bot {}", token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create DM channel: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let err = response.text().await.unwrap_or_default();
        return Err(format!("Failed to create DM (HTTP {}): {}", status, err));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse DM response: {}", e))?;

    data["id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "No channel ID in DM response".to_string())
}
