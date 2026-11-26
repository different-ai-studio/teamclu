//! `amuxd app …` — create, deploy and inspect TeamClu apps from a shell, so an
//! agent amuxd did not start (Claude Code, Codex, a CI script) can publish one.
//!
//! A thin client: every command is one `POST /v1/app-ops` to the running
//! daemon (`http::app_ops`), which runs the same flows as the desktop's
//! `manage_app` tool on the daemon's own agent account.
//!
//! The output is a contract (docs/specs/2026-11-24-amuxd-app-cli-design.md
//! §2.2–2.3): one line of JSON, `{"v":1,"ok":true,"data":…}` or
//! `{"v":1,"ok":false,"error":{code,message,next,retryable,…}}`, and an exit
//! status that says what went wrong — 0 done, 2 arguments, 3 no identity,
//! 4 not allowed, 5 not found or ambiguous, 6 conflict, 7 platform / daemon,
//! 8 outcome unknown (never retry blindly). `-o table` is for people.
//!
//! With neither `--id` nor `--app`, the app is the one whose checkout the
//! current directory is in, which is what an agent editing an app wants.

use clap::{Args, Subcommand};
use serde_json::{json, Value};

use super::daemon_http::LocalDaemonClient;

/// Total output beyond this is cut, with a pointer to `-o file:` (C10).
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// Any one string longer than this is cut (log messages, cells, errors).
const MAX_FIELD_BYTES: usize = 2 * 1024;
/// `logs` without `--limit` (cli-design §2.2).
const DEFAULT_LOG_LIMIT: u64 = 50;

#[derive(Args, Debug)]
pub struct AppArgs {
    /// json (default, one line), table (for people), or file:<path> (the
    /// whole result to a file; stdout gets a summary).
    #[arg(short = 'o', long = "output", global = true, default_value = "json")]
    pub output: String,
    #[command(subcommand)]
    pub action: AppAction,
}

