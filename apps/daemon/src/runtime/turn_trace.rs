//! Turn execution trace (#1455 §7.2): one gzipped JSONL blob per turn in OSS,
//! with a pointer in `messages.metadata.trace` that FC writes on complete.
//!
//! The trace is recorded while the turn runs, not reconstructed when it ends.
//! Every traced event is serialized into its agent's buffer as it passes
//! through the run loop, each payload capped on the way in, so ending a turn is
//! a `mem::take` of an already-bounded buffer rather than a scan of the agent's
//! whole `EventHistory` file. Compression and hashing run on the blocking pool,
//! once per turn no matter how many sessions the reply lands in.
//!
//! Line format — one JSON object per line, `turn_seq` dense from 1:
//!
//! ```text
//! every line          turn_seq, type, ts_ms, [sequence], [child_session], [model]
//! thinking | reply    text              consecutive deltas coalesced into one line
//! tool_call           tool_id, tool_name, tool_kind, status, [raw_input], [raw_output]
//! tool_result         tool_id, success, summary, [raw_output]
//! permission_request  request_id, tool_name, description
//! status_change       old_status, new_status
//! error               message, details
//! trace_truncated     dropped_events    last line, only when the budget ran out
//! ```
//!
//! A payload over [`FIELD_CAP_BYTES`] becomes a string holding its head and tail
//! plus a `<field>_original_size` sibling. A payload that is valid single-line
//! JSON within the cap is embedded as JSON, verbatim.

use crate::backend::{Backend, BackendError, TurnTraceStatus, TurnTraceUpload};
use crate::proto::amux;
use bytes::Bytes;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;
use tracing::warn;

/// Cap on any single payload (text run, tool input/output, error details).
pub const FIELD_CAP_BYTES: usize = 256 * 1024;

/// Uncompressed size after which only structural lines (`status_change`,
/// `error`) are still written. One line may overshoot by its own payloads, so
/// the hard ceiling is this plus a couple of `FIELD_CAP_BYTES`.
pub const TRACE_BUDGET_BYTES: usize = 8 * 1024 * 1024;

type LineMap<'a, 'w> =
    serde_json::ser::Compound<'a, &'w mut Vec<u8>, serde_json::ser::CompactFormatter>;

/// The fields every line starts with.
struct LineHead<'a> {
    kind: &'static str,
    ts_ms: i64,
    sequence: u64,
    child_session: &'a str,
    model: &'a str,
}

/// One turn's trace while it is being recorded.
pub struct TurnTrace {
    turn_id: String,
    jsonl: Vec<u8>,
    lines: u64,
    dropped_events: u64,
    pending: Option<PendingText>,
}

/// A run of thinking or reply deltas not yet written as a line.
struct PendingText {
    kind: &'static str,
    text: String,
    original_size: usize,
    ts_ms: i64,
    sequence: u64,
    child_session: String,
    model: String,
}

