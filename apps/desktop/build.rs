/// Deep-merge two JSON values (objects are merged recursively, everything else is overwritten).
fn deep_merge(base: &mut serde_json::Value, overlay: serde_json::Value) {
    if let (serde_json::Value::Object(base_map), serde_json::Value::Object(overlay_map)) =
        (base, overlay)
    {
        for (key, overlay_val) in overlay_map {
            let entry = base_map.entry(key).or_insert(serde_json::Value::Null);
            if entry.is_object() && overlay_val.is_object() {
                deep_merge(entry, overlay_val);
            } else {
                *entry = overlay_val;
            }
        }
    }
}

/// Declare a `rerun-if-changed` dependency only for a path that exists.
///
/// Cargo cannot distinguish "this input is legitimately absent" from "this input
/// vanished", so it marks a unit whose declared path fails to stat as stale on
/// every single build. Every optional input here (gitignored build configs,
/// staged sidecars, bridge bundles) must go through this instead of printing the
/// directive unconditionally.
fn rerun_if_present<P: AsRef<std::path::Path>>(path: P) {
    let path = path.as_ref();
    if path.exists() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

fn resolve_updater_url(url: &str) -> Option<String> {
    if url.contains("__OSS_BASE_URL__") {
        let oss_base = std::env::var("OSS_BASE_URL")
            .ok()
            .map(|s| s.trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())?;
        Some(url.replace("__OSS_BASE_URL__", &oss_base))
    } else if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

fn resolve_updater_endpoints(config: &serde_json::Value) -> Vec<String> {
    let updater = &config["app"]["updater"];
    let mut endpoints = Vec::new();

    let mut push_unique = |url: String| {
        if !endpoints.iter().any(|existing| existing == &url) {
            endpoints.push(url);
        }
    };

    if let Some(endpoint) = updater["endpoint"].as_str().and_then(resolve_updater_url) {
        push_unique(endpoint);
    }

    if let Some(list) = updater["endpoints"].as_array() {
        for endpoint in list.iter().filter_map(|endpoint| endpoint.as_str()) {
            if let Some(url) = resolve_updater_url(endpoint) {
                push_unique(url);
            }
        }
    }

    endpoints
}

fn main() {
    // ── Read build config: base → env → local (mirrors vite.config.ts) ──
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("Cargo must set CARGO_MANIFEST_DIR for build scripts");
    let root_dir = std::path::Path::new(&manifest_dir)
        .parent()
        .and_then(|p| p.parent())
        .unwrap();

    let base_path = root_dir.join("build.config.json");
    // Only declare the dependency when the file is actually there. Cargo treats
    // a `rerun-if-changed` path it cannot stat as permanently stale ("stale:
    // missing ..."), so declaring this unconditionally re-ran the build script,
    // recompiled teamclu_lib and relinked the binary on EVERY build — ~39s of
    // pure waste per `tauri:dev` start, because build.config.json is gitignored
    // and absent from a normal checkout (local dev uses BUILD_ENV=dev +
    // build.config.dev.json instead).
    //
    // Trade-off: creating build.config.json later does not invalidate this
    // build script on its own. Touch apps/desktop/build.rs after adding it.
    rerun_if_present(&base_path);

    let mut config: serde_json::Value = std::fs::read_to_string(&base_path)
        .map(|s| serde_json::from_str(&s).expect("build.config.json is not valid JSON"))
        .unwrap_or_else(|_| serde_json::json!({"app":{"name":"TeamClu"}}));

    // Merge build.config.{BUILD_ENV}.json if BUILD_ENV is set.
    // BUILD_ENV selects which config is merged (and thus the baked CLOUD_API_URL),
    // so cargo MUST re-run this script when it changes. Without this, a binary
    // first compiled without BUILD_ENV (or with a different one) keeps its stale
    // CLOUD_API_URL on a rebuild with BUILD_ENV=dev — the frontend (rebuilt by
    // vite every time) points at the dev backend while the Rust team-share / OSS
    // commands still fall back to https://cloud.ucar.cc, yielding
    // "function 'teamclu-sync' does not exist" (FunctionNotFound) on dev.
    println!("cargo:rerun-if-env-changed=BUILD_ENV");
    if let Ok(build_env) = std::env::var("BUILD_ENV") {
        let env_path = root_dir.join(format!("build.config.{}.json", build_env));
        // Same missing-path rule as base_path above: a BUILD_ENV naming a brand
        // with no config file on disk would otherwise pin the build script to
        // "always stale".
        rerun_if_present(&env_path);
        if let Ok(s) = std::fs::read_to_string(&env_path) {
            let env_config: serde_json::Value = serde_json::from_str(&s)
                .unwrap_or_else(|_| panic!("build.config.{}.json is not valid JSON", build_env));
            deep_merge(&mut config, env_config);
        }
    }

    // NOTE: build.config.local.json is intentionally NOT merged here. The vite
    // frontend dropped it from its merge chain (commit f56d0ea9) so BUILD_ENV is
    // the single authoritative way to switch environments. build.rs must mirror
    // that, otherwise a stale local override (e.g. a dead legacy test-api pin)
    // gets baked into CLOUD_API_URL for the Rust team-share / OSS commands while
    // the frontend points at the BUILD_ENV backend — the two desync and enabling
    // Team Shared fails with "function 'legacy-test-api' does not exist".

    let short_name = config["app"]["shortName"]
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let name = config["app"]["name"].as_str().unwrap_or("teamclu");
            name.chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .map(|c| c.to_ascii_lowercase())
                .collect()
        });

    // Validate
    assert!(
        !short_name.is_empty()
            && short_name.len() <= 20
            && short_name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
        "app.shortName must be 1-20 chars, [a-z0-9] only, got: '{}'",
        short_name
    );

    println!("cargo:rustc-env=APP_SHORT_NAME={}", short_name);
    println!("cargo:warning=Using APP_SHORT_NAME={}", short_name);

    let display_name = config["app"]["displayName"]
        .as_str()
        .or_else(|| config["app"]["name"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("TeamClu");
    println!("cargo:rustc-env=APP_DISPLAY_NAME={}", display_name);
    println!("cargo:warning=Using APP_DISPLAY_NAME={}", display_name);

    // Resolved by the one brand table, not a second copy of the rule. This file
    // used to carry its own `is_official` list that disagreed with
    // `storage_namespace`'s, which is how a betly build ended up reading secrets
    // from `~/.teamclu` while writing its cache to `~/.teamclaw`.
    let teamclu_dir = teamclu_runtime_env::workspace_meta_dir_name(&short_name);
    let config_file_name = teamclu_runtime_env::workspace_config_file_name(&short_name);
    println!("cargo:rustc-env=TEAMCLU_DIR={}", teamclu_dir);
    println!("cargo:rustc-env=CONFIG_FILE_NAME={}", config_file_name);

    // Deep-link scheme (`app.scheme`). Not derivable from short_name: betly's
    // short name is "teamclaw" while it ships on the default "teamclu" scheme.
    // Stamped onto amuxd so the teamclu-introspect sidecar's export_session_link
    // hands out a link this build actually registers with the OS.
    let app_scheme = config["app"]["scheme"].as_str().unwrap_or("teamclu");
    assert!(
        !app_scheme.is_empty()
            && app_scheme.starts_with(|c: char| c.is_ascii_lowercase())
            && app_scheme.chars().all(|c| c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || matches!(c, '+' | '.' | '-')),
        "app.scheme must start with a lowercase letter, then [a-z0-9+.-], got: '{}'",
        app_scheme
    );
    println!("cargo:rustc-env=APP_SCHEME={}", app_scheme);
    println!("cargo:warning=Using APP_SCHEME={}", app_scheme);

    // Export updater config from build.config.json (comma-separated for runtime fallback)
    let updater_endpoints = resolve_updater_endpoints(&config);
    if !updater_endpoints.is_empty() {
        let joined = updater_endpoints.join(",");
        println!("cargo:rustc-env=UPDATER_ENDPOINTS={}", joined);
        println!("cargo:warning=Using UPDATER_ENDPOINTS={}", joined);
    }
    if let Some(pubkey) = config["app"]["updater"]["pubkey"].as_str() {
        println!("cargo:rustc-env=UPDATER_PUBKEY={}", pubkey);
        println!("cargo:warning=Using UPDATER_PUBKEY={}", pubkey);
    }

    // Bake the Cloud API URL into the binary so the Rust team-share / OSS
    // commands default to the SAME backend the frontend resolves from
    // (`getEffectiveServerConfigSync().cloudApiUrl`). Precedence mirrors the
    // frontend: `VITE_CLOUD_API_URL` env override wins, else `cloudApiUrl` from
    // the merged build config. Without this the Rust fallback was hardcoded to
    // the production URL, so a non-production build (e.g. a legacy test build) sent its
    // freshly-issued JWT to production FC and PostgREST rejected the signature.
    println!("cargo:rerun-if-env-changed=VITE_CLOUD_API_URL");
    let cloud_api_url = std::env::var("VITE_CLOUD_API_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            config["cloudApiUrl"]
                .as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    match cloud_api_url {
        Some(url) => {
            let url = url.trim_end_matches('/');
            println!("cargo:rustc-env=CLOUD_API_URL={}", url);
            println!("cargo:warning=Using CLOUD_API_URL={}", url);
        }
        // A release-profile build with no Cloud API URL produces a binary that
        // compiles, publishes, and only dies when a user clicks "开通团队共享" —
        // `default_fc_endpoint` (commands/oss_sync/mod.rs) panics at RUNTIME on
        // the missing `option_env!("CLOUD_API_URL")`. That shipped once: betly
        // builds from the old release-beta.yml baked nothing, fell back to the
        // then-hardcoded `https://cloud.ucar.cc`, and every Team Shared attempt
        // got `FunctionNotFound: function 'teamclu-sync' does not exist`.
        // Fail the build instead, so it cannot leave CI.
        //
        // Gated on PROFILE, not CI: `cargo fmt/clippy/check` (ci.yml) and
        // `tauri dev` run the debug profile with no build.config.json on disk
        // (it is gitignored) and must keep working. Every pipeline that ships a
        // binary supplies one — release-oss.yml via brand-setup, release.yml via
        // BUILD_ENV=production merging build.config.production.json.
        None if std::env::var("PROFILE").as_deref() == Ok("release") => {
            panic!(
                "cloudApiUrl is not set — refusing to bake a release binary with no Cloud API \
                 endpoint.\nSet it one of these ways:\n  \
                 • put `cloudApiUrl` in build.config.json (copy build.config.example.json)\n  \
                 • build with BUILD_ENV=production (merges build.config.production.json)\n  \
                 • export VITE_CLOUD_API_URL=<url>\nSee apps/desktop/src/commands/oss_sync/mod.rs \
                 (default_fc_endpoint) for why a binary without this is broken."
            );
        }
        None => {
            println!(
                "cargo:warning=No cloudApiUrl in build config — CLOUD_API_URL unset. Fine for \
                 check/clippy; a release build with this unset is a hard error."
            );
        }
    }

    let target_triple = std::env::var("TARGET").unwrap_or_default();
    let in_ci = std::env::var("CI").is_ok();

    // Check that the teamclu-introspect sidecar binary exists.
    // Unlike opencode (downloaded), this is built from crates/teamclu-introspect.
    // rust-cli.js auto-builds it before invoking cargo.
    let introspect_bin = format!("binaries/teamclu-introspect-{}", target_triple);
    let introspect_bin_exe = format!("{}.exe", introspect_bin);
    let introspect_exists = std::path::Path::new(&introspect_bin).exists()
        || (target_triple.contains("windows")
            && std::path::Path::new(&introspect_bin_exe).exists());
    if !introspect_exists && !in_ci {
        panic!(
            "\n\n\
            ╔══════════════════════════════════════════════════════════════╗\n\
            ║  teamclu-introspect sidecar binary not found!             ║\n\
            ║                                                            ║\n\
            ║  Build it with:                                            ║\n\
            ║    cargo build -p teamclu-introspect                      ║\n\
            ║    cp target/debug/teamclu-introspect {:<20}║\n\
            ╚══════════════════════════════════════════════════════════════╝\n\n",
            introspect_bin
        );
    }
    rerun_if_present(&introspect_bin);

    // amuxd sidecar is bundled (built by scripts/ensure-amuxd-sidecar.js before cargo).
    let amuxd_bin = format!("binaries/amuxd-{}", target_triple);
    let amuxd_bin_exe = format!("{}.exe", amuxd_bin);
    let amuxd_exists = std::path::Path::new(&amuxd_bin).exists()
        || (target_triple.contains("windows") && std::path::Path::new(&amuxd_bin_exe).exists());
    if !amuxd_exists && !in_ci {
        panic!(
            "\n\namuxd sidecar binary not found: {}\nBuild it with: node -e \"require('./scripts/ensure-amuxd-sidecar').ensureAmuxdSidecar(process.env)\"\n\n",
            amuxd_bin
        );
    }
    rerun_if_present(&amuxd_bin);

    tauri_build::build()
}
