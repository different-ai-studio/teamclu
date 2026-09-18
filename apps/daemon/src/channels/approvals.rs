//! Tool approvals and agent questions asked of the chat a turn came from.
//!
//! A gateway turn stops when the runtime needs a person: a tool permission
//! (session under "ask"), or the agent's `question` tool. The desktop shows a
//! card for either, but nobody may be at that desktop, and the person in the
//! chat used to wait out the whole turn timeout with no idea why. So the
//! request is also put to the chat — as buttons where the channel has them —
//! and anyone in it can settle it: `/allow`, `/always`, `/deny` for a
//! permission, `/answer` (or `/deny` to skip) for a question.
//!
//! The chat never resolves anything itself. Its decision goes to the daemon's
//! run loop, through the same first-come gate a desktop answer uses, so
//! whichever side answers first wins and the other is told it was already
//! handled.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, oneshot};

use crate::proto::amux;

/// One option of a question, as the agent offered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

/// One question of the agent's `question` tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionSpec {
    pub question: String,
    pub header: String,
    pub options: Vec<QuestionOption>,
    pub multiple: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalKind {
    Permission { offers_always: bool },
    Question { questions: Vec<QuestionSpec> },
}

/// One thing a gateway turn is waiting on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRequest {
    pub request_id: String,
    /// The runtime the request belongs to — what the run loop resolves against.
    pub agent_id: String,
    /// What it is about, in one line: the tool as the runtime titled it
    /// (`bash: <first line of the command>`), or the first question. A
    /// permission's full arguments stay off the chat: they can carry tokens,
    /// and a group chat is not the place for them.
    pub summary: String,
    pub kind: ApprovalKind,
}

impl ApprovalRequest {
    pub fn from_event(agent_id: &str, request: &amux::AcpPermissionRequest) -> Self {
        Self {
            request_id: request.request_id.clone(),
            agent_id: agent_id.to_string(),
            summary: request.tool_name.clone(),
            kind: ApprovalKind::Permission {
                offers_always: request
                    .options
                    .iter()
                    .any(|option| option.kind == "allow_always"),
            },
        }
    }

    /// From the `question_asked` raw event (`translate::question_asked_event`).
    pub fn from_question_event(agent_id: &str, payload: &[u8]) -> Option<Self> {
        let body: serde_json::Value = serde_json::from_slice(payload).ok()?;
        let request_id = body.get("id")?.as_str()?.to_string();
        let str_of = |v: &serde_json::Value, k: &str| {
            v.get(k)
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let questions: Vec<QuestionSpec> = body
            .get("questions")?
            .as_array()?
            .iter()
            .map(|q| QuestionSpec {
                question: str_of(q, "question"),
                header: str_of(q, "header"),
                options: q
                    .get("options")
                    .and_then(|o| o.as_array())
                    .map(|opts| {
                        opts.iter()
                            .filter_map(|o| match o {
                                serde_json::Value::String(label) => Some(QuestionOption {
                                    label: label.trim().to_string(),
                                    description: String::new(),
                                }),
                                other => Some(QuestionOption {
                                    label: str_of(other, "label"),
                                    description: str_of(other, "description"),
                                }),
                            })
                            .filter(|o| !o.label.is_empty())
                            .collect()
                    })
                    .unwrap_or_default(),
                multiple: q.get("multiple").and_then(|m| m.as_bool()).unwrap_or(false),
            })
            .collect();
        if questions.is_empty() {
            return None;
        }
        let summary = questions
            .iter()
            .map(|q| {
                if q.question.is_empty() {
                    q.header.clone()
                } else {
                    q.question.clone()
                }
            })
            .find(|s| !s.is_empty())
            .unwrap_or_default();
        Some(Self {
            request_id,
            agent_id: agent_id.to_string(),
            summary,
            kind: ApprovalKind::Question { questions },
        })
    }
}

/// What someone in the chat answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    AllowOnce,
    AllowAlways,
    /// Refuse a permission, or skip a question.
    Deny,
    /// Answer a question: option numbers or free text (see [`parse_answers`]).
    Answer(String),
}

