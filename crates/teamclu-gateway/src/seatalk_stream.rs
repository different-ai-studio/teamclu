//! One SeaTalk stream for a turn.
//! Protocol: https://open.seatalk.io/docs/send-streaming-message
//!
//! The placeholder opens on "Thinking". Each reply so far replaces that
//! snapshot as soon as it arrives. While the next reply is still running,
//! the same stream is refreshed inside SeaTalk's 30-second idle limit.
//! The final call only closes the stream.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use super::{build_text_message, decode_conv_id, optional_id, SeaTalkClient};
use crate::driver::{BufferedReply, Conversation, ConversationKind, DriverError, OutboundMessage};
use crate::i18n::{self, MsgKey};

const KEEPALIVE: Duration = Duration::from_secs(10);
const STREAM_CHAR_LIMIT: usize = 4096;

enum Note {
    /// Reply text so far. Cumulative, not a delta.
    Preview(String),
    Finish {
        text: String,
        done: oneshot::Sender<Result<(), String>>,
    },
}

/// Its sender is the worker's lifetime guard. If the core is dropped or fails
/// before finishing, receiver closure closes the waiting placeholder too.
pub(super) struct SeaTalkBufferedReply {
    tx: Option<mpsc::UnboundedSender<Note>>,
}

#[derive(Clone)]
struct Target {
    chat: String,
    thread: Option<String>,
    group: bool,
}

impl Target {
    fn new(to: &Conversation) -> Self {
        let (chat, thread) = decode_conv_id(&to.id);
        Self {
            chat: chat.to_string(),
            thread: thread.map(str::to_string),
            group: to.kind == ConversationKind::Group,
        }
    }

    fn body(&self) -> Value {
        if self.group {
            json!({ "group_id": self.chat })
        } else {
            json!({ "employee_code": self.chat })
        }
    }

    fn endpoint(&self, init: bool) -> &'static str {
        match (self.group, init) {
            (true, true) => "/messaging/v2/group_chat/init_stream",
            (true, false) => "/messaging/v2/group_chat/update_stream",
            (false, true) => "/messaging/v2/single_chat/init_stream",
            (false, false) => "/messaging/v2/single_chat/update_stream",
        }
    }

    async fn send_text(&self, client: &SeaTalkClient, text: &str) -> Result<(), String> {
        if self.group {
            client
                .send_group_text(&self.chat, text, self.thread.as_deref())
                .await
        } else {
            client
                .send_single_text(&self.chat, text, self.thread.as_deref())
                .await
        }
    }
}

struct Stream {
    id: String,
    seq: u64,
}

impl Stream {
    async fn init(client: &SeaTalkClient, target: &Target, text: &str) -> Result<Self, String> {
        let mut body = target.body();
        body["message"] = build_text_message(text, target.thread.as_deref());
        let response = client
            .api_call(
                reqwest::Method::POST,
                target.endpoint(true),
                Some(body),
                true,
            )
            .await?;
        let id = optional_id(response["stream_id"].as_str())
            .ok_or_else(|| "SeaTalk init_stream returned no stream_id".to_string())?;
        Ok(Self {
            id: id.to_string(),
            seq: 0,
        })
    }

    async fn update(
        &mut self,
        client: &SeaTalkClient,
        target: &Target,
        text: &str,
        finish: bool,
    ) -> Result<Option<String>, String> {
        self.seq += 1;
        let mut body = target.body();
        body["stream_id"] = json!(self.id);
        body["seq"] = json!(self.seq);
        body["finish"] = json!(finish);
        // Each update replaces the snapshot. The init placeholder is not a
        // prefix of the answer; update samples in the API use answer text only.
        body["message"] = json!({ "text": { "format": 1, "content": text } });
        let response = client
            .api_call(
                reqwest::Method::POST,
                target.endpoint(false),
                Some(body),
                true,
            )
            .await?;
        Ok(optional_id(response["msg_id"].as_str()).map(str::to_string))
    }
}

impl SeaTalkBufferedReply {
    pub(super) async fn start(
        client: Arc<SeaTalkClient>,
        to: Conversation,
        app_id: &str,
        cursors: Option<Arc<super::CursorStore>>,
    ) -> Option<Self> {
        let target = Target::new(&to);
        let reply_cursor = reply_cursor(app_id, &target, cursors);
        let thinking = i18n::t(MsgKey::ReplyThinking, i18n::locale());
        let stream = match Stream::init(&client, &target, &thinking).await {
            Ok(stream) => Some(stream),
            Err(error) => {
                // An unavailable stream must not prevent the agent turn. Its
                // eventual complete answer uses the existing text endpoint.
                tracing::warn!(error = %error, "SeaTalk: stream placeholder unavailable");
                return None;
            }
        };
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(wait_for_reply(
            client,
            target,
            thinking,
            stream,
            reply_cursor,
            rx,
        ));
        Some(Self { tx: Some(tx) })
    }
}

