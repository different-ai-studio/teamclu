//! `amuxd git-credential --app <id> <get|store|erase>` — the credential helper
//! git runs inside an app checkout whose repo is reached over http(s).
//!
//! The https counterpart of [`super::git_ssh`]. An imported repo lives on
//! someone else's forge, so there is no key to mint; what the cloud holds is the
//! token the app's admin stored (`PUT /v1/apps/:id/git-credential`). The
//! checkout names this helper in `.git/config`, so whenever the forge asks git
//! for a login, git asks here, this asks the daemon, and the daemon asks the
//! cloud. The token lands nowhere: not in the remote URL, not in `.git/config`,
//! not in a credential store.
//!
//! ### Protocol
//!
//! git writes `key=value` lines ending in a blank line to stdin and reads the
//! same shape back from stdout. Only `get` is answered. `store` and `erase` are
//! git reporting what worked, and the cloud copy is the only place the
//! credential lives.
//!
//! ### Where the credential comes from
//!
//! The environment first: the daemon's own clone passes the credential it was
//! just handed in `AMUXD_GIT_HTTPS_*`, because the desktop read it a moment ago
//! and a second cloud round trip would buy nothing. Otherwise the daemon socket.
//!
//! ### Failure behaviour
//!
//! Fail *open* to git, unlike `git-ssh`: exit 0 with nothing on stdout, so git
//! moves on to its next helper or its own error. A machine whose own helper
//! knows the host keeps working. One line on stderr says why this helper had
//! nothing, so a failing `git pull` names the reason.

use std::io::{BufRead, Write};
use std::path::Path;

use serde_json::{json, Value};

use crate::sync::app_git;

/// Prefix on every message this helper prints.
const TAG: &str = "[amuxd git-credential]";

/// Run the helper for one git `operation`. Always exits 0 — see the module docs.
pub fn run(sock_path: &Path, app_id: &str, operation: &str) -> i32 {
    // Read git's attributes whatever the operation: git writes them either way,
    // and a pipe nobody reads can fail its write before it gets to our reply.
    let request = read_request(std::io::stdin().lock());
    if operation != "get" {
        return 0;
    }
    let stored = match credential_for(sock_path, app_id) {
        Ok(Some(stored)) => stored,
        Ok(None) => return 0,
        Err(reason) => {
            eprintln!("{TAG} {reason}");
            return 0;
        }
    };
    let Some(reply) = answer(&request, &stored) else {
        return 0;
    };
    let mut out = std::io::stdout().lock();
    if let Err(e) = out.write_all(reply.as_bytes()).and_then(|()| out.flush()) {
        eprintln!("{TAG} could not answer git: {e}");
    }
    0
}

/// The attributes of one request that decide whether to answer it.
#[derive(Debug, Default, PartialEq, Eq)]
struct Request {
    protocol: String,
    /// `host` or `host:port`, exactly as the remote URL spells it.
    host: String,
}

fn read_request(input: impl BufRead) -> Request {
    let mut request = Request::default();
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.is_empty() {
            break;
        }
        match line.split_once('=') {
            Some(("protocol", value)) => request.protocol = value.to_string(),
            Some(("host", value)) => request.host = value.to_string(),
            _ => {}
        }
    }
    request
}

/// A token and the repo it belongs to.
struct Stored {
    remote_url: String,
    username: String,
    token: String,
}

fn credential_for(sock_path: &Path, app_id: &str) -> Result<Option<Stored>, String> {
    if let Some(stored) = from_env(|key| std::env::var(key).ok()) {
        return Ok(Some(stored));
    }
    let request = json!({ "cmd": "app-git-credential", "appId": app_id });
    let result = sock_result(sock_path, &request)
        .map_err(|e| format!("no stored credential for this app: {e}"))?;
    if result.get("authKind").and_then(Value::as_str) == Some(app_git::HTTPS_TOKEN_AUTH_KIND) {
        return Ok(stored_from_result(&result));
    }
    // A deploy key: this repo is reached over ssh, where `git-ssh` is the one to
    // use it. Asking minted it, so hand it straight back instead of leaving a
    // live write key to the expiry sweep.
    if let Some(key_id) = result.get("deployKeyId").and_then(Value::as_i64) {
        let revoke = json!({
            "cmd": "app-git-credential",
            "action": "revoke",
            "appId": app_id,
            "deployKeyId": key_id,
        });
        let _ = sock_result(sock_path, &revoke);
    }
    Ok(None)
}

fn from_env(var: impl Fn(&str) -> Option<String>) -> Option<Stored> {
    let remote_url = var(app_git::ENV_GIT_HTTPS_REMOTE).filter(|u| !u.is_empty())?;
    let token = var(app_git::ENV_GIT_HTTPS_TOKEN).filter(|t| !t.is_empty())?;
    let username = var(app_git::ENV_GIT_HTTPS_USERNAME)
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| app_git::DEFAULT_GIT_HTTPS_USERNAME.to_string());
    Some(Stored {
        remote_url,
        username,
        token,
    })
}

