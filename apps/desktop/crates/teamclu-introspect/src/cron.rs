use serde_json::{json, Value};

pub async fn handle(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: action".to_string())?;

    let body = match action {
        "create" => create_request_body(workspace, arguments)?,
        "list" | "pause" | "resume" | "delete" | "run" | "get_runs" => {
            job_action_body(workspace, arguments, action)?
        }
        other => return Err(format!("Unknown action: {other}")),
    };

    let resp = crate::desktop_api::post(api_port, "/cron-manage", &body).await?;
    Ok(sanitize_manage_response(resp))
}

// ─── Create ───────────────────────────────────────────────────────────────────

fn create_request_body(workspace: &str, args: &Value) -> Result<Value, String> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "create requires 'name'".to_string())?;

    let schedule = args
        .get("schedule")
        .ok_or_else(|| "create requires 'schedule'".to_string())?;
    let schedule = normalize_schedule(schedule)?;

    let message = args
        .get("message")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "create requires 'message'".to_string())?;

    let scope = parse_scope(args)?;
    let mut body = json!({
        "action": "create",
        "scope": scope,
        "name": name,
        "enabled": true,
        "schedule": schedule,
        "payload": { "message": message },
    });

    if let Some(d) = args.get("description") {
        if !d.is_null() {
            body["description"] = d.clone();
        }
    }
    if let Some(delivery) = normalize_delivery(args)? {
        body["delivery"] = delivery;
    }
    if let Some(token) = args.get("reply_token").and_then(|v| v.as_str()) {
        let token = token.trim();
        if !token.is_empty() {
            body["reply_token"] = json!(token);
        }
    }
    attach_workspace_path(&mut body, workspace, args, scope);
    Ok(body)
}

fn normalize_delivery(args: &Value) -> Result<Option<Value>, String> {
    let Some(delivery) = args.get("delivery") else {
        return Ok(None);
    };
    if delivery.is_null() {
        return Ok(None);
    }
    let Some(obj) = delivery.as_object() else {
        return Err("delivery must be an object".to_string());
    };
    let mode = obj
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("announce");
    if mode == "none" {
        return Ok(Some(delivery.clone()));
    }

    let mut out = obj.clone();
    let mut to = out
        .get("to")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if to.is_empty() {
        if let Some(token) = args
            .get("reply_token")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            to = token.to_string();
        }
    }
    if to.is_empty() {
        return Err(
            "delivery.to is required for announce. An empty value is not this chat. \
             For the current conversation, set delivery.to to this run's reply_token \
             (from the prompt); it is stored as a stable chat id. \
             WeCom also accepts single:<userid> or group:<chatid>."
                .to_string(),
        );
    }
    out.insert("to".into(), json!(to));
    Ok(Some(Value::Object(out)))
}

fn job_action_body(workspace: &str, args: &Value, action: &str) -> Result<Value, String> {
    let scope = parse_scope(args)?;
    let mut body = json!({
        "action": action,
        "scope": scope,
    });
    if action != "list" {
        body["job_id"] = json!(require_job_id(args)?);
    }
    attach_workspace_path(&mut body, workspace, args, scope);
    Ok(body)
}

fn parse_scope(args: &Value) -> Result<&'static str, String> {
    match args
        .get("scope")
        .and_then(|v| v.as_str())
        .unwrap_or("global")
    {
        "global" => Ok("global"),
        "workspace" => Ok("workspace"),
        other => Err(format!(
            "scope must be 'global' or 'workspace', got {other}"
        )),
    }
}

