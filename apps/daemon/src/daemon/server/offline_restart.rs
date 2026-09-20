//! Re-engage with sessions that got messages while the daemon was down.
//!
//! Daemon-owned runtimes are subprocesses; they die when the daemon process
//! exits. MQTT live publishes against those sessions are dropped by the broker
//! (clean_session=true), so the only record of those messages is the
//! `messages` table. The user-facing symptom is "messages I sent while the
//! daemon was off never get a reply".
//!
//! Strategy: for each session this daemon's actor is in, fetch the messages
//! after its cursor. A session with an @-mention nobody answered yet gets its
//! runtime started, and the existing `catchup_runtime` path then routes those
//! messages through `route_session_message`, exactly as live traffic would.
//!
//! The scan runs off the main loop. It is a handful of Cloud calls per
//! session, and it used to run inline before the loop served anything: a
//! daemon in thirty-odd sessions spent 20–35 s on it, then 11–17 s more
//! starting runtimes. `channel-status` and the other control commands the
//! settings pages send waited behind all of it, the desktop gave up after its
//! 30 s read timeout, and the channels page spun after every restart
//! (2026-09-18). Now [`OfflineRestartPlanner`] checks a few sessions at a time
//! in a background task and hands the ones that need a runtime back to the
//! main loop one by one, so commands are served in between.

use std::sync::Arc;

use futures::stream::{self, StreamExt};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tracing::{info, warn};

use super::runtime_lifecycle::gateway_binding_exists;
use super::{DaemonServer, OfflineRestartPlan};
use crate::backend::Backend;
use crate::daemon::runtime_cursor::last_unanswered_mention_idx;
use crate::daemon::runtime_resolution::resolve_requested_agent_type;
use crate::proto::amux;
use crate::runtime::RuntimeManager;

/// Sessions checked at once. Each check is a few sequential Cloud calls, so
/// this is what turns a scan of thirty sessions from half a minute into a few
/// seconds, while staying well clear of hammering the Cloud API.
const PLAN_CONCURRENCY: usize = 8;

/// Everything the scan reads, cloned out of the server so it can run in a
/// task of its own while the main loop keeps serving commands.
#[derive(Clone)]
pub(crate) struct OfflineRestartPlanner {
    backend: Arc<dyn Backend>,
    agents: Arc<AsyncMutex<RuntimeManager>>,
    team_id: Option<String>,
    actor_id: String,
}

impl OfflineRestartPlanner {
    /// The sessions that need a runtime, in the order the Cloud listed them.
    pub(crate) async fn plan(&self) -> Vec<OfflineRestartPlan> {
        let session_ids = self.list_all_actor_session_ids().await;
        if session_ids.is_empty() {
            return Vec::new();
        }
        info!(
            count = session_ids.len(),
            "plan_auto_restart_offline_sessions: scanning Cloud regular sessions for offline messages"
        );
        stream::iter(session_ids)
            .map(|session_id| self.plan_session(session_id))
            .buffered(PLAN_CONCURRENCY)
            .filter_map(|entry| async move { entry })
            .collect()
            .await
    }

