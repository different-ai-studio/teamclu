//! Present a completed agent reply on the message that initially said Thinking.
//! Protocol: https://open.seatalk.io/docs/send-streaming-message
//!
//! The worker receives exactly one complete reply, not ACP deltas. While it
//! waits, it refreshes the placeholder inside SeaTalk's 30-second idle limit.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use super::{build_text_message, decode_conv_id, optional_id, SeaTalkClient};
use crate::driver::{BufferedReply, Conversation, ConversationKind, DriverError, OutboundMessage};
use crate::i18n::{self, MsgKey};

const KEEPALIVE: Duration = Duration::from_secs(10);
const FRAME_INTERVAL: Duration = Duration::from_millis(200);
const FRAME_CHARS: usize = 128;
const STREAM_CHAR_LIMIT: usize = 4096;

struct Completion {
    text: String,
    done: oneshot::Sender<Result<(), String>>,
}

/// Its sender is the worker's lifetime guard. If the core is dropped or fails
/// before finishing, receiver closure closes the waiting placeholder too.
pub(super) struct SeaTalkBufferedReply {
    completion: Option<mpsc::UnboundedSender<Completion>>,
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
    ) -> Result<(), String> {
        self.seq += 1;
        let mut body = target.body();
        body["stream_id"] = json!(self.id);
        body["seq"] = json!(self.seq);
        body["finish"] = json!(finish);
        // Each update replaces the snapshot. The init placeholder is not a
        // prefix of the answer; update samples in the API use answer text only.
        body["message"] = json!({ "text": { "format": 1, "content": text } });
        client
            .api_call(
                reqwest::Method::POST,
                target.endpoint(false),
                Some(body),
                true,
            )
            .await?;
        Ok(())
    }
}

impl SeaTalkBufferedReply {
    pub(super) async fn start(client: Arc<SeaTalkClient>, to: Conversation) -> Option<Self> {
        let target = Target::new(&to);
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
        tokio::spawn(wait_for_reply(client, target, thinking, stream, rx));
        Some(Self {
            completion: Some(tx),
        })
    }
}

#[async_trait::async_trait]
impl BufferedReply for SeaTalkBufferedReply {
    async fn finish(&mut self, msg: &OutboundMessage) -> Result<(), DriverError> {
        let sender = self
            .completion
            .take()
            .ok_or_else(|| DriverError::Transport("SeaTalk reply already finished".into()))?;
        let (done, result) = oneshot::channel();
        sender
            .send(Completion {
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

async fn wait_for_reply(
    client: Arc<SeaTalkClient>,
    target: Target,
    thinking: String,
    mut stream: Option<Stream>,
    mut rx: mpsc::UnboundedReceiver<Completion>,
) {
    let mut heartbeat = tokio::time::interval(KEEPALIVE);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    loop {
        tokio::select! {
            biased;
            completion = rx.recv() => {
                match completion {
                    Some(completion) => {
                        let text = if completion.text.trim().is_empty() {
                            i18n::t(MsgKey::ReplyFinishedNoText, i18n::locale())
                        } else {
                            completion.text
                        };
                        let result = present_reply(&client, &target, stream, &thinking, &text).await;
                        let _ = completion.done.send(result);
                    }
                    None => {
                        if let Some(mut stream) = stream {
                            let stopped = i18n::t(MsgKey::SessionStopped, i18n::locale());
                            if let Err(error) = stream.update(&client, &target, &stopped, true).await {
                                tracing::warn!(error = %error, "SeaTalk: could not close abandoned placeholder");
                            }
                        }
                    }
                }
                return;
            }
            _ = heartbeat.tick() => {
                if let Some(active) = stream.as_mut() {
                    if let Err(error) = active.update(&client, &target, &thinking, false).await {
                        // SeaTalk terminates a stream after an error. Never
                        // reference it again; preserve the final-text fallback.
                        tracing::warn!(error = %error, "SeaTalk: placeholder keepalive failed");
                        stream = None;
                    }
                }
            }
        }
    }
}

async fn present_reply(
    client: &SeaTalkClient,
    target: &Target,
    mut stream: Option<Stream>,
    thinking: &str,
    text: &str,
) -> Result<(), String> {
    if stream.is_none() {
        return target.send_text(client, text).await;
    }
    let chunks = split_stream_text(text);
    for (index, chunk) in chunks.iter().enumerate() {
        if index > 0 {
            stream = match Stream::init(client, target, thinking).await {
                Ok(stream) => Some(stream),
                Err(error) => {
                    tracing::warn!(error = %error, "SeaTalk: next reply stream unavailable");
                    None
                }
            };
        }
        let result = match stream.as_mut() {
            Some(active) => reveal_text(client, target, active, chunk).await,
            None => Err("SeaTalk reply stream unavailable".to_string()),
        };
        if let Err(error) = result {
            tracing::warn!(error = %error, "SeaTalk: streaming failed; delivering remaining reply as text");
            // Include the current chunk: a failed request may not have reached
            // SeaTalk. Previously completed chunks need not be sent again.
            return target.send_text(client, &chunks[index..].concat()).await;
        }
    }
    Ok(())
}

/// Split by Unicode characters, retaining all bytes. Each subsequent stream
/// stays in the same thread and keeps the same session binding.
fn split_stream_text(text: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut start = 0;
    for (count, (offset, _)) in text.char_indices().enumerate() {
        if count > 0 && count % STREAM_CHAR_LIMIT == 0 {
            chunks.push(&text[start..offset]);
            start = offset;
        }
    }
    if start < text.len() {
        chunks.push(&text[start..]);
    }
    chunks
}

async fn reveal_text(
    client: &SeaTalkClient,
    target: &Target,
    stream: &mut Stream,
    text: &str,
) -> Result<(), String> {
    // Short answers should also unfold across several snapshots. Long answers
    // cap each frame so a full 4096-character stream still advances regularly.
    let frame_chars = text.chars().count().div_ceil(8).clamp(1, FRAME_CHARS);
    for (count, (offset, ch)) in text.char_indices().enumerate() {
        let end = offset + ch.len_utf8();
        if (count + 1) % frame_chars == 0 || end == text.len() {
            let finish = end == text.len();
            stream.update(client, target, &text[..end], finish).await?;
            if !finish {
                tokio::time::sleep(FRAME_INTERVAL).await;
            }
        }
    }
    Ok(())
}
