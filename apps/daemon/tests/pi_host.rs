//! Integration tests for the TeamClu pi multi-session host
//! (`assets/pi-host/host.mjs`), run against the stub pi SDK in
//! `tests/fixtures/pi-host-stub/` — hermetic: no real pi install, no network,
//! no model calls. What is under test is precisely the host's session
//! multiplexing: concurrent turns, per-session event tagging, per-session
//! abort, and the per-session extension UI channel.
//!
//! Requires `node` on PATH; the test skips (passes with a note) when absent so
//! `cargo test -p amuxd` stays green on machines without Node.

#![cfg(unix)]

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

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

struct Host {
    _child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    /// The stub's `getAgentDir()` — where `models.json` is written, so the
    /// auth tests can assert on the file without going near a real `~/.pi`.
    agent_dir: PathBuf,
    _dirs: tempfile::TempDir,
}

impl Host {
    async fn spawn() -> Host {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let host_script = manifest.join("assets/pi-host/host.mjs");
        let stub_package = manifest.join("tests/fixtures/pi-host-stub");
        let dirs = tempfile::tempdir().expect("tempdir");
        let cwd = dirs.path().join("worktree");
        let session_dir = dirs.path().join("sessions");
        let agent_dir = dirs.path().join("agent");
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
            .env("TEAMCLU_PI_STUB_AGENT_DIR", &agent_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn node host.mjs");
        let stdin = child.stdin.take().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut host = Host {
            _child: child,
            stdin,
            lines,
            next_id: 1,
            agent_dir,
            _dirs: dirs,
        };
        let ready = host.next().await;
        assert_eq!(ready["type"], "host_ready", "first line is host_ready");
        host
    }

    async fn send_raw(&mut self, value: serde_json::Value) {
        let mut line = value.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    /// Send a command with a fresh id; returns the id.
    async fn send(&mut self, mut cmd: serde_json::Value) -> String {
        let id = format!("t-{}", self.next_id);
        self.next_id += 1;
        cmd.as_object_mut()
            .unwrap()
            .insert("id".into(), serde_json::json!(id));
        self.send_raw(cmd).await;
        id
    }

    async fn next(&mut self) -> serde_json::Value {
        let line = tokio::time::timeout(READ_TIMEOUT, self.lines.next_line())
            .await
            .expect("host output within timeout")
            .expect("host stdout readable")
            .expect("host stdout still open");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("non-JSON host line ({e}): {line}"))
    }

    /// Read until `pred` matches, returning the matching line and everything
    /// skipped before it.
    async fn wait_for(
        &mut self,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> (serde_json::Value, Vec<serde_json::Value>) {
        let mut skipped = Vec::new();
        loop {
            let line = self.next().await;
            if pred(&line) {
                return (line, skipped);
            }
            skipped.push(line);
        }
    }

    /// Wait for the `{type:"response"}` with this id; asserts success.
    async fn response(&mut self, id: &str) -> (serde_json::Value, Vec<serde_json::Value>) {
        let (resp, skipped) = self
            .wait_for(|l| l["type"] == "response" && l["id"] == id)
            .await;
        assert_eq!(resp["success"], true, "command {id} failed: {resp}");
        (resp, skipped)
    }

    /// Read until `pred` matches, returning every line read including the
    /// match.
    ///
    /// The auth flow needs this rather than [`Self::response`]: pi's login
    /// emits its first `auth_event` / `auth_prompt` *before* the
    /// `auth_login_start` ack, because the flow reaches its first question
    /// while the command handler is still returning. A helper that waits for
    /// one line and discards the rest therefore eats the very events under
    /// test. Collecting lets a test assert on all of them regardless of order.
    async fn read_until(
        &mut self,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> Vec<serde_json::Value> {
        let mut seen = Vec::new();
        loop {
            let line = self.next().await;
            let matched = pred(&line);
            seen.push(line);
            if matched {
                return seen;
            }
        }
    }

    async fn new_session(&mut self) -> String {
        let id = self.send(serde_json::json!({"type": "new_session"})).await;
        let (resp, _) = self.response(&id).await;
        let session_id = resp["data"]["sessionId"].as_str().unwrap().to_string();
        assert!(session_id.starts_with("pi:"), "acp-shaped id: {session_id}");
        session_id
    }
}

fn is_agent_end(line: &serde_json::Value, session: &str) -> bool {
    line["type"] == "agent_end" && line["sessionId"] == session
}

fn delta_text(line: &serde_json::Value, session: &str) -> Option<String> {
    if line["type"] == "message_update"
        && line["sessionId"] == session
        && line["assistantMessageEvent"]["type"] == "text_delta"
    {
        line["assistantMessageEvent"]["delta"]
            .as_str()
            .map(str::to_string)
    } else {
        None
    }
}

/// Acceptance criterion #1 of the multi-session host: three sessions in one
/// worktree prompt at the same time, each reply streams back complete and
/// correctly tagged, none fails with "mid-turn on another session", none
/// hangs. Under `pi --mode rpc` this exact sequence failed for two of the
/// three prompts.
#[tokio::test]
async fn three_sessions_prompt_concurrently_without_cross_talk() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut host = Host::spawn().await;
    let a = host.new_session().await;
    let b = host.new_session().await;
    let c = host.new_session().await;
    assert_ne!(a, b);
    assert_ne!(b, c);

    // B first, and slow — if sessions serialized, B would block A and C.
    let id_b = host
        .send(serde_json::json!({"type": "prompt", "sessionId": b, "message": "slow-b"}))
        .await;
    let id_a = host
        .send(serde_json::json!({"type": "prompt", "sessionId": a, "message": "hello-a"}))
        .await;
    let id_c = host
        .send(serde_json::json!({"type": "prompt", "sessionId": c, "message": "hello-c"}))
        .await;

    // All three prompts are accepted while B is still streaming.
    let mut pending: std::collections::HashSet<String> = [id_a, id_b, id_c].into_iter().collect();
    let mut texts: std::collections::HashMap<String, String> = Default::default();
    let mut end_order: Vec<String> = Vec::new();
    while end_order.len() < 3 {
        let line = host.next().await;
        if line["type"] == "response" {
            let id = line["id"].as_str().unwrap_or_default().to_string();
            assert_eq!(line["success"], true, "prompt rejected: {line}");
            pending.remove(&id);
            continue;
        }
        let session = line["sessionId"].as_str().unwrap_or_default().to_string();
        if line["type"] == "agent_end" {
            end_order.push(session);
            continue;
        }
        for s in [&a, &b, &c] {
            if let Some(delta) = delta_text(&line, s) {
                texts.entry(s.clone()).or_default().push_str(&delta);
            }
        }
    }
    assert!(pending.is_empty(), "all prompt commands acknowledged");
    assert_eq!(texts.get(&a).map(String::as_str), Some("echo:hello-a!"));
    assert_eq!(texts.get(&b).map(String::as_str), Some("echo:slow-b!"));
    assert_eq!(texts.get(&c).map(String::as_str), Some("echo:hello-c!"));
    // The slow session finishes LAST even though its prompt was sent first —
    // the fast sessions ran through it, not behind it.
    assert_eq!(
        end_order.last(),
        Some(&b),
        "slow session must not serialize the others: {end_order:?}"
    );
}

/// Cancelling one session must not disturb the turn running in another —
/// under the single-session protocol, a failed abort killed the whole child
/// and with it every session on the worktree.
#[tokio::test]
async fn abort_is_per_session() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut host = Host::spawn().await;
    let a = host.new_session().await;
    let b = host.new_session().await;

    host.send(serde_json::json!({"type": "prompt", "sessionId": b, "message": "slow-b"}))
        .await;
    host.send(serde_json::json!({"type": "prompt", "sessionId": a, "message": "slow-a"}))
        .await;
    // Wait until B is demonstrably mid-turn (first delta seen), then abort it.
    host.wait_for(|l| delta_text(l, &b).is_some()).await;
    let abort_id = host
        .send(serde_json::json!({"type": "abort", "sessionId": b}))
        .await;
    host.response(&abort_id).await;

    // B settles (agent_end still fires after an abort)…
    host.wait_for(|l| is_agent_end(l, &b)).await;
    // …and A still completes its full reply afterwards.
    let (_, skipped) = host.wait_for(|l| is_agent_end(l, &a)).await;
    let mut a_text = String::new();
    for line in &skipped {
        if let Some(d) = delta_text(line, &a) {
            a_text.push_str(&d);
        }
    }
    // A's deltas may partly precede the abort; only completeness matters —
    // collect the ones seen before too.
    // (Deltas before this wait_for were consumed by earlier waits; re-prompt
    // to assert a clean full turn.)
    let id_a2 = host
        .send(serde_json::json!({"type": "prompt", "sessionId": a, "message": "after"}))
        .await;
    host.response(&id_a2).await;
    let (_, skipped) = host.wait_for(|l| is_agent_end(l, &a)).await;
    let mut text = String::new();
    for line in &skipped {
        if let Some(d) = delta_text(line, &a) {
            text.push_str(&d);
        }
    }
    assert_eq!(text, "echo:after!", "A unaffected by B's abort");
}

/// Extension UI requests carry the raising session's id, and the reply routes
/// back to exactly that session — the "permission dialog goes to the right
/// chat" property (`--mode rpc` guessed the active session and cross-wired).
#[tokio::test]
async fn ui_requests_are_tagged_with_their_session() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut host = Host::spawn().await;
    let a = host.new_session().await;
    let b = host.new_session().await;