impl TurnTrace {
    pub fn new(turn_id: impl Into<String>) -> Self {
        Self {
            turn_id: turn_id.into(),
            jsonl: Vec::new(),
            lines: 0,
            dropped_events: 0,
            pending: None,
        }
    }

    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }

    pub fn is_empty(&self) -> bool {
        self.lines == 0 && self.pending.is_none() && self.dropped_events == 0
    }

    /// Append one ACP event. `sequence` is the envelope sequence (0 when the
    /// caller has none); `child_session` is the sub-agent ACP session id, empty
    /// for the agent's own events.
    pub fn record(&mut self, sequence: u64, child_session: &str, event: &amux::AcpEvent) {
        use amux::acp_event::Event;
        let Some(inner) = event.event.as_ref().filter(|_| is_traced(event)) else {
            return;
        };
        let ts_ms = chrono::Utc::now().timestamp_millis();
        let (kind, delta) = match inner {
            Event::Thinking(t) => ("thinking", t.text.as_str()),
            Event::Output(o) => ("reply", o.text.as_str()),
            _ => {
                self.flush_pending();
                let head = |kind| LineHead {
                    kind,
                    ts_ms,
                    sequence,
                    child_session,
                    model: &event.model,
                };
                self.record_structured(head, inner);
                return;
            }
        };

        let continues = self.pending.as_ref().is_some_and(|p| {
            p.kind == kind && p.child_session == child_session && p.model == event.model
        });
        if !continues {
            self.flush_pending();
            self.pending = Some(PendingText {
                kind,
                text: String::new(),
                original_size: 0,
                ts_ms,
                sequence,
                child_session: child_session.to_owned(),
                model: event.model.clone(),
            });
        }
        let pending = self.pending.as_mut().expect("pending text set above");
        pending.original_size += delta.len();
        let room = FIELD_CAP_BYTES.saturating_sub(pending.text.len());
        if room > 0 {
            pending
                .text
                .push_str(&delta[..delta.floor_char_boundary(room)]);
        }
        if matches!(inner, Event::Output(o) if o.is_complete) {
            self.flush_pending();
        }
    }

    /// Close the trace: flush the open text run and, if the budget dropped
    /// anything, say how much.
    pub fn finish(mut self) -> Vec<u8> {
        self.flush_pending();
        if self.dropped_events > 0 {
            let dropped = self.dropped_events;
            let head = LineHead {
                kind: "trace_truncated",
                ts_ms: chrono::Utc::now().timestamp_millis(),
                sequence: 0,
                child_session: "",
                model: "",
            };
            self.write_line(head, true, |map| {
                map.serialize_entry("dropped_events", &dropped)
            });
        }
        self.jsonl
    }

    fn record_structured<'e>(
        &mut self,
        head: impl Fn(&'static str) -> LineHead<'e>,
        event: &amux::acp_event::Event,
    ) {
        use amux::acp_event::Event;
        match event {
            Event::ToolUse(tu) => self.write_line(head("tool_call"), false, |map| {
                map.serialize_entry("tool_id", &tu.tool_id)?;
                map.serialize_entry("tool_name", &tu.tool_name)?;
                map.serialize_entry("tool_kind", &tu.tool_kind)?;
                map.serialize_entry("status", &tu.status)?;
                serialize_payload(map, "raw_input", &tu.raw_input_json, true)?;
                serialize_payload(map, "raw_output", &tu.raw_output_json, true)
            }),
            Event::ToolResult(tr) => self.write_line(head("tool_result"), false, |map| {
                map.serialize_entry("tool_id", &tr.tool_id)?;
                map.serialize_entry("success", &tr.success)?;
                serialize_payload(map, "summary", &tr.summary, false)?;
                serialize_payload(map, "raw_output", &tr.raw_output_json, true)
            }),
            Event::PermissionRequest(pr) => {
                self.write_line(head("permission_request"), false, |map| {
                    map.serialize_entry("request_id", &pr.request_id)?;
                    map.serialize_entry("tool_name", &pr.tool_name)?;
                    serialize_payload(map, "description", &pr.description, false)
                })
            }
            Event::StatusChange(sc) => self.write_line(head("status_change"), true, |map| {
                map.serialize_entry("old_status", status_name(sc.old_status))?;
                map.serialize_entry("new_status", status_name(sc.new_status))
            }),
            Event::Error(err) => self.write_line(head("error"), true, |map| {
                serialize_payload(map, "message", &err.message, false)?;
                serialize_payload(map, "details", &err.details, false)
            }),
            _ => {}
        }
    }

    fn flush_pending(&mut self) {
        let Some(p) = self.pending.take() else {
            return;
        };
        let head = LineHead {
            kind: p.kind,
            ts_ms: p.ts_ms,
            sequence: p.sequence,
            child_session: &p.child_session,
            model: &p.model,
        };
        self.write_line(head, false, |map| {
            map.serialize_entry("text", &p.text)?;
            if p.original_size > p.text.len() {
                map.serialize_entry("text_original_size", &p.original_size)?;
            }
            Ok(())
        });
    }

    /// Write one line. `structural` lines are kept past the budget; everything
    /// else is counted in `dropped_events` instead.
    fn write_line(
        &mut self,
        head: LineHead<'_>,
        structural: bool,
        body: impl FnOnce(&mut LineMap<'_, '_>) -> serde_json::Result<()>,
    ) {
        if !structural && self.jsonl.len() >= TRACE_BUDGET_BYTES {
            self.dropped_events += 1;
            return;
        }
        let start = self.jsonl.len();
        let turn_seq = self.lines + 1;
        match serialize_line(&mut self.jsonl, turn_seq, &head, body) {
            Ok(()) => {
                self.jsonl.push(b'\n');
                self.lines = turn_seq;
            }
            Err(e) => {
                // Serializing into a Vec cannot fail on I/O; drop the partial line
                // so one bad event cannot corrupt the rest of the file.
                warn!(?e, kind = head.kind, "turn trace line serialization failed");
                self.jsonl.truncate(start);
                self.dropped_events += 1;
            }
        }
    }
}

