//! `amuxd manage` — interactive headless configuration (LLM + team share).
//!
//! Uses dialoguer menus/forms so a server without a GUI or browser can configure
//! the same stores the desktop setup UI writes to.

use std::path::{Path, PathBuf};

use dialoguer::{theme::ColorfulTheme, Confirm, Input, Password, Select};
use serde::{de::DeserializeOwned, Deserialize};

use crate::backend::TeamSkillRow;
use crate::config::{
    encode_workspace_path, DaemonConfig, OpenCodeCompatStore, ProviderAuthRequest,
    ProviderModelConfig, WorkspaceControlStore,
};
use crate::sync::oss::state::LocalSyncState;
use crate::sync::secret_store::{mask_secret, validate_team_secret, SecretStore, TeamSecrets};

/// One cloud-registered workspace that exists on this machine (same filter as
/// `GET /v1/workspaces`).
#[derive(Debug, Clone, Deserialize)]
struct RegisteredWorkspace {
    path: PathBuf,
    display_name: String,
    is_default: bool,
    #[allow(dead_code)]
    workspace_id: String,
}

/// Small loopback client for the running daemon's management surface.
/// Cloud credentials stay owned by that process; this CLI only holds a
/// short-lived local session token.
struct ManageDaemonClient {
    client: reqwest::Client,
    base: String,
    session_token: String,
}

impl ManageDaemonClient {
    async fn connect() -> anyhow::Result<Self> {
        let port_path = DaemonConfig::http_port_path();
        let token_path = DaemonConfig::http_token_path();
        let port = std::fs::read_to_string(&port_path)
            .map_err(|e| {
                anyhow::anyhow!("read {} ({e}). Is the daemon running?", port_path.display())
            })?
            .trim()
            .to_string();
        let root_token = std::fs::read_to_string(&token_path)
            .map_err(|e| anyhow::anyhow!("read {} ({e})", token_path.display()))?
            .trim()
            .to_string();
        if port.is_empty() || root_token.is_empty() {
            anyhow::bail!("daemon HTTP control files are empty; restart amuxd");
        }

        let client = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{port}");
        let exchange: serde_json::Value = client
            .post(format!("{base}/v1/auth/exchange"))
            .bearer_auth(&root_token)
            .json(&serde_json::json!({
                "scopes": ["workspace:read", "workspace:write"],
                "ttl_seconds": 300,
                "label": "manage-cli",
            }))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("connect to running daemon: {e}"))?
            .error_for_status()
            .map_err(|e| anyhow::anyhow!("authenticate to running daemon: {e}"))?
            .json()
            .await?;
        let session_token = exchange["token"]
            .as_str()
            .filter(|token| !token.is_empty())
            .ok_or_else(|| anyhow::anyhow!("daemon auth response missing token"))?
            .to_string();

        Ok(Self {
            client,
            base,
            session_token,
        })
    }

    async fn json<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> anyhow::Result<T> {
        let mut request = self
            .client
            .request(method, format!("{}{}", self.base, path))
            .bearer_auth(&self.session_token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("daemon request {path}: {e}"))?;
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            let detail = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|body| body["detail"].as_str().map(str::to_owned))
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned());
            anyhow::bail!("daemon request {path} returned {status}: {detail}");
        }
        serde_json::from_slice(&bytes)
            .map_err(|e| anyhow::anyhow!("decode daemon response {path}: {e}"))
    }
}

pub fn run() -> anyhow::Result<()> {
    let theme = ColorfulTheme::default();
    loop {
        println!();
        print_header();
        let choice = Select::with_theme(&theme)
            .with_prompt("Choose an action")
            .items(&[
                "Status overview",
                "Agent runtime (pi)",
                "LLM provider",
                "Team share secrets",
                "Team skills",
                "Sync status / trigger",
                "Quit",
            ])
            .default(0)
            .interact()?;

        match choice {
            0 => show_status()?,
            1 => agent_runtime_menu(&theme)?,
            2 => llm_menu(&theme)?,
            3 => team_secrets_menu(&theme)?,
            4 => team_skills_menu(&theme)?,
            5 => sync_menu(&theme)?,
            _ => break,
        }
    }
    Ok(())
}