    // Only A asks; B just streams.
    host.send(serde_json::json!({"type": "prompt", "sessionId": a, "message": "ask-a"}))
        .await;
    host.send(serde_json::json!({"type": "prompt", "sessionId": b, "message": "plain-b"}))
        .await;

    let (request, _) = host
        .wait_for(|l| l["type"] == "extension_ui_request" && l["method"] == "confirm")
        .await;
    assert_eq!(
        request["sessionId"], a,
        "the confirm belongs to the session that raised it"
    );
    let request_id = request["id"].as_str().unwrap().to_string();
    host.send_raw(serde_json::json!({
        "type": "extension_ui_response", "id": request_id, "confirmed": true
    }))
    .await;

    let (_, skipped) = host.wait_for(|l| is_agent_end(l, &a)).await;
    let mut a_text = String::new();
    for line in &skipped {
        if let Some(d) = delta_text(line, &a) {
            a_text.push_str(&d);
        }
    }
    assert!(
        a_text.starts_with("confirmed:"),
        "the approval reached A's turn: {a_text:?}"
    );
}

/// Session lifecycle plumbing: reopen-is-idempotent, state and commands are
/// per-session, close works, and a missing session file fails an open.
#[tokio::test]
async fn open_state_commands_close_round_trip() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut host = Host::spawn().await;
    let a = host.new_session().await;
    let a_path = a.strip_prefix("pi:").unwrap().to_string();

    // Reopening an already-open session reuses it (no second AgentSession
    // over the same jsonl).
    let id = host
        .send(serde_json::json!({"type": "open_session", "sessionPath": a_path}))
        .await;
    let (resp, _) = host.response(&id).await;
    assert_eq!(resp["data"]["sessionId"], a);
    assert_eq!(resp["data"]["reused"], true);

    let id = host
        .send(serde_json::json!({"type": "get_state", "sessionId": a}))
        .await;
    let (resp, _) = host.response(&id).await;
    assert_eq!(resp["data"]["sessionFile"].as_str(), Some(a_path.as_str()));
    assert_eq!(resp["data"]["isStreaming"], false);

    let id = host
        .send(serde_json::json!({"type": "get_commands", "sessionId": a}))
        .await;
    let (resp, _) = host.response(&id).await;
    let names: Vec<&str> = resp["data"]["commands"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    assert!(names.contains(&"stub-cmd"), "{names:?}");
    assert!(names.contains(&"skill:stub-skill"), "{names:?}");

    let id = host
        .send(serde_json::json!({"type": "get_available_models"}))
        .await;
    let (resp, _) = host.response(&id).await;
    assert_eq!(resp["data"]["models"].as_array().unwrap().len(), 2);

    let id = host
        .send(serde_json::json!({"type": "close_session", "sessionId": a}))
        .await;
    let (resp, _) = host.response(&id).await;
    assert_eq!(resp["data"]["closed"], true);

    // Commands addressed to a closed / unknown session fail cleanly instead of
    // taking the host down.
    let id = host
        .send(serde_json::json!({"type": "get_state", "sessionId": a}))
        .await;
    let (resp, _) = host
        .wait_for(|l| l["type"] == "response" && l["id"] == id)
        .await;
    assert_eq!(resp["success"], false);

    // A vanished session file refuses to open (the daemon's resume fallback
    // depends on this being an error, not a silent new session).
    let id = host
        .send(serde_json::json!({"type": "open_session", "sessionPath": "/nonexistent/x.jsonl"}))
        .await;
    let (resp, _) = host
        .wait_for(|l| l["type"] == "response" && l["id"] == id)
        .await;
    assert_eq!(resp["success"], false);

    // …and the host is still serving afterwards.
    let ping = host.send(serde_json::json!({"type": "ping"})).await;
    host.response(&ping).await;
}

