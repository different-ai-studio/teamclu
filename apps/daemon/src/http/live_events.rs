//! `GET /v1/live/events` — local fast-path SSE.
//!
//! Mirrors every session/live publish (the exact `LiveEventEnvelope` bytes
//! that go to the MQTT broker, including `event_id`) to same-machine
//! subscribers, so a local UI's streaming is independent of broker RTT and
//! availability. Clients that also receive the MQTT copy dedupe by
//! `event_id`; an event dropped here (subscriber lag) is backfilled by the
//! MQTT copy, and vice versa — the two paths are self-healing.
//!
//! Frame shape matches the desktop MQTT bridge payload so consumers can feed
//! both sources through one ingestion path:
//!
//! ```text
//! data: {"topic":"amux/<team>/session/<id>/live","b64":"<base64 payload>"}
//! ```

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use futures::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use super::auth::{require_scope, Principal};
use super::errors::{ErrorCode, HttpError};
use super::state::HttpState;

/// One session/live publish, mirrored to local subscribers. Carries the exact
/// same wrapped `LiveEventEnvelope` bytes that go to the MQTT broker —
/// including the `event_id` — so clients receiving both copies dedupe with
/// their existing eventId logic. Defined here (not in `teamclu`) because the
/// HTTP module tree is also compiled standalone by integration tests.
#[derive(Clone, Debug)]
pub struct LiveTeeEvent {
    pub topic: String,
    pub payload: Vec<u8>,
}

/// `GET /v1/live/events`
pub async fn stream(
    principal: Principal,
    State(state): State<HttpState>,
) -> Result<Response, HttpError> {
    require_scope(&principal, "events:read")?;
    let Some(tee) = &state.live_tee else {
        return Err(HttpError::new(
            ErrorCode::RuntimeUnavailable,
            "live-event tee not attached (daemon has no team session manager)",
        ));
    };
    let rx = tee.subscribe();
    let heartbeat = state.config.heartbeat_interval;

    let live = BroadcastStream::new(rx).filter_map(|res| async move {
        match res {
            Ok(ev) => {
                let frame = serde_json::json!({
                    "topic": ev.topic,
                    "b64": base64::engine::general_purpose::STANDARD.encode(&ev.payload),
                });
                Some(Ok::<_, std::io::Error>(
                    format!("data: {frame}\n\n").into_bytes(),
                ))
            }
            // Slow subscriber lagged past the ring buffer — skip; the MQTT
            // copy of the missed events still reaches the client.
            Err(_) => None,
        }
    });

    let hb = tokio_stream::wrappers::IntervalStream::new(tokio::time::interval(heartbeat))
        .map(|_| Ok::<_, std::io::Error>(b":hb\n\n".to_vec()));

    // Ends at daemon shutdown: the heartbeat never would, and an open stream
    // holds axum's graceful shutdown until the client hangs up.
    let stream = futures::stream::select(live, hb).take_until(state.shutdown.triggered());
    let body = Body::from_stream(stream);
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-accel-buffering", "no")
        .header(header::CONNECTION, "keep-alive")
        .body(body)
        .unwrap()
        .into_response())
}