fn print_header() {
    println!("amuxd manage — headless daemon configuration");
    println!("Onboarding stays on `amuxd init`; use this for agent runtime, LLM + team share.");
}

fn show_status() -> anyhow::Result<()> {
    let config_path = DaemonConfig::default_path();
    let onboarded = match DaemonConfig::load(&config_path) {
        Ok(cfg) => {
            println!("Onboarded: yes");
            if let Some(team) = cfg.team_id.as_deref() {
                println!("  team_id:  {team}");
                // The identity lives with the team's credentials, not in
                // daemon.toml — that file only points at the team directory.
                match crate::provider_config::ProviderConfig::load_from_path(
                    &crate::provider_config::ProviderConfig::path_for_team(team),
                ) {
                    Ok(crate::provider_config::ProviderConfig::CloudApi(cloud)) => {
                        println!("  actor_id: {}", cloud.actor_id);
                    }
                    Err(e) => println!("  actor_id: (backend.toml unreadable: {e})"),
                }
            }
            println!("  actor name: {}", cfg.actor.name);
            true
        }
        Err(e) => {
            println!("Onboarded: no ({e})");
            false
        }
    };

    match daemon_pid() {
        Some(pid) => println!("Daemon:    running (pid {pid})"),
        None => println!("Daemon:    not running"),
    }

    let doctor = crate::cli::doctor::report();
    println!(
        "pi:        {} ({}, node {})",
        if doctor.pi.satisfied {
            "ready"
        } else {
            "missing"
        },
        doctor.pi.version.as_deref().unwrap_or("(not installed)"),
        doctor.node.version.as_deref().unwrap_or("(not installed)")
    );
    println!(
        "git:       {} ({})",
        if doctor.git.present {
            "ready"
        } else {
            "missing"
        },
        doctor.git.version.as_deref().unwrap_or("(not installed)")
    );

    if onboarded {
        match fetch_registered_workspaces() {
            Ok(workspaces) if workspaces.is_empty() => {
                println!("Workspaces: none registered on this machine (add one in Desktop → Daemon → Workspace)");
            }
            Ok(workspaces) => {
                println!("Registered workspaces:");
                for w in &workspaces {
                    let tag = if w.is_default { " [default]" } else { "" };
                    println!("  - {}{}: {}", w.display_name, tag, w.path.display());
                    print_workspace_llm_summary(&w.path, "    ");
                }
            }
            Err(e) => println!("Workspaces: could not load from cloud ({e})"),
        }

        if let Ok(team_id) = resolve_team_id(None) {
            let secrets = SecretStore::new();
            if let Ok(s) = secrets.load(&team_id) {
                println!(
                    "Team secret:    {}",
                    mask_secret(s.oss_team_secret.as_deref())
                );
            }
        }
    }

    Ok(())
}

fn agent_runtime_menu(theme: &ColorfulTheme) -> anyhow::Result<()> {
    loop {
        print_agent_runtime_status();

        let choice = Select::with_theme(theme)
            .with_prompt("Agent runtime")
            .items(&["Refresh status", "Install / repair pi", "Back"])
            .default(0)
            .interact()?;

        match choice {
            0 => continue,
            1 => install_pi_interactive(theme)?,
            _ => break,
        }
    }
    Ok(())
}

