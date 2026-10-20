use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    CloudApi,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudApiConfig {
    pub url: String,
    pub refresh_token: String,
    pub team_id: String,
    pub actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderConfig {
    CloudApi(CloudApiConfig),
}

impl ProviderConfig {
    pub fn kind(&self) -> ProviderKind {
        match self {
            ProviderConfig::CloudApi(_) => ProviderKind::CloudApi,
        }
    }

    /// `teams/<active>/state/backend.toml` — the active team's cloud credentials.
    ///
    /// Every field in this file is per-team (`url`, `refresh_token`, `team_id`,
    /// `actor_id`), so it belongs to the team directory and not to the home
    /// root. Switching teams then means pointing `daemon.toml` at a different
    /// directory rather than overwriting one set of credentials with another.
    pub fn default_path() -> Result<PathBuf, ProviderConfigError> {
        Ok(crate::config::layout::active_state_dir().join("backend.toml"))
    }

    /// The same file for a team that is not the active one yet — what
    /// onboarding needs, since it writes the credentials *before* `daemon.toml`
    /// starts pointing at them.
    pub fn path_for_team(team_id: &str) -> PathBuf {
        crate::config::layout::team_state_dir(team_id).join("backend.toml")
    }

    /// Whether *any* onboarding config exists at `backend_path` — either the
    /// real `backend.toml` or a legacy `supabase.toml` awaiting migration.
    ///
    /// Callers use this to tell "this daemon has never been onboarded" apart
    /// from "onboarding config exists but is corrupt". The former is a normal
    /// first-run state that starts unclaimed; the latter must stay a hard
    /// error rather than silently discarding a broken config and re-onboarding.
    pub fn exists_at(backend_path: &Path) -> bool {
        backend_path.exists()
            || backend_path
                .parent()
                .map(|dir| dir.join("supabase.toml").exists())
                .unwrap_or(false)
    }

    pub fn load_from_path(backend_path: &Path) -> Result<Self, ProviderConfigError> {
        if backend_path.exists() {
            return Self::load_backend_toml(backend_path);
        }

        let legacy_supabase_path = backend_path
            .parent()
            .map(|dir| dir.join("supabase.toml"))
            .ok_or_else(|| {
                ProviderConfigError::Config("backend.toml has no parent directory".to_string())
            })?;

        if legacy_supabase_path.exists() {
            let migrated = Self::migrate_legacy_supabase_toml(&legacy_supabase_path)?;
            Self::write_backend_toml(backend_path, &migrated)?;
            tracing::info!(
                backend = %backend_path.display(),
                legacy = %legacy_supabase_path.display(),
                "migrated legacy supabase.toml to backend.toml (kind = cloud_api)"
            );
            return Ok(ProviderConfig::CloudApi(migrated));
        }

        Err(ProviderConfigError::Config(format!(
            "backend.toml not found at {} (legacy supabase.toml also missing at {})",
            backend_path.display(),
            legacy_supabase_path.display()
        )))
    }

    fn migrate_legacy_supabase_toml(path: &Path) -> Result<CloudApiConfig, ProviderConfigError> {
        let text = std::fs::read_to_string(path)?;
        let legacy: LegacySupabaseToml = toml::from_str(&text).map_err(|e| {
            ProviderConfigError::Config(format!(
                "parse legacy supabase.toml at {}: {e}",
                path.display()
            ))
        })?;
        if legacy.refresh_token.trim().is_empty() {
            return Err(ProviderConfigError::Config(format!(
                "legacy supabase.toml at {} is missing refresh_token",
                path.display()
            )));
        }
        Ok(CloudApiConfig {
            url: resolve_cloud_api_url()?,
            refresh_token: legacy.refresh_token,
            team_id: legacy.team_id,
            actor_id: legacy.actor_id,
        })
    }

    /// Persist a `cloud_api` backend config to `path`, atomically.
    ///
    /// Used both by the legacy `supabase.toml` migration and at runtime to write
    /// back a rotated refresh token, so the write must be crash-safe: a torn
    /// write here would lose the only credential the daemon has.
    pub fn save_cloud_api(path: &Path, cfg: &CloudApiConfig) -> Result<(), ProviderConfigError> {
        Self::write_backend_toml(path, cfg)
    }

    fn write_backend_toml(path: &Path, cfg: &CloudApiConfig) -> Result<(), ProviderConfigError> {
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
        // Write to a sibling temp file then rename, so a crash mid-write can
        // never leave a partially written backend.toml.
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, text)?;
        // `refresh_token` is a long-lived credential: it mints the daemon's
        // access tokens for as long as it is not rotated. Owner-only, like
        // `secret.key` beside it; set on the temp file so the rename never
        // exposes a world-readable instant.
        set_owner_only(&tmp)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    fn load_backend_toml(path: &Path) -> Result<Self, ProviderConfigError> {
        let text = std::fs::read_to_string(path)?;
        let file: BackendConfigFile = toml::from_str(&text)?;
        match file.kind.as_str() {
            "cloud_api" => file.cloud_api.map(ProviderConfig::CloudApi).ok_or_else(|| {
                ProviderConfigError::Config(
                    "[cloud_api] section is required when kind = \"cloud_api\"".to_string(),
                )
            }),
            other => Err(ProviderConfigError::Config(format!(
                "unsupported backend kind: {other}"
            ))),
        }
    }
}

#[derive(Debug, Deserialize)]
struct BackendConfigFile {
    kind: String,
    #[serde(default)]
    cloud_api: Option<CloudApiConfig>,
}

/// Flat `~/.amuxd/supabase.toml` written by older `amuxd init` flows.
#[derive(Debug, Deserialize)]
struct LegacySupabaseToml {
    #[allow(dead_code)]
    url: Option<String>,
    #[allow(dead_code)]
    anon_key: Option<String>,
    refresh_token: String,
    team_id: String,
    actor_id: String,
}

fn resolve_cloud_api_url() -> Result<String, ProviderConfigError> {
    if let Ok(url) = std::env::var("TEAMCLU_CLOUD_API_URL") {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    Err(ProviderConfigError::MissingCloudApiUrl)
}

fn toml_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderConfigError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("parse backend.toml: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("provider config error: {0}")]
    Config(String),
    #[error("Cloud API URL not configured. Set TEAMCLU_CLOUD_API_URL env var.")]
    MissingCloudApiUrl,
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> std::io::Result<()> {
    // Per-user profile directory is the boundary on Windows; no POSIX mode.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn backend_toml_is_written_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        let cfg = CloudApiConfig {
            url: "https://fc.example.com".into(),
            refresh_token: "refresh".into(),
            team_id: "team-1".into(),
            actor_id: "agent-1".into(),
        };
        ProviderConfig::save_cloud_api(&backend_path, &cfg).unwrap();
        let mode = std::fs::metadata(&backend_path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);

        // Rewriting (what a rotated refresh token does) tightens a file an
        // older daemon left world-readable.
        std::fs::set_permissions(&backend_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        ProviderConfig::save_cloud_api(&backend_path, &cfg).unwrap();
        let mode = std::fs::metadata(&backend_path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn loads_cloud_api_backend_toml() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        std::fs::write(
            &backend_path,
            r#"
kind = "cloud_api"

[cloud_api]
url = "https://fc.example.com"
refresh_token = "refresh"
team_id = "team-1"
actor_id = "agent-1"
"#,
        )
        .unwrap();

        let loaded = ProviderConfig::load_from_path(&backend_path).unwrap();

        assert_eq!(loaded.kind(), ProviderKind::CloudApi);
        let ProviderConfig::CloudApi(config) = loaded;
        assert_eq!(config.url, "https://fc.example.com");
        assert_eq!(config.refresh_token, "refresh");
        assert_eq!(config.team_id, "team-1");
        assert_eq!(config.actor_id, "agent-1");
    }

    #[test]
    fn migrates_legacy_supabase_toml_when_backend_toml_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        let legacy_path = dir.path().join("supabase.toml");
        std::fs::write(
            &legacy_path,
            r#"
url = "https://project.supabase.co"
anon_key = "anon"
refresh_token = "refresh"
team_id = "team-1"
actor_id = "agent-1"
"#,
        )
        .unwrap();

        // Migration requires TEAMCLU_CLOUD_API_URL to be set.
        std::env::set_var("TEAMCLU_CLOUD_API_URL", "https://teamclu-api.ucar.cc");
        let loaded = ProviderConfig::load_from_path(&backend_path).unwrap();
        std::env::remove_var("TEAMCLU_CLOUD_API_URL");
        assert!(backend_path.exists());
        assert_eq!(loaded.kind(), ProviderKind::CloudApi);
        let ProviderConfig::CloudApi(config) = loaded;
        assert_eq!(config.refresh_token, "refresh");
        assert_eq!(config.team_id, "team-1");
        assert_eq!(config.actor_id, "agent-1");
        assert_eq!(config.url, "https://teamclu-api.ucar.cc");
    }

    #[test]
    fn rejects_when_backend_and_legacy_supabase_toml_are_missing() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        let err = ProviderConfig::load_from_path(&backend_path).expect_err("missing should fail");
        assert!(err.to_string().contains("backend.toml not found"));
        assert!(err.to_string().contains("supabase.toml also missing"));
    }

    #[test]
    fn rejects_unknown_kind() {
        let dir = tempfile::tempdir().unwrap();
        let backend_path = dir.path().join("backend.toml");
        std::fs::write(&backend_path, r#"kind = "mythical""#).unwrap();
        let err =
            ProviderConfig::load_from_path(&backend_path).expect_err("unknown kind should fail");
        assert!(err.to_string().contains("unsupported backend kind"));
    }

    #[test]
    fn default_path_follows_amuxd_home_env() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(dir.path());
        // Unclaimed: no daemon.toml to point at a team yet.
        let path = ProviderConfig::default_path().unwrap();
        assert_eq!(path, dir.path().join("teams/_unclaimed/state/backend.toml"));

        // Once claimed, the same file lives under the team it belongs to.
        std::fs::write(dir.path().join("daemon.toml"), "team_id = \"team-a\"\n").unwrap();
        assert_eq!(
            ProviderConfig::default_path().unwrap(),
            dir.path().join("teams/team-a/state/backend.toml")
        );
    }

    #[test]
    fn default_path_follows_brand_short_name_when_home_unset() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("copilot361");
        let path = ProviderConfig::default_path().unwrap();
        assert!(
            path.ends_with(".amuxd-copilot361/teams/_unclaimed/state/backend.toml"),
            "got {}",
            path.display()
        );
    }
}
