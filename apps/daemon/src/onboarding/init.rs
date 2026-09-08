use crate::config::{DaemonConfig, HttpConfig};
// Test-only: only the fixtures below construct a whole daemon.toml.
#[cfg(test)]
use crate::config::{ActorConfig, AgentsConfig, MqttConfig, TeamShareConfig};
use crate::onboarding::invite_url::{self, ParsedInvite};
use crate::provider_config::{CloudApiConfig, ProviderConfig};
use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};

pub struct InitOutcome {
    pub actor_id: String,
    pub team_id: String,
    pub display_name: String,
    pub config_path: PathBuf,
}

/// Execute `amuxd init <teamclu://invite?token=...>`:
///  1. parse token
///  2. POST `/v1/invites/claim` against the Cloud API (anonymous — no bearer)
///  3. persist `teams/<team>/state/backend.toml` with `kind = "cloud_api"`
///     (per-team, not the home root — see `ProviderConfig::path_for_team`)
///  4. write `daemon.toml` if absent (broker_url left empty unless the invite
///     carries a `?broker=` override — the daemon resolves it from
///     `/v1/config/bootstrap` at startup), or preserve the existing one's
///     actor.id while refreshing team_id
pub async fn run(raw_url: &str, config_path: Option<&Path>) -> Result<InitOutcome> {
    let invite = invite_url::parse(raw_url)?;

    let cloud_url = resolve_cloud_api_url(invite.cloud_api_url.as_deref())?;
    let claim = bootstrap_claim_invite(&cloud_url, &invite.token)
        .await
        .map_err(actionable_invite_claim_error)?;

    let refresh_token = claim.refresh_token.clone().ok_or_else(|| {
        anyhow!("claim_team_invite did not return a refresh token (kind=member?)")
    })?;

    let cfg = CloudApiConfig {
        url: cloud_url,
        refresh_token,
        team_id: claim.team_id.clone(),
        actor_id: claim.actor_id.clone(),
    };

    // Adopt whatever this daemon wrote while unclaimed before anything is
    // written under the team id — otherwise the credentials land in the new
    // directory and the rename then refuses to clobber it, stranding the
    // pre-onboarding sessions in `_unclaimed`.
    if let Err(e) = crate::config::layout::promote_unclaimed(&claim.team_id) {
        tracing::warn!(error = %e, "could not adopt the unclaimed team directory");
    }

    let path = match config_path {
        Some(p) => p.to_path_buf(),
        // Explicitly by team id, not `default_path()`: `daemon.toml` still
        // points at the previous team (or nowhere) until it is written below.
        None => ProviderConfig::path_for_team(&claim.team_id),
    };
    save_backend_toml(&path, &cfg).with_context(|| format!("write {}", path.display()))?;

    let daemon_path = DaemonConfig::default_path();
    let existing_daemon_cfg = DaemonConfig::load(&daemon_path).ok();
    let daemon_cfg = daemon_config_for_invite(
        existing_daemon_cfg,
        &claim.display_name,
        &claim.team_id,
        &claim.actor_id,
        &invite,
    );
    daemon_cfg
        .save(&daemon_path)
        .map_err(|e| anyhow!("write daemon.toml: {e}"))?;

    Ok(InitOutcome {
        actor_id: claim.actor_id,
        team_id: claim.team_id,
        display_name: claim.display_name,
        config_path: path,
    })
}

#[derive(Debug, serde::Deserialize)]
struct ClaimResponse {
    #[serde(rename = "actorId")]
    actor_id: String,
    #[serde(rename = "teamId")]
    team_id: String,
    #[serde(rename = "actorType")]
    #[allow(dead_code)]
    actor_type: String,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(rename = "refreshToken")]
    refresh_token: Option<String>,
}

/// Anonymous (no Authorization header) POST to /v1/invites/claim.
async fn bootstrap_claim_invite(cloud_url: &str, token: &str) -> Result<ClaimResponse> {
    #[derive(serde::Serialize)]
    struct Body<'a> {
        token: &'a str,
    }
    let url = format!("{}/v1/invites/claim", cloud_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(url)
        .json(&Body { token })
        .send()
        .await
        .with_context(|| "POST /v1/invites/claim")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("cloud api claim failed ({status}): {body}"));
    }
    resp.json::<ClaimResponse>()
        .await
        .with_context(|| "decode claim response")
}

