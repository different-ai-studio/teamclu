//! Core-path acceptance tests (design §5.7).
//!
//! End-to-end through a real [`Core`] + [`CoreTurnRunner`] + [`Esp32InboundSink`],
//! not pre-baked [`TurnFail`] doubles.
//!
//! ## §5.7 checklist
//!
//! | Requirement | Covered by |
//! |---|---|
//! | Duplicate `external_message_id` → one turn (`MemoryDedup`) | [`duplicate_external_message_id_runs_one_turn_only`] |
//! | Second accept while busy → cancel, not queue | **Existing** `voice::esp32_sink::tests::{second_accept_cancels_agent_by_sticky_acp_and_speak, barge_in_never_delivers_queue_position_chinese}` + Core-path [`second_accept_while_core_busy_cancels_without_queue_notice`] |
//! | `Core::handle` `Err(Turn)` → NoAgent error ctl | [`core_turn_err_publishes_no_agent_via_sink`] (forces failing [`TurnRunner`] inside Core) |
//! | VoiceRouter `turn_start`+`boot_id` → fork external id | [`voice_router_turn_start_boot_id_reaches_fork`] (+ unit `voice::esp32_fork::tests::use_core_with_boot_id_accepts_expected_external_message_id`) |
//!
//! Lives under `channels/core` (not `voice/`) so integration-test crate roots that
//! include `voice` without `channels` still compile — same boundary as
//! `Esp32InboundSink` staying free of `crate::channels`. |

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use teamclu_gateway::agent::{
    AgentCommand, AgentError, AgentHandle, AmuxSessionId, ModelInfo, WorkspaceInfo,
};
use teamclu_gateway::driver::{
    ChannelDriver, Conversation, ConversationKind, ExternalSender, InboundMessage, InboundSink,
    SessionAttachment,
};
use teamclu_gateway::esp32::{Esp32Downlink, Esp32Driver, Esp32Target};
use tokio::sync::{mpsc, Notify};

use super::dedup::MemoryDedup;
use super::sink::CoreTurnRunner;
use super::{
    CommandRunner, Core, CoreError, IdentityMapper, PendingUpload, SessionRef, SessionRouter,
    SessionWriter, TurnRunner,
};
use crate::config::{Esp32Channel, Esp32DeviceEntry};
use crate::voice::adapter::{DeviceKey, VoiceEvent, VoiceRouter};
use crate::voice::ctl::VoiceCtl;
use crate::voice::esp32_fork::Esp32CoreForkSink;
use crate::voice::esp32_sink::Esp32InboundSink;
use crate::voice::spk::ReplySpeaker;
use crate::voice::stt::{AudioFrame, Intent, SttError, SttProvider, SttStream, Transcript};

// ── Core fakes (mirror channels/core/tests.rs) ─────────────────────────────

#[derive(Default)]
struct FakeRouter {
    bindings: Mutex<Vec<String>>,
}

#[async_trait]
impl SessionRouter for FakeRouter {
    async fn resolve(
        &self,
        binding: &str,
        _title: &str,
        _actor: &str,
    ) -> Result<SessionRef, CoreError> {
        self.bindings.lock().unwrap().push(binding.to_string());
        Ok(SessionRef {
            session_id: format!("session-for-{binding}"),
            acp_session_id: format!("acp-for-{binding}"),
        })
    }
}

#[derive(Default)]
struct FakeIdentity;

#[async_trait]
impl IdentityMapper for FakeIdentity {
    async fn actor_for(&self, urn: &str, _display: &str) -> Result<String, CoreError> {
        Ok(format!("actor-for-{urn}"))
    }
    async fn join(&self, _session: &str, _actor: &str) -> Result<(), CoreError> {
        Ok(())
    }
}

#[derive(Default)]
struct FakeWriter;

