//! `ChannelStore` impl: adapts amuxd's backend client to the
//! `teamclu_gateway::ChannelStore` trait so channels persist external
//! actors, gateway sessions, and messages through the same backend
//! endpoints amuxd already uses for native sessions.

use async_trait::async_trait;
use std::sync::Arc;

use teamclu_gateway::{AttachmentRecord, ChannelStore, EnsureSessionOutcome, StoreError};

use crate::backend::Backend;
use crate::channels::live_notify::GatewayLiveNotifier;
use crate::proto::teamclu::MessageKind;

pub struct AmuxdChannelStore {
    pub client: Arc<dyn Backend>,
    /// Broadcasts what this store writes on `session/{id}/live`. `None` in
    /// tests and before onboarding; a message written without it is still
    /// persisted, just not pushed — which is exactly the behaviour this field
    /// exists to end.
    pub live: Option<GatewayLiveNotifier>,
}

impl AmuxdChannelStore {
    /// `mention_actor_ids` for a message the gateway has already answered:
    /// deliberately empty.
    ///
    /// Naming the daemon's agent here is what would make the loopback copy
    /// engage a second turn. The reply is already on its way back to the chat,
    /// so nothing downstream needs to be told to answer it.
    ///
    /// #933 lists "replace this with claim-before-publish so cross-channel
    /// `@somebody` is visible" as work to do. Checked 2026-08-25: the claim is
    /// already here — `GatewayLiveNotifier::message_created` claims the id in
    /// the shared `MessageDedup` before publishing, and `route_session_message`
    /// reads the same map. So the belt is on and this constant is only braces.
    ///
    /// It stays anyway, because carrying real mentions would currently feed
    /// nobody:
    ///
    /// - Desktop routes an inbound live envelope's `mentionActorIds` into the
    ///   ACP debug panel only. The message list, unread state and the status
    ///   dot never see it (the dot reads the *outbox*, i.e. what this client
    ///   sent).
    /// - `route_session_message` and `push_message_to_mentioned_externals` are
    ///   the daemon-side consumers, and both sit behind the dedup gate that the
    ///   publish already closed — for a gateway-written message neither runs.
    /// - WeCom has no structured mention field to carry in the first place:
    ///   `@<display name> 正文` in the text is all its callback gives (see
    ///   `strip_group_mention_prefix`). Feishu does have one.
    ///
    /// So the order is: give inbound mentions a consumer first, then plumb
    /// `InboundMessage.mentions` through `SessionWriter`. Dropping the constant
    /// before that changes nothing a user can see and re-opens the double-turn
    /// this guards against.
    const NO_MENTIONS: &'static str = r#"{"mention_actor_ids":[]}"#;

    async fn announce(
        &self,
        session_id: &str,
        message_id: &str,
        sender_actor_id: &str,
        kind: MessageKind,
        content: &str,
    ) {
        if let Some(live) = &self.live {
            live.message_created(
                session_id,
                message_id,
                sender_actor_id,
                kind,
                content,
                Self::NO_MENTIONS,
            )
            .await;
        }
    }
}

/// The `messages.attachments` JSONB shape, shared by both directions so an
/// inbound and an outbound attachment are stored identically.
fn attachment_json(attachments: Vec<AttachmentRecord>) -> serde_json::Value {
    serde_json::Value::Array(
        attachments
            .into_iter()
            .map(|a| {
                serde_json::json!({
                    "filename": a.filename,
                    "mime": a.mime,
                    "size": a.size,
                    "bucket_path": a.bucket_path,
                    "local_path": a.local_path,
                })
            })
            .collect(),
    )
}