/// Resolve the Cloud API endpoint `amuxd init` POSTs `/v1/invites/claim` to.
///
/// Precedence (first non-empty wins):
///  1. `TEAMCLU_CLOUD_API_URL` process env — explicit operator/self-test override.
///  2. `invite_override` — the `?cloud_api_url=` the inviter (desktop) baked into
///     the invite, so the daemon follows the app's build/runtime endpoint choice.
///  3. `apps/daemon/.env` `TEAMCLU_CLOUD_API_URL` — local dev override.
///
/// There is no hardcoded default. If no source provides a URL, init fails with
/// a clear error rather than silently routing to a stale/wrong endpoint.
fn resolve_cloud_api_url(invite_override: Option<&str>) -> Result<String> {
    let env_override = std::env::var("TEAMCLU_CLOUD_API_URL").ok();
    let dotenv_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(".env");
    let dotenv_override = std::fs::read_to_string(&dotenv_path)
        .ok()
        .and_then(|text| read_dotenv_value(&text, "TEAMCLU_CLOUD_API_URL"));
    pick_cloud_api_url(
        env_override.as_deref(),
        invite_override,
        dotenv_override.as_deref(),
    )
}

/// Pure precedence resolver (see [`resolve_cloud_api_url`]); split out so the
/// ordering is unit-testable without touching process env or the filesystem.
fn pick_cloud_api_url(
    env_override: Option<&str>,
    invite_override: Option<&str>,
    dotenv_override: Option<&str>,
) -> Result<String> {
    for candidate in [env_override, invite_override, dotenv_override] {
        if let Some(value) = candidate {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    Err(anyhow!(
        "Cloud API URL not configured. Set TEAMCLU_CLOUD_API_URL or pass a valid invite URL."
    ))
}

fn read_dotenv_value(contents: &str, key: &str) -> Option<String> {
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, v) = line.split_once('=')?;
        if k.trim() == key {
            let v = v.trim();
            if v.len() >= 2 {
                let bytes = v.as_bytes();
                if (bytes[0] == b'"' && bytes[v.len() - 1] == b'"')
                    || (bytes[0] == b'\'' && bytes[v.len() - 1] == b'\'')
                {
                    return Some(v[1..v.len() - 1].to_string());
                }
            }
            return Some(v.to_string());
        }
    }
    None
}

fn save_backend_toml(path: &Path, cfg: &CloudApiConfig) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = format!(
        r#"kind = "cloud_api"

[cloud_api]
url = {url}
refresh_token = {refresh_token}
team_id = {team_id}
actor_id = {actor_id}
"#,
        url = toml_quote(&cfg.url),
        refresh_token = toml_quote(&cfg.refresh_token),
        team_id = toml_quote(&cfg.team_id),
        actor_id = toml_quote(&cfg.actor_id),
    );
    std::fs::write(path, text)
}

fn toml_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

fn actionable_invite_claim_error(err: anyhow::Error) -> anyhow::Error {
    let s = err.to_string();
    if s.contains("member claim requires authentication") {
        return anyhow!(
            "{s}\nThis is a teammate/member invite. `amuxd init` requires an Agent invite; \
             create one from the app's Invite dialog with Kind = Agent."
        );
    }
    err
}

fn default_daemon_config(display_name: &str, actor_id: &str) -> DaemonConfig {
    let mut config = DaemonConfig::bootstrap();
    config.actor.id = actor_id.to_string();
    config.actor.name = display_name.to_string();
    config
}

