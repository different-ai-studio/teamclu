//! Thin reqwest call layer over the `opencode serve` HTTP API.
//!
//! All session endpoints are scoped by `?directory=<canonical worktree>`;
//! auth is HTTP Basic with username `opencode` and the supervisor-generated
//! `OPENCODE_SERVER_PASSWORD`.

use serde::Serialize;
use std::time::Duration;

use crate::proto::amux;

const BASIC_AUTH_USER: &str = "opencode";

/// opencode `SessionStatus.type` collapsed for turn-boundary decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpencodeSessionPhase {
    Idle,
    Running,
    Unknown,
}

#[derive(Clone)]
pub struct ServeClient {
    http: reqwest::Client,
    base: String,
    password: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptModel {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PromptPart {
    Text {
        text: String,
    },
    File {
        mime: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
    },
}

#[derive(Debug, Serialize)]
pub struct PromptBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<PromptModel>,
    pub parts: Vec<PromptPart>,
}

impl ServeClient {
    pub fn new(base: String, password: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        Self {
            http,
            base,
            password,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub fn password(&self) -> &str {
        &self.password
    }

    fn req(&self, method: reqwest::Method, path: &str, directory: &str) -> reqwest::RequestBuilder {
        let mut rb = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .basic_auth(BASIC_AUTH_USER, Some(&self.password));
        if !directory.is_empty() {
            rb = rb.query(&[("directory", directory)]);
        }
        rb
    }

    async fn check(resp: reqwest::Response, what: &str) -> crate::error::Result<reqwest::Response> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let body = resp.text().await.unwrap_or_default();
        Err(crate::error::AmuxError::Agent(format!(
            "opencode serve {what} failed: HTTP {status}: {}",
            body.chars().take(500).collect::<String>()
        )))
    }

    /// Health probe (no auth-sensitive payload; used by the supervisor).
    pub async fn health(&self) -> bool {
        self.req(reqwest::Method::GET, "/global/health", "")
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// POST /session → new session id.
    pub async fn create_session(&self, directory: &str) -> crate::error::Result<String> {
        let resp = self
            .req(reqwest::Method::POST, "/session", directory)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("create session: {e}")))?;
        let resp = Self::check(resp, "create session").await?;
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("create session body: {e}")))?;
        body.get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| {
                crate::error::AmuxError::Agent("create session: no id in response".into())
            })
    }

    /// POST /instance/dispose — drop the cached instance for `directory` so the
    /// next request re-reads config (including OPENCODE_CONFIG). Does not kill
    /// the global serve process. 404 means nothing was cached.
    pub async fn dispose_instance(&self, directory: &str) -> crate::error::Result<()> {
        let resp = self
            .req(reqwest::Method::POST, "/instance/dispose", directory)
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("dispose instance: {e}")))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        let _ = Self::check(resp, "dispose instance").await?;
        Ok(())
    }

    /// GET /session/{id} → the session object, or `None` when opencode has no
    /// such session (404).
    ///
    /// Doubles as the resume check and as the source of the session's
    /// persisted `model` — opencode stores the last model a session ran on in
    /// its own `session.model` column, which survives daemon restarts. See
    /// [`session_model_id`].
    pub async fn get_session(
        &self,
        directory: &str,
        session_id: &str,
    ) -> crate::error::Result<Option<serde_json::Value>> {
        let resp = self
            .req(
                reqwest::Method::GET,
                &format!("/session/{session_id}"),
                directory,
            )
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("get session: {e}")))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let resp = Self::check(resp, "get session").await?;
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("get session body: {e}")))?;
        Ok(Some(body))
    }

    /// POST /session/{id}/prompt_async (204; completion arrives via SSE
    /// `session.idle`).
    pub async fn prompt_async(
        &self,
        directory: &str,
        session_id: &str,
        body: &PromptBody,
    ) -> crate::error::Result<()> {
        let resp = self
            .req(
                reqwest::Method::POST,
                &format!("/session/{session_id}/prompt_async"),
                directory,
            )
            .json(body)
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("prompt_async: {e}")))?;
        Self::check(resp, "prompt_async").await.map(|_| ())
    }

    /// GET /session/{id}/message → the session's persisted messages
    /// (`[{info, parts}, …]`, oldest first). Used to reconcile a turn after
    /// an SSE gap: the event stream has no replay, so lost tail parts and a
    /// missed `session.idle` are recovered from this snapshot instead.
    pub async fn session_messages(
        &self,
        directory: &str,
        session_id: &str,
    ) -> crate::error::Result<Vec<serde_json::Value>> {
        let resp = self
            .req(
                reqwest::Method::GET,
                &format!("/session/{session_id}/message"),
                directory,
            )
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("session messages: {e}")))?;
        let resp = Self::check(resp, "session messages").await?;
        resp.json()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("session messages body: {e}")))
    }

    /// GET /session/status → map of session id to current status
    /// (`{"ses_x": {"type": "retry", "message": …, "next": …}}`). The only
    /// reliable way to observe provider-retry state: the SSE `session.status`
    /// event fires once at retry entry and is lost if the subscription is
    /// (re)connecting at that moment. Official desktop polls this snapshot.
    pub async fn session_status(&self, directory: &str) -> crate::error::Result<serde_json::Value> {
        let resp = self
            .req(reqwest::Method::GET, "/session/status", directory)
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("session status: {e}")))?;
        let resp = Self::check(resp, "session status").await?;
        resp.json()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("session status body: {e}")))
    }

    /// Classify one session's `SessionStatus` object from `/session/status`.
    pub fn session_phase_from_status(status: &serde_json::Value) -> OpencodeSessionPhase {
        match status.get("type").and_then(|v| v.as_str()) {
            Some("idle") => OpencodeSessionPhase::Idle,
            Some("busy") | Some("retry") => OpencodeSessionPhase::Running,
            _ => OpencodeSessionPhase::Unknown,
        }
    }

    /// Look up `session_id` in a `/session/status` response map.
    pub fn session_phase_from_map(map: &serde_json::Value, session_id: &str) -> OpencodeSessionPhase {
        map.get(session_id)
            .map(Self::session_phase_from_status)
            .unwrap_or(OpencodeSessionPhase::Unknown)
    }

    /// GET /question → all pending question requests (across sessions).
    pub async fn question_list(
        &self,
        directory: &str,
    ) -> crate::error::Result<Vec<serde_json::Value>> {
        let resp = self
            .req(reqwest::Method::GET, "/question", directory)
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("question list: {e}")))?;
        let resp = Self::check(resp, "question list").await?;
        resp.json()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("question list body: {e}")))
    }

    /// POST /question/{requestID}/reply with `{"answers": [[labels], ...]}`.
    pub async fn question_reply(
        &self,
        directory: &str,
        request_id: &str,
        answers: &serde_json::Value,
    ) -> crate::error::Result<()> {
        let resp = self
            .req(
                reqwest::Method::POST,
                &format!("/question/{request_id}/reply"),
                directory,
            )
            .json(&serde_json::json!({ "answers": answers }))
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("question reply: {e}")))?;
        Self::check(resp, "question reply").await.map(|_| ())
    }

    /// POST /question/{requestID}/reject.
    pub async fn question_reject(
        &self,
        directory: &str,
        request_id: &str,
    ) -> crate::error::Result<()> {
        let resp = self
            .req(
                reqwest::Method::POST,
                &format!("/question/{request_id}/reject"),
                directory,
            )
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("question reject: {e}")))?;
        Self::check(resp, "question reject").await.map(|_| ())
    }

    /// POST /session/{id}/abort.
    pub async fn abort(&self, directory: &str, session_id: &str) -> crate::error::Result<()> {
        let resp = self
            .req(
                reqwest::Method::POST,
                &format!("/session/{session_id}/abort"),
                directory,
            )
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("abort: {e}")))?;
        Self::check(resp, "abort").await.map(|_| ())
    }

    /// POST /session/{id}/permissions/{permissionID} with
    /// `{"response": "once" | "always" | "reject"}`.
    pub async fn permission_respond(
        &self,
        directory: &str,
        session_id: &str,
        permission_id: &str,
        response: &str,
    ) -> crate::error::Result<()> {
        let resp = self
            .req(
                reqwest::Method::POST,
                &format!("/session/{session_id}/permissions/{permission_id}"),
                directory,
            )
            .json(&serde_json::json!({ "response": response }))
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("permission respond: {e}")))?;
        Self::check(resp, "permission respond").await.map(|_| ())
    }

    /// GET /config → the effective config for a directory (used for the
    /// default `model` of new sessions, shape `provider/model`).
    pub async fn config_default_model(&self, directory: &str) -> Option<String> {
        let resp = self
            .req(reqwest::Method::GET, "/config", directory)
            .send()
            .await
            .ok()?;
        let body: serde_json::Value = resp.json().await.ok()?;
        body.get("model")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }

    /// GET /config/providers → flattened model catalog (`provider/model` ids).
    pub async fn model_catalog(
        &self,
        directory: &str,
    ) -> crate::error::Result<Vec<amux::ModelInfo>> {
        let resp = self
            .req(reqwest::Method::GET, "/config/providers", directory)
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("providers: {e}")))?;
        let resp = Self::check(resp, "providers").await?;
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("providers body: {e}")))?;
        Ok(models_from_providers(&body))
    }

    /// GET /event?directory=… as a streaming SSE response (no timeout).
    pub async fn event_stream(&self, directory: &str) -> crate::error::Result<reqwest::Response> {
        let resp = self
            .req(reqwest::Method::GET, "/event", directory)
            .timeout(Duration::from_secs(u64::MAX / 4))
            .send()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("event stream: {e}")))?;
        Self::check(resp, "event stream").await
    }
}

