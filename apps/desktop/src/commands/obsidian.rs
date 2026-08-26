//! Open the team knowledge directory in Obsidian, and report whether Obsidian
//! is even installed so the button can be greyed out instead of failing.
//!
//! Detection is per-platform because there is no portable way to ask "is this
//! app installed":
//! - macOS: the bundle's well-known locations, then Spotlight for people who
//!   keep their apps somewhere else.
//! - Windows: the install roots the installer uses (per-user and machine-wide),
//!   then the `obsidian://` URI handler in the registry.
//! - Linux: PATH, then the Flatpak id.
//!
//! Opening a vault goes through the `obsidian://` URI, not argv: Obsidian does
//! not accept a folder as a command-line argument, and the URI is the only
//! entry point it documents. That URI can only resolve a path inside a vault
//! Obsidian already knows, so a directory it has never opened gets the app
//! launched bare instead — the caller walks the user through
//! "Open folder as vault" once, and every later click takes the URI path.

use std::path::{Path, PathBuf};
use std::process::Command;

// Only the Windows paths shell out to a console program.
#[cfg(target_os = "windows")]
use crate::process_util::CommandNoWindow;

/// What the UI needs to decide how the Obsidian button renders.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianStatus {
    /// Obsidian is installed on this machine. `false` greys the button out.
    pub installed: bool,
    /// The directory already carries a `.obsidian/` folder, i.e. Obsidian has
    /// opened it as a vault before. While this is false the URI cannot resolve
    /// the path, so the caller has to hand the user the path once.
    pub vault_initialized: bool,
}

/// Is Obsidian installed, and has `vault_path` been opened as a vault yet?
///
/// `vault_path` may be empty — then only `installed` is meaningful.
#[tauri::command]
pub fn obsidian_status(vault_path: String) -> ObsidianStatus {
    ObsidianStatus {
        installed: obsidian_app_path().is_some() || uri_handler_registered(),
        vault_initialized: !vault_path.is_empty() && is_vault_initialized(Path::new(&vault_path)),
    }
}

/// A directory Obsidian has opened before has a `.obsidian/` config folder in
/// it. That is the only marker it leaves on disk, and it is what decides
/// whether `obsidian://open?path=` resolves or just raises an error dialog.
fn is_vault_initialized(dir: &Path) -> bool {
    dir.join(".obsidian").is_dir()
}

/// Build the `obsidian://open?path=<abs path>` URI for a vault directory.
///
/// Kept separate from the spawn so the encoding can be unit-tested without an
/// Obsidian install: encoding is the part that breaks. Team dirs sit under a
/// home directory that often contains spaces, and CJK folder names are routine
/// in this product.
fn open_uri(vault_path: &str) -> String {
    format!("obsidian://open?path={}", urlencoding::encode(vault_path))
}

/// Hand `vault_path` to Obsidian.
///
/// When the directory has never been opened as a vault, this launches Obsidian
/// without a target instead: the URI would resolve to nothing and the user
/// would get an error dialog rather than the app they asked for.
///
/// Errors when Obsidian is not installed. The button should be disabled in that
/// case, so reaching here means the UI and the filesystem disagree — saying so
/// beats silently doing nothing.
#[tauri::command]
pub fn obsidian_open_vault(vault_path: String) -> Result<(), String> {
    if vault_path.trim().is_empty() {
        return Err("obsidian: empty vault path".to_string());
    }
    let dir = Path::new(&vault_path);
    if !dir.is_dir() {
        return Err(format!("obsidian: no such directory: {vault_path}"));
    }
    let app = obsidian_app_path();
    if app.is_none() && !uri_handler_registered() {
        return Err("obsidian: not installed".to_string());
    }

    if is_vault_initialized(dir) {
        open_target(&open_uri(&vault_path))
    } else {
        launch_app(app)
    }
}

/// Hand a URI to the platform's URL opener.
fn open_target(uri: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(uri);
        c
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        // `start` needs the empty "" title argument, or it treats the quoted
        // URI as a window title and opens nothing.
        c.no_window().args(["/C", "start", "", uri]);
        c
    };

    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(uri);
        c
    };

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("obsidian: failed to open: {e}"))
}