/// Which app. Neither flag: the app whose checkout the current directory is in.
#[derive(Args, Debug, Default)]
pub struct AppTarget {
    /// The app's id.
    #[arg(long, conflicts_with = "app")]
    pub id: Option<String>,
    /// The app's name or slug — must match exactly one app in the team.
    #[arg(long)]
    pub app: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum AppAction {
    /// Which account these commands act as, and in which team.
    Whoami,
    /// This team's apps visible to this daemon's agent, with the local
    /// checkout of each one this machine has.
    List,
    /// Every setting of one app, where its checkout is, what it declares, and
    /// how far its branch is ahead of what is live.
    ///
    /// Example: amuxd app status --app 记账
    Status(AppTarget),
    /// Create an app and put its code on this machine: a starter template by
    /// default, or a clone (--from-git), or an existing folder (--from-dir).
    ///
    /// Example: amuxd app create 记账 --type data_app
    Create {
        /// The new app's name.
        name: Option<String>,
        /// static_web (template default), slides, data_app, or imported
        /// (default for --from-git / --from-dir).
        #[arg(long = "type")]
        app_type: Option<String>,
        /// personal (default) or team.
        #[arg(long)]
        visibility: Option<String>,
        /// Import this repository instead of starting from a template.
        #[arg(long, conflicts_with = "from_dir")]
        from_git: Option<String>,
        /// Use this folder as the app's code, where it is.
        #[arg(long)]
        from_dir: Option<std::path::PathBuf>,
        #[arg(long = "name", hide = true)]
        old_name: Option<String>,
        #[arg(long = "git-remote", hide = true)]
        old_git_remote: Option<String>,
        #[arg(long = "dir", hide = true)]
        old_dir: Option<String>,
    },
    /// Write the app's code again, for an app whose seed never ran or failed.
    Reseed(AppTarget),
    /// Put a team app's code on this machine. Never clones over a checkout
    /// that is already here.
    Download(AppTarget),
    /// Change the app's settings: name, type, visibility, and the login wall.
    /// The reply's `notes` say what each change does and when it takes effect.
    Update {
        #[command(flatten)]
        target: AppTarget,
        /// A new name. The public URL does not change.
        #[arg(long)]
        name: Option<String>,
        /// static_web, slides, data_app, or imported. Takes effect on the next
        /// deploy; leaving data_app drops DATABASE_URL from the app.
        #[arg(long = "type")]
        app_type: Option<String>,
        /// personal or team. A personal app is invisible to this daemon's
        /// agent unless that agent created it.
        #[arg(long)]
        visibility: Option<String>,
        /// none or platform (the login wall).
        #[arg(long)]
        auth_mode: Option<String>,
        /// any or org.
        #[arg(long)]
        auth_audience: Option<String>,
        /// all or paths.
        #[arg(long)]
        auth_scope: Option<String>,
        /// The per-path rules, as JSON:
        /// '[{"path":"/admin","auth":"required","audience":"org"}]'.
        #[arg(long, value_parser = parse_json)]
        auth_rules: Option<Value>,
    },
    /// Build the checkout on this machine and publish it. A Gitea-hosted app
    /// must be committed and pushed first. Needs write on the app.
    ///
    /// Example: amuxd app deploy
    Deploy {
        #[command(flatten)]
        target: AppTarget,
        /// Confirm that this deploy carries a database migration.
        #[arg(long)]
        migration: bool,
        /// Move an app still on its old domain to its app-code domain once
        /// this deploy succeeds.
        #[arg(long)]
        move_domain: bool,
        #[arg(long = "use-app-code-domain", hide = true)]
        old_use_app_code_domain: bool,
    },
    /// The deployed app's own output.
    ///
    /// Example: amuxd app logs --since 5m --grep error
    Logs {
        #[command(flatten)]
        target: AppTarget,
        /// How far back: 30m (default), 2h, 1d — at most 7d.
        #[arg(long)]
        since: Option<String>,
        /// At most this many entries (default 50, at most 200).
        #[arg(long)]
        limit: Option<u64>,
        /// app (default), request, or all.
        #[arg(long)]
        kind: Option<String>,
        /// Only entries containing this text.
        #[arg(long)]
        grep: Option<String>,
        /// Only entries for this request id.
        #[arg(long)]
        request_id: Option<String>,
        #[arg(long = "contains", hide = true)]
        old_contains: Option<String>,
    },
    /// Take the deployed site offline and keep the app, its code and its data.
    /// A deployed app must be undeployed before it can be deleted. Needs an
    /// explicit --id or --app.
    Undeploy {
        #[command(flatten)]
        target: AppTarget,
    },
    /// Delete the app: its site goes offline and its repository is archived.
    /// Needs an explicit --id or --app, and --yes.
    Delete {
        #[command(flatten)]
        target: AppTarget,
        /// Yes, delete it. There is no undo.
        #[arg(long)]
        yes: bool,
    },
}

fn parse_json(raw: &str) -> Result<Value, String> {
    serde_json::from_str(raw).map_err(|e| format!("not valid JSON: {e}"))
}

/// An argument mistake, refused before the daemon is asked (exit 2).
#[derive(Debug)]
struct Usage {
    code: &'static str,
    message: String,
    next: Option<String>,
}

fn usage(code: &'static str, message: impl Into<String>, next: Option<String>) -> Usage {
    Usage { code, message: message.into(), next }
}

/// A flag that was renamed (Q7: no aliases): say what it is called now.
fn renamed(old: &str, new: &str) -> Usage {
    usage(
        "renamed_argument",
        format!("{old} was renamed to {new}"),
        Some(format!("use {new}")),
    )
}

/// `30m`, `2h`, `1d`, `45s` → whole minutes, at least 1.
fn since_minutes(raw: &str) -> Result<u64, Usage> {
    let raw = raw.trim();
    let bad = || {
        usage(
            "invalid_since",
            format!("--since takes a duration like 30m, 2h or 1d (got {raw:?})"),
            raw.parse::<u64>()
                .ok()
                .map(|n| format!("--since {n}m")),
        )
    };
    let (num, unit) = raw.split_at(raw.find(|c: char| !c.is_ascii_digit()).ok_or_else(bad)?);
    let n: u64 = num.parse().map_err(|_| bad())?;
    let minutes = match unit {
        "s" => n.div_ceil(60),
        "m" => n,
        "h" => n * 60,
        "d" => n * 24 * 60,
        _ => return Err(bad()),
    };
    Ok(minutes.max(1))
}

/// The JSON body for one action.
fn request_body(action: &AppAction, cwd: Option<String>) -> Result<Value, Usage> {
    let target = |t: &AppTarget| {
        json!({
            "appId": t.id,
            "appName": t.app,
            "workspacePath": cwd,
        })
    };
    let mut body = match action {
        AppAction::Whoami | AppAction::List => json!({}),
        AppAction::Status(t) | AppAction::Reseed(t) | AppAction::Download(t) => target(t),
        AppAction::Update {
            target: t,
            name,
            app_type,
            visibility,
            auth_mode,
            auth_audience,
            auth_scope,
            auth_rules,
        } => {
            let mut body = target(t);
            body["name"] = json!(name);
            body["type"] = json!(app_type);
            body["visibility"] = json!(visibility);
            body["authMode"] = json!(auth_mode);
            body["authAudience"] = json!(auth_audience);
            body["authScope"] = json!(auth_scope);
            body["authRules"] = json!(auth_rules);
            body
        }
        AppAction::Undeploy { target: t } => target(t),
        AppAction::Delete { target: t, yes } => {
            let mut body = target(t);
            body["confirm"] = json!(yes);
            body
        }
        AppAction::Create {
            name,
            app_type,
            visibility,
            from_git,
            from_dir,
            old_name,
            old_git_remote,
            old_dir,
        } => {
            if old_name.is_some() {
                return Err(usage(
                    "renamed_argument",
                    "the name is now positional: amuxd app create <name>",
                    Some(format!("amuxd app create {:?}", old_name.as_deref().unwrap_or(""))),
                ));
            }
            if old_git_remote.is_some() {
                return Err(renamed("--git-remote", "--from-git"));
            }
            if old_dir.is_some() {
                return Err(renamed("--dir", "--from-dir"));
            }
            // The daemon refuses a relative directory; resolve it against the
            // caller's cwd here, which is the only place that knows it.
            let local_dir = match from_dir {
                Some(dir) => Some(
                    std::path::absolute(dir)
                        .map_err(|e| usage("invalid_dir", e.to_string(), None))?
                        .to_string_lossy()
                        .into_owned(),
                ),
                None => None,
            };
            json!({
                "name": name,
                "type": app_type,
                "visibility": visibility,
                "gitRemoteUrl": from_git,
                "localDir": local_dir,
            })
        }
        AppAction::Deploy {
            target: t,
            migration,
            move_domain,
            old_use_app_code_domain,
        } => {
            if *old_use_app_code_domain {
                return Err(renamed("--use-app-code-domain", "--move-domain"));
            }
            let mut body = target(t);
            body["migrationIntent"] = json!(migration);
            body["useAppCodeDomain"] = json!(move_domain);
            body
        }
        AppAction::Logs {
            target: t,
            since,
            limit,
            kind,
            grep,
            request_id,
            old_contains,
        } => {
            if old_contains.is_some() {
                return Err(renamed("--contains", "--grep"));
            }
            let mut body = target(t);
            body["sinceMinutes"] = json!(since.as_deref().map(since_minutes).transpose()?);
            body["limit"] = json!(limit.unwrap_or(DEFAULT_LOG_LIMIT));
            body["kind"] = json!(kind);
            body["contains"] = json!(grep);
            body["requestId"] = json!(request_id);
            body
        }
    };
    body["action"] = json!(action_name(action));
    Ok(body)
}

fn action_name(action: &AppAction) -> &'static str {
    match action {
        AppAction::Whoami => "whoami",
        AppAction::List => "list",
        AppAction::Status(_) => "status",
        AppAction::Create { .. } => "create",
        AppAction::Reseed(_) => "reseed",
        AppAction::Download(_) => "download",
        AppAction::Update { .. } => "update",
        AppAction::Undeploy { .. } => "undeploy",
        AppAction::Delete { .. } => "delete",
        AppAction::Deploy { .. } => "deploy",
        AppAction::Logs { .. } => "logs",
    }
}

