//! Collab session cold attach: resume backend sessions from `runtimes.toml` bindings.

use tracing::{info, warn};

use crate::channels::ColdAttach;
use crate::config::SessionBinding;
use crate::daemon::session_resume::{resolve_backend_session_id, BACKEND_SESSION_NOT_RESUMABLE};
use crate::proto::amux;

use super::{DaemonServer, StartRuntimeError, StartRuntimeOutcome};

impl DaemonServer {
    /// Resolve workspace for MQTT / cold paths: participant row, then default.
    pub(super) async fn resolve_collab_workspace_id(
        &self,
        cloud_session_id: &str,
    ) -> Option<String> {
        if let Ok(Some(ws)) = self
            .backend
            .fetch_session_workspace(cloud_session_id, self.backend.actor_id())
            .await
        {
            if !ws.trim().is_empty() {
                return Some(ws);
            }
        }
        let default = self.resolve_default_workspace_for_publish().await.0;
        if default.trim().is_empty() {
            None
        } else {
            Some(default)
        }
    }

    /// Pick a unique binding when workspace is unknown. Returns None if ambiguous.
    pub(super) fn resolve_binding_workspace_for_cold_attach(
        &self,
        cloud_session_id: &str,
        agent_type: amux::AgentType,
        workspace_hint: Option<&str>,
    ) -> Option<String> {
        if let Some(ws) = workspace_hint.filter(|s| !s.is_empty()) {
            return Some(ws.to_string());
        }
        let matches: Vec<_> = self
            .sessions
            .all_for_session(cloud_session_id)
            .into_iter()
            .filter(|b| b.agent_type == agent_type as i32)
            .collect();
        match matches.len() {
            0 => None,
            1 => Some(matches[0].workspace_id.clone()),
            _ => {
                warn!(
                    session_id = %cloud_session_id,
                    count = matches.len(),
                    "cold attach: ambiguous bindings for session; skipping auto-resume"
                );
                None
            }
        }
    }

    /// Attach a live runtime for `(session, workspace, agent_type)` using stored binding.
    ///
    /// `client_permission_mode` is the caller's wire mode (`""` when the
    /// caller has none); it is resolved exactly as a fresh spawn resolves it.
    pub(super) async fn attach_collab_from_binding(
        &mut self,
        cloud_session_id: &str,
        agent_type: amux::AgentType,
        workspace_id: &str,
        initial_prompt: &str,
        initial_model_override: Option<&str>,
        forbid_new_session_fallback: bool,
        bind_member_actor_id: Option<&str>,
        client_permission_mode: &str,
        log_label: &'static str,
    ) -> Result<Option<String>, StartRuntimeError> {
        if cloud_session_id.is_empty() || workspace_id.is_empty() {
            return Ok(None);
        }

        if self
            .agents
            .lock()
            .await
            .get_handle(cloud_session_id)
            .is_some()
        {
            return Ok(Some(cloud_session_id.to_string()));
        }

        let Some(acp_resume) =
            resolve_backend_session_id(&self.sessions, cloud_session_id, agent_type, workspace_id)
        else {
            return Ok(None);
        };

        let worktree = match self.workspace_resolver.resolve(workspace_id).await {
            Ok(ws) if !ws.path.trim().is_empty() => ws.path,
            _ => {
                warn!(
                    session_id = %cloud_session_id,
                    workspace_id = %workspace_id,
                    log_label,
                    "attach_collab_from_binding: workspace resolve failed"
                );
                return Ok(None);
            }
        };

        let mut context = match self
            .assemble_stored_execution_context(&worktree, workspace_id)
            .await
        {
            Ok(context) => context,
            Err(e) => {
                warn!(
                    session_id = %cloud_session_id,
                    workspace_id = %workspace_id,
                    error = %e,
                    log_label,
                    "attach_collab_from_binding: assemble execution context failed"
                );
                return Ok(None);
            }
        };

        // The stored env only knows the `gateway:` workspace prefix. A binding
        // a desktop RuntimeStart wrote carries the real workspace id, so a
        // chat-bound session that had been idle-evicted used to resume as Ask
        // — whatever the client asked for — and the next chat turn, which
        // reuses the live attachment, waited on an approval nobody in the chat
        // could give.
        let is_gateway = context.spawn_env.is_gateway
            || self.session_has_gateway_binding(cloud_session_id).await;
        let permission = crate::runtime::PermissionPolicy::resolve_for_session(
            is_gateway,
            client_permission_mode,
        );
        context.spawn_env.permission = Some(permission);

        info!(
            session_id = %cloud_session_id,
            workspace_id = %workspace_id,
            backend_session_id = %acp_resume,
            permission = %permission,
            log_label,
            "attach_collab_from_binding: resuming stored backend session"
        );

        let resume_res = {
            let mut agents = self.agents.lock().await;
            // Asked again under the lock the resume holds, because the check
            // at the top was not: resolving the workspace and env in between
            // is long enough for a chat turn to attach this session itself,
            // and `resume_agent` would replace that runtime under the turn
            // using it (`no agent for acp_session_id`). A chat's own inbound
            // write echoing back over `session/live` is exactly that race.
            if agents.get_handle(cloud_session_id).is_some() {
                return Ok(Some(cloud_session_id.to_string()));
            }
            agents
                .resume_agent(
                    cloud_session_id,
                    &acp_resume,
                    agent_type,
                    workspace_id,
                    Some(workspace_id),
                    initial_prompt,
                    None,
                    forbid_new_session_fallback,
                    context,
                )
                .await
        };

        let new_acp_sid = match resume_res {
            Ok(sid) => sid,
            Err(e) if forbid_new_session_fallback => {
                return Err(StartRuntimeError {
                    error_code: BACKEND_SESSION_NOT_RESUMABLE.to_string(),
                    error_message: format!("backend session {acp_resume} not resumable: {e}"),
                    failed_stage: "binding_resume".to_string(),
                });
            }
            Err(e) => {
                warn!(
                    session_id = %cloud_session_id,
                    log_label,
                    "attach_collab_from_binding: resume failed: {e}"
                );
                return Ok(None);
            }
        };

        self.finalize_binding_resume(
            cloud_session_id,
            workspace_id,
            agent_type,
            &new_acp_sid,
            initial_model_override,
        )
        .await;

        if let Some(member) = bind_member_actor_id.filter(|s| !s.is_empty()) {
            let team_id = self.config.team_id.clone().unwrap_or_default();
            self.ensure_live_runtime_remote_tools(
                cloud_session_id,
                cloud_session_id,
                member,
                &team_id,
            )
            .await;
        }

        Ok(Some(cloud_session_id.to_string()))
    }