#[tokio::test]
async fn fork_session_branches_jsonl() {
    if !node_available() {
        eprintln!("skip pi_host fork_session: node not on PATH");
        return;
    }
    let mut host = Host::spawn().await;
    let new_id = host
        .send(serde_json::json!({"type": "new_session"}))
        .await;
    let (new_resp, _) = host.response(&new_id).await;
    let parent_path = new_resp["data"]["sessionFile"].as_str().unwrap();
    let prompt_id = host
        .send(serde_json::json!({
            "type": "prompt",
            "sessionId": new_resp["data"]["sessionId"],
            "message": "hello"
        }))
        .await;
    let _ = host.response(&prompt_id).await;
    let (agent_end, _) = host
        .wait_for(|l| l["type"] == "agent_end")
        .await;
    let leaf_id = agent_end["leafId"].as_str().unwrap().to_string();
    let fork_cmd = host
        .send(serde_json::json!({
            "type": "fork_session",
            "parentSessionPath": parent_path,
            "forkLeafId": leaf_id,
        }))
        .await;
    let (fork_resp, _) = host.response(&fork_cmd).await;
    assert_eq!(fork_resp["success"], true);
    let fork_path = fork_resp["data"]["sessionFile"].as_str().unwrap();
    assert_ne!(fork_path, parent_path);
    assert!(fork_resp["data"]["sessionId"]
        .as_str()
        .unwrap()
        .starts_with("pi:"));
    // The branch has to be cut *at* the leaf, not merely be a new file: the
    // host opens the parent from disk and slices its entries, so a fork that
    // silently produced an empty session would satisfy everything above.
    assert_eq!(
        fork_resp["data"]["leafId"].as_str(),
        Some(leaf_id.as_str()),
        "fork should end on the leaf it branched from"
    );
    let forked = std::fs::read_to_string(fork_path).unwrap();
    assert!(
        forked.contains("echo:hello!"),
        "fork should carry the parent turn: {forked}"
    );
}

