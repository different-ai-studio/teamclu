use std::collections::HashMap;
use std::time::{Duration, Instant};

use uuid::Uuid;

const TURN_CONTEXT_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone)]
pub struct RemoteToolTurnContext {
    pub runtime_id: String,
    pub acp_session_id: String,
    pub teamclu_session_id: String,
    pub requester_actor_id: String,
    created_at: Instant,
}

#[derive(Default)]
pub struct RemoteToolTurnContextStore {
    by_id: HashMap<String, RemoteToolTurnContext>,
    current_by_runtime: HashMap<String, String>,
}

impl RemoteToolTurnContextStore {
    pub fn create(
        &mut self,
        runtime_id: &str,
        acp_session_id: &str,
        teamclu_session_id: &str,
        requester_actor_id: &str,
    ) -> Option<String> {
        if runtime_id.is_empty()
            || acp_session_id.is_empty()
            || teamclu_session_id.is_empty()
            || requester_actor_id.is_empty()
        {
            return None;
        }

        let id = format!("rtctx_{}", Uuid::new_v4().simple());
        self.by_id.insert(
            id.clone(),
            RemoteToolTurnContext {
                runtime_id: runtime_id.to_string(),
                acp_session_id: acp_session_id.to_string(),
                teamclu_session_id: teamclu_session_id.to_string(),
                requester_actor_id: requester_actor_id.to_string(),
                created_at: Instant::now(),
            },
        );
        self.current_by_runtime
            .insert(runtime_id.to_string(), id.clone());
        Some(id)
    }

    pub fn resolve(&mut self, id: &str) -> Option<RemoteToolTurnContext> {
        self.prune_expired();
        self.by_id.get(id).cloned()
    }

    pub fn clear_runtime(&mut self, runtime_id: &str) {
        if let Some(id) = self.current_by_runtime.remove(runtime_id) {
            self.by_id.remove(&id);
        }
        self.by_id.retain(|_, ctx| ctx.runtime_id != runtime_id);
    }

    pub fn prune_expired(&mut self) {
        let expired: Vec<String> = self
            .by_id
            .iter()
            .filter_map(|(id, ctx)| {
                (ctx.created_at.elapsed() > TURN_CONTEXT_TTL).then_some(id.clone())
            })
            .collect();
        for id in expired {
            self.by_id.remove(&id);
            self.current_by_runtime.retain(|_, current| current != &id);
        }
    }
}

pub fn inject_remote_context(prompt: &str, remote_context_id: &str) -> String {
    if remote_context_id.is_empty() {
        return prompt.to_string();
    }
    format!(
        "{}\n\n{prompt}",
        remote_context_instructions(remote_context_id)
    )
}

pub fn remote_context_instructions(remote_context_id: &str) -> String {
    // Used by `prepare_remote_tool_context_for_turn` when per-turn injection is
    // re-enabled (see daemon/server/remote_tools.rs).
    if remote_context_id.is_empty() {
        return String::new();
    }
    format!(
        "TeamClu remote tool context for this reply:\n\
         When calling any amuxd-remote-tools tool, include remote_context_id exactly as: {remote_context_id}\n\
         Do not reuse it after this reply."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_resolve_and_clear_context() {
        let mut store = RemoteToolTurnContextStore::default();
        let id = store
            .create("rt1", "acp1", "session1", "actor1")
            .expect("context id");
        let ctx = store.resolve(&id).expect("context");
        assert_eq!(ctx.requester_actor_id, "actor1");
        assert_eq!(ctx.teamclu_session_id, "session1");

        store.clear_runtime("rt1");
        assert!(store.resolve(&id).is_none());
    }

    #[test]
    fn new_context_does_not_invalidate_inflight_contexts() {
        let mut store = RemoteToolTurnContextStore::default();
        let first = store.create("rt1", "acp1", "session1", "actor1").unwrap();
        let second = store.create("rt1", "acp1", "session1", "actor2").unwrap();

        assert_eq!(store.resolve(&first).unwrap().requester_actor_id, "actor1");
        assert_eq!(store.resolve(&second).unwrap().requester_actor_id, "actor2");
    }

    #[test]
    fn injects_prompt_context() {
        let body = inject_remote_context("hello", "rtctx_1");
        assert!(body.contains("remote_context_id exactly as: rtctx_1"));
        assert!(body.ends_with("hello"));
    }

    #[test]
    fn builds_context_instructions_without_prompt() {
        let body = remote_context_instructions("rtctx_1");
        assert!(body.contains("remote_context_id exactly as: rtctx_1"));
        assert!(!body.contains("hello"));
    }
}
