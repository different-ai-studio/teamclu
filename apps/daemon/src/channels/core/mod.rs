//! The one implementation of "a channel message becomes a session turn".
//!
//! See `docs/specs/2026-08-18-gateway-transport-architecture.md`. Everything a
//! session needs happens here, once, for every channel: dedup, routing,
//! identity, commands, writing, broadcasting, driving the turn, and degrading
//! the reply to what the channel can actually render.
//!
//! Why the daemon and not `teamclu-gateway` (§4.1): everything it needs — the
//! store, live publishing, the runtime — is daemon-side. The gateway crate is a
//! leaf that both the daemon and the desktop depend on.
//!
//! ```text
//! dedup → addressed? → route → identity → command? → write → turn → render
//! ```

use std::sync::Arc;

use async_trait::async_trait;
use teamclu_gateway::driver::{
    AttachmentSource, ChannelDriver, Conversation, DeliveryId, ExternalSender, InboundMessage,
    OutboundMessage, SessionAttachment, TurnEnd,
};

pub mod adapters;
pub mod dedup;
pub mod outbox;
pub mod sink;
pub mod turn_attachments;

/// Remembers which channel messages have already been handled.
///
/// One store for every channel, replacing three mechanisms that each forget
/// differently: an in-memory set (WeCom), nothing at all (Feishu), and a UID
/// watermark plus a sqlite table (email).
#[async_trait]
pub trait DedupStore: Send + Sync {
    /// True when this is the first sighting. Claims atomically: a webhook
    /// redelivered while the first copy is still in flight has to lose.
    async fn claim(&self, channel: &str, external_message_id: &str) -> bool;
}

/// The session a conversation resolves to, and the agent session behind it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRef {
    pub session_id: String,
    /// The agent-side session id, which commands and turns address.
    pub acp_session_id: String,
}

/// Finds or creates the session for a binding.
#[async_trait]
pub trait SessionRouter: Send + Sync {
    async fn resolve(
        &self,
        binding: &str,
        title: &str,
        external_actor_id: &str,
    ) -> Result<SessionRef, CoreError>;
}

/// Maps a channel user onto an actor, so a gateway message has a real sender
/// rather than "the bot".
#[async_trait]
pub trait IdentityMapper: Send + Sync {
    async fn actor_for(&self, urn: &str, display_name: &str) -> Result<String, CoreError>;
    /// Adds the actor to the session's participants; already-present is fine.
    async fn join(&self, session_id: &str, actor_id: &str) -> Result<(), CoreError>;
}

/// The #933 write service: insert, broadcast, and attach — in that order, once.
#[async_trait]
pub trait SessionWriter: Send + Sync {
    async fn write_inbound(
        &self,
        session_id: &str,
        actor_id: &str,
        text: &str,
        attachments: Vec<PendingUpload>,
        external_message_id: &str,
    ) -> Result<String, CoreError>;

    /// Records the agent's reply the same way, so both directions look alike.
    async fn write_reply(
        &self,
        session_id: &str,
        text: &str,
        attachments: Vec<SessionAttachment>,
    ) -> Result<String, CoreError>;

    /// Uploads bytes to the session's attachment store, returning the record
    /// the message will carry. Used for BOTH directions — an agent-sent file is
    /// a session attachment exactly like a received one.
    async fn upload(
        &self,
        session_id: &str,
        upload: &PendingUpload,
    ) -> Result<SessionAttachment, CoreError>;
}

/// An attachment resolved to bytes, ready to upload.
#[derive(Debug, Clone)]
pub struct PendingUpload {
    pub filename: String,
    pub mime: String,
    pub bytes: Vec<u8>,
    /// Where the bytes still live on this machine, when they do. A channel that
    /// uploads media through its own API (WeCom) reads the file again at
    /// delivery time; inbound attachments have no such copy and leave it None.
    pub local_path: Option<String>,
}

/// Runs the turn. Streaming is always offered; whether the *channel* shows the
/// intermediate text is decided by caps, not here.
#[async_trait]
pub trait TurnRunner: Send + Sync {
    async fn run(
        &self,
        acp_session_id: &str,
        sender_display: &str,
        prompt: &str,
        on_delta: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<String, CoreError>;
}

/// Slash commands, dispatched from one place instead of per channel.
#[async_trait]
pub trait CommandRunner: Send + Sync {
    /// `Ok(Some(reply))` when handled; `Ok(None)` when the command is unknown.
    async fn dispatch(
        &self,
        name: &str,
        arg: Option<&str>,
        acp_session_id: &str,
    ) -> Result<Option<String>, CoreError>;

