use std::collections::HashMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

use teamclu_runtime_env::team_crypto::{self, EncryptedEnvelope};

#[derive(Debug, Clone, Default)]
pub struct TeamEnvLoadDiagnostics {
    pub values: HashMap<String, String>,
    pub source_paths: HashMap<String, String>,
    pub unresolved_keys: Vec<String>,
    pub overridden_keys: Vec<String>,
}

/// Derive the team AES key. Re-exported from the shared `team_crypto` module so
/// this crate's OSS blob crypto (`sync::oss`) keeps a single import path.
pub fn derive_key(env_secret: &str) -> anyhow::Result<[u8; 32]> {
    Ok(team_crypto::derive_key(env_secret)?)
}

pub fn normalize_env_map(input: HashMap<String, String>) -> HashMap<String, String> {
    let mut out = input;
    let additions: Vec<(String, String)> = out
        .iter()
        .filter_map(|(key, value)| {
            let upper = key.to_ascii_uppercase();
            if key == &upper || out.contains_key(&upper) {
                None
            } else {
                Some((upper, value.clone()))
            }
        })
        .collect();
    for (key, value) in additions {
        out.insert(key, value);
    }
    out
}

/// Resolve `_secrets/` for a workspace: prefer `teamclu-team` (global link),
/// then configured `sharedDirName`.
pub fn resolve_team_secrets_dir(
    workspace_root: &Path,
    team_id: Option<&str>,
    shared_dir_name: &str,
) -> PathBuf {
    team_secrets_dir_candidates(workspace_root, team_id, shared_dir_name)
        .into_iter()
        .find(|dir| dir.exists())
        .unwrap_or_else(|| workspace_root.join(shared_dir_name).join("_secrets"))
}

/// Candidate `_secrets/` directories, most preferred first.
pub fn team_secrets_dir_candidates(
    workspace_root: &Path,
    team_id: Option<&str>,
    shared_dir_name: &str,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |path: PathBuf| {
        if seen.insert(path.clone()) {
            out.push(path);
        }
    };

    if let Some(team_id) = team_id.filter(|id| !id.trim().is_empty()) {
        push(
            crate::config::global_team_store::resolve_team_dir(workspace_root, team_id)
                .join("_secrets"),
        );
        push(crate::config::global_team_store::global_team_dir(team_id).join("_secrets"));
    }

    for path in teamclu_runtime_env::env_catalog::team_secrets_dir_candidates_workspace(
        workspace_root,
        shared_dir_name,
    ) {
        push(path);
    }

    // The Cloud API cache goes LAST on purpose. `load_team_env_for_workspace_detailed`
    // merges every candidate with later dirs overriding earlier ones, so being
    // last is what makes the cloud value authoritative.
    //
    // The legacy `_secrets/` directories above are still read rather than
    // dropped. `_secrets/` is no longer synced, so those files can only exist on
    // a machine that already had them — reading them costs nothing and keeps a
    // pre-migration checkout working, while the ordering means they can never
    // shadow the cloud.
    if let Some(team_id) = team_id.filter(|id| !id.trim().is_empty()) {
        push(crate::runtime::team_cloud_config::team_cloud_secrets_dir(
            team_id,
        ));
    }
    out
}

fn read_team_json_shared_dir_name(workspace_root: &Path) -> String {
    teamclu_runtime_env::team_provider::resolve_shared_dir_name(workspace_root)
}

pub fn load_team_env_from_secrets_dir(
    secrets_dir: &Path,
    env_secret: &str,
) -> anyhow::Result<HashMap<String, String>> {
    Ok(load_team_env_from_secrets_dir_detailed(secrets_dir, env_secret)?.values)
}

