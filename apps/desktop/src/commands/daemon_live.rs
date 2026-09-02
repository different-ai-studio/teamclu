//! Local fast-path: subscribe to the daemon's `GET /v1/live/events` SSE and
//! forward each frame to the webview as `mqtt:envelopes` — the exact event
//! shape the MQTT bridge emits (`[{topic, b64}]`).
//!
//! The daemon tees every session/live publish (identical bytes, identical
//! event_id) into this stream BEFORE the MQTT publish, so a same-machine UI
//! streams at loopback latency and keeps working when the broker is slow or
//! unreachable. The webview's existing eventId dedup drops whichever copy
//! (SSE vs MQTT) arrives second; events lost on one path are backfilled by
//! the other.
//!
//! Lifecycle: one background task spawned at app setup. It loops forever:
//! discover the daemon through [`crate::daemon_client`], exchange an
//! `events:read` token, hold the SSE open, and on any error/EOF back off and
//! retry — daemon restarts and re-onboards are picked up automatically.
//!
//! Each successful connect also refreshes the cached daemon identity
//! (`/v1/setup/status`), which is what lets sync callers answer "who is my
//! daemon" without opening its private config.

use futures_util::StreamExt;
use tauri::Emitter;

use crate::daemon_client::{self as daemon, RequestSpec, NO_BODY};

/// Spawn the persistent SSE subscriber. Call once from the Tauri setup hook.
pub fn spawn(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut announced_up = false;
        loop {
            match run_once(&app, &mut announced_up).await {
                Ok(()) => {
                    // Stream ended cleanly (daemon shutdown) — retry soon.
                }
                Err(e) => {
                    tracing::debug!("[daemon-live] stream unavailable: {e}");
                }
            }
            if announced_up {
                announced_up = false;
                let _ = app.emit("daemon-live:connected", false);
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
}

async fn run_once(app: &tauri::AppHandle, announced_up: &mut bool) -> Result<(), String> {
    let endpoint = daemon::discover()?;

    // The daemon is reachable: remember who it is. Best-effort — the stream is
    // the job here, identity is a side benefit.
    if let Err(e) = daemon::refresh_actor_id(&endpoint).await {
        tracing::debug!("[daemon-live] setup status unavailable: {e}");
    }

    // A day-long token so the stream is not cut by its own expiry; the client
    // keys the cache by endpoint, so a restarted daemon gets a fresh one.
    let spec =
        RequestSpec::get("/v1/live/events", &["events:read"]).ttl(daemon::MAX_TOKEN_TTL_SECS);
    let resp = daemon::send(&endpoint, spec, NO_BODY).await?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("sse connect: {status}"));
    }
    let base = &endpoint.base_url;

    tracing::info!("[daemon-live] connected to {base}/v1/live/events");
    *announced_up = true;
    let _ = app.emit("daemon-live:connected", true);

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("sse read: {e}"))?;
        buf.extend_from_slice(&chunk);

        // Frames are `data: {...}\n\n`; heartbeats are `:hb\n\n` comments.
        // Collect every complete frame in this chunk into ONE emit (mirrors
        // the MQTT bridge's burst coalescing).
        let mut batch: Vec<serde_json::Value> = Vec::new();
        while let Some(pos) = find_frame_end(&buf) {
            let frame: Vec<u8> = buf.drain(..pos + 2).collect();
            let Ok(text) = std::str::from_utf8(&frame) else {
                continue;
            };
            for line in text.lines() {
                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                match serde_json::from_str::<serde_json::Value>(data) {
                    Ok(v) if v.get("topic").is_some() && v.get("b64").is_some() => batch.push(v),
                    _ => tracing::warn!("[daemon-live] unparseable frame: {data}"),
                }
            }
        }
        if !batch.is_empty() {
            let _ = app.emit("mqtt:envelopes", batch);
        }
    }
    Ok(())
}

fn find_frame_end(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_end_finds_double_newline() {
        assert_eq!(find_frame_end(b"data: {}\n\nrest"), Some(8));
        assert_eq!(find_frame_end(b"partial"), None);
    }
}
