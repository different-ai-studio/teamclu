use std::path::Path;

use teamclu_runtime_env::ManagedLlmState;

use crate::runtime::execution_context::{ExecutionContext, IsolationDomainKey, WorkspaceIdentity};
use crate::runtime::{PermissionPolicy, SpawnRuntimeEnv};

use super::DaemonServer;

#[derive(Clone)]
pub(crate) struct ExecutionContextAssembler {
    workspace_resolver: std::sync::Arc<crate::config::WorkspaceResolver>,
    backend: std::sync::Arc<dyn crate::backend::Backend>,
    managed_llm: std::sync::Arc<crate::runtime::managed_llm::ManagedLlmResolver>,
    refresh_coordinator: Option<std::sync::Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
    team_id: Option<String>,
    actor_id: String,
    actor_name: String,
}

impl DaemonServer {
    pub(super) fn execution_context_assembler(&self) -> ExecutionContextAssembler {
        ExecutionContextAssembler {
            workspace_resolver: self.workspace_resolver.clone(),
            backend: self.backend.clone(),
            managed_llm: self.managed_llm.clone(),
            refresh_coordinator: self.refresh_coordinator.clone(),
            team_id: self.config.team_id.clone(),
            actor_id: self.config.actor.id.clone(),
            actor_name: self.config.actor.name.clone(),
        }
    }

    pub(super) async fn assemble_execution_context(
        &self,
        working_directory: &str,
        workspace_root_hint: Option<&str>,
        workspace_id_hint: Option<&str>,
        is_gateway: bool,
        permission: Option<PermissionPolicy>,
    ) -> Result<ExecutionContext, String> {
        self.execution_context_assembler()
            .assemble(
                working_directory,
                workspace_root_hint,
                workspace_id_hint,
                is_gateway,
                permission,
            )
            .await
    }

    pub(super) async fn assemble_stored_execution_context(
        &self,
        working_directory: &str,
        workspace_id: &str,
    ) -> Result<ExecutionContext, String> {
        self.execution_context_assembler()
            .assemble_stored(working_directory, workspace_id)
            .await
    }

    /// Team ID is resolved from the cloud workspace row by UUID; on a cold resolver cache (e.g. right after daemon restart) a bare-agent spawn with an empty workspace_id yields None team_id until the cache warms — intentional under the cloud-source-of-truth / no-local-store design.
    pub(super) async fn resolve_workspace_team_id(&self, workspace_id: &str) -> Option<String> {
        let fallback = || {
            self.config
                .team_id
                .as_ref()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
        };

        if workspace_id.is_empty() {
            // Bare-agent spawns have no workspace id; skip the guaranteed-miss
            // cloud lookup and go straight to the configured team fallback.
            return fallback();
        }

        self.workspace_resolver
            .resolve(workspace_id)
            .await
            .ok()
            .and_then(|w| w.team_id)
            .filter(|team_id| !team_id.trim().is_empty())
            .or_else(fallback)
    }
}

#[cfg(test)]
mod execution_context_tests {
    use super::*;
    use crate::backend::{mock::MockBackend, WorkspaceRow};
    use crate::backend::{ManagedLlmConfig, ManagedLlmModelInfo};
    use crate::opencode_settings::WorkspaceSettingsContextResolver;
    use crate::runtime::execution_context::ProcessEnvRevision;
    use std::sync::Arc;

    fn assembler(
        backend: Arc<MockBackend>,
        team_id: &str,
        actor_id: &str,
    ) -> ExecutionContextAssembler {
        ExecutionContextAssembler {
            workspace_resolver: Arc::new(crate::config::WorkspaceResolver::new(backend.clone())),
            backend: backend.clone(),
            managed_llm: Arc::new(crate::runtime::managed_llm::ManagedLlmResolver::new(
                backend,
            )),
            refresh_coordinator: None,
            team_id: Some(team_id.into()),
            actor_id: actor_id.into(),
            actor_name: "Agent A".into(),
        }
    }

