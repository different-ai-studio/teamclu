//! Voice credentials — fetched from the Cloud API, cached until they expire.
//!
//! Speech runs on hosted Alibaba NLS (plan §13.9), and the AccessKey for it
//! lives in FC, not here. This module calls
//! `POST /v1/teams/{teamId}/voice/credentials` and holds the short-lived token
//! it returns.
//!
//! ## Why a cache rather than a fetch per turn
//!
//! The minted token is valid for hours, and a round trip to the Cloud API sits
//! directly in the PTT-release-to-first-audio path (§9). Fetching per turn
//! would spend that latency on every utterance to re-obtain a credential we
//! already hold. The cache refreshes on expiry, and only then.
//!
//! ## Why it refreshes early
//!
//! A token that expires *mid-stream* fails the turn, not the request: NLS
//! rejects the handshake and the user has already spoken. [`REFRESH_SKEW`]
//! renews before that window rather than at the edge of it.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::backend::Backend;

/// Renew this long before the token actually expires.
///
/// Generous on purpose: the cost of renewing early is one extra HTTP call an
/// hour, and the cost of renewing late is a failed turn the user has to repeat.
const REFRESH_SKEW: Duration = Duration::minutes(10);

/// What FC hands back. Mirrors `VoiceCredentialsResponse` in the OpenAPI spec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceCredentials {
    /// `wss://…/ws/v1` — both recognition and synthesis speak this endpoint.
    pub gateway_endpoint: String,
    /// NLS project appkey; goes in every message header.
    pub app_key: String,
    /// Short-lived bearer, sent as the `X-NLS-Token` handshake header.
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub stt_model: String,
    pub tts_voice: String,
}

impl VoiceCredentials {
    /// True when the token is close enough to expiry to be worth replacing.
    pub fn needs_refresh(&self, now: DateTime<Utc>) -> bool {
        self.expires_at - now <= REFRESH_SKEW
    }
}

/// Where credentials come from. A trait so both NLS providers can be tested
/// without a Cloud API, and so a future device-scoped mint can replace the
/// team-scoped one without touching either provider.
#[async_trait]
pub trait CredentialSource: Send + Sync {
    async fn credentials(&self) -> Result<VoiceCredentials, String>;
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialsBody {
    gateway_endpoint: String,
    app_key: String,
    token: String,
    expires_at: String,
    stt_model: String,
    tts_voice: String,
}

/// Fetches from the Cloud API and caches until [`REFRESH_SKEW`] before expiry.
pub struct CloudApiCredentials {
    backend: Arc<dyn Backend>,
    client: reqwest::Client,
    cached: Mutex<Option<VoiceCredentials>>,
}

impl CloudApiCredentials {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            client: reqwest::Client::new(),
            cached: Mutex::new(None),
        }
    }

    async fn fetch(&self) -> Result<VoiceCredentials, String> {
        let base = self
            .backend
            .cloud_base_url()
            .ok_or_else(|| "no cloud base url; voice needs the Cloud API".to_string())?;
        let team_id = self.backend.team_id().to_string();
        let auth = self
            .backend
            .auth_token()
            .await
            .map_err(|e| format!("voice credentials: no auth token: {e}"))?;

        let url = format!(
            "{}/v1/teams/{}/voice/credentials",
            base.trim_end_matches('/'),
            team_id
        );
        let resp = self
            .client
            .post(&url)
            .bearer_auth(auth)
            .send()
            .await
            .map_err(|e| format!("voice credentials: {url}: {e}"))?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // FC answers 503 naming the missing VOICE_* variable and 502 when
            // the vendor call failed. Passing the body through keeps that
            // diagnosis intact instead of flattening it to "request failed".
            let snippet: String = body.chars().take(300).collect();
            return Err(format!("voice credentials: HTTP {status}: {snippet}"));
        }

        let parsed: CredentialsBody = serde_json::from_str(&body)
            .map_err(|e| format!("voice credentials: malformed response: {e}"))?;
        let expires_at = DateTime::parse_from_rfc3339(&parsed.expires_at)
            .map_err(|e| {
                format!(
                    "voice credentials: bad expiresAt {:?}: {e}",
                    parsed.expires_at
                )
            })?
            .with_timezone(&Utc);

        Ok(VoiceCredentials {
            gateway_endpoint: parsed.gateway_endpoint,
            app_key: parsed.app_key,
            token: parsed.token,
            expires_at,
            stt_model: parsed.stt_model,
            tts_voice: parsed.tts_voice,
        })
    }
}

#[async_trait]
impl CredentialSource for CloudApiCredentials {
    async fn credentials(&self) -> Result<VoiceCredentials, String> {
        let mut cached = self.cached.lock().await;
        if let Some(c) = cached.as_ref() {
            if !c.needs_refresh(Utc::now()) {
                return Ok(c.clone());
            }
            info!("voice credentials near expiry; renewing");
        }
        match self.fetch().await {
            Ok(fresh) => {
                info!(expires_at = %fresh.expires_at, "voice credentials minted");
                *cached = Some(fresh.clone());
                Ok(fresh)
            }
            Err(e) => {
                // A still-valid cached credential beats failing the turn: the
                // renewal window is 10 minutes wide precisely so a transient
                // Cloud API blip does not take voice down with it.
                if let Some(c) = cached.as_ref().filter(|c| c.expires_at > Utc::now()) {
                    warn!(error = %e,
                          "voice credential renewal failed; using the one still in hand");
                    return Ok(c.clone());
                }
                Err(e)
            }
        }
    }
}

