//! A [`Backend`] that may not be onboarded yet.
//!
//! `amuxd start` must come up on a machine that has never run `amuxd init`,
//! so the HTTP control plane can serve the setup UI that *performs* the
//! onboarding. Before that happens there is no `backend.toml`, hence no
//! credentials and no Cloud API client.
//!
//! [`DeferredBackend`] fills that gap: it is a `Backend` whose inner
//! implementation is installed later. Every business call fails with
//! [`unclaimed_error`] until [`DeferredBackend::install`] is called; after
//! that they delegate to the real backend. Because callers bind to
//! `Arc<dyn Backend>`, installing the real client mid-flight is invisible to
//! them — no `Option` threading through the daemon, no restart required.
//!
//! Identity (`team_id` / `actor_id`) returns `&str`, which cannot borrow from
//! behind a lock guard, so it is stored in a `OnceLock` written at install
//! time. This also encodes the intended lifecycle: a daemon is claimed by
//! exactly one actor, once. Re-claiming as a *different* actor requires a
//! restart, which is correct — MQTT topic ACLs are bound to `actor_id`, and
//! live sessions/subscriptions cannot be re-keyed under a new identity.

use async_trait::async_trait;
use std::sync::{Arc, OnceLock};

use super::records::{
    ActorDirectoryRow, BackendSessionAndParticipants, ClaimResult, GatewaySessionRow,
    StoredMessage, WorkspaceRow, WorkspaceUpsert,
};
use super::{
    AgentDefaults, Backend, BackendError, BackendResult, BootstrapMqttOverride, CloudAuthSnapshot,
    ManagedLlmConfig, ShareModeConfig, TeamEnvSecretRow, TeamSkillDownload, TeamSkillRow,
};

/// Error returned by every business call before onboarding completes.
///
/// `Auth` (not `Config`) because callers already treat auth failures as
/// retryable-after-credentials rather than fatal — an unclaimed daemon is
/// exactly that state.
fn unclaimed_error() -> BackendError {
    BackendError::Auth(
        "daemon is not onboarded yet (no backend.toml); complete setup at /v1/setup \
         or run `amuxd init <invite-url>`"
            .to_string(),
    )
}

pub struct DeferredBackend {
    inner: parking_lot::RwLock<Option<Arc<dyn Backend>>>,
    team_id: OnceLock<String>,
    actor_id: OnceLock<String>,
}

impl std::fmt::Debug for DeferredBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeferredBackend")
            .field("claimed", &self.is_claimed())
            .field("team_id", &self.team_id.get())
            .field("actor_id", &self.actor_id.get())
            .finish()
    }
}

impl DeferredBackend {
    /// An un-onboarded daemon: no credentials, no identity.
    pub fn unclaimed() -> Self {
        Self {
            inner: parking_lot::RwLock::new(None),
            team_id: OnceLock::new(),
            actor_id: OnceLock::new(),
        }
    }

    /// Wrap an already-onboarded backend. Used on the normal startup path when
    /// `backend.toml` is present, so the wrapper is uniform and the daemon has
    /// exactly one backend type regardless of onboarding state.
    pub fn claimed(inner: Arc<dyn Backend>) -> Self {
        let wrapper = Self::unclaimed();
        wrapper.install(inner);
        wrapper
    }

    /// Install the real backend, making this daemon claimed.
    ///
    /// Identity is captured on the first install only. A second install swaps
    /// the client (e.g. refreshed credentials for the same actor) but leaves
    /// `team_id`/`actor_id` untouched — see the module docs on why re-claiming
    /// as a different actor needs a restart. Returns whether identity was
    /// captured from *this* call, so the caller can detect that case.
    pub fn install(&self, backend: Arc<dyn Backend>) -> bool {
        let first = self.team_id.set(backend.team_id().to_string()).is_ok();
        let _ = self.actor_id.set(backend.actor_id().to_string());
        *self.inner.write() = Some(backend);
        first
    }

    pub fn is_claimed(&self) -> bool {
        self.inner.read().is_some()
    }

    /// The real backend, or [`unclaimed_error`]. The guard is dropped before
    /// the returned `Arc` is awaited on — holding a lock across `.await` would
    /// serialize every backend call in the daemon.
    fn inner(&self) -> BackendResult<Arc<dyn Backend>> {
        self.inner.read().clone().ok_or_else(unclaimed_error)
    }

    /// Non-erroring variant for the trait methods that return a plain value.
    fn inner_opt(&self) -> Option<Arc<dyn Backend>> {
        self.inner.read().clone()
    }
}