/// A failure envelope built on this side of the daemon.
pub fn error_envelope(code: &str, message: &str, next: Option<&str>, exit: i32, retryable: bool) -> Value {
    let kind = match exit {
        2 => "invalid",
        3 => "unauthenticated",
        4 => "forbidden",
        5 => "not_found",
        6 => "conflict",
        8 => "unknown",
        _ => "upstream",
    };
    json!({
        "v": 1,
        "ok": false,
        "error": {
            "code": code,
            "message": message,
            "next": next,
            "retryable": retryable,
            "kind": kind,
            "exit": exit,
        }
    })
}

/// What the daemon answered, as an envelope. An HTTP error comes from below
/// the flows (no scope, an older daemon): mapped by status.
fn to_envelope(outcome: anyhow::Result<Result<Value, (u16, String)>>) -> Value {
    match outcome {
        Ok(Ok(value)) if value.get("v").is_some() => value,
        // A daemon from before the envelope: its success is the bare result.
        Ok(Ok(value)) => json!({ "v": 1, "ok": true, "data": value }),
        Ok(Err((status, detail))) => {
            let (code, exit) = match status {
                401 => ("daemon_unauthorized", 3),
                403 => ("daemon_forbidden", 4),
                404 => ("daemon_too_old", 7),
                422 => ("refused", 6),
                _ => ("daemon_error", 7),
            };
            let next = (status == 404).then_some("amuxd update");
            error_envelope(code, &detail, next, exit, false)
        }
        Err(e) => error_envelope(
            "daemon_unreachable",
            &format!("the local amuxd did not answer: {e}"),
            Some("amuxd status"),
            7,
            true,
        ),
    }
}

