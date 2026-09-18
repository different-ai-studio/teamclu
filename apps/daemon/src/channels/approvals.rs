//! Tool approvals asked of the chat a turn came from.
//!
//! A gateway turn whose session runs under "ask" stops on a permission
//! request. The desktop shows a card for it, but nobody may be at that desktop,
//! and the person in the chat used to wait out the whole turn timeout with no
//! idea why. So the request is also put to the chat, and anyone in it can
//! settle it with `/allow`, `/always` or `/deny`.
//!
//! The chat never resolves anything itself. Its decision goes to the daemon's
//! run loop, through the same first-come gate a desktop grant uses, so whichever
//! side answers first wins and the other is told it was already handled.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, oneshot};

use crate::proto::amux;

/// One permission request a gateway turn is waiting on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRequest {
    pub request_id: String,
    /// The runtime the request belongs to — what the run loop resolves against.
    pub agent_id: String,
    /// What the request is about, as the runtime titled it
    /// (`bash: <first line of the command>`). The full arguments stay off the
    /// chat: they can carry tokens, and a group chat is not the place for them.
    pub summary: String,
    pub offers_always: bool,
}

impl ApprovalRequest {
    pub fn from_event(agent_id: &str, request: &amux::AcpPermissionRequest) -> Self {
        Self {
            request_id: request.request_id.clone(),
            agent_id: agent_id.to_string(),
            summary: request.tool_name.clone(),
            offers_always: request
                .options
                .iter()
                .any(|option| option.kind == "allow_always"),
        }
    }
}

/// What someone in the chat answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    AllowOnce,
    AllowAlways,
    Deny,
}

impl Decision {
    /// The slash command, without its slash. The Chinese spellings are there
    /// because that is what people type in these chats.
    pub fn from_command(name: &str) -> Option<Self> {
        match name {
            "allow" | "允许" => Some(Self::AllowOnce),
            "always" | "始终允许" => Some(Self::AllowAlways),
            "deny" | "拒绝" => Some(Self::Deny),
            _ => None,
        }
    }

    pub fn granted(self) -> bool {
        !matches!(self, Self::Deny)
    }

    /// The runtime's option id (`translate::permission_options`).
    pub fn option_id(self) -> Option<String> {
        match self {
            Self::AllowOnce => Some("once".to_string()),
            Self::AllowAlways => Some("always".to_string()),
            Self::Deny => None,
        }
    }
}

/// How the run loop settled a decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settled {
    Resolved,
    /// Someone got there first — the desktop, or another `/allow`.
    AlreadyHandled,
    /// Won the gate but the runtime could not be reached.
    Failed,
}

/// A decision on its way to the run loop.
#[derive(Debug)]
pub struct ChatDecision {
    pub agent_id: String,
    pub request_id: String,
    pub granted: bool,
    pub option_id: Option<String>,
    /// Display name of whoever answered, for the log.
    pub approver: String,
    pub reply: oneshot::Sender<Settled>,
}

/// What a `/allow` (or `/always`, `/deny`) came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecideOutcome {
    NothingPending,
    /// The decision that took effect. `/always` on a request that does not
    /// offer it is applied as a one-off allow, and says so.
    Resolved {
        request: ApprovalRequest,
        decision: Decision,
    },
    AlreadyHandled,
    Failed {
        request: ApprovalRequest,
    },
}

/// Pending approvals, per logical gateway session.
pub struct ApprovalDesk {
    pending: Mutex<HashMap<String, Vec<ApprovalRequest>>>,
    watchers: Mutex<HashMap<String, mpsc::UnboundedSender<ApprovalRequest>>>,
    resolver: mpsc::Sender<ChatDecision>,
}

