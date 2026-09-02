//! Tests for the env-var commands.

use super::blob::derive_personal_env_index_from_blob;
use super::blob::read_env_blob;
use super::blob::read_personal_secret_blob_with_reader;
use super::blob::read_personal_secret_blob_with_reader_for_startup;
use super::blob::write_env_blob;
use super::catalog::env_var_delete_for_workspace;
use super::index::get_env_vars_from_json;
use super::index::read_env_index;
use super::index::read_teamclu_json;
use crate::commands::local_secret_store;

use crate::commands::local_secret_store::SecretStorePaths;
// One lock for every test in the crate that touches HOME — see test_home.
use crate::test_home::HomeGuard;
use tempfile::tempdir;

#[test]
fn read_env_blob_migrates_legacy_disk_snapshot_into_local_encrypted_store() {
    let home_dir = tempdir().unwrap();
    let workspace_dir = tempdir().unwrap();
    let _home = HomeGuard::set(home_dir.path());

    let legacy_blob_dir = home_dir
        .path()
        .join(format!(".{}", teamclu_runtime_env::OFFICIAL_STORAGE_DIR));
    std::fs::create_dir_all(&legacy_blob_dir).unwrap();

    let mut legacy_blob = serde_json::Map::new();
    legacy_blob.insert(
        "OPENAI_API_KEY".into(),
        serde_json::Value::String("legacy-secret".into()),
    );
    std::fs::write(
        legacy_blob_dir.join("env-blob.json"),
        serde_json::to_vec(&legacy_blob).unwrap(),
    )
    .unwrap();

    let workspace_path = workspace_dir.path().to_string_lossy().to_string();
    let loaded = read_env_blob(&workspace_path).unwrap();
    assert_eq!(loaded, legacy_blob);

    let paths = SecretStorePaths::for_home_dir().unwrap();
    assert!(
        paths.blob_path.exists(),
        "expected encrypted blob to be created"
    );
    let meta = crate::commands::local_secret_store::read_meta(&paths).unwrap();
    assert!(meta.migrated_from_keychain);

    std::fs::remove_file(legacy_blob_dir.join("env-blob.json")).unwrap();

    let mut updated_blob = loaded.clone();
    updated_blob.insert(
        "OPENAI_API_KEY".into(),
        serde_json::Value::String("local-secret".into()),
    );
    write_env_blob(&updated_blob).unwrap();

    let reloaded = read_env_blob(&workspace_path).unwrap();
    assert_eq!(
        reloaded.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
        Some("local-secret")
    );
}

#[test]
fn read_personal_secret_blob_merges_legacy_once_per_workspace() {
    let home_dir = tempdir().unwrap();
    let workspace_a = tempdir().unwrap();
    let workspace_b = tempdir().unwrap();
    let _home = HomeGuard::set(home_dir.path());

    let paths = SecretStorePaths::for_home_dir().unwrap();
    let workspace_a_path = workspace_a.path().to_string_lossy().to_string();
    let workspace_b_path = workspace_b.path().to_string_lossy().to_string();

    let first = read_personal_secret_blob_with_reader(&workspace_a_path, &paths, |wp| {
        let mut map = serde_json::Map::new();
        if wp == workspace_a_path {
            map.insert(
                "WORKSPACE_A_KEY".into(),
                serde_json::Value::String("a-secret".into()),
            );
        }
        Ok(Some(map))
    })
    .unwrap();
    assert_eq!(
        first.get("WORKSPACE_A_KEY").and_then(|v| v.as_str()),
        Some("a-secret")
    );

    let second = read_personal_secret_blob_with_reader(&workspace_b_path, &paths, |wp| {
        let mut map = serde_json::Map::new();
        if wp == workspace_b_path {
            map.insert(
                "WORKSPACE_B_KEY".into(),
                serde_json::Value::String("b-secret".into()),
            );
        }
        Ok(Some(map))
    })
    .unwrap();
    assert_eq!(
        second.get("WORKSPACE_A_KEY").and_then(|v| v.as_str()),
        Some("a-secret")
    );
    assert_eq!(
        second.get("WORKSPACE_B_KEY").and_then(|v| v.as_str()),
        Some("b-secret")
    );

    let third = read_personal_secret_blob_with_reader(&workspace_b_path, &paths, |_wp| {
        Err("legacy reader should not run after workspace migration".to_string())
    })
    .unwrap();
    assert_eq!(third, second);
}