fn attach_workspace_path(body: &mut Value, workspace: &str, args: &Value, scope: &str) {
    if scope != "workspace" {
        return;
    }
    let path = args
        .get("workspace_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(workspace);
    body["workspace_path"] = json!(resolve_workspace_root(path));
}

/// Map a runtime cwd (often `{repo}/.worktrees/<id>`) back to the workspace root
/// the desktop cron UI actually lists.
fn resolve_workspace_root(path: &str) -> String {
    let path = std::path::Path::new(path);
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut parts: Vec<_> = abs.iter().map(|s| s.to_os_string()).collect();
    if let Some(idx) = parts.iter().position(|c| c == ".worktrees") {
        parts.truncate(idx);
        return std::path::PathBuf::from_iter(parts)
            .to_string_lossy()
            .into_owned();
    }
    abs.to_string_lossy().into_owned()
}

fn sanitize_manage_response(mut resp: Value) -> Value {
    if let Some(job) = resp.get("job").cloned() {
        resp["job"] = safe_job_summary(&job);
    }
    if let Some(jobs) = resp.get("jobs").and_then(|v| v.as_array()).cloned() {
        resp["jobs"] = Value::Array(jobs.into_iter().map(|j| safe_job_summary(&j)).collect());
    }
    resp
}

fn normalize_schedule(schedule: &Value) -> Result<Value, String> {
    if let Some(raw) = schedule.as_str() {
        return normalize_schedule_string(raw);
    }

    let Some(schedule_obj) = schedule.as_object() else {
        return Err(
            "schedule must be a cron expression string, ISO-8601 timestamp, or schedule object"
                .to_string(),
        );
    };

    normalize_schedule_object(schedule_obj)
}

fn normalize_schedule_string(raw: &str) -> Result<Value, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("schedule cannot be empty".to_string());
    }

    // Tool schema is string | object, so models often stringify the object.
    // Parse that JSON instead of stuffing it into `expr` as a cron string.
    if raw.starts_with('{') {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            if parsed.is_object() {
                return normalize_schedule(&parsed);
            }
        }
    }

    if chrono::DateTime::parse_from_rfc3339(raw).is_ok() {
        return Ok(json!({ "kind": "at", "at": raw }));
    }

    Ok(json!({ "kind": "cron", "expr": raw }))
}

fn normalize_schedule_object(
    schedule_obj: &serde_json::Map<String, Value>,
) -> Result<Value, String> {
    let mut out = schedule_obj.clone();
    if let Some(every_ms) = out.remove("every_ms") {
        out.entry("everyMs".to_string()).or_insert(every_ms);
    }

    let kind = out
        .get("kind")
        .and_then(|v| v.as_str())
        .map(normalize_schedule_kind);

    match kind.as_deref() {
        Some(k @ ("at" | "every" | "cron")) => {
            // `{kind:"cron", expr:"{\"kind\":\"at\",...}"}` is the same LLM
            // mix-up one layer deeper — unwrap instead of storing JSON as expr.
            if k == "cron" {
                if let Some(expr) = out.get("expr").and_then(|v| v.as_str()) {
                    let expr = expr.trim();
                    if expr.starts_with('{') {
                        if let Ok(parsed) = serde_json::from_str::<Value>(expr) {
                            if parsed.is_object() {
                                return normalize_schedule(&parsed);
                            }
                        }
                    }
                }
            }
            out.insert("kind".into(), json!(k));
            Ok(Value::Object(out))
        }
        Some(other) => Err(format!(
            "schedule.kind must be one of: at, every, cron, got {other}"
        )),
        None => {
            if out.get("at").and_then(|v| v.as_str()).is_some() {
                out.insert("kind".into(), json!("at"));
                return Ok(Value::Object(out));
            }
            if out.get("everyMs").is_some() {
                out.insert("kind".into(), json!("every"));
                return Ok(Value::Object(out));
            }
            if out.get("expr").and_then(|v| v.as_str()).is_some() {
                out.insert("kind".into(), json!("cron"));
                return Ok(Value::Object(out));
            }
            Err("schedule.kind must be one of: at, every, cron".to_string())
        }
    }
}

