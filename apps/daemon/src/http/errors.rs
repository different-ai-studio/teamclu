//! RFC 7807 `application/problem+json` error model.
//!
//! Every fallible HTTP handler returns `Result<T, HttpError>` so the response
//! shape is uniform: a JSON body with `type`, `title`, `status`, `detail`,
//! `code`, `request_id`. The `code` field is the stable machine-readable
//! identifier — clients should branch on it rather than parsing `detail`.

use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

/// Stable machine-readable error codes. New variants must keep the
/// `#[serde(rename_all = "snake_case")]` representation stable — clients
/// branch on these strings.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // stable wire contract — not every code is emitted yet
pub enum ErrorCode {
    Unauthorized,
    Forbidden,
    NotFound,
    SessionNotFound,
    SessionBusy,
    RuntimeUnavailable,
    RateLimited,
    ValidationFailed,
    EventGone,
    Conflict,
    BadRequest,
    Internal,
    /// Reserved for endpoints defined but not yet implemented (e.g. provider OAuth phase 2).
    NotImplemented,
}

impl ErrorCode {
    pub fn http_status(self) -> StatusCode {
        match self {
            ErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
            ErrorCode::Forbidden => StatusCode::FORBIDDEN,
            ErrorCode::NotFound | ErrorCode::SessionNotFound => StatusCode::NOT_FOUND,
            ErrorCode::SessionBusy | ErrorCode::Conflict => StatusCode::CONFLICT,
            ErrorCode::RuntimeUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            ErrorCode::ValidationFailed => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::EventGone => StatusCode::GONE,
            ErrorCode::BadRequest => StatusCode::BAD_REQUEST,
            ErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::NotImplemented => StatusCode::NOT_IMPLEMENTED,
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            ErrorCode::Unauthorized => "Unauthorized",
            ErrorCode::Forbidden => "Forbidden",
            ErrorCode::NotFound => "Not found",
            ErrorCode::SessionNotFound => "Session not found",
            ErrorCode::SessionBusy => "Session busy",
            ErrorCode::RuntimeUnavailable => "Runtime unavailable",
            ErrorCode::RateLimited => "Too many requests",
            ErrorCode::ValidationFailed => "Validation failed",
            ErrorCode::EventGone => "Event window expired",
            ErrorCode::Conflict => "Conflict",
            ErrorCode::BadRequest => "Bad request",
            ErrorCode::Internal => "Internal server error",
            ErrorCode::NotImplemented => "Not implemented",
        }
    }
}

/// Internal error representation. Constructed by handlers; converted into
/// a problem+json `Response` by `IntoResponse`.
#[derive(Debug, Clone)]
pub struct HttpError {
    pub code: ErrorCode,
    pub detail: String,
    /// Optional `WWW-Authenticate` header value, set on 401 to indicate the
    /// Bearer challenge per RFC 6750 §3.
    pub www_authenticate: Option<&'static str>,
    /// Optional `Retry-After` seconds for 429 responses.
    pub retry_after: Option<u64>,
}

impl HttpError {
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
            www_authenticate: None,
            retry_after: None,
        }
    }

    pub fn unauthorized(detail: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Unauthorized,
            detail: detail.into(),
            www_authenticate: Some("Bearer realm=\"amuxd\""),
            retry_after: None,
        }
    }

    pub fn forbidden(detail: impl Into<String>) -> Self {
        Self::new(ErrorCode::Forbidden, detail)
    }

    #[allow(dead_code)]
    pub fn not_found(detail: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, detail)
    }

    pub fn session_not_found(id: &str) -> Self {
        Self::new(
            ErrorCode::SessionNotFound,
            format!("session {id} not found or evicted"),
        )
    }

    pub fn validation(detail: impl Into<String>) -> Self {
        Self::new(ErrorCode::ValidationFailed, detail)
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, detail)
    }

    pub fn runtime_unavailable(detail: impl Into<String>) -> Self {
        Self::new(ErrorCode::RuntimeUnavailable, detail)
    }

    pub fn rate_limited(retry_after_secs: u64) -> Self {
        Self {
            code: ErrorCode::RateLimited,
            detail: "rate limit exceeded".into(),
            www_authenticate: None,
            retry_after: Some(retry_after_secs),
        }
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.detail)
    }
}

impl std::error::Error for HttpError {}

#[derive(Serialize)]
struct ProblemBody {
    #[serde(rename = "type")]
    type_uri: String,
    title: &'static str,
    status: u16,
    detail: String,
    code: ErrorCode,
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let status = self.code.http_status();
        let body = ProblemBody {
            type_uri: format!(
                "https://teamclu/errors/{}",
                serde_json::to_string(&self.code)
                    .ok()
                    .and_then(|s| serde_json::from_str::<String>(&s).ok())
                    .unwrap_or_else(|| "internal".into())
            ),
            title: self.code.title(),
            status: status.as_u16(),
            detail: self.detail.clone(),
            code: self.code,
        };
        let mut resp = (status, Json(body)).into_response();
        resp.headers_mut().insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/problem+json"),
        );
        if let Some(challenge) = self.www_authenticate {
            if let Ok(v) = header::HeaderValue::from_str(challenge) {
                resp.headers_mut().insert(header::WWW_AUTHENTICATE, v);
            }
        }
        if let Some(secs) = self.retry_after {
            if let Ok(v) = header::HeaderValue::from_str(&secs.to_string()) {
                resp.headers_mut().insert(header::RETRY_AFTER, v);
            }
        }
        resp
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn problem_json_shape() {
        let err = HttpError::not_found("nope");
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/problem+json"
        );
        let body = to_bytes(resp.into_body(), 4096).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], 404);
        assert_eq!(json["code"], "not_found");
        assert_eq!(json["title"], "Not found");
        assert_eq!(json["detail"], "nope");
    }

    #[tokio::test]
    async fn unauthorized_sets_www_authenticate() {
        let err = HttpError::unauthorized("missing token");
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(resp.headers().contains_key(header::WWW_AUTHENTICATE));
    }

    #[tokio::test]
    async fn rate_limit_sets_retry_after() {
        let resp = HttpError::rate_limited(30).into_response();
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(resp.headers().get(header::RETRY_AFTER).unwrap(), "30");
    }
}
