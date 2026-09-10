//! The management tabs that are plain Cloud API resources under one app:
//! 协作权限 (`manage_app_access`), 变量与密钥 (`manage_app_env`), 定时任务
//! (`manage_app_cron`) and 自定义域名 (`manage_app_domain`).
//!
//! Each handler resolves the app the same way `manage_app` does, then does one
//! thing to one resource. Permission tiers are the server's to enforce and are
//! only named here, in the "what was being done" of each failure, so a 404 the
//! API returns for "not allowed" reads as the permission it probably is.

use std::time::Duration;

use reqwest::Method;
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use super::{
    app_path, explain, notify_app_changed, parse_body, require_action, resolve_app_row, row_id,
    row_str, u64_body_field, AppApi,
};
use crate::commands::introspect_api::{items_of, str_body_field};

/// Exactly one of `candidates` whose `name` equals `wanted`, ignoring case.
///
/// The rule every name-addressed write in these tools follows: granting the
/// wrong person access, or deleting the wrong job, is not worth a fuzzy match,
/// so none or several matches come back as the list to pick an id from.
fn pick_by_name<'a>(
    candidates: &'a [(String, String)],
    wanted: &str,
    what: &str,
    id_field: &str,
) -> Result<&'a (String, String), String> {
    let lower = wanted.trim().to_lowercase();
    let matches: Vec<&(String, String)> = candidates
        .iter()
        .filter(|(_, name)| name.trim().to_lowercase() == lower)
        .collect();
    let listing = |rows: &[&(String, String)]| {
        Value::Array(
            rows.iter()
                .map(|(id, name)| json!({ id_field: id, "name": name }))
                .collect(),
        )
    };
    match matches.len() {
        1 => Ok(matches[0]),
        0 => Err(format!(
            "No {what} named {wanted:?}. Candidates: {}",
            listing(&candidates.iter().collect::<Vec<_>>())
        )),
        n => Err(format!(
            "{wanted:?} matches {n} {what}s — pass {id_field} instead. Matches: {}",
            listing(&matches)
        )),
    }
}

// ─── 协作权限 ────────────────────────────────────────────────────────────────

const ACCESS_ACTIONS: [&str; 3] = ["list", "grant", "revoke"];
const PERMISSION_LEVELS: [&str; 3] = ["view", "prompt", "admin"];

/// The team's human members as `(member actor id, display name)` — the ids
/// `app_member_access` is keyed on, and the list the access tab picks from.
async fn team_members(api: &AppApi, team_id: &str) -> Result<Vec<(String, String)>, String> {
    let page = api
        .get(
            &format!(
                "/v1/teams/{}/actors?kind=member&limit=500",
                urlencoding::encode(team_id)
            ),
            "Listing the team's members",
        )
        .await?;
    Ok(items_of(&page)
        .iter()
        .filter_map(|row| {
            let id = row_str(row, "id")?;
            let name = row_str(row, "displayName").unwrap_or(id);
            Some((id.to_string(), name.to_string()))
        })
        .collect())
}

/// `member_id`, or the one member whose name is `member_name`.
///
/// An id is taken as given even when it is not in the member list: a grant can
/// outlive the member's place on the team, and revoking it is exactly what
/// someone cleaning up would want to do.
fn resolve_member(members: &[(String, String)], v: &Value) -> Result<(String, String), String> {
    if let Some(id) = str_body_field(v, "member_id", "memberId") {
        let name = members
            .iter()
            .find(|(member_id, _)| *member_id == id)
            .map(|(_, name)| name.clone())
            .unwrap_or_else(|| id.clone());
        return Ok((id, name));
    }
    let wanted = str_body_field(v, "member_name", "memberName")
        .ok_or("pass member_id or member_name — action \"list\" shows the candidates")?;
    pick_by_name(members, &wanted, "team member", "member_id").cloned()
}

