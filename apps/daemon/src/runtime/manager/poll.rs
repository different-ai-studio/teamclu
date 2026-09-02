//! ACP event draining, extracted from `manager.rs`.
//!
//! The main MQTT loop drains every agent's queued ACP events once per tick;
//! a secondary consumer (the HTTP/SSE adapter) can drain only the runtimes it
//! owns. Agents whose `event_rx` is checked out for a gateway turn are skipped.
//!
//! Child module of `runtime::manager`, so the `impl RuntimeManager` block
//! reaches the private `agents` map directly.

use crate::runtime::acp_event_frame::AcpEventFrame;

use super::RuntimeManager;

impl RuntimeManager {
    /// Drain events from all agents, returns (agent_id, event) pairs.
    ///
    /// Agents whose `event_rx` has been checked out by a gateway turn are
    /// skipped — that owner is responsible for forwarding/aggregating its
    /// own events for the duration of the turn and will hand the receiver
    /// back afterwards.
    pub fn poll_events(&mut self) -> Vec<(String, AcpEventFrame)> {
        self.poll_events_inner(|_| true)
    }

    pub fn poll_events_for(
        &mut self,
        allow: &std::collections::HashSet<String>,
    ) -> Vec<(String, AcpEventFrame)> {
        self.poll_events_inner(|agent_id| allow.contains(agent_id))
    }

    fn poll_events_inner(&mut self, allow: impl Fn(&str) -> bool) -> Vec<(String, AcpEventFrame)> {
        let mut events = vec![];
        for (agent_id, handle) in &mut self.agents {
            if !allow(agent_id) {
                continue;
            }
            let mut got_any = false;
            if let Some(rx) = handle.event_rx.as_mut() {
                while let Ok(event) = rx.try_recv() {
                    events.push((agent_id.clone(), event));
                    got_any = true;
                }
            }
            if got_any {
                handle.bump_activity();
            }
        }
        events
    }
}
