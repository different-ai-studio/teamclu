//! In-process registry mapping backend sessions to TeamClu cloud sessions.
//!
//! Replaces worktree-level `active-session-id` for managed daemon backends.

use std::collections::HashMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use teamclu_runtime_env::session_context::{
    TEAMCLU_AGENT_BACKEND_ENV, TEAMCLU_HOST_GENERATION_ID_ENV, TEAMCLU_RUNTIME_CONTEXT_TOKEN_ENV,
    TEAMCLU_RUNTIME_CONTEXT_URL_ENV,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BackendSessionKey {
    pub backend_kind: String,
    pub host_generation_id: String,
    pub backend_session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    Active,
    Detaching,
    Stopped,
}

#[derive(Debug, Clone)]
pub struct RuntimeSessionBinding {
    pub teamclu_session_id: String,
    pub runtime_id: String,
    pub parent_backend_session_id: Option<String>,
    pub lifecycle_state: LifecycleState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveRuntimeContextRequest {
    #[serde(rename = "backendSessionId")]
    pub backend_session_id: String,
    #[serde(rename = "hostGenerationId")]
    pub host_generation_id: String,
    #[serde(rename = "backendKind")]
    pub backend_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveRuntimeContextResponse {
    #[serde(rename = "teamcluSessionId")]
    pub teamclu_session_id: String,
    #[serde(rename = "runtimeId")]
    pub runtime_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    InvalidBackendSessionId,
    InvalidRuntimeContextToken,
    SessionContextUnavailable,
    StaleHostGeneration,
}

impl ResolveError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidBackendSessionId => "invalid_backend_session_id",
            Self::InvalidRuntimeContextToken => "invalid_runtime_context_token",
            Self::SessionContextUnavailable => "session_context_unavailable",
            Self::StaleHostGeneration => "stale_host_generation",
        }
    }

    pub fn http_status(&self) -> u16 {
        match self {
            Self::InvalidRuntimeContextToken => 401,
            Self::SessionContextUnavailable => 404,
            Self::StaleHostGeneration => 409,
            Self::InvalidBackendSessionId => 422,
        }
    }
}

#[derive(Default)]
pub struct RuntimeContextRegistry {
    entries: HashMap<BackendSessionKey, RuntimeSessionBinding>,
}

impl RuntimeContextRegistry {
    pub fn register_parent(
        &mut self,
        backend_kind: impl Into<String>,
        host_generation_id: impl Into<String>,
        backend_session_id: impl Into<String>,
        teamclu_session_id: impl Into<String>,
        runtime_id: impl Into<String>,
    ) {
        let key = BackendSessionKey {
            backend_kind: backend_kind.into(),
            host_generation_id: host_generation_id.into(),
            backend_session_id: backend_session_id.into(),
        };
        self.entries.insert(
            key,
            RuntimeSessionBinding {
                teamclu_session_id: teamclu_session_id.into(),
                runtime_id: runtime_id.into(),
                parent_backend_session_id: None,
                lifecycle_state: LifecycleState::Active,
            },
        );
    }

    pub fn register_child(
        &mut self,
        backend_kind: impl Into<String>,
        host_generation_id: impl Into<String>,
        child_backend_session_id: impl Into<String>,
        parent_backend_session_id: impl Into<String>,
    ) -> bool {
        let parent_key = BackendSessionKey {
            backend_kind: backend_kind.into(),
            host_generation_id: host_generation_id.into(),
            backend_session_id: parent_backend_session_id.into(),
        };
        let Some(parent) = self.entries.get(&parent_key) else {
            return false;
        };
        if parent.lifecycle_state != LifecycleState::Active {
            return false;
        }
        let child_key = BackendSessionKey {
            backend_kind: parent_key.backend_kind.clone(),
            host_generation_id: parent_key.host_generation_id.clone(),
            backend_session_id: child_backend_session_id.into(),
        };
        self.entries.insert(
            child_key,
            RuntimeSessionBinding {
                teamclu_session_id: parent.teamclu_session_id.clone(),
                runtime_id: parent.runtime_id.clone(),
                parent_backend_session_id: Some(parent_key.backend_session_id.clone()),
                lifecycle_state: LifecycleState::Active,
            },
        );
        true
    }

    pub fn unregister_backend_session(
        &mut self,
        backend_kind: &str,
        host_generation_id: &str,
        backend_session_id: &str,
    ) {
        let prefix = BackendSessionKey {
            backend_kind: backend_kind.to_string(),
            host_generation_id: host_generation_id.to_string(),
            backend_session_id: backend_session_id.to_string(),
        };
        self.entries.remove(&prefix);
        self.entries.retain(|_, binding| {
            binding.parent_backend_session_id.as_deref() != Some(backend_session_id)
        });
    }

    pub fn clear_generation(&mut self, backend_kind: &str, host_generation_id: &str) {
        self.entries.retain(|key, _| {
            key.backend_kind != backend_kind || key.host_generation_id != host_generation_id
        });
    }

