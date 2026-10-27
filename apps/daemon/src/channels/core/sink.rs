//! Where a gateway hands a normalized message to the core.
//!
//! The gateway crate cannot call the daemon (it is a leaf both the daemon and
//! the desktop depend on), so the daemon implements
//! [`teamclu_gateway::driver::InboundSink`] and injects it at boot.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Instant;

use crate::channels::session_queue::{EnqueueResult, QueuedMessage, RejectReason, SessionQueue};
use async_trait::async_trait;
use futures::future::{BoxFuture, Shared};
use futures::FutureExt;
use teamclu_gateway::driver::{
    BufferedReply, ChannelDriver, Conversation, InboundMessage, InboundSink, OutboundMessage,
};
use teamclu_gateway::i18n::{self, MsgKey};
use tokio::sync::{oneshot, Mutex, OwnedMutexGuard};

use super::{Core, CoreError, Outcome};

#[derive(Default)]
struct PreparedReply {
    has_placeholder: bool,
    pending: Mutex<Option<Box<dyn BufferedReply>>>,
}

type PreparingReply = Shared<BoxFuture<'static, Arc<PreparedReply>>>;

/// One channel's inbound edge: its driver plus the shared pipeline.
pub struct CoreSink {
    pub core: Arc<Core>,
    pub driver: Arc<dyn ChannelDriver>,
    /// One turn at a time per conversation.
    ///
    /// Without it every inbound message spawned its own turn, and two messages
    /// in one chat raced for the same runtime: the second waited out the whole
    /// turn timeout and then failed, because single-session runtimes (pi) hold
    /// their child for the turn's duration. Serialising is also what the sender
    /// expects — a chat is a conversation, not a thread pool.
    pub queue: Arc<SessionQueue>,
    /// Serializes only admission/startup of appendable turns. Once Pi is
    /// accepting context the running turn releases the gate, so later input
    /// never waits for its completed reply. Weak entries do not retain chats.
    pub(crate) append_gates: StdMutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl CoreSink {
    /// Run one message through the pipeline, reporting the outcome.
    async fn process(
        core: Arc<Core>,
        driver: Arc<dyn ChannelDriver>,
        msg: InboundMessage,
        prepared: Option<PreparingReply>,
    ) {
        let channel = msg.conversation.channel;
        let external_id = msg.external_message_id.clone();
        let result = match prepared {
            Some(prepared) => {
                let pending = prepared.await.pending.lock().await.take();
                core.handle_prepared(driver.as_ref(), msg, pending).await
            }
            None => core.handle(driver.as_ref(), msg).await,
        };
        Self::report(channel, &external_id, result);
    }

    fn report(channel: &str, external_id: &str, result: Result<Outcome, CoreError>) {
        match result {
            Ok(Outcome::Handled {
                session_id,
                deliveries,
            }) => {
                tracing::info!(channel, session_id, deliveries, "gateway: turn complete");
            }
            Ok(Outcome::ContextAppended { session_id }) => {
                tracing::info!(
                    channel,
                    session_id,
                    external_id,
                    "gateway: context appended to live turn"
                );
            }
            Ok(other) => {
                tracing::debug!(channel, external_id, ?other, "gateway: message not a turn");
            }
            Err(e) => {
                // Loud: the sender is waiting and nothing else reports this.
                tracing::error!(channel, external_id, error = %e, "gateway: message failed");
            }
        }
    }

    fn append_gate(&self, binding: &str) -> Arc<Mutex<()>> {
        let mut gates = self.append_gates.lock().unwrap();
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(binding).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(Mutex::new(()));
        gates.insert(binding.to_string(), Arc::downgrade(&gate));
        gate
    }

    async fn process_appendable(
        core: Arc<Core>,
        driver: Arc<dyn ChannelDriver>,
        msg: InboundMessage,
        guard: OwnedMutexGuard<()>,
    ) {
        let binding = driver.binding(&msg.conversation);
        let initial_turn = core.turns.active_turn(&binding).await;
        let pending = if initial_turn.is_none() {
            core.prepare_buffered_reply(driver.as_ref(), &msg).await
        } else {
            None
        };
        let channel = msg.conversation.channel;
        let external_id = msg.external_message_id.clone();
        let work = core.handle_prepared(driver.as_ref(), msg, pending);
        tokio::pin!(work);
        let mut guard = Some(guard);
        let result = loop {
            tokio::select! {
                biased;
                result = &mut work => break result,
                _ = tokio::time::sleep(std::time::Duration::from_millis(25)), if guard.is_some() => {
                    let current = core.turns.active_turn(&binding).await;
                    if current.is_some() && current != initial_turn {
                        // Keep input ordered through cold startup and context
                        // preparation; release as soon as the new turn can be
                        // steered. The original collector keeps running here.
                        guard.take();
                    }
                }
            }
        };
        Self::report(channel, &external_id, result);
    }

    /// Tell the chat its message is not being answered, and why.
    async fn notify(driver: Arc<dyn ChannelDriver>, to: Conversation, text: String) {
        let out = OutboundMessage {
            text,
            attachments: Vec::new(),
            question: None,
        };
        if let Err(e) = driver.deliver(&to, None, &out).await {
            tracing::warn!(error = %e, "gateway: queue notice could not be delivered");
        }
    }
}

/// A slash command is an instruction *about* the conversation, not a turn in
/// it. Queueing `/stop` behind the turn it is meant to stop would make it
/// arrive after the thing it was cancelling had already finished.
fn is_command(text: &str) -> bool {
    text.trim_start().starts_with('/')
}

#[async_trait]
impl InboundSink for CoreSink {
    async fn accept(&self, msg: InboundMessage) {
        let core = self.core.clone();
        let driver = self.driver.clone();

        // Spawned either way so the transport's read loop keeps draining while
        // a turn runs. A turn is minutes on a slow model; holding the websocket
        // loop for it would stall every other conversation on the connection.
        if is_command(&msg.text) {
            tokio::spawn(Self::process(core, driver, msg, None));
            return;
        }

        // Awaited, not spawned: a picture posted just before "@bot what is
        // this" has to be in the silent queue before that turn reads it.
        if !msg.addressed_to_bot && driver.records_unaddressed() {
            match core.record_silent(driver.as_ref(), msg).await {
                Ok(outcome) => tracing::debug!(?outcome, "gateway: recorded without a turn"),
                Err(error) => tracing::warn!(%error, "gateway: unaddressed message not recorded"),
            }
            return;
        }
        if let Some(outcome) = core.claim_message(&msg).await {
            tracing::debug!(external_id = %msg.external_message_id, ?outcome, "gateway: message not a turn");
            return;
        }
        if driver.append_during_turn() {
            let gate = self.append_gate(&driver.binding(&msg.conversation));
            let guard = gate.lock_owned().await;
            tokio::spawn(Self::process_appendable(core, driver, msg, guard));
            return;
        }
        // Start the placeholder at receipt, including for queued messages.
        // The API runs separately so it cannot stall the transport loop or
        // reorder messages in the session queue when one request is slow.
        let (ready, waiting) = oneshot::channel();
        let prepare_driver = driver.clone();
        let to = msg.conversation.clone();
        let context = msg.reply_context.clone();
        tokio::spawn(async move {
            let pending = if !prepare_driver.caps().streaming_edit {
                match prepare_driver
                    .prepare_buffered_reply(&to, context.as_deref())
                    .await
                {
                    Ok(pending) => pending,
                    Err(error) => {
                        tracing::warn!(error = %error, "gateway: placeholder unavailable; using ordinary delivery");
                        None
                    }
                }
            } else {
                None
            };
            let _ = ready.send(Arc::new(PreparedReply {
                has_placeholder: pending.is_some(),
                pending: Mutex::new(pending),
            }));
        });
        let prepared = async move { waiting.await.unwrap_or_default() }
            .boxed()
            .shared();
        let reject_reply = prepared.clone();
        let queued_reply = prepared.clone();
        let key = self.driver.binding(&msg.conversation);
        let conversation = msg.conversation.clone();
        let notify_conversation = conversation.clone();
        let notify_driver = self.driver.clone();
        let queued = self
            .queue
            .enqueue(
                &key,
                QueuedMessage {
                    enqueued_at: Instant::now(),
                    process_fn: Box::new(move || {
                        Box::pin(Self::process(core, driver, msg, Some(prepared)))
                    }),
                    notify_fn: Some(Box::new(move |reason| {
                        Box::pin(async move {
                            let text = match reason {
                                RejectReason::QueueFull => {
                                    i18n::t(MsgKey::QueueFull, i18n::locale())
                                }
                                RejectReason::Timeout => {
                                    i18n::t(MsgKey::QueueTimeout, i18n::locale())
                                }
                                RejectReason::SessionClosed => {
                                    i18n::t(MsgKey::GatewayShuttingDown, i18n::locale())
                                }
                            };
                            let pending = reject_reply.await.pending.lock().await.take();
                            if let Some(mut pending) = pending {
                                let out = OutboundMessage {
                                    text: text.clone(),
                                    ..Default::default()
                                };
                                if pending.finish(&out).await.is_ok() {
                                    return;
                                }
                            }
                            Self::notify(notify_driver, notify_conversation, text).await;
                        })
                    })),
                },
            )
            .await;

        match queued {
            EnqueueResult::Processing => {}
            EnqueueResult::Queued { position } => {
                tracing::info!(
                    key,
                    position,
                    "gateway: message queued behind a running turn"
                );
                // Silence here reads as "the bot ignored me", which is what
                // sending again — and making the queue longer — comes from.
                let queued_driver = self.driver.clone();
                tokio::spawn(async move {
                    // The placeholder acknowledges receipt while it waits.
                    // Other channels keep their queue-position notice.
                    if !queued_reply.await.has_placeholder {
                        Self::notify(
                            queued_driver,
                            conversation,
                            i18n::t(MsgKey::QueuedBehind(position), i18n::locale()),
                        )
                        .await;
                    }
                });
            }
            // The reject notice was already delivered by `notify_fn`.
            EnqueueResult::Full => {
                tracing::warn!(key, "gateway: queue full; message rejected");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_commands_skip_the_queue() {
        // `/stop` exists to end the turn that is holding the queue. Queueing it
        // behind that turn would deliver it after the thing it cancels is done.
        assert!(is_command("/stop"));
        assert!(is_command("  /new"));
        assert!(is_command("/model deepseek/v4"));
        // Everything else is a turn and waits its go.
        assert!(!is_command("top10 体育新闻"));
        assert!(!is_command("what about /stop"));
        assert!(!is_command(""));
    }
}
