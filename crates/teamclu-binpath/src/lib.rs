//! Absolute-path fallbacks for the CLIs TeamClu shells out to.
//!
//! **The symptom this exists for: a tool that works perfectly in a terminal yet
//! reports "not installed" in the app.** A bare `Command::new("node")` can only
//! find what the process's own PATH lists, and neither app gets the PATH the
//! user's shell would have given it:
//!
//! - macOS hands a process started from Dock/Spotlight the bare system PATH
//!   (`/usr/bin:/bin:/usr/sbin:/sbin`), which contains none of the places these
//!   tools install into. The desktop repairs that before spawning the daemon
//!   (`fix_path_env` in `apps/desktop/src/lib.rs`), but that probe has a
//!   4-second timeout and a shell-profile-mtime cache, so a slow or unusual
//!   profile leaves the bare system PATH in place.
//! - On Windows `fix_path_env` returns immediately ("GUI apps generally inherit
//!   the full PATH"), which holds right up until the user installs Node after
//!   the app — or with nvm-windows / fnm / scoop, which never touch the machine
//!   PATH the app inherited at launch.
//!
//! opencode never had the problem, because it resolves
//! `~/.opencode/bin/opencode` by absolute path before falling back to the bare
//! name. This generalizes that step.
//!
//! It lives in a shared crate rather than in either app because it did not,
//! once: `apps/desktop`'s dependency probe kept its own bare-name lookup while
//! the daemon hardened this one, so the same machine answered "Node is
//! installed" in onboarding and "Node is missing" in Settings (#1049).
//!
//! Deliberately a fixed list rather than a filesystem crawl: it runs on every
//! `doctor` call and on the spawn path, so it must stay cheap and predictable.

use std::path::{Path, PathBuf};

/// Directories to search, in order. Home-relative first — a user-local install
/// is the one they chose most recently — then the system-wide package roots.
///
/// `/opt/homebrew` is Apple-silicon Homebrew, `/usr/local` covers Intel
/// Homebrew and npm's default global prefix.
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        // The official Claude Code and cursor-agent installers both land here.
        dirs.push(home.join(".local").join("bin"));
        // npm's global prefix when the user relocated it out of /usr/local.
        dirs.push(home.join(".npm-global").join("bin"));
        dirs.push(home.join("bin"));
        if cfg!(windows) {
            // Bun's Windows installer target. Only added here: the POSIX list
            // is left exactly as it was, since those platforms already work.
            dirs.push(home.join(".bun").join("bin"));
        }
    }
    if cfg!(windows) {
        // npm's global prefix on Windows. `npm install -g` writes its shims
        // here (`pi.cmd`), and nothing about a Node MSI install puts this
        // directory on a *service*-launched process's PATH.
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        // Where the Node.js MSI itself lands: `node.exe` plus `npm.cmd`.
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(program_files).join("nodejs"));
        }
    } else {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

/// The program name to hand `std::process::Command` on this platform.
///
/// Rust resolves a bare program name against PATH by appending `.exe` and
/// nothing else — it never consults `PATHEXT`. Everything npm ships is a
/// `.cmd` shim (`npm.cmd`, `npx.cmd`; there is no `npm.exe`), so
/// `Command::new("npm")` cannot start npm on Windows even with Node installed
/// and on PATH. That is what made `amuxd install-pi` bail with "neither npm
/// nor bun found" on a machine whose `node --version` worked fine — `node` is
/// a real `.exe`, so only the npm probe failed.
///
/// Only the shims are mapped. `bun`, `node` and friends are real executables
/// that the implicit `.exe` already resolves.
pub fn spawn_name(program: &str) -> String {
    if cfg!(windows) && matches!(program, "npm" | "npx" | "pnpm" | "yarn") {
        format!("{program}.cmd")
    } else {
        program.to_string()
    }
}

/// Executable file names to try for `name`, in order.
///
/// Windows has no single answer. A native CLI is `bun.exe`, but a global npm
/// install writes `pi.cmd` and no `pi.exe` at all — probing only `.exe` is why
/// a perfectly good `npm install -g` of pi still read as "not installed".
/// The extension-less `pi` npm writes beside the shim is a shell script
/// `CreateProcess` cannot start, so it is deliberately not a candidate.
fn exe_candidates(name: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    } else {
        vec![name.to_string()]
    }
}

