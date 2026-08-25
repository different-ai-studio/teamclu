//! The core's traits, implemented over what the daemon already has.
//!
//! Nothing new is invented here: `AmuxdChannelStore` already inserts and
//! broadcasts, `AmuxdAgentHandle` already drives turns, `commands::dispatch`
//! already answers slash commands. What changes is that there is now exactly
//! one caller of each, instead of one per channel.

use std::sync::Arc;

use async_trait::async_trait;
use teamclu_gateway::{
    driver::SessionAttachment, AgentHandle, AttachmentRecord, ChannelStore, StoreError,
};

use super::{
    CommandRunner, CoreError, IdentityMapper, PendingUpload, SessionRef, SessionRouter,
    SessionWriter, TurnRunner,
};

fn route(e: StoreError) -> CoreError {
    CoreError::Route(e.to_string())
}

/// Team-scoped session resolution: binding → session, created on first contact.
pub struct StoreRouter {
    pub store: Arc<dyn ChannelStore>,
    pub team_id: String,
    pub primary_agent_actor_id: String,
    pub agent_owner_actor_ids: Vec<String>,
}

#[async_trait]
impl SessionRouter for StoreRouter {
    async fn resolve(
        &self,
        binding: &str,
        title: &str,
        external_actor_id: &str,
    ) -> Result<SessionRef, CoreError> {
        let outcome = self
            .store
            .ensure_session(
                &self.team_id,
                binding,
                title,
                &self.primary_agent_actor_id,
                &self.agent_owner_actor_ids,
                std::slice::from_ref(&external_actor_id.to_string()),
            )
            .await
            .map_err(route)?;
        Ok(SessionRef {
            session_id: outcome.session_id,
            acp_session_id: outcome.acp_session_id,
        })
    }
}

pub struct StoreIdentity {
    pub store: Arc<dyn ChannelStore>,
    pub team_id: String,
    /// `"wecom"` / `"feishu"` — the `source` column on the actor.
    pub source: &'static str,
}

#[async_trait]
impl IdentityMapper for StoreIdentity {
    async fn actor_for(&self, urn: &str, display_name: &str) -> Result<String, CoreError> {
        self.store
            .ensure_external_actor(&self.team_id, self.source, urn, display_name)
            .await
            .map_err(|e| CoreError::Identity(e.to_string()))
    }

    async fn join(&self, session_id: &str, actor_id: &str) -> Result<(), CoreError> {
        // A failure here is not fatal: the message still belongs in the
        // session, and the participant list is repaired on the next message.
        if let Err(e) = self.store.add_participant(session_id, actor_id).await {
            tracing::warn!(session_id, error = %e, "gateway: add_participant failed");
        }
        Ok(())
    }
}

/// Writes and broadcasts — the #933 write service, as far as it exists today.
///
/// `AmuxdChannelStore::record_*` already publishes `message.created` after each
/// insert, so "write" and "broadcast" are one call. When the write service
/// lands properly (mention semantics, claim-before-publish), this is the single
/// place that changes.
pub struct StoreWriter {
    pub store: Arc<dyn ChannelStore>,
    /// Who agent replies are attributed to.
    pub agent_actor_id: String,
    pub team_id: String,
}

#[async_trait]
impl SessionWriter for StoreWriter {
    async fn write_inbound(
        &self,
        session_id: &str,
        actor_id: &str,
        text: &str,
        attachments: Vec<PendingUpload>,
        external_message_id: &str,
    ) -> Result<String, CoreError> {
        let mut records = Vec::with_capacity(attachments.len());
        let mut fragments = Vec::new();
        for upload in &attachments {
            // An upload failure keeps the message: the agent still needs the
            // text and the filename, even if clients cannot download the bytes.
            let record = match self.upload(session_id, upload).await {
                Ok(a) => AttachmentRecord {
                    filename: a.filename,
                    mime: a.mime,
                    size: upload.bytes.len(),
                    bucket_path: a.bucket_path,
                    local_path: a.local_path,
                },
                Err(e) => {
                    tracing::warn!(session_id, error = %e, "attachment upload failed; recording metadata only");
                    AttachmentRecord {
                        filename: upload.filename.clone(),
                        mime: upload.mime.clone(),
                        size: upload.bytes.len(),
                        bucket_path: String::new(),
                        local_path: None,
                    }
                }
            };
            fragments.push(format!(
                "[Attachment: {}] ({})",
                record.filename,
                human_size(record.size)
            ));
            records.push(record);
        }

        // Same rendering convention the desktop's own upload path produces, so
        // an attachment from a channel and one from the app look alike in the
        // message list.
        let content = match (text.trim().is_empty(), fragments.is_empty()) {
            (_, true) => text.to_string(),
            (true, false) => fragments.join("\n"),
            (false, false) => format!("{text}\n{}", fragments.join("\n")),
        };

        self.store
            .record_message_with_attachments(
                session_id,
                actor_id,
                &content,
                Some(external_message_id),
                records,
            )
            .await
            .map_err(|e| CoreError::Write(e.to_string()))
    }

