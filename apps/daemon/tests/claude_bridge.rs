//! Integration tests for `ClaudeAgentBackend` against a hermetic fake claude-bridge.
//!
//! Requires `node` on PATH; skips when absent. No Anthropic network or SDK.

#![cfg(unix)]

include!("support/crate_modules.rs");

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use runtime::acp_event_frame::AcpEventFrame;
use runtime::backend::{AcpCommand, AgentBackend};
use runtime::claude_agent::{ClaudeAgentBackend, SESSION_ID_PREFIX};
use runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
use runtime::AgentLaunchConfig;
use runtime::permission_policy::PermissionPolicy;
use tokio::sync::mpsc;

const EVENT_TIMEOUT: Duration = Duration::from_secs(10);

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn fake_bridge_command() -> Vec<String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude-bridge-fake/fake-bridge.mjs");
    vec![
        "node".into(),
        script.to_string_lossy().into_owned(),
        "--mode".into(),
        "rpc".into(),
    ]
}

fn launch_config() -> AgentLaunchConfig {
    AgentLaunchConfig::new("claude", vec![], "claude")
}

struct Harness {
    backend: ClaudeAgentBackend,
    event_tx: mpsc::Sender<AcpEventFrame>,
    event_rx: mpsc::Receiver<AcpEventFrame>,
    _worktree: tempfile::TempDir,
    worktree_path: String,
}

impl Harness {
    async fn new() -> Self {
        let worktree = tempfile::tempdir().expect("tempdir");
        let worktree_path = std::fs::canonicalize(worktree.path())
            .expect("canonicalize")
            .to_string_lossy()
            .into_owned();
        let mut backend = ClaudeAgentBackend::new();
        backend.set_bridge_command(fake_bridge_command());
        let (event_tx, event_rx) = mpsc::channel(64);
        Self {
            backend,
            event_tx,
            event_rx,
            _worktree: worktree,
            worktree_path,
        }
    }

    async fn attach(
        &mut self,
        worktree: &str,
        teamclu_session_id: &str,
    ) -> (mpsc::Sender<AcpCommand>, String) {
        let domain = IsolationDomainKey::Workspace(worktree.to_string());
        let revision = ProcessEnvRevision::from_bindings(&HashMap::new());
        let (cmd_tx, meta) = self
            .backend
            .attach_session(
                proto::amux::AgentType::ClaudeCode,
                &launch_config(),
                domain,
                revision,
                HashMap::new(),
                false,
                worktree.to_string(),
                None,
                None,
                None,
                vec![],
                String::new(),
                self.event_tx.clone(),
                PermissionPolicy::Ask,
                false,
                teamclu_session_id.to_string(),
            )
            .await
            .expect("attach_session");
        assert!(meta.acp_session_id.starts_with(SESSION_ID_PREFIX));
        (cmd_tx, meta.acp_session_id)
    }

    async fn next_for(
        &mut self,
        session_id: &str,
        pred: impl Fn(&proto::amux::AcpEvent) -> bool,
    ) -> AcpEventFrame {
        let deadline = tokio::time::Instant::now() + EVENT_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let frame = tokio::time::timeout(remaining, self.event_rx.recv())
                .await
                .expect("event within timeout")
                .expect("event channel open");
            if frame.acp_session_id == session_id && pred(&frame.event) {
                return frame;
            }
        }
    }

    async fn collect_output_until_idle(&mut self, session_id: &str) -> String {
        let mut text = String::new();
        loop {
            let frame = self.next_for(session_id, |_| true).await;
            match frame.event.event {
                Some(proto::amux::acp_event::Event::Output(out)) => text.push_str(&out.text),
                Some(proto::amux::acp_event::Event::StatusChange(sc))
                    if sc.new_status == proto::amux::AgentStatus::Idle as i32 =>
                {
                    break;
                }
                _ => {}
            }
        }
        text
    }

    async fn next_error_for(&mut self, session_id: &str) -> String {
        let frame = self
            .next_for(session_id, |ev| {
                matches!(
                    ev.event,
                    Some(proto::amux::acp_event::Event::Error(_))
                )
            })
            .await;
        match frame.event.event {
            Some(proto::amux::acp_event::Event::Error(err)) => err.message,
            _ => String::new(),
        }
    }

    async fn wait_until_idle(&mut self, session_id: &str) {
        self.next_for(session_id, |ev| {
            matches!(
                ev.event,
                Some(proto::amux::acp_event::Event::StatusChange(ref sc))
                    if sc.new_status == proto::amux::AgentStatus::Idle as i32
            )
        })
        .await;
    }
}

