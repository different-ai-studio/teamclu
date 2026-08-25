//! Note sink — a final `note` transcript becomes a stored message (M3-4).
//!
//! The second of the device's two gestures. Where [`super::chat_sink`] asks the
//! agent a question and [`super::spk`] speaks the answer back, a note is
//! fire-and-forget capture: it is written down, nothing replies, and no audio
//! is ever synthesised.
//!
//! ## Where a note goes
//!
//! Into the session message store, as one `text` message from the device's own
//! actor — the same table a typed message lands in. Two alternatives were
//! considered and rejected:
//!
//! - **Ideas** (`teamclu::Idea`) look note-shaped from the name, but they are
//!   task objects: status, claims, submissions, parent links. A spoken
//!   "周会挪到周四" is not a work item.
//! - **`RuntimeAdapter::send_prompt`**, the way chat does it, would start a
//!   runtime and produce an answer. That is precisely what a note must not do.
//!
//! `Backend::insert_message` writes the row without waking an agent, which is
//! what makes "no reply" structural here rather than a promise.
//!
//! ## Why the device is told
//!
//! The firmware's note gesture currently shows `Saving` and then `Saved` on a
//! **timer** (`SavingToSavedMs`), whether or not anything was stored — the same
//! defect the chat path had before `spk` started sending real markers. So this
//! sink publishes `note_saved` on success and `error` on failure, and carries
//! the transcript back so the device's "today's notes" list can show what was
//! actually recorded instead of the seeded placeholders.
//!
//! ## The session hint is not trusted
//!
//! `turn_start` may name a session, and this sink ignores it, for the reason
//! [`super::chat_sink`] gives: a device that remembered an id across a reflash —
//! or invented one — must not be able to write into somebody else's session.
//! The store is constructed with the session a note belongs in.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use tracing::{info, warn};

use super::adapter::{DeviceKey, TranscriptSink};
use super::spk::VoicePublisher;
use super::stt::Intent;
use crate::backend::Backend;

/// One captured note, before it is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub team_id: String,
    pub actor_id: String,
    pub text: String,
    pub at: DateTime<Utc>,
}

impl Note {
    /// `HH:MM` in UTC — the shape `face::Note::time` renders.
    ///
    /// UTC because the daemon has no idea what timezone the device is in and
    /// the device has no timezone either (its clock comes from SNTP). A wrong
    /// but consistent clock beats a plausible-looking wrong one; see plan §12.
    pub fn hhmm(&self) -> String {
        self.at.format("%H:%M").to_string()
    }
}

/// Where notes are persisted. A trait so the sink is testable without a
/// backend, and so a future local-first note store can replace the cloud one
/// without touching the routing above it.
#[async_trait]
pub trait NoteStore: Send + Sync {
    /// Persist one note, returning its stored id.
    async fn save(&self, note: &Note) -> Result<String, String>;
}

pub struct NoteSink {
    store: Arc<dyn NoteStore>,
    /// Publishes `note_saved` / `error` back to the device. `None` stores the
    /// note silently, leaving the firmware's timer-driven `Saved` cue as-is.
    publisher: Option<Arc<dyn VoicePublisher>>,
    seq: AtomicU64,
}

impl NoteSink {
    pub fn new(store: Arc<dyn NoteStore>) -> Self {
        Self {
            store,
            publisher: None,
            seq: AtomicU64::new(0),
        }
    }

    /// Tell the device whether the note actually landed.
    pub fn with_publisher(mut self, publisher: Arc<dyn VoicePublisher>) -> Self {
        self.publisher = Some(publisher);
        self
    }

    async fn send_ctl(&self, key: &DeviceKey, mut body: serde_json::Value) {
        let Some(publisher) = &self.publisher else {
            return;
        };
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("seq".into(), serde_json::Value::from(seq));
        }
        let topic = super::voice_ctl_topic(&key.team_id, &key.actor_id);
        let payload = match serde_json::to_vec(&body) {
            Ok(p) => p,
            Err(e) => {
                warn!(error = %e, "note ctl serialise failed");
                return;
            }
        };
        if let Err(e) = publisher.publish(topic, payload, true).await {
            warn!(error = %e, "note ctl publish failed");
        }
    }
}

