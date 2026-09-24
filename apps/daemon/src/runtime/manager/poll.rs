//! ACP event draining, extracted from `manager.rs`.
//!
//! The main MQTT loop drains every agent's queued ACP events once per tick,
//! except the runtimes marked HTTP-owned; the HTTP/SSE adapter drains only
//! those. Agents whose `event_rx` is checked out for a gateway turn are skipped.
//!
//! Child module of `runtime::manager`, so the `impl RuntimeManager` block
//! reaches the private `agents` map directly.

use crate::runtime::acp_event_frame::AcpEventFrame;

use super::RuntimeManager;

impl RuntimeManager {
    /// Drain events from all agents not owned by the HTTP adapter, returns
    /// (agent_id, event) pairs.
    ///
    /// Agents whose `event_rx` has been checked out by a gateway turn are
    /// skipped — that owner is responsible for forwarding/aggregating its
    /// own events for the duration of the turn and will hand the receiver
    /// back afterwards.
    pub fn poll_events(&mut self) -> Vec<(String, AcpEventFrame)> {
        let http_owned = self.http_owned.clone();
        self.poll_events_inner(|agent_id| !http_owned.contains(agent_id))
    }

    pub fn poll_events_for(
        &mut self,
        allow: &std::collections::HashSet<String>,
    ) -> Vec<(String, AcpEventFrame)> {
        self.poll_events_inner(|agent_id| allow.contains(agent_id))
    }

    /// Hand this runtime's events to the HTTP adapter alone. Call it under the
    /// same lock that spawned the runtime, so no main-loop tick sees it first.
    /// `stop_runtime` clears the mark.
    pub fn mark_http_owned(&mut self, agent_id: &str) {
        self.http_owned.insert(agent_id.to_string());
    }

    fn poll_events_inner(&mut self, allow: impl Fn(&str) -> bool) -> Vec<(String, AcpEventFrame)> {
        let mut events = vec![];
        for (agent_id, handle) in &mut self.agents {
            if !allow(agent_id) {
                continue;
            }
            let mut got_any = false;
            let drained_at = events.len();
            if let Some(rx) = handle.event_rx.as_mut() {
                while let Ok(event) = rx.try_recv() {
                    events.push((agent_id.clone(), event));
                    got_any = true;
                }
            }
            if got_any {
                handle.bump_activity();
                let now = chrono::Utc::now().timestamp();
                for (_, frame) in &events[drained_at..] {
                    crate::runtime::turn_reply::apply_tool_deadline_unix(
                        &frame.event,
                        &mut handle.in_flight_tool_deadline,
                        now,
                    );
                }
            }
        }
        events
    }
}