fn permission_request_id(ev: &proto::amux::AcpEvent) -> Option<String> {
    match &ev.event {
        Some(proto::amux::acp_event::Event::PermissionRequest(req)) => {
            Some(req.request_id.clone())
        }
        _ => None,
    }
}

#[tokio::test]
async fn fake_bridge_single_session_full_turn() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut h = Harness::new().await;
    let (cmd_tx, session) = h.attach(&h.worktree_path.clone(), "tc-1").await;
    cmd_tx
        .send(AcpCommand::Prompt {
            acp_session_id: session.clone(),
            text: "hello".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();
    let text = h.collect_output_until_idle(&session).await;
    assert!(text.contains("echo:hello"), "{text}");
}

#[tokio::test]
async fn fake_bridge_two_sessions_same_worktree_do_not_cross_talk() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut h = Harness::new().await;
    let wt = h.worktree_path.clone();
    let (cmd_a, session_a) = h.attach(&wt, "tc-a").await;
    let (cmd_b, session_b) = h.attach(&wt, "tc-b").await;
    assert_ne!(session_a, session_b);

    cmd_a
        .send(AcpCommand::Prompt {
            acp_session_id: session_a.clone(),
            text: "alpha".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();
    cmd_b
        .send(AcpCommand::Prompt {
            acp_session_id: session_b.clone(),
            text: "beta".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();

    let text_a = h.collect_output_until_idle(&session_a).await;
    let text_b = h.collect_output_until_idle(&session_b).await;
    assert!(text_a.contains("echo:alpha"));
    assert!(text_b.contains("echo:beta"));
}

#[tokio::test]
async fn fake_bridge_permission_round_trip() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut h = Harness::new().await;
    let wt = h.worktree_path.clone();
    let (cmd_tx, session) = h.attach(&wt, "perm-1").await;
    cmd_tx
        .send(AcpCommand::Prompt {
            acp_session_id: session.clone(),
            text: "perm:allow".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();

    let frame = h
        .next_for(&session, |ev| permission_request_id(ev).is_some())
        .await;
    let request_id = permission_request_id(&frame.event).unwrap();
    cmd_tx
        .send(AcpCommand::ResolvePermission {
            request_id,
            granted: true,
            option_id: Some("once".into()),
        })
        .await
        .unwrap();
    h.collect_output_until_idle(&session).await;
}

#[tokio::test]
async fn fake_bridge_cancel_returns_to_idle() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut h = Harness::new().await;
    let wt = h.worktree_path.clone();
    let (cmd_tx, session) = h.attach(&wt, "cancel").await;
    cmd_tx
        .send(AcpCommand::Prompt {
            acp_session_id: session.clone(),
            text: "go".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();
    h.next_for(&session, |ev| {
        matches!(
            ev.event,
            Some(proto::amux::acp_event::Event::StatusChange(ref sc))
                if sc.new_status == proto::amux::AgentStatus::Active as i32
        )
    })
    .await;
    cmd_tx
        .send(AcpCommand::Cancel {
            acp_session_id: session.clone(),
        })
        .await
        .unwrap();
    h.next_for(&session, |ev| {
        matches!(
            ev.event,
            Some(proto::amux::acp_event::Event::StatusChange(ref sc))
                if sc.new_status == proto::amux::AgentStatus::Idle as i32
        )
    })
    .await;
}

#[tokio::test]
async fn fake_bridge_set_model_success() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut h = Harness::new().await;
    let wt = h.worktree_path.clone();
    let (cmd_tx, session) = h.attach(&wt, "model").await;
    cmd_tx
        .send(AcpCommand::SetModel {
            acp_session_id: session.clone(),
            model_id: "claude/claude-sonnet".into(),
        })
        .await
        .unwrap();
    cmd_tx
        .send(AcpCommand::Prompt {
            acp_session_id: session.clone(),
            text: "ok".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();
    let text = h.collect_output_until_idle(&session).await;
    assert!(text.contains("echo:ok"));
}

#[tokio::test]
async fn fake_bridge_set_model_failure_keeps_previous_model() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut h = Harness::new().await;
    let wt = h.worktree_path.clone();
    let (cmd_tx, session) = h.attach(&wt, "model-fail").await;
    cmd_tx
        .send(AcpCommand::SetModel {
            acp_session_id: session.clone(),
            model_id: "claude/invalid-model".into(),
        })
        .await
        .unwrap();
    cmd_tx
        .send(AcpCommand::Prompt {
            acp_session_id: session.clone(),
            text: "still-ok".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();
    let text = h.collect_output_until_idle(&session).await;
    assert!(text.contains("echo:still-ok"), "{text}");
}

#[tokio::test]
async fn fake_bridge_crash_allows_fresh_attach() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut h = Harness::new().await;
    let wt = h.worktree_path.clone();
    let (cmd_tx, session) = h.attach(&wt, "crash").await;
    cmd_tx
        .send(AcpCommand::Prompt {
            acp_session_id: session.clone(),
            text: "__crash_bridge__".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();
    h.wait_until_idle(&session).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (_cmd2, session2) = h.attach(&wt, "crash-2").await;
    assert_ne!(session, session2);
}

#[tokio::test]
async fn fake_bridge_crash_marks_old_session_disconnected() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut h = Harness::new().await;
    let wt = h.worktree_path.clone();
    let (cmd_tx, session) = h.attach(&wt, "crash-old").await;
    cmd_tx
        .send(AcpCommand::Prompt {
            acp_session_id: session.clone(),
            text: "__crash_bridge__".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();
    h.wait_until_idle(&session).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    cmd_tx
        .send(AcpCommand::Prompt {
            acp_session_id: session.clone(),
            text: "after-crash".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();
    let err = h.next_error_for(&session).await;
    assert!(
        err.contains("disconnected"),
        "expected disconnected error, got {err}"
    );
}

/// Each bridge process resets session keys to `sess-1`. Composite `(bridge_id,
/// session_key)` routing keeps worktrees isolated.
#[tokio::test]
async fn fake_bridge_two_worktrees_same_local_session_key_stay_isolated() {
    if !node_available() {
        return;
    }
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let path_a = std::fs::canonicalize(dir_a.path()).unwrap().to_string_lossy().into_owned();
    let path_b = std::fs::canonicalize(dir_b.path()).unwrap().to_string_lossy().into_owned();

    let mut h = Harness::new().await;
    let (cmd_a, session_a) = h.attach(&path_a, "iso-a").await;
    let (cmd_b, session_b) = h.attach(&path_b, "iso-b").await;

    cmd_a
        .send(AcpCommand::Prompt {
            acp_session_id: session_a.clone(),
            text: "only-a".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();
    cmd_b
        .send(AcpCommand::Prompt {
            acp_session_id: session_b.clone(),
            text: "only-b".into(),
            attachment_urls: vec![],
            requester_actor_id: None,
            reply_to_message_id: None,
        })
        .await
        .unwrap();

    let text_a = h.collect_output_until_idle(&session_a).await;
    let text_b = h.collect_output_until_idle(&session_b).await;
    assert!(text_a.contains("echo:only-a"));
    assert!(text_b.contains("echo:only-b"));
    assert!(!text_a.contains("only-b"));
    assert!(!text_b.contains("only-a"));
}
