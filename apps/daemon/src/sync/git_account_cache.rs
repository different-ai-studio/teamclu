//! `<amuxd home>/cache/git-account.json` — the TeamClu git hosts this daemon has
//! seen, and the cloud API base, for `amuxd git-credential` in global mode.
//!
//! A person's machine also learns the host from the desktop's token file; this
//! cache is what lets the helper answer for an agent on a headless box where no
//! person ever signed in. It is a cache in the layout sense
//! (`docs/architecture/amuxd-home-layout-v2.md`): rebuilt the next time a
//! checkout is pointed at per-account git, harmless to delete.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const ACCOUNT_CACHE_FILE: &str = "git-account.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCache {
    #[serde(default)]
    pub hosts: Vec<String>,
    pub api_base: Option<String>,
}

pub fn account_cache_path() -> PathBuf {
    crate::config::layout::cache_dir().join(ACCOUNT_CACHE_FILE)
}

/// Add `host` (lowercased) and record `api_base`; writes only on change.
pub fn remember_git_host(host: &str, api_base: Option<&str>) -> std::io::Result<()> {
    remember_in(&account_cache_path(), host, api_base)
}

fn remember_in(path: &std::path::Path, host: &str, api_base: Option<&str>) -> std::io::Result<()> {
    let mut cache: AccountCache = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let host = host.trim().to_ascii_lowercase();
    let mut changed = false;
    if !host.is_empty() && !cache.hosts.iter().any(|h| h == &host) {
        cache.hosts.push(host);
        changed = true;
    }
    if let Some(base) = api_base.map(str::trim).filter(|b| !b.is_empty()) {
        if cache.api_base.as_deref() != Some(base) {
            cache.api_base = Some(base.to_string());
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(&cache).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_accumulate_once_and_the_api_base_follows_the_latest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache").join(ACCOUNT_CACHE_FILE);
        remember_in(&path, "Gitea.Example.com", Some("https://api.example.com")).unwrap();
        remember_in(&path, "gitea.example.com", None).unwrap();
        remember_in(&path, "git.other.box", Some("https://api2.example.com")).unwrap();
        let cache: AccountCache =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            cache.hosts,
            vec!["gitea.example.com".to_string(), "git.other.box".to_string()]
        );
        assert_eq!(cache.api_base.as_deref(), Some("https://api2.example.com"));
    }
}
