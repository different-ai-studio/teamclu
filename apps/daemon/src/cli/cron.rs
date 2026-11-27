//! `amuxd cron …` — scheduled jobs, for agents first (it replaced the
//! `teamclu-introspect` `manage_cron_job` MCP tool) and people second.
//!
//! A thin client over the running daemon's `/v1/cron/manage`, the same store
//! the settings page lists. The output follows `amuxd app`'s contract: one
//! line of JSON, `{"v":1,"ok":…}`, exit 0 done, 2 arguments, 5 not found,
//! 7 daemon (see `retryable`).

use clap::{Args, Subcommand};
use serde_json::{json, Value};

use super::app::{emit, error_envelope};
use super::daemon_http::LocalDaemonClient;

#[derive(Args, Debug)]
pub struct CronArgs {
    /// json (default), table, or file:<path>.
    #[arg(
        short = 'o',
        long = "output",
        global = true,
        default_value = "json",
        hide_default_value = true
    )]
    pub output: String,
    #[command(subcommand)]
    pub action: CronAction,
}

// Parsed once per process; boxing `Add` would only obscure the flags.
#[allow(clippy::large_enum_variant)]
#[derive(Subcommand, Debug)]
pub enum CronAction {
    /// Jobs in the global list, or this workspace's with --workspace.
    ///
    /// Example: amuxd cron ls -o table
    Ls {
        /// This workspace's jobs (the current directory's) instead of global.
        #[arg(long)]
        workspace: bool,
    },
    /// Create a job. Exactly one of --at, --every, --cron.
    ///
    /// The job runs the message as a prompt, unattended with full access.
    /// To post each result to the chat you are in, pass this run's reply
    /// token as --to (stored as a stable chat id). Without --to, results
    /// stay in the job's run history.
    ///
    /// Example: amuxd cron add 日报 --cron "0 9 * * 1-5" --tz Asia/Shanghai --message "汇总昨天的进展" --to <reply_token>
    Add {
        /// Job name.
        name: String,
        /// The prompt each run executes.
        #[arg(long, conflicts_with = "message_file")]
        message: Option<String>,
        /// Read the prompt from a file (`-` for stdin).
        #[arg(long)]
        message_file: Option<String>,
        /// Once, at an ISO-8601 time with offset (2026-12-01T09:00:00+08:00).
        #[arg(long, group = "when")]
        at: Option<String>,
        /// Repeatedly, every interval: 90s, 30m, 2h, 1d.
        #[arg(long, group = "when")]
        every: Option<String>,
        /// Repeatedly, on a 5-field cron expression.
        #[arg(long, group = "when")]
        cron: Option<String>,
        /// IANA timezone for --cron. Default: this machine's local time.
        #[arg(long, requires = "cron")]
        tz: Option<String>,
        /// What the job does, for people reading the list.
        #[arg(long)]
        description: Option<String>,
        /// Where to post each result: this run's reply token (the chat you
        /// are in), or a channel's own target with --channel (wecom
        /// single:<userid> / group:<chatid>).
        #[arg(long)]
        to: Option<String>,
        /// The channel for a --to that is not a reply token: wecom, feishu,
        /// discord, email, kook, wechat, seatalk.
        #[arg(long, requires = "to")]
        channel: Option<String>,
        /// Store it with this workspace (the current directory) instead of
        /// the global list. Only for jobs that must run in that folder.
        #[arg(long)]
        workspace: bool,
    },
    /// Stop a job from running until resumed.
    ///
    /// Example: amuxd cron pause <job-id>
    Pause { job: String },
    /// Let a paused job run again.
    ///
    /// Example: amuxd cron resume <job-id>
    Resume { job: String },
    /// Delete a job and its run history.
    ///
    /// Example: amuxd cron rm <job-id>
    Rm { job: String },
    /// Run a job now, once, without changing its schedule.
    ///
    /// Example: amuxd cron run <job-id>
    Run { job: String },
    /// A job's last 10 runs.
    ///
    /// Example: amuxd cron runs <job-id>
    Runs { job: String },
}

/// A bad command line, as the envelope says it.
#[derive(Debug)]
struct Usage {
    code: &'static str,
    message: String,
    next: Option<String>,
}

