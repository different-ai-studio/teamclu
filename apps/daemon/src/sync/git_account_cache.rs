//! `<amuxd home>/cache/git-account.json` — the TeamClu git host of this daemon's
//! cloud, and the cloud API base, for `amuxd git-credential` in global mode.
//!
//! Whatever is in here, the helper hands a login to. So a host only gets in
//! once the cloud itself has named it (`GET /v1/git/host`, asked by
//! `http/apps.rs`) — never on the word of whoever called the daemon — and the
//! newest answer replaces the old one: a daemon has one cloud, a cloud has one
//! git host, and a host the cloud has moved away from must stop being trusted.
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
    /// The subset of `hosts` the cloud serves over plain `http` (a test box
    /// without TLS). Every other host is answered over `https` only, so a
    /// rewritten remote cannot make git send a login in cleartext.
    #[serde(default)]
    pub http_hosts: Vec<String>,
    pub api_base: Option<String>,
}

impl AccountCache {
    /// Whether a login may be sent to `host` over `protocol`.
    pub fn answers(&self, protocol: &str, host: &str) -> bool {
        let host = host.trim().to_ascii_lowercase();
        if !self.hosts.iter().any(|h| h.eq_ignore_ascii_case(&host)) {
            return false;
        }
        match protocol {
            "https" => true,
            "http" => self
                .http_hosts
                .iter()
                .any(|h| h.eq_ignore_ascii_case(&host)),
            _ => false,
        }
    }
}

pub fn account_cache_path() -> PathBuf {
    crate::config::layout::cache_dir().join(ACCOUNT_CACHE_FILE)
}

pub fn read_account_cache() -> AccountCache {
    std::fs::read_to_string(account_cache_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Make `scheme://host` (as the cloud named it) the one trusted git host and
/// record `api_base`; writes only on change.
pub fn remember_git_host(scheme: &str, host: &str, api_base: Option<&str>) -> std::io::Result<()> {
    remember_in(&account_cache_path(), scheme, host, api_base)
}

fn remember_in(
    path: &std::path::Path,
    scheme: &str,
    host: &str,
    api_base: Option<&str>,
) -> std::io::Result<()> {
    let mut cache: AccountCache = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let host = host.trim().to_ascii_lowercase();
    let mut changed = false;
    if !host.is_empty() {
        let hosts = vec![host.clone()];
        let http_hosts = if scheme.eq_ignore_ascii_case("http") {
            vec![host]
        } else {
            Vec::new()
        };
        if cache.hosts != hosts || cache.http_hosts != http_hosts {
            cache.hosts = hosts;
            cache.http_hosts = http_hosts;
            changed = true;
        }
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
    fn the_newest_host_replaces_the_old_one_and_the_api_base_follows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache").join(ACCOUNT_CACHE_FILE);
        let read = || -> AccountCache {
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
        };
        remember_in(
            &path,
            "https",
            "Gitea.Example.com",
            Some("https://api.example.com"),
        )
        .unwrap();
        remember_in(&path, "https", "gitea.example.com", None).unwrap();
        assert_eq!(read().hosts, vec!["gitea.example.com".to_string()]);
        // The cloud moved its git host: the old one stops being trusted.
        remember_in(
            &path,
            "https",
            "git.other.box",
            Some("https://api2.example.com"),
        )
        .unwrap();
        let cache = read();
        assert_eq!(cache.hosts, vec!["git.other.box".to_string()]);
        assert_eq!(cache.api_base.as_deref(), Some("https://api2.example.com"));
    }

    #[test]
    fn a_login_goes_over_http_only_to_a_host_the_cloud_serves_over_http() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ACCOUNT_CACHE_FILE);
        let read = || -> AccountCache {
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
        };
        remember_in(&path, "https", "gitea.example.com", None).unwrap();
        let cache = read();
        assert!(cache.answers("https", "Gitea.Example.com"));
        assert!(!cache.answers("http", "gitea.example.com"));
        assert!(!cache.answers("https", "github.com"));
        assert!(!cache.answers("ssh", "gitea.example.com"));

        remember_in(&path, "http", "gitea.localhost:8080", None).unwrap();
        let cache = read();
        assert!(cache.answers("http", "gitea.localhost:8080"));
        assert!(cache.answers("https", "gitea.localhost:8080"));
        assert!(!cache.answers("https", "gitea.example.com"));
    }

    #[test]
    fn a_cache_written_before_http_hosts_existed_still_reads() {
        let cache: AccountCache =
            serde_json::from_str(r#"{"hosts":["gitea.example.com"],"apiBase":null}"#).unwrap();
        assert!(cache.answers("https", "gitea.example.com"));
        assert!(!cache.answers("http", "gitea.example.com"));
    }
}
