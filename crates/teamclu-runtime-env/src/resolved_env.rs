use std::collections::HashMap;
use std::fmt;
use std::sync::OnceLock;

use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::SystemEnvContext;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvScope {
    Personal,
    Team,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvSource {
    Personal,
    Team,
    System,
    UppercaseAlias,
    DotFreeAlias,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvProvenance {
    pub key: String,
    pub scope: EnvScope,
    pub source: EnvSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_of: Option<String>,
    /// Non-secret origin identifier used by diagnostics (usually a file path).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvOverrideKind {
    Layer,
    AliasCollision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvOverride {
    pub key: String,
    pub kind: EnvOverrideKind,
    pub overridden: EnvProvenance,
    pub winner: EnvProvenance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnresolvedReason {
    Missing,
    Invalid,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnresolvedEnv {
    pub key: String,
    pub scope: EnvScope,
    pub reason: UnresolvedReason,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedEnvSnapshot {
    /// Runtime-only values. Diagnostics and serialized snapshots must never
    /// expose these bindings.
    #[serde(skip, default)]
    pub bindings: HashMap<String, String>,
    pub fingerprint: String,
    pub provenance: Vec<EnvProvenance>,
    pub overrides: Vec<EnvOverride>,
    pub unresolved: Vec<UnresolvedEnv>,
}

impl Default for ResolvedEnvSnapshot {
    fn default() -> Self {
        let bindings = HashMap::new();
        Self {
            fingerprint: fingerprint_bindings(&bindings),
            bindings,
            provenance: Vec::new(),
            overrides: Vec::new(),
            unresolved: Vec::new(),
        }
    }
}

impl fmt::Debug for ResolvedEnvSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedEnvSnapshot")
            .field("binding_count", &self.bindings.len())
            .field("fingerprint", &self.fingerprint)
            .field("provenance", &self.provenance)
            .field("overrides", &self.overrides)
            .field("unresolved", &self.unresolved)
            .finish()
    }
}

impl ResolvedEnvSnapshot {
    /// Attach storage locations after resolution without coupling this module
    /// to the desktop/daemon filesystem adapters.
    pub fn annotate_sources(
        &mut self,
        personal_location: Option<&str>,
        team_locations: &HashMap<String, String>,
    ) {
        for entry in &mut self.provenance {
            entry.location = match entry.scope {
                EnvScope::Personal => personal_location.map(str::to_string),
                EnvScope::Team => {
                    let source_key = entry.alias_of.as_deref().unwrap_or(&entry.key);
                    team_locations.get(source_key).cloned()
                }
                EnvScope::System => None,
            };
        }
        for entry in &mut self.overrides {
            annotate_provenance(&mut entry.overridden, personal_location, team_locations);
            annotate_provenance(&mut entry.winner, personal_location, team_locations);
        }
    }
}

fn annotate_provenance(
    entry: &mut EnvProvenance,
    personal_location: Option<&str>,
    team_locations: &HashMap<String, String>,
) {
    entry.location = match entry.scope {
        EnvScope::Personal => personal_location.map(str::to_string),
        EnvScope::Team => {
            let source_key = entry.alias_of.as_deref().unwrap_or(&entry.key);
            team_locations.get(source_key).cloned()
        }
        EnvScope::System => None,
    };
}

pub fn resolve_runtime_env(
    personal: HashMap<String, String>,
    team: HashMap<String, String>,
    system: SystemEnvContext,
) -> ResolvedEnvSnapshot {
    let mut bindings = personal;
    let mut provenance: HashMap<String, EnvProvenance> = bindings
        .keys()
        .map(|key| {
            (
                key.clone(),
                direct_provenance(key.clone(), EnvScope::Personal, EnvSource::Personal),
            )
        })
        .collect();
    let mut overrides = Vec::new();

    for (key, value) in team {
        insert_direct(
            &mut bindings,
            &mut provenance,
            &mut overrides,
            key,
            value,
            EnvScope::Team,
            EnvSource::Team,
        );
    }

    if !system.actor_id.is_empty() {
        insert_direct(
            &mut bindings,
            &mut provenance,
            &mut overrides,
            "actor_id".to_string(),
            system.actor_id.clone(),
            EnvScope::System,
            EnvSource::System,
        );
    }
    if let Some(token) = system.gateway_token.filter(|t| !t.is_empty()) {
        insert_direct(
            &mut bindings,
            &mut provenance,
            &mut overrides,
            "tc_gateway_token".to_string(),
            token,
            EnvScope::System,
            EnvSource::System,
        );
    }
    if !system.display_name.is_empty() {
        insert_direct(
            &mut bindings,
            &mut provenance,
            &mut overrides,
            "display_name".to_string(),
            system.display_name,
            EnvScope::System,
            EnvSource::System,
        );
    }
    if let Some(path) = system.cloud_token_file.filter(|path| !path.is_empty()) {
        insert_direct(
            &mut bindings,
            &mut provenance,
            &mut overrides,
            "TC_ACCESS_TOKEN_FILE".to_string(),
            path,
            EnvScope::System,
            EnvSource::System,
        );
    }

    add_aliases(
        &mut bindings,
        &mut provenance,
        &mut overrides,
        EnvSource::UppercaseAlias,
        |key| {
            let alias = key.to_ascii_uppercase();
            (alias != key).then_some(alias)
        },
    );
    add_aliases(
        &mut bindings,
        &mut provenance,
        &mut overrides,
        EnvSource::DotFreeAlias,
        |key| key.contains('.').then(|| key.replace('.', "_")),
    );

    let fingerprint = fingerprint_bindings(&bindings);
    let mut provenance: Vec<_> = provenance.into_values().collect();
    provenance.sort_by(|left, right| left.key.cmp(&right.key));
    overrides.sort_by(|left, right| left.key.cmp(&right.key));

    ResolvedEnvSnapshot {
        bindings,
        fingerprint,
        provenance,
        overrides,
        unresolved: Vec::new(),
    }
}

fn direct_provenance(key: String, scope: EnvScope, source: EnvSource) -> EnvProvenance {
    EnvProvenance {
        key,
        scope,
        source,
        alias_of: None,
        location: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_direct(
    bindings: &mut HashMap<String, String>,
    provenance: &mut HashMap<String, EnvProvenance>,
    overrides: &mut Vec<EnvOverride>,
    key: String,
    value: String,
    scope: EnvScope,
    source: EnvSource,
) {
    let winner = direct_provenance(key.clone(), scope, source);
    if bindings.insert(key.clone(), value).is_some() {
        let overridden = provenance
            .get(&key)
            .cloned()
            .expect("every binding has provenance");
        overrides.push(EnvOverride {
            key: key.clone(),
            kind: EnvOverrideKind::Layer,
            overridden,
            winner: winner.clone(),
        });
    }
    provenance.insert(key, winner);
}

fn add_aliases(
    bindings: &mut HashMap<String, String>,
    provenance: &mut HashMap<String, EnvProvenance>,
    overrides: &mut Vec<EnvOverride>,
    source: EnvSource,
    alias_for: impl Fn(&str) -> Option<String>,
) {
    // Keep the two-phase collection/insertion behavior of merge_env_maps:
    // aliases are selected against the pre-pass map, then inserted in the
    // HashMap's iteration order.
    let additions: Vec<(String, String, EnvProvenance)> = bindings
        .iter()
        .filter_map(|(key, value)| {
            let alias = alias_for(key)?;
            let origin = provenance.get(key).expect("every binding has provenance");
            let alias_provenance = EnvProvenance {
                key: alias.clone(),
                scope: origin.scope,
                source,
                alias_of: Some(key.clone()),
                location: origin.location.clone(),
            };
            if bindings.contains_key(&alias) {
                let winner = provenance
                    .get(&alias)
                    .cloned()
                    .expect("every binding has provenance");
                overrides.push(EnvOverride {
                    key: alias,
                    kind: EnvOverrideKind::AliasCollision,
                    overridden: alias_provenance,
                    winner,
                });
                None
            } else {
                Some((alias, value.clone(), alias_provenance))
            }
        })
        .collect();

    for (key, value, winner) in additions {
        if bindings.insert(key.clone(), value).is_some() {
            let overridden = provenance
                .get(&key)
                .cloned()
                .expect("every binding has provenance");
            overrides.push(EnvOverride {
                key: key.clone(),
                kind: EnvOverrideKind::AliasCollision,
                overridden,
                winner: winner.clone(),
            });
        }
        provenance.insert(key, winner);
    }
}

/// Process-stable, order-independent fingerprint for a fully assembled runtime
/// env. A process-local secret key prevents diagnostics from becoming an
/// offline oracle for low-entropy secret values.
///
/// The digest is safe to expose in diagnostics; callers must still treat it as
/// an opaque identifier and never serialize the underlying bindings.
pub fn fingerprint_bindings(bindings: &HashMap<String, String>) -> String {
    let mut entries: Vec<_> = bindings.iter().collect();
    entries.sort_by_key(|(left, _)| *left);

    let mut hasher = Sha256::new();
    for (key, value) in entries {
        hasher.update((key.len() as u64).to_be_bytes());
        hasher.update(key.as_bytes());
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    let canonical_digest = hasher.finalize();
    static PROCESS_KEY: OnceLock<[u8; 32]> = OnceLock::new();
    let process_key = PROCESS_KEY.get_or_init(|| {
        let mut key = [0_u8; 32];
        getrandom::getrandom(&mut key).expect("OS randomness required for env fingerprints");
        key
    });
    let hkdf = Hkdf::<Sha256>::new(Some(process_key), &canonical_digest);
    let mut fingerprint = [0_u8; 32];
    hkdf.expand(b"teamclu-resolved-env-fingerprint-v1", &mut fingerprint)
        .expect("fixed SHA-256 fingerprint length is valid");
    hex::encode(fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merge::merge_env_maps;

    fn context() -> SystemEnvContext {
        SystemEnvContext {
            actor_id: "actor-1".to_string(),
            display_name: "Agent".to_string(),
            cloud_token_file: Some("/tmp/cloud-token".to_string()),
            gateway_token: None,
            ai_proxy_base: None,
        }
    }

    #[test]
    fn fingerprint_is_independent_of_input_order() {
        let first = HashMap::from([
            ("B".to_string(), "second".to_string()),
            ("A".to_string(), "first".to_string()),
        ]);
        let second = HashMap::from([
            ("A".to_string(), "first".to_string()),
            ("B".to_string(), "second".to_string()),
        ]);

        let first = resolve_runtime_env(first, HashMap::new(), context());
        let second = resolve_runtime_env(second, HashMap::new(), context());

        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.fingerprint.len(), 64);
    }

    #[test]
    fn bindings_match_merge_env_maps() {
        let personal = HashMap::from([
            ("personal.key".to_string(), "personal".to_string()),
            ("SHARED".to_string(), "personal-shared".to_string()),
        ]);
        let team = HashMap::from([
            ("SHARED".to_string(), "team-shared".to_string()),
            ("team.key".to_string(), "team".to_string()),
        ]);
        let system = context();

        let expected = merge_env_maps(personal.clone(), team.clone(), &system);
        let snapshot = resolve_runtime_env(personal, team, system);

        assert_eq!(snapshot.bindings, expected);
    }

    #[test]
    fn records_layer_overrides_without_values() {
        let personal = HashMap::from([
            ("SHARED".to_string(), "personal-secret".to_string()),
            ("actor_id".to_string(), "personal-actor".to_string()),
        ]);
        let team = HashMap::from([
            ("SHARED".to_string(), "team-secret".to_string()),
            ("actor_id".to_string(), "team-actor".to_string()),
        ]);

        let snapshot = resolve_runtime_env(personal, team, context());
        let shared = snapshot
            .overrides
            .iter()
            .find(|entry| entry.key == "SHARED")
            .unwrap();
        assert_eq!(shared.kind, EnvOverrideKind::Layer);
        assert_eq!(shared.overridden.scope, EnvScope::Personal);
        assert_eq!(shared.winner.scope, EnvScope::Team);
        assert_eq!(
            snapshot
                .overrides
                .iter()
                .filter(|entry| entry.key == "actor_id")
                .count(),
            2
        );
    }

    #[test]
    fn records_alias_collision_and_source() {
        let personal = HashMap::from([
            ("service.key".to_string(), "from-dot".to_string()),
            ("service_key".to_string(), "explicit".to_string()),
        ]);

        let snapshot = resolve_runtime_env(personal, HashMap::new(), context());
        let collision = snapshot
            .overrides
            .iter()
            .find(|entry| {
                entry.kind == EnvOverrideKind::AliasCollision && entry.key == "service_key"
            })
            .unwrap();

        assert_eq!(collision.overridden.source, EnvSource::DotFreeAlias);
        assert_eq!(
            collision.overridden.alias_of.as_deref(),
            Some("service.key")
        );
        assert_eq!(collision.winner.source, EnvSource::Personal);
        assert_eq!(
            snapshot.bindings.get("service_key").map(String::as_str),
            Some("explicit")
        );
    }

    #[test]
    fn serialization_never_exposes_bindings_or_secret_values() {
        let secret = "highly-sensitive-secret";
        let snapshot = resolve_runtime_env(
            HashMap::from([("API_TOKEN".to_string(), secret.to_string())]),
            HashMap::new(),
            context(),
        );

        let serialized = serde_json::to_string(&snapshot).unwrap();

        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("\"bindings\""));
        assert!(!format!("{snapshot:?}").contains(secret));
    }

    #[test]
    fn storage_locations_are_attached_without_values() {
        let mut snapshot = resolve_runtime_env(
            HashMap::from([("personal.key".to_string(), "vault-value".to_string())]),
            HashMap::from([("TEAM_TOKEN".to_string(), "shared-value".to_string())]),
            context(),
        );
        snapshot.annotate_sources(
            Some("/home/user/.teamclu/secrets/personal-secrets.json.enc"),
            &HashMap::from([(
                "TEAM_TOKEN".to_string(),
                "/workspace/teamclu-team/_secrets/TEAM_TOKEN.enc.json".to_string(),
            )]),
        );

        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(serialized.contains("personal-secrets.json.enc"));
        assert!(serialized.contains("TEAM_TOKEN.enc.json"));
        assert!(!serialized.contains("vault-value"));
        assert!(!serialized.contains("shared-value"));
    }
}
