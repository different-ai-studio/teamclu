//! Provider authentication catalog — OAuth-capable built-in providers.
//!
//! Static OAuth fallbacks and merge helpers for the daemon HTTP control plane.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One way to authenticate with a provider (mirrors OpenCode `provider.auth`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuthMethodType {
    Oauth,
    Api,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderAuthMethod {
    #[serde(rename = "type")]
    pub method_type: ProviderAuthMethodType,
    pub label: String,
}

/// Wire shape: `{ "openai": [{ "type": "oauth", "label": "..." }], ... }`
pub type ProviderAuthMethodsResponse = HashMap<String, Vec<ProviderAuthMethod>>;

/// Built-in providers that expose browser OAuth in OpenCode (Phase 1 catalog).
const OAUTH_BROWSER_LOGIN: &[(&str, &str)] = &[
    ("openai", "Browser login"),
    ("anthropic", "Browser login"),
    ("google", "Browser login"),
];

/// Merge built-in OAuth fallbacks into a live OpenCode `GET /provider/auth` map.
pub fn merge_live_provider_auth_methods(
    mut live: ProviderAuthMethodsResponse,
) -> ProviderAuthMethodsResponse {
    for (provider_id, fallback) in builtin_provider_auth_methods() {
        let existing = live.entry(provider_id).or_default();
        if existing
            .iter()
            .any(|m| m.method_type == ProviderAuthMethodType::Oauth)
        {
            continue;
        }
        existing.splice(0..0, fallback);
    }
    live
}

pub fn builtin_provider_auth_methods() -> ProviderAuthMethodsResponse {
    let mut out = ProviderAuthMethodsResponse::new();
    for (id, label) in OAUTH_BROWSER_LOGIN {
        out.insert(
            id.to_string(),
            vec![ProviderAuthMethod {
                method_type: ProviderAuthMethodType::Oauth,
                label: label.to_string(),
            }],
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_includes_openai_oauth() {
        let methods = builtin_provider_auth_methods();
        let openai = methods.get("openai").expect("openai entry");
        assert_eq!(openai.len(), 1);
        assert_eq!(openai[0].method_type, ProviderAuthMethodType::Oauth);
        assert_eq!(openai[0].label, "Browser login");
    }

    #[test]
    fn catalog_serializes_snake_case_type() {
        let methods = builtin_provider_auth_methods();
        let json = serde_json::to_value(&methods).unwrap();
        assert_eq!(json["openai"][0]["type"], "oauth");
    }
}