impl Decision {
    /// A slash command (name without its slash, and its argument) as a
    /// decision, plus the request it names when it names one. `#<id>` as the
    /// first word targets a request — what a card button sends; people typing
    /// leave it out and get the oldest request that fits.
    ///
    /// The Chinese spellings are there because that is what people type in
    /// these chats.
    pub fn from_command(name: &str, arg: Option<&str>) -> Option<(Self, Option<String>)> {
        let arg = arg.unwrap_or("").trim();
        let (target, rest) = match arg.strip_prefix('#') {
            Some(tail) => {
                let (id, rest) = tail.split_once(char::is_whitespace).unwrap_or((tail, ""));
                (Some(id.to_string()).filter(|s| !s.is_empty()), rest.trim())
            }
            None => (None, arg),
        };
        let decision = match name {
            "allow" | "允许" => Self::AllowOnce,
            "always" | "始终允许" => Self::AllowAlways,
            "deny" | "拒绝" => Self::Deny,
            "answer" | "回答" => Self::Answer(rest.to_string()),
            _ => return None,
        };
        Some((decision, target))
    }

    fn fits(&self, kind: &ApprovalKind) -> bool {
        match self {
            Self::AllowOnce | Self::AllowAlways => {
                matches!(kind, ApprovalKind::Permission { .. })
            }
            Self::Answer(_) => matches!(kind, ApprovalKind::Question { .. }),
            Self::Deny => true,
        }
    }
}

/// Turn `/answer` text into one list of chosen labels per question.
///
/// Questions are separated by `;`; a multi-select question's picks by `,`.
/// A number within range picks that option; anything else is the person's
/// own answer, which the question tool accepts. With one question the whole
/// text is its answer — no splitting on `;` a free answer might contain.
pub fn parse_answers(raw: &str, questions: &[QuestionSpec]) -> Vec<Vec<String>> {
    let raw = raw.trim();
    let parts: Vec<&str> = if questions.len() <= 1 {
        vec![raw]
    } else {
        raw.split([';', '；']).map(str::trim).collect()
    };
    questions
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let part = parts.get(i).copied().unwrap_or("").trim();
            if part.is_empty() {
                return Vec::new();
            }
            let picks: Vec<&str> = if q.multiple {
                part.split([',', '，', '、']).map(str::trim).collect()
            } else {
                vec![part]
            };
            picks
                .into_iter()
                .filter(|p| !p.is_empty())
                .map(|p| match p.parse::<usize>() {
                    Ok(n) if (1..=q.options.len()).contains(&n) => q.options[n - 1].label.clone(),
                    _ => p.to_string(),
                })
                .collect()
        })
        .collect()
}

/// What the run loop is asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatAction {
    Permission {
        granted: bool,
        option_id: Option<String>,
    },
    Question {
        answers_json: String,
        reject: bool,
    },
}

/// How the run loop settled a decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settled {
    Resolved,
    /// Someone got there first — the desktop, or another answer from the chat.
    AlreadyHandled,
    /// Won the gate but the runtime could not be reached.
    Failed,
}

/// A decision on its way to the run loop.
#[derive(Debug)]
pub struct ChatDecision {
    pub agent_id: String,
    pub request_id: String,
    pub action: ChatAction,
    /// Display name of whoever answered, for the log.
    pub approver: String,
    pub reply: oneshot::Sender<Settled>,
}

/// What a `/allow` (or `/always`, `/deny`, `/answer`) came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecideOutcome {
    NothingPending,
    /// The decision that took effect. `/always` on a request that does not
    /// offer it is applied as a one-off allow, and says so. `answers` is set
    /// for an answered question.
    Resolved {
        request: ApprovalRequest,
        decision: Decision,
        answers: Option<Vec<Vec<String>>>,
    },
    AlreadyHandled,
    Failed {
        request: ApprovalRequest,
    },
    /// The command does not fit what is waiting (`/allow` on a question).
    WrongKind {
        request: ApprovalRequest,
    },
    /// `/answer` with nothing after it.
    EmptyAnswer {
        request: ApprovalRequest,
    },
}