fn load_team_env_from_secrets_dir_detailed(
    secrets_dir: &Path,
    env_secret: &str,
) -> anyhow::Result<TeamEnvLoadDiagnostics> {
    if !secrets_dir.exists() {
        return Ok(TeamEnvLoadDiagnostics::default());
    }

    // Validate the team secret shape up front; per-file decrypt uses
    // `decrypt_secret_for_team` so pre-rename (teamclaw salt) envelopes still open.
    derive_key(env_secret)?;
    let mut loaded = TeamEnvLoadDiagnostics::default();
    for entry in std::fs::read_dir(secrets_dir)? {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(e) => {
                warn!("failed to read team secret directory entry: {e}");
                continue;
            }
        };
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !file_name.ends_with(".enc.json") {
            continue;
        }
        let key_from_file = file_name
            .strip_suffix(".enc.json")
            .unwrap_or(file_name)
            .to_string();
        let body = match std::fs::read_to_string(&path) {
            Ok(body) => body,
            Err(e) => {
                warn!(path = %path.display(), "failed to read team secret file: {e}");
                loaded.unresolved_keys.push(key_from_file);
                continue;
            }
        };
        let envelope: EncryptedEnvelope = match serde_json::from_str(&body) {
            Ok(envelope) => envelope,
            Err(e) => {
                warn!(path = %path.display(), "failed to parse team secret file: {e}");
                loaded.unresolved_keys.push(key_from_file);
                continue;
            }
        };
        let secret = match team_crypto::decrypt_secret_for_team(&envelope, env_secret) {
            Ok(secret) => secret,
            Err(e) => {
                warn!(path = %path.display(), "failed to decrypt team secret file: {e}");
                loaded.unresolved_keys.push(key_from_file);
                continue;
            }
        };
        // The team LLM credential is never sourced from team `_secrets`, under
        // either name. It is per-device — today a daemon session token minted
        // locally, previously a key derived from `actor_id` — so a copy shared
        // across the team is meaningless and, worse, would shadow the real one.
        //
        // `tc_api_key` stays in this list because a stale copy can still be
        // sitting in a team's `_secrets` from before the gateway cutover.
        // Other shared secrets flow through unchanged.
        if secret.key_id.eq_ignore_ascii_case("tc_api_key")
            || secret.key_id.eq_ignore_ascii_case("tc_gateway_token")
        {
            continue;
        }
        loaded
            .source_paths
            .insert(secret.key_id.clone(), path.display().to_string());
        loaded.values.insert(secret.key_id, secret.key);
    }
    loaded.values = normalize_env_map(loaded.values);
    loaded.unresolved_keys.sort();
    loaded.unresolved_keys.dedup();
    Ok(loaded)
}

pub fn load_team_env(
    workspace_root: &Path,
    shared_dir_name: &str,
    env_secret: &str,
) -> anyhow::Result<HashMap<String, String>> {
    let secrets_dir =
        crate::config::global_team_store::shared_dir_path(workspace_root, shared_dir_name)?
            .join("_secrets");
    load_team_env_from_secrets_dir(&secrets_dir, env_secret)
}

/// The team env decryption key: this daemon's own store first.
///
/// `_secrets/` rides along in the shared dir, so this key is what turns those
/// envelopes back into env vars.
///
/// The daemon's store wins because it is the only source a standalone install
/// can be handed one (`amuxd team secrets set`, or the desktop's
/// `POST /v1/team/secrets`). The workspace `teamclu.json` and the desktop's
/// `_team_secret.{team_id}` blob remain as fallbacks so installs predating
/// daemon-side custody keep decrypting untouched.
fn resolve_env_secret(workspace_root: &Path, team_id: Option<&str>) -> Option<String> {
    resolve_env_secret_with(
        &crate::sync::secret_store::SecretStore::new(),
        workspace_root,
        team_id,
    )
}

/// `resolve_env_secret` over an explicit store, so tests can exercise the
/// precedence without reaching for the real `$HOME`.
fn resolve_env_secret_with(
    store: &crate::sync::secret_store::SecretStore,
    workspace_root: &Path,
    team_id: Option<&str>,
) -> Option<String> {
    if let Some(team_id) = team_id.filter(|id| !id.trim().is_empty()) {
        if let Some(secret) = store.team_secret(team_id) {
            return Some(secret);
        }
    }
    let brand = teamclu_runtime_env::brand_short_name_from_env();
    teamclu_runtime_env::env_catalog::resolve_team_env_secret(
        workspace_root,
        team_id,
        Some(brand.as_str()),
    )
}