    #[tokio::test]
    async fn resolve_device_settings_context_needs_no_registered_workspace() {
        // No workspace was ever registered on this backend — a call through
        // `assemble`/`resolve_identity_for_path` would fail closed here. The
        // device-settings path must not go through workspace identity
        // resolution at all.
        let backend = Arc::new(MockBackend::default());
        let assembler = assembler(backend, "team-a", "actor-a");

        let context = assembler.resolve_device_settings_context().await.unwrap();

        assert!(matches!(
            context.isolation_domain,
            IsolationDomainKey::UnscopedAgent { .. }
        ));
        assert!(context.workspace.is_none());
    }

    #[tokio::test]
    async fn configured_team_fallback_keeps_workspace_context_revisions_equal() {
        // The two `assemble` calls below are compared field by field, and one of
        // those fields — `OPENCODE_CONFIG` — is derived from the amuxd home.
        // Every test that *moves* `HOME` / `AMUXD_HOME` already serializes on
        // `TEST_HOME_LOCK`, but a reader that does not join them can still have
        // one moved out from under it between its two reads, and then the two
        // maps differ by a path rooted in two different tempdirs. That is what
        // made this fail in CI while passing alone. The guard both joins that
        // lock and pins a home of its own, so the comparison no longer depends
        // on whatever the ambient environment happens to be.
        let amuxd_home = tempfile::tempdir().unwrap();
        let _env = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(amuxd_home.path());

        let workspace = tempfile::tempdir().unwrap();
        let backend = Arc::new(MockBackend::default());
        backend.state().workspaces_by_id.insert(
            "ws-a".into(),
            WorkspaceRow {
                id: "ws-a".into(),
                team_id: String::new(),
                path: Some(workspace.path().to_string_lossy().into_owned()),
                archived: false,
                agent_id: None,
            },
        );
        backend.state().managed_llm_configs.insert(
            "team-a".into(),
            ManagedLlmConfig {
                enabled: true,
                base_url: Some("https://gateway.example/v1".into()),
                name: Some("Team A".into()),
                models: vec![ManagedLlmModelInfo {
                    id: "team-model".into(),
                    name: "Team Model".into(),
                }],
            },
        );
        let assembler = assembler(backend, "team-a", "actor-a");

        let desktop = assembler
            .assemble(
                workspace.path().to_string_lossy().as_ref(),
                None,
                Some("ws-a"),
                false,
                None,
            )
            .await
            .unwrap();
        let gateway = assembler
            .assemble(
                workspace.path().to_string_lossy().as_ref(),
                None,
                None,
                true,
                Some(PermissionPolicy::Full),
            )
            .await
            .unwrap();

        assert_eq!(
            desktop.isolation_domain,
            IsolationDomainKey::Workspace("ws-a".into())
        );
        assert_eq!(desktop.isolation_domain, gateway.isolation_domain);
        assert_eq!(desktop.spawn_env.extra_env, gateway.spawn_env.extra_env);
        assert_eq!(desktop.spawn_env.env_team_id.as_deref(), Some("team-a"));
        assert!(
            desktop
                .spawn_env
                .extra_env
                .contains_key("TEAMCLU_TEAM_PROVIDER"),
            "configured-team managed LLM credentials must be assembled"
        );
        assert_eq!(
            ProcessEnvRevision::from_bindings(&desktop.spawn_env.extra_env),
            ProcessEnvRevision::from_bindings(&gateway.spawn_env.extra_env)
        );
    }

