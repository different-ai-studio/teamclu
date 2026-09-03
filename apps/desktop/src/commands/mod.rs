pub mod acp_debug_log;
pub mod agents_skills;
pub mod amuxd_control;
pub mod amuxd_supervisor;
pub mod app_menu;
pub mod clawhub;
pub mod cron;
pub mod daemon_http;
pub mod daemon_live;
pub mod daemon_onboarding;
pub mod deps;
pub mod diagnostics;
pub mod env_vars;
pub mod filewatcher;
pub mod gateway;
pub mod introspect_api;
pub mod introspect_auth;
pub mod local_secret_store;
pub mod mqtt_bus;
pub mod oauth_loopback;
pub mod obsidian;
pub mod oss_sync;
pub mod server_config;
pub mod session_export;
pub mod setup;
pub mod shared_secrets;
pub mod shared_secrets_crypto;
pub mod skillssh;
pub mod system_appearance;
pub mod team;
pub mod team_secret_store;
pub mod team_share;
pub mod team_skills;
pub mod team_sync_proxy;
pub mod terminal;
pub mod tray_menu;
pub mod updater;
pub mod webview;
pub mod window;
pub mod window_chrome;
pub mod workspace_files;

/// True when the OS is set to a Chinese locale.
///
/// Cold-start only: the language the user picked in Settings lives in the
/// webview's localStorage, which Rust cannot read before the frontend boots,
/// so the native menu bar and tray start from the OS and get corrected the
/// moment `syncTrayMenuLabels` runs.
///
/// `sys_locale` asks the OS itself. The previous `LC_ALL` / `LANG` probe was a
/// Unix convention that Windows does not follow — neither variable is normally
/// set there, so a Chinese Windows always cold-started in English.
pub fn prefers_zh_locale() -> bool {
    sys_locale::get_locale()
        .unwrap_or_default()
        .to_lowercase()
        .starts_with("zh")
}

/// The short application name, injected at compile time via `build.rs`.
pub const APP_SHORT_NAME: &str = env!("APP_SHORT_NAME");
/// User-facing product name (`app.displayName` / `app.name` from build config).
pub const APP_DISPLAY_NAME: &str = env!("APP_DISPLAY_NAME");
/// Deep-link scheme for this build (`app.scheme`, default `teamclu`).
/// Independent of `APP_SHORT_NAME` — betly is short name `teamclaw` on scheme
/// `teamclu`, copilot361 is `copilot361` on both.
pub const APP_SCHEME: &str = env!("APP_SCHEME");
/// Read by the teamclu-introspect sidecar (`export_session_link`), which amuxd
/// registers as an MCP server and therefore inherits this from.
pub const APP_SCHEME_ENV: &str = "TEAMCLU_APP_SCHEME";
/// Workspace metadata directory (`.teamclu` for official builds).
pub const TEAMCLU_DIR: &str = env!("TEAMCLU_DIR");
/// Subfolder inside workspace where the team repo is cloned / symlinked.
/// Fixed across brands — must match the daemon's `TEAM_LINK_NAME` (`teamclu-team`).
pub const TEAM_REPO_DIR: &str = "teamclu-team";
/// Workspace config file name (`teamclu.json` for official builds).
pub const CONFIG_FILE_NAME: &str = env!("CONFIG_FILE_NAME");
/// Home-directory storage folder name without leading dot (`teamclu` for official).
pub fn home_storage_dir_name() -> &'static str {
    teamclu_runtime_env::resolve_storage_dir_name(APP_SHORT_NAME)
}

/// Local amuxd state directory for this desktop brand (`~/.amuxd` or `~/.amuxd-<brand>`).
pub fn amuxd_home_dir() -> std::path::PathBuf {
    teamclu_runtime_env::amuxd_home_for_brand(APP_SHORT_NAME)
}

/// `<amuxd home>/run` — where the daemon publishes pid, lock, control socket
/// and the HTTP port/token the desktop discovers it by. One definition for
/// both sides, in `teamclu_runtime_env::amuxd_layout` — the daemon's
/// `config::layout` delegates to the same functions, so the pair cannot drift.
pub fn amuxd_run_dir() -> std::path::PathBuf {
    teamclu_runtime_env::amuxd_layout::run_dir(&amuxd_home_dir())
}

