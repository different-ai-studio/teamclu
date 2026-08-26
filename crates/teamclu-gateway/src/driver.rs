//! The shape every channel is reduced to.
//!
//! A driver owns exactly one thing: its wire protocol. Signature checks, token
//! refresh, AES decryption, IMAP fetch, MIME parsing — all of that stays inside
//! the driver and never reaches anything else. What comes out is an
//! [`InboundMessage`]; what goes back in is an [`OutboundMessage`].
//!
//! Everything a *session* needs — dedup, routing, identity, policy, writing,
//! broadcasting, driving the turn — belongs to the core (daemon side, see
//! `docs/specs/2026-08-18-gateway-transport-architecture.md` §4.1) and is
//! written once. Today each channel re-implements those, badly and unevenly:
//! inbound attachments exist only on WeCom, streaming only on WeCom, and dedup
//! is three different mechanisms. This module is the seam that ends that.

use std::sync::Arc;

use async_trait::async_trait;

/// `"wecom"` / `"feishu"` / `"email"` — matches the `[channels.*]` config key.
pub type ChannelId = &'static str;

/// Where a message came from, and where a reply goes back to.
///
/// `bot_id` is part of the identity, not decoration: WeCom already runs several
/// bots in one process, and two bots in the same group chat would otherwise
/// collapse into one conversation and cross their sessions.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Conversation {
    pub channel: ChannelId,
    pub bot_id: Option<String>,
    pub kind: ConversationKind,
    /// Chat id, user id, or mail thread root — whatever the channel keys on.
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConversationKind {
    Direct,
    Group,
    /// A mail thread. Not "a group with slower messages": membership is per
    /// message (anyone can be added by a Cc), and the thread id is derived from
    /// the `References` chain rather than assigned by a server.
    MailThread,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExternalSender {
    /// Channel-native user id. Stable within a channel, meaningless outside it.
    pub external_id: String,
    pub display_name: String,
    /// Only email populates this, and it is **not** proof of identity — `From`
    /// is trivially forged, which is why an email conversation needs an
    /// allowlist that an IM conversation does not.
    pub email: Option<String>,
}

/// An attachment the sender included.
///
/// The bytes are behind [`AttachmentSource::Deferred`] so a text-only message
/// never waits on a download it does not have. WeCom's handler already relies
/// on that property today (a text message starts its turn immediately while a
/// media message waits for the upload); the type keeps it rather than leaving
/// it as an accident of ordering.
pub struct InboundAttachment {
    pub filename: String,
    pub mime: String,
    /// What the channel claims before fetching. Advisory: verify after fetch.
    pub size_hint: Option<usize>,
    pub source: AttachmentSource,
}

pub enum AttachmentSource {
    /// Already in memory — the channel delivered the bytes inline.
    Ready(Vec<u8>),
    /// Fetched on demand (download + decrypt for WeCom, MIME part for email).
    Deferred(Arc<dyn FetchAttachment>),
}

#[async_trait]
pub trait FetchAttachment: Send + Sync {
    async fn fetch(&self) -> Result<Vec<u8>, DriverError>;
}

pub struct InboundMessage {
    pub conversation: Conversation,
    pub sender: ExternalSender,
    /// Dedup key. Must be unique within the channel and stable across
    /// redelivery — the whole point is surviving a re-sent webhook.
    pub external_message_id: String,
    pub text: String,
    pub attachments: Vec<InboundAttachment>,
    /// Whether this message is addressed to the bot at all.
    ///
    /// Group chats only start a turn when the bot is addressed. Email has no
    /// such concept — every mail to the address is addressed to us — so email
    /// drivers set this to `true` unconditionally rather than inventing a
    /// mention rule.
    pub addressed_to_bot: bool,
    /// Text of the message being replied to, when the channel supports quoting.
    /// Used for context and for matching an answer back to a pending question.
    pub quoted_text: Option<String>,
    /// Opaque handle back to *this* request, for channels whose reply path is
    /// bound to the inbound one rather than to the conversation.
    ///
    /// WeCom is the reason this exists: its replies and streaming card updates
    /// go back over the websocket that delivered the callback, keyed by the
    /// request id — "send to this chat" is a different, weaker operation. The
    /// core never reads it; it carries it back to the driver untouched.
    pub reply_context: Option<String>,
}

/// What the core hands back for rendering. Attachments are already session
/// attachments — uploaded and recorded — so the driver only renders them.
#[derive(Debug, Clone, Default)]
pub struct OutboundMessage {
    pub text: String,
    pub attachments: Vec<SessionAttachment>,
    pub question: Option<InteractiveQuestion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionAttachment {
    pub filename: String,
    pub mime: String,
    /// Where the bytes live in the session's attachment store. A channel that
    /// cannot upload renders this as a link instead.
    pub bucket_path: String,
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractiveQuestion {
    pub question_id: String,
    pub prompt: String,
    pub options: Vec<String>,
}

/// What a channel can actually do.
///
/// The core reads this and degrades; a missing capability must never mean a
/// missing feature. Today the opposite is true — no streaming on Feishu means
/// Feishu users simply do not get progressive replies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelCaps {
    /// Can an already-sent message be edited as the reply grows?
    pub streaming_edit: bool,
    pub media_upload: bool,
    /// Cards, buttons — anything that collects a choice without free text.
    pub interactive: bool,
    pub threading: Threading,
    /// Hard limit per outbound message; the core splits above it.
    /// `0` means unlimited / do not split.
    pub max_chars: usize,
    /// How long one turn may take before the queue gives up on it.
    ///
    /// Per-channel because it is a property of the medium, not of the agent: a
    /// mail round trip that takes four minutes is normal, and the IM-shaped
    /// 180s in `session_queue.rs` would abandon it.
    pub turn_timeout_secs: u64,
}

impl ChannelCaps {
    /// `turn_timeout_secs` as a `Duration`, for the agent call that enforces it.
    pub fn turn_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.turn_timeout_secs)
    }
}

