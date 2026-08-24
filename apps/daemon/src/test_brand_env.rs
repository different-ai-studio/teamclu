//! Serialize tests that mutate brand / amuxd-home path env vars.
//!
//! Shares `TEST_HOME_LOCK` with the tests that mutate `HOME` rather than
//! keeping a second mutex. Both sets drive the *same* process-global path
//! resolution — `HOME`, `AMUXD_HOME` and the brand name all feed
//! `global_team_dir()` / `config_dir()` — so two independent locks serialized
//! each set against itself while leaving them free to race against each other.
//! That race is what made `team_link` / `workspace_link` / `daemon::server`
//! tests fail under `cargo test` but pass under `--test-threads=1`.

use std::path::Path;
use std::sync::MutexGuard;

use crate::config::global_team_store::TEST_HOME_LOCK;

pub struct BrandEnvGuard {
    _lock: MutexGuard<'static, ()>,
    previous_brand: Option<String>,
    previous_home: Option<String>,
    previous_user_home: Option<String>,
}

impl BrandEnvGuard {
    /// Set `TEAMCLU_BRAND_SHORT_NAME` and clear `AMUXD_HOME` so path resolution
    /// is driven by brand alone.
    pub fn set(brand: &str) -> Self {
        let lock = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous_brand = std::env::var(teamclu_runtime_env::BRAND_SHORT_NAME_ENV).ok();
        let previous_home = std::env::var(teamclu_runtime_env::AMUXD_HOME_ENV).ok();
        std::env::set_var(teamclu_runtime_env::BRAND_SHORT_NAME_ENV, brand);
        std::env::remove_var(teamclu_runtime_env::AMUXD_HOME_ENV);
        Self {
            _lock: lock,
            previous_brand,
            previous_home,
            previous_user_home: None,
        }
    }

    /// [`set`], plus a temporary `HOME`.
    ///
    /// Needed by anything that resolves `~/.agents/skills` — the default write
    /// root for skills — because `dirs::home_dir()` reads the real `HOME` and a
    /// test that does not move it writes into the developer's own skills
    /// directory. Same lock as the brand, so it cannot race the white-label
    /// tests.
    pub fn set_with_home(brand: &str, home: &Path) -> Self {
        let mut guard = Self::set(brand);
        guard.previous_user_home = Some(std::env::var("HOME").unwrap_or_default());
        // SAFETY: serialized by TEST_HOME_LOCK, held by `guard`.
        std::env::set_var("HOME", home);
        guard
    }

    /// Set an explicit `AMUXD_HOME` override (brand env left unchanged).
    pub fn set_amuxd_home(home: &Path) -> Self {
        let lock = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous_brand = std::env::var(teamclu_runtime_env::BRAND_SHORT_NAME_ENV).ok();
        let previous_home = std::env::var(teamclu_runtime_env::AMUXD_HOME_ENV).ok();
        std::env::set_var(teamclu_runtime_env::AMUXD_HOME_ENV, home);
        Self {
            _lock: lock,
            previous_brand,
            previous_home,
            previous_user_home: None,
        }
    }
}

impl Drop for BrandEnvGuard {
    fn drop(&mut self) {
        match &self.previous_brand {
            Some(v) => std::env::set_var(teamclu_runtime_env::BRAND_SHORT_NAME_ENV, v),
            None => std::env::remove_var(teamclu_runtime_env::BRAND_SHORT_NAME_ENV),
        }
        match &self.previous_home {
            Some(v) => std::env::set_var(teamclu_runtime_env::AMUXD_HOME_ENV, v),
            None => std::env::remove_var(teamclu_runtime_env::AMUXD_HOME_ENV),
        }
        if let Some(v) = &self.previous_user_home {
            if v.is_empty() {
                std::env::remove_var("HOME");
            } else {
                std::env::set_var("HOME", v);
            }
        }
    }
}
