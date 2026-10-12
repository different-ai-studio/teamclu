//! Shared runtime context service used by HTTP resolve and runtime lifecycle.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::RwLock;
use tracing::warn;

use super::context_registry::{
    backend_kind_for_agent_type, generation_env, GenerationTokenStore, HostCaller, HostProcess,
    HostProcessRegistry, ResolveError, ResolveRuntimeContextRequest, ResolveRuntimeContextResponse,
    RuntimeContextRegistry,
};
use crate::proto::amux;

#[derive(Clone)]
pub struct RuntimeContextService {
    inner: Arc<RwLock<RuntimeContextServiceInner>>,
}

struct RuntimeContextServiceInner {
    registry: RuntimeContextRegistry,
    tokens: GenerationTokenStore,
    hosts: HostProcessRegistry,
    base_url: Option<String>,
    /// The cloud-token socket (`TEAMCLU_RUNTIME_CONTEXT_SOCK`), once bound.
    socket_path: Option<String>,
}

impl Default for RuntimeContextService {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeContextService {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(RuntimeContextServiceInner {
                registry: RuntimeContextRegistry::default(),
                tokens: GenerationTokenStore::default(),
                hosts: HostProcessRegistry::default(),
                base_url: None,
                socket_path: None,
            })),
        }
    }

    pub fn set_base_url(&self, base_url: impl Into<String>) {
        let url = base_url.into();
        if url.trim().is_empty() {
            return;
        }
        self.inner.write().base_url = Some(url.trim_end_matches('/').to_string());
    }

    /// Where the cloud-token socket is bound. Every host spawned from now on
    /// gets it as `TEAMCLU_RUNTIME_CONTEXT_SOCK`.
    pub fn set_socket_path(&self, path: impl Into<String>) {
        let path = path.into();
        if path.trim().is_empty() {
            return;
        }
        self.inner.write().socket_path = Some(path);
    }

    /// The OS process behind a host generation, from the spawn path. Until a
    /// generation is registered nothing in its tree can draw a cloud token.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub fn register_host_process(
        &self,
        agent_type: amux::AgentType,
        host_generation_id: &str,
        process: HostProcess,
    ) {
        if host_generation_id.trim().is_empty() {
            return;
        }
        let backend_kind = backend_kind_for_agent_type(agent_type);
        self.inner
            .write()
            .hosts
            .register(backend_kind, host_generation_id, process);
    }

    /// The host generation whose process tree `chain` (a pid and its
    /// ancestors, nearest first) belongs to, checked against the live start
    /// time of the matched pid. See `runtime::proc_tree` for why ancestry
    /// rather than a token is what the cloud-token socket trusts.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub fn host_for_process_chain(
        &self,
        chain: &[u32],
        start_time_of: impl Fn(u32) -> Option<u64>,
    ) -> Result<HostCaller, ResolveError> {
        self.inner
            .read()
            .hosts
            .find_in_chain(chain, start_time_of)
            .ok_or(ResolveError::CallerNotAgentHost)
    }

    /// [`Self::host_for_process_chain`] for a connected peer: its ancestry
    /// and start times as the kernel reports them right now.
    #[cfg(unix)]
    pub fn host_for_peer_pid(&self, peer_pid: u32) -> Result<HostCaller, ResolveError> {
        use super::proc_tree::{ancestry, process_info};
        let chain = ancestry(peer_pid);
        self.host_for_process_chain(&chain, |pid| process_info(pid).map(|i| i.start_time))
    }

    pub fn register_attached_session(
        &self,
        agent_type: amux::AgentType,
        host_generation_id: &str,
        backend_session_id: &str,
        teamclu_session_id: &str,
        runtime_id: &str,
    ) {
        if host_generation_id.trim().is_empty()
            || backend_session_id.trim().is_empty()
            || teamclu_session_id.trim().is_empty()
        {
            return;
        }
        let backend_kind = backend_kind_for_agent_type(agent_type);
        self.inner.write().registry.register_parent(
            backend_kind,
            host_generation_id,
            backend_session_id,
            teamclu_session_id,
            runtime_id,
        );
    }

    pub fn register_child_session(
        &self,
        agent_type: amux::AgentType,
        host_generation_id: &str,
        child_backend_session_id: &str,
        parent_backend_session_id: &str,
    ) {
        let backend_kind = backend_kind_for_agent_type(agent_type);
        let ok = self.inner.write().registry.register_child(
            backend_kind,
            host_generation_id,
            child_backend_session_id,
            parent_backend_session_id,
        );
        if !ok {
            warn!(
                backend_kind,
                host_generation_id,
                child_backend_session_id,
                parent_backend_session_id,
                "runtime context child registration failed"
            );
        }
    }

    pub fn unregister_backend_session(
        &self,
        agent_type: amux::AgentType,
        host_generation_id: &str,
        backend_session_id: &str,
    ) {
        if host_generation_id.trim().is_empty() || backend_session_id.trim().is_empty() {
            return;
        }
        let backend_kind = backend_kind_for_agent_type(agent_type);
        self.inner.write().registry.unregister_backend_session(
            backend_kind,
            host_generation_id,
            backend_session_id,
        );
    }

    pub fn clear_generation(&self, agent_type: amux::AgentType, host_generation_id: &str) {
        if host_generation_id.trim().is_empty() {
            return;
        }
        let backend_kind = backend_kind_for_agent_type(agent_type);
        let mut inner = self.inner.write();
        inner
            .registry
            .clear_generation(backend_kind, host_generation_id);
        inner
            .tokens
            .revoke_generation(backend_kind, host_generation_id);
        inner
            .hosts
            .revoke_generation(backend_kind, host_generation_id);
    }

    pub fn resolve_with_token(
        &self,
        bearer_token: &str,
        req: &ResolveRuntimeContextRequest,
    ) -> Result<ResolveRuntimeContextResponse, ResolveError> {
        if req.backend_session_id.trim().is_empty() {
            return Err(ResolveError::InvalidBackendSessionId);
        }
        if req.host_generation_id.trim().is_empty() {
            return Err(ResolveError::StaleHostGeneration);
        }
        let inner = self.inner.read();
        inner.tokens.validate(
            bearer_token,
            req.backend_kind.trim(),
            req.host_generation_id.trim(),
        )?;
        inner.registry.resolve(req)
    }

    /// Whether `bearer_token` is the live token of this host generation — the
    /// check behind `/internal/runtime-context/verify`. Unlike
    /// [`Self::resolve_with_token`] it names no backend session: the caller is
    /// the host's MCP child, which serves every session in that host.
    pub fn verify_token(
        &self,
        bearer_token: &str,
        backend_kind: &str,
        host_generation_id: &str,
    ) -> Result<(), ResolveError> {
        if host_generation_id.trim().is_empty() {
            return Err(ResolveError::StaleHostGeneration);
        }
        self.inner.read().tokens.validate(
            bearer_token,
            backend_kind.trim(),
            host_generation_id.trim(),
        )
    }

    pub fn env_for_generation(
        &self,
        agent_type: amux::AgentType,
        host_generation_id: &str,
    ) -> HashMap<String, String> {
        let backend_kind = backend_kind_for_agent_type(agent_type);
        let mut inner = self.inner.write();
        let token = inner.tokens.ensure_token(backend_kind, host_generation_id);
        let base_url = inner
            .base_url
            .clone()
            .unwrap_or_else(|| "http://127.0.0.1:0".to_string());
        generation_env(
            &base_url,
            &token,
            backend_kind,
            host_generation_id,
            inner.socket_path.as_deref(),
        )
    }

    /// Phase 2 startup validation: managed session context must be wired before
    /// accepting agent attachments.
    pub fn validate_managed_setup(&self) -> Result<(), String> {
        let inner = self.inner.read();
        if inner.base_url.as_deref().unwrap_or("").trim().is_empty() {
            return Err(
                "runtime context service has no loopback base URL; HTTP server must bind first"
                    .to_string(),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_is_recognised_by_its_tree_until_its_generation_is_cleared_or_its_pid_is_reused() {
        let service = RuntimeContextService::new();
        let host = HostProcess {
            pid: 500,
            start_time: 1_000,
        };
        service.register_host_process(amux::AgentType::Pi, "pi-gen-1", host);
        let live = |pid: u32| (pid == 500).then_some(1_000u64);

        // The host itself, and a grandchild of it.
        let direct = service.host_for_process_chain(&[500], live).unwrap();
        assert_eq!(direct.host_generation_id, "pi-gen-1");
        assert_eq!(direct.backend_kind, "pi");
        assert_eq!(direct.host_pid, 500);
        let nested = service
            .host_for_process_chain(&[777, 600, 500, 1], live)
            .unwrap();
        assert_eq!(nested.host_pid, 500);

        // A tree with no host in it — any other process of this user.
        assert_eq!(
            service.host_for_process_chain(&[777, 600, 42], live),
            Err(ResolveError::CallerNotAgentHost)
        );
        // The pid is registered but now belongs to a different process.
        let reused = |pid: u32| (pid == 500).then_some(2_000u64);
        assert_eq!(
            service.host_for_process_chain(&[600, 500], reused),
            Err(ResolveError::CallerNotAgentHost)
        );
        // Gone with the generation.
        service.clear_generation(amux::AgentType::Pi, "pi-gen-1");
        assert_eq!(
            service.host_for_process_chain(&[500], live),
            Err(ResolveError::CallerNotAgentHost)
        );
    }

    #[test]
    fn env_carries_the_socket_only_once_it_is_bound() {
        use teamclu_runtime_env::session_context::TEAMCLU_RUNTIME_CONTEXT_SOCK_ENV;
        let service = RuntimeContextService::new();
        let env = service.env_for_generation(amux::AgentType::Pi, "pi-gen-1");
        assert!(!env.contains_key(TEAMCLU_RUNTIME_CONTEXT_SOCK_ENV));
        service.set_socket_path("/tmp/run/runtime-context.sock");
        let env = service.env_for_generation(amux::AgentType::Pi, "pi-gen-1");
        assert_eq!(
            env.get(TEAMCLU_RUNTIME_CONTEXT_SOCK_ENV)
                .map(String::as_str),
            Some("/tmp/run/runtime-context.sock")
        );
    }

    #[test]
    fn validate_managed_setup_requires_base_url() {
        let service = RuntimeContextService::new();
        assert!(service.validate_managed_setup().is_err());
        service.set_base_url("http://127.0.0.1:13141");
        assert!(service.validate_managed_setup().is_ok());
    }
}
