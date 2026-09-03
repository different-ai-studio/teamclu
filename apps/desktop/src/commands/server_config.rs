use std::path::PathBuf;

const LEGACY_CONFIG_DIR: &str = "amux";
const SERVER_CONFIG_FILE: &str = "config.json";
const LEGACY_TEAMCLU_CONFIG_FILE: &str = "teamclu.json";
const LEGACY_SERVER_CONFIG_FILE: &str = "server-config.json";

fn legacy_config_base_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// Every on-disk server-config file this app (or its predecessors) may have
/// written. The Cloud API URL now comes solely from the frontend build config
/// and MQTT from the Cloud API `/v1/config/bootstrap`; nothing reads these files
/// anymore.
///
/// The first entry is brand-scoped: hardcoded to `~/.teamclu` it swept the
/// official namespace no matter which build ran, so a white-label install could
/// never clean its own leftover and would happily delete the official build's.
/// The `teamclaw` / `amux` entries below stay literal — they are historical
/// directory names, not this build's identity.
fn deprecated_config_paths() -> Vec<PathBuf> {
    vec![
        super::brand_home_dir().join(SERVER_CONFIG_FILE),
        legacy_config_base_dir()
            .join(teamclu_runtime_env::LEGACY_BRAND_STORAGE_DIR)
            .join(LEGACY_TEAMCLU_CONFIG_FILE),
        legacy_config_base_dir()
            .join(teamclu_runtime_env::LEGACY_BRAND_STORAGE_DIR)
            .join(LEGACY_SERVER_CONFIG_FILE),
        legacy_config_base_dir()
            .join(LEGACY_CONFIG_DIR)
            .join(LEGACY_SERVER_CONFIG_FILE),
    ]
}

fn remove_config_files(paths: &[PathBuf]) {
    for path in paths {
        if !path.exists() {
            continue;
        }
        match std::fs::remove_file(path) {
            Ok(()) => log::info!(
                "[ServerConfig] Removed deprecated server config {}",
                path.display()
            ),
            Err(e) => log::error!(
                "[ServerConfig] Failed to remove deprecated server config {}: {e}",
                path.display()
            ),
        }
    }
}

/// Best-effort one-time cleanup of the deprecated on-disk server config. A stale
/// persisted `cloudApiUrl` (e.g. an old `https://cloud.ucar.cc`) used to be
/// injected at startup and would silently shadow the value baked into the build
/// config. Deleting the files guarantees the build config is the single source
/// of truth. Failures are non-fatal.
pub fn cleanup_deprecated_server_config() {
    remove_config_files(&deprecated_config_paths());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deprecated_paths_cover_known_config_files() {
        let names: Vec<String> = deprecated_config_paths()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"config.json".to_string()));
        assert!(names.contains(&"server-config.json".to_string()));
        assert!(names.contains(&"teamclu.json".to_string()));
    }

    #[test]
    fn remove_config_files_deletes_existing_and_ignores_missing() {
        let temp = tempfile::tempdir().unwrap();
        let existing = temp.path().join("config.json");
        std::fs::write(&existing, "{\"cloudApiUrl\":\"https://cloud.ucar.cc\"}").unwrap();
        let missing = temp.path().join("does-not-exist.json");

        remove_config_files(&[existing.clone(), missing.clone()]);

        assert!(!existing.exists(), "existing config should be removed");
        assert!(!missing.exists(), "missing path should stay absent");
    }
}
