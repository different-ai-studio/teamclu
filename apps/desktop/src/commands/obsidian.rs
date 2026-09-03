//! Open the team knowledge directory in Obsidian, initializing it as a vault
//! the first time so the user never has to add it by hand.
//!
//! ## How Obsidian decides what a vault is
//!
//! Verified against Obsidian 1.13.7 on macOS, not inferred:
//!
//! - The vault list lives in `<config dir>/obsidian/obsidian.json`, shaped
//!   `{"vaults": {"<id>": {"path": …, "ts": …, "open": bool}}}`. The id is an
//!   opaque 16-hex string — **not** a hash of the path (md5/sha1/sha256 of the
//!   path all fail to reproduce a real one), so any unique value works. We
//!   derive ours from the path anyway, which makes re-registration idempotent.
//! - `obsidian://open?path=…` resolves only against vaults in that file.
//! - A vault's `.obsidian/` directory is created by Obsidian **when it first
//!   opens the folder** — it is a consequence of registration, not the cause.
//!   So `.obsidian/` existing cannot be used to decide "is this a vault"; the
//!   registry is the only honest source.
//! - **Obsidian reads that file at startup only.** Registering a vault while
//!   Obsidian is running does not make the URI work — measured: the URI was
//!   accepted and silently did nothing. Hence [`OpenOutcome`].
//!
//! ## Detection
//!
//! Per-platform, because there is no portable way to ask "is this app
//! installed": macOS looks at the two bundle locations then Spotlight; Windows
//! at the installer's roots then the `obsidian://` handler in the registry;
//! Linux at PATH then the Flatpak id.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

// Only the Windows paths shell out to a console program.
#[cfg(target_os = "windows")]
use crate::process_util::CommandNoWindow;

/// What the UI needs to decide how the Obsidian button renders.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianStatus {
    /// Obsidian is installed on this machine. `false` greys the button out.
    pub installed: bool,
    /// The directory is already in Obsidian's vault registry, so the URI will
    /// resolve it. When false the first open has to register it first.
    pub vault_registered: bool,
}

/// What [`obsidian_open_vault`] actually managed to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenOutcome {
    /// Obsidian was handed the vault and is opening it.
    Opened,
    /// The vault was added to Obsidian's registry, but Obsidian is already
    /// running and only reads that file at startup — the user has to restart it
    /// once. Every later open takes the `Opened` path.
    RegisteredNeedsRestart,
}

/// Is Obsidian installed, and is `vault_path` registered with it?
///
/// `vault_path` may be empty — then only `installed` is meaningful.
///
/// `async` + `spawn_blocking`: the frontend re-asks on every window focus, and
/// the answer can involve spawning `mdfind` / `reg` / `flatpak`. A non-`async`
/// command runs inline on the main thread, so that spawn used to freeze the
/// window on every focus for anyone with Obsidian outside `/Applications`.
#[tauri::command]
pub async fn obsidian_status(vault_path: String) -> ObsidianStatus {
    tokio::task::spawn_blocking(move || status_blocking(&vault_path))
        .await
        .unwrap_or(ObsidianStatus {
            installed: false,
            vault_registered: false,
        })
}

fn status_blocking(vault_path: &str) -> ObsidianStatus {
    ObsidianStatus {
        installed: obsidian_installed(),
        vault_registered: !vault_path.is_empty() && is_vault_registered(vault_path),
    }
}

/// Open `vault_path` in Obsidian, registering it as a vault first if needed.
///
/// Errors when Obsidian is not installed. The button should be disabled in that
/// case, so reaching here means the UI and the filesystem disagree — saying so
/// beats silently doing nothing.
#[tauri::command]
pub async fn obsidian_open_vault(vault_path: String) -> Result<OpenOutcome, String> {
    tokio::task::spawn_blocking(move || open_vault_blocking(&vault_path))
        .await
        .map_err(|e| format!("obsidian: open task failed: {e}"))?
}

fn open_vault_blocking(vault_path: &str) -> Result<OpenOutcome, String> {
    if vault_path.trim().is_empty() {
        return Err("obsidian: empty vault path".to_string());
    }
    let dir = Path::new(vault_path);
    if !dir.is_dir() {
        return Err(format!("obsidian: no such directory: {vault_path}"));
    }
    if !obsidian_installed() {
        return Err("obsidian: not installed".to_string());
    }

    if is_vault_registered(vault_path) {
        open_target(&open_uri(vault_path))?;
        return Ok(OpenOutcome::Opened);
    }

    // First time: seed the vault's own config, then register it.
    seed_vault_config(dir);
    register_vault(vault_path)?;

    if obsidian_is_running() {
        // The registry write lands, but the running instance will not see it.
        // Sending the URI now would be accepted and do nothing at all, which
        // reads as a broken button — say what happened instead.
        Ok(OpenOutcome::RegisteredNeedsRestart)
    } else {
        open_target(&open_uri(vault_path))?;
        Ok(OpenOutcome::Opened)
    }
}

