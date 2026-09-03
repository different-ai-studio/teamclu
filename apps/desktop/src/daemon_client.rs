//! The one client for amuxd's loopback HTTP API.
//!
//! Before this module every caller re-read `amuxd.http.{port,token}`, built its
//! own `reqwest::Client`, and ran its own `POST /v1/auth/exchange` — a dozen
//! copies of each, and the team-sync proxy exchanged a fresh 300-second token on
//! every call. This file is the single place that:
//!
//! - discovers the daemon ([`discover`]),
//! - owns the shared HTTP client ([`http`]),
//! - exchanges and caches scoped session tokens ([`session_token`]), keyed by
//!   endpoint + scope set and refreshed ahead of the daemon-side expiry,
//! - issues requests whose failures are typed ([`DaemonError`]) — a body that
//!   does not decode is an error, never an `Ok(empty)`.
//!
//! Restart handling needs no signal from the supervisor: the daemon binds a
//! fresh loopback port and mints a fresh root token on every start, and both
//! are part of the token-cache key, so a restart makes every cached token
//! unreachable by construction. A daemon that comes back on the same port
//! answers `401` to the old session token; [`dispatch`] drops it and retries
//! once with a new exchange.
//!
//! Callers keep their `Result<_, String>` boundaries via `From<DaemonError>
//! for String`; the typed error is for the places that need to branch (daemon
//! down vs. real failure).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;

pub use teamclu_types::daemon_http as wire;

/// `<amuxd run dir>/amuxd.http.port` — the bound TCP port, decimal.
pub const PORT_FILE: &str = "amuxd.http.port";
/// `<amuxd run dir>/amuxd.http.token` — the root bearer token.
pub const TOKEN_FILE: &str = "amuxd.http.token";
/// What the daemon's `exchange_handler` uses when no ttl is given.
pub const DEFAULT_TOKEN_TTL_SECS: u64 = 3600;
/// The daemon rejects anything longer.
pub const MAX_TOKEN_TTL_SECS: u64 = 86_400;

/// Sugar for the body argument of unit/GET requests.
pub const NO_BODY: Option<&()> = None;

/// Where the daemon listens and the root credential that unlocks token exchange.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonEndpoint {
    /// e.g. `http://127.0.0.1:52341`
    pub base_url: String,
    pub root_token: String,
}