#[async_trait]
impl Backend for DeferredBackend {
    // ── Identity ──────────────────────────────────────────────────────────
    // Empty string when unclaimed. Callers already tolerate this: the MQTT
    // client is a placeholder while `broker_url` is empty (which it also is
    // when unclaimed), so no topic is ever built from these.
    fn team_id(&self) -> &str {
        self.team_id.get().map(String::as_str).unwrap_or("")
    }

    fn actor_id(&self) -> &str {
        self.actor_id.get().map(String::as_str).unwrap_or("")
    }

    // ── Credentials ───────────────────────────────────────────────────────
    async fn auth_token(&self) -> BackendResult<String> {
        self.inner()?.auth_token().await
    }

    fn cached_credential_expiry_epoch(&self) -> Option<i64> {
        self.inner_opt()?.cached_credential_expiry_epoch()
    }

    fn invalidate_cached_credential(&self) {
        if let Some(inner) = self.inner_opt() {
            inner.invalidate_cached_credential();
        }
    }

    fn cloud_auth_health(&self) -> Option<CloudAuthSnapshot> {
        self.inner_opt()?.cloud_auth_health()
    }

    async fn fetch_bootstrap_mqtt(&self) -> BackendResult<Option<BootstrapMqttOverride>> {
        // Unclaimed: no broker to resolve. `None` (not an error) keeps
        // `apply_bootstrap_overrides` on its quiet path — it already warns
        // once about the empty broker and leaves MQTT on the placeholder.
        match self.inner_opt() {
            Some(inner) => inner.fetch_bootstrap_mqtt().await,
            None => Ok(None),
        }
    }

    async fn team_share_config(&self, team_id: &str) -> BackendResult<ShareModeConfig> {
        self.inner()?.team_share_config(team_id).await
    }

    async fn managed_llm_config(&self, team_id: &str) -> BackendResult<ManagedLlmConfig> {
        self.inner()?.managed_llm_config(team_id).await
    }

    async fn team_mcp_config(&self, team_id: &str) -> BackendResult<serde_json::Value> {
        self.inner()?.team_mcp_config(team_id).await
    }

    async fn install_team_mcp(&self, team_id: &str, name: &str) -> BackendResult<()> {
        self.inner()?.install_team_mcp(team_id, name).await
    }

    async fn uninstall_team_mcp(&self, team_id: &str, name: &str) -> BackendResult<()> {
        self.inner()?.uninstall_team_mcp(team_id, name).await
    }

    async fn team_env_secrets(&self, team_id: &str) -> BackendResult<Vec<TeamEnvSecretRow>> {
        self.inner()?.team_env_secrets(team_id).await
    }

    // Every method a caller needs has to be forwarded explicitly — a trait
    // default here is not "unimplemented", it is a wrong answer delivered
    // confidently. The skills reconcile reads an un-forwarded `team_skills` as
    // an empty desired set and deletes the agent's entire skill root on that
    // basis, which is why these three exist even though the wrapper looks like
    // it could inherit them.
    async fn team_skills(&self, team_id: &str) -> BackendResult<Vec<TeamSkillRow>> {
        self.inner()?.team_skills(team_id).await
    }

    async fn team_skill_download(
        &self,
        team_id: &str,
        slug: &str,
        version: i64,
    ) -> BackendResult<TeamSkillDownload> {
        self.inner()?
            .team_skill_download(team_id, slug, version)
            .await
    }

    async fn record_team_skill_install(
        &self,
        team_id: &str,
        slug: &str,
        version: i64,
    ) -> BackendResult<()> {
        self.inner()?
            .record_team_skill_install(team_id, slug, version)
            .await
    }

    async fn remove_team_skill_install(&self, team_id: &str, slug: &str) -> BackendResult<()> {
        self.inner()?.remove_team_skill_install(team_id, slug).await
    }

    async fn verify_agent_management_grant(
        &self,
        grant: &str,
        scope: &str,
        requester_actor_id: &str,
        request_id: &str,
    ) -> BackendResult<()> {
        self.inner()?
            .verify_agent_management_grant(grant, scope, requester_actor_id, request_id)
            .await
    }

    async fn ensure_llm_member_key(&self, team_id: &str) -> BackendResult<()> {
        self.inner()?.ensure_llm_member_key(team_id).await
    }

    async fn get_effective_default_agent(&self, team_id: &str) -> BackendResult<Option<String>> {
        self.inner()?.get_effective_default_agent(team_id).await
    }

    fn cloud_base_url(&self) -> Option<String> {
        self.inner_opt()?.cloud_base_url()
    }

