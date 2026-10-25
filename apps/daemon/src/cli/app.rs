//! `amuxd app …` — create, deploy and inspect TeamClu apps from a shell, so an
//! agent amuxd did not start (Claude Code, Codex, a CI script) can publish one.
//!
//! A thin client: every command is one `POST /v1/app-ops` to the running
//! daemon (`http::app_ops`), which runs the same flows as the desktop's
//! `manage_app` tool on the daemon's own agent account. Output is JSON on
//! stdout either way — `{"ok":false,"error":…}` and exit status 1 on failure —
//! so a caller parses one shape.
//!
//! With neither `--id` nor `--app`, the app is the one whose checkout the
//! current directory is in, which is what an agent editing an app wants.

use clap::{Args, Subcommand};
use serde_json::{json, Value};

use super::daemon_http::LocalDaemonClient;

#[derive(Args, Debug)]
pub struct AppArgs {
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
    /// List this team's apps visible to this daemon's agent, with the local
    /// checkout of each one this machine has.
    List,
    /// Every setting of one app, where its checkout is, what it declares, and
    /// how far its branch is ahead of what is live.
    Status(AppTarget),
    /// Create an app and put its code on this machine: a starter template by
    /// default, or a clone of `--git-remote`, or an existing `--dir`.
    Create {
        /// The new app's name.
        #[arg(long)]
        name: String,
        /// static_web (template default), slides, data_app, or imported
        /// (default for --git-remote / --dir).
        #[arg(long = "type")]
        app_type: Option<String>,
        /// personal (default) or team.
        #[arg(long)]
        visibility: Option<String>,
        /// Import this repository instead of starting from a template.
        #[arg(long, conflicts_with = "dir")]
        git_remote: Option<String>,
        /// Use this folder as the app's code, where it is.
        #[arg(long)]
        dir: Option<std::path::PathBuf>,
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
    /// must be committed and pushed first.
    Deploy {
        #[command(flatten)]
        target: AppTarget,
        /// Confirm that this deploy carries a database migration.
        #[arg(long)]
        migration: bool,
        /// Move an app still on its old domain to its app-code domain once
        /// this deploy succeeds.
        #[arg(long)]
        use_app_code_domain: bool,
    },
    /// The deployed app's own output.
    Logs {
        #[command(flatten)]
        target: AppTarget,
        /// How far back, in minutes (default 30, at most 7 days).
        #[arg(long)]
        since: Option<u64>,
        /// At most this many entries (default 100, at most 200).
        #[arg(long)]
        limit: Option<u64>,
        /// app (default), request, or all.
        #[arg(long)]
        kind: Option<String>,
        /// Only entries containing this text.
        #[arg(long)]
        contains: Option<String>,
        /// Only entries for this request id.
        #[arg(long)]
        request_id: Option<String>,
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

/// The JSON body for one action.
fn request_body(action: &AppAction, cwd: Option<String>) -> anyhow::Result<Value> {
    let target = |t: &AppTarget| {
        json!({
            "appId": t.id,
            "appName": t.app,
            "workspacePath": cwd,
        })
    };
    let mut body = match action {
        AppAction::List => json!({}),
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
            git_remote,
            dir,
        } => {
            // The daemon refuses a relative directory; resolve it against the
            // caller's cwd here, which is the only place that knows it.
            let local_dir = match dir {
                Some(dir) => Some(std::path::absolute(dir)?.to_string_lossy().into_owned()),
                None => None,
            };
            json!({
                "name": name,
                "type": app_type,
                "visibility": visibility,
                "gitRemoteUrl": git_remote,
                "localDir": local_dir,
            })
        }
        AppAction::Deploy {
            target: t,
            migration,
            use_app_code_domain,
        } => {
            let mut body = target(t);
            body["migrationIntent"] = json!(migration);
            body["useAppCodeDomain"] = json!(use_app_code_domain);
            body
        }
        AppAction::Logs {
            target: t,
            since,
            limit,
            kind,
            contains,
            request_id,
        } => {
            let mut body = target(t);
            body["sinceMinutes"] = json!(since);
            body["limit"] = json!(limit);
            body["kind"] = json!(kind);
            body["contains"] = json!(contains);
            body["requestId"] = json!(request_id);
            body
        }
    };
    body["action"] = json!(action_name(action));
    Ok(body)
}

fn action_name(action: &AppAction) -> &'static str {
    match action {
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

/// Run one command; the process exit status is 1 when it failed.
pub fn run(args: AppArgs) -> anyhow::Result<bool> {
    let cwd = std::env::current_dir()
        .ok()
        .map(|dir| dir.to_string_lossy().into_owned());
    let body = request_body(&args.action, cwd)?;
    let rt = tokio::runtime::Runtime::new()?;
    let outcome = rt.block_on(async {
        let daemon = LocalDaemonClient::connect("app-cli").await?;
        daemon
            .send(reqwest::Method::POST, "/v1/app-ops", Some(body))
            .await
    });
    let (ok, out) = match outcome {
        Ok(Ok(value)) => (true, value),
        Ok(Err((_, detail))) => (false, json!({ "ok": false, "error": detail })),
        Err(e) => (false, json!({ "ok": false, "error": e.to_string() })),
    };
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(ok)
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

    fn body_of(argv: &[&str]) -> Value {
        let parsed =
            Harness::try_parse_from(std::iter::once("app").chain(argv.iter().copied())).unwrap();
        request_body(&parsed.action, Some("/work/site".into())).unwrap()
    }

    #[test]
    fn a_command_without_a_target_resolves_from_the_current_directory() {
        let body = body_of(&["deploy"]);
        assert_eq!(body["action"], "deploy");
        assert_eq!(body["workspacePath"], "/work/site");
        assert_eq!(body["appId"], Value::Null);
        assert_eq!(body["migrationIntent"], false);
        assert_eq!(body["useAppCodeDomain"], false);
        assert_eq!(
            body_of(&["deploy", "--use-app-code-domain"])["useAppCodeDomain"],
            true
        );
    }

    #[test]
    fn an_app_is_named_by_id_or_by_name_but_not_both() {
        assert_eq!(body_of(&["status", "--app", "记账"])["appName"], "记账");
        assert_eq!(
            body_of(&["logs", "--id", "a1", "--since", "5"])["sinceMinutes"],
            5
        );
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
    fn create_sends_an_absolute_directory_and_one_source() {
        let body = body_of(&["create", "--name", "site", "--dir", "/srv/site"]);
        assert_eq!(body["localDir"], "/srv/site");
        assert_eq!(body["gitRemoteUrl"], Value::Null);
        let relative = body_of(&["create", "--name", "site", "--dir", "site"]);
        assert!(std::path::Path::new(relative["localDir"].as_str().unwrap()).is_absolute());
        assert!(Harness::try_parse_from([
            "app",
            "create",
            "--name",
            "x",
            "--dir",
            "/d",
            "--git-remote",
            "u"
        ])
        .is_err());
    }
}