fn print_agent_runtime_status() {
    println!();
    let doctor = crate::cli::doctor::report();
    print_component_status(
        "Node.js (managed)",
        doctor.node.present,
        doctor.node.version.as_deref(),
        doctor.node.path.as_deref(),
    );
    if !doctor.node.satisfied {
        println!(
            "  required Node.js version: {}",
            doctor.node.required_version
        );
    }
    print_component_status(
        "pi",
        doctor.pi.present,
        doctor.pi.version.as_deref(),
        doctor.pi.path.as_deref(),
    );
    if !doctor.pi.satisfied {
        println!("  required pi version: {}", doctor.pi.required_version);
        println!(
            "  MCP SDK: {} (required {})",
            doctor.pi.mcp_sdk_version.as_deref().unwrap_or("(missing)"),
            doctor.pi.required_mcp_sdk_version
        );
    }
    print_component_status(
        "git",
        doctor.git.present,
        doctor.git.version.as_deref(),
        None,
    );
    println!();
}

fn print_component_status(name: &str, present: bool, version: Option<&str>, path: Option<&str>) {
    let state = if present { "ready" } else { "missing" };
    let ver = version.unwrap_or("(not installed)");
    match path {
        Some(p) => println!("{name}: {state} ({ver}) @ {p}"),
        None => println!("{name}: {state} ({ver})"),
    }
}

fn install_pi_interactive(theme: &ColorfulTheme) -> anyhow::Result<()> {
    let pi = crate::pi_install::doctor();
    let force = if pi.present {
        Confirm::with_theme(theme)
            .with_prompt("pi is already installed — reinstall / upgrade to the required version?")
            .default(false)
            .interact()?
    } else {
        println!("pi is not installed — installing the managed Node.js and pi…");
        false
    };
    crate::pi_install::run_install(force)?;
    let after = crate::pi_install::doctor();
    if after.satisfied {
        println!(
            "✓ pi {} ready on Node.js {}.",
            after.required_version, after.required_node_version
        );
        println!("  Restart the daemon if it is already running.");
    } else {
        println!("pi install finished but version check did not pass — run `amuxd doctor`.");
    }
    Ok(())
}

fn llm_menu(theme: &ColorfulTheme) -> anyhow::Result<()> {
    let workspace = pick_workspace(theme)?;
    let ws_id = encode_workspace_path(&workspace)?;
    let store = OpenCodeCompatStore::new();

    loop {
        let choice = Select::with_theme(theme)
            .with_prompt(format!("LLM · {}", workspace.display()))
            .items(&[
                "List providers",
                "Add / update provider",
                "Remove provider",
                "Set default model",
                "Back",
            ])
            .default(0)
            .interact()?;

        match choice {
            0 => {
                let providers = store.get_providers(&ws_id)?;
                if providers.is_empty() {
                    println!("No providers configured.");
                } else {
                    for p in providers {
                        println!(
                            "{} · {} · {} · models [{}]",
                            p.id,
                            p.display_name,
                            if p.authenticated { "key set" } else { "no key" },
                            p.models.join(", ")
                        );
                    }
                }
                if let Some(model) = read_default_model(&workspace)? {
                    println!("Default model: {model}");
                }
            }
            1 => {
                let provider_id: String = Input::with_theme(theme)
                    .with_prompt("Provider ID (e.g. selfhost)")
                    .interact_text()?;
                let provider_id = provider_id.trim().to_string();
                if provider_id.is_empty() {
                    anyhow::bail!("provider ID must not be empty");
                }

                let display_name: String = Input::with_theme(theme)
                    .with_prompt("Display name")
                    .default(provider_id.clone())
                    .interact_text()?;
                let base_url: String = Input::with_theme(theme)
                    .with_prompt("Base URL (OpenAI-compatible)")
                    .interact_text()?;
                let api_key = Password::with_theme(theme)
                    .with_prompt("API key")
                    .interact()?;
                let models_raw: String = Input::with_theme(theme)
                    .with_prompt("Model IDs (comma-separated)")
                    .interact_text()?;

                let models: Vec<ProviderModelConfig> = models_raw
                    .split(',')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .map(|id| ProviderModelConfig {
                        model_id: id.to_owned(),
                        model_name: None,
                    })
                    .collect();
                if models.is_empty() {
                    anyhow::bail!("at least one model ID is required");
                }

                let outcome = store.put_provider_auth(
                    &ws_id,
                    &provider_id,
                    ProviderAuthRequest {
                        api_key,
                        base_url: Some(base_url),
                        display_name: Some(display_name),
                        models,
                    },
                )?;
                println!("✓ Provider '{provider_id}' saved ({outcome:?}).");
                if matches!(outcome, crate::config::ApplyOutcome::RestartRequired) {
                    println!("  Restart the daemon (`amuxd stop && amuxd start`) to pick up LLM changes.");
                }
            }
            2 => {
                let providers = store.get_providers(&ws_id)?;
                if providers.is_empty() {
                    println!("No providers to remove.");
                    continue;
                }
                let labels: Vec<String> = providers.iter().map(|p| p.id.clone()).collect();
                let idx = Select::with_theme(theme)
                    .with_prompt("Remove which provider?")
                    .items(&labels)
                    .interact()?;
                let id = &labels[idx];
                if Confirm::with_theme(theme)
                    .with_prompt(format!("Remove provider '{id}'?"))
                    .default(false)
                    .interact()?
                {
                    store.delete_provider_auth(&ws_id, id)?;
                    println!("✓ Removed '{id}'.");
                }
            }
            3 => {
                let providers = store.get_providers(&ws_id)?;
                if providers.is_empty() {
                    println!("Configure a provider first.");
                    continue;
                }
                let mut options: Vec<String> = Vec::new();
                for p in &providers {
                    for m in &p.models {
                        options.push(format!("{}/{}", p.id, m));
                    }
                }
                if options.is_empty() {
                    println!("No models on configured providers.");
                    continue;
                }
                let idx = Select::with_theme(theme)
                    .with_prompt("Default model")
                    .items(&options)
                    .interact()?;
                set_default_model(&workspace, &options[idx])?;
                println!("✓ Default model set to {}.", options[idx]);
            }
            _ => break,
        }
    }
    Ok(())
}

