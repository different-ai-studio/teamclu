use chrono::Utc;
use serde_json::{json, Value};
use uuid::Uuid;

pub async fn handle(workspace: &str, api_port: u16, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: action".to_string())?;

    match action {
        "create" => action_create(workspace, arguments),
        "pause" => action_set_enabled(workspace, arguments, false),
        "resume" => action_set_enabled(workspace, arguments, true),
        "delete" => action_delete(workspace, arguments),
        "run" => action_run(workspace, api_port, arguments).await,
        "get_runs" => action_get_runs(workspace, arguments),
        other => Err(format!("Unknown action: {other}")),
    }
}

// ─── Create ───────────────────────────────────────────────────────────────────

fn action_create(workspace: &str, args: &Value) -> Result<Value, String> {
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

    let description = args.get("description");
    let delivery = args.get("delivery");

    let now = Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();

    let mut job = serde_json::Map::new();
    job.insert("id".to_string(), Value::String(id.clone()));
    job.insert("name".to_string(), Value::String(name.to_string()));

    if let Some(d) = description {
        if !d.is_null() {
            job.insert("description".to_string(), d.clone());
        }
    }

    job.insert("enabled".to_string(), Value::Bool(true));
    job.insert("schedule".to_string(), schedule);
    job.insert("payload".to_string(), json!({ "message": message }));

    if let Some(d) = delivery {
        if !d.is_null() {
            job.insert("delivery".to_string(), d.clone());
        }
    }

    job.insert("createdAt".to_string(), Value::String(now.clone()));
    job.insert("updatedAt".to_string(), Value::String(now));

    let new_job = Value::Object(job);

    // Read, append, write
    let mut jobs = read_jobs_array(workspace)?;
    jobs.push(new_job.clone());
    write_jobs_array(workspace, jobs)?;

    Ok(json!({
        "action": "created",
        "job": safe_job_summary(&new_job)
    }))
}

// ─── Pause / Resume ──────────────────────────────────────────────────────────

fn action_set_enabled(workspace: &str, args: &Value, enabled: bool) -> Result<Value, String> {
    let job_id = require_job_id(args)?;
    let now = Utc::now().to_rfc3339();

    let mut jobs = read_jobs_array(workspace)?;
    let mut found = false;

    for job in jobs.iter_mut() {
        if job_matches_id(job, job_id) {
            if let Value::Object(ref mut map) = job {
                map.insert("enabled".to_string(), Value::Bool(enabled));
                map.insert("updatedAt".to_string(), Value::String(now.clone()));
            }
            found = true;
            break;
        }
    }

    if !found {
        return Err(format!("Cron job not found: {job_id}"));
    }

    write_jobs_array(workspace, jobs)?;

    let action = if enabled { "resumed" } else { "paused" };
    Ok(json!({
        "action": action,
        "job_id": job_id
    }))
}

// ─── Delete ───────────────────────────────────────────────────────────────────

fn action_delete(workspace: &str, args: &Value) -> Result<Value, String> {
    let job_id = require_job_id(args)?;

    let jobs = read_jobs_array(workspace)?;
    let original_len = jobs.len();

    let updated: Vec<Value> = jobs
        .into_iter()
        .filter(|job| !job_matches_id(job, job_id))
        .collect();

    if updated.len() == original_len {
        return Err(format!("Cron job not found: {job_id}"));
    }

    write_jobs_array(workspace, updated)?;

    // Delete run history file if it exists
    let runs_dir = std::path::Path::new(workspace)
        .join(crate::config::TEAMCLU_DIR)
        .join("cron-runs");
    let history_file = runs_dir.join(format!("{job_id}.jsonl"));
    if history_file.exists() {
        let _ = std::fs::remove_file(&history_file);
    }

    Ok(json!({
        "action": "deleted",
        "job_id": job_id
    }))
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async fn action_run(workspace: &str, api_port: u16, args: &Value) -> Result<Value, String> {
    let job_id = require_job_id(args)?;

    // Verify the job exists
    let jobs = read_jobs_array(workspace)?;
    let job_exists = jobs.iter().any(|j| job_matches_id(j, job_id));
    if !job_exists {
        return Err(format!("Cron job not found: {job_id}"));
    }

    let resp = crate::desktop_api::send(api_port, "/cron-run", &json!({"job_id": job_id}))
        .await
        .map_err(|e| format!("Cron run request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Cron run failed ({status}): {text}"));
    }

    Ok(json!({
        "action": "triggered",
        "job_id": job_id
    }))
}