// ---------------------------------------------------------------------------
// Installation cache
// ---------------------------------------------------------------------------

/// How long a "not installed" answer is trusted before the probes run again.
///
/// Installing Obsidian is the one thing that flips it, and that takes longer
/// than this. A found install is not subject to the TTL: it is re-verified by
/// a single `exists()` on the remembered path, which is as cheap as it gets.
const NOT_INSTALLED_TTL: Duration = Duration::from_secs(60);

struct AppPathProbe {
    at: Instant,
    found: Option<PathBuf>,
}

static APP_PATH_CACHE: Mutex<Option<AppPathProbe>> = Mutex::new(None);

/// [`obsidian_app_path`], remembered process-wide.
///
/// The probe is what made `obsidian_status` expensive: on macOS it ends in a
/// Spotlight query when the bundle is not in one of the two usual places, and
/// the frontend asks on every window focus.
fn cached_obsidian_app_path() -> Option<PathBuf> {
    let mut guard = APP_PATH_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(probe) = guard.as_ref() {
        match &probe.found {
            Some(path) if path.exists() => return Some(path.clone()),
            None if probe.at.elapsed() < NOT_INSTALLED_TTL => return None,
            // Found before but gone now, or a stale negative: probe again.
            _ => {}
        }
    }
    let found = obsidian_app_path();
    *guard = Some(AppPathProbe {
        at: Instant::now(),
        found: found.clone(),
    });
    found
}

/// Installed by either probe: a known bundle/executable path, or a registered
/// `obsidian://` handler (the path probe can miss portable installs).
fn obsidian_installed() -> bool {
    cached_obsidian_app_path().is_some() || uri_handler_registered()
}

// ---------------------------------------------------------------------------
// Vault registry
// ---------------------------------------------------------------------------

/// `<config dir>/obsidian/obsidian.json`.
///
/// `dirs::config_dir()` happens to be right on all three platforms:
/// `~/Library/Application Support` (macOS), `%APPDATA%` (Windows),
/// `~/.config` (Linux) — which is exactly where Obsidian keeps it.
fn registry_path() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("obsidian").join("obsidian.json"))
}

/// Compare two vault paths. Obsidian stores what it was given, so a trailing
/// separator difference must not read as a different vault.
fn same_vault_path(a: &str, b: &str) -> bool {
    a.trim_end_matches(['/', '\\']) == b.trim_end_matches(['/', '\\'])
}

/// Whether Obsidian's registry already lists this directory.
fn is_vault_registered(vault_path: &str) -> bool {
    let Some(registry) = registry_path() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(&registry) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    json.get("vaults")
        .and_then(|v| v.as_object())
        .is_some_and(|vaults| {
            vaults.values().any(|entry| {
                entry
                    .get("path")
                    .and_then(|p| p.as_str())
                    .is_some_and(|p| same_vault_path(p, vault_path))
            })
        })
}

