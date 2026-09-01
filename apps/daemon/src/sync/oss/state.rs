//! Local sync state — `{meta}/sync/state.json` schema (spec §4.2).
//!
//! NOTE: `LocalSyncState` load/save/new and `FileState::upsert` are reserved for
//! the OSS pull/push pipeline; not yet called from the sync dispatcher.
#![allow(dead_code, clippy::too_many_arguments)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: u32 = 1;

/// Per-file state entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    /// Version number at which we last synced this file from the server.
    pub synced_version: i32,
    /// sha256(blob bytes) as of last completed sync — matches `content_hash` on wire.
    pub synced_cipher_hash: String,
    /// sha256(plaintext) as of last completed sync — local only, never sent.
    pub synced_plain_hash: String,
    /// sha256(current local plaintext) — updated on every scan.
    pub local_plain_hash: String,
    /// Last modified time (unix seconds) at last scan.
    pub mtime: u64,
    /// File size in bytes at last scan.
    pub size: u64,
    /// True if local file differs from `synced_plain_hash`.
    pub dirty: bool,
    /// True if the file was locally deleted but the deletion not yet pushed.
    #[serde(default)]
    pub deleted_local: bool,
}

/// A file the server offered that this device could not decode or write.
///
/// Kept so the pull can move PAST it — the sync cursor used to be held at the
/// first unreadable file, which stopped every later document in the team from
/// ever arriving. The entry is retried on every tick, so this is a "keep
/// trying" list, not a "give up" list: dropping it instead would lose the file
/// permanently, since the manifest is queried by `afterSeq`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedPull {
    /// Blob hash to re-fetch (also what the FC download endpoint takes).
    pub cipher_hash: String,
    /// Server version this blob belongs to.
    pub version: i32,
    /// Why it failed last time, for the log and for support.
    pub reason: String,
    /// How many ticks have tried. Never used to stop trying — a key can be
    /// delivered, or a bad blob re-uploaded, long after the first failure.
    pub attempts: u32,
}

/// A path the server refuses to serve this device: the team restricted the
/// directory and this actor is not granted it.
///
/// Not an error and not a quarantine. A quarantined pull is "try again every
/// tick, something might have changed"; this is "stop asking". A restricted
/// directory only opens when an administrator grants access, which no amount of
/// retrying brings closer, and retrying it every tick would hold the file dirty
/// and keep a red count in front of the user forever.
///
/// It is retried, rarely, because a grant CAN arrive: see
/// `FORBIDDEN_RETRY_SECS`. There is deliberately no push notification for a
/// grant — one would have to name the directory, and telling someone a
/// restricted directory exists is the thing the design withholds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForbiddenPath {
    /// Unix seconds of the last attempt. Retry is time-based, not count-based.
    pub last_tried_at: u64,
    /// Server's message, kept for the log and for support.
    pub reason: String,
}

/// How long to leave a forbidden path alone before trying once more.
///
/// A day, because the only thing that changes the answer is an administrator
/// action, and an admin who has just granted access can tell the person to
/// restart the app rather than wait. Polling more often would be a request per
/// file per interval, buying nothing.
pub const FORBIDDEN_RETRY_SECS: u64 = 24 * 60 * 60;

/// A file the manifest lists that this device has NOT fetched.
///
/// # Why this is not a flag on `FileState`
///
/// The engine decides a file was deleted locally from `in state.files, absent
/// from the scan` (`engine::locally_deleted_paths`) — and "known but not
/// downloaded" is exactly that shape. A `materialized: bool` on `FileState`
/// would work only as long as every one of the dozen call sites that read that
/// map remembers to check it, and the cost of one forgetting is a tombstone
/// broadcast to the whole team.
///
/// Keeping these in their own map makes it a property of the type instead: a
/// path that is not in `files` can never become a tombstone candidate, and that
/// holds without anyone remembering anything.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownFile {
    /// Server version this entry describes.
    pub version: i32,
    /// Blob hash — what the download endpoint takes.
    pub cipher_hash: String,
    /// Size on the server, for showing a cost before fetching.
    pub size: u64,
}

