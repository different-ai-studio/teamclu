//! `amuxd app …` — how agents create, deploy and manage TeamClu apps: the
//! agents amuxd runs, and any other (Claude Code, Codex, a CI script).
//!
//! A thin client: every command is a `POST /v1/app-ops` to the running daemon
//! (`http::app_ops`), which runs the `teamclu-apps` flows on the daemon's own
//! agent account. The bytes of `files get|put` move here, in this process.
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
    pub action: AppAction,
}

/// Which app. Neither flag: the app whose checkout the current directory is in.
#[derive(Args, Debug, Default)]
pub struct AppTarget {
    /// The app's id.
    #[arg(long, conflicts_with = "app")]
    pub id: Option<String>,
    /// The app's name or slug.
    #[arg(long)]
    pub app: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum AppAction {
    /// Which account these commands act as, and in which team.
    ///
    /// Every command acts as this daemon's agent account; what it may do is
    /// that account's grants on each app.
    ///
    /// Example: amuxd app whoami
    Whoami,
    /// The team's apps this agent can see, with local checkouts.
    ///
    /// Example: amuxd app list -o table
    List,
    /// One app: settings, checkout, declaration, ahead of live.
    ///
    /// Without --id/--app: the app whose checkout this directory is in. Also
    /// lists the app's running operations. Needs read.
    ///
    /// Example: amuxd app status --app 记账
    Status(AppTarget),
    /// Create an app and put its code on this machine.
    ///
    /// A starter template by default, a clone with --from-git, or a folder
    /// already here with --from-dir.
    ///
    /// Example: amuxd app create 记账 --type data_app
    Create {
        /// The new app's name.
        name: Option<String>,
        /// static_web (default), slides, data_app, imported.
        #[arg(long = "type")]
        app_type: Option<String>,
        #[arg(long = "visibility", hide = true)]
        old_visibility: Option<String>,
        /// Import this repository.
        #[arg(long, conflicts_with = "from_dir")]
        from_git: Option<String>,
        /// Use this folder as the app's code, where it is.
        #[arg(long)]
        from_dir: Option<std::path::PathBuf>,
        /// Template only: no code here yet (`checkout reseed` later).
        #[arg(long, conflicts_with_all = ["from_git", "from_dir"])]
        no_checkout: bool,
        #[arg(long = "name", hide = true)]
        old_name: Option<String>,
        #[arg(long = "git-remote", hide = true)]
        old_git_remote: Option<String>,
        #[arg(long = "dir", hide = true)]
        old_dir: Option<String>,
    },
    #[command(hide = true)]
    Reseed(AppTarget),
    #[command(hide = true)]
    Download(AppTarget),
    /// Runtimes the platform offers and what this machine can build.
    ///
    /// Pick a runtime from this, not from memory. Needs read.
    ///
    /// Example: amuxd app runtime --language node
    Runtime {
        #[command(flatten)]
        target: AppTarget,
        /// node, python, go, php or java.
        #[arg(long)]
        language: Option<String>,
    },
    /// The sessions opened on the app.
    ///
    /// Example: amuxd app sessions --app 记账
    Sessions(AppTarget),
    /// The app's code directory on this machine.
    Checkout(Group<CheckoutCmd>),
    /// Rename the app or change its type.
    ///
    /// The reply's `notes` say when each change takes effect. Who may work on
    /// it: `access`; who may open the site: `gate`. Needs admin.
    ///
    /// Example: amuxd app update --name 账本
    Update {
        #[command(flatten)]
        target: AppTarget,
        /// A new name; the URL stays.
        #[arg(long)]
        name: Option<String>,
        /// static_web, slides, data_app, imported (next deploy).
        #[arg(long = "type")]
        app_type: Option<String>,
        #[arg(long = "visibility", hide = true)]
        old_visibility: Option<String>,
        #[arg(long = "auth-mode", hide = true)]
        old_auth_mode: Option<String>,
        #[arg(long = "auth-audience", hide = true)]
        old_auth_audience: Option<String>,
        #[arg(long = "auth-scope", hide = true)]
        old_auth_scope: Option<String>,
        #[arg(long = "auth-rules", hide = true)]
        old_auth_rules: Option<String>,
    },
    /// Build the checkout here and publish it.
    ///
    /// Commit and push first. amuxd runs it: if this command is killed,
    /// `amuxd app op wait <op>` waits again. Needs write.
    ///
    /// Example: amuxd app deploy
    Deploy {
        /// Return the operation id at once.
        #[arg(long)]
        detach: bool,
        #[command(flatten)]
        target: AppTarget,
        /// This deploy carries a database migration.
        #[arg(long)]
        migration: bool,
        /// Move to the app-code domain once it succeeds.
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
        /// 30m (default), 2h, 1d — at most 7d.
        #[arg(long)]
        since: Option<String>,
        /// Default 50, at most 200.
        #[arg(long)]
        limit: Option<u64>,
        /// app (default), request, or all.
        #[arg(long)]
        kind: Option<String>,
        /// Only entries containing this text.
        #[arg(long)]
        grep: Option<String>,
        /// Only this request's entries.
        #[arg(long)]
        request_id: Option<String>,
        #[arg(long = "contains", hide = true)]
        old_contains: Option<String>,
    },
    /// Take the site offline; keep the app, code and data.
    ///
    /// Needs --id or --app, and admin. Waits like deploy.
    ///
    /// Example: amuxd app undeploy --app 记账
    Undeploy {
        #[command(flatten)]
        target: AppTarget,
        /// Return the operation id at once.
        #[arg(long)]
        detach: bool,
    },
    /// Deploys and undeploys amuxd is running or ran.
    Op {
        #[command(subcommand)]
        cmd: OpCmd,
    },
    /// Delete the app; its repository is archived. No undo.
    ///
    /// Undeploy it first. Needs --id or --app, --yes, and admin held directly.
    ///
    /// Example: amuxd app delete --app 记账 --yes
    Delete {
        #[command(flatten)]
        target: AppTarget,
        /// Yes, delete it.
        #[arg(long)]
        yes: bool,
    },
    /// Who may work on the app (read / write / admin).
    Access(Group<AccessCmd>),
    /// Who may open the deployed site (the login wall).
    Gate(Group<GateCmd>),
    /// Files the app stored in object storage.
    Files(Group<FilesCmd>),
    /// Environment variables and secrets (next deploy).
    Env(Group<EnvCmd>),
    /// HTTP calls the platform makes to the app on a schedule.
    Cron(Group<CronCmd>),
    /// The app's custom domain (self-host only).
    Domain(Group<DomainCmd>),
    /// The deployed data_app's database, one row at a time.
    Data(Group<DataCmd>),
}

/// A resource group: which app (before or after the verb), then the verb.
#[derive(Args, Debug)]
pub struct Group<C: Subcommand> {
    /// The app's id.
    #[arg(long, global = true, conflicts_with = "app")]
    pub id: Option<String>,
    /// The app's name or slug.
    #[arg(long, global = true)]
    pub app: Option<String>,
    #[command(subcommand)]
    pub cmd: C,
}

#[derive(Subcommand, Debug)]
pub enum AccessCmd {
    /// Grants with their source, the org level, and candidates.
    ///
    /// A grant is direct, or inherited from an agent's owner. Needs admin.
    ///
    /// Example: amuxd app access ls --app 记账
    Ls,
    /// Grant a person or an agent a level, or the whole org.
    ///
    /// Needs admin held directly (not through an owner).
    ///
    /// Example: amuxd app access grant 王芳 write
    ///
    /// Example: amuxd app access grant --org read
    Grant {
        /// Actor id or name; with --org, the level.
        who: String,
        /// read, write or admin.
        level: Option<String>,
        /// The whole org (read only, for now).
        #[arg(long)]
        org: bool,
    },
    /// Remove an actor's own grant, or the org's.
    ///
    /// Needs admin held directly.
    ///
    /// Example: amuxd app access revoke 王芳
    ///
    /// Example: amuxd app access revoke --org
    Revoke {
        /// Actor id or name.
        #[arg(required_unless_present = "org")]
        who: Option<String>,
        /// The org's grant.
        #[arg(long, conflicts_with = "who")]
        org: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum GateCmd {
    /// The wall, the policy per path, and the org's roles.
    ///
    /// Example: amuxd app gate show
    Show,
    /// Change only the fields given.
    ///
    /// Applies from the next request, no deploy. Needs admin.
    ///
    /// Example: amuxd app gate set --mode platform --audience org
    Set {
        /// none (open) or platform (sign-in).
        #[arg(long)]
        mode: Option<String>,
        /// any (signed in) or org (org members).
        #[arg(long)]
        audience: Option<String>,
        /// all (rules are exceptions) or paths (only rules).
        #[arg(long)]
        scope: Option<String>,
        /// Replace all rules with this JSON array (- = stdin).
        #[arg(long)]
        rules_file: Option<String>,
    },
    /// Add or remove the rule for one path prefix.
    Rule {
        #[command(subcommand)]
        cmd: GateRuleCmd,
    },
}

#[derive(Subcommand, Debug)]
pub enum GateRuleCmd {
    /// Add the rule, or replace the one on that path.
    ///
    /// Needs admin.
    ///
    /// Example: amuxd app gate rule add /admin --auth required --audience org
    Add {
        /// A path prefix starting with /.
        path: String,
        /// required or public.
        #[arg(long)]
        auth: String,
        /// any or org (with required).
        #[arg(long)]
        audience: Option<String>,
        /// Org role codes, a,b (with required).
        #[arg(long, value_delimiter = ',')]
        roles: Option<Vec<String>>,
    },
    /// Remove the rule on exactly this path.
    ///
    /// Example: amuxd app gate rule rm /legacy
    Rm {
        /// The rule's path, as `gate show` lists it.
        path: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum CheckoutCmd {
    /// Where this machine's checkout is, if anywhere.
    ///
    /// Example: amuxd app checkout where --app 记账
    Where,
    /// Put the app's code on this machine.
    ///
    /// Never clones over a checkout already here. Needs read.
    ///
    /// Example: amuxd app checkout clone --app 记账
    Clone,
    /// Move this machine's checkout, whole.
    ///
    /// Not the one this command runs in: run it from elsewhere with --app.
    ///
    /// Example: amuxd app checkout move ~/code/notes --app 记账
    Move {
        /// The new location (absolute, or from here).
        dir: std::path::PathBuf,
    },
    /// Use a folder already here as the app's checkout.
    ///
    /// Example: amuxd app checkout bind ~/code/notes --app 记账
    Bind {
        /// The folder (absolute, or from here).
        dir: std::path::PathBuf,
    },
    /// Write the code again, when the first seed failed.
    ///
    /// Example: amuxd app checkout reseed --app 记账
    Reseed,
}

#[derive(Subcommand, Debug)]
pub enum OpCmd {
    /// The operation now, without waiting.
    ///
    /// Example: amuxd app op status op_3f9a1c2b7d10
    Status {
        /// The op_… id deploy printed.
        op: String,
    },
    /// Wait for it to end; exit with its outcome.
    ///
    /// Exit 8 means unknown: check the app before trying again.
    ///
    /// Example: amuxd app op wait op_3f9a1c2b7d10
    Wait {
        /// The op_… id deploy printed.
        op: String,
    },
    /// Recent operations of this team, newest first.
    ///
    /// Example: amuxd app op list --active
    List {
        /// Only those still running.
        #[arg(long)]
        active: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum FilesCmd {
    /// One folder level (-r: everything under it).
    ///
    /// Example: amuxd app files ls uploads/
    Ls {
        /// A folder prefix, like uploads/.
        prefix: Option<String>,
        /// Every file under the prefix.
        #[arg(short = 'r', long)]
        recursive: bool,
        /// The previous page's next_cursor.
        #[arg(long)]
        cursor: Option<String>,
        /// Default and most 100.
        #[arg(long)]
        limit: Option<u64>,
    },
    /// A signed link, or the file itself with --to.
    ///
    /// Never overwrites. Needs read.
    ///
    /// Example: amuxd app files get reports/q3.csv --to ./q3.csv
    Get {
        /// As `files ls` lists it.
        path: String,
        /// Save here (a directory keeps the name).
        #[arg(long)]
        to: Option<std::path::PathBuf>,
    },
    /// Upload a local file, at most 512 MiB.
    ///
    /// A PATH ending in / is a folder. Needs write.
    ///
    /// Example: amuxd app files put ./logo.png img/
    Put {
        /// The local file.
        local: std::path::PathBuf,
        /// Where to store it (default: its name, at the root).
        path: Option<String>,
        /// Guessed from the extension.
        #[arg(long)]
        content_type: Option<String>,
    },
    /// Delete a file, or a folder with -r.
    ///
    /// Never the root: that is purge. Needs write.
    ///
    /// Example: amuxd app files rm -r tmp/
    Rm {
        /// A file, or a folder with -r.
        path: String,
        /// PATH is a folder.
        #[arg(short = 'r', long)]
        recursive: bool,
    },
    /// Delete every file of the app. No undo.
    ///
    /// Needs --id or --app, --yes, and admin.
    ///
    /// Example: amuxd app files purge --app 记账 --yes
    Purge {
        /// Yes, delete them all.
        #[arg(long)]
        yes: bool,
    },
    /// Bytes stored, against the quota.
    ///
    /// Example: amuxd app files usage --refresh
    Usage {
        /// Measure again first.
        #[arg(long)]
        refresh: bool,
    },
    /// Set the quota in bytes, or `default`.
    ///
    /// Needs admin.
    ///
    /// Example: amuxd app files quota 1073741824
    Quota {
        /// Bytes, or `default`.
        bytes: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum EnvCmd {
    /// The variables; a secret's value is never shown.
    ///
    /// Example: amuxd app env ls
    Ls,
    /// Set a variable, or a secret from stdin / --file.
    ///
    /// A secret never goes on the command line. Needs admin.
    ///
    /// Example: amuxd app env set PORT --value 3000
    ///
    /// Example: printf %s "$TOKEN" | amuxd app env set STRIPE_KEY --secret
    Set {
        /// The variable's name.
        key: String,
        /// A plain variable's value.
        #[arg(long)]
        value: Option<String>,
        /// A secret, read from stdin or --file.
        #[arg(long)]
        secret: bool,
        /// Read the secret from this file.
        #[arg(long, requires = "secret")]
        file: Option<std::path::PathBuf>,
    },
    /// Delete a variable.
    ///
    /// Needs admin.
    ///
    /// Example: amuxd app env rm OLD_KEY
    Rm {
        /// The variable's name.
        key: String,
    },
}

/// The schedule fields of `cron add` / `cron edit`.
#[derive(Args, Debug, Default)]
pub struct CronSpec {
    /// The task's name.
    #[arg(long)]
    pub name: Option<String>,
    /// "minute hour day month weekday".
    #[arg(long)]
    pub schedule: Option<String>,
    /// IANA zone, e.g. Asia/Shanghai.
    #[arg(long)]
    pub tz: Option<String>,
    /// GET (default), POST, …
    #[arg(long)]
    pub method: Option<String>,
    /// The app's own path, e.g. /api/nightly.
    #[arg(long)]
    pub path: Option<String>,
    /// Give up after this long.
    #[arg(long)]
    pub timeout_ms: Option<u64>,
    /// JSON with `headers` and `body`.
    #[arg(long)]
    pub file: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum CronCmd {
    /// The app's scheduled tasks.
    ///
    /// Example: amuxd app cron ls
    Ls,
    /// Add a task. Needs admin.
    ///
    /// Example: amuxd app cron add --name 对账 --schedule "0 9 * * 1-5" --path /api/reconcile
    Add(CronSpec),
    /// Change only the fields given. <JOB>: id or name.
    ///
    /// Example: amuxd app cron edit 对账 --schedule "0 10 * * *"
    Edit {
        /// Job id or name.
        job: String,
        #[command(flatten)]
        spec: CronSpec,
    },
    /// Turn a task on.
    ///
    /// Example: amuxd app cron enable 对账
    Enable {
        /// Job id or name.
        job: String,
    },
    /// Turn a task off; it keeps its schedule.
    ///
    /// Example: amuxd app cron disable 对账
    Disable {
        /// Job id or name.
        job: String,
    },
    /// Run a task now; the schedule does not move.
    ///
    /// Example: amuxd app cron run 对账
    Run {
        /// Job id or name.
        job: String,
    },
    /// A task's recent runs.
    ///
    /// Example: amuxd app cron runs 对账 --limit 5
    Runs {
        /// Job id or name.
        job: String,
        /// Default 20.
        #[arg(long)]
        limit: Option<u64>,
    },
    /// Delete a task.
    ///
    /// Example: amuxd app cron rm 对账
    Rm {
        /// Job id or name.
        job: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum DomainCmd {
    /// The bound domain and whether it is verified.
    ///
    /// Example: amuxd app domain show
    Show,
    /// Bind a hostname; replies with the DNS records.
    ///
    /// Needs admin.
    ///
    /// Example: amuxd app domain set app.example.com
    Set {
        /// e.g. app.example.com.
        host: String,
    },
    /// Check DNS; exit 6 (retryable) while it propagates.
    ///
    /// Example: amuxd app domain verify
    Verify,
    /// Unbind the domain; the app keeps its own URL.
    ///
    /// Example: amuxd app domain rm
    Rm,
}

#[derive(Subcommand, Debug)]
pub enum DataCmd {
    /// The tables, with their primary keys.
    ///
    /// Example: amuxd app data tables
    Tables,
    /// A table's rows, a page at a time.
    ///
    /// Example: amuxd app data rows orders --where status eq paid --limit 10
    Rows {
        /// The table's name.
        table: String,
        /// COL OP [VALUE]: eq, contains, isNull, notNull.
        #[arg(long = "where", num_args = 2..=3, value_names = ["COL", "OP", "VALUE"])]
        filter: Option<Vec<String>>,
        /// Default 20, at most 100.
        #[arg(long)]
        limit: Option<u64>,
        /// The previous page's next_cursor.
        #[arg(long)]
        cursor: Option<String>,
        /// Newest first.
        #[arg(long)]
        desc: bool,
    },
    /// Insert one row from a JSON object.
    ///
    /// {} inserts defaults. Needs admin.
    ///
    /// Example: echo '{"sku":"A1"}' | amuxd app data insert items --file -
    Insert {
        /// The table's name.
        table: String,
        /// JSON object (- = stdin).
        #[arg(long)]
        file: String,
    },
    /// Update one row, by its primary key.
    ///
    /// Needs admin.
    ///
    /// Example: echo '{"status":"refunded"}' | amuxd app data update orders --key id=42 --file -
    Update {
        /// The table's name.
        table: String,
        /// COL=VALUE, once per key column.
        #[arg(long = "key", required = true)]
        key: Vec<String>,
        /// JSON patch (- = stdin).
        #[arg(long)]
        file: String,
    },
    /// Delete one row, by its primary key.
    ///
    /// Needs admin.
    ///
    /// Example: amuxd app data rm orders --key id=42
    Rm {
        /// The table's name.
        table: String,
        /// COL=VALUE, once per key column.
        #[arg(long = "key", required = true)]
        key: Vec<String>,
    },
}

/// An argument mistake, refused before the daemon is asked (exit 2).
#[derive(Debug)]
struct Usage {
    code: &'static str,
    message: String,
    next: Option<String>,
}

fn usage(code: &'static str, message: impl Into<String>, next: Option<String>) -> Usage {
    Usage {
        code,
        message: message.into(),
        next,
    }
}

/// A flag that was renamed (Q7: no aliases): say what it is called now.
fn renamed(old: &str, new: &str) -> Usage {
    usage(
        "renamed_argument",
        format!("{old} was renamed to {new}"),
        Some(format!("use {new}")),
    )
}

/// A flag that left this command for another group.
fn moved(old: &str, new: &str) -> Usage {
    usage(
        "moved_argument",
        format!("{old} moved out of this command"),
        Some(new.to_string()),
    )
}

/// A command that moved into a group.
fn moved_command(old: &str, new: &str) -> Usage {
    usage(
        "moved_command",
        format!("`amuxd app {old}` moved"),
        Some(new.to_string()),
    )
}

/// A local directory argument, absolute against this process's cwd — the
/// daemon refuses a relative one, and only this side knows the cwd.
fn absolute(dir: &std::path::Path) -> Result<String, Usage> {
    Ok(std::path::absolute(dir)
        .map_err(|e| usage("invalid_dir", e.to_string(), None))?
        .to_string_lossy()
        .into_owned())
}

/// `--visibility` is an org grant now (CLI design Q11).
fn visibility_moved(value: &str) -> Usage {
    moved(
        "--visibility",
        if value.trim() == "team" {
            "amuxd app access grant --org read"
        } else {
            "amuxd app access revoke --org"
        },
    )
}

/// `30m`, `2h`, `1d`, `45s` → whole minutes, at least 1.
fn since_minutes(raw: &str) -> Result<u64, Usage> {
    let raw = raw.trim();
    let bad = || {
        usage(
            "invalid_since",
            format!("--since takes a duration like 30m, 2h or 1d (got {raw:?})"),
            raw.parse::<u64>().ok().map(|n| format!("--since {n}m")),
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

/// All of stdin, or a file; one trailing newline dropped (what `echo` adds).
/// A secret's value from `--file` or stdin — never an empty one.
///
/// An agent's shell has nothing on stdin unless it pipes something, so a
/// forgotten pipe reads as "" — and an empty value is a valid one to the
/// platform, which would overwrite the real secret with it and report
/// success. A terminal on stdin means nothing is coming either.
fn read_secret(path: Option<&str>, key: &str) -> Result<String, Usage> {
    use std::io::IsTerminal as _;
    let pipe_it = Some(format!(
        "printf %s \"$VALUE\" | amuxd app env set {key} --secret"
    ));
    if path.is_none() && std::io::stdin().is_terminal() {
        return Err(usage(
            "secret_not_piped",
            "--secret reads the value from stdin, and nothing is piped in",
            pipe_it,
        ));
    }
    let value = read_text(path)?;
    if value.is_empty() {
        return Err(usage(
            "empty_secret",
            "the secret's value is empty — nothing was piped in, or the file is empty; nothing was changed (`env rm` deletes a variable)",
            pipe_it,
        ));
    }
    Ok(value)
}

fn read_text(path: Option<&str>) -> Result<String, Usage> {
    use std::io::Read as _;
    let mut text = String::new();
    match path {
        None | Some("-") => {
            std::io::stdin().read_to_string(&mut text).map_err(|e| {
                usage(
                    "unreadable_input",
                    format!("could not read stdin: {e}"),
                    None,
                )
            })?;
        }
        Some(path) => {
            text = std::fs::read_to_string(path).map_err(|e| {
                usage(
                    "unreadable_input",
                    format!("could not read {path}: {e}"),
                    None,
                )
            })?;
        }
    }
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    Ok(text)
}

/// A JSON object from a file, or from stdin for `-`.
fn read_json_object(path: &str) -> Result<Value, Usage> {
    let text = read_text(Some(path))?;
    let value: Value = serde_json::from_str(&text).map_err(|e| {
        usage(
            "invalid_json",
            format!("{path} is not valid JSON: {e}"),
            None,
        )
    })?;
    if !value.is_object() {
        return Err(usage(
            "invalid_json",
            format!("{path} must hold a JSON object"),
            None,
        ));
    }
    Ok(value)
}

/// `COL=VALUE` pairs → an object; a value that parses as JSON (a number,
/// true, null) is sent as that, anything else as text.
fn key_columns(pairs: &[String]) -> Result<Value, Usage> {
    let mut out = serde_json::Map::new();
    for pair in pairs {
        let (col, val) = pair.split_once('=').ok_or_else(|| {
            usage(
                "invalid_key",
                format!("--key takes COL=VALUE (got {pair:?})"),
                None,
            )
        })?;
        let val = serde_json::from_str::<Value>(val)
            .ok()
            .filter(|v| !v.is_object() && !v.is_array())
            .unwrap_or_else(|| json!(val));
        out.insert(col.trim().to_string(), val);
    }
    Ok(Value::Object(out))
}

fn cron_args(spec: &CronSpec) -> Result<Value, Usage> {
    let mut args = json!({
        "name": spec.name,
        "schedule": spec.schedule,
        "timezone": spec.tz,
        "method": spec.method,
        "path": spec.path,
        "timeoutMs": spec.timeout_ms,
    });
    if let Some(file) = &spec.file {
        let request = read_json_object(file)?;
        for key in ["headers", "body"] {
            if let Some(v) = request.get(key) {
                args[key] = v.clone();
            }
        }
    }
    Ok(args)
}

/// The action and arguments of a resource-group command.
fn group_body(action: &AppAction) -> Result<Option<(&'static str, Value)>, Usage> {
    Ok(Some(match action {
        AppAction::Checkout(g) => match &g.cmd {
            CheckoutCmd::Where => ("checkout_where", json!({})),
            CheckoutCmd::Clone => ("download", json!({})),
            CheckoutCmd::Reseed => ("reseed", json!({})),
            CheckoutCmd::Move { dir } => ("checkout_move", json!({ "dir": absolute(dir)? })),
            CheckoutCmd::Bind { dir } => ("checkout_bind", json!({ "dir": absolute(dir)? })),
        },
        AppAction::Files(g) => match &g.cmd {
            FilesCmd::Ls {
                prefix,
                recursive,
                cursor,
                limit,
            } => (
                "files_ls",
                json!({ "prefix": prefix, "recursive": recursive, "after": cursor, "limit": limit }),
            ),
            FilesCmd::Get { path, .. } => ("files_url", json!({ "path": path })),
            FilesCmd::Put {
                local,
                path,
                content_type,
            } => {
                let upload = Upload::check(local, path.as_deref(), content_type.as_deref())?;
                (
                    "files_sign_upload",
                    json!({ "path": upload.dest, "contentType": upload.content_type }),
                )
            }
            FilesCmd::Rm {
                path,
                recursive: true,
            } => ("files_rm_r", json!({ "prefix": path })),
            FilesCmd::Rm { path, .. } => ("files_rm", json!({ "path": path })),
            FilesCmd::Purge { yes } => ("files_purge", json!({ "confirm": yes })),
            FilesCmd::Usage { refresh } => ("files_usage", json!({ "refresh": refresh })),
            FilesCmd::Quota { bytes } => {
                let bytes =
                    match bytes.trim() {
                        "default" => Value::Null,
                        n => json!(n.parse::<u64>().ok().filter(|n| *n > 0).ok_or_else(|| {
                            usage(
                        "invalid_quota",
                        format!("quota takes a positive number of bytes or `default` (got {n:?})"),
                        Some("amuxd app files quota 1073741824".to_string()),
                    )
                        })?),
                    };
                ("files_quota", json!({ "bytes": bytes }))
            }
        },
        AppAction::Access(g) => match &g.cmd {
            AccessCmd::Ls => ("access_ls", json!({})),
            AccessCmd::Grant { who, level, org } => match (org, level) {
                (true, None) => ("access_grant", json!({ "org": true, "level": who })),
                (true, Some(_)) => {
                    return Err(usage(
                        "invalid_argument",
                        "with --org, give only the level",
                        Some("amuxd app access grant --org read".to_string()),
                    ))
                }
                (false, Some(level)) => ("access_grant", json!({ "who": who, "level": level })),
                (false, None) => {
                    return Err(usage(
                        "missing_level",
                        "access grant needs a level: read, write or admin",
                        Some(format!("amuxd app access grant {who} write")),
                    ))
                }
            },
            AccessCmd::Revoke { who, org } => ("access_revoke", json!({ "who": who, "org": org })),
        },
        AppAction::Gate(g) => match &g.cmd {
            GateCmd::Show => ("gate_show", json!({})),
            GateCmd::Set {
                mode,
                audience,
                scope,
                rules_file,
            } => {
                let rules = match rules_file {
                    Some(f) => {
                        let text = read_text(Some(f.as_str()).filter(|f| *f != "-"))?;
                        let rules: Value = serde_json::from_str(&text).map_err(|e| {
                            usage(
                                "invalid_json",
                                format!("--rules-file is not JSON: {e}"),
                                None,
                            )
                        })?;
                        if !rules.is_array() {
                            return Err(usage(
                                "invalid_rules",
                                "--rules-file holds a JSON array of {path, auth, audience?, roles?}",
                                None,
                            ));
                        }
                        Some(rules)
                    }
                    None => None,
                };
                (
                    "gate_set",
                    json!({ "mode": mode, "audience": audience, "scope": scope, "rules": rules }),
                )
            }
            GateCmd::Rule { cmd } => match cmd {
                GateRuleCmd::Add {
                    path,
                    auth,
                    audience,
                    roles,
                } => (
                    "gate_rule_add",
                    json!({ "path": path, "auth": auth, "audience": audience, "roles": roles }),
                ),
                GateRuleCmd::Rm { path } => ("gate_rule_rm", json!({ "path": path })),
            },
        },
        AppAction::Env(g) => match &g.cmd {
            EnvCmd::Ls => ("env_list", json!({})),
            EnvCmd::Set {
                key,
                value,
                secret,
                file,
            } => {
                let (value, secret) = match (value, secret) {
                    (Some(_), true) => {
                        return Err(usage(
                            "secret_on_command_line",
                            "a secret's value never goes on the command line — pipe it in or use --file",
                            Some(format!("printf %s \"$VALUE\" | amuxd app env set {key} --secret")),
                        ))
                    }
                    (Some(v), false) => (v.clone(), false),
                    (None, true) => (read_secret(file.as_ref().and_then(|p| p.to_str()), key)?, true),
                    (None, false) => {
                        return Err(usage(
                            "missing_value",
                            "env set needs --value V, or --secret with the value on stdin",
                            Some(format!("amuxd app env set {key} --value <value>")),
                        ))
                    }
                };
                (
                    "env_set",
                    json!({ "key": key, "value": value, "isSecret": secret }),
                )
            }
            EnvCmd::Rm { key } => ("env_delete", json!({ "key": key })),
        },
        AppAction::Cron(g) => match &g.cmd {
            CronCmd::Ls => ("cron_list", json!({})),
            CronCmd::Add(spec) => ("cron_create", cron_args(spec)?),
            CronCmd::Edit { job, spec } => {
                let mut args = cron_args(spec)?;
                args["job"] = json!(job);
                ("cron_update", args)
            }
            CronCmd::Enable { job } => ("cron_enable", json!({ "job": job })),
            CronCmd::Disable { job } => ("cron_disable", json!({ "job": job })),
            CronCmd::Run { job } => ("cron_run", json!({ "job": job })),
            CronCmd::Runs { job, limit } => ("cron_runs", json!({ "job": job, "limit": limit })),
            CronCmd::Rm { job } => ("cron_delete", json!({ "job": job })),
        },
        AppAction::Domain(g) => match &g.cmd {
            DomainCmd::Show => ("domain_show", json!({})),
            DomainCmd::Set { host } => ("domain_set", json!({ "domain": host })),
            DomainCmd::Verify => ("domain_verify", json!({})),
            DomainCmd::Rm => ("domain_remove", json!({})),
        },
        AppAction::Data(g) => match &g.cmd {
            DataCmd::Tables => ("data_tables", json!({})),
            DataCmd::Rows {
                table,
                filter,
                limit,
                cursor,
                desc,
            } => {
                let mut args = json!({
                    "table": table,
                    "limit": limit.unwrap_or(20),
                    "after": cursor,
                    "direction": if *desc { Some("desc") } else { None },
                });
                if let Some(parts) = filter {
                    args["filterColumn"] = json!(parts[0]);
                    args["filterOp"] = json!(parts[1]);
                    args["filterValue"] = json!(parts.get(2));
                }
                ("data_rows", args)
            }
            DataCmd::Insert { table, file } => (
                "data_insert",
                json!({ "table": table, "values": read_json_object(file)? }),
            ),
            DataCmd::Update { table, key, file } => (
                "data_update",
                json!({ "table": table, "key": key_columns(key)?, "patch": read_json_object(file)? }),
            ),
            DataCmd::Rm { table, key } => (
                "data_delete",
                json!({ "table": table, "key": key_columns(key)? }),
            ),
        },
        _ => return Ok(None),
    }))
}

/// The JSON body for one action.
fn request_body(action: &AppAction, cwd: Option<String>) -> Result<Value, Usage> {
    if let Some((name, args)) = group_body(action)? {
        let (id, app) = match action {
            AppAction::Checkout(g) => (&g.id, &g.app),
            AppAction::Files(g) => (&g.id, &g.app),
            AppAction::Access(g) => (&g.id, &g.app),
            AppAction::Gate(g) => (&g.id, &g.app),
            AppAction::Env(g) => (&g.id, &g.app),
            AppAction::Cron(g) => (&g.id, &g.app),
            AppAction::Domain(g) => (&g.id, &g.app),
            AppAction::Data(g) => (&g.id, &g.app),
            _ => unreachable!("group_body answered for a group"),
        };
        return Ok(json!({
            "action": name,
            "appId": id,
            "appName": app,
            "workspacePath": cwd,
            "args": args,
        }));
    }
    let target = |t: &AppTarget| {
        json!({
            "appId": t.id,
            "appName": t.app,
            "workspacePath": cwd,
        })
    };
    let mut body = match action {
        AppAction::Whoami | AppAction::List => json!({}),
        AppAction::Checkout(_)
        | AppAction::Files(_)
        | AppAction::Access(_)
        | AppAction::Gate(_)
        | AppAction::Env(_)
        | AppAction::Cron(_)
        | AppAction::Domain(_)
        | AppAction::Data(_) => {
            unreachable!("handled by group_body above")
        }
        AppAction::Status(t) | AppAction::Sessions(t) => target(t),
        AppAction::Reseed(_) => return Err(moved_command("reseed", "amuxd app checkout reseed")),
        AppAction::Download(_) => {
            return Err(moved_command("download", "amuxd app checkout clone"))
        }
        AppAction::Runtime {
            target: t,
            language,
        } => {
            let mut body = target(t);
            body["args"] = json!({ "language": language });
            body
        }
        AppAction::Update {
            target: t,
            name,
            app_type,
            old_visibility,
            old_auth_mode,
            old_auth_audience,
            old_auth_scope,
            old_auth_rules,
        } => {
            if let Some(v) = old_visibility {
                return Err(visibility_moved(v));
            }
            for (flag, set, new) in [
                (
                    "--auth-mode",
                    old_auth_mode.is_some(),
                    "amuxd app gate set --mode",
                ),
                (
                    "--auth-audience",
                    old_auth_audience.is_some(),
                    "amuxd app gate set --audience",
                ),
                (
                    "--auth-scope",
                    old_auth_scope.is_some(),
                    "amuxd app gate set --scope",
                ),
                (
                    "--auth-rules",
                    old_auth_rules.is_some(),
                    "amuxd app gate rule add|rm, or gate set --rules-file",
                ),
            ] {
                if set {
                    return Err(moved(flag, new));
                }
            }
            let mut body = target(t);
            body["name"] = json!(name);
            body["type"] = json!(app_type);
            body
        }
        AppAction::Undeploy { target: t, .. } => target(t),
        AppAction::Op { cmd } => match cmd {
            OpCmd::Status { op } => json!({ "action": "op_status", "args": { "op": op } }),
            OpCmd::Wait { op } => json!({ "action": "op_wait", "args": { "op": op } }),
            OpCmd::List { active } => json!({ "action": "op_list", "args": { "active": active } }),
        },
        AppAction::Delete { target: t, yes } => {
            let mut body = target(t);
            body["confirm"] = json!(yes);
            body
        }
        AppAction::Create {
            name,
            app_type,
            old_visibility,
            from_git,
            from_dir,
            no_checkout,
            old_name,
            old_git_remote,
            old_dir,
        } => {
            if old_name.is_some() {
                return Err(usage(
                    "renamed_argument",
                    "the name is now positional: amuxd app create <name>",
                    Some(format!(
                        "amuxd app create {:?}",
                        old_name.as_deref().unwrap_or("")
                    )),
                ));
            }
            if let Some(v) = old_visibility {
                return Err(visibility_moved(v));
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
                "gitRemoteUrl": from_git,
                "noCheckout": no_checkout,
                "localDir": local_dir,
            })
        }
        AppAction::Deploy {
            target: t,
            detach: _,
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
        AppAction::Runtime { .. } => "runtime",
        AppAction::Sessions(_) => "sessions",
        AppAction::Update { .. } => "update",
        AppAction::Undeploy { .. } => "undeploy",
        AppAction::Delete { .. } => "delete",
        AppAction::Deploy { .. } => "deploy",
        AppAction::Op { cmd } => match cmd {
            OpCmd::Status { .. } => "op_status",
            OpCmd::Wait { .. } => "op_wait",
            OpCmd::List { .. } => "op_list",
        },
        AppAction::Logs { .. } => "logs",
        AppAction::Checkout(_)
        | AppAction::Files(_)
        | AppAction::Access(_)
        | AppAction::Gate(_)
        | AppAction::Env(_)
        | AppAction::Cron(_)
        | AppAction::Domain(_)
        | AppAction::Data(_) => {
            unreachable!("a resource group's action comes from group_body")
        }
    }
}

/// A failure envelope built on this side of the daemon.
pub fn error_envelope(
    code: &str,
    message: &str,
    next: Option<&str>,
    exit: i32,
    retryable: bool,
) -> Value {
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
    envelope["error"]["exit"]
        .as_i64()
        .map(|n| n as i32)
        .unwrap_or(7)
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
    // A failure's message is capped too (a build's stderr can be huge), and
    // never dropped: the code, `next` and exit are what the caller acts on.
    if let Some(error) = envelope.get_mut("error") {
        truncated |= cap_fields(error);
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
    let mut out = json!({
        "v": 1,
        "ok": envelope["ok"],
        "truncated": true,
        "data_preview": preview,
        "next": "rerun with -o file:<path> for the full result, or narrow it (--limit, --since)",
    });
    if envelope["ok"] != true {
        // The contract's fields only (already capped above), so what is kept
        // cannot itself be what made the line too long.
        let e = &envelope["error"];
        let mut kept = serde_json::Map::new();
        for field in ["code", "message", "next", "retryable", "kind", "exit", "op"] {
            if let Some(v) = e.get(field) {
                kept.insert(field.to_string(), v.clone());
            }
        }
        out["error"] = Value::Object(kept);
        if let Some(o) = out.as_object_mut() {
            o.remove("data_preview");
        }
    }
    out.to_string()
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
    let rows = data.as_array().or_else(|| {
        data.as_object()
            .and_then(|m| m.values().find_map(Value::as_array))
    });
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
            out.push_str(
                &cols
                    .iter()
                    .map(|c| cell(&row[c]))
                    .collect::<Vec<_>>()
                    .join("\t"),
            );
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
                            error_envelope(
                                "output_unwritable",
                                &format!("could not write {path}: {e}"),
                                None,
                                2,
                                false
                            )
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

/// Every command's help in clap's compact layout: the paragraphs after the
/// first (details, permission, example) move into `after_help`.
///
/// A command with a long description makes clap lay out `--help` with each
/// option's text on its own line and blank lines between them — twice the
/// height for the same words, past the 15 lines §5 allows. `after_help`
/// shows the same text under both `-h` and `--help` without that.
pub fn compact_help(mut cmd: clap::Command) -> clap::Command {
    if let Some(long) = cmd.get_long_about().map(|s| s.to_string()) {
        if let Some((_, rest)) = long.split_once("\n\n") {
            cmd = cmd.after_help(rest.trim().to_string()).long_about(None);
        }
    }
    let names: Vec<String> = cmd
        .get_subcommands()
        .map(|c| c.get_name().to_string())
        .collect();
    for name in names {
        cmd = cmd.mut_subcommand(name, compact_help);
    }
    cmd
}

/// A command line clap could not parse. Under `amuxd app` the contract
/// still holds — one JSON line, exit 2 — because an agent parses it; help,
/// version and every other subcommand keep clap's own output.
pub fn exit_on_parse_error(e: clap::Error) -> ! {
    use clap::error::ErrorKind;
    let under_app = std::env::args().nth(1).as_deref() == Some("app");
    if !under_app
        || matches!(
            e.kind(),
            ErrorKind::DisplayHelp
                | ErrorKind::DisplayVersion
                | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
        )
    {
        e.exit();
    }
    let message = e.render().to_string();
    let mut lines = message.lines().filter(|l| !l.trim().is_empty());
    let mut first = lines
        .next()
        .unwrap_or("")
        .trim_start_matches("error: ")
        .to_string();
    // "the following required arguments were not provided:" names them on
    // the next line.
    if first.ends_with(':') {
        if let Some(what) = lines.next() {
            first = format!("{first} {}", what.trim());
        }
    }
    let next = match std::env::args().nth(2) {
        Some(sub) if !sub.starts_with('-') => format!("amuxd app {sub} --help"),
        _ => "amuxd app --help".to_string(),
    };
    println!(
        "{}",
        error_envelope("invalid_arguments", &first, Some(&next), 2, false)
    );
    std::process::exit(2);
}

/// Run one command; returns the process exit status.
/// A local file checked for `files put` before anything is signed.
#[derive(Debug)]
struct Upload {
    local: std::path::PathBuf,
    dest: String,
    content_type: String,
}

impl Upload {
    fn check(
        local: &std::path::Path,
        path: Option<&str>,
        content_type: Option<&str>,
    ) -> Result<Self, Usage> {
        let local =
            std::path::absolute(local).map_err(|e| usage("invalid_path", e.to_string(), None))?;
        let meta = std::fs::metadata(&local).map_err(|e| {
            usage(
                "unreadable_file",
                format!("cannot read {}: {e}", local.display()),
                None,
            )
        })?;
        if !meta.is_file() {
            return Err(usage(
                "not_a_file",
                format!("{} is not a file", local.display()),
                None,
            ));
        }
        if meta.len() > teamclu_apps::MAX_UPLOAD_BYTES {
            return Err(usage(
                "file_too_large",
                format!(
                    "{} is {} bytes; files put sends at most {}",
                    local.display(),
                    meta.len(),
                    teamclu_apps::MAX_UPLOAD_BYTES
                ),
                None,
            ));
        }
        let file_name = local
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| usage("invalid_path", "the local file has no usable name", None))?
            .to_string();
        Ok(Self {
            dest: teamclu_apps::upload_destination(path, &file_name),
            content_type: content_type
                .map(str::to_string)
                .unwrap_or_else(|| teamclu_apps::guess_content_type(&file_name).to_string()),
            local,
        })
    }
}

/// Where `files get --to` saves: a directory receives the file under its own
/// name; an existing file is refused rather than overwritten.
fn download_destination(to: &std::path::Path, remote: &str) -> Result<std::path::PathBuf, Value> {
    let mut dest = std::path::absolute(to)
        .map_err(|e| error_envelope("invalid_path", &e.to_string(), None, 2, false))?;
    if dest.is_dir() {
        let name = remote
            .rsplit('/')
            .find(|seg| !seg.is_empty())
            .ok_or_else(|| {
                error_envelope("invalid_path", "the path has no file name", None, 2, false)
            })?;
        dest = dest.join(name);
    }
    if dest.exists() {
        return Err(error_envelope(
            "destination_exists",
            &format!(
                "{} already exists — choose another --to, or remove it first",
                dest.display()
            ),
            None,
            6,
            false,
        ));
    }
    Ok(dest)
}

/// A transfer the storage refused or dropped. The signed URL is never quoted:
/// it carries the signature, and an error is what ends up in a transcript.
fn storage_failure(what: &str, detail: String) -> Value {
    error_envelope(
        "storage_failed",
        &format!("{what} failed: {detail}"),
        None,
        7,
        true,
    )
}

/// Stream a signed URL into `dest` through a sibling temp file, so a transfer
/// that fails halfway leaves nothing under the name that was asked for.
async fn fetch_to_file(url: &str, dest: &std::path::Path) -> Result<u64, Value> {
    use std::io::Write as _;
    let local = |e: std::io::Error, p: &std::path::Path| {
        error_envelope(
            "local_write_failed",
            &format!("cannot write {}: {e}", p.display()),
            None,
            7,
            false,
        )
    };
    let mut resp = reqwest::get(url)
        .await
        .map_err(|e| storage_failure("Download", e.without_url().to_string()))?;
    if !resp.status().is_success() {
        return Err(storage_failure(
            "Download",
            format!("storage answered HTTP {}", resp.status()),
        ));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| local(e, parent))?;
    }
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    let tmp = dest.with_file_name(format!(".{name}.part"));
    let mut file = std::fs::File::create(&tmp).map_err(|e| local(e, &tmp))?;
    let mut written = 0u64;
    let result: Result<(), Value> = async {
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| storage_failure("Download", e.without_url().to_string()))?
        {
            file.write_all(&chunk).map_err(|e| local(e, &tmp))?;
            written += chunk.len() as u64;
        }
        file.sync_all().map_err(|e| local(e, &tmp))
    }
    .await;
    drop(file);
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        local(e, dest)
    })?;
    Ok(written)
}

/// PUT the file to the signed URL. The content type was signed into it, so
/// the PUT carries exactly that; the length is explicit because an empty
/// body otherwise goes out without one and storage answers 411.
async fn put_file(url: &str, upload: &Upload) -> Result<u64, Value> {
    let bytes = std::fs::read(&upload.local).map_err(|e| {
        error_envelope(
            "unreadable_file",
            &format!("cannot read {}: {e}", upload.local.display()),
            None,
            2,
            false,
        )
    })?;
    let size = bytes.len() as u64;
    let resp = reqwest::Client::new()
        .put(url)
        .header(reqwest::header::CONTENT_TYPE, &upload.content_type)
        .header(reqwest::header::CONTENT_LENGTH, size)
        .body(bytes)
        .send()
        .await
        .map_err(|e| storage_failure("Upload", e.without_url().to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        return Err(storage_failure(
            "Upload",
            format!("storage answered HTTP {status}: {snippet}"),
        ));
    }
    Ok(size)
}

/// The data of a successful envelope, or the envelope itself to print.
fn ok_data(envelope: Value) -> Result<Value, Value> {
    if envelope["ok"] == true {
        Ok(envelope["data"].clone())
    } else {
        Err(envelope)
    }
}

fn success(data: Value) -> Value {
    json!({ "v": 1, "ok": true, "data": data })
}

/// How long one `op_wait` asks the daemon to hold the request.
const OP_WAIT_SECS: u64 = 25;

/// Whether a reply's data is an operation snapshot (`{op, state, …}`).
fn op_snapshot(envelope: &Value) -> Option<&Value> {
    let data = envelope.get("data")?;
    (envelope["ok"] == true && data["op"].is_string() && data["state"].is_string()).then_some(data)
}

/// An operation that ended, as the envelope of the command that started it:
/// the flow's own result or error, with the operation id added.
fn op_outcome(snap: &Value) -> Value {
    let op = snap["op"].clone();
    match snap["state"].as_str() {
        Some("succeeded") => {
            let mut data = snap["result"].clone();
            if let Some(obj) = data.as_object_mut() {
                obj.insert("op".into(), op);
            }
            success(data)
        }
        _ => {
            let mut error = snap["error"].clone();
            if !error.is_object() {
                error = error_envelope(
                    "outcome_unknown",
                    "the operation ended without saying how",
                    None,
                    8,
                    false,
                )["error"]
                    .clone();
            }
            error["op"] = op;
            json!({ "v": 1, "ok": false, "error": error })
        }
    }
}

/// Wait for a running operation to end, telling stderr it is still going.
async fn wait_op(daemon: &mut LocalDaemonClient, snap: Value) -> Value {
    let op = snap["op"].as_str().unwrap_or_default().to_string();
    let action = snap["action"].as_str().unwrap_or("operation").to_string();
    let mut snap = snap;
    while snap["state"] == "running" {
        eprintln!(
            "amuxd app: {action} {op} running ({}s) — safe to interrupt; `amuxd app op wait {op}` waits again",
            snap["elapsed_s"].as_i64().unwrap_or(0)
        );
        let ask = json!({ "action": "op_wait", "args": { "op": op, "timeoutS": OP_WAIT_SECS } });
        let mut reply = to_envelope(
            daemon
                .send(reqwest::Method::POST, "/v1/app-ops", Some(ask.clone()))
                .await,
        );
        // The session token is short-lived and a build is not: when it
        // expires mid-wait, trade the root token for a fresh one and ask
        // again, rather than reading the 401 as a daemon that went away.
        if reply["error"]["code"] == "daemon_unauthorized" {
            if let Ok(fresh) = LocalDaemonClient::connect("app-cli").await {
                *daemon = fresh;
                reply = to_envelope(
                    daemon
                        .send(reqwest::Method::POST, "/v1/app-ops", Some(ask))
                        .await,
                );
            }
        }
        match op_snapshot(&reply) {
            Some(next) => snap = next.clone(),
            // The daemon went away mid-wait: whatever it was doing stopped
            // with it, at a point nobody saw.
            None => {
                let mut e = error_envelope(
                    "outcome_unknown",
                    &format!(
                        "lost the daemon while waiting for {action} {op}: {}",
                        reply["error"]["message"].as_str().unwrap_or("no answer")
                    ),
                    Some(&format!("amuxd app op status {op}")),
                    8,
                    false,
                );
                e["error"]["op"] = json!(op);
                return e;
            }
        }
    }
    op_outcome(&snap)
}

/// `files get --to`: sign on the daemon, fetch here.
async fn files_get_to(daemon: &LocalDaemonClient, body: Value, dest: std::path::PathBuf) -> Value {
    let run = async {
        let signed = ok_data(to_envelope(
            daemon
                .send(reqwest::Method::POST, "/v1/app-ops", Some(body))
                .await,
        ))?;
        let url = signed["url"].as_str().ok_or_else(|| {
            error_envelope(
                "unexpected_response",
                "the daemon returned no download link",
                None,
                7,
                false,
            )
        })?;
        let bytes = fetch_to_file(url, &dest).await?;
        Ok::<_, Value>(success(json!({
            "action": "files_get",
            "app_id": signed["app_id"],
            "path": signed["path"],
            "saved_to": dest.display().to_string(),
            "bytes": bytes,
        })))
    };
    run.await.unwrap_or_else(|e| e)
}

/// `files put`: sign on the daemon, PUT from here, then tell the daemon it
/// landed.
async fn files_put(daemon: &LocalDaemonClient, body: Value, upload: Upload) -> Value {
    let run = async {
        let signed = ok_data(to_envelope(
            daemon
                .send(reqwest::Method::POST, "/v1/app-ops", Some(body.clone()))
                .await,
        ))?;
        let url = signed["url"].as_str().ok_or_else(|| {
            error_envelope(
                "unexpected_response",
                "the daemon returned no upload link",
                None,
                7,
                false,
            )
        })?;
        let bytes = put_file(url, &upload).await?;
        let mut done = body;
        done["action"] = json!("files_uploaded");
        // Only a notification: the file is already stored.
        let _ = daemon
            .send(reqwest::Method::POST, "/v1/app-ops", Some(done))
            .await;
        Ok::<_, Value>(success(json!({
            "action": "files_put",
            "app_id": signed["app_id"],
            "path": signed["path"],
            "bytes": bytes,
            "content_type": upload.content_type,
        })))
    };
    run.await.unwrap_or_else(|e| e)
}

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
    // The two transfers: the daemon signs, the bytes move here.
    let mut download = None;
    let mut upload = None;
    if let AppAction::Files(g) = &args.action {
        match &g.cmd {
            FilesCmd::Get { path, to: Some(to) } => match download_destination(to, path) {
                Ok(dest) => download = Some(dest),
                Err(envelope) => return Ok(emit(&args.output, envelope)),
            },
            FilesCmd::Put {
                local,
                path,
                content_type,
            } => {
                // Checked once already by request_body; it cannot fail now
                // unless the file changed in between.
                match Upload::check(local, path.as_deref(), content_type.as_deref()) {
                    Ok(u) => upload = Some(u),
                    Err(u) => {
                        return Ok(emit(
                            &args.output,
                            error_envelope(u.code, &u.message, u.next.as_deref(), 2, false),
                        ))
                    }
                }
            }
            _ => {}
        }
    }
    let rt = tokio::runtime::Runtime::new()?;
    let envelope = rt.block_on(async {
        let mut daemon = match LocalDaemonClient::connect("app-cli").await {
            Ok(d) => d,
            Err(e) => return to_envelope(Err(e)),
        };
        if let Some(dest) = download {
            return files_get_to(&daemon, body, dest).await;
        }
        if let Some(upload) = upload {
            return files_put(&daemon, body, upload).await;
        }
        let reply = to_envelope(
            daemon
                .send(reqwest::Method::POST, "/v1/app-ops", Some(body))
                .await,
        );
        let detach = matches!(
            args.action,
            AppAction::Deploy { detach: true, .. } | AppAction::Undeploy { detach: true, .. }
        );
        let waits = matches!(
            args.action,
            AppAction::Deploy { .. }
                | AppAction::Undeploy { .. }
                | AppAction::Op {
                    cmd: OpCmd::Wait { .. }
                }
        );
        match op_snapshot(&reply) {
            Some(snap) if waits && !(detach && snap["state"] == "running") => {
                wait_op(&mut daemon, snap.clone()).await
            }
            _ => reply,
        }
    });
    Ok(emit(&args.output, envelope))
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
        assert_eq!(
            body_of(&["deploy", "--move-domain"])["useAppCodeDomain"],
            true
        );
    }

    #[test]
    fn an_app_is_named_by_id_or_by_name_but_not_both() {
        assert_eq!(body_of(&["status", "--app", "记账"])["appName"], "记账");
        assert!(Harness::try_parse_from(["app", "status", "--id", "a1", "--app", "x"]).is_err());
    }

    #[test]
    fn update_keeps_name_and_type_and_points_moved_flags_to_their_groups() {
        let body = body_of(&["update", "--app", "记账", "--name", "账本"]);
        assert_eq!(body["action"], "update");
        assert_eq!(body["name"], "账本");
        assert!(body.get("visibility").is_none());
        let v = refusal(&["update", "--visibility", "team"]);
        assert_eq!(v.code, "moved_argument");
        assert_eq!(v.next.as_deref(), Some("amuxd app access grant --org read"));
        let r = refusal(&["update", "--auth-rules", "[]"]);
        assert!(r.next.unwrap().contains("gate rule"));
        assert_eq!(
            refusal(&["create", "x", "--visibility", "personal"])
                .next
                .as_deref(),
            Some("amuxd app access revoke --org")
        );
    }

    #[test]
    fn access_grants_one_actor_or_the_org() {
        let g = body_of(&["access", "grant", "王芳", "write", "--app", "记账"]);
        assert_eq!(g["action"], "access_grant");
        assert_eq!(g["appName"], "记账");
        assert_eq!(g["args"], json!({"who":"王芳","level":"write"}));
        let org = body_of(&["access", "grant", "--org", "read"]);
        assert_eq!(org["args"], json!({"org":true,"level":"read"}));
        assert_eq!(refusal(&["access", "grant", "王芳"]).code, "missing_level");
        assert_eq!(
            body_of(&["access", "revoke", "--org"])["args"],
            json!({"who":null,"org":true})
        );
        assert!(Harness::try_parse_from(["app", "access", "revoke"]).is_err());
    }

    #[test]
    fn gate_edits_fields_and_single_rules() {
        let set = body_of(&["gate", "set", "--mode", "platform"]);
        assert_eq!(set["action"], "gate_set");
        assert_eq!(set["args"]["mode"], "platform");
        assert_eq!(set["args"]["rules"], Value::Null);
        let add = body_of(&[
            "gate",
            "rule",
            "add",
            "/admin",
            "--auth",
            "required",
            "--roles",
            "finance,ops",
        ]);
        assert_eq!(add["action"], "gate_rule_add");
        assert_eq!(add["args"]["roles"], json!(["finance", "ops"]));
        assert_eq!(
            body_of(&["gate", "rule", "rm", "/legacy"])["args"],
            json!({"path":"/legacy"})
        );
    }

    #[test]
    fn files_commands_map_to_their_actions() {
        let ls = body_of(&["files", "ls", "uploads/", "-r", "--app", "记账"]);
        assert_eq!(ls["action"], "files_ls");
        assert_eq!(ls["args"]["recursive"], true);
        assert_eq!(
            body_of(&["files", "rm", "a/", "-r"])["action"],
            "files_rm_r"
        );
        assert_eq!(
            body_of(&["files", "rm", "a.txt"])["args"],
            json!({"path":"a.txt"})
        );
        assert_eq!(
            body_of(&["files", "purge", "--id", "a1"])["args"],
            json!({"confirm": false})
        );
        assert_eq!(
            body_of(&["files", "quota", "default"])["args"],
            json!({"bytes": null})
        );
        assert_eq!(refusal(&["files", "quota", "0"]).code, "invalid_quota");
        assert_eq!(
            body_of(&["files", "get", "a.txt", "--to", "/tmp/x"])["action"],
            "files_url"
        );
    }

    #[test]
    fn files_put_checks_the_local_file_before_signing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("logo.png");
        std::fs::write(&file, b"png").unwrap();
        let body = body_of(&["files", "put", file.to_str().unwrap(), "img/"]);
        assert_eq!(body["action"], "files_sign_upload");
        assert_eq!(
            body["args"],
            json!({"path":"img/logo.png","contentType":"image/png"})
        );
        let missing = dir.path().join("nope.png");
        assert_eq!(
            refusal(&["files", "put", missing.to_str().unwrap()]).code,
            "unreadable_file"
        );
        assert_eq!(
            refusal(&["files", "put", dir.path().to_str().unwrap()]).code,
            "not_a_file"
        );
    }

    #[test]
    fn a_download_never_overwrites_and_fills_in_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            download_destination(dir.path(), "reports/q3.csv").unwrap(),
            dir.path().join("q3.csv")
        );
        std::fs::write(dir.path().join("q3.csv"), b"x").unwrap();
        let e = download_destination(dir.path(), "reports/q3.csv").unwrap_err();
        assert_eq!(e["error"]["code"], "destination_exists");
        assert_eq!(e["error"]["exit"], 6);
    }

    /// A storage bucket that takes signed PUTs and serves GETs, recording the
    /// headers each PUT carried.
    async fn fake_storage() -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<(String, String, usize)>>>,
    ) {
        use axum::{body::Bytes, http::HeaderMap, http::StatusCode, routing::get, Router};
        let puts = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = puts.clone();
        let router = Router::new()
            .route(
                "/obj",
                get(|| async { Bytes::from_static(b"hello,csv") }).put(
                    move |headers: HeaderMap, body: Bytes| {
                        let seen = seen.clone();
                        async move {
                            let h =
                                |k: &str| headers.get(k).map(|v| v.to_str().unwrap().to_string());
                            let Some(length) = h("content-length") else {
                                return StatusCode::LENGTH_REQUIRED;
                            };
                            seen.lock().unwrap().push((
                                h("content-type").unwrap_or_default(),
                                length,
                                body.len(),
                            ));
                            StatusCode::OK
                        }
                    },
                ),
            )
            .route("/denied", get(|| async { StatusCode::FORBIDDEN }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (format!("http://{addr}"), puts)
    }

    #[tokio::test]
    async fn transfers_move_the_bytes_and_never_quote_the_signed_url() {
        let (base, puts) = fake_storage().await;
        let dir = tempfile::tempdir().unwrap();

        let dest = dir.path().join("q3.csv");
        assert_eq!(
            fetch_to_file(&format!("{base}/obj"), &dest).await.unwrap(),
            9
        );
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello,csv");

        let e = fetch_to_file(
            &format!("{base}/denied?Signature=secret"),
            &dir.path().join("x"),
        )
        .await
        .unwrap_err();
        assert_eq!(e["error"]["code"], "storage_failed");
        assert!(!e.to_string().contains("secret"), "{e}");
        assert!(!dir.path().join("x").exists() && !dir.path().join(".x.part").exists());

        let empty = dir.path().join("empty.txt");
        std::fs::write(&empty, b"").unwrap();
        let upload = Upload::check(&empty, None, None).unwrap();
        assert_eq!(put_file(&format!("{base}/obj"), &upload).await.unwrap(), 0);
        assert_eq!(
            puts.lock().unwrap().last().unwrap(),
            &("text/plain".to_string(), "0".to_string(), 0),
            "an empty file still carries its length"
        );
    }

    #[test]
    fn op_commands_and_detach_map_to_their_bodies() {
        assert_eq!(
            body_of(&["op", "wait", "op_1"]),
            json!({ "action": "op_wait", "args": { "op": "op_1" } })
        );
        assert_eq!(body_of(&["op", "list", "--active"])["args"]["active"], true);
        assert_eq!(body_of(&["deploy", "--detach"])["action"], "deploy");
        assert_eq!(
            body_of(&["undeploy", "--id", "a1", "--detach"])["appId"],
            "a1"
        );
    }

    #[test]
    fn an_ended_operation_answers_as_the_command_that_started_it() {
        let ok = op_outcome(&json!({
            "op": "op_1", "state": "succeeded", "result": { "action": "deploy", "url": "https://x" },
        }));
        assert_eq!(ok["data"]["url"], "https://x");
        assert_eq!(ok["data"]["op"], "op_1");
        assert_eq!(exit_of(&ok), 0);

        let failed = op_outcome(&json!({
            "op": "op_2", "state": "failed",
            "error": { "code": "deploy_locked", "exit": 6, "message": "busy" },
        }));
        assert_eq!(exit_of(&failed), 6);
        assert_eq!(failed["error"]["op"], "op_2");

        let unknown = op_outcome(&json!({
            "op": "op_3", "state": "unknown",
            "error": { "code": "daemon_restarted", "exit": 8, "message": "?" },
        }));
        assert_eq!(exit_of(&unknown), 8);
        assert!(op_snapshot(&json!({"ok":true,"data":{"op":"op_1","state":"running"}})).is_some());
        assert!(op_snapshot(&json!({"ok":true,"data":{"action":"deploy"}})).is_none());
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
            "app",
            "create",
            "x",
            "--from-dir",
            "/d",
            "--from-git",
            "u"
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
    fn a_group_names_its_app_before_or_after_the_verb() {
        let before = body_of(&["env", "--app", "记账", "ls"]);
        assert_eq!(before["action"], "env_list");
        assert_eq!(before["appName"], "记账");
        let after = body_of(&["cron", "runs", "nightly", "--limit", "5", "--id", "a1"]);
        assert_eq!(after["action"], "cron_runs");
        assert_eq!(after["appId"], "a1");
        assert_eq!(after["args"], json!({ "job": "nightly", "limit": 5 }));
        assert_eq!(
            body_of(&["domain", "set", "app.example.com"])["args"]["domain"],
            "app.example.com"
        );
    }

    #[test]
    fn a_secret_never_comes_from_the_command_line() {
        let u = refusal(&["env", "set", "STRIPE_KEY", "--secret", "--value", "sk_live"]);
        assert_eq!(u.code, "secret_on_command_line");
        assert!(u.next.unwrap().contains("--secret"));
        assert_eq!(refusal(&["env", "set", "K"]).code, "missing_value");
        let plain = body_of(&["env", "set", "PORT", "--value", "3000"]);
        assert_eq!(
            plain["args"],
            json!({ "key": "PORT", "value": "3000", "isSecret": false })
        );
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("secret");
        std::fs::write(&file, "sk_live\n").unwrap();
        let secret = body_of(&[
            "env",
            "set",
            "STRIPE_KEY",
            "--secret",
            "--file",
            file.to_str().unwrap(),
        ]);
        assert_eq!(secret["args"]["value"], "sk_live");
        assert_eq!(secret["args"]["isSecret"], true);
    }

    #[test]
    fn data_rows_take_a_filter_and_rows_are_addressed_by_their_key() {
        let rows = body_of(&[
            "data", "rows", "orders", "--where", "status", "eq", "paid", "--desc",
        ]);
        assert_eq!(rows["args"]["filterColumn"], "status");
        assert_eq!(rows["args"]["filterValue"], "paid");
        assert_eq!(rows["args"]["direction"], "desc");
        assert_eq!(rows["args"]["limit"], 20);
        let nulls = body_of(&["data", "rows", "orders", "--where", "paid_at", "isNull"]);
        assert_eq!(nulls["args"]["filterValue"], Value::Null);
        let rm = body_of(&[
            "data",
            "rm",
            "orders",
            "--key",
            "tenant=acme",
            "--key",
            "id=42",
        ]);
        assert_eq!(rm["args"]["key"], json!({ "tenant": "acme", "id": 42 }));
        assert_eq!(
            refusal(&["data", "rm", "orders", "--key", "id"]).code,
            "invalid_key"
        );
    }

    #[test]
    fn cron_edit_carries_only_the_fields_given_and_the_request_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("req.json");
        std::fs::write(
            &file,
            r#"{"headers":{"x-secret":"s"},"body":{"kind":"daily"}}"#,
        )
        .unwrap();
        let edit = body_of(&[
            "cron",
            "edit",
            "对账",
            "--tz",
            "Asia/Shanghai",
            "--file",
            file.to_str().unwrap(),
        ]);
        assert_eq!(edit["action"], "cron_update");
        assert_eq!(edit["args"]["job"], "对账");
        assert_eq!(edit["args"]["timezone"], "Asia/Shanghai");
        assert_eq!(edit["args"]["schedule"], Value::Null);
        assert_eq!(edit["args"]["headers"]["x-secret"], "s");
        assert_eq!(body_of(&["cron", "disable", "x"])["action"], "cron_disable");
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
        let rows: Vec<Value> = (0..200)
            .map(|i| json!({"i": i, "m": "y".repeat(1000)}))
            .collect();
        let huge = bounded(json!({"v":1,"ok":true,"data":rows}));
        assert!(huge.len() <= MAX_OUTPUT_BYTES);
        let v: Value = serde_json::from_str(&huge).unwrap();
        assert_eq!(v["truncated"], true);
        assert!(v["next"].as_str().unwrap().contains("-o file:"));
    }

    #[test]
    fn a_failure_is_capped_but_never_loses_its_error() {
        let long = bounded(error_envelope(
            "build_failed",
            &"e".repeat(5000),
            Some("amuxd app logs"),
            7,
            false,
        ));
        let v: Value = serde_json::from_str(&long).unwrap();
        assert!(v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("more bytes"));
        assert_eq!(v["error"]["code"], "build_failed");
        assert_eq!(v["error"]["exit"], 7);
        // Over the whole-output cap: still the error, not a preview of null.
        let mut huge = error_envelope("build_failed", "x", None, 7, false);
        huge["error"]["details"] = json!((0..200)
            .map(|i| json!({"i": i, "m": "y".repeat(1000)}))
            .collect::<Vec<_>>());
        let out = bounded(huge);
        assert!(out.len() <= MAX_OUTPUT_BYTES + 4096, "{}", out.len());
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["error"]["code"], "build_failed");
        assert!(v.get("data_preview").is_none());
        assert_eq!(exit_of(&v), 7);
    }

    #[test]
    fn an_empty_secret_is_refused_before_anything_is_sent() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty");
        std::fs::write(&empty, "\n").unwrap();
        let u = refusal(&[
            "env",
            "set",
            "STRIPE_KEY",
            "--secret",
            "--file",
            empty.to_str().unwrap(),
        ]);
        assert_eq!(u.code, "empty_secret");
        assert!(u.next.unwrap().contains("--secret"));
        let full = dir.path().join("full");
        std::fs::write(&full, "sk_live\n").unwrap();
        let body = body_of(&[
            "env",
            "set",
            "STRIPE_KEY",
            "--secret",
            "--file",
            full.to_str().unwrap(),
        ]);
        assert_eq!(body["args"]["value"], "sk_live");
    }

    #[test]
    fn a_table_is_columns_for_rows_and_lines_for_an_object() {
        let t = table(
            &json!({"v":1,"ok":true,"data":{"apps":[{"name":"a","id":"1"},{"name":"b","id":"2"}]}}),
        );
        assert_eq!(t.lines().count(), 3);
        assert!(t.starts_with("name\tid"));
        let e = table(
            &json!({"v":1,"ok":false,"error":{"code":"x","message":"m","next":"amuxd app list"}}),
        );
        assert!(e.contains("next: amuxd app list"));
    }
}

#[cfg(test)]
mod help_contract {
    //! CLI design §5 (C1): every command's `--help` is short — a sentence,
    //! the permission it needs, an example — and the group listing fits on
    //! one line per entry.

    use super::*;
    use clap::{CommandFactory, Parser};

    #[derive(Parser)]
    #[command(name = "amuxd app")]
    struct Cli {
        #[command(flatten)]
        args: AppArgs,
    }

    fn root() -> clap::Command {
        compact_help(Cli::command()).term_width(100)
    }

    /// What `amuxd app <path> --help` prints.
    fn help_of(path: &[String]) -> String {
        let argv = std::iter::once("amuxd app".to_string())
            .chain(path.iter().cloned())
            .chain(std::iter::once("--help".to_string()));
        match root().try_get_matches_from(argv) {
            Err(e) if e.kind() == clap::error::ErrorKind::DisplayHelp => e.render().to_string(),
            other => panic!("{path:?} --help did not print help: {other:?}"),
        }
    }

    /// Every visible leaf command as (path, its `--help`, visible options).
    fn leaves(cmd: &clap::Command, path: Vec<String>, out: &mut Vec<(String, String, usize)>) {
        let subs: Vec<&clap::Command> = cmd
            .get_subcommands()
            .filter(|c| !c.is_hide_set() && c.get_name() != "help")
            .collect();
        if subs.is_empty() {
            let options = cmd.get_arguments().filter(|a| !a.is_hide_set()).count();
            out.push((format!("app {}", path.join(" ")), help_of(&path), options));
            return;
        }
        for sub in subs {
            let mut next = path.clone();
            next.push(sub.get_name().to_string());
            leaves(sub, next, out);
        }
    }

    fn all() -> (clap::Command, Vec<(String, String, usize)>) {
        let mut cmd = root();
        cmd.build();
        let mut out = vec![];
        leaves(&cmd, vec![], &mut out);
        (cmd, out)
    }

    #[test]
    fn every_command_help_is_short_and_has_an_example() {
        let (_, leaves) = all();
        assert!(leaves.len() > 50, "{}", leaves.len());
        for (path, help, options) in &leaves {
            assert!(help.contains("Example"), "{path} has no example:\n{help}");
            for line in help.lines() {
                let t = line.trim();
                let bare = (t.starts_with('<') || t.starts_with('[')) && !t.contains("  ");
                assert!(!bare, "{path}: an argument without a description: {line:?}");
            }
            // One line per argument beyond -o/--id/--app/-h is allowed on top.
            // §5 allows 1–2 examples; the second costs its own paragraph.
            let examples = help.matches("Example:").count();
            assert!(examples <= 2, "{path}: {examples} examples");
            let budget = 15 + options.saturating_sub(4) + 2 * examples.saturating_sub(1);
            let lines = help.lines().count();
            assert!(lines <= budget, "{path}: {lines} lines > {budget}:\n{help}");
        }
    }

    #[test]
    fn the_top_level_lists_each_command_on_one_line() {
        let (mut cmd, _) = all();
        let help = cmd.render_help().to_string();
        for line in help.lines() {
            assert!(line.chars().count() <= 100, "wraps: {line}");
        }
        assert!(help.lines().count() <= 35, "{help}");
    }
}