/// Start Obsidian with no target, for the first-run case where the directory is
/// not a vault yet and the user has to add it by hand.
fn launch_app(app: Option<PathBuf>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        Command::new("open")
            .args(["-a", "Obsidian"])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("obsidian: failed to launch: {e}"))
    }

    #[cfg(target_os = "windows")]
    {
        match app {
            Some(exe) => Command::new(exe)
                .no_window()
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("obsidian: failed to launch: {e}")),
            // Only the registry knew about this install, so there is no exe
            // path to spawn. The URI handler is registered, so ask it to open
            // nothing in particular — Obsidian comes up on its vault picker.
            None => open_target("obsidian://"),
        }
    }

    #[cfg(target_os = "linux")]
    {
        match app {
            Some(exe) => Command::new(exe)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("obsidian: failed to launch: {e}")),
            None => Command::new("flatpak")
                .args(["run", "md.obsidian.Obsidian"])
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("obsidian: failed to launch: {e}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Installation detection
// ---------------------------------------------------------------------------

/// Path to the Obsidian executable/bundle, when it can be found by looking.
/// `None` does not prove Obsidian is absent — see [`uri_handler_registered`].
#[cfg(target_os = "macos")]
fn obsidian_app_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        PathBuf::from("/Applications/Obsidian.app"),
        PathBuf::from(format!("{home}/Applications/Obsidian.app")),
    ];
    if let Some(hit) = candidates.into_iter().find(|p| p.exists()) {
        return Some(hit);
    }
    // Installed somewhere else. Spotlight knows where; it can be turned off, so
    // this is a fallback and never the only check.
    let out = Command::new("mdfind")
        .arg("kMDItemCFBundleIdentifier == 'md.obsidian'")
        .output()
        .ok()?;
    let first = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    (!first.is_empty()).then(|| PathBuf::from(first))
}

#[cfg(target_os = "windows")]
fn obsidian_app_path() -> Option<PathBuf> {
    let roots = [
        std::env::var("LOCALAPPDATA").ok(),
        std::env::var("ProgramFiles").ok(),
        std::env::var("ProgramFiles(x86)").ok(),
    ];
    for root in roots.into_iter().flatten() {
        let base = Path::new(&root);
        // Per-user installs land in `Obsidian\`, Squirrel machine-wide ones in
        // `Programs\Obsidian\`.
        for rel in ["Obsidian", "Programs\\Obsidian"] {
            let exe = base.join(rel).join("Obsidian.exe");
            if exe.exists() {
                return Some(exe);
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn obsidian_app_path() -> Option<PathBuf> {
    let out = Command::new("which").arg("obsidian").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// Whether something has claimed the `obsidian://` scheme. Catches installs the
/// path probes miss — a portable Windows install, a Flatpak on Linux.
///
/// macOS has no cheap shell-level equivalent (Launch Services needs an ObjC
/// round-trip), and the bundle probe plus Spotlight already covers it, so this
/// is `false` there and the path probe decides.
#[cfg(target_os = "windows")]
fn uri_handler_registered() -> bool {
    Command::new("reg")
        .no_window()
        .args(["query", r"HKCU\Software\Classes\obsidian"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn uri_handler_registered() -> bool {
    Command::new("flatpak")
        .args(["info", "md.obsidian.Obsidian"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn uri_handler_registered() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Team dirs sit under a home directory that often has a space in it, and
    /// folder names in this product are routinely CJK. Both have to survive
    /// into the URI.
    #[test]
    fn open_uri_percent_encodes_the_path() {
        let uri = open_uri("/Users/a b/.amuxd/teams/abc-123/shared/knowledge");
        assert!(uri.starts_with("obsidian://open?path="));
        assert!(uri.contains("%2FUsers%2Fa%20b%2F"));
        assert!(!uri.contains(' '));
    }

    #[test]
    fn open_uri_encodes_non_ascii() {
        let uri = open_uri("/tmp/团队/knowledge");
        assert!(!uri.contains('团'));
        assert!(uri.contains("%E5%9B%A2%E9%98%9F"));
    }

    #[test]
    fn a_dir_without_dot_obsidian_is_not_an_initialized_vault() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_vault_initialized(dir.path()));
        std::fs::create_dir(dir.path().join(".obsidian")).unwrap();
        assert!(is_vault_initialized(dir.path()));
    }

    /// A file named `.obsidian` is not a vault marker — the check is
    /// specifically for a directory.
    #[test]
    fn a_dot_obsidian_file_does_not_count() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".obsidian"), b"").unwrap();
        assert!(!is_vault_initialized(dir.path()));
    }

    #[test]
    fn opening_a_missing_directory_is_an_error() {
        let err = obsidian_open_vault("/nope/does/not/exist".into()).unwrap_err();
        assert!(err.contains("no such directory"), "{err}");
    }

    #[test]
    fn opening_an_empty_path_is_an_error() {
        assert!(obsidian_open_vault("   ".into()).is_err());
    }
}
