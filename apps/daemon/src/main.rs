mod agent_discover;
mod backend;
mod channels;
mod claude_install;
mod cli;
mod collab;
mod config;
mod cursor_install;
mod daemon;
mod device_id;
mod error;
mod history;
mod http;
mod logging;
mod mcp_probe;
mod mqtt;
mod nats;
mod onboarding;
mod opencode_install;
mod opencode_settings;
mod pi_install;
mod proto;
mod provider_config;
mod remote_tools;
mod runtime;
mod service;
mod sync;
mod team_link;
mod team_shared_env;
mod teamclu;
#[cfg(test)]
mod test_brand_env;
#[cfg(test)]
mod workspace_meta_gate;

use clap::Parser;
use cli::{Cli, Commands, TestClientAction};

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Setup { print_only } => {
            cli::setup::run(print_only)?;
        }
        Commands::Init { join_url } => {
            // A CLI-first machine must not have its freshly written config
            // eaten later: the v1 purge deletes root `daemon.toml`, and the v2
            // file init writes sits at the same path. Running the purge (and
            // its marker) here, before anything is written, closes that
            // window. Skipped when a daemon holds the lock — a running v2
            // daemon already purged at its own boot.
            if let Ok(_lock) = cli::process::acquire_daemon_lock_at(
                &config::DaemonConfig::lock_path(),
                std::time::Duration::ZERO,
            ) {
                config::layout::purge_v1_layout();
                config::layout::ensure();
            }
            let url = match join_url {
                Some(u) => u,
                None => prompt_for_invite_url()?,
            };
            let rt = tokio::runtime::Runtime::new()?;
            let outcome = rt.block_on(onboarding::init::run(&url, None))?;
            println!(
                "\n✓ Daemon onboarded.\n  actor_id      = {}\n  team_id       = {}\n  display_name  = {}\n  backend.toml  = {}\n\nNext: `amuxd start`",
                outcome.actor_id,
                outcome.team_id,
                outcome.display_name,
                outcome.config_path.display()
            );
        }
        Commands::Manage => {
            cli::manage::run()?;
        }
        Commands::Clear { force } => {
            cli::clear::run(force)?;
        }
        Commands::Team(args) => {
            cli::team_secrets::run(args)?;
        }
        Commands::Start {
            daemonize: _,
            config,
        } => {
            let config_path = config.unwrap_or_else(config::DaemonConfig::default_path);

            // Tracing goes to `logs/amuxd.log`, size-capped, no matter how the
            // daemon was launched — managed spawn, launchd, or a terminal. The
            // stdout/stderr redirects the launchers keep pointing at this
            // directory only catch what tracing cannot (panics, child output),
            // so they stay small instead of growing without bound. A terminal
            // additionally gets the log on stdout.
            let (log_max_bytes, log_keep) = logging::settings_from(&config_path);
            let file_log = logging::RotatingLog::new(
                config::layout::logs_dir().join("amuxd.log"),
                log_max_bytes,
                log_keep,
            );
            {
                use std::io::IsTerminal;
                use tracing_subscriber::layer::SubscriberExt;
                use tracing_subscriber::util::SubscriberInitExt;
                let registry = tracing_subscriber::registry()
                    .with(
                        tracing_subscriber::EnvFilter::from_default_env()
                            .add_directive("amuxd=info".parse().unwrap())
                            // Without its own directive the gateway crate matches
                            // nothing and every warn! it emits — inbound attachment
                            // failures included — is discarded before it reaches a file.
                            .add_directive("teamclu_gateway=info".parse().unwrap())
                            // Child-process output is emitted under its own target
                            // (`warn!(target: "pi_rpc", ...)`), which matches none
                            // of the directives above — and `from_default_env`
                            // defaults to ERROR, so every one of these lines was
                            // dropped in a packaged build. They are the ONLY record
                            // of why a runtime child died: a pi host that fails to
                            // boot writes its stack to stderr and nothing at all to
                            // stdout.
                            .add_directive("pi_rpc=info".parse().unwrap())
                            .add_directive("opencode_serve=info".parse().unwrap())
                            .add_directive("cursor_bridge=info".parse().unwrap())
                            .add_directive("claude_bridge=info".parse().unwrap()),
                    )
                    .with(
                        tracing_subscriber::fmt::layer()
                            .with_ansi(false)
                            .with_writer(file_log),
                    );
                if std::io::stdout().is_terminal() {
                    registry.with(tracing_subscriber::fmt::layer()).init();
                } else {
                    registry.init();
                }
            }

            // The lock comes first because the two calls under it rewrite the
            // home directory, and `purge_v1_layout` in particular deletes the
            // root `daemon.toml` — the v1 config sits at the exact path the v2
            // one does, so the purge has to happen before anything loads it or
            // it would delete a config that had just been bootstrapped.
            let _daemon_lock = cli::process::acquire_daemon_lock()?;
            cli::process::prepare_daemon_start();
            config::layout::purge_v1_layout();
            config::layout::ensure();
            // App checkouts moved out of `state/` and into `teams/<id>/apps`.
            // Done here, at boot, and never from the path accessor: the deploy
            // pipeline builds whatever sits at the new path, so a checkout left
            // behind would keep shipping the seed template.
            http::apps::migrate_legacy_apps_root();
            cli::process::write_pidfile()?;
            let _pid_guard = PidfileGuard;
            // Absent config bootstraps rather than failing: a fresh install must
            // be able to start and serve the setup UI that configures it.
            let mut daemon_config = config::DaemonConfig::load_or_bootstrap(&config_path)?;
            // The team half (channels / team_share / local_agent) lives in
            // teams/<id>/state/team.toml; daemon.toml only points there. An
            // unreadable team.toml must not stop the daemon booting (the HTTP
            // control plane is how the operator fixes it), so warn and run on
            // defaults — the file is left untouched for repair.
            if let Err(e) = config::team_config::hydrate(&mut daemon_config) {
                tracing::warn!(error = %e, "team.toml unreadable; running with default team config");
            }
            // Boot is the moment "which runtime does this team run here" is
            // decided, and the only caller that should write an answer down —
            // the other `hydrate` callers are readers (status, channel reload).
            if let Err(e) = config::team_config::seed_local_agent_if_unset(&mut daemon_config) {
                tracing::warn!(error = %e, "could not seed team local_agent; keeping the default");
            }
            if let Err(e) = agent_discover::discover_and_persist(&mut daemon_config, &config_path) {
                tracing::warn!("agent auto-discovery failed: {e}");
            }

            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
                let server = daemon::DaemonServer::new(daemon_config, &config_path).await?;
                // run() owns the shutdown signal so it can gracefully tear
                // down channels (consuming `ChannelManager::shutdown(self)`)
                // before returning. Dropping the run() future mid-loop via
                // an external select would skip that teardown.
                server.run(shutdown_signal()).await
            })?;
        }
        Commands::InstallService => {
            cli::service::install()?;
        }
        Commands::UninstallService => {
            cli::service::uninstall()?;
        }
        Commands::Stop => {
            cli::process::run_stop()?;
        }
        Commands::Status => {
            cli::process::run_status()?;
        }
        Commands::TestSpawn { prompt, worktree } => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::from_default_env()
                        .add_directive("amuxd=debug".parse().unwrap()),
                )
                .init();

            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
                let (tx, mut rx) = tokio::sync::mpsc::channel(256);
                let binary = "opencode".to_string();
                println!(
                    "Spawning opencode agent: {} with prompt \"{}\" in {}",
                    binary, prompt, worktree
                );

                let (startup_tx, _startup_rx) = tokio::sync::oneshot::channel::<
                    Result<runtime::adapter::AcpStartupMetadata, String>,
                >();
                let _cmd_tx = runtime::adapter::start_standalone_runtime(
                    binary,
                    Vec::new(),
                    worktree.clone(),
                    prompt.clone(),
                    proto::amux::AgentType::Opencode,
                    tx,
                    None,
                    startup_tx,
                    None,
                    None,
                    std::collections::HashMap::new(),
                )?;

                println!("--- Streaming events (Ctrl+C to stop) ---\n");
                let mut count = 0u32;
                while let Some(frame) = rx.recv().await {
                    count += 1;
                    match &frame.event.event {
                        Some(proto::amux::acp_event::Event::Output(o)) => {
                            print!("{}", o.text);
                        }
                        Some(proto::amux::acp_event::Event::Thinking(t)) => {
                            println!(
                                "\n[THINKING] {}",
                                if t.text.len() > 100 {
                                    &t.text[..100]
                                } else {
                                    &t.text
                                }
                            );
                        }
                        Some(proto::amux::acp_event::Event::ToolUse(tu)) => {
                            println!("\n[TOOL] {} ({})", tu.tool_name, tu.tool_id);
                        }
                        Some(proto::amux::acp_event::Event::ToolResult(tr)) => {
                            println!(
                                "[TOOL RESULT] success={} summary={}",
                                tr.success,
                                if tr.summary.len() > 80 {
                                    &tr.summary[..80]
                                } else {
                                    &tr.summary
                                }
                            );
                        }
                        Some(proto::amux::acp_event::Event::StatusChange(sc)) => {
                            println!("\n[STATUS] {:?} -> {:?}", sc.old_status, sc.new_status);
                        }
                        Some(proto::amux::acp_event::Event::Error(e)) => {
                            println!("\n[ERROR] {}", e.message);
                        }
                        _ => {
                            println!("\n[OTHER EVENT]");
                        }
                    }
                }

                println!("\n\n--- Done. {} events received ---", count);
                Ok::<(), anyhow::Error>(())
            })?;
        }
        Commands::Doctor => {
            cli::doctor::run()?;
        }
        Commands::InstallOpencode { force } => {
            cli::install_opencode::run(force)?;
        }
        Commands::OpencodeVersions => {
            cli::install_opencode::print_versions();
        }
        Commands::InstallPi { force } => {
            pi_install::run_install(force)?;
        }
        Commands::Channel(args) => {
            let path = config::DaemonConfig::default_path();
            cli::channel::run(args, &path)?;
        }
        Commands::Config(args) => {
            let path = config::DaemonConfig::default_path();
            cli::config_cmd::run(args, &path)?;
        }
        Commands::RemoteToolsMcp(args) => {
            let sock = args
                .sock
                .clone()
                .unwrap_or_else(config::DaemonConfig::sock_path);
            let _ = (&args.session_id, &args.team_id, &args.member_actor_id);
            cli::remote_tools_mcp::run(&sock)?;
        }
        Commands::CursorPermissionHook(args) => {
            let sock = args
                .sock
                .clone()
                .unwrap_or_else(config::DaemonConfig::sock_path);
            cli::cursor_permission_hook::run(&sock, &args.worktree)?;
        }
        Commands::TestClient { config, action } => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::from_default_env()
                        .add_directive("amuxd=info".parse().unwrap()),
                )
                .init();

            let config_path = config.unwrap_or_else(config::DaemonConfig::default_path);
            let mut daemon_config = config::DaemonConfig::load(&config_path)?;
            if let Err(e) = agent_discover::discover_and_persist(&mut daemon_config, &config_path) {
                tracing::warn!("agent auto-discovery failed: {e}");
            }

            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
                match action {
                    TestClientAction::Watch => cli::test_client::run_watch(daemon_config).await?,
                    TestClientAction::StartAgent { worktree, prompt } => {
                        cli::test_client::run_start_agent(daemon_config, &worktree, &prompt)
                            .await?;
                    }
                    TestClientAction::Announce { token } => {
                        cli::test_client::run_announce(daemon_config, &token).await?;
                    }
                    TestClientAction::E2e {
                        token,
                        worktree,
                        prompt,
                    } => {
                        cli::test_client::run_e2e(daemon_config, &token, &worktree, &prompt)
                            .await?;
                    }
                }
                Ok::<(), anyhow::Error>(())
            })?;
        }
    }

    Ok(())
}

