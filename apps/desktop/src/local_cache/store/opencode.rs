//! Filling tool-call output from opencode's own database.
//!
//! The daemon persists a tool call's arguments but not always its output, so
//! for opencode sessions the missing text is read back out of opencode's
//! private SQLite file. Every other runtime (pi, cursor, claude-code) never
//! writes that file, so for them the lookup is skipped before it touches disk.

use super::rows::MessageRow;
use super::{placeholders, text, MAX_IN_LIST};
use libsql::Builder;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// The runtime whose private database `enrich_*` reads. Every other runtime
/// (pi, cursor, claude-code) never writes it, so for them the lookup is a
/// guaranteed miss and is skipped up front.
const OPENCODE_RUNTIME: &str = "opencode";

fn opencode_db_paths(workspace_path: Option<&str>) -> Vec<PathBuf> {
    crate::opencode_paths::opencode_db_candidates(workspace_path, dirs::home_dir().as_deref())
}

/// Whether the tool-output lookup in opencode's private database can ever hit
/// for this message. `None` means the caller does not know the runtime (older
/// frontends, `enrich_parts` with no message row) — then only the on-disk
/// existence of the database gates the lookup, as before.
fn opencode_enrichment_applies(runtime: Option<&str>) -> bool {
    match runtime.map(str::trim).filter(|r| !r.is_empty()) {
        Some(runtime) => runtime.eq_ignore_ascii_case(OPENCODE_RUNTIME),
        None => true,
    }
}

fn string_at<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|v| v.as_str())
}

fn collect_description_values(args: Option<&serde_json::Value>) -> HashSet<String> {
    let mut values = HashSet::new();
    let Some(args) = args.and_then(|v| v.as_object()) else {
        return values;
    };

    for key in ["description", "summary", "title", "action"] {
        if let Some(value) = args.get(key).and_then(|v| v.as_str()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                values.insert(trimmed.to_string());
            }
        }
    }

    if let Some(raw) = args.get("_description").and_then(|v| v.as_str()) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) {
            for key in ["description", "summary", "title", "action"] {
                if let Some(value) = parsed.get(key).and_then(|v| v.as_str()) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        values.insert(trimmed.to_string());
                    }
                }
            }
        } else {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                values.insert(trimmed.to_string());
            }
        }
    }

    values
}

fn tool_call_id_from_part(part: &serde_json::Value) -> Option<String> {
    string_at(part, "toolCallId")
        .or_else(|| part.pointer("/toolCall/id").and_then(|v| v.as_str()))
        .map(ToString::to_string)
}

fn tool_call_part_needs_output(part: &serde_json::Value) -> bool {
    let result = part.pointer("/toolCall/result").and_then(|v| v.as_str());
    let Some(result) = result.map(str::trim).filter(|s| !s.is_empty()) else {
        return true;
    };
    let args = part.pointer("/toolCall/arguments");
    collect_description_values(args).contains(result)
}

fn collect_opencode_tool_ids_from_parts_json(parts_json: &str) -> HashSet<String> {
    let Ok(parts) = serde_json::from_str::<serde_json::Value>(parts_json) else {
        return HashSet::new();
    };
    let Some(parts) = parts.as_array() else {
        return HashSet::new();
    };
    parts
        .iter()
        .filter(|part| string_at(part, "type") == Some("tool-call"))
        .filter(|part| tool_call_part_needs_output(part))
        .filter_map(tool_call_id_from_part)
        .collect()
}

/// JSON key on an opencode `part` row that carries the tool-call id. The
/// `json_extract` in [`load_opencode_tool_outputs_from_paths`] and the
/// post-filter here must agree on it.
const OPENCODE_CALL_ID_KEY: &str = "callID";

/// `(callID, output)` of an opencode tool part, if it has a non-empty output.
fn opencode_part_call_output(data: &str) -> Option<(String, String)> {
    let value = serde_json::from_str::<serde_json::Value>(data).ok()?;
    let call_id = string_at(&value, OPENCODE_CALL_ID_KEY)?.to_string();
    let state = value.get("state")?;
    let output = string_at(state, "output")
        .or_else(|| state.pointer("/metadata/output").and_then(|v| v.as_str()))
        .map(ToString::to_string)
        .filter(|text| !text.trim().is_empty())?;
    Some((call_id, output))
}

