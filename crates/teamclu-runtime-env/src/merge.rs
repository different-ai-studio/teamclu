use std::collections::HashMap;

use crate::SystemEnvContext;

/// Locally derived AI-gateway key for the given actor (empty → none).
pub fn tc_api_key_for_actor(actor_id: &str) -> Option<String> {
    if actor_id.is_empty() {
        return None;
    }
    let suffix: String = actor_id.chars().take(40).collect();
    Some(format!("sk-tc-{suffix}"))
}

/// Secrets map for reconcile / lightweight provider.team sync (tc_api_key only).
pub fn secrets_for_team_provider(actor_id: &str) -> HashMap<String, String> {
    let mut secrets = HashMap::new();
    if let Some(key) = tc_api_key_for_actor(actor_id) {
        secrets.insert("tc_api_key".to_string(), key);
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
    fn secrets_for_team_provider_derives_tc_api_key() {
        let secrets = secrets_for_team_provider("actor-123");
        assert_eq!(
            secrets.get("tc_api_key").map(String::as_str),
            Some("sk-tc-actor-123")
        );
        assert!(secrets_for_team_provider("").is_empty());
    }

    #[test]
    fn tc_api_key_from_actor_id() {
        let actor_id = "a".repeat(50);
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx(&actor_id, ""));

        assert_eq!(
            out.get("actor_id").map(String::as_str),
            Some(actor_id.as_str())
        );
        let expected_key = format!("sk-tc-{}", &actor_id[..40]);
        assert_eq!(
            out.get("tc_api_key").map(String::as_str),
            Some(expected_key.as_str())
        );
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
    fn skips_tc_api_key_when_actor_id_empty() {
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx("", "host"));

        assert!(!out.contains_key("actor_id"));
        assert!(!out.contains_key("tc_api_key"));
        assert_eq!(out.get("display_name").map(String::as_str), Some("host"));
    }

    #[test]
    fn injects_actor_id_and_display_name() {
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx("actor-123", "My Mac"));

        assert_eq!(out.get("actor_id").map(String::as_str), Some("actor-123"));
        assert_eq!(out.get("display_name").map(String::as_str), Some("My Mac"));
        assert_eq!(
            out.get("tc_api_key").map(String::as_str),
            Some("sk-tc-actor-123")
        );
    }

    #[test]
    fn adds_uppercase_alias_for_lowercase_key() {
        let mut personal = HashMap::new();
        personal.insert("tc_api_key".to_string(), "secret".to_string());

        let out = merge_env_maps(personal, HashMap::new(), &ctx("", ""));

        assert_eq!(out.get("tc_api_key").map(String::as_str), Some("secret"));
        assert_eq!(out.get("TC_API_KEY").map(String::as_str), Some("secret"));
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