fn team_secrets_menu(theme: &ColorfulTheme) -> anyhow::Result<()> {
    let team_id = resolve_team_id(None)?;
    let store = SecretStore::new();
    let current = store.load(&team_id).unwrap_or_default();

    println!("Team: {team_id}");
    println!(
        "  team_secret:    {}",
        mask_secret(current.oss_team_secret.as_deref())
    );
    println!();
    println!("Leave a field blank to keep the stored value.");

    let team_secret = prompt_optional_secret(theme, "Team secret (64 hex chars)")?;
    if let Some(ref s) = team_secret {
        validate_team_secret(s).map_err(|e| anyhow::anyhow!("team secret: {e}"))?;
    }

    if team_secret.is_none() {
        println!("Nothing to save.");
        return Ok(());
    }

    let incoming = TeamSecrets {
        oss_team_secret: team_secret,
        user_jwt: None,
        channel_secrets: Default::default(),
    };
    store
        .merge(&team_id, &incoming)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("✓ Secrets updated for team {team_id}.");
    println!("  Restart the daemon so the sync timer picks up workspace changes.");

    Ok(())
}

/// Manage the skills assigned to this daemon's own agent actor.
///
/// Unlike the Desktop UI, a headless daemon never selects another actor: its
/// Cloud API credential is the hosted agent identity, so all installs land on
/// this machine and are materialised under its daemon-owned cloud cache.
fn team_skills_menu(theme: &ColorfulTheme) -> anyhow::Result<()> {
    loop {
        let (team_id, skills) = fetch_team_skills()?;
        println!("Team: {team_id}");
        if skills.is_empty() {
            println!("  No skills have been published to this team's registry.");
        } else {
            println!("  Registry skills (for this daemon):");
            for skill in &skills {
                let installed = match skill.installed_version {
                    Some(version) if version == skill.latest_version => {
                        format!("installed v{version}")
                    }
                    Some(version) => format!(
                        "installed v{version}; update available v{}",
                        skill.latest_version
                    ),
                    None => "not installed".to_string(),
                };
                println!(
                    "  - {} (latest v{}; {installed})",
                    skill.slug, skill.latest_version
                );
            }
        }

        let choice = Select::with_theme(theme)
            .with_prompt("Team skills")
            .items(&[
                "Refresh registry",
                "Install a skill on this daemon",
                "Sync installed skills now",
                "Back",
            ])
            .default(0)
            .interact()?;

        match choice {
            0 => continue,
            1 => install_team_skill_interactive(theme, &team_id, &skills)?,
            2 => sync_team_skills_now(&team_id)?,
            _ => break,
        }
    }
    Ok(())
}

