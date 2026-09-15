//! Who may change things through the introspect API.
//!
//! The bearer gate (SEC-1, in the parent module) proves a caller can read a file
//! this OS user owns. Every program the user runs can — including another coding
//! agent, such as Codex, opened on an app's checkout, which found the sidecar in
//! `~/.amuxd/mcp.json` and published an app with it.
//!
//! So a call that changes something, or reads MCP config (which carries
//! credentials), must also present the runtime-context token amuxd gave the agent
//! host that spawned the sidecar, and amuxd must confirm it is live
//! (`/internal/runtime-context/verify`). Only amuxd's agent hosts have one, and pi
//! hands it to `teamclu-introspect` alone. Without it a caller keeps the read-only
//! actions in [`route_access`] and nothing else.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use teamclu_runtime_env::session_context as ctx;

/// What a route lets a caller without a verified agent host do.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RouteAccess {
    /// Verified agents only.
    AgentOnly,
    /// These `action`s only read and are open to any bearer holder; every
    /// other action is agent-only.
    ReadActions(&'static [&'static str]),
}

/// Unknown routes are agent-only, so a route added without an entry here fails
/// closed rather than open.
pub(crate) fn route_access(path: &str) -> RouteAccess {
    use RouteAccess::*;
    match path {
        "/app-manage" => ReadActions(&["list", "status", "sessions", "logs"]),
        "/app-access" => ReadActions(&["list"]),
        "/app-data" => ReadActions(&["tables", "rows"]),
        "/app-files" => ReadActions(&["usage", "list", "download_url"]),
        "/app-env" => ReadActions(&["list"]),
        "/app-cron" => ReadActions(&["list", "runs"]),
        "/app-domain" => ReadActions(&["get"]),
        "/cron-manage" => ReadActions(&["list", "get_runs"]),
        "/session-participants" => ReadActions(&["list", "list_candidates"]),
        // `/mcp-get` only reads, but what it returns is MCP config — API keys in
        // `environment`, bearer headers — so it stays agent-only.
        _ => AgentOnly,
    }
}

/// Whether `body`'s `action` is one of `reads`. A body that does not parse, or
/// names no action, is not a read.
pub(crate) fn is_read_action(body: &[u8], reads: &[&str]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .as_ref()
        .and_then(|v| v.get("action"))
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|action| reads.contains(&action))
}

/// The agent host a sidecar says it runs under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentCaller {
    pub(crate) token: String,
    pub(crate) host_generation_id: String,
    pub(crate) backend_kind: String,
}

/// All three caller headers, or `None`.
pub(crate) fn caller_from_headers(headers: &HeaderMap) -> Option<AgentCaller> {
    let value = |name: &str| {
        headers
            .get(name)?
            .to_str()
            .ok()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    Some(AgentCaller {
        token: value(ctx::INTROSPECT_CALLER_TOKEN_HEADER)?,
        host_generation_id: value(ctx::INTROSPECT_CALLER_GENERATION_HEADER)?,
        backend_kind: value(ctx::INTROSPECT_CALLER_BACKEND_HEADER)?,
    })
}

/// Why a call was refused for who made it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CallerRejection {
    /// No agent host at all: a sidecar some other program started.
    NotAnAgent,
    /// amuxd does not know the host or its token — stale, or made up.
    UnknownAgent,
    /// amuxd could not be asked.
    Unverifiable(String),
}

impl CallerRejection {
    fn status(&self) -> StatusCode {
        match self {
            Self::NotAnAgent | Self::UnknownAgent => StatusCode::FORBIDDEN,
            Self::Unverifiable(_) => StatusCode::SERVICE_UNAVAILABLE,
        }
    }

    /// The sentence the agent reads, through the sidecar's `API error: …`.
    pub(crate) fn message(&self) -> String {
        let brand = crate::branding::brand_name();
        match self {
            Self::NotAnAgent => format!(
                "Refused: this changes something, and only an agent running inside {brand} may do \
                 that. The call came from a copy of teamclu-introspect started outside a {brand} \
                 agent session — for example by another coding agent — so nothing was done. \
                 Read-only actions still work; ask the user to make this change in {brand}."
            ),
            Self::UnknownAgent => format!(
                "Refused: the {brand} agent session this call names is not running (its token is \
                 unknown or expired), so nothing was done."
            ),
            Self::Unverifiable(why) => format!(
                "Refused: could not confirm this call comes from a {brand} agent, because the local \
                 agent service did not answer ({why}). Nothing was done."
            ),
        }
    }
}

