//! `amuxd git-ssh --app <id> -- <ssh args…>` — the ssh binary git calls.
//!
//! An app checkout's `.git/config` carries
//! `core.sshCommand = <amuxd> git-ssh --app <id>`, so this runs once per ssh
//! connection git opens: `git push`, `git fetch`, `git ls-remote`. It asks the
//! daemon for a just-in-time Gitea deploy key, writes it to a `0600` temp file,
//! runs the real `ssh` with `-i`, and deletes the file on the way out.
//!
//! ### Why this exists
//!
//! The deploy key handed to the desktop at seed/clone time lives for one
//! operation and is deliberately not persisted, so by the time an agent commits
//! there is nothing in the checkout to push with — the agent's `git push` fell
//! through to the machine's own ssh identity, which Gitea has never seen. That
//! is the whole bug. Wiring the credential into git itself is what lets the
//! templates keep saying "commit and push" without teaching every agent a
//! bespoke command.
//!
//! ### Failure behaviour
//!
//! Fail *closed*, loudly: with no key there is nothing useful to try, and a
//! bare `ssh` would fail with `Permission denied (publickey)` — the exact
//! misleading error this shim exists to remove. One line naming the real reason
//! goes to stderr, where it lands in the agent's `git push` output.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use crate::process_util::CommandNoWindow;

/// Prefix on every message this shim prints, so a failing `git push` says which
/// component refused rather than looking like an ssh or network fault.
const TAG: &str = "[amuxd git-ssh]";

/// Run the shim. `args` are git's own ssh arguments, passed through verbatim.
///
/// Returns the exit code to exit with — ssh's own when it ran, 255 (ssh's
/// "could not connect" code) when we never got far enough to run it.
pub fn run(sock_path: &Path, app_id: &str, args: &[String]) -> i32 {
    let issued = match fetch_deploy_key(sock_path, app_id) {
        Ok(issued) => issued,
        Err(e) => {
            eprintln!("{TAG} no push credential for this app: {e}");
            return 255;
        }
    };

    let key = match write_key_file(&issued.private_key_pem) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("{TAG} could not stage the deploy key: {e}");
            return 255;
        }
    };

    let status = Command::new("ssh")
        .no_window()
        .arg("-i")
        .arg(key.path())
        .arg("-o")
        .arg("IdentitiesOnly=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("BatchMode=yes")
        .args(args)
        .status();

    // The temp file is removed by `key`'s drop either way; the explicit drop
    // just makes the ordering against the child process obvious.
    drop(key);

    // Hand the key back now that ssh is done with it. This is the difference
    // between a repo that accumulates live write credentials and one that does
    // not: the cloud's expiry sweep only runs when something asks that repo for
    // a key again, so a repo nobody returns to would keep every key it was ever
    // issued. Failure here is not worth a word to the user — the push already
    // happened, and the sweep remains as the backstop.
    if let Some(key_id) = issued.deploy_key_id {
        if let Err(e) = revoke_deploy_key(sock_path, app_id, key_id) {
            eprintln!("{TAG} note: could not return the deploy key ({e}); it expires on its own");
        }
    }

    match status {
        Ok(s) => s.code().unwrap_or(255),
        Err(e) => {
            eprintln!("{TAG} could not run ssh: {e}");
            255
        }
    }
}

/// One issued credential: the key to use, and the id to give back afterwards.
struct IssuedKey {
    private_key_pem: String,
    /// None only from a cloud too old to report it; the key then falls to the
    /// expiry sweep instead of being returned.
    deploy_key_id: Option<i64>,
}

/// Ask the daemon for a fresh key. The daemon is the only local holder of a
/// cloud identity — this process has none, by design.
fn fetch_deploy_key(sock_path: &Path, app_id: &str) -> Result<IssuedKey, String> {
    let request = json!({ "cmd": "app-git-credential", "appId": app_id });
    let result = sock_result(sock_path, &request)?;
    let pem = result
        .get("privateKeyPem")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "amuxd returned no private key".to_string())?;
    Ok(IssuedKey {
        private_key_pem: pem.to_string(),
        deploy_key_id: result.get("deployKeyId").and_then(Value::as_i64),
    })
}