impl DaemonEndpoint {
    pub fn new(base_url: impl Into<String>, root_token: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            root_token: root_token.into(),
        }
    }

    fn url(&self, path: &str, query: &str) -> String {
        format!("{}{}{}", self.base_url, path, query)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DaemonError {
    /// No listener published: port/token files absent, or the token not written yet.
    #[error("daemon HTTP port/token files not present (is amuxd running?)")]
    NotRunning,
    #[error("invalid daemon HTTP port file: {0:?}")]
    InvalidPort(String),
    #[error("daemon auth/exchange request failed: {0}")]
    ExchangeTransport(#[source] reqwest::Error),
    #[error("daemon auth/exchange {status}: {body}")]
    ExchangeRejected { status: u16, body: String },
    #[error("daemon auth/exchange decode failed: {source} (body: {snippet:?})")]
    ExchangeDecode {
        #[source]
        source: serde_json::Error,
        snippet: String,
    },
    #[error("daemon request {path} failed: {source}")]
    Transport {
        path: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("daemon {path} {status}: {body}")]
    Status {
        path: String,
        status: u16,
        body: String,
    },
    #[error("daemon {path} decode failed: {source} (body: {snippet:?})")]
    Decode {
        path: String,
        #[source]
        source: serde_json::Error,
        snippet: String,
    },
}

impl DaemonError {
    /// The daemon is not reachable at all. Callers that treat "daemon down" as
    /// a soft no-op branch on this; everything else is a real failure.
    pub fn is_unavailable(&self) -> bool {
        matches!(self, Self::NotRunning | Self::InvalidPort(_))
    }

    /// HTTP status the daemon answered with, when it answered.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Status { status, .. } | Self::ExchangeRejected { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl From<DaemonError> for String {
    fn from(err: DaemonError) -> String {
        err.to_string()
    }
}

// ─── discovery ──────────────────────────────────────────────────────────────

/// Read the daemon's published port and root token for this brand's amuxd home.
///
/// Not cached on purpose: two tiny file reads cost nothing, and the files are
/// rewritten on every daemon start, so reading them is what keeps the client
/// pointing at the live listener after a restart.
pub fn discover() -> Result<DaemonEndpoint, DaemonError> {
    discover_in(&crate::commands::amuxd_run_dir())
}

/// [`discover`] against an explicit run directory.
pub fn discover_in(run_dir: &Path) -> Result<DaemonEndpoint, DaemonError> {
    let port_raw =
        std::fs::read_to_string(run_dir.join(PORT_FILE)).map_err(|_| DaemonError::NotRunning)?;
    let port_str = port_raw.trim();
    let port: u16 = port_str
        .parse()
        .ok()
        .filter(|p| *p != 0)
        .ok_or_else(|| DaemonError::InvalidPort(port_str.to_owned()))?;
    let root_token = std::fs::read_to_string(run_dir.join(TOKEN_FILE))
        .map_err(|_| DaemonError::NotRunning)?
        .trim()
        .to_owned();
    if root_token.is_empty() {
        // The daemon creates the file before it writes the token.
        return Err(DaemonError::NotRunning);
    }
    Ok(DaemonEndpoint {
        base_url: format!("http://127.0.0.1:{port}"),
        root_token,
    })
}

// ─── shared HTTP client ─────────────────────────────────────────────────────

/// The process-wide client for daemon calls. No request timeout here — the
/// SSE stream and `prompt-await`-length turns run on it — so callers that
/// want one set it per request via [`RequestSpec::timeout`].
pub fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Loopback only: a system HTTP proxy must never see these.
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

// ─── scoped session tokens ──────────────────────────────────────────────────

/// Which scopes to ask for and how long the daemon should honor the token.
#[derive(Debug, Clone, Copy)]
pub struct TokenSpec<'a> {
    pub scopes: &'a [&'a str],
    pub ttl_seconds: u64,
}

