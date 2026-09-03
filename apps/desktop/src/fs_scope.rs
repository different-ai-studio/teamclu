//! The webview's filesystem scope (SEC-2 / ADR-0009).
//!
//! `capabilities/default.json` used to grant every `fs:` operation over
//! `$HOME/**` and `/**`. That is whole-disk read *and* write for the app
//! origin — the same origin that renders teammate markdown, agent-authored
//! dynamic UI, and arbitrary workspace files. `~/.ssh/id_rsa` was one
//! `readTextFile` away.
//!
//! ADR-0009 picked the narrow-scope option: grant the few roots the product
//! actually uses, and extend the scope at runtime as the user opens things.
//! This module is the runtime half.
//!
//! **Three sources of scope, and only the first is static:**
//!
//! 1. `capabilities/default.json` — the fixed dot-directories under `$HOME`
//!    that exist before any user action (skills roots).
//! 2. This module — the brand's amuxd home at startup, then each workspace as
//!    it is opened and any extra skill-scan directory the user has configured.
//! 3. Tauri itself — the dialog plugin calls `allow_file` / `allow_directory`
//!    for whatever the user picks in an open/save dialog, and the drag-drop
//!    handler does the same for dropped paths *before* emitting the event
//!    (`tauri::manager::window`). Neither needs anything from us, which is why
//!    "save an attachment anywhere" and "drag a file in from Finder" keep
//!    working under a narrow scope.
//!
//! Runtime grants live in memory and do **not** survive a restart. Anything
//! that must work on a cold start has to come from source 1 or 2, not from a
//! dialog the user used yesterday.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Runtime};
use tauri_plugin_fs::FsExt;

/// Directories the app needs before the user has done anything.
///
/// Deliberately *not* here: the system download directory. Every download in
/// the product (`saveDiagnosticZip`, attachment download, image save) writes to
/// a path returned by the save dialog, and the dialog plugin grants that path
/// itself — so a static Downloads grant would widen the scope for nothing.
fn fixed_roots() -> Vec<PathBuf> {
    let mut roots = vec![crate::commands::amuxd_home_dir()];
    if let Some(home) = dirs::home_dir() {
        // Skills. `~/.agents/skills` is where team packs and the inherent
        // skills are installed; `~/.claude/skills` is the fifth scan root in
        // `lib/skills/loader.ts`. Granting the parents rather than the
        // `skills` leaf keeps `origin.json` and sibling metadata readable.
        roots.push(home.join(".agents"));
        roots.push(home.join(".claude").join("skills"));
    }
    roots
}

/// Extend the webview's fs scope to a directory and everything under it.
///
/// A path that does not exist yet is still granted: the scope is a glob match,
/// not a filesystem check, and the frontend's first act in a fresh workspace is
/// often `mkdir`.
pub fn allow_directory<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    app.fs_scope()
        .allow_directory(path, true)
        .map_err(|e| format!("failed to widen fs scope to {}: {e}", path.display()))
}

/// Grant the fixed roots. Called once from `setup`.
///
/// Failures are logged, not fatal: a broken scope grant must not stop the app
/// from starting, and every caller of the affected paths already handles a
/// rejected fs call.
pub fn grant_fixed_roots<R: Runtime>(app: &AppHandle<R>) {
    for root in fixed_roots() {
        if let Err(e) = allow_directory(app, &root) {
            log::warn!("[FsScope] {e}");
        }
    }
}

/// Widen the fs scope to directories the frontend is about to read or write.
///
/// Called with the workspace root before anything touches it, and with the
/// user's configured extra skill-scan directories before they are scanned.
/// Both are known to the frontend first: the workspace lives in `localStorage`
/// and the scan paths in a config file the frontend parses, so having the
/// frontend ask is what keeps that parsing in one place.
///
/// This widens the scope and never narrows it, so it is safe to call again for
/// a directory that is already allowed. It is *not* a way to reach outside the
/// product's own roots by asking nicely — but it is deliberately unrestricted,
/// because the caller is the app origin and the app origin is what the scope
/// protects the rest of the disk *from*. Keep the call sites few and obvious.
#[tauri::command]
pub async fn allow_fs_scope_dirs(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        allow_directory(&app, Path::new(trimmed))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_roots_cover_the_amuxd_home_and_both_skill_roots() {
        let roots = fixed_roots();
        assert!(
            roots.contains(&crate::commands::amuxd_home_dir()),
            "the brand's amuxd home must be granted; it holds team knowledge and skill packs"
        );
        let Some(home) = dirs::home_dir() else {
            return;
        };
        assert!(roots.contains(&home.join(".agents")));
        assert!(roots.contains(&home.join(".claude").join("skills")));
    }

    /// The download directory is covered by the save dialog's own grant. If a
    /// download ever stops going through `save()`, this test is the reminder
    /// that the scope has to be widened deliberately rather than by accident.
    #[test]
    fn fixed_roots_do_not_include_the_download_directory() {
        let Some(downloads) = dirs::download_dir() else {
            return;
        };
        assert!(
            !fixed_roots().contains(&downloads),
            "downloads are granted by the save dialog, not statically"
        );
    }
}
