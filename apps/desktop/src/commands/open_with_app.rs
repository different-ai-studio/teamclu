//! Open a local folder in another developer tool (VS Code, Cursor, Claude Code,
//! ChatGPT Codex…).
//!
//! The set of tools is a closed list on purpose: the frontend names a target by
//! id and this module decides what runs. Nothing the caller sends becomes a
//! program name, and the folder never lands on a shell command line — on macOS
//! it is an argv entry to `open` / `osascript`, on Windows it is the child's
//! working directory (same reasoning as `open_in_terminal`, SEC-6).

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenWithTarget {
    VsCode,
    Claude,
    Cursor,
    WorkBuddy,
    Qoder,
    Codex,
}

/// Launch Services resolves bundle identity even when the installed app is renamed.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum MacApp {
    Name(&'static str),
    BundleId(&'static str),
}

impl OpenWithTarget {
    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "vscode" => Some(Self::VsCode),
            "claude" => Some(Self::Claude),
            "cursor" => Some(Self::Cursor),
            "workbuddy" => Some(Self::WorkBuddy),
            "qoder" => Some(Self::Qoder),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    /// What the user calls it, for error messages.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::VsCode => "VS Code",
            Self::Claude => "Claude Code",
            Self::Cursor => "Cursor",
            Self::WorkBuddy => "WorkBuddy",
            Self::Qoder => "Qoder",
            Self::Codex => "ChatGPT Codex",
        }
    }

    /// The Launch Services identity to open. None for Claude Code, which
    /// is a CLI and runs inside a terminal instead. Codex has both: the desktop
    /// app first, the `codex` CLI in Terminal when the app is not installed.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn mac_app(self) -> Option<MacApp> {
        match self {
            Self::VsCode => Some(MacApp::Name("Visual Studio Code")),
            Self::Cursor => Some(MacApp::Name("Cursor")),
            Self::WorkBuddy => Some(MacApp::Name("WorkBuddy")),
            Self::Qoder => Some(MacApp::Name("Qoder")),
            // Codex can ship as ChatGPT.app; names are not stable identifiers.
            Self::Codex => Some(MacApp::BundleId("com.openai.codex")),
            Self::Claude => None,
        }
    }

    /// Whether the tool is (or, for Codex, falls back to) a terminal CLI that
    /// must run inside a console window rather than open as a GUI app.
    fn runs_in_terminal(self) -> bool {
        matches!(self, Self::Claude | Self::Codex)
    }

    /// The launcher each tool puts on PATH.
    fn cli_name(self) -> &'static str {
        match self {
            Self::VsCode => "code",
            Self::Claude => "claude",
            Self::Cursor => "cursor",
            Self::WorkBuddy => "workbuddy",
            Self::Qoder => "qoder",
            Self::Codex => "codex",
        }
    }
}

/// Open `path` (a directory) with the tool named by `target`.
#[tauri::command]
pub async fn open_path_with_app(path: String, target: String) -> Result<(), String> {
    let target =
        OpenWithTarget::parse(&target).ok_or_else(|| format!("Unsupported app: {target}"))?;
    tokio::task::spawn_blocking(move || open_blocking(&path, target))
        .await
        .map_err(|e| format!("open_path_with_app task failed: {e}"))?
}

fn validate_dir(path: &str) -> Result<&Path, String> {
    // A verbatim `\\?\C:\...` path (what canonicalize returns on Windows)
    // cannot be a cmd.exe working directory — cmd silently falls back to the
    // Windows folder — and some editors mangle it. The plain form is the same
    // folder.
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("Not an absolute path: {path}"));
    }
    if !p.is_dir() {
        return Err(format!("Folder does not exist: {path}"));
    }
    Ok(p)
}

fn not_installed(target: OpenWithTarget) -> String {
    format!(
        "{} is not installed on this computer",
        target.display_name()
    )
}

