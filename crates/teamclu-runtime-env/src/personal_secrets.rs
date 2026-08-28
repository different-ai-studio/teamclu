use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tracing::warn;

use crate::{brand_short_name_from_env, resolve_storage_dir_name};

#[derive(Debug, Clone)]
struct SecretStorePaths {
    master_key_path: PathBuf,
    blob_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedBlobFile {
    nonce_b64: String,
    ciphertext_b64: String,
}

impl SecretStorePaths {
    fn for_storage_dir(storage_dir: &str) -> Option<Self> {
        let home = dirs::home_dir()?;
        Some(Self::for_base_dir(
            home.join(format!(".{storage_dir}")).join("secrets"),
        ))
    }

    fn for_base_dir(base_dir: PathBuf) -> Self {
        Self {
            master_key_path: base_dir.join("master.key"),
            blob_path: base_dir.join("personal-secrets.json.enc"),
        }
    }
}

fn load_master_key(paths: &SecretStorePaths) -> anyhow::Result<[u8; 32]> {
    let raw = std::fs::read(&paths.master_key_path)?;
    raw.try_into()
        .map_err(|_| anyhow::anyhow!("Invalid master key length"))
}

fn read_secret_blob(
    paths: &SecretStorePaths,
) -> anyhow::Result<serde_json::Map<String, serde_json::Value>> {
    if !paths.blob_path.exists() {
        return Ok(serde_json::Map::new());
    }

    let key = load_master_key(paths)?;
    let cipher = Aes256Gcm::new_from_slice(&key)?;
    let file: EncryptedBlobFile = serde_json::from_slice(&std::fs::read(&paths.blob_path)?)?;

    let nonce_bytes = B64.decode(&file.nonce_b64)?;
    if nonce_bytes.len() != 12 {
        anyhow::bail!("Invalid nonce length {}", nonce_bytes.len());
    }
    let ciphertext = B64.decode(&file.ciphertext_b64)?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| anyhow::anyhow!("Failed to decrypt secret blob (authentication failed)"))?;

    let value: serde_json::Value = serde_json::from_slice(&plaintext)?;
    match value {
        serde_json::Value::Object(map) => Ok(map),
        _ => anyhow::bail!("Secret blob JSON must be an object"),
    }
}

fn string_env_from_map(map: serde_json::Map<String, serde_json::Value>) -> HashMap<String, String> {
    map.into_iter()
        .filter_map(|(key, value)| value.as_str().map(|s| (key, s.to_string())))
        .collect()
}

/// Keys seeded by the desktop runtime into the personal blob but not shown in
/// the workspace `envVars` index (system / team-secret material).
pub fn is_internal_personal_blob_key(key: &str) -> bool {
    key == "tc_gateway_token" || key.starts_with("_team_secret.")
}

pub fn count_user_personal_env_keys(env: &HashMap<String, String>) -> usize {
    env.keys()
        .filter(|key| !is_internal_personal_blob_key(key))
        .count()
}

pub fn user_personal_env_from_map(
    map: serde_json::Map<String, serde_json::Value>,
) -> HashMap<String, String> {
    string_env_from_map(map)
        .into_iter()
        .filter(|(key, _)| !is_internal_personal_blob_key(key))
        .collect()
}

/// Load personal env for the process brand ([`brand_short_name_from_env`]).
///
/// Desktop sets `TEAMCLU_BRAND_SHORT_NAME` when spawning amuxd so white-label
/// builds read `~/.{brand}/secrets` instead of always `~/.teamclu`.
pub fn load_personal_env() -> anyhow::Result<HashMap<String, String>> {
    load_personal_env_for_brand(&brand_short_name_from_env())
}

/// Load decrypted personal env vars for a build `brand_short_name` (`teamclu`,
/// `copilot361`, …). Only `teamclu` resolves to `~/.teamclu/secrets`; every
/// other name gets `~/.{brand}/secrets` (see [`crate::is_official_brand`]).
pub fn load_personal_env_for_brand(
    brand_short_name: &str,
) -> anyhow::Result<HashMap<String, String>> {
    load_personal_env_for_storage_dir(resolve_storage_dir_name(brand_short_name))
}