/// Pending approvals and questions, per logical gateway session.
pub struct ApprovalDesk {
    pending: Mutex<HashMap<String, Vec<ApprovalRequest>>>,
    watchers: Mutex<HashMap<String, mpsc::UnboundedSender<ApprovalRequest>>>,
    resolver: mpsc::Sender<ChatDecision>,
}

enum Pick {
    Take(ApprovalRequest),
    Mismatch(ApprovalRequest),
    Empty(ApprovalRequest),
    None,
}

impl ApprovalDesk {
    pub fn new(resolver: mpsc::Sender<ChatDecision>) -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
            resolver,
        }
    }

    /// Receive this session's requests for as long as the guard lives. The
    /// core holds one for the duration of a turn, so a request can be put to
    /// the chat the moment it is raised.
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

    /// A turn stopped on a permission request or a question.
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

    /// Take the request `decision` is about: the one `target` names, or the
    /// oldest that fits. A request that does not fit is left in place.
    fn pick(&self, session: &str, decision: &Decision, target: Option<&str>) -> Pick {
        let mut pending = self.pending.lock().unwrap();
        let Some(list) = pending.get_mut(session) else {
            return Pick::None;
        };
        let index = match target {
            Some(id) => list.iter().position(|r| r.request_id == id),
            None => list.iter().position(|r| decision.fits(&r.kind)),
        };
        let Some(index) = index else {
            // Nothing fits: point at what is actually waiting, if anything.
            return match (target, list.first()) {
                (None, Some(first)) => Pick::Mismatch(first.clone()),
                _ => Pick::None,
            };
        };
        if !decision.fits(&list[index].kind) {
            return Pick::Mismatch(list[index].clone());
        }
        if matches!(decision, Decision::Answer(a) if a.trim().is_empty()) {
            return Pick::Empty(list[index].clone());
        }
        let request = list.remove(index);
        if list.is_empty() {
            pending.remove(session);
        }
        Pick::Take(request)
    }

    /// Settle the request `decision` is about (see [`Self::pick`]).
    ///
    /// A request the desktop already answered is still listed here (nothing
    /// tells this desk about desktop answers), so without a target one the run
    /// loop reports as handled is skipped in favour of the next.
    pub async fn decide(
        &self,
        session: &str,
        decision: Decision,
        approver: &str,
        target: Option<&str>,
    ) -> DecideOutcome {
        let mut skipped_any = false;
        loop {
            let next = match self.pick(session, &decision, target) {
                Pick::Take(request) => request,
                Pick::Mismatch(request) if !skipped_any => {
                    return DecideOutcome::WrongKind { request }
                }
                Pick::Empty(request) => return DecideOutcome::EmptyAnswer { request },
                Pick::Mismatch(_) | Pick::None => break,
            };
            let (effective, action, answers) = match (&next.kind, &decision) {
                (ApprovalKind::Permission { offers_always }, d) => {
                    let effective = match d {
                        Decision::AllowAlways if !offers_always => Decision::AllowOnce,
                        other => other.clone(),
                    };
                    let action = ChatAction::Permission {
                        granted: !matches!(effective, Decision::Deny),
                        option_id: match effective {
                            Decision::AllowOnce => Some("once".to_string()),
                            Decision::AllowAlways => Some("always".to_string()),
                            _ => None,
                        },
                    };
                    (effective, action, None)
                }
                (ApprovalKind::Question { questions }, Decision::Answer(raw)) => {
                    let answers = parse_answers(raw, questions);
                    let action = ChatAction::Question {
                        answers_json: serde_json::to_string(&answers).unwrap_or_default(),
                        reject: false,
                    };
                    (decision.clone(), action, Some(answers))
                }
                (ApprovalKind::Question { .. }, _) => (
                    Decision::Deny,
                    ChatAction::Question {
                        answers_json: String::new(),
                        reject: true,
                    },
                    None,
                ),
            };
            let (reply, settled) = oneshot::channel();
            let sent = self
                .resolver
                .send(ChatDecision {
                    agent_id: next.agent_id.clone(),
                    request_id: next.request_id.clone(),
                    action,
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
                        decision: effective,
                        answers,
                    }
                }
                Ok(Settled::AlreadyHandled) if target.is_none() => skipped_any = true,
                Ok(Settled::AlreadyHandled) => return DecideOutcome::AlreadyHandled,
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

    fn permission(id: &str, offers_always: bool) -> ApprovalRequest {
        ApprovalRequest {
            request_id: id.into(),
            agent_id: "agent-1".into(),
            summary: "bash: date".into(),
            kind: ApprovalKind::Permission { offers_always },
        }
    }

    fn question(id: &str, multiple: bool) -> ApprovalRequest {
        ApprovalRequest {
            request_id: id.into(),
            agent_id: "agent-1".into(),
            summary: "去哪".into(),
            kind: ApprovalKind::Question {
                questions: vec![QuestionSpec {
                    question: "去哪".into(),
                    header: String::new(),
                    options: vec![
                        QuestionOption {
                            label: "北京".into(),
                            description: String::new(),
                        },
                        QuestionOption {
                            label: "上海".into(),
                            description: String::new(),
                        },
                    ],
                    multiple,
                }],
            },
        }
    }

    /// A run loop stand-in that answers every decision with the next of
    /// `answers`, recording what it was asked.
    fn run_loop(
        answers: Vec<Settled>,
    ) -> (Arc<ApprovalDesk>, Arc<Mutex<Vec<(String, ChatAction)>>>) {
        let (tx, mut rx) = mpsc::channel::<ChatDecision>(8);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            let mut answers = answers.into_iter();
            while let Some(d) = rx.recv().await {
                log.lock()
                    .unwrap()
                    .push((d.request_id.clone(), d.action.clone()));
                let _ = d.reply.send(answers.next().unwrap_or(Settled::Resolved));
            }
        });
        (Arc::new(ApprovalDesk::new(tx)), seen)
    }

    fn allow(id: &str, always: bool) -> (String, ChatAction) {
        (
            id.to_string(),
            ChatAction::Permission {
                granted: true,
                option_id: Some(if always { "always" } else { "once" }.to_string()),
            },
        )
    }

    #[test]
    fn commands_map_to_decisions_and_targets() {
        assert_eq!(
            Decision::from_command("allow", None),
            Some((Decision::AllowOnce, None))
        );
        assert_eq!(
            Decision::from_command("允许", None),
            Some((Decision::AllowOnce, None))
        );
        assert_eq!(
            Decision::from_command("always", Some("#r-1")),
            Some((Decision::AllowAlways, Some("r-1".into())))
        );
        assert_eq!(
            Decision::from_command("拒绝", None),
            Some((Decision::Deny, None))
        );
        assert_eq!(
            Decision::from_command("answer", Some("#q-1 2")),
            Some((Decision::Answer("2".into()), Some("q-1".into())))
        );
        assert_eq!(
            Decision::from_command("回答", Some("自己写的答案")),
            Some((Decision::Answer("自己写的答案".into()), None))
        );
        assert_eq!(Decision::from_command("stop", None), None);
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
        assert_eq!(
            r.kind,
            ApprovalKind::Permission {
                offers_always: true
            }
        );
        assert_eq!(r.summary, "bash: date");
        let event = amux::AcpPermissionRequest {
            options: crate::runtime::pi_rpc::translate::permission_options(false),
            ..event
        };
        assert_eq!(
            ApprovalRequest::from_event("agent-1", &event).kind,
            ApprovalKind::Permission {
                offers_always: false
            }
        );
    }

    #[test]
    fn a_question_event_reads_the_translated_payload() {
        let payload = crate::runtime::pi_rpc::translate::question_asked_event(
            "q-1",
            &serde_json::json!({
                "toolCallId": "call-1",
                "questions": [{
                    "question": "去哪个城市？",
                    "header": "城市",
                    "options": [{"label": "北京", "description": "首都"}, "上海"],
                    "multiple": false
                }]
            }),
        );
        let Some(amux::acp_event::Event::Raw(raw)) = payload.event else {
            panic!("question_asked is a raw event");
        };
        let r = ApprovalRequest::from_question_event("agent-1", &raw.json_payload).unwrap();
        assert_eq!(r.request_id, "q-1");
        assert_eq!(r.summary, "去哪个城市？");
        let ApprovalKind::Question { questions } = r.kind else {
            panic!("a question");
        };
        assert_eq!(questions[0].options.len(), 2);
        assert_eq!(questions[0].options[0].description, "首都");
        assert_eq!(questions[0].options[1].label, "上海");
    }

    #[test]
    fn answers_pick_options_by_number_and_keep_free_text() {
        let q = |multiple| QuestionSpec {
            question: "q".into(),
            header: String::new(),
            options: vec![
                QuestionOption {
                    label: "A".into(),
                    description: String::new(),
                },
                QuestionOption {
                    label: "B".into(),
                    description: String::new(),
                },
                QuestionOption {
                    label: "C".into(),
                    description: String::new(),
                },
            ],
            multiple,
        };
        assert_eq!(parse_answers("2", &[q(false)]), vec![vec!["B".to_string()]]);
        assert_eq!(parse_answers("9", &[q(false)]), vec![vec!["9".to_string()]]);
        assert_eq!(
            parse_answers("自己写的; 带分号", &[q(false)]),
            vec![vec!["自己写的; 带分号".to_string()]],
            "one question takes the whole text"
        );
        assert_eq!(
            parse_answers("1，3", &[q(true)]),
            vec![vec!["A".to_string(), "C".to_string()]]
        );
        assert_eq!(
            parse_answers("1; 2,3", &[q(false), q(true)]),
            vec![
                vec!["A".to_string()],
                vec!["B".to_string(), "C".to_string()]
            ]
        );
        assert_eq!(
            parse_answers("1", &[q(false), q(false)]),
            vec![vec!["A".to_string()], vec![]],
            "a missing answer is empty, not an error"
        );
    }

    #[tokio::test]
    async fn raise_reaches_the_watcher_until_the_guard_drops() {
        let (desk, _) = run_loop(vec![]);
        let (mut rx, guard) = desk.watch("s1");
        desk.raise("s1", permission("r1", true));
        assert_eq!(rx.recv().await.unwrap().request_id, "r1");
        drop(guard);
        desk.raise("s1", permission("r2", true));
        assert!(rx.recv().await.is_none(), "watch must end with its guard");
    }

    #[tokio::test]
    async fn decide_settles_the_oldest_request_through_the_run_loop() {
        let (desk, seen) = run_loop(vec![Settled::Resolved]);
        desk.raise("s1", permission("r1", true));
        desk.raise("s1", permission("r2", true));
        let outcome = desk.decide("s1", Decision::AllowAlways, "张三", None).await;
        assert!(matches!(
            outcome,
            DecideOutcome::Resolved { ref request, decision: Decision::AllowAlways, .. } if request.request_id == "r1"
        ));
        assert_eq!(seen.lock().unwrap().as_slice(), &[allow("r1", true)]);
    }

    #[tokio::test]
    async fn a_target_settles_that_request_not_the_oldest() {
        let (desk, seen) = run_loop(vec![Settled::Resolved]);
        desk.raise("s1", permission("r1", true));
        desk.raise("s1", permission("r2", true));
        desk.decide("s1", Decision::AllowOnce, "张三", Some("r2"))
            .await;
        assert_eq!(seen.lock().unwrap().as_slice(), &[allow("r2", false)]);
    }

    #[tokio::test]
    async fn always_on_a_request_without_it_is_a_one_off_allow() {
        let (desk, seen) = run_loop(vec![Settled::Resolved]);
        desk.raise("s1", permission("r1", false));
        let outcome = desk.decide("s1", Decision::AllowAlways, "张三", None).await;
        assert!(matches!(
            outcome,
            DecideOutcome::Resolved {
                decision: Decision::AllowOnce,
                ..
            }
        ));
        assert_eq!(seen.lock().unwrap().as_slice(), &[allow("r1", false)]);
    }

    #[tokio::test]
    async fn an_answer_goes_to_the_question_as_the_tool_expects_it() {
        let (desk, seen) = run_loop(vec![Settled::Resolved]);
        desk.raise("s1", permission("r1", true));
        desk.raise("s1", question("q1", false));
        let outcome = desk
            .decide("s1", Decision::Answer("2".into()), "张三", None)
            .await;
        assert!(matches!(
            outcome,
            DecideOutcome::Resolved { ref request, answers: Some(ref a), .. }
                if request.request_id == "q1" && a == &vec![vec!["上海".to_string()]]
        ));
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            &[(
                "q1".to_string(),
                ChatAction::Question {
                    answers_json: r#"[["上海"]]"#.into(),
                    reject: false
                }
            )]
        );
    }

    #[tokio::test]
    async fn deny_on_a_question_skips_it() {
        let (desk, seen) = run_loop(vec![Settled::Resolved]);
        desk.raise("s1", question("q1", false));
        desk.decide("s1", Decision::Deny, "张三", None).await;
        assert_eq!(
            seen.lock().unwrap()[0].1,
            ChatAction::Question {
                answers_json: String::new(),
                reject: true
            }
        );
    }

    #[tokio::test]
    async fn a_command_that_does_not_fit_says_so_and_leaves_the_request() {
        let (desk, seen) = run_loop(vec![Settled::Resolved]);
        desk.raise("s1", question("q1", false));
        assert!(matches!(
            desk.decide("s1", Decision::AllowOnce, "张三", None).await,
            DecideOutcome::WrongKind { ref request } if request.request_id == "q1"
        ));
        assert!(matches!(
            desk.decide("s1", Decision::Answer("  ".into()), "张三", None)
                .await,
            DecideOutcome::EmptyAnswer { .. }
        ));
        assert!(seen.lock().unwrap().is_empty());
        assert!(matches!(
            desk.decide("s1", Decision::Answer("1".into()), "张三", None)
                .await,
            DecideOutcome::Resolved { .. }
        ));
    }

    #[tokio::test]
    async fn a_request_answered_elsewhere_is_skipped_for_the_next() {
        let (desk, seen) = run_loop(vec![Settled::AlreadyHandled, Settled::Resolved]);
        desk.raise("s1", permission("r1", true));
        desk.raise("s1", permission("r2", true));
        let outcome = desk.decide("s1", Decision::Deny, "张三", None).await;
        assert!(matches!(
            outcome,
            DecideOutcome::Resolved { ref request, decision: Decision::Deny, .. } if request.request_id == "r2"
        ));
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_targeted_request_answered_elsewhere_is_reported_not_skipped() {
        let (desk, seen) = run_loop(vec![Settled::AlreadyHandled]);
        desk.raise("s1", permission("r1", true));
        desk.raise("s1", permission("r2", true));
        assert_eq!(
            desk.decide("s1", Decision::AllowOnce, "张三", Some("r1"))
                .await,
            DecideOutcome::AlreadyHandled
        );
        assert_eq!(seen.lock().unwrap().len(), 1, "r2 was not touched");
    }

    #[tokio::test]
    async fn only_stale_requests_report_already_handled() {
        let (desk, _) = run_loop(vec![Settled::AlreadyHandled]);
        desk.raise("s1", permission("r1", true));
        assert_eq!(
            desk.decide("s1", Decision::AllowOnce, "张三", None).await,
            DecideOutcome::AlreadyHandled
        );
        assert_eq!(
            desk.decide("s1", Decision::AllowOnce, "张三", None).await,
            DecideOutcome::NothingPending
        );
    }

    #[tokio::test]
    async fn clear_drops_what_a_finished_turn_asked() {
        let (desk, seen) = run_loop(vec![]);
        desk.raise("s1", permission("r1", true));
        desk.clear("s1");
        assert_eq!(
            desk.decide("s1", Decision::AllowOnce, "张三", None).await,
            DecideOutcome::NothingPending
        );
        assert!(seen.lock().unwrap().is_empty());
    }
}
