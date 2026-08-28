//! Canonical env-var catalog — list and resolve metadata from one source.
//!
//! - Personal/system: `{workspace}/{meta}/{brand}.json` → `envVars`
//! - Team: `{sharedDirName}/_secrets/*.enc.json` (Git default: `teamclu/_secrets`)
//!
//! Desktop writes go through `env_catalog_set` / `env_catalog_delete`; daemon
//! runtime injection decrypts the same team paths via `team_shared_env`.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tracing::warn;

use crate::storage_namespace::resolve_workspace_config_path;
use crate::team_crypto::{self, EncryptedEnvelope};
use crate::team_provider;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalEnvListing {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEnvListing {
    pub key_id: String,
    pub description: String,
    pub category: String,
    pub created_by: String,
    pub updated_by: String,
    pub updated_at: String,
    /// `true` when the encrypted file decrypted with the local team secret.
    /// `false` means the file exists (so the key is known from its name) but the
    /// local secret is missing or wrong — the metadata/value could not be read.
    /// The UI surfaces these as "not decrypted" rather than dropping the key.
    #[serde(default = "default_decrypted")]
    pub decrypted: bool,
    /// Only meaningful when `decrypted == false`. `true` means a local team
    /// secret *was* available but this file failed to decrypt under it (wrong /
    /// rotated key). `false` means no local secret was available at all
    /// (missing). Lets the UI say "key mismatch" vs "no local key".
    #[serde(default)]
    pub key_mismatch: bool,
}

/// Entries predate the `decrypted` field, so a missing field means it decrypted.
fn default_decrypted() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCatalog {
    pub personal: Vec<PersonalEnvListing>,
    pub team: Vec<TeamEnvListing>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEnvListing {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

const SECRETS_SUBDIR: &str = "_secrets";

fn workspace_config_path(workspace: &Path, brand_short_name: &str) -> PathBuf {
    resolve_workspace_config_path(workspace, brand_short_name)
}

fn read_teamclu_config_for_brand(
    workspace: &Path,
    brand_short_name: &str,
) -> Option<serde_json::Value> {
    let body = std::fs::read_to_string(workspace_config_path(workspace, brand_short_name)).ok()?;
    serde_json::from_str(&body).ok()
}

fn read_team_json_env_secret(workspace: &Path, brand_short_name: &str) -> Option<String> {
    read_teamclu_config_for_brand(workspace, brand_short_name)?
        .get("team")?
        .get("envSecret")?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Team env decryption key from `team.envSecret` or `_team_secret.{team_id}` blob.
pub fn resolve_team_env_secret(
    workspace: &Path,
    team_id: Option<&str>,
    brand_short_name: Option<&str>,
) -> Option<String> {
    let brand = brand_short_name.unwrap_or("teamclu");
    if let Some(secret) = read_team_json_env_secret(workspace, brand) {
        return Some(secret);
    }
    let team_id = team_id.filter(|id| !id.trim().is_empty())?;
    let blob_key = format!("_team_secret.{team_id}");
    crate::personal_secrets::load_personal_env_for_brand(brand)
        .ok()
        .and_then(|env| env.get(&blob_key).cloned())
        .filter(|s| !s.trim().is_empty())
}

pub fn read_teamclu_config(workspace: &Path) -> Option<serde_json::Value> {
    read_teamclu_config_for_brand(workspace, "teamclu")
}

/// Team shared directory for writes: `{workspace}/{sharedDirName}`.
pub fn resolve_team_dir_for_workspace(workspace: &Path) -> PathBuf {
    workspace.join(team_provider::resolve_shared_dir_name(workspace))
}

/// Workspace-local `_secrets/` candidates, most preferred first.
///
/// Git teams default to `{workspace}/teamclu/_secrets`; newer layouts use the
/// `teamclu-team` symlink. Callers with a global team store can prepend extra paths.
pub fn team_secrets_dir_candidates_workspace(
    workspace: &Path,
    shared_dir_name: &str,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |path: PathBuf| {
        if seen.insert(path.clone()) {
            out.push(path);
        }
    };

    push(
        workspace
            .join(crate::DEFAULT_TEAM_REPO_DIR)
            .join(SECRETS_SUBDIR),
    );
    if shared_dir_name != crate::DEFAULT_TEAM_REPO_DIR {
        push(workspace.join(shared_dir_name).join(SECRETS_SUBDIR));
    }
    // Legacy desktop default before sharedDirName was aligned with the team
    // drive dir. A path that exists on disk, so it keeps its pre-rebrand
    // spelling — "teamclu" here would name a directory nobody ever created.
    push(workspace.join("teamclaw").join(SECRETS_SUBDIR));
    out
}

fn derive_key(env_secret: &str) -> anyhow::Result<[u8; 32]> {
    Ok(team_crypto::derive_key(env_secret)?)
}

/// A key-only listing for a secret file that could not be decrypted. The key
/// name is still recoverable from the file name, so the UI can show the key with
/// a "not decrypted" warning instead of the key vanishing entirely.
/// `key_mismatch = true` when a local secret was present but decryption failed
/// (wrong / rotated key); `false` when no local secret was available at all.
fn undecrypted_listing(key_id: String, key_mismatch: bool) -> TeamEnvListing {
    TeamEnvListing {
        key_id,
        description: String::new(),
        category: "team".to_string(),
        created_by: String::new(),
        updated_by: String::new(),
        updated_at: String::new(),
        decrypted: false,
        key_mismatch,
    }
}

fn key_id_from_file_name(file_name: &str) -> Option<String> {
    file_name.strip_suffix(".enc.json").map(str::to_string)
}

/// List every `<key_id>.enc.json` in `secrets_dir` as an undecrypted listing.
/// `key_mismatch` distinguishes "secret present but couldn't decrypt this dir"
/// (malformed secret) from "no secret available at all".
fn load_team_env_keys_from_dir(secrets_dir: &Path, key_mismatch: bool) -> Vec<TeamEnvListing> {
    let Ok(read_dir) = std::fs::read_dir(secrets_dir) else {
        return Vec::new();
    };
    read_dir
        .flatten()
        .filter_map(|entry| key_id_from_file_name(&entry.file_name().to_string_lossy()))
        .map(|key_id| undecrypted_listing(key_id, key_mismatch))
        .collect()
}

/// Decrypt every secret file under `secrets_dir`. A file that cannot be read,
/// parsed, or decrypted still yields a key-only (`decrypted: false`) listing so
/// the key stays visible with a warning rather than silently disappearing.
fn load_team_env_metas_from_dir(secrets_dir: &Path, env_secret: &str) -> Vec<TeamEnvListing> {
    if !secrets_dir.exists() {
        return Vec::new();
    }

    // A malformed team secret (wrong length / non-hex) can't decrypt anything;
    // fall back to key-only listings for the whole directory. A secret *was*
    // present, so mark these as a key mismatch. Per-file decrypt goes through
    // `decrypt_secret_for_team` so pre-rename (teamclaw salt) envelopes still open.
    if let Err(e) = derive_key(env_secret) {
        warn!(dir = %secrets_dir.display(), "env_catalog: invalid team secret, listing keys only: {e}");
        return load_team_env_keys_from_dir(secrets_dir, true);
    }

    let read_dir = match std::fs::read_dir(secrets_dir) {
        Ok(read_dir) => read_dir,
        Err(e) => {
            warn!(dir = %secrets_dir.display(), "env_catalog: failed to read team secret directory: {e}");
            return Vec::new();
        }
    };

    let mut out = Vec::new();
    for entry in read_dir {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(e) => {
                warn!("env_catalog: failed to read team secret directory entry: {e}");
                continue;
            }
        };
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(file_key) = key_id_from_file_name(file_name) else {
            continue;
        };
        let body = match std::fs::read_to_string(&path) {
            Ok(body) => body,
            Err(e) => {
                warn!(path = %path.display(), "env_catalog: failed to read team secret file: {e}");
                out.push(undecrypted_listing(file_key, true));
                continue;
            }
        };
        let envelope: EncryptedEnvelope = match serde_json::from_str(&body) {
            Ok(envelope) => envelope,
            Err(e) => {
                warn!(path = %path.display(), "env_catalog: failed to parse team secret file: {e}");
                out.push(undecrypted_listing(file_key, true));
                continue;
            }
        };
        let secret = match team_crypto::decrypt_secret_for_team(&envelope, env_secret) {
            Ok(secret) => secret,
            Err(e) => {
                warn!(path = %path.display(), "env_catalog: failed to decrypt team secret file: {e}");
                out.push(undecrypted_listing(file_key, true));
                continue;
            }
        };
        out.push(TeamEnvListing {
            key_id: secret.key_id,
            description: secret.description,
            category: if secret.category.is_empty() {
                "custom".to_string()
            } else {
                secret.category
            },
            created_by: secret.created_by,
            updated_by: secret.updated_by,
            updated_at: secret.updated_at,
            decrypted: true,
            key_mismatch: false,
        });
    }
    out
}

/// Load team secret metadata by scanning all workspace `_secrets/` candidates.
///
/// When the local team secret is missing or wrong, keys are still listed (from
/// the file names) with `decrypted: false`. A decrypted listing always wins over
/// an undecrypted one for the same key across candidate directories.
pub fn load_team_env_listings(
    workspace: &Path,
    team_id: Option<&str>,
    brand_short_name: Option<&str>,
) -> Vec<TeamEnvListing> {
    let shared_dir_name = team_provider::resolve_shared_dir_name(workspace);
    let env_secret = resolve_team_env_secret(workspace, team_id, brand_short_name);

    let mut out: Vec<TeamEnvListing> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for secrets_dir in team_secrets_dir_candidates_workspace(workspace, &shared_dir_name) {
        let listings = match &env_secret {
            Some(secret) => load_team_env_metas_from_dir(&secrets_dir, secret),
            None => load_team_env_keys_from_dir(&secrets_dir, false),
        };
        for listing in listings {
            let lower = listing.key_id.to_ascii_lowercase();
            match index.get(&lower) {
                // Prefer a decrypted listing over a previously-seen undecrypted one.
                Some(&i) => {
                    if listing.decrypted && !out[i].decrypted {
                        out[i] = listing;
                    }
                }
                None => {
                    index.insert(lower, out.len());
                    out.push(listing);
                }
            }
        }
    }
    out.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    out
}

/// Personal env catalog: machine-global blob keys merged with workspace index metadata.
///
/// Values live in `~/.{brand}/secrets`; workspace `envVars` is only a description
/// / category cache (and system-seeded rows like `tc_gateway_token`).
pub fn load_personal_env_listings(
    workspace: &Path,
    brand_short_name: Option<&str>,
) -> Vec<PersonalEnvListing> {
    let brand = brand_short_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("teamclu");

    // Machine-level index first; a workspace copy an older build wrote is folded
    // in behind it so nothing disappears before the desktop rewrites the index.
    let machine_entries: Vec<PersonalEnvListing> =
        crate::personal_secrets::read_personal_env_index_for_brand(brand)
            .into_iter()
            .map(|entry| PersonalEnvListing {
                key: entry.key,
                description: entry.description,
                category: entry.category,
            })
            .collect();

    let legacy_entries: Vec<PersonalEnvListing> = read_teamclu_config_for_brand(workspace, brand)
        .and_then(|config| {
            config
                .get("envVars")
                .and_then(|v| v.as_array())
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| {
                            let key = entry.get("key")?.as_str()?.to_string();
                            Some(PersonalEnvListing {
                                key,
                                description: entry
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string),
                                category: entry
                                    .get("category")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string),
                            })
                        })
                        .collect()
                })
        })
        .unwrap_or_default();

    let mut by_lower: std::collections::HashMap<String, PersonalEnvListing> =
        std::collections::HashMap::new();

    // System / index-only rows first (e.g. tc_gateway_token before a value is present).
    // Legacy first so the machine copy overwrites it on a key both describe.
    for entry in legacy_entries.into_iter().chain(machine_entries) {
        by_lower.insert(entry.key.to_ascii_lowercase(), entry);
    }

    // Blob user keys are authoritative for machine-global personal vars.
    if let Ok(blob) = crate::personal_secrets::load_personal_env_for_brand(brand) {
        for key in blob.keys() {
            if crate::personal_secrets::is_internal_personal_blob_key(key) {
                continue;
            }
            let lower = key.to_ascii_lowercase();
            by_lower
                .entry(lower)
                .and_modify(|existing| {
                    // Prefer the blob's canonical key casing when index drifted.
                    if existing.key != *key {
                        existing.key = key.clone();
                    }
                })
                .or_insert_with(|| PersonalEnvListing {
                    key: key.clone(),
                    description: None,
                    category: None,
                });
        }
    }

    let mut out: Vec<PersonalEnvListing> = by_lower.into_values().collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

