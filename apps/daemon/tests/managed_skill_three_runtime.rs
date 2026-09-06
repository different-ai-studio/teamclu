//! Pi managed skill discovery through real adapter boundaries:
//! OpenCode session inventory (`scan_roles_skills_state`) and Pi `get_commands`
//! (`commands_from_get_commands_response`).

#![cfg(unix)]

include!("support/crate_modules.rs");

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use config::{
    create_pack, find_managed_skill_in_session_inventory, pack_digest, ClaimedTeamContext,
    CreatePackRequest,
};
use runtime::pi_rpc::commands_from_get_commands_response;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

const READ_TIMEOUT: Duration = Duration::from_secs(10);

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
    runtime::skills_bridge::reconcile_after_managed_mutation(workspace, slug, Path::new(&resp.path))
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
    async fn spawn_with_skills_root(skills_root: &Path) -> Self {
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
            .env("TEAMCLU_PI_STUB_SKILLS_ROOT", skills_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn pi-host");

        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let lines = BufReader::new(stdout).lines();

        let mut host = Self {
            _child: child,
            stdin,
            lines,
            next_id: 1,
        };
        let ready = host.next_line().await;
        assert_eq!(ready["type"], "host_ready", "first line is host_ready");
        host
    }

    async fn next_line(&mut self) -> serde_json::Value {
        let line = tokio::time::timeout(READ_TIMEOUT, self.lines.next_line())
            .await
            .expect("read within timeout")
            .expect("line")
            .expect("non-empty line");
        serde_json::from_str(&line).expect("json line")
    }

    async fn send(&mut self, mut cmd: serde_json::Value) -> String {
        let id = format!("req-{}", self.next_id);
        self.next_id += 1;
        cmd.as_object_mut()
            .unwrap()
            .insert("id".into(), serde_json::json!(id));
        let mut line = cmd.to_string();
        line.push('\n');
        tokio::time::timeout(READ_TIMEOUT, self.stdin.write_all(line.as_bytes()))
            .await
            .expect("write within timeout")
            .expect("write");
        id
    }

    async fn response(&mut self, id: &str) -> serde_json::Value {
        loop {
            let v = self.next_line().await;
            if v["id"].as_str() == Some(id) && v["type"] == "response" {
                assert_eq!(v["success"], true, "command {id} failed: {v}");
                return v;
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

#[tokio::test]
async fn managed_skill_discovered_by_pi_adapters() {
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

    // Session inventory boundary (production `list_skills` scan).
    let inventory = find_managed_skill_in_session_inventory(workspace.path(), slug)
        .unwrap()
        .expect("session inventory should include the managed skill");
    let inventory_pack = Path::new(&inventory.dir_path).join(&inventory.filename);
    let inventory_digest = pack_digest(&inventory_pack).unwrap();
    assert_eq!(inventory.filename, slug);
    assert_eq!(inventory_digest, created.digest);

    // Pi adapter boundary: host `get_commands` → production parser.
    let skills_root = home.path().join(".agents/skills");
    let mut pi_host = PiHost::spawn_with_skills_root(&skills_root).await;
    let session_id = pi_host.new_session().await;
    let get_commands = pi_host.get_commands_response(&session_id).await;
    let pi_commands = commands_from_get_commands_response(&get_commands);
    assert!(
        pi_commands
            .iter()
            .any(|cmd| cmd.name == "skill:cross-runtime"),
        "Pi get_commands should advertise the skill: {pi_commands:?}"
    );

    drop(lock);
}