// ── Personal env index ───────────────────────────────────────────────────────
//
// The *values* live in the encrypted blob above, keyed by name and nothing else.
// Descriptions and categories (`system` / `system-shared`) have nowhere to go in
// there, so they live in this index — a plain, non-secret JSON file next to the
// blob, in the same machine-global directory.
//
// It used to be an `envVars` array inside every `<workspace>/{meta}/{brand}.json`,
// which made a machine-global fact per-workspace: the same key described twice
// with different text in two checkouts, and a fresh workspace showing none of the
// keys it can actually resolve. `read_personal_env_index_for_brand` still folds in
// a legacy workspace copy so nothing disappears before the desktop rewrites it.

const ENV_INDEX_FILE: &str = "env-index.json";

/// One index row: a key plus what the UI needs to describe it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalEnvIndexEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `system` (seeded by the desktop each launch) / `system-shared` (value in
    /// the team KMS) / absent for a user key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersonalEnvIndexFile {
    #[serde(rename = "envVars", default)]
    env_vars: Vec<PersonalEnvIndexEntry>,
}

/// `~/.{brand}/secrets/env-index.json`.
pub fn personal_env_index_path_for_brand(brand_short_name: &str) -> Option<PathBuf> {
    let storage_dir = resolve_storage_dir_name(brand_short_name);
    let home = dirs::home_dir()?;
    Some(
        home.join(format!(".{storage_dir}"))
            .join("secrets")
            .join(ENV_INDEX_FILE),
    )
}

/// The machine-level index. Missing or unparseable reads as empty — it is
/// metadata, and losing it must never hide a key whose value the blob still has.
pub fn read_personal_env_index_for_brand(brand_short_name: &str) -> Vec<PersonalEnvIndexEntry> {
    let Some(path) = personal_env_index_path_for_brand(brand_short_name) else {
        return Vec::new();
    };
    let Ok(body) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    match serde_json::from_str::<PersonalEnvIndexFile>(&body) {
        Ok(file) => file.env_vars,
        Err(e) => {
            warn!(path = %path.display(), error = %e, "personal env index unreadable; treating as empty");
            Vec::new()
        }
    }
}

