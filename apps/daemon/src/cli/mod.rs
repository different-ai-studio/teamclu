pub mod app;
pub mod channel;
pub mod clear;
pub mod config_cmd;
pub mod cron;
pub mod daemon_http;
pub mod doctor;
pub mod envelope;
pub mod git_account;
pub mod git_credential;
pub mod git_ssh;
pub mod knowledge;
pub mod manage;
pub mod member;
pub mod process;
pub mod role;
pub mod service;
pub mod session;
pub mod setup;
pub mod skill;
pub mod sock;
pub mod team_secrets;
pub mod test_client;
pub mod update;
pub mod workspace;

use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "amuxd", version, about = "AMUX Agent Multiplexer Daemon")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Start the daemon (writes ~/.amuxd/amuxd.pid while running).
    Start {
        /// Accepted and ignored: `start` always runs in the foreground and
        /// leaves backgrounding to whatever launched it (the desktop app, a
        /// service manager, `nohup`). Kept so older scripts still parse.
        #[arg(short, long)]
        daemonize: bool,
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Stop the running daemon (SIGTERM via pidfile).
    Stop,
    /// Show daemon status (reads the pidfile).
    Status,
    /// Onboard this daemon. Without args, walks you through the iOS side
    Init {
        /// `teamclu://invite?token=...` URL from the iOS Actors tab.
        join_url: Option<String>,
    },
    /// Interactive headless configuration (LLM providers + team share secrets).
    ///
    /// For onboarding, use `amuxd init`. This menu covers the settings that are
    /// otherwise easiest from the desktop app or the browser setup UI.
    Manage,
    /// Print the setup URL for a running daemon, and open it by default.
    ///
    /// The browser UI covers onboarding and every daemon setting, so a fresh
    /// install needs no `config`/`channel` flags. Requires `amuxd start` to be
    /// running — the URL is its loopback listener.
    Setup {
        /// Print the URL instead of opening a browser (for headless hosts).
        #[arg(long)]
        print_only: bool,
    },
    /// Delete local daemon state (daemon.toml, members.toml, sessions.toml,
    /// backend.toml, workspaces.toml). Use before running `init` against a
    /// different team or after revoking access.
    Clear {
        /// Skip the interactive confirmation prompt.
        #[arg(long)]
        force: bool,
    },
    /// Test: simulate an iOS client — connect to broker, send commands, watch events
    TestClient {
        /// Config file path (uses same daemon.toml)
        #[arg(long)]
        config: Option<std::path::PathBuf>,
        #[command(subcommand)]
        action: TestClientAction,
    },
    /// Channel bindings (discord, wecom, feishu, kook, wechat, wechatpad, email, seatalk): ls, show, set, rm, test, reload.
    Channel(ChannelArgs),
    /// daemon.toml and team.toml values by dotted key: ls, show, set, rm.
    Config(ConfigArgs),
    /// Team share: sync now, and the secrets a headless daemon needs.
    Team(TeamArgs),
    /// Create, deploy and manage TeamClu apps, as this daemon's agent account.
    ///
    /// One line of JSON on stdout: {"v":1,"ok":…}. Exit 0 ok, 2 arguments,
    /// 3 no identity, 4 not allowed, 5 not found or ambiguous, 6 conflict,
    /// 7 platform/daemon (see `retryable`), 8 outcome unknown — do not retry
    /// blindly. Needs `amuxd start` running.
    App(app::AppArgs),
    /// Scheduled jobs: ls, create, enable, disable, rm, run now, runs.
    ///
    /// Same JSON contract as `amuxd app`. Jobs live in this daemon, which
    /// runs them unattended. Needs `amuxd start` running.
    Cron(cron::CronArgs),
    /// Personal skills (~/.agents/skills) and installed team Skill drafts.
    ///
    /// Same JSON contract as `amuxd app`. A skill is a folder: write it, then
    /// `create`/`update --from-dir`. Needs `amuxd start` running.
    Skill(skill::SkillArgs),
    /// This workspace's agent roles: ls, set (create or replace from a
    /// ROLE.md), rm.
    ///
    /// Same JSON contract as `amuxd app`. Needs `amuxd start` running.
    Role(role::RoleArgs),
    /// The team's conversations: list, read, open, post, archive, seats.
    ///
    /// Same JSON contract as `amuxd app`, as this daemon's agent account.
    /// Needs `amuxd start` running.
    Session(session::SessionArgs),
    /// The team's people and agents, by id or name.
    ///
    /// Same JSON contract as `amuxd app`. Needs `amuxd start` running.
    Member(member::MemberArgs),
    /// This machine's workspaces and their runtimes: status, reload,
    /// diagnose, models, MCP tools (read-only).
    ///
    /// Same JSON contract as `amuxd app`. Needs `amuxd start` running.
    Workspace(workspace::WorkspaceArgs),
    /// The team's knowledge vault: search, read, and the review inbox.
    ///
    /// Same JSON contract as `amuxd app`. Needs `amuxd start` running.
    Knowledge(knowledge::KnowledgeArgs),
    /// Report install status of amuxd / the managed Node / pi / git as JSON.
    Doctor,
    /// Install or repair the managed pi runtime: the pinned Node.js, then pi
    /// and the MCP SDK on it (`npm ci` in <amuxd cache>/pi).
    InstallPi {
        /// Reinstall even if the locked version is already present.
        #[arg(long)]
        force: bool,
    },
    /// Register amuxd as a user-level background service (launchd / systemd-user / scheduled task) and start it.
    InstallService,
    /// Stop and remove the amuxd background service.
    UninstallService,
    /// Replace the standalone amuxd (`<amuxd home>/bin/amuxd`) with the latest
    /// build on its release channel, then restart the service. A running
    /// daemon also checks by itself; `[update] auto = false` turns that off.
    Update {
        /// Only report the current and the latest version.
        #[arg(long)]
        check: bool,
        /// Reinstall even when already on the channel's version.
        #[arg(long)]
        force: bool,
        /// Replace the binary but leave the running daemon alone.
        #[arg(long)]
        no_restart: bool,
    },
    /// The `ssh` git runs inside an app checkout. Set as `core.sshCommand` by
    /// seed/clone; fetches a JIT Gitea deploy key from the daemon per
    /// connection so an agent's plain `git push` works with nothing persisted.
    GitSsh(GitSshArgs),
    /// The credential helper git runs inside an app checkout reached over
    /// http(s). Set as `credential.helper` by clone; answers git's `get` with
    /// the token stored for the app, so an agent's plain `git pull` works with
    /// nothing persisted.
    GitCredential(GitCredentialArgs),
}