fn serialize_line(
    out: &mut Vec<u8>,
    turn_seq: u64,
    head: &LineHead<'_>,
    body: impl FnOnce(&mut LineMap<'_, '_>) -> serde_json::Result<()>,
) -> serde_json::Result<()> {
    let mut ser = serde_json::Serializer::new(out);
    let mut map = ser.serialize_map(None)?;
    map.serialize_entry("turn_seq", &turn_seq)?;
    map.serialize_entry("type", head.kind)?;
    map.serialize_entry("ts_ms", &head.ts_ms)?;
    if head.sequence > 0 {
        map.serialize_entry("sequence", &head.sequence)?;
    }
    if !head.child_session.is_empty() {
        map.serialize_entry("child_session", head.child_session)?;
    }
    if !head.model.is_empty() {
        map.serialize_entry("model", head.model)?;
    }
    body(&mut map)?;
    SerializeMap::end(map)
}

/// The traces of every agent's in-flight turn, for the chat path.
#[derive(Default)]
pub struct TurnTraceRecorder {
    active: HashMap<String, TurnTrace>,
}

impl TurnTraceRecorder {
    /// Record one event of `agent_id`'s turn `turn_id`. A new turn id replaces
    /// whatever the agent had open; events outside a turn are ignored.
    pub fn record(
        &mut self,
        agent_id: &str,
        turn_id: &str,
        sequence: u64,
        child_session: &str,
        event: &amux::AcpEvent,
    ) {
        if turn_id.is_empty() || !is_traced(event) {
            return;
        }
        if self
            .active
            .get(agent_id)
            .is_none_or(|t| t.turn_id != turn_id)
        {
            self.active
                .insert(agent_id.to_owned(), TurnTrace::new(turn_id));
        }
        if let Some(trace) = self.active.get_mut(agent_id) {
            trace.record(sequence, child_session, event);
        }
    }

    /// Hand over `agent_id`'s trace if it is for `turn_id`.
    pub fn take(&mut self, agent_id: &str, turn_id: &str) -> Option<TurnTrace> {
        if self.active.get(agent_id)?.turn_id != turn_id {
            return None;
        }
        self.active.remove(agent_id)
    }

    /// Drop whatever `agent_id` has open — the turn ended without a reply to
    /// attach it to.
    pub fn discard(&mut self, agent_id: &str) {
        self.active.remove(agent_id);
    }

    #[cfg(test)]
    pub fn active_len(&self) -> usize {
        self.active.len()
    }
}

/// Whether `event` belongs in a trace. Everything else (ambient command lists,
/// plan snapshots, raw catch-alls) is skipped without touching an open text run.
pub fn is_traced(event: &amux::AcpEvent) -> bool {
    use amux::acp_event::Event;
    matches!(
        event.event,
        Some(
            Event::Thinking(_)
                | Event::Output(_)
                | Event::ToolUse(_)
                | Event::ToolResult(_)
                | Event::PermissionRequest(_)
                | Event::StatusChange(_)
                | Event::Error(_)
        )
    )
}

fn status_name(status: i32) -> &'static str {
    match amux::AgentStatus::try_from(status).unwrap_or(amux::AgentStatus::Unknown) {
        amux::AgentStatus::Unknown => "unknown",
        amux::AgentStatus::Starting => "starting",
        amux::AgentStatus::Active => "active",
        amux::AgentStatus::Idle => "idle",
        amux::AgentStatus::Error => "error",
        amux::AgentStatus::Stopped => "stopped",
    }
}