    /// Whether this command can be answered before a session exists (`/help`).
    fn needs_session(&self, name: &str) -> bool;

    /// Rendered "unknown command" text, in the caller's locale.
    fn unknown_command_text(&self, name: &str) -> String;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Duplicate,
    NotAddressed,
    /// Addressed, but said nothing (a bare mention, an empty body).
    Empty,
    /// A slash command answered without running a turn.
    Command {
        handled: bool,
    },
    Handled {
        session_id: String,
        /// How many times the channel was asked to render. One for a channel
        /// that cannot edit; more when it streams.
        deliveries: usize,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("route: {0}")]
    Route(String),
    #[error("identity: {0}")]
    Identity(String),
    #[error("write: {0}")]
    Write(String),
    #[error("turn: {0}")]
    Turn(String),
    #[error("render: {0}")]
    Render(String),
}

pub struct Core {
    pub dedup: Arc<dyn DedupStore>,
    pub router: Arc<dyn SessionRouter>,
    pub identity: Arc<dyn IdentityMapper>,
    pub writer: Arc<dyn SessionWriter>,
    pub turns: Arc<dyn TurnRunner>,
    pub commands: Arc<dyn CommandRunner>,
}

impl Core {
    /// One inbound message, start to finish.
    ///
    /// The driver is the only channel-shaped thing in sight: it supplies the
    /// binding, the sender URN, the title, and does the rendering. Nothing in
    /// this function knows what WeCom or email is.
    pub async fn handle(
        &self,
        driver: &dyn ChannelDriver,
        msg: InboundMessage,
    ) -> Result<Outcome, CoreError> {
        // 1. Dedup first: everything below has side effects, and a redelivered
        //    webhook must not produce a second turn.
        if !self
            .dedup
            .claim(msg.conversation.channel, &msg.external_message_id)
            .await
        {
            return Ok(Outcome::Duplicate);
        }
        if !msg.addressed_to_bot {
            return Ok(Outcome::NotAddressed);
        }
        if msg.text.trim().is_empty() && msg.attachments.is_empty() {
            return Ok(Outcome::Empty);
        }

        let reply_ctx = msg.reply_context.clone();

        // 2. A command that needs no session is answered before one is made:
        //    `/help` in a chat the bot has never seen must not create a
        //    session as a side effect of being asked for help.
        let trimmed = msg.text.trim().to_string();
        let parsed = teamclu_gateway::commands::parse_slash(&trimmed);
        if let Some((name, _)) = &parsed {
            if !self.commands.needs_session(name) {
                let reply = self.commands.dispatch(name, None, "").await?;
                let text = reply.unwrap_or_else(|| self.commands.unknown_command_text(name));
                self.say(driver, &msg.conversation, reply_ctx.as_deref(), &text)
                    .await?;
                return Ok(Outcome::Command { handled: true });
            }
        }

        // 3. Identity, then session — in that order, because the actor is a
        //    participant of the session being created.
        let urn = driver.sender_urn(&msg.conversation, &msg.sender);
        let display = display_name(&msg.sender);
        let actor_id = self.identity.actor_for(&urn, &display).await?;

        let binding = driver.binding(&msg.conversation);
        let title = driver.session_title(&msg.conversation, &msg.sender);
        let session = self.router.resolve(&binding, &title, &actor_id).await?;
        self.identity.join(&session.session_id, &actor_id).await?;

        // 4. Session-scoped commands, now that there is one to act on.
        if let Some((name, arg)) = parsed {
            let reply = self
                .commands
                .dispatch(&name, arg.as_deref(), &session.acp_session_id)
                .await?;
            let (text, handled) = match reply {
                Some(t) => (t, true),
                None => (self.commands.unknown_command_text(&name), false),
            };
            self.say(driver, &msg.conversation, reply_ctx.as_deref(), &text)
                .await?;
            return Ok(Outcome::Command { handled });
        }

        // 5. Resolve attachments. Deferred by construction, so a text-only
        //    message spends nothing here — which is what keeps the common case
        //    starting its turn immediately.
        let mut uploads = Vec::new();
        for att in &msg.attachments {
            let bytes = match &att.source {
                AttachmentSource::Ready(b) => b.clone(),
                AttachmentSource::Deferred(f) => f
                    .fetch()
                    .await
                    .map_err(|e| CoreError::Write(format!("attachment fetch: {e}")))?,
            };
            uploads.push(PendingUpload {
                filename: att.filename.clone(),
                mime: att.mime.clone(),
                bytes,
                local_path: None,
            });
        }

        // 6. Write BEFORE the turn, always. Writing after is what made a
        //    three-minute turn look like a frozen client everywhere else, then
        //    dropped both rows in 39ms apart.
        let prompt = compose_prompt(&msg);
        self.writer
            .write_inbound(
                &session.session_id,
                &actor_id,
                &prompt,
                uploads,
                &msg.external_message_id,
            )
            .await?;

        // 7. Drive the turn, streaming only where it can be seen.
        //
        //    Two ways to attach a file, because runtimes differ in what they
        //    can do: the send tool (MCP, so not everywhere) writes into the
        //    turn window, and the outbox directory (a file write, so anywhere)
        //    is drained afterwards. Both close on failure too — a file attached
        //    to a turn that never delivers must not wait for the next one.
        turn_attachments::open(&session.session_id);
        let prompt = match outbox::prepare(&session.session_id) {
            Some(dir) => format!("{}\n\n{prompt}", outbox::prompt_note(&dir)),
            None => prompt,
        };
        let result = if driver.caps().streaming_edit {
            self.run_streamed(driver, &msg, &session, &display, &prompt)
                .await
        } else {
            self.run_buffered(driver, &msg, &session, &display, &prompt)
                .await
        };
        if result.is_err() {
            let orphaned = turn_attachments::close(&session.session_id);
            if !orphaned.is_empty() {
                tracing::warn!(
                    session_id = %session.session_id,
                    count = orphaned.len(),
                    "gateway: turn failed with files attached; they were not delivered"
                );
            }
        }

        Ok(Outcome::Handled {
            session_id: session.session_id,
            deliveries: result?,
        })
    }