#[derive(Args, Debug)]
pub struct ConfigArgs {
    /// json (default), table, or file:<path>.
    #[arg(
        short = 'o',
        long = "output",
        global = true,
        default_value = "json",
        hide_default_value = true
    )]
    pub output: String,
    /// Config file path. Defaults to `~/.amuxd/daemon.toml`.
    #[arg(long, global = true)]
    pub config: Option<PathBuf>,
    #[command(subcommand)]
    pub action: ConfigAction,
}

#[derive(Subcommand, Debug)]
pub enum ConfigAction {
    /// The config file path that would be used.
    Path,
    /// Every scalar value by dotted key (daemon.toml and the team's
    /// team.toml). Credentials show as "(set)"; `show <key>` reads one.
    ///
    /// Example: amuxd config ls -o table
    #[command(alias = "list")]
    Ls,
    /// One value by dotted key.
    ///
    /// Example: amuxd config show update.auto
    #[command(alias = "get")]
    Show { key: String },
    /// Set one value by dotted key. Values are parsed as TOML literals;
    /// invalid literals are written as strings.
    ///
    /// Example: amuxd config set update.auto false
    Set { key: String, value: String },
    /// Remove one value by dotted key.
    ///
    /// Example: amuxd config rm update.channel
    #[command(alias = "unset")]
    Rm { key: String },
}

#[derive(Args, Debug)]
pub struct TeamArgs {
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
    pub action: TeamAction,
}

#[derive(Subcommand, Debug)]
pub enum TeamAction {
    /// Provision the secrets a headless daemon cannot obtain on its own.
    ///
    /// The team secret seals this machine's copy of the team's secrets and
    /// decrypts team files uploaded before sync switched to plaintext
    /// (ADR-0008). Sync itself does not need it. It is user-held and has no
    /// server-side copy, so a headless install can only be handed one here.
    #[command(subcommand)]
    Secrets(TeamSecretsAction),
    /// Sync the team's shared folder (knowledge, documents) now: upload local
    /// changes, download remote ones, and report what happened.
    ///
    /// Needs `amuxd start` running.
    ///
    /// Example: amuxd team sync
    Sync,
}

#[derive(Subcommand, Debug)]
pub enum TeamSecretsAction {
    /// Set the team secret (64 hex chars), read from a file or stdin so it
    /// never sits on a command line. Restart the daemon afterwards.
    ///
    /// Example: printf %s "$SECRET" | amuxd team secrets set --team-secret-file -
    Set {
        /// Team to write. Defaults to `team_id` from daemon.toml.
        #[arg(long)]
        team_id: Option<String>,
        /// File holding the team secret (`-` for stdin).
        #[arg(long, conflicts_with = "team_secret")]
        team_secret_file: Option<String>,
        /// The secret itself. Kept for old scripts; prefer --team-secret-file.
        #[arg(long, alias = "oss-secret", hide = true)]
        team_secret: Option<String>,
    },
    /// Which secrets are set. Values are masked.
    ///
    /// Example: amuxd team secrets show
    Show {
        #[arg(long)]
        team_id: Option<String>,
    },
    /// Remove all stored secrets for a team.
    ///
    /// Example: amuxd team secrets rm --yes
    #[command(alias = "clear")]
    Rm {
        #[arg(long)]
        team_id: Option<String>,
        /// Required: this cannot be undone.
        #[arg(long, alias = "force")]
        yes: bool,
    },
}