/// `<amuxd home>/logs` — the daemon's rotating log, and the stdout/stderr this
/// app redirects when it spawns the bundled sidecar.
pub fn amuxd_logs_dir() -> std::path::PathBuf {
    teamclu_runtime_env::amuxd_layout::logs_dir(&amuxd_home_dir())
}

/// `<amuxd home>/teams/<team_id>` — everything the daemon keeps for one team.
pub fn amuxd_team_dir(team_id: &str) -> std::path::PathBuf {
    teamclu_runtime_env::amuxd_layout::team_dir(&amuxd_home_dir(), team_id)
}

/// `<amuxd home>/teams/<team_id>/state` — the daemon-private half.
pub fn amuxd_team_state_dir(team_id: &str) -> std::path::PathBuf {
    teamclu_runtime_env::amuxd_layout::team_state_dir(&amuxd_home_dir(), team_id)
}

/// `<amuxd home>/teams/<team_id>/workspace` — the daemon's default worktree
/// for this team (gateway sessions run here when no workspace is picked).
pub fn amuxd_team_workspace_dir(team_id: &str) -> std::path::PathBuf {
    teamclu_runtime_env::amuxd_layout::team_workspace_dir(&amuxd_home_dir(), team_id)
}

/// The team this brand's daemon is claimed by (`active_team` in daemon.toml),
/// or `None` while unclaimed. The one probe — daemon_http, gateway and cron
/// used to each carry their own copy of this parse.
pub fn amuxd_active_team() -> Option<String> {
    let team = teamclu_runtime_env::amuxd_layout::active_team(&amuxd_home_dir());
    (team != teamclu_runtime_env::amuxd_layout::UNCLAIMED_TEAM).then_some(team)
}

/// `<amuxd home>/teams/<team_id>/shared/teamclu-team` — the daemon's synced
/// copy, and the target every workspace's `teamclu-team` symlink points at.
///
/// Mirrors `daemon::config::global_team_store::global_team_dir`. The `shared/`
/// level is what keeps daemon-private state out of the one directory the sync
/// engine scans, so this app must not shortcut past it.
pub fn amuxd_team_shared_dir(team_id: &str) -> std::path::PathBuf {
    amuxd_team_dir(team_id).join("shared").join(TEAM_REPO_DIR)
}

/// This desktop brand's own home storage directory (`~/.teamclu` or `~/.<brand>`):
/// personal secrets, `local-cache.db`, telemetry consent, the PATH cache.
///
/// Every call site that wants it comes here. Assembling it from [`TEAMCLU_DIR`]
/// — a *workspace* metadata name that only coincides with this one for the
/// official brand — is what put `local-cache.db` and the secrets store in
/// different directories on a white-label build.
pub fn brand_home_dir() -> std::path::PathBuf {
    teamclu_runtime_env::brand_home_dir(APP_SHORT_NAME)
}

/// Brand + `AMUXD_HOME` + app-scheme env every bundled amuxd subcommand must
/// inherit so `stop` / `start` / `status` / `init` / `clear` / `uninstall-service`
/// all hit the same branded home (`~/.amuxd-<brand>`), not the default `~/.amuxd`.
pub fn branded_amuxd_env_for(
    short_name: &str,
    display_name: &str,
    scheme: &str,
) -> Vec<(&'static str, String)> {
    vec![
        (
            teamclu_runtime_env::BRAND_SHORT_NAME_ENV,
            short_name.to_string(),
        ),
        (
            teamclu_runtime_env::APP_DISPLAY_NAME_ENV,
            display_name.to_string(),
        ),
        (
            teamclu_runtime_env::AMUXD_HOME_ENV,
            teamclu_runtime_env::amuxd_home_for_brand(short_name)
                .to_string_lossy()
                .into_owned(),
        ),
        (APP_SCHEME_ENV, scheme.to_string()),
    ]
}