/// How a streamed reply ended.
///
/// The distinction is not cosmetic: a bubble that closes on "done" after the
/// user typed `/stop` tells them the thing they cancelled finished anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnEnd {
    /// The turn produced this text — show it as the answer.
    Answered,
    /// The turn ended with nothing to show: cancelled, or stopped before it
    /// wrote anything.
    NoAnswer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Threading {
    /// Replies land in the conversation, unattached to a specific message.
    Inline,
    /// Replies reference the message they answer.
    ReplyTo,
    /// `In-Reply-To` / `References` must be carried or the thread splits and
    /// the next mail resolves to a different conversation.
    MailHeaders,
}

impl ChannelCaps {
    /// Sensible floor: text only, no editing, IM-ish timeout.
    pub const MINIMAL: ChannelCaps = ChannelCaps {
        streaming_edit: false,
        media_upload: false,
        interactive: false,
        threading: Threading::Inline,
        max_chars: 2000,
        turn_timeout_secs: 180,
    };
}

#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("transport: {0}")]
    Transport(String),
    #[error("payload: {0}")]
    Payload(String),
}

/// Identifies a delivered message so a streaming reply can keep editing it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryId(pub String);

/// Where a driver hands a normalized message for the core to act on.
///
/// The direction matters: this crate is a leaf, so it cannot call the daemon
/// that owns the pipeline. The daemon implements this and injects it, and the
/// gateway's connection loop only ever pushes.
#[async_trait]
pub trait InboundSink: Send + Sync {
    async fn accept(&self, msg: InboundMessage);
}

#[async_trait]
pub trait ChannelDriver: Send + Sync {
    fn id(&self) -> ChannelId;
    fn caps(&self) -> ChannelCaps;

    /// The session binding URI for this conversation.
    ///
    /// Channel-shaped by nature (`wecom://{corp}/{agent}/{group}/{chat}`), so
    /// the driver owns it. The core only needs the string to be stable: it is
    /// what makes the same chat resolve to the same session tomorrow.
    fn binding(&self, conversation: &Conversation) -> String;

    /// Stable URN for a channel user, used to find or create their actor.
    fn sender_urn(&self, conversation: &Conversation, sender: &ExternalSender) -> String;

    /// Human-readable session title on first contact ("WeCom group: …").
    fn session_title(&self, conversation: &Conversation, sender: &ExternalSender) -> String;

    /// Render one outbound message.
    ///
    /// `reply_context` is whatever the inbound message carried — a websocket
    /// request id, a message id to reply to, a mail `Message-ID`. `None` means
    /// this is proactive: not an answer to anything, which some channels can
    /// only do through a different API.
    async fn deliver(
        &self,
        to: &Conversation,
        reply_context: Option<&str>,
        msg: &OutboundMessage,
    ) -> Result<DeliveryId, DriverError>;

    /// Update a previously delivered message. Only called when
    /// [`ChannelCaps::streaming_edit`] is set, so the default is unreachable
    /// for channels that never opt in.
    ///
    /// `end` is `None` while the turn is still running.
    async fn update(
        &self,
        _id: &DeliveryId,
        _text: &str,
        _end: Option<TurnEnd>,
    ) -> Result<(), DriverError> {
        Err(DriverError::Transport(
            "this channel cannot edit a delivered message".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bot_id_is_part_of_the_conversation_identity() {
        // WeCom runs several bots in one process. Without bot_id in the key,
        // two bots in the same group chat share one conversation — and one
        // bot's turn answers into the other bot's session.
        let a = Conversation {
            channel: "wecom",
            bot_id: Some("bot-a".into()),
            kind: ConversationKind::Group,
            id: "chat-1".into(),
        };
        let b = Conversation {
            bot_id: Some("bot-b".into()),
            ..a.clone()
        };
        assert_ne!(a, b);
    }

    #[test]
    fn the_minimal_caps_still_carry_a_timeout() {
        // A zero here would mean "give up immediately"; the floor has to be a
        // usable value because every driver that omits caps inherits it.
        assert!(ChannelCaps::MINIMAL.turn_timeout_secs > 0);
    }
}
