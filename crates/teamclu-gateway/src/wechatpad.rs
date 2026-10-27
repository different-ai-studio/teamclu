//! Personal WeChat through a self-hosted iPad-protocol server.
//!
//! The server is a closed-source container the operator runs next to the
//! daemon (`deploy/wechatpad/docker-compose.yml`). It holds a logged-in
//! WeChat account; this driver
//!
//! - calls its HTTP API on loopback to check the login, turn on its heartbeat
//!   and send text, and
//! - receives its pushes — every sync, plus a logout notice — on a loopback
//!   port of its own ([`CallbackServer`]).
//!
//! Nothing here logs the account in: that is a QR scan against the server,
//! done once outside the daemon. `start()` only re-attaches to a session the
//! server already holds.
//!
//! Wire facts this module is built around, all measured against the 8.0.74
//! server (`docs/features/wechatpad.md` has the details):
//!
//! - A response succeeded when `Success` is true. `Code` is not a success
//!   flag: one endpoint answers success with 1, another with 0.
//! - A push is `{Code, Success, Data: {AddMsgs: [...]}}`. Bodies are sometimes
//!   empty, "no new messages" pushes carry a `Data` without `AddMsgs`, and a
//!   login replays the same history several times in a couple of seconds.
//! - In a group the sender is a `"<wxid>:\n"` prefix on the content; an
//!   `@mention` is followed by U+2005, not a space; who was mentioned is in
//!   `MsgSource`'s `<atuserlist>`.
//! - The account's own messages typed on the phone come back as pushes.
//!
//! The account is unofficial on an unofficial protocol, and risk control
//! reads volume and rhythm. Everything outbound goes through [`SendPlanner`].

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex, Notify, RwLock};

use crate::driver::{
    ChannelCaps, ChannelDriver, ChannelId, Conversation, ConversationKind, DeliveryId, DriverError,
    ExternalSender, InboundMessage, InboundSink, OutboundMessage, QuotedText, Threading,
};
use crate::wechatpad_config::{
    WeChatPadConfig, WeChatPadGatewayStatus, WeChatPadGatewayStatusResponse,
};

const CHANNEL: ChannelId = "wechatpad";
/// Not documented anywhere; comfortably under what has been seen to go through.
const MAX_CHARS: usize = 1500;
/// What WeChat puts after an `@name` mention instead of a space.
const MENTION_SEPARATOR: char = '\u{2005}';

// ==================== Decoding pushes ====================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PadKind {
    Text,
    /// A reply quoting an earlier message. The message's `text` is the reply.
    Quote {
        /// `NewMsgId` of the quoted message.
        quoted_msg_id: Option<i64>,
        quoted_sender: String,
        /// Only for a quoted text message; anything else quotes as XML.
        quoted_text: Option<String>,
    },
    Image,
    File {
        name: String,
    },
    /// Voice, video, links, stickers, …
    Other {
        msg_type: i64,
        app_type: Option<i64>,
    },
}

/// One chat message out of a push, with the protocol's quirks taken off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PadMessage {
    pub new_msg_id: i64,
    /// A wxid, or `…@chatroom` for a group.
    pub chat_id: String,
    pub sender_id: String,
    pub is_group: bool,
    pub text: String,
    /// `<atuserlist>`: the wxids this message mentions.
    pub mentions: Vec<String>,
    pub create_time: i64,
    /// `"<nickname> : <text>"` for a DM; the only place the sender's display
    /// name shows up without a contact lookup.
    pub push_content: Option<String>,
    pub kind: PadKind,
}

/// 51 init, 9999 unknown, 10000 prompts, 10002 revokes / pats / system XML.
const SYSTEM_MSG_TYPES: [i64; 4] = [51, 9999, 10000, 10002];