    async fn write_reply(
        &self,
        session_id: &str,
        text: &str,
        attachments: Vec<SessionAttachment>,
    ) -> Result<String, CoreError> {
        if attachments.is_empty() {
            return self
                .store
                .record_agent_reply(session_id, &self.agent_actor_id, text, None)
                .await
                .map_err(|e| CoreError::Write(e.to_string()));
        }
        let records = attachments
            .into_iter()
            .map(|a| AttachmentRecord {
                filename: a.filename,
                mime: a.mime,
                size: 0,
                bucket_path: a.bucket_path,
                local_path: a.local_path,
            })
            .collect();
        self.store
            .record_agent_reply_with_attachments(
                session_id,
                &self.agent_actor_id,
                text,
                None,
                records,
            )
            .await
            .map_err(|e| CoreError::Write(e.to_string()))
    }

    async fn upload(
        &self,
        session_id: &str,
        upload: &PendingUpload,
    ) -> Result<SessionAttachment, CoreError> {
        // Team- and session-scoped, so both directions land in one place.
        let bucket_path = format!(
            "{}/{}/{}-{}",
            self.team_id,
            session_id,
            uuid::Uuid::new_v4(),
            super::safe_object_name(&upload.filename)
        );
        let stored = self
            .store
            .upload_attachment(&bucket_path, upload.bytes.clone(), &upload.mime)
            .await
            .map_err(|e| CoreError::Write(e.to_string()))?;
        Ok(SessionAttachment {
            filename: upload.filename.clone(),
            mime: upload.mime.clone(),
            bucket_path: stored,
            // Carried through so a channel that uploads media itself can read
            // the bytes back at delivery time.
            local_path: upload.local_path.clone(),
        })
    }
}

fn human_size(bytes: usize) -> String {
    const KB: usize = 1024;
    const MB: usize = KB * 1024;
    match bytes {
        b if b >= MB => format!("{:.1} MB", b as f64 / MB as f64),
        b if b >= KB => format!("{:.1} KB", b as f64 / KB as f64),
        b => format!("{b} B"),
    }
}

/// Drives the turn through the agent handle the gateways already share.
pub struct AgentTurns {
    /// The channel's own patience, from its caps. Held here because the core
    /// is built per driver, so there is exactly one value in play per channel.
    pub turn_timeout: std::time::Duration,
    pub agent: Arc<dyn AgentHandle>,
}

#[async_trait]
impl TurnRunner for AgentTurns {
    async fn run(
        &self,
        acp_session_id: &str,
        sender_display: &str,
        prompt: &str,
        on_delta: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<String, CoreError> {
        let outcome = match on_delta {
            Some(tx) => {
                self.agent
                    .send_prompt_streamed(
                        &acp_session_id.to_string(),
                        sender_display,
                        prompt,
                        tx,
                        self.turn_timeout,
                    )
                    .await
            }
            None => {
                self.agent
                    .send_prompt(
                        &acp_session_id.to_string(),
                        sender_display,
                        prompt,
                        self.turn_timeout,
                    )
                    .await
            }
        }
        .map_err(|e| CoreError::Turn(e.to_string()))?;
        Ok(outcome.reply_text)
    }
}

/// Slash commands, through the same two-layer dispatch every channel used.
pub struct GatewayCommands {
    pub agent: Arc<dyn AgentHandle>,
    pub store: Arc<dyn ChannelStore>,
}

#[async_trait]
impl CommandRunner for GatewayCommands {
    async fn dispatch(
        &self,
        name: &str,
        arg: Option<&str>,
        acp_session_id: &str,
    ) -> Result<Option<String>, CoreError> {
        use std::sync::Mutex;
        let locale = teamclu_gateway::i18n::locale();
        let cell: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let sink = cell.clone();
        let handled = teamclu_gateway::commands::dispatch(
            name,
            arg,
            self.agent.as_ref(),
            self.store.as_ref(),
            &acp_session_id.to_string(),
            locale,
            move |r| {
                *sink.lock().unwrap() = Some(r);
            },
        )
        .await
        .map_err(|e| CoreError::Turn(e.to_string()))?;

        let reply = cell.lock().unwrap().take();
        Ok(match (handled, reply) {
            // Handled with nothing to say still counts as handled — some
            // commands act and stay quiet.
            (true, r) => Some(r.unwrap_or_default()),
            (false, _) => None,
        })
    }

    fn needs_session(&self, name: &str) -> bool {
        teamclu_gateway::commands::needs_session(name)
    }

    fn unknown_command_text(&self, name: &str) -> String {
        teamclu_gateway::commands::unknown_command_reply(name, teamclu_gateway::i18n::locale())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_sizes_read_as_sizes_not_byte_counts() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(2048), "2.0 KB");
        assert_eq!(human_size(3 * 1024 * 1024), "3.0 MB");
    }
}