fn open_blocking(path: &str, target: OpenWithTarget) -> Result<(), String> {
    let dir = validate_dir(path)?;

    #[cfg(target_os = "macos")]
    {
        match target.mac_app() {
            Some(app) => match mac::open_app(app, dir) {
                // Codex without the desktop app: the CLI still works.
                Err(MacOpenError::NotInstalled) if target.runs_in_terminal() => {
                    mac::run_in_terminal(dir, target).map_err(|e| e.message(target))
                }
                other => other.map_err(|e| e.message(target)),
            },
            None => mac::run_in_terminal(dir, target).map_err(|e| e.message(target)),
        }
    }

    #[cfg(target_os = "windows")]
    {
        windows::open(dir, target)
    }

    #[cfg(target_os = "linux")]
    {
        let spawned = if target.runs_in_terminal() {
            ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
                .iter()
                .any(|term| {
                    std::process::Command::new(term)
                        .args(["-e", target.cli_name()])
                        .current_dir(dir)
                        .spawn()
                        .is_ok()
                })
        } else {
            std::process::Command::new(target.cli_name())
                .arg(dir)
                .spawn()
                .is_ok()
        };
        if !spawned {
            return Err(not_installed(target));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
enum MacOpenError {
    NotInstalled,
    Failed(String),
}

#[cfg(target_os = "macos")]
impl MacOpenError {
    fn message(self, target: OpenWithTarget) -> String {
        match self {
            Self::NotInstalled => not_installed(target),
            Self::Failed(detail) => format!("Failed to open {}: {detail}", target.display_name()),
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{MacApp, MacOpenError, OpenWithTarget};
    use std::path::Path;
    use std::process::{Command, Output};

    fn check(output: std::io::Result<Output>) -> Result<(), MacOpenError> {
        let output = output.map_err(|e| MacOpenError::Failed(e.to_string()))?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("Unable to find application") {
            return Err(MacOpenError::NotInstalled);
        }
        Err(MacOpenError::Failed(stderr.trim().to_string()))
    }

    pub(super) fn app_command(app: MacApp, dir: &Path) -> Command {
        let mut command = Command::new("open");
        match app {
            MacApp::Name(name) => command.arg("-a").arg(name),
            MacApp::BundleId(id) => command.arg("-b").arg(id),
        };
        command.arg(dir);
        command
    }

    pub(super) fn open_app(app: MacApp, dir: &Path) -> Result<(), MacOpenError> {
        check(app_command(app, dir).output())
    }

    /// Terminal.app running the tool's CLI in `dir`. `quoted form of` does the
    /// shell quoting inside AppleScript, and the folder arrives as argv rather
    /// than spliced into the script. The CLI name is a fixed constant.
    pub(super) fn run_in_terminal(dir: &Path, target: OpenWithTarget) -> Result<(), MacOpenError> {
        let script_line = format!(
            "do script \"cd \" & quoted form of (item 1 of argv) & \" && {}\"",
            target.cli_name()
        );
        check(
            Command::new("osascript")
                .args([
                    "-e",
                    "on run argv",
                    "-e",
                    "tell application \"Terminal\"",
                    "-e",
                    &script_line,
                    "-e",
                    "activate",
                    "-e",
                    "end tell",
                    "-e",
                    "end run",
                ])
                .arg(dir)
                .output(),
        )
    }
}

/// Windows: editors are found by where their installers put them, and only
/// then by PATH, because a GUI process often starts with a PATH that predates
/// the install (and the `.cmd` shims need cmd.exe to run at all).
#[cfg(target_os = "windows")]
mod windows {
    use super::{not_installed, OpenWithTarget};
    use std::ffi::OsString;
    use std::os::windows::process::CommandExt as _;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// `<install dir>\<exe>` candidates, relative to LOCALAPPDATA\Programs
    /// (per-user installs, the default) and the Program Files folders.
    fn install_candidates(target: OpenWithTarget) -> &'static [(&'static str, &'static str)] {
        match target {
            OpenWithTarget::VsCode => &[("Microsoft VS Code", "Code.exe")],
            OpenWithTarget::Cursor => &[("cursor", "Cursor.exe"), ("Cursor", "Cursor.exe")],
            OpenWithTarget::Qoder => &[("Qoder", "Qoder.exe")],
            OpenWithTarget::WorkBuddy => &[("WorkBuddy", "WorkBuddy.exe")],
            OpenWithTarget::Claude | OpenWithTarget::Codex => &[],
        }
    }

    fn env_dir(key: &str) -> Option<PathBuf> {
        std::env::var_os(key)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    }

    fn installed_exe(target: OpenWithTarget) -> Option<PathBuf> {
        let roots: Vec<PathBuf> = [
            env_dir("LOCALAPPDATA").map(|d| d.join("Programs")),
            env_dir("ProgramFiles"),
            env_dir("ProgramFiles(x86)"),
        ]
        .into_iter()
        .flatten()
        .collect();
        install_candidates(target).iter().find_map(|(dir, exe)| {
            roots
                .iter()
                .map(|root| root.join(dir).join(exe))
                .find(|p| p.is_file())
        })
    }

    /// First `name` + PATHEXT extension found on `path`.
    fn find_on_path(name: &str, path: &OsString) -> Option<PathBuf> {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        std::env::split_paths(path).find_map(|dir| {
            exts.split(';')
                .filter(|e| !e.is_empty())
                .map(|ext| dir.join(format!("{name}{ext}")))
                .find(|p| p.is_file())
        })
    }

    /// PATH for the child, with the places the Claude Code / Codex CLI
    /// installers use appended in case this process started before they were
    /// added.
    fn path_with_cli_dirs() -> OsString {
        let mut dirs: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        if let Some(home) = env_dir("USERPROFILE") {
            dirs.push(home.join(".local").join("bin"));
        }
        if let Some(appdata) = env_dir("APPDATA") {
            dirs.push(appdata.join("npm"));
        }
        std::env::join_paths(dirs).unwrap_or_default()
    }

    pub(super) fn open(dir: &Path, target: OpenWithTarget) -> Result<(), String> {
        let fail = |e: std::io::Error| format!("Failed to open {}: {e}", target.display_name());

        if target.runs_in_terminal() {
            let path = path_with_cli_dirs();
            if find_on_path(target.cli_name(), &path).is_none() {
                return Err(not_installed(target));
            }
            // A visible console that stays open (`/K`) with the CLI running in
            // the folder. The folder is the working directory, never part of
            // the command line cmd parses.
            Command::new("cmd")
                .args(["/K", target.cli_name()])
                .env("PATH", path)
                .current_dir(dir)
                .creation_flags(CREATE_NEW_CONSOLE)
                .spawn()
                .map_err(fail)?;
            return Ok(());
        }

        // The editor binary itself, with the folder as a plain argv entry —
        // no shell between us and it.
        if let Some(exe) = installed_exe(target) {
            Command::new(exe).arg(dir).spawn().map_err(fail)?;
            return Ok(());
        }

        // Fallback: the PATH launcher (`code.cmd` and friends). Only cmd can
        // run a `.cmd`; `.` is a fixed argument and the folder is the working
        // directory.
        let path = std::env::var_os("PATH").unwrap_or_default();
        if find_on_path(target.cli_name(), &path).is_none() {
            return Err(not_installed(target));
        }
        let status = Command::new("cmd")
            .args(["/C", target.cli_name(), "."])
            .current_dir(dir)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(fail)?;
        if !status.success() {
            return Err(format!(
                "Failed to open {}: launcher exited with {status}",
                target.display_name()
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_targets_parse() {
        for id in ["vscode", "claude", "cursor", "workbuddy", "qoder", "codex"] {
            assert!(OpenWithTarget::parse(id).is_some(), "{id}");
        }
        for id in ["", "code", "bash", "/bin/sh", "VSCODE"] {
            assert!(OpenWithTarget::parse(id).is_none(), "{id}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn codex_uses_bundle_identity_and_preserves_workspace_argument() {
        let dir = Path::new("/tmp/财务 app's $(echo test)");
        let command = mac::app_command(OpenWithTarget::Codex.mac_app().unwrap(), dir);
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(command.get_program(), "open");
        assert_eq!(args, ["-b", "com.openai.codex", dir.to_str().unwrap()]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn other_editors_keep_opening_by_name() {
        let command =
            mac::app_command(OpenWithTarget::VsCode.mac_app().unwrap(), Path::new("/tmp"));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["-a", "Visual Studio Code", "/tmp"]);
    }

    #[test]
    fn rejects_relative_and_missing_paths() {
        assert!(validate_dir("relative/dir").is_err());
        assert!(validate_dir("/definitely/not/a/real/dir/teamclu").is_err());
        let tmp = std::env::temp_dir();
        assert!(validate_dir(tmp.to_str().unwrap()).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn strips_the_verbatim_prefix() {
        let tmp = std::env::temp_dir();
        let verbatim = format!(r"\\?\{}", tmp.display());
        assert_eq!(validate_dir(&verbatim).unwrap(), tmp.as_path());
    }
}