/// Full local sync state file (schema v1).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncState {
    pub schema_version: u32,
    pub team_id: String,
    /// The highest `change_seq` whose full page has been processed.
    pub last_server_seq: i64,
    pub last_sync_at: String,
    /// Map from relative path (e.g. "skills/foo.md") to per-file state.
    pub files: HashMap<String, FileState>,
    /// Files the pull could not apply, by path. `serde(default)` so a state file
    /// written by an older daemon still loads — the schema version is unchanged
    /// on purpose, since old daemons can read the new file too (they ignore it).
    #[serde(default)]
    pub quarantined: HashMap<String, QuarantinedPull>,
    /// Paths the server has refused as restricted, by path. `serde(default)` so
    /// a state file written by an older daemon still loads, and an older daemon
    /// still reads a newer file — the schema version is unchanged on purpose,
    /// exactly as it was when `quarantined` was added.
    #[serde(default)]
    pub forbidden: HashMap<String, ForbiddenPath>,
    /// Unix seconds of the last FULL manifest drain (from seq 0).
    ///
    /// The ordinary tick asks for `afterSeq = last_server_seq`, which can only
    /// ever tell us about changes. Losing access to a directory is not a change
    /// the server can send us — the rows simply stop being returned — so it is
    /// invisible to an incremental sync. Periodically widening the window to the
    /// whole manifest is what makes revocation observable at all.
    #[serde(default)]
    pub last_reconcile_at: u64,
    /// Manifest entries this device knows about but has not fetched.
    ///
    /// Only ever `documents/` paths: `knowledge/` is fetched eagerly because
    /// every member is meant to hold the same copy of it.
    ///
    /// `serde(default)` so an older state file still loads, and an older daemon
    /// still reads a newer one — same treatment `quarantined` and `forbidden`
    /// got, and for the same reason.
    #[serde(default)]
    pub known: HashMap<String, KnownFile>,
}