/// Load decrypted team shared env for a workspace.
///
/// Does not require `team.enabled` in `teamclu.json`. Secrets normally live
/// under `{sharedDirName}/_secrets` (default UI: `teamclu/_secrets`); the global
/// `teamclu-team` symlink and `_team_secret.{team_id}` blob are fallbacks.
pub fn load_team_env_for_workspace(
    workspace_root: &Path,
    team_id: Option<&str>,
) -> HashMap<String, String> {
    load_team_env_for_workspace_detailed(workspace_root, team_id).values
}

pub fn load_team_env_for_workspace_detailed(
    workspace_root: &Path,
    team_id: Option<&str>,
) -> TeamEnvLoadDiagnostics {
    let shared_dir_name = read_team_json_shared_dir_name(workspace_root);
    let Some(env_secret) = resolve_env_secret(workspace_root, team_id) else {
        if team_id.is_some() {
            warn!(
                workspace = %workspace_root.display(),
                "team env secret missing; set it with `amuxd team secrets set --team-secret <64-hex>`"
            );
        }
        return TeamEnvLoadDiagnostics::default();
    };

    // Merge every candidate `_secrets/` dir — same union as the settings catalog.
    // Stopping at the first non-empty dir (old behaviour) dropped workspace-local
    // secrets whenever the global team store already held a partial copy.
    let mut merged = TeamEnvLoadDiagnostics::default();
    for secrets_dir in team_secrets_dir_candidates(workspace_root, team_id, &shared_dir_name) {
        match load_team_env_from_secrets_dir_detailed(&secrets_dir, &env_secret) {
            Ok(loaded) if !loaded.values.is_empty() || !loaded.unresolved_keys.is_empty() => {
                info!(
                    workspace = %workspace_root.display(),
                    secrets_dir = %secrets_dir.display(),
                    count = loaded.values.len(),
                    "merged team shared environment variables"
                );
                for key in loaded.values.keys() {
                    if merged.values.contains_key(key) {
                        merged.overridden_keys.push(key.clone());
                    }
                }
                merged.values.extend(loaded.values);
                merged.source_paths.extend(loaded.source_paths);
                merged.unresolved_keys.extend(loaded.unresolved_keys);
            }
            Ok(_) => {}
            Err(e) => {
                warn!(
                    workspace = %workspace_root.display(),
                    secrets_dir = %secrets_dir.display(),
                    error = %e,
                    "failed to load team shared environment variables"
                );
            }
        }
    }
    merged.values = normalize_env_map(merged.values);
    merged
        .unresolved_keys
        .retain(|key| !merged.values.contains_key(key));
    merged.unresolved_keys.sort();
    merged.unresolved_keys.dedup();
    merged.overridden_keys.sort();
    merged.overridden_keys.dedup();
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::secret_store::{SecretStore, TeamSecrets};
    use teamclu_runtime_env::team_crypto::SecretEntry;

    fn store_with_secret(base: &Path, team_id: &str, secret: &str) -> SecretStore {
        let store = SecretStore::with_base(base.to_path_buf());
        store
            .merge(
                team_id,
                &TeamSecrets {
                    oss_team_secret: Some(secret.to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
        store
    }

    /// The standalone-daemon case: nothing in the workspace, no desktop blob —
    /// only what `amuxd team secrets set` (or the desktop's push) left behind.
    #[test]
    fn env_secret_resolves_from_daemon_store_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let secret = "5a".repeat(32);
        let store = store_with_secret(home.path(), "t-1", &secret);

        let got = resolve_env_secret_with(&store, tmp.path(), Some("t-1"));
        assert_eq!(got.as_deref(), Some(secret.as_str()));
    }

    /// The daemon's own copy is the system of record, so it outranks a stale
    /// `team.envSecret` left in a workspace's teamclu.json.
    #[test]
    fn daemon_store_wins_over_workspace_teamclu_json() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join(".teamclu");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("teamclu.json"),
            serde_json::json!({ "team": { "envSecret": "11".repeat(32) } }).to_string(),
        )
        .unwrap();
        let store = store_with_secret(home.path(), "t-1", &"22".repeat(32));

        let got = resolve_env_secret_with(&store, tmp.path(), Some("t-1"));
        assert_eq!(got.as_deref(), Some("22".repeat(32).as_str()));
    }

    /// Compat: an install that predates daemon-side custody has an empty store
    /// and must keep decrypting from teamclu.json.
    #[test]
    fn falls_back_to_teamclu_json_when_store_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let secret = "33".repeat(32);
        let config_dir = tmp.path().join(".teamclu");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("teamclu.json"),
            serde_json::json!({ "team": { "envSecret": secret } }).to_string(),
        )
        .unwrap();
        let store = SecretStore::with_base(home.path().to_path_buf());

        let got = resolve_env_secret_with(&store, tmp.path(), Some("t-1"));
        assert_eq!(got.as_deref(), Some(secret.as_str()));
    }

    /// A team_id is required to key into the store; without one the store is
    /// skipped rather than consulted with a blank key.
    #[test]
    fn blank_team_id_skips_the_store() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let store = store_with_secret(home.path(), "   ", &"44".repeat(32));

        assert!(resolve_env_secret_with(&store, tmp.path(), Some("   ")).is_none());
        assert!(resolve_env_secret_with(&store, tmp.path(), None).is_none());
    }

    fn encrypted_secret_file(env_secret: &str, key_id: &str, key_value: &str) -> String {
        let key = derive_key(env_secret).unwrap();
        let entry = SecretEntry {
            key_id: key_id.to_string(),
            key: key_value.to_string(),
            ..Default::default()
        };
        let envelope = team_crypto::encrypt_secret(&entry, &key).unwrap();
        serde_json::to_string(&envelope).unwrap()
    }

    #[test]
    fn normalize_env_adds_uppercase_alias_for_lowercase_key() {
        let mut input = HashMap::new();
        input.insert("tc_api_key".to_string(), "secret".to_string());

        let out = normalize_env_map(input);

        assert_eq!(out.get("tc_api_key").unwrap(), "secret");
        assert_eq!(out.get("TC_API_KEY").unwrap(), "secret");
    }

    #[test]
    fn normalize_env_does_not_override_existing_uppercase_key() {
        let mut input = HashMap::new();
        input.insert("tc_api_key".to_string(), "lower".to_string());
        input.insert("TC_API_KEY".to_string(), "upper".to_string());

        let out = normalize_env_map(input);

        assert_eq!(out.get("TC_API_KEY").unwrap(), "upper");
    }

    #[test]
    fn missing_secrets_dir_returns_empty_env() {
        let tmp = tempfile::tempdir().unwrap();
        let env = load_team_env(tmp.path(), "teamclu", &"00".repeat(32)).unwrap();
        assert!(env.is_empty());
    }

    #[test]
    fn unsafe_shared_dir_name_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let err = load_team_env(tmp.path(), "../outside", &"00".repeat(32)).unwrap_err();
        assert!(err.to_string().contains("shared_dir_name"));
    }

    #[test]
    fn resolve_team_secrets_dir_prefers_teamclu_team_link() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets_dir = tmp.path().join("teamclu-team").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(secrets_dir.join("marker"), b"").unwrap();

        let resolved = resolve_team_secrets_dir(tmp.path(), None, "teamclu");
        assert_eq!(resolved, secrets_dir);
    }

    #[test]
    fn team_secrets_dir_candidates_includes_legacy_teamclaw_path() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("teamclaw").join("_secrets");
        std::fs::create_dir_all(&legacy).unwrap();

        let dirs = team_secrets_dir_candidates(tmp.path(), None, "teamclu-team");
        assert!(dirs.contains(&legacy));
    }

    #[test]
    fn load_team_env_for_workspace_reads_legacy_teamclaw_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let env_secret = "33".repeat(32);
        let config_dir = tmp.path().join(".teamclu");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("teamclu.json"),
            serde_json::json!({
                "team": { "envSecret": env_secret }
            })
            .to_string(),
        )
        .unwrap();
        let secrets_dir = tmp.path().join("teamclaw").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(
            secrets_dir.join("s3_bucket.enc.json"),
            encrypted_secret_file(&env_secret, "s3_bucket", "my-bucket"),
        )
        .unwrap();

        let env = load_team_env_for_workspace(tmp.path(), None);
        assert_eq!(env.get("s3_bucket"), Some(&"my-bucket".to_string()));
    }

    #[test]
    fn load_team_env_for_workspace_reads_git_shared_dir_name() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join(".teamclu");
        std::fs::create_dir_all(&config_dir).unwrap();
        let env_secret = "44".repeat(32);
        std::fs::write(
            config_dir.join("teamclu.json"),
            serde_json::json!({
                "team": {
                    "gitUrl": "https://example.com/team.git",
                    "sharedDirName": "teamclu",
                    "envSecret": env_secret
                }
            })
            .to_string(),
        )
        .unwrap();
        let secrets_dir = tmp.path().join("teamclu").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(
            secrets_dir.join("git_team_key.enc.json"),
            encrypted_secret_file(&env_secret, "git_team_key", "from-git-dir"),
        )
        .unwrap();

        let env = load_team_env_for_workspace(tmp.path(), None);
        assert_eq!(env.get("git_team_key"), Some(&"from-git-dir".to_string()));
    }

    #[test]
    fn load_team_env_for_workspace_reads_teamclu_team_without_git_url() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join(".teamclu");
        std::fs::create_dir_all(&config_dir).unwrap();
        let env_secret = "22".repeat(32);
        std::fs::write(
            config_dir.join("teamclu.json"),
            serde_json::json!({
                "team": {
                    "enabled": true,
                    "envSecret": env_secret
                }
            })
            .to_string(),
        )
        .unwrap();
        let secrets_dir = tmp.path().join("teamclu-team").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(
            secrets_dir.join("log_search_site.enc.json"),
            encrypted_secret_file(&env_secret, "log_search_site", "https://logs.example"),
        )
        .unwrap();

        let env = load_team_env_for_workspace(tmp.path(), None);
        assert_eq!(
            env.get("log_search_site"),
            Some(&"https://logs.example".to_string())
        );
    }

    #[test]
    fn malformed_secret_files_do_not_suppress_valid_env() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets_dir = tmp.path().join("teamclu").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(secrets_dir.join("bad.enc.json"), "{not json").unwrap();

        let env_secret = "11".repeat(32);
        std::fs::write(
            secrets_dir.join("good.enc.json"),
            encrypted_secret_file(&env_secret, "SHARED_TOKEN", "secret"),
        )
        .unwrap();

        let env = load_team_env(tmp.path(), "teamclu", &env_secret).unwrap();
        assert_eq!(env.get("SHARED_TOKEN").unwrap(), "secret");
    }

    #[test]
    fn wrong_team_secret_never_injects_an_encrypted_value() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets_dir = tmp.path().join("teamclu").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        let writer_secret = "66".repeat(32);
        std::fs::write(
            secrets_dir.join("shared_token.enc.json"),
            encrypted_secret_file(&writer_secret, "shared_token", "must-not-leak"),
        )
        .unwrap();

        let env = load_team_env(tmp.path(), "teamclu", &"77".repeat(32)).unwrap();

        assert!(env.is_empty(), "a key mismatch must fail closed");

        let detailed =
            load_team_env_from_secrets_dir_detailed(&secrets_dir, &"77".repeat(32)).unwrap();
        assert_eq!(detailed.unresolved_keys, vec!["shared_token"]);
        assert!(detailed.source_paths.is_empty());
    }

    #[test]
    fn load_team_env_decrypts_pre_rename_teamclaw_salt() {
        use aes_gcm::aead::Aead;
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        use hkdf::Hkdf;
        use sha2::Sha256;

        let tmp = tempfile::tempdir().unwrap();
        let secrets_dir = tmp.path().join("teamclu").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();

        let env_secret = "99".repeat(32);
        let ikm = hex::decode(&env_secret).unwrap();
        let hk = Hkdf::<Sha256>::new(Some(b"teamclaw-secrets-v1"), &ikm);
        let mut key = [0u8; 32];
        hk.expand(b"aes-256-gcm", &mut key).unwrap();
        let entry = SecretEntry {
            key_id: "legacy_salt_token".to_string(),
            key: "from-pre-rename".to_string(),
            ..Default::default()
        };
        let plaintext = serde_json::to_vec(&entry).unwrap();
        let nonce = [3u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
            .unwrap();
        let envelope = EncryptedEnvelope {
            v: 1,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        };
        std::fs::write(
            secrets_dir.join("legacy_salt_token.enc.json"),
            serde_json::to_string(&envelope).unwrap(),
        )
        .unwrap();

        let env = load_team_env(tmp.path(), "teamclu", &env_secret).unwrap();
        assert_eq!(
            env.get("LEGACY_SALT_TOKEN").map(String::as_str),
            Some("from-pre-rename")
        );
    }

    #[test]
    fn daemon_secret_survives_restart_and_decrypts_team_env_file() {
        let workspace = tempfile::tempdir().unwrap();
        let daemon_state = tempfile::tempdir().unwrap();
        let team_id = "restart-team";
        let team_secret = "88".repeat(32);

        // Persist as the desktop-to-daemon secret delivery endpoint does, then
        // recreate the store to model an amuxd restart.
        store_with_secret(daemon_state.path(), team_id, &team_secret);
        let restarted_store =
            crate::sync::secret_store::SecretStore::with_base(daemon_state.path().to_path_buf());
        let restored_secret =
            resolve_env_secret_with(&restarted_store, workspace.path(), Some(team_id))
                .expect("daemon secret must persist across restart");

        let secrets_dir = workspace.path().join("teamclu-team").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(
            secrets_dir.join("restart_token.enc.json"),
            encrypted_secret_file(&team_secret, "restart_token", "available-after-restart"),
        )
        .unwrap();

        let env = load_team_env_from_secrets_dir(&secrets_dir, &restored_secret).unwrap();
        assert_eq!(
            env.get("RESTART_TOKEN").map(String::as_str),
            Some("available-after-restart")
        );
    }

    #[test]
    fn load_team_env_for_workspace_merges_all_candidate_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let env_secret = "55".repeat(32);
        let config_dir = tmp.path().join(".teamclu");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("teamclu.json"),
            serde_json::json!({
                "team": {
                    "sharedDirName": "teamclu-team",
                    "envSecret": env_secret
                }
            })
            .to_string(),
        )
        .unwrap();

        let global_like = tmp.path().join("teamclu-team").join("_secrets");
        std::fs::create_dir_all(&global_like).unwrap();
        std::fs::write(
            global_like.join("from_global.enc.json"),
            encrypted_secret_file(&env_secret, "from_global", "global-value"),
        )
        .unwrap();

        let legacy = tmp.path().join("teamclaw").join("_secrets");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            legacy.join("from_local.enc.json"),
            encrypted_secret_file(&env_secret, "from_local", "local-value"),
        )
        .unwrap();
        std::fs::write(
            legacy.join("from_global.enc.json"),
            encrypted_secret_file(&env_secret, "from_global", "local-override"),
        )
        .unwrap();

        let env = load_team_env_for_workspace(tmp.path(), None);
        assert_eq!(
            env.get("from_global"),
            Some(&"local-override".to_string()),
            "later candidate dirs should override duplicate keys"
        );
        assert_eq!(
            env.get("from_local"),
            Some(&"local-value".to_string()),
            "keys from later dirs should be included"
        );
    }

    #[test]
    fn tc_api_key_is_dropped_from_secrets() {
        // tc_api_key is derived locally at env-assembly time, never sourced from
        // team `_secrets`, so any stale copy on disk must be ignored here.
        let tmp = tempfile::tempdir().unwrap();
        let secrets_dir = tmp.path().join("teamclu").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();

        let env_secret = "22".repeat(32);
        std::fs::write(
            secrets_dir.join("key.enc.json"),
            encrypted_secret_file(&env_secret, "tc_api_key", "stale-disk-value"),
        )
        .unwrap();
        std::fs::write(
            secrets_dir.join("other.enc.json"),
            encrypted_secret_file(&env_secret, "SHARED_TOKEN", "keep-me"),
        )
        .unwrap();

        let env = load_team_env(tmp.path(), "teamclu", &env_secret).unwrap();
        assert!(!env.contains_key("tc_api_key"));
        assert!(!env.contains_key("TC_API_KEY"));
        assert_eq!(env.get("SHARED_TOKEN").unwrap(), "keep-me");
    }
}