pub fn write_personal_env_index_for_brand(
    brand_short_name: &str,
    entries: &[PersonalEnvIndexEntry],
) -> anyhow::Result<()> {
    let path = personal_env_index_path_for_brand(brand_short_name)
        .ok_or_else(|| anyhow::anyhow!("no home directory"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(&PersonalEnvIndexFile {
        env_vars: entries.to_vec(),
    })?;
    std::fs::write(&path, body)?;
    Ok(())
}

/// Merge two index lists, first-wins per key (case-insensitive).
pub fn merge_personal_env_index(
    preferred: Vec<PersonalEnvIndexEntry>,
    fallback: Vec<PersonalEnvIndexEntry>,
) -> Vec<PersonalEnvIndexEntry> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for entry in preferred.into_iter().chain(fallback) {
        if seen.insert(entry.key.to_ascii_lowercase()) {
            out.push(entry);
        }
    }
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

/// Non-secret diagnostics for the encrypted personal env store (paths + counts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalEnvStoreDiagnostics {
    pub storage_dir: String,
    pub secrets_dir: String,
    pub master_key_exists: bool,
    pub blob_exists: bool,
    pub blob_readable: bool,
    pub blob_error: Option<String>,
    /// All string keys in the encrypted blob (includes system-seeded keys).
    pub stored_var_count: usize,
    /// User-configured personal keys only (`tc_gateway_token` / `_team_secret.*` excluded).
    pub user_stored_var_count: usize,
}

/// Diagnose the personal store for the process brand ([`brand_short_name_from_env`]).
pub fn diagnose_personal_env_store() -> PersonalEnvStoreDiagnostics {
    diagnose_personal_env_store_for_brand(&brand_short_name_from_env())
}

pub fn diagnose_personal_env_store_for_brand(
    brand_short_name: &str,
) -> PersonalEnvStoreDiagnostics {
    diagnose_personal_env_store_for_storage_dir(resolve_storage_dir_name(brand_short_name))
}

fn diagnose_personal_env_store_for_storage_dir(storage_dir: &str) -> PersonalEnvStoreDiagnostics {
    let Some(paths) = SecretStorePaths::for_storage_dir(storage_dir) else {
        return PersonalEnvStoreDiagnostics {
            storage_dir: storage_dir.to_string(),
            secrets_dir: String::new(),
            master_key_exists: false,
            blob_exists: false,
            blob_readable: false,
            blob_error: Some("home directory not found".to_string()),
            stored_var_count: 0,
            user_stored_var_count: 0,
        };
    };

    let secrets_dir = paths
        .blob_path
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let master_key_exists = paths.master_key_path.exists();
    let blob_exists = paths.blob_path.exists();

    match read_secret_blob(&paths) {
        Ok(map) => {
            let env = string_env_from_map(map);
            PersonalEnvStoreDiagnostics {
                storage_dir: storage_dir.to_string(),
                secrets_dir,
                master_key_exists,
                blob_exists,
                blob_readable: true,
                blob_error: None,
                user_stored_var_count: count_user_personal_env_keys(&env),
                stored_var_count: env.len(),
            }
        }
        Err(err) => PersonalEnvStoreDiagnostics {
            storage_dir: storage_dir.to_string(),
            secrets_dir,
            master_key_exists,
            blob_exists,
            blob_readable: false,
            blob_error: Some(err.to_string()),
            stored_var_count: 0,
            user_stored_var_count: 0,
        },
    }
}

fn load_personal_env_for_storage_dir(storage_dir: &str) -> anyhow::Result<HashMap<String, String>> {
    let Some(paths) = SecretStorePaths::for_storage_dir(storage_dir) else {
        return Ok(HashMap::new());
    };

    match read_secret_blob(&paths) {
        Ok(map) => Ok(string_env_from_map(map)),
        Err(err) => {
            warn!(
                storage_dir,
                error = %err,
                "Failed to read personal secrets; using empty env"
            );
            Ok(HashMap::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the tests assert against the unbranded default, so importing it at
    // module scope left a dead import in every non-test build.
    use crate::test_util::{home_env_lock, HomeGuard};
    use crate::OFFICIAL_STORAGE_DIR;
    use aes_gcm::aead::{Aead, KeyInit};
    use rand::RngCore;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_secret_blob_for_test(
        paths: &SecretStorePaths,
        map: &serde_json::Map<String, serde_json::Value>,
    ) {
        std::fs::create_dir_all(
            paths
                .master_key_path
                .parent()
                .expect("master key has parent"),
        )
        .unwrap();

        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        std::fs::write(&paths.master_key_path, key).unwrap();

        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let plaintext = serde_json::to_vec(map).unwrap();
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher.encrypt(nonce, plaintext.as_ref()).unwrap();

        let file = EncryptedBlobFile {
            nonce_b64: B64.encode(nonce_bytes),
            ciphertext_b64: B64.encode(ciphertext),
        };
        let blob_bytes = serde_json::to_vec_pretty(&file).unwrap();
        std::fs::File::create(&paths.blob_path)
            .unwrap()
            .write_all(&blob_bytes)
            .unwrap();
    }

    #[test]
    fn internal_personal_blob_keys_are_excluded_from_user_count() {
        let mut env = HashMap::new();
        env.insert("MY_API_KEY".to_string(), "secret".to_string());
        env.insert("tc_gateway_token".to_string(), "tok_x".to_string());
        env.insert("_team_secret.abc".to_string(), "team-secret".to_string());
        assert_eq!(super::count_user_personal_env_keys(&env), 1);
        assert!(super::is_internal_personal_blob_key("tc_gateway_token"));
        assert!(super::is_internal_personal_blob_key("_team_secret.team-1"));
        assert!(!super::is_internal_personal_blob_key("MY_API_KEY"));
    }

    #[test]
    fn diagnose_personal_env_store_reports_missing_blob() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        let _home = HomeGuard::set(dir.path());
        std::env::remove_var(crate::BRAND_SHORT_NAME_ENV);

        let diag = super::diagnose_personal_env_store();
        assert_eq!(diag.storage_dir, OFFICIAL_STORAGE_DIR);
        assert!(!diag.blob_exists);
        assert!(diag.blob_readable);
        assert_eq!(diag.stored_var_count, 0);
    }

    #[test]
    fn load_personal_env_reads_encrypted_blob() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        let _home = HomeGuard::set(dir.path());
        std::env::remove_var(crate::BRAND_SHORT_NAME_ENV);

        let secrets_dir = dir
            .path()
            .join(format!(".{OFFICIAL_STORAGE_DIR}"))
            .join("secrets");
        let paths = SecretStorePaths::for_base_dir(secrets_dir);
        let mut map = serde_json::Map::new();
        map.insert("my_key".into(), serde_json::Value::String("secret".into()));
        write_secret_blob_for_test(&paths, &map);

        let env = load_personal_env().unwrap();
        assert_eq!(env.get("my_key"), Some(&"secret".to_string()));
    }

    #[test]
    fn load_personal_env_respects_brand_short_name_env() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        let _home = HomeGuard::set(dir.path());

        let teamclu_secrets = dir
            .path()
            .join(format!(".{OFFICIAL_STORAGE_DIR}"))
            .join("secrets");
        let mut teamclu_map = serde_json::Map::new();
        teamclu_map.insert(
            "FROM_TEAMCLU".into(),
            serde_json::Value::String("tc".into()),
        );
        write_secret_blob_for_test(
            &SecretStorePaths::for_base_dir(teamclu_secrets),
            &teamclu_map,
        );

        let c361_secrets = dir.path().join(".copilot361").join("secrets");
        let mut c361_map = serde_json::Map::new();
        c361_map.insert(
            "FROM_COPILOT361".into(),
            serde_json::Value::String("c361".into()),
        );
        write_secret_blob_for_test(&SecretStorePaths::for_base_dir(c361_secrets), &c361_map);

        std::env::set_var(crate::BRAND_SHORT_NAME_ENV, "copilot361");
        let env = load_personal_env().unwrap();
        assert_eq!(env.get("FROM_COPILOT361"), Some(&"c361".to_string()));
        assert!(!env.contains_key("FROM_TEAMCLU"));

        std::env::remove_var(crate::BRAND_SHORT_NAME_ENV);
        let env = load_personal_env().unwrap();
        assert_eq!(env.get("FROM_TEAMCLU"), Some(&"tc".to_string()));
        assert!(!env.contains_key("FROM_COPILOT361"));
    }

    #[test]
    fn load_personal_env_skips_non_string_values() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        let _home = HomeGuard::set(dir.path());

        let secrets_dir = dir
            .path()
            .join(format!(".{OFFICIAL_STORAGE_DIR}"))
            .join("secrets");
        let paths = SecretStorePaths::for_base_dir(secrets_dir);
        let mut map = serde_json::Map::new();
        map.insert("str_key".into(), serde_json::Value::String("value".into()));
        map.insert("num_key".into(), serde_json::Value::Number(42.into()));
        write_secret_blob_for_test(&paths, &map);

        let env = load_personal_env().unwrap();
        assert_eq!(env.get("str_key"), Some(&"value".to_string()));
        assert!(!env.contains_key("num_key"));
    }

    #[test]
    fn load_personal_env_returns_empty_when_blob_missing() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        let _home = HomeGuard::set(dir.path());

        let env = load_personal_env().unwrap();
        assert!(env.is_empty());
    }

    #[test]
    fn load_personal_env_returns_empty_on_decrypt_failure() {
        let _lock = home_env_lock();
        let dir = tempdir().unwrap();
        let _home = HomeGuard::set(dir.path());

        let secrets_dir = dir
            .path()
            .join(format!(".{OFFICIAL_STORAGE_DIR}"))
            .join("secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        let paths = SecretStorePaths::for_base_dir(secrets_dir);
        let mut map = serde_json::Map::new();
        map.insert("my_key".into(), serde_json::Value::String("secret".into()));
        write_secret_blob_for_test(&paths, &map);

        let mut blob = std::fs::read(&paths.blob_path).unwrap();
        blob[0] ^= 0x01;
        std::fs::write(&paths.blob_path, blob).unwrap();

        let env = load_personal_env().unwrap();
        assert!(env.is_empty());
    }
}