#[async_trait::async_trait]
impl BufferedReply for SeaTalkBufferedReply {
    async fn preview(&mut self, text: &str) -> Result<(), DriverError> {
        let sender = self
            .tx
            .as_ref()
            .ok_or_else(|| DriverError::Transport("SeaTalk reply already finished".into()))?;
        sender
            .send(Note::Preview(text.to_string()))
            .map_err(|_| DriverError::Transport("SeaTalk reply worker stopped".into()))
    }

    async fn finish(&mut self, msg: &OutboundMessage) -> Result<(), DriverError> {
        let sender = self
            .tx
            .take()
            .ok_or_else(|| DriverError::Transport("SeaTalk reply already finished".into()))?;
        let (done, result) = oneshot::channel();
        sender
            .send(Note::Finish {
                text: msg.text.clone(),
                done,
            })
            .map_err(|_| DriverError::Transport("SeaTalk reply worker stopped".into()))?;
        // Once sent, the worker owns completion even if the caller is cancelled.
        drop(sender);
        result
            .await
            .map_err(|_| DriverError::Transport("SeaTalk reply worker stopped".into()))?
            .map_err(DriverError::Transport)
    }
}

struct Live {
    stream: Option<Stream>,
    /// Leading slices already closed. The open stream holds only the tail.
    closed: usize,
    /// Exact text on the open stream. Keepalive resends this, not "Thinking",
    /// once a reply has replaced the placeholder.
    snapshot: String,
    broken: bool,
    /// `msg_id` from the update that closed the stream.
    finish_msg_id: Option<String>,
}

struct ReplyCursor {
    store: Arc<super::CursorStore>,
    key: String,
}

fn reply_cursor(
    app_id: &str,
    target: &Target,
    cursors: Option<Arc<super::CursorStore>>,
) -> Option<ReplyCursor> {
    let store = cursors?;
    let thread = target.thread.as_deref()?;
    let kind = if target.group { "group" } else { "dm" };
    Some(ReplyCursor {
        store,
        key: super::cursor::thread_key(app_id, kind, &target.chat, thread),
    })
}

fn note_finish_id(live: &mut Live, id: Option<String>, finish: bool) {
    if finish {
        if let Some(id) = id {
            live.finish_msg_id = Some(id);
        }
    }
}

async fn settle_reply_cursor(client: &SeaTalkClient, cursor: Option<&ReplyCursor>, live: &Live) {
    let Some(cursor) = cursor else {
        return;
    };
    let Some(msg_id) = live.finish_msg_id.as_deref() else {
        eprintln!("[SeaTalk] reply cursor left in place; finish returned no msg_id");
        return;
    };
    let sent_time = match client.get_message(msg_id).await {
        Ok(message) => super::json_sent_time(&message).filter(|sent| *sent > 0),
        Err(error) => {
            eprintln!("[SeaTalk] reply cursor left in place; message lookup failed: {error}");
            return;
        }
    };
    let Some(sent_time) = sent_time else {
        eprintln!("[SeaTalk] reply cursor left in place; message has no sent time");
        return;
    };
    if let Err(error) = cursor
        .store
        .advance(&cursor.key, sent_time, &[msg_id.to_string()])
        .await
    {
        eprintln!("[SeaTalk] reply cursor was not saved: {error}");
    } else {
        eprintln!("[SeaTalk] thread cursor advanced to reply msg_id={msg_id}");
    }
}

