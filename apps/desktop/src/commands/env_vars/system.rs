//! Environment variables the product itself defines (as opposed to the
//! user's own), and the pass that makes sure a workspace has them.

use super::blob::read_env_blob;
use super::blob::write_env_blob;
use super::index::read_env_index;
use super::index::write_env_index;
use super::index::EnvVarEntry;

/// Context available to system env var default generators.
struct SystemEnvVarContext {
    // Read by default generators; the registry is empty since the team-gateway
    // cutover, so nothing reads it today. Kept as the extension point it documents.
    #[allow(dead_code)]
    actor_id: String,
}

/// How a system env var's default value should be applied on startup.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DefaultPolicy {
    /// Re-derive on every startup; overwrite the stored value if it differs.
    /// Use when the default depends on system state that may change
    /// (e.g. `tc_api_key` is derived from `actor_id`).
    #[allow(dead_code)] // no registry entry uses it since the team-gateway cutover
    RegenerateAlways,
    /// Write the default only when the key is missing from the blob.
    /// Empty user-set values are preserved (treated as "user has decided to leave blank").
    #[allow(dead_code)]
    SetIfAbsent,
}

/// Definition of a system-managed env var.
pub(crate) struct SystemEnvVarDef {
    key: &'static str,
    description: &'static str,
    default_fn: fn(&SystemEnvVarContext) -> Option<String>,
    policy: DefaultPolicy,
    /// When true, the entry is registered with category `system-shared`. The UI uses
    /// this to surface the key as a team-shared candidate (encrypted, synced via
    /// `shared_secrets`) and never seeds a value into the local keychain blob.
    shared_default: bool,
}

/// Registry of all system env vars.
/// To add a new one: append an entry here — nothing else changes.
///
/// Empty since the team-gateway cutover. It held exactly one entry,
/// `tc_api_key`, whose default was `sk-tc-{actor_id[..40]}` — a LiteLLM virtual
/// key the desktop could derive because it was guessable. Its replacement is a
/// daemon session token scoped to `ai:invoke`, which only the daemon can mint,
/// so there is nothing for the desktop to seed.
///
/// Seeding the old value would be worse than useless now: personal env takes
/// precedence over system env when the runtime env is merged, so a leftover
/// `tc_api_key` in the keychain blob would shadow the credential the daemon
/// writes.
pub(crate) const SYSTEM_ENV_VARS: &[SystemEnvVarDef] = &[];

/// Ensure all system env vars exist in the local encrypted store and in the teamclu.json index.
/// If a key is missing from the blob, its default value is generated and written.
/// If a key already has a value (user customized), it is left unchanged.
/// This must be called on a blocking thread (disk I/O).
pub(crate) fn ensure_system_env_vars(workspace_path: &str, actor_id: &str) -> Result<(), String> {
    let ctx = SystemEnvVarContext {
        actor_id: actor_id.to_string(),
    };
    let mut blob = read_env_blob(workspace_path)?;
    let mut entries = read_env_index(workspace_path)?;
    let mut blob_changed = false;
    let mut index_changed = false;

    for def in SYSTEM_ENV_VARS {
        // `system-shared` defs never touch the local keychain blob — their values
        // live in `shared_secrets` (team KMS) and are injected into opencode at startup.
        // We only register them in the teamclu.json index so the key shows up in
        // the env-var UI on every member's machine.
        if !def.shared_default {
            let key_present_in_blob = blob.contains_key(def.key);
            let existing_value = blob.get(def.key).and_then(|v| v.as_str()).unwrap_or("");

            match def.policy {
                DefaultPolicy::RegenerateAlways => {
                    // Re-derive on every startup; overwrite if the result differs.
                    // Used when the default depends on mutable system state (e.g. actor_id).
                    if let Some(new_value) = (def.default_fn)(&ctx) {
                        if existing_value != new_value {
                            if !existing_value.is_empty() {
                                println!(
                                    "[EnvVars] Updating system var {} (value changed)",
                                    def.key
                                );
                            } else {
                                println!(
                                    "[EnvVars] Generated default value for system var: {}",
                                    def.key
                                );
                            }
                            blob.insert(def.key.to_string(), serde_json::Value::String(new_value));
                            blob_changed = true;
                        }
                    }
                }
                DefaultPolicy::SetIfAbsent => {
                    // Only seed the default when the key has never been written.
                    // An existing empty string is treated as "user left it blank intentionally".
                    if !key_present_in_blob {
                        if let Some(default) = (def.default_fn)(&ctx) {
                            println!("[EnvVars] Seeding system var {} with default", def.key);
                            blob.insert(def.key.to_string(), serde_json::Value::String(default));
                            blob_changed = true;
                        }
                    }
                }
            }
        }

        // Decide whether to register in the index (synced via teamclu.json):
        //   - shared_default:                always register (key shows in UI; value lives in shared_secrets).
        //   - SetIfAbsent (local):           always register so the key shows even before a value is set.
        //   - RegenerateAlways (local):      only when the blob holds a non-empty value
        //                                    (skip when the generator yielded nothing, e.g. actor_id not ready).
        let should_index = if def.shared_default {
            true
        } else {
            match def.policy {
                DefaultPolicy::RegenerateAlways => blob
                    .get(def.key)
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| !v.is_empty()),
                DefaultPolicy::SetIfAbsent => true,
            }
        };
        if !should_index {
            continue;
        }

        let target_category = if def.shared_default {
            "system-shared"
        } else {
            "system"
        };
        if let Some(existing) = entries.iter_mut().find(|e| e.key == def.key) {
            if existing.category.as_deref() != Some(target_category) {
                existing.category = Some(target_category.to_string());
                index_changed = true;
            }
        } else {
            entries.push(EnvVarEntry {
                key: def.key.to_string(),
                description: Some(def.description.to_string()),
                category: Some(target_category.to_string()),
            });
            index_changed = true;
        }
    }

    if blob_changed {
        write_env_blob(&blob)?;
    }
    if index_changed {
        write_env_index(workspace_path, &entries)?;
    }

    Ok(())
}
