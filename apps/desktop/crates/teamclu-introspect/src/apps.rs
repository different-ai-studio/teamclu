//! The `manage_app*` tools — a TeamClu app's control panel, for an agent.
//!
//! One tool per surface of the panel: the app itself (`manage_app`: settings,
//! deploy, logs, delete), who may work on it (`manage_app_access`), its
//! database rows (`manage_app_data`), stored files (`manage_app_files`),
//! environment (`manage_app_env`), cloud schedule (`manage_app_cron`) and
//! custom domain (`manage_app_domain`).
//!
//! Thin clients over the desktop loopback API, which owns the work: only the
//! app holds the signed-in user's cloud bearer (so the Cloud API decides what
//! this agent may do) and only it can reach the local daemon that builds a
//! deploy. This binary shapes arguments and rejects the mistakes that do not
//! need a round trip — and moves file bytes, which belong in the agent's own
//! process (see `files`).
//!
//! The app is named by `app_id`, or by `app_name` when that matches exactly one
//! app in the current team, or — with neither — by the workspace the agent is
//! running in, which the desktop matches against the checkouts this machine
//! holds. Deploying publishes to the public internet and a row write is
//! production data, so an ambiguous name comes back as the candidate list
//! rather than acting on a guess; a directory, by contrast, either is an app's
//! checkout or is not. Irreversible actions (deleting the app, purging its
//! files) do not take the workspace default at all.

mod files;

use serde_json::{json, Value};

const TOOL_NAMES: [&str; 7] = [
    "manage_app",
    "manage_app_access",
    "manage_app_data",
    "manage_app_files",
    "manage_app_env",
    "manage_app_cron",
    "manage_app_domain",
];

pub fn is_app_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// Run one `manage_app*` tool call.
pub async fn handle(
    tool: &str,
    workspace: &str,
    api_port: u16,
    arguments: &Value,
) -> Result<Value, String> {
    let (route, body) = match tool {
        "manage_app" => ("/app-manage", manage_body(workspace, arguments)?),
        "manage_app_access" => ("/app-access", access_body(workspace, arguments)?),
        "manage_app_data" => ("/app-data", data_body(workspace, arguments)?),
        "manage_app_env" => ("/app-env", env_body(workspace, arguments)?),
        "manage_app_cron" => ("/app-cron", cron_body(workspace, arguments)?),
        "manage_app_domain" => ("/app-domain", domain_body(workspace, arguments)?),
        "manage_app_files" => return files::handle(workspace, api_port, arguments).await,
        other => return Err(format!("Unknown tool: {other}")),
    };
    crate::desktop_api::post(api_port, route, &body).await
}

// ─── Argument shaping ───────────────────────────────────────────────────────