fn install_team_skill_interactive(
    theme: &ColorfulTheme,
    team_id: &str,
    skills: &[TeamSkillRow],
) -> anyhow::Result<()> {
    let available: Vec<&TeamSkillRow> = skills.iter().filter(|skill| !skill.installed).collect();
    if available.is_empty() {
        println!("All published team skills are already assigned to this daemon.");
        return Ok(());
    }
    let labels: Vec<String> = available
        .iter()
        .map(|skill| {
            let summary = skill.summary.trim();
            if summary.is_empty() {
                format!("{} (v{})", skill.slug, skill.latest_version)
            } else {
                format!("{} (v{}) — {summary}", skill.slug, skill.latest_version)
            }
        })
        .collect();
    let idx = Select::with_theme(theme)
        .with_prompt("Install on this daemon")
        .items(&labels)
        .interact()?;
    let skill = available[idx];
    let version = skill.latest_version.max(1);
    if !Confirm::with_theme(theme)
        .with_prompt(format!(
            "Assign {} v{version} to this daemon and download it now?",
            skill.slug
        ))
        .default(true)
        .interact()?
    {
        return Ok(());
    }

    let outcome = install_and_sync_team_skill(team_id, &skill.slug, version)?;
    println!("✓ {} is assigned to this daemon.", skill.slug);
    print_team_skill_sync_outcome(outcome);
    Ok(())
}

fn sync_team_skills_now(team_id: &str) -> anyhow::Result<()> {
    let outcome = reconcile_team_skills(team_id)?;
    print_team_skill_sync_outcome(outcome);
    Ok(())
}

