//! The management tabs that are plain Cloud API resources under one app:
//! 协作权限 (`manage_app_access`), 变量与密钥 (`manage_app_env`), 定时任务
//! (`manage_app_cron`) and 自定义域名 (`manage_app_domain`).
//!
//! Each handler resolves the app the same way `manage_app` does, then does one
//! thing to one resource. Permission tiers are the server's to enforce and are
//! only named here, in the "what was being done" of each failure, so a 404 the
//! API returns for "not allowed" reads as the permission it probably is.

use serde_json::{json, Map, Value};
use tauri::AppHandle;
use teamclu_apps::{CronFields, Named};

use super::{
    app_ops, app_path, notify_app_changed, parse_body, require_action, resolve_app_row, row_id,
    row_str, u64_body_field, AppApi, DesktopHost,
};
use crate::commands::introspect_api::{confirm, items_of, str_body_field};

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
    teamclu_apps::pick_by_name(members, &wanted, "team member", "member_id")
        .cloned()
        .map_err(String::from)
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
            confirm::confirm_with_user(
                app,
                confirm::app_access_grant(
                    crate::commands::prefers_zh_locale(),
                    &row,
                    &name,
                    &level,
                ),
            )
            .await?;
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
            confirm::confirm_with_user(
                app,
                confirm::app_access_revoke(crate::commands::prefers_zh_locale(), &row, &name),
            )
            .await?;
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
/// The flows are `teamclu-apps` (`resources.rs`), shared with `amuxd app env`.
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
    let host = DesktopHost::new(app, &api);
    let ops = app_ops(&api, &host);
    let out = match action.as_str() {
        "list" => ops.env_list(&row).await?,
        "set" => {
            let is_secret = v
                .get("is_secret")
                .or_else(|| v.get("isSecret"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            ops.env_set(
                &row,
                &key.unwrap_or_default(),
                &value.unwrap_or_default(),
                is_secret,
            )
            .await?
        }
        "delete" => ops.env_delete(&row, &key.unwrap_or_default()).await?,
        other => return Err(format!("Unknown action: {other}")),
    };
    Ok(out.to_string())
}

// ─── 定时任务 ────────────────────────────────────────────────────────────────

const CRON_ACTIONS: [&str; 6] = ["list", "create", "update", "delete", "run", "runs"];

/// The job fields a create or update carries. Only the fields that were
/// passed: an update leaves the rest as they were.
fn cron_fields(v: &Value) -> CronFields {
    CronFields {
        name: str_body_field(v, "name", "name"),
        schedule: str_body_field(v, "schedule", "schedule"),
        timezone: str_body_field(v, "timezone", "timezone"),
        method: str_body_field(v, "method", "method"),
        path: str_body_field(v, "path", "path"),
        headers: v.get("headers").filter(|h| !h.is_null()).cloned(),
        body: match v.get("body") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(s)) => Some(Some(s.clone())),
            // An object is what an agent reaches for when it means a JSON body.
            Some(other) => Some(Some(other.to_string())),
        },
        timeout_ms: u64_body_field(v, "timeout_ms", "timeoutMs"),
        enabled: v.get("enabled").and_then(Value::as_bool),
    }
}

/// `job_id`, or `job_name` (which must match exactly one job).
fn cron_job(v: &Value) -> Result<Named, String> {
    if let Some(id) = str_body_field(v, "job_id", "jobId") {
        return Ok(Named::Id(id));
    }
    str_body_field(v, "job_name", "jobName")
        .map(Named::Name)
        .ok_or_else(|| {
            "pass job_id or job_name — action \"list\" shows the app's tasks".to_string()
        })
}

/// `manage_app_cron` — the app's cloud-side schedule: at each due minute, one
/// HTTP request to the app's own public URL. Flows in `teamclu-apps`.
pub(crate) async fn handle_app_cron(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v = parse_body(body)?;
    let action = require_action(&v, &CRON_ACTIONS)?;
    let fields = cron_fields(&v);
    // Argument mistakes before anything is resolved.
    let fields_json = fields.to_api()?;
    if action == "update" && fields_json.as_object().is_some_and(Map::is_empty) {
        return Err(
            "update needs at least one field to change: name, schedule, timezone, method, path, headers, body, timeout_ms, enabled"
                .to_string(),
        );
    }
    let api = AppApi::for_tool(app, &v, "manage_app_cron").await?;
    let row = resolve_app_row(app, &api, &v).await?;
    let host = DesktopHost::new(app, &api);
    let ops = app_ops(&api, &host);
    let out = match action.as_str() {
        "list" => ops.cron_list(&row).await?,
        "create" => ops.cron_create(&row, &fields).await?,
        "update" => ops.cron_update(&row, &cron_job(&v)?, &fields).await?,
        "delete" => ops.cron_delete(&row, &cron_job(&v)?).await?,
        "run" => ops.cron_run(&row, &cron_job(&v)?).await?,
        "runs" => {
            ops.cron_runs(&row, &cron_job(&v)?, u64_body_field(&v, "limit", "limit"))
                .await?
        }
        other => return Err(format!("Unknown action: {other}")),
    };
    Ok(out.to_string())
}

// ─── 自定义域名 ──────────────────────────────────────────────────────────────

const DOMAIN_ACTIONS: [&str; 4] = ["get", "set", "verify", "remove"];

/// `manage_app_domain` — serve the app on a hostname its owner controls.
/// Flows in `teamclu-apps`; the native confirmation stays here until the MCP
/// tools retire (P2.5 S5).
pub(crate) async fn handle_app_domain(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v = parse_body(body)?;
    let action = require_action(&v, &DOMAIN_ACTIONS)?;
    let domain = str_body_field(&v, "domain", "domain");
    if action == "set" && domain.is_none() {
        return Err("set needs `domain` — a hostname only, like app.example.com".to_string());
    }
    let api = AppApi::for_tool(app, &v, "manage_app_domain").await?;
    let row = resolve_app_row(app, &api, &v).await?;
    let host = DesktopHost::new(app, &api);
    let ops = app_ops(&api, &host);
    let out = match action.as_str() {
        "get" => ops.domain_show(&row)?,
        "set" => {
            let domain = domain.unwrap_or_default();
            if let Some(confirmation) =
                confirm::app_domain_set(crate::commands::prefers_zh_locale(), &row, &domain)
            {
                confirm::confirm_with_user(app, confirmation).await?;
            }
            ops.domain_set(&row, &domain).await?
        }
        "verify" => match ops.domain_verify(&row).await {
            Ok(out) => out,
            // "Not visible yet" is the ordinary state while DNS propagates —
            // an answer to report, not a failure.
            Err(e) if e.retryable => json!({
                "ok": false,
                "action": "verify",
                "app_id": row_str(&row, "id"),
                "verified": false,
                "message": e.message,
            }),
            Err(e) => return Err(e.into()),
        },
        "remove" => {
            if let Some(confirmation) =
                confirm::app_domain_remove(crate::commands::prefers_zh_locale(), &row)
            {
                confirm::confirm_with_user(app, confirmation).await?;
            }
            ops.domain_remove(&row).await?
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
}