/// Brand env for this desktop build (`APP_SHORT_NAME` / display / scheme).
pub fn branded_amuxd_env() -> Vec<(&'static str, String)> {
    branded_amuxd_env_for(APP_SHORT_NAME, APP_DISPLAY_NAME, APP_SCHEME)
}

/// Stamp brand + `AMUXD_HOME` onto a shell sidecar so CLI (`init` / `clear` /
/// `doctor`) reads the same state dir as the desktop-managed daemon.
pub fn with_amuxd_brand_env(
    command: tauri_plugin_shell::process::Command,
) -> tauri_plugin_shell::process::Command {
    branded_amuxd_env()
        .into_iter()
        .fold(command, |cmd, (key, value)| cmd.env(key, value))
}

/// Best-effort OS account name used to seed a new member's default display
/// name (instead of the legacy "You"). Prefers the human "real name" — macOS
/// Directory Services full name, Windows account display name, Linux GECOS —
/// and falls back to the login username. Returns an empty string when nothing
/// usable is available, in which case the server synthesizes a handle.
#[tauri::command]
pub fn os_full_name() -> String {
    let real = whoami::realname();
    if !real.trim().is_empty() {
        return real.trim().to_string();
    }
    let user = whoami::username();
    if !user.trim().is_empty() {
        return user.trim().to_string();
    }
    String::new()
}

/// Best-effort machine hostname, used to seed a default name when onboarding
/// this machine's agent (e.g. "MacBook-Pro"). Strips a trailing ".local" the
/// way macOS appends it, and returns an empty string when nothing usable is
/// available so the caller can fall back to its own placeholder.
#[tauri::command]
pub fn get_device_hostname() -> String {
    let host = gethostname::gethostname().to_string_lossy().to_string();
    let host = host.trim();
    host.strip_suffix(".local")
        .unwrap_or(host)
        .trim()
        .to_string()
}

/// Reveal a file or folder in the native file manager (Finder on macOS, Explorer on Windows).
#[tauri::command]
pub async fn show_in_folder(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || show_in_folder_blocking(path))
        .await
        .map_err(|e| format!("show_in_folder task failed: {e}"))?
}

/// Blocking body of [`show_in_folder`], shared with the Rust callers that are
/// already off the main thread (diagnostics, acp debug log).
pub(crate) fn show_in_folder_blocking(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try xdg-open on the parent directory
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to reveal in file manager: {}", e))?;
    }

    Ok(())
}

/// Open a file with the system default application.
#[tauri::command]
pub async fn open_with_default_app(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || open_with_default_app_blocking(path))
        .await
        .map_err(|e| format!("open_with_default_app task failed: {e}"))?
}

fn open_with_default_app_blocking(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        // Not `cmd /C start "" <path>`: cmd re-parses its command line, so a
        // path containing `&`, `|` or `^` — a directory named `x & calc` —
        // ran as a command (SEC-6). `explorer.exe <path>` resolves the file
        // association itself and takes the path as one argv element, the
        // same launcher `show_in_folder` already trusts.
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

/// Open a terminal at the given directory path.
#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || open_in_terminal_blocking(path))
        .await
        .map_err(|e| format!("open_in_terminal task failed: {e}"))?
}

fn open_in_terminal_blocking(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal", &path])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        // The path never touches a command line (SEC-6): the shell is started
        // with its working directory already set, in a fresh visible console
        // (CREATE_NEW_CONSOLE), instead of `cmd /C start cmd /K cd /d <path>`
        // where cmd's own parser would run whatever followed a `&` in the
        // directory name.
        use std::os::windows::process::CommandExt as _;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        std::process::Command::new("cmd")
            .current_dir(&path)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators
        let terminals = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
        let mut opened = false;
        for term in &terminals {
            if std::process::Command::new(term)
                .current_dir(&path)
                .spawn()
                .is_ok()
            {
                opened = true;
                break;
            }
        }
        if !opened {
            return Err("No terminal emulator found".to_string());
        }
    }

    Ok(())
}
