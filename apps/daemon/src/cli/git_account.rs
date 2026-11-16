//! `amuxd git-credential` with no `--app` — per-account git for TeamClu apps.
//!
//! docs/specs/2026-11-16-app-platform-identity-design.md §5–6. Git asks this
//! helper for a login to the TeamClu git host; it answers with the identity of
//! whoever is running git:
//!
//! * **An agent.** Its environment carries `TEAMCLU_RUNTIME_CONTEXT_SOCK`,
//!   which amuxd puts into every agent host it spawns. The helper asks that
//!   socket for the daemon account's login token; the socket hands it out only
//!   to processes the kernel says descend from such a host. If that fails —
//!   typically `nohup git push &`, which orphans the process and breaks the
//!   ancestry — the helper says why and answers nothing. It never falls back to
//!   the person's token: an agent's push must not land under a person's name.
//! * **A person.** No such variable. The helper reads the git-only token the
//!   desktop wrote to `~/.{brand}/git-credential.json` at sign-in.
//!
//! The variable only picks the path; the agent path still authenticates by
//! process ancestry. An agent that strips the variable reads the same file any
//! process of this OS user can read — which no scheme can prevent, and why the
//! file holds a git-only, 30-day, revocable token rather than a session.
//!
//! Hosts it does not know (any other forge) get no answer, so git moves on to
//! its next helper. Always exits 0, for the same reason the per-app helper does.

use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

pub use crate::sync::git_account_cache::{account_cache_path, AccountCache};

const TAG: &str = "[amuxd git]";

/// Where the desktop writes a person's git token, inside its own home.
pub const TOKEN_FILE_NAME: &str = "git-credential.json";

/// `~/.{brand}/git-credential.json`, written by the desktop (0600).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenFile {
    pub git_host: Option<String>,
    pub api_base: Option<String>,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub token: String,
    /// RFC 3339.
    pub expires_at: Option<String>,
}

/// `~/.{brand}/git-credential.json` — the desktop's home, which the daemon only reads.
pub fn token_file_path(brand: Option<&str>) -> PathBuf {
    let brand = brand
        .map(str::to_string)
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(teamclu_runtime_env::brand_short_name_from_env);
    teamclu_runtime_env::brand_home_dir(&brand).join(TOKEN_FILE_NAME)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Request {
    pub protocol: String,
    pub host: String,
    pub path: Option<String>,
}

pub fn read_request(input: impl BufRead) -> Request {
    let mut request = Request::default();
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.is_empty() {
            break;
        }
        match line.split_once('=') {
            Some(("protocol", v)) => request.protocol = v.to_string(),
            Some(("host", v)) => request.host = v.to_ascii_lowercase(),
            Some(("path", v)) => request.path = Some(v.to_string()),
            _ => {}
        }
    }
    request
}

/// Who is asking, as far as the helper can tell from its environment.
#[derive(Debug, PartialEq, Eq)]
pub enum Caller {
    Agent { socket: PathBuf },
    Person,
}

pub fn caller_from_env(var: impl Fn(&str) -> Option<String>) -> Caller {
    match var(teamclu_runtime_env::TEAMCLU_RUNTIME_CONTEXT_SOCK_ENV)
        .filter(|v| !v.trim().is_empty())
    {
        Some(socket) => Caller::Agent {
            socket: PathBuf::from(socket),
        },
        None => Caller::Person,
    }
}

/// A login to hand git.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Login {
    pub username: String,
    pub password: String,
}

/// `u` + the account id without dashes — the Gitea user FC created for it.
pub fn gitea_user_name(account_id: &str) -> String {
    format!("u{}", account_id.replace('-', "").to_ascii_lowercase())
}

/// The `sub` of a JWT, unverified: the server verifies, this only names the user.
pub fn jwt_subject(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get("sub")?.as_str().map(str::to_string)
}

fn expired(expires_at: Option<&str>, now: chrono::DateTime<chrono::Utc>) -> bool {
    match expires_at.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) {
        Some(at) => at.with_timezone(&chrono::Utc) <= now,
        None => false,
    }
}

