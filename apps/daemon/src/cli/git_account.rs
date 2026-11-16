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

use std::io::{BufRead, Write};
// Only the unix socket path reads a raw stream; Windows goes through reqwest.
#[cfg(unix)]
use std::io::Read;
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
    /// Unix: the runtime-context socket, which checks the caller's process
    /// ancestry against the agent hosts amuxd spawned.
    AgentSocket {
        socket: PathBuf,
    },
    /// Windows (no peer-pid socket): the host's runtime-context bearer over
    /// loopback TCP — the same route Windows skills already use for the cloud
    /// token. The daemon checks the bearer against the live host generation.
    AgentBearer {
        url: String,
        token: String,
        host_generation_id: String,
        backend_kind: String,
    },
    Person,
}

/// amuxd puts the socket (unix only) and the URL / token / generation /
/// backend (every platform) into each agent host's environment; any of them
/// marks the caller as an agent. The socket wins when both are present: on
/// unix the TCP route refuses to issue the token at all.
pub fn caller_from_env(var: impl Fn(&str) -> Option<String>) -> Caller {
    let get = |key: &str| {
        var(key)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    if let Some(socket) = get(teamclu_runtime_env::TEAMCLU_RUNTIME_CONTEXT_SOCK_ENV) {
        return Caller::AgentSocket {
            socket: PathBuf::from(socket),
        };
    }
    let url = get(teamclu_runtime_env::TEAMCLU_RUNTIME_CONTEXT_URL_ENV);
    let token = get(teamclu_runtime_env::TEAMCLU_RUNTIME_CONTEXT_TOKEN_ENV);
    match (url, token) {
        (Some(url), Some(token)) => Caller::AgentBearer {
            url,
            token,
            host_generation_id: get(teamclu_runtime_env::TEAMCLU_HOST_GENERATION_ID_ENV)
                .unwrap_or_default(),
            backend_kind: get(teamclu_runtime_env::TEAMCLU_AGENT_BACKEND_ENV).unwrap_or_default(),
        },
        // Half of the pair is still an agent environment — refused below rather
        // than mistaken for a person.
        (Some(url), None) | (None, Some(url)) => Caller::AgentBearer {
            url,
            token: String::new(),
            host_generation_id: String::new(),
            backend_kind: String::new(),
        },
        (None, None) => Caller::Person,
    }
}

const UNCONFIRMED_AGENT: &str = "could not confirm this agent's identity (a background process \
     outlives the agent that started it) — run git in the foreground";

/// Unix agent with the TCP variables but no socket variable: amuxd sets the
/// socket whenever it could bind one, and the TCP route refuses to issue the
/// token on unix, so asking would only end in the misleading "background
/// process" refusal above.
#[cfg(unix)]
const NO_IDENTITY_SOCKET: &str = "this agent's daemon has no identity socket (amuxd could not \
     create run/runtime-context.sock — see the amuxd log), so git cannot act as this agent";

/// The login for an agent that arrived without a socket variable.
fn agent_login_without_socket(
    url: &str,
    bearer: &str,
    host_generation_id: &str,
    backend_kind: &str,
) -> Result<Login, String> {
    #[cfg(unix)]
    {
        let _ = (url, bearer, host_generation_id, backend_kind);
        Err(NO_IDENTITY_SOCKET.into())
    }
    #[cfg(not(unix))]
    {
        agent_login_bearer(url, bearer, host_generation_id, backend_kind)
    }
}

/// The login an agent gets from the daemon's token, named after its account.
fn agent_login_from_token(token: String) -> Login {
    let username = jwt_subject(&token)
        .map(|sub| gitea_user_name(&sub))
        .unwrap_or_else(|| "git".to_string());
    Login {
        username,
        password: token,
    }
}

/// The agent's login over loopback TCP with the host's bearer (Windows).
pub fn agent_login_bearer(
    url: &str,
    bearer: &str,
    host_generation_id: &str,
    backend_kind: &str,
) -> Result<Login, String> {
    if bearer.is_empty() || host_generation_id.is_empty() {
        return Err(UNCONFIRMED_AGENT.into());
    }
    let endpoint = format!(
        "{}/internal/runtime-context/cloud-token",
        url.trim_end_matches('/')
    );
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("cannot ask amuxd for this agent's identity ({e})"))?;
    let token = rt.block_on(async {
        // Loopback: never through a proxy, whatever the environment says.
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        let res = client
            .post(&endpoint)
            .bearer_auth(bearer)
            .header("Accept", "text/plain")
            .json(&serde_json::json!({
                "hostGenerationId": host_generation_id,
                "backendKind": backend_kind,
            }))
            .send()
            .await
            .map_err(|e| format!("cannot reach amuxd for this agent's identity ({e})"))?;
        if !res.status().is_success() {
            return Err(UNCONFIRMED_AGENT.to_string());
        }
        let body = res.text().await.map_err(|e| e.to_string())?;
        let body = body.trim().to_string();
        if body.is_empty() {
            return Err(UNCONFIRMED_AGENT.to_string());
        }
        Ok(body)
    })?;
    Ok(agent_login_from_token(token))
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
        return Err(UNCONFIRMED_AGENT.into());
    }
    Ok(agent_login_from_token(body.to_string()))
}