/// The exit status an envelope stands for.
fn exit_of(envelope: &Value) -> i32 {
    if envelope["ok"] == true {
        return 0;
    }
    envelope["error"]["exit"].as_i64().map(|n| n as i32).unwrap_or(7)
}

/// Strings longer than [`MAX_FIELD_BYTES`] cut; true when anything was.
fn cap_fields(value: &mut Value) -> bool {
    match value {
        Value::String(s) if s.len() > MAX_FIELD_BYTES => {
            let mut cut = MAX_FIELD_BYTES;
            while !s.is_char_boundary(cut) {
                cut -= 1;
            }
            let dropped = s.len() - cut;
            s.truncate(cut);
            s.push_str(&format!("…[{dropped} more bytes]"));
            true
        }
        Value::Array(items) => items.iter_mut().fold(false, |acc, v| cap_fields(v) | acc),
        Value::Object(map) => map.values_mut().fold(false, |acc, v| cap_fields(v) | acc),
        _ => false,
    }
}

/// The envelope as it goes to stdout: fields capped, the whole capped, and
/// `truncated: true` with a way to get everything when anything was cut.
fn bounded(mut envelope: Value) -> String {
    let mut truncated = false;
    if let Some(data) = envelope.get_mut("data") {
        truncated = cap_fields(data);
    }
    if truncated {
        envelope["truncated"] = json!(true);
        envelope["next"] = json!("rerun with -o file:<path> for the full result");
    }
    let line = envelope.to_string();
    if line.len() <= MAX_OUTPUT_BYTES {
        return line;
    }
    let mut preview = envelope["data"].to_string();
    let mut cut = MAX_OUTPUT_BYTES - 1024;
    while !preview.is_char_boundary(cut) {
        cut -= 1;
    }
    preview.truncate(cut);
    json!({
        "v": 1,
        "ok": envelope["ok"],
        "truncated": true,
        "data_preview": preview,
        "next": "rerun with -o file:<path> for the full result, or narrow it (--limit, --since)",
    })
    .to_string()
}