    pub fn resolve(&self, req: &ResolveRuntimeContextRequest) -> Result<ResolveRuntimeContextResponse, ResolveError> {
        let backend_session_id = req.backend_session_id.trim();
        if backend_session_id.is_empty() {
            return Err(ResolveError::InvalidBackendSessionId);
        }
        let host_generation_id = req.host_generation_id.trim();
        if host_generation_id.is_empty() {
            return Err(ResolveError::StaleHostGeneration);
        }
        let backend_kind = req.backend_kind.trim();
        if backend_kind.is_empty() {
            return Err(ResolveError::InvalidBackendSessionId);
        }

        let mut current = backend_session_id.to_string();
        let mut seen = HashMap::<String, u8>::new();
        loop {
            if seen.insert(current.clone(), 1).is_some() {
                return Err(ResolveError::SessionContextUnavailable);
            }
            let key = BackendSessionKey {
                backend_kind: backend_kind.to_string(),
                host_generation_id: host_generation_id.to_string(),
                backend_session_id: current.clone(),
            };
            let Some(binding) = self.entries.get(&key) else {
                return Err(ResolveError::SessionContextUnavailable);
            };
            if binding.lifecycle_state != LifecycleState::Active {
                return Err(ResolveError::SessionContextUnavailable);
            }
            if binding.teamclu_session_id.trim().is_empty() {
                return Err(ResolveError::SessionContextUnavailable);
            }
            match binding.parent_backend_session_id.as_deref() {
                None => {
                    return Ok(ResolveRuntimeContextResponse {
                        teamclu_session_id: binding.teamclu_session_id.clone(),
                        runtime_id: binding.runtime_id.clone(),
                    });
                }
                Some(parent) => current = parent.to_string(),
            }
        }
    }
}

#[derive(Debug, Clone)]
struct GenerationTokenRecord {
    token: String,
    backend_kind: String,
    generation_id: String,
    created_at: Instant,
}

#[derive(Default)]
pub struct GenerationTokenStore {
    by_generation: HashMap<(String, String), GenerationTokenRecord>,
    by_token: HashMap<String, (String, String)>,
}

impl GenerationTokenStore {
    pub fn ensure_token(
        &mut self,
        backend_kind: impl Into<String>,
        generation_id: impl Into<String>,
    ) -> String {
        let backend_kind = backend_kind.into();
        let generation_id = generation_id.into();
        let key = (backend_kind.clone(), generation_id.clone());
        if let Some(record) = self.by_generation.get(&key) {
            return record.token.clone();
        }
        let token = format!("rtctx_{}", Uuid::new_v4().simple());
        self.by_generation.insert(
            key.clone(),
            GenerationTokenRecord {
                token: token.clone(),
                backend_kind: backend_kind.clone(),
                generation_id: generation_id.clone(),
                created_at: Instant::now(),
            },
        );
        self.by_token
            .insert(token.clone(), (backend_kind, generation_id));
        token
    }

    pub fn validate(
        &self,
        token: &str,
        backend_kind: &str,
        host_generation_id: &str,
    ) -> Result<(), ResolveError> {
        let token = token.trim();
        if token.is_empty() {
            return Err(ResolveError::InvalidRuntimeContextToken);
        }
        let Some((kind, generation)) = self.by_token.get(token) else {
            return Err(ResolveError::InvalidRuntimeContextToken);
        };
        if kind != backend_kind || generation != host_generation_id {
            return Err(ResolveError::InvalidRuntimeContextToken);
        }
        Ok(())
    }

    pub fn revoke_generation(&mut self, backend_kind: &str, generation_id: &str) {
        let key = (backend_kind.to_string(), generation_id.to_string());
        if let Some(record) = self.by_generation.remove(&key) {
            self.by_token.remove(&record.token);
        }
    }
}

pub fn backend_kind_for_agent_type(agent_type: crate::proto::amux::AgentType) -> &'static str {
    match agent_type {
        crate::proto::amux::AgentType::Pi => "pi",
        crate::proto::amux::AgentType::ClaudeCode => "claude",
        crate::proto::amux::AgentType::Cursor => "cursor",
        crate::proto::amux::AgentType::Opencode | crate::proto::amux::AgentType::Codex => "opencode",
        _ => "opencode",
    }
}

