//! Where a gateway hands a normalized message to the core.
//!
//! The gateway crate cannot call the daemon (it is a leaf both the daemon and
//! the desktop depend on), so the daemon implements
//! [`teamclu_gateway::driver::InboundSink`] and injects it at boot.

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use teamclu_gateway::driver::{
    ChannelDriver, Conversation, InboundMessage, InboundSink, OutboundMessage,
};
use teamclu_gateway::i18n::{self, MsgKey};
use teamclu_gateway::session_queue::{EnqueueResult, QueuedMessage, RejectReason, SessionQueue};

use super::{Core, Outcome};

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
}

impl CoreSink {
    /// Run one message through the pipeline, reporting the outcome.
    async fn process(core: Arc<Core>, driver: Arc<dyn ChannelDriver>, msg: InboundMessage) {
        let channel = msg.conversation.channel;
        let external_id = msg.external_message_id.clone();
        match core.handle(driver.as_ref(), msg).await {
            Ok(Outcome::Handled {
                session_id,
                deliveries,
            }) => {
                tracing::info!(channel, session_id, deliveries, "gateway: turn complete");
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
            tokio::spawn(Self::process(core, driver, msg));
            return;
        }

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
                    process_fn: Box::new(move || Box::pin(Self::process(core, driver, msg))),
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
                Self::notify(
                    self.driver.clone(),
                    conversation,
                    i18n::t(MsgKey::QueuedBehind(position), i18n::locale()),
                )
                .await;
            }
            // The reject notice was already delivered by `notify_fn`.
            EnqueueResult::Full => {
                tracing::warn!(key, "gateway: queue full; message rejected");
            }
        }
    }
}

/// Wraps [`Core`] as an [`crate::voice::InboundTurnRunner`] for ESP32.
///
/// Used when constructing [`crate::voice::Esp32InboundSink`] (Task 1.6 wiring).
#[allow(dead_code)] // wired in Task 1.6 (VoiceRouter → core fork)
pub struct CoreTurnRunner {
    pub core: Arc<Core>,
}

#[async_trait]
impl crate::voice::InboundTurnRunner for CoreTurnRunner {
    async fn run(
        &self,
        driver: &dyn ChannelDriver,
        msg: InboundMessage,
    ) -> Result<crate::voice::TurnOutcome, String> {
        match self.core.handle(driver, msg).await {
            Ok(Outcome::Handled { session_id, .. }) => Ok(crate::voice::TurnOutcome {
                session_id: Some(session_id),
            }),
            Ok(_) => Ok(crate::voice::TurnOutcome { session_id: None }),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Whether this daemon routes gateways through the core pipeline.
///
/// On by default. `TEAMCLU_GATEWAY_CORE=0` falls back to each gateway's inline
/// handler — a switch for the first live round trip, to be deleted with the
/// inline handlers once that has happened.
pub fn core_pipeline_enabled() -> bool {
    !matches!(
        std::env::var("TEAMCLU_GATEWAY_CORE").as_deref(),
        Ok("0") | Ok("false") | Ok("off")
    )
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

    #[test]
    fn the_core_pipeline_is_on_unless_explicitly_turned_off() {
        // A typo'd value must not silently disable it: only the three spellings
        // of "off" count, everything else stays on.
        let cases = [
            (None, true),
            (Some("0"), false),
            (Some("false"), false),
            (Some("off"), false),
            (Some("1"), true),
            (Some("yes"), true),
            (Some(""), true),
        ];
        for (value, expected) in cases {
            match value {
                Some(v) => std::env::set_var("TEAMCLU_GATEWAY_CORE", v),
                None => std::env::remove_var("TEAMCLU_GATEWAY_CORE"),
            }
            assert_eq!(core_pipeline_enabled(), expected, "for {value:?}");
        }
        std::env::remove_var("TEAMCLU_GATEWAY_CORE");
    }
}
