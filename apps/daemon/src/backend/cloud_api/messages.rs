use super::super::{BackendResult, StoredMessage, TurnTracePrepare};
use super::client::empty_to_none;
use super::CloudApiBackend;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub(super) struct CloudPage<T> {
    pub(super) items: Vec<T>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CloudMessage {
    pub(super) id: String,
    #[serde(rename = "sessionId")]
    pub(super) session_id: String,
    #[serde(rename = "senderActorId")]
    pub(super) sender_actor_id: Option<String>,
    pub(super) kind: String,
    pub(super) content: String,
    pub(super) metadata: Option<Value>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: DateTime<Utc>,
}

impl CloudMessage {
    pub(super) fn into_stored_message(self) -> BackendResult<StoredMessage> {
        Ok(StoredMessage {
            id: self.id,
            session_id: self.session_id,
            sender_actor_id: self.sender_actor_id.unwrap_or_default(),
            kind: self.kind,
            content: self.content,
            metadata_json: serde_json::to_string(&self.metadata.unwrap_or(Value::Null))?,
            created_at: self.created_at.timestamp(),
        })
    }
}

#[derive(Serialize)]
pub(super) struct InsertMessageRequest<'a> {
    pub(super) id: &'a str,
    #[serde(rename = "teamId")]
    pub(super) team_id: &'a str,
    #[serde(rename = "senderActorId")]
    pub(super) sender_actor_id: &'a str,
    pub(super) content: &'a str,
    pub(super) kind: &'a str,
    pub(super) metadata: Option<Value>,
    #[serde(rename = "turnId")]
    pub(super) turn_id: Option<&'a str>,
    #[serde(rename = "replyToMessageId")]
    pub(super) reply_to_message_id: Option<&'a str>,
    pub(super) model: Option<&'a str>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: Option<&'a str>,
}

/// Namespace for deterministic gateway message UUIDs derived from channel-
/// native ids (SeaTalk/WeCom/Feishu/…). `messages.id` is a UUID column — using
/// the raw channel id as the PK makes inserts fail and leaves agent-only
/// history in the UI.
const GATEWAY_MSG_NS: uuid::Uuid = uuid::Uuid::from_bytes([
    0x74, 0x65, 0x61, 0x6d, // "team"
    0x63, 0x6c, 0x61, 0x77, // "claw"
    0x67, 0x77, 0x6d, 0x73, // "gwms"
    0x67, 0x69, 0x64, 0x01, // "gid\x01"
]);

/// Build a UUID primary key (+ optional metadata) for a gateway-originated
/// message. Channel-native ids are never used as the PK; they are stored under
/// `metadata.external_message_id` and folded into a deterministic UUID v5 so
/// retries stay idempotent.
pub(super) fn gateway_message_id_and_metadata(
    session_id: &str,
    external_message_id: Option<&str>,
    extra_metadata: Option<Value>,
) -> (String, Option<Value>) {
    let mut metadata = match extra_metadata {
        Some(Value::Object(map)) => Value::Object(map),
        Some(other) => serde_json::json!({ "extra": other }),
        None => Value::Object(serde_json::Map::new()),
    };

    let id = match external_message_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(external) => {
            if let Some(obj) = metadata.as_object_mut() {
                obj.insert(
                    "external_message_id".to_string(),
                    Value::String(external.to_string()),
                );
            }
            // Prefer the raw value when it is already a UUID (keeps older
            // callers that passed UUIDs stable). Otherwise derive v5.
            if let Ok(parsed) = uuid::Uuid::parse_str(external) {
                parsed.to_string()
            } else {
                let name = format!("gateway:{session_id}:{external}");
                uuid::Uuid::new_v5(&GATEWAY_MSG_NS, name.as_bytes()).to_string()
            }
        }
        None => uuid::Uuid::new_v4().to_string(),
    };

    let metadata = match &metadata {
        Value::Object(map) if map.is_empty() => None,
        other => Some(other.clone()),
    };
    (id, metadata)
}