/// RAII guard: removes the pidfile when the daemon's main scope exits
/// (either from a clean shutdown or a panic that unwinds main).
struct PidfileGuard;
impl Drop for PidfileGuard {
    fn drop(&mut self) {
        cli::process::remove_pidfile();
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("install SIGINT handler");
    tokio::select! {
        _ = term.recv() => {},
        _ = int.recv()  => {},
    }
}

/// Windows: Ctrl-C / console-close. Service-style stops arrive as the
/// `shutdown` control command instead (SockCommand::Shutdown in the run loop).
#[cfg(windows)]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

/// Print onboarding instructions and block on stdin for the deeplink the
/// user copies from the iOS app's Actors tab.
fn prompt_for_invite_url() -> anyhow::Result<String> {
    use std::io::{BufRead, Write};

    println!("amuxd onboarding — register this daemon as an agent on your TeamClu team.");
    println!();
    println!("  1. Install the AMUX iOS app and sign in.");
    println!("  2. Create a team (if you haven't already).");
    println!("  3. Open the Actors tab → tap the + icon in the top right.");
    println!("  4. Pick kind = Agent, set a display name, tap Confirm.");
    println!("  5. Copy the generated `teamclu://invite?...` deeplink.");
    println!();
    print!("Paste the deeplink here (or Ctrl-C to abort): ");
    std::io::stdout().flush()?;

    let stdin = std::io::stdin();
    let mut line = String::new();
    stdin.lock().read_line(&mut line)?;
    let trimmed: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    if trimmed.is_empty() {
        anyhow::bail!("no deeplink provided");
    }
    Ok(trimmed)
}
