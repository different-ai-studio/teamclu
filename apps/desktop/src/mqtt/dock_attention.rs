//! macOS Dock bounce on inbox MQTT pings while the main window is unfocused.
//! Runs in Rust so attention still fires when the WebView is background-throttled.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, UserAttentionType};

const INBOX_TOPIC_PREFIX: &str = "inbox/";
const DOCK_ATTENTION_THROTTLE: Duration = Duration::from_secs(5);

static LAST_DOCK_ATTENTION: Mutex<Option<Instant>> = Mutex::new(None);

fn inbox_message_ping(payload: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return false;
    };
    if value.get("type").and_then(|t| t.as_str()) == Some("read") {
        return false;
    }
    value
        .get("session_id")
        .and_then(|id| id.as_str())
        .is_some_and(|id| !id.is_empty())
}

/// Request a one-shot Dock bounce for an inbox message ping when the app is in the background.
pub fn maybe_request_dock_attention(app: &AppHandle, topic: &str, payload: &[u8]) {
    if !topic.starts_with(INBOX_TOPIC_PREFIX) || !inbox_message_ping(payload) {
        return;
    }

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_focused().unwrap_or(true) {
        return;
    }

    let mut last = LAST_DOCK_ATTENTION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    if last
        .is_some_and(|prev| now.duration_since(prev) < DOCK_ATTENTION_THROTTLE)
    {
        return;
    }
    *last = Some(now);
    drop(last);

    let _ = window.request_user_attention(Some(UserAttentionType::Informational));
}

#[cfg(test)]
mod tests {
    use super::inbox_message_ping;

    #[test]
    fn accepts_legacy_message_ping_without_type() {
        assert!(inbox_message_ping(
            br#"{"session_id":"s1","ts":123}"#.as_slice()
        ));
    }

    #[test]
    fn accepts_explicit_message_ping() {
        assert!(inbox_message_ping(
            br#"{"type":"message","session_id":"s1"}"#.as_slice()
        ));
    }

    #[test]
    fn rejects_read_ping() {
        assert!(!inbox_message_ping(
            br#"{"type":"read","session_id":"s1"}"#.as_slice()
        ));
    }

    #[test]
    fn rejects_missing_session_id() {
        assert!(!inbox_message_ping(br#"{"type":"message","ts":1}"#.as_slice()));
    }
}
