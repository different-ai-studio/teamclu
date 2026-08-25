//! Chat sink — a final transcript becomes an agent prompt (M3-3).
//!
//! This is the piece that makes a spoken turn actually *do* something. The
//! router hands it the final transcript; it finds or creates a session for the
//! device and calls [`RuntimeAdapter::send_prompt`].
//!
//! ## Why a session per device, not per turn
//!
//! The device is a conversational object: "what did I just ask you" has to
//! work. Sessions already carry history, so the sink keeps one per
//! `(team, actor)` and reuses it across turns rather than opening a fresh one
//! each time — which would make every utterance context-free.
//!
//! The session is created lazily on the first transcript rather than at pair
//! time, because a device that is powered on but never spoken to should not
//! occupy a runtime.
//!
//! ## Speaking the answer back
//!
//! `send_prompt` returns as soon as the turn is *accepted*; the answer arrives
//! later as session events. Turning those into audio belongs to
//! [`super::spk`], which this sink drives through the [`ReplySpeaker`] seam —
//! a trait rather than a direct dependency so the prompt path stays testable
//! without a TTS stack behind it.
//!
//! The ordering matters and is easy to get wrong: [`ReplySpeaker::begin`] runs
//! **before** `send_prompt`, because it subscribes to the session and a
//! subscription opened afterwards races the first token deltas — the reply
//! starts mid-sentence. A sink built without a speaker keeps the old
//! behaviour: the agent hears the question and the device hears nothing.
//!
//! `Intent::Note` is ignored here; it belongs to the note sink (M3-4).

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};
use uuid::Uuid;

use super::adapter::{DeviceKey, TranscriptSink};
use super::spk::ReplySpeaker;
use super::stt::Intent;
use crate::http::runtime_adapter::{CreateSessionParams, PromptParams, RuntimeAdapter};

/// Fallback agent type, used only if the caller supplies none.
///
/// Matches `default_local_agent()` in config. The real value is team-scoped
/// (`teams/<id>/state/team.toml` decides which runtime a team's agents run),
/// so hardcoding *any* value here would be wrong for a team that picked `pi` —
/// the constant exists so a missing config degrades to the same default the
/// rest of the daemon uses rather than failing to open a session at all.
const FALLBACK_AGENT_TYPE: &str = "opencode";

pub struct ChatSink {
    runtime: Arc<dyn RuntimeAdapter>,
    /// Sessions own the conversation history, so this is what makes a device
    /// multi-turn rather than a series of unrelated questions.
    sessions: Mutex<HashMap<DeviceKey, Uuid>>,
    /// Session owner. Sessions are scoped to the token that created them; the
    /// device has no HTTP token, so the daemon's own id owns them.
    owner_token_id: Uuid,
    /// Which runtime a device turn runs against. Team-scoped config, passed in
    /// rather than read here so this stays testable without a config tree.
    agent_type: String,
    /// Speaks the agent's reply back to the device. `None` leaves the device
    /// silent after a successful prompt — the pre-TTS behaviour.
    speaker: Option<Arc<dyn ReplySpeaker>>,
}

impl ChatSink {
    /// `agent_type` comes from the team's `local_agent` setting. `None` falls
    /// back to the daemon-wide default.
    pub fn new(
        runtime: Arc<dyn RuntimeAdapter>,
        owner_token_id: Uuid,
        agent_type: Option<String>,
    ) -> Self {
        Self {
            runtime,
            sessions: Mutex::new(HashMap::new()),
            owner_token_id,
            agent_type: agent_type
                .filter(|a| !a.trim().is_empty())
                .unwrap_or_else(|| FALLBACK_AGENT_TYPE.to_string()),
            speaker: None,
        }
    }

    /// Attach the TTS downlink so replies are spoken back to the device.
    pub fn with_speaker(mut self, speaker: Arc<dyn ReplySpeaker>) -> Self {
        self.speaker = Some(speaker);
        self
    }