/// Vault id: 16 hex chars, derived from the path.
///
/// Obsidian's own ids are opaque and look random; nothing reads them back, they
/// only key the dictionary and name a `<id>.json` window-state file. Deriving
/// ours from the path means a second registration of the same directory
/// overwrites its own entry instead of adding a duplicate.
fn vault_id(vault_path: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized = vault_path.trim_end_matches(['/', '\\']);
    let digest = Sha256::digest(normalized.as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Add `vault_path` to Obsidian's registry.
///
/// `open: false` deliberately: `true` would make Obsidian open this vault on
/// next launch instead of whatever the user had, and hijacking that is not what
/// a button labelled "open in Obsidian" is allowed to do.
fn register_vault(vault_path: &str) -> Result<(), String> {
    let registry = registry_path().ok_or_else(|| "obsidian: no config dir".to_string())?;
    if let Some(parent) = registry.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("obsidian: create {}: {e}", parent.display()))?;
    }

    // A missing or unparseable registry is treated as empty rather than fatal:
    // Obsidian rewrites this file wholesale, and refusing to proceed would make
    // the button permanently dead on a machine whose file we merely failed to
    // understand. `preserve_order` on serde_json keeps every other vault's
    // position intact through the round-trip.
    let mut json = std::fs::read_to_string(&registry)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));

    if !json.get("vaults").is_some_and(|v| v.is_object()) {
        json["vaults"] = serde_json::json!({});
    }
    let normalized = vault_path.trim_end_matches(['/', '\\']).to_string();
    prune_stale_team_vaults(&mut json, &normalized);
    json["vaults"][vault_id(&normalized)] = serde_json::json!({
        "path": normalized,
        "ts": now_millis(),
        "open": false,
    });

    // Atomic replace: Obsidian may read this file at any moment, and a
    // half-written registry loses every vault the user has.
    let tmp = registry.with_extension("json.teamclu-tmp");
    std::fs::write(
        &tmp,
        serde_json::to_string(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("obsidian: write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &registry)
        .map_err(|e| format!("obsidian: replace {}: {e}", registry.display()))?;
    Ok(())
}

/// Drop entries this app wrote that no longer point at anything.
///
/// The team knowledge directory moved once already (`shared/knowledge` ->
/// `shared/team-sync/knowledge`), and the entry left behind shows up in the
/// user's Obsidian as a vault that opens onto nothing. Registering the new one
/// does not remove the old.
///
/// # What it will not touch
///
/// Three conditions have to hold together, and each is there to make sure this
/// only ever removes something we put there ourselves:
///
///   * the id is one we would have generated for that path — a vault the user
///     added by hand has an id Obsidian chose, so it can never match;
///   * the path is inside a `teams/<id>/shared` directory, which is ours;
///   * the directory does not exist any more.
///
/// A vault the user keeps somewhere else, or one of ours that still resolves,
/// is left exactly where it is. Losing somebody's real vault list would be a
/// far worse outcome than leaving a dead entry behind, so the test is strict
/// rather than clever.
fn prune_stale_team_vaults(json: &mut serde_json::Value, keep: &str) {
    let Some(vaults) = json.get_mut("vaults").and_then(|v| v.as_object_mut()) else {
        return;
    };
    vaults.retain(|id, entry| {
        let Some(path) = entry.get("path").and_then(|p| p.as_str()) else {
            return true;
        };
        if same_vault_path(path, keep) {
            return true;
        }
        let ours = id == &vault_id(path.trim_end_matches(['/', '\\']))
            && path.contains("/teams/")
            && path.contains("/shared");
        if !ours {
            return true;
        }
        let gone = !std::path::Path::new(path).is_dir();
        if gone {
            tracing::info!(vault = %path, "removing a team vault entry that no longer resolves");
        }
        !gone
    });
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Defaults written into the vault's own `.obsidian/app.json` the first time.
///
/// - `attachmentFolderPath`: the attachment location this product assumes, so
///   an image pasted in Obsidian and one added from the app land together.
/// - `showUnsupportedFiles`: knowledge trees hold files with no `.md`
///   extension; without this Obsidian hides them and they look deleted.
/// - `alwaysUpdateLinks`: renaming a note rewrites the `[[links]]` pointing at
///   it. On a shared tree the alternative is one person's rename silently
///   breaking everyone else's links.
///
/// Never overwrites an existing `app.json` — that file is the user's.
/// `.obsidian/` is deliberately excluded from team sync, so this is per-device
/// setup, not shared config.
fn seed_vault_config(dir: &Path) {
    let config_dir = dir.join(".obsidian");
    let app_json = config_dir.join("app.json");
    if app_json.exists() {
        return;
    }
    if std::fs::create_dir_all(&config_dir).is_err() {
        return;
    }
    let defaults = serde_json::json!({
        "attachmentFolderPath": "attachments",
        "showUnsupportedFiles": true,
        "alwaysUpdateLinks": true,
    });
    // Best-effort: failing to seed defaults is not a reason to refuse to open
    // the vault. Obsidian writes its own `app.json` when it starts.
    let _ = std::fs::write(
        &app_json,
        serde_json::to_string_pretty(&defaults).unwrap_or_default(),
    );
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/// Build the `obsidian://open?path=<abs path>` URI for a vault directory.
///
/// Kept separate from the spawn so the encoding can be unit-tested without an
/// Obsidian install: encoding is the part that breaks. Home directories with a
/// space are common, and CJK folder names are routine in this product.
fn open_uri(vault_path: &str) -> String {
    format!("obsidian://open?path={}", urlencoding::encode(vault_path))
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
        // Not `cmd /C start "" <uri>`: `start` goes through cmd's parser, where
        // `&`, `|` and `^` in the argument are operators, so anything derived
        // from a caller-supplied path is a command injection waiting for the
        // one character the encoder misses. `explorer` hands its single
        // argument to ShellExecute as-is, which resolves the `obsidian://`
        // scheme to its registered handler without a shell in between.
        let mut c = Command::new("explorer.exe");
        c.no_window().arg(uri);
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

// ---------------------------------------------------------------------------
// Process and installation detection
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn obsidian_is_running() -> bool {
    Command::new("tasklist")
        .no_window()
        .args(["/FI", "IMAGENAME eq Obsidian.exe", "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("Obsidian.exe"))
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn obsidian_is_running() -> bool {
    // macOS's process is `Obsidian`, most Linux packages ship `obsidian`.
    ["Obsidian", "obsidian"].iter().any(|name| {
        Command::new("pgrep")
            .args(["-x", name])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

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

    /// The prune must only ever remove entries this app wrote, for directories
    /// that are gone. Everything else in a person's vault list is theirs.
    #[test]
    fn prune_keeps_everything_it_did_not_write() {
        let user_vault = "/Users/x/Notes";
        let ours_alive = "/Users/x/.amuxd/teams/t1/shared/team-sync/knowledge";
        let ours_dead = "/Users/x/.amuxd/teams/t1/shared/knowledge";

        let mut json = serde_json::json!({
            "vaults": {
                // A vault Obsidian registered itself: the id is not one we
                // would generate, so it can never match however its path looks.
                "0123456789abcdef": { "path": user_vault, "ts": 1, "open": false },
                // Ours, and the directory really is gone.
                vault_id(ours_dead): { "path": ours_dead, "ts": 2, "open": false },
                // Ours, under a teams dir, but with an id we did not generate.
                "ffffffffffffffff": { "path": ours_dead, "ts": 3, "open": false },
            }
        });

        prune_stale_team_vaults(&mut json, ours_alive);

        let vaults = json["vaults"].as_object().unwrap();
        assert!(
            vaults.contains_key("0123456789abcdef"),
            "a vault the user added must survive"
        );
        assert!(
            vaults.contains_key("ffffffffffffffff"),
            "an id we would not have generated is not ours to remove"
        );
        assert!(
            !vaults.contains_key(&vault_id(ours_dead)),
            "our own entry for a directory that is gone should be dropped"
        );
    }

    #[test]
    fn prune_keeps_a_team_vault_that_still_resolves() {
        // A real directory, so the "gone" test fails and the entry stays. Uses
        // the crate's own path so the check is against something that exists.
        let alive = std::env::temp_dir().join("teams/t1/shared/knowledge");
        std::fs::create_dir_all(&alive).unwrap();
        let alive = alive.to_string_lossy().to_string();

        let mut json = serde_json::json!({
            "vaults": { vault_id(&alive): { "path": alive, "ts": 1, "open": false } }
        });
        prune_stale_team_vaults(&mut json, "/somewhere/else");
        assert!(
            json["vaults"]
                .as_object()
                .unwrap()
                .contains_key(&vault_id(&alive)),
            "a team vault whose directory exists must be left alone"
        );
    }

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
    fn vault_id_is_sixteen_hex_and_stable() {
        let id = vault_id("/tmp/a");
        assert_eq!(id.len(), 16);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(id, vault_id("/tmp/a"));
        assert_ne!(id, vault_id("/tmp/b"));
    }

    /// A trailing separator must not produce a second registry entry for a
    /// directory that is already there.
    #[test]
    fn vault_id_ignores_a_trailing_separator() {
        assert_eq!(vault_id("/tmp/a"), vault_id("/tmp/a/"));
    }

    #[test]
    fn same_vault_path_ignores_trailing_separators() {
        assert!(same_vault_path("/tmp/a", "/tmp/a/"));
        assert!(same_vault_path("C:\\vault\\", "C:\\vault"));
        assert!(!same_vault_path("/tmp/a", "/tmp/ab"));
    }

    #[test]
    fn seeding_writes_defaults_into_a_fresh_vault() {
        let dir = tempfile::tempdir().unwrap();
        seed_vault_config(dir.path());
        let text = std::fs::read_to_string(dir.path().join(".obsidian/app.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["attachmentFolderPath"], "attachments");
        assert_eq!(json["showUnsupportedFiles"], true);
        assert_eq!(json["alwaysUpdateLinks"], true);
    }

    /// `app.json` is the user's file once it exists. Overwriting it would reset
    /// their editor settings every time they clicked the button.
    #[test]
    fn seeding_never_overwrites_an_existing_app_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".obsidian")).unwrap();
        std::fs::write(dir.path().join(".obsidian/app.json"), r#"{"mine":1}"#).unwrap();
        seed_vault_config(dir.path());
        let text = std::fs::read_to_string(dir.path().join(".obsidian/app.json")).unwrap();
        assert_eq!(text, r#"{"mine":1}"#);
    }

    #[test]
    fn opening_a_missing_directory_is_an_error() {
        let err = open_vault_blocking("/nope/does/not/exist").unwrap_err();
        assert!(err.contains("no such directory"), "{err}");
    }

    #[test]
    fn opening_an_empty_path_is_an_error() {
        assert!(open_vault_blocking("   ").is_err());
    }
}
