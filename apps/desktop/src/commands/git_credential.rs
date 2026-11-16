//! The person's git-only token, and the git config that uses it
//! (docs/specs/2026-11-16-app-platform-identity-design.md §4–6).
//!
//! The frontend mints a token with `POST /v1/git/token` after sign-in and hands
//! it here. It lands in this brand's own home (`~/.{brand}/git-credential.json`,
//! 0600), which the daemon only reads — the layout rule for personal secrets
//! (`docs/architecture/amuxd-home-layout-v2.md` §1). `amuxd git-credential`
//! reads it when git asks for a login to the TeamClu git host.
//!
//! The same call installs the global git config for that host:
//!
//! ```text
//! credential.<scheme>://<host>.helper = ""            (forget earlier helpers for this host)
//! credential.<scheme>://<host>.helper = !<amuxd> git-credential [--brand <b>]
//! credential.<scheme>://<host>.useHttpPath = true
//! ```
//!
//! `<scheme>` is `https` unless the server says its git host is plain `http`
//! (a self-host test box without TLS): git only consults a helper whose scheme
//! matches the URL it is fetching.
//!
//! The empty entry matters on macOS: the system git's osxkeychain helper would
//! otherwise store the short-lived token and replay it after it expires.
//!
//! Sign-out empties the token but keeps the host (and scheme, API base): with
//! no record of the host at all, the helper would treat it as a stranger's and
//! stay silent, and git would only say "could not read Username". Keeping it
//! lets the helper say "not signed in — open TeamClu". The token itself is
//! revoked server-side by the frontend before calling `git_credential_clear`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::{brand_home_dir, APP_SHORT_NAME};

const TOKEN_FILE_NAME: &str = "git-credential.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialFile {
    pub git_host: Option<String>,
    /// `https` (default) or `http`, from `POST /v1/git/token`'s `gitScheme`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_scheme: Option<String>,
    pub api_base: Option<String>,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub token: String,
    pub expires_at: Option<String>,
}

/// What the frontend needs to decide whether to mint a new token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialStatus {
    pub present: bool,
    pub user_id: Option<String>,
    pub expires_at: Option<String>,
    pub git_host: Option<String>,
}

fn token_file() -> PathBuf {
    brand_home_dir().join(TOKEN_FILE_NAME)
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&tmp, bytes)?;
    }
    std::fs::rename(&tmp, path)
}

/// The amuxd the git helper should run. The bundled sidecar's path is stable
/// across app updates (it lives inside the app bundle).
fn amuxd_path() -> Option<PathBuf> {
    super::amuxd_supervisor::locate_bundled_sidecar("amuxd")
}

fn shell_quote(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c));
    if plain {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

fn helper_command(amuxd: &Path) -> String {
    let brand = if teamclu_runtime_env::is_official_brand(APP_SHORT_NAME) {
        String::new()
    } else {
        format!(" --brand {}", shell_quote(APP_SHORT_NAME))
    };
    format!(
        "!{} git-credential{}",
        shell_quote(&amuxd.to_string_lossy()),
        brand
    )
}

fn git(args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut cmd = Command::new("git");
    cmd.args(args).env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.output()
}

/// The scheme the helper is keyed on: only an explicit `http` drops TLS.
fn helper_scheme(scheme: Option<&str>) -> &'static str {
    match scheme.map(str::trim) {
        Some(s) if s.eq_ignore_ascii_case("http") => "http",
        _ => "https",
    }
}

