//! FC client + shared team-sync infrastructure.
//!
//! Plan B Task 8: the desktop OSS sync ENGINE has been deleted — the daemon
//! owns all team sync now (pull/push/conflict/version). What remains here is the
//! shared FC HTTP client and helpers that team-share onboarding and LiteLLM
//! provisioning still depend on:
//!
//!   fc_client.rs      — reqwest FC client with JWT injection and error mapping
//!   error.rs          — SyncError unified error type
//!   path_validator.rs — client-side mirror of FC validateSyncPath (referenced
//!                       by error.rs's From impl)
//!   get_fc_endpoint() — reads teamclu.json for the FC endpoint (callers
//!                       supply their own fresh user JWT; see Design 2)
//!
//! The deleted engine submodules were: engine, scanner, state, manifest,
//! conflict, crypto — plus the blob-transfer/version methods on FcClient and
//! the `oss_sync_*` Tauri command surface, which now live in
//! `crate::commands::team_sync_proxy` as thin daemon proxies.

pub mod error;
pub mod fc_client;
pub mod path_validator;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Read the FC endpoint from the workspace's `teamclu.json` (falling back to
/// the build-config Cloud API URL — see `default_fc_endpoint`).
///
/// The FC JWT is **not** read here anymore. Each Tauri command receives the
/// caller's own fresh user session token (from the frontend `getSession()`,
/// which is kept current by the session-store auto-refresh) and passes it to
/// `FcClient`. The previous behaviour read a `supabase_jwt` cached in
/// `teamclu.json` that nothing refreshed after the daemon-owns-team-sync
/// refactor (#296) gutted the JWT bridge — so it went stale and FC returned
/// 401. Tauri uses its own token; the daemon uses its own; neither crosses.
pub(crate) fn get_fc_endpoint(_workspace_path: &str) -> String {
    // The build-config Cloud API URL (baked at compile time, see
    // `default_fc_endpoint`) is the single source of truth — the same one the
    // frontend resolves from. We deliberately do NOT honor a per-workspace
    // `fc_endpoint` override in `teamclu.json` anymore.
    //
    // That override was the same anti-pattern as the now-removed
    // `build.config.local.json`: a stale local pin (e.g. a long-dead
    // `legacy-test-api.example.test` left over from earlier testing) silently won
    // over the build's backend, so the frontend talked to the build-config
    // backend while the Rust team-share / OSS commands hit the dead host —
    // surfacing as `FunctionNotFound: function 'legacy-test-api' does not exist`
    // when enabling Team Shared. Routing solely from the build config keeps the
    // two in lockstep and cannot drift. `_workspace_path` is retained for call-
    // site compatibility.
    default_fc_endpoint().trim_end_matches('/').to_string()
}

/// Normalize the Cloud API endpoint supplied by the renderer for a native
/// command. Runtime server selection lives in the web renderer, so native
/// commands must use this value instead of the URL baked into the binary.
pub(crate) fn resolve_runtime_fc_endpoint(cloud_api_url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(cloud_api_url.trim())
        .map_err(|_| "cloudApiUrl must be a valid http(s) URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("cloudApiUrl must be a valid http(s) URL".to_string());
    }
    Ok(cloud_api_url.trim().trim_end_matches('/').to_string())
}

/// The default Cloud API endpoint used when a workspace's `teamclu.json` does
/// not pin an explicit `fc_endpoint`.
///
/// This is the **build-config** Cloud API URL (`build.config*.json` →
/// `cloudApiUrl`, with the `VITE_CLOUD_API_URL` dev override), baked into the
/// binary at compile time by `build.rs`. It is the same single source of truth
/// the frontend resolves from (`getEffectiveServerConfigSync().cloudApiUrl`), so
/// the Rust team-share / OSS commands route to the SAME backend the frontend
/// talks to. Previously this was hardcoded to `https://cloud.ucar.cc`, which
/// sent a non-production build's (e.g. a legacy test build) freshly-issued JWT to the
/// production Cloud API — whose JWT secret differs — yielding a PostgREST
/// `JWSError JWSInvalidSignature` (PGRST301). The hardcoded production URL
/// remains only as a last-resort fallback if the build did not bake one.
fn default_fc_endpoint() -> &'static str {
    match option_env!("CLOUD_API_URL") {
        Some(url) if !url.trim().is_empty() => url.trim(),
        _ => panic!("CLOUD_API_URL must be set at build time — no fallback cloud endpoint"),
    }
}

#[cfg(test)]
mod fc_endpoint_tests {
    use super::*;

    fn write_workspace_config(dir: &std::path::Path, body: &str) {
        let cfg_dir = dir.join(crate::commands::TEAMCLU_DIR);
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::write(cfg_dir.join(crate::commands::CONFIG_FILE_NAME), body).unwrap();
    }

    /// These three assert on the Cloud API URL `build.rs` bakes in from
    /// `build.config*.json` — a gitignored file. A debug build without one leaves
    /// `CLOUD_API_URL` unset **on purpose** (`cargo check` / `tauri dev` have to
    /// keep working), and `default_fc_endpoint` panics on it by design, so on a
    /// clean checkout these tests could only ever fail. Nothing caught that
    /// because CI never ran this crate's tests.
    ///
    /// Skip rather than weaken: when a build config *is* present — every pipeline
    /// that ships a binary supplies one — they run for real.
    fn baked_endpoint_or_skip() -> Option<&'static str> {
        match option_env!("CLOUD_API_URL") {
            Some(url) if !url.trim().is_empty() => Some(url.trim()),
            _ => {
                log::warn!(
                    "skipping: no CLOUD_API_URL baked in (no build.config.json).                      Run with VITE_CLOUD_API_URL=<url> to exercise this."
                );
                None
            }
        }
    }

    fn temp_dir() -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "teamclu-fc-endpoint-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn workspace_fc_endpoint_override_is_ignored() {
        // A stale per-workspace pin must NOT override the build-config URL —
        // this is the regression that produced
        // `FunctionNotFound: function 'legacy-test-api' does not exist`.
        if baked_endpoint_or_skip().is_none() {
            return;
        }
        let dir = temp_dir();
        write_workspace_config(
            &dir,
            r#"{"fc_endpoint":"https://legacy-test-api.example.test/"}"#,
        );
        assert_eq!(
            get_fc_endpoint(dir.to_str().unwrap()),
            default_fc_endpoint().trim_end_matches('/')
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_config_uses_build_default() {
        if baked_endpoint_or_skip().is_none() {
            return;
        }
        let dir = temp_dir();
        // No teamclu.json at all.
        assert_eq!(
            get_fc_endpoint(dir.to_str().unwrap()),
            default_fc_endpoint().trim_end_matches('/')
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn default_endpoint_is_non_empty_https() {
        let Some(_) = baked_endpoint_or_skip() else {
            return;
        };
        let d = default_fc_endpoint();
        assert!(
            d.starts_with("https://"),
            "default endpoint must be https: {d}"
        );
    }

    #[test]
    fn runtime_endpoint_uses_the_renderer_url_and_normalizes_a_trailing_slash() {
        assert_eq!(
            resolve_runtime_fc_endpoint("https://copilot.accounting.i.test.shopee.io/").unwrap(),
            "https://copilot.accounting.i.test.shopee.io"
        );
    }

    #[test]
    fn runtime_endpoint_rejects_non_http_urls() {
        assert!(resolve_runtime_fc_endpoint("file:///tmp/teamclu").is_err());
        assert!(resolve_runtime_fc_endpoint("not a url").is_err());
    }
}