// ─── Get runs ────────────────────────────────────────────────────────────────

fn action_get_runs(workspace: &str, args: &Value) -> Result<Value, String> {
    let job_id = require_job_id(args)?;

    // Verify the job exists
    let jobs = read_jobs_array(workspace)?;
    let job_exists = jobs.iter().any(|j| job_matches_id(j, job_id));
    if !job_exists {
        return Err(format!("Cron job not found: {job_id}"));
    }

    let raw_runs = crate::config::read_cron_runs(workspace, job_id, 10)?;

    // Filter to safe fields only
    let safe_runs: Vec<Value> = raw_runs
        .iter()
        .map(|run| {
            let mut out = serde_json::Map::new();
            for field in &[
                "runId",
                "run_id",
                "jobId",
                "job_id",
                "startedAt",
                "started_at",
                "finishedAt",
                "finished_at",
                "status",
                "sessionId",
                "session_id",
                "responseSummary",
                "response_summary",
                "deliveryStatus",
                "delivery_status",
                "error",
            ] {
                if let Some(v) = run.get(*field) {
                    // Normalize to snake_case
                    let key = match *field {
                        "runId" => "run_id",
                        "jobId" => "job_id",
                        "startedAt" => "started_at",
                        "finishedAt" => "finished_at",
                        "sessionId" => "session_id",
                        "responseSummary" => "response_summary",
                        "deliveryStatus" => "delivery_status",
                        other => other,
                    };
                    out.insert(key.to_string(), v.clone());
                }
            }
            Value::Object(out)
        })
        .collect();

    Ok(json!({
        "job_id": job_id,
        "runs": safe_runs
    }))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn read_jobs_array(workspace: &str) -> Result<Vec<Value>, String> {
    let data = crate::config::read_cron_jobs(workspace)?;
    Ok(crate::config::cron_jobs_from_value(&data))
}

fn write_jobs_array(workspace: &str, jobs: Vec<Value>) -> Result<(), String> {
    crate::config::write_cron_jobs(workspace, &json!({ "jobs": jobs }))
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

fn job_matches_id(job: &Value, id: &str) -> bool {
    job.get("id")
        .and_then(|v| v.as_str())
        .map(|s| s == id)
        .unwrap_or(false)
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

    fn temp_workspace() -> PathBuf {
        std::env::temp_dir().join(format!("teamclu-introspect-cron-{}", Uuid::new_v4()))
    }

    #[tokio::test]
    async fn create_writes_native_cron_jobs_wrapper_for_cron_expression() {
        let workspace = temp_workspace();
        std::fs::create_dir_all(&workspace).unwrap();

        let result = handle(
            workspace.to_str().unwrap(),
            1420,
            &json!({
                "action": "create",
                "name": "Morning summary",
                "schedule": "0 9 * * *",
                "message": "Summarize yesterday's work"
            }),
        )
        .await
        .unwrap();

        assert_eq!(result["action"], "created");

        let raw = std::fs::read_to_string(workspace.join(".teamclu/cron-jobs.json")).unwrap();
        let data: Value = serde_json::from_str(&raw).unwrap();
        let jobs = data
            .get("jobs")
            .and_then(|v| v.as_array())
            .expect("cron jobs file should use the native { jobs: [...] } shape");

        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0]["name"], "Morning summary");
        assert_eq!(jobs[0]["enabled"], true);
        assert_eq!(
            jobs[0]["schedule"],
            json!({ "kind": "cron", "expr": "0 9 * * *" })
        );
        assert_eq!(
            jobs[0]["payload"],
            json!({ "message": "Summarize yesterday's work" })
        );

        let _ = std::fs::remove_dir_all(workspace);
    }
}