// ─── Provider auth (`pi /login`) ─────────────────────────────────────────────
//
// The host's job in a login is to project pi's `AuthInteraction` — a
// `prompt()` that returns a string and a `notify()` that reports progress —
// onto the JSONL wire, and to answer it from the other side. These tests drive
// that contract end to end against the stub, which implements `login` the way
// a real provider does: publish a URL, then ask for the code.

/// The whole login round trip: ack, provider events, the prompt, the answer,
/// and a terminal `auth_login_end` — with the credential visible afterwards.
///
/// This is the sequence a browser OAuth login reduces to on the wire, so if it
/// holds, `openai-codex` / `anthropic` / `openrouter` hold too: none of the
/// per-provider detail lives here.
#[tokio::test]
async fn an_oauth_login_publishes_a_url_asks_for_the_code_and_finishes() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut host = Host::spawn().await;

    let id = host
        .send(serde_json::json!({
            "type": "auth_login_start",
            "loginId": "L1",
            "providerId": "stub-oauth",
            "authType": "oauth",
        }))
        .await;

    // Both orders are legal and both occur: a provider whose login reaches its
    // first question synchronously (this stub, and pi's real `openai-codex`)
    // emits the prompt before the command handler returns its ack, while one
    // that awaits the network first acks earlier. Read to the ack, then to the
    // prompt if it has not already gone by.
    let mut opening = host
        .read_until(|l| l["type"] == "response" && l["id"] == id.as_str())
        .await;
    if !opening.iter().any(|l| l["type"] == "auth_prompt") {
        opening.extend(host.read_until(|l| l["type"] == "auth_prompt").await);
    }

    // The ack must not wait for the login to finish: a browser round trip
    // outlives the client's 30s request timeout, and a timed-out request would
    // abandon a flow pi is still running.
    let ack = opening
        .iter()
        .find(|l| l["type"] == "response" && l["id"] == id.as_str())
        .expect("auth_login_start acked");
    assert_eq!(ack["success"], true, "{ack}");

    let event = opening
        .iter()
        .find(|l| l["type"] == "auth_event")
        .expect("provider published an auth event");
    assert_eq!(event["loginId"], "L1");
    assert_eq!(event["event"]["type"], "auth_url");
    assert_eq!(event["event"]["url"], "https://stub.example/authorize");

    let prompt = opening
        .iter()
        .find(|l| l["type"] == "auth_prompt")
        .expect("login asked for the code");
    assert_eq!(prompt["prompt"]["type"], "manual_code");
    // The AbortSignal on pi's AuthPrompt is not serializable and must be
    // stripped rather than crashing the JSON encode.
    assert!(prompt["prompt"].get("signal").is_none(), "{prompt}");
    let prompt_id = prompt["promptId"].as_str().unwrap().to_string();

    host.send_raw(serde_json::json!({
        "type": "auth_prompt_response",
        "loginId": "L1",
        "promptId": prompt_id,
        "value": "code-from-the-browser",
    }))
    .await;

    let end = host
        .read_until(|l| l["type"] == "auth_login_end")
        .await
        .pop()
        .unwrap();
    assert_eq!(end["success"], true, "{end}");
    assert_eq!(end["providerId"], "stub-oauth");

    let list = host.send(serde_json::json!({"type": "auth_list"})).await;
    let (resp, _) = host.response(&list).await;
    let provider = resp["data"]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "stub-oauth")
        .expect("stub-oauth listed")
        .clone();
    assert_eq!(provider["configured"], true, "{provider}");
    assert_eq!(provider["credentialType"], "oauth");
}