#[derive(Args, Debug)]
pub struct GitSshArgs {
    /// App whose repo this connection is for. Baked into `core.sshCommand`.
    #[arg(long)]
    pub app: String,
    #[arg(long)]
    pub sock: Option<std::path::PathBuf>,
    /// git's own ssh arguments — host, `-o` flags, and the remote command.
    /// `trailing_var_arg` keeps git's leading `-o`/`-p` flags from being
    /// parsed as ours.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    pub args: Vec<String>,
}

#[derive(Args, Debug)]
pub struct GitCredentialArgs {
    /// App whose repo git is asking about (an imported http(s) repo's stored
    /// token). Without it: per-account git for the TeamClu git host — the
    /// agent's or the person's own identity (see `cli::git_account`).
    #[arg(long)]
    pub app: Option<String>,
    /// Brand whose desktop wrote the person's git token. Baked in for a
    /// white-label brand; git runs the helper with no brand in its environment.
    #[arg(long)]
    pub brand: Option<String>,
    #[arg(long)]
    pub sock: Option<std::path::PathBuf>,
    /// `get`, `store` or `erase` — appended by git.
    pub operation: String,
}

#[derive(Args, Debug)]
pub struct ChannelArgs {
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
    pub action: ChannelAction,
}

#[derive(Subcommand, Debug)]
pub enum ChannelAction {
    /// Every channel: enabled or not, which credentials are stored.
    ///
    /// Example: amuxd channel ls -o table
    #[command(alias = "list")]
    Ls,
    /// One channel's settings (or every channel's), from the team's
    /// team.toml. It holds no credentials: `secretsSet` names the stored ones.
    ///
    /// Example: amuxd channel show wecom
    Show {
        /// discord, wecom, feishu, kook, wechat, wechatpad, email, seatalk.
        platform: Option<String>,
    },
    /// Change a channel's settings: a JSON object of fields is merged over
    /// the current ones and saved by the running daemon, which reloads it.
    ///
    /// Credentials go in the same object; they are stored encrypted, never in
    /// team.toml. Pass it on stdin (`--config-file -`) so a secret never sits
    /// on a command line. `{"enabled": false}` turns a channel off. Field
    /// names are those `amuxd channel show` prints.
    ///
    /// Example: echo '{"enabled":true}' | amuxd channel set wecom --config-file -
    Set {
        platform: String,
        /// JSON object of fields to change (`-` for stdin).
        #[arg(long)]
        config_file: String,
    },
    /// Remove a channel: its settings and its stored credentials.
    ///
    /// Example: amuxd channel rm kook
    #[command(alias = "unbind")]
    Rm { platform: String },
    /// Whether a channel is configured and enabled, and which credentials
    /// are stored.
    ///
    /// Example: amuxd channel test wecom
    Test { platform: String },
    /// Make the running daemon re-read its channel config.
    ///
    /// Example: amuxd channel reload
    Reload,
    /// Old spelling of `set` with per-platform flags (secrets on the command
    /// line). Use `set --config-file -`.
    #[command(hide = true)]
    Bind(ChannelBindArgs),
}

#[derive(Args, Debug)]
pub struct ChannelBindArgs {
    #[command(subcommand)]
    pub platform: ChannelBindPlatform,
}

#[derive(Subcommand, Debug)]
pub enum ChannelBindPlatform {
    /// Bind a Discord bot.
    Discord {
        #[arg(long)]
        bot_token: String,
        #[arg(long)]
        default_username: Option<String>,
    },
    /// Bind a WeCom bot.
    Wecom {
        #[arg(long)]
        bot_id: String,
        #[arg(long)]
        secret: String,
        #[arg(long)]
        encoding_aes_key: Option<String>,
    },
    /// Bind a Feishu app.
    Feishu {
        #[arg(long)]
        app_id: String,
        #[arg(long)]
        app_secret: String,
    },
    /// Bind a Kook bot.
    Kook {
        #[arg(long)]
        bot_token: String,
    },
    /// Bind a WeChat (iLink) account.
    Wechat {
        #[arg(long)]
        ilink_account: String,
        #[arg(long)]
        ilink_token: String,
    },
    /// Bind an Email (IMAP/SMTP) channel.
    Email {
        #[arg(long)]
        imap_host: String,
        #[arg(long)]
        imap_port: u16,
        #[arg(long)]
        imap_user: String,
        #[arg(long)]
        imap_pass: String,
        #[arg(long)]
        smtp_host: String,
        #[arg(long)]
        smtp_port: u16,
        #[arg(long)]
        smtp_user: String,
        #[arg(long)]
        smtp_pass: String,
    },
    /// Bind a SeaTalk Open Platform bot.
    Seatalk {
        #[arg(long)]
        app_id: String,
        #[arg(long)]
        app_secret: String,
    },
}

#[derive(Subcommand)]
pub enum TestClientAction {
    /// Watch all events from the daemon (subscribe to all topics)
    Watch,
    /// Send a StartAgent command
    StartAgent { worktree: String, prompt: String },
    /// Send a PeerAnnounce (authenticate with token)
    Announce { token: String },
    /// Full E2E: announce → start agent → watch events (single connection)
    E2e {
        token: String,
        worktree: String,
        prompt: String,
    },
}