    /// Everything this turn wants to attach, from both routes.
    ///
    /// The `send` tool (MCP — only some runtimes have it) has already uploaded
    /// what it attached; the outbox holds raw files any runtime could write, so
    /// those are uploaded here. An upload failure keeps the attachment with an
    /// empty bucket path: the channel can still deliver it from the local copy,
    /// and the session row still records that a file was part of the reply.
    async fn collect_attachments(&self, session_id: &str) -> Vec<SessionAttachment> {
        let mut out = turn_attachments::close(session_id);
        for upload in outbox::collect(session_id) {
            match self.writer.upload(session_id, &upload).await {
                Ok(a) => out.push(a),
                Err(e) => {
                    tracing::warn!(session_id, file = %upload.filename, error = %e, "outbox: upload failed; delivering the local copy only");
                    out.push(SessionAttachment {
                        filename: upload.filename,
                        mime: upload.mime,
                        bucket_path: String::new(),
                        local_path: upload.local_path,
                    });
                }
            }
        }
        if !out.is_empty() {
            tracing::info!(
                session_id,
                count = out.len(),
                "gateway: reply carries attachments"
            );
        }
        out
    }

    /// A one-shot line back to the chat that is not an agent turn (a command
    /// answer, an error). Recorded nowhere on purpose: it is gateway chrome,
    /// not conversation.
    async fn say(
        &self,
        driver: &dyn ChannelDriver,
        to: &Conversation,
        reply_context: Option<&str>,
        text: &str,
    ) -> Result<DeliveryId, CoreError> {
        driver
            .deliver(
                to,
                reply_context,
                &OutboundMessage {
                    text: text.to_string(),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| CoreError::Render(e.to_string()))
    }

    /// Channels that cannot edit a sent message get one delivery, at the end.
    /// The turn still streams internally — the session and every other client
    /// see the deltas; the channel just sees the result.
    async fn run_buffered(
        &self,
        driver: &dyn ChannelDriver,
        msg: &InboundMessage,
        session: &SessionRef,
        display: &str,
        prompt: &str,
    ) -> Result<usize, CoreError> {
        let reply = self
            .turns
            .run(&session.acp_session_id, display, prompt, None)
            .await?;
        let attachments = self.collect_attachments(&session.session_id).await;
        self.writer
            .write_reply(&session.session_id, &reply, attachments.clone())
            .await?;
        let outbound = render(driver, &reply, attachments);
        driver
            .deliver(&msg.conversation, msg.reply_context.as_deref(), &outbound)
            .await
            .map_err(|e| CoreError::Render(e.to_string()))?;
        Ok(1)
    }

    async fn run_streamed(
        &self,
        driver: &dyn ChannelDriver,
        msg: &InboundMessage,
        session: &SessionRef,
        display: &str,
        prompt: &str,
    ) -> Result<usize, CoreError> {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(32);
        let handle = driver
            .deliver(
                &msg.conversation,
                msg.reply_context.as_deref(),
                &OutboundMessage::default(),
            )
            .await
            .map_err(|e| CoreError::Render(e.to_string()))?;

        let turns = self.turns.clone();
        let acp = session.acp_session_id.clone();
        let display_owned = display.to_string();
        let prompt_owned = prompt.to_string();
        let turn = tokio::spawn(async move {
            turns
                .run(&acp, &display_owned, &prompt_owned, Some(tx))
                .await
        });

        let mut updates = 0usize;
        while let Some(text) = rx.recv().await {
            driver
                .update(&handle, &text, None)
                .await
                .map_err(|e| CoreError::Render(e.to_string()))?;
            updates += 1;
        }

        let reply = turn
            .await
            .map_err(|e| CoreError::Turn(format!("turn task: {e}")))??;
        let attachments = self.collect_attachments(&session.session_id).await;
        let outbound = render(driver, &reply, attachments.clone());

        // A cancelled turn comes back with nothing: no text, no files. Ending
        // the bubble on "done" would tell the user the thing they just stopped
        // finished anyway.
        let produced_nothing = outbound.text.trim().is_empty() && outbound.attachments.is_empty();
        let end = if produced_nothing {
            TurnEnd::NoAnswer
        } else {
            TurnEnd::Answered
        };

        // The streaming bubble carries the text; files cannot be edited into
        // it, so they go out as their own delivery right after — still one
        // logical reply, and one row in the session.
        driver
            .update(&handle, &outbound.text, Some(end))
            .await
            .map_err(|e| CoreError::Render(e.to_string()))?;
        let file_deliveries = if outbound.attachments.is_empty() {
            0
        } else {
            driver
                .deliver(
                    &msg.conversation,
                    msg.reply_context.as_deref(),
                    &OutboundMessage {
                        text: String::new(),
                        attachments: outbound.attachments,
                        question: None,
                    },
                )
                .await
                .map_err(|e| CoreError::Render(e.to_string()))?;
            1
        };

        // Nothing to record: the store rejects an empty message outright
        // ("content is required"), so a cancelled turn used to end on an error
        // log for a turn that did exactly what was asked of it.
        if !produced_nothing {
            self.writer
                .write_reply(&session.session_id, &reply, attachments)
                .await?;
        }
        // The opening delivery, every intermediate edit, the final one, and
        // any file delivery.
        Ok(1 + updates + 1 + file_deliveries)
    }
}

/// Shape the turn's result for one channel.
///
/// A channel that cannot upload does not silently lose the files: their names
/// are appended to the text, so the reader knows something exists and can find
/// it in the session. Feishu is in exactly that position today.
fn render(
    driver: &dyn ChannelDriver,
    reply: &str,
    attachments: Vec<SessionAttachment>,
) -> OutboundMessage {
    if attachments.is_empty() {
        return OutboundMessage {
            text: reply.to_string(),
            ..Default::default()
        };
    }
    if driver.caps().media_upload {
        return OutboundMessage {
            text: reply.to_string(),
            attachments,
            question: None,
        };
    }
    let names = attachments
        .iter()
        .map(|a| format!("[附件: {}]", a.filename))
        .collect::<Vec<_>>()
        .join("\n");
    OutboundMessage {
        text: format!("{reply}\n{names}"),
        ..Default::default()
    }
}

/// What the agent is told the sender is called. Channels that carry no display
/// name (WeCom callbacks do not) fall back to the raw id rather than to "".
fn display_name(sender: &ExternalSender) -> String {
    if sender.display_name.trim().is_empty() {
        sender.external_id.clone()
    } else {
        sender.display_name.clone()
    }
}

/// The text the agent actually sees.
///
/// Quoted context is prepended here — one rule for every channel, instead of
/// each gateway inventing its own marker format.
fn compose_prompt(msg: &InboundMessage) -> String {
    match &msg.quoted_text {
        Some(q) if !q.is_empty() => {
            format!(
                "[Quoted message]\n{q}\n[End quoted message]\n\n{}",
                msg.text
            )
        }
        _ => msg.text.clone(),
    }
}

#[cfg(test)]
mod tests;