/// `-o table`: what a person reads. Arrays of objects become columns,
/// objects become `key: value` lines, nested values stay JSON.
fn table(envelope: &Value) -> String {
    let cell = |v: &Value| match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    if envelope["ok"] != true {
        let e = &envelope["error"];
        let mut out = format!("error [{}]: {}", cell(&e["code"]), cell(&e["message"]));
        if let Some(next) = e["next"].as_str() {
            out.push_str(&format!("\nnext: {next}"));
        }
        return out;
    }
    let data = &envelope["data"];
    let rows = data
        .as_array()
        .or_else(|| data.as_object().and_then(|m| m.values().find_map(Value::as_array)));
    if let Some(rows) = rows.filter(|r| r.iter().all(Value::is_object) && !r.is_empty()) {
        let mut cols: Vec<String> = Vec::new();
        for row in rows {
            for k in row.as_object().into_iter().flat_map(|m| m.keys()) {
                if !cols.contains(k) {
                    cols.push(k.clone());
                }
            }
        }
        let mut out = cols.join("\t");
        for row in rows {
            out.push('\n');
            out.push_str(&cols.iter().map(|c| cell(&row[c])).collect::<Vec<_>>().join("\t"));
        }
        return out;
    }
    match data.as_object() {
        Some(map) => map
            .iter()
            .map(|(k, v)| format!("{k}: {}", cell(v)))
            .collect::<Vec<_>>()
            .join("\n"),
        None => cell(data),
    }
}

/// Write `envelope` the way `-o` asks; the exit status it stands for.
fn emit(output: &str, envelope: Value) -> i32 {
    let exit = exit_of(&envelope);
    match output {
        "json" => println!("{}", bounded(envelope)),
        "table" => println!("{}", table(&envelope)),
        other => match other.strip_prefix("file:").filter(|p| !p.is_empty()) {
            Some(path) => {
                let text = serde_json::to_string_pretty(&envelope).unwrap_or_default();
                match std::fs::write(path, &text) {
                    Ok(()) => {
                        let mut summary = json!({ "v": 1, "ok": envelope["ok"], "written": path, "bytes": text.len() });
                        if envelope["ok"] != true {
                            summary["error"] = envelope["error"].clone();
                        }
                        println!("{summary}");
                    }
                    Err(e) => {
                        println!(
                            "{}",
                            error_envelope("output_unwritable", &format!("could not write {path}: {e}"), None, 2, false)
                        );
                        return 2;
                    }
                }
            }
            None => {
                println!(
                    "{}",
                    error_envelope(
                        "invalid_output",
                        &format!("-o takes json, table or file:<path> (got {other:?})"),
                        Some("-o table"),
                        2,
                        false,
                    )
                );
                return 2;
            }
        },
    }
    exit
}

/// A command line clap could not parse. Under `amuxd app` the contract
/// still holds — one JSON line, exit 2 — because an agent parses it; help,
/// version and every other subcommand keep clap's own output.
pub fn exit_on_parse_error(e: clap::Error) -> ! {
    use clap::error::ErrorKind;
    let under_app = std::env::args().nth(1).as_deref() == Some("app");
    if !under_app || matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand) {
        e.exit();
    }
    let message = e.render().to_string();
    let first = message.lines().next().unwrap_or("").trim_start_matches("error: ").to_string();
    let next = match std::env::args().nth(2) {
        Some(sub) if !sub.starts_with('-') => format!("amuxd app {sub} --help"),
        _ => "amuxd app --help".to_string(),
    };
    println!("{}", error_envelope("invalid_arguments", &first, Some(&next), 2, false));
    std::process::exit(2);
}

