//! Observability middleware: per-request id and structured tracing.
//!
//! Every response carries an `X-Request-Id` header (ULID-shaped, 26 chars
//! crockford base32). Logs emitted inside a handler include the same id so
//! a single grep links request and response. The id is also exposed to
//! handlers via the `RequestId` extension so error responses can echo it.

use axum::{
    body::Body,
    http::{header, HeaderName, HeaderValue, Method, Request},
    middleware::Next,
    response::Response,
};
use std::time::Instant;

/// Header name used both for the inbound override (clients may supply
/// their own correlation id) and the outbound echo.
pub const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

#[derive(Clone, Debug)]
pub struct RequestId(#[allow(dead_code)] pub String);

/// Generate a Crockford-base32 ULID-shaped id without pulling the `ulid`
/// crate. 26 chars = 130 bits of randomness; good enough for log
/// correlation, never used as a security token.
fn new_request_id() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut rng = rand::thread_rng();
    (0..26)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

/// A routine poll slower than this is still logged at INFO: a status check
/// that takes a second is itself worth seeing.
const ROUTINE_POLL_SLOW_MS: u64 = 1_000;

/// Status reads the desktop asks on a timer, many times a minute, for the
/// whole life of the app: the cron change counters (every 3s), the identity /
/// MQTT read, the health check, a workspace's runtime state.
///
/// At INFO they were ~40 of every minute's log lines. The desktop's diagnostic
/// bundle keeps only the last 500 lines of this log, so a report covered nine
/// minutes of polling and none of what the user was reporting. A successful,
/// fast one goes to DEBUG; a failing or slow one is logged as before.
fn is_routine_poll(method: &Method, path: &str) -> bool {
    if method != Method::GET {
        return false;
    }
    match path {
        "/v1/cron/status" | "/v1/info" | "/v1/healthz" => true,
        _ => path
            .strip_prefix("/v1/workspaces/")
            .and_then(|rest| rest.strip_suffix("/runtime"))
            .is_some_and(|id| !id.is_empty() && !id.contains('/')),
    }
}

/// Middleware: install or echo a request id, and log a single structured
/// line per request at completion. Stays cheap — no per-handler spans, no
/// allocation beyond the id itself.
pub async fn request_id_layer(mut req: Request<Body>, next: Next) -> Response {
    let id = req
        .headers()
        .get(&REQUEST_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_graphic()))
        .map(|s| s.to_owned())
        .unwrap_or_else(new_request_id);

    req.extensions_mut().insert(RequestId(id.clone()));

    let method = req.method().clone();
    let uri = req.uri().clone();
    let started = Instant::now();
    let mut resp = next.run(req).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    if let Ok(value) = HeaderValue::from_str(&id) {
        resp.headers_mut().insert(REQUEST_ID_HEADER, value);
    }

    let status = resp.status().as_u16();
    if status >= 500 {
        tracing::error!(request_id = %id, %method, %uri, status, elapsed_ms, "http request");
    } else if status >= 400 {
        tracing::warn!(request_id = %id, %method, %uri, status, elapsed_ms, "http request");
    } else if is_routine_poll(&method, uri.path()) && elapsed_ms < ROUTINE_POLL_SLOW_MS {
        tracing::debug!(request_id = %id, %method, %uri, status, elapsed_ms, "http request");
    } else {
        tracing::info!(request_id = %id, %method, %uri, status, elapsed_ms, "http request");
    }

    resp
}

/// Helper accessor used by handlers that want to embed the id in a body
/// (e.g. problem+json) — the id was inserted by the middleware above.
#[allow(dead_code)]
pub fn request_id_of(req: &Request<Body>) -> Option<&str> {
    req.extensions()
        .get::<RequestId>()
        .map(|RequestId(s)| s.as_str())
}

/// Header sentinel re-exported here so other modules don't need to import
/// `axum::http::header` directly.
#[allow(dead_code)]
pub const X_REQUEST_ID: HeaderName = REQUEST_ID_HEADER;
#[allow(dead_code)]
pub const HEADER_CONTENT_TYPE: HeaderName = header::CONTENT_TYPE;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_are_unique_and_well_formed() {
        let a = new_request_id();
        let b = new_request_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 26);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn routine_polls_are_the_timer_driven_status_reads() {
        for path in [
            "/v1/cron/status",
            "/v1/info",
            "/v1/healthz",
            "/v1/workspaces/L1VzZXJzL21l/runtime",
        ] {
            assert!(is_routine_poll(&Method::GET, path), "{path}");
        }
    }

    #[test]
    fn everything_else_stays_at_info() {
        // Writes to the same paths, and reads that are not polls.
        assert!(!is_routine_poll(&Method::POST, "/v1/info"));
        assert!(!is_routine_poll(
            &Method::POST,
            "/v1/workspaces/abc/runtime"
        ));
        for path in [
            "/v1/rpc",
            "/v1/cron/jobs",
            "/v1/workspaces/abc/skills",
            "/v1/workspaces//runtime",
            "/v1/workspaces/a/b/runtime",
            "/v1/workspaces/abc/runtime/extra",
        ] {
            assert!(!is_routine_poll(&Method::GET, path), "{path}");
        }
    }
}