fn print_team_skill_sync_outcome(outcome: crate::runtime::team_skills::TeamSkillReconcileOutcome) {
    if outcome.changed() {
        println!(
            "✓ Team skills synced: installed {}, removed {}.",
            outcome.installed, outcome.removed
        );
        println!("  New agent sessions will discover the updated skill set.");
    } else {
        println!("✓ Team skills are already current.");
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpTeamSkillsResponse {
    team_id: String,
    skills: Vec<TeamSkillRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpTeamSkillReconcileResponse {
    team_id: String,
    #[serde(flatten)]
    outcome: crate::runtime::team_skills::TeamSkillReconcileOutcome,
}

fn fetch_team_skills() -> anyhow::Result<(String, Vec<TeamSkillRow>)> {
    tokio::runtime::Runtime::new()?.block_on(async {
        let daemon = ManageDaemonClient::connect().await?;
        let response: HttpTeamSkillsResponse = daemon
            .json(reqwest::Method::GET, "/v1/team/skills", None)
            .await?;
        Ok((response.team_id, response.skills))
    })
}

fn install_and_sync_team_skill(
    team_id: &str,
    slug: &str,
    version: i64,
) -> anyhow::Result<crate::runtime::team_skills::TeamSkillReconcileOutcome> {
    tokio::runtime::Runtime::new()?.block_on(async {
        let daemon = ManageDaemonClient::connect().await?;
        let path = format!("/v1/team/skills/{slug}/install");
        let response: HttpTeamSkillReconcileResponse = daemon
            .json(
                reqwest::Method::PUT,
                &path,
                Some(serde_json::json!({ "version": version })),
            )
            .await?;
        if response.team_id != team_id {
            anyhow::bail!("daemon is bound to a different team");
        }
        Ok(response.outcome)
    })
}

fn reconcile_team_skills(
    team_id: &str,
) -> anyhow::Result<crate::runtime::team_skills::TeamSkillReconcileOutcome> {
    tokio::runtime::Runtime::new()?.block_on(async {
        let daemon = ManageDaemonClient::connect().await?;
        let response: HttpTeamSkillReconcileResponse = daemon
            .json(reqwest::Method::POST, "/v1/team/skills/reconcile", None)
            .await?;
        if response.team_id != team_id {
            anyhow::bail!("daemon is bound to a different team");
        }
        Ok(response.outcome)
    })
}

fn sync_menu(theme: &ColorfulTheme) -> anyhow::Result<()> {
    let config_path = DaemonConfig::default_path();
    // team_share is serde-skipped on DaemonConfig; a raw load would always
    // show the default (enabled) and the menu could never re-enable sync.
    let auto_sync = DaemonConfig::team_share_auto_sync_enabled_from_disk();
    let team_id = resolve_team_id(None)?;

    println!("Team: {team_id}");
    println!(
        "Local auto_sync: {} (team.toml [team_share])",
        if auto_sync { "enabled" } else { "disabled" }
    );
    if !auto_sync {
        println!("  This daemon skips automatic OSS sync.");
        println!("  Use manual sync below or `amuxd config set team_share.auto_sync true`.");
    }

    let toggle_label = if auto_sync {
        "Disable local auto_sync".to_string()
    } else {
        "Enable local auto_sync".to_string()
    };
    let items = [toggle_label.as_str(), "Trigger manual sync now", "Back"];
    let choice = Select::with_theme(theme)
        .with_prompt("Sync menu")
        .items(&items)
        .default(0)
        .interact()?;

    match choice {
        0 => {
            let next = !auto_sync;
            let label = if next { "enable" } else { "disable" };
            if Confirm::with_theme(theme)
                .with_prompt(format!("{label} team_share.auto_sync?"))
                .default(next)
                .interact()?
            {
                crate::config::edit::set_config_value(
                    &config_path,
                    "team_share.auto_sync",
                    if next { "true" } else { "false" },
                )?;
                println!("✓ team_share.auto_sync = {next}");
                if !next {
                    println!("  Restart the daemon so the sync timer picks up the change.");
                }
            }
        }
        1 => trigger_manual_sync(theme, &team_id)?,
        _ => {}
    }
    Ok(())
}

fn trigger_manual_sync(theme: &ColorfulTheme, team_id: &str) -> anyhow::Result<()> {
    let workspace = pick_workspace(theme)?;
    let sync_info = LocalSyncState::load(&workspace.to_string_lossy(), team_id).ok();
    println!("Workspace: {}", workspace.display());

    if sync_info
        .as_ref()
        .map(|s| s.last_sync_at.is_empty())
        .unwrap_or(true)
    {
        println!("Last sync: (never recorded locally)");
    } else if let Some(state) = &sync_info {
        println!("Last sync: {}", state.last_sync_at);
        println!("Server seq: {}", state.last_server_seq);
        println!("Tracked files: {}", state.files.len());
    }

    if daemon_pid().is_none() {
        println!();
        println!("Daemon is not running — start it with `amuxd start` before triggering sync.");
        return Ok(());
    }

    if !Confirm::with_theme(theme)
        .with_prompt("Trigger a manual sync now? (bypasses auto_sync off)")
        .default(false)
        .interact()?
    {
        return Ok(());
    }

    match trigger_sync_via_http(&workspace, team_id, true) {
        Ok(status) => {
            if status.skipped {
                println!(
                    "Sync skipped (auto_sync disabled — this should not happen for manual sync)."
                );
                return Ok(());
            }
            println!("✓ Sync finished.");
            if let Some(mode) = status.mode {
                println!("  mode: {mode}");
            }
            if !status.last_sync_at.is_empty() {
                println!("  last_sync_at: {}", status.last_sync_at);
            }
            println!(
                "  pulled {} · pushed {} · conflicts {}",
                status.pulled, status.pushed, status.conflicts
            );
            if status.failed > 0 {
                println!(
                    "  ⚠ {} file(s) could not be pulled — cursor held back, will retry",
                    status.failed
                );
            }
            if let Some(err) = status.last_error.filter(|e| !e.trim().is_empty()) {
                println!("  last_error: {err}");
            }
        }
        Err(e) => println!("Sync failed: {e}"),
    }
    Ok(())
}

fn pick_workspace(theme: &ColorfulTheme) -> anyhow::Result<PathBuf> {
    let workspaces = match fetch_registered_workspaces() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("Could not load workspaces from cloud: {e}");
            Vec::new()
        }
    };

    if workspaces.is_empty() {
        println!("No registered workspaces on this machine.");
        return prompt_manual_workspace(theme);
    }

    let mut labels: Vec<String> = workspaces
        .iter()
        .map(|w| {
            let tag = if w.is_default { "[default] " } else { "" };
            format!("{}{} — {}", tag, w.display_name, w.path.display())
        })
        .collect();
    labels.push("Enter path manually…".to_string());

    let default_idx = workspaces.iter().position(|w| w.is_default).unwrap_or(0);

    let idx = Select::with_theme(theme)
        .with_prompt("Select workspace")
        .items(&labels)
        .default(default_idx)
        .interact()?;

    if idx == workspaces.len() {
        return prompt_manual_workspace(theme);
    }
    Ok(workspaces[idx].path.clone())
}

fn prompt_manual_workspace(theme: &ColorfulTheme) -> anyhow::Result<PathBuf> {
    let raw: String = Input::with_theme(theme)
        .with_prompt("Workspace path (absolute)")
        .interact_text()?;
    let path = expand_home_path(raw.trim());
    if !path.is_dir() {
        anyhow::bail!("not a directory: {}", path.display());
    }
    if !crate::config::workspace_path::is_linkable_workspace_path(&path.to_string_lossy()) {
        anyhow::bail!(
            "workspace path must not be under ~/.amuxd (daemon config dir): {}",
            path.display()
        );
    }
    Ok(path)
}

fn expand_home_path(raw: &str) -> PathBuf {
    if raw == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(raw));
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(raw)
}