fn normalize_schedule_kind(kind: &str) -> String {
    match kind.trim().to_ascii_lowercase().as_str() {
        "once" | "one-time" | "onetime" | "at" => "at".to_string(),
        other => other.to_string(),
    }
}

fn require_job_id(args: &Value) -> Result<&str, String> {
    args.get("job_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Missing required parameter: job_id".to_string())
}

/// Return safe summary fields for a job (no payload details).
fn safe_job_summary(job: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for field in &[
        "id",
        "name",
        "description",
        "enabled",
        "schedule",
        "delivery",
        "createdAt",
        "updatedAt",
        "lastRunAt",
        "nextRunAt",
    ] {
        if let Some(v) = job.get(*field) {
            // Normalize camelCase → snake_case for output
            let key = match *field {
                "createdAt" => "created_at",
                "updatedAt" => "updated_at",
                "lastRunAt" => "last_run_at",
                "nextRunAt" => "next_run_at",
                other => other,
            };
            out.insert(key.to_string(), v.clone());
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_workspace() -> PathBuf {
        std::env::temp_dir().join(format!("teamclu-introspect-cron-{}", Uuid::new_v4()))
    }

    #[test]
    fn create_body_defaults_to_global_scope_and_normalizes_cron_expr() {
        let body = create_request_body(
            "/tmp/ws",
            &json!({
                "name": "Morning summary",
                "schedule": "0 9 * * *",
                "message": "Summarize yesterday's work"
            }),
        )
        .unwrap();

        assert_eq!(body["action"], "create");
        assert_eq!(body["scope"], "global");
        assert_eq!(body["name"], "Morning summary");
        assert_eq!(
            body["schedule"],
            json!({ "kind": "cron", "expr": "0 9 * * *" })
        );
        assert_eq!(body["payload"]["message"], "Summarize yesterday's work");
        assert_eq!(body["enabled"], true);
        assert!(body.get("workspace_path").is_none());
    }

    /// Models often stringify the schedule object because the tool schema
    /// allows string | object. That JSON must become a one-time job, not a
    /// cron expression whose `expr` is the raw JSON (which is what the
    /// settings dialog then shows as "Cron 表达式").
    #[test]
    fn stringified_at_schedule_becomes_one_time_not_cron_expr() {
        let body = create_request_body(
            "/tmp/ws",
            &json!({
                "name": "One-shot ping",
                "schedule": "{\"kind\": \"at\", \"at\": \"2026-09-09T20:10:30+08:00\"}",
                "message": "ping"
            }),
        )
        .unwrap();

        assert_eq!(body["schedule"]["kind"], "at");
        assert_eq!(body["schedule"]["at"], "2026-09-09T20:10:30+08:00");
        assert!(body["schedule"].get("expr").is_none());
    }

    #[test]
    fn iso_timestamp_schedule_becomes_one_time() {
        let body = create_request_body(
            "/tmp/ws",
            &json!({
                "name": "One-shot ping",
                "schedule": "2026-09-09T20:10:30+08:00",
                "message": "ping"
            }),
        )
        .unwrap();

        assert_eq!(
            body["schedule"],
            json!({ "kind": "at", "at": "2026-09-09T20:10:30+08:00" })
        );
    }

    #[test]
    fn at_object_schedule_is_preserved() {
        let body = create_request_body(
            "/tmp/ws",
            &json!({
                "name": "One-shot ping",
                "schedule": { "kind": "at", "at": "2026-09-09T20:10:30+08:00" },
                "message": "ping"
            }),
        )
        .unwrap();

        assert_eq!(body["schedule"]["kind"], "at");
        assert_eq!(body["schedule"]["at"], "2026-09-09T20:10:30+08:00");
    }

    #[test]
    fn once_kind_alias_becomes_at() {
        let body = create_request_body(
            "/tmp/ws",
            &json!({
                "name": "One-shot ping",
                "schedule": { "kind": "once", "at": "2026-09-09T20:10:30+08:00" },
                "message": "ping"
            }),
        )
        .unwrap();

        assert_eq!(body["schedule"]["kind"], "at");
        assert_eq!(body["schedule"]["at"], "2026-09-09T20:10:30+08:00");
    }

    #[test]
    fn cron_object_whose_expr_is_stringified_at_becomes_one_time() {
        let body = create_request_body(
            "/tmp/ws",
            &json!({
                "name": "One-shot ping",
                "schedule": {
                    "kind": "cron",
                    "expr": "{\"kind\": \"at\", \"at\": \"2026-09-09T20:10:30+08:00\"}"
                },
                "message": "ping"
            }),
        )
        .unwrap();

        assert_eq!(body["schedule"]["kind"], "at");
        assert_eq!(body["schedule"]["at"], "2026-09-09T20:10:30+08:00");
        assert!(body["schedule"].get("expr").is_none());
    }

    #[test]
    fn resolve_workspace_root_strips_git_worktree() {
        let input = std::path::PathBuf::from("/repo")
            .join(".worktrees")
            .join("cron-j1-r1");
        let got = std::path::PathBuf::from(resolve_workspace_root(&input.to_string_lossy()));
        assert_eq!(got, std::path::PathBuf::from("/repo"));
    }

    /// Regression: MCP used to write `{cwd}/.teamclu/cron-jobs.json` and report
    /// success. The settings list reads the desktop cron store (global by
    /// default), so those jobs never appeared. Create must go through the
    /// desktop API instead of a sidecar-local file.
    #[tokio::test]
    async fn create_does_not_write_a_workspace_file_the_ui_never_reads() {
        let workspace = temp_workspace();
        std::fs::create_dir_all(&workspace).unwrap();

        let result = handle(
            workspace.to_str().unwrap(),
            9, // nothing listens here; the point is we must not succeed locally
            &json!({
                "action": "create",
                "name": "Morning summary",
                "schedule": "0 9 * * *",
                "message": "Summarize yesterday's work"
            }),
        )
        .await;

        assert!(
            result.is_err(),
            "create must go through the desktop API, got {result:?}"
        );
        assert!(
            !workspace.join(".teamclu/cron-jobs.json").exists(),
            "MCP must not stash jobs in the agent cwd"
        );

        let _ = std::fs::remove_dir_all(workspace);
    }

    #[test]
    fn announce_delivery_rejects_empty_to() {
        let err = create_request_body(
            "/tmp/ws",
            &json!({
                "name": "日报",
                "schedule": "0 10 * * *",
                "message": "写日报",
                "delivery": { "mode": "announce", "channel": "wecom", "to": "" }
            }),
        )
        .unwrap_err();
        assert!(err.contains("delivery.to is required"), "got: {err}");
        assert!(err.contains("reply_token"), "got: {err}");
    }

    #[test]
    fn announce_delivery_fills_empty_to_from_reply_token() {
        let token = "0c2a4f9d1ed3c8e310824f6dcf60ff8d";
        let body = create_request_body(
            "/tmp/ws",
            &json!({
                "name": "日报",
                "schedule": "0 10 * * *",
                "message": "写日报",
                "reply_token": token,
                "delivery": { "mode": "announce", "channel": "wecom", "to": "" }
            }),
        )
        .unwrap();
        assert_eq!(body["delivery"]["to"], token);
        assert_eq!(body["reply_token"], token);
    }

    #[test]
    fn safe_job_summary_echoes_delivery() {
        let summary = safe_job_summary(&json!({
            "id": "j1",
            "name": "日报",
            "schedule": { "kind": "cron", "expr": "0 10 * * *" },
            "delivery": { "mode": "announce", "channel": "wecom", "to": "single:HuangWeiGan" }
        }));
        assert_eq!(
            summary["delivery"],
            json!({ "mode": "announce", "channel": "wecom", "to": "single:HuangWeiGan" })
        );
    }
}