    /// Session for this device, creating one on first use.
    ///
    /// `hint` is the session id the device claimed on `turn_start`. It is
    /// honoured only if we have no session of our own: the device is not the
    /// authority on which sessions exist, and trusting an id it invented (or
    /// remembered across a reflash) would send prompts into a session that may
    /// belong to somebody else.
    async fn session_for(&self, key: &DeviceKey, hint: Option<&str>) -> Option<Uuid> {
        let mut map = self.sessions.lock().await;
        if let Some(id) = map.get(key) {
            return Some(*id);
        }

        if let Some(h) = hint.and_then(|h| Uuid::parse_str(h).ok()) {
            // Only adopt it if the runtime agrees it exists.
            if self.runtime.get_session(h).await.is_ok() {
                map.insert(key.clone(), h);
                info!(team_id = %key.team_id, actor_id = %key.actor_id, session_id = %h,
                      "voice: adopted device-supplied session");
                return Some(h);
            }
            warn!(team_id = %key.team_id, session_hint = %h,
                  "voice: device named a session that does not exist; creating a new one");
        }

        let params = CreateSessionParams {
            agent_type: self.agent_type.clone(),
            workspace_id: None,
            model: None,
            // The first transcript is sent as a normal prompt below, not as the
            // session's initial prompt, so both paths look identical to the
            // agent and there is one code path to debug.
            initial_prompt: None,
            metadata: Some(serde_json::json!({
                "source": "stopwatch",
                "actor_id": key.actor_id,
            })),
            // A device has no approval surface: a permission card raised here
            // is shown to nobody, and the runtime's watchdog reads "waiting on
            // the user" as healthy rather than stalled, so the turn parks
            // forever and the device sits on Think until its own deadline.
            // Observed exactly that — the agent answered a spoken question
            // with two `bash` calls and the turn never moved again.
            //
            // Same reasoning as gateway and cron sessions (see
            // `PermissionPolicy`), and the same trade: a spoken sentence can
            // now run any tool the agent chooses, with no confirmation. That
            // is a real widening of what a paired device can do, and it is why
            // the field is `serde(skip)` — the daemon decides this, never a
            // request.
            permission: Some(crate::runtime::PermissionPolicy::Full),
        };
        match self
            .runtime
            .create_session(self.owner_token_id, params)
            .await
        {
            Ok(snap) => {
                info!(team_id = %key.team_id, actor_id = %key.actor_id,
                      session_id = %snap.session_id, "voice: opened session for device");
                map.insert(key.clone(), snap.session_id);
                Some(snap.session_id)
            }
            Err(e) => {
                warn!(team_id = %key.team_id, actor_id = %key.actor_id, error = ?e,
                      "voice: could not open a session for device");
                None
            }
        }
    }

    /// Forget a device's session, so the next turn opens a fresh one. Called
    /// when the runtime rejects a prompt for a session it no longer has —
    /// otherwise a restarted daemon leaves the device wedged against a dead id.
    async fn forget(&self, key: &DeviceKey) {
        self.sessions.lock().await.remove(key);
    }
}