    /// `runtimeStart` cold path after warm dedup miss.
    pub(super) async fn try_resume_runtime_for_start(
        &mut self,
        cloud_session_id: &str,
        agent_type: amux::AgentType,
        workspace_id: &str,
        initial_prompt: &str,
        initial_model_override: Option<&str>,
        requester_actor_id: &str,
        client_permission_mode: &str,
    ) -> Result<Option<StartRuntimeOutcome>, StartRuntimeError> {
        if cloud_session_id.is_empty() || workspace_id.is_empty() {
            return Ok(None);
        }

        let runtime_id = self
            .attach_collab_from_binding(
                cloud_session_id,
                agent_type,
                workspace_id,
                initial_prompt,
                initial_model_override,
                true,
                (!requester_actor_id.is_empty()).then_some(requester_actor_id),
                client_permission_mode,
                "runtime_start",
            )
            .await?;

        Ok(runtime_id.map(|id| StartRuntimeOutcome {
            runtime_id: id,
            session_id: cloud_session_id.to_string(),
        }))
    }

    /// MQTT `session/live`: no in-memory runtime — resume from binding if possible.
    pub(super) async fn resume_historical_runtimes_for_session(
        &mut self,
        session_id: &str,
        requester_actor_id: Option<&str>,
    ) -> bool {
        let bindings: Vec<SessionBinding> = self
            .sessions
            .all_for_session(session_id)
            .into_iter()
            .cloned()
            .collect();
        if bindings.is_empty() {
            return false;
        }

        let workspace_hint = self.resolve_collab_workspace_id(session_id).await;
        let binding_count = bindings.len();

        for binding in bindings {
            let agent_type = match amux::AgentType::try_from(binding.agent_type) {
                Ok(at) => at,
                Err(_) => {
                    let agents = self.agents.lock().await;
                    agents.default_agent_type()
                }
            };

            let workspace_id = if let Some(hint) = workspace_hint.clone().filter(|w| !w.is_empty())
            {
                if hint != binding.workspace_id && binding_count > 1 {
                    continue;
                }
                hint
            } else {
                binding.workspace_id.clone()
            };

            match self
                .attach_collab_from_binding(
                    session_id,
                    agent_type,
                    &workspace_id,
                    "",
                    None,
                    false,
                    requester_actor_id,
                    "",
                    "session_live",
                )
                .await
            {
                Ok(Some(_)) => return true,
                Ok(None) => continue,
                Err(e) => {
                    warn!(
                        session_id = %session_id,
                        workspace_id = %workspace_id,
                        agent_type = ?agent_type,
                        error = %e.error_message,
                        "resume_historical_runtimes_for_session: binding resume failed"
                    );
                }
            }
        }
        false
    }