impl LocalSyncState {
    /// Load from `{meta}/sync/state.json` inside `workspace_path`.
    /// Returns a default empty state if the file doesn't exist.
    pub fn load(workspace_path: &str, team_id: &str) -> Result<Self, String> {
        let path = state_read_path(workspace_path);
        if !path.exists() {
            return Ok(Self::new(team_id));
        }
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("state: read {}: {e}", path.display()))?;
        let state: Self = serde_json::from_str(&raw)
            .map_err(|e| format!("state: parse {}: {e}", path.display()))?;
        if state.schema_version != SCHEMA_VERSION {
            return Err(format!(
                "state: unsupported schemaVersion {} (expected {})",
                state.schema_version, SCHEMA_VERSION
            ));
        }
        Ok(state)
    }

    /// Persist state to `{meta}/sync/state.json` (brand-canonical write path).
    pub fn save(&self, workspace_path: &str) -> Result<(), String> {
        let path = state_write_path(workspace_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("state: create dir {}: {e}", parent.display()))?;
        }
        let json =
            serde_json::to_string_pretty(self).map_err(|e| format!("state: serialize: {e}"))?;
        std::fs::write(&path, json).map_err(|e| format!("state: write {}: {e}", path.display()))?;
        Ok(())
    }

    /// Load OSS sync state for a team from the daemon global location
    /// `~/.amuxd/teams/<team_id>/sync/state.json`.
    pub fn load_at(team_id: &str) -> Result<Self, String> {
        let path = crate::config::global_team_store::global_sync_state_path(team_id);
        let default = || Self {
            schema_version: SCHEMA_VERSION,
            team_id: team_id.to_string(),
            last_server_seq: 0,
            last_sync_at: String::new(),
            files: HashMap::new(),
            quarantined: HashMap::new(),
            forbidden: HashMap::new(),
            last_reconcile_at: 0,
            known: HashMap::new(),
        };
        let body = match std::fs::read_to_string(&path) {
            Ok(body) => body,
            // Missing file (or unreadable) → fresh state, sync bootstraps normally.
            Err(_) => return Ok(default()),
        };
        match serde_json::from_str(&body) {
            Ok(state) => Ok(state),
            Err(e) => {
                // A torn/partial write (e.g. crash mid-save on the old non-atomic
                // path) used to fail every tick, bricking sync permanently.
                // Quarantine the corrupt file and recover with default state so
                // the next sync rebuilds it. Deterministic `.corrupt` suffix
                // (overwrite) avoids clock/random in this module.
                let corrupt = path.with_extension("json.corrupt");
                let _ = std::fs::rename(&path, &corrupt);
                tracing::warn!(
                    error = %e,
                    quarantined = %corrupt.display(),
                    "sync state.json failed to parse; quarantined and reset to default"
                );
                Ok(default())
            }
        }
    }

    /// Persist to the daemon global location. Writes atomically (temp sibling +
    /// rename) so a crash mid-write can never leave a torn `state.json` that
    /// bricks sync — the old file survives until the rename completes.
    pub fn save_at(&self, team_id: &str) -> Result<(), String> {
        let path = crate::config::global_team_store::global_sync_state_path(team_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir sync state: {e}"))?;
        }
        let body = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body).map_err(|e| format!("write sync state tmp: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("rename sync state: {e}"))
    }

    /// An empty state, for tests that need one without touching the disk.
    #[cfg(test)]
    pub fn new_for_test(team_id: &str) -> Self {
        Self::new(team_id)
    }

    fn new(team_id: &str) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            team_id: team_id.to_string(),
            last_server_seq: 0,
            last_sync_at: "".to_string(),
            files: HashMap::new(),
            quarantined: HashMap::new(),
            forbidden: HashMap::new(),
            last_reconcile_at: 0,
            known: HashMap::new(),
        }
    }

    /// Record (or re-record) a file the pull could not apply.
    pub fn quarantine(&mut self, path: &str, cipher_hash: &str, version: i32, reason: String) {
        let attempts = self
            .quarantined
            .get(path)
            .map(|q| q.attempts.saturating_add(1))
            .unwrap_or(1);
        self.quarantined.insert(
            path.to_string(),
            QuarantinedPull {
                cipher_hash: cipher_hash.to_string(),
                version,
                reason,
                attempts,
            },
        );
    }

    /// Insert or update a file entry after a successful download/upload.
    pub fn upsert(
        &mut self,
        path: &str,
        synced_version: i32,
        synced_cipher_hash: String,
        synced_plain_hash: String,
        local_plain_hash: String,
        mtime: u64,
        size: u64,
    ) {
        // Whatever went wrong with this path before, it just landed.
        self.quarantined.remove(path);
        self.files.insert(
            path.to_string(),
            FileState {
                synced_version,
                synced_cipher_hash,
                synced_plain_hash,
                local_plain_hash: local_plain_hash.clone(),
                mtime,
                size,
                dirty: false,
                deleted_local: false,
            },
        );
    }

    /// Record a manifest entry without fetching it.
    ///
    /// Refuses to touch a path that is already materialized: overwriting a real
    /// `files` entry with a `known` one would tell the engine the file is not on
    /// disk while it still is, and the very next scan would treat the local copy
    /// as an untracked addition.
    pub fn note_known(&mut self, path: &str, version: i32, cipher_hash: &str, size: u64) {
        if self.files.contains_key(path) {
            return;
        }
        self.known.insert(
            path.to_string(),
            KnownFile {
                version,
                cipher_hash: cipher_hash.to_string(),
                size,
            },
        );
    }

    /// Whether this path is listed but not present on disk.
    pub fn is_known_only(&self, path: &str) -> bool {
        !self.files.contains_key(path) && self.known.contains_key(path)
    }

    /// Forget a `known` entry — the file has just landed, or the server dropped it.
    ///
    /// The caller writes to `files` separately (via `upsert`); this only clears
    /// the other side. Keeping the two halves separate means neither map can be
    /// updated "half way" by a single helper that someone later changes.
    pub fn clear_known(&mut self, path: &str) {
        self.known.remove(path);
    }

    /// Give up the local copy of a file, keeping the knowledge that it exists.
    ///
    /// The inverse of a download, and the ONLY way a path leaves `files` without
    /// being deleted. Deliberately not routed through the tombstone path: this
    /// must never produce a `delete_batch` entry, or releasing local disk would
    /// delete the file for every member.
    ///
    /// Returns `false` — refusing — when the file has unpushed local edits.
    /// Releasing those throws away something the user wrote, which no amount of
    /// disk pressure justifies. The caller is expected to surface the refusal.
    pub fn release_local(&mut self, path: &str) -> bool {
        let Some(entry) = self.files.get(path) else {
            return false;
        };
        if entry.dirty || entry.deleted_local {
            return false;
        }
        let known = KnownFile {
            version: entry.synced_version,
            cipher_hash: entry.synced_cipher_hash.clone(),
            size: entry.size,
        };
        self.files.remove(path);
        self.known.insert(path.to_string(), known);
        true
    }

    /// Remember that the server refuses this path, so the push side stops
    /// offering it.
    ///
    /// Also clears `dirty`: a file we are never allowed to upload is not
    /// "pending upload", and leaving the flag set keeps it in every scan's
    /// changed set and in the user's error count forever.
    pub fn mark_forbidden(&mut self, path: &str, reason: &str, now_secs: u64) {
        self.quarantined.remove(path);
        self.forbidden.insert(
            path.to_string(),
            ForbiddenPath {
                last_tried_at: now_secs,
                reason: reason.to_string(),
            },
        );
        if let Some(f) = self.files.get_mut(path) {
            f.dirty = false;
        }
    }

    /// Whether the push side should skip this path right now.
    ///
    /// False once `FORBIDDEN_RETRY_SECS` have passed, which is what lets a
    /// later grant heal on its own without anyone being told the directory
    /// exists.
    pub fn is_forbidden_now(&self, path: &str, now_secs: u64) -> bool {
        match self.forbidden.get(path) {
            None => false,
            Some(f) => now_secs.saturating_sub(f.last_tried_at) < FORBIDDEN_RETRY_SECS,
        }
    }

    /// Drop the refusal — the server accepted this path again.
    pub fn clear_forbidden(&mut self, path: &str) {
        self.forbidden.remove(path);
    }

    /// Record a tombstone for a path that was deleted (locally pushed, or pulled
    /// from the server). The entry is RETAINED — set to the tombstone `version`
    /// with `deleted_local=true` — rather than removed, so a later re-create of the
    /// same path can CAS against the tombstone version. (Removing the entry made a
    /// re-add push with parentVersion=0, which conflicts against the tombstone
    /// forever and never resurrects the file.)
    pub fn mark_tombstoned(&mut self, path: &str, version: i32) {
        // A file that was quarantined and has since been deleted server-side
        // must stop being retried: its blob is gone, so every future attempt is
        // a guaranteed 404 and the count next to "cannot sync" would never
        // clear.
        self.quarantined.remove(path);
        if let Some(f) = self.files.get_mut(path) {
            f.synced_version = version;
            f.deleted_local = true;
            f.dirty = false;
        }
    }

    /// Advance a DIRTY file's `synced_version` to the server tombstone version
    /// while keeping `dirty = true` (and `deleted_local = false` — the file still
    /// exists locally with unpushed edits). Used on the pull path when the server
    /// deleted a path the user has locally modified: without this the entry keeps
    /// its stale pre-delete `synced_version`, so the next push sends
    /// `parentVersion = stale`, FC 409s forever, and every tick writes a new
    /// timestamped conflict sidecar (unbounded). CAS-ing against the tombstone
    /// version instead resurrects the file on the next push.
    pub fn advance_dirty_to_tombstone(&mut self, path: &str, version: i32) {
        if let Some(f) = self.files.get_mut(path) {
            if f.dirty {
                f.synced_version = version;
            }
        }
    }

    /// Update the timestamp of last successful sync (RFC 3339).
    pub fn touch_sync_at(&mut self) {
        self.last_sync_at = chrono_now_utc();
    }
}

