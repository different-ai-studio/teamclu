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
pub mod manage;
pub mod process;
pub mod role;
pub mod service;
pub mod setup;
pub mod skill;
pub mod sock;
pub mod team_secrets;
pub mod test_client;
pub mod update;

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
    /// Manage channel bindings (discord, wecom, feishu, kook, wechat, wechatpad, email).
    Channel(ChannelArgs),
    /// Read and edit daemon.toml values by dotted key.
    Config(ConfigArgs),
    /// Manage team-share state for this daemon.
    Team(TeamArgs),
    /// Create, deploy and manage TeamClu apps, as this daemon's agent account.
    ///
    /// One line of JSON on stdout: {"v":1,"ok":…}. Exit 0 ok, 2 arguments,
    /// 3 no identity, 4 not allowed, 5 not found or ambiguous, 6 conflict,
    /// 7 platform/daemon (see `retryable`), 8 outcome unknown — do not retry
    /// blindly. Needs `amuxd start` running.
    App(app::AppArgs),
    /// Scheduled jobs: list, create, pause, resume, delete, run now, runs.
    ///
    /// Same JSON contract as `amuxd app`. Jobs live in this daemon, which
    /// runs them unattended. Needs `amuxd start` running.
    Cron(cron::CronArgs),
    /// Personal skills (~/.agents/skills) and installed team Skill drafts.
    ///
    /// Same JSON contract as `amuxd app`. A skill is a folder: write it, then
    /// `create`/`update --from-dir`. Needs `amuxd start` running.
    Skill(skill::SkillArgs),
    /// This workspace's agent roles: list, create or replace from a ROLE.md,
    /// delete.
    ///
    /// Same JSON contract as `amuxd app`. Needs `amuxd start` running.
    Role(role::RoleArgs),
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
    /// Config file path. Defaults to `~/.amuxd/daemon.toml`.
    #[arg(long)]
    pub config: Option<PathBuf>,
    #[command(subcommand)]
    pub action: ConfigAction,
}

#[derive(Subcommand, Debug)]
pub enum ConfigAction {
    /// Print the config file path that would be used.
    Path,
    /// List all scalar config values as dotted keys.
    List,
    /// Print one config value by dotted key.
    Get { key: String },
    /// Set one config value by dotted key. Values are parsed as TOML literals;
    /// invalid literals are written as strings.
    Set { key: String, value: String },
    /// Remove one config value by dotted key.
    Unset { key: String },
}

#[derive(Args, Debug)]
pub struct TeamArgs {
    #[command(subcommand)]
    pub action: TeamAction,
}

#[derive(Subcommand, Debug)]
pub enum TeamAction {
    /// Provision the secrets a headless daemon cannot obtain on its own.
    ///
    /// `--team-secret` seals this machine's copy of the team's secrets and
    /// decrypts team files uploaded before sync switched to plaintext
    /// (ADR-0008). Sync itself does not need it. It is user-held and has no
    /// server-side copy, so a headless install can only be handed one here.
    Secrets(TeamSecretsArgs),
    /// Sync the team's shared folder (knowledge, documents) now: upload local
    /// changes, download remote ones, and report what happened.
    ///
    /// One line of JSON, like `amuxd app`. Needs `amuxd start` running.
    ///
    /// Example: amuxd team sync
    Sync {
        /// json (default), table, or file:<path>.
        #[arg(
            short = 'o',
            long = "output",
            default_value = "json",
            hide_default_value = true
        )]
        output: String,
    },
}

#[derive(Args, Debug)]
pub struct TeamSecretsArgs {
    #[command(subcommand)]
    pub action: TeamSecretsAction,
}

#[derive(Subcommand, Debug)]
pub enum TeamSecretsAction {
    /// Set one or more secrets. Omitted fields keep their stored value.
    /// Restart the daemon afterwards so it picks the new value up.
    Set {
        /// Team to write. Defaults to `team_id` from daemon.toml.
        #[arg(long)]
        team_id: Option<String>,
        /// Team secret, 64 hex chars. Seals the local secrets file and
        /// decrypts team files uploaded before sync switched to plaintext.
        #[arg(long, alias = "oss-secret")]
        team_secret: Option<String>,
    },
    /// Show which secrets are set. Values are masked.
    Show {
        #[arg(long)]
        team_id: Option<String>,
    },
    /// Remove all stored secrets for a team.
    Clear {
        #[arg(long)]
        team_id: Option<String>,
        /// Skip the interactive confirmation prompt.
        #[arg(long)]
        force: bool,
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
    #[command(subcommand)]
    pub action: ChannelAction,
}

#[derive(Subcommand, Debug)]
pub enum ChannelAction {
    /// List all channels and their enabled state.
    List,
    /// Bind a channel (per-platform credentials).
    Bind(ChannelBindArgs),
    /// Remove a channel binding.
    Unbind { platform: String },
    /// Verify channel credentials are configured.
    Test { platform: String },
    /// Signal a running amuxd to re-read channel config.
    Reload,
    /// One channel's settings as JSON (or every channel's), for agents.
    ///
    /// From the team's team.toml, which holds no credentials: `secretsSet`
    /// names the credentials that are stored. Same JSON contract as
    /// `amuxd app`.
    ///
    /// Example: amuxd channel show wecom
    Show {
        /// discord, wecom, feishu, kook, wechat, wechatpad, email, seatalk.
        platform: Option<String>,
        /// json (default), table, or file:<path>.
        #[arg(
            short = 'o',
            long = "output",
            default_value = "json",
            hide_default_value = true
        )]
        output: String,
    },
    /// Change a channel's settings, for agents: a JSON object of fields is
    /// merged over the current ones and saved by the running daemon, which
    /// reloads the channel.
    ///
    /// Credentials go in the same object; they are stored encrypted, never in
    /// team.toml. Pass the object on stdin (`--config-file -`) so a secret
    /// never sits on a command line. `{"enabled": false}` turns a channel
    /// off. Field names are those `amuxd channel show` prints.
    ///
    /// Example: echo '{"enabled":true}' | amuxd channel set wecom --config-file -
    Set {
        platform: String,
        /// JSON object of fields to change (`-` for stdin).
        #[arg(long)]
        config_file: String,
        /// json (default), table, or file:<path>.
        #[arg(
            short = 'o',
            long = "output",
            default_value = "json",
            hide_default_value = true
        )]
        output: String,
    },
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
