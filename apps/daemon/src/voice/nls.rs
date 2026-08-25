//! Alibaba NLS WebSocket protocol — the envelope both speech paths share.
//!
//! Recognition ([`super::aliyun_stt`]) and synthesis ([`super::aliyun_tts`])
//! talk to the same gateway with the same message shape and differ only in
//! `namespace` and event names, so the framing lives here once.
//!
//! ```text
//! { "header": { "message_id", "task_id", "namespace", "name", "appkey" },
//!   "payload": { … } }
//! ```
//!
//! Two details that are easy to get wrong and silent when you do:
//!
//! - **ids are 32-char hex, not hyphenated UUIDs.** NLS rejects the hyphenated
//!   form, so [`nls_id`] strips them.
//! - **`task_id` is per session, `message_id` is per message.** Reusing one
//!   `message_id` across a session, or minting a fresh `task_id` per message,
//!   both look plausible and neither works.
//!
//! ## Status — verified on the live gateway 2026-08-25
//!
//! Exercised against `wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1` with a
//! console-issued token: the handshake header, this envelope, both namespaces,
//! `STATUS_OK`, and `TaskFailed`'s `status_text` all behave as written. The
//! round trip synthesised a sentence and transcribed it back verbatim.

use serde::Deserialize;

/// A 32-character lowercase hex id, the form NLS accepts.
pub fn nls_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Build one protocol message.
pub fn envelope(
    namespace: &str,
    name: &str,
    app_key: &str,
    task_id: &str,
    payload: serde_json::Value,
) -> String {
    serde_json::json!({
        "header": {
            "message_id": nls_id(),
            "task_id": task_id,
            "namespace": namespace,
            "name": name,
            "appkey": app_key,
        },
        "payload": payload,
    })
    .to_string()
}

/// The header of an inbound message. `status` is 20000000 on success; anything
/// else carries `status_text` explaining why.
#[derive(Debug, Clone, Deserialize)]
pub struct NlsHeader {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: u32,
    #[serde(default)]
    pub status_text: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NlsMessage {
    pub header: NlsHeader,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// NLS's success status. Every other value is a failure carrying `status_text`.
pub const STATUS_OK: u32 = 20000000;

impl NlsMessage {
    pub fn parse(text: &str) -> Result<Self, String> {
        serde_json::from_str(text).map_err(|e| format!("malformed NLS message: {e}"))
    }

    /// `Some(reason)` when the gateway reported a failure.
    ///
    /// A zero status means the field was absent, which is not an error — some
    /// events omit it. Treating absent as failure would abort every session on
    /// its first event.
    pub fn failure(&self) -> Option<String> {
        if self.header.status == 0 || self.header.status == STATUS_OK {
            None
        } else {
            Some(format!(
                "{} (status {})",
                if self.header.status_text.is_empty() {
                    "NLS error"
                } else {
                    &self.header.status_text
                },
                self.header.status
            ))
        }
    }

    /// `payload.result`, the field both recognition events carry their text in.
    pub fn result_text(&self) -> Option<&str> {
        self.payload.get("result").and_then(|v| v.as_str())
    }
}

/// Build the handshake request, carrying the minted token as `X-NLS-Token`.
///
/// The token goes in a header rather than the query string on purpose: query
/// strings land in proxy access logs, and this one is a live credential.
pub fn handshake(endpoint: &str, token: &str) -> Result<http::Request<()>, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let mut req = endpoint
        .into_client_request()
        .map_err(|e| format!("bad NLS endpoint {endpoint}: {e}"))?;
    req.headers_mut().insert(
        "X-NLS-Token",
        token
            .parse()
            .map_err(|_| "NLS token is not a valid header value".to_string())?,
    );
    Ok(req)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_32_hex_chars_without_hyphens() {
        // NLS rejects the hyphenated UUID form outright.
        let id = nls_id();
        assert_eq!(id.len(), 32, "got {id}");
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "got {id}");
    }

    #[test]
    fn ids_are_unique() {
        assert_ne!(nls_id(), nls_id());
    }

    #[test]
    fn envelope_carries_the_header_fields_nls_requires() {
        let raw = envelope(
            "SpeechTranscriber",
            "StartTranscription",
            "ak-1",
            "task-1",
            serde_json::json!({ "format": "pcm" }),
        );
        let v: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(v["header"]["namespace"], "SpeechTranscriber");
        assert_eq!(v["header"]["name"], "StartTranscription");
        assert_eq!(v["header"]["appkey"], "ak-1");
        assert_eq!(v["header"]["task_id"], "task-1");
        assert_eq!(v["payload"]["format"], "pcm");
        assert!(v["header"]["message_id"].is_string());
    }

    #[test]
    fn each_message_gets_its_own_message_id_but_keeps_the_task_id() {
        // Reusing message_id, or re-minting task_id per message, are the two
        // plausible-looking ways to break a session.
        let a: serde_json::Value =
            serde_json::from_str(&envelope("N", "A", "k", "task-1", serde_json::json!({})))
                .unwrap();
        let b: serde_json::Value =
            serde_json::from_str(&envelope("N", "B", "k", "task-1", serde_json::json!({})))
                .unwrap();
        assert_ne!(a["header"]["message_id"], b["header"]["message_id"]);
        assert_eq!(a["header"]["task_id"], b["header"]["task_id"]);
    }

    #[test]
    fn a_success_status_is_not_a_failure() {
        let m = NlsMessage::parse(
            r#"{"header":{"name":"TranscriptionStarted","status":20000000},"payload":{}}"#,
        )
        .expect("parse");
        assert!(m.failure().is_none());
    }

    #[test]
    fn an_absent_status_is_not_a_failure() {
        // Some events omit `status`; treating absent as failure would abort
        // every session on its first event.
        let m =
            NlsMessage::parse(r#"{"header":{"name":"SentenceEnd"},"payload":{}}"#).expect("parse");
        assert!(m.failure().is_none());
    }

    #[test]
    fn an_error_status_surfaces_its_text() {
        let m = NlsMessage::parse(
            r#"{"header":{"name":"TaskFailed","status":40000004,"status_text":"token invalid"}}"#,
        )
        .expect("parse");
        let f = m.failure().expect("a failure");
        assert!(f.contains("token invalid"), "got {f}");
        assert!(f.contains("40000004"), "got {f}");
    }

    #[test]
    fn result_text_reads_the_recognition_field() {
        let m = NlsMessage::parse(
            r#"{"header":{"name":"SentenceEnd"},"payload":{"result":"今天几号"}}"#,
        )
        .expect("parse");
        assert_eq!(m.result_text(), Some("今天几号"));
    }

    #[test]
    fn a_malformed_message_is_an_error_not_a_panic() {
        assert!(NlsMessage::parse("not json").is_err());
    }

    #[test]
    fn handshake_puts_the_token_in_a_header_not_the_url() {
        let req = handshake("wss://nls-gateway.example/ws/v1", "secret-token").expect("request");
        assert_eq!(
            req.headers()
                .get("X-NLS-Token")
                .map(|v| v.to_str().unwrap()),
            Some("secret-token"),
        );
        assert!(
            !req.uri().to_string().contains("secret-token"),
            "a live credential must not land in proxy access logs",
        );
    }
}
