//! Open a local folder in another developer tool (VS Code, Cursor, Claude Code…).
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
}

impl OpenWithTarget {
    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "vscode" => Some(Self::VsCode),
            "claude" => Some(Self::Claude),
            "cursor" => Some(Self::Cursor),
            "workbuddy" => Some(Self::WorkBuddy),
            "qoder" => Some(Self::Qoder),
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
        }
    }

    /// The `.app` bundle name `open -a` looks up. None for Claude Code, which
    /// is a CLI and runs inside a terminal instead.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn mac_app_name(self) -> Option<&'static str> {
        match self {
            Self::VsCode => Some("Visual Studio Code"),
            Self::Cursor => Some("Cursor"),
            Self::WorkBuddy => Some("WorkBuddy"),
            Self::Qoder => Some("Qoder"),
            Self::Claude => None,
        }
    }

    /// The launcher each tool puts on PATH.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    fn cli_name(self) -> &'static str {
        match self {
            Self::VsCode => "code",
            Self::Claude => "claude",
            Self::Cursor => "cursor",
            Self::WorkBuddy => "workbuddy",
            Self::Qoder => "qoder",
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
        let output = match target.mac_app_name() {
            Some(app) => std::process::Command::new("open")
                .arg("-a")
                .arg(app)
                .arg(dir)
                .output(),
            // `quoted form of` does the shell quoting inside AppleScript, and
            // the folder arrives as argv rather than spliced into the script.
            None => std::process::Command::new("osascript")
                .args([
                    "-e",
                    "on run argv",
                    "-e",
                    "tell application \"Terminal\"",
                    "-e",
                    "do script \"cd \" & quoted form of (item 1 of argv) & \" && claude\"",
                    "-e",
                    "activate",
                    "-e",
                    "end tell",
                    "-e",
                    "end run",
                ])
                .arg(dir)
                .output(),
        }
        .map_err(|e| format!("Failed to open {}: {e}", target.display_name()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("Unable to find application") {
                return Err(not_installed(target));
            }
            return Err(format!(
                "Failed to open {}: {}",
                target.display_name(),
                stderr.trim()
            ));
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if target == OpenWithTarget::Claude {
            // A visible console that stays open (`/K`) with claude running in
            // the folder; the folder is the working directory, not an argument.
            std::process::Command::new("cmd")
                .args(["/K", "claude"])
                .current_dir(dir)
                .creation_flags(CREATE_NEW_CONSOLE)
                .spawn()
                .map_err(|e| format!("Failed to open {}: {e}", target.display_name()))?;
            return Ok(());
        }
        // The editors install `.cmd` shims, which only cmd can resolve. `.`
        // is a fixed argument; the folder is the working directory.
        let status = std::process::Command::new("cmd")
            .args(["/C", target.cli_name(), "."])
            .current_dir(dir)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("Failed to open {}: {e}", target.display_name()))?;
        if !status.success() {
            return Err(not_installed(target));
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let spawned = if target == OpenWithTarget::Claude {
            ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
                .iter()
                .any(|term| {
                    std::process::Command::new(term)
                        .args(["-e", "claude"])
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_targets_parse() {
        for id in ["vscode", "claude", "cursor", "workbuddy", "qoder"] {
            assert!(OpenWithTarget::parse(id).is_some(), "{id}");
        }
        for id in ["", "code", "bash", "/bin/sh", "VSCODE"] {
            assert!(OpenWithTarget::parse(id).is_none(), "{id}");
        }
    }

    #[test]
    fn rejects_relative_and_missing_paths() {
        assert!(validate_dir("relative/dir").is_err());
        assert!(validate_dir("/definitely/not/a/real/dir/teamclu").is_err());
        let tmp = std::env::temp_dir();
        assert!(validate_dir(tmp.to_str().unwrap()).is_ok());
    }
}