pub fn load_env_catalog(
    workspace: &Path,
    team_id: Option<&str>,
    brand_short_name: Option<&str>,
) -> EnvCatalog {
    EnvCatalog {
        personal: load_personal_env_listings(workspace, brand_short_name),
        team: load_team_env_listings(workspace, team_id, brand_short_name),
    }
}

/// Personal `envVars` index merged with team keys — shape used by agent tools.
pub fn load_agent_env_listings(
    workspace: &Path,
    team_id: Option<&str>,
    brand_short_name: Option<&str>,
) -> Vec<AgentEnvListing> {
    let personal = load_personal_env_listings(workspace, brand_short_name);
    let team = load_team_env_listings(workspace, team_id, brand_short_name);

    let mut out: Vec<AgentEnvListing> = personal
        .into_iter()
        .map(|entry| AgentEnvListing {
            key: entry.key,
            description: entry.description,
            category: entry.category,
        })
        .collect();

    let personal_keys: HashSet<String> = out
        .iter()
        .map(|entry| entry.key.to_ascii_lowercase())
        .collect();

    for meta in team {
        if personal_keys.contains(&meta.key_id.to_ascii_lowercase()) {
            continue;
        }
        out.push(AgentEnvListing {
            key: meta.key_id,
            description: if meta.description.is_empty() {
                None
            } else {
                Some(meta.description)
            },
            category: Some(if meta.category.is_empty() {
                "team".to_string()
            } else {
                meta.category
            }),
        });
    }

    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_crypto::SecretEntry;

    // The personal-secrets blob below is a different format (raw key, no HKDF,
    // `nonce_b64` fields), so it still builds its ciphertext by hand.
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    fn encrypted_secret_file(env_secret: &str, key_id: &str, key_value: &str) -> String {
        let key = derive_key(env_secret).unwrap();
        let entry = SecretEntry {
            key_id: key_id.to_string(),
            key: key_value.to_string(),
            description: "desc".to_string(),
            category: "custom".to_string(),
            created_by: "node-a".to_string(),
            updated_by: "node-a".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let envelope = team_crypto::encrypt_secret(&entry, &key).unwrap();
        serde_json::to_string(&envelope).unwrap()
    }

    #[test]
    fn git_team_listings_read_teamclu_shared_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let env_secret = "55".repeat(32);
        std::fs::create_dir_all(tmp.path().join(".teamclu")).unwrap();
        std::fs::write(
            tmp.path().join(".teamclu/teamclu.json"),
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
        let secrets_dir = tmp.path().join("teamclu/_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(
            secrets_dir.join("git_key.enc.json"),
            encrypted_secret_file(&env_secret, "git_key", "secret"),
        )
        .unwrap();

        let team = load_team_env_listings(tmp.path(), None, None);
        assert_eq!(team.len(), 1);
        assert_eq!(team[0].key_id, "git_key");
        assert_eq!(team[0].description, "desc");
    }

    #[test]
    fn wrong_team_secret_keeps_key_visible_as_undecrypted() {
        let tmp = tempfile::tempdir().unwrap();
        let real_secret = "55".repeat(32);
        let wrong_secret = "66".repeat(32);
        std::fs::create_dir_all(tmp.path().join(".teamclu")).unwrap();
        std::fs::write(
            tmp.path().join(".teamclu/teamclu.json"),
            serde_json::json!({
                "team": { "sharedDirName": "teamclu", "envSecret": wrong_secret }
            })
            .to_string(),
        )
        .unwrap();
        let secrets_dir = tmp.path().join("teamclu/_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        // Encrypted under the REAL secret, but the workspace config carries the WRONG one.
        std::fs::write(
            secrets_dir.join("api_key.enc.json"),
            encrypted_secret_file(&real_secret, "api_key", "secret"),
        )
        .unwrap();

        let team = load_team_env_listings(tmp.path(), None, None);
        assert_eq!(team.len(), 1, "key must stay visible, not vanish");
        assert_eq!(team[0].key_id, "api_key");
        assert!(!team[0].decrypted, "wrong key → marked not decrypted");
        assert!(team[0].key_mismatch, "secret present but wrong → mismatch");
        assert!(team[0].description.is_empty());
    }

    #[test]
    fn missing_team_secret_lists_keys_only_as_undecrypted() {
        let tmp = tempfile::tempdir().unwrap();
        let real_secret = "55".repeat(32);
        // Team config with NO envSecret and no team_id fallback → secret unresolved.
        std::fs::create_dir_all(tmp.path().join(".teamclu")).unwrap();
        std::fs::write(
            tmp.path().join(".teamclu/teamclu.json"),
            serde_json::json!({ "team": { "sharedDirName": "teamclu" } }).to_string(),
        )
        .unwrap();
        let secrets_dir = tmp.path().join("teamclu/_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(
            secrets_dir.join("api_key.enc.json"),
            encrypted_secret_file(&real_secret, "api_key", "secret"),
        )
        .unwrap();

        let team = load_team_env_listings(tmp.path(), None, None);
        assert_eq!(team.len(), 1);
        assert_eq!(team[0].key_id, "api_key");
        assert!(!team[0].decrypted);
        assert!(
            !team[0].key_mismatch,
            "no secret at all → missing, not mismatch"
        );
    }

    #[test]
    fn agent_listing_merges_personal_and_team_without_duplicates() {
        let _lock = crate::test_util::home_env_lock();
        let home = tempfile::tempdir().unwrap();
        let _home_guard = crate::test_util::HomeGuard::set(home.path());
        std::env::remove_var(crate::BRAND_SHORT_NAME_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let env_secret = "66".repeat(32);
        std::fs::create_dir_all(tmp.path().join(".teamclu")).unwrap();
        std::fs::write(
            tmp.path().join(".teamclu/teamclu.json"),
            serde_json::json!({
                "envVars": [
                    { "key": "tc_gateway_token", "category": "system" },
                    { "key": "mine", "description": "personal" }
                ],
                "team": {
                    "sharedDirName": "teamclu",
                    "envSecret": env_secret
                }
            })
            .to_string(),
        )
        .unwrap();
        let secrets_dir = tmp.path().join("teamclu/_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(
            secrets_dir.join("team_only.enc.json"),
            encrypted_secret_file(&env_secret, "team_only", "x"),
        )
        .unwrap();

        let listings = load_agent_env_listings(tmp.path(), None, None);
        let keys: Vec<_> = listings.iter().map(|entry| entry.key.as_str()).collect();
        assert!(keys.contains(&"tc_gateway_token"));
        assert!(keys.contains(&"mine"));
        assert!(keys.contains(&"team_only"));
        assert_eq!(keys.len(), 3);
    }

    #[test]
    fn personal_listings_include_blob_keys_missing_from_workspace_index() {
        let _lock = crate::test_util::home_env_lock();
        let home = tempfile::tempdir().unwrap();
        let _home_guard = crate::test_util::HomeGuard::set(home.path());
        std::env::remove_var(crate::BRAND_SHORT_NAME_ENV);

        write_personal_secret_blob(
            home.path(),
            &[
                ("ANTHROPIC_AUTH_TOKEN", "secret"),
                ("tc_gateway_token", "tok_x"),
                ("_team_secret.abc", "team"),
            ],
        );

        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join(".teamclu")).unwrap();
        std::fs::write(
            workspace.path().join(".teamclu/teamclu.json"),
            serde_json::json!({
                "envVars": [
                    { "key": "tc_gateway_token", "category": "system", "description": "Team LLM API Key" }
                ]
            })
            .to_string(),
        )
        .unwrap();

        let listings = load_personal_env_listings(workspace.path(), Some("teamclu"));
        let by_key: std::collections::HashMap<_, _> =
            listings.iter().map(|e| (e.key.as_str(), e)).collect();
        assert!(by_key.contains_key("ANTHROPIC_AUTH_TOKEN"));
        assert_eq!(
            by_key.get("tc_gateway_token").and_then(|e| e.category.as_deref()),
            Some("system")
        );
        assert!(!by_key.contains_key("_team_secret.abc"));
        assert_eq!(listings.len(), 2);
    }

    /// Write a personal-secrets blob (`$HOME/.teamclu/secrets/`) matching the
    /// layout `personal_secrets::load_personal_env` reads.
    fn write_personal_secret_blob(home: &Path, entries: &[(&str, &str)]) {
        let secrets_dir = home.join(".teamclu").join("secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        let key = [7_u8; 32];
        std::fs::write(secrets_dir.join("master.key"), key).unwrap();

        let map: serde_json::Map<String, serde_json::Value> = entries
            .iter()
            .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
            .collect();
        let plaintext = serde_json::to_vec(&map).unwrap();
        let nonce = [3_u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
            .unwrap();
        let blob = serde_json::json!({
            "nonce_b64": BASE64.encode(nonce),
            "ciphertext_b64": BASE64.encode(ciphertext),
        });
        std::fs::write(
            secrets_dir.join("personal-secrets.json.enc"),
            serde_json::to_vec(&blob).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn resolve_team_env_secret_falls_back_to_personal_blob_with_team_id() {
        let _lock = crate::test_util::home_env_lock();
        let home = tempfile::tempdir().unwrap();
        let _home_guard = crate::test_util::HomeGuard::set(home.path());

        // Workspace has a team config but NO inline `team.envSecret`.
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join(".teamclu")).unwrap();
        std::fs::write(
            workspace.path().join(".teamclu/teamclu.json"),
            serde_json::json!({ "team": { "sharedDirName": "teamclu" } }).to_string(),
        )
        .unwrap();

        let team_id = "4b8e9df9-c8c5-4d6b-b074-986eef7d02d1";
        let env_secret = "aa".repeat(32);
        write_personal_secret_blob(
            home.path(),
            &[(&format!("_team_secret.{team_id}"), &env_secret)],
        );

        // Without team_id the inline secret is missing → None (this was the bug:
        // the write/delete path passed None and hard-errored).
        assert_eq!(resolve_team_env_secret(workspace.path(), None, None), None);

        // With team_id the personal-blob fallback resolves the secret.
        assert_eq!(
            resolve_team_env_secret(workspace.path(), Some(team_id), None).as_deref(),
            Some(env_secret.as_str())
        );
    }

    #[test]
    fn white_label_reads_brand_config_and_legacy_fallback() {
        let workspace = tempfile::tempdir().unwrap();
        let brand = "copilot361";

        // Prefer brand config when present.
        std::fs::create_dir_all(workspace.path().join(".copilot361")).unwrap();
        std::fs::write(
            workspace.path().join(".copilot361/copilot361.json"),
            serde_json::json!({
                "envVars": [{ "key": "BRAND_KEY", "description": "from brand" }],
                "team": { "envSecret": "brand-secret" }
            })
            .to_string(),
        )
        .unwrap();
        let listings = load_personal_env_listings(workspace.path(), Some(brand));
        assert!(listings.iter().any(|e| e.key == "BRAND_KEY"));
        assert_eq!(
            resolve_team_env_secret(workspace.path(), None, Some(brand)).as_deref(),
            Some("brand-secret")
        );

        // Legacy-only workspace still resolves for white-label brand.
        let legacy_only = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(legacy_only.path().join(".teamclu")).unwrap();
        std::fs::write(
            legacy_only.path().join(".teamclu/teamclu.json"),
            serde_json::json!({
                "envVars": [{ "key": "LEGACY_KEY", "description": "from legacy" }],
                "team": { "envSecret": "legacy-secret" }
            })
            .to_string(),
        )
        .unwrap();
        let listings = load_personal_env_listings(legacy_only.path(), Some(brand));
        assert!(listings.iter().any(|e| e.key == "LEGACY_KEY"));
        assert_eq!(
            resolve_team_env_secret(legacy_only.path(), None, Some(brand)).as_deref(),
            Some("legacy-secret")
        );
    }
}