fn enrich_parts_json_with_opencode_outputs(
    parts_json: &str,
    outputs: &HashMap<String, String>,
) -> Option<String> {
    let mut parts = serde_json::from_str::<serde_json::Value>(parts_json).ok()?;
    let parts_array = parts.as_array_mut()?;
    let mut changed = false;

    for part in parts_array {
        if string_at(part, "type") != Some("tool-call") || !tool_call_part_needs_output(part) {
            continue;
        }
        let Some(tool_call_id) = tool_call_id_from_part(part) else {
            continue;
        };
        let Some(output) = outputs.get(&tool_call_id) else {
            continue;
        };
        let Some(tool_call) = part.get_mut("toolCall").and_then(|v| v.as_object_mut()) else {
            continue;
        };
        tool_call.insert(
            "result".to_string(),
            serde_json::Value::String(output.clone()),
        );
        changed = true;
    }

    if changed {
        serde_json::to_string(&parts).ok()
    } else {
        None
    }
}

/// Look up tool outputs for `tool_call_ids` in the opencode databases at
/// `paths` (first hit per id wins; later paths only fill the gaps).
///
/// One statement per database: `json_extract(data, '$.callID') IN (...)`.
/// The previous shape was one `LIKE '%<id>%'` scan of the whole `part` table
/// *per tool call*, so a turn with 30 tool calls scanned the table 30 times —
/// and the table holds every opencode session on the machine, not just this
/// one. `json_valid` guards `json_extract`, which errors (aborting the query)
/// on a malformed row instead of skipping it.
async fn load_opencode_tool_outputs_from_paths(
    tool_call_ids: &HashSet<String>,
    paths: &[PathBuf],
) -> HashMap<String, String> {
    let mut outputs: HashMap<String, String> = HashMap::new();
    if tool_call_ids.is_empty() {
        return outputs;
    }

    for path in paths {
        if tokio::fs::metadata(path).await.is_err() {
            continue;
        }
        let db = match Builder::new_local(path.to_string_lossy().to_string())
            .build()
            .await
        {
            Ok(db) => db,
            Err(_) => continue,
        };
        let conn = match db.connect() {
            Ok(conn) => conn,
            Err(_) => continue,
        };

        let missing = tool_call_ids
            .iter()
            .filter(|id| !outputs.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>();
        for chunk in missing.chunks(MAX_IN_LIST) {
            let sql = format!(
                "SELECT data FROM part
                 WHERE json_valid(data)
                   AND json_extract(data, '$.{OPENCODE_CALL_ID_KEY}') IN ({})
                 ORDER BY time_updated DESC, time_created DESC",
                placeholders(chunk.len(), 0)
            );
            let binds = chunk.iter().map(|id| text(id)).collect::<Vec<_>>();
            let mut rows = match conn.query(&sql, binds).await {
                Ok(rows) => rows,
                Err(_) => continue,
            };
            while let Ok(Some(row)) = rows.next().await {
                let data = row.get::<String>(0).unwrap_or_default();
                let Some((call_id, output)) = opencode_part_call_output(&data) else {
                    continue;
                };
                // Rows arrive newest first; keep the first output per id.
                if tool_call_ids.contains(&call_id) {
                    outputs.entry(call_id).or_insert(output);
                }
            }
        }

        if outputs.len() == tool_call_ids.len() {
            break;
        }
    }
    outputs
}

async fn load_opencode_tool_outputs(
    tool_call_ids: &HashSet<String>,
    workspace_path: Option<&str>,
    runtime: Option<&str>,
) -> HashMap<String, String> {
    if tool_call_ids.is_empty() || !opencode_enrichment_applies(runtime) {
        return HashMap::new();
    }
    load_opencode_tool_outputs_from_paths(tool_call_ids, &opencode_db_paths(workspace_path)).await
}

pub(super) async fn enrich_message_rows_from_opencode(
    rows: &mut [MessageRow],
    workspace_path: Option<&str>,
    runtime: Option<&str>,
) {
    if !opencode_enrichment_applies(runtime) {
        return;
    }
    let tool_call_ids = rows
        .iter()
        .filter_map(|row| row.parts_json.as_deref())
        .flat_map(collect_opencode_tool_ids_from_parts_json)
        .collect::<HashSet<_>>();
    let outputs = load_opencode_tool_outputs(&tool_call_ids, workspace_path, runtime).await;
    if outputs.is_empty() {
        return;
    }

    for row in rows {
        let Some(parts_json) = row.parts_json.as_deref() else {
            continue;
        };
        if let Some(enriched) = enrich_parts_json_with_opencode_outputs(parts_json, &outputs) {
            row.parts_json = Some(enriched);
        }
    }
}

/// Fill tool-call results from opencode's own database. `runtime` is the
/// agent runtime that produced the parts when the caller knows it; anything
/// but opencode short-circuits without touching the disk.
pub async fn enrich_parts_json_from_opencode(
    parts_json: &str,
    workspace_path: Option<&str>,
    runtime: Option<&str>,
) -> String {
    if !opencode_enrichment_applies(runtime) {
        return parts_json.to_string();
    }
    let tool_call_ids = collect_opencode_tool_ids_from_parts_json(parts_json);
    let outputs = load_opencode_tool_outputs(&tool_call_ids, workspace_path, runtime).await;
    if outputs.is_empty() {
        return parts_json.to_string();
    }
    enrich_parts_json_with_opencode_outputs(parts_json, &outputs)
        .unwrap_or_else(|| parts_json.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use libsql::params;
    use tempfile::tempdir;

    #[test]
    fn opencode_part_call_output_reads_real_tool_stdout() {
        let data = serde_json::json!({
            "type": "tool",
            "tool": "bash",
            "callID": "call_1",
            "state": {
                "status": "completed",
                "input": {
                    "command": "ps -o pid,%cpu,%mem,comm -r | head -10",
                    "description": "Top 10 processes by CPU"
                },
                "output": "PID %CPU COMM\n1 launchd\n",
                "metadata": {
                    "output": "metadata output",
                    "description": "Top 10 processes by CPU"
                }
            }
        })
        .to_string();

        let (call_id, output) = opencode_part_call_output(&data).expect("completed tool part");
        assert_eq!(call_id, "call_1");
        assert_eq!(output, "PID %CPU COMM\n1 launchd\n");
    }

    #[test]
    fn collect_opencode_tool_ids_only_when_result_is_description() {
        let parts_json = serde_json::json!([
            {
                "type": "tool-call",
                "toolCallId": "call_needs_output",
                "toolCall": {
                    "id": "call_needs_output",
                    "result": "Top 10 processes by CPU",
                    "arguments": {
                        "description": "Top 10 processes by CPU"
                    }
                }
            },
            {
                "type": "tool-call",
                "toolCallId": "call_has_output",
                "toolCall": {
                    "id": "call_has_output",
                    "result": "PID %CPU COMM\n1 launchd\n",
                    "arguments": {
                        "description": "Top 10 processes by CPU"
                    }
                }
            }
        ])
        .to_string();

        let ids = collect_opencode_tool_ids_from_parts_json(&parts_json);
        assert!(ids.contains("call_needs_output"));
        assert!(!ids.contains("call_has_output"));
    }

    #[test]
    fn enrich_parts_json_with_opencode_output_replaces_title_result() {
        let parts_json = serde_json::json!([
            {
                "id": "stream:tool:call_1",
                "type": "tool-call",
                "toolCallId": "call_1",
                "toolCall": {
                    "id": "call_1",
                    "name": "bash",
                    "status": "completed",
                    "arguments": {
                        "_description": "{\"command\":\"ps -o pid,%cpu,%mem,comm -r | head -10\",\"description\":\"Top 10 processes by CPU\"}",
                        "command": "ps -o pid,%cpu,%mem,comm -r | head -10",
                        "description": "Top 10 processes by CPU"
                    },
                    "result": "Top 10 processes by CPU"
                }
            }
        ])
        .to_string();
        let outputs = HashMap::from([(
            "call_1".to_string(),
            "PID %CPU COMM\n50369 opencode\n".to_string(),
        )]);

        let enriched = enrich_parts_json_with_opencode_outputs(&parts_json, &outputs).unwrap();
        let parsed = serde_json::from_str::<serde_json::Value>(&enriched).unwrap();
        assert_eq!(
            parsed
                .pointer("/0/toolCall/result")
                .and_then(|v| v.as_str()),
            Some("PID %CPU COMM\n50369 opencode\n")
        );
    }

    #[test]
    fn opencode_enrichment_applies_only_to_opencode_or_unknown_runtime() {
        assert!(opencode_enrichment_applies(None));
        assert!(opencode_enrichment_applies(Some("")));
        assert!(opencode_enrichment_applies(Some("opencode")));
        assert!(opencode_enrichment_applies(Some(" OpenCode ")));
        assert!(!opencode_enrichment_applies(Some("pi")));
        assert!(!opencode_enrichment_applies(Some("cursor")));
        assert!(!opencode_enrichment_applies(Some("claude-code")));
    }

    #[tokio::test]
    async fn enrich_parts_json_leaves_non_opencode_runtimes_untouched() {
        let parts_json = serde_json::json!([{
            "type": "tool-call",
            "toolCallId": "call_1",
            "toolCall": { "id": "call_1", "result": "", "arguments": {} }
        }])
        .to_string();
        let out = enrich_parts_json_from_opencode(&parts_json, None, Some("pi")).await;
        assert_eq!(out, parts_json);
    }

    fn opencode_part(call_id: &str, output: &str) -> String {
        serde_json::json!({
            "type": "tool",
            "tool": "bash",
            "callID": call_id,
            "state": { "status": "completed", "output": output }
        })
        .to_string()
    }

    #[tokio::test]
    async fn opencode_outputs_resolve_all_ids_with_one_json_extract_query() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        {
            let db = Builder::new_local(path.to_string_lossy().to_string())
                .build()
                .await
                .unwrap();
            let conn = db.connect().unwrap();
            conn.execute(
                "CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT,
                                    time_created INTEGER, time_updated INTEGER, data TEXT)",
                (),
            )
            .await
            .unwrap();
            let rows: Vec<(&str, i64, String)> =
                vec![
                ("p1", 10, opencode_part("call_1", "older")),
                ("p2", 20, opencode_part("call_1", "newer")),
                ("p3", 15, opencode_part("call_2", "two")),
                // Completed tool without any output: must not count as a hit.
                (
                    "p4",
                    30,
                    serde_json::json!({ "callID": "call_3", "state": { "status": "completed" } })
                        .to_string(),
                ),
                // Not a tool part at all, and one malformed row json_valid must skip.
                ("p5", 40, serde_json::json!({ "type": "text", "text": "call_1" }).to_string()),
                ("p6", 50, "not json {".to_string()),
            ];
            for (id, t, data) in rows {
                conn.execute(
                    "INSERT INTO part (id, session_id, message_id, time_created, time_updated, data)
                     VALUES (?1, 'ses', 'msg', ?2, ?2, ?3)",
                    params![id.to_string(), t, data],
                )
                .await
                .unwrap();
            }
        }

        let ids = ["call_1", "call_2", "call_3", "missing"]
            .into_iter()
            .map(str::to_string)
            .collect::<HashSet<_>>();
        // A path that does not exist first: it is skipped, not fatal.
        let paths = vec![dir.path().join("nope.db"), path];
        let outputs = load_opencode_tool_outputs_from_paths(&ids, &paths).await;

        assert_eq!(outputs.get("call_1").map(String::as_str), Some("newer"));
        assert_eq!(outputs.get("call_2").map(String::as_str), Some("two"));
        assert!(!outputs.contains_key("call_3"));
        assert!(!outputs.contains_key("missing"));
        assert_eq!(outputs.len(), 2);
    }
}