fn str_arg(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn require_action(arguments: &Value, allowed: &[&str]) -> Result<String, String> {
    let action = str_arg(arguments, "action").unwrap_or_default();
    if !allowed.contains(&action.as_str()) {
        return Err(format!(
            "action must be one of: {}. Got: {}",
            allowed.join(", "),
            if action.is_empty() {
                "(missing)"
            } else {
                &action
            }
        ));
    }
    Ok(action)
}

/// Copy the app selector onto the outgoing body, refusing both forms at once.
///
/// Neither form is not an error here: the desktop then resolves the app from
/// `workspace_path` — the checkout the agent is actually working in. Only the
/// desktop can do that (it knows the team and can ask the daemon where each
/// app lives), and it is the case this tool used to dead-end on.
fn attach_app_selector(arguments: &Value, body: &mut Value) -> Result<(), String> {
    match (str_arg(arguments, "app_id"), str_arg(arguments, "app_name")) {
        (Some(_), Some(_)) => Err("pass app_id or app_name, not both".to_string()),
        (None, None) => Ok(()),
        (Some(id), None) => {
            body["app_id"] = json!(id);
            Ok(())
        }
        (None, Some(name)) => {
            body["app_name"] = json!(name);
            Ok(())
        }
    }
}

/// Irreversible actions name their app instead of inheriting the workspace's.
/// The desktop enforces the same rule; refusing here saves the round trip.
fn require_named_app(arguments: &Value, action: &str) -> Result<(), String> {
    if str_arg(arguments, "app_id").is_some() || str_arg(arguments, "app_name").is_some() {
        return Ok(());
    }
    Err(format!(
        "{action} cannot be undone, so it needs an explicit app_id or app_name — it does not act on the app inferred from the workspace"
    ))
}

/// Forward the arguments the desktop reads for one action, and nothing else.
fn copy_args(arguments: &Value, body: &mut Value, keys: &[&str]) {
    for key in keys {
        if let Some(value) = arguments.get(*key) {
            if !value.is_null() {
                body[*key] = value.clone();
            }
        }
    }
}

/// `{ action, workspace_path, app_id | app_name }` — every app tool's start.
fn app_body(
    workspace: &str,
    arguments: &Value,
    allowed: &[&str],
) -> Result<(String, Value), String> {
    let action = require_action(arguments, allowed)?;
    let mut body = json!({ "action": action, "workspace_path": workspace });
    attach_app_selector(arguments, &mut body)?;
    Ok((action, body))
}

fn needs(arguments: &Value, key: &str, message: &str) -> Result<(), String> {
    match arguments.get(key) {
        Some(Value::Null) | None => Err(message.to_string()),
        Some(Value::String(s)) if s.trim().is_empty() => Err(message.to_string()),
        Some(_) => Ok(()),
    }
}

const MANAGE_ACTIONS: [&str; 7] = [
    "list", "status", "sessions", "update", "deploy", "logs", "delete",
];
const UPDATE_FIELDS: [&str; 7] = [
    "name",
    "type",
    "visibility",
    "auth_mode",
    "auth_audience",
    "auth_scope",
    "auth_rules",
];

/// The body `/app-manage` receives, so the argument rules are testable without
/// a desktop to post them to.
fn manage_body(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let (action, mut body) = app_body(workspace, arguments, &MANAGE_ACTIONS)?;
    match action.as_str() {
        "logs" => copy_args(
            arguments,
            &mut body,
            &["since_minutes", "limit", "kind", "contains", "request_id"],
        ),
        "update" => {
            copy_args(arguments, &mut body, &UPDATE_FIELDS);
            if !UPDATE_FIELDS.iter().any(|k| body.get(*k).is_some()) {
                return Err(format!(
                    "update needs at least one of: {}",
                    UPDATE_FIELDS.join(", ")
                ));
            }
        }
        "delete" => require_named_app(arguments, "delete")?,
        _ => {}
    }
    Ok(body)
}

const ACCESS_ACTIONS: [&str; 3] = ["list", "grant", "revoke"];

fn access_body(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let (action, mut body) = app_body(workspace, arguments, &ACCESS_ACTIONS)?;
    if action == "list" {
        return Ok(body);
    }
    if str_arg(arguments, "member_id").is_none() && str_arg(arguments, "member_name").is_none() {
        return Err(format!(
            "{action} needs member_id or member_name — action \"list\" shows the candidates"
        ));
    }
    if action == "grant"
        && !matches!(
            str_arg(arguments, "permission").as_deref(),
            Some("view" | "prompt" | "admin")
        )
    {
        return Err("grant needs `permission`: view, prompt or admin".to_string());
    }
    copy_args(
        arguments,
        &mut body,
        &["member_id", "member_name", "permission"],
    );
    Ok(body)
}

const DATA_ACTIONS: [&str; 4] = ["tables", "rows", "update_row", "delete_row"];

fn data_body(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let (action, mut body) = app_body(workspace, arguments, &DATA_ACTIONS)?;

    if action != "tables" {
        let table = str_arg(arguments, "table").ok_or_else(|| {
            format!("{action} needs `table` — run action \"tables\" first to see what exists")
        })?;
        body["table"] = json!(table);
    }

    match action.as_str() {
        "rows" => copy_args(
            arguments,
            &mut body,
            &[
                "limit",
                "after",
                "direction",
                "filter_column",
                "filter_op",
                "filter_value",
            ],
        ),
        "update_row" | "delete_row" => {
            // Addressed by primary key only. `key` is the column → value map for
            // this row's primary key; `row_key` is the opaque form a previous
            // reply handed back, accepted so a caller can pass one straight
            // through.
            if arguments.get("key").is_none() && str_arg(arguments, "row_key").is_none() {
                return Err(format!(
                    "{action} needs `key` — an object of the row's primary-key columns, e.g. {{\"id\": 42}}"
                ));
            }
            if action == "update_row" && !arguments.get("patch").is_some_and(Value::is_object) {
                return Err(
                    "update_row needs `patch` — an object of column → new value".to_string()
                );
            }
            copy_args(arguments, &mut body, &["key", "row_key", "patch"]);
        }
        _ => {}
    }
    Ok(body)
}

const ENV_ACTIONS: [&str; 3] = ["list", "set", "delete"];

fn env_body(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let (action, mut body) = app_body(workspace, arguments, &ENV_ACTIONS)?;
    if action == "list" {
        return Ok(body);
    }
    needs(
        arguments,
        "key",
        &format!("{action} needs `key` — the variable name"),
    )?;
    if action == "set"
        && !matches!(
            arguments.get("value"),
            Some(Value::String(_) | Value::Number(_) | Value::Bool(_))
        )
    {
        return Err("set needs `value` — a string; an empty string is allowed".to_string());
    }
    copy_args(arguments, &mut body, &["key", "value", "is_secret"]);
    Ok(body)
}

const CRON_ACTIONS: [&str; 6] = ["list", "create", "update", "delete", "run", "runs"];
const CRON_FIELDS: [&str; 9] = [
    "name",
    "schedule",
    "timezone",
    "method",
    "path",
    "headers",
    "body",
    "timeout_ms",
    "enabled",
];

fn cron_body(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let (action, mut body) = app_body(workspace, arguments, &CRON_ACTIONS)?;
    match action.as_str() {
        "list" => {}
        "create" => {
            needs(arguments, "name", "create needs `name`")?;
            needs(
                arguments,
                "schedule",
                "create needs `schedule` — five cron fields: minute hour day-of-month month day-of-week",
            )?;
            copy_args(arguments, &mut body, &CRON_FIELDS);
            // `body: null` is how a caller clears a request body; copy_args
            // drops nulls, so carry it explicitly.
            if arguments.get("body").is_some_and(Value::is_null) {
                body["body"] = Value::Null;
            }
        }
        _ => {
            if str_arg(arguments, "job_id").is_none() && str_arg(arguments, "job_name").is_none() {
                return Err(format!(
                    "{action} needs job_id or job_name — action \"list\" shows the app's tasks"
                ));
            }
            copy_args(arguments, &mut body, &["job_id", "job_name"]);
            if action == "update" {
                copy_args(arguments, &mut body, &CRON_FIELDS);
                if arguments.get("body").is_some_and(Value::is_null) {
                    body["body"] = Value::Null;
                }
                if !CRON_FIELDS.iter().any(|k| body.get(*k).is_some()) {
                    return Err(format!(
                        "update needs at least one field to change: {}",
                        CRON_FIELDS.join(", ")
                    ));
                }
            }
            if action == "runs" {
                copy_args(arguments, &mut body, &["limit"]);
            }
        }
    }
    Ok(body)
}

const DOMAIN_ACTIONS: [&str; 4] = ["get", "set", "verify", "remove"];

fn domain_body(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let (action, mut body) = app_body(workspace, arguments, &DOMAIN_ACTIONS)?;
    if action == "set" {
        let domain = str_arg(arguments, "domain")
            .ok_or("set needs `domain` — a hostname only, like app.example.com")?;
        if domain.contains("://") || domain.contains('/') {
            return Err(format!(
                "domain must be a hostname only, with no scheme or path (got {domain:?})"
            ));
        }
        body["domain"] = json!(domain);
    }
    Ok(body)
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const APP_SELECTOR_ID: &str = "The app's UUID. Give this or app_name, not both; omit both to mean the app whose checkout is the current workspace.";
const APP_SELECTOR_NAME: &str = "The app's name, when it identifies exactly one app in this team. Omit it and app_id to mean the app whose checkout is the current workspace.";

pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "manage_app",
            "description": "Work with a TeamClu app — what its control panel does. Omit app_id and app_name to act on the app whose checkout is the workspace you are in; you do not need to ask the user which app this is, and `list` reports each app's local `workdir`. list: this team's apps. status: every setting, where the checkout is on this machine, what the checkout declares about how it is built and run, and how far its branch is ahead of what is live. sessions: conversations linked to the app. update: change name, type, visibility and the deployed site's login wall (auth_*) — only the fields you pass change. deploy: build the checkout on this machine and PUBLISH TO THE PUBLIC INTERNET; an app whose auth_mode is \"none\" is readable by anyone with the URL. logs: what the deployed app printed, which is how you find out why it 500s. delete: take the app offline for good; needs an explicit app_id or app_name. Related tools: manage_app_access (who on the team may work on it), manage_app_env, manage_app_cron, manage_app_files, manage_app_data, manage_app_domain. Requires the TeamClu desktop app to be running and signed in; the user's own permissions apply (most changes need admin on the app).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": MANAGE_ACTIONS,
                        "description": "What to do with the app."
                    },
                    "app_id": { "type": "string", "description": format!("{APP_SELECTOR_ID} Not needed for list.") },
                    "app_name": { "type": "string", "description": APP_SELECTOR_NAME },
                    "name": { "type": "string", "description": "update: the new display name. The public URL does not change." },
                    "type": {
                        "type": "string",
                        "enum": ["static_web", "slides", "data_app", "imported"],
                        "description": "update: static_web (a website) and slides have no database; data_app gets a Postgres database; imported is code from an existing repo, with no database. What reaches the running app is only whether it has a database, on the next deploy. Leaving data_app removes DATABASE_URL from the app on that deploy, so code using the database breaks — the data is kept and comes back if the type is set to data_app again."
                    },
                    "visibility": {
                        "type": "string",
                        "enum": ["personal", "team"],
                        "description": "update: personal = only the creator and members granted access in manage_app_access (the local daemon cannot see it either); team = everyone on the team."
                    },
                    "auth_mode": {
                        "type": "string",
                        "enum": ["none", "platform"],
                        "description": "update: the deployed site's login wall. none = public; platform = visitors must sign in. Applies from the next request, no deploy needed."
                    },
                    "auth_audience": {
                        "type": "string",
                        "enum": ["any", "org"],
                        "description": "update: who passes the wall — any = any signed-in user, org = only people in this organisation."
                    },
                    "auth_scope": {
                        "type": "string",
                        "enum": ["all", "paths"],
                        "description": "update: all = every path needs login; paths = only the paths an auth rule marks required."
                    },
                    "auth_rules": {
                        "type": "array",
                        "description": "update: exceptions to auth_scope, matched by path prefix, longest match wins. REPLACES the whole list — read status first to keep the existing rules. With auth_scope paths at least one rule must be required.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string", "description": "Starts with /. /admin covers /admin and /admin/..., not /administrator." },
                                "auth": { "type": "string", "enum": ["required", "public"] },
                                "audience": { "type": "string", "enum": ["any", "org"], "description": "Only for required; omit to follow auth_audience." }
                            },
                            "required": ["path", "auth"]
                        }
                    },
                    "since_minutes": { "type": "integer", "description": "logs: how far back to read. Default 30, max 10080 (7 days)." },
                    "limit": { "type": "integer", "description": "logs: how many entries. Default 100, max 200." },
                    "kind": {
                        "type": "string",
                        "enum": ["app", "request", "all"],
                        "description": "logs: `app` is what the app printed (default), `request` is one line per HTTP request with status and duration, `all` is both."
                    },
                    "contains": { "type": "string", "description": "logs: only entries whose message contains this text." },
                    "request_id": { "type": "string", "description": "logs: only entries from this request id — the way to see one failing request end to end." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "manage_app_access",
            "description": "Who on the team may work on a TeamClu app: view = can see it; prompt = can work on its code and read its data, logs and environment; admin = can deploy, change its settings and grant access. The creator is always admin and is not a grant. This is NOT the deployed site's login wall (that is manage_app update with auth_*). list: current grants, and the members who could be granted. grant: set or change one member's level. revoke: remove it. A member is named by member_id, or by member_name when that matches exactly one person — otherwise the candidates come back and nothing changes. Needs admin on the app.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ACCESS_ACTIONS },
                    "app_id": { "type": "string", "description": APP_SELECTOR_ID },
                    "app_name": { "type": "string", "description": APP_SELECTOR_NAME },
                    "member_id": { "type": "string", "description": "grant / revoke: the member's id, from list." },
                    "member_name": { "type": "string", "description": "grant / revoke: the member's display name, as an alternative to member_id." },
                    "permission": { "type": "string", "enum": ["view", "prompt", "admin"], "description": "grant: the level to give." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "manage_app_data",
            "description": "Read and edit the rows in a deployed app's own database — its real production data. Use it to check what the app actually stored, or to fix one bad row. Reads need `prompt` permission on the app and writes need `admin`; only apps with a database (data_app) that have been deployed have one. Writes address exactly one row by primary key; there is no bulk update or delete.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": DATA_ACTIONS,
                        "description": "tables: what tables exist, with their columns and primary key. rows: one page of rows. update_row / delete_row: change exactly one row."
                    },
                    "app_id": { "type": "string", "description": APP_SELECTOR_ID },
                    "app_name": { "type": "string", "description": APP_SELECTOR_NAME },
                    "table": { "type": "string", "description": "Table name, as reported by action \"tables\". Required for everything but tables." },
                    "limit": { "type": "integer", "description": "rows: page size. Default 50, max 100." },
                    "after": { "type": "string", "description": "rows: the previous page's next_cursor. Omit for the first page." },
                    "direction": { "type": "string", "enum": ["asc", "desc"], "description": "rows: order along the primary key. Default asc." },
                    "filter_column": { "type": "string", "description": "rows: column to filter on. Give with filter_op." },
                    "filter_op": { "type": "string", "enum": ["eq", "contains", "isNull", "notNull"], "description": "rows: how to compare." },
                    "filter_value": { "type": "string", "description": "rows: the value to compare against. Ignored by isNull / notNull." },
                    "key": {
                        "type": "object",
                        "description": "update_row / delete_row: the row's primary-key columns and values, e.g. {\"id\": 42}. Read them off the row you got from action \"rows\".",
                        "additionalProperties": true
                    },
                    "row_key": { "type": "string", "description": "Alternative to `key`: the opaque row key form, if you already have one." },
                    "patch": {
                        "type": "object",
                        "description": "update_row: column → new value. Primary-key columns cannot be changed here.",
                        "additionalProperties": true
                    }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "manage_app_files",
            "description": "Files a TeamClu app stored in its object storage. list: one folder level (recursive: true lists every key under prefix). download: a short-lived link, or the file saved locally when save_to is given. upload: send a local file (local_path) to path. delete: one file. delete_folder: everything under a prefix. purge: EVERY file the app has — irreversible, and it needs an explicit app_id or app_name. usage: bytes used against the quota (refresh: true re-measures now). set_quota: change the ceiling. Reading needs view on the app, upload and delete need prompt, purge and set_quota need admin.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": files::ACTIONS },
                    "app_id": { "type": "string", "description": APP_SELECTOR_ID },
                    "app_name": { "type": "string", "description": APP_SELECTOR_NAME },
                    "path": { "type": "string", "description": "download / delete: the file, relative to the app's storage root (as list reports it). upload: where to store it; defaults to the local file's name at the root." },
                    "prefix": { "type": "string", "description": "list: the folder to look in, e.g. uploads/. delete_folder: the folder to empty (required, never the root)." },
                    "recursive": { "type": "boolean", "description": "list: every key under prefix instead of one level. Default false." },
                    "after": { "type": "string", "description": "list: the previous page's next_cursor." },
                    "limit": { "type": "integer", "description": "list: page size, 1-100. Default 100." },
                    "save_to": { "type": "string", "description": "download: save the file here instead of returning a link. Absolute, or relative to the workspace. Refuses to overwrite an existing file." },
                    "local_path": { "type": "string", "description": "upload: the local file to send. Absolute, or relative to the workspace." },
                    "content_type": { "type": "string", "description": "upload: MIME type. Guessed from the extension when omitted." },
                    "refresh": { "type": "boolean", "description": "usage: re-measure now instead of reading the last periodic count." },
                    "quota_bytes": { "type": ["integer", "null"], "description": "set_quota: the ceiling in bytes, or null for the deployment default." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "manage_app_env",
            "description": "A TeamClu app's environment variables and secrets, injected into the deployed app. list: every key, with can_write and whether a change is waiting for a deploy; a secret's value is never returned, to anyone. set: create or replace one (is_secret: true stores it sealed and write-only). delete: remove one. Changes reach the app only on its NEXT deploy (manage_app deploy). Names the platform sets itself are refused: PORT, NODE_ENV, DATABASE_URL, APP_PUBLIC_URL, API_BASE, SUPABASE_URL, SUPABASE_ANON_KEY and anything starting TEAMCLU_. Reading needs prompt on the app, changing needs admin.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ENV_ACTIONS },
                    "app_id": { "type": "string", "description": APP_SELECTOR_ID },
                    "app_name": { "type": "string", "description": APP_SELECTOR_NAME },
                    "key": { "type": "string", "description": "set / delete: letters, digits and underscores, not starting with a digit." },
                    "value": { "type": "string", "description": "set: the value, up to 8192 characters, no newlines. May be empty." },
                    "is_secret": { "type": "boolean", "description": "set: store it as a secret. Default false." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "manage_app_cron",
            "description": "A TeamClu app's cloud scheduled tasks: at each scheduled minute the platform sends one HTTP request to the app's own public URL, whether or not this computer is on. Not manage_cron_job, which runs agent turns on this machine. The request carries no login session, so a path behind the login wall fails — make that path public (manage_app update auth_rules) and check a secret header of your own. At most 20 tasks per app. run: fire one now without moving its schedule. runs: its recent history (the last 20 are kept). A task is named by job_id, or by job_name when that matches exactly one. Listing needs any permission on the app, changes need admin.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": CRON_ACTIONS },
                    "app_id": { "type": "string", "description": APP_SELECTOR_ID },
                    "app_name": { "type": "string", "description": APP_SELECTOR_NAME },
                    "job_id": { "type": "string", "description": "update / delete / run / runs: the task's id, from list." },
                    "job_name": { "type": "string", "description": "update / delete / run / runs: the task's name, as an alternative to job_id." },
                    "name": { "type": "string", "description": "create (required) / update: the task's name." },
                    "schedule": { "type": "string", "description": "create (required) / update: five cron fields — minute hour day-of-month month day-of-week, e.g. \"0 9 * * 1-5\". Supports *, lists, ranges and */n." },
                    "timezone": { "type": "string", "description": "IANA zone the schedule is read in, e.g. Asia/Shanghai. Default UTC." },
                    "method": { "type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], "description": "Default GET." },
                    "path": { "type": "string", "description": "Path on the app's URL, starting with /. Default /." },
                    "headers": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Request headers, at most 20." },
                    "body": { "type": ["string", "null"], "description": "Request body, up to 64 KiB. An object is sent as its JSON text." },
                    "timeout_ms": { "type": "integer", "description": "1000-60000. Default 30000." },
                    "enabled": { "type": "boolean", "description": "Default true. A disabled task has no next run." },
                    "limit": { "type": "integer", "description": "runs: how many. Default 20." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "manage_app_domain",
            "description": "Serve a TeamClu app on a domain the user owns (self-hosted deployments only). get: what is bound and whether it is verified. set: bind a hostname and get the DNS records to publish (a CNAME, and a TXT at _teamclu.<domain>); it is not served until verify succeeds. Setting the same domain again is safe: it shows the records again and keeps any verification. verify: check the TXT record — verified: false with a message usually means DNS has not propagated yet; try again later. remove: unbind it. Changes need admin on the app.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": DOMAIN_ACTIONS },
                    "app_id": { "type": "string", "description": APP_SELECTOR_ID },
                    "app_name": { "type": "string", "description": APP_SELECTOR_NAME },
                    "domain": { "type": "string", "description": "set: hostname only, no scheme or path, e.g. app.example.com." }
                },
                "required": ["action"]
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = "0c0a97bf-d615-47f1-b471-45cb717f1629";

    const WS: &str = "/Users/x/apps/demo";

    #[test]
    fn every_tool_has_a_definition_and_a_route() {
        let defined: Vec<String> = tool_definitions()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(defined, TOOL_NAMES.map(String::from).to_vec());
        for tool in TOOL_NAMES {
            assert!(is_app_tool(tool));
        }
        assert!(!is_app_tool("manage_cron_job"));
    }

    #[test]
    fn unknown_action_is_rejected_before_anything_else() {
        // Checked first on purpose: a typo'd action must not reach the desktop
        // and must not read as "the app is missing".
        let err = manage_body(WS, &json!({ "action": "publish" })).unwrap_err();
        assert!(err.contains("action must be one of"), "{err}");
    }

    #[test]
    fn deploy_without_a_target_defers_to_the_workspace() {
        // The desktop resolves the app from the checkout the agent is in, so an
        // unnamed deploy must reach it instead of being refused here.
        let body = manage_body(WS, &json!({ "action": "deploy" })).unwrap();
        assert_eq!(body["workspace_path"], json!(WS));
        assert!(body.get("app_id").is_none());
        assert!(body.get("app_name").is_none());
    }

    #[test]
    fn the_workspace_travels_with_every_action() {
        let body = manage_body(WS, &json!({ "action": "list" })).unwrap();
        assert_eq!(body["workspace_path"], json!(WS));
    }

    #[test]
    fn an_explicit_target_still_wins() {
        let body = manage_body(WS, &json!({ "action": "deploy", "app_id": APP })).unwrap();
        assert_eq!(body["app_id"], json!(APP));
    }

    #[test]
    fn deploy_refuses_both_target_forms() {
        let err = manage_body(
            WS,
            &json!({ "action": "deploy", "app_id": APP, "app_name": "记账" }),
        )
        .unwrap_err();
        assert!(err.contains("not both"), "{err}");
    }

    #[test]
    fn update_forwards_only_settings_and_needs_one() {
        let body = manage_body(
            WS,
            &json!({
                "action": "update", "type": "data_app", "auth_mode": "platform",
                "auth_rules": [{ "path": "/admin", "auth": "required" }],
                "fcStatus": "live",
            }),
        )
        .unwrap();
        assert_eq!(body["type"], json!("data_app"));
        assert_eq!(body["auth_mode"], json!("platform"));
        assert!(body["auth_rules"].is_array());
        assert!(body.get("fcStatus").is_none());

        let err = manage_body(WS, &json!({ "action": "update" })).unwrap_err();
        assert!(err.contains("at least one"), "{err}");
    }

    #[test]
    fn delete_and_purge_never_take_the_workspace_default() {
        let err = manage_body(WS, &json!({ "action": "delete" })).unwrap_err();
        assert!(err.contains("app_id or app_name"), "{err}");
        assert!(manage_body(WS, &json!({ "action": "delete", "app_name": "记账" })).is_ok());
    }

    #[test]
    fn access_grant_needs_a_member_and_a_level() {
        assert!(access_body(WS, &json!({ "action": "list" })).is_ok());
        let err =
            access_body(WS, &json!({ "action": "grant", "permission": "admin" })).unwrap_err();
        assert!(err.contains("member_id or member_name"), "{err}");
        let err = access_body(
            WS,
            &json!({ "action": "grant", "member_name": "海港", "permission": "owner" }),
        )
        .unwrap_err();
        assert!(err.contains("view, prompt or admin"), "{err}");
        let body = access_body(WS, &json!({ "action": "revoke", "member_id": "m-1" })).unwrap();
        assert_eq!(body["member_id"], json!("m-1"));
    }

    #[test]
    fn env_set_allows_an_empty_value_but_not_a_missing_one() {
        let body = env_body(WS, &json!({ "action": "set", "key": "FLAG", "value": "" })).unwrap();
        assert_eq!(body["value"], json!(""));
        let err = env_body(WS, &json!({ "action": "set", "key": "FLAG" })).unwrap_err();
        assert!(err.contains("needs `value`"), "{err}");
        let err = env_body(WS, &json!({ "action": "delete" })).unwrap_err();
        assert!(err.contains("needs `key`"), "{err}");
    }

    #[test]
    fn cron_create_and_update_rules() {
        let err = cron_body(WS, &json!({ "action": "create", "name": "对账" })).unwrap_err();
        assert!(err.contains("schedule"), "{err}");
        let err = cron_body(WS, &json!({ "action": "run" })).unwrap_err();
        assert!(err.contains("job_id or job_name"), "{err}");
        let err = cron_body(WS, &json!({ "action": "update", "job_name": "对账" })).unwrap_err();
        assert!(err.contains("at least one field"), "{err}");

        let body = cron_body(
            WS,
            &json!({ "action": "update", "job_name": "对账", "body": null, "enabled": false }),
        )
        .unwrap();
        assert!(body["body"].is_null() && body.get("body").is_some());
        assert_eq!(body["enabled"], json!(false));
    }

    #[test]
    fn a_domain_is_a_hostname_only() {
        let err = domain_body(
            WS,
            &json!({ "action": "set", "domain": "https://app.example.com/" }),
        )
        .unwrap_err();
        assert!(err.contains("hostname only"), "{err}");
        let body =
            domain_body(WS, &json!({ "action": "set", "domain": "app.example.com" })).unwrap();
        assert_eq!(body["domain"], json!("app.example.com"));
    }

    #[test]
    fn rows_needs_a_table() {
        let err = data_body(WS, &json!({ "action": "rows", "app_id": APP })).unwrap_err();
        assert!(err.contains("needs `table`"), "{err}");
    }

    #[test]
    fn update_row_needs_a_key() {
        let err = data_body(
            WS,
            &json!({
                "action": "update_row", "app_id": APP,
                "table": "entries", "patch": { "title": "x" }
            }),
        )
        .unwrap_err();
        assert!(err.contains("needs `key`"), "{err}");
    }

    #[test]
    fn update_row_needs_a_patch_object() {
        let err = data_body(
            WS,
            &json!({
                "action": "update_row", "app_id": APP,
                "table": "entries", "key": { "id": 42 }, "patch": "title=x"
            }),
        )
        .unwrap_err();
        assert!(err.contains("needs `patch`"), "{err}");
    }

    #[test]
    fn delete_row_needs_no_patch() {
        // The argument check must not demand a patch to delete.
        let body = data_body(
            WS,
            &json!({
                "action": "delete_row", "app_id": APP,
                "table": "entries", "key": { "id": 42 }
            }),
        )
        .unwrap();
        assert_eq!(body["key"], json!({ "id": 42 }));
    }

    #[test]
    fn copy_args_skips_absent_and_null() {
        let mut body = json!({ "action": "logs" });
        copy_args(
            &json!({ "limit": 20, "contains": Value::Null }),
            &mut body,
            &["limit", "contains", "kind"],
        );
        assert_eq!(body["limit"], json!(20));
        assert!(body.get("contains").is_none());
        assert!(body.get("kind").is_none());
    }
}