/// `manage_app_access` — who on the team may work on this app.
///
/// Not the site's login wall (that is `manage_app` `update` with the `auth_*`
/// fields): this is `app_member_access`, which decides who sees the app, works
/// on its code, and deploys it.
pub(crate) async fn handle_app_access(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v = parse_body(body)?;
    let action = require_action(&v, &ACCESS_ACTIONS)?;
    let api = AppApi::for_tool(app, &v, "manage_app_access").await?;
    let row = resolve_app_row(app, &api, &v).await?;
    let app_id = row_id(&row)?;
    let team_id = row_str(&row, "teamId").ok_or("app row has no team")?;
    let members = team_members(&api, team_id).await?;
    let name_of = |id: &str| {
        members
            .iter()
            .find(|(member_id, _)| member_id == id)
            .map(|(_, name)| name.clone())
    };
    let creator = row_str(&row, "createdByActorId").unwrap_or_default();

    let out = match action.as_str() {
        "list" => {
            let grants = api
                .get(
                    &app_path(&app_id, "/access"),
                    "Reading the app's collaborators (needs admin on it)",
                )
                .await?;
            let grants = items_of(&grants);
            let rows: Vec<Value> = grants
                .iter()
                .map(|g| {
                    let id = row_str(g, "memberId").unwrap_or_default();
                    let granted_by = row_str(g, "grantedByMemberId");
                    json!({
                        "member_id": id,
                        "name": name_of(id),
                        "permission": g.get("permissionLevel"),
                        "granted_by": granted_by.map(|by| name_of(by).unwrap_or_else(|| by.to_string())),
                    })
                })
                .collect();
            let candidates: Vec<Value> = members
                .iter()
                .filter(|(id, _)| {
                    id != creator
                        && !grants
                            .iter()
                            .any(|g| row_str(g, "memberId") == Some(id.as_str()))
                })
                .map(|(id, name)| json!({ "member_id": id, "name": name }))
                .collect();
            json!({
                "action": "list",
                "app_id": app_id,
                // Never in the grant table: the creator is admin by being the
                // creator, and cannot be downgraded or revoked here.
                "creator": { "member_id": creator, "name": name_of(creator) },
                "grants": rows,
                "candidates": candidates,
            })
        }
        "grant" => {
            let level = str_body_field(&v, "permission", "permissionLevel")
                .filter(|l| PERMISSION_LEVELS.contains(&l.as_str()))
                .ok_or("grant needs `permission`: view, prompt or admin")?;
            let (member_id, name) = resolve_member(&members, &v)?;
            if member_id == creator {
                return Err(format!(
                    "{name} created this app and is always admin on it; there is nothing to grant."
                ));
            }
            let saved = api
                .put(
                    &app_path(
                        &app_id,
                        &format!("/access/{}", urlencoding::encode(&member_id)),
                    ),
                    &json!({ "permissionLevel": level }),
                    "Granting access (needs admin on the app)",
                )
                .await?;
            notify_app_changed(app, &row);
            json!({
                "ok": true,
                "action": "grant",
                "app_id": app_id,
                "grant": {
                    "member_id": member_id,
                    "name": name,
                    "permission": saved.get("permissionLevel").cloned().unwrap_or(json!(level)),
                },
            })
        }
        "revoke" => {
            let (member_id, name) = resolve_member(&members, &v)?;
            api.delete(
                &app_path(
                    &app_id,
                    &format!("/access/{}", urlencoding::encode(&member_id)),
                ),
                "Revoking access (needs admin on the app)",
            )
            .await?;
            notify_app_changed(app, &row);
            json!({
                "ok": true,
                "action": "revoke",
                "app_id": app_id,
                "member_id": member_id,
                "name": name,
            })
        }
        other => return Err(format!("Unknown action: {other}")),
    };
    Ok(out.to_string())
}

// ─── 变量与密钥 ──────────────────────────────────────────────────────────────

const ENV_ACTIONS: [&str; 3] = ["list", "set", "delete"];

const ENV_NOT_LIVE: &str =
    "Not live yet: the environment is baked into the function, so the app sees this on its next deploy (manage_app action \"deploy\").";

fn env_var_view(var: &Value) -> Value {
    json!({
        "key": var.get("key"),
        "is_secret": var.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
        // Null for a secret, for everyone — including whoever set it.
        "value": var.get("value"),
        "updated_at": var.get("updatedAt"),
    })
}

/// A variable's value as the API wants it: a string, possibly empty. A number
/// or boolean is written the way it would be exported in a shell.
fn env_value(v: &Value) -> Result<String, String> {
    match v.get("value") {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(Value::Number(n)) => Ok(n.to_string()),
        Some(Value::Bool(b)) => Ok(b.to_string()),
        _ => Err("set needs `value` — a string; an empty string is allowed".to_string()),
    }
}