/// Fixed credentials, for tests and for pointing a dev daemon at a gateway by
/// hand without standing up FC.
pub struct StaticCredentials(pub VoiceCredentials);

impl StaticCredentials {
    /// Build from `TEAMCLU_VOICE_*`, bypassing FC entirely.
    ///
    /// The Aliyun console issues a temporary NLS token directly, which is
    /// enough to exercise the gateway without an AccessKey pair — and so
    /// without the `CreateToken` path FC owns. That is how the protocol in
    /// [`super::nls`] was first verified; it is a testing hatch, not a
    /// deployment mode, because a console token expires in a day and nothing
    /// renews it.
    ///
    /// Returns `None` unless both the appkey and the token are set.
    pub fn from_env() -> Option<Self> {
        Self::assemble(
            std::env::var("TEAMCLU_VOICE_APPKEY").ok(),
            std::env::var("TEAMCLU_VOICE_TOKEN").ok(),
            std::env::var("TEAMCLU_VOICE_GATEWAY").ok(),
            std::env::var("TEAMCLU_VOICE_REGION").ok(),
            std::env::var("TEAMCLU_VOICE_STT_MODEL").ok(),
            std::env::var("TEAMCLU_VOICE_TTS_VOICE").ok(),
        )
    }

    /// Build from the team's `[voice]` section (`team.toml`).
    ///
    /// Same testing hatch as [`Self::from_env`], reached the durable way: a
    /// file the daemon reads at boot rather than an environment only one
    /// launcher happens to carry. The token still expires in about a day and
    /// still nothing renews it — for that, leave the section empty and let
    /// [`CloudApiCredentials`] mint one per turn.
    ///
    /// Returns `None` unless both the appkey and the token are set, so a
    /// half-filled section falls through to FC rather than failing every turn
    /// against a gateway that will not have it.
    pub fn from_config(cfg: &crate::config::VoiceConfig) -> Option<Self> {
        Self::assemble(
            cfg.appkey.clone(),
            cfg.token.clone(),
            cfg.gateway.clone(),
            cfg.region.clone(),
            cfg.stt_model.clone(),
            cfg.tts_voice.clone(),
        )
    }

    /// Shared by both sources: blank is absent, and every optional field has a
    /// working default so only the two credentials are ever mandatory.
    fn assemble(
        appkey: Option<String>,
        token: Option<String>,
        gateway: Option<String>,
        region: Option<String>,
        stt_model: Option<String>,
        tts_voice: Option<String>,
    ) -> Option<Self> {
        let nonblank =
            |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let appkey = nonblank(appkey)?;
        let token = nonblank(token)?;
        let region = nonblank(region).unwrap_or_else(|| "cn-shanghai".to_string());
        Some(Self(VoiceCredentials {
            gateway_endpoint: nonblank(gateway)
                .unwrap_or_else(|| format!("wss://nls-gateway-{region}.aliyuncs.com/ws/v1")),
            app_key: appkey,
            token,
            // A console token lasts about a day; claim an hour so anything
            // watching `expires_at` still treats it as perishable.
            expires_at: Utc::now() + Duration::hours(1),
            stt_model: nonblank(stt_model).unwrap_or_else(|| "paraformer-realtime-v2".to_string()),
            // An NLS voice name. CosyVoice names (longxiaochun, …) are a
            // different product and the gateway rejects them with 418.
            tts_voice: nonblank(tts_voice).unwrap_or_else(|| "zhixiaobai".to_string()),
        }))
    }
}

#[async_trait]
impl CredentialSource for StaticCredentials {
    async fn credentials(&self) -> Result<VoiceCredentials, String> {
        Ok(self.0.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(expires_in_minutes: i64) -> VoiceCredentials {
        VoiceCredentials {
            gateway_endpoint: "wss://nls/ws/v1".into(),
            app_key: "ak".into(),
            token: "tok".into(),
            expires_at: Utc::now() + Duration::minutes(expires_in_minutes),
            stt_model: "paraformer-realtime-v2".into(),
            tts_voice: "zhixiaobai".into(),
        }
    }

    #[test]
    fn a_fresh_token_is_not_refreshed() {
        assert!(!creds(60).needs_refresh(Utc::now()));
    }

    #[test]
    fn a_token_inside_the_skew_is_refreshed_before_it_expires() {
        // The failure this prevents: renewing at the edge means a turn that
        // starts at T-30s dies mid-stream, after the user has already spoken.
        assert!(creds(5).needs_refresh(Utc::now()));
    }

    #[test]
    fn an_already_expired_token_is_refreshed() {
        assert!(creds(-1).needs_refresh(Utc::now()));
    }

    #[tokio::test]
    async fn static_credentials_round_trip() {
        let c = creds(60);
        let src = StaticCredentials(c.clone());
        assert_eq!(src.credentials().await.expect("static"), c);
    }
}