#[async_trait]
impl TranscriptSink for NoteSink {
    async fn on_final(
        &self,
        team_id: &str,
        actor_id: &str,
        intent: Intent,
        _session_id: Option<&str>,
        text: &str,
    ) {
        if intent != Intent::Note {
            return; // chat belongs to ChatSink
        }
        let key = DeviceKey {
            team_id: team_id.to_string(),
            actor_id: actor_id.to_string(),
        };
        if text.trim().is_empty() {
            // The user held the note button and said nothing. Storing an empty
            // note would put a blank row in the list that cannot be deleted
            // from the device.
            info!(
                team_id,
                actor_id, "voice: empty note transcript, nothing to save"
            );
            self.send_ctl(
                &key,
                serde_json::json!({
                    "from": super::ctl::FROM_DAEMON, "type": "error", "code": "empty_note",
                    "message": "nothing was heard",
                }),
            )
            .await;
            return;
        }

        let note = Note {
            team_id: team_id.to_string(),
            actor_id: actor_id.to_string(),
            text: text.trim().to_string(),
            at: Utc::now(),
        };

        match self.store.save(&note).await {
            Ok(id) => {
                info!(team_id, actor_id, note_id = %id, chars = note.text.chars().count(),
                      "voice: note saved");
                // The text goes back so the device's note list shows what was
                // actually recorded, not what it thinks it said.
                self.send_ctl(
                    &key,
                    serde_json::json!({
                        "from": super::ctl::FROM_DAEMON, "type": "note_saved",
                        "time": note.hhmm(),
                        "text": note.text,
                    }),
                )
                .await;
            }
            Err(e) => {
                warn!(team_id, actor_id, error = %e,
                      "voice: note could not be stored");
                self.send_ctl(
                    &key,
                    serde_json::json!({
                        "from": super::ctl::FROM_DAEMON, "type": "error", "code": "note_failed", "message": e,
                    }),
                )
                .await;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Backend-backed store
// ---------------------------------------------------------------------------

/// Stores notes as `text` messages in one session via [`Backend::insert_message`].
///
/// The session is fixed at construction rather than taken from the note,
/// because the daemon has no per-device notes session to resolve yet — that
/// arrives with M2-2 pairing, alongside the subscription that would deliver a
/// note in the first place. Wiring this up is the remaining piece; the write
/// itself is complete.
pub struct BackendNoteStore {
    backend: Arc<dyn Backend>,
    session_id: String,
    /// Per-session message ordering. Notes are the only writer on this session
    /// today, so a local counter is sufficient and avoids a read-before-write
    /// on every capture.
    sequence: AtomicU64,
}

impl BackendNoteStore {
    pub fn new(backend: Arc<dyn Backend>, session_id: impl Into<String>) -> Self {
        Self {
            backend,
            session_id: session_id.into(),
            sequence: AtomicU64::new(0),
        }
    }

    /// Start numbering after the messages a session already holds, so a daemon
    /// restart does not re-issue sequence 0 and collide with existing rows.
    pub fn resume_from(self, sequence: u64) -> Self {
        self.sequence.store(sequence, Ordering::Relaxed);
        self
    }
}

#[async_trait]
impl NoteStore for BackendNoteStore {
    async fn save(&self, note: &Note) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let metadata = serde_json::json!({
            "source": "stopwatch",
            "intent": "note",
            "captured_at": note.at.to_rfc3339(),
        })
        .to_string();

        self.backend
            .insert_message(
                &id,
                &note.team_id,
                &self.session_id,
                // The note is the *user's*, so it is attributed to the device's
                // actor rather than the daemon's.
                &note.actor_id,
                "text",
                &note.text,
                &metadata,
                "", // no model: nothing generated this
                "", // no turn: a note is not part of an agent turn
                "", // replies to nothing
                self.sequence.fetch_add(1, Ordering::Relaxed),
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mock::MockBackend;
    use tokio::sync::Mutex;

    // ---- fakes ---------------------------------------------------------

    #[derive(Default)]
    struct RecordingStore {
        saved: Mutex<Vec<Note>>,
        fail: bool,
    }

    #[async_trait]
    impl NoteStore for RecordingStore {
        async fn save(&self, note: &Note) -> Result<String, String> {
            if self.fail {
                return Err("backend on fire".into());
            }
            self.saved.lock().await.push(note.clone());
            Ok(format!("note-{}", self.saved.lock().await.len()))
        }
    }

    #[derive(Default)]
    struct RecordingPublisher {
        ctl: Mutex<Vec<serde_json::Value>>,
    }

    #[async_trait]
    impl VoicePublisher for RecordingPublisher {
        async fn publish(&self, topic: String, payload: Vec<u8>, qos1: bool) -> Result<(), String> {
            assert!(topic.ends_with("/ctl"), "notes only ever publish ctl");
            assert!(qos1, "note markers must not be fire-and-forget");
            self.ctl
                .lock()
                .await
                .push(serde_json::from_slice(&payload).expect("ctl json"));
            Ok(())
        }
    }

    impl RecordingPublisher {
        async fn types(&self) -> Vec<String> {
            self.ctl
                .lock()
                .await
                .iter()
                .filter_map(|v| v.get("type").and_then(|t| t.as_str()).map(String::from))
                .collect()
        }
    }

    fn sink_with(store: Arc<RecordingStore>) -> (NoteSink, Arc<RecordingPublisher>) {
        let publisher = Arc::new(RecordingPublisher::default());
        let sink = NoteSink::new(store).with_publisher(publisher.clone());
        (sink, publisher)
    }

    // ---- routing -------------------------------------------------------

    #[tokio::test]
    async fn a_note_transcript_is_stored() {
        let store = Arc::new(RecordingStore::default());
        let (sink, publisher) = sink_with(store.clone());
        sink.on_final("t1", "a1", Intent::Note, None, "周会挪到周四下午")
            .await;

        let saved = store.saved.lock().await;
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].text, "周会挪到周四下午");
        assert_eq!(saved[0].team_id, "t1");
        assert_eq!(saved[0].actor_id, "a1");
        assert_eq!(publisher.types().await, vec!["note_saved"]);
    }

    #[tokio::test]
    async fn a_chat_transcript_is_left_to_the_chat_sink() {
        // Both sinks see every final; each must ignore the other's intent or a
        // chat turn would be silently filed as a note.
        let store = Arc::new(RecordingStore::default());
        let (sink, publisher) = sink_with(store.clone());
        sink.on_final("t1", "a1", Intent::Chat, None, "今天几号")
            .await;
        assert!(store.saved.lock().await.is_empty());
        assert!(publisher.types().await.is_empty(), "and says nothing");
    }

    #[tokio::test]
    async fn the_saved_marker_carries_the_text_back() {
        // This is what lets the device show a real note list instead of the
        // seeded placeholders in main.cpp.
        let store = Arc::new(RecordingStore::default());
        let (sink, publisher) = sink_with(store);
        sink.on_final("t1", "a1", Intent::Note, None, "买牛奶")
            .await;

        let ctl = publisher.ctl.lock().await;
        assert_eq!(ctl[0]["type"], "note_saved");
        assert_eq!(ctl[0]["text"], "买牛奶");
        let time = ctl[0]["time"].as_str().expect("a time");
        assert_eq!(time.len(), 5, "HH:MM, got {time}");
        assert_eq!(&time[2..3], ":");
    }

    #[tokio::test]
    async fn text_is_trimmed_before_it_is_stored() {
        let store = Arc::new(RecordingStore::default());
        let (sink, _) = sink_with(store.clone());
        sink.on_final("t1", "a1", Intent::Note, None, "  记一下  \n")
            .await;
        assert_eq!(store.saved.lock().await[0].text, "记一下");
    }

    #[tokio::test]
    async fn an_empty_note_is_refused_rather_than_stored_blank() {
        // A blank row would sit in the device's list forever; there is no way
        // to delete one from the device.
        let store = Arc::new(RecordingStore::default());
        let (sink, publisher) = sink_with(store.clone());
        sink.on_final("t1", "a1", Intent::Note, None, "   ").await;
        assert!(store.saved.lock().await.is_empty());
        let ctl = publisher.ctl.lock().await;
        assert_eq!(ctl[0]["type"], "error");
        assert_eq!(ctl[0]["code"], "empty_note");
    }

    #[tokio::test]
    async fn a_failed_store_tells_the_device_instead_of_pretending() {
        // The firmware's `Saved` screen is on a timer, so silence here reads
        // to the user as success. That is the failure this guards.
        let store = Arc::new(RecordingStore {
            fail: true,
            ..Default::default()
        });
        let (sink, publisher) = sink_with(store);
        sink.on_final("t1", "a1", Intent::Note, None, "重要的事")
            .await;

        let ctl = publisher.ctl.lock().await;
        assert_eq!(ctl[0]["type"], "error");
        assert_eq!(ctl[0]["code"], "note_failed");
        assert!(
            !ctl.iter().any(|c| c["type"] == "note_saved"),
            "a failed save must never report success"
        );
    }

    #[tokio::test]
    async fn a_sink_without_a_publisher_still_stores() {
        let store = Arc::new(RecordingStore::default());
        let sink = NoteSink::new(store.clone());
        sink.on_final("t1", "a1", Intent::Note, None, "静默保存")
            .await;
        assert_eq!(store.saved.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn ctl_seq_is_monotonic_across_notes() {
        let store = Arc::new(RecordingStore::default());
        let (sink, publisher) = sink_with(store);
        for t in ["一", "二", "三"] {
            sink.on_final("t1", "a1", Intent::Note, None, t).await;
        }
        let ctl = publisher.ctl.lock().await;
        let seqs: Vec<u64> = ctl.iter().map(|c| c["seq"].as_u64().unwrap()).collect();
        assert_eq!(seqs, vec![0, 1, 2]);
    }

    // ---- the real store ------------------------------------------------

    fn note(text: &str) -> Note {
        Note {
            team_id: "team-x".into(),
            actor_id: "device-actor".into(),
            text: text.into(),
            at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn backend_store_writes_one_text_message() {
        let mock = MockBackend::with_identity("team-x", "daemon-actor");
        let state = mock.state.clone();
        let store = BackendNoteStore::new(Arc::new(mock), "sess-notes");

        let id = store.save(&note("周会挪到周四")).await.expect("saved");

        let recorded = state.lock().unwrap().messages_inserted.clone();
        assert_eq!(recorded.len(), 1);
        let m = &recorded[0];
        assert_eq!(m.id, id);
        assert_eq!(m.session_id, "sess-notes");
        assert_eq!(m.kind, "text");
        assert_eq!(m.content, "周会挪到周四");
        assert_eq!(m.team_id, "team-x");
    }

    #[tokio::test]
    async fn a_note_is_attributed_to_the_device_not_the_daemon() {
        // `Backend::actor_id()` is the daemon's own identity. Using it would
        // file every user's note under the machine that happened to relay it.
        let mock = MockBackend::with_identity("team-x", "daemon-actor");
        let state = mock.state.clone();
        let store = BackendNoteStore::new(Arc::new(mock), "sess-notes");
        store.save(&note("我的笔记")).await.expect("saved");

        let recorded = state.lock().unwrap().messages_inserted.clone();
        assert_eq!(recorded[0].sender_actor_id, "device-actor");
    }

    #[tokio::test]
    async fn a_note_carries_no_turn_or_model() {
        // Non-empty values here would make a note look like part of an agent
        // turn to anything reading the table back.
        let mock = MockBackend::with_identity("team-x", "daemon-actor");
        let state = mock.state.clone();
        let store = BackendNoteStore::new(Arc::new(mock), "sess-notes");
        store.save(&note("x")).await.expect("saved");

        let recorded = state.lock().unwrap().messages_inserted.clone();
        assert_eq!(recorded[0].model, "");
        assert_eq!(recorded[0].turn_id, "");
        assert_eq!(recorded[0].reply_to_message_id, "");
    }

    #[tokio::test]
    async fn metadata_marks_the_note_as_device_captured() {
        let mock = MockBackend::with_identity("team-x", "daemon-actor");
        let state = mock.state.clone();
        let store = BackendNoteStore::new(Arc::new(mock), "sess-notes");
        store.save(&note("x")).await.expect("saved");

        let recorded = state.lock().unwrap().messages_inserted.clone();
        let meta: serde_json::Value =
            serde_json::from_str(&recorded[0].metadata_json).expect("metadata is json");
        assert_eq!(meta["source"], "stopwatch");
        assert_eq!(meta["intent"], "note");
        assert!(meta["captured_at"].is_string());
    }

    #[tokio::test]
    async fn sequences_advance_and_ids_are_unique() {
        let mock = MockBackend::with_identity("team-x", "daemon-actor");
        let state = mock.state.clone();
        let store = BackendNoteStore::new(Arc::new(mock), "sess-notes");
        for t in ["一", "二", "三"] {
            store.save(&note(t)).await.expect("saved");
        }
        let recorded = state.lock().unwrap().messages_inserted.clone();
        assert_eq!(
            recorded.iter().map(|m| m.sequence).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        let ids: std::collections::HashSet<_> = recorded.iter().map(|m| &m.id).collect();
        assert_eq!(ids.len(), 3, "message ids must not repeat");
    }

    #[tokio::test]
    async fn resume_from_avoids_colliding_with_existing_rows() {
        // A restarted daemon that began at 0 again would write sequence numbers
        // the session already has.
        let mock = MockBackend::with_identity("team-x", "daemon-actor");
        let state = mock.state.clone();
        let store = BackendNoteStore::new(Arc::new(mock), "sess-notes").resume_from(41);
        store.save(&note("x")).await.expect("saved");
        assert_eq!(state.lock().unwrap().messages_inserted[0].sequence, 41);
    }

    #[tokio::test]
    async fn hhmm_is_zero_padded() {
        let at: DateTime<Utc> = "2026-08-25T04:07:00Z".parse().expect("ts");
        let n = Note { at, ..note("x") };
        assert_eq!(n.hhmm(), "04:07");
    }
}