#[async_trait]
impl ChannelStore for AmuxdChannelStore {
    async fn ensure_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> Result<String, StoreError> {
        self.client
            .rpc_upsert_external_actor(team_id, source, source_id, display_name)
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))
    }

    async fn ensure_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
        primary_agent_actor_id: &str,
        owner_member_actor_ids: &[String],
        participant_actor_ids: &[String],
    ) -> Result<EnsureSessionOutcome, StoreError> {
        let (session_id, acp_session_id, created) = self
            .client
            .rpc_ensure_gateway_session(
                team_id,
                binding,
                title,
                primary_agent_actor_id,
                owner_member_actor_ids,
                participant_actor_ids,
            )
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))?;
        Ok(EnsureSessionOutcome {
            session_id,
            acp_session_id,
            created,
        })
    }

    async fn record_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> Result<String, StoreError> {
        let message_id = self
            .client
            .insert_gateway_message(session_id, sender_actor_id, content, external_message_id)
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))?;
        self.announce(
            session_id,
            &message_id,
            sender_actor_id,
            MessageKind::Text,
            content,
        )
        .await;
        Ok(message_id)
    }

    async fn record_agent_reply(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> Result<String, StoreError> {
        let message_id = self
            .client
            .insert_gateway_agent_reply(session_id, sender_actor_id, content, external_message_id)
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))?;
        self.announce(
            session_id,
            &message_id,
            sender_actor_id,
            MessageKind::AgentReply,
            content,
        )
        .await;
        Ok(message_id)
    }

    async fn record_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: Vec<AttachmentRecord>,
    ) -> Result<String, StoreError> {
        let message_id = self
            .client
            .insert_gateway_message_with_attachments(
                session_id,
                sender_actor_id,
                content,
                external_message_id,
                attachment_json(attachments),
            )
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))?;
        self.announce(
            session_id,
            &message_id,
            sender_actor_id,
            MessageKind::Text,
            content,
        )
        .await;
        Ok(message_id)
    }

    async fn record_agent_reply_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: Vec<AttachmentRecord>,
    ) -> Result<String, StoreError> {
        let message_id = self
            .client
            .insert_gateway_agent_reply_with_attachments(
                session_id,
                sender_actor_id,
                content,
                external_message_id,
                attachment_json(attachments),
            )
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))?;
        self.announce(
            session_id,
            &message_id,
            sender_actor_id,
            MessageKind::AgentReply,
            content,
        )
        .await;
        Ok(message_id)
    }

    async fn upload_attachment(
        &self,
        bucket_path: &str,
        bytes: Vec<u8>,
        mime: &str,
    ) -> Result<String, StoreError> {
        self.client
            .upload_attachment_bytes(bucket_path, bytes, mime)
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))
    }

    async fn add_participant(&self, session_id: &str, actor_id: &str) -> Result<(), StoreError> {
        self.client
            .upsert_session_participant(session_id, actor_id)
            .await
            .map_err(|e| StoreError::Backend(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    //! Caller-level integration tests proving the `Backend` abstraction is
    //! usable: `AmuxdChannelStore` is exercised against `MockBackend` with
    //! no HTTP mocking, and we inspect the backend's recorded state to
    //! assert behavior.

    use super::*;
    use crate::backend::mock::MockBackend;
    use teamclu_gateway::AttachmentRecord;

    fn store() -> (AmuxdChannelStore, MockBackend) {
        let mock = MockBackend::with_identity("team-x", "agent-x");
        let backend: Arc<dyn Backend> = Arc::new(mock.clone());
        // No notifier: these tests assert what reaches the backend, and a
        // live publish needs an MQTT client they deliberately do not have.
        (
            AmuxdChannelStore {
                client: backend,
                live: None,
            },
            mock,
        )
    }

    #[tokio::test]
    async fn ensure_external_actor_records_inputs_and_uses_default_uuid() {
        let (store, mock) = store();
        let id = store
            .ensure_external_actor("team-x", "discord", "user-42", "Alice")
            .await
            .unwrap();
        assert_eq!(id, "external-discord-user-42");
        let snap = mock.state();
        assert_eq!(snap.external_actors_upserted.len(), 1);
        assert_eq!(snap.external_actors_upserted[0].display_name, "Alice");
    }

    #[tokio::test]
    async fn ensure_session_threads_seeded_outcome_back_to_caller() {
        let (store, mock) = store();
        mock.state().ensure_gateway_session_result = Some(("sess-1".into(), "acp-1".into(), true));

        let out = store
            .ensure_session(
                "team-x",
                "discord://chan/1",
                "title",
                "agent-x",
                &["owner-1".into()],
                &["part-1".into()],
            )
            .await
            .unwrap();
        assert_eq!(out.session_id, "sess-1");
        assert_eq!(out.acp_session_id, "acp-1");
        assert!(out.created);

        let snap = mock.state();
        assert_eq!(snap.gateway_sessions_ensured.len(), 1);
        assert_eq!(snap.gateway_sessions_ensured[0].binding, "discord://chan/1");
        assert_eq!(
            snap.gateway_sessions_ensured[0].owner_member_actor_ids,
            vec!["owner-1".to_string()]
        );
    }

    #[tokio::test]
    async fn record_message_with_attachments_serializes_attachment_records() {
        let (store, mock) = store();
        let attachments = vec![AttachmentRecord {
            filename: "img.png".into(),
            mime: "image/png".into(),
            size: 1024,
            bucket_path: "t/s/1/img.png".into(),
            local_path: Some("/tmp/img.png".into()),
        }];
        let id = store
            .record_message_with_attachments(
                "sess-1",
                "agent-x",
                "see attached",
                Some("ext-1"),
                attachments,
            )
            .await
            .unwrap();
        assert!(id.starts_with("mock-msg-"));

        let snap = mock.state();
        assert_eq!(snap.gateway_messages_inserted.len(), 1);
        let stored = &snap.gateway_messages_inserted[0];
        assert_eq!(stored.external_id.as_deref(), Some("ext-1"));
        let arr = stored
            .attachments
            .as_array()
            .expect("attachments JSON array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["filename"], "img.png");
        assert_eq!(arr[0]["bucket_path"], "t/s/1/img.png");
    }

    #[tokio::test]
    async fn upload_attachment_buffers_bytes_in_recorded_state() {
        let (store, mock) = store();
        store
            .upload_attachment("team-x/sess/file.png", vec![1, 2, 3, 4], "image/png")
            .await
            .unwrap();
        let snap = mock.state();
        assert_eq!(snap.attachments_uploaded.len(), 1);
        assert_eq!(snap.attachments_uploaded[0].bytes, vec![1, 2, 3, 4]);
        assert_eq!(snap.attachments_uploaded[0].mime, "image/png");
    }

    #[tokio::test]
    async fn an_agent_sent_attachment_is_recorded_as_a_reply_not_a_user_message() {
        // The kind decides which side of the conversation the row renders on.
        // Recorded as `text`, a file the agent sent showed up in the desktop as
        // if the user had sent it.
        let (store, mock) = store();
        store
            .record_agent_reply_with_attachments(
                "sess-1",
                "agent-1",
                "[Attachment: poem.md]",
                None,
                vec![AttachmentRecord {
                    filename: "poem.md".into(),
                    mime: "text/markdown".into(),
                    size: 12,
                    bucket_path: "team/sess-1/uuid-poem.md".into(),
                    local_path: Some("/tmp/poem.md".into()),
                }],
            )
            .await
            .unwrap();

        let st = mock.state();
        let row = st.gateway_messages_inserted.last().unwrap();
        assert_eq!(row.kind, "agent_reply");
        assert_eq!(row.attachments[0]["filename"], "poem.md");
        assert_eq!(
            row.attachments[0]["bucket_path"],
            "team/sess-1/uuid-poem.md"
        );
    }

    #[tokio::test]
    async fn an_inbound_attachment_is_still_recorded_as_a_user_message() {
        let (store, mock) = store();
        store
            .record_message_with_attachments(
                "sess-1",
                "external-1",
                "look at this",
                Some("ext-1"),
                vec![AttachmentRecord {
                    filename: "photo.png".into(),
                    mime: "image/png".into(),
                    size: 3,
                    bucket_path: "team/sess-1/uuid-photo.png".into(),
                    local_path: None,
                }],
            )
            .await
            .unwrap();

        assert_eq!(
            mock.state().gateway_messages_inserted.last().unwrap().kind,
            "text"
        );
    }
}
