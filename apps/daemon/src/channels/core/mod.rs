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
    InteractiveChoice, InteractiveQuestion, OutboundMessage, SessionAttachment, TurnEnd,
};
use teamclu_gateway::i18n::{self, MsgKey};
use teamclu_gateway::TurnUpdate;

use crate::channels::approvals::{
    self, ApprovalDesk, ApprovalKind, ApprovalRequest, DecideOutcome, Decision, QuestionSpec,
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

/// What `write_inbound` stored.
#[derive(Debug, Clone, Default)]
pub struct WrittenInbound {
    pub message_id: String,
    /// Where each attachment that uploaded can be fetched. Handed to the turn,
    /// so the agent sees the files and not only their names.
    pub attachment_urls: Vec<String>,
    /// Names of the attachments that did not upload, which the agent will not
    /// find anywhere.
    pub failed_uploads: Vec<String>,
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
    ) -> Result<WrittenInbound, CoreError>;

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

/// An object-store-safe form of `filename`, for use inside a bucket key.
///
/// The attachment store rejects keys with non-ASCII bytes — a reply carrying
/// `诗一首.md` came back `validation_failed: Invalid key`, so the file reached
/// the chat while the session copy had no download. Only the *path* is
/// sanitized: `AttachmentRecord.filename` keeps the original, which is what
/// clients display.
pub fn safe_object_name(filename: &str) -> String {
    fn scrub(part: &str) -> String {
        let mut out = String::with_capacity(part.len());
        let mut last_underscore = false;
        for c in part.chars() {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                out.push(c);
                last_underscore = false;
            } else if !last_underscore {
                // Collapse runs, so a wholly non-ASCII name does not become a
                // string of underscores as long as the original.
                out.push('_');
                last_underscore = true;
            }
        }
        out.trim_matches(['_', '.'].as_slice()).to_string()
    }

    // Stem and extension are scrubbed apart, because trimming the joined
    // string ate the dot and turned `诗一首.md` into `md` — an extension
    // masquerading as the whole name.
    let (stem, ext) = match filename.rsplit_once('.') {
        Some((stem, ext)) if !ext.is_empty() => (stem, Some(ext)),
        _ => (filename, None),
    };
    let stem = match scrub(stem) {
        s if s.is_empty() => "file".to_string(),
        s => s,
    };
    match ext.map(scrub) {
        Some(e) if !e.is_empty() => format!("{stem}.{e}"),
        _ => stem,
    }
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
        attachment_urls: &[String],
        on_delta: Option<tokio::sync::mpsc::Sender<TurnUpdate>>,
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
    /// Tool approvals a turn puts to the chat, answered with `/allow` and
    /// friends. `None` where no runtime can ask (tests).
    pub approvals: Option<Arc<ApprovalDesk>>,
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
            // Answers to a tool approval or an agent question. Anyone in the
            // chat may give one; the answer is recorded against whoever did.
            if let (Some(desk), Some((decision, target))) = (
                &self.approvals,
                Decision::from_command(&name, arg.as_deref()),
            ) {
                let (text, record) = self
                    .answer_approval(desk, &session, decision, target.as_deref(), &display)
                    .await;
                // Reply first: a card press has to be answered within five
                // seconds, and the record can wait.
                self.say(driver, &msg.conversation, reply_ctx.as_deref(), &text)
                    .await?;
                if let Some(record) = record {
                    if let Err(e) = self
                        .writer
                        .write_inbound(
                            &session.session_id,
                            &actor_id,
                            &record,
                            Vec::new(),
                            &msg.external_message_id,
                        )
                        .await
                    {
                        tracing::warn!(
                            session_id = %session.session_id,
                            error = %e,
                            "gateway: an approval took effect but its record could not be written"
                        );
                    }
                }
                return Ok(Outcome::Command { handled: true });
            }
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
            // A driver that cannot tell a file's type (WeCom) leaves the type
            // empty and the name bare; both are settled here from the bytes.
            // The attachment store refuses an empty content type, and the agent
            // is shown a picture only when the stored name ends like one.
            let mime = if att.mime.is_empty() {
                teamclu_gateway::wecom::resolve_mime(&bytes, Some(&att.filename))
            } else {
                att.mime.clone()
            };
            uploads.push(PendingUpload {
                filename: teamclu_gateway::wecom::name_with_extension(&att.filename, &mime),
                mime,
                bytes,
                local_path: None,
            });
        }

        // 6. Write BEFORE the turn, always. Writing after is what made a
        //    three-minute turn look like a frozen client everywhere else, then
        //    dropped both rows in 39ms apart.
        let prompt = compose_prompt(&msg);
        let written = self
            .writer
            .write_inbound(
                &session.session_id,
                &actor_id,
                &prompt,
                uploads,
                &msg.external_message_id,
            )
            .await?;
        // For the agent only: the stored message already names every file,
        // uploaded or not.
        let prompt = match unretrieved_note(&written.failed_uploads) {
            Some(note) => format!("{prompt}\n\n{note}"),
            None => prompt,
        };

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
        let urls = &written.attachment_urls;
        let result = if driver.caps().streaming_edit {
            self.run_streamed(driver, &msg, &session, &display, &prompt, urls)
                .await
        } else {
            self.run_buffered(driver, &msg, &session, &display, &prompt, urls)
                .await
        };
        if let Err(error) = &result {
            let orphaned = turn_attachments::close(&session.session_id);
            if !orphaned.is_empty() {
                tracing::warn!(
                    session_id = %session.session_id,
                    count = orphaned.len(),
                    "gateway: turn failed with files attached; they were not delivered"
                );
            }

            // A streamed gateway has an in-place progress card, which
            // `run_streamed` has already closed with this same message. Other
            // gateways have no such card: explicitly return the real turn
            // failure instead of silently leaving the sender with nothing.
            if !driver.caps().streaming_edit {
                let notice = gateway_turn_failure_notice(error);
                if let Err(delivery_error) = self
                    .say(driver, &msg.conversation, reply_ctx.as_deref(), &notice)
                    .await
                {
                    tracing::warn!(
                        session_id = %session.session_id,
                        error = %delivery_error,
                        "gateway: failed to deliver turn failure notice"
                    );
                }
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

    /// Settle what this session's turn is waiting on. Returns the chat reply,
    /// which names who answered, and the line to record in the session as
    /// that person's own message — so the history shows who answered what
    /// even after the chat has scrolled away.
    async fn answer_approval(
        &self,
        desk: &ApprovalDesk,
        session: &SessionRef,
        decision: Decision,
        target: Option<&str>,
        display: &str,
    ) -> (String, Option<String>) {
        let locale = i18n::locale();
        match desk
            .decide(&session.acp_session_id, decision, display, target)
            .await
        {
            DecideOutcome::Resolved {
                request,
                decision,
                answers,
            } => {
                let about = request.summary.as_str();
                let (reply, record) = match (&request.kind, decision, answers) {
                    (ApprovalKind::Question { .. }, _, Some(answers)) => {
                        let summary = answers_summary(&answers);
                        (
                            i18n::t(MsgKey::QuestionAnswered(display, &summary), locale),
                            i18n::t(MsgKey::QuestionRecordAnswered(&summary), locale),
                        )
                    }
                    (ApprovalKind::Question { .. }, _, None) => (
                        i18n::t(MsgKey::QuestionSkipped(display, about), locale),
                        i18n::t(MsgKey::QuestionRecordSkipped(about), locale),
                    ),
                    (_, Decision::AllowAlways, _) => (
                        i18n::t(MsgKey::ApprovalAllowedAlways(display, about), locale),
                        i18n::t(MsgKey::ApprovalRecordAllowedAlways(about), locale),
                    ),
                    (_, Decision::Deny, _) => (
                        i18n::t(MsgKey::ApprovalDenied(display, about), locale),
                        i18n::t(MsgKey::ApprovalRecordDenied(about), locale),
                    ),
                    _ => (
                        i18n::t(MsgKey::ApprovalAllowedOnce(display, about), locale),
                        i18n::t(MsgKey::ApprovalRecordAllowedOnce(about), locale),
                    ),
                };
                (reply, Some(record))
            }
            DecideOutcome::AlreadyHandled => {
                (i18n::t(MsgKey::ApprovalAlreadyHandled, locale), None)
            }
            DecideOutcome::NothingPending => {
                (i18n::t(MsgKey::ApprovalNothingPending, locale), None)
            }
            DecideOutcome::Failed { request } => (
                i18n::t(MsgKey::ApprovalFailed(&request.summary), locale),
                None,
            ),
            DecideOutcome::WrongKind { request } => {
                let key = match request.kind {
                    ApprovalKind::Question { .. } => MsgKey::UseAnswerForQuestion(&request.summary),
                    ApprovalKind::Permission { .. } => {
                        MsgKey::UseAllowForApproval(&request.summary)
                    }
                };
                (i18n::t(key, locale), None)
            }
            DecideOutcome::EmptyAnswer { .. } => (i18n::t(MsgKey::AnswerUsage, locale), None),
        }
    }

    /// Put what a turn is waiting on to the chat: buttons where the channel
    /// has them, and text saying what to type everywhere (the fallback, and
    /// what other channels show). Best-effort: the desktop card is still
    /// there if the chat cannot be reached.
    async fn ask_chat(
        &self,
        driver: &dyn ChannelDriver,
        to: &Conversation,
        request: &ApprovalRequest,
    ) {
        let locale = i18n::locale();
        let (text, question) = match &request.kind {
            ApprovalKind::Permission { offers_always } => {
                let mut choices = vec![InteractiveChoice {
                    label: i18n::t(MsgKey::ApprovalChoiceOnce, locale),
                    reply: format!("/allow #{}", request.request_id),
                }];
                if *offers_always {
                    choices.push(InteractiveChoice {
                        label: i18n::t(MsgKey::ApprovalChoiceAlways, locale),
                        reply: format!("/always #{}", request.request_id),
                    });
                }
                choices.push(InteractiveChoice {
                    label: i18n::t(MsgKey::ApprovalChoiceDeny, locale),
                    reply: format!("/deny #{}", request.request_id),
                });
                (
                    i18n::t(
                        MsgKey::ApprovalRequested(&request.summary, *offers_always),
                        locale,
                    ),
                    Some(InteractiveQuestion {
                        question_id: request.request_id.clone(),
                        title: i18n::t(MsgKey::ApprovalCardTitle, locale),
                        prompt: request.summary.clone(),
                        choices,
                    }),
                )
            }
            ApprovalKind::Question { questions } => {
                let several = questions.len() > 1 || questions.iter().any(|q| q.multiple);
                let text = i18n::t(
                    MsgKey::QuestionAsked(&render_questions(questions), several),
                    locale,
                );
                // Buttons only for the shape a button answers: one question,
                // one pick. The rest is answered in text.
                let card = match questions.as_slice() {
                    [q] if !q.multiple && !q.options.is_empty() => Some(InteractiveQuestion {
                        question_id: request.request_id.clone(),
                        title: if q.header.is_empty() {
                            i18n::t(MsgKey::QuestionCardTitle, locale)
                        } else {
                            q.header.clone()
                        },
                        prompt: q.question.clone(),
                        choices: q
                            .options
                            .iter()
                            .enumerate()
                            .map(|(i, o)| InteractiveChoice {
                                label: o.label.clone(),
                                reply: format!("/answer #{} {}", request.request_id, i + 1),
                            })
                            .collect(),
                    }),
                    _ => None,
                };
                (text, card)
            }
        };
        // No reply context: the request did not come from a chat message. On
        // WeCom a card goes out on its own; text lands in the open progress
        // bubble, which is the one thing it reliably shows mid-stream.
        if let Err(e) = driver
            .deliver(
                to,
                None,
                &OutboundMessage {
                    text,
                    attachments: Vec::new(),
                    question,
                },
            )
            .await
        {
            tracing::warn!(
                request_id = %request.request_id,
                error = %e,
                "gateway: what the turn is waiting on could not be put to the chat"
            );
        }
    }

    /// This session's approval requests, for the life of the returned guard.
    fn watch_approvals(
        &self,
        session: &SessionRef,
    ) -> (
        Option<tokio::sync::mpsc::UnboundedReceiver<ApprovalRequest>>,
        Option<approvals::WatchGuard>,
    ) {
        match &self.approvals {
            Some(desk) => {
                let (rx, guard) = desk.watch(&session.acp_session_id);
                (Some(rx), Some(guard))
            }
            None => (None, None),
        }
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
        attachment_urls: &[String],
    ) -> Result<usize, CoreError> {
        let (mut asks, _watch) = self.watch_approvals(session);
        let turn = self.turns.run(
            &session.acp_session_id,
            display,
            prompt,
            attachment_urls,
            None,
        );
        tokio::pin!(turn);
        let reply = loop {
            tokio::select! {
                reply = &mut turn => break reply?,
                Some(request) = approvals::next_request(&mut asks) => {
                    self.ask_chat(driver, &msg.conversation, &request).await;
                }
            }
        };
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
        attachment_urls: &[String],
    ) -> Result<usize, CoreError> {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<TurnUpdate>(32);
        let handle = driver
            .deliver(
                &msg.conversation,
                msg.reply_context.as_deref(),
                &OutboundMessage::default(),
            )
            .await
            .map_err(|e| CoreError::Render(e.to_string()))?;

        // Before the turn starts, so no request it raises can be missed.
        let (mut asks, _watch) = self.watch_approvals(session);
        let turns = self.turns.clone();
        let acp = session.acp_session_id.clone();
        let display_owned = display.to_string();
        let prompt_owned = prompt.to_string();
        let urls_owned = attachment_urls.to_vec();
        let turn = tokio::spawn(async move {
            turns
                .run(&acp, &display_owned, &prompt_owned, &urls_owned, Some(tx))
                .await
        });

        let mut updates = 0usize;
        loop {
            tokio::select! {
                update = rx.recv() => {
                    match update {
                        None => break,
                        Some(TurnUpdate::Reply(text)) => {
                            driver
                                .update(&handle, &text, None)
                                .await
                                .map_err(|e| CoreError::Render(e.to_string()))?;
                            updates += 1;
                        }
                        // Progress is decoration: a channel that cannot show
                        // it must not fail the turn over it.
                        Some(TurnUpdate::Step(step)) => {
                            if let Err(e) = driver.add_step(&handle, &step).await {
                                tracing::debug!(error = %e, "gateway: progress step not shown");
                            }
                        }
                    }
                }
                Some(request) = approvals::next_request(&mut asks) => {
                    self.ask_chat(driver, &msg.conversation, &request).await;
                }
            }
        }

        let reply = match turn
            .await
            .map_err(|e| CoreError::Turn(format!("turn task: {e}")))?
        {
            Ok(reply) => reply,
            Err(e) => {
                // The progress bubble is already on the channel. Close it even
                // when the wait loop fails, otherwise the sender sees either
                // a permanent "thinking…" state or a misleading cancellation.
                // Keep the actual cause: it is often directly actionable
                // (such as an unavailable model credential), and this core is
                // shared by every gateway, not just WeCom.
                let notice = gateway_turn_failure_notice(&e);
                let _ = driver
                    .update(&handle, &notice, Some(TurnEnd::Answered))
                    .await;
                return Err(e);
            }
        };
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

        // Persist the session row as soon as the turn is done. WeCom's finish
        // frame still waits on the stream ack; parking write_reply behind that
        // left desktop without a ChatMessage until the bubble caught up.
        if !produced_nothing {
            self.writer
                .write_reply(&session.session_id, &reply, attachments.clone())
                .await?;
        }

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
            match driver
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
            {
                Ok(_) => 1,
                Err(e) => {
                    tracing::warn!(
                        session_id = %session.session_id,
                        error = %e,
                        "gateway: file delivery failed after the reply was recorded"
                    );
                    0
                }
            }
        };
        // The opening delivery, every intermediate edit, the final one, and
        // any file delivery.
        Ok(1 + updates + 1 + file_deliveries)
    }
}