/// Never reached on Windows: amuxd sets no socket variable there, so an agent
/// arrives as [`Caller::AgentBearer`]. Kept so a stray variable still refuses
/// instead of falling back to the person's token.
#[cfg(not(unix))]
pub fn agent_login(_socket: &Path) -> Result<Login, String> {
    Err(UNCONFIRMED_AGENT.into())
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
        Caller::AgentSocket { socket } => agent_login(&socket),
        Caller::AgentBearer {
            url,
            token,
            host_generation_id,
            backend_kind,
        } => agent_login_without_socket(&url, &token, &host_generation_id, &backend_kind),
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
    #[cfg(not(unix))]
    use std::io::Read;

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

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn the_socket_variable_marks_a_unix_agent_and_wins_over_the_bearer() {
        let caller = caller_from_env(env(&[
            ("TEAMCLU_RUNTIME_CONTEXT_SOCK", "/run/x.sock"),
            ("TEAMCLU_RUNTIME_CONTEXT_URL", "http://127.0.0.1:1"),
            ("TEAMCLU_RUNTIME_CONTEXT_TOKEN", "t"),
        ]));
        assert_eq!(
            caller,
            Caller::AgentSocket {
                socket: PathBuf::from("/run/x.sock")
            }
        );
        assert_eq!(caller_from_env(|_| None), Caller::Person);
        assert_eq!(caller_from_env(|_| Some("  ".into())), Caller::Person);
    }

    #[test]
    fn the_runtime_context_url_and_token_mark_a_windows_agent() {
        let caller = caller_from_env(env(&[
            ("TEAMCLU_RUNTIME_CONTEXT_URL", "http://127.0.0.1:41000/"),
            ("TEAMCLU_RUNTIME_CONTEXT_TOKEN", "rtctx"),
            ("TEAMCLU_HOST_GENERATION_ID", "gen-1"),
            ("TEAMCLU_AGENT_BACKEND", "pi"),
        ]));
        assert_eq!(
            caller,
            Caller::AgentBearer {
                url: "http://127.0.0.1:41000/".into(),
                token: "rtctx".into(),
                host_generation_id: "gen-1".into(),
                backend_kind: "pi".into(),
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_unix_agent_without_the_socket_is_told_why_and_never_asks_over_tcp() {
        // Port 9 (discard) on loopback: if this ever tried TCP it would fail
        // with a connect error, not the socket sentence.
        let err =
            agent_login_without_socket("http://127.0.0.1:9", "rtctx", "gen-1", "pi").unwrap_err();
        assert!(err.contains("runtime-context.sock"), "{err}");
        assert!(!err.contains("background process"), "{err}");
    }

    #[test]
    fn half_an_agent_environment_is_still_an_agent_and_is_refused() {
        let caller = caller_from_env(env(&[("TEAMCLU_RUNTIME_CONTEXT_TOKEN", "rtctx")]));
        let Caller::AgentBearer {
            url,
            token,
            host_generation_id,
            backend_kind,
        } = caller
        else {
            panic!("must not be treated as a person: {caller:?}");
        };
        assert!(
            agent_login_bearer(&url, &token, &host_generation_id, &backend_kind)
                .unwrap_err()
                .contains("foreground")
        );
    }

    /// One-shot loopback HTTP server; returns (base url, captured request).
    fn serve_once(status: &'static str, body: String) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
            let mut buf = vec![0u8; 8192];
            let mut req = String::new();
            loop {
                let n = s.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                req.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some((head, rest)) = req.split_once("\r\n\r\n") {
                    let len = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if rest.len() >= len {
                        break;
                    }
                }
            }
            let resp = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = s.write_all(resp.as_bytes());
            req
        });
        (url, handle)
    }

    #[test]
    fn a_windows_agent_gets_the_daemon_token_with_its_host_bearer() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"sub":"cccccccc-0000-4000-8000-00000000000c"}"#);
        let daemon_token = format!("h.{payload}.s");
        let (url, server) = serve_once("200 OK", daemon_token.clone());
        let login = agent_login_bearer(&url, "rtctx-secret", "gen-7", "pi").unwrap();
        assert_eq!(login.username, "ucccccccc00004000800000000000000c");
        assert_eq!(login.password, daemon_token);
        let req = server.join().unwrap();
        assert!(
            req.starts_with("POST /internal/runtime-context/cloud-token "),
            "{req}"
        );
        assert!(req
            .to_ascii_lowercase()
            .contains("authorization: bearer rtctx-secret"));
        assert!(
            req.contains(r#""hostGenerationId":"gen-7""#) && req.contains(r#""backendKind":"pi""#)
        );
    }

    #[test]
    fn a_windows_agent_the_daemon_refuses_gets_no_login() {
        let (url, server) = serve_once("401 Unauthorized", String::new());
        assert!(agent_login_bearer(&url, "stale", "gen-old", "pi")
            .unwrap_err()
            .contains("foreground"));
        server.join().unwrap();
    }

    #[test]
    fn a_signed_out_file_keeps_the_host_known_and_asks_to_sign_in() {
        // What the desktop leaves on sign-out (git_credential_clear): host, no token.
        let raw = r#"{"gitHost":"gitea.example.com","gitScheme":"https","apiBase":null,"userId":null,"userName":null,"token":"","expiresAt":null}"#;
        let file: TokenFile = serde_json::from_str(raw).unwrap();
        assert!(known_hosts(Some(&file), &AccountCache::default())
            .contains(&"gitea.example.com".to_string()));
        let err = person_login(Some(&file), now()).unwrap_err();
        assert!(err.contains("not signed in"), "{err}");
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