/// Run one command; returns the process exit status.
pub fn run(args: AppArgs) -> anyhow::Result<i32> {
    let cwd = std::env::current_dir()
        .ok()
        .map(|dir| dir.to_string_lossy().into_owned());
    let body = match request_body(&args.action, cwd) {
        Ok(body) => body,
        Err(u) => {
            return Ok(emit(
                &args.output,
                error_envelope(u.code, &u.message, u.next.as_deref(), 2, false),
            ))
        }
    };
    let rt = tokio::runtime::Runtime::new()?;
    let outcome = rt.block_on(async {
        let daemon = LocalDaemonClient::connect("app-cli").await?;
        daemon
            .send(reqwest::Method::POST, "/v1/app-ops", Some(body))
            .await
    });
    Ok(emit(&args.output, to_envelope(outcome)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Harness {
        #[command(subcommand)]
        action: AppAction,
    }

    fn parse(argv: &[&str]) -> AppAction {
        Harness::try_parse_from(std::iter::once("app").chain(argv.iter().copied()))
            .unwrap()
            .action
    }

    fn body_of(argv: &[&str]) -> Value {
        request_body(&parse(argv), Some("/work/site".into())).unwrap()
    }

    fn refusal(argv: &[&str]) -> Usage {
        request_body(&parse(argv), Some("/work/site".into())).unwrap_err()
    }

    #[test]
    fn a_command_without_a_target_resolves_from_the_current_directory() {
        let body = body_of(&["deploy"]);
        assert_eq!(body["action"], "deploy");
        assert_eq!(body["workspacePath"], "/work/site");
        assert_eq!(body["appId"], Value::Null);
        assert_eq!(body["migrationIntent"], false);
        assert_eq!(body["useAppCodeDomain"], false);
        assert_eq!(body_of(&["deploy", "--move-domain"])["useAppCodeDomain"], true);
    }

    #[test]
    fn an_app_is_named_by_id_or_by_name_but_not_both() {
        assert_eq!(body_of(&["status", "--app", "记账"])["appName"], "记账");
        assert!(Harness::try_parse_from(["app", "status", "--id", "a1", "--app", "x"]).is_err());
    }

    #[test]
    fn update_sends_only_what_was_given_and_rules_as_json() {
        let body = body_of(&[
            "update",
            "--app",
            "记账",
            "--visibility",
            "team",
            "--auth-rules",
            r#"[{"path":"/admin","auth":"required"}]"#,
        ]);
        assert_eq!(body["action"], "update");
        assert_eq!(body["visibility"], "team");
        assert_eq!(body["name"], Value::Null);
        assert_eq!(body["authRules"][0]["path"], "/admin");
        assert!(Harness::try_parse_from(["app", "update", "--auth-rules", "[oops"]).is_err());
    }

    #[test]
    fn delete_carries_the_yes_it_was_given() {
        assert_eq!(body_of(&["delete", "--id", "a1"])["confirm"], false);
        assert_eq!(body_of(&["delete", "--id", "a1", "--yes"])["confirm"], true);
    }

    #[test]
    fn create_takes_the_name_positionally_and_one_absolute_source() {
        let body = body_of(&["create", "site", "--from-dir", "/srv/site"]);
        assert_eq!(body["name"], "site");
        assert_eq!(body["localDir"], "/srv/site");
        assert_eq!(body["gitRemoteUrl"], Value::Null);
        let relative = body_of(&["create", "site", "--from-dir", "site"]);
        assert!(std::path::Path::new(relative["localDir"].as_str().unwrap()).is_absolute());
        assert!(Harness::try_parse_from([
            "app", "create", "x", "--from-dir", "/d", "--from-git", "u"
        ])
        .is_err());
    }

    #[test]
    fn a_renamed_flag_is_refused_with_its_new_spelling() {
        for (argv, new) in [
            (vec!["create", "--name", "x"], "amuxd app create"),
            (vec!["create", "x", "--git-remote", "u"], "--from-git"),
            (vec!["create", "x", "--dir", "/d"], "--from-dir"),
            (vec!["deploy", "--use-app-code-domain"], "--move-domain"),
            (vec!["logs", "--contains", "e"], "--grep"),
        ] {
            let u = refusal(&argv);
            assert_eq!(u.code, "renamed_argument", "{argv:?}");
            assert!(u.next.unwrap().contains(new), "{argv:?}");
        }
    }

    #[test]
    fn logs_take_a_duration_and_default_to_fifty_entries() {
        let body = body_of(&["logs", "--since", "2h", "--grep", "boom"]);
        assert_eq!(body["sinceMinutes"], 120);
        assert_eq!(body["contains"], "boom");
        assert_eq!(body["limit"], 50);
        assert_eq!(body_of(&["logs", "--since", "90s"])["sinceMinutes"], 2);
        assert_eq!(body_of(&["logs", "--since", "1d"])["sinceMinutes"], 1440);
        let bare = refusal(&["logs", "--since", "5"]);
        assert_eq!(bare.code, "invalid_since");
        assert_eq!(bare.next.as_deref(), Some("--since 5m"));
    }

    #[test]
    fn each_failure_exits_with_the_status_its_envelope_names() {
        assert_eq!(exit_of(&json!({"v":1,"ok":true,"data":{}})), 0);
        assert_eq!(exit_of(&json!({"v":1,"ok":false,"error":{"exit":5}})), 5);
        assert_eq!(exit_of(&to_envelope(Err(anyhow::anyhow!("refused")))), 7);
        assert_eq!(exit_of(&to_envelope(Ok(Err((403, "scope".into()))))), 4);
        let old_daemon = to_envelope(Ok(Ok(json!({"ok":true,"action":"list"}))));
        assert_eq!(old_daemon["v"], 1);
        assert_eq!(old_daemon["data"]["action"], "list");
    }

    #[test]
    fn output_is_one_line_with_long_fields_and_the_whole_capped() {
        let small = bounded(json!({"v":1,"ok":true,"data":{"a":"b"}}));
        assert!(!small.contains('\n'));
        let long = bounded(json!({"v":1,"ok":true,"data":{"msg":"x".repeat(5000)}}));
        let v: Value = serde_json::from_str(&long).unwrap();
        assert_eq!(v["truncated"], true);
        assert!(v["data"]["msg"].as_str().unwrap().contains("more bytes"));
        let rows: Vec<Value> = (0..200).map(|i| json!({"i": i, "m": "y".repeat(1000)})).collect();
        let huge = bounded(json!({"v":1,"ok":true,"data":rows}));
        assert!(huge.len() <= MAX_OUTPUT_BYTES);
        let v: Value = serde_json::from_str(&huge).unwrap();
        assert_eq!(v["truncated"], true);
        assert!(v["next"].as_str().unwrap().contains("-o file:"));
    }

    #[test]
    fn a_table_is_columns_for_rows_and_lines_for_an_object() {
        let t = table(&json!({"v":1,"ok":true,"data":{"apps":[{"name":"a","id":"1"},{"name":"b","id":"2"}]}}));
        assert_eq!(t.lines().count(), 3);
        assert!(t.starts_with("name\tid"));
        let e = table(&json!({"v":1,"ok":false,"error":{"code":"x","message":"m","next":"amuxd app list"}}));
        assert!(e.contains("next: amuxd app list"));
    }
}
