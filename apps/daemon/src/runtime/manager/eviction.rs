//! Idle-runtime eviction, extracted from `manager.rs`.
//!
//! The daemon's idle sweeper stops runtimes that have been quiet past a
//! threshold, buffering their ids on `evicted_pending_publish` so the main
//! event loop can clear the retained `runtime/{id}/state` MQTT topic on its
//! next tick.
//!
//! Child module of `runtime::manager`, so the `impl RuntimeManager` block
//! reaches the private `agents` map and `evicted_pending_publish` buffer.

use tracing::info;

use super::RuntimeManager;

impl RuntimeManager {
    /// Stop every runtime whose `last_active_at` is older than
    /// `now - threshold_secs`. Skips runtimes whose `event_rx` is currently
    /// checked out (a gateway turn is in flight). Returns the list of
    /// agent_ids that were stopped — and also buffers them on
    /// `evicted_pending_publish` so the daemon main loop can clear retained
    /// state. Called by the daemon's idle sweeper task.
    pub async fn evict_idle(&mut self, threshold_secs: i64) -> Vec<String> {
        let now = chrono::Utc::now().timestamp();
        let cutoff = now - threshold_secs;
        let stale: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, h)| h.event_rx.is_some() && h.last_active_at <= cutoff)
            .map(|(id, _)| id.clone())
            .collect();
        let mut evicted = Vec::with_capacity(stale.len());
        for id in stale {
            if self.stop_runtime(&id).await.is_some() {
                info!(
                    agent_id = %id,
                    threshold_secs,
                    "idle sweeper: evicted runtime"
                );
                evicted.push(id);
            }
        }
        self.evicted_pending_publish.extend(evicted.iter().cloned());
        evicted
    }

    /// Detach least-recently-used attachments until at most `max` remain.
    ///
    /// The idle sweep alone bounds the set only by user behaviour — how many
    /// sessions someone opens inside the timeout — so this is the hard ceiling
    /// behind it (ADR-0004).
    ///
    /// Deliberately WITHOUT the `event_rx.is_some()` guard the idle sweep uses:
    /// that guard exists to protect a turn in flight, but a receiver stranded
    /// by a failed checkout would exempt its attachment forever. Capacity must
    /// hold even then, and `stop_runtime` does not consult `event_rx`.
    pub async fn evict_over_capacity(&mut self, max: usize) -> Vec<String> {
        if self.agents.len() <= max {
            return Vec::new();
        }
        let mut by_age: Vec<(String, i64)> = self
            .agents
            .iter()
            .map(|(id, h)| (id.clone(), h.last_active_at))
            .collect();
        // Oldest first; ties broken by id so the choice is deterministic.
        by_age.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));

        let excess = self.agents.len() - max;
        let mut evicted = Vec::with_capacity(excess);
        for (id, _) in by_age.into_iter().take(excess) {
            if self.stop_runtime(&id).await.is_some() {
                tracing::info!(agent_id = %id, max, "capacity sweeper: detached LRU attachment");
                evicted.push(id);
            }
        }
        self.evicted_pending_publish.extend(evicted.iter().cloned());
        evicted
    }

    /// Stop one idle attachment so a user-facing `runtimeStart` can retry after
    /// `host_capacity_timeout`. Picks the least-recently-active runtime that:
    /// - is not mid-turn (`turn_lock` free),
    /// - still owns `event_rx` (not checked out),
    /// - is not `exclude_session_id` (the session we are trying to start).
    ///
    /// Goes through [`Self::stop_runtime`] so the OpenCode host is detached,
    /// never killed. Auto-recovery must not call this — only the user RPC path.
    pub async fn evict_one_idle_attachment_for_capacity(
        &mut self,
        exclude_session_id: &str,
    ) -> Option<String> {
        let exclude = exclude_session_id.trim();
        let candidate = self
            .agents
            .iter()
            .filter(|(id, handle)| {
                let excluded =
                    !exclude.is_empty() && (*id == exclude || handle.session_id == exclude);
                !excluded && handle.event_rx.is_some() && handle.turn_lock.try_lock().is_ok()
            })
            .min_by(|(a_id, a), (b_id, b)| {
                a.last_active_at
                    .cmp(&b.last_active_at)
                    .then_with(|| a_id.cmp(b_id))
            })
            .map(|(id, _)| id.clone());
        let id = candidate?;
        if self.stop_runtime(&id).await.is_some() {
            info!(
                agent_id = %id,
                "capacity: evicted idle attachment to free a host slot"
            );
            self.evicted_pending_publish.push(id.clone());
            Some(id)
        } else {
            None
        }
    }

    /// Drain the buffer of idle-evicted agent_ids whose terminal MQTT state
    /// still needs publishing. Called once per main-loop tick.
    pub fn drain_evicted(&mut self) -> Vec<String> {
        std::mem::take(&mut self.evicted_pending_publish)
    }
}
