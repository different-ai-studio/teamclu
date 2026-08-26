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
//! 1. cancel in-flight speech ([`ReplySpeaker::cancel`]) — also when the
//!    previous turn finished but TTS may still be playing
//! 2. cancel the **agent** turn via [`AgentHandle::cancel`] with the sticky
//!    ACP session id (Core drives turns through ACP, not HTTP RuntimeAdapter)
//! 3. abort the spawned turn task
//! 4. `tokio::spawn` the new message — never enqueue, never queue-notify
//!
//! Sticky id is the **ACP** session id from a successful handled turn, so a
//! later barge-in can stop the live agent. The first press on a cold device
//! may only abort + stop speech until that id exists.
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
use teamclu_gateway::agent::AgentHandle;
use teamclu_gateway::driver::{ChannelDriver, InboundMessage, InboundSink};
use tokio::sync::Mutex;
use tokio::task::AbortHandle;
use tracing::{debug, error, info};

use super::adapter::DeviceKey;
use super::spk::ReplySpeaker;

/// Result of one inbound turn through the core (or a test double).
#[derive(Debug, Clone)]
pub struct TurnOutcome {
    /// Cloud / store session id (informational).
    pub session_id: Option<String>,
    /// ACP session id — what [`AgentHandle::cancel`] / `send_prompt` address.
    pub acp_session_id: Option<String>,
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
    /// Last handled ACP session id — used to cancel the live agent turn.
    acp_session_id: Option<String>,
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
    /// Cancels the in-flight Core / ACP turn (`send_prompt` path).
    agent: Arc<dyn AgentHandle>,
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
        agent: Arc<dyn AgentHandle>,
        speaker: Arc<dyn ReplySpeaker>,
    ) -> Self {
        Self {
            turns,
            driver,
            team_id: team_id.into(),
            agent,
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

    /// Stop TTS always; if a turn is in flight, also cancel the ACP agent and
    /// abort the spawned `Core::handle` task.
    async fn interrupt(&self, key: &DeviceKey) {
        let (prev, acp_session_id) = {
            let mut active = self.active.lock().await;
            let state = active.entry(key.clone()).or_default();
            (state.in_flight.take(), state.acp_session_id.clone())
        };

        // Always — turn may have finished while TTS is still draining.
        self.speaker.cancel(key).await;

        if let Some(flight) = prev {
            if let Some(acp) = acp_session_id.as_ref() {
                if let Err(e) = self.agent.cancel(acp).await {
                    debug!(
                        team_id = %key.team_id,
                        actor_id = %key.actor_id,
                        acp_session_id = %acp,
                        error = %e,
                        "esp32: AgentHandle cancel on barge-in failed"
                    );
                }
            }
            flight.abort.abort();
            debug!(
                team_id = %key.team_id,
                actor_id = %key.actor_id,
                interrupted = %flight.external_message_id,
                acp_session_id = acp_session_id.as_deref().unwrap_or("-"),
                "esp32: cancelled in-flight turn for barge-in"
            );
        }
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
                session_id,
                acp_session_id: Some(acp),
            }) => {
                info!(
                    channel,
                    session_id = session_id.as_deref().unwrap_or("-"),
                    acp_session_id = %acp,
                    "esp32: turn complete"
                );
                let mut g = active.lock().await;
                g.entry(key.clone()).or_default().acp_session_id = Some(acp);
            }
            Ok(TurnOutcome {
                acp_session_id: None,
                ..
            }) => {
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
    use teamclu_gateway::agent::{
        AgentCommand, AgentError, AgentHandle, AmuxSessionId, ModelInfo, WorkspaceInfo,
    };
    use teamclu_gateway::driver::{
        ChannelCaps, ChannelId, Conversation, ConversationKind, DeliveryId, DriverError,
        ExternalSender, OutboundMessage, Threading, TurnEnd,
    };
    use tokio::sync::Notify;

    // ── fakes ──────────────────────────────────────────────────────────────

    /// Blocks until `release`, returns fixed cloud + ACP session ids.
    struct BlockingTurns {
        session_id: String,
        acp_session_id: String,
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
                session_id: Some(self.session_id.clone()),
                acp_session_id: Some(self.acp_session_id.clone()),
            })
        }
    }

    struct InstantTurns {
        session_id: String,
        acp_session_id: String,
    }

    #[async_trait]
    impl InboundTurnRunner for InstantTurns {
        async fn run(
            &self,
            _driver: &dyn ChannelDriver,
            _msg: InboundMessage,
        ) -> Result<TurnOutcome, String> {
            Ok(TurnOutcome {
                session_id: Some(self.session_id.clone()),
                acp_session_id: Some(self.acp_session_id.clone()),
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

    /// Records [`AgentHandle::cancel`] calls by ACP session id.
    struct RecordingAgent {
        cancels: Mutex<Vec<String>>,
    }

    impl RecordingAgent {
        fn new() -> Self {
            Self {
                cancels: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl AgentHandle for RecordingAgent {
        async fn create_session(
            &self,
            _team_id: &str,
            _binding: &str,
            _title: &str,
        ) -> Result<AmuxSessionId, AgentError> {
            Err(AgentError::Create("unused".into()))
        }
        async fn send_prompt(
            &self,
            _session: &AmuxSessionId,
            _sender: &str,
            _text: &str,
            _timeout: std::time::Duration,
        ) -> Result<teamclu_gateway::agent::TurnOutcome, AgentError> {
            Err(AgentError::Send("unused".into()))
        }
        async fn inject_context(
            &self,
            _session: &AmuxSessionId,
            _sender: &str,
            _text: &str,
        ) -> Result<(), AgentError> {
            Ok(())
        }
        async fn cancel(&self, session: &AmuxSessionId) -> Result<(), AgentError> {
            self.cancels.lock().await.push(session.clone());
            Ok(())
        }
        async fn reset_session(&self, _session: &AmuxSessionId) -> Result<(), AgentError> {
            Ok(())
        }
        async fn list_models(
            &self,
            _session: &AmuxSessionId,
        ) -> Result<Vec<ModelInfo>, AgentError> {
            Ok(Vec::new())
        }
        async fn set_model(
            &self,
            _session: &AmuxSessionId,
            _provider: &str,
            _model: &str,
        ) -> Result<(), AgentError> {
            Ok(())
        }
        async fn available_commands(
            &self,
            _session: &AmuxSessionId,
        ) -> Result<Vec<AgentCommand>, AgentError> {
            Ok(Vec::new())
        }
        async fn send_slash_command(
            &self,
            _session: &AmuxSessionId,
            _name: &str,
            _input: Option<&str>,
        ) -> Result<teamclu_gateway::agent::TurnOutcome, AgentError> {
            Err(AgentError::Send("unused".into()))
        }
        async fn list_sessions(
            &self,
            _active: &AmuxSessionId,
        ) -> Result<Vec<teamclu_gateway::agent::SessionInfo>, AgentError> {
            Ok(Vec::new())
        }
        async fn list_workspaces(
            &self,
            _session: &AmuxSessionId,
        ) -> Result<Vec<WorkspaceInfo>, AgentError> {
            Ok(Vec::new())
        }
        async fn set_workspace(
            &self,
            _session: &AmuxSessionId,
            _workspace_id: &str,
        ) -> Result<(), AgentError> {
            Ok(())
        }
        async fn list_skills(
            &self,
            _session: &AmuxSessionId,
        ) -> Result<Vec<(String, String)>, AgentError> {
            Ok(Vec::new())
        }
    }

    struct RecordingSpeaker {
        cancels: Mutex<usize>,
    }

    #[async_trait]
    impl ReplySpeaker for RecordingSpeaker {
        async fn begin(&self, _key: DeviceKey, _session_id: uuid::Uuid) {}
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

    async fn seed_acp(sink: &Esp32InboundSink, acp_session_id: &str) {
        let mut g = sink.active.lock().await;
        g.insert(
            DeviceKey {
                team_id: "team-1".into(),
                actor_id: "actor-1".into(),
            },
            DeviceState {
                acp_session_id: Some(acp_session_id.to_string()),
                in_flight: None,
            },
        );
    }

    fn sink_with(
        turns: Arc<dyn InboundTurnRunner>,
        agent: Arc<RecordingAgent>,
        speaker: Arc<RecordingSpeaker>,
        driver: Arc<RecordingDriver>,
    ) -> Esp32InboundSink {
        Esp32InboundSink::new(
            turns,
            driver as Arc<dyn ChannelDriver>,
            "team-1",
            agent as Arc<dyn AgentHandle>,
            speaker as Arc<dyn ReplySpeaker>,
        )
    }

    #[tokio::test]
    async fn second_accept_cancels_agent_by_sticky_acp_and_speak() {
        let acp = "acp-sticky-1".to_string();
        let release = Arc::new(Notify::new());
        let blocking = Arc::new(BlockingTurns {
            session_id: "cloud-sess".into(),
            acp_session_id: acp.clone(),
            release: release.clone(),
            runs: AtomicUsize::new(0),
            finished: AtomicUsize::new(0),
        });

        let recording = Arc::new(RecordingDriver::default());
        let agent = Arc::new(RecordingAgent::new());
        let speaker = Arc::new(RecordingSpeaker {
            cancels: Mutex::new(0),
        });

        let sink = sink_with(
            blocking.clone() as Arc<dyn InboundTurnRunner>,
            agent.clone(),
            speaker.clone(),
            recording.clone(),
        );
        seed_acp(&sink, &acp).await;

        sink.accept(msg("block-1", "first question")).await;
        wait_runs(&blocking, 1).await;
        assert_eq!(
            *speaker.cancels.lock().await,
            1,
            "first accept still cancels speak (may be draining prior TTS)"
        );

        sink.accept(msg("block-2", "interrupt")).await;

        assert_eq!(
            *speaker.cancels.lock().await,
            2,
            "barge-in must cancel speak again"
        );
        {
            let cancels = agent.cancels.lock().await;
            assert_eq!(
                cancels.as_slice(),
                &[acp.clone()],
                "barge-in must AgentHandle::cancel with sticky ACP id"
            );
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
    async fn accept_cancels_speak_even_when_no_in_flight_turn() {
        let agent = Arc::new(RecordingAgent::new());
        let speaker = Arc::new(RecordingSpeaker {
            cancels: Mutex::new(0),
        });
        let recording = Arc::new(RecordingDriver::default());
        let release = Arc::new(Notify::new());
        let blocking = Arc::new(BlockingTurns {
            session_id: "s".into(),
            acp_session_id: "acp".into(),
            release: release.clone(),
            runs: AtomicUsize::new(0),
            finished: AtomicUsize::new(0),
        });

        let sink = sink_with(
            blocking.clone() as Arc<dyn InboundTurnRunner>,
            agent.clone(),
            speaker.clone(),
            recording,
        );
        // Sticky ACP but nothing in flight — TTS may still be playing.
        seed_acp(&sink, "acp-idle").await;

        sink.accept(msg("fresh-1", "hello")).await;
        wait_runs(&blocking, 1).await;

        assert_eq!(
            *speaker.cancels.lock().await,
            1,
            "new accept must cancel speak even with no in_flight"
        );
        assert!(
            agent.cancels.lock().await.is_empty(),
            "no in_flight → do not AgentHandle::cancel"
        );

        release.notify_waiters();
        wait_finished(&blocking, 1).await;
    }

    #[tokio::test]
    async fn barge_in_never_delivers_queue_position_chinese() {
        let acp = "acp-q".to_string();
        let release = Arc::new(Notify::new());
        let blocking = Arc::new(BlockingTurns {
            session_id: "s".into(),
            acp_session_id: acp.clone(),
            release: release.clone(),
            runs: AtomicUsize::new(0),
            finished: AtomicUsize::new(0),
        });
        let recording = Arc::new(RecordingDriver::default());
        let agent = Arc::new(RecordingAgent::new());
        let speaker = Arc::new(RecordingSpeaker {
            cancels: Mutex::new(0),
        });

        let sink = sink_with(
            blocking.clone() as Arc<dyn InboundTurnRunner>,
            agent,
            speaker,
            recording.clone(),
        );
        seed_acp(&sink, &acp).await;

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
    async fn handled_stores_sticky_acp_for_later_cancel() {
        let acp = "acp-from-handled".to_string();
        let recording = Arc::new(RecordingDriver::default());
        let agent = Arc::new(RecordingAgent::new());
        let speaker = Arc::new(RecordingSpeaker {
            cancels: Mutex::new(0),
        });

        let sink = sink_with(
            Arc::new(InstantTurns {
                session_id: "cloud-1".into(),
                acp_session_id: acp.clone(),
            }) as Arc<dyn InboundTurnRunner>,
            agent,
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
                if g.get(&key).and_then(|s| s.acp_session_id.as_deref()) == Some(acp.as_str())
                {
                    break;
                }
                drop(g);
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("handled turn must store sticky acp_session_id");
    }
}