pub fn generation_env(
    base_url: &str,
    token: &str,
    backend_kind: &str,
    generation_id: &str,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert(
        TEAMCLU_RUNTIME_CONTEXT_URL_ENV.to_string(),
        base_url.trim_end_matches('/').to_string(),
    );
    env.insert(TEAMCLU_RUNTIME_CONTEXT_TOKEN_ENV.to_string(), token.to_string());
    env.insert(
        TEAMCLU_HOST_GENERATION_ID_ENV.to_string(),
        generation_id.to_string(),
    );
    env.insert(
        TEAMCLU_AGENT_BACKEND_ENV.to_string(),
        backend_kind.to_string(),
    );
    env.insert(
        teamclu_runtime_env::session_context::TEAMCLU_REQUIRE_EXPLICIT_SESSION_ID_ENV.to_string(),
        "1".to_string(),
    );
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION_A: &str = "a1ca8f06-94ee-4fb5-bdfb-194a5606062f";
    const SESSION_B: &str = "b2db9017-05ff-4ac6-c0ec-0a5b67171730";

    fn req(backend_session: &str, generation: &str) -> ResolveRuntimeContextRequest {
        ResolveRuntimeContextRequest {
            backend_session_id: backend_session.to_string(),
            host_generation_id: generation.to_string(),
            backend_kind: "opencode".to_string(),
        }
    }

    #[test]
    fn register_and_resolve_two_concurrent_sessions() {
        let mut registry = RuntimeContextRegistry::default();
        registry.register_parent("opencode", "gen1", "ses_a", SESSION_A, SESSION_A);
        registry.register_parent("opencode", "gen1", "ses_b", SESSION_B, SESSION_B);
        assert_eq!(
            registry.resolve(&req("ses_a", "gen1")).unwrap().teamclu_session_id,
            SESSION_A
        );
        assert_eq!(
            registry.resolve(&req("ses_b", "gen1")).unwrap().teamclu_session_id,
            SESSION_B
        );
    }

    #[test]
    fn same_backend_session_id_in_two_generations_do_not_collide() {
        let mut registry = RuntimeContextRegistry::default();
        registry.register_parent("opencode", "gen1", "ses_same", SESSION_A, SESSION_A);
        registry.register_parent("opencode", "gen2", "ses_same", SESSION_B, SESSION_B);
        assert_eq!(
            registry.resolve(&req("ses_same", "gen1")).unwrap().teamclu_session_id,
            SESSION_A
        );
        assert_eq!(
            registry.resolve(&req("ses_same", "gen2")).unwrap().teamclu_session_id,
            SESSION_B
        );
    }

    #[test]
    fn detach_one_session_leaves_the_other() {
        let mut registry = RuntimeContextRegistry::default();
        registry.register_parent("opencode", "gen1", "ses_a", SESSION_A, SESSION_A);
        registry.register_parent("opencode", "gen1", "ses_b", SESSION_B, SESSION_B);
        registry.unregister_backend_session("opencode", "gen1", "ses_a");
        assert!(registry.resolve(&req("ses_a", "gen1")).is_err());
        assert_eq!(
            registry.resolve(&req("ses_b", "gen1")).unwrap().teamclu_session_id,
            SESSION_B
        );
    }

    #[test]
    fn child_inherits_parent_teamclu_session() {
        let mut registry = RuntimeContextRegistry::default();
        registry.register_parent("opencode", "gen1", "ses_parent", SESSION_A, SESSION_A);
        assert!(registry.register_child("opencode", "gen1", "ses_child", "ses_parent"));
        assert_eq!(
            registry
                .resolve(&req("ses_child", "gen1"))
                .unwrap()
                .teamclu_session_id,
            SESSION_A
        );
    }

    #[test]
    fn generation_teardown_clears_entries() {
        let mut registry = RuntimeContextRegistry::default();
        registry.register_parent("opencode", "gen1", "ses_a", SESSION_A, SESSION_A);
        registry.clear_generation("opencode", "gen1");
        assert!(registry.resolve(&req("ses_a", "gen1")).is_err());
    }

    #[test]
    fn generation_token_validates_kind_and_generation() {
        let mut store = GenerationTokenStore::default();
        let token = store.ensure_token("opencode", "gen1");
        assert!(store.validate(&token, "opencode", "gen1").is_ok());
        assert!(store.validate(&token, "pi", "gen1").is_err());
        assert!(store.validate(&token, "opencode", "gen2").is_err());
    }

    #[test]
    fn child_without_parent_fails_closed() {
        let mut registry = RuntimeContextRegistry::default();
        assert!(!registry.register_child("opencode", "gen1", "ses_child", "missing_parent"));
        assert!(registry.resolve(&req("ses_child", "gen1")).is_err());
    }

    /// Phase 2 integration gate: alternating concurrent resolves must never cross sessions.
    #[test]
    fn concurrent_ab_resolves_never_cross_sessions() {
        let mut registry = RuntimeContextRegistry::default();
        registry.register_parent("opencode", "gen1", "ses_a", SESSION_A, SESSION_A);
        registry.register_parent("opencode", "gen1", "ses_b", SESSION_B, SESSION_B);
        registry.register_child("opencode", "gen1", "ses_child_a", "ses_a");

        use std::sync::{Arc, Mutex};
        let registry = Arc::new(Mutex::new(registry));
        let mut handles = Vec::new();
        for i in 0..100 {
            let reg = Arc::clone(&registry);
            handles.push(std::thread::spawn(move || {
                let backend_session = if i % 2 == 0 { "ses_a" } else { "ses_b" };
                let expected = if i % 2 == 0 { SESSION_A } else { SESSION_B };
                let resolved = reg
                    .lock()
                    .unwrap()
                    .resolve(&req(backend_session, "gen1"))
                    .unwrap()
                    .teamclu_session_id;
                assert_eq!(resolved, expected);
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            registry
                .lock()
                .unwrap()
                .resolve(&req("ses_child_a", "gen1"))
                .unwrap()
                .teamclu_session_id,
            SESSION_A
        );
    }
}