#[derive(Deserialize)]
struct Envelope {
    #[serde(rename = "Data", default)]
    data: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct BuiltinString {
    #[serde(default)]
    string: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AddMsg {
    new_msg_id: i64,
    msg_type: i64,
    #[serde(default)]
    from_user_name: Option<BuiltinString>,
    #[serde(default)]
    to_user_name: Option<BuiltinString>,
    #[serde(default)]
    content: Option<BuiltinString>,
    #[serde(default)]
    create_time: Option<i64>,
    #[serde(default)]
    msg_source: Option<String>,
    #[serde(default)]
    push_content: Option<String>,
}

/// Messages in a sync-message push. Anything unreadable decodes to nothing:
/// the server pushes empty bodies and "no new messages" shapes routinely.
pub fn decode_push(body: &[u8]) -> Vec<PadMessage> {
    let Ok(envelope) = serde_json::from_slice::<Envelope>(body) else {
        return Vec::new();
    };
    let Some(add_msgs) = envelope
        .data
        .and_then(|d| d.get("AddMsgs").cloned())
        .and_then(|v| serde_json::from_value::<Vec<AddMsg>>(v).ok())
    else {
        return Vec::new();
    };
    add_msgs.into_iter().filter_map(decode_message).collect()
}

fn decode_message(raw: AddMsg) -> Option<PadMessage> {
    let from = raw
        .from_user_name
        .and_then(|s| s.string)
        .unwrap_or_default();
    if from.is_empty() || SYSTEM_MSG_TYPES.contains(&raw.msg_type) {
        return None;
    }
    let to = raw.to_user_name.and_then(|s| s.string).unwrap_or_default();
    let mut content = raw.content.and_then(|s| s.string).unwrap_or_default();

    let from_group = from.ends_with("@chatroom");
    let is_group = from_group || to.ends_with("@chatroom");
    // The account's own message to a group comes back as from=self, to=group;
    // file it under the group either way.
    let chat_id = if from_group || !to.ends_with("@chatroom") {
        from.clone()
    } else {
        to.clone()
    };
    let mut sender = from;
    if from_group {
        match content.split_once(":\n") {
            Some((who, body)) => {
                sender = who.to_string();
                content = body.to_string();
            }
            // No prefix: the account itself said it.
            None => sender = to,
        }
    }

    let (kind, text) = match raw.msg_type {
        1 => (PadKind::Text, content),
        3 => (PadKind::Image, String::new()),
        49 => {
            let app = AppMsg::parse(&content);
            match app.app_type {
                Some(57) => (
                    PadKind::Quote {
                        quoted_msg_id: app.refer_svrid,
                        quoted_sender: app.refer_from.unwrap_or_default(),
                        quoted_text: (app.refer_type == Some(1))
                            .then_some(app.refer_content)
                            .flatten(),
                    },
                    app.title.unwrap_or_default(),
                ),
                Some(6) => (
                    PadKind::File {
                        name: app.title.unwrap_or_default(),
                    },
                    String::new(),
                ),
                // Upload-in-progress placeholder that precedes every file.
                Some(74) => return None,
                other => (
                    PadKind::Other {
                        msg_type: 49,
                        app_type: other,
                    },
                    String::new(),
                ),
            }
        }
        other => (
            PadKind::Other {
                msg_type: other,
                app_type: None,
            },
            String::new(),
        ),
    };

    Some(PadMessage {
        new_msg_id: raw.new_msg_id,
        chat_id,
        sender_id: sender,
        is_group,
        text,
        mentions: mentions(raw.msg_source.as_deref().unwrap_or("")),
        create_time: raw.create_time.unwrap_or(0),
        push_content: raw.push_content,
        kind,
    })
}

fn mentions(msg_source: &str) -> Vec<String> {
    xml_element(msg_source, "atuserlist")
        .map(|list| {
            list.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The `<appmsg>` fields this driver reads. The quoted message's own
/// `<type>`/`<title>` live under `<refermsg>`, so the XML is split there first.
#[derive(Default)]
struct AppMsg {
    app_type: Option<i64>,
    title: Option<String>,
    refer_type: Option<i64>,
    refer_svrid: Option<i64>,
    refer_from: Option<String>,
    refer_content: Option<String>,
}

impl AppMsg {
    fn parse(xml: &str) -> AppMsg {
        let (head, refer) = match xml.find("<refermsg>") {
            Some(i) => (&xml[..i], Some(&xml[i..])),
            None => (xml, None),
        };
        let mut app = AppMsg {
            app_type: xml_element(head, "type").and_then(|t| t.trim().parse().ok()),
            title: xml_element(head, "title").map(|t| t.trim().to_string()),
            ..AppMsg::default()
        };
        if let Some(refer) = refer {
            app.refer_type = xml_element(refer, "type").and_then(|t| t.trim().parse().ok());
            app.refer_svrid = xml_element(refer, "svrid").and_then(|t| t.trim().parse().ok());
            app.refer_from = xml_element(refer, "fromusr").map(|t| t.trim().to_string());
            app.refer_content = xml_element(refer, "content").map(|t| t.trim().to_string());
        }
        app
    }
}

/// Text of the first `<name>…</name>`, unescaped. Enough XML for these
/// payloads, which never nest an element inside one of its own name.
fn xml_element(xml: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = xml.find(&open)? + open.len();
    let end = start + xml[start..].find(&close)?;
    let raw = &xml[start..end];
    let raw = raw
        .strip_prefix("<![CDATA[")
        .and_then(|r| r.strip_suffix("]]>"))
        .unwrap_or(raw);
    Some(unescape(raw))
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// `@亮亮bot\u{2005}/status` → `/status`. Only leading mentions go: one in the
/// middle of a sentence is part of what was said. A plain space does not end
/// a WeChat mention, so `@someone hi` is left alone.
pub fn strip_leading_mentions(text: &str) -> String {
    let mut rest = text.trim_start();
    while rest.starts_with('@') {
        match rest.find(MENTION_SEPARATOR) {
            Some(i) => rest = rest[i + MENTION_SEPARATOR.len_utf8()..].trim_start(),
            None => break,
        }
    }
    rest.trim().to_string()
}

// ==================== Access policy ====================

/// A message the policy let through, and whether it is aimed at the bot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admitted {
    pub text: String,
    pub addressed: bool,
}

/// Decide whether a message reaches the core at all.
///
/// Gateway sessions auto-approve tools, so this allowlist is the only thing
/// between a WeChat contact and the agent; that is why both policies default
/// to `allowlist`. In a group the bot is addressed by an `@mention`, a slash
/// command, or a quote of something it said — bare chatter in a shared group
/// never starts a turn.
pub fn admit(cfg: &WeChatPadConfig, msg: &PadMessage) -> Option<Admitted> {
    let bot = cfg.account_wxid.as_str();
    if msg.sender_id == bot {
        return None;
    }
    let quotes_bot = match &msg.kind {
        PadKind::Text => false,
        PadKind::Quote { quoted_sender, .. } => quoted_sender == bot,
        // Media is not carried yet; text-only for now.
        _ => return None,
    };

    let sender_listed = listed(&cfg.allow_from, &msg.sender_id);
    if msg.is_group {
        match cfg.group_policy.as_str() {
            "open" => {}
            "allowlist" => {
                let group_ok =
                    cfg.group_allow_from.is_empty() || listed(&cfg.group_allow_from, &msg.chat_id);
                if !group_ok || !sender_listed {
                    return None;
                }
            }
            _ => return None,
        }
    } else if cfg.dm_policy != "open" && !sender_listed {
        return None;
    }

    let mentioned = msg.mentions.iter().any(|m| m == bot);
    let text = if mentioned {
        strip_leading_mentions(&msg.text)
    } else {
        msg.text.trim().to_string()
    };
    if text.is_empty() {
        return None;
    }
    let addressed = !msg.is_group || mentioned || quotes_bot || text.starts_with('/');
    Some(Admitted { text, addressed })
}

fn listed(list: &[String], id: &str) -> bool {
    list.iter().any(|e| {
        let e = e.trim();
        e == "*" || e == id
    })
}

// ==================== Outbound pacing ====================

/// What the planner thinks of a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendKind {
    /// Answers someone: never merged, never dropped.
    Reply,
    /// Unprompted: merged into one message per chat per window, droppable.
    Notice,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SendPolicy {
    pub min_gap: Duration,
    pub max_jitter: Duration,
    pub coalesce_window: Duration,
    pub per_minute: usize,
    pub per_hour: usize,
}

impl SendPolicy {
    pub const NORMAL: SendPolicy = SendPolicy {
        min_gap: Duration::from_secs(3),
        max_jitter: Duration::from_secs(2),
        coalesce_window: Duration::from_secs(30),
        per_minute: 10,
        per_hour: 100,
    };
    pub const FRESH_LOGIN: SendPolicy = SendPolicy {
        min_gap: Duration::from_secs(5),
        max_jitter: Duration::from_secs(3),
        coalesce_window: Duration::from_secs(60),
        per_minute: 5,
        per_hour: 50,
    };
}

/// For two days after a QR login the account is least trusted.
pub const FRESH_LOGIN_PERIOD: Duration = Duration::from_secs(48 * 3600);
pub const NOTICE_SEPARATOR: &str = "\n\n———\n\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendAction {
    Send {
        chat_id: String,
        /// Empty when this send is a file.
        text: String,
        media: Option<Media>,
        /// Ticket of every caller this send answers.
        tickets: Vec<u64>,
    },
    /// Nothing may go before this instant.
    Wait(Instant),
    Idle,
}

/// A file on its way out. Sent through its own endpoint, never merged or
/// chunked, but paced like any text.
#[derive(Clone, PartialEq, Eq)]
pub enum Media {
    Image(Vec<u8>),
    File { name: String, bytes: Vec<u8> },
}

impl std::fmt::Debug for Media {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Media::Image(b) => write!(f, "Image({} bytes)", b.len()),
            Media::File { name, bytes } => write!(f, "File({name}, {} bytes)", bytes.len()),
        }
    }
}

struct Pending {
    chat_id: String,
    text: String,
    media: Option<Media>,
    kind: SendKind,
    ready_at: Instant,
    tickets: Vec<u64>,
}

/// Decides what the account sends, and when. Pure: the caller owns the clock
/// and does the sending.
///
/// - **Coalescing.** Notices to one chat within `coalesce_window` of the last
///   one go out as one message; the first after a quiet spell goes at once.
/// - **Rhythm.** At least `min_gap` plus a random share of `max_jitter`
///   between any two sends, chunks of one long reply included.
/// - **Quota.** At most `per_minute` / `per_hour` sends. A reply waits for room
///   in the minute and is never dropped. A notice past the hourly quota is
///   dropped and counted; the next message says how many were left out.
///
/// The numbers are conservative guesses, not measured thresholds — WeChat
/// publishes none.
pub struct SendPlanner {
    /// Seconds since the login, at `epoch`; `None` when unknown.
    login_age_at_epoch: Option<Duration>,
    epoch: Instant,
    jitter: Box<dyn FnMut() -> f64 + Send>,
    queue: VecDeque<Pending>,
    sent: VecDeque<Instant>,
    last_sent: Option<Instant>,
    next_gap: Option<Duration>,
    last_notice: std::collections::HashMap<String, Instant>,
    omitted: usize,
}

/// Tickets settled without a send: their notice was dropped over quota.
pub type Dropped = Vec<u64>;

impl SendPlanner {
    pub fn new(
        login_age: Option<Duration>,
        epoch: Instant,
        jitter: Box<dyn FnMut() -> f64 + Send>,
    ) -> Self {
        Self {
            login_age_at_epoch: login_age,
            epoch,
            jitter,
            queue: VecDeque::new(),
            sent: VecDeque::new(),
            last_sent: None,
            next_gap: None,
            last_notice: Default::default(),
            omitted: 0,
        }
    }

    pub fn policy(&self, now: Instant) -> SendPolicy {
        match self.login_age_at_epoch {
            Some(age) if age + now.saturating_duration_since(self.epoch) < FRESH_LOGIN_PERIOD => {
                SendPolicy::FRESH_LOGIN
            }
            _ => SendPolicy::NORMAL,
        }
    }

    pub fn pending(&self) -> usize {
        self.queue.len()
    }

    /// Returns false when there was nothing to queue (blank text).
    pub fn enqueue(
        &mut self,
        chat_id: &str,
        text: &str,
        kind: SendKind,
        ticket: u64,
        now: Instant,
    ) -> bool {
        let text = text.trim();
        if text.is_empty() {
            return false;
        }
        match kind {
            SendKind::Reply => self.queue.push_back(Pending {
                chat_id: chat_id.to_string(),
                text: text.to_string(),
                media: None,
                kind,
                ready_at: now,
                tickets: vec![ticket],
            }),
            SendKind::Notice => {
                if let Some(p) = self.queue.iter_mut().find(|p| {
                    p.kind == SendKind::Notice && p.chat_id == chat_id && p.media.is_none()
                }) {
                    p.text.push_str(NOTICE_SEPARATOR);
                    p.text.push_str(text);
                    p.tickets.push(ticket);
                    return true;
                }
                let window = self.policy(now).coalesce_window;
                let ready_at = self
                    .last_notice
                    .get(chat_id)
                    .map(|last| (*last + window).max(now))
                    .unwrap_or(now);
                self.queue.push_back(Pending {
                    chat_id: chat_id.to_string(),
                    text: text.to_string(),
                    media: None,
                    kind,
                    ready_at,
                    tickets: vec![ticket],
                });
            }
        }
        true
    }

    /// Queue a file. Files are never merged, so a notice's file waits for its
    /// own turn like a reply does; only the hourly quota can drop it.
    pub fn enqueue_media(
        &mut self,
        chat_id: &str,
        media: Media,
        kind: SendKind,
        ticket: u64,
        now: Instant,
    ) {
        self.queue.push_back(Pending {
            chat_id: chat_id.to_string(),
            text: String::new(),
            media: Some(media),
            kind,
            ready_at: now,
            tickets: vec![ticket],
        });
    }

    /// What to do now, plus any tickets whose notice was dropped. `Send`
    /// removes the message from the queue; report it with `did_send`.
    pub fn next(&mut self, now: Instant) -> (SendAction, Dropped) {
        let policy = self.policy(now);
        while self
            .sent
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= Duration::from_secs(3600))
        {
            self.sent.pop_front();
        }
        let mut dropped = Vec::new();
        loop {
            // Replies first: someone is waiting on them.
            let ready = |p: &Pending| p.ready_at <= now;
            let index = self
                .queue
                .iter()
                .position(|p| ready(p) && p.kind == SendKind::Reply)
                .or_else(|| self.queue.iter().position(ready));
            let Some(index) = index else {
                let action = self
                    .queue
                    .iter()
                    .map(|p| p.ready_at)
                    .min()
                    .map_or(SendAction::Idle, SendAction::Wait);
                return (action, dropped);
            };

            if self.queue[index].kind == SendKind::Notice && self.sent.len() >= policy.per_hour {
                let p = self.queue.remove(index).expect("index from position");
                self.omitted += p.tickets.len();
                dropped.extend(p.tickets);
                continue;
            }
            if let Some(last) = self.last_sent {
                let gap = match self.next_gap {
                    Some(g) => g,
                    None => {
                        let share = (self.jitter)().clamp(0.0, 1.0);
                        policy.min_gap + policy.max_jitter.mul_f64(share)
                    }
                };
                self.next_gap = Some(gap);
                if last + gap > now {
                    return (SendAction::Wait(last + gap), dropped);
                }
            }
            let in_minute: Vec<Instant> = self
                .sent
                .iter()
                .copied()
                .filter(|t| now.saturating_duration_since(*t) < Duration::from_secs(60))
                .collect();
            if in_minute.len() >= policy.per_minute {
                return (
                    SendAction::Wait(in_minute[0] + Duration::from_secs(60)),
                    dropped,
                );
            }

            let p = self.queue.remove(index).expect("index from position");
            if p.kind == SendKind::Notice {
                self.last_notice.insert(p.chat_id.clone(), now);
            }
            if let Some(media) = p.media {
                return (
                    SendAction::Send {
                        chat_id: p.chat_id,
                        text: String::new(),
                        media: Some(media),
                        tickets: p.tickets,
                    },
                    dropped,
                );
            }
            let mut text = p.text;
            if self.omitted > 0 {
                text.push_str(&format!("\n\n（已省略 {} 条通知）", self.omitted));
                self.omitted = 0;
            }
            let mut chunks = chunk(&text, MAX_CHARS).into_iter();
            let first = chunks.next().unwrap_or_default();
            // The rest of a long message keeps its place at the head, paced
            // like any other send; its callers settle with the last chunk.
            let rest: Vec<String> = chunks.collect();
            let mut tickets = p.tickets;
            let last = rest.len().checked_sub(1);
            for (i, c) in rest.into_iter().enumerate().rev() {
                self.queue.push_front(Pending {
                    chat_id: p.chat_id.clone(),
                    text: c,
                    media: None,
                    kind: SendKind::Reply,
                    ready_at: now,
                    tickets: if Some(i) == last {
                        std::mem::take(&mut tickets)
                    } else {
                        Vec::new()
                    },
                });
            }
            return (
                SendAction::Send {
                    chat_id: p.chat_id,
                    text: first,
                    media: None,
                    tickets,
                },
                dropped,
            );
        }
    }

    pub fn did_send(&mut self, now: Instant) {
        self.last_sent = Some(now);
        self.sent.push_back(now);
        self.next_gap = None;
    }
}

/// Split at line boundaries so no piece exceeds `limit` characters; a single
/// line longer than that is cut hard.
pub fn chunk(text: &str, limit: usize) -> Vec<String> {
    if text.chars().count() <= limit {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut current = String::new();
    for line in text.split('\n') {
        let mut line = line.to_string();
        while line.chars().count() > limit {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            let cut: String = line.chars().take(limit).collect();
            line = line.chars().skip(limit).collect();
            out.push(cut);
        }
        let joined =
            current.chars().count() + line.chars().count() + usize::from(!current.is_empty());
        if joined > limit && !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(&line);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

// ==================== Server API ====================

/// The protocol server's HTTP API. Success is `Success == true` only.
#[derive(Clone)]
pub struct PadApi {
    base: String,
    client: reqwest::Client,
}

impl PadApi {
    pub fn new(server_url: &str) -> Self {
        Self {
            base: format!("{}/api", server_url.trim_end_matches('/')),
            // Loopback: never through a system proxy.
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
        }
    }

    async fn call(
        &self,
        path: &str,
        query: &[(&str, &str)],
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, (Option<i64>, String)> {
        let mut req = self
            .client
            .post(format!("{}{path}", self.base))
            .query(query);
        req = match body {
            Some(b) => req.json(&b),
            None => req.header("Content-Type", "application/json"),
        };
        let resp = req.send().await.map_err(|e| (None, e.to_string()))?;
        let json: serde_json::Value = resp.json().await.map_err(|e| (None, e.to_string()))?;
        if json.get("Success").and_then(|v| v.as_bool()) == Some(true) {
            Ok(json.get("Data").cloned().unwrap_or(serde_json::Value::Null))
        } else {
            Err((
                json.get("Code").and_then(|v| v.as_i64()),
                json.get("Message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("failed")
                    .to_string(),
            ))
        }
    }

    /// Whether the account has a live session — the check the server's own
    /// client uses. A server answer of "no" is `Ok(false)`; not reaching the
    /// server at all is an error.
    pub async fn is_logged_in(&self, wxid: &str) -> Result<bool, String> {
        match self
            .call("/User/GetContractProfile", &[("wxid", wxid)], None)
            .await
        {
            Ok(_) => Ok(true),
            Err((Some(_), _)) => Ok(false),
            Err((None, e)) => Err(e),
        }
    }

    /// Re-login from the cached session, without a QR scan.
    pub async fn twice_auto_auth(&self, wxid: &str) -> Result<(), String> {
        self.call("/Login/LoginTwiceAutoAuth", &[("wxid", wxid)], None)
            .await
            .map(|_| ())
            .map_err(|(_, e)| e)
    }

    /// Turns on the server's heartbeat and message push. Idempotent.
    pub async fn auto_heartbeat(&self, wxid: &str) -> Result<(), String> {
        self.call("/Login/AutoHeartBeat", &[("wxid", wxid)], None)
            .await
            .map(|_| ())
            .map_err(|(_, e)| e)
    }

    /// Upload and send an image in one call.
    pub async fn send_image(&self, wxid: &str, to: &str, bytes: &[u8]) -> Result<(), String> {
        use base64::Engine;
        self.call(
            "/Msg/UploadImg",
            &[],
            Some(serde_json::json!({
                "Wxid": wxid, "ToWxid": to,
                "Base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            })),
        )
        .await
        .map(|_| ())
        .map_err(|(_, e)| e)
    }

    /// Upload a file in 200KB chunks (multipart), then send it as an
    /// `appmsg type 6` pointing at the upload.
    pub async fn send_file(
        &self,
        wxid: &str,
        to: &str,
        name: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        const CHUNK: usize = 200 * 1000;
        let md5 = format!("{:x}", md5::compute(bytes));
        let total = bytes.len();
        let chunks = total.div_ceil(CHUNK).max(1);
        let client_id = format!(
            "{wxid}_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let mut media_id = None;
        let mut app_id = String::new();
        for i in 0..chunks {
            let start = i * CHUNK;
            let piece = &bytes[start..(start + CHUNK).min(total)];
            let (content_type, body) = multipart(
                name,
                piece,
                &[
                    ("Wxid", wxid.to_string()),
                    ("ClientAppDataId", client_id.clone()),
                    ("FileMD5", md5.clone()),
                    ("TotalLen", total.to_string()),
                    ("StartPos", start.to_string()),
                    ("TotalChunks", chunks.to_string()),
                ],
            );
            let resp = self
                .client
                .post(format!("{}/Tools/UploadAppAttachStream", self.base))
                .header("Content-Type", content_type)
                .body(body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            if json.get("Success").and_then(|v| v.as_bool()) != Some(true) {
                return Err(json
                    .get("Message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("upload failed")
                    .to_string());
            }
            let data = json.get("Data").cloned().unwrap_or_default();
            if let Some(id) = data.get("mediaId").and_then(|v| v.as_str()) {
                media_id = Some(id.to_string());
            }
            if let Some(id) = data.get("appId").and_then(|v| v.as_str()) {
                app_id = id.to_string();
            }
        }
        let media_id = media_id.ok_or("upload returned no mediaId")?;
        let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        let xml = format!(
            "<appmsg appid=\"{}\" sdkver=\"0\"><title>{}</title><des></des><action></action>\
             <type>6</type><showtype>0</showtype><soundtype>0</soundtype><contentattr>0</contentattr>\
             <url></url><appattach><totallen>{total}</totallen><attachid>{}</attachid>\
             <fileext>{}</fileext></appattach><md5>{md5}</md5></appmsg>",
            xml_escape(&app_id),
            xml_escape(name),
            xml_escape(&media_id),
            xml_escape(ext),
        );
        self.call(
            "/Msg/SendApp",
            &[],
            Some(serde_json::json!({"Wxid": wxid, "ToWxid": to, "Type": 6, "Xml": xml})),
        )
        .await
        .map(|_| ())
        .map_err(|(_, e)| e)
    }

    /// Returns the sent message's `NewMsgId`.
    pub async fn send_text(
        &self,
        wxid: &str,
        to: &str,
        content: &str,
    ) -> Result<Option<i64>, String> {
        let data = self
            .call(
                "/Msg/SendTxt",
                &[],
                Some(serde_json::json!({
                    "Wxid": wxid, "ToWxid": to, "Content": content, "Type": 1, "At": "",
                })),
            )
            .await
            .map_err(|(code, e)| match code {
                Some(c) => format!("{e} ({c})"),
                None => e,
            })?;
        Ok(data
            .get("List")
            .and_then(|l| l.get(0))
            .and_then(|m| m.get("NewMsgId"))
            .and_then(|v| v.as_i64()))
    }
}

/// One file part plus text fields, the way `UploadAppAttachStream` reads
/// them (the file field is `chunk`). Built by hand: one request shape does
/// not justify a multipart dependency.
fn multipart(filename: &str, piece: &[u8], fields: &[(&str, String)]) -> (String, Vec<u8>) {
    let boundary = format!("----teamclu{:016x}", {
        let mut b = [0u8; 8];
        getrandom::getrandom(&mut b).unwrap_or_default();
        u64::from_le_bytes(b)
    });
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"chunk\"; filename=\"{}\"\r\n\
             Content-Type: application/octet-stream\r\n\r\n",
            filename.replace('"', "_")
        )
        .as_bytes(),
    );
    body.extend_from_slice(piece);
    body.extend_from_slice(b"\r\n");
    for (k, v) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
                .as_bytes(),
        );
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Images WeChat shows inline; anything else goes as a file.
fn is_inline_image(mime: &str, filename: &str) -> bool {
    let mime = mime.to_ascii_lowercase();
    if [
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/gif",
        "image/webp",
    ]
    .contains(&mime.as_str())
    {
        return true;
    }
    let lower = filename.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|e| lower.ends_with(e))
}

/// The largest file this driver will push; WeChat itself takes more, but a
/// bigger upload through an unofficial server is a risk for little gain.
const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

// ==================== Callback listener ====================

/// One request from the protocol server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackRequest {
    pub path: String,
    pub body: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    Complete(CallbackRequest),
    Incomplete,
}

/// Just enough HTTP/1.1 for the server's pushes: one request per connection,
/// body framed by `Content-Length`.
pub fn parse_request(buf: &[u8]) -> Parsed {
    let Some(head_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
        return Parsed::Incomplete;
    };
    let head = String::from_utf8_lossy(&buf[..head_end]);
    let mut lines = head.split("\r\n");
    let path = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .unwrap_or("")
        .to_string();
    let length = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = head_end + 4;
    if buf.len() < body_start + length {
        return Parsed::Incomplete;
    }
    Parsed::Complete(CallbackRequest {
        path,
        body: buf[body_start..body_start + length].to_vec(),
    })
}

const MAX_REQUEST: usize = 64 << 20;

async fn serve_connection(mut stream: tokio::net::TcpStream) -> Option<CallbackRequest> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let request = loop {
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        match parse_request(&buf) {
            Parsed::Complete(r) => break r,
            Parsed::Incomplete if buf.len() < MAX_REQUEST => continue,
            Parsed::Incomplete => return None,
        }
    };
    let body = r#"{"Code":0,"Success":true}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
    Some(request)
}

// ==================== Gateway ====================

#[derive(Clone)]
pub struct WeChatPadGateway {
    config: Arc<RwLock<WeChatPadConfig>>,
    status: Arc<RwLock<WeChatPadGatewayStatusResponse>>,
    inbound_sink: Arc<RwLock<Option<Arc<dyn InboundSink>>>>,
    outbox: Arc<Outbox>,
    shutdown_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

/// The planner plus the callers waiting on it.
struct Outbox {
    planner: Mutex<SendPlanner>,
    waiters: Mutex<std::collections::HashMap<u64, oneshot::Sender<Result<(), String>>>>,
    next_ticket: std::sync::atomic::AtomicU64,
    wake: Notify,
}

impl Outbox {
    fn new(login_at: Option<i64>) -> Self {
        let login_age = login_at.and_then(|t| {
            let age = chrono::Utc::now().timestamp() - t;
            (age >= 0).then(|| Duration::from_secs(age as u64))
        });
        let planner = SendPlanner::new(
            login_age,
            Instant::now(),
            Box::new(|| {
                let mut b = [0u8; 1];
                getrandom::getrandom(&mut b).unwrap_or_default();
                b[0] as f64 / 255.0
            }),
        );
        Self {
            planner: Mutex::new(planner),
            waiters: Mutex::new(Default::default()),
            next_ticket: std::sync::atomic::AtomicU64::new(1),
            wake: Notify::new(),
        }
    }

    /// Queue a message. The receiver settles when it is sent (or dropped).
    async fn enqueue(
        &self,
        chat_id: &str,
        text: &str,
        kind: SendKind,
    ) -> oneshot::Receiver<Result<(), String>> {
        let ticket = self
            .next_ticket
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        // Registered before queuing: the send loop may settle the ticket the
        // moment it is in the planner.
        self.waiters.lock().await.insert(ticket, tx);
        let queued = self
            .planner
            .lock()
            .await
            .enqueue(chat_id, text, kind, ticket, Instant::now());
        if queued {
            self.wake.notify_one();
        } else {
            self.settle(&[ticket], &Ok(())).await;
        }
        rx
    }

    async fn enqueue_media(
        &self,
        chat_id: &str,
        media: Media,
        kind: SendKind,
    ) -> oneshot::Receiver<Result<(), String>> {
        let ticket = self
            .next_ticket
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().await.insert(ticket, tx);
        self.planner
            .lock()
            .await
            .enqueue_media(chat_id, media, kind, ticket, Instant::now());
        self.wake.notify_one();
        rx
    }

    async fn settle(&self, tickets: &[u64], result: &Result<(), String>) {
        let mut waiters = self.waiters.lock().await;
        for t in tickets {
            if let Some(tx) = waiters.remove(t) {
                let _ = tx.send(result.clone());
            }
        }
    }

    /// Drains the planner until shutdown.
    async fn run(self: Arc<Self>, api: PadApi, wxid: String, mut shutdown: oneshot::Receiver<()>) {
        loop {
            let (action, dropped) = self.planner.lock().await.next(Instant::now());
            self.settle(&dropped, &Ok(())).await;
            match action {
                SendAction::Send {
                    chat_id,
                    text,
                    media,
                    tickets,
                } => {
                    let result = match &media {
                        None => api.send_text(&wxid, &chat_id, &text).await.map(|_| ()),
                        Some(Media::Image(bytes)) => api.send_image(&wxid, &chat_id, bytes).await,
                        Some(Media::File { name, bytes }) => {
                            api.send_file(&wxid, &chat_id, name, bytes).await
                        }
                    };
                    if let Err(e) = &result {
                        eprintln!("[WeChatPad] send to {chat_id} failed: {e}");
                    }
                    // Counted either way: a refused send is still a request
                    // the server saw.
                    self.planner.lock().await.did_send(Instant::now());
                    self.settle(&tickets, &result).await;
                }
                SendAction::Wait(until) => {
                    tokio::select! {
                        _ = tokio::time::sleep_until(until.into()) => {}
                        _ = self.wake.notified() => {}
                        _ = &mut shutdown => return,
                    }
                }
                SendAction::Idle => {
                    tokio::select! {
                        _ = self.wake.notified() => {}
                        _ = &mut shutdown => return,
                    }
                }
            }
        }
    }
}

impl WeChatPadGateway {
    pub fn new() -> Self {
        Self {
            config: Arc::new(RwLock::new(WeChatPadConfig::default())),
            status: Arc::new(RwLock::new(WeChatPadGatewayStatusResponse::default())),
            inbound_sink: Arc::new(RwLock::new(None)),
            outbox: Arc::new(Outbox::new(None)),
            shutdown_tx: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn set_config(&mut self, config: WeChatPadConfig) {
        self.outbox = Arc::new(Outbox::new(config.login_at));
        *self.config.write().await = config;
    }

    pub async fn get_status(&self) -> WeChatPadGatewayStatusResponse {
        self.status.read().await.clone()
    }

    async fn set_status(&self, status: WeChatPadGatewayStatus, error: Option<String>) {
        if let Some(e) = &error {
            eprintln!("[WeChatPad] {e}");
        }
        *self.status.write().await = WeChatPadGatewayStatusResponse {
            status,
            error_message: error,
        };
    }

    pub async fn use_core_pipeline(&self, sink: Arc<dyn InboundSink>) {
        *self.inbound_sink.write().await = Some(sink);
    }

    pub async fn as_driver(&self) -> WeChatPadDriver {
        WeChatPadDriver {
            account_wxid: self.config.read().await.account_wxid.clone(),
            outbox: Arc::clone(&self.outbox),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        let cfg = self.config.read().await.clone();
        if cfg.account_wxid.trim().is_empty() {
            return Err("WeChat (iPad) account_wxid is empty — log the account in first".into());
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", cfg.callback_port))
            .await
            .map_err(|e| format!("callback port 127.0.0.1:{}: {e}", cfg.callback_port))?;
        self.set_status(WeChatPadGatewayStatus::Connecting, None)
            .await;

        let (tx, rx) = oneshot::channel();
        *self.shutdown_tx.lock().await = Some(tx);
        let api = PadApi::new(&cfg.server_url);

        // One shutdown signal fans out to the three loops.
        let (stop_tx, _) = tokio::sync::broadcast::channel::<()>(1);
        {
            let stop_tx = stop_tx.clone();
            tokio::spawn(async move {
                let _ = rx.await;
                let _ = stop_tx.send(());
            });
        }

        let (outbox_stop_tx, outbox_stop_rx) = oneshot::channel();
        {
            let mut stop = stop_tx.subscribe();
            tokio::spawn(async move {
                let _ = stop.recv().await;
                let _ = outbox_stop_tx.send(());
            });
        }
        tokio::spawn(Arc::clone(&self.outbox).run(
            api.clone(),
            cfg.account_wxid.clone(),
            outbox_stop_rx,
        ));

        {
            let gw = self.clone();
            let mut stop = stop_tx.subscribe();
            // History a login replays is not a stack of orders.
            let started_at = chrono::Utc::now().timestamp();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        accepted = listener.accept() => {
                            let Ok((stream, _)) = accepted else { continue };
                            let gw = gw.clone();
                            tokio::spawn(async move {
                                if let Some(req) = serve_connection(stream).await {
                                    gw.handle_callback(req, started_at).await;
                                }
                            });
                        }
                        _ = stop.recv() => return,
                    }
                }
            });
        }

        let gw = self.clone();
        tokio::spawn(async move { gw.attach(api, cfg.account_wxid).await });
        Ok(())
    }

    /// Re-attach to the session the server holds; never shows a QR.
    async fn attach(&self, api: PadApi, wxid: String) {
        let result: Result<(), String> = async {
            if !api.is_logged_in(&wxid).await? {
                api.twice_auto_auth(&wxid).await?;
                if !api.is_logged_in(&wxid).await? {
                    return Err("the account is logged out — scan the QR again".into());
                }
            }
            api.auto_heartbeat(&wxid).await
        }
        .await;
        match result {
            Ok(()) => {
                println!("[WeChatPad] attached to {wxid}");
                self.set_status(WeChatPadGatewayStatus::Connected, None)
                    .await;
            }
            Err(e) => {
                self.set_status(
                    WeChatPadGatewayStatus::Error,
                    Some(format!("WeChat (iPad): {e}")),
                )
                .await
            }
        }
    }

    async fn handle_callback(&self, req: CallbackRequest, started_at: i64) {
        if req.path.ends_with("/logout") {
            let offline = serde_json::from_slice::<serde_json::Value>(&req.body)
                .ok()
                .and_then(|v| {
                    v.get("type")
                        .and_then(|t| t.as_str())
                        .map(|t| t == "offline")
                })
                .unwrap_or(false);
            if offline {
                self.set_status(
                    WeChatPadGatewayStatus::Error,
                    Some("WeChat (iPad): the account went offline — scan the QR again".into()),
                )
                .await;
            }
            return;
        }
        if !req.path.ends_with("/sync-message") {
            return;
        }
        let Some(sink) = self.inbound_sink.read().await.clone() else {
            return;
        };
        let cfg = self.config.read().await.clone();
        for msg in decode_push(&req.body) {
            if msg.create_time < started_at {
                continue;
            }
            let Some(admitted) = admit(&cfg, &msg) else {
                continue;
            };
            sink.accept(normalize(&cfg.account_wxid, &msg, admitted))
                .await;
        }
    }

    pub async fn shutdown(self) {
        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }
        self.set_status(WeChatPadGatewayStatus::Disconnected, None)
            .await;
    }
}

impl Default for WeChatPadGateway {
    fn default() -> Self {
        Self::new()
    }
}

/// Turn an admitted message into what the core consumes.
///
/// `NewMsgId` is the server's per-message id and survives redelivery, so it
/// is the dedup key. The display name comes from `PushContent` in a DM; a
/// group's push names nobody, so the wxid stands in.
pub fn normalize(account_wxid: &str, msg: &PadMessage, admitted: Admitted) -> InboundMessage {
    let display_name = msg
        .push_content
        .as_deref()
        .filter(|_| !msg.is_group)
        .and_then(|p| p.split_once(" : ").map(|(name, _)| name.trim().to_string()))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| msg.sender_id.clone());
    let quoted_text = match &msg.kind {
        PadKind::Quote {
            quoted_text: Some(t),
            ..
        } => Some(QuotedText::Ready(t.clone())),
        _ => None,
    };
    InboundMessage {
        conversation: Conversation {
            channel: CHANNEL,
            bot_id: Some(account_wxid.to_string()),
            kind: if msg.is_group {
                ConversationKind::Group
            } else {
                ConversationKind::Direct
            },
            id: msg.chat_id.clone(),
        },
        sender: ExternalSender {
            external_id: msg.sender_id.clone(),
            display_name,
            email: None,
        },
        external_message_id: msg.new_msg_id.to_string(),
        text: admitted.text,
        attachments: Vec::new(),
        addressed_to_bot: admitted.addressed,
        quoted_text,
        context_prefix: None,
        after_persisted: None,
        // Marks a delivery as an answer to someone (paced, never dropped)
        // rather than an unprompted notice.
        reply_context: Some(msg.new_msg_id.to_string()),
    }
}

async fn read_attachment(att: &crate::driver::SessionAttachment) -> Result<Vec<u8>, String> {
    let path = att
        .local_path
        .as_deref()
        .ok_or("no local copy of this attachment")?;
    let meta = tokio::fs::metadata(path).await.map_err(|e| e.to_string())?;
    if meta.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "{} bytes is over the {MAX_ATTACHMENT_BYTES}-byte limit",
            meta.len()
        ));
    }
    tokio::fs::read(path).await.map_err(|e| e.to_string())
}

/// WeChat (iPad protocol) as a transport driver.
pub struct WeChatPadDriver {
    account_wxid: String,
    outbox: Arc<Outbox>,
}

pub fn caps() -> ChannelCaps {
    ChannelCaps {
        streaming_edit: false,
        media_upload: true,
        interactive: false,
        threading: Threading::Inline,
        max_chars: MAX_CHARS,
        turn_timeout_secs: 180,
    }
}

#[async_trait::async_trait]
impl ChannelDriver for WeChatPadDriver {
    fn id(&self) -> ChannelId {
        CHANNEL
    }

    fn caps(&self) -> ChannelCaps {
        caps()
    }

    fn binding(&self, conversation: &Conversation) -> String {
        let account = conversation.bot_id.as_deref().unwrap_or(&self.account_wxid);
        match conversation.kind {
            ConversationKind::Group => crate::binding::wechatpad_group(account, &conversation.id),
            _ => crate::binding::wechatpad_dm(account, &conversation.id),
        }
    }

    fn sender_urn(&self, conversation: &Conversation, sender: &ExternalSender) -> String {
        crate::binding::urn_wechatpad_user(
            conversation.bot_id.as_deref().unwrap_or(&self.account_wxid),
            &sender.external_id,
        )
    }

    fn session_title(&self, conversation: &Conversation, sender: &ExternalSender) -> String {
        match conversation.kind {
            ConversationKind::Group => format!("WeChat group: {}", conversation.id),
            _ => format!("WeChat DM: {}", sender.display_name),
        }
    }

    /// Queues the text with the planner. An answer (`reply_context` set, or a
    /// question someone is waiting on) is awaited so a failed send surfaces;
    /// an unprompted notice returns at once — it may be merged or held for a
    /// while, and nobody is waiting on it.
    async fn deliver(
        &self,
        to: &Conversation,
        reply_context: Option<&str>,
        msg: &OutboundMessage,
    ) -> Result<DeliveryId, DriverError> {
        let id = DeliveryId(to.id.clone());
        let kind = if reply_context.is_some() || msg.question.is_some() {
            SendKind::Reply
        } else {
            SendKind::Notice
        };

        // Files this driver cannot read go by name, as the core would have
        // rendered them for a channel without uploads.
        let mut text = msg.text.clone();
        let mut media = Vec::new();
        for att in &msg.attachments {
            match read_attachment(att).await {
                Ok(bytes) if is_inline_image(&att.mime, &att.filename) => {
                    media.push(Media::Image(bytes))
                }
                Ok(bytes) => media.push(Media::File {
                    name: att.filename.clone(),
                    bytes,
                }),
                Err(e) => {
                    eprintln!("[WeChatPad] attachment {}: {e}", att.filename);
                    text.push_str(&format!("\n[附件: {}]", att.filename));
                }
            }
        }

        // The reply's words first, then its files, each paced like any send.
        let mut pending = Vec::new();
        if !text.trim().is_empty() {
            pending.push(self.outbox.enqueue(&to.id, &text, kind).await);
        }
        for m in media {
            pending.push(self.outbox.enqueue_media(&to.id, m, kind).await);
        }
        if kind == SendKind::Notice {
            return Ok(id);
        }
        for rx in pending {
            match rx.await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(DriverError::Transport(e)),
                Err(_) => {
                    return Err(DriverError::Transport(
                        "WeChat (iPad) gateway stopped".into(),
                    ))
                }
            }
        }
        Ok(id)
    }
}

#[cfg(test)]
mod tests;
