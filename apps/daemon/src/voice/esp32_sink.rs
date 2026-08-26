//! ESP32 inbound edge: cancel-in-flight, never queue.
//!
//! [`teamclu_gateway::session_queue::SessionQueue`] +
//! `channels::core::sink::CoreSink` are correct for chat windows: a second
//! message waits, and the channel is told "排在第 N 位". On a PTT voice device
//! that notice would be **spoken**, and the user who pressed again meant
//! "stop, try this instead" — not "line up behind myself".
//!
//! So this sink **bypasses** `SessionQueue` entirely. It does not change
//! `MAX_QUEUE_SIZE` for other channels. On `accept` while a turn is already
//! running for the same device:
//!
//! 1. cancel in-flight speech ([`ReplySpeaker::cancel`])
//! 2. cancel the runtime turn if we already know the session id
//! 3. abort the spawned turn task
//! 4. `tokio::spawn` the new message — never enqueue, never queue-notify
//!
//! Session id is sticky per device: a successful handled turn stores it so a
//! later barge-in can call [`RuntimeAdapter::cancel`]. The first press on a
//! cold device may only abort + stop speech until that id exists.
//!
//! The turn itself is injected as [`InboundTurnRunner`] (typically
//! `channels::core::sink::CoreTurnRunner` wrapping `Core::handle`) so this
//! module stays free of `crate::channels` — integration test crates include
//! `voice` without the channel pipeline.
//!
//! Mapping core errors → device `error` ctl is Task 1.5; failures are log-only
//! here.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use teamclu_gateway::driver::{ChannelDriver, InboundMessage, InboundSink};
use tokio::sync::Mutex;
use tokio::task::AbortHandle;
use tracing::{debug, error, info};
use uuid::Uuid;

use super::adapter::DeviceKey;
use super::spk::ReplySpeaker;
use crate::http::runtime_adapter::RuntimeAdapter;

/// Result of one inbound turn through the core (or a test double).
#[derive(Debug, Clone)]
pub struct TurnOutcome {
    /// Present when the message became a handled agent turn.
    pub session_id: Option<String>,
}

/// Runs one inbound message through the session pipeline.
///
/// Production wires this to `Core::handle`. Tests supply a fake that blocks or
/// records without pulling in `crate::channels`.
#[async_trait]
pub trait InboundTurnRunner: Send + Sync {
    async fn run(
        &self,
        driver: &dyn ChannelDriver,
        msg: InboundMessage,
    ) -> Result<TurnOutcome, String>;
}

/// One device's remembered session + optional in-flight accept.
#[derive(Default)]
struct DeviceState {
    /// Last handled session id (UUID), reused across turns.
    session_id: Option<Uuid>,
    in_flight: Option<InFlight>,
}

struct InFlight {
    abort: AbortHandle,
    external_message_id: String,
}

/// [`InboundSink`] for ESP32: interrupt replaces queue.
pub struct Esp32InboundSink {
    turns: Arc<dyn InboundTurnRunner>,
    driver: Arc<dyn ChannelDriver>,
    /// Fallback team when `reply_context` is absent (matches `Esp32Driver::team_id`).
    team_id: String,
    runtime: Arc<dyn RuntimeAdapter>,
    speaker: Arc<dyn ReplySpeaker>,
    /// Per-device turn state (Arc so spawned `process` can update it).
    active: Arc<Mutex<HashMap<DeviceKey, DeviceState>>>,
    /// Serialises `accept` per device so two concurrent presses cannot both
    /// spawn without the second cancelling the first.
    gates: Mutex<HashMap<DeviceKey, Arc<Mutex<()>>>>,
}