    pub(super) async fn finalize_binding_resume(
        &mut self,
        cloud_session_id: &str,
        workspace_id: &str,
        agent_type: amux::AgentType,
        acp_session_id: &str,
        initial_model_override: Option<&str>,
    ) {
        match self
            .backend
            .fetch_session_cursor(cloud_session_id, self.backend.actor_id())
            .await
        {
            Ok(cursor) => {
                self.agents
                    .lock()
                    .await
                    .set_session_cursor(cloud_session_id, cursor);
            }
            Err(e) => {
                warn!(
                    session_id = %cloud_session_id,
                    "fetch_session_cursor failed after resume: {e}"
                );
            }
        }

        self.sessions.upsert(SessionBinding::new(
            cloud_session_id,
            workspace_id,
            agent_type as i32,
            acp_session_id,
        ));
        let _ = self.sessions.save(&self.sessions_path);

        if let Some(model_id) = initial_model_override.filter(|m| !m.is_empty()) {
            let mut agents = self.agents.lock().await;
            if let Err(e) = agents.send_set_model(cloud_session_id, model_id).await {
                warn!(
                    session_id = %cloud_session_id,
                    model_id,
                    "set_model after binding resume failed: {e}"
                );
            } else {
                agents.set_current_model(cloud_session_id, model_id);
            }
        }

        self.publish_runtime_state_by_id(cloud_session_id).await;
        self.catchup_runtime(cloud_session_id).await;
    }

    /// A chat turn found no live runtime for its session.
    ///
    /// `Resume` is the resume a desktop message gets, keyed by the workspace
    /// the chat runs in, so an idle-evicted chat picks its conversation back up
    /// instead of starting over. `Record` stores what a chat spawned when there
    /// was nothing to resume, which is what makes the next cold start resumable.
    pub(crate) async fn serve_cold_attach(&mut self, request: ColdAttach) {
        let agent_type = self.agents.lock().await.default_agent_type();
        match request {
            ColdAttach::Resume {
                cloud_session_id,
                workspace_id,
                reply,
            } => {
                let attached = self
                    .attach_collab_from_binding(
                        &cloud_session_id,
                        agent_type,
                        &workspace_id,
                        "",
                        None,
                        false,
                        None,
                        "",
                        "gateway_cold_attach",
                    )
                    .await;
                let acp = match attached {
                    Ok(Some(_)) => self
                        .agents
                        .lock()
                        .await
                        .get_handle(&cloud_session_id)
                        .map(|h| h.acp_session_id.clone())
                        .filter(|sid| !sid.is_empty()),
                    Ok(None) => None,
                    Err(e) => {
                        warn!(
                            session_id = %cloud_session_id,
                            workspace_id = %workspace_id,
                            error = %e.error_message,
                            "gateway cold attach: resume failed; the chat starts a fresh session"
                        );
                        None
                    }
                };
                let _ = reply.send(acp);
            }
            ColdAttach::Record {
                cloud_session_id,
                workspace_id,
                acp_session_id,
            } => {
                self.upsert_session_binding(
                    &cloud_session_id,
                    &workspace_id,
                    agent_type,
                    &acp_session_id,
                );
            }
        }
    }

