//! The `ai:invoke` credential the agent runtime presents to the local AI proxy.
//!
//! Minted once per daemon process and reused. Two reasons it is not minted per
//! use: `sync_global_team_provider` writes whatever token it is handed, so a
//! fresh one on every provider read would rewrite the config file continuously
//! and churn the refresh watcher; and every mint leaves an entry in the token
//! store, which only empties when the process exits.
//!
//! Session tokens live in daemon memory, so this value dies with the process
//! that minted it. That is the reason the sync writes the token outright rather
//! than only substituting a placeholder — after a restart the value left on
//! disk names a token nothing will accept, and a placeholder-only substitution
//! would never replace it.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use crate::http::tokens::TokenStore;

/// Long enough that it never expires under the process that owns it — the
/// process outliving a year is not the failure mode this guards against.
const TTL: Duration = Duration::from_secs(365 * 24 * 60 * 60);

/// Lazily mints (and then reuses) the runtime's `ai:invoke` token.
#[derive(Clone)]
pub struct GatewayTokenSource {
    tokens: TokenStore,
    cached: Arc<OnceLock<String>>,
}

impl GatewayTokenSource {
    pub fn new(tokens: TokenStore) -> Self {
        Self {
            tokens,
            cached: Arc::new(OnceLock::new()),
        }
    }

    /// The token for this process, minting it on first call.
    ///
    /// Scoped to `ai:invoke` alone: the runtime proxies completions and does
    /// nothing else with the daemon API, so a broader grant would hand every
    /// agent the ability to drive sessions it was never asked to touch.
    pub fn get_or_mint(&self) -> String {
        self.cached
            .get_or_init(|| {
                let (raw, _info) = self.tokens.mint(
                    vec!["ai:invoke".to_string()],
                    TTL,
                    Some("team AI provider".to_string()),
                );
                raw
            })
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> TokenStore {
        let dir = tempdir().unwrap();
        let store = TokenStore::load_or_init(&dir.path().join("token")).unwrap();
        std::mem::forget(dir);
        store
    }

    #[test]
    fn mints_once_and_reuses() {
        // A fresh token per call would rewrite opencode.json on every provider
        // read and leak an entry into the store each time.
        let src = GatewayTokenSource::new(store());
        assert_eq!(src.get_or_mint(), src.get_or_mint());
    }

    #[test]
    fn carries_only_the_ai_scope() {
        let tokens = store();
        let src = GatewayTokenSource::new(tokens.clone());
        let info = tokens.lookup(&src.get_or_mint()).expect("token is valid");
        assert_eq!(info.scopes, vec!["ai:invoke".to_string()]);
    }
}