/// Render a runtime failure for a channel recipient.
///
/// The first sentence is the useful runtime error. pi appends local help paths
/// after a blank line for interactive CLI users; forwarding that tail would
/// expose a device path without helping a gateway user resolve the failure.
fn gateway_turn_failure_notice(error: &CoreError) -> String {
    let rendered = error.to_string();
    let detail = rendered
        .strip_prefix("turn: ")
        .unwrap_or(&rendered)
        .split_once("\n\n")
        .map(|(head, _)| head)
        .unwrap_or_else(|| rendered.strip_prefix("turn: ").unwrap_or(&rendered));
    teamclu_gateway::i18n::t(
        teamclu_gateway::i18n::MsgKey::TurnFailed(detail),
        teamclu_gateway::i18n::locale(),
    )
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
/// The questions as text, numbered where there are several, options
/// numbered for `/answer`.
fn render_questions(questions: &[QuestionSpec]) -> String {
    let several = questions.len() > 1;
    let mut out = Vec::new();
    for (i, q) in questions.iter().enumerate() {
        let head = if q.question.is_empty() {
            &q.header
        } else {
            &q.question
        };
        out.push(if several {
            format!("{}. {head}", i + 1)
        } else {
            head.clone()
        });
        for (n, o) in q.options.iter().enumerate() {
            out.push(if o.description.is_empty() {
                format!("  {}) {}", n + 1, o.label)
            } else {
                format!("  {}) {} — {}", n + 1, o.label, o.description)
            });
        }
    }
    out.join("\n")
}

/// Answers as one line: picks joined by `, `, questions by `；`.
fn answers_summary(answers: &[Vec<String>]) -> String {
    answers
        .iter()
        .map(|a| a.join(", "))
        .collect::<Vec<_>>()
        .join("；")
}

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

/// Tells the agent which of the user's files it will not find, so it says so
/// instead of answering as if nothing had been sent.
fn unretrieved_note(failed: &[String]) -> Option<String> {
    (!failed.is_empty()).then(|| {
        format!(
            "[{} attachment(s) the user sent could not be retrieved: {}]",
            failed.len(),
            failed.join(", ")
        )
    })
}

#[cfg(test)]
mod tests;