    pub(super) fn upsert_session_binding(
        &mut self,
        cloud_session_id: &str,
        workspace_id: &str,
        agent_type: amux::AgentType,
        acp_session_id: &str,
    ) {
        self.sessions.upsert(SessionBinding::new(
            cloud_session_id,
            workspace_id,
            agent_type as i32,
            acp_session_id,
        ));
        let _ = self.sessions.save(&self.sessions_path);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::backend::mock::MockBackend;
    use crate::backend::{Backend, WorkspaceRow};
    use crate::channels::ColdAttach;
    use crate::config::SessionBinding;
    use crate::daemon::server::tests::test_server_with_cloud_api;
    use crate::proto::amux;
    use crate::runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
    use crate::runtime::PermissionPolicy;

    #[tokio::test]
    async fn collab_runtime_ensure_resume_propagates_workspace_attach_context() {
        let workspace = tempfile::tempdir().unwrap();
        let mock = MockBackend::with_identity("team-test", "agent-actor");
        mock.state().workspaces_by_id.insert(
            "ws-a".into(),
            WorkspaceRow {
                id: "ws-a".into(),
                team_id: "team-test".into(),
                path: Some(workspace.path().to_string_lossy().into_owned()),
                archived: false,
                agent_id: None,
            },
        );
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let mut fixture = test_server_with_cloud_api(backend);
        let captures = {
            let mut manager = fixture.server.agents.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };
        fixture.server.sessions.upsert(SessionBinding::new(
            "session-a",
            "ws-a",
            amux::AgentType::Opencode as i32,
            "acp-a",
        ));

        assert!(
            fixture
                .server
                .resume_historical_runtimes_for_session("session-a", None)
                .await
        );

        let captures = captures.lock().unwrap();
        assert_eq!(captures.len(), 1);
        assert_eq!(
            captures[0].domain,
            IsolationDomainKey::Workspace("ws-a".into())
        );
        assert_eq!(captures[0].working_directory, workspace.path());
        assert_eq!(
            captures[0].process_env_revision,
            ProcessEnvRevision::from_bindings(&captures[0].extra_env)
        );
    }

    #[tokio::test]
    async fn stored_workspace_scoped_gateway_resume_lookup_failure_does_not_attach_bare_env() {
        let workspace = tempfile::tempdir().unwrap();
        let backend: Arc<dyn Backend> =
            Arc::new(MockBackend::with_identity("team-test", "agent-actor"));
        let mut fixture = test_server_with_cloud_api(backend);
        let captures = {
            let mut manager = fixture.server.agents.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };
        fixture.server.sessions.upsert(SessionBinding::new(
            "session-gateway",
            "gateway:wecom://bot/chat",
            amux::AgentType::Opencode as i32,
            "acp-gw",
        ));

        assert!(
            !fixture
                .server
                .resume_historical_runtimes_for_session("session-gateway", None)
                .await,
            "workspace-scoped stored gateway must fail closed when identity lookup fails"
        );
        assert!(
            captures.lock().unwrap().is_empty(),
            "failed workspace lookup must not attach with UnscopedAgent and bare env"
        );
    }

    /// A session whose binding a desktop RuntimeStart wrote (real workspace
    /// id, not `gateway:`), optionally bound to a chat. Returns the fixture
    /// with a capturing backend installed plus the workspace dir guard.
    async fn stored_binding_fixture(
        chat_binding: Option<&str>,
    ) -> (
        crate::daemon::server::tests::TestServer,
        Arc<std::sync::Mutex<Vec<crate::runtime::test_support::CapturedAttach>>>,
        tempfile::TempDir,
    ) {
        let workspace = tempfile::tempdir().unwrap();
        let mock = Arc::new(MockBackend::with_identity("team-test", "actor-config-test"));
        mock.state().workspaces_by_id.insert(
            "ws-a".into(),
            WorkspaceRow {
                id: "ws-a".into(),
                team_id: "team-test".into(),
                path: Some(workspace.path().to_string_lossy().into_owned()),
                archived: false,
                agent_id: None,
            },
        );
        mock.state().sessions.insert(
            "chat-session".into(),
            crate::backend::BackendSessionAndParticipants {
                session: crate::backend::BackendSessionRow {
                    id: "chat-session".into(),
                    team_id: "team-test".into(),
                    created_by_actor_id: Some("human-actor".into()),
                    primary_agent_id: Some("actor-config-test".into()),
                    mode: "chat".into(),
                    title: "WeCom DM".into(),
                    summary: String::new(),
                    idea_id: None,
                    parent_session_id: None,
                    thread_root_message_id: None,
                    created_at: chrono::Utc::now(),
                },
                participants: Vec::new(),
            },
        );
        if let Some(binding) = chat_binding {
            mock.state()
                .session_bindings
                .insert("chat-session".into(), binding.into());
        }
        let backend: Arc<dyn Backend> = mock;
        let mut fixture = test_server_with_cloud_api(backend);
        let captures = {
            let mut manager = fixture.server.agents.lock().await;
            crate::runtime::test_support::install_capturing_backend(&mut manager)
        };
        fixture.server.sessions.upsert(SessionBinding::new(
            "chat-session",
            "ws-a",
            amux::AgentType::Pi as i32,
            "acp-old",
        ));
        (fixture, captures, workspace)
    }

    async fn cold_runtime_start(
        fixture: &mut crate::daemon::server::tests::TestServer,
        workspace: &tempfile::TempDir,
        permission_mode: &str,
    ) {
        fixture
            .server
            .apply_start_runtime(
                amux::AgentType::Pi,
                "ws-a",
                workspace.path().to_string_lossy().as_ref(),
                "chat-session",
                "",
                None,
                "",
                false,
                None,
                permission_mode,
            )
            .await
            .unwrap_or_else(|e| panic!("start failed: {}", e.error_message));
    }

    fn only_permission(
        captures: &std::sync::Mutex<Vec<crate::runtime::test_support::CapturedAttach>>,
    ) -> PermissionPolicy {
        let captures = captures.lock().unwrap();
        assert_eq!(captures.len(), 1, "expected exactly one attach");
        captures[0].permission
    }

    #[tokio::test]
    async fn cold_resume_honors_client_full_access() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let (mut fixture, captures, workspace) = stored_binding_fixture(None).await;
        cold_runtime_start(&mut fixture, &workspace, "full_access").await;
        assert_eq!(only_permission(&captures), PermissionPolicy::Full);
    }