#[test]
fn existing_blob_survives_legacy_reader_error_without_marking_complete() {
    let home_dir = tempdir().unwrap();
    let workspace_dir = tempdir().unwrap();
    let _home = HomeGuard::set(home_dir.path());

    let paths = SecretStorePaths::for_home_dir().unwrap();
    let workspace_path = workspace_dir.path().to_string_lossy().to_string();

    let mut blob = serde_json::Map::new();
    blob.insert(
        "OPENAI_API_KEY".into(),
        serde_json::Value::String("local-secret".into()),
    );
    local_secret_store::write_secret_blob(&paths, &blob).unwrap();

    let (first, retry_needed) =
        read_personal_secret_blob_with_reader_for_startup(&workspace_path, &paths, |_wp| {
            Err("simulated legacy reader failure".to_string())
        })
        .unwrap();
    assert_eq!(
        first.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
        Some("local-secret")
    );
    assert!(retry_needed);

    let second = read_personal_secret_blob_with_reader(&workspace_path, &paths, |_wp| {
        Err("legacy reader failure remains non-fatal on later reads".to_string())
    })
    .unwrap();
    assert_eq!(second, first);
}

#[test]
fn existing_blob_reads_even_if_teamclu_json_is_invalid() {
    let home_dir = tempdir().unwrap();
    let workspace_dir = tempdir().unwrap();
    let _home = HomeGuard::set(home_dir.path());

    let teamclu_dir = workspace_dir.path().join(super::super::TEAMCLU_DIR);
    std::fs::create_dir_all(&teamclu_dir).unwrap();
    std::fs::write(teamclu_dir.join(super::super::CONFIG_FILE_NAME), "{").unwrap();

    let paths = SecretStorePaths::for_home_dir().unwrap();
    let workspace_path = workspace_dir.path().to_string_lossy().to_string();

    let mut blob = serde_json::Map::new();
    blob.insert(
        "OPENAI_API_KEY".into(),
        serde_json::Value::String("local-secret".into()),
    );
    local_secret_store::write_secret_blob(&paths, &blob).unwrap();

    let loaded = read_personal_secret_blob_with_reader(&workspace_path, &paths, |_wp| {
        Err("legacy reader should not be required when local blob already exists".into())
    })
    .unwrap();

    assert_eq!(
        loaded.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
        Some("local-secret")
    );
}

#[test]
fn first_migration_succeeds_even_if_teamclu_json_is_invalid() {
    let home_dir = tempdir().unwrap();
    let workspace_dir = tempdir().unwrap();
    let _home = HomeGuard::set(home_dir.path());

    let teamclu_dir = workspace_dir.path().join(super::super::TEAMCLU_DIR);
    std::fs::create_dir_all(&teamclu_dir).unwrap();
    std::fs::write(teamclu_dir.join(super::super::CONFIG_FILE_NAME), "{").unwrap();

    let workspace_path = workspace_dir.path().to_string_lossy().to_string();
    let loaded = read_env_blob(&workspace_path).unwrap();
    assert!(loaded.is_empty());

    let paths = SecretStorePaths::for_home_dir().unwrap();
    assert!(
        paths.blob_path.exists(),
        "expected encrypted blob to be created"
    );
}

#[test]
fn startup_retry_is_requested_when_teamclu_json_is_invalid() {
    let home_dir = tempdir().unwrap();
    let workspace_dir = tempdir().unwrap();
    let _home = HomeGuard::set(home_dir.path());

    let teamclu_dir = workspace_dir.path().join(super::super::TEAMCLU_DIR);
    std::fs::create_dir_all(&teamclu_dir).unwrap();
    std::fs::write(teamclu_dir.join(super::super::CONFIG_FILE_NAME), "{").unwrap();

    let paths = SecretStorePaths::for_home_dir().unwrap();
    let workspace_path = workspace_dir.path().to_string_lossy().to_string();

    let mut blob = serde_json::Map::new();
    blob.insert(
        "OPENAI_API_KEY".into(),
        serde_json::Value::String("local-secret".into()),
    );
    local_secret_store::write_secret_blob(&paths, &blob).unwrap();

    let (loaded, retry_needed) =
        read_personal_secret_blob_with_reader_for_startup(&workspace_path, &paths, |_wp| Ok(None))
            .unwrap();

    assert_eq!(
        loaded.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
        Some("local-secret")
    );
    assert!(retry_needed);
}

