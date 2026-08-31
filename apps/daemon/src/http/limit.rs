//! Per-token rate limiting + body-size cap.
//!
//! The HTTP layer fronts the same `RuntimeManager` as the desktop
//! client, so unbounded inbound traffic would starve real users.
//! Rate-limiting is keyed on the session token id (or on the source
//! IP when no token is present — e.g. unauthenticated /v1/healthz).
//!
//! Algorithm: per-key token bucket. Bucket of `burst` capacity,
//! refilled at `rps` tokens per second. Each request consumes 1
//! token; an empty bucket → `429 Too Many Requests` with a
//! `Retry-After` header.

use axum::{
    extract::{Request, State},
    http::header,
    middleware::Next,
    response::{IntoResponse, Response},
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use super::errors::HttpError;
use super::state::HttpState;

struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

/// Concurrent token-bucket limiter keyed on an opaque string.
#[derive(Default)]
pub struct RateLimiter {
    inner: Mutex<HashMap<String, Bucket>>,
}

impl RateLimiter {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Attempt to consume one token. Returns `Err(retry_after_secs)`
    /// when the bucket is empty.
    pub fn check(&self, key: &str, rps: u32, burst: u32) -> Result<(), u64> {
        let burst = burst.max(rps) as f64;
        let rps = rps as f64;
        let now = Instant::now();
        let mut map = self.inner.lock();
        let bucket = map.entry(key.to_owned()).or_insert(Bucket {
            tokens: burst,
            last_refill: now,
        });
        let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * rps).min(burst);
        bucket.last_refill = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let deficit = 1.0 - bucket.tokens;
            let wait_secs = if rps > 0.0 {
                (deficit / rps).ceil() as u64
            } else {
                60
            };
            Err(wait_secs.max(1))
        }
    }

    #[allow(dead_code)]
    pub fn vacuum(&self) {
        // Drop entries that have been at full capacity for a while. Cheap
        // best-effort sweep called from the existing token reaper.
        let now = Instant::now();
        let mut map = self.inner.lock();
        map.retain(|_, b| now.duration_since(b.last_refill).as_secs() < 600);
    }
}

/// Bucket key strategy: prefer the bound session token, fall back to
/// source IP for unauthenticated routes (so `/v1/healthz` isn't a free
/// DOS vector).
fn key_for(req: &Request) -> String {
    if let Some(p) = req.extensions().get::<super::auth::Principal>() {
        return format!("token:{}", p.token_id);
    }
    if let Some(addr) = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
    {
        return format!("ip:{}", addr.0.ip());
    }
    "anonymous".into()
}

pub async fn rate_limit_layer(
    State(state): State<HttpState>,
    req: Request,
    next: Next,
) -> Response {
    // `/v1/ai/*` gets its own bucket, keyed separately so a busy agent cannot
    // exhaust the control-plane allowance that the UI watching it depends on.
    let is_ai = req.uri().path().starts_with("/v1/ai/");
    let key = if is_ai {
        format!("ai:{}", key_for(&req))
    } else {
        key_for(&req)
    };
    let (rps, burst) = if is_ai {
        (
            state.config.ai_rate_limit_rps,
            state.config.ai_rate_limit_burst,
        )
    } else {
        (state.config.rate_limit_rps, state.config.rate_limit_burst)
    };
    match state.limiter.check(&key, rps, burst) {
        Ok(()) => next.run(req).await,
        Err(retry_after) => HttpError::rate_limited(retry_after).into_response(),
    }
}

/// Configure a body-size cap. Counts only request bodies — SSE response
/// streams are never body-capped here.
pub fn body_limit_layer(max_bytes: usize) -> tower_http::limit::RequestBodyLimitLayer {
    tower_http::limit::RequestBodyLimitLayer::new(max_bytes)
}

/// Custom rejection so the body-size limit returns problem+json
/// instead of axum's default plain-text 413.
#[allow(dead_code)]
pub fn body_too_large_response() -> Response {
    let mut resp = HttpError::validation("request body exceeds configured limit").into_response();
    *resp.status_mut() = http::StatusCode::PAYLOAD_TOO_LARGE;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/problem+json"),
    );
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_consumes_then_refills() {
        let limiter = RateLimiter::new();
        // burst=2, rps=1 — two free, then 429 (refill is too slow to
        // top us up between consecutive sub-millisecond calls). After
        // a 1.2s sleep ≥1 token is back.
        for _ in 0..2 {
            assert!(limiter.check("k", 1, 2).is_ok());
        }
        assert!(limiter.check("k", 1, 2).is_err());
        std::thread::sleep(std::time::Duration::from_millis(1200));
        assert!(limiter.check("k", 1, 2).is_ok());
    }

    #[test]
    fn independent_keys() {
        let limiter = RateLimiter::new();
        for _ in 0..5 {
            assert!(limiter.check("a", 1, 5).is_ok());
        }
        assert!(limiter.check("a", 1, 5).is_err());
        // Key "b" still has full burst.
        assert!(limiter.check("b", 1, 5).is_ok());
    }
}