#[async_trait]
impl TranscriptSink for ChatSink {
    async fn on_final(
        &self,
        team_id: &str,
        actor_id: &str,
        intent: Intent,
        session_id: Option<&str>,
        text: &str,
    ) {
        if intent != Intent::Chat {
            return; // notes belong to the note sink (M3-4)
        }
        if text.trim().is_empty() {
            // A final with no text means the user held the button and said
            // nothing. Prompting the agent with "" would burn a turn to be told
            // there was no question.
            info!(
                team_id,
                actor_id, "voice: empty chat transcript, nothing to ask"
            );
            return;
        }

        let key = DeviceKey {
            team_id: team_id.to_string(),
            actor_id: actor_id.to_string(),
        };
        let Some(session) = self.session_for(&key, session_id).await else {
            return; // already logged
        };

        // Before the prompt, not after: `begin` subscribes to the session, and
        // a subscription opened after `send_prompt` misses the opening tokens
        // of the reply. It also puts the device on its Think screen, so the
        // user sees the turn was received even if the agent is slow.
        if let Some(speaker) = &self.speaker {
            speaker.begin(key.clone(), session).await;
        }

        let params = PromptParams {
            text: text.to_string(),
            attachments: Vec::new(),
            mentions: Vec::new(),
            metadata: Some(serde_json::json!({ "source": "stopwatch" })),
        };
        match self.runtime.send_prompt(session, params).await {
            Ok(ack) => {
                info!(team_id, actor_id, session_id = %session, turn_id = %ack.turn_id,
                      chars = text.chars().count(), "voice: chat prompt accepted");
            }
            Err(e) => {
                warn!(team_id, actor_id, session_id = %session, error = ?e,
                      "voice: chat prompt rejected; dropping the session so the next turn retries");
                // The speaker is already watching a session that will never
                // answer. Tear it down and show the error, or the device sits
                // on Think until its own deadline expires.
                if let Some(speaker) = &self.speaker {
                    speaker
                        .fail(&key, "no_agent", "prompt rejected by the runtime")
                        .await;
                }
                self.forget(&key).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::errors::HttpError;
    use crate::http::runtime_adapter::{
        PromptAck, ReplayPage, SessionSnapshot, SessionState, SubscriptionHandle,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Records what the sink asked the runtime to do.
    struct FakeRuntime {
        created: AtomicUsize,
        created_with: Mutex<Option<String>>,
        created_permission: Mutex<Option<crate::runtime::PermissionPolicy>>,
        prompts: Mutex<Vec<(Uuid, String)>>,
        session_id: Uuid,
        /// When set, `get_session` fails — i.e. the device named a session the
        /// runtime does not have.
        known_session: Option<Uuid>,
        fail_prompt: bool,
        /// Shared call log, so tests can assert the *order* of runtime and
        /// speaker calls against each other and not just their counts.
        journal: Arc<Mutex<Vec<&'static str>>>,
    }

    impl FakeRuntime {
        fn new() -> Self {
            Self {
                created: AtomicUsize::new(0),
                created_with: Mutex::new(None),
                created_permission: Mutex::new(None),
                prompts: Mutex::new(Vec::new()),
                session_id: Uuid::new_v4(),
                known_session: None,
                fail_prompt: false,
                journal: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    /// Records what the sink asked the speech downlink to do.
    struct FakeSpeaker {
        journal: Arc<Mutex<Vec<&'static str>>>,
        errors: Mutex<Vec<String>>,
        begun: Mutex<Vec<(DeviceKey, Uuid)>>,
    }

    impl FakeSpeaker {
        fn new(journal: Arc<Mutex<Vec<&'static str>>>) -> Self {
            Self {
                journal,
                errors: Mutex::new(Vec::new()),
                begun: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl ReplySpeaker for FakeSpeaker {
        async fn begin(&self, key: DeviceKey, session_id: Uuid) {
            self.journal.lock().await.push("begin");
            self.begun.lock().await.push((key, session_id));
        }
        async fn cancel(&self, _key: &DeviceKey) {
            self.journal.lock().await.push("cancel");
        }
        async fn fail(&self, _key: &DeviceKey, code: &str, _message: &str) {
            self.journal.lock().await.push("fail");
            self.errors.lock().await.push(code.to_string());
        }
    }

    /// Wires a sink to a speaker sharing the runtime's call log.
    fn sink_with_speaker(rt: Arc<FakeRuntime>) -> (ChatSink, Arc<FakeSpeaker>) {
        let speaker = Arc::new(FakeSpeaker::new(rt.journal.clone()));
        let sink = ChatSink::new(rt, Uuid::new_v4(), None).with_speaker(speaker.clone());
        (sink, speaker)
    }

    #[async_trait]
    impl RuntimeAdapter for FakeRuntime {
        async fn create_session(
            &self,
            _owner: Uuid,
            _p: CreateSessionParams,
        ) -> Result<SessionSnapshot, HttpError> {
            self.created.fetch_add(1, Ordering::SeqCst);
            *self.created_with.lock().await = Some(_p.agent_type.clone());
            *self.created_permission.lock().await = _p.permission;
            Ok(SessionSnapshot {
                session_id: self.session_id,
                agent_type: "local".into(),
                runtime_id: "rt".into(),
                workspace_id: None,
                current_model: None,
                state: SessionState::Idle,
                created_at: chrono::Utc::now(),
                last_activity: chrono::Utc::now(),
                last_event_seq: 0,
            })
        }

        async fn get_session(&self, id: Uuid) -> Result<SessionSnapshot, HttpError> {
            if Some(id) == self.known_session {
                return self.create_session(Uuid::nil(), unreachable_params()).await;
            }
            Err(HttpError::not_found("no such session"))
        }

        async fn list_sessions(&self, _owner: Uuid) -> Vec<SessionSnapshot> {
            Vec::new()
        }
        async fn close_session(&self, _id: Uuid) -> Result<(), HttpError> {
            Ok(())
        }

        async fn send_prompt(&self, id: Uuid, p: PromptParams) -> Result<PromptAck, HttpError> {
            self.journal.lock().await.push("prompt");
            if self.fail_prompt {
                return Err(HttpError::not_found("session gone"));
            }
            self.prompts.lock().await.push((id, p.text));
            Ok(PromptAck {
                prompt_id: Uuid::new_v4(),
                turn_id: Uuid::new_v4(),
            })
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
            Err(HttpError::not_found("no"))
        }
        async fn cancel(&self, _id: Uuid, _t: Option<Uuid>) -> Result<(), HttpError> {
            Ok(())
        }

        // The sink itself never reads session events: subscribing belongs to
        // the speech downlink, which reaches it through `ReplySpeaker` rather
        // than through this adapter. Refusing here keeps that boundary honest —
        // if the sink ever starts subscribing directly, these tests fail loudly
        // rather than silently exercising a stub.
        async fn subscribe(
            &self,
            _id: Uuid,
            _since: Option<u64>,
        ) -> Result<SubscriptionHandle, HttpError> {
            Err(HttpError::not_found("fake runtime does not stream"))
        }

        async fn replay(
            &self,
            _id: Uuid,
            _since: u64,
            _limit: usize,
        ) -> Result<ReplayPage, HttpError> {
            Err(HttpError::not_found("fake runtime does not replay"))
        }
    }

    fn unreachable_params() -> CreateSessionParams {
        CreateSessionParams {
            agent_type: "local".into(),
            workspace_id: None,
            model: None,
            initial_prompt: None,
            metadata: None,
            permission: None,
        }
    }

    #[tokio::test]
    async fn a_chat_transcript_becomes_a_prompt() {
        let rt = Arc::new(FakeRuntime::new());
        let sink = ChatSink::new(rt.clone(), Uuid::new_v4(), None);
        sink.on_final("t1", "a1", Intent::Chat, None, "今天几号")
            .await;

        let prompts = rt.prompts.lock().await;
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].1, "今天几号");
        assert_eq!(rt.created.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn turns_share_one_session() {
        let rt = Arc::new(FakeRuntime::new());
        let sink = ChatSink::new(rt.clone(), Uuid::new_v4(), None);
        sink.on_final("t1", "a1", Intent::Chat, None, "第一句")
            .await;
        sink.on_final("t1", "a1", Intent::Chat, None, "第二句")
            .await;

        // One session, two prompts: the second turn must see the first's
        // context, which is the whole point of reusing the session.
        assert_eq!(rt.created.load(Ordering::SeqCst), 1, "session is reused");
        let prompts = rt.prompts.lock().await;
        assert_eq!(prompts.len(), 2);
        assert_eq!(prompts[0].0, prompts[1].0, "same session id");
    }

    #[tokio::test]
    async fn devices_do_not_share_a_session() {
        let rt = Arc::new(FakeRuntime::new());
        let sink = ChatSink::new(rt.clone(), Uuid::new_v4(), None);
        sink.on_final("t1", "a1", Intent::Chat, None, "x").await;
        sink.on_final("t1", "a2", Intent::Chat, None, "y").await;
        assert_eq!(
            rt.created.load(Ordering::SeqCst),
            2,
            "one session per device"
        );
    }

    // ---- speech downlink ------------------------------------------------

    #[tokio::test]
    async fn speech_begins_before_the_prompt_is_sent() {
        // The one ordering that matters, and the one an innocent-looking
        // refactor breaks: `begin` subscribes to the session, so doing it
        // after `send_prompt` races the agent's first token deltas and the
        // spoken reply starts mid-sentence.
        let rt = Arc::new(FakeRuntime::new());
        let (sink, speaker) = sink_with_speaker(rt.clone());
        sink.on_final("t1", "a1", Intent::Chat, None, "今天几号")
            .await;

        assert_eq!(*rt.journal.lock().await, vec!["begin", "prompt"]);
        let begun = speaker.begun.lock().await;
        assert_eq!(begun.len(), 1);
        assert_eq!(begun[0].0.actor_id, "a1");
        assert_eq!(begun[0].1, rt.session_id, "speaks the session it prompted");
    }

    #[tokio::test]
    async fn a_rejected_prompt_puts_the_device_on_its_error_screen() {
        // Otherwise the speaker sits watching a session that will never
        // answer, and the device stares at Think until its own deadline
        // expires — a 30-second hang instead of an immediate error.
        let mut rt = FakeRuntime::new();
        rt.fail_prompt = true;
        let rt = Arc::new(rt);
        let (sink, speaker) = sink_with_speaker(rt.clone());
        sink.on_final("t1", "a1", Intent::Chat, None, "问题").await;

        assert_eq!(*rt.journal.lock().await, vec!["begin", "prompt", "fail"]);
        assert_eq!(*speaker.errors.lock().await, vec!["no_agent"]);
    }

    #[tokio::test]
    async fn a_note_never_starts_speech() {
        // Notes are read back on screen, not spoken. Beginning a turn here
        // would leave a TTS stream open for a reply that never comes.
        let rt = Arc::new(FakeRuntime::new());
        let (sink, _speaker) = sink_with_speaker(rt.clone());
        sink.on_final("t1", "a1", Intent::Note, None, "买牛奶")
            .await;
        assert!(rt.journal.lock().await.is_empty());
    }

    #[tokio::test]
    async fn an_empty_transcript_never_starts_speech() {
        let rt = Arc::new(FakeRuntime::new());
        let (sink, _speaker) = sink_with_speaker(rt.clone());
        sink.on_final("t1", "a1", Intent::Chat, None, "  ").await;
        assert!(rt.journal.lock().await.is_empty());
    }

    #[tokio::test]
    async fn a_sink_without_a_speaker_still_prompts() {
        // The pre-TTS arrangement has to keep working: no speaker means the
        // agent still hears the question, the device just stays quiet.
        let rt = Arc::new(FakeRuntime::new());
        let sink = ChatSink::new(rt.clone(), Uuid::new_v4(), None);
        sink.on_final("t1", "a1", Intent::Chat, None, "问题").await;
        assert_eq!(*rt.journal.lock().await, vec!["prompt"]);
        assert_eq!(rt.prompts.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn a_note_is_not_sent_to_the_agent() {
        let rt = Arc::new(FakeRuntime::new());
        let sink = ChatSink::new(rt.clone(), Uuid::new_v4(), None);
        sink.on_final("t1", "a1", Intent::Note, None, "买牛奶")
            .await;
        assert!(rt.prompts.lock().await.is_empty());
        assert_eq!(
            rt.created.load(Ordering::SeqCst),
            0,
            "no session for a note"
        );
    }

    #[tokio::test]
    async fn an_empty_transcript_does_not_burn_a_turn() {
        let rt = Arc::new(FakeRuntime::new());
        let sink = ChatSink::new(rt.clone(), Uuid::new_v4(), None);
        sink.on_final("t1", "a1", Intent::Chat, None, "   ").await;
        assert!(rt.prompts.lock().await.is_empty());
        assert_eq!(rt.created.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn an_unknown_device_session_hint_is_not_trusted() {
        let rt = Arc::new(FakeRuntime::new()); // known_session = None
        let sink = ChatSink::new(rt.clone(), Uuid::new_v4(), None);
        let bogus = Uuid::new_v4().to_string();
        sink.on_final("t1", "a1", Intent::Chat, Some(&bogus), "hi")
            .await;

        // It must create its own rather than prompt into a session it cannot
        // confirm exists.
        assert_eq!(rt.created.load(Ordering::SeqCst), 1);
        let prompts = rt.prompts.lock().await;
        assert_ne!(prompts[0].0.to_string(), bogus);
    }

    #[tokio::test]
    async fn a_device_turn_runs_with_full_access() {
        // The device has no screen to approve on. Under the default `Ask` the
        // agent's first tool call raises a card nobody sees, the runtime
        // watchdog counts "waiting on the user" as healthy, and the turn parks
        // forever — observed on hardware as a spoken question answered by two
        // `bash` calls and then silence.
        //
        // This is a security-relevant default, not an incidental one: it lets
        // a spoken sentence run any tool the agent picks. It is asserted so it
        // cannot be widened or narrowed by accident.
        let rt = Arc::new(FakeRuntime::new());
        let sink = ChatSink::new(rt.clone(), Uuid::new_v4(), None);
        sink.on_final("t1", "a1", Intent::Chat, None, "看看磁盘还剩多少")
            .await;

        assert_eq!(
            *rt.created_permission.lock().await,
            Some(crate::runtime::PermissionPolicy::Full)
        );
    }

    #[tokio::test]
    async fn the_teams_runtime_choice_is_honoured() {
        // A team on `pi` must not have its device turns opened against
        // opencode. This is why the agent type is passed in rather than
        // hardcoded — the setting is team-scoped.
        let rt = Arc::new(FakeRuntime::new());
        let sink = ChatSink::new(rt.clone(), Uuid::new_v4(), Some("pi".into()));
        sink.on_final("t1", "a1", Intent::Chat, None, "hi").await;
        assert_eq!(rt.created_with.lock().await.as_deref(), Some("pi"));
    }

    #[tokio::test]
    async fn a_rejected_prompt_drops_the_session_so_the_next_turn_retries() {
        let mut fake = FakeRuntime::new();
        fake.fail_prompt = true;
        let rt = Arc::new(fake);
        let sink = ChatSink::new(rt.clone(), Uuid::new_v4(), None);

        sink.on_final("t1", "a1", Intent::Chat, None, "one").await;
        sink.on_final("t1", "a1", Intent::Chat, None, "two").await;

        // Two sessions created: the first was discarded when the prompt was
        // refused, so a restarted runtime does not wedge the device forever.
        assert_eq!(rt.created.load(Ordering::SeqCst), 2);
    }
}
