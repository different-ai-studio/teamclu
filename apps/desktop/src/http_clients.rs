//! The process's HTTP clients.
//!
//! STR-8 — there were two Cloud API clients (`oss_sync::fc_client::FcClient`
//! async, `team_skills::build_cloud_api_client` blocking) that had drifted into
//! near-copies of each other, plus a scatter of one-off `reqwest::Client`s each
//! naming its own timeouts. Two costs: the SGW workaround below had to be
//! rediscovered every time someone added a call, and every one-off client
//! carried its own connection pool, so a call that could have reused a warm
//! TLS connection opened a new one and threw it away.
//!
//! Each policy here is built once, on first use, and shared. `reqwest::Client`
//! is a handle around an `Arc`ed pool — cloning is cheap and cloning is the
//! point.

use std::sync::OnceLock;
use std::time::Duration;

/// Per-request cap. Long enough for a skill pack upload over a slow link,
/// short enough that a black-holed host surfaces as an error instead of a
/// spinner that never resolves.
///
/// A bare `reqwest::Client::new()` has **no** request timeout, and that is not
/// theoretical: a Cloud API host that accepts the connection and then never
/// answers (a diverged `cloudApiUrl`, a black-holed load balancer, a stalled
/// TLS peer) leaves the awaiting promise neither resolved nor rejected, and
/// Settings → Team Shared sits on "Loading team share status…" forever.
pub const CLOUD_API_TIMEOUT: Duration = Duration::from_secs(30);

/// Cap on establishing TCP/TLS, so an unreachable host fails fast rather than
/// waiting out the whole request timeout.
pub const CLOUD_API_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Applies to both Cloud API clients:
///
/// - **HTTP/1.1 only.** The Cloud API sits behind SGW-fronted hosts where an
///   idle HTTP/2 connection reused after ~60 s fails as a bare
///   "error sending request for url" with no further detail.
/// - **rustls.** reqwest 0.11's default TLS fails to some of those hosts with
///   "error trying to connect: bad protocol version"; rustls does not.
macro_rules! cloud_api_policy {
    ($builder:expr) => {
        $builder
            .http1_only()
            .use_rustls_tls()
            .timeout(CLOUD_API_TIMEOUT)
            .connect_timeout(CLOUD_API_CONNECT_TIMEOUT)
    };
}

static CLOUD_API: OnceLock<reqwest::Client> = OnceLock::new();
static CLOUD_API_BLOCKING: OnceLock<reqwest::blocking::Client> = OnceLock::new();

/// Shared async client for Cloud API calls.
///
/// Falls back to a default client if the builder fails — that only happens on a
/// fatal TLS/runtime misconfiguration, and a request that then fails with a
/// real error beats a panic during startup.
pub fn cloud_api() -> reqwest::Client {
    CLOUD_API
        .get_or_init(|| {
            cloud_api_policy!(reqwest::Client::builder())
                .build()
                .unwrap_or_else(|e| {
                    log::error!("http_clients: cloud_api builder failed ({e}); using defaults");
                    reqwest::Client::new()
                })
        })
        .clone()
}

/// Shared blocking client for Cloud API calls made inside `spawn_blocking`.
///
/// Same policy as [`cloud_api`]. Held in a `static` deliberately: a
/// `reqwest::blocking::Client` owns a runtime thread, and dropping one from
/// inside an async context is what panics — a client that is never dropped
/// cannot.
pub fn cloud_api_blocking() -> Result<reqwest::blocking::Client, String> {
    if let Some(client) = CLOUD_API_BLOCKING.get() {
        return Ok(client.clone());
    }
    let client = cloud_api_policy!(reqwest::blocking::Client::builder())
        .build()
        .map_err(|e| format!("Failed to build Cloud API HTTP client: {}", e))?;
    Ok(CLOUD_API_BLOCKING.get_or_init(|| client).clone())
}