/// Serialize `raw` under `field`, capped. Empty payloads are omitted.
fn serialize_payload(
    map: &mut LineMap<'_, '_>,
    field: &'static str,
    raw: &str,
    json: bool,
) -> serde_json::Result<()> {
    if raw.is_empty() {
        return Ok(());
    }
    if raw.len() > FIELD_CAP_BYTES {
        let head = &raw[..raw.floor_char_boundary(FIELD_CAP_BYTES / 2)];
        let tail = &raw[raw.ceil_char_boundary(raw.len() - FIELD_CAP_BYTES / 2)..];
        map.serialize_entry(
            field,
            &Truncated {
                head,
                tail,
                original_size: raw.len(),
            },
        )?;
        return map.serialize_entry(original_size_key(field), &raw.len());
    }
    if json {
        // Verbatim only when it is JSON *and* single-line: a pretty-printed
        // payload's newlines would split the JSONL record.
        if let Ok(value) = serde_json::from_str::<&RawValue>(raw) {
            if !raw.contains('\n') {
                return map.serialize_entry(field, value);
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
                return map.serialize_entry(field, &value);
            }
        }
    }
    map.serialize_entry(field, raw)
}

fn original_size_key(field: &'static str) -> &'static str {
    match field {
        "raw_input" => "raw_input_original_size",
        "raw_output" => "raw_output_original_size",
        "summary" => "summary_original_size",
        "description" => "description_original_size",
        "message" => "message_original_size",
        "details" => "details_original_size",
        _ => "original_size",
    }
}

struct Truncated<'a> {
    head: &'a str,
    tail: &'a str,
    original_size: usize,
}

impl Serialize for Truncated<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // `collect_str` escapes straight into the output; no joined copy.
        serializer.collect_str(&format_args!(
            "{}\n…[{} bytes truncated]…\n{}",
            self.head, self.original_size, self.tail
        ))
    }
}

/// A finished trace, compressed once and shared by every session's upload.
pub struct TraceBlob {
    pub gz: Bytes,
    pub size: u64,
    pub sha256: String,
}

pub fn compress_trace(jsonl: &[u8]) -> std::io::Result<TraceBlob> {
    let mut enc = GzEncoder::new(Vec::with_capacity(jsonl.len() / 4), Compression::fast());
    enc.write_all(jsonl)?;
    let gz = enc.finish()?;
    let sha256 = crate::sync::oss::crypto::sha256_hex(&gz);
    Ok(TraceBlob {
        size: gz.len() as u64,
        sha256,
        gz: Bytes::from(gz),
    })
}

/// Where one turn's reply was persisted.
pub struct TraceTarget {
    pub session_id: String,
    pub message_id: String,
}

/// Compress `trace` off the run loop and upload it for every target.
pub fn spawn_trace_upload(backend: Arc<dyn Backend>, trace: TurnTrace, targets: Vec<TraceTarget>) {
    if targets.is_empty() || trace.is_empty() {
        return;
    }
    tokio::spawn(async move {
        let turn_id = trace.turn_id().to_owned();
        let blob = match tokio::task::spawn_blocking(move || compress_trace(&trace.finish())).await
        {
            Ok(Ok(blob)) => blob,
            Ok(Err(e)) => {
                warn!(?e, turn_id, "turn trace compression failed");
                return;
            }
            Err(e) => {
                warn!(?e, turn_id, "turn trace compression task failed");
                return;
            }
        };
        futures::future::join_all(
            targets
                .iter()
                .map(|target| upload_to_target(backend.as_ref(), &turn_id, &blob, target)),
        )
        .await;
    });
}