async fn wait_for_reply(
    client: Arc<SeaTalkClient>,
    target: Target,
    thinking: String,
    stream: Option<Stream>,
    reply_cursor: Option<ReplyCursor>,
    mut rx: mpsc::UnboundedReceiver<Note>,
) {
    let mut live = Live {
        stream,
        closed: 0,
        snapshot: thinking,
        broken: false,
        finish_msg_id: None,
    };
    let mut heartbeat = tokio::time::interval(KEEPALIVE);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    loop {
        tokio::select! {
            biased;
            note = rx.recv() => {
                match note {
                    Some(Note::Preview(text)) => {
                        let mut latest = text;
                        let mut finish = None;
                        loop {
                            match rx.try_recv() {
                                Ok(Note::Preview(text)) => latest = text,
                                Ok(finish_note @ Note::Finish { .. }) => {
                                    finish = Some(finish_note);
                                    break;
                                }
                                Err(_) => break,
                            }
                        }
                        show_preview(&client, &target, &mut live, &latest).await;
                        if let Some(Note::Finish { text, done }) = finish {
                            let result = show_final(&client, &target, &mut live, &text).await;
                            if result.is_ok() {
                                settle_reply_cursor(&client, reply_cursor.as_ref(), &live).await;
                            }
                            let _ = done.send(result);
                            return;
                        }
                    }
                    Some(Note::Finish { text, done }) => {
                        let result = show_final(&client, &target, &mut live, &text).await;
                        if result.is_ok() {
                            settle_reply_cursor(&client, reply_cursor.as_ref(), &live).await;
                        }
                        let _ = done.send(result);
                        return;
                    }
                    None => {
                        if let Some(mut stream) = live.stream.take() {
                            let stopped = i18n::t(MsgKey::SessionStopped, i18n::locale());
                            match stream.update(&client, &target, &stopped, true).await {
                                Ok(msg_id) => {
                                    note_finish_id(&mut live, msg_id, true);
                                    settle_reply_cursor(&client, reply_cursor.as_ref(), &live).await;
                                }
                                Err(error) => {
                                    tracing::warn!(error = %error, "SeaTalk: could not close abandoned placeholder");
                                }
                            }
                        }
                        return;
                    }
                }
            }
            _ = heartbeat.tick() => {
                if let Some(active) = live.stream.as_mut() {
                    match active.update(&client, &target, &live.snapshot, false).await {
                        Ok(_) => {}
                        Err(error) => {
                            // SeaTalk terminates a stream after an error. Never
                            // reference it again; the final text still goes out
                            // through the ordinary send.
                            tracing::warn!(error = %error, "SeaTalk: stream keepalive failed");
                            live.stream = None;
                            live.broken = true;
                        }
                    }
                }
            }
        }
    }
}

async fn show_preview(client: &SeaTalkClient, target: &Target, live: &mut Live, text: &str) {
    if live.broken || text.trim().is_empty() || text == live.snapshot {
        return;
    }
    if let Err(error) = publish(client, target, live, text, false).await {
        tracing::warn!(error = %error, "SeaTalk: reply preview failed; holding the final text");
        live.stream = None;
        live.broken = true;
    }
}

async fn show_final(
    client: &SeaTalkClient,
    target: &Target,
    live: &mut Live,
    text: &str,
) -> Result<(), String> {
    let text = if text.trim().is_empty() {
        i18n::t(MsgKey::ReplyFinishedNoText, i18n::locale())
    } else {
        text.to_string()
    };
    if live.stream.is_none() {
        return target.send_text(client, &text).await;
    }
    match publish(client, target, live, &text, true).await {
        Ok(()) => Ok(()),
        Err(error) => {
            tracing::warn!(error = %error, "SeaTalk: closing the stream failed; delivering the reply as text");
            live.stream = None;
            target.send_text(client, &text).await
        }
    }
}