#[async_trait]
impl SessionWriter for FakeWriter {
    async fn write_inbound(
        &self,
        _session: &str,
        _actor: &str,
        _text: &str,
        _attachments: Vec<PendingUpload>,
        _external: &str,
    ) -> Result<String, CoreError> {
        Ok("msg-in".into())
    }
    async fn write_reply(
        &self,
        _session: &str,
        _text: &str,
        _attachments: Vec<SessionAttachment>,
    ) -> Result<String, CoreError> {
        Ok("msg-out".into())
    }
    async fn upload(
        &self,
        _session: &str,
        upload: &PendingUpload,
    ) -> Result<SessionAttachment, CoreError> {
        Ok(SessionAttachment {
            filename: upload.filename.clone(),
            mime: upload.mime.clone(),
            bucket_path: format!("bucket/{}", upload.filename),
            local_path: None,
        })
    }
}

#[derive(Default)]
struct FakeCommands;

#[async_trait]
impl CommandRunner for FakeCommands {
    async fn dispatch(
        &self,
        _name: &str,
        _arg: Option<&str>,
        _acp: &str,
    ) -> Result<Option<String>, CoreError> {
        Ok(None)
    }
    fn needs_session(&self, _name: &str) -> bool {
        true
    }
    fn unknown_command_text(&self, name: &str) -> String {
        format!("unknown: /{name}")
    }
}

struct OkTurns {
    reply: &'static str,
    runs: AtomicUsize,
}

#[async_trait]
impl TurnRunner for OkTurns {
    async fn run(
        &self,
        _acp: &str,
        _display: &str,
        _prompt: &str,
        _on_delta: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<String, CoreError> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        Ok(self.reply.to_string())
    }
}

/// Blocks until `release`, then returns — for barge-in / interrupt tests.
struct BlockingTurns {
    release: Arc<Notify>,
    runs: AtomicUsize,
    finished: AtomicUsize,
}

#[async_trait]
impl TurnRunner for BlockingTurns {
    async fn run(
        &self,
        _acp: &str,
        _display: &str,
        _prompt: &str,
        _on_delta: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<String, CoreError> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        self.release.notified().await;
        self.finished.fetch_add(1, Ordering::SeqCst);
        Ok("blocked-reply".into())
    }
}

struct FailTurnRunner {
    runs: AtomicUsize,
}

#[async_trait]
impl TurnRunner for FailTurnRunner {
    async fn run(
        &self,
        _acp: &str,
        _display: &str,
        _prompt: &str,
        _on_delta: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<String, CoreError> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        Err(CoreError::Turn("agent unreachable".into()))
    }
}

// ── ESP32 / sink fakes ─────────────────────────────────────────────────────

#[derive(Default)]
struct FakeDownlink {
    speaks: Mutex<Vec<(String, String, String, String)>>,
}

#[async_trait]
impl Esp32Downlink for FakeDownlink {
    async fn speak(
        &self,
        device: &Esp32Target,
        text: &str,
    ) -> Result<(), teamclu_gateway::driver::DriverError> {
        self.speaks.lock().unwrap().push((
            device.team_id.clone(),
            device.actor_id.clone(),
            device.device_id.clone(),
            text.to_string(),
        ));
        Ok(())
    }
    async fn publish_ctl(
        &self,
        _device: &Esp32Target,
        _json: &str,
    ) -> Result<(), teamclu_gateway::driver::DriverError> {
        Ok(())
    }
}

struct RecordingAgent {
    cancels: tokio::sync::Mutex<Vec<String>>,
}