impl<'a> TokenSpec<'a> {
    pub const fn new(scopes: &'a [&'a str]) -> Self {
        Self {
            scopes,
            ttl_seconds: DEFAULT_TOKEN_TTL_SECS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TokenKey {
    base_url: String,
    root_token: String,
    /// Sorted and deduplicated, so `[a, b]` and `[b, a]` share a token.
    scopes: Vec<String>,
}

impl TokenKey {
    fn new(endpoint: &DaemonEndpoint, scopes: &[&str]) -> Self {
        let mut scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
        scopes.sort();
        scopes.dedup();
        Self {
            base_url: endpoint.base_url.clone(),
            root_token: endpoint.root_token.clone(),
            scopes,
        }
    }
}

struct CachedToken {
    token: String,
    expires_at: Instant,
}

fn token_cache() -> &'static Mutex<HashMap<TokenKey, CachedToken>> {
    static CACHE: OnceLock<Mutex<HashMap<TokenKey, CachedToken>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_token(key: &TokenKey) -> Option<String> {
    let cache = token_cache().lock().unwrap_or_else(|p| p.into_inner());
    cache
        .get(key)
        .filter(|entry| Instant::now() < entry.expires_at)
        .map(|entry| entry.token.clone())
}

fn store_token(key: TokenKey, token: String, ttl: Duration) {
    let mut cache = token_cache().lock().unwrap_or_else(|p| p.into_inner());
    let now = Instant::now();
    // Only expired entries are evicted. Tokens minted by a previous daemon
    // listener are unreachable once the endpoint changes (the key includes
    // base_url and root_token), so they age out on their own within the TTL.
    // Evicting by endpoint here made the cache a process-wide side effect:
    // two callers on different endpoints in one process (the wiremock tests)
    // kept deleting each other's entries between store and lookup.
    cache.retain(|_, v| now < v.expires_at);
    cache.insert(
        key,
        CachedToken {
            token,
            expires_at: now + ttl,
        },
    );
}

/// Drop the cached token for these scopes (used after a `401`).
pub fn forget_token(endpoint: &DaemonEndpoint, scopes: &[&str]) {
    let mut cache = token_cache().lock().unwrap_or_else(|p| p.into_inner());
    cache.remove(&TokenKey::new(endpoint, scopes));
}

/// How long to trust a token locally: 10% ahead of the daemon-side expiry,
/// capped at five minutes early, never less than a second.
pub(crate) fn local_ttl(ttl_seconds: u64) -> Duration {
    let ttl = ttl_seconds.max(1);
    let margin = (ttl / 10).min(300);
    Duration::from_secs((ttl - margin).max(1))
}

fn snippet(text: &str) -> String {
    text.chars().take(200).collect()
}

/// A session token carrying `spec.scopes`, from the cache when one is still
/// good, otherwise via `POST /v1/auth/exchange` with the root token.
pub async fn session_token(
    endpoint: &DaemonEndpoint,
    spec: TokenSpec<'_>,
) -> Result<String, DaemonError> {
    let key = TokenKey::new(endpoint, spec.scopes);
    if let Some(token) = cached_token(&key) {
        return Ok(token);
    }
    let ttl_seconds = spec.ttl_seconds.clamp(1, MAX_TOKEN_TTL_SECS);
    let body = wire::AuthExchangeRequest {
        scopes: key.scopes.clone(),
        ttl_seconds,
        label: Some(format!("{}-desktop", crate::commands::APP_SHORT_NAME)),
    };
    let resp = http()
        .post(endpoint.url("/v1/auth/exchange", ""))
        .bearer_auth(&endpoint.root_token)
        .timeout(Duration::from_secs(10))
        .json(&body)
        .send()
        .await
        .map_err(DaemonError::ExchangeTransport)?;
    let status = resp.status();
    let text = resp.text().await.map_err(DaemonError::ExchangeTransport)?;
    if !status.is_success() {
        return Err(DaemonError::ExchangeRejected {
            status: status.as_u16(),
            body: text,
        });
    }
    let parsed: wire::AuthExchangeResponse =
        serde_json::from_str(&text).map_err(|source| DaemonError::ExchangeDecode {
            source,
            snippet: snippet(&text),
        })?;
    store_token(key, parsed.token.clone(), local_ttl(ttl_seconds));
    Ok(parsed.token)
}

// ─── requests ───────────────────────────────────────────────────────────────

/// One daemon call: route, the scopes it needs, and an optional timeout.
#[derive(Debug, Clone)]
pub struct RequestSpec<'a> {
    pub method: reqwest::Method,
    /// e.g. `/v1/team/sync`
    pub path: &'a str,
    /// Pre-encoded, with its leading `?`, or empty.
    pub query: &'a str,
    pub token: TokenSpec<'a>,
    /// Whole-request timeout. Leave `None` for streams.
    pub timeout: Option<Duration>,
}

impl<'a> RequestSpec<'a> {
    pub fn new(method: reqwest::Method, path: &'a str, scopes: &'a [&'a str]) -> Self {
        Self {
            method,
            path,
            query: "",
            token: TokenSpec::new(scopes),
            timeout: None,
        }
    }

    pub fn get(path: &'a str, scopes: &'a [&'a str]) -> Self {
        Self::new(reqwest::Method::GET, path, scopes)
    }

    pub fn post(path: &'a str, scopes: &'a [&'a str]) -> Self {
        Self::new(reqwest::Method::POST, path, scopes)
    }

    pub fn put(path: &'a str, scopes: &'a [&'a str]) -> Self {
        Self::new(reqwest::Method::PUT, path, scopes)
    }

    pub fn query(mut self, query: &'a str) -> Self {
        self.query = query;
        self
    }

    pub fn ttl(mut self, ttl_seconds: u64) -> Self {
        self.token.ttl_seconds = ttl_seconds;
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }
}

/// Build, authorize and send; on the first `401` drop the cached session token
/// and try once more with a fresh exchange.
async fn dispatch<F>(
    endpoint: &DaemonEndpoint,
    spec: &RequestSpec<'_>,
    attach: F,
) -> Result<reqwest::Response, DaemonError>
where
    F: Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
{
    let mut retried = false;
    loop {
        let token = session_token(endpoint, spec.token).await?;
        let mut builder = http()
            .request(spec.method.clone(), endpoint.url(spec.path, spec.query))
            .bearer_auth(&token);
        if let Some(timeout) = spec.timeout {
            builder = builder.timeout(timeout);
        }
        let resp = attach(builder)
            .send()
            .await
            .map_err(|source| DaemonError::Transport {
                path: spec.path.to_owned(),
                source,
            })?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED && !retried {
            forget_token(endpoint, spec.token.scopes);
            retried = true;
            continue;
        }
        return Ok(resp);
    }
}

/// Send with an optional JSON body; the raw response is yours (streams, bytes).
pub async fn send<B: Serialize + ?Sized>(
    endpoint: &DaemonEndpoint,
    spec: RequestSpec<'_>,
    body: Option<&B>,
) -> Result<reqwest::Response, DaemonError> {
    dispatch(endpoint, &spec, |builder| match body {
        Some(json) => builder.json(json),
        None => builder,
    })
    .await
}

/// Send an opaque body with an explicit content type (protobuf RPC).
pub async fn send_bytes(
    endpoint: &DaemonEndpoint,
    spec: RequestSpec<'_>,
    content_type: &str,
    payload: &[u8],
) -> Result<reqwest::Response, DaemonError> {
    dispatch(endpoint, &spec, |builder| {
        builder
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(payload.to_vec())
    })
    .await
}

/// Read the body of a 2xx response; anything else becomes [`DaemonError::Status`].
pub async fn success_body(path: &str, resp: reqwest::Response) -> Result<String, DaemonError> {
    let status = resp.status();
    let text = resp.text().await.map_err(|source| DaemonError::Transport {
        path: path.to_owned(),
        source,
    })?;
    if !status.is_success() {
        return Err(DaemonError::Status {
            path: path.to_owned(),
            status: status.as_u16(),
            body: text,
        });
    }
    Ok(text)
}

/// Decode a 2xx JSON body into `R`; a body that does not parse is an error.
pub async fn decode<R: DeserializeOwned>(
    path: &str,
    resp: reqwest::Response,
) -> Result<R, DaemonError> {
    let text = success_body(path, resp).await?;
    serde_json::from_str(&text).map_err(|source| DaemonError::Decode {
        path: path.to_owned(),
        source,
        snippet: snippet(&text),
    })
}

/// Send and decode a JSON response.
pub async fn call<B: Serialize + ?Sized, R: DeserializeOwned>(
    endpoint: &DaemonEndpoint,
    spec: RequestSpec<'_>,
    body: Option<&B>,
) -> Result<R, DaemonError> {
    let path = spec.path.to_owned();
    let resp = send(endpoint, spec, body).await?;
    decode(&path, resp).await
}

/// Send and require success; the body is ignored.
pub async fn call_unit<B: Serialize + ?Sized>(
    endpoint: &DaemonEndpoint,
    spec: RequestSpec<'_>,
    body: Option<&B>,
) -> Result<(), DaemonError> {
    let path = spec.path.to_owned();
    let resp = send(endpoint, spec, body).await?;
    success_body(&path, resp).await.map(|_| ())
}

/// [`discover`] then [`call`].
pub async fn call_discovered<B: Serialize + ?Sized, R: DeserializeOwned>(
    spec: RequestSpec<'_>,
    body: Option<&B>,
) -> Result<R, DaemonError> {
    let endpoint = discover()?;
    call(&endpoint, spec, body).await
}

/// [`discover`] then [`call_unit`].
pub async fn call_unit_discovered<B: Serialize + ?Sized>(
    spec: RequestSpec<'_>,
    body: Option<&B>,
) -> Result<(), DaemonError> {
    let endpoint = discover()?;
    call_unit(&endpoint, spec, body).await
}

// ─── identity ───────────────────────────────────────────────────────────────

/// `GET /v1/setup/status`. Unauthenticated by design: an unclaimed daemon has
/// no token to give, and the answer for one is just "setup needed".
pub async fn setup_status(
    endpoint: &DaemonEndpoint,
) -> Result<wire::SetupStatusResponse, DaemonError> {
    let path = "/v1/setup/status";
    let resp = http()
        .get(endpoint.url(path, ""))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|source| DaemonError::Transport {
            path: path.to_owned(),
            source,
        })?;
    decode(path, resp).await
}

fn actor_id_cell() -> &'static Mutex<Option<String>> {
    static CELL: Mutex<Option<String>> = Mutex::new(None);
    &CELL
}

/// The daemon's actor id as last reported by `/v1/setup/status` (or recorded
/// at onboarding). `None` until the daemon has been seen, or when it is unclaimed.
pub fn cached_actor_id() -> Option<String> {
    actor_id_cell()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// Record the daemon's actor id. An empty id clears the cache.
pub fn note_actor_id(actor_id: &str) {
    let trimmed = actor_id.trim();
    *actor_id_cell().lock().unwrap_or_else(|p| p.into_inner()) = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    };
}

/// Forget the actor id (daemon state wiped).
pub fn clear_actor_id() {
    note_actor_id("");
}

/// Ask the daemon who it is and remember the answer.
pub async fn refresh_actor_id(endpoint: &DaemonEndpoint) -> Result<Option<String>, DaemonError> {
    let status = setup_status(endpoint).await?;
    let actor = status
        .actor_id
        .filter(|_| status.claimed)
        .map(|a| a.trim().to_owned())
        .filter(|a| !a.is_empty());
    match &actor {
        Some(id) => note_actor_id(id),
        None => clear_actor_id(),
    }
    Ok(actor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn exchange_mock(ep: &DaemonEndpoint, token: &str) -> Mock {
        Mock::given(method("POST"))
            .and(path("/v1/auth/exchange"))
            .and(header(
                "authorization",
                format!("Bearer {}", ep.root_token).as_str(),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "token": token,
                "token_id": "00000000-0000-0000-0000-000000000001",
                "scopes": ["workspace:read"],
                "expires_at": "2026-09-02T00:00:00Z"
            })))
    }

    fn endpoint(server: &MockServer) -> DaemonEndpoint {
        // Unique per call: wiremock reuses ports across tests in one process, and the
        // token cache is keyed by (base_url, root_token), so a shared root token let a
        // previous test's cached session token satisfy a later test on the same port.
        static NEXT_ROOT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let n = NEXT_ROOT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        DaemonEndpoint::new(server.uri(), format!("root-{n}"))
    }

    #[test]
    fn discover_reads_port_and_token_and_names_each_failure() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            discover_in(dir.path()),
            Err(DaemonError::NotRunning)
        ));

        std::fs::write(dir.path().join(PORT_FILE), "not-a-port\n").unwrap();
        std::fs::write(dir.path().join(TOKEN_FILE), "tok\n").unwrap();
        match discover_in(dir.path()) {
            Err(DaemonError::InvalidPort(raw)) => assert_eq!(raw, "not-a-port"),
            other => panic!("expected InvalidPort, got {other:?}"),
        }

        std::fs::write(dir.path().join(PORT_FILE), " 52341 \n").unwrap();
        std::fs::write(dir.path().join(TOKEN_FILE), "").unwrap();
        assert!(
            matches!(discover_in(dir.path()), Err(DaemonError::NotRunning)),
            "an empty token file is the daemon mid-start"
        );

        std::fs::write(dir.path().join(TOKEN_FILE), "tok\n").unwrap();
        let ep = discover_in(dir.path()).unwrap();
        assert_eq!(ep.base_url, "http://127.0.0.1:52341");
        assert_eq!(ep.root_token, "tok");
        assert!(DaemonError::NotRunning.is_unavailable());
        assert!(DaemonError::InvalidPort("0".into()).is_unavailable());
    }

    #[test]
    fn local_ttl_refreshes_ahead_of_the_daemon_expiry() {
        assert_eq!(local_ttl(3600), Duration::from_secs(3300));
        assert_eq!(local_ttl(86_400), Duration::from_secs(86_100));
        assert_eq!(local_ttl(300), Duration::from_secs(270));
        assert_eq!(local_ttl(1), Duration::from_secs(1));
        assert_eq!(local_ttl(0), Duration::from_secs(1));
    }

    #[test]
    fn token_key_ignores_scope_order_and_duplicates() {
        let ep = DaemonEndpoint::new("http://127.0.0.1:1", "r");
        assert_eq!(
            TokenKey::new(
                &ep,
                &["workspace:write", "workspace:read", "workspace:read"]
            ),
            TokenKey::new(&ep, &["workspace:read", "workspace:write"])
        );
    }

    #[tokio::test]
    async fn session_token_is_exchanged_once_per_endpoint_and_scope_set() {
        let server = MockServer::start().await;
        let ep = endpoint(&server);
        exchange_mock(&ep, "sess-1").expect(1).mount(&server).await;

        let a = session_token(&ep, TokenSpec::new(&["workspace:read"]))
            .await
            .unwrap();
        let b = session_token(&ep, TokenSpec::new(&["workspace:read"]))
            .await
            .unwrap();
        assert_eq!(a, "sess-1");
        assert_eq!(b, "sess-1");
    }

    #[tokio::test]
    async fn exchange_rejection_carries_status_and_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/auth/exchange"))
            .respond_with(ResponseTemplate::new(401).set_body_string("stale root token"))
            .mount(&server)
            .await;
        let err = session_token(&endpoint(&server), TokenSpec::new(&["admin"]))
            .await
            .unwrap_err();
        assert_eq!(err.status(), Some(401));
        assert!(err.to_string().contains("stale root token"), "{err}");
    }

    #[tokio::test]
    async fn a_401_drops_the_cached_token_and_retries_once() {
        let server = MockServer::start().await;
        let ep = endpoint(&server);
        exchange_mock(&ep, "sess-2").expect(2).mount(&server).await;
        // First attempt: revoked. wiremock evaluates mocks in mount order and
        // retires this one after a single match, so the retry sees the 200.
        Mock::given(method("GET"))
            .and(path("/v1/ping"))
            .respond_with(ResponseTemplate::new(401))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/ping"))
            .and(header("authorization", "Bearer sess-2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "ok": true })))
            .mount(&server)
            .await;

        let body: serde_json::Value =
            call(&ep, RequestSpec::get("/v1/ping", &["events:read"]), NO_BODY)
                .await
                .unwrap();
        assert_eq!(body, json!({ "ok": true }));
    }

    #[tokio::test]
    async fn a_body_that_does_not_decode_is_an_error_not_an_empty_default() {
        let server = MockServer::start().await;
        let ep = endpoint(&server);
        exchange_mock(&ep, "sess-3").mount(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/workspaces"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>not json</html>"))
            .mount(&server)
            .await;

        let err = call::<(), wire::ListWorkspacesResponse>(
            &ep,
            RequestSpec::get("/v1/workspaces", &["workspace:read"]),
            NO_BODY,
        )
        .await
        .unwrap_err();
        match &err {
            DaemonError::Decode { path, snippet, .. } => {
                assert_eq!(path, "/v1/workspaces");
                assert!(snippet.contains("not json"));
            }
            other => panic!("expected Decode, got {other:?}"),
        }
        assert!(!err.is_unavailable());
    }

    #[tokio::test]
    async fn non_2xx_surfaces_status_and_body_for_unit_calls_too() {
        let server = MockServer::start().await;
        let ep = endpoint(&server);
        exchange_mock(&ep, "sess-4").mount(&server).await;
        Mock::given(method("POST"))
            .and(path("/v1/team/link"))
            .respond_with(ResponseTemplate::new(422).set_body_string("path is not a dir"))
            .mount(&server)
            .await;

        let err = call_unit(
            &ep,
            RequestSpec::post("/v1/team/link", &["workspace:write"]),
            Some(&wire::TeamLinkRequest {
                path: Some("/nowhere".into()),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.status(), Some(422));
        assert!(err.to_string().contains("path is not a dir"), "{err}");
    }

    #[tokio::test]
    async fn refresh_actor_id_reads_setup_status_and_clears_when_unclaimed() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/setup/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "claimed": true, "actorId": "actor-7", "teamId": "team-1"
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/setup/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "claimed": false, "actorId": null, "teamId": null
            })))
            .mount(&server)
            .await;

        let ep = endpoint(&server);
        assert_eq!(
            refresh_actor_id(&ep).await.unwrap().as_deref(),
            Some("actor-7")
        );
        assert_eq!(cached_actor_id().as_deref(), Some("actor-7"));
        assert_eq!(refresh_actor_id(&ep).await.unwrap(), None);
        assert_eq!(cached_actor_id(), None);
    }
}