/// First existing `<dir>/<name>` among the well-known directories.
///
/// `extra` is searched first, for a tool that owns a directory of its own
/// (`~/.pi/bin`, `~/.claude/local`).
pub fn find_with(name: &str, extra: &[PathBuf], dirs: &[PathBuf]) -> Option<PathBuf> {
    let files = exe_candidates(name);
    // Directory-major: an earlier directory wins over a later one whatever
    // extension each holds, so `extra` keeps beating the well-known dirs.
    extra
        .iter()
        .chain(dirs.iter())
        .flat_map(|dir| files.iter().map(move |file| dir.join(file)))
        .find(|candidate| is_executable_file(candidate))
}

/// [`find_with`] against the real well-known directories.
pub fn find(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    find_with(name, extra, &search_dirs())
}

/// `PATH` for a child process, with the well-known directories appended.
///
/// Finding a CLI by absolute path is not always enough to RUN it: npm installs
/// a shim whose shebang is `#!/usr/bin/env node`, so `/opt/homebrew/bin/pi`
/// (a symlink to `dist/cli.js`) dies with `env: node: No such file or directory`
/// under the bare system PATH even though the file is right there. Appending —
/// not prepending — keeps whatever the user's real PATH says authoritative when
/// we do have one.
pub fn augmented_path() -> std::ffi::OsString {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let existing: Vec<PathBuf> = std::env::split_paths(&current).collect();
    let mut all = existing.clone();
    for dir in search_dirs() {
        if !existing.contains(&dir) {
            all.push(dir);
        }
    }
    std::env::join_paths(all).unwrap_or(current)
}

/// Exists and is a file (following symlinks — the Claude Code installer puts a
/// symlink in `~/.local/bin` pointing at the versioned binary).
fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// The shared resolution order for a runtime binary:
/// explicit config → the tool's own directory → well-known dirs → bare name
/// (i.e. whatever PATH we do have).
///
/// `configured` follows the existing convention: `AgentBackendConfig.binary`
/// serde-defaults to the shared string `"claude"`, so that value means
/// "not configured" for every runtime that is not claude itself.
pub fn resolve_binary(name: &str, configured: Option<&str>, extra: &[PathBuf]) -> String {
    resolve_binary_with(name, configured, extra, &search_dirs())
}