impl RecordingAgent {
    fn new() -> Self {
        Self {
            cancels: tokio::sync::Mutex::new(Vec::new()),
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
    async fn list_models(&self, _session: &AmuxSessionId) -> Result<Vec<ModelInfo>, AgentError> {
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
    cancels: tokio::sync::Mutex<usize>,
    fails: tokio::sync::Mutex<Vec<(String, String)>>,
}

impl RecordingSpeaker {
    fn new() -> Self {
        Self {
            cancels: tokio::sync::Mutex::new(0),
            fails: tokio::sync::Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl ReplySpeaker for RecordingSpeaker {
    async fn begin(&self, _key: DeviceKey, _session_id: uuid::Uuid) {}
    async fn cancel(&self, _key: &DeviceKey) {
        *self.cancels.lock().await += 1;
    }
    async fn fail(&self, _key: &DeviceKey, code: &str, message: &str) {
        self.fails
            .lock()
            .await
            .push((code.to_string(), message.to_string()));
    }
}

fn esp32_msg(external_id: &str, text: &str) -> InboundMessage {
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
        external_message_id: external_id.into(),
        text: text.into(),
        attachments: Vec::new(),
        addressed_to_bot: true,
        quoted_text: None,
        reply_context: Some("team-1/actor-1/dev-aabbcc".into()),
    }
}

fn core_with_turns(turns: Arc<dyn TurnRunner>) -> Arc<Core> {
    Arc::new(Core {
        dedup: Arc::new(MemoryDedup::default()),
        router: Arc::new(FakeRouter::default()),
        identity: Arc::new(FakeIdentity),
        writer: Arc::new(FakeWriter),
        turns,
        commands: Arc::new(FakeCommands),
    })
}

fn sink_for(
    core: Arc<Core>,
    downlink: Arc<FakeDownlink>,
    agent: Arc<RecordingAgent>,
    speaker: Arc<RecordingSpeaker>,
) -> Esp32InboundSink {
    let driver: Arc<dyn ChannelDriver> = Arc::new(Esp32Driver {
        downlink: downlink as Arc<dyn Esp32Downlink>,
        team_id: "team-1".into(),
    });
    Esp32InboundSink::new(
        Arc::new(CoreTurnRunner { core }),
        driver,
        "team-1",
        agent as Arc<dyn AgentHandle>,
        speaker as Arc<dyn ReplySpeaker>,
    )
}

async fn wait_runs(runs: &AtomicUsize, n: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while runs.load(Ordering::SeqCst) < n {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {n} turn run(s)"));
}

async fn wait_fails(speaker: &RecordingSpeaker, n: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while speaker.fails.lock().await.len() < n {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {n} fail(s)"));
}

fn assert_no_queue_speak(downlink: &FakeDownlink) {
    let speaks = downlink.speaks.lock().unwrap().clone();
    for (_t, _a, _d, text) in &speaks {
        assert!(
            !text.contains("排队") && !text.contains("排在第"),
            "must not speak queue notices, got {text:?}"
        );
    }
}

// ── §5.7 cases ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn duplicate_external_message_id_runs_one_turn_only() {
    let turns = Arc::new(OkTurns {
        reply: "once",
        runs: AtomicUsize::new(0),
    });
    let downlink = Arc::new(FakeDownlink::default());
    let speaker = Arc::new(RecordingSpeaker::new());
    let sink = sink_for(
        core_with_turns(turns.clone()),
        downlink.clone(),
        Arc::new(RecordingAgent::new()),
        speaker.clone(),
    );

    let id = "esp32:dev-aabbcc:boot1:1";
    sink.accept(esp32_msg(id, "第一问")).await;
    wait_runs(&turns.runs, 1).await;
    // Let Core finish + sticky ACP store before redelivery.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    sink.accept(esp32_msg(id, "第一问")).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    assert_eq!(
        turns.runs.load(Ordering::SeqCst),
        1,
        "MemoryDedup must drop the redelivered external_message_id"
    );
    assert!(
        speaker.fails.lock().await.is_empty(),
        "duplicate is Outcome::Duplicate, not an error ctl"
    );
    assert_no_queue_speak(&downlink);
}

#[tokio::test]
async fn second_accept_while_core_busy_cancels_without_queue_notice() {
    let release = Arc::new(Notify::new());
    let turns = Arc::new(BlockingTurns {
        release: release.clone(),
        runs: AtomicUsize::new(0),
        finished: AtomicUsize::new(0),
    });
    let downlink = Arc::new(FakeDownlink::default());
    let agent = Arc::new(RecordingAgent::new());
    let speaker = Arc::new(RecordingSpeaker::new());
    let sink = sink_for(
        core_with_turns(turns.clone()),
        downlink.clone(),
        agent.clone(),
        speaker.clone(),
    );

    // Warm sticky ACP so barge-in can AgentHandle::cancel (same as sink unit tests).
    sink.test_seed_acp("team-1", "actor-1", "acp-for-esp32://team-1/actor-1")
        .await;

    sink.accept(esp32_msg("esp32:dev:boot:1", "first")).await;
    wait_runs(&turns.runs, 1).await;

    sink.accept(esp32_msg("esp32:dev:boot:2", "interrupt")).await;
    wait_runs(&turns.runs, 2).await;

    assert!(
        *speaker.cancels.lock().await >= 2,
        "each accept cancels speak; barge-in must cancel again"
    );
    assert_no_queue_speak(&downlink);

    release.notify_waiters();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while turns.finished.load(Ordering::SeqCst) < 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("at least the surviving turn finishes");
}

#[tokio::test]
async fn core_turn_err_publishes_no_agent_via_sink() {
    // Force TurnRunner failure *inside* Core — not a pre-baked TurnFail.
    let turns = Arc::new(FailTurnRunner {
        runs: AtomicUsize::new(0),
    });
    let speaker = Arc::new(RecordingSpeaker::new());
    let downlink = Arc::new(FakeDownlink::default());
    let sink = sink_for(
        core_with_turns(turns.clone()),
        downlink,
        Arc::new(RecordingAgent::new()),
        speaker.clone(),
    );

    sink.accept(esp32_msg("esp32:dev:boot:fail", "hello")).await;
    wait_fails(&speaker, 1).await;
    wait_runs(&turns.runs, 1).await;

    assert_eq!(
        speaker.fails.lock().await.as_slice(),
        &[("no_agent".into(), "电脑没醒着".into())],
        "CoreError::Turn must map through CoreTurnRunner → ReplySpeaker::fail"
    );
}

// ── VoiceRouter → fork (1.6 gap) ───────────────────────────────────────────

struct EchoFinalStt;

#[async_trait]
impl SttProvider for EchoFinalStt {
    fn name(&self) -> &'static str {
        "echo-final"
    }
    async fn recognize(
        &self,
        _intent: Intent,
        mut frames_rx: tokio::sync::mpsc::Receiver<AudioFrame>,
    ) -> Result<SttStream, SttError> {
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        let (ftx, _frx) = tokio::sync::mpsc::channel(8);
        tokio::spawn(async move {
            while frames_rx.recv().await.is_some() {}
            let _ = tx.send(Transcript::final_("今天几号")).await;
        });
        Ok(SttStream {
            frames_tx: ftx,
            transcripts_rx: rx,
        })
    }
}

struct RecordingInbound {
    accepted: tokio::sync::Mutex<Vec<InboundMessage>>,
}

#[async_trait]
impl InboundSink for RecordingInbound {
    async fn accept(&self, msg: InboundMessage) {
        self.accepted.lock().await.push(msg);
    }
}

#[tokio::test]
async fn voice_router_turn_start_boot_id_reaches_fork() {
    let inbound = Arc::new(RecordingInbound {
        accepted: tokio::sync::Mutex::new(Vec::new()),
    });
    let speaker = Arc::new(RecordingSpeaker::new());
    let fork = Esp32CoreForkSink::new(
        inbound.clone(),
        speaker.clone(),
        Esp32Channel {
            enabled: true,
            use_core: true,
            devices: vec![Esp32DeviceEntry {
                device_id: "c19518".into(),
                name: "工位".into(),
                paired_at: None,
            }],
        },
    );
    let router = VoiceRouter::new(Arc::new(EchoFinalStt), Arc::new(fork));
    // `handle` is private; drive through the public spawn channel.
    let (tx, rx) = mpsc::unbounded_channel();
    let _jh = router.spawn(rx);

    tx.send(VoiceEvent::Ctl {
        team_id: "team-1".into(),
        actor_id: "actor-1".into(),
        ctl: VoiceCtl::parse(
            br#"{"type":"turn_start","intent":"chat","seq":7,"boot_id":"a1b2c3d4"}"#,
        )
        .unwrap(),
    })
    .unwrap();
    tx.send(VoiceEvent::Ctl {
        team_id: "team-1".into(),
        actor_id: "actor-1".into(),
        ctl: VoiceCtl::parse(br#"{"type":"turn_end","seq":8}"#).unwrap(),
    })
    .unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if !inbound.accepted.lock().await.is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fork should accept after turn_end final");

    let accepted = inbound.accepted.lock().await;
    assert_eq!(accepted.len(), 1);
    assert_eq!(
        accepted[0].external_message_id,
        "esp32:c19518:a1b2c3d4:7",
        "boot_id+seq from turn_start must form the Core dedup key"
    );
}
