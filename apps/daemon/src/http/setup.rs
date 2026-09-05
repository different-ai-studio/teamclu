//! First-run onboarding over HTTP (`/v1/setup/*`).
//!
//! The browser-side equivalent of `amuxd init <invite-url>`: it claims a team
//! invite, persists `backend.toml` + `daemon.toml`, and installs the resulting
//! credentials into the running daemon's [`DeferredBackend`].
//!
//! ## Why these routes are not `admin`-scoped
//!
//! Every other mutating route requires a scoped session token. `claim` cannot:
//! on a fresh install the whole point is that no credentials exist yet, and the
//! root token needed to mint a session token is exactly what `amuxd setup`
//! hands the browser. So `claim` is gated on the **root token** ([`RootAuth`])
//! — the 0600 file in `~/.amuxd/`. Holding it already implies local
//! filesystem access, which is a strictly higher bar than any scope.
//!
//! `status` is unauthenticated: it reveals only whether onboarding is needed,
//! which the setup page must know before it can authenticate at all. It
//! deliberately exposes no identifiers when unclaimed.

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use super::auth::RootAuth;
use super::errors::{ErrorCode, HttpError};
use super::state::HttpState;

/// Onboarding, as the HTTP layer needs it.
///
/// A trait rather than a direct call into `crate::onboarding`: the integration
/// tests pull `src/http/**` into standalone test crates via `#[path]`, where
/// the daemon's module tree does not exist. Same reason `Backend::
/// report_client_version` takes `device_id` instead of reading it itself.
///
/// The daemon supplies the real implementation; focused HTTP tests supply a
/// stub or `None`.
#[async_trait::async_trait]
pub trait OnboardingService: Send + Sync {
    /// Whether this daemon has credentials.
    fn is_claimed(&self) -> bool;

    /// `(actor_id, team_id)`, or `None` while unclaimed.
    fn identity(&self) -> Option<(String, String)>;

    /// Claim an invite: persist config and install credentials into the
    /// running daemon. `Err` carries an operator-facing message.
    async fn claim(&self, invite_url: &str) -> Result<ClaimOutcome, String>;
}

