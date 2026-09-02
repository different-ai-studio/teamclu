pub mod channel;
pub mod clear;
pub mod config_cmd;
pub mod cursor_permission_hook;
pub mod doctor;
pub mod git_ssh;
pub mod install_opencode;
pub mod manage;
pub mod process;
pub mod remote_tools_mcp;
pub mod service;
pub mod setup;
pub mod sock;
pub mod team_secrets;
pub mod test_client;

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
    /// Test: spawn claude and print parsed events (for development)
    TestSpawn {
        /// Prompt to send
        prompt: String,
        /// Working directory
        #[arg(long, default_value = ".")]
        worktree: String,
    },
    /// Test: simulate an iOS client — connect to broker, send commands, watch events
    TestClient {
        /// Config file path (uses same daemon.toml)
        #[arg(long)]
        config: Option<std::path::PathBuf>,
        #[command(subcommand)]
        action: TestClientAction,
    },
    /// Manage channel bindings (discord, wecom, feishu, kook, wechat, email).
    Channel(ChannelArgs),
    /// Read and edit daemon.toml values by dotted key.
    Config(ConfigArgs),
    /// Manage team-share state for this daemon.
    Team(TeamArgs),
    /// Report install status of opencode / git / amuxd as JSON.
    Doctor,
    /// Download and install the opencode binary into ~/.amuxd/bin/opencode.
    InstallOpencode {
        /// Re-download the latest release even if opencode is already installed.
        #[arg(long)]
        force: bool,
    },
    /// Report installed vs newest-available opencode as JSON, for the
    /// Dependencies UI's "up to date / update available" state.
    OpencodeVersions,
    /// Install or upgrade the pi coding agent (npm/bun global install).
    InstallPi {
        /// Reinstall even if the locked version is already present.
        #[arg(long)]
        force: bool,
    },
    /// Register amuxd as a user-level background service (launchd / systemd-user / scheduled task) and start it.
    InstallService,
    /// Stop and remove the amuxd background service.
    UninstallService,
    /// Run the remote-tools MCP server on stdio. Proxies browser/client tools
    /// to the bound TeamClu client over MQTT RPC.
    RemoteToolsMcp(RemoteToolsMcpArgs),
    /// Cursor `preToolUse` hook. Spawned by `@cursor/sdk` per tool call;
    /// reads the hook request on stdin and prints an allow/deny decision.
    CursorPermissionHook(CursorPermissionHookArgs),
    /// The `ssh` git runs inside an app checkout. Set as `core.sshCommand` by
    /// seed/clone; fetches a JIT Gitea deploy key from the daemon per
    /// connection so an agent's plain `git push` works with nothing persisted.
    GitSsh(GitSshArgs),
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
    /// `--team-secret` decrypts the team's shared env vars (`_secrets/`) and
    /// encrypts OSS blobs. It is user-held and has no server-side copy, so a
    /// headless install can only be handed one here.
    Secrets(TeamSecretsArgs),
}

#[derive(Args, Debug)]
pub struct TeamSecretsArgs {
    #[command(subcommand)]
    pub action: TeamSecretsAction,
}

#[derive(Subcommand, Debug)]
pub enum TeamSecretsAction {
    /// Set one or more secrets. Omitted fields keep their stored value.
    /// Restart the daemon afterwards: the sync timer snapshots its workspace
    /// list at startup.
    Set {
        /// Team to write. Defaults to `team_id` from daemon.toml.
        #[arg(long)]
        team_id: Option<String>,
        /// Team secret, 64 hex chars. Decrypts the team's shared env vars and
        /// encrypts the blobs OSS sync uploads.
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
pub struct RemoteToolsMcpArgs {
    #[arg(long, default_value = "")]
    pub session_id: String,
    #[arg(long, default_value = "")]
    pub team_id: String,
    /// Member actor that owns the RPC topic (`amux/{team}/{id}/rpc/req`).
    #[arg(long, alias = "client-actor-id", default_value = "")]
    pub member_actor_id: String,
    #[arg(long)]
    pub sock: Option<std::path::PathBuf>,
}

#[derive(Args, Debug)]
pub struct CursorPermissionHookArgs {
    /// Worktree the calling agent runs in; used to resolve the session.
    #[arg(long, default_value = "")]
    pub worktree: String,
    #[arg(long)]
    pub sock: Option<std::path::PathBuf>,
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