impl CloudApiBackend {
    pub(super) async fn messages_after_cursor_impl(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>> {
        let page: CloudPage<CloudMessage> = self
            .get(&format!("/v1/sessions/{session_id}/messages"))
            .await?;
        let mut seen_cursor = after_id.is_none();
        let mut out = Vec::new();
        for row in page.items {
            if !seen_cursor {
                seen_cursor = Some(row.id.as_str()) == after_id;
                continue;
            }
            out.push(row.into_stored_message()?);
        }
        Ok(out)
    }

    pub(super) async fn insert_gateway_message_impl(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        let (id, metadata) = gateway_message_id_and_metadata(session_id, external_message_id, None);
        let message: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id: &id,
                    team_id: &self.cfg.team_id,
                    sender_actor_id,
                    content,
                    kind: "text",
                    metadata,
                    turn_id: None,
                    reply_to_message_id: None,
                    model: None,
                    created_at: None,
                },
                Some(&id),
            )
            .await?;
        Ok(message.id)
    }

    pub(super) async fn insert_gateway_agent_reply_impl(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        let (id, metadata) = gateway_message_id_and_metadata(session_id, external_message_id, None);
        let message: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id: &id,
                    team_id: &self.cfg.team_id,
                    sender_actor_id,
                    content,
                    kind: "agent_reply",
                    metadata,
                    turn_id: None,
                    reply_to_message_id: None,
                    model: None,
                    created_at: None,
                },
                Some(&id),
            )
            .await?;
        Ok(message.id)
    }

    /// `kind` decides which side of the conversation this lands on: `text` is
    /// what a person sent, `agent_reply` what the agent did. A file the agent
    /// pushed to a chat used to be inserted as `text` and therefore rendered as
    /// if the user had sent it.
    pub(super) async fn insert_gateway_message_with_attachments_impl(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: Value,
        kind: &str,
    ) -> BackendResult<String> {
        let (id, metadata) = gateway_message_id_and_metadata(
            session_id,
            external_message_id,
            Some(serde_json::json!({ "attachments": attachments })),
        );
        let message: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id: &id,
                    team_id: &self.cfg.team_id,
                    sender_actor_id,
                    content,
                    kind,
                    metadata,
                    turn_id: None,
                    reply_to_message_id: None,
                    model: None,
                    created_at: None,
                },
                Some(&id),
            )
            .await?;
        Ok(message.id)
    }

    #[cfg(test)]
    pub(super) fn cursor_filter(
        items: Vec<CloudMessage>,
        after_id: Option<&str>,
    ) -> Vec<CloudMessage> {
        let mut seen_cursor = after_id.is_none();
        let mut out = Vec::new();
        for row in items {
            if !seen_cursor {
                seen_cursor = Some(row.id.as_str()) == after_id;
                continue;
            }
            out.push(row);
        }
        out
    }

    pub(super) async fn prepare_turn_trace_upload_impl(
        &self,
        session_id: &str,
        turn_id: &str,
        team_id: &str,
        size: u64,
        sha256: &str,
    ) -> BackendResult<TurnTracePrepare> {
        #[derive(Serialize)]
        struct Body<'a> {
            #[serde(rename = "teamId")]
            team_id: &'a str,
            size: u64,
            sha256: &'a str,
        }
        #[derive(Deserialize)]
        struct Resp {
            #[serde(rename = "ossKey")]
            oss_key: String,
            #[serde(rename = "presignedPut")]
            presigned_put: String,
        }
        let resp: Resp = self
            .post(
                &format!("/v1/sessions/{session_id}/turns/{turn_id}/trace/prepare"),
                &Body {
                    team_id,
                    size,
                    sha256,
                },
                None,
            )
            .await?;
        Ok(TurnTracePrepare {
            oss_key: resp.oss_key,
            presigned_put: resp.presigned_put,
        })
    }

    pub(super) async fn patch_message_metadata_impl(
        &self,
        message_id: &str,
        metadata_json: &str,
    ) -> BackendResult<()> {
        let metadata = serde_json::from_str(metadata_json).unwrap_or(Value::Null);
        #[derive(Serialize)]
        struct Patch {
            metadata: Value,
        }
        self.patch_no_content(
            &format!("/v1/messages/{message_id}"),
            &Patch { metadata },
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn insert_message_impl(
        &self,
        id: &str,
        team_id: &str,
        session_id: &str,
        sender_actor_id: &str,
        kind: &str,
        content: &str,
        metadata_json: &str,
        model: &str,
        turn_id: &str,
        reply_to_message_id: &str,
        sequence: u64,
    ) -> BackendResult<()> {
        let metadata = serde_json::from_str(metadata_json).unwrap_or(Value::Null);
        let metadata = match metadata {
            Value::Object(mut object) => {
                object.insert("sequence".to_string(), Value::from(sequence));
                Some(Value::Object(object))
            }
            Value::Null => Some(serde_json::json!({ "sequence": sequence })),
            other => Some(serde_json::json!({ "value": other, "sequence": sequence })),
        };
        let _: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id,
                    team_id,
                    sender_actor_id,
                    content,
                    kind,
                    metadata,
                    turn_id: empty_to_none(turn_id),
                    reply_to_message_id: empty_to_none(reply_to_message_id),
                    model: empty_to_none(model),
                    created_at: None,
                },
                Some(id),
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn make_msg(id: &str) -> CloudMessage {
        CloudMessage {
            id: id.to_string(),
            session_id: "sess".to_string(),
            sender_actor_id: Some("actor-1".to_string()),
            kind: "text".to_string(),
            content: "hello".to_string(),
            metadata: None,
            created_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
        }
    }

    #[test]
    fn into_stored_message_maps_fields() {
        let msg = make_msg("msg-1");
        let stored = msg.into_stored_message().unwrap();
        assert_eq!(stored.id, "msg-1");
        assert_eq!(stored.session_id, "sess");
        assert_eq!(stored.sender_actor_id, "actor-1");
        assert_eq!(stored.kind, "text");
        assert_eq!(stored.content, "hello");
        assert_eq!(stored.metadata_json, "null");
        assert_eq!(stored.created_at, 1_700_000_000);
    }

    #[test]
    fn into_stored_message_null_sender_becomes_empty() {
        let mut msg = make_msg("msg-2");
        msg.sender_actor_id = None;
        let stored = msg.into_stored_message().unwrap();
        assert_eq!(stored.sender_actor_id, "");
    }

    #[test]
    fn into_stored_message_metadata_serialised() {
        let mut msg = make_msg("msg-3");
        msg.metadata = Some(serde_json::json!({"key": "value"}));
        let stored = msg.into_stored_message().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&stored.metadata_json).unwrap();
        assert_eq!(parsed["key"], "value");
    }

    #[test]
    fn cursor_filter_no_cursor_returns_all() {
        let items = vec![make_msg("a"), make_msg("b"), make_msg("c")];
        let out = CloudApiBackend::cursor_filter(items, None);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn cursor_filter_skips_up_to_and_including_cursor() {
        let items = vec![make_msg("a"), make_msg("b"), make_msg("c"), make_msg("d")];
        let out = CloudApiBackend::cursor_filter(items, Some("b"));
        let ids: Vec<_> = out.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["c", "d"]);
    }

    #[test]
    fn cursor_filter_cursor_is_last_returns_empty() {
        let items = vec![make_msg("a"), make_msg("b")];
        let out = CloudApiBackend::cursor_filter(items, Some("b"));
        assert!(out.is_empty());
    }

    #[test]
    fn cursor_filter_cursor_not_found_returns_empty() {
        let items = vec![make_msg("a"), make_msg("b")];
        let out = CloudApiBackend::cursor_filter(items, Some("z"));
        assert!(out.is_empty());
    }

    #[test]
    fn gateway_id_without_external_is_random_uuid() {
        let (id, meta) = gateway_message_id_and_metadata("sess-1", None, None);
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert!(meta.is_none());
        let (id2, _) = gateway_message_id_and_metadata("sess-1", None, None);
        assert_ne!(id, id2);
    }

    #[test]
    fn gateway_id_with_native_channel_id_is_uuid_v5_and_stores_external() {
        let native = "u7oirumAclCbrRQB-RCYnjzhvXNAhNTUFJTM6fDCaFsK-Jplxk2X23T2";
        let (id, meta) = gateway_message_id_and_metadata("sess-1", Some(native), None);
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert_ne!(id, native);
        assert_eq!(
            meta.as_ref()
                .and_then(|m| m["external_message_id"].as_str()),
            Some(native)
        );
        // Deterministic for idempotency.
        let (id2, _) = gateway_message_id_and_metadata("sess-1", Some(native), None);
        assert_eq!(id, id2);
        // Different session ⇒ different id.
        let (id3, _) = gateway_message_id_and_metadata("sess-2", Some(native), None);
        assert_ne!(id, id3);
    }

    #[test]
    fn gateway_id_preserves_uuid_external_ids() {
        let external = "550e8400-e29b-41d4-a716-446655440000";
        let (id, meta) = gateway_message_id_and_metadata("sess-1", Some(external), None);
        assert_eq!(id, external);
        assert_eq!(
            meta.as_ref()
                .and_then(|m| m["external_message_id"].as_str()),
            Some(external)
        );
    }

    #[test]
    fn gateway_id_merges_attachments_metadata() {
        let (id, meta) = gateway_message_id_and_metadata(
            "sess-1",
            Some("native-msg-1"),
            Some(serde_json::json!({ "attachments": [{"filename": "a.png"}] })),
        );
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        let meta = meta.expect("metadata");
        assert_eq!(meta["external_message_id"], "native-msg-1");
        assert_eq!(meta["attachments"][0]["filename"], "a.png");
    }
}