#[derive(Debug, Clone)]
pub struct ClaimOutcome {
    pub actor_id: String,
    pub team_id: String,
    pub display_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatusResponse {
    /// False when this daemon has no credentials and needs onboarding.
    pub claimed: bool,
    /// Identity, once claimed. `None` while unclaimed — an unauthenticated
    /// caller learns nothing beyond "setup is needed".
    pub actor_id: Option<String>,
    pub team_id: Option<String>,
}

pub async fn setup_status(State(state): State<HttpState>) -> Json<SetupStatusResponse> {
    let onboarding = state.onboarding.as_ref();
    let claimed = onboarding.map(|o| o.is_claimed()).unwrap_or(false);
    let identity = onboarding.filter(|_| claimed).and_then(|o| o.identity());

    Json(SetupStatusResponse {
        claimed,
        actor_id: identity.as_ref().map(|(actor, _)| actor.clone()),
        team_id: identity.as_ref().map(|(_, team)| team.clone()),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRequest {
    /// A `teamclu://invite?token=…` URL. Must be an **Agent** invite; member
    /// invites are rejected by the Cloud API with a targeted hint.
    pub invite_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimResponse {
    pub actor_id: String,
    pub team_id: String,
    pub display_name: String,
    /// True when the daemon booted unclaimed.
    ///
    /// Credentials are live immediately and MQTT converges on its own (the
    /// run loop re-reads `daemon.toml` for team_id/actor.id and re-fetches the
    /// broker). But consumers that captured the placeholder identity at
    /// startup — `teamclu::SessionManager` — cannot be re-keyed in place, so
    /// collab stays wrong until a restart. Reported honestly rather than
    /// papered over.
    pub requires_restart: bool,
}

pub async fn setup_claim(
    _root: RootAuth,
    State(state): State<HttpState>,
    Json(req): Json<ClaimRequest>,
) -> Result<Json<ClaimResponse>, HttpError> {
    let onboarding = state.onboarding.as_ref().ok_or_else(|| {
        HttpError::new(
            ErrorCode::RuntimeUnavailable,
            "no daemon actor loop behind this HTTP server",
        )
    })?;

    // A claimed daemon re-onboarding under a *different* actor cannot converge
    // in place (see DeferredBackend's docs), so refuse rather than half-apply.
    // `amuxd init` remains the escape hatch for a deliberate re-onboard.
    if onboarding.is_claimed() {
        return Err(HttpError::new(
            ErrorCode::Conflict,
            "daemon is already onboarded; re-onboard with `amuxd init <invite-url>` and restart",
        ));
    }

    let outcome = onboarding
        .claim(&req.invite_url)
        .await
        .map_err(|e| HttpError::validation(format!("invite claim failed: {e}")))?;

    tracing::info!(
        actor_id = %outcome.actor_id,
        team_id = %outcome.team_id,
        "daemon onboarded via /v1/setup/claim"
    );

    Ok(Json(ClaimResponse {
        actor_id: outcome.actor_id,
        team_id: outcome.team_id,
        display_name: outcome.display_name,
        // This route only runs on a daemon that booted unclaimed — the
        // already-claimed case returned Conflict above.
        requires_restart: true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Stub standing in for the daemon's real onboarding.
    struct StubOnboarding {
        claimed: bool,
    }

    #[async_trait::async_trait]
    impl OnboardingService for StubOnboarding {
        fn is_claimed(&self) -> bool {
            self.claimed
        }
        fn identity(&self) -> Option<(String, String)> {
            self.claimed
                .then(|| ("actor-7".to_string(), "team-7".to_string()))
        }
        async fn claim(&self, _invite_url: &str) -> Result<ClaimOutcome, String> {
            Ok(ClaimOutcome {
                actor_id: "actor-7".into(),
                team_id: "team-7".into(),
                display_name: "mac-mini".into(),
            })
        }
    }

    /// Minimal state for the two routes under test — neither touches the
    /// runtime, tokens, or sync surfaces.
    fn state_with(onboarding: Option<Arc<dyn OnboardingService>>) -> HttpState {
        let dir = tempfile::tempdir().unwrap();
        HttpState::new(
            crate::config::HttpConfig::default(),
            super::super::tokens::TokenStore::load_or_init(&dir.path().join("token")).unwrap(),
            super::super::server::metadata("actor-test".into(), "test"),
            super::super::runtime_adapter::StubRuntimeAdapter::new(16),
            None,
            None,
            crate::sync::dispatch::SyncDispatcher::new(
                crate::sync::secret_store::SecretStore::new(),
                None,
            ),
            None,
        )
        .with_config_admin(None, None, onboarding)
    }

    #[tokio::test]
    async fn status_reports_unclaimed_without_leaking_identity() {
        let state = state_with(Some(Arc::new(StubOnboarding { claimed: false })));
        let Json(body) = setup_status(State(state)).await;

        assert!(!body.claimed);
        assert!(body.actor_id.is_none());
        assert!(body.team_id.is_none());
    }

    #[tokio::test]
    async fn status_reports_identity_once_claimed() {
        let state = state_with(Some(Arc::new(StubOnboarding { claimed: true })));
        let Json(body) = setup_status(State(state)).await;

        assert!(body.claimed);
        assert_eq!(body.actor_id.as_deref(), Some("actor-7"));
        assert_eq!(body.team_id.as_deref(), Some("team-7"));
    }

    #[tokio::test]
    async fn claim_succeeds_on_an_unclaimed_daemon_and_asks_for_a_restart() {
        let state = state_with(Some(Arc::new(StubOnboarding { claimed: false })));
        let Json(body) = setup_claim(
            RootAuth,
            State(state),
            Json(ClaimRequest {
                invite_url: "teamclu://invite?token=tok".into(),
            }),
        )
        .await
        .unwrap();

        assert_eq!(body.actor_id, "actor-7");
        assert_eq!(body.display_name, "mac-mini");
        // Startup-captured identity can't be re-keyed in place.
        assert!(body.requires_restart);
    }

    #[tokio::test]
    async fn claim_on_an_already_onboarded_daemon_conflicts() {
        // Must not half-apply: identity captured at startup can't be re-keyed.
        let state = state_with(Some(Arc::new(StubOnboarding { claimed: true })));
        let err = setup_claim(
            RootAuth,
            State(state),
            Json(ClaimRequest {
                invite_url: "teamclu://invite?token=tok".into(),
            }),
        )
        .await
        .unwrap_err();

        assert_eq!(err.code, ErrorCode::Conflict);
    }

    #[tokio::test]
    async fn claim_without_a_daemon_behind_it_is_unavailable() {
        let err = setup_claim(
            RootAuth,
            State(state_with(None)),
            Json(ClaimRequest {
                invite_url: "teamclu://invite?token=tok".into(),
            }),
        )
        .await
        .unwrap_err();

        assert_eq!(err.code, ErrorCode::RuntimeUnavailable);
    }
}