async fn publish(
    client: &SeaTalkClient,
    target: &Target,
    live: &mut Live,
    text: &str,
    finish: bool,
) -> Result<(), String> {
    let plan = frames_for(live.closed, &live.snapshot, text, finish, STREAM_CHAR_LIMIT);
    let mut stream = live.stream.take();
    for frame in plan.frames {
        match frame {
            Frame::Update { text, finish } => {
                let active = stream
                    .as_mut()
                    .ok_or_else(|| "SeaTalk reply stream unavailable".to_string())?;
                let returned = active.update(client, target, &text, finish).await;
                let msg_id = match returned {
                    Ok(msg_id) => msg_id,
                    Err(error) => {
                        live.stream = None;
                        return Err(error);
                    }
                };
                note_finish_id(live, msg_id, finish);
                if finish {
                    stream = None;
                }
            }
            Frame::Init { text } => match Stream::init(client, target, &text).await {
                Ok(next) => stream = Some(next),
                Err(error) => {
                    live.stream = None;
                    return Err(error);
                }
            },
        }
    }
    live.stream = stream;
    live.closed = plan.closed;
    live.snapshot = plan.snapshot;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum Frame {
    /// Replace the open stream. `finish` closes it.
    Update { text: String, finish: bool },
    /// Open the next stream. Its first snapshot is `text`.
    Init { text: String },
}

struct Plan {
    frames: Vec<Frame>,
    closed: usize,
    snapshot: String,
}

/// What to send so `text` becomes the visible reply.
///
/// An update replaces the whole open snapshot, so a reply that outgrows one
/// stream closes that stream and continues in the next. An unchanged snapshot
/// is not sent again; keepalive does that on its own timer.
fn frames_for(closed: usize, snapshot: &str, text: &str, finish: bool, limit: usize) -> Plan {
    let chunks = split_at(text, limit);
    if chunks.is_empty() {
        return Plan {
            frames: Vec::new(),
            closed,
            snapshot: snapshot.to_string(),
        };
    }
    let mut frames = Vec::new();
    let mut closed = closed.min(chunks.len());
    let mut snapshot = snapshot.to_string();
    if chunks.len() <= closed {
        if text != snapshot || finish {
            frames.push(Frame::Update {
                text: text.to_string(),
                finish,
            });
            snapshot = text.to_string();
        }
        return Plan {
            frames,
            closed,
            snapshot,
        };
    }
    let last = chunks.len() - 1;
    while closed < last {
        let chunk = chunks[closed].to_string();
        frames.push(Frame::Update {
            text: chunk,
            finish: true,
        });
        closed += 1;
        let next = chunks[closed].to_string();
        frames.push(Frame::Init { text: next.clone() });
        snapshot = next;
    }
    let current = chunks[closed].to_string();
    if current != snapshot || finish {
        frames.push(Frame::Update {
            text: current.clone(),
            finish,
        });
        snapshot = current;
    }
    if finish {
        closed = chunks.len();
    }
    Plan {
        frames,
        closed,
        snapshot,
    }
}

/// Split by Unicode characters, retaining all bytes. Each subsequent stream
/// stays in the same thread and keeps the same session binding.
fn split_at(text: &str, limit: usize) -> Vec<&str> {
    if limit == 0 {
        return vec![text];
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    for (count, (offset, _)) in text.char_indices().enumerate() {
        if count > 0 && count % limit == 0 {
            chunks.push(&text[start..offset]);
            start = offset;
        }
    }
    if start < text.len() {
        chunks.push(&text[start..]);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(plan: &Plan) -> Vec<(&str, bool)> {
        plan.frames
            .iter()
            .map(|frame| match frame {
                Frame::Update { text, finish } => (text.as_str(), *finish),
                Frame::Init { text } => (text.as_str(), false),
            })
            .collect()
    }

    #[test]
    fn the_first_reply_replaces_thinking_without_closing() {
        let plan = frames_for(0, "Thinking…", "先看一下日志", false, 4096);
        assert_eq!(texts(&plan), vec![("先看一下日志", false)]);
        assert_eq!(plan.closed, 0);
        assert_eq!(plan.snapshot, "先看一下日志");
    }

    #[test]
    fn a_later_reply_replaces_the_same_stream() {
        let plan = frames_for(0, "先看一下日志", "先看一下日志\n\n有三处报错", false, 4096);
        assert_eq!(texts(&plan), vec![("先看一下日志\n\n有三处报错", false)]);
    }

    #[test]
    fn an_unchanged_reply_sends_nothing() {
        let plan = frames_for(0, "先看一下日志", "先看一下日志", false, 4096);
        assert!(plan.frames.is_empty());
    }

    #[test]
    fn finish_closes_the_snapshot_already_shown() {
        let plan = frames_for(0, "先看一下日志", "先看一下日志", true, 4096);
        assert_eq!(texts(&plan), vec![("先看一下日志", true)]);
        assert_eq!(plan.closed, 1);
    }

    #[test]
    fn a_reply_past_the_limit_opens_the_next_stream() {
        let plan = frames_for(0, "Thinking…", "abcdefghij", false, 4);
        assert_eq!(
            plan.frames,
            vec![
                Frame::Update {
                    text: "abcd".into(),
                    finish: true,
                },
                Frame::Init {
                    text: "efgh".into(),
                },
                Frame::Update {
                    text: "efgh".into(),
                    finish: true,
                },
                Frame::Init { text: "ij".into() },
            ]
        );
        assert_eq!(plan.closed, 2);
        assert_eq!(plan.snapshot, "ij");
    }
}
