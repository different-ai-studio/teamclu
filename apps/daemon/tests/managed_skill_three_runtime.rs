//! Three-runtime managed skill discovery through real adapter boundaries:
//! OpenCode session inventory (`scan_roles_skills_state`), Pi `get_commands`
//! (`commands_from_get_commands_response`), Claude bridge `slash_commands`
//! (`available_commands_from_slash_commands_event` via ACP AvailableCommands).

#![cfg(unix)]

include!("support/crate_modules.rs");

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use config::{
    create_pack, find_managed_skill_in_session_inventory, pack_digest, ClaimedTeamContext,
    CreatePackRequest,
};
use runtime::acp_event_frame::AcpEventFrame;
use runtime::backend::AgentBackend;
use runtime::claude_agent::{available_commands_from_slash_commands_event, ClaudeAgentBackend};
use runtime::execution_context::{IsolationDomainKey, ProcessEnvRevision};
use runtime::permission_policy::PermissionPolicy;
use runtime::pi_rpc::commands_from_get_commands_response;
use runtime::AgentLaunchConfig;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::mpsc;

const READ_TIMEOUT: Duration = Duration::from_secs(10);
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

fn register_runtime_skill_paths(workspace: &Path, home: &Path, agents_root: &Path) {
    let agents = agents_root.to_string_lossy();
    std::fs::write(
        workspace.join("opencode.json"),
        format!(r#"{{"skills":{{"paths":["{}"]}}}}"#, agents),
    )
    .unwrap();
    let claude_settings = workspace.join(".claude/settings.json");
    std::fs::create_dir_all(claude_settings.parent().unwrap()).unwrap();
    std::fs::write(
        &claude_settings,
        format!(r#"{{"skills":{{"paths":["{}"]}}}}"#, agents),
    )
    .unwrap();
}

fn create_managed_skill_pack(
    workspace: &Path,
    home: &Path,
    slug: &str,
    body: &str,
) -> config::ManageSkillResponse {
    std::fs::create_dir_all(home.join(".agents/skills")).unwrap();
    register_runtime_skill_paths(workspace, home, &home.join(".agents/skills"));
    let req = CreatePackRequest {
        slug: slug.into(),
        content: body.into(),
        files: vec![],
    };
    let resp = create_pack(workspace, home, &req, &ClaimedTeamContext::NoTeam).unwrap();
    runtime::claude_skills::reconcile_after_managed_mutation(workspace, slug, Path::new(&resp.path))
        .unwrap();
    runtime::supervisor::prepare_workspace(workspace).unwrap();
    resp
}

struct PiHost {
    _child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl PiHost {
    async fn spawn_with_agents_skills_root(agents_root: &Path) -> Self {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let host_script = manifest.join("assets/pi-host/host.mjs");
        let stub_package = manifest.join("tests/fixtures/pi-host-stub");
        let dirs = tempfile::tempdir().expect("tempdir");
        let cwd = dirs.path().join("worktree");
        let session_dir = dirs.path().join("sessions");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&session_dir).unwrap();

        let mut child = tokio::process::Command::new("node")
            .arg(&host_script)
            .arg("--pi-package")
            .arg(&stub_package)
            .arg("--cwd")
            .arg(&cwd)
            .arg("--session-dir")
            .arg(&session_dir)
            .env(
                "TEAMCLU_PI_STUB_SKILLS_ROOT",
                agents_root.to_string_lossy().as_ref(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn pi host");
        let stdin = child.stdin.take().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut host = Self {
            _child: child,
            stdin,
            lines,
            next_id: 1,
        };
        let ready = host.next_line().await;
        assert_eq!(ready["type"], "host_ready");
        host
    }

    async fn send(&mut self, mut cmd: serde_json::Value) -> String {
        let id = format!("t-{}", self.next_id);
        self.next_id += 1;
        cmd.as_object_mut()
            .unwrap()
            .insert("id".into(), serde_json::json!(id));
        let mut line = cmd.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.flush().await.unwrap();
        id
    }

    async fn next_line(&mut self) -> serde_json::Value {
        let line = tokio::time::timeout(READ_TIMEOUT, self.lines.next_line())
            .await
            .expect("host output within timeout")
            .expect("host stdout readable")
            .expect("host stdout still open");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("non-JSON host line ({e}): {line}"))
    }

    async fn response(&mut self, id: &str) -> serde_json::Value {
        loop {
            let line = self.next_line().await;
            if line["type"] == "response" && line["id"] == id {
                assert_eq!(line["success"], true, "command {id} failed: {line}");
                return line;
            }
        }
    }

    async fn new_session(&mut self) -> String {
        let id = self.send(serde_json::json!({"type": "new_session"})).await;
        let resp = self.response(&id).await;
        resp["data"]["sessionId"]
            .as_str()
            .expect("session id")
            .to_string()
    }

    async fn get_commands_response(&mut self, session_id: &str) -> serde_json::Value {
        let id = self
            .send(serde_json::json!({"type": "get_commands", "sessionId": session_id}))
            .await;
        self.response(&id).await
    }
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

struct ClaudeHarness {
    backend: ClaudeAgentBackend,
    event_tx: mpsc::Sender<AcpEventFrame>,
    event_rx: mpsc::Receiver<AcpEventFrame>,
    worktree_path: String,
}

impl ClaudeHarness {
    async fn new(worktree: &Path) -> Self {
        let worktree_path = std::fs::canonicalize(worktree)
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
            worktree_path,
        }
    }

    async fn attach(&mut self, teamclu_session_id: &str) -> String {
        let domain = IsolationDomainKey::Workspace(self.worktree_path.clone());
        let revision = ProcessEnvRevision::from_bindings(&std::collections::HashMap::new());
        let meta = self
            .backend
            .attach_session(
                proto::amux::AgentType::ClaudeCode,
                &AgentLaunchConfig::new("claude", vec![], "claude"),
                domain,
                revision,
                std::collections::HashMap::new(),
                false,
                self.worktree_path.clone(),
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
            .expect("attach_session")
            .1;
        meta.acp_session_id
    }

    async fn wait_for_available_commands(&mut self, session_id: &str) -> Vec<proto::amux::AcpAvailableCommand> {
        let deadline = tokio::time::Instant::now() + EVENT_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let frame = tokio::time::timeout(remaining, self.event_rx.recv())
                .await
                .expect("event within timeout")
                .expect("event channel open");
            if frame.acp_session_id != session_id {
                continue;
            }
            if let Some(proto::amux::acp_event::Event::AvailableCommands(cmds)) =
                frame.event.event
            {
                return cmds.commands;
            }
        }
    }
}

#[tokio::test]
async fn managed_skill_discovered_by_pi_opencode_and_claude_adapters() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }

    let lock = config::global_team_store::TEST_HOME_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    let workspace = tempfile::tempdir().unwrap();

    let slug = "cross-runtime";
    let body = "---\nname: cross-runtime\ndescription: Shared.\n---\n\n# Shared body\n";
    let created =
        create_managed_skill_pack(workspace.path(), home.path(), slug, body);

    // OpenCode session inventory boundary (production `list_skills` scan).
    let inventory = find_managed_skill_in_session_inventory(workspace.path(), slug)
        .unwrap()
        .expect("OpenCode inventory should include the managed skill");
    let inventory_pack = Path::new(&inventory.dir_path).join(&inventory.filename);
    let inventory_digest = pack_digest(&inventory_pack).unwrap();
    assert_eq!(inventory.filename, slug);
    assert_eq!(inventory_digest, created.digest);

    // Pi adapter boundary: host `get_commands` → production parser.
    let mut pi_host =
        PiHost::spawn_with_agents_skills_root(&home.path().join(".agents/skills")).await;
    let session_id = pi_host.new_session().await;
    let get_commands = pi_host.get_commands_response(&session_id).await;
    let pi_commands = commands_from_get_commands_response(&get_commands);
    assert!(
        pi_commands
            .iter()
            .any(|cmd| cmd.name == "skill:cross-runtime"),
        "Pi get_commands should advertise the skill: {pi_commands:?}"
    );

    // Claude adapter boundary: bridge slash_commands → ACP AvailableCommands.
    let mut claude = ClaudeHarness::new(workspace.path()).await;
    let acp_session = claude.attach("tc-cross-runtime").await;
    let claude_commands = claude.wait_for_available_commands(&acp_session).await;
    assert!(
        claude_commands.iter().any(|cmd| cmd.name == "cross-runtime"),
        "Claude bridge should advertise the project skill: {claude_commands:?}"
    );

    // Production slash_commands parser (same path as `emit_slash_commands`).
    let bridge_event = serde_json::json!({
        "commands": [{
            "name": "cross-runtime",
            "description": "Shared.",
            "inputHint": "",
        }],
    });
    let parsed = available_commands_from_slash_commands_event(&bridge_event);
    assert!(parsed.iter().any(|cmd| cmd.name == "cross-runtime"));

    drop(lock);
}