fn stored_from_result(result: &Value) -> Option<Stored> {
    let text = |key: &str| {
        result
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    Some(Stored {
        remote_url: text("remoteUrl")?,
        username: text("username")
            .unwrap_or_else(|| app_git::DEFAULT_GIT_HTTPS_USERNAME.to_string()),
        token: text("token")?,
    })
}

/// git's reply, or None when this request is not for the token's own repo.
fn answer(request: &Request, stored: &Stored) -> Option<String> {
    let (scheme, host) = app_git::http_remote_authority(&stored.remote_url)?;
    // The token belongs to one forge. A redirect, a submodule or an LFS server
    // on another host asks this same helper, and answering would hand the token
    // to whoever runs it.
    if !request.protocol.eq_ignore_ascii_case(&scheme) || !request.host.eq_ignore_ascii_case(&host)
    {
        return None;
    }
    let one_line = |v: &str| !v.contains(['\n', '\r', '\0']);
    if !one_line(&stored.username) || !one_line(&stored.token) {
        return None;
    }
    Some(format!(
        "username={}\npassword={}\n",
        stored.username, stored.token
    ))
}

/// One sock round trip, unwrapped to the `result` object or a readable reason.
fn sock_result(sock_path: &Path, request: &Value) -> Result<Value, String> {
    let raw = super::sock::sock_roundtrip(sock_path, &request.to_string())
        .map_err(|e| format!("amuxd is not reachable on {} ({e})", sock_path.display()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(remote_url: &str) -> Stored {
        Stored {
            remote_url: remote_url.to_string(),
            username: "me".to_string(),
            token: "ghp_abc".to_string(),
        }
    }

    fn request(protocol: &str, host: &str) -> Request {
        Request {
            protocol: protocol.to_string(),
            host: host.to_string(),
        }
    }

    #[test]
    fn reads_the_attributes_up_to_the_blank_line() {
        let input = "protocol=https\nhost=github.com\npath=o/r.git\n\nhost=ignored\n";
        assert_eq!(
            read_request(input.as_bytes()),
            request("https", "github.com")
        );
    }

    #[test]
    fn answers_the_forge_the_token_belongs_to() {
        let reply = answer(
            &request("https", "github.com"),
            &stored("https://github.com/o/r.git"),
        );
        assert_eq!(reply.as_deref(), Some("username=me\npassword=ghp_abc\n"));
    }

    #[test]
    fn host_case_does_not_matter_but_the_host_does() {
        let token_repo = stored("https://GitHub.com/o/r.git");
        assert!(answer(&request("https", "github.com"), &token_repo).is_some());
        assert!(answer(&request("https", "evil.example"), &token_repo).is_none());
        assert!(answer(&request("https", "github.com.evil.example"), &token_repo).is_none());
    }

    #[test]
    fn a_different_scheme_or_port_is_a_different_server() {
        assert!(answer(
            &request("http", "github.com"),
            &stored("https://github.com/o/r.git")
        )
        .is_none());
        assert!(answer(
            &request("https", "git.internal"),
            &stored("https://git.internal:8443/o/r.git")
        )
        .is_none());
        assert!(answer(
            &request("https", "git.internal:8443"),
            &stored("https://git.internal:8443/o/r.git")
        )
        .is_some());
    }

    #[test]
    fn a_value_that_would_break_the_protocol_is_not_sent() {
        let mut bad = stored("https://github.com/o/r.git");
        bad.token = "a\nquit=1".to_string();
        assert!(answer(&request("https", "github.com"), &bad).is_none());
    }

    #[test]
    fn the_clone_environment_needs_a_repo_and_a_token() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| v.to_string())
            }
        };
        let full = from_env(env(&[
            (app_git::ENV_GIT_HTTPS_REMOTE, "https://github.com/o/r.git"),
            (app_git::ENV_GIT_HTTPS_TOKEN, "tok"),
        ]))
        .expect("remote and token are enough");
        assert_eq!(full.username, app_git::DEFAULT_GIT_HTTPS_USERNAME);
        assert_eq!(full.token, "tok");

        assert!(from_env(env(&[(app_git::ENV_GIT_HTTPS_TOKEN, "tok")])).is_none());
        assert!(from_env(env(&[(
            app_git::ENV_GIT_HTTPS_REMOTE,
            "https://github.com/o/r.git"
        )]))
        .is_none());
    }

    #[test]
    fn a_cloud_reply_without_a_token_is_no_credential() {
        let with = json!({ "authKind": "https_token", "remoteUrl": "https://h/o/r", "token": "t" });
        let parsed = stored_from_result(&with).expect("has a token");
        assert_eq!(parsed.username, app_git::DEFAULT_GIT_HTTPS_USERNAME);

        let without = json!({ "authKind": "https_token", "remoteUrl": "https://h/o/r" });
        assert!(stored_from_result(&without).is_none());
    }
}