async fn upload_to_target(
    backend: &dyn Backend,
    turn_id: &str,
    blob: &TraceBlob,
    target: &TraceTarget,
) {
    let upload = TurnTraceUpload {
        session_id: &target.session_id,
        turn_id,
        message_id: &target.message_id,
        size: blob.size,
        sha256: &blob.sha256,
    };
    let status = match backend.prepare_turn_trace_upload(&upload).await {
        Ok(presigned_put) => match backend
            .put_turn_trace_blob(&presigned_put, blob.gz.clone())
            .await
        {
            Ok(()) => TurnTraceStatus::Uploaded,
            Err(e) => {
                warn!(?e, session_id = %target.session_id, turn_id, "turn trace upload failed");
                TurnTraceStatus::Failed
            }
        },
        // Already uploaded: the pointer is in place, and FC would refuse to
        // downgrade it anyway.
        Err(BackendError::Provider {
            code: Some(code), ..
        }) if code == "conflict" => return,
        Err(e) => {
            warn!(?e, session_id = %target.session_id, turn_id, "turn trace prepare failed");
            TurnTraceStatus::Failed
        }
    };
    if let Err(e) = backend.complete_turn_trace_upload(&upload, status).await {
        warn!(?e, session_id = %target.session_id, turn_id, ?status, "turn trace complete failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amux::acp_event::Event;
    use serde_json::Value;

    fn ev(event: Event) -> amux::AcpEvent {
        amux::AcpEvent {
            event: Some(event),
            model: String::new(),
        }
    }

    fn lines(trace: TurnTrace) -> Vec<Value> {
        let raw = trace.finish();
        String::from_utf8(raw)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn status(old: amux::AgentStatus, new: amux::AgentStatus) -> Event {
        Event::StatusChange(amux::AcpStatusChange {
            old_status: old as i32,
            new_status: new as i32,
        })
    }

    #[test]
    fn turn_seq_is_dense_across_skipped_events_and_boundaries_are_kept() {
        let mut t = TurnTrace::new("turn");
        t.record(
            1,
            "",
            &ev(status(amux::AgentStatus::Idle, amux::AgentStatus::Active)),
        );
        t.record(
            2,
            "",
            &ev(Event::AvailableCommands(
                amux::AcpAvailableCommands::default(),
            )),
        );
        t.record(
            3,
            "",
            &ev(Event::ToolUse(amux::AcpToolUse {
                tool_id: "t1".into(),
                tool_name: "read".into(),
                raw_input_json: r#"{"path":"a.rs"}"#.into(),
                ..Default::default()
            })),
        );
        t.record(4, "", &ev(Event::Raw(amux::AcpRawJson::default())));
        t.record(
            5,
            "",
            &ev(Event::ToolResult(amux::AcpToolResult {
                tool_id: "t1".into(),
                success: true,
                summary: "ok".into(),
                ..Default::default()
            })),
        );
        t.record(
            6,
            "",
            &ev(status(amux::AgentStatus::Active, amux::AgentStatus::Idle)),
        );

        let lines = lines(t);
        let seqs: Vec<u64> = lines
            .iter()
            .map(|l| l["turn_seq"].as_u64().unwrap())
            .collect();
        assert_eq!(seqs, vec![1, 2, 3, 4]);
        assert_eq!(lines[0]["type"], "status_change");
        assert_eq!(lines[0]["new_status"], "active");
        assert_eq!(lines[1]["type"], "tool_call");
        assert_eq!(lines[1]["raw_input"]["path"], "a.rs");
        assert_eq!(lines[1]["sequence"], 3);
        assert_eq!(lines[2]["type"], "tool_result");
        assert_eq!(lines[3]["new_status"], "idle");
    }

    #[test]
    fn text_deltas_coalesce_into_one_line_per_run() {
        let mut t = TurnTrace::new("turn");
        for chunk in ["Let ", "me ", "look"] {
            t.record(
                0,
                "",
                &ev(Event::Thinking(amux::AcpThinking { text: chunk.into() })),
            );
        }
        for chunk in ["Done", "."] {
            t.record(
                0,
                "",
                &ev(Event::Output(amux::AcpOutput {
                    text: chunk.into(),
                    is_complete: false,
                })),
            );
        }
        let lines = lines(t);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["type"], "thinking");
        assert_eq!(lines[0]["text"], "Let me look");
        assert_eq!(lines[1]["type"], "reply");
        assert_eq!(lines[1]["text"], "Done.");
    }

    #[test]
    fn every_payload_is_capped_including_tool_use() {
        let big_json = format!(r#"{{"blob":"{}"}}"#, "x".repeat(FIELD_CAP_BYTES * 2));
        let big_text = "é".repeat(FIELD_CAP_BYTES);
        let mut t = TurnTrace::new("turn");
        t.record(
            0,
            "",
            &ev(Event::ToolUse(amux::AcpToolUse {
                tool_id: "t1".into(),
                raw_input_json: big_json.clone(),
                raw_output_json: big_json.clone(),
                ..Default::default()
            })),
        );
        t.record(
            0,
            "",
            &ev(Event::Thinking(amux::AcpThinking {
                text: big_text.clone(),
            })),
        );
        t.record(
            0,
            "",
            &ev(Event::Error(amux::AcpError {
                message: "boom".into(),
                details: big_text.clone(),
            })),
        );
        let raw = t.finish();
        assert!(
            raw.len() < FIELD_CAP_BYTES * 5,
            "trace was {} bytes",
            raw.len()
        );
        let lines: Vec<Value> = String::from_utf8(raw)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["raw_input_original_size"], big_json.len());
        assert_eq!(lines[0]["raw_output_original_size"], big_json.len());
        assert!(lines[0]["raw_input"]
            .as_str()
            .unwrap()
            .contains("bytes truncated"));
        assert_eq!(lines[1]["text_original_size"], big_text.len());
        assert!(lines[1]["text"].as_str().unwrap().len() <= FIELD_CAP_BYTES);
        assert_eq!(lines[2]["details_original_size"], big_text.len());
    }

    #[test]
    fn budget_drops_payload_lines_but_keeps_structure() {
        let payload = "y".repeat(FIELD_CAP_BYTES);
        let mut t = TurnTrace::new("turn");
        let results = TRACE_BUDGET_BYTES / FIELD_CAP_BYTES + 8;
        for i in 0..results {
            t.record(
                0,
                "",
                &ev(Event::ToolResult(amux::AcpToolResult {
                    tool_id: format!("t{i}"),
                    summary: payload.clone(),
                    ..Default::default()
                })),
            );
        }
        t.record(
            0,
            "",
            &ev(status(amux::AgentStatus::Active, amux::AgentStatus::Idle)),
        );
        let raw = t.finish();
        assert!(raw.len() < TRACE_BUDGET_BYTES + 2 * FIELD_CAP_BYTES);
        let lines: Vec<Value> = String::from_utf8(raw)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let last = lines.last().unwrap();
        assert_eq!(last["type"], "trace_truncated");
        assert!(last["dropped_events"].as_u64().unwrap() > 0);
        assert_eq!(lines[lines.len() - 2]["type"], "status_change");
        let seqs: Vec<u64> = lines
            .iter()
            .map(|l| l["turn_seq"].as_u64().unwrap())
            .collect();
        assert_eq!(seqs, (1..=lines.len() as u64).collect::<Vec<_>>());
    }

    #[test]
    fn pretty_printed_json_stays_on_one_line() {
        let mut t = TurnTrace::new("turn");
        t.record(
            0,
            "",
            &ev(Event::ToolResult(amux::AcpToolResult {
                tool_id: "t1".into(),
                raw_output_json: "{\n  \"a\": 1\n}".into(),
                ..Default::default()
            })),
        );
        let lines = lines(t);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["raw_output"]["a"], 1);
    }

    #[test]
    fn recorder_takes_only_the_matching_turn_and_resets_on_a_new_one() {
        let thinking = ev(Event::Thinking(amux::AcpThinking { text: "hm".into() }));
        let mut rec = TurnTraceRecorder::default();
        rec.record("agent", "", 1, "", &thinking);
        assert!(rec.take("agent", "").is_none());

        rec.record("agent", "turn-a", 2, "", &thinking);
        rec.record("agent", "turn-b", 3, "", &thinking);
        assert!(rec.take("agent", "turn-a").is_none());
        let trace = rec.take("agent", "turn-b").expect("turn-b trace");
        assert_eq!(lines(trace).len(), 1);
        assert!(rec.take("agent", "turn-b").is_none());

        // Ambient events neither open nor reset a turn.
        rec.record("agent", "turn-c", 4, "", &thinking);
        rec.record(
            "agent",
            "turn-d",
            5,
            "",
            &ev(Event::AvailableCommands(
                amux::AcpAvailableCommands::default(),
            )),
        );
        assert!(rec.take("agent", "turn-c").is_some());
    }

    #[test]
    fn compressed_blob_round_trips_and_hashes_the_gzip_bytes() {
        use std::io::Read;
        let mut t = TurnTrace::new("turn");
        t.record(
            0,
            "",
            &ev(Event::Thinking(amux::AcpThinking { text: "hi".into() })),
        );
        let jsonl = t.finish();
        let blob = compress_trace(&jsonl).unwrap();
        assert_eq!(blob.size, blob.gz.len() as u64);
        assert_eq!(blob.sha256, crate::sync::oss::crypto::sha256_hex(&blob.gz));
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&blob.gz[..])
            .read_to_end(&mut out)
            .unwrap();
        assert_eq!(out, jsonl);
    }
}
