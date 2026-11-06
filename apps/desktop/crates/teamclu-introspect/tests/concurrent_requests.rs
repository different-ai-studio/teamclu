use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

fn reply_to_desktop_request(mut stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut content_length = 0;
    let mut line = String::new();
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length: ") {
            content_length = value.trim().parse().unwrap();
        }
    }
    let mut body = vec![0; content_length];
    reader.read_exact(&mut body).unwrap();
    let action = serde_json::from_slice::<Value>(&body).unwrap()["action"]
        .as_str()
        .unwrap()
        .to_string();
    if action == "status" {
        thread::sleep(Duration::from_millis(350));
    }
    let response = json!({"action": action, "app": {"id": "fixture"}}).to_string();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response.len(),
        response
    )
    .unwrap();
    stream.flush().unwrap();
}

#[test]
fn recovery_read_completes_before_a_blocked_tool_call() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let mut handlers = Vec::new();
        for _ in 0..2 {
            let (stream, _) = listener.accept().unwrap();
            handlers.push(thread::spawn(move || reply_to_desktop_request(stream)));
        }
        for handler in handlers {
            handler.join().unwrap();
        }
    });

    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    std::fs::create_dir(&run).unwrap();
    std::fs::write(run.join("introspect.http.token"), "synthetic-test-token").unwrap();
    std::fs::write(run.join("introspect.http.port"), port.to_string()).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_teamclu-introspect"))
        .arg("--workspace")
        .arg(home.path())
        .env("AMUXD_HOME", home.path())
        .env_remove("http_proxy")
        .env_remove("https_proxy")
        .env_remove("all_proxy")
        .env_remove("HTTP_PROXY")
        .env_remove("HTTPS_PROXY")
        .env_remove("ALL_PROXY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.as_mut().unwrap();
    for (id, action) in [(1, "status"), (2, "deploy_status")] {
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"manage_app","arguments":{"action":action,"app_id":"fixture"}}})
        )
        .unwrap();
    }
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    server.join().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["id"], 2, "recovery read waited behind the slow request");
    assert_eq!(replies[1]["id"], 1);
}
