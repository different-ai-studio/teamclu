//! Read-only agent lookups, extracted from `manager.rs`.
//!
//! The map is keyed by cloud `session_id` (ADR-0004), so most of these are
//! now direct gets. They exist to carry the owner-actor filter and to keep the
//! call sites reading in domain terms. All are pure reads of the manager's
//! private `agents` map.
//!
//! Child module of `runtime::manager`, so the `impl RuntimeManager` block
//! reaches `agents` directly.


use super::super::handle::RuntimeHandle;
use super::RuntimeManager;

fn owner_matches(handle: &RuntimeHandle, actor_id: &str) -> bool {
    if actor_id.is_empty() {
        return true;
    }
    // Legacy / unstamped handles: do not fail closed on missing owner.
    if handle.owner_actor_id.is_empty() {
        return true;
    }
    handle.owner_actor_id == actor_id
}

impl RuntimeManager {
    /// The attachment for `session_id`, if this daemon holds one. Exactly 0 or
    /// 1 by construction — the session id is the key. The `Vec` shape is kept
    /// because callers iterate; it can hold at most one element.
    pub fn runtime_ids_for_session(&self, session_id: &str) -> Vec<String> {
        self.agents
            .contains_key(session_id)
            .then(|| vec![session_id.to_string()])
            .unwrap_or_default()
    }

    /// The attachment for `session_id`. Was "the newest of several" back when
    /// a session could accumulate one handle per spawn.
    pub fn newest_runtime_id_for_session(&self, session_id: &str) -> Option<String> {
        self.newest_runtime_id_for_session_actor(session_id, "")
    }

    /// The attachment for `session_id`, gated on owner when `actor_id` is
    /// non-empty so one agent cannot reach another's attachment (ADR-0004).
    pub fn newest_runtime_id_for_session_actor(
        &self,
        session_id: &str,
        actor_id: &str,
    ) -> Option<String> {
        let handle = self.agents.get(session_id)?;
        owner_matches(handle, actor_id).then(|| session_id.to_string())
    }

    /// Member actor bound for remote-tool RPC on the live runtime for `session_id`.
    pub fn remote_tool_member_for_session(&self, session_id: &str) -> Option<String> {
        self.runtime_ids_for_session(session_id)
            .into_iter()
            .find_map(|rid| {
                self.get_handle(&rid).and_then(|h| {
                    if h.remote_tool_member_id.is_empty() {
                        None
                    } else {
                        Some(h.remote_tool_member_id.clone())
                    }
                })
            })
    }

    /// The cloud session this attachment serves, if it is session-bound.
    /// Ambient / bare-agent spawns have none.
    pub fn session_id_for_runtime(&self, runtime_id: &str) -> Option<String> {
        self.agents
            .get(runtime_id)
            .map(|h| h.session_id.clone())
            .filter(|s| !s.is_empty())
    }

    /// Look up an agent runtime by its ACP session id (the 36-char uuid
    /// returned by `session/new` and stored on `RuntimeHandle.acp_session_id`).
    /// Returns the daemon-side 8-char `agent_id` key used by `send_prompt`.
    pub fn agent_id_by_acp_session(&self, acp_session_id: &str) -> Option<String> {
        if acp_session_id.is_empty() {
            return None;
        }
        self.agents
            .iter()
            .find(|(_, h)| h.acp_session_id == acp_session_id)
            .map(|(id, _)| id.clone())
    }

    /// Normalise a client-facing command address to the attachment key.
    ///
    /// The map is keyed by cloud `session_id` (ADR-0004), so this is parsing,
    /// not lookup: `{actor}::{session}` yields `session` once the actor matches
    /// this attachment's owner, and a bare session id passes through. There is
    /// deliberately no per-spawn form — that id no longer exists.
    ///
    /// `actor_id` is the cloud agent actor from the envelope (and/or MQTT
    /// topic). When non-empty it must match the composite's left side, so one
    /// agent cannot address another's attachment in a shared session.
    pub fn resolve_command_agent_id(&self, addressed_as: &str, actor_id: &str) -> Option<String> {
        let addressed = addressed_as.trim();
        if addressed.is_empty() {
            return None;
        }
        let actor_id = actor_id.trim();

        let session = match addressed.split_once("::") {
            Some((left, session)) => {
                let (left, session) = (left.trim(), session.trim());
                if session.is_empty() {
                    return None;
                }
                if !actor_id.is_empty() && !left.is_empty() && left != actor_id {
                    return None;
                }
                session
            }
            None => addressed,
        };

        let handle = self.agents.get(session)?;
        owner_matches(handle, actor_id).then(|| session.to_string())
    }
}