/// The person's login from the token file, or the reason there is none.
pub fn person_login(
    file: Option<&TokenFile>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Login, String> {
    let file = file.ok_or("not signed in — open TeamClu and sign in to use git")?;
    if file.token.trim().is_empty() {
        return Err("not signed in — open TeamClu and sign in to use git".into());
    }
    if expired(file.expires_at.as_deref(), now) {
        return Err("your TeamClu git sign-in has expired — open TeamClu to renew it".into());
    }
    let username = file
        .user_name
        .clone()
        .or_else(|| file.user_id.as_deref().map(gitea_user_name))
        .unwrap_or_else(|| "git".to_string());
    Ok(Login {
        username,
        password: file.token.trim().to_string(),
    })
}

/// The agent's login from the runtime-context socket, or the reason there is none.
#[cfg(unix)]
pub fn agent_login(socket: &Path) -> Result<Login, String> {
    use std::os::unix::net::UnixStream;
    let mut stream = UnixStream::connect(socket)
        .map_err(|e| format!("cannot reach amuxd for this agent's identity ({e})"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request = "POST /internal/runtime-context/cloud-token HTTP/1.1\r\nHost: amuxd\r\nAccept: text/plain\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("cannot ask amuxd for this agent's identity ({e})"))?;
    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|e| format!("no answer from amuxd ({e})"))?;
    let status: u16 = raw
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let body = raw
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.trim())
        .unwrap_or("");
    if status != 200 || body.is_empty() {
        return Err(
            "could not confirm this agent's identity (a background process outlives the agent \
             that started it) — run git in the foreground"
                .into(),
        );
    }
    let token = body.to_string();
    let username = jwt_subject(&token)
        .map(|sub| gitea_user_name(&sub))
        .unwrap_or_else(|| "git".to_string());
    Ok(Login {
        username,
        password: token,
    })
}

#[cfg(not(unix))]
pub fn agent_login(_socket: &Path) -> Result<Login, String> {
    Err("agent git identity is not available on this platform yet".into())
}

fn read_token_file(path: &Path) -> Option<TokenFile> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn read_cache() -> AccountCache {
    std::fs::read_to_string(account_cache_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Hosts this helper answers for: the person's token file and the daemon's cache.
pub fn known_hosts(file: Option<&TokenFile>, cache: &AccountCache) -> Vec<String> {
    let mut hosts: Vec<String> = cache.hosts.iter().map(|h| h.to_ascii_lowercase()).collect();
    if let Some(h) = file.and_then(|f| f.git_host.as_deref()) {
        let h = h.trim().to_ascii_lowercase();
        if !h.is_empty() && !hosts.contains(&h) {
            hosts.push(h);
        }
    }
    hosts
}

pub fn answer(login: &Login) -> Option<String> {
    let one_line = |v: &str| !v.contains(['\n', '\r', '\0']);
    (one_line(&login.username) && one_line(&login.password))
        .then(|| format!("username={}\npassword={}\n", login.username, login.password))
}

pub fn run(brand: Option<&str>, operation: &str) -> i32 {
    let request = read_request(std::io::stdin().lock());
    if operation != "get" {
        return 0;
    }
    let file = read_token_file(&token_file_path(brand));
    let cache = read_cache();
    if !known_hosts(file.as_ref(), &cache).contains(&request.host) {
        return 0;
    }
    let login = match caller_from_env(|k| std::env::var(k).ok()) {
        Caller::Agent { socket } => agent_login(&socket),
        Caller::Person => person_login(file.as_ref(), chrono::Utc::now()),
    };
    let login = match login {
        Ok(l) => l,
        Err(reason) => {
            eprintln!("{TAG} {reason}");
            return 0;
        }
    };
    let api_base = file
        .as_ref()
        .and_then(|f| f.api_base.clone())
        .or(cache.api_base.clone());
    if let (Some(base), Some(path)) = (api_base, request.path.as_deref()) {
        if let Some(hint) = access_hint(&base, path, &login.password) {
            eprintln!("{TAG} {hint}");
        }
    }
    if let Some(reply) = answer(&login) {
        let mut out = std::io::stdout().lock();
        if let Err(e) = out.write_all(reply.as_bytes()).and_then(|()| out.flush()) {
            eprintln!("{TAG} could not answer git: {e}");
        }
    }
    0
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Access {
    app_name: String,
    permission: Option<String>,
    actor_name: Option<String>,
    actor_type: Option<String>,
}

/// One sentence when the caller holds nothing on the app, else None. Best-effort
/// with a short timeout: the git operation must never wait on the hint.
fn access_hint(api_base: &str, repo_path: &str, token: &str) -> Option<String> {
    let url = format!(
        "{}/v1/git/access?repo={}",
        api_base.trim_end_matches('/'),
        urlencoding_component(repo_path)
    );
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    let access: Access = rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .ok()?;
        let res = client.get(&url).bearer_auth(token).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json::<Access>().await.ok()
    })?;
    hint_for(&access)
}

fn hint_for(access: &Access) -> Option<String> {
    if access.permission.is_some() {
        return None;
    }
    let who = match (access.actor_type.as_deref(), access.actor_name.as_deref()) {
        (Some("agent"), Some(name)) => format!("agent「{name}」"),
        (_, Some(name)) => format!("「{name}」"),
        _ => "you".to_string(),
    };
    Some(format!(
        "{who} has no access to app「{}」— grant it under Apps → Collaborators (应用 → 协作权限)",
        access.app_name
    ))
}

fn urlencoding_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-11-17T08:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn reads_protocol_host_and_path() {
        let r = read_request(
            "protocol=https\nhost=Gitea.Example.com\npath=o1/tc-app-1.git\n\n".as_bytes(),
        );
        assert_eq!(
            r,
            Request {
                protocol: "https".into(),
                host: "gitea.example.com".into(),
                path: Some("o1/tc-app-1.git".into())
            }
        );
    }

    #[test]
    fn the_socket_variable_marks_an_agent() {
        let agent = caller_from_env(|k| {
            (k == "TEAMCLU_RUNTIME_CONTEXT_SOCK").then(|| "/run/x.sock".to_string())
        });
        assert_eq!(
            agent,
            Caller::Agent {
                socket: PathBuf::from("/run/x.sock")
            }
        );
        assert_eq!(caller_from_env(|_| None), Caller::Person);
        assert_eq!(caller_from_env(|_| Some("  ".into())), Caller::Person);
    }

    #[test]
    fn a_person_answers_with_the_token_file() {
        let file = TokenFile {
            git_host: Some("gitea.example.com".into()),
            user_id: Some("AAAAAAAA-0000-4000-8000-00000000000A".into()),
            token: "git-token".into(),
            expires_at: Some("2026-12-01T00:00:00Z".into()),
            ..Default::default()
        };
        let login = person_login(Some(&file), now()).unwrap();
        assert_eq!(
            login,
            Login {
                username: "uaaaaaaaa00004000800000000000000a".into(),
                password: "git-token".into()
            }
        );
        assert_eq!(
            answer(&login).unwrap(),
            "username=uaaaaaaaa00004000800000000000000a\npassword=git-token\n"
        );
    }

    #[test]
    fn a_person_without_a_valid_token_gets_a_reason() {
        assert!(person_login(None, now()).unwrap_err().contains("sign in"));
        let stale = TokenFile {
            token: "t".into(),
            expires_at: Some("2026-11-01T00:00:00Z".into()),
            ..Default::default()
        };
        assert!(person_login(Some(&stale), now())
            .unwrap_err()
            .contains("expired"));
    }

    #[test]
    fn only_known_hosts_are_answered() {
        let file = TokenFile {
            git_host: Some("Gitea.Example.com".into()),
            token: "t".into(),
            ..Default::default()
        };
        let cache = AccountCache {
            hosts: vec!["git.headless.box".into()],
            api_base: None,
        };
        let hosts = known_hosts(Some(&file), &cache);
        assert!(hosts.contains(&"gitea.example.com".to_string()));
        assert!(hosts.contains(&"git.headless.box".to_string()));
        assert!(!hosts.contains(&"github.com".to_string()));
        assert!(known_hosts(None, &AccountCache::default()).is_empty());
    }

    #[test]
    fn the_jwt_subject_names_the_agent_user() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"sub":"bbbbbbbb-0000-4000-8000-00000000000b"}"#);
        let token = format!("x.{payload}.y");
        assert_eq!(
            jwt_subject(&token).as_deref(),
            Some("bbbbbbbb-0000-4000-8000-00000000000b")
        );
        assert_eq!(
            gitea_user_name("bbbbbbbb-0000-4000-8000-00000000000b"),
            "ubbbbbbbb00004000800000000000000b"
        );
        assert_eq!(jwt_subject("not-a-jwt"), None);
    }

    #[test]
    fn multi_line_values_are_never_answered() {
        assert!(answer(&Login {
            username: "u".into(),
            password: "a\nb".into()
        })
        .is_none());
    }

    #[test]
    fn the_hint_names_an_ungranted_agent_and_stays_quiet_otherwise() {
        let none = Access {
            app_name: "订单看板".into(),
            permission: None,
            actor_name: Some("小助手".into()),
            actor_type: Some("agent".into()),
        };
        let hint = hint_for(&none).unwrap();
        assert!(hint.contains("agent「小助手」") && hint.contains("订单看板"));
        let some = Access {
            app_name: "x".into(),
            permission: Some("read".into()),
            actor_name: None,
            actor_type: None,
        };
        assert!(hint_for(&some).is_none());
    }

    #[test]
    fn repo_paths_are_query_encoded() {
        assert_eq!(
            urlencoding_component("o1/tc-app-1.git"),
            "o1%2Ftc-app-1.git"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_agent_path_never_falls_back_when_the_socket_refuses() {
        use std::os::unix::net::UnixListener;
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("rt.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        });
        let err = agent_login(&sock).unwrap_err();
        assert!(err.contains("foreground"));
        server.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_agent_path_uses_the_daemon_token() {
        use std::os::unix::net::UnixListener;
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("rt.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"sub":"bbbbbbbb-0000-4000-8000-00000000000b"}"#);
        let token = format!("h.{payload}.s");
        let body = token.clone();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = s.write_all(resp.as_bytes());
        });
        let login = agent_login(&sock).unwrap();
        assert_eq!(login.username, "ubbbbbbbb00004000800000000000000b");
        assert_eq!(login.password, token);
        server.join().unwrap();
    }
}