    #[tokio::test]
    async fn cold_resume_of_chat_bound_session_defaults_to_full_access() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let (mut fixture, captures, workspace) =
            stored_binding_fixture(Some("wecom://bot/chat")).await;
        cold_runtime_start(&mut fixture, &workspace, "").await;
        assert_eq!(only_permission(&captures), PermissionPolicy::Full);
    }

    #[tokio::test]
    async fn session_live_resume_of_chat_bound_session_is_full_access() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let (mut fixture, captures, _workspace) =
            stored_binding_fixture(Some("wecom://bot/chat")).await;
        assert!(
            fixture
                .server
                .resume_historical_runtimes_for_session("chat-session", None)
                .await
        );
        assert_eq!(only_permission(&captures), PermissionPolicy::Full);
    }

    #[tokio::test]
    async fn cold_resume_keeps_an_explicit_ask_on_a_chat_bound_session() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let (mut fixture, captures, workspace) =
            stored_binding_fixture(Some("wecom://bot/chat")).await;
        cold_runtime_start(&mut fixture, &workspace, "default").await;
        assert_eq!(only_permission(&captures), PermissionPolicy::Ask);
    }

    async fn cold_attach_resume(
        fixture: &mut crate::daemon::server::tests::TestServer,
        workspace_id: &str,
    ) -> Option<String> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        fixture
            .server
            .serve_cold_attach(ColdAttach::Resume {
                cloud_session_id: "chat-session".into(),
                workspace_id: workspace_id.into(),
                reply,
            })
            .await;
        answer.await.unwrap()
    }

    #[tokio::test]
    async fn a_cold_chat_resumes_the_session_it_had() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let (mut fixture, captures, _workspace) =
            stored_binding_fixture(Some("wecom://bot/chat")).await;

        let acp = cold_attach_resume(&mut fixture, "ws-a").await;

        assert_eq!(acp.as_deref(), Some("captured-1"));
        let captures = captures.lock().unwrap();
        assert_eq!(captures.len(), 1);
        assert_eq!(
            captures[0].resume_acp_session_id.as_deref(),
            Some("acp-old")
        );
        assert_eq!(captures[0].permission, PermissionPolicy::Full);
    }

    #[tokio::test]
    async fn a_live_runtime_answers_a_cold_chat_without_a_second_attach() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let (mut fixture, captures, _workspace) =
            stored_binding_fixture(Some("wecom://bot/chat")).await;

        let first = cold_attach_resume(&mut fixture, "ws-a").await;
        let second = cold_attach_resume(&mut fixture, "ws-a").await;

        assert_eq!(first, second);
        assert_eq!(captures.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn what_a_chat_spawned_is_what_its_next_cold_start_resumes() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let (mut fixture, captures, _workspace) =
            stored_binding_fixture(Some("wecom://bot/chat")).await;

        fixture
            .server
            .serve_cold_attach(ColdAttach::Record {
                cloud_session_id: "chat-session".into(),
                workspace_id: "ws-a".into(),
                acp_session_id: "acp-new".into(),
            })
            .await;
        cold_attach_resume(&mut fixture, "ws-a").await;

        let captures = captures.lock().unwrap();
        assert_eq!(
            captures[0].resume_acp_session_id.as_deref(),
            Some("acp-new")
        );
    }

    #[tokio::test]
    async fn a_cold_chat_with_nothing_stored_is_told_to_start_fresh() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let (mut fixture, captures, _workspace) =
            stored_binding_fixture(Some("wecom://bot/chat")).await;

        // Stored under ws-a; the chat runs somewhere else.
        assert_eq!(cold_attach_resume(&mut fixture, "ws-other").await, None);
        assert!(captures.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn session_live_resume_of_desktop_session_still_asks() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(home.path());
        let (mut fixture, captures, _workspace) = stored_binding_fixture(None).await;
        assert!(
            fixture
                .server
                .resume_historical_runtimes_for_session("chat-session", None)
                .await
        );
        assert_eq!(only_permission(&captures), PermissionPolicy::Ask);
    }
}
