use std::collections::HashMap;

use crate::SystemEnvContext;

/// Placeholder written into `provider.team.options.apiKey` before resolution.
pub const GATEWAY_TOKEN_PLACEHOLDER: &str = "${tc_gateway_token}";

/// Prefix of the credential this replaced: a LiteLLM virtual key derived
/// locally as `sk-tc-{actor_id[..40]}`. A value with this prefix on disk is a
/// leftover from before the gateway cutover and must be overwritten — it names
/// a key the new gateway will never accept, and nothing else would clear it.
pub const LEGACY_VIRTUAL_KEY_PREFIX: &str = "sk-tc-";

/// Secrets map for reconcile / lightweight `provider.team` sync.
///
/// The credential is supplied by the caller rather than derived here: it is a
/// daemon session token scoped to `ai:invoke`, and only the daemon can mint
/// one. Deriving a value from the actor id (which is what this did for LiteLLM)
/// cannot produce a token anything is willing to verify.
pub fn secrets_for_team_provider(gateway_token: &str) -> HashMap<String, String> {
    let mut secrets = HashMap::new();
    if !gateway_token.is_empty() {
        secrets.insert("tc_gateway_token".to_string(), gateway_token.to_string());
    }
    secrets
}

/// Keys from `env` that the host OS environment would override at opencode serve
/// spawn (serve only injects when `std::env::var_os(key)` is unset).
pub fn host_shadowed_env_keys(env: &HashMap<String, String>) -> Vec<String> {
    use std::collections::HashSet;

    let mut seen = HashSet::new();
    let mut shadowed = Vec::new();
    for key in env.keys() {
        if std::env::var_os(key).is_some() {
            if seen.insert(key.clone()) {
                shadowed.push(key.clone());
            }
            continue;
        }
        let upper = key.to_ascii_uppercase();
        if upper != *key && std::env::var_os(&upper).is_some() && seen.insert(upper.clone()) {
            shadowed.push(format!("{key} (host has {upper})"));
        }
    }
    shadowed.sort();
    shadowed.truncate(8);
    shadowed
}