#[test]
fn env_var_delete_removes_all_case_variants_from_blob_and_index() {
    let home_dir = tempdir().unwrap();
    let workspace_dir = tempdir().unwrap();
    let _home = HomeGuard::set(home_dir.path());

    let teamclu_dir = workspace_dir.path().join(super::super::TEAMCLU_DIR);
    std::fs::create_dir_all(&teamclu_dir).unwrap();
    std::fs::write(
        teamclu_dir.join(super::super::CONFIG_FILE_NAME),
        serde_json::json!({
            "envVars": [
                { "key": "jira_token", "description": "lower" },
                { "key": "JIRA_TOKEN", "description": "upper" }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let paths = SecretStorePaths::for_home_dir().unwrap();
    let mut blob = serde_json::Map::new();
    blob.insert(
        "jira_token".into(),
        serde_json::Value::String("secret-lower".into()),
    );
    blob.insert(
        "JIRA_TOKEN".into(),
        serde_json::Value::String("secret-upper".into()),
    );
    local_secret_store::write_secret_blob(&paths, &blob).unwrap();

    let workspace_path = workspace_dir.path().to_string_lossy().to_string();
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(env_var_delete_for_workspace(
            &workspace_path,
            "JIRA_TOKEN".into(),
        ))
        .unwrap();

    let remaining_blob = read_env_blob(&workspace_path).unwrap();
    assert!(!remaining_blob.contains_key("jira_token"));
    assert!(!remaining_blob.contains_key("JIRA_TOKEN"));

    let json = read_teamclu_json(&workspace_path).unwrap();
    let entries = get_env_vars_from_json(&json);
    assert!(entries.is_empty());
}

#[test]
fn derive_personal_env_index_from_blob_adds_missing_user_keys() {
    let home_dir = tempdir().unwrap();
    let workspace_dir = tempdir().unwrap();
    let _home = HomeGuard::set(home_dir.path());

    let teamclu_dir = workspace_dir.path().join(super::super::TEAMCLU_DIR);
    std::fs::create_dir_all(&teamclu_dir).unwrap();
    std::fs::write(
        teamclu_dir.join(super::super::CONFIG_FILE_NAME),
        r#"{"envVars":[{"key":"tc_api_key","category":"system"}]}"#,
    )
    .unwrap();

    let paths = SecretStorePaths::for_home_dir().unwrap();
    let mut blob = serde_json::Map::new();
    blob.insert(
        "tc_api_key".into(),
        serde_json::Value::String("sk-tc-x".into()),
    );
    blob.insert(
        "_team_secret.abc".into(),
        serde_json::Value::String("team".into()),
    );
    blob.insert(
        "ANTHROPIC_AUTH_TOKEN".into(),
        serde_json::Value::String("secret".into()),
    );
    local_secret_store::write_secret_blob(&paths, &blob).unwrap();

    let workspace_path = workspace_dir.path().to_string_lossy().to_string();
    let added = derive_personal_env_index_from_blob(&workspace_path).unwrap();
    assert_eq!(added, 1);

    let entries = read_env_index(&workspace_path).unwrap();
    let keys: Vec<_> = entries.iter().map(|e| e.key.as_str()).collect();
    // The legacy workspace row is folded in, the blob key is added.
    assert!(keys.contains(&"tc_api_key"));
    assert!(keys.contains(&"ANTHROPIC_AUTH_TOKEN"));
    assert!(!keys.iter().any(|k| k.starts_with("_team_secret.")));

    // The index now lives next to the blob, machine-wide…
    let machine =
        teamclu_runtime_env::read_personal_env_index_for_brand(super::super::APP_SHORT_NAME);
    assert!(machine.iter().any(|e| e.key == "ANTHROPIC_AUTH_TOKEN"));
    // …and the workspace copy is retired rather than kept in sync twice.
    let json = read_teamclu_json(&workspace_path).unwrap();
    assert!(
        json.get("envVars").is_none(),
        "workspace copy should be gone: {json}"
    );

    // Idempotent — second call adds nothing.
    assert_eq!(
        derive_personal_env_index_from_blob(&workspace_path).unwrap(),
        0
    );
}
