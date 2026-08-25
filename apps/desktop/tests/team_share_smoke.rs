#![allow(clippy::await_holding_lock)]
//! Smoke test for the team encryption key (`team_share::set_team_secret_impl`).
//!
//! It used to cover `create_team` and `join_existing` too. Both were deleted as
//! unreachable — the frontend creates teams through the Cloud API provider, and
//! the join command's `JoinTeamFlow` component was never built — so those cases
//! went with them rather than keeping dead code alive from the test side.
//!
//! Secret persistence beyond validation is intentionally NOT asserted here:
//! `team_secret_store` talks to the OS keychain / a host-wide env blob, which
//! is not safely isolatable inside a `cargo test` run.

use serde_json::json;
use teamclu_lib::commands::team_secret_store;
use teamclu_lib::commands::team_share;
use tempfile::TempDir;

/// Redirect $HOME to a tempdir so the `local_secret_store` backing the
/// `team_secret_store` writes inside isolation. Note: env vars are
/// process-global, so the Task 6 tests below must not run in parallel with
/// each other if they need disjoint home stores. Cargo runs each integration
/// test binary on multiple threads by default; the Task 6 tests synchronize
/// through a single Mutex guard (`HOME_GUARD`).
#[allow(deprecated)]
fn isolate_home(tmp: &TempDir) {
    std::env::set_var("HOME", tmp.path());
    // Prime the legacy disk-fallback env-blob with a non-empty map so
    // `read_legacy_disk_blob` returns Ok(Some(..)). The personal secret store
    // will migrate this into its own encrypted blob on first read.
    let fallback_dir = tmp.path().join(".teamclu");
    std::fs::create_dir_all(&fallback_dir).expect("mkdir ~/.teamclu");
    std::fs::write(
        fallback_dir.join("env-blob.json"),
        r#"{"_test_isolation_marker":"1"}"#,
    )
    .expect("write disk fallback env-blob.json");
}

/// Serialize Task 6 tests that mutate $HOME / global env state.
static HOME_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Construct a workspace dir + write `.teamclu/teamclu.json` pointing at
/// the mock FC endpoint, with a fake supabase_jwt.
fn seed_workspace(tmp: &TempDir, fc_endpoint: &str) -> String {
    let workspace = tmp.path().to_path_buf();
    // Mirror `commands::TEAMCLU_DIR` (`.teamclu`) / `CONFIG_FILE_NAME`
    // (`teamclu.json`) using the APP_SHORT_NAME compiled into the lib.
    let cfg_dir = workspace.join(".teamclu");
    std::fs::create_dir_all(&cfg_dir).expect("mkdir .teamclu");
    let cfg = json!({
        "fc_endpoint": fc_endpoint,
        "supabase_jwt": "test-jwt",
    });
    std::fs::write(
        cfg_dir.join("teamclu.json"),
        serde_json::to_string_pretty(&cfg).unwrap(),
    )
    .expect("write teamclu.json");
    workspace.to_string_lossy().into_owned()
}

#[tokio::test]
async fn set_team_secret_validates_and_stores() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp, "http://unused");

    // 63 chars → reject.
    let too_short = "a".repeat(63);
    let err = team_share::enable::set_team_secret_impl(
        "team-sst".to_string(),
        too_short,
        workspace.clone(),
    )
    .await
    .expect_err("should reject non-64-char secret");
    assert!(err.contains("64 hex"), "unexpected error: {err}");

    // 64 hex chars (uppercase accepted) → normalized to lowercase.
    let mixed_case = "ABCDEF0123456789".repeat(4);
    team_share::enable::set_team_secret_impl(
        "team-sst".to_string(),
        mixed_case.clone(),
        workspace.clone(),
    )
    .await
    .expect("should accept valid hex");
    let loaded = team_secret_store::load_team_secret(&workspace, "team-sst")
        .expect("secret should be readable");
    assert_eq!(loaded, mixed_case.to_ascii_lowercase());
}

#[tokio::test]
async fn set_team_secret_rejects_non_hex() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp, "http://unused");
    // 64 chars but contains a non-hex char.
    let mut bad = "a".repeat(63);
    bad.push('z');
    let err = team_share::enable::set_team_secret_impl("team-x".to_string(), bad, workspace)
        .await
        .expect_err("non-hex should be rejected");
    assert!(err.contains("64 hex"), "unexpected error: {err}");
}