fn fetch_registered_workspaces() -> anyhow::Result<Vec<RegisteredWorkspace>> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(fetch_registered_workspaces_async())
}

async fn fetch_registered_workspaces_async() -> anyhow::Result<Vec<RegisteredWorkspace>> {
    #[derive(Deserialize)]
    struct Response {
        workspaces: Vec<RegisteredWorkspace>,
    }

    let daemon = ManageDaemonClient::connect().await?;
    let mut out = daemon
        .json::<Response>(reqwest::Method::GET, "/v1/workspaces", None)
        .await?
        .workspaces;
    out.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(out)
}

fn print_workspace_llm_summary(workspace: &Path, indent: &str) {
    let Ok(ws_id) = encode_workspace_path(workspace) else {
        return;
    };
    let store = OpenCodeCompatStore::new();
    match store.get_providers(&ws_id) {
        Ok(providers) if providers.is_empty() => {
            println!("{indent}LLM: no providers");
        }
        Ok(providers) => {
            let names: Vec<String> = providers
                .iter()
                .map(|p| {
                    let auth = if p.authenticated { "key" } else { "no key" };
                    format!("{} ({auth})", p.id)
                })
                .collect();
            println!("{indent}LLM providers: {}", names.join(", "));
            if let Ok(Some(model)) = read_default_model(workspace) {
                println!("{indent}default model: {model}");
            }
        }
        Err(e) => println!("{indent}LLM: error ({e})"),
    }
}