/// Cancelling must settle the flow rather than leaving it parked on a prompt
/// nobody will answer — the host has to reject the pending prompt itself, since
/// aborting the interaction signal does not settle a promise the host created.
#[tokio::test]
async fn cancelling_a_login_ends_it() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut host = Host::spawn().await;
    host.send(serde_json::json!({
        "type": "auth_login_start",
        "loginId": "L2",
        "providerId": "stub",
        "authType": "api_key",
    }))
    .await;
    host.read_until(|l| l["type"] == "auth_prompt").await;

    host.send(serde_json::json!({"type": "auth_login_cancel", "loginId": "L2"}))
        .await;

    let end = host
        .read_until(|l| l["type"] == "auth_login_end")
        .await
        .pop()
        .unwrap();
    assert_eq!(end["success"], false, "{end}");
    assert_eq!(end["error"], "Login cancelled");
}

/// Ambient-only providers (an AWS profile, Vertex ADC) have no `login` on their
/// api-key auth. Handing one to `ModelRuntime.login` produces a flow that emits
/// nothing and never ends, so the host refuses it up front and the caller gets
/// a real error instead of a spinner.
#[tokio::test]
async fn a_provider_without_interactive_login_is_refused() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut host = Host::spawn().await;
    let id = host
        .send(serde_json::json!({
            "type": "auth_login_start",
            "loginId": "L3",
            "providerId": "stub-ambient",
            "authType": "api_key",
        }))
        .await;
    let (resp, _) = host
        .wait_for(|l| l["type"] == "response" && l["id"] == id.as_str())
        .await;
    assert_eq!(resp["success"], false, "{resp}");
    assert!(
        resp["error"].as_str().unwrap().contains("does not support"),
        "{resp}"
    );
    // `auth_list` is what the UI uses to decide whether to offer a key field.
    let list = host.send(serde_json::json!({"type": "auth_list"})).await;
    let (list_resp, _) = host.response(&list).await;
    let ambient = list_resp["data"]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "stub-ambient")
        .expect("listed");
    assert_eq!(ambient["methods"][0]["canLogin"], false, "{ambient}");
}