fn usage(code: &'static str, message: impl Into<String>, next: Option<&str>) -> Usage {
    Usage {
        code,
        message: message.into(),
        next: next.map(str::to_owned),
    }
}

/// `30m` → 1 800 000. Units s, m, h, d; a bare number is minutes.
fn every_ms(raw: &str) -> Result<u64, Usage> {
    let raw = raw.trim();
    let (digits, unit) = match raw.find(|c: char| !c.is_ascii_digit()) {
        Some(i) => raw.split_at(i),
        None => (raw, "m"),
    };
    let n: u64 = digits.parse().ok().filter(|n| *n > 0).ok_or_else(|| {
        usage(
            "invalid_interval",
            format!("--every takes a positive number with s, m, h or d (got {raw:?})"),
            Some("--every 30m"),
        )
    })?;
    let unit_ms = match unit {
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        other => {
            return Err(usage(
                "invalid_interval",
                format!("unknown unit {other:?} in --every; use s, m, h or d"),
                Some("--every 30m"),
            ))
        }
    };
    Ok(n * unit_ms)
}

fn read_message(message: Option<&str>, file: Option<&str>) -> Result<String, Usage> {
    let text = match (message, file) {
        (Some(m), _) => m.to_string(),
        (None, Some("-")) => {
            let mut s = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)
                .map_err(|e| usage("unreadable_file", format!("read stdin: {e}"), None))?;
            s
        }
        (None, Some(path)) => std::fs::read_to_string(path)
            .map_err(|e| usage("unreadable_file", format!("read {path}: {e}"), None))?,
        (None, None) => {
            return Err(usage(
                "missing_message",
                "a job needs --message or --message-file",
                Some("amuxd cron add --help"),
            ))
        }
    };
    if text.trim().is_empty() {
        return Err(usage("missing_message", "the message is empty", None));
    }
    Ok(text)
}

/// The workspace root the settings page lists for `dir`: a pi worktree
/// (`<repo>/.worktrees/<id>`) maps back to `<repo>`.
fn workspace_root(dir: &std::path::Path) -> String {
    let parts: Vec<_> = dir.iter().collect();
    match parts.iter().position(|c| *c == ".worktrees") {
        Some(idx) => std::path::PathBuf::from_iter(&parts[..idx])
            .to_string_lossy()
            .into_owned(),
        None => dir.to_string_lossy().into_owned(),
    }
}

fn scope_fields(body: &mut Value, workspace: bool, cwd: Option<&std::path::Path>) {
    if workspace {
        body["scope"] = json!("workspace");
        if let Some(cwd) = cwd {
            body["workspace_path"] = json!(workspace_root(cwd));
        }
    } else {
        body["scope"] = json!("global");
    }
}

/// The `/v1/cron/manage` body for a command line.
fn request_body(action: &CronAction, cwd: Option<&std::path::Path>) -> Result<Value, Usage> {
    let job_action = |name: &str, job: &str| json!({ "action": name, "job_id": job.trim() });
    Ok(match action {
        CronAction::Ls { workspace } => {
            let mut body = json!({ "action": "list" });
            scope_fields(&mut body, *workspace, cwd);
            body
        }
        CronAction::Pause { job } => job_action("pause", job),
        CronAction::Resume { job } => job_action("resume", job),
        CronAction::Rm { job } => job_action("delete", job),
        CronAction::Run { job } => job_action("run", job),
        CronAction::Runs { job } => job_action("get_runs", job),
        CronAction::Add {
            name,
            message,
            message_file,
            at,
            every,
            cron,
            tz,
            description,
            channel,
            to,
            workspace,
        } => {
            let schedule = match (at, every, cron) {
                (Some(at), _, _) => {
                    chrono::DateTime::parse_from_rfc3339(at.trim()).map_err(|_| {
                        usage(
                            "invalid_time",
                            format!("--at takes an ISO-8601 time with an offset (got {at:?})"),
                            Some("--at 2026-12-01T09:00:00+08:00"),
                        )
                    })?;
                    json!({ "kind": "at", "at": at.trim() })
                }
                (_, Some(every), _) => json!({ "kind": "every", "everyMs": every_ms(every)? }),
                (_, _, Some(expr)) => {
                    let mut s = json!({ "kind": "cron", "expr": expr.trim() });
                    if let Some(tz) = tz.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                        s["tz"] = json!(tz);
                    }
                    s
                }
                _ => {
                    return Err(usage(
                        "missing_schedule",
                        "a job needs one of --at, --every, --cron",
                        Some("amuxd cron add --help"),
                    ))
                }
            };
            let message = read_message(message.as_deref(), message_file.as_deref())?;
            let mut body = json!({
                "action": "create",
                "name": name,
                "enabled": true,
                "schedule": schedule,
                "payload": { "message": message },
            });
            if let Some(d) = description {
                body["description"] = json!(d);
            }
            if let Some(to) = to {
                let to = to.trim();
                if to.is_empty() {
                    return Err(usage(
                        "missing_target",
                        "--to is empty; an empty target is not this chat",
                        Some("--to <this run's reply token>"),
                    ));
                }
                let mut delivery = json!({ "mode": "announce", "to": to });
                if let Some(channel) = channel {
                    delivery["channel"] = json!(channel.trim().to_ascii_lowercase());
                }
                body["delivery"] = delivery;
            }
            scope_fields(&mut body, *workspace, cwd);
            body
        }
    })
}