impl IntoResponse for CallerRejection {
    fn into_response(self) -> Response {
        (self.status(), self.message()).into_response()
    }
}

pub(crate) type VerifyFuture = Pin<Box<dyn Future<Output = Result<(), CallerRejection>> + Send>>;

/// Asks whether an [`AgentCaller`] is live: amuxd in production
/// ([`daemon_verifier`]), a stub in tests.
pub(crate) type CallerVerifier = Arc<dyn Fn(AgentCaller) -> VerifyFuture + Send + Sync>;

pub(crate) fn daemon_verifier() -> CallerVerifier {
    Arc::new(|caller| Box::pin(verify_with_daemon(caller)))
}

const VERIFY_TIMEOUT: Duration = Duration::from_secs(5);

async fn verify_with_daemon(caller: AgentCaller) -> Result<(), CallerRejection> {
    let endpoint = crate::daemon_client::discover()
        .map_err(|e| CallerRejection::Unverifiable(e.to_string()))?;
    let response = crate::daemon_client::http()
        .post(format!(
            "{}/internal/runtime-context/verify",
            endpoint.base_url
        ))
        .bearer_auth(&caller.token)
        .json(&serde_json::json!({
            "hostGenerationId": caller.host_generation_id,
            "backendKind": caller.backend_kind,
        }))
        .timeout(VERIFY_TIMEOUT)
        .send()
        .await
        .map_err(|e| CallerRejection::Unverifiable(e.without_url().to_string()))?;
    match response.status().as_u16() {
        200..=299 => Ok(()),
        401 | 409 => Err(CallerRejection::UnknownAgent),
        // A daemon from before this route cannot vouch for anyone.
        404 => Err(CallerRejection::Unverifiable(
            "the agent service is too old to confirm callers; update it".to_string(),
        )),
        status => Err(CallerRejection::Unverifiable(format!("HTTP {status}"))),
    }
}

/// Largest body read to find its `action`: axum's default body limit, which the
/// handlers' `Bytes` extractor applies anyway.
const MAX_ACTION_BODY: usize = 2 * 1024 * 1024;