/// `manage_app_env` — the operator's own environment for the deployed app.
pub(crate) async fn handle_app_env(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v = parse_body(body)?;
    let action = require_action(&v, &ENV_ACTIONS)?;
    let key = str_body_field(&v, "key", "key");
    if action != "list" && key.is_none() {
        return Err(format!("{action} needs `key` — the variable name"));
    }
    let value = if action == "set" {
        Some(env_value(&v)?)
    } else {
        None
    };
    let api = AppApi::for_tool(app, &v, "manage_app_env").await?;
    let row = resolve_app_row(app, &api, &v).await?;
    let app_id = row_id(&row)?;

    let out = match action.as_str() {
        "list" => {
            let listing = api
                .get(
                    &app_path(&app_id, "/env"),
                    "Reading the app's environment (needs prompt on it)",
                )
                .await?;
            json!({
                "action": "list",
                "app_id": app_id,
                "can_write": listing.get("canWrite").and_then(Value::as_bool).unwrap_or(false),
                "pending_redeploy": row.get("envPendingRedeploy").and_then(Value::as_bool).unwrap_or(false),
                "variables": items_of(&listing).iter().map(env_var_view).collect::<Vec<_>>(),
            })
        }
        "set" => {
            let key = key.unwrap_or_default();
            let is_secret = v
                .get("is_secret")
                .or_else(|| v.get("isSecret"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let saved = api
                .put(
                    &app_path(&app_id, &format!("/env/{}", urlencoding::encode(&key))),
                    &json!({ "value": value.unwrap_or_default(), "isSecret": is_secret }),
                    "Setting the variable (needs admin on the app)",
                )
                .await?;
            notify_app_changed(app, &row);
            json!({
                "ok": true,
                "action": "set",
                "app_id": app_id,
                "variable": env_var_view(&saved),
                "note": ENV_NOT_LIVE,
            })
        }
        "delete" => {
            let key = key.unwrap_or_default();
            api.delete(
                &app_path(&app_id, &format!("/env/{}", urlencoding::encode(&key))),
                "Deleting the variable (needs admin on the app)",
            )
            .await?;
            notify_app_changed(app, &row);
            json!({
                "ok": true,
                "action": "delete",
                "app_id": app_id,
                "key": key,
                "note": ENV_NOT_LIVE,
            })
        }
        other => return Err(format!("Unknown action: {other}")),
    };
    Ok(out.to_string())
}

// ─── 定时任务 ────────────────────────────────────────────────────────────────

const CRON_ACTIONS: [&str; 6] = ["list", "create", "update", "delete", "run", "runs"];

fn cron_job_view(job: &Value) -> Value {
    json!({
        "id": job.get("id"),
        "name": job.get("name"),
        "enabled": job.get("enabled"),
        "schedule": job.get("schedule"),
        "timezone": job.get("timezone"),
        "method": job.get("method"),
        "path": job.get("path"),
        "headers": job.get("headers"),
        "body": job.get("body"),
        "timeout_ms": job.get("timeoutMs"),
        "last_run_at": job.get("lastRunAt"),
        "next_run_at": job.get("nextRunAt"),
    })
}

fn cron_run_view(run: &Value) -> Value {
    json!({
        "id": run.get("id"),
        "started_at": run.get("startedAt"),
        "finished_at": run.get("finishedAt"),
        "status": run.get("status"),
        "response_status": run.get("responseStatus"),
        "duration_ms": run.get("durationMs"),
        "error": run.get("error"),
    })
}

/// The job fields a create or update carries, in the API's names.
///
/// Only the fields that were passed: an update leaves the rest as they were,
/// which is what the endpoint does with an absent field.
fn cron_fields(v: &Value) -> Result<Value, String> {
    let mut out = Map::new();
    for key in ["name", "schedule", "timezone", "method", "path"] {
        if let Some(value) = str_body_field(v, key, key) {
            out.insert(key.to_string(), json!(value));
        }
    }
    if let Some(headers) = v.get("headers").filter(|h| !h.is_null()) {
        let map = headers
            .as_object()
            .ok_or("headers must be an object of header name → string value")?;
        if map.values().any(|value| !value.is_string()) {
            return Err("every header value must be a string".to_string());
        }
        out.insert("headers".to_string(), headers.clone());
    }
    match v.get("body") {
        None => {}
        Some(Value::Null) => {
            out.insert("body".to_string(), Value::Null);
        }
        Some(Value::String(s)) => {
            out.insert("body".to_string(), json!(s));
        }
        // An object is what an agent reaches for when it means a JSON body.
        Some(other) => {
            out.insert("body".to_string(), json!(other.to_string()));
        }
    }
    if let Some(ms) = u64_body_field(v, "timeout_ms", "timeoutMs") {
        out.insert("timeoutMs".to_string(), json!(ms));
    }
    if let Some(enabled) = v.get("enabled").and_then(Value::as_bool) {
        out.insert("enabled".to_string(), json!(enabled));
    }
    Ok(Value::Object(out))
}

/// The job `job_id` names, or the one whose name is `job_name`.
async fn resolve_cron_job(
    api: &AppApi,
    app_id: &str,
    v: &Value,
) -> Result<(String, Value), String> {
    let listing = api
        .get(
            &app_path(app_id, "/cron-jobs"),
            "Listing the app's scheduled tasks",
        )
        .await?;
    let jobs = items_of(&listing);
    if let Some(id) = str_body_field(v, "job_id", "jobId") {
        let job = jobs
            .iter()
            .find(|j| row_str(j, "id") == Some(id.as_str()))
            .cloned()
            .unwrap_or(Value::Null);
        return Ok((id, job));
    }
    let wanted = str_body_field(v, "job_name", "jobName")
        .ok_or("pass job_id or job_name — action \"list\" shows the app's tasks")?;
    let named: Vec<(String, String)> = jobs
        .iter()
        .filter_map(|j| {
            Some((
                row_str(j, "id")?.to_string(),
                row_str(j, "name")?.to_string(),
            ))
        })
        .collect();
    let (id, _) = pick_by_name(&named, &wanted, "scheduled task", "job_id")?;
    let job = jobs
        .iter()
        .find(|j| row_str(j, "id") == Some(id.as_str()))
        .cloned()
        .unwrap_or(Value::Null);
    Ok((id.clone(), job))
}

/// `manage_app_cron` — the app's cloud-side schedule: at each due minute, one
/// HTTP request to the app's own public URL.
pub(crate) async fn handle_app_cron(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v = parse_body(body)?;
    let action = require_action(&v, &CRON_ACTIONS)?;
    let fields = cron_fields(&v)?;
    match action.as_str() {
        "create" if fields.get("name").is_none() || fields.get("schedule").is_none() => {
            return Err(
                "create needs `name` and `schedule` (five cron fields: minute hour day-of-month month day-of-week)"
                    .to_string(),
            );
        }
        "update" if fields.as_object().is_some_and(Map::is_empty) => {
            return Err(
                "update needs at least one field to change: name, schedule, timezone, method, path, headers, body, timeout_ms, enabled"
                    .to_string(),
            );
        }
        _ => {}
    }
    let api = AppApi::for_tool(app, &v, "manage_app_cron").await?;
    let row = resolve_app_row(app, &api, &v).await?;
    let app_id = row_id(&row)?;

    let out = match action.as_str() {
        "list" => {
            let listing = api
                .get(
                    &app_path(&app_id, "/cron-jobs"),
                    "Listing the app's scheduled tasks",
                )
                .await?;
            json!({
                "action": "list",
                "app_id": app_id,
                "jobs": items_of(&listing).iter().map(cron_job_view).collect::<Vec<_>>(),
            })
        }
        "create" => {
            let job = api
                .post(
                    &app_path(&app_id, "/cron-jobs"),
                    &fields,
                    "Creating the scheduled task (needs admin on the app)",
                )
                .await?;
            notify_app_changed(app, &row);
            json!({ "ok": true, "action": "create", "app_id": app_id, "job": cron_job_view(&job) })
        }
        "update" => {
            let (job_id, _) = resolve_cron_job(&api, &app_id, &v).await?;
            let job = api
                .patch(
                    &app_path(
                        &app_id,
                        &format!("/cron-jobs/{}", urlencoding::encode(&job_id)),
                    ),
                    &fields,
                    "Updating the scheduled task (needs admin on the app)",
                )
                .await?;
            notify_app_changed(app, &row);
            json!({ "ok": true, "action": "update", "app_id": app_id, "job": cron_job_view(&job) })
        }
        "delete" => {
            let (job_id, job) = resolve_cron_job(&api, &app_id, &v).await?;
            api.delete(
                &app_path(
                    &app_id,
                    &format!("/cron-jobs/{}", urlencoding::encode(&job_id)),
                ),
                "Deleting the scheduled task (needs admin on the app)",
            )
            .await?;
            notify_app_changed(app, &row);
            json!({
                "ok": true,
                "action": "delete",
                "app_id": app_id,
                "job_id": job_id,
                "name": job.get("name"),
            })
        }
        "run" => {
            let (job_id, _) = resolve_cron_job(&api, &app_id, &v).await?;
            // The task's own timeout goes up to 60 s, and the endpoint answers
            // only once the request it sends has.
            let outcome = api
                .call(
                    Method::POST,
                    &app_path(
                        &app_id,
                        &format!("/cron-jobs/{}/run", urlencoding::encode(&job_id)),
                    ),
                    Some(&json!({})),
                    Some(Duration::from_secs(90)),
                    "Running the scheduled task now (needs admin on the app)",
                )
                .await?;
            json!({
                "ok": true,
                "action": "run",
                "app_id": app_id,
                "job_id": job_id,
                // A non-2xx from the app is still a successful call here, with
                // status "failed" — that is the answer the agent came for.
                "outcome": {
                    "status": outcome.get("status"),
                    "response_status": outcome.get("responseStatus"),
                    "error": outcome.get("error"),
                },
                "note": "Running now does not move the schedule; next_run_at is unchanged.",
            })
        }
        "runs" => {
            let (job_id, _) = resolve_cron_job(&api, &app_id, &v).await?;
            let limit = u64_body_field(&v, "limit", "limit")
                .unwrap_or(20)
                .clamp(1, 100);
            let listing = api
                .get(
                    &app_path(
                        &app_id,
                        &format!(
                            "/cron-jobs/{}/runs?limit={limit}",
                            urlencoding::encode(&job_id)
                        ),
                    ),
                    "Reading the task's run history",
                )
                .await?;
            json!({
                "action": "runs",
                "app_id": app_id,
                "job_id": job_id,
                "runs": items_of(&listing).iter().map(cron_run_view).collect::<Vec<_>>(),
            })
        }
        other => return Err(format!("Unknown action: {other}")),
    };
    Ok(out.to_string())
}

// ─── 自定义域名 ──────────────────────────────────────────────────────────────

const DOMAIN_ACTIONS: [&str; 4] = ["get", "set", "verify", "remove"];

fn domain_view(domain: &Value) -> Value {
    json!({
        "domain": domain.get("domain"),
        "verified": domain.get("verified").and_then(Value::as_bool).unwrap_or(false),
        "verified_at": domain.get("verifiedAt"),
        "dns": domain.get("dns").cloned().unwrap_or(json!([])),
    })
}

/// `manage_app_domain` — serve the app on a hostname its owner controls.
pub(crate) async fn handle_app_domain(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v = parse_body(body)?;
    let action = require_action(&v, &DOMAIN_ACTIONS)?;
    let domain = str_body_field(&v, "domain", "domain");
    if action == "set" && domain.is_none() {
        return Err("set needs `domain` — a hostname only, like app.example.com".to_string());
    }
    let api = AppApi::for_tool(app, &v, "manage_app_domain").await?;
    let row = resolve_app_row(app, &api, &v).await?;
    let app_id = row_id(&row)?;
    let path = app_path(&app_id, "/custom-domain");

    let out = match action.as_str() {
        "get" => {
            let bound = row_str(&row, "customDomain");
            let verified = row_str(&row, "customDomainVerifiedAt").is_some();
            // The TXT value embeds a token that is not on the app row, so the
            // records can only be re-read by binding the same name again —
            // which the server keeps idempotent for exactly this.
            let hint = (bound.is_some() && !verified).then_some(
                "Not served until verified. To see the DNS records again, call set with the same domain — it keeps the token and any verification.",
            );
            let url = super::app_brief(&row)["url"].clone();
            json!({
                "action": "get",
                "app_id": app_id,
                "domain": bound,
                "verified": verified,
                "verified_at": row.get("customDomainVerifiedAt"),
                "url": url,
                "hint": hint,
            })
        }
        "set" => {
            let saved = api
                .put(
                    &path,
                    &json!({ "domain": domain.unwrap_or_default() }),
                    "Binding the domain (needs admin on the app)",
                )
                .await?;
            notify_app_changed(app, &row);
            let mut out = domain_view(&saved);
            out["ok"] = json!(true);
            out["action"] = json!("set");
            out["app_id"] = json!(app_id);
            out["next"] = json!(
                "Publish these DNS records at the domain's DNS provider, then call verify. The domain is not served until verify succeeds."
            );
            out
        }
        "verify" => match api
            .send(
                Method::POST,
                &format!("{path}/verify"),
                Some(&json!({})),
                None,
            )
            .await
        {
            Ok(saved) => {
                notify_app_changed(app, &row);
                let mut out = domain_view(&saved);
                out["ok"] = json!(true);
                out["action"] = json!("verify");
                out["app_id"] = json!(app_id);
                out
            }
            // "The record is not visible yet" is the ordinary state while DNS
            // propagates. Reporting it as a failure would tell the agent
            // something is broken when the only thing to do is wait.
            Err(e) if e.status == 409 => json!({
                "ok": false,
                "action": "verify",
                "app_id": app_id,
                "verified": false,
                "message": e.message,
                "hint": "DNS changes can take a while to propagate; verify again later. set with the same domain shows the records to publish.",
            }),
            Err(e) => return Err(explain("Verifying the domain (needs admin on the app)", &e)),
        },
        "remove" => {
            api.delete(&path, "Unbinding the domain (needs admin on the app)")
                .await?;
            notify_app_changed(app, &row);
            json!({
                "ok": true,
                "action": "remove",
                "app_id": app_id,
                "note": "The app is still reachable on its own URL.",
            })
        }
        other => return Err(format!("Unknown action: {other}")),
    };
    Ok(out.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members() -> Vec<(String, String)> {
        vec![
            ("m-1".into(), "海港".into()),
            ("m-2".into(), "Wei Gan".into()),
            ("m-3".into(), "wei gan".into()),
        ]
    }

    #[test]
    fn a_member_is_named_by_id_even_after_leaving_the_team() {
        let (id, name) = resolve_member(&members(), &json!({ "member_id": "m-9" })).unwrap();
        assert_eq!((id.as_str(), name.as_str()), ("m-9", "m-9"));
        let (_, name) = resolve_member(&members(), &json!({ "member_id": "m-1" })).unwrap();
        assert_eq!(name, "海港");
    }

    #[test]
    fn a_member_name_must_match_exactly_one_person() {
        let (id, _) = resolve_member(&members(), &json!({ "member_name": "海港" })).unwrap();
        assert_eq!(id, "m-1");

        // Case-insensitive, so two people differing only in case are two
        // matches — and granting access is not worth guessing between them.
        let err = resolve_member(&members(), &json!({ "member_name": "WEI GAN" })).unwrap_err();
        assert!(
            err.contains("matches 2") && err.contains("member_id"),
            "{err}"
        );

        let err = resolve_member(&members(), &json!({ "member_name": "nobody" })).unwrap_err();
        assert!(err.contains("Candidates") && err.contains("m-2"), "{err}");

        assert!(resolve_member(&members(), &json!({})).is_err());
    }

    #[test]
    fn env_values_are_strings_and_empty_is_allowed() {
        assert_eq!(env_value(&json!({ "value": "" })).unwrap(), "");
        assert_eq!(env_value(&json!({ "value": 3000 })).unwrap(), "3000");
        assert_eq!(env_value(&json!({ "value": true })).unwrap(), "true");
        assert!(env_value(&json!({})).is_err());
        assert!(env_value(&json!({ "value": { "a": 1 } })).is_err());
    }

    #[test]
    fn cron_fields_carry_only_what_was_passed_in_the_api_s_names() {
        let fields = cron_fields(&json!({
            "name": "对账",
            "schedule": "0 9 * * 1-5",
            "timezone": "Asia/Shanghai",
            "timeout_ms": 45000,
            "enabled": false,
            "headers": { "x-cron-secret": "s" },
        }))
        .unwrap();
        assert_eq!(
            fields,
            json!({
                "name": "对账",
                "schedule": "0 9 * * 1-5",
                "timezone": "Asia/Shanghai",
                "timeoutMs": 45000,
                "enabled": false,
                "headers": { "x-cron-secret": "s" },
            })
        );
        assert_eq!(
            cron_fields(&json!({ "action": "update" })).unwrap(),
            json!({})
        );
    }

    #[test]
    fn a_cron_body_is_always_sent_as_text() {
        let fields = cron_fields(&json!({ "body": { "kind": "daily" } })).unwrap();
        assert_eq!(fields["body"], json!(r#"{"kind":"daily"}"#));
        let fields = cron_fields(&json!({ "body": null })).unwrap();
        assert!(fields["body"].is_null());
    }

    #[test]
    fn cron_headers_must_be_string_values() {
        assert!(cron_fields(&json!({ "headers": { "x": 1 } })).is_err());
        assert!(cron_fields(&json!({ "headers": ["x"] })).is_err());
    }
}