impl ApprovalDesk {
    pub fn new(resolver: mpsc::Sender<ChatDecision>) -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
            resolver,
        }
    }

    /// Receive this session's approval requests for as long as the guard
    /// lives. The core holds one for the duration of a turn, so a request can
    /// be put to the chat the moment it is raised.
    pub fn watch(
        self: &Arc<Self>,
        session: &str,
    ) -> (mpsc::UnboundedReceiver<ApprovalRequest>, WatchGuard) {
        let (tx, rx) = mpsc::unbounded_channel();
        self.watchers
            .lock()
            .unwrap()
            .insert(session.to_string(), tx);
        (
            rx,
            WatchGuard {
                desk: self.clone(),
                session: session.to_string(),
            },
        )
    }

    /// A turn stopped on a permission request.
    pub fn raise(&self, session: &str, request: ApprovalRequest) {
        self.pending
            .lock()
            .unwrap()
            .entry(session.to_string())
            .or_default()
            .push(request.clone());
        if let Some(watcher) = self.watchers.lock().unwrap().get(session) {
            let _ = watcher.send(request);
        }
    }

    /// The turn is over; nothing it asked for can be answered any more.
    pub fn clear(&self, session: &str) {
        self.pending.lock().unwrap().remove(session);
    }

    /// Settle the oldest request this session is waiting on.
    ///
    /// A request the desktop already answered is still listed here (nothing
    /// tells this desk about desktop answers), so one the run loop reports as
    /// handled is skipped in favour of the next.
    pub async fn decide(&self, session: &str, decision: Decision, approver: &str) -> DecideOutcome {
        let mut skipped_any = false;
        loop {
            let next = {
                let mut pending = self.pending.lock().unwrap();
                let Some(list) = pending.get_mut(session) else {
                    break;
                };
                if list.is_empty() {
                    pending.remove(session);
                    break;
                }
                let request = list.remove(0);
                if list.is_empty() {
                    pending.remove(session);
                }
                request
            };
            let decision = match decision {
                Decision::AllowAlways if !next.offers_always => Decision::AllowOnce,
                other => other,
            };
            let (reply, settled) = oneshot::channel();
            let sent = self
                .resolver
                .send(ChatDecision {
                    agent_id: next.agent_id.clone(),
                    request_id: next.request_id.clone(),
                    granted: decision.granted(),
                    option_id: decision.option_id(),
                    approver: approver.to_string(),
                    reply,
                })
                .await;
            if sent.is_err() {
                return DecideOutcome::Failed { request: next };
            }
            match settled.await {
                Ok(Settled::Resolved) => {
                    return DecideOutcome::Resolved {
                        request: next,
                        decision,
                    }
                }
                Ok(Settled::AlreadyHandled) => skipped_any = true,
                Ok(Settled::Failed) | Err(_) => return DecideOutcome::Failed { request: next },
            }
        }
        if skipped_any {
            DecideOutcome::AlreadyHandled
        } else {
            DecideOutcome::NothingPending
        }
    }

    fn unwatch(&self, session: &str) {
        self.watchers.lock().unwrap().remove(session);
    }
}

/// Stops a [`ApprovalDesk::watch`] when dropped, on every exit path of a turn.
pub struct WatchGuard {
    desk: Arc<ApprovalDesk>,
    session: String,
}

impl Drop for WatchGuard {
    fn drop(&mut self) {
        self.desk.unwatch(&self.session);
    }
}

