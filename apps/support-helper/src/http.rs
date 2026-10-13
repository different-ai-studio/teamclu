#![cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]

use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build()
}

fn join_url(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

#[derive(Debug)]
pub struct OpenedSession {
    pub id: String,
    pub code: String,
}

#[derive(Debug, Deserialize)]
struct OpenedBody {
    #[serde(rename = "sessionId")]
    session_id: String,
    code: String,
}

#[derive(Debug, Clone)]
pub struct HelperPoll {
    pub status: String,
    pub support_display_name: Option<String>,
    pub conclusion: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PollBody {
    status: String,
    #[serde(rename = "supportDisplayName")]
    support_display_name: Option<String>,
    conclusion: Option<String>,
}

pub fn create_session(api: &str, phase: &str) -> Result<OpenedSession, String> {
    let response = agent()
        .post(&join_url(api, "/v1/support-sessions"))
        .send_json(serde_json::json!({ "phase": phase }))
        .map_err(|err| err.to_string())?;
    let body: OpenedBody = response.into_json().map_err(|err| err.to_string())?;
    Ok(OpenedSession {
        id: body.session_id,
        code: body.code,
    })
}

pub fn poll_session(api: &str, id: &str, code: &str) -> Result<HelperPoll, String> {
    let url = join_url(
        api,
        &format!("/v1/support-sessions/{id}?code={}", urlencoding_min(code)),
    );
    let body: PollBody = agent()
        .get(&url)
        .call()
        .map_err(|err| err.to_string())?
        .into_json()
        .map_err(|err| err.to_string())?;
    Ok(HelperPoll {
        status: body.status,
        support_display_name: body.support_display_name,
        conclusion: body.conclusion,
    })
}

pub fn allow_session(api: &str, id: &str, code: &str) -> Result<(), String> {
    let url = join_url(
        api,
        &format!(
            "/v1/support-sessions/{id}/allow?code={}",
            urlencoding_min(code)
        ),
    );
    agent()
        .post(&url)
        .send_json(serde_json::json!({}))
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn upload_bundle(api: &str, id: &str, code: &str, bundle: &Value) -> Result<(), String> {
    let url = join_url(
        api,
        &format!(
            "/v1/support-sessions/{id}/bundle?code={}",
            urlencoding_min(code)
        ),
    );
    agent()
        .post(&url)
        .send_json(bundle)
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn close_session(api: &str, id: &str, code: &str, reason: &str) -> Result<(), String> {
    let url = join_url(
        api,
        &format!(
            "/v1/support-sessions/{id}/close?code={}",
            urlencoding_min(code)
        ),
    );
    agent()
        .post(&url)
        .send_json(serde_json::json!({ "reason": reason }))
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn urlencoding_min(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