/// [`resolve_binary`] against an explicit directory list, so tests do not
/// depend on what happens to be installed on the machine running them.
pub fn resolve_binary_with(
    name: &str,
    configured: Option<&str>,
    extra: &[PathBuf],
    dirs: &[PathBuf],
) -> String {
    if let Some(b) = configured {
        if !b.is_empty() && b != "claude" {
            return b.to_string();
        }
    }
    find_with(name, extra, dirs)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(&exe_candidates(name)[0]);
        std::fs::write(&p, "").unwrap();
        p
    }

    #[test]
    fn npm_is_probed_by_its_windows_shim_name() {
        // Regression: `Command::new("npm")` never resolves `npm.cmd`, so the
        // pi installer reported "neither npm nor bun found" on machines with
        // Node installed. Bun and node stay bare — they are real `.exe`s.
        if cfg!(windows) {
            assert_eq!(spawn_name("npm"), "npm.cmd");
            assert_eq!(spawn_name("npx"), "npx.cmd");
        } else {
            assert_eq!(spawn_name("npm"), "npm");
            assert_eq!(spawn_name("npx"), "npx");
        }
        assert_eq!(spawn_name("bun"), "bun");
        assert_eq!(spawn_name("node"), "node");
    }

    #[test]
    fn windows_looks_for_the_cmd_shim_too() {
        let got = exe_candidates("pi");
        if cfg!(windows) {
            assert_eq!(got, vec!["pi.exe", "pi.cmd", "pi.bat"]);
        } else {
            assert_eq!(got, vec!["pi"]);
        }
    }

    #[test]
    fn a_later_extension_in_an_earlier_dir_still_wins() {
        // Only meaningful on Windows, where a directory holds `pi.cmd` while a
        // later one may hold `pi.exe`; asserted everywhere so the ordering
        // contract is not silently inverted by a refactor.
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first");
        let second = tmp.path().join("second");
        let last_candidate = exe_candidates("pi").pop().unwrap();
        std::fs::create_dir_all(&first).unwrap();
        std::fs::write(first.join(&last_candidate), "").unwrap();
        touch(&second, "pi");
        assert_eq!(
            find_with("pi", &[], &[first.clone(), second]),
            Some(first.join(&last_candidate))
        );
    }

    #[test]
    fn windows_search_dirs_cover_the_npm_global_prefix() {
        let dirs = search_dirs();
        if cfg!(windows) {
            let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
            if let Some(appdata) = appdata {
                assert!(
                    dirs.contains(&appdata.join("npm")),
                    "%APPDATA%\\npm is where `npm install -g` puts pi.cmd"
                );
            }
        } else {
            assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
            assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
        }
    }

    #[test]
    fn extra_dirs_win_over_well_known_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let own = tmp.path().join("own");
        let brew = tmp.path().join("brew");
        let in_own = touch(&own, "pi");
        touch(&brew, "pi");
        assert_eq!(
            find_with(
                "pi",
                std::slice::from_ref(&own),
                std::slice::from_ref(&brew)
            ),
            Some(in_own)
        );
    }

    #[test]
    fn falls_through_the_dir_list_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first");
        let second = tmp.path().join("second");
        std::fs::create_dir_all(&first).unwrap();
        let in_second = touch(&second, "claude");
        assert_eq!(
            find_with("claude", &[], &[first, second]),
            Some(in_second),
            "an empty earlier directory must not stop the search"
        );
    }

    #[test]
    fn missing_everywhere_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(find_with("nope", &[], &[tmp.path().to_path_buf()]), None);
    }

    #[test]
    fn a_directory_named_like_the_binary_does_not_count() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(&exe_candidates("claude")[0])).unwrap();
        assert_eq!(find_with("claude", &[], &[tmp.path().to_path_buf()]), None);
    }

    #[test]
    fn explicit_config_beats_every_probe() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        touch(&dir, "pi");
        let dirs = [dir];
        assert_eq!(
            resolve_binary_with("pi", Some("/opt/pi"), &[], &dirs),
            "/opt/pi"
        );
        // The serde default for a shared field — treated as unconfigured, so
        // the probe still runs and wins over the bare name.
        assert_ne!(resolve_binary_with("pi", Some("claude"), &[], &dirs), "pi");
        assert_ne!(resolve_binary_with("pi", Some(""), &[], &dirs), "pi");
    }

    #[test]
    fn bare_name_is_the_last_resort() {
        // Nothing to find: keep the bare name so whatever PATH we do have still
        // gets a shot.
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_binary_with("claude", None, &[], &[tmp.path().to_path_buf()]),
            "claude"
        );
    }

    #[test]
    fn augmented_path_appends_without_dropping_the_existing_entries() {
        let before: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        let after: Vec<PathBuf> = std::env::split_paths(&augmented_path()).collect();
        for dir in &before {
            assert!(after.contains(dir), "{dir:?} must survive augmentation");
        }
        assert_eq!(
            &after[..before.len()],
            &before[..],
            "existing PATH stays first"
        );
        for dir in search_dirs() {
            assert!(after.contains(&dir), "{dir:?} must be reachable");
        }
    }
}
