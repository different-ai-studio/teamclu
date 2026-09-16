//! Turn execution trace: `EventHistory` → jsonl.gz → OSS (#1455 §7.2).

use crate::backend::{Backend, BackendResult, TurnTracePrepare};
use crate::proto::amux;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use tracing::warn;

/// Single tool-result payload cap before head/tail truncation (§7.2 Q8).
pub const TOOL_RESULT_TRUNCATE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TracePointer {
    pub key: String,
    pub size: u64,
    pub sha256: String,
    pub status: &'static str,
}

pub fn turn_trace_object_key(team_id: &str, session_id: &str, turn_id: &str) -> String {
    format!("turns/{team_id}/{session_id}/{turn_id}.jsonl.gz")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn gzip_bytes(raw: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
    enc.write_all(raw)?;
    Ok(enc.finish()?)
}

/// Serialize matching turn envelopes as newline-delimited JSON.
pub fn encode_turn_trace_jsonl(events: &[amux::Envelope]) -> Vec<u8> {
    let mut out = Vec::new();
    for (idx, env) in events.iter().enumerate() {
        let Some(line) = envelope_to_trace_line(env, idx as u64 + 1) else {
            continue;
        };
        serde_json::to_writer(&mut out, &line).ok();
        out.push(b'\n');
    }
    out
}

fn envelope_to_trace_line(env: &amux::Envelope, turn_seq: u64) -> Option<Value> {
    let acp = match env.payload.as_ref()? {
        amux::envelope::Payload::AcpEvent(e) => e,
        _ => return None,
    };
    let mut line = json!({
        "turn_seq": turn_seq,
        "sequence": env.sequence,
        "timestamp": env.timestamp,
        "turn_id": env.turn_id,
        "runtime_id": env.runtime_id,
    });
    let obj = line.as_object_mut()?;
    match acp.event.as_ref()? {
        amux::acp_event::Event::Thinking(t) => {
            obj.insert("type".into(), Value::String("thinking".into()));
            obj.insert("text".into(), Value::String(t.text.clone()));
        }
        amux::acp_event::Event::Output(o) => {
            obj.insert("type".into(), Value::String("reply".into()));
            obj.insert("text".into(), Value::String(o.text.clone()));
            obj.insert("is_complete".into(), Value::Bool(o.is_complete));
        }
        amux::acp_event::Event::ToolUse(tu) => {
            obj.insert("type".into(), Value::String("tool_call".into()));
            obj.insert("tool_id".into(), Value::String(tu.tool_id.clone()));
            obj.insert("tool_name".into(), Value::String(tu.tool_name.clone()));
            obj.insert("tool_kind".into(), Value::String(tu.tool_kind.clone()));
            obj.insert("status".into(), Value::String(tu.status.clone()));
            if !tu.raw_input_json.is_empty() {
                obj.insert(
                    "raw_input".into(),
                    parse_json_or_string(&tu.raw_input_json),
                );
            }
            if !tu.raw_output_json.is_empty() {
                obj.insert(
                    "raw_output".into(),
                    parse_json_or_string(&tu.raw_output_json),
                );
            }
        }
        amux::acp_event::Event::ToolResult(tr) => {
            obj.insert("type".into(), Value::String("tool_result".into()));
            obj.insert("tool_id".into(), Value::String(tr.tool_id.clone()));
            obj.insert("success".into(), Value::Bool(tr.success));
            let (summary, truncated, original_size) =
                truncate_tool_text(&tr.summary, TOOL_RESULT_TRUNCATE_BYTES);
            obj.insert("summary".into(), Value::String(summary));
            if truncated {
                obj.insert("summary_truncated".into(), Value::Bool(true));
                obj.insert(
                    "summary_original_size".into(),
                    Value::Number(original_size.into()),
                );
            }
            if !tr.raw_output_json.is_empty() {
                let raw = tr.raw_output_json.as_str();
                let (text, truncated, original_size) =
                    truncate_tool_text(raw, TOOL_RESULT_TRUNCATE_BYTES);
                obj.insert("raw_output".into(), parse_json_or_string(&text));
                if truncated {
                    obj.insert("raw_output_truncated".into(), Value::Bool(true));
                    obj.insert(
                        "raw_output_original_size".into(),
                        Value::Number(original_size.into()),
                    );
                }
            }
        }
        _ => return None,
    }
    if !acp.model.is_empty() {
        obj.insert("model".into(), Value::String(acp.model.clone()));
    }
    Some(line)
}

fn parse_json_or_string(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn truncate_tool_text(text: &str, max_bytes: usize) -> (String, bool, usize) {
    let bytes = text.as_bytes();
    let original_size = bytes.len();
    if original_size <= max_bytes {
        return (text.to_string(), false, original_size);
    }
    let head = max_bytes / 2;
    let tail = max_bytes.saturating_sub(head);
    let head_str = String::from_utf8_lossy(&bytes[..head]);
    let tail_str = String::from_utf8_lossy(&bytes[original_size - tail..]);
    (
        format!("{head_str}\n…[{original_size} bytes truncated]…\n{tail_str}"),
        true,
        original_size,
    )
}

/// Match `CloudApiBackend::insert_message_impl` — stamp envelope sequence on
/// cloud metadata so a later trace patch does not drop it.
pub fn stamp_cloud_message_metadata(metadata_json: &str, sequence: u64) -> String {
    let mut root = serde_json::from_str::<Value>(metadata_json).unwrap_or_else(|_| json!({}));
    match &mut root {
        Value::Object(map) => {
            map.insert("sequence".into(), Value::from(sequence));
        }
        Value::Null => {
            root = json!({ "sequence": sequence });
        }
        other => {
            root = json!({ "value": other, "sequence": sequence });
        }
    }
    serde_json::to_string(&root).unwrap_or_else(|_| metadata_json.to_string())
}

pub fn merge_trace_metadata(existing: &str, trace: &TracePointer) -> String {
    let mut root = serde_json::from_str::<Value>(existing).unwrap_or_else(|_| json!({}));
    let obj = match &mut root {
        Value::Object(map) => map,
        other => {
            root = json!({ "value": other });
            root.as_object_mut().unwrap()
        }
    };
    obj.insert(
        "trace".into(),
        json!({
            "key": trace.key,
            "size": trace.size,
            "sha256": trace.sha256,
            "status": trace.status,
        }),
    );
    serde_json::to_string(&root).unwrap_or_else(|_| existing.to_string())
}

pub async fn put_presigned_bytes(url: &str, bytes: Vec<u8>) -> BackendResult<()> {
    let resp = reqwest::Client::new()
        .put(url)
        .header(reqwest::header::CONTENT_LENGTH, bytes.len())
        .body(bytes)
        .send()
        .await
        .map_err(|e| crate::backend::BackendError::Provider {
            provider: "cloud_api",
            code: None,
            message: format!("turn trace PUT failed: {e}"),
        })?;
    if resp.status().is_success() {
        return Ok(());
    }
    Err(crate::backend::BackendError::Provider {
        provider: "cloud_api",
        code: None,
        message: format!("turn trace PUT failed: HTTP {}", resp.status()),
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn upload_turn_trace(
    backend: std::sync::Arc<dyn Backend>,
    team_id: &str,
    session_id: &str,
    turn_id: &str,
    message_id: &str,
    metadata_json: &str,
    events: Vec<amux::Envelope>,
) {
    if turn_id.is_empty() || events.is_empty() {
        return;
    }
    let raw = encode_turn_trace_jsonl(&events);
    let gz = match gzip_bytes(&raw) {
        Ok(v) => v,
        Err(e) => {
            warn!(?e, session_id, turn_id, "turn trace gzip failed");
            return;
        }
    };
    let sha = sha256_hex(&gz);
    let size = gz.len() as u64;
    let key = turn_trace_object_key(team_id, session_id, turn_id);

    let prepare: TurnTracePrepare = match backend
        .prepare_turn_trace_upload(session_id, turn_id, team_id, size, &sha)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            warn!(?e, session_id, turn_id, "turn trace prepare failed");
            patch_trace_status(
                backend.as_ref(),
                message_id,
                metadata_json,
                &TracePointer {
                    key: key.clone(),
                    size,
                    sha256: sha,
                    status: "failed",
                },
            )
            .await;
            return;
        }
    };

    if let Err(e) = put_presigned_bytes(&prepare.presigned_put, gz).await {
        warn!(?e, session_id, turn_id, "turn trace upload failed");
        patch_trace_status(
            backend.as_ref(),
            message_id,
            metadata_json,
            &TracePointer {
                key: prepare.oss_key,
                size,
                sha256: sha,
                status: "failed",
            },
        )
        .await;
        return;
    }

    patch_trace_status(
        backend.as_ref(),
        message_id,
        metadata_json,
        &TracePointer {
            key: prepare.oss_key,
            size,
            sha256: sha,
            status: "uploaded",
        },
    )
    .await;
}

async fn patch_trace_status(
    backend: &dyn Backend,
    message_id: &str,
    metadata_json: &str,
    trace: &TracePointer,
) {
    let merged = merge_trace_metadata(metadata_json, trace);
    if let Err(e) = backend.patch_message_metadata(message_id, &merged).await {
        warn!(?e, message_id, "turn trace metadata patch failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::amux;

    fn env(seq: u64, turn_id: &str, event: amux::acp_event::Event) -> amux::Envelope {
        amux::Envelope {
            runtime_id: "agent".into(),
            actor_id: "actor".into(),
            source_peer_id: String::new(),
            timestamp: 1,
            sequence: seq,
            turn_id: turn_id.into(),
            acp_session_id: String::new(),
            payload: Some(amux::envelope::Payload::AcpEvent(amux::AcpEvent {
                event: Some(event),
                model: String::new(),
            })),
        }
    }

    #[test]
    fn jsonl_includes_turn_seq_and_tool_events() {
        let turn = "00000000-0000-0000-0000-00000000000a";
        let events = vec![
            env(
                1,
                turn,
                amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                    tool_id: "t1".into(),
                    tool_name: "read".into(),
                    ..Default::default()
                }),
            ),
            env(
                2,
                turn,
                amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                    tool_id: "t1".into(),
                    success: true,
                    summary: "ok".into(),
                    ..Default::default()
                }),
            ),
        ];
        let raw = encode_turn_trace_jsonl(&events);
        let text = String::from_utf8(raw).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["type"], "tool_call");
        assert_eq!(lines[0]["turn_seq"], 1);
        assert_eq!(lines[1]["type"], "tool_result");
        assert_eq!(lines[1]["turn_seq"], 2);
    }

    #[test]
    fn merge_trace_metadata_preserves_existing_keys() {
        let merged = merge_trace_metadata(
            r#"{"turn_status":"ok","sequence":7}"#,
            &TracePointer {
                key: "turns/t/s/t.jsonl.gz".into(),
                size: 12,
                sha256: "abc".into(),
                status: "uploaded",
            },
        );
        let v: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["turn_status"], "ok");
        assert_eq!(v["sequence"], 7);
        assert_eq!(v["trace"]["status"], "uploaded");
    }

    #[test]
    fn truncate_tool_text_keeps_head_and_tail() {
        let big = "x".repeat(300_000);
        let (out, truncated, size) = truncate_tool_text(&big, 256 * 1024);
        assert!(truncated);
        assert_eq!(size, 300_000);
        assert!(out.contains("truncated"));
    }
}