    #[tokio::test]
    async fn unscoped_gateway_resume_recreates_daemon_scratch_directory() {
        let backend = Arc::new(MockBackend::default());
        let assembler = assembler(backend, "team-a", "actor-a");
        let scratch = std::env::temp_dir().join(format!(
            "amuxd-gateway-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));

        let context = assembler
            .assemble_stored(
                scratch.to_string_lossy().as_ref(),
                "gateway:wecom://bot/chat",
            )
            .await
            .unwrap();

        assert!(scratch.is_dir());
        assert_eq!(
            context.isolation_domain,
            IsolationDomainKey::UnscopedAgent {
                team_id: "team-a".into(),
                actor_id: "actor-a".into(),
            }
        );
        assert_eq!(context.working_directory, scratch);
        assert!(context.spawn_env.extra_env.is_empty());
        std::fs::remove_dir_all(&context.working_directory).unwrap();
    }

    #[tokio::test]
    async fn stored_gateway_resume_keeps_real_workspace_with_scratch_shaped_path_scoped() {
        let scratch_shaped_workspace = std::env::temp_dir().join(format!(
            "amuxd-gateway-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        std::fs::create_dir_all(&scratch_shaped_workspace).unwrap();
        let backend = Arc::new(MockBackend::default());
        backend.state().workspaces_by_id.insert(
            "ws-real".into(),
            WorkspaceRow {
                id: "ws-real".into(),
                team_id: "team-a".into(),
                path: Some(scratch_shaped_workspace.to_string_lossy().into_owned()),
                archived: false,
                agent_id: None,
            },
        );
        let assembler = assembler(backend, "team-a", "actor-a");

        let context = assembler
            .assemble_stored(
                scratch_shaped_workspace.to_string_lossy().as_ref(),
                "gateway:wecom://bot/chat",
            )
            .await
            .unwrap();

        assert_eq!(
            context.isolation_domain,
            IsolationDomainKey::Workspace("ws-real".into())
        );
        assert_eq!(
            context
                .workspace
                .as_ref()
                .map(|workspace| workspace.workspace_id.as_str()),
            Some("ws-real")
        );
        assert!(
            !context.spawn_env.extra_env.is_empty(),
            "real workspace resumes must assemble workspace environment"
        );
        std::fs::remove_dir_all(&scratch_shaped_workspace).unwrap();
    }

    #[tokio::test]
    async fn stored_gateway_resume_does_not_unscope_missing_registered_scratch_shaped_workspace() {
        let scratch_shaped_workspace = std::env::temp_dir().join(format!(
            "amuxd-gateway-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        assert!(!scratch_shaped_workspace.exists());
        let backend = Arc::new(MockBackend::default());
        backend.state().workspaces_by_id.insert(
            "ws-real".into(),
            WorkspaceRow {
                id: "ws-real".into(),
                team_id: "team-a".into(),
                path: Some(scratch_shaped_workspace.to_string_lossy().into_owned()),
                archived: false,
                agent_id: None,
            },
        );
        let assembler = assembler(backend, "team-a", "actor-a");

        let result = assembler
            .assemble_stored(
                scratch_shaped_workspace.to_string_lossy().as_ref(),
                "gateway:wecom://bot/chat",
            )
            .await;

        assert!(
            !matches!(
                result.as_ref().map(|context| &context.isolation_domain),
                Ok(IsolationDomainKey::UnscopedAgent { .. })
            ),
            "a missing registered workspace must fail closed or remain workspace-scoped"
        );
        if scratch_shaped_workspace.exists() {
            std::fs::remove_dir_all(&scratch_shaped_workspace).unwrap();
        }
    }

    #[tokio::test]
    async fn stored_gateway_resume_backend_error_does_not_attach_unscoped() {
        let scratch = std::env::temp_dir().join(format!(
            "amuxd-gateway-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        std::fs::create_dir_all(&scratch).unwrap();
        let backend = Arc::new(MockBackend::default());
        backend.state().get_workspaces_by_team_error = Some("workspace backend unavailable".into());
        let assembler = assembler(backend, "team-a", "actor-a");

        let result = assembler
            .assemble_stored(
                scratch.to_string_lossy().as_ref(),
                "gateway:wecom://bot/chat",
            )
            .await;

        assert!(
            result.is_err(),
            "backend lookup errors must fail closed, got isolation domain {:?}",
            result
                .as_ref()
                .ok()
                .map(|context| &context.isolation_domain)
        );
        std::fs::remove_dir_all(&scratch).unwrap();
    }
}

impl ExecutionContextAssembler {
    fn configured_team_id(&self) -> Option<&str> {
        self.team_id
            .as_deref()
            .map(str::trim)
            .filter(|team_id| !team_id.is_empty())
    }

    pub(crate) async fn assemble_unscoped_gateway(
        &self,
        working_directory: Option<&Path>,
    ) -> Result<ExecutionContext, String> {
        let working_directory = working_directory
            .filter(|path| !path.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_default();
        if !working_directory.as_os_str().is_empty() {
            std::fs::create_dir_all(&working_directory).map_err(|e| {
                format!(
                    "create unscoped gateway working directory {} failed: {e}",
                    working_directory.display()
                )
            })?;
        }

        Ok(ExecutionContext {
            isolation_domain: IsolationDomainKey::UnscopedAgent {
                team_id: self.configured_team_id().unwrap_or_default().to_string(),
                actor_id: self.actor_id.clone(),
            },
            workspace: None,
            working_directory,
            spawn_env: SpawnRuntimeEnv {
                is_gateway: true,
                ..SpawnRuntimeEnv::default()
            },
        })
    }

    async fn assemble_stored(
        &self,
        working_directory: &str,
        workspace_id: &str,
    ) -> Result<ExecutionContext, String> {
        if !crate::runtime::is_gateway_workspace_id(workspace_id) {
            return self
                .assemble(working_directory, None, Some(workspace_id), false, None)
                .await;
        }

        let working_directory = Path::new(working_directory);
        if self
            .workspace_resolver
            .resolve_identity_for_path(working_directory, self.configured_team_id())
            .await
            .map_err(|e| format!("workspace identity resolution failed: {e}"))?
            .is_some()
        {
            return self
                .assemble(
                    working_directory.to_string_lossy().as_ref(),
                    None,
                    None,
                    true,
                    None,
                )
                .await;
        }

        if is_daemon_gateway_scratch_directory(working_directory) {
            return self
                .assemble_unscoped_gateway(Some(working_directory))
                .await;
        }

        self.assemble(
            working_directory.to_string_lossy().as_ref(),
            None,
            None,
            true,
            None,
        )
        .await
    }

    pub(crate) async fn assemble(
        &self,
        working_directory: &str,
        workspace_root_hint: Option<&str>,
        workspace_id_hint: Option<&str>,
        is_gateway: bool,
        permission: Option<PermissionPolicy>,
    ) -> Result<ExecutionContext, String> {
        let team_id = self.team_id.as_deref();
        let workspace = if let Some(workspace_id) =
            workspace_id_hint.filter(|id| !id.trim().is_empty())
        {
            let resolved = self
                .workspace_resolver
                .resolve(workspace_id)
                .await
                .map_err(|e| format!("workspace identity resolution failed: {e}"))?;
            let identity = self
                .workspace_resolver
                .resolve_identity_for_path(Path::new(&resolved.path), resolved.team_id.as_deref())
                .await
                .map_err(|e| format!("workspace identity resolution failed: {e}"))?
                .ok_or_else(|| {
                    format!(
                        "workspace identity resolution failed: ambiguous or invalid workspace {workspace_id}"
                    )
                })?;
            if identity.workspace_id != workspace_id {
                return Err(format!(
                    "workspace identity mismatch: expected {workspace_id}, resolved {}",
                    identity.workspace_id
                ));
            }
            identity
        } else if let Some(root) = workspace_root_hint.filter(|root| !root.trim().is_empty()) {
            self.workspace_resolver
                .resolve_identity_for_path(Path::new(root), team_id)
                .await
                .map_err(|e| format!("workspace identity resolution failed: {e}"))?
                .ok_or_else(|| {
                    format!(
                        "workspace identity resolution failed for parent root {}",
                        Path::new(root).display()
                    )
                })?
        } else if !working_directory.trim().is_empty() {
            self.workspace_resolver
                .resolve_identity_for_path(Path::new(working_directory), team_id)
                .await
                .map_err(|e| format!("workspace identity resolution failed: {e}"))?
                .ok_or_else(|| {
                    format!(
                        "workspace identity resolution failed for working directory {}",
                        Path::new(working_directory).display()
                    )
                })?
        } else {
            self.workspace_resolver
                .resolve_default_workspace(team_id, &self.actor_id)
                .await
                .ok_or_else(|| {
                    "no working directory: configure a default workspace in Daemon > Workspace settings"
                        .to_string()
                })?
        };

        let working_directory = if working_directory.trim().is_empty() {
            workspace.workspace_root.clone()
        } else {
            Path::new(working_directory).to_path_buf()
        };
        let execution_workspace = self
            .workspace_resolver
            .resolve_identity_for_path(&working_directory, workspace.team_id.as_deref())
            .await
            .map_err(|e| format!("workspace identity resolution failed: {e}"))?
            .ok_or_else(|| {
                format!(
                    "working directory {} does not belong to resolved workspace {}",
                    working_directory.display(),
                    workspace.workspace_id
                )
            })?;
        if execution_workspace.workspace_id != workspace.workspace_id {
            return Err(format!(
                "working directory {} resolves to workspace {}, not hinted workspace {}",
                working_directory.display(),
                execution_workspace.workspace_id,
                workspace.workspace_id
            ));
        }
        let mut spawn_env = self
            .assemble_workspace_execution_env(&workspace, &working_directory)
            .await?;
        spawn_env.is_gateway = is_gateway;
        spawn_env.permission = permission;

        Ok(ExecutionContext {
            isolation_domain: IsolationDomainKey::Workspace(workspace.workspace_id.clone()),
            workspace: Some(workspace),
            working_directory,
            spawn_env,
        })
    }

    async fn assemble_workspace_execution_env(
        &self,
        workspace: &WorkspaceIdentity,
        working_directory: &Path,
    ) -> Result<SpawnRuntimeEnv, String> {
        let team_id = workspace
            .team_id
            .as_deref()
            .map(str::trim)
            .filter(|team_id| !team_id.is_empty())
            .or_else(|| self.configured_team_id());
        let managed_llm = match team_id {
            Some(team_id) => self.managed_llm.resolve(team_id).await,
            None => ManagedLlmState::Unknown,
        };
        let cloud_token_file = self
            .backend
            .cloud_auth_health()
            .map(|_| crate::config::DaemonConfig::cloud_token_path())
            .map(|path| path.to_string_lossy().into_owned());

        if let Some(ref refresh) = self.refresh_coordinator {
            crate::runtime::refresh::refresh_watch::suppress_for_workspace_path(
                refresh,
                working_directory,
                &crate::runtime::refresh::INTERNAL_OPENCODE_KINDS,
                crate::runtime::refresh::INTERNAL_WRITE_SUPPRESS,
            );
        }
        crate::runtime::supervisor::materialize_inherent_mcp_for_spawn(working_directory)
            .map_err(|e| format!("materialize_inherent_mcp_for_spawn failed: {e}"))?;
        crate::runtime::env_assembly::assemble_spawn_runtime_env_for_execution(
            &workspace.workspace_root,
            working_directory,
            team_id,
            &self.actor_id,
            &self.actor_name,
            cloud_token_file.as_deref(),
            &managed_llm,
        )
        .map_err(|e| format!("assemble_runtime_env failed: {e}"))
    }
}

fn is_daemon_gateway_scratch_directory(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(suffix) = name.strip_prefix("amuxd-gateway-") else {
        return false;
    };
    if suffix.len() != 8 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return false;
    }

    path.parent().is_some_and(|parent| {
        parent == Path::new("/tmp") || parent == std::env::temp_dir().as_path()
    })
}

#[async_trait::async_trait]
impl crate::http::runtime_adapter::RuntimeExecutionContextAssembler for ExecutionContextAssembler {
    async fn assemble(
        &self,
        working_directory: &str,
        workspace_id: Option<&str>,
    ) -> Result<ExecutionContext, String> {
        ExecutionContextAssembler::assemble(
            self,
            working_directory,
            None,
            workspace_id,
            false,
            None,
        )
        .await
    }
}

#[async_trait::async_trait]
impl crate::opencode_settings::WorkspaceSettingsContextResolver for ExecutionContextAssembler {
    async fn resolve_settings_context(&self, workspace: &Path) -> Result<ExecutionContext, String> {
        self.assemble(
            workspace.to_string_lossy().as_ref(),
            None,
            None,
            false,
            None,
        )
        .await
    }

    async fn resolve_device_settings_context(&self) -> Result<ExecutionContext, String> {
        self.assemble_unscoped_gateway(Some(&device_settings_scratch_directory()))
            .await
    }
}

/// Stable scratch directory for the device-level `opencode serve` host used
/// by provider OAuth/config that isn't tied to a project workspace. Never
/// resolved through `WorkspaceResolver` — it just needs to exist so opencode
/// has somewhere to spawn.
fn device_settings_scratch_directory() -> std::path::PathBuf {
    crate::config::layout::cache_dir().join("device-settings")
}

impl DaemonServer {
    /// Resolve real spawn envs for the two most relevant linkable on-disk
    /// workspaces, for ACP host prewarming at daemon start. One entry per
    /// workspace: `(workspace_id, worktree_path, extra_env, force_env_override)`.
    ///
    /// Reusing `assemble_spawn_runtime_env_for_worktree` here is deliberate: it
    /// (a) syncs `provider.team` into the active team's `opencode.json` so the prewarmed host advertises the team
    /// model list, (b) warms the `managed_llm_cache` so the first real session
    /// skips the cloud round-trip, and (c) yields the exact `extra_env` the first
    /// `attach_session` will use, so the prewarmed host's `env_fingerprint`
    /// matches and gets reused.
    ///
    /// The daemon default is moved first because cron runs may target it even
    /// when it is not the cloud list's first row. The remaining slot follows
    /// cloud list order. Workspaces whose env fails to assemble are skipped
    /// with a warning.
    ///
    /// Returns an empty vec when the team has no linkable workspace yet (fresh
    /// install) — the caller then falls back to an empty-env prewarm.
    pub(super) async fn resolve_all_prewarm_envs(
        &self,
    ) -> Vec<(
        String,
        String,
        std::collections::HashMap<String, String>,
        bool,
    )> {
        let mut out = Vec::new();
        let (default_workspace_id, default_workspace_path) =
            self.resolve_default_workspace_for_publish().await;
        let mut workspaces = self.cloud_workspace_list().await;
        if let Some(index) = workspaces
            .iter()
            .position(|workspace| workspace.workspace_id == default_workspace_id)
        {
            let default = workspaces.remove(index);
            workspaces.insert(0, default);
        } else if !default_workspace_id.is_empty() && !default_workspace_path.is_empty() {
            workspaces.insert(
                0,
                crate::proto::amux::WorkspaceInfo {
                    workspace_id: default_workspace_id,
                    path: default_workspace_path,
                    display_name: String::new(),
                },
            );
        }
        for ws in workspaces.into_iter().take(2) {
            match self
                .assemble_spawn_runtime_env_for_worktree(&ws.path, &ws.workspace_id)
                .await
            {
                Ok(env) => out.push((
                    ws.workspace_id,
                    ws.path,
                    env.extra_env,
                    env.force_env_override,
                )),
                Err(e) => {
                    tracing::warn!(
                        workspace = %ws.path,
                        error = %e,
                        "prewarm: failed to assemble workspace env; skipping this workspace"
                    );
                }
            }
        }
        out
    }

    /// Fire-and-forget: warm an ACP host for `worktree`'s real spawn env so the
    /// first session on this workspace skips the cold `initialize`. The env
    /// assembly (disk + short-TTL-cached managed LLM) runs inline and is quick;
    /// only the host spawn + `initialize` is detached. Safe to call repeatedly —
    /// `ensure_host` no-ops when a host with the same fingerprint already exists.
    pub(crate) async fn kick_prewarm_for_workspace(&self, worktree: &str, workspace_id: &str) {
        let env = match self
            .assemble_spawn_runtime_env_for_worktree(worktree, workspace_id)
            .await
        {
            Ok(env) => env,
            Err(e) => {
                tracing::warn!(worktree, error = %e, "prewarm-on-workspace-add: env assembly failed");
                return;
            }
        };
        let agents = self.agents.clone();
        let workspace_id_for_prewarm = workspace_id.to_string();
        let worktree_for_prewarm = worktree.to_string();
        tokio::spawn(async move {
            let mut mgr = agents.lock().await;
            mgr.prewarm_agent_backend_for_workspace(
                &workspace_id_for_prewarm,
                env.extra_env,
                env.force_env_override,
                worktree_for_prewarm.as_str(),
            )
            .await;
        });
    }

    pub(super) async fn assemble_spawn_runtime_env_for_worktree(
        &self,
        worktree: &str,
        workspace_id: &str,
    ) -> Result<SpawnRuntimeEnv, String> {
        // Async lookups first — these must not race the refresh-watch suppress
        // window. Managed-LLM cloud fetch can exceed INTERNAL_WRITE_SUPPRESS
        // (3s); if we suppress *before* that await and only write afterward,
        // opencode.json rewrites leak as Pending "OpenCode config" banners.
        let team_id = self.resolve_workspace_team_id(workspace_id).await;
        let managed_llm = match team_id.as_deref() {
            Some(tid) => self.resolve_managed_llm(tid).await,
            None => ManagedLlmState::Unknown,
        };
        // Only advertise the cloud-token file when there is a real cloud backend
        // maintaining it (mock backends have no auth surface). The refresher task
        // in `run()` is gated the same way, so the file exists whenever the path
        // is injected.
        let cloud_token_file = self
            .backend
            .cloud_auth_health()
            .map(|_| crate::config::DaemonConfig::cloud_token_path())
            .map(|p| p.to_string_lossy().into_owned());

        // Suppress immediately before sync disk writes (inherent MCP, then
        // global provider.team sync + workspace secret resolve). Callers
        // must not rely on a suppress issued before the awaits above.
        self.suppress_internal_opencode_writes(worktree);
        crate::runtime::supervisor::materialize_inherent_mcp_for_spawn(Path::new(worktree))
            .map_err(|e| format!("materialize_inherent_mcp_for_spawn failed: {e}"))?;
        crate::runtime::env_assembly::assemble_spawn_runtime_env(
            Path::new(worktree),
            team_id.as_deref(),
            &self.config.actor.id,
            &self.config.actor.name,
            cloud_token_file.as_deref(),
            &managed_llm,
        )
        .map_err(|e| e.to_string())
    }

    /// Resolve the team's managed (shared) LLM via the shared TTL-cached
    /// resolver, which the HTTP provider snapshot uses too — so a provider read
    /// and a spawn share one throttled cloud fetch.
    async fn resolve_managed_llm(&self, team_id: &str) -> ManagedLlmState {
        self.managed_llm.resolve(team_id).await
    }

    /// Cloud workspace id + local path for this daemon agent's default workspace.
    /// Uses the same resolution as cron and `GET /v1/agent/default-workspace`.
    pub(super) async fn resolve_default_workspace_for_publish(&self) -> (String, String) {
        let actor_id = &self.actor_id;
        let team_id = self.config.team_id.as_deref();

        let mut workspace_id = String::new();
        let mut worktree = String::new();

        if let Ok(defaults) = self.backend.get_agent_defaults(actor_id).await {
            if let Some(id) = defaults
                .default_workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                workspace_id = id.to_string();
                if let Ok(ws) = self.workspace_resolver.resolve(id).await {
                    let path = ws.path.trim();
                    if !path.is_empty() {
                        worktree = path.to_string();
                    }
                }
            }
        }

        if worktree.is_empty() {
            if let Some(path) = crate::config::resolve_default_workspace_path(
                &self.backend,
                &self.workspace_resolver,
                team_id,
                actor_id,
            )
            .await
            {
                worktree = path;
                if workspace_id.is_empty() {
                    if let Some(id) = self.workspace_resolver.id_for_path(&worktree).await {
                        workspace_id = id;
                    }
                }
            }
        }

        (workspace_id, worktree)
    }
}