pub fn merge_env_maps(
    personal: HashMap<String, String>,
    team: HashMap<String, String>,
    system: &SystemEnvContext,
) -> HashMap<String, String> {
    crate::resolved_env::resolve_runtime_env(personal, team, system.clone()).bindings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(actor_id: &str, display_name: &str) -> SystemEnvContext {
        SystemEnvContext {
            actor_id: actor_id.to_string(),
            display_name: display_name.to_string(),
            cloud_token_file: None,
            gateway_token: None,
        }
    }

    #[test]
    fn host_shadowed_env_keys_detects_exact_host_match() {
        use rand::Rng;
        let suffix: u64 = rand::thread_rng().gen();
        let key = format!("TEAMCLU_HOST_SHADOW_{suffix}");
        // SAFETY: test-only unique key; restored immediately.
        unsafe { std::env::set_var(&key, "from-host") };
        let mut env = HashMap::new();
        env.insert(key.clone(), "from-blob".to_string());
        let shadowed = host_shadowed_env_keys(&env);
        unsafe { std::env::remove_var(&key) };
        assert_eq!(shadowed, vec![key]);
    }

    #[test]
    fn host_shadowed_env_keys_detects_uppercase_host_match() {
        use rand::Rng;
        let suffix: u64 = rand::thread_rng().gen();
        let key = format!("teamclu_host_shadow_{suffix}");
        let upper = key.to_ascii_uppercase();
        // SAFETY: test-only unique key; restored immediately.
        unsafe { std::env::set_var(&upper, "from-host") };
        let mut env = HashMap::new();
        env.insert(key.clone(), "from-blob".to_string());
        let shadowed = host_shadowed_env_keys(&env);
        unsafe { std::env::remove_var(&upper) };
        assert!(
            shadowed.iter().any(|s| s.contains(&key)),
            "expected host shadow for {key}, got {shadowed:?}"
        );
    }

    #[test]
    fn team_overrides_personal_on_duplicate() {
        let mut personal = HashMap::new();
        personal.insert("FOO".to_string(), "personal".to_string());
        let mut team = HashMap::new();
        team.insert("FOO".to_string(), "team".to_string());

        let out = merge_env_maps(personal, team, &ctx("", ""));

        assert_eq!(out.get("FOO").map(String::as_str), Some("team"));
    }

    #[test]
    fn secrets_for_team_provider_carries_the_caller_supplied_token() {
        // The credential is passed in, not derived: it is a daemon session
        // token, and no function of the actor id produces one anything will
        // verify.
        let secrets = secrets_for_team_provider("tok_abc");
        assert_eq!(
            secrets.get("tc_gateway_token").map(String::as_str),
            Some("tok_abc")
        );
        // No token (no HTTP layer to mint one) leaves the placeholder in place
        // rather than writing an empty credential.
        assert!(secrets_for_team_provider("").is_empty());
    }

    #[test]
    fn actor_id_no_longer_yields_a_credential() {
        // It used to: `sk-tc-{actor_id[..40]}` was a LiteLLM virtual key derived
        // from the actor id. The gateway token cannot be derived, so a context
        // without one binds no credential rather than a guessable string.
        let actor_id = "a".repeat(50);
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx(&actor_id, ""));

        assert_eq!(
            out.get("actor_id").map(String::as_str),
            Some(actor_id.as_str())
        );
        assert!(!out.contains_key("tc_gateway_token"));
        assert!(!out.contains_key("tc_api_key"));
    }

    #[test]
    fn injects_cloud_token_file_when_set() {
        let mut ctx = ctx("actor-1", "host");
        ctx.cloud_token_file = Some("/home/u/.amuxd/amuxd.cloud-token".to_string());

        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx);

        assert_eq!(
            out.get("TC_ACCESS_TOKEN_FILE").map(String::as_str),
            Some("/home/u/.amuxd/amuxd.cloud-token")
        );
    }

    #[test]
    fn skips_cloud_token_file_when_none_or_empty() {
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx("actor-1", ""));
        assert!(!out.contains_key("TC_ACCESS_TOKEN_FILE"));

        let mut ctx = ctx("actor-1", "");
        ctx.cloud_token_file = Some(String::new());
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx);
        assert!(!out.contains_key("TC_ACCESS_TOKEN_FILE"));
    }

    #[test]
    fn skips_actor_bindings_when_actor_id_empty() {
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx("", "host"));

        assert!(!out.contains_key("actor_id"));
        assert!(!out.contains_key("tc_gateway_token"));
        assert_eq!(out.get("display_name").map(String::as_str), Some("host"));
    }

    #[test]
    fn injects_actor_id_and_display_name() {
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx("actor-123", "My Mac"));

        assert_eq!(out.get("actor_id").map(String::as_str), Some("actor-123"));
        assert_eq!(out.get("display_name").map(String::as_str), Some("My Mac"));
    }

    #[test]
    fn adds_uppercase_alias_for_lowercase_key() {
        let mut personal = HashMap::new();
        personal.insert("some_api_key".to_string(), "secret".to_string());

        let out = merge_env_maps(personal, HashMap::new(), &ctx("", ""));

        assert_eq!(out.get("some_api_key").map(String::as_str), Some("secret"));
        assert_eq!(out.get("SOME_API_KEY").map(String::as_str), Some("secret"));
    }

    #[test]
    fn adds_dot_free_alias_for_dotted_key() {
        let mut personal = HashMap::new();
        personal.insert("wecom.corp_id".to_string(), "cid".to_string());

        let out = merge_env_maps(personal, HashMap::new(), &ctx("", ""));

        assert_eq!(out.get("wecom.corp_id").map(String::as_str), Some("cid"));
        assert_eq!(out.get("wecom_corp_id").map(String::as_str), Some("cid"));
    }
}
