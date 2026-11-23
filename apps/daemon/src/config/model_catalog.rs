//! Device-scoped model catalog, keyed by backend and worktree directory.
//!
//! # Why this exists
//!
//! The model catalog is a property of the *device* — of the one global
//! `opencode serve` process and the providers configured for a given worktree
//! (see `runtime::opencode_http::supervisor`: "One serve instance per
//! daemon"). It is emphatically not a property of a single runtime binding.
//!
//! It used to be stored as one, though. `RuntimeHandle::available_models` is
//! filled from `startup.available_models` at attach time and published in that
//! handle's retained `runtime/{id}/state`. Every other binding for the same
//! device — an idle one from yesterday, a historical row replayed out of
//! `SessionStore` by `publish_actor_state` — advertised an **empty**
//! catalog, because it never had an attach of its own to fill it.
//!
//! Clients read that as "this runtime offers no models". The desktop's session
//! pill treats `availableModelCount == 0` as not-ready and shows 连接中 with no
//! model name, forever, for any session that is not the most recent spawn.
//! Observed 2026-07-27: two sessions on the same device, one green with 44
//! models, one stuck connecting — the difference was solely which binding had
//! done the attach.
//!
//! So the catalog is cached here once per (backend, worktree) and merged into
//! every `RuntimeInfo` that would otherwise go out empty.
//!
//! # Why it is persisted
//!
//! `publish_actor_state` runs at startup and after every MQTT reconnect —
//! before any runtime has attached, so an in-memory-only cache would still be
//! empty at exactly the moment it is most needed. Persisting means a cold
//! daemon publishes its last-known catalog instead of nothing.
//!
//! A stale entry is safe: this list only populates a picker. The authoritative
//! check happens on `set_model`, which goes to the live serve. Publishing a
//! slightly outdated list beats publishing none — the failure mode of "none"
//! is a session that can never be used.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::proto::amux;

/// One model as persisted in the catalog.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredModel {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub provider_name: String,
}

/// Backend id (`"opencode"` / `"pi"` / `"cursor"` / `"claude"`) → canonical
/// worktree path → the models that backend last advertised there.
///
/// # Why the backend is part of the key
///
/// Same reason [`super::ModelMru`] splits by backend: model ids are
/// backend-local, so `opencode/big-pickle` means nothing to pi and a cursor id
/// means nothing to either. This store used to be keyed by worktree alone, so
/// flipping `agents.local_agent` made the new backend's probe overwrite the old
/// backend's catalog — and [`Self::models_for_or_any`] would then hand that list
/// to whichever binding asked. Combined with the desktop auto-selecting the
/// first advertised model, that produced a `ProviderModelNotFoundError` on the
/// first send: a model the running backend has never heard of.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct DeviceModelCatalog {
    #[serde(default)]
    pub by_backend: BTreeMap<String, BTreeMap<String, Vec<StoredModel>>>,
}

impl DeviceModelCatalog {
    /// A machine-level probe cache keyed by backend and worktree — never by
    /// team, so it lives in `cache/` rather than sinking into `teams/`.
    pub fn default_path() -> PathBuf {
        super::layout::cache_dir().join("model-catalog.toml")
    }