/// Next request from an optional watch; pends forever without one, so it can
/// sit in a `select!` next to the turn.
pub async fn next_request(
    watch: &mut Option<mpsc::UnboundedReceiver<ApprovalRequest>>,
) -> Option<ApprovalRequest> {
    match watch {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, offers_always: bool) -> ApprovalRequest {
        ApprovalRequest {
            request_id: id.into(),
            agent_id: "agent-1".into(),
            summary: "bash: date".into(),
            offers_always,
        }
    }

    /// A run loop stand-in that answers every decision with `settled` and
    /// records what it was asked.
    fn run_loop(
        answers: Vec<Settled>,
    ) -> (
        Arc<ApprovalDesk>,
        Arc<Mutex<Vec<(String, bool, Option<String>)>>>,
    ) {
        let (tx, mut rx) = mpsc::channel::<ChatDecision>(8);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            let mut answers = answers.into_iter();
            while let Some(d) = rx.recv().await {
                log.lock()
                    .unwrap()
                    .push((d.request_id.clone(), d.granted, d.option_id.clone()));
                let _ = d.reply.send(answers.next().unwrap_or(Settled::Resolved));
            }
        });
        (Arc::new(ApprovalDesk::new(tx)), seen)
    }

    #[test]
    fn commands_map_to_decisions() {
        assert_eq!(Decision::from_command("allow"), Some(Decision::AllowOnce));
        assert_eq!(Decision::from_command("允许"), Some(Decision::AllowOnce));
        assert_eq!(
            Decision::from_command("always"),
            Some(Decision::AllowAlways)
        );
        assert_eq!(Decision::from_command("拒绝"), Some(Decision::Deny));
        assert_eq!(Decision::from_command("stop"), None);
        assert_eq!(Decision::Deny.option_id(), None);
        assert!(!Decision::Deny.granted());
    }

    #[test]
    fn from_event_reads_always_off_the_options() {
        let event = amux::AcpPermissionRequest {
            request_id: "r1".into(),
            tool_name: "bash: date".into(),
            description: String::new(),
            params: Default::default(),
            options: crate::runtime::pi_rpc::translate::permission_options(true),
        };
        let r = ApprovalRequest::from_event("agent-1", &event);
        assert!(r.offers_always);
        assert_eq!(r.summary, "bash: date");
        let event = amux::AcpPermissionRequest {
            options: crate::runtime::pi_rpc::translate::permission_options(false),
            ..event
        };
        assert!(!ApprovalRequest::from_event("agent-1", &event).offers_always);
    }

    #[tokio::test]
    async fn raise_reaches_the_watcher_until_the_guard_drops() {
        let (desk, _) = run_loop(vec![]);
        let (mut rx, guard) = desk.watch("s1");
        desk.raise("s1", request("r1", true));
        assert_eq!(rx.recv().await.unwrap().request_id, "r1");
        drop(guard);
        desk.raise("s1", request("r2", true));
        assert!(rx.recv().await.is_none(), "watch must end with its guard");
    }

    #[tokio::test]
    async fn decide_settles_the_oldest_request_through_the_run_loop() {
        let (desk, seen) = run_loop(vec![Settled::Resolved]);
        desk.raise("s1", request("r1", true));
        desk.raise("s1", request("r2", true));
        let outcome = desk.decide("s1", Decision::AllowAlways, "张三").await;
        assert_eq!(
            outcome,
            DecideOutcome::Resolved {
                request: request("r1", true),
                decision: Decision::AllowAlways,
            }
        );
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            &[("r1".to_string(), true, Some("always".to_string()))]
        );
    }

    #[tokio::test]
    async fn always_on_a_request_without_it_is_a_one_off_allow() {
        let (desk, seen) = run_loop(vec![Settled::Resolved]);
        desk.raise("s1", request("r1", false));
        let outcome = desk.decide("s1", Decision::AllowAlways, "张三").await;
        assert!(matches!(
            outcome,
            DecideOutcome::Resolved {
                decision: Decision::AllowOnce,
                ..
            }
        ));
        assert_eq!(seen.lock().unwrap()[0].2.as_deref(), Some("once"));
    }

    #[tokio::test]
    async fn a_request_answered_elsewhere_is_skipped_for_the_next() {
        let (desk, seen) = run_loop(vec![Settled::AlreadyHandled, Settled::Resolved]);
        desk.raise("s1", request("r1", true));
        desk.raise("s1", request("r2", true));
        let outcome = desk.decide("s1", Decision::Deny, "张三").await;
        assert!(matches!(
            outcome,
            DecideOutcome::Resolved { ref request, decision: Decision::Deny } if request.request_id == "r2"
        ));
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn only_stale_requests_report_already_handled() {
        let (desk, _) = run_loop(vec![Settled::AlreadyHandled]);
        desk.raise("s1", request("r1", true));
        assert_eq!(
            desk.decide("s1", Decision::AllowOnce, "张三").await,
            DecideOutcome::AlreadyHandled
        );
        assert_eq!(
            desk.decide("s1", Decision::AllowOnce, "张三").await,
            DecideOutcome::NothingPending
        );
    }

    #[tokio::test]
    async fn clear_drops_what_a_finished_turn_asked() {
        let (desk, seen) = run_loop(vec![]);
        desk.raise("s1", request("r1", true));
        desk.clear("s1");
        assert_eq!(
            desk.decide("s1", Decision::AllowOnce, "张三").await,
            DecideOutcome::NothingPending
        );
        assert!(seen.lock().unwrap().is_empty());
    }
}
