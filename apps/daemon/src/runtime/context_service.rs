//! Shared runtime context service used by HTTP resolve and runtime lifecycle.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::RwLock;
use tracing::warn;

use super::context_registry::{
    backend_kind_for_agent_type, generation_env, GenerationTokenStore, ResolveError,
    ResolveRuntimeContextRequest, ResolveRuntimeContextResponse, RuntimeContextRegistry,
};
use crate::proto::amux;

#[derive(Clone)]
pub struct RuntimeContextService {
    inner: Arc<RwLock<RuntimeContextServiceInner>>,
}

struct RuntimeContextServiceInner {
    registry: RuntimeContextRegistry,
    tokens: GenerationTokenStore,
    base_url: Option<String>,
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
                base_url: None,
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
        generation_env(&base_url, &token, backend_kind, host_generation_id)
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
    fn validate_managed_setup_requires_base_url() {
        let service = RuntimeContextService::new();
        assert!(service.validate_managed_setup().is_err());
        service.set_base_url("http://127.0.0.1:13141");
        assert!(service.validate_managed_setup().is_ok());
    }
}