/// Flatten a `/config/providers` response into `amux::ModelInfo`s with
/// `provider/model` ids (the id shape the clients and manager already use).
pub fn models_from_providers(body: &serde_json::Value) -> Vec<amux::ModelInfo> {
    let mut out = Vec::new();
    let Some(providers) = body.get("providers").and_then(|v| v.as_array()) else {
        return out;
    };
    for provider in providers {
        let pid = provider.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if pid.is_empty() {
            continue;
        }
        let provider_name = provider
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(pid);
        let Some(models) = provider.get("models").and_then(|v| v.as_object()) else {
            continue;
        };
        for (mid, model) in models {
            let name = model
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(mid);
            out.push(amux::ModelInfo {
                id: format!("{pid}/{mid}"),
                display_name: name.to_string(),
                provider_name: provider_name.to_string(),
            });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Split a `provider/model` id on the FIRST `/` into `(providerID, modelID)`.
pub fn split_model_id(model_id: &str) -> Option<PromptModel> {
    let (provider, model) = model_id.split_once('/')?;
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    Some(PromptModel {
        provider_id: provider.to_string(),
        model_id: model.to_string(),
    })
}

/// Pull the `provider/model` id out of a `GET /session/{id}` body.
///
/// opencode stores the session's last-used model as
/// `{"id": "big-pickle", "providerID": "opencode", "variant": "default"}`;
/// this rejoins it into the flat id shape the manager and clients use. A
/// freshly-created session has no model yet, hence `Option`.
///
/// Read on the resume path: a conversation we re-attach to keeps running on
/// whatever it ran on before, and opencode is the only one who knows what that
/// was. (This is not the retired MRU hook — ADR-0007 removed
/// `AgentBackend::session_model`, which asked the same question in order to
/// teach a device-wide preference. Recovering one session's own model is a
/// fact about that session.)
pub fn session_model_id(session: &serde_json::Value) -> Option<String> {
    let model = session.get("model")?;
    let provider = model.get("providerID").and_then(|v| v.as_str())?;
    let id = model.get("id").and_then(|v| v.as_str())?;
    if provider.is_empty() || id.is_empty() {
        return None;
    }
    Some(format!("{provider}/{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_phase_from_status_classifies_idle_busy_retry() {
        assert_eq!(
            ServeClient::session_phase_from_status(&serde_json::json!({"type":"idle"})),
            OpencodeSessionPhase::Idle
        );
        assert_eq!(
            ServeClient::session_phase_from_status(&serde_json::json!({"type":"busy"})),
            OpencodeSessionPhase::Running
        );
        assert_eq!(
            ServeClient::session_phase_from_status(&serde_json::json!({
                "type":"retry","attempt":1,"message":"quota","next":0
            })),
            OpencodeSessionPhase::Running
        );
        assert_eq!(
            ServeClient::session_phase_from_status(&serde_json::json!({})),
            OpencodeSessionPhase::Unknown
        );
    }

    #[test]
    fn session_phase_from_map_looks_up_session_id() {
        let map = serde_json::json!({
            "ses_a": {"type":"busy"},
            "ses_b": {"type":"idle"},
        });
        assert_eq!(
            ServeClient::session_phase_from_map(&map, "ses_a"),
            OpencodeSessionPhase::Running
        );
        assert_eq!(
            ServeClient::session_phase_from_map(&map, "ses_missing"),
            OpencodeSessionPhase::Unknown
        );
    }

    #[test]
    fn session_model_id_rejoins_provider_and_id() {
        let session = serde_json::json!({
            "id": "ses_abc",
            "model": {"id": "big-pickle", "providerID": "opencode", "variant": "default"},
        });
        assert_eq!(
            session_model_id(&session).as_deref(),
            Some("opencode/big-pickle")
        );
    }

    #[test]
    fn session_model_id_is_none_for_a_fresh_session() {
        assert_eq!(
            session_model_id(&serde_json::json!({"id": "ses_abc"})),
            None
        );
        assert_eq!(
            session_model_id(&serde_json::json!({"id": "ses_abc", "model": null})),
            None
        );
        // Partial model objects are unusable — don't half-build an id.
        assert_eq!(
            session_model_id(&serde_json::json!({"model": {"id": "big-pickle"}})),
            None
        );
    }

    #[test]
    fn split_model_id_splits_on_first_slash() {
        let m = split_model_id("scnet/MiniMax-M2.5").unwrap();
        assert_eq!(m.provider_id, "scnet");
        assert_eq!(m.model_id, "MiniMax-M2.5");
        // Model ids can themselves contain '/'.
        let m = split_model_id("openrouter/anthropic/claude-sonnet-4.6").unwrap();
        assert_eq!(m.provider_id, "openrouter");
        assert_eq!(m.model_id, "anthropic/claude-sonnet-4.6");
        assert!(split_model_id("bare-model").is_none());
    }

    #[test]
    fn models_from_providers_flattens_provider_model_ids() {
        let body = serde_json::json!({
            "providers": [
                {"id":"team","name":"Team","source":"config","env":[],"options":{},
                 "models":{"glm-4.6":{"name":"GLM 4.6"},"kimi-k2":{}}}
            ],
            "default": {"team":"glm-4.6"}
        });
        let models = models_from_providers(&body);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "team/glm-4.6");
        assert_eq!(models[0].display_name, "GLM 4.6");
        assert_eq!(models[0].provider_name, "Team");
        assert_eq!(models[1].id, "team/kimi-k2");
        assert_eq!(models[1].display_name, "kimi-k2");
    }
}