    /// Read the store, treating any problem (missing, unreadable, malformed) as
    /// "no catalog yet". Same convention as [`super::ModelMru`]: a cache must
    /// never fail startup.
    ///
    /// A pre-backend-keyed file (`[by_worktree]` at the top level) simply
    /// deserializes to empty and is discarded: those entries carry no record of
    /// which backend produced them, and guessing would reintroduce exactly the
    /// cross-backend mixing the key change prevents. The cost is one cold probe
    /// after upgrading, which the store refills.
    pub fn load(path: &Path) -> Self {
        let Ok(content) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        match toml::from_str::<Self>(&content) {
            Ok(mut store) => {
                for by_worktree in store.by_backend.values_mut() {
                    for models in by_worktree.values_mut() {
                        models.retain(|m| !m.id.trim().is_empty());
                    }
                    by_worktree.retain(|_, models| !models.is_empty());
                }
                store
                    .by_backend
                    .retain(|_, by_worktree| !by_worktree.is_empty());
                store
            }
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "model catalog unreadable; starting empty");
                Self::default()
            }
        }
    }

    pub fn save(&self, path: &Path) -> crate::error::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| crate::error::AmuxError::Config(e.to_string()))?;
        super::atomic_file::write(path, &content)?;
        Ok(())
    }

    /// Replace `backend`'s catalog for `worktree`. Returns whether anything
    /// changed, so the caller can skip the disk write on the common "same
    /// catalog again" path.
    ///
    /// An empty `models` is ignored rather than stored: a failed or not-yet-
    /// completed probe must not erase a good catalog — that would reintroduce
    /// exactly the empty-list bug this store exists to prevent.
    pub fn record(&mut self, backend: &str, worktree: &str, models: &[amux::ModelInfo]) -> bool {
        let backend_key = backend.trim();
        let key = worktree.trim();
        if backend_key.is_empty() || key.is_empty() || models.is_empty() {
            return false;
        }
        let next: Vec<StoredModel> = models
            .iter()
            .filter(|m| !m.id.trim().is_empty())
            .map(|m| StoredModel {
                id: m.id.clone(),
                display_name: m.display_name.clone(),
                provider_name: m.provider_name.clone(),
            })
            .collect();
        if next.is_empty() {
            return false;
        }
        let by_worktree = self.by_backend.entry(backend_key.to_string()).or_default();
        if by_worktree.get(key) == Some(&next) {
            return false;
        }
        by_worktree.insert(key.to_string(), next);
        true
    }

    /// `backend`'s last-known catalog for `worktree` as proto, empty when unknown.
    ///
    /// Exact-match lookup; production callers go through
    /// [`Self::models_for_or_any`], which is this plus the same-backend
    /// cross-worktree fallback.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn models_for(&self, backend: &str, worktree: &str) -> Vec<amux::ModelInfo> {
        self.by_backend
            .get(backend.trim())
            .and_then(|by_worktree| by_worktree.get(worktree.trim()))
            .map(|m| to_proto(m.as_slice()))
            .unwrap_or_default()
    }

    /// `backend`'s catalog, preferred by exact worktree match, else any worktree
    /// **this same backend** has served.
    ///
    /// A historical `SessionStore` row can carry a worktree this device has
    /// since stopped using (renamed directory, deleted worktree). Falling back
    /// to another of this backend's worktrees is still far more useful than an
    /// empty list, because one device runs one `opencode serve` (or one pi /
    /// cursor child) with the same provider credentials — the per-worktree split
    /// exists for workspace-local config overrides, not for wholly disjoint
    /// model sets.
    ///
    /// The fallback deliberately does not cross backends: a pi id handed to
    /// opencode is not a degraded answer, it is a wrong one.
    pub fn models_for_or_any(&self, backend: &str, worktree: &str) -> Vec<amux::ModelInfo> {
        let Some(by_worktree) = self.by_backend.get(backend.trim()) else {
            return Vec::new();
        };
        by_worktree
            .get(worktree.trim())
            .or_else(|| by_worktree.values().next())
            .map(|m| to_proto(m.as_slice()))
            .unwrap_or_default()
    }
}