fn resolve_team_id(explicit: Option<String>) -> anyhow::Result<String> {
    if let Some(id) = explicit {
        let id = id.trim().to_string();
        if id.is_empty() {
            anyhow::bail!("team id is empty");
        }
        return Ok(id);
    }
    let path = DaemonConfig::default_path();
    let config = DaemonConfig::load(&path)
        .map_err(|e| anyhow::anyhow!("read {}: {e}\nRun `amuxd init` first.", path.display()))?;
    config
        .team_id
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("no team_id in {}.\nRun `amuxd init` first.", path.display())
        })
}

fn read_default_model(workspace: &Path) -> anyhow::Result<Option<String>> {
    let cfg = teamclu_runtime_env::opencode_config::OpencodeConfigStore::load(workspace)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(cfg.get("model").and_then(|v| v.as_str()).map(str::to_owned))
}

fn set_default_model(workspace: &Path, model: &str) -> anyhow::Result<()> {
    let model = model.trim().to_string();
    teamclu_runtime_env::opencode_config::OpencodeConfigStore::apply(workspace, |cfg| {
        let obj = cfg.as_object_mut().ok_or_else(|| {
            teamclu_runtime_env::opencode_config::OpencodeConfigError::Parse(
                "opencode.json root is not an object".into(),
            )
        })?;
        obj.insert("model".to_owned(), serde_json::Value::String(model.clone()));
        Ok(true)
    })
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

fn prompt_optional_secret(theme: &ColorfulTheme, prompt: &str) -> anyhow::Result<Option<String>> {
    let value = Password::with_theme(theme)
        .with_prompt(prompt)
        .allow_empty_password(true)
        .interact()?;
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed))
    }
}

fn daemon_pid() -> Option<i32> {
    let path = DaemonConfig::pid_path();
    let raw = std::fs::read_to_string(&path).ok()?;
    let pid: i32 = raw.trim().parse().ok()?;
    if is_process_alive(pid) {
        Some(pid)
    } else {
        None
    }
}

#[cfg(unix)]
fn is_process_alive(pid: i32) -> bool {
    // Signal 0 checks existence without killing.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(windows)]
fn is_process_alive(pid: i32) -> bool {
    use crate::process_util::CommandNoWindow;
    use std::process::Command;
    Command::new("tasklist")
        .no_window()
        .args(["/FI", &format!("PID eq {pid}")])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .any(|line| line.contains(&pid.to_string()))
        })
        .unwrap_or(false)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpSyncStatus {
    mode: Option<String>,
    last_sync_at: String,
    #[allow(dead_code)]
    syncing: bool,
    last_error: Option<String>,
    pulled: u32,
    pushed: u32,
    conflicts: u32,
    #[serde(default)]
    failed: u32,
    #[serde(default)]
    #[allow(dead_code)]
    skipped: bool,
}

fn trigger_sync_via_http(
    workspace: &Path,
    team_id: &str,
    force_sync: bool,
) -> anyhow::Result<HttpSyncStatus> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        let daemon = ManageDaemonClient::connect().await?;
        let workspace_path = workspace.to_string_lossy().to_string();
        let sync: HttpSyncStatus = daemon
            .json(
                reqwest::Method::POST,
                "/v1/team/sync",
                Some(serde_json::json!({
                    "workspacePath": workspace_path,
                    "forceSync": force_sync,
                })),
            )
            .await?;

        // Ignore unused field in struct when API returns extra keys.
        let _ = team_id;
        Ok(sync)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_workspace_path_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let id = encode_workspace_path(dir.path()).unwrap();
        let decoded = crate::config::decode_workspace_path(&id).unwrap();
        assert_eq!(decoded, dir.path());
    }
}