/// Refuse an agent-only call that amuxd does not vouch for. Runs inside the
/// bearer gate, so an unauthenticated request never costs a daemon round trip.
pub(crate) async fn caller_gate(
    State(verifier): State<CallerVerifier>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    let request = match route_access(&path) {
        RouteAccess::AgentOnly => request,
        RouteAccess::ReadActions(reads) => {
            let (parts, body) = request.into_parts();
            let Ok(bytes) = axum::body::to_bytes(body, MAX_ACTION_BODY).await else {
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Request body unreadable or too large",
                )
                    .into_response();
            };
            let read = is_read_action(&bytes, reads);
            let request = Request::from_parts(parts, Body::from(bytes));
            if read {
                return next.run(request).await;
            }
            request
        }
    };
    let rejection = match caller_from_headers(request.headers()) {
        None => CallerRejection::NotAnAgent,
        Some(caller) => match verifier(caller).await {
            Ok(()) => return next.run(request).await,
            Err(rejection) => rejection,
        },
    };
    log::warn!("[IntrospectAPI] refused {path}: {rejection:?}");
    rejection.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use axum::routing::post;
    use axum::Router;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn reads_are_open_and_everything_else_is_agent_only() {
        let reads = |path: &str, body: &str| match route_access(path) {
            RouteAccess::AgentOnly => false,
            RouteAccess::ReadActions(reads) => is_read_action(body.as_bytes(), reads),
        };
        assert!(reads("/app-manage", r#"{"action":"list"}"#));
        assert!(reads("/app-manage", r#"{"action":" logs "}"#));
        assert!(reads("/app-data", r#"{"action":"rows"}"#));

        // What the Codex session did: create, then deploy.
        assert!(!reads("/app-manage", r#"{"action":"create"}"#));
        assert!(!reads("/app-manage", r#"{"action":"deploy"}"#));
        assert!(!reads("/app-data", r#"{"action":"update_row"}"#));
        // No action, a body that does not parse, a route with no reads.
        assert!(!reads("/app-manage", "{}"));
        assert!(!reads("/app-manage", "not json"));
        assert!(!reads("/mcp-put", r#"{"action":"list"}"#));
        // MCP config carries credentials.
        assert!(!reads("/mcp-get", "{}"));
        // A route nobody classified fails closed.
        assert!(!reads("/app-something-new", r#"{"action":"list"}"#));
    }

    fn caller_headers(token: &str, generation: &str, backend: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            (ctx::INTROSPECT_CALLER_TOKEN_HEADER, token),
            (ctx::INTROSPECT_CALLER_GENERATION_HEADER, generation),
            (ctx::INTROSPECT_CALLER_BACKEND_HEADER, backend),
        ] {
            headers.insert(name, value.parse().unwrap());
        }
        headers
    }

    #[test]
    fn a_caller_needs_all_three_headers() {
        assert_eq!(
            caller_from_headers(&caller_headers("rtctx_a", "pi-1", "pi")),
            Some(AgentCaller {
                token: "rtctx_a".into(),
                host_generation_id: "pi-1".into(),
                backend_kind: "pi".into(),
            })
        );
        assert_eq!(
            caller_from_headers(&caller_headers("rtctx_a", " ", "pi")),
            None
        );
        let mut partial = caller_headers("rtctx_a", "pi-1", "pi");
        partial.remove(ctx::INTROSPECT_CALLER_BACKEND_HEADER);
        assert_eq!(caller_from_headers(&partial), None);
        assert_eq!(caller_from_headers(&HeaderMap::new()), None);
    }

    /// A verifier that answers `outcome` and counts how often it was asked.
    fn stub_verifier(
        outcome: fn() -> Result<(), CallerRejection>,
    ) -> (CallerVerifier, Arc<AtomicUsize>) {
        let asked = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&asked);
        let verifier: CallerVerifier = Arc::new(move |_caller| {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { outcome() })
        });
        (verifier, asked)
    }

    fn guarded_router(verifier: CallerVerifier) -> Router {
        // Echo the body so a test sees what reached the handler.
        let echo = post(|body: Bytes| async move { body });
        Router::new()
            .route("/app-manage", echo.clone())
            .route("/mcp-put", echo)
            .layer(axum::middleware::from_fn_with_state(verifier, caller_gate))
    }

    async fn call(
        router: Router,
        path: &str,
        body: &str,
        headers: Option<HeaderMap>,
    ) -> (StatusCode, String) {
        use tower::ServiceExt as _;
        let mut request = axum::http::Request::builder().method("POST").uri(path);
        if let Some(headers) = headers {
            for (name, value) in headers.iter() {
                request = request.header(name, value);
            }
        }
        let response = router
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .expect("router is infallible");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tokio::test]
    async fn a_read_needs_no_caller_and_asks_nobody() {
        let (verifier, asked) = stub_verifier(|| Err(CallerRejection::UnknownAgent));
        let body = r#"{"action":"status"}"#;
        let (status, echoed) = call(guarded_router(verifier), "/app-manage", body, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            echoed, body,
            "the buffered body must reach the handler intact"
        );
        assert_eq!(asked.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_sidecar_started_outside_an_agent_cannot_deploy() {
        let (verifier, asked) = stub_verifier(|| Ok(()));
        let (status, message) = call(
            guarded_router(verifier),
            "/app-manage",
            r#"{"action":"deploy"}"#,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(message.contains("nothing was done"), "{message}");
        assert_eq!(asked.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_verified_agent_gets_through_with_its_body() {
        let (verifier, asked) = stub_verifier(|| Ok(()));
        let body = r#"{"action":"deploy","app_id":"a1"}"#;
        let (status, echoed) = call(
            guarded_router(verifier),
            "/app-manage",
            body,
            Some(caller_headers("rtctx_a", "pi-1", "pi")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(echoed, body);
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn headers_amuxd_does_not_vouch_for_are_refused() {
        let (verifier, _) = stub_verifier(|| Err(CallerRejection::UnknownAgent));
        let (status, _) = call(
            guarded_router(verifier),
            "/mcp-put",
            "{}",
            Some(caller_headers("rtctx_made_up", "pi-1", "pi")),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (verifier, _) =
            stub_verifier(|| Err(CallerRejection::Unverifiable("connection refused".into())));
        let (status, message) = call(
            guarded_router(verifier),
            "/mcp-put",
            "{}",
            Some(caller_headers("rtctx_a", "pi-1", "pi")),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(message.contains("connection refused"), "{message}");
    }
}