    // ── Business operations ───────────────────────────────────────────────
    async fn claim_team_invite(&self, token: &str) -> BackendResult<ClaimResult> {
        self.inner()?.claim_team_invite(token).await
    }

    async fn fetch_session_workspace(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>> {
        self.inner()?
            .fetch_session_workspace(session_id, actor_id)
            .await
    }

    async fn fetch_session_cursor(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>> {
        self.inner()?
            .fetch_session_cursor(session_id, actor_id)
            .await
    }

    async fn ensure_agent_types(
        &self,
        supported_types: &[String],
        default_agent_type: Option<&str>,
    ) -> BackendResult<()> {
        self.inner()?
            .ensure_agent_types(supported_types, default_agent_type)
            .await
    }

    async fn check_agent_permission(
        &self,
        agent_id: &str,
        actor_id: &str,
    ) -> BackendResult<Option<String>> {
        self.inner()?
            .check_agent_permission(agent_id, actor_id)
            .await
    }

    async fn heartbeat(&self) -> BackendResult<()> {
        self.inner()?.heartbeat().await
    }

    async fn report_client_version(&self, device_id: &str) -> BackendResult<()> {
        self.inner()?.report_client_version(device_id).await
    }

    async fn upsert_workspace(&self, row: &WorkspaceUpsert<'_>) -> BackendResult<WorkspaceRow> {
        self.inner()?.upsert_workspace(row).await
    }

    async fn get_workspaces_by_ids(&self, ids: &[String]) -> BackendResult<Vec<WorkspaceRow>> {
        self.inner()?.get_workspaces_by_ids(ids).await
    }

    async fn get_workspaces_by_agent(
        &self,
        team_id: &str,
        agent_id: &str,
    ) -> BackendResult<Vec<WorkspaceRow>> {
        self.inner()?
            .get_workspaces_by_agent(team_id, agent_id)
            .await
    }

    async fn get_workspaces_by_team(&self, team_id: &str) -> BackendResult<Vec<WorkspaceRow>> {
        self.inner()?.get_workspaces_by_team(team_id).await
    }

    async fn set_agent_default_workspace(&self, workspace_id: &str) -> BackendResult<()> {
        self.inner()?
            .set_agent_default_workspace(workspace_id)
            .await
    }

    async fn get_agent_defaults(&self, agent_id: &str) -> BackendResult<AgentDefaults> {
        self.inner()?.get_agent_defaults(agent_id).await
    }

    async fn fetch_session_with_participants(
        &self,
        session_id: &str,
    ) -> BackendResult<BackendSessionAndParticipants> {
        self.inner()?
            .fetch_session_with_participants(session_id)
            .await
    }

    async fn get_actors_by_ids(&self, ids: &[String]) -> BackendResult<Vec<ActorDirectoryRow>> {
        self.inner()?.get_actors_by_ids(ids).await
    }

    async fn messages_after_cursor(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>> {
        self.inner()?
            .messages_after_cursor(session_id, after_id)
            .await
    }

    async fn update_session_cursor(
        &self,
        session_id: &str,
        actor_id: &str,
        last_processed_message_id: &str,
    ) -> BackendResult<()> {
        self.inner()?
            .update_session_cursor(session_id, actor_id, last_processed_message_id)
            .await
    }

    async fn update_participant_model(
        &self,
        session_id: &str,
        actor_id: &str,
        model: &str,
    ) -> BackendResult<()> {
        self.inner()?
            .update_participant_model(session_id, actor_id, model)
            .await
    }

    async fn rpc_upsert_external_actor(
        &self,
        team_id: &str,
        source: &str,
        source_id: &str,
        display_name: &str,
    ) -> BackendResult<String> {
        self.inner()?
            .rpc_upsert_external_actor(team_id, source, source_id, display_name)
            .await
    }

    async fn get_gateway_session_by_acp_id(
        &self,
        acp_session_id: &str,
    ) -> BackendResult<Option<(String, Option<String>)>> {
        self.inner()?
            .get_gateway_session_by_acp_id(acp_session_id)
            .await
    }

    async fn get_session_binding(&self, session_id: &str) -> BackendResult<Option<String>> {
        self.inner()?.get_session_binding(session_id).await
    }

    async fn rpc_detach_gateway_session(&self, acp_session_id: &str) -> BackendResult<bool> {
        self.inner()?
            .rpc_detach_gateway_session(acp_session_id)
            .await
    }

    async fn rpc_list_gateway_sessions(
        &self,
        team_id: &str,
        gateway_key: &str,
        limit: u32,
    ) -> BackendResult<Vec<GatewaySessionRow>> {
        self.inner()?
            .rpc_list_gateway_sessions(team_id, gateway_key, limit)
            .await
    }

    async fn rpc_attach_gateway_session(
        &self,
        binding: &str,
        session_id: &str,
    ) -> BackendResult<Option<String>> {
        self.inner()?
            .rpc_attach_gateway_session(binding, session_id)
            .await
    }

    async fn rpc_ensure_gateway_session(
        &self,
        team_id: &str,
        binding: &str,
        title: &str,
        primary_agent_actor_id: &str,
        owner_member_actor_ids: &[String],
        participant_actor_ids: &[String],
    ) -> BackendResult<(String, String, bool)> {
        self.inner()?
            .rpc_ensure_gateway_session(
                team_id,
                binding,
                title,
                primary_agent_actor_id,
                owner_member_actor_ids,
                participant_actor_ids,
            )
            .await
    }

    async fn insert_gateway_message(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        self.inner()?
            .insert_gateway_message(session_id, sender_actor_id, content, external_message_id)
            .await
    }

    async fn insert_gateway_agent_reply(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        // Delegate explicitly rather than inheriting the trait default: the
        // default would call *our* `insert_gateway_message`, silently
        // downgrading the `agent_reply` kind to `text`.
        self.inner()?
            .insert_gateway_agent_reply(session_id, sender_actor_id, content, external_message_id)
            .await
    }

    async fn insert_gateway_message_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: serde_json::Value,
    ) -> BackendResult<String> {
        self.inner()?
            .insert_gateway_message_with_attachments(
                session_id,
                sender_actor_id,
                content,
                external_message_id,
                attachments,
            )
            .await
    }

    async fn insert_gateway_agent_reply_with_attachments(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: serde_json::Value,
    ) -> BackendResult<String> {
        self.inner()?
            .insert_gateway_agent_reply_with_attachments(
                session_id,
                sender_actor_id,
                content,
                external_message_id,
                attachments,
            )
            .await
    }

    async fn upload_attachment_bytes(
        &self,
        path: &str,
        bytes: Vec<u8>,
        mime: &str,
    ) -> BackendResult<String> {
        self.inner()?
            .upload_attachment_bytes(path, bytes, mime)
            .await
    }

    async fn list_agent_admin_member_actor_ids(
        &self,
        agent_actor_id: &str,
    ) -> BackendResult<Vec<String>> {
        self.inner()?
            .list_agent_admin_member_actor_ids(agent_actor_id)
            .await
    }

    async fn update_session_title(&self, session_id: &str, title: &str) -> BackendResult<()> {
        self.inner()?.update_session_title(session_id, title).await
    }

    async fn upsert_session_participant(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> BackendResult<()> {
        self.inner()?
            .upsert_session_participant(session_id, actor_id)
            .await
    }

    async fn create_cron_session(
        &self,
        team_id: &str,
        primary_agent_actor_id: &str,
        title: &str,
        cron_job_id: Option<&str>,
    ) -> BackendResult<String> {
        self.inner()?
            .create_cron_session(team_id, primary_agent_actor_id, title, cron_job_id)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_message(
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
        self.inner()?
            .insert_message(
                id,
                team_id,
                session_id,
                sender_actor_id,
                kind,
                content,
                metadata_json,
                model,
                turn_id,
                reply_to_message_id,
                sequence,
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mock::MockBackend;

    #[test]
    fn unclaimed_has_empty_identity() {
        let b = DeferredBackend::unclaimed();
        assert!(!b.is_claimed());
        assert_eq!(b.team_id(), "");
        assert_eq!(b.actor_id(), "");
    }

    #[tokio::test]
    async fn unclaimed_business_calls_fail_with_auth_error() {
        let b = DeferredBackend::unclaimed();
        let err = b.heartbeat().await.unwrap_err();
        assert!(matches!(err, BackendError::Auth(_)));
        assert!(err.to_string().contains("not onboarded"));
        assert!(b.auth_token().await.is_err());
    }

    #[tokio::test]
    async fn unclaimed_bootstrap_mqtt_is_none_not_error() {
        // apply_bootstrap_overrides tolerates Err, but None keeps it off the
        // warn path — an unclaimed daemon has nothing to warn about yet.
        let b = DeferredBackend::unclaimed();
        assert!(b.fetch_bootstrap_mqtt().await.unwrap().is_none());
    }

    #[test]
    fn unclaimed_value_returning_methods_do_not_panic() {
        let b = DeferredBackend::unclaimed();
        assert!(b.cached_credential_expiry_epoch().is_none());
        assert!(b.cloud_auth_health().is_none());
        assert!(b.cloud_base_url().is_none());
        b.invalidate_cached_credential();
    }

    #[tokio::test]
    async fn install_captures_identity_and_delegates() {
        let b = DeferredBackend::unclaimed();
        let mock = Arc::new(MockBackend::with_identity("team-1", "actor-1"));

        assert!(b.install(mock));

        assert!(b.is_claimed());
        assert_eq!(b.team_id(), "team-1");
        assert_eq!(b.actor_id(), "actor-1");
        assert!(b.heartbeat().await.is_ok());
    }

    #[tokio::test]
    async fn identity_is_captured_once() {
        let b = DeferredBackend::unclaimed();
        assert!(b.install(Arc::new(MockBackend::with_identity("team-1", "actor-1"))));

        // Second install swaps the client but must not re-key identity.
        assert!(!b.install(Arc::new(MockBackend::with_identity("team-2", "actor-2"))));
        assert_eq!(b.team_id(), "team-1");
        assert_eq!(b.actor_id(), "actor-1");
    }

    #[test]
    fn claimed_constructor_is_immediately_claimed() {
        let b = DeferredBackend::claimed(Arc::new(MockBackend::with_identity("team-9", "actor-9")));
        assert!(b.is_claimed());
        assert_eq!(b.team_id(), "team-9");
    }

    /// `/sessions` and `/sessions <n>` go through this wrapper, and both used
    /// to inherit a trait default instead of reaching the client: the list
    /// answered "no sessions" and the switch answered "cannot switch", in every
    /// chat, without one packet leaving the daemon. `install_captures_identity_
    /// and_delegates` above did not catch it because it only exercises
    /// `heartbeat`. Both trait methods are required now, so a future forward
    /// that goes missing is a compile error — this test is the belt to that
    /// braces, and pins the values through rather than just the plumbing.
    #[tokio::test]
    async fn gateway_session_lineage_reaches_the_inner_backend() {
        let mock = Arc::new(MockBackend::with_identity("team-1", "actor-1"));
        let key = "wecom://bot/bot/single/LiangLiang";
        mock.state().gateway_sessions_by_key.insert(
            key.to_string(),
            vec![
                GatewaySessionRow {
                    session_id: "sess-current".into(),
                    acp_session_id: Some("acp-current".into()),
                    title: "WeCom DM: LiangLiang".into(),
                    is_current: true,
                },
                GatewaySessionRow {
                    session_id: "sess-older".into(),
                    acp_session_id: Some("acp-older".into()),
                    title: "WeCom DM: LiangLiang (2026-08-19 01:15)".into(),
                    is_current: false,
                },
            ],
        );
        let b = DeferredBackend::claimed(mock.clone());

        let listed = b
            .rpc_list_gateway_sessions("team-1", key, 20)
            .await
            .unwrap();
        assert_eq!(
            listed.len(),
            2,
            "the chat's lineage must survive the wrapper"
        );
        assert_eq!(listed[0].session_id, "sess-current");
        assert!(listed[0].is_current);

        let attached = b
            .rpc_attach_gateway_session(key, "sess-older")
            .await
            .unwrap();
        assert_eq!(attached.as_deref(), Some("acp-older"));
        assert_eq!(
            mock.state().gateway_sessions_attached,
            vec![(key.to_string(), "sess-older".to_string())],
            "the switch must be recorded by the inner backend, not swallowed"
        );
    }

    /// Both of these were added to the trait with default bodies and never
    /// forwarded here, so on every onboarded daemon `verify_agent_management_grant`
    /// answered "unsupported by this backend" — surfaced in the UI as "upgrade
    /// your Agent" — and `remove_team_skill_install` silently did nothing while
    /// reporting success. Nothing failed to compile. They are required trait
    /// methods now; this test is the behavioural half of that guard.
    #[tokio::test]
    async fn agent_management_and_skill_removal_reach_the_inner_backend() {
        let mock = Arc::new(MockBackend::with_identity("team-1", "agent-1"));
        let b = DeferredBackend::claimed(mock.clone());

        b.verify_agent_management_grant("grant-jwt", "skills:install", "member-1", "req-1")
            .await
            .expect("a claimed wrapper must delegate, not answer 'unsupported'");
        assert_eq!(
            mock.state().agent_management_verifications,
            vec![(
                "grant-jwt".to_string(),
                "skills:install".to_string(),
                "member-1".to_string(),
                "req-1".to_string(),
            )],
        );

        b.remove_team_skill_install("team-1", "research")
            .await
            .unwrap();
        assert_eq!(
            mock.state().team_skill_uninstalls,
            vec![("team-1".to_string(), "research".to_string())],
            "a silent Ok(()) here reports an uninstall that never happened",
        );
    }
}