impl Esp32InboundSink {
    pub fn new(
        turns: Arc<dyn InboundTurnRunner>,
        driver: Arc<dyn ChannelDriver>,
        team_id: impl Into<String>,
        runtime: Arc<dyn RuntimeAdapter>,
        speaker: Arc<dyn ReplySpeaker>,
    ) -> Self {
        Self {
            turns,
            driver,
            team_id: team_id.into(),
            runtime,
            speaker,
            active: Arc::new(Mutex::new(HashMap::new())),
            gates: Mutex::new(HashMap::new()),
        }
    }

    /// `(team, actor)` for speech cancel and active-turn tracking.
    fn device_key(&self, msg: &InboundMessage) -> DeviceKey {
        if let Some(ctx) = msg.reply_context.as_deref() {
            let mut parts = ctx.split('/');
            if let (Some(team), Some(actor), Some(_device), None) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            {
                if !team.is_empty() && !actor.is_empty() {
                    return DeviceKey {
                        team_id: team.to_string(),
                        actor_id: actor.to_string(),
                    };
                }
            }
        }
        DeviceKey {
            team_id: self.team_id.clone(),
            actor_id: msg.conversation.id.clone(),
        }
    }

    async fn gate_for(&self, key: &DeviceKey) -> Arc<Mutex<()>> {
        let mut gates = self.gates.lock().await;
        gates
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn interrupt(&self, key: &DeviceKey) {
        let prev = {
            let mut active = self.active.lock().await;
            active.entry(key.clone()).or_default().in_flight.take()
        };
        let Some(flight) = prev else {
            return;
        };

        self.speaker.cancel(key).await;

        let session_id = self
            .active
            .lock()
            .await
            .get(key)
            .and_then(|s| s.session_id);
        if let Some(sid) = session_id {
            if let Err(e) = self.runtime.cancel(sid, None).await {
                debug!(
                    team_id = %key.team_id,
                    actor_id = %key.actor_id,
                    session_id = %sid,
                    error = %e,
                    "esp32: runtime cancel on barge-in failed"
                );
            }
        }

        flight.abort.abort();
        debug!(
            team_id = %key.team_id,
            actor_id = %key.actor_id,
            interrupted = %flight.external_message_id,
            "esp32: cancelled in-flight turn for barge-in"
        );
    }

    async fn process(
        turns: Arc<dyn InboundTurnRunner>,
        driver: Arc<dyn ChannelDriver>,
        active: Arc<Mutex<HashMap<DeviceKey, DeviceState>>>,
        key: DeviceKey,
        msg: InboundMessage,
    ) {
        let channel = msg.conversation.channel;
        let external_id = msg.external_message_id.clone();
        match turns.run(driver.as_ref(), msg).await {
            Ok(TurnOutcome {
                session_id: Some(session_id),
            }) => {
                info!(channel, session_id = %session_id, "esp32: turn complete");
                if let Ok(uuid) = Uuid::parse_str(&session_id) {
                    let mut g = active.lock().await;
                    g.entry(key.clone()).or_default().session_id = Some(uuid);
                }
            }
            Ok(TurnOutcome { session_id: None }) => {
                debug!(
                    channel,
                    external_id = %external_id,
                    "esp32: message not a handled turn"
                );
            }
            Err(e) => {
                // Task 1.5 maps errors → error ctl; keep log-only here.
                error!(
                    channel,
                    external_id = %external_id,
                    error = %e,
                    "esp32: message failed"
                );
            }
        }

        let mut g = active.lock().await;
        if let Some(state) = g.get_mut(&key) {
            if state
                .in_flight
                .as_ref()
                .is_some_and(|f| f.external_message_id == external_id)
            {
                state.in_flight = None;
            }
        }
    }
}

#[async_trait]
impl InboundSink for Esp32InboundSink {
    async fn accept(&self, msg: InboundMessage) {
        let key = self.device_key(&msg);
        let gate = self.gate_for(&key).await;
        let _serial = gate.lock().await;

        self.interrupt(&key).await;

        let turns = self.turns.clone();
        let driver = self.driver.clone();
        let active = self.active.clone();
        let key_for_task = key.clone();
        let external_message_id = msg.external_message_id.clone();

        let handle = tokio::spawn(async move {
            Self::process(turns, driver, active, key_for_task, msg).await;
        });

        let mut g = self.active.lock().await;
        g.entry(key).or_default().in_flight = Some(InFlight {
            abort: handle.abort_handle(),
            external_message_id,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use teamclu_gateway::driver::{
        ChannelCaps, ChannelId, Conversation, ConversationKind, DeliveryId, DriverError,
        ExternalSender, OutboundMessage, Threading, TurnEnd,
    };
    use tokio::sync::Notify;

    use crate::http::errors::HttpError;
    use crate::http::runtime_adapter::{
        CreateSessionParams, PromptAck, PromptParams, ReplayPage, SessionSnapshot,
        SubscriptionHandle,
    };

    // ── fakes ──────────────────────────────────────────────────────────────

    /// Blocks until `release`, returns a fixed session id.
    struct BlockingTurns {
        session_id: Uuid,
        release: Arc<Notify>,
        runs: AtomicUsize,
        finished: AtomicUsize,
    }

    #[async_trait]
    impl InboundTurnRunner for BlockingTurns {
        async fn run(
            &self,
            _driver: &dyn ChannelDriver,
            _msg: InboundMessage,
        ) -> Result<TurnOutcome, String> {
            self.runs.fetch_add(1, Ordering::SeqCst);
            self.release.notified().await;
            self.finished.fetch_add(1, Ordering::SeqCst);
            Ok(TurnOutcome {
                session_id: Some(self.session_id.to_string()),
            })
        }
    }

    struct InstantTurns {
        session_id: Uuid,
    }

    #[async_trait]
    impl InboundTurnRunner for InstantTurns {
        async fn run(
            &self,
            _driver: &dyn ChannelDriver,
            _msg: InboundMessage,
        ) -> Result<TurnOutcome, String> {
            Ok(TurnOutcome {
                session_id: Some(self.session_id.to_string()),
            })
        }
    }

    async fn wait_runs(turns: &BlockingTurns, n: usize) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while turns.runs.load(Ordering::SeqCst) < n {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {n} turn run(s)"));
    }

    async fn wait_finished(turns: &BlockingTurns, n: usize) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while turns.finished.load(Ordering::SeqCst) < n {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {n} finished turn(s)"));
    }

    #[derive(Default)]
    struct RecordingDriver {
        delivered: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait]
    impl ChannelDriver for RecordingDriver {
        fn id(&self) -> ChannelId {
            "esp32"
        }
        fn caps(&self) -> ChannelCaps {
            ChannelCaps {
                streaming_edit: false,
                media_upload: false,
                interactive: true,
                threading: Threading::Inline,
                max_chars: 0,
                turn_timeout_secs: 60,
            }
        }
        fn binding(&self, c: &Conversation) -> String {
            format!("esp32://team-1/{}", c.id)
        }
        fn sender_urn(&self, _c: &Conversation, s: &ExternalSender) -> String {
            format!("esp32:{}", s.external_id)
        }
        fn session_title(&self, _c: &Conversation, s: &ExternalSender) -> String {
            format!("StopWatch {}", s.external_id)
        }
        async fn deliver(
            &self,
            _to: &Conversation,
            _reply_context: Option<&str>,
            msg: &OutboundMessage,
        ) -> Result<DeliveryId, DriverError> {
            self.delivered.lock().unwrap().push(msg.text.clone());
            Ok(DeliveryId("d1".into()))
        }
        async fn update(
            &self,
            _id: &DeliveryId,
            _text: &str,
            _end: Option<TurnEnd>,
        ) -> Result<(), DriverError> {
            Ok(())
        }
    }

    struct RecordingRuntime {
        cancels: Mutex<Vec<(Uuid, Option<Uuid>)>>,
    }

    impl RecordingRuntime {
        fn new() -> Self {
            Self {
                cancels: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl RuntimeAdapter for RecordingRuntime {
        async fn create_session(
            &self,
            _owner: Uuid,
            _p: CreateSessionParams,
        ) -> Result<SessionSnapshot, HttpError> {
            Err(HttpError::not_found("unused"))
        }
        async fn get_session(&self, _id: Uuid) -> Result<SessionSnapshot, HttpError> {
            Err(HttpError::not_found("unused"))
        }
        async fn list_sessions(&self, _owner: Uuid) -> Vec<SessionSnapshot> {
            Vec::new()
        }
        async fn close_session(&self, _id: Uuid) -> Result<(), HttpError> {
            Ok(())
        }
        async fn send_prompt(
            &self,
            _id: Uuid,
            _p: PromptParams,
        ) -> Result<PromptAck, HttpError> {
            Err(HttpError::not_found("unused"))
        }
        async fn set_model(&self, _id: Uuid, _m: String) -> Result<(), HttpError> {
            Ok(())
        }
        async fn reply_permission(
            &self,
            _id: Uuid,
            _r: String,
            _g: bool,
            _o: Option<String>,
        ) -> Result<(), HttpError> {
            Ok(())
        }
        async fn restart_session(&self, _id: Uuid) -> Result<SessionSnapshot, HttpError> {
            Err(HttpError::not_found("unused"))
        }
        async fn cancel(&self, id: Uuid, turn: Option<Uuid>) -> Result<(), HttpError> {
            self.cancels.lock().await.push((id, turn));
            Ok(())
        }
        async fn subscribe(
            &self,
            _id: Uuid,
            _since: Option<u64>,
        ) -> Result<SubscriptionHandle, HttpError> {
            Err(HttpError::not_found("unused"))
        }
        async fn replay(
            &self,
            _id: Uuid,
            _since: u64,
            _limit: usize,
        ) -> Result<ReplayPage, HttpError> {
            Err(HttpError::not_found("unused"))
        }
    }

    struct RecordingSpeaker {
        cancels: Mutex<usize>,
    }

    #[async_trait]
    impl ReplySpeaker for RecordingSpeaker {
        async fn begin(&self, _key: DeviceKey, _session_id: Uuid) {}
        async fn cancel(&self, _key: &DeviceKey) {
            *self.cancels.lock().await += 1;
        }
        async fn fail(&self, _key: &DeviceKey, _code: &str, _message: &str) {}
    }

    fn msg(id: &str, text: &str) -> InboundMessage {
        InboundMessage {
            conversation: Conversation {
                channel: "esp32",
                bot_id: None,
                kind: ConversationKind::Direct,
                id: "actor-1".into(),
            },
            sender: ExternalSender {
                external_id: "dev-aabbcc".into(),
                display_name: "StopWatch".into(),
                email: None,
            },
            external_message_id: id.into(),
            text: text.into(),
            attachments: Vec::new(),
            addressed_to_bot: true,
            quoted_text: None,
            reply_context: Some("team-1/actor-1/dev-aabbcc".into()),
        }
    }

    async fn seed_session(sink: &Esp32InboundSink, session_id: Uuid) {
        let mut g = sink.active.lock().await;
        g.insert(
            DeviceKey {
                team_id: "team-1".into(),
                actor_id: "actor-1".into(),
            },
            DeviceState {
                session_id: Some(session_id),
                in_flight: None,
            },
        );
    }

    fn sink_with(
        turns: Arc<dyn InboundTurnRunner>,
        runtime: Arc<RecordingRuntime>,
        speaker: Arc<RecordingSpeaker>,
        driver: Arc<RecordingDriver>,
    ) -> Esp32InboundSink {
        Esp32InboundSink::new(
            turns,
            driver as Arc<dyn ChannelDriver>,
            "team-1",
            runtime as Arc<dyn RuntimeAdapter>,
            speaker as Arc<dyn ReplySpeaker>,
        )
    }

    #[tokio::test]
    async fn second_accept_cancels_runtime_and_speak_then_processes() {
        let session_id = Uuid::new_v4();
        let release = Arc::new(Notify::new());
        let blocking = Arc::new(BlockingTurns {
            session_id,
            release: release.clone(),
            runs: AtomicUsize::new(0),
            finished: AtomicUsize::new(0),
        });

        let recording = Arc::new(RecordingDriver::default());
        let runtime = Arc::new(RecordingRuntime::new());
        let speaker = Arc::new(RecordingSpeaker {
            cancels: Mutex::new(0),
        });

        let sink = sink_with(
            blocking.clone() as Arc<dyn InboundTurnRunner>,
            runtime.clone(),
            speaker.clone(),
            recording.clone(),
        );
        seed_session(&sink, session_id).await;

        sink.accept(msg("block-1", "first question")).await;
        wait_runs(&blocking, 1).await;

        sink.accept(msg("block-2", "interrupt")).await;

        assert_eq!(
            *speaker.cancels.lock().await,
            1,
            "barge-in must cancel speak"
        );
        {
            let cancels = runtime.cancels.lock().await;
            assert_eq!(cancels.len(), 1, "barge-in must cancel runtime session");
            assert_eq!(cancels[0].0, session_id);
            assert!(cancels[0].1.is_none());
        }

        wait_runs(&blocking, 2).await;
        release.notify_waiters();
        wait_finished(&blocking, 1).await;

        let texts = recording.delivered.lock().unwrap().clone();
        for t in &texts {
            assert!(
                !t.contains("排队") && !t.contains("排在第"),
                "must not speak queue notices, got {t:?}"
            );
        }
    }

    #[tokio::test]
    async fn barge_in_never_delivers_queue_position_chinese() {
        let session_id = Uuid::new_v4();
        let release = Arc::new(Notify::new());
        let blocking = Arc::new(BlockingTurns {
            session_id,
            release: release.clone(),
            runs: AtomicUsize::new(0),
            finished: AtomicUsize::new(0),
        });
        let recording = Arc::new(RecordingDriver::default());
        let runtime = Arc::new(RecordingRuntime::new());
        let speaker = Arc::new(RecordingSpeaker {
            cancels: Mutex::new(0),
        });

        let sink = sink_with(
            blocking.clone() as Arc<dyn InboundTurnRunner>,
            runtime,
            speaker,
            recording.clone(),
        );
        seed_session(&sink, session_id).await;

        sink.accept(msg("q1", "one")).await;
        wait_runs(&blocking, 1).await;
        sink.accept(msg("q2", "two")).await;
        wait_runs(&blocking, 2).await;
        release.notify_waiters();
        wait_finished(&blocking, 1).await;

        let texts = recording.delivered.lock().unwrap().clone();
        for t in &texts {
            assert!(
                !t.contains("排队") && !t.contains("排在第"),
                "must not speak queue notices, got {t:?}"
            );
        }
    }

    #[tokio::test]
    async fn handled_stores_sticky_session_for_later_cancel() {
        let session_id = Uuid::new_v4();
        let recording = Arc::new(RecordingDriver::default());
        let runtime = Arc::new(RecordingRuntime::new());
        let speaker = Arc::new(RecordingSpeaker {
            cancels: Mutex::new(0),
        });

        let sink = sink_with(
            Arc::new(InstantTurns { session_id }) as Arc<dyn InboundTurnRunner>,
            runtime,
            speaker,
            recording,
        );

        sink.accept(msg("warm-1", "hello")).await;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let g = sink.active.lock().await;
                let key = DeviceKey {
                    team_id: "team-1".into(),
                    actor_id: "actor-1".into(),
                };
                if g.get(&key).and_then(|s| s.session_id) == Some(session_id) {
                    break;
                }
                drop(g);
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("handled turn must store sticky session_id");
    }
}