/// `models.json` is edited by read-modify-write, not rewritten: the provider
/// under edit is replaced and everything else in the document — other
/// providers, keys the UI has no field for, top-level settings — survives.
///
/// This is the difference between editing one provider and silently discarding
/// a hand-written config.
#[tokio::test]
async fn custom_provider_writes_preserve_the_rest_of_models_json() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut host = Host::spawn().await;
    let models_json = host.agent_dir.join("models.json");
    std::fs::create_dir_all(&host.agent_dir).unwrap();
    std::fs::write(
        &models_json,
        serde_json::json!({
            "providers": {
                "hand-written": {"baseUrl": "http://kept", "modelOverrides": {"a": {"cost": 1}}}
            },
            "someTopLevelKey": 42,
        })
        .to_string(),
    )
    .unwrap();

    let put = host
        .send(serde_json::json!({
            "type": "auth_models_put",
            "providerId": "ollama",
            "provider": {
                "baseUrl": "http://localhost:11434/v1",
                "api": "openai-completions",
                "apiKey": "ollama",
                "models": [{"id": "llama3.1:8b"}],
            },
        }))
        .await;
    host.response(&put).await;

    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&models_json).unwrap()).unwrap();
    assert_eq!(doc["someTopLevelKey"], 42, "top-level key kept: {doc}");
    assert_eq!(doc["providers"]["hand-written"]["baseUrl"], "http://kept");
    assert_eq!(
        doc["providers"]["hand-written"]["modelOverrides"]["a"]["cost"],
        1,
        "unmodelled provider keys kept: {doc}"
    );
    assert_eq!(doc["providers"]["ollama"]["apiKey"], "ollama");

    // The read path is the same document, so the UI sees what is on disk.
    let get = host.send(serde_json::json!({"type": "auth_models_get"})).await;
    let (resp, _) = host.response(&get).await;
    assert_eq!(resp["data"]["providers"]["ollama"]["api"], "openai-completions");
    assert!(resp["data"]["path"].as_str().unwrap().ends_with("models.json"));

    // Deleting removes only that provider.
    let del = host
        .send(serde_json::json!({"type": "auth_models_delete", "providerId": "ollama"}))
        .await;
    host.response(&del).await;
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&models_json).unwrap()).unwrap();
    assert!(doc["providers"].get("ollama").is_none(), "{doc}");
    assert_eq!(doc["providers"]["hand-written"]["baseUrl"], "http://kept");
    assert_eq!(doc["someTopLevelKey"], 42);
}

/// `/logout` drops the stored credential, and the listing reflects it — the
/// signal the settings pane uses to move a provider back to "available".
#[tokio::test]
async fn logout_clears_the_stored_credential() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let mut host = Host::spawn().await;
    host.send(serde_json::json!({
        "type": "auth_login_start",
        "loginId": "L4",
        "providerId": "stub",
        "authType": "api_key",
    }))
    .await;
    let prompt = host
        .read_until(|l| l["type"] == "auth_prompt")
        .await
        .pop()
        .unwrap();
    assert_eq!(prompt["prompt"]["type"], "secret", "{prompt}");
    host.send_raw(serde_json::json!({
        "type": "auth_prompt_response",
        "loginId": "L4",
        "promptId": prompt["promptId"],
        "value": "sk-test",
    }))
    .await;
    let end = host
        .read_until(|l| l["type"] == "auth_login_end")
        .await
        .pop()
        .unwrap();
    assert_eq!(end["success"], true, "{end}");

    let out = host
        .send(serde_json::json!({"type": "auth_logout", "providerId": "stub"}))
        .await;
    host.response(&out).await;

    let list = host.send(serde_json::json!({"type": "auth_list"})).await;
    let (resp, _) = host.response(&list).await;
    let provider = resp["data"]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "stub")
        .expect("listed")
        .clone();
    assert_eq!(provider["configured"], false, "{provider}");
}