fn to_proto(models: &[StoredModel]) -> Vec<amux::ModelInfo> {
    models
        .iter()
        .map(|m| amux::ModelInfo {
            id: m.id.clone(),
            display_name: m.display_name.clone(),
            provider_name: m.provider_name.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str) -> amux::ModelInfo {
        amux::ModelInfo {
            id: id.to_string(),
            display_name: id.to_string(),
            provider_name: "test".to_string(),
        }
    }

    #[test]
    fn record_stores_and_dedupes() {
        let mut cat = DeviceModelCatalog::default();
        assert!(cat.record("opencode", "/w1", &[model("a/x"), model("a/y")]));
        // Same catalog again is a no-op, so callers can skip the disk write.
        assert!(!cat.record("opencode", "/w1", &[model("a/x"), model("a/y")]));
        assert!(cat.record("opencode", "/w1", &[model("a/x")]));
        assert_eq!(cat.models_for("opencode", "/w1").len(), 1);
    }

    #[test]
    fn record_ignores_empty_so_a_failed_probe_cannot_erase_a_good_catalog() {
        let mut cat = DeviceModelCatalog::default();
        cat.record("opencode", "/w1", &[model("a/x")]);
        assert!(!cat.record("opencode", "/w1", &[]));
        assert_eq!(cat.models_for("opencode", "/w1").len(), 1);
    }

    #[test]
    fn each_backend_keeps_its_own_catalog_for_the_same_worktree() {
        // Flipping `agents.local_agent` in one worktree used to overwrite the
        // previous backend's catalog, so the next binding could be handed model
        // ids the running backend has never heard of.
        let mut cat = DeviceModelCatalog::default();
        cat.record("opencode", "/w1", &[model("opencode/big-pickle")]);
        cat.record("pi", "/w1", &[model("pi/small-gherkin")]);

        assert_eq!(
            cat.models_for("opencode", "/w1")[0].id,
            "opencode/big-pickle"
        );
        assert_eq!(cat.models_for("pi", "/w1")[0].id, "pi/small-gherkin");
    }

    #[test]
    fn models_for_or_any_falls_back_to_another_worktree() {
        let mut cat = DeviceModelCatalog::default();
        cat.record("opencode", "/w1", &[model("a/x")]);
        // Unknown worktree — a historical session row from a directory that no
        // longer exists still gets this backend's catalog.
        assert_eq!(cat.models_for("opencode", "/gone").len(), 0);
        assert_eq!(cat.models_for_or_any("opencode", "/gone").len(), 1);
    }

    #[test]
    fn models_for_or_any_never_crosses_backends() {
        let mut cat = DeviceModelCatalog::default();
        cat.record("opencode", "/w1", &[model("opencode/big-pickle")]);
        // cursor has no catalog at all: an empty list is correct, borrowing
        // opencode's ids would be actively wrong.
        assert!(cat.models_for_or_any("cursor", "/w1").is_empty());
        assert!(cat.models_for_or_any("cursor", "/gone").is_empty());
    }

    #[test]
    fn legacy_worktree_only_file_is_discarded_rather_than_misattributed() {
        let path = std::env::temp_dir()
            .join("amuxd-test-model-catalog")
            .join(format!("legacy-{}.toml", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
        // Shape written by the pre-backend-keyed version.
        std::fs::write(
            &path,
            "[by_worktree]\n\"/w1\" = [{ id = \"a/x\", display_name = \"\", provider_name = \"\" }]\n",
        )
        .expect("write");
        let loaded = DeviceModelCatalog::load(&path);
        assert!(loaded.by_backend.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_missing_file_is_empty_not_an_error() {
        let path = std::env::temp_dir().join("amuxd-test-catalog-missing.toml");
        let _ = std::fs::remove_file(&path);
        assert!(DeviceModelCatalog::load(&path).by_backend.is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let path = std::env::temp_dir()
            .join("amuxd-test-model-catalog")
            .join(format!("{}.toml", uuid::Uuid::new_v4()));
        let mut cat = DeviceModelCatalog::default();
        cat.record("opencode", "/w1", &[model("a/x"), model("a/y")]);
        cat.save(&path).expect("save");
        let loaded = DeviceModelCatalog::load(&path);
        assert_eq!(loaded.models_for("opencode", "/w1").len(), 2);
        assert_eq!(loaded.models_for("opencode", "/w1")[0].id, "a/x");
        let _ = std::fs::remove_file(&path);
    }
}