/// Install the global helper config for `<scheme>://<host>`. Idempotent.
fn install_global_helper(host: &str, scheme: Option<&str>, amuxd: &Path) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() || host.contains(['\n', '\r', ' ']) {
        return Err(format!(
            "refusing a git host that is not a host name: {host:?}"
        ));
    }
    let scheme = helper_scheme(scheme);
    let key = format!("credential.{scheme}://{host}.helper");
    // Exit 5: nothing to unset.
    let out = git(&["config", "--global", "--unset-all", &key]).map_err(|e| e.to_string())?;
    if !out.status.success() && out.status.code() != Some(5) {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    for value in ["", helper_command(amuxd).as_str()] {
        let out = git(&["config", "--global", "--add", &key, value]).map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
    }
    let path_key = format!("credential.{scheme}://{host}.useHttpPath");
    let out = git(&["config", "--global", &path_key, "true"]).map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

#[tauri::command]
pub fn git_credential_status() -> GitCredentialStatus {
    let file: Option<GitCredentialFile> = std::fs::read_to_string(token_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    match file {
        Some(f) if !f.token.trim().is_empty() => GitCredentialStatus {
            present: true,
            user_id: f.user_id,
            expires_at: f.expires_at,
            git_host: f.git_host,
        },
        _ => GitCredentialStatus {
            present: false,
            user_id: None,
            expires_at: None,
            git_host: None,
        },
    }
}

/// Store the minted token and point git at the helper for its host. The git
/// config step is best-effort: without git on PATH the file is still useful to
/// TeamClu's own checkouts, which carry their own repo-local helper config.
#[tauri::command]
pub fn git_credential_write(credential: GitCredentialFile) -> Result<(), String> {
    if credential.token.trim().is_empty() || credential.token.contains(['\n', '\r']) {
        return Err("git credential token is empty or malformed".into());
    }
    let bytes = serde_json::to_vec_pretty(&credential).map_err(|e| e.to_string())?;
    write_private(&token_file(), &bytes)
        .map_err(|e| format!("could not write git credential: {e}"))?;
    if let (Some(host), Some(amuxd)) = (credential.git_host.as_deref(), amuxd_path()) {
        if let Err(e) = install_global_helper(host, credential.git_scheme.as_deref(), &amuxd) {
            tracing::warn!(error = %e, "git credential: could not install the global git helper");
        }
    }
    Ok(())
}

/// What sign-out leaves behind: where the git host is, and nothing about who.
fn signed_out(file: GitCredentialFile) -> GitCredentialFile {
    GitCredentialFile {
        git_host: file.git_host,
        git_scheme: file.git_scheme,
        api_base: file.api_base,
        user_id: None,
        user_name: None,
        token: String::new(),
        expires_at: None,
    }
}

fn clear_at(path: &Path) -> Result<(), String> {
    let current: Option<GitCredentialFile> = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    match current {
        // Keep the host so the helper can tell the person to sign in again.
        Some(file)
            if file
                .git_host
                .as_deref()
                .is_some_and(|h| !h.trim().is_empty()) =>
        {
            let bytes = serde_json::to_vec_pretty(&signed_out(file)).map_err(|e| e.to_string())?;
            write_private(path, &bytes).map_err(|e| format!("could not clear git credential: {e}"))
        }
        // Nothing worth keeping (no host, or unreadable): remove it.
        _ => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("could not remove git credential: {e}")),
        },
    }
}

/// Sign-out: forget the token and who it belonged to; keep the host. The
/// global helper config stays, and now answers "not signed in" for that host.
#[tauri::command]
pub fn git_credential_clear() -> Result<(), String> {
    clear_at(&token_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_helper_runs_amuxd_in_global_mode() {
        let cmd = helper_command(Path::new("/Applications/TeamClu.app/Contents/MacOS/amuxd"));
        assert!(cmd.starts_with("!/Applications/TeamClu.app/Contents/MacOS/amuxd git-credential"));
        assert!(!cmd.contains("--app"));
        let spaced = helper_command(Path::new("/Users/me/Application Support/amuxd"));
        assert!(spaced.starts_with("!'/Users/me/Application Support/amuxd' git-credential"));
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x").join(TOKEN_FILE_NAME);
        write_private(&path, b"{}").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn a_host_with_spaces_or_newlines_is_refused() {
        assert!(install_global_helper("evil host", None, Path::new("/x/amuxd")).is_err());
        assert!(install_global_helper("a\nb", None, Path::new("/x/amuxd")).is_err());
    }

    #[test]
    fn the_helper_is_keyed_on_https_unless_the_server_says_http() {
        assert_eq!(helper_scheme(None), "https");
        assert_eq!(helper_scheme(Some("https")), "https");
        assert_eq!(helper_scheme(Some("HTTP")), "http");
        assert_eq!(helper_scheme(Some("ftp")), "https");
    }

    #[test]
    fn sign_out_keeps_the_host_and_drops_the_token_and_the_account() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        let file = GitCredentialFile {
            git_host: Some("git.example.com".into()),
            git_scheme: Some("https".into()),
            api_base: Some("https://api.example.com".into()),
            user_id: Some("u-1".into()),
            user_name: Some("uabc".into()),
            token: "secret-token".into(),
            expires_at: Some("2027-01-01T00:00:00Z".into()),
        };
        write_private(&path, &serde_json::to_vec(&file).unwrap()).unwrap();
        clear_at(&path).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("secret-token") && !raw.contains("u-1") && !raw.contains("uabc"),
            "{raw}"
        );
        let left: GitCredentialFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(left.git_host.as_deref(), Some("git.example.com"));
        assert_eq!(left.git_scheme.as_deref(), Some("https"));
        assert!(left.token.is_empty());
        // and the status the frontend reads says there is no token
        assert!(left.token.trim().is_empty());
    }

    #[test]
    fn sign_out_with_no_file_or_no_host_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        clear_at(&path).unwrap();
        assert!(!path.exists());
        std::fs::write(&path, r#"{"token":"t"}"#).unwrap();
        clear_at(&path).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn an_older_token_file_without_a_scheme_still_reads() {
        let f: GitCredentialFile =
            serde_json::from_str(r#"{"gitHost":"g.example","token":"t"}"#).unwrap();
        assert_eq!(f.git_scheme, None);
    }
}