/// A job as the CLI shows it: what it is and when it runs, not its prompt.
fn job_summary(job: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for field in [
        "id",
        "name",
        "description",
        "enabled",
        "schedule",
        "delivery",
        "workspacePath",
        "lastRunAt",
        "nextRunAt",
    ] {
        if let Some(v) = job.get(field).filter(|v| !v.is_null()) {
            out.insert(field.to_string(), v.clone());
        }
    }
    Value::Object(out)
}

/// What the daemon answered, as an envelope.
fn to_envelope(outcome: anyhow::Result<Result<Value, (u16, String)>>) -> Value {
    match outcome {
        Ok(Ok(mut value)) => {
            if let Some(job) = value.get("job").map(job_summary) {
                value["job"] = job;
            }
            if let Some(jobs) = value.get("jobs").and_then(Value::as_array) {
                value["jobs"] = Value::Array(jobs.iter().map(job_summary).collect());
            }
            json!({ "v": 1, "ok": true, "data": value })
        }
        Ok(Err((status, detail))) => {
            let (code, exit, retryable, next) = match status {
                404 => ("not_found", 5, false, Some("amuxd cron ls")),
                400 | 422 => ("invalid_job", 2, false, Some("amuxd cron add --help")),
                401 => ("daemon_unauthorized", 3, false, None),
                403 => ("daemon_forbidden", 4, false, None),
                503 => ("cron_unavailable", 7, true, None),
                _ => ("daemon_error", 7, false, None),
            };
            error_envelope(code, &detail, next, exit, retryable)
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

/// Run one command; returns the process exit status.
pub fn run(args: CronArgs) -> anyhow::Result<i32> {
    let cwd = std::env::current_dir().ok();
    let body = match request_body(&args.action, cwd.as_deref()) {
        Ok(body) => body,
        Err(u) => {
            return Ok(emit(
                &args.output,
                error_envelope(u.code, &u.message, u.next.as_deref(), 2, false),
            ))
        }
    };
    let rt = tokio::runtime::Runtime::new()?;
    let envelope = rt.block_on(async {
        let daemon = match LocalDaemonClient::connect("cron-cli").await {
            Ok(d) => d,
            Err(e) => return to_envelope(Err(e)),
        };
        to_envelope(
            daemon
                .send(reqwest::Method::POST, "/v1/cron/manage", Some(body))
                .await,
        )
    });
    Ok(emit(&args.output, envelope))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn parse(words: &[&str]) -> CronAction {
        match crate::cli::Cli::try_parse_from(words).unwrap().command {
            crate::cli::Commands::Cron(args) => args.action,
            _ => unreachable!(),
        }
    }

    #[test]
    fn intervals_take_units_and_default_to_minutes() {
        assert_eq!(every_ms("90s").unwrap(), 90_000);
        assert_eq!(every_ms("30m").unwrap(), 1_800_000);
        assert_eq!(every_ms("2h").unwrap(), 7_200_000);
        assert_eq!(every_ms("1d").unwrap(), 86_400_000);
        assert_eq!(every_ms("15").unwrap(), 900_000);
        assert!(every_ms("0m").is_err());
        assert!(every_ms("3w").is_err());
        assert!(every_ms("soon").is_err());
    }

    #[test]
    fn a_cron_job_with_delivery_becomes_the_manage_body() {
        let action = parse(&[
            "amuxd",
            "cron",
            "add",
            "日报",
            "--cron",
            "0 9 * * 1-5",
            "--tz",
            "Asia/Shanghai",
            "--message",
            "汇总",
            "--channel",
            "WeCom",
            "--to",
            "rt_abc",
        ]);
        let body = request_body(&action, None).unwrap();
        assert_eq!(
            body,
            json!({
                "action": "create",
                "name": "日报",
                "enabled": true,
                "schedule": { "kind": "cron", "expr": "0 9 * * 1-5", "tz": "Asia/Shanghai" },
                "payload": { "message": "汇总" },
                "delivery": { "mode": "announce", "channel": "wecom", "to": "rt_abc" },
                "scope": "global",
            })
        );
    }

    #[test]
    fn schedules_are_exclusive_and_required() {
        assert!(crate::cli::Cli::try_parse_from([
            "amuxd",
            "cron",
            "add",
            "x",
            "--message",
            "m",
            "--at",
            "2026-12-01T09:00:00+08:00",
            "--every",
            "1h",
        ])
        .is_err());
        let action = parse(&["amuxd", "cron", "add", "x", "--message", "m"]);
        assert_eq!(
            request_body(&action, None).unwrap_err().code,
            "missing_schedule"
        );
        let action = parse(&[
            "amuxd",
            "cron",
            "add",
            "x",
            "--message",
            "m",
            "--at",
            "tomorrow",
        ]);
        assert_eq!(
            request_body(&action, None).unwrap_err().code,
            "invalid_time"
        );
    }

    #[test]
    fn a_channel_needs_a_target_and_a_token_needs_no_channel() {
        assert!(crate::cli::Cli::try_parse_from([
            "amuxd",
            "cron",
            "add",
            "x",
            "--message",
            "m",
            "--every",
            "1h",
            "--channel",
            "wecom",
        ])
        .is_err());
        let action = parse(&[
            "amuxd",
            "cron",
            "add",
            "x",
            "--message",
            "m",
            "--every",
            "1h",
            "--to",
            " ",
        ]);
        assert_eq!(
            request_body(&action, None).unwrap_err().code,
            "missing_target"
        );
        let token = "ab".repeat(16);
        let action = parse(&[
            "amuxd",
            "cron",
            "add",
            "x",
            "--message",
            "m",
            "--every",
            "1h",
            "--to",
            &token,
        ]);
        assert_eq!(
            request_body(&action, None).unwrap()["delivery"],
            json!({ "mode": "announce", "to": token })
        );
    }

    #[test]
    fn workspace_scope_maps_a_worktree_back_to_its_root() {
        let action = parse(&["amuxd", "cron", "ls", "--workspace"]);
        let cwd = std::path::Path::new("/repo/.worktrees/abc/sub");
        assert_eq!(
            request_body(&action, Some(cwd)).unwrap(),
            json!({ "action": "list", "scope": "workspace", "workspace_path": "/repo" })
        );
    }

    #[test]
    fn job_commands_name_the_daemon_actions() {
        for (word, action) in [
            ("pause", "pause"),
            ("resume", "resume"),
            ("rm", "delete"),
            ("run", "run"),
            ("runs", "get_runs"),
        ] {
            let body = request_body(&parse(&["amuxd", "cron", word, "j1"]), None).unwrap();
            assert_eq!(body, json!({ "action": action, "job_id": "j1" }));
        }
    }

    #[test]
    fn replies_hide_the_prompt_and_map_failures_to_exits() {
        let reply = to_envelope(Ok(Ok(json!({
            "action": "created",
            "job": { "id": "j1", "name": "x", "payload": { "message": "secret" }, "enabled": true },
        }))));
        assert_eq!(
            reply["data"]["job"],
            json!({ "id": "j1", "name": "x", "enabled": true })
        );
        let missing = to_envelope(Ok(Err((404, "Job not found: j9".into()))));
        assert_eq!(missing["error"]["exit"], 5);
        let invalid = to_envelope(Ok(Err((422, "bad cron".into()))));
        assert_eq!(invalid["error"]["exit"], 2);
    }
}