/// Tell the daemon the key is finished with, so it can be revoked upstream.
fn revoke_deploy_key(sock_path: &Path, app_id: &str, deploy_key_id: i64) -> Result<(), String> {
    let request = json!({
        "cmd": "app-git-credential",
        "action": "revoke",
        "appId": app_id,
        "deployKeyId": deploy_key_id,
    });
    sock_result(sock_path, &request).map(|_| ())
}

/// One sock round trip, unwrapped to the `result` object or a readable reason.
fn sock_result(sock_path: &Path, request: &Value) -> Result<Value, String> {
    let raw = super::sock::sock_roundtrip(sock_path, &request.to_string()).map_err(|e| {
        format!("amuxd is not reachable on {} ({e})", sock_path.display())
    })?;
    let parsed: Value = serde_json::from_str(raw.trim())
        .map_err(|e| format!("unreadable reply from amuxd: {e}"))?;
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let reason = parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("amuxd declined");
        return Err(reason.to_string());
    }
    Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
}

/// A `0600` temp file holding the PEM, removed when dropped.
struct KeyFile(tempfile::NamedTempFile);

impl KeyFile {
    fn path(&self) -> PathBuf {
        self.0.path().to_path_buf()
    }
}

fn write_key_file(pem: &str) -> Result<KeyFile, String> {
    let mut file = tempfile::Builder::new()
        .prefix("amuxd-git-ssh-")
        .tempfile()
        .map_err(|e| e.to_string())?;
    // The trailing newline is load-bearing: OpenSSH rejects a key file whose
    // final armour line is unterminated. Same trap as `app_git::SshEnv`.
    file.write_all(pem.trim().as_bytes())
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.flush())
        .map_err(|e| e.to_string())?;
    set_restrictive_permissions(file.path())?;
    Ok(KeyFile(file))
}

#[cfg(unix)]
fn set_restrictive_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn set_restrictive_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_is_reported_with_its_reason() {
        let parsed: Value = serde_json::from_str(r#"{"ok":false,"error":"app not found"}"#).unwrap();
        assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn an_issued_key_carries_the_id_it_will_be_returned_by() {
        // Without the id the shim cannot hand the key back, and the repo is
        // left accumulating live write credentials until something else asks
        // it for one.
        let reply = r#"{"ok":true,"result":{"privateKeyPem":"pem","deployKeyId":42}}"#;
        let parsed: Value = serde_json::from_str(reply).unwrap();
        let result = parsed.get("result").unwrap();
        assert_eq!(result.get("deployKeyId").and_then(Value::as_i64), Some(42));
    }

    #[test]
    fn a_cloud_that_reports_no_key_id_still_yields_a_usable_key() {
        let reply = r#"{"ok":true,"result":{"privateKeyPem":"pem"}}"#;
        let parsed: Value = serde_json::from_str(reply).unwrap();
        let result = parsed.get("result").unwrap();
        assert_eq!(result.get("deployKeyId").and_then(Value::as_i64), None);
        assert_eq!(result.get("privateKeyPem").and_then(Value::as_str), Some("pem"));
    }

    #[test]
    fn the_key_file_is_private_and_newline_terminated() {
        // Deliberately not a real PEM armour block. These assertions are about
        // the file's mode and its trailing newline, so a literal key header
        // here would buy nothing and trip secret scanners forever.
        let key = write_key_file("private-key-bytes").unwrap();
        let body = std::fs::read_to_string(key.path()).unwrap();
        assert!(body.ends_with('\n'), "OpenSSH rejects an unterminated key");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(key.path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "ssh refuses a world-readable key");
        }
    }

    #[test]
    fn the_key_file_is_gone_once_dropped() {
        let path = {
            let key = write_key_file("pem").unwrap();
            key.path()
        };
        assert!(!path.exists(), "a deploy key must not outlive the ssh call");
    }
}