fn daemon_config_for_invite(
    existing: Option<DaemonConfig>,
    display_name: &str,
    team_id: &str,
    actor_id: &str,
    invite: &ParsedInvite,
) -> DaemonConfig {
    let mut daemon_cfg = existing.unwrap_or_else(|| default_daemon_config(display_name, actor_id));
    // In-memory convergence only: `actor.id` never reaches daemon.toml (the
    // field is skip_serializing; the team's backend.toml is the identity's one
    // owner on disk). It still matters for the process that called init — the
    // Cloud API access-token hook embeds ACL rules under the
    // `amux/{team}/{actor}/...` topic namespace, so a running daemon must
    // converge on the claimed actor_id before its next CONNECT.
    daemon_cfg.actor.id = actor_id.to_string();
    // Replace the placeholder left by a daemon that booted unclaimed, so
    // presence doesn't announce it. An operator-chosen name is preserved.
    if daemon_cfg.actor.name.is_empty()
        || daemon_cfg.actor.name == crate::config::BOOTSTRAP_ACTOR_NAME
    {
        daemon_cfg.actor.name = display_name.to_string();
    }
    daemon_cfg.team_id = Some(team_id.to_string());
    // Capture the invite's URL scheme so the daemon can feed
    // `TEAMCLU_APP_SCHEME` to workspace-scoped MCP tools (introspect's
    // `get_session_deeplink`). Without this, branded builds emit deeplinks
    // with the wrong `teamclu://` scheme. Re-onboarding refreshes it; an
    // existing value is overwritten so a re-brand takes effect.
    daemon_cfg.app_scheme = Some(invite.scheme.clone());
    // Honor an explicit `?broker=` invite override; otherwise leave empty so the
    // daemon resolves the broker from /v1/config/bootstrap at startup.
    daemon_cfg.mqtt.broker_url = invite.broker_url.clone().unwrap_or_default();
    if daemon_cfg.http.is_none() {
        daemon_cfg.http = Some(HttpConfig::default());
    }
    daemon_cfg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_init_config_persists_desktop_http_cors_origins() {
        let cfg = daemon_config_for_invite(
            None,
            "win-pc",
            "team-1",
            "actor-1",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: None,
                cloud_api_url: None,
                scheme: "teamclu".into(),
            },
        );
        let http = cfg.http.expect("init should write [http]");
        assert!(
            http.allowed_origins
                .iter()
                .any(|o| o == "https://tauri.localhost"),
            "expected packaged desktop origin"
        );
        assert!(
            http.allowed_origins
                .iter()
                .any(|o| o == "http://tauri.localhost"),
            "expected WebView2 http tauri origin"
        );
    }

    #[test]
    fn reinit_backfills_http_section_when_missing() {
        let cfg = daemon_config_for_invite(
            Some(DaemonConfig {
                actor: ActorConfig {
                    id: "actor-1".into(),
                    name: "host".into(),
                },
                mqtt: MqttConfig {
                    broker_url: String::new(),
                    username: None,
                    password: None,
                },
                agents: AgentsConfig::default(),
                transport: None,
                team_id: Some("team-1".into()),
                channels: Default::default(),
                idle_runtime_timeout_secs: None,
                max_attachments: None,
                http: None,
                team_share: TeamShareConfig::default(),
                log: None,
                locale: None,
                app_scheme: None,
            }),
            "host",
            "team-1",
            "actor-1",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: None,
                cloud_api_url: None,
                scheme: "teamclu".into(),
            },
        );
        assert!(cfg.http.is_some());
        assert!(cfg
            .http
            .unwrap()
            .allowed_origins
            .iter()
            .any(|o| o == "http://tauri.localhost"));
    }

    #[test]
    fn invite_broker_url_overrides_default() {
        let cfg = daemon_config_for_invite(
            None,
            "macmini-5",
            "team-1",
            "actor-1",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: Some("mqtts://broker.example.com:8883".into()),
                cloud_api_url: None,
                scheme: "teamclu".into(),
            },
        );
        assert_eq!(cfg.team_id.as_deref(), Some("team-1"));
        assert_eq!(cfg.actor.id, "actor-1");
        assert_eq!(cfg.actor.name, "macmini-5");
        assert_eq!(cfg.mqtt.broker_url, "mqtts://broker.example.com:8883");
    }

    #[test]
    fn invite_scheme_is_captured_into_app_scheme() {
        // A branded build's invite carries the brand scheme; the daemon must
        // persist it so workspace-scoped MCP tools (get_session_deeplink) emit
        // deeplinks with the brand scheme instead of the default teamclu://.
        let cfg = daemon_config_for_invite(
            None,
            "host",
            "team-1",
            "actor-1",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: None,
                cloud_api_url: None,
                scheme: "acme".into(),
            },
        );
        assert_eq!(cfg.app_scheme.as_deref(), Some("acme"));
    }

    #[test]
    fn invite_without_broker_leaves_broker_url_empty() {
        // No `?broker=` override → broker_url stays empty; the daemon resolves it
        // from /v1/config/bootstrap at startup (apply_bootstrap_overrides).
        let cfg = daemon_config_for_invite(
            None,
            "macmini-5",
            "team-1",
            "actor-1",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: None,
                cloud_api_url: None,
                scheme: "teamclu".into(),
            },
        );
        assert_eq!(cfg.mqtt.broker_url, "");
    }

    #[test]
    fn existing_actor_id_is_replaced_with_claim_actor_id() {
        let cfg = daemon_config_for_invite(
            Some(DaemonConfig {
                actor: ActorConfig {
                    id: "stale-actor-id".into(),
                    name: "existing-host".into(),
                },
                mqtt: MqttConfig {
                    broker_url: "mqtts://old.example.com:8883".into(),
                    username: None,
                    password: None,
                },
                agents: AgentsConfig::default(),
                transport: None,
                team_id: Some("team-old".into()),
                channels: Default::default(),
                idle_runtime_timeout_secs: None,
                max_attachments: None,
                http: None,
                team_share: TeamShareConfig::default(),
                log: None,
                locale: None,
                app_scheme: None,
            }),
            "new-display-name",
            "team-2",
            "actor-2",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: Some("mqtts://broker.example.com:8883".into()),
                cloud_api_url: None,
                scheme: "teamclu".into(),
            },
        );
        assert_eq!(cfg.actor.id, "actor-2");
        assert_eq!(cfg.actor.name, "existing-host");
        assert_eq!(cfg.team_id.as_deref(), Some("team-2"));
        assert_eq!(cfg.mqtt.broker_url, "mqtts://broker.example.com:8883");
    }

    #[test]
    fn claiming_a_bootstrapped_config_replaces_the_placeholder_name() {
        // A daemon that booted with no daemon.toml carries a placeholder
        // actor.name. Claiming must adopt the cloud display name, or presence
        // would announce the placeholder once MQTT comes up.
        let cfg = daemon_config_for_invite(
            Some(DaemonConfig::bootstrap()),
            "new-display-name",
            "team-2",
            "actor-2",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: None,
                cloud_api_url: None,
                scheme: "teamclu".into(),
            },
        );
        assert_eq!(cfg.actor.name, "new-display-name");
        assert_eq!(cfg.actor.id, "actor-2");
    }

    #[test]
    fn member_invite_claim_error_explains_agent_invite_requirement() {
        let err = actionable_invite_claim_error(anyhow!(
            r#"cloud api claim failed (401): {{"message":"member claim requires authentication"}}"#
        ));
        let s = err.to_string();
        assert!(s.contains("Kind = Agent"));
        assert!(s.contains("member claim requires authentication"));
    }

    #[test]
    fn cloud_api_url_precedence_env_over_invite_over_dotenv() {
        // env wins over everything (operator/self-test escape hatch).
        assert_eq!(
            pick_cloud_api_url(
                Some("https://env.example"),
                Some("https://invite.example"),
                Some("https://dotenv.example")
            )
            .unwrap(),
            "https://env.example"
        );
        // No env → the invite-carried endpoint wins (the production path).
        assert_eq!(
            pick_cloud_api_url(
                None,
                Some("https://invite.example"),
                Some("https://dotenv.example")
            )
            .unwrap(),
            "https://invite.example"
        );
        // Empty/whitespace candidates are skipped, not treated as a value.
        assert_eq!(
            pick_cloud_api_url(Some("   "), Some("https://invite.example"), None).unwrap(),
            "https://invite.example"
        );
        // Nothing set → error.
        assert!(pick_cloud_api_url(None, None, None).is_err());
        // dotenv is the lowest non-default fallback.
        assert_eq!(
            pick_cloud_api_url(None, None, Some("https://dotenv.example")).unwrap(),
            "https://dotenv.example"
        );
    }

    #[test]
    fn read_dotenv_value_returns_quoted_and_plain() {
        let text = "FOO=bar\nBAZ=\"qux\"\n# comment\nEMPTY=\n";
        assert_eq!(read_dotenv_value(text, "FOO").as_deref(), Some("bar"));
        assert_eq!(read_dotenv_value(text, "BAZ").as_deref(), Some("qux"));
        assert_eq!(read_dotenv_value(text, "EMPTY").as_deref(), Some(""));
        assert!(read_dotenv_value(text, "MISSING").is_none());
    }
}
