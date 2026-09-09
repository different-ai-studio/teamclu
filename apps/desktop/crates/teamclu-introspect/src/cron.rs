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
    if let Some(d) = args.get("delivery") {
        if !d.is_null() {
            body["delivery"] = d.clone();
        }
    }
    attach_workspace_path(&mut body, workspace, args, scope);
    Ok(body)
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
    match args.get("scope").and_then(|v| v.as_str()).unwrap_or("global") {
        "global" => Ok("global"),
        "workspace" => Ok("workspace"),
        other => Err(format!("scope must be 'global' or 'workspace', got {other}")),
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
    if let Some(expr) = schedule.as_str() {
        let expr = expr.trim();
        if expr.is_empty() {
            return Err("schedule cron expression cannot be empty".to_string());
        }
        return Ok(json!({ "kind": "cron", "expr": expr }));
    }

    let Some(schedule_obj) = schedule.as_object() else {
        return Err("schedule must be a cron expression string or schedule object".to_string());
    };

    if !matches!(
        schedule_obj.get("kind").and_then(|v| v.as_str()),
        Some("at" | "every" | "cron")
    ) {
        return Err("schedule.kind must be one of: at, every, cron".to_string());
    }

    Ok(Value::Object(schedule_obj.clone()))
}

fn require_job_id<'a>(args: &'a Value) -> Result<&'a str, String> {
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
}