fn state_read_path(workspace_path: &str) -> PathBuf {
    teamclu_runtime_env::resolve_workspace_meta_path_from_env(
        Path::new(workspace_path),
        Path::new("sync").join("state.json"),
    )
}

fn state_write_path(workspace_path: &str) -> PathBuf {
    teamclu_runtime_env::workspace_meta_write_path_from_env(
        Path::new(workspace_path),
        Path::new("sync").join("state.json"),
    )
}

fn chrono_now_utc() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_save_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let mut state = LocalSyncState::load(ws, "team-abc").unwrap();
        assert_eq!(state.schema_version, 1);
        assert_eq!(state.team_id, "team-abc");
        assert_eq!(state.last_server_seq, 0);

        state.upsert(
            "knowledge/foo.md",
            3,
            "cipherhash".into(),
            "plainhash".into(),
            "plainhash".into(),
            1748332800,
            1024,
        );
        state.last_server_seq = 42;
        state.save(ws).unwrap();

        let loaded = LocalSyncState::load(ws, "team-abc").unwrap();
        assert_eq!(loaded.last_server_seq, 42);
        let f = loaded.files.get("knowledge/foo.md").unwrap();
        assert_eq!(f.synced_version, 3);
        assert_eq!(f.synced_cipher_hash, "cipherhash");
        assert!(!f.dirty);
    }

    #[test]
    fn a_state_file_from_an_older_daemon_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".teamclu").join("sync").join("state.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // No `quarantined` key at all — written before the field existed.
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"teamId":"t","lastServerSeq":5,"lastSyncAt":"","files":{}}"#,
        )
        .unwrap();

        let state = LocalSyncState::load(dir.path().to_str().unwrap(), "t").unwrap();
        assert_eq!(state.last_server_seq, 5);
        assert!(state.quarantined.is_empty());
    }

    #[test]
    fn a_server_side_deletion_retires_a_quarantined_file() {
        let mut state = LocalSyncState::new("t");
        state.files.insert(
            "knowledge/gone.md".into(),
            FileState {
                synced_version: 1,
                synced_cipher_hash: "c".into(),
                synced_plain_hash: "p".into(),
                local_plain_hash: "p".into(),
                mtime: 0,
                size: 0,
                dirty: false,
                deleted_local: false,
            },
        );
        state.quarantine("knowledge/gone.md", "hash1", 1, "decrypt failed".into());

        state.mark_tombstoned("knowledge/gone.md", 2);

        assert!(
            state.quarantined.is_empty(),
            "there is nothing left to retry once the server dropped the file"
        );
    }

    #[test]
    fn quarantine_counts_attempts_and_clears_when_the_file_finally_lands() {
        let mut state = LocalSyncState::new("t");
        state.quarantine("knowledge/a.md", "hash1", 3, "decrypt failed".into());
        state.quarantine("knowledge/a.md", "hash1", 3, "decrypt failed".into());
        assert_eq!(state.quarantined["knowledge/a.md"].attempts, 2);
        assert_eq!(state.quarantined["knowledge/a.md"].version, 3);

        state.upsert(
            "knowledge/a.md",
            3,
            "hash1".into(),
            "plain".into(),
            "plain".into(),
            1,
            2,
        );
        assert!(
            state.quarantined.is_empty(),
            "a successful pull retires the quarantine entry"
        );
    }

    #[test]
    fn test_schema_version_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".teamclu").join("sync").join("state.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"schemaVersion":99,"teamId":"t","lastServerSeq":0,"lastSyncAt":"","files":{}}"#,
        )
        .unwrap();
        let result = LocalSyncState::load(dir.path().to_str().unwrap(), "t");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("schemaVersion"));
    }

    #[test]
    fn white_label_save_writes_brand_meta_and_load_reads_legacy() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("copilot361");

        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let legacy = dir.path().join(".teamclu/sync/state.json");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(
            &legacy,
            r#"{"schemaVersion":1,"teamId":"team-x","lastServerSeq":7,"lastSyncAt":"","files":{}}"#,
        )
        .unwrap();
        let loaded = LocalSyncState::load(ws, "team-x").unwrap();
        assert_eq!(loaded.last_server_seq, 7);

        let mut state = LocalSyncState::new("team-x");
        state.last_server_seq = 99;
        state.save(ws).unwrap();
        assert!(dir.path().join(".copilot361/sync/state.json").is_file());
        let reloaded = LocalSyncState::load(ws, "team-x").unwrap();
        assert_eq!(reloaded.last_server_seq, 99);
    }
}