    async fn list_all_actor_session_ids(&self) -> Vec<String> {
        let team_id = match self.team_id.as_deref() {
            Some(team_id) if !team_id.is_empty() => team_id,
            _ => return Vec::new(),
        };
        let mut session_ids = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let (page, next) = match self
                .backend
                .list_actor_session_ids(team_id, cursor.as_deref(), 50)
                .await
            {
                Ok(page) => page,
                Err(e) => {
                    warn!(
                        ?e,
                        team_id, "list_all_actor_session_ids: Cloud session list failed"
                    );
                    break;
                }
            };
            session_ids.extend(page);
            cursor = next.filter(|c| !c.is_empty());
            if cursor.is_none() {
                break;
            }
        }
        session_ids
    }

    /// `Some` when `session_id` has an @-mention of this daemon that still
    /// needs a turn and nothing else will give it one.
    async fn plan_session(&self, session_id: String) -> Option<OfflineRestartPlan> {
        let my_actor = self.actor_id.as_str();
        // The cursor comes from this actor's participant row (ADR-0005).
        // `None` means "never read anything here", which is materially
        // different from the old "no runtime row → skip the session": a
        // session this daemon has joined but never answered in should still
        // be planned for restart, from the beginning.
        let prior_cursor = match self
            .backend
            .fetch_session_cursor(&session_id, my_actor)
            .await
        {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    ?e,
                    session_id = %session_id,
                    "plan_auto_restart_offline_sessions: fetch_session_cursor failed"
                );
                return None;
            }
        };

        // If a live runtime is already serving this session (e.g. a
        // network blip rather than a full daemon restart), skip — the
        // live MQTT path will deliver the messages directly.
        if !self
            .agents
            .lock()
            .await
            .runtime_ids_for_session(&session_id)
            .is_empty()
        {
            return None;
        }

        // A chat-bound session (WeCom and the other gateways) belongs to
        // its gateway, which answers in the chat on its own turn. Its
        // cursor never moves — gateway turns do not go through
        // `route_session_message` — so every restart used to find "unread"
        // messages the gateway had long since answered. And a runtime
        // started here cannot reply into the chat anyway: the answer would
        // land in the session only, which nobody in the chat sees. The
        // daemon's participant row in these sessions carries no workspace
        // either, so the attempt failed on workspace identity to boot.
        if gateway_binding_exists(self.backend.as_ref(), &session_id).await {
            info!(
                session_id = %session_id,
                "plan_auto_restart_offline_sessions: skipping chat-bound session; its gateway answers it"
            );
            return None;
        }

        let cursor = prior_cursor.as_deref().filter(|s| !s.is_empty());
        let messages = match self
            .backend
            .messages_after_cursor(&session_id, cursor)
            .await
        {
            Ok(m) => m,
            Err(e) => {
                warn!(
                    ?e,
                    session_id = %session_id,
                    "plan_auto_restart_offline_sessions: messages_after_cursor failed"
                );
                return None;
            }
        };

        // Only an @-mention of this daemon starts a turn; every other
        // message is queued silently as context for the next one. Starting a
        // runtime for those alone buys nothing: silent rows never move the
        // cursor, so catch-up replays them from it whenever the next mention
        // arrives. It also never ended — the cursor stayed put, and the same
        // sessions were planned again on every restart (seven of them, each
        // time, on 2026-09-18).
        last_unanswered_mention_idx(&messages, my_actor)?;

        let unread_count = messages
            .iter()
            .filter(|m| m.sender_actor_id != my_actor)
            .count();

        // One backend is active per actor at a time (ADR-0002), so the
        // restart uses the daemon's own rather than replaying whatever a
        // prior spawn happened to record.
        let backend = resolve_requested_agent_type(amux::AgentType::Unknown);

        // Workspace comes from the participant row that owns it (ADR-0005).
        // Empty means "resolve at spawn from the agent's default", the same
        // fallback a session with no prior runtime always took.
        let local_workspace_id = self
            .backend
            .fetch_session_workspace(&session_id, my_actor)
            .await
            .unwrap_or_default()
            .unwrap_or_default();

        let fork_from = match self
            .backend
            .fetch_session_with_participants(&session_id)
            .await
        {
            Ok(sp) => sp.session.thread_fork_from(),
            Err(e) => {
                warn!(
                    ?e,
                    session_id = %session_id,
                    "plan_auto_restart_offline_sessions: fetch_session_with_participants failed"
                );
                None
            }
        };

        Some(OfflineRestartPlan {
            session_id,
            backend,
            local_workspace_id,
            unread_count,
            fork_from,
        })
    }
}

impl DaemonServer {
    /// `None` before the team session manager exists: there are no sessions
    /// to drain yet.
    fn offline_restart_planner(&self) -> Option<OfflineRestartPlanner> {
        self.teamclu.as_ref()?;
        Some(OfflineRestartPlanner {
            backend: self.backend.clone(),
            agents: self.agents.clone(),
            team_id: self.config.team_id.clone(),
            actor_id: self.actor_id.clone(),
        })
    }

    /// The scan, awaited in place — what the tests drive.
    #[cfg(test)]
    pub(crate) async fn plan_auto_restart_offline_sessions(&self) -> Vec<OfflineRestartPlan> {
        match self.offline_restart_planner() {
            Some(planner) => planner.plan().await,
            None => Vec::new(),
        }
    }

    /// Scan in the background and send each session that needs a runtime
    /// through `tx`; the main loop starts them with
    /// [`Self::apply_offline_restart`].
    pub(crate) fn spawn_offline_restart_planning(&self, tx: mpsc::Sender<OfflineRestartPlan>) {
        let Some(planner) = self.offline_restart_planner() else {
            return;
        };
        tokio::spawn(async move {
            let plan = planner.plan().await;
            if plan.is_empty() {
                return;
            }
            info!(
                count = plan.len(),
                "auto_restart_offline_sessions: spawning {} runtime(s) for sessions with offline messages",
                plan.len()
            );
            for entry in plan {
                if tx.send(entry).await.is_err() {
                    return;
                }
            }
        });
    }

    /// Start the runtime for one planned session.
    pub(crate) async fn apply_offline_restart(&mut self, entry: OfflineRestartPlan) {
        // The scan ran while commands were being served, so a client may
        // have started this session's runtime in the meantime.
        if !self
            .agents
            .lock()
            .await
            .runtime_ids_for_session(&entry.session_id)
            .is_empty()
        {
            info!(
                session_id = %entry.session_id,
                "auto_restart_offline_sessions: runtime already running; skipping"
            );
            return;
        }
        info!(
            session_id = %entry.session_id,
            workspace_id = %entry.local_workspace_id,
            backend = ?entry.backend,
            unread = entry.unread_count,
            "auto_restart_offline_sessions: spawning runtime to drain offline messages"
        );
        match self
            .apply_start_runtime(
                entry.backend,
                &entry.local_workspace_id,
                "",
                &entry.session_id,
                "",
                None,
                "",
                false,
                entry.fork_from,
                "",
            )
            .await
        {
            Ok(outcome) => {
                info!(
                    session_id = %entry.session_id,
                    runtime_id = %outcome.runtime_id,
                    "auto_restart_offline_sessions: runtime spawned, catchup_runtime engaged"
                );
            }
            Err(err) => {
                warn!(
                    session_id = %entry.session_id,
                    error = %err.error_message,
                    stage = %err.failed_stage,
                    "auto_restart_offline_sessions: apply_start_runtime failed"
                );
            }
        }
    }
}
