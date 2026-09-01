//! SyncEngine — `tick()` entry point implementing full pull → push cycle (spec §4.3).
//!
//! Design note (§4.3 fix #11): after overwriting a local file during PULL,
//! the state entry is updated with dirty=false. The high-water mark
//! `last_server_seq` is only advanced **after** the full cursor drain.

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use futures::StreamExt;

use super::{
    conflict::write_conflict_sidecar,
    crypto::sha256_hex,
    error::SyncError,
    fc_client::{
        BatchItemOutcome, CompleteResult, DeleteBatchItem, FcClient, ManifestItem, PrepareBatchItem,
    },
    ignore_rules::IgnoreRules,
    path_validator::{validate, validate_no_symlink_escape, ALLOWED_PREFIXES},
    scanner::{scan_workspace_with, ScannedFile},
    state::LocalSyncState,
    ProgressSink, SyncPhase,
};

/// Chunk size for batch FC calls — must not exceed the FC server cap
/// (`MAX_SYNC_BATCH`). The daemon auto-splits larger working sets into chunks.
const MAX_BATCH: usize = 200;

/// Stable node id stamped on prepare/delete so FC can set `created_by_node_id`
/// and (via top-level `nodeId` on complete/delete-batch) publish MQTT hints
/// with a filterable `originNodeId`. Peers drop echoes matching this value.
fn knowledge_created_by_node_id() -> Option<String> {
    Some(crate::device_id::daemon_device_id())
}

fn prepare_batch_item_for(
    path: &str,
    parent_version: i32,
    content_hash: &str,
    size: u64,
) -> PrepareBatchItem {
    PrepareBatchItem {
        path: path.to_string(),
        parent_version,
        content_hash: content_hash.to_string(),
        size,
        node_id: knowledge_created_by_node_id(),
    }
}

fn delete_batch_item_for(path: &str, parent_version: i32) -> DeleteBatchItem {
    DeleteBatchItem {
        path: path.to_string(),
        parent_version,
        node_id: knowledge_created_by_node_id(),
    }
}

/// Largest single file the sync will carry.
///
/// The ignore rules match on names, so they only stop what someone thought to
/// name. A 4 GB screen recording dropped into the knowledge dir has an entirely
/// ordinary name and no rule will ever match it — but the object store behind
/// this sync has single-digit GB free. This guard is the one that does not need
/// to have anticipated anything.
///
/// Same number the desktop uses to decide a workspace file is too big to open
/// (`MAX_WORKSPACE_FILE_BYTES`), so "too big to edit" and "too big to sync"
/// agree.
const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;

/// How many previously-unseen files one tick will push without being asked
/// twice.
///
/// This is the guard that actually catches "somebody dropped a repo in here":
/// it counts, it does not read names, so it fires before anyone has written a
/// rule — including for the build tool nobody on this team has heard of yet.
/// Editing 2000 documents by hand between two ticks does not happen; a
/// `git clone` lands ten times that in one second.
const MAX_NEW_FILES_PER_TICK: usize = 2000;

/// Most tombstones one tick may broadcast before it stops and asks.
///
/// The add-side guard above protects the team's cloud from one person's
/// mistake. This one protects **every member's disk** from it, which is the
/// more expensive direction: a tombstone is applied by everyone, and the file
/// is gone from all of their machines before anyone notices.
///
/// The engine infers "deleted locally" from `in state, absent from the scan`,
/// so anything that makes the scan come back short reads as a mass delete —
/// an external drive that did not mount, a directory moved out from under us,
/// a sync plugin mid-write, a content-root change that ran in the wrong order.
/// None of those are deletions, and all of them look exactly like one.
///
/// Deliberately far lower than the add-side limit. Deleting two hundred notes
/// in one sitting is already unusual enough to be worth one confirmation;
/// creating two thousand files is merely someone dropping a repo in.
const MAX_DELETES_PER_TICK: usize = 200;

/// Per-tick knobs a caller can set. A tick with `Default` values is the
/// autonomous one the timer runs.
#[derive(Debug, Clone, Copy, Default)]
pub struct TickOptions {
    /// Send a batch of new files that an earlier tick refused to send.
    ///
    /// Set only when a person has been shown the count and said yes — this is
    /// the acknowledgement, so defaulting it to `true` anywhere would quietly
    /// remove the guard.
    pub allow_bulk_add: bool,
    /// Broadcast a set of deletions an earlier tick refused to send.
    ///
    /// Same contract as [`TickOptions::allow_bulk_add`]: only ever set after a
    /// person has been shown the count and agreed. Defaulting it to `true`
    /// anywhere removes the guard, and this is the guard whose failure mode
    /// reaches other people's machines.
    pub allow_bulk_delete: bool,
}

/// Max concurrent direct-to-OSS blob transfers (PUT on push, GET on pull). OSS
/// presigned transfers bypass FC and are not rate-limited, but we still cap the
/// connection fan-out.
const BLOB_CONCURRENCY: usize = 16;

/// Summary returned by `tick()`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TickResult {
    pub pulled: u32,
    pub pushed: u32,
    pub conflicts: u32,
    /// Files the server listed but we could not fetch this tick.
    ///
    /// Previously this number had nowhere to go: a failed pull only produced a
    /// `warn!`, the tick still returned `Ok`, and the UI just saw a smaller
    /// `pulled`. Surfacing it is what makes the failure observable at all.
    pub failed: u32,
    /// Paths skipped for exceeding [`MAX_FILE_BYTES`].
    ///
    /// The tick still succeeds — one huge file is not a reason to stop syncing
    /// the notes around it — but this has to reach the UI. A silently skipped
    /// file is worse than a slow sync: the user believes it went up.
    pub oversize: Vec<String>,
    /// How many new files this tick refused to push, when
    /// [`MAX_NEW_FILES_PER_TICK`] was exceeded. `None` on a normal tick.
    ///
    /// Nothing was pushed in that case — not even the first
    /// [`MAX_NEW_FILES_PER_TICK`] of them. Half a source tree in the team's
    /// cloud is worse than none of it, and the user has to make one decision,
    /// not watch a partial upload.
    pub blocked_new_files: Option<u32>,
    /// How many deletions this tick refused to broadcast, when
    /// [`MAX_DELETES_PER_TICK`] was exceeded. `None` on a normal tick.
    ///
    /// Nothing was deleted in that case — not even the first
    /// [`MAX_DELETES_PER_TICK`]. A partially applied mass deletion is the worst
    /// of both: the files are gone for everyone AND the cause is harder to see.
    pub blocked_deletes: Option<u32>,
}

/// Run a full sync tick: PULL then PUSH (spec §4.3), reporting how far it has
/// got as it goes.
///
/// The totals are known before the work starts — the manifest walk produces the
/// pull list, the scan produces the push list — so every phase after `Checking`
/// reports a real denominator rather than a spinner.
pub async fn tick_with_progress(
    content_root: &str,
    team_id: &str,
    team_secret: Option<&str>,
    fc: &FcClient,
    progress: &ProgressSink,
    opts: TickOptions,
) -> Result<TickResult, SyncError> {
    // Knowledge content is pushed as plaintext, so a key is no longer required
    // to sync. It is still derived when the team has a secret, because blobs
    // written before that change are AES-GCM envelopes and are only readable
    // with it.
    let key: Option<[u8; 32]> = match team_secret {
        Some(secret) => Some(
            crate::team_shared_env::derive_key(secret)
                .map_err(|e| SyncError::Crypto(e.to_string()))?,
        ),
        None => None,
    };
    // content_root is now a parameter (the global team dir).
    let mut state = LocalSyncState::load_at(team_id).map_err(SyncError::State)?;

    // Built once per tick and threaded through scan, pull and tombstone. Reading
    // the rule files three times would also let them change mid-tick, and a tick
    // that ignores a path on the way in but not on the way out is exactly how
    // §4.6's delete-everything failure happens.
    let rules = IgnoreRules::load(std::path::Path::new(content_root));

    // Refresh the `dirty` flag from the working tree BEFORE PULL so the pull-phase
    // checks reflect the CURRENT tree, not the last-sync snapshot. Without this an
    // unsynced local edit (state still dirty=false) is silently overwritten by a
    // newer remote version with no conflict sidecar.
    //
    // IMPORTANT: only `dirty` is updated here — NOT mtime/size. Those stay at the
    // last-synced baseline that the PUSH-phase scan's cheap mtime+size check relies
    // on; mutating them here would make that scan treat an edited file as clean and
    // skip the upload.
    refresh_dirty(&mut state, content_root, &rules);

    // ── PULL ─────────────────────────────────────────────────────────────────
    // Paginate /sync/manifest fully before advancing last_server_seq.
    let mut cursor: Option<String> = None;
    let mut snapshot_seq: Option<i64> = None;
    let mut all_items: Vec<ManifestItem> = Vec::new();

    // Periodically ask for the WHOLE manifest rather than just what changed, so
    // access that was taken away becomes visible (see RECONCILE_INTERVAL_SECS).
    // Costs nothing extra in applied work: the pull loop skips every item whose
    // version it already holds.
    let reconciling = now_secs().saturating_sub(state.last_reconcile_at) >= RECONCILE_INTERVAL_SECS;
    let since_seq = if reconciling {
        0
    } else {
        state.last_server_seq
    };
    progress.report(SyncPhase::Checking, 0, 0);
    loop {
        // Retry transient failures (429 rate-limit / 503) in-call: a single
        // throttled manifest page must not fail the whole tick and surface as
        // an error to the desktop.
        let page =
            with_batch_retry(|| fc.manifest(team_id, since_seq, cursor.clone(), snapshot_seq))
                .await?;
        snapshot_seq.get_or_insert(page.snapshot_seq);
        all_items.extend(page.items);
        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }

    let mut pull_conflicts = 0u32;
    // Decide per item what needs downloading (and write conflict sidecars for
    // dirty-vs-newer files) here — this mutates `state`/disk and must stay
    // sequential. The actual blob downloads are then batched by `pull_phase`.
    let mut pull_items: Vec<PullItem> = Vec::new();

    for item in &all_items {
        // `.mcp/` and `_secrets/` moved to the Cloud API. A team synced before the
        // migration still has rows for them; skip rather than write them back to
        // disk, where they would shadow the cloud copy. Skipped before `validate`
        // so the two never have to agree about them.
        if super::path_validator::is_retired(&item.path) {
            continue;
        }
        // Conflict copies live under `.conflicts/` and must never be pulled —
        // even if a buggy older client somehow pushed one. `continue`, never
        // `return Err` (§4.5): rejecting a single manifest row used to abort
        // the whole apply.
        if super::conflict::is_under_conflicts_dir(&item.path) {
            continue;
        }
        // Ignored here means "this device does not want this file on disk" —
        // an older client, or one with looser rules, can still have pushed it.
        // `continue`, never `?`: the retired-prefix comment above records what
        // happens when a per-item rejection aborts the manifest apply, and this
        // would be the same failure with a different trigger.
        if rules.is_ignored_with_ancestors(&item.path) {
            continue;
        }
        // Spec §4.3: path-validate all manifest items (defense vs. malicious remote).
        validate(&item.path).map_err(SyncError::from)?;

        let abs_path = Path::new(content_root).join(&item.path);

        if let Some(parent) = abs_path.parent() {
            validate_no_symlink_escape(Path::new(content_root), &abs_path)
                .map_err(SyncError::from)?;
            let _ = parent; // ensure compiler doesn't strip the validation
        }

        // The server is offering this path again, so whatever refusal we
        // recorded is stale — a grant landed. Clearing here (rather than waiting
        // for the 24h retry) is what makes a new grant take effect on the very
        // next tick.
        state.clear_forbidden(&item.path);

        let local = state.files.get(&item.path).cloned();

        if item.deleted {
            // Server says file is deleted.
            if let Some(ref ls) = local {
                if !ls.dirty && !ls.deleted_local {
                    // Local is clean and not already tombstoned — remove it and
                    // record the tombstone version (so a later re-create CAS-es
                    // correctly). Skipping when already deleted_local keeps this
                    // idempotent and avoids removing a file re-created locally.
                    let _ = tokio::fs::remove_file(&abs_path).await;
                    prune_empty_parents(Path::new(content_root), &item.path).await;
                    state.mark_tombstoned(&item.path, item.version);
                } else if ls.dirty {
                    // Server deleted the path but the local copy has unpushed
                    // edits: keep the file (user work survives), but advance the
                    // entry's synced_version to the tombstone so the next push
                    // CAS-es against the tombstone and RESURRECTS the file,
                    // instead of sending the stale pre-delete parentVersion which
                    // 409s forever (writing an unbounded stream of conflict
                    // sidecars). dirty stays true so prepare_upload re-uploads it.
                    state.advance_dirty_to_tombstone(&item.path, item.version);
                }
                // If dirty: leave local file, do NOT delete. User-local edits survive.
            }
            // Not in local state → nothing to do.
            continue;
        }

        let remote_cipher_hash = match &item.content_hash {
            Some(h) => h.clone(),
            None => continue, // shouldn't happen for non-deleted
        };

        let needs_download = match &local {
            None => true,
            Some(ls) => item.version > ls.synced_version,
        };

        if !needs_download {
            continue;
        }

        // If local file is dirty and remote has a newer version → conflict.
        if let Some(ref ls) = local {
            if ls.dirty && item.version > ls.synced_version {
                // Write local content as a conflict sidecar before overwriting.
                if let Ok(local_bytes) = std::fs::read(&abs_path) {
                    let _ = write_conflict_sidecar(
                        Path::new(content_root),
                        &item.path,
                        &local_bytes,
                        &ls.synced_cipher_hash,
                    )
                    .await;
                    pull_conflicts += 1;
                }
            }
        }

        pull_items.push(PullItem {
            path: item.path.clone(),
            cipher_hash: remote_cipher_hash,
            version: item.version,
        });
    }

    let retried = state.quarantined.len();
    let pull_items = with_quarantined_retries(pull_items, &state);
    if retried > 0 {
        tracing::info!(
            team_id,
            count = retried,
            "retrying quarantined pulls before this tick's manifest items"
        );
    }

    // Batched download (with per-file fallback on a pre-batch FC).
    let expected_pulls = pull_items.len();
    progress.report(SyncPhase::Pulling, 0, expected_pulls as u32);
    let pulled = pull_phase(
        content_root,
        key.as_ref(),
        fc,
        &mut state,
        pull_items,
        progress,
    )
    .await;
    let pull_failures = expected_pulls.saturating_sub(pulled as usize);

    state.last_server_seq = next_high_water(state.last_server_seq, snapshot_seq);

    // Revocation is only observable against a COMPLETE manifest — see
    // RECONCILE_INTERVAL_SECS and `apply_revocations`. Running this on an
    // incremental page would read "not in this page" as "no longer allowed" and
    // wipe the vault.
    //
    // Placed after the pull and before the push on purpose: `locally_deleted_paths`
    // runs in the push phase, and it must not see a half-applied revocation.
    if reconciling {
        let manifest_paths: std::collections::HashSet<String> =
            all_items.iter().map(|i| i.path.clone()).collect();
        apply_revocations(content_root, &mut state, &manifest_paths, &rules);
        state.last_reconcile_at = now_secs();
    }
    if !state.quarantined.is_empty() {
        tracing::warn!(
            team_id,
            quarantined = state.quarantined.len(),
            cursor = state.last_server_seq,
            "some files could not be applied; the cursor moved on and they are retried every tick"
        );
    }

    // ── PUSH ─────────────────────────────────────────────────────────────────
    // Re-scan (the tree may have changed during PULL) to pick up current
    // mtime/size/dirty flags.
    let scan = apply_scan(&mut state, content_root, &rules);

    let dirty_paths: Vec<String> = state
        .files
        .iter()
        .filter(|(_, f)| f.dirty && !f.deleted_local)
        .map(|(p, _)| p.clone())
        .collect();

    // Also include new files from scan (not yet in state).
    let mut extra_dirty: Vec<String> = scan
        .iter()
        .filter(|s| s.dirty && !state.files.contains_key(&s.rel_path))
        .map(|s| s.rel_path.clone())
        .collect();

    // Re-created files: a path we previously tombstoned (deleted_local) that is
    // back on disk. It must be pushed to resurrect it server-side — push_phase
    // CAS-es against the stored tombstone version. Included regardless of the cheap
    // dirty check, since an identical re-create wouldn't trip mtime+size.
    let present: std::collections::HashSet<&str> =
        scan.iter().map(|s| s.rel_path.as_str()).collect();
    let mut readd_paths: Vec<String> = state
        .files
        .iter()
        .filter(|(p, f)| f.deleted_local && present.contains(p.as_str()))
        .map(|(p, _)| p.clone())
        .collect();

    // The two name-blind guards live in `plan_push`; see its doc for why they
    // count and measure instead of matching names.
    let sizes: std::collections::HashMap<&str, u64> =
        scan.iter().map(|s| (s.rel_path.as_str(), s.size)).collect();
    let PushPlan {
        to_push: mut all_dirty,
        oversize,
        blocked_new_files,
    } = plan_push(
        dirty_paths,
        extra_dirty,
        readd_paths,
        &sizes,
        opts.allow_bulk_add,
    );

    // Drop paths the server has already told us are restricted. Filtered AFTER
    // plan_push so the bulk-add guard still counts what the user actually
    // created — a person who drops a repo into a restricted directory should be
    // asked the same question as anyone else, not have the count quietly
    // shrunk.
    //
    // The entry expires (`is_forbidden_now`), which is what lets a later grant
    // heal without anyone being notified that the directory exists.
    {
        let now = now_secs();
        let before = all_dirty.len();
        all_dirty.retain(|p| !state.is_forbidden_now(p, now));
        let skipped = before - all_dirty.len();
        if skipped > 0 {
            tracing::debug!(
                team_id,
                skipped,
                "push: skipping paths the server restricts"
            );
        }
    }
    if let Some(count) = blocked_new_files {
        tracing::warn!(
            team_id,
            new_files = count,
            limit = MAX_NEW_FILES_PER_TICK,
            "push held back: too many new files at once, waiting for confirmation"
        );
    }
    if !oversize.is_empty() {
        tracing::warn!(
            team_id,
            count = oversize.len(),
            limit_bytes = MAX_FILE_BYTES,
            "skipping files above the per-file size limit"
        );
    }

    // Batched PUSH (upload) — collect → prepare-batch → concurrent blob PUT →
    // complete-batch → per-item apply. Falls back to per-file on a pre-batch FC.
    progress.report(SyncPhase::Pushing, 0, all_dirty.len() as u32);
    let push_stats = push_phase(
        content_root,
        team_id,
        key.as_ref(),
        fc,
        &mut state,
        all_dirty,
        progress,
    )
    .await;

    // Propagate local deletions: a previously-synced file that is absent from the
    // current scan was deleted locally → emit a server-side tombstone so other
    // nodes pull the deletion. Each tombstone is a parentVersion CAS.
    let dels = locally_deleted_paths(&state, &scan, &rules);

    // A tombstone reaches every member's disk, so an unexpected pile of them is
    // stopped and reported rather than sent. `locally_deleted_paths` cannot tell
    // a real deletion from a scan that came back short — an unmounted drive, a
    // moved directory, a content root that changed under us all read the same —
    // and by the time the difference is visible the files are gone everywhere.
    //
    // All or nothing, matching the add-side guard: a half-applied mass deletion
    // is the worst outcome, because the files are gone AND the cause is harder
    // to see.
    let (dels, blocked_deletes) = apply_delete_guard(dels, opts.allow_bulk_delete);
    if let Some(count) = blocked_deletes {
        tracing::warn!(
            team_id,
            deletions = count,
            limit = MAX_DELETES_PER_TICK,
            "push held back: refusing to broadcast this many deletions without confirmation"
        );
    }

    progress.report(SyncPhase::Deleting, 0, dels.len() as u32);
    let del_stats = delete_phase(content_root, team_id, fc, &mut state, dels).await;

    let pushed = push_stats.pushed + del_stats.pushed;
    let push_conflicts = push_stats.conflicts + del_stats.conflicts;
    // Transient (rate-limit / 503) failures that survived in-call retries. We leave
    // such files dirty (no upsert) so they retry next tick, and surface the
    // condition via the returned error rather than silently dropping the change.
    let deferred = push_stats.deferred + del_stats.deferred;
    let last_transient = push_stats.last_transient.or(del_stats.last_transient);

    state.touch_sync_at();
    state.save_at(team_id).map_err(SyncError::State)?;

    // Surface persistent rate-limiting rather than silently dropping changes: the
    // deferred files stay dirty and will retry on the next tick. The message keeps
    // the underlying "429/Too Many Requests" text so callers can detect+back off.
    if deferred > 0 {
        let detail = last_transient
            .map(|e| e.to_string())
            .unwrap_or_else(|| "rate limited".to_string());
        return Err(SyncError::Network(format!(
            "{deferred} operation(s) deferred (pulled={pulled} pushed={pushed}); {detail}"
        )));
    }

    let conflict_count = pull_conflicts + push_conflicts;

    let result = TickResult {
        pulled,
        pushed,
        conflicts: conflict_count,
        // What is STUCK, not what missed this tick: a quarantined file stays
        // counted until it finally lands, which is the number a person needs to
        // see. `pull_failures` is only interesting to the log line above.
        failed: state.quarantined.len() as u32,
        oversize,
        blocked_new_files,
        blocked_deletes,
    };
    let _ = pull_failures;

    tracing::info!(
        team_id,
        pulled = result.pulled,
        pushed = result.pushed,
        conflicts = result.conflicts,
        failed = result.failed,
        "oss sync tick complete"
    );

    Ok(result)
}

// ── Batch phase plumbing ───────────────────────────────────────────────────────

/// A blob this device could not turn into a file on disk.
struct FailedPull {
    path: String,
    cipher_hash: String,
    version: i32,
    error: SyncError,
}

/// [`crypto::decode_blob`] in this module's error type. A blob it cannot open is
/// a quarantine entry, not a reason to wedge the whole sync.
fn decode_pulled_blob(blob: Vec<u8>, key: Option<&[u8; 32]>) -> Result<Vec<u8>, SyncError> {
    super::crypto::decode_blob(blob, key).map_err(SyncError::Crypto)
}

/// Reports one unit of transfer progress when it goes out of scope.
///
/// A transfer future can leave through `?` at four different awaits; a guard is
/// the only way to count all of them without a report at every exit. The bar
/// tracks work ATTEMPTED, so a partial pull settles at 10/10 rather than
/// stopping at 8/10 and looking hung.
struct ReportOnDrop<'a> {
    progress: &'a ProgressSink,
    phase: SyncPhase,
    counter: Arc<AtomicU32>,
    total: u32,
}

impl Drop for ReportOnDrop<'_> {
    fn drop(&mut self) {
        let done = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        self.progress.report(self.phase, done, self.total);
    }
}

/// A manifest item that needs its blob downloaded (decided in the PULL pre-loop).
struct PullItem {
    path: String,
    cipher_hash: String,
    version: i32,
}

/// Front half of an upload — read + hash, with no network. Computed
/// before the prepare/complete batch round-trips so the blob is ready to PUT.
struct PreparedUpload {
    path: String,
    /// sha256 of the plaintext (what local dirty-detection compares against).
    plain_hash: String,
    /// plaintext bytes uploaded to OSS (knowledge blobs are not encrypted).
    blob: Vec<u8>,
    /// sha256 of `blob` — the content hash the FC CAS keys on.
    cipher_hash: String,
    parent_version: i32,
    /// blob length — the `size` the FC HEAD-check verifies on the OSS object.
    size: u64,
}

/// Result of one concurrent PULL transfer, applied to `state` after the join.
struct WriteResult {
    path: String,
    version: i32,
    cipher_hash: String,
    plain_hash: String,
    mtime: u64,
    size: u64,
}

/// Per-phase tallies, merged into the tick summary.
#[derive(Default)]
struct PhaseStats {
    pushed: u32,
    conflicts: u32,
    deferred: u32,
    last_transient: Option<SyncError>,
}

/// Retry a whole-batch FC call on transient (rate-limit / 503) errors, reusing
/// the per-file backoff schedule. `BatchUnsupported` (404) is NOT retried — it is
/// terminal and signals the caller to fall back to the per-file path.
async fn with_batch_retry<T, F, Fut>(mut f: F) -> Result<T, SyncError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, SyncError>>,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Err(e) if is_transient(&e) && attempt < MAX_TRANSIENT_RETRIES => {
                attempt += 1;
                backoff_sleep(attempt).await;
            }
            other => return other,
        }
    }
}

/// Classify a per-item batch error: transient (429/503/timeout) → defer for the
/// next tick; anything else → log and drop (the file stays dirty and retries).
/// Unix seconds. Only used for the forbidden-path retry clock, which is a
/// once-a-day decision, so a clock that jumps is not a problem worth solving.
/// Remove local copies of files this device may no longer have.
///
/// # The ordering here is load-bearing
///
/// The engine decides "the user deleted this file" from `in state, absent from
/// the scan` (`locally_deleted_paths`). Deleting a revoked file from disk while
/// its state entry survives is indistinguishable from that, so the very next
/// push would tombstone it — and a tombstone is team-wide. **Deleting one
/// person's revoked copies would delete the directory off every teammate who
/// still has access.**
///
/// So the state entry is removed FIRST, and the entry is removed rather than
/// tombstoned: a path with no entry can never become a tombstone candidate,
/// which is a stronger guarantee than relying on a filter. `mark_forbidden`
/// comes before both so the push side skips the path even if this returns early.
///
/// Do not reorder these three steps. Do not "simplify" this by reusing the
/// tombstone path.
///
/// # Why only after a full drain
///
/// `manifest_paths` must be the caller's ENTIRE visible manifest, not an
/// incremental page. An incremental query returns only what changed, so almost
/// every path would look absent and this would delete the whole vault.
fn apply_revocations(
    content_root: &str,
    state: &mut LocalSyncState,
    manifest_paths: &std::collections::HashSet<String>,
    rules: &IgnoreRules,
) -> Vec<String> {
    let revoked: Vec<String> = state
        .files
        .iter()
        .filter(|(path, f)| {
            // Never synced, or already gone locally — nothing was distributed.
            f.synced_version > 0
                && !f.deleted_local
                && !manifest_paths.contains(path.as_str())
                // Paths the pull loop skips by design never appear in the
                // manifest set, and treating them as revoked would delete them.
                && !super::path_validator::is_retired(path)
                && !super::conflict::is_under_conflicts_dir(path)
                && !rules.is_ignored_with_ancestors(path)
        })
        .map(|(path, _)| path.clone())
        .collect();

    for path in &revoked {
        // 1. Stop offering it. Done first so an early return below still leaves
        //    the push side quiet.
        state.mark_forbidden(path, "no longer accessible", now_secs());
        // 2. Forget it, BEFORE touching the disk. See the ordering note above.
        state.files.remove(path);
        // 3. Only now remove the bytes.
        let abs = Path::new(content_root).join(path);
        let _ = std::fs::remove_file(&abs);
    }
    if !revoked.is_empty() {
        // Count only — naming the paths would write a restricted directory's
        // contents into the log of a machine that is no longer allowed to see it.
        tracing::info!(
            count = revoked.len(),
            "removed local copies of files this device no longer has access to"
        );
    }
    revoked
}

/// How often to drain the whole manifest instead of just the changes.
///
/// This is the only way a device learns it has LOST access to a directory: the
/// rows stop being returned rather than arriving marked as gone, which an
/// incremental `afterSeq` query cannot distinguish from "nothing changed".
///
/// Half an hour is a deliberate trade. Revocation cannot recall copies that were
/// already taken (see the design's §0), so shortening this window buys very
/// little real protection, while a full drain on every tick would make the
/// manifest query proportional to the whole knowledge base forever.
const RECONCILE_INTERVAL_SECS: u64 = 30 * 60;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The server refuses this path: the team restricted the directory and this
/// device's actor is not granted it.
///
/// Recorded, not counted. It is not a failure the user can act on and not one
/// that clears by retrying, so it must not land in `stats` — a permanent red
/// count next to a directory somebody deliberately does not have access to is
/// noise, and worse, it hints at the directory's existence.
///
/// Logged at debug for the same reason: `warn` would put a restricted path in
/// the log of a machine whose owner is not supposed to know about it.
fn record_forbidden(state: &mut LocalSyncState, label: &str, path: &str, message: &str) {
    tracing::debug!("[oss_sync] {label} {path}: not accessible; will not retry today");
    state.mark_forbidden(path, message, now_secs());
}

fn record_item_error(stats: &mut PhaseStats, label: &str, path: &str, status: u16, message: &str) {
    let e = SyncError::Internal(format!("FC item HTTP {status}: {message}"));
    if is_transient(&e) {
        stats.deferred += 1;
        stats.last_transient = Some(e);
    } else {
        tracing::warn!("[oss_sync] {label} {path} HTTP {status}: {message}");
    }
}

/// Encrypt a blob for the OSS upload path, compressing (v2) when the gate is on.
/// Read + hash one local file in preparation for upload (no network).
///
/// The bytes go up as they are on disk. Knowledge content used to be wrapped in
/// an AES-GCM envelope keyed by the team secret, which bought nothing — chat
/// messages, skill packages and MCP config all live server-side in the clear —
/// while a secret typed differently by two members meant one of them could
/// never read the other's documents, silently and permanently.
///
/// `cipher_hash` keeps its name: on the wire it is just "the hash of the blob",
/// which for a plaintext blob is the hash of the plaintext.
fn prepare_upload(
    content_root: &str,
    rel_path: &str,
    state: &LocalSyncState,
) -> Result<PreparedUpload, SyncError> {
    let abs_path = Path::new(content_root).join(rel_path);
    let blob = std::fs::read(&abs_path).map_err(|e| SyncError::Io(e.to_string()))?;
    let plain_hash = sha256_hex(&blob);
    let cipher_hash = plain_hash.clone();
    let parent_version = state
        .files
        .get(rel_path)
        .map(|f| f.synced_version)
        .unwrap_or(0);
    let size = blob.len() as u64;
    Ok(PreparedUpload {
        path: rel_path.to_string(),
        plain_hash,
        blob,
        cipher_hash,
        parent_version,
        size,
    })
}

/// Batched PULL: sign N GET URLs in one FC round-trip, then fetch + decrypt +
/// write blobs concurrently straight from OSS. Returns the number pulled.
/// Put everything the last ticks could not apply back at the front of this
/// tick's pull list.
///
/// This is what makes moving the cursor past a bad file safe. The manifest is
/// queried by `afterSeq`, so once the cursor passes a file the server never
/// lists it again — without this list, "skip the file that failed" would mean
/// "lose the file forever". Sorted for a deterministic order, and files this
/// tick's manifest already offers are left to it rather than fetched twice.
fn with_quarantined_retries(items: Vec<PullItem>, state: &LocalSyncState) -> Vec<PullItem> {
    if state.quarantined.is_empty() {
        return items;
    }
    let already_listed: std::collections::HashSet<&str> =
        items.iter().map(|i| i.path.as_str()).collect();
    let mut retries: Vec<PullItem> = state
        .quarantined
        .iter()
        .filter(|(path, _)| !already_listed.contains(path.as_str()))
        .map(|(path, q)| PullItem {
            path: path.clone(),
            cipher_hash: q.cipher_hash.clone(),
            version: q.version,
        })
        .collect();
    retries.sort_by(|a, b| a.path.cmp(&b.path));
    retries.extend(items);
    retries
}

/// Where the sync cursor should sit after a pull: at the snapshot the manifest
/// reported, whenever it reported one.
///
/// This used to hold the cursor back whenever ANY file failed to land, so that
/// the next manifest request would list it again. The cost was catastrophic and
/// silent: one undecodable blob — a file encrypted with a key this device does
/// not have — froze the cursor forever, and every document created after it
/// stopped arriving for that member, with no error anywhere (the tick returns
/// `Ok`, and only a `warn!` recorded it).
///
/// The retry now lives in `state.quarantined` instead, which is re-fetched by
/// path on every tick. That keeps the "never lose a file" property — dropping
/// the file outright would lose it, since the manifest is queried by
/// `afterSeq` — without letting one bad file block everyone else's work.
fn next_high_water(current: i64, snapshot_seq: Option<i64>) -> i64 {
    match snapshot_seq {
        Some(seq) => seq,
        None => current,
    }
}

async fn pull_phase(
    content_root: &str,
    key: Option<&[u8; 32]>,
    fc: &FcClient,
    state: &mut LocalSyncState,
    items: Vec<PullItem>,
    progress: &ProgressSink,
) -> u32 {
    if items.is_empty() {
        return 0;
    }
    let team_id = state.team_id.clone();
    let key_copy = key.copied();
    let mut pulled = 0u32;
    let total = items.len() as u32;
    // Counts every file the transfer loop finishes, including the ones that
    // fail: the bar tracks work done, not work that succeeded, or it stalls at
    // 8/10 forever on a partial pull.
    let transferred = Arc::new(AtomicU32::new(0));

    for chunk in items.chunks(MAX_BATCH) {
        let hashes: Vec<String> = chunk.iter().map(|i| i.cipher_hash.clone()).collect();
        let outcomes = match with_batch_retry(|| fc.download_batch(&team_id, &hashes)).await {
            Ok(o) => o,
            Err(SyncError::BatchUnsupported) => {
                // Per-file fallback (pre-batch FC).
                for it in chunk {
                    match download_and_write(
                        content_root,
                        &it.path,
                        &it.cipher_hash,
                        it.version,
                        key,
                        fc,
                        state,
                    )
                    .await
                    {
                        Ok(_) => pulled += 1,
                        Err(e) => {
                            tracing::warn!("[oss_sync] pull {}: {e}", it.path);
                            state.quarantine(&it.path, &it.cipher_hash, it.version, e.to_string());
                        }
                    }
                    progress.report(
                        SyncPhase::Pulling,
                        transferred.fetch_add(1, Ordering::Relaxed) + 1,
                        total,
                    );
                }
                continue;
            }
            Err(e) => {
                tracing::warn!("[oss_sync] download-batch: {e}");
                continue;
            }
        };

        // Collect signed targets, then fetch+decrypt+write concurrently. Downloads
        // never CAS-conflict; a per-item error just skips that file.
        let mut targets: Vec<(String, String, i32, String)> = Vec::new();
        for (it, oc) in chunk.iter().zip(outcomes.into_iter()) {
            match oc {
                BatchItemOutcome::Ok(dl) => targets.push((
                    it.path.clone(),
                    it.cipher_hash.clone(),
                    it.version,
                    dl.download_url,
                )),
                BatchItemOutcome::Conflict { .. } => {}
                // Quarantining would be wrong here: quarantine means "retry
                // every tick", and this blob will not become available by
                // asking again.
                BatchItemOutcome::Forbidden { message } => {
                    record_forbidden(state, "download", &it.path, &message);
                }
                BatchItemOutcome::Err { status, message } => {
                    tracing::warn!("[oss_sync] download {} HTTP {status}: {message}", it.path);
                    state.quarantine(
                        &it.path,
                        &it.cipher_hash,
                        it.version,
                        format!("download HTTP {status}: {message}"),
                    );
                }
            }
        }

        let writes: Vec<Result<WriteResult, FailedPull>> = futures::stream::iter(
            targets
                .into_iter()
                .map(|(path, cipher_hash, version, url)| {
                    let transferred = transferred.clone();
                    let team_id = team_id.clone();
                    async move {
                        let _guard = ReportOnDrop {
                            progress,
                            phase: SyncPhase::Pulling,
                            counter: transferred,
                            total,
                        };
                        // Failures carry the path/hash/version so the caller can
                        // quarantine THIS file rather than stalling everyone.
                        let fail = |e: SyncError| FailedPull {
                            path: path.clone(),
                            cipher_hash: cipher_hash.clone(),
                            version,
                            error: e,
                        };
                        let blob = fc.get_blob(&url, &cipher_hash).await.map_err(&fail)?;
                        let plaintext =
                            decode_pulled_blob(blob, key_copy.as_ref()).map_err(&fail)?;
                        let abs = Path::new(content_root).join(&path);
                        // MUST precede create_dir_all / write: inotify can deliver
                        // Local before this task resumes after an await.
                        crate::sync::watch::record_pull_write(&team_id, &path);
                        if let Some(parent) = abs.parent() {
                            tokio::fs::create_dir_all(parent)
                                .await
                                .map_err(|e| fail(SyncError::Io(e.to_string())))?;
                        }
                        tokio::fs::write(&abs, &plaintext)
                            .await
                            .map_err(|e| fail(SyncError::Io(e.to_string())))?;
                        let meta = std::fs::metadata(&abs)
                            .map_err(|e| fail(SyncError::Io(e.to_string())))?;
                        let mtime = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        let size = meta.len();
                        let plain_hash = sha256_hex(&plaintext);
                        Ok(WriteResult {
                            path,
                            version,
                            cipher_hash,
                            plain_hash,
                            mtime,
                            size,
                        })
                    }
                }),
        )
        .buffer_unordered(BLOB_CONCURRENCY)
        .collect()
        .await;

        // Apply upserts sequentially (needs &mut state).
        for w in writes {
            match w {
                Ok(w) => {
                    state.upsert(
                        &w.path,
                        w.version,
                        w.cipher_hash,
                        w.plain_hash.clone(),
                        w.plain_hash,
                        w.mtime,
                        w.size,
                    );
                    pulled += 1;
                }
                Err(f) => {
                    tracing::warn!("[oss_sync] pull {}: {}", f.path, f.error);
                    state.quarantine(&f.path, &f.cipher_hash, f.version, f.error.to_string());
                }
            }
        }
    }
    pulled
}

/// Batched PUSH: hash locally → prepare-batch → concurrent blob PUT →
/// complete-batch → per-item apply. Per-file fallback on a pre-batch FC.
async fn push_phase(
    content_root: &str,
    team_id: &str,
    // `key` is only reachable through the conflict path, which pulls the remote
    // version that won — uploads themselves no longer encrypt anything.
    key: Option<&[u8; 32]>,
    fc: &FcClient,
    state: &mut LocalSyncState,
    paths: Vec<String>,
    progress: &ProgressSink,
) -> PhaseStats {
    let mut stats = PhaseStats::default();
    if paths.is_empty() {
        return stats;
    }
    let total = paths.len() as u32;
    // The blob PUT is where a push spends its time, so that is what the bar
    // follows. Items whose blob is already in OSS never PUT and are counted as
    // they are queued for completion instead.
    let uploaded = Arc::new(AtomicU32::new(0));

    for chunk in paths.chunks(MAX_BATCH) {
        // Stage 0: read + hash. Unreadable files are skipped (stay dirty).
        let mut prepared: Vec<PreparedUpload> = Vec::new();
        for p in chunk {
            match prepare_upload(content_root, p, state) {
                Ok(pu) => prepared.push(pu),
                Err(e) => tracing::warn!("[oss_sync] prepare {p}: {e}"),
            }
        }
        if prepared.is_empty() {
            continue;
        }

        // Stage 1: prepare-batch (session + presigned PUT per item).
        let items: Vec<PrepareBatchItem> = prepared
            .iter()
            .map(|pu| {
                prepare_batch_item_for(&pu.path, pu.parent_version, &pu.cipher_hash, pu.size)
            })
            .collect();

        let prep_outcomes = match with_batch_retry(|| fc.upload_prepare_batch(team_id, &items))
            .await
        {
            Ok(o) => o,
            Err(SyncError::BatchUnsupported) => {
                for p in chunk {
                    apply_push_per_file(content_root, p, team_id, key, fc, state, &mut stats).await;
                    progress.report(
                        SyncPhase::Pushing,
                        uploaded.fetch_add(1, Ordering::Relaxed) + 1,
                        total,
                    );
                }
                continue;
            }
            Err(e) => {
                if is_transient(&e) {
                    stats.deferred += prepared.len() as u32;
                    stats.last_transient = Some(e);
                } else {
                    tracing::warn!("[oss_sync] prepare-batch: {e}");
                }
                continue;
            }
        };

        // Stage 2: PUT blobs concurrently for items that prepared OK and require
        // upload. Items whose blob already exists in OSS (requires_upload=false)
        // are immediately ready to complete. Prepare never CAS-conflicts.
        struct Ready {
            idx: usize,
            session_id: String,
        }
        let mut ready: Vec<Ready> = Vec::new();
        let mut put_futs = Vec::new();
        for (idx, (pu, oc)) in prepared.iter().zip(prep_outcomes.into_iter()).enumerate() {
            match oc {
                BatchItemOutcome::Ok(pr) => {
                    if pr.requires_upload {
                        match pr.presigned_put {
                            Some(url) => {
                                let blob = pu.blob.clone();
                                let sess = pr.upload_session_id;
                                let uploaded = uploaded.clone();
                                put_futs.push(async move {
                                    let r = fc.put_blob(&url, blob).await;
                                    progress.report(
                                        SyncPhase::Pushing,
                                        uploaded.fetch_add(1, Ordering::Relaxed) + 1,
                                        total,
                                    );
                                    (idx, sess, r)
                                });
                            }
                            None => tracing::warn!(
                                "[oss_sync] prepare {} requires upload but no presigned URL",
                                pu.path
                            ),
                        }
                    } else {
                        ready.push(Ready {
                            idx,
                            session_id: pr.upload_session_id,
                        });
                        progress.report(
                            SyncPhase::Pushing,
                            uploaded.fetch_add(1, Ordering::Relaxed) + 1,
                            total,
                        );
                    }
                }
                BatchItemOutcome::Conflict { .. } => { /* prepare does not CAS */ }
                BatchItemOutcome::Forbidden { message } => {
                    record_forbidden(state, "prepare", &pu.path, &message)
                }
                BatchItemOutcome::Err { status, message } => {
                    record_item_error(&mut stats, "prepare", &pu.path, status, &message)
                }
            }
        }

        let put_results: Vec<(usize, String, Result<(), SyncError>)> =
            futures::stream::iter(put_futs)
                .buffer_unordered(BLOB_CONCURRENCY)
                .collect()
                .await;
        for (idx, sess, r) in put_results {
            match r {
                Ok(()) => ready.push(Ready {
                    idx,
                    session_id: sess,
                }),
                Err(e) => {
                    if is_transient(&e) {
                        stats.deferred += 1;
                        stats.last_transient = Some(e);
                    } else {
                        tracing::warn!("[oss_sync] put {}: {e}", prepared[idx].path);
                    }
                }
            }
        }

        // Stage 3: complete-batch (CAS) for everything whose blob is in place.
        if ready.is_empty() {
            continue;
        }
        let session_ids: Vec<String> = ready.iter().map(|r| r.session_id.clone()).collect();
        let node_id = knowledge_created_by_node_id();
        let comp_outcomes = match with_batch_retry(|| {
            fc.upload_complete_batch(team_id, &session_ids, node_id.as_deref())
        })
        .await
        {
            Ok(o) => o,
            Err(SyncError::BatchUnsupported) => {
                // prepare-batch worked but complete-batch 404 — vanishingly
                // unlikely, but degrade per-item rather than lose the uploads.
                for r in &ready {
                    let pu = &prepared[r.idx];
                    match fc
                        .upload_complete(team_id, &r.session_id, node_id.as_deref())
                        .await
                    {
                        Ok(c) => finalize_upload(content_root, pu, c, state, &mut stats),
                        Err(SyncError::Conflict {
                            remote_version,
                            remote_cipher_hash,
                        }) => {
                            handle_push_conflict(
                                content_root,
                                &pu.path,
                                remote_version,
                                remote_cipher_hash,
                                key,
                                fc,
                                state,
                                &mut stats,
                            )
                            .await
                        }
                        Err(e) => {
                            if is_transient(&e) {
                                stats.deferred += 1;
                                stats.last_transient = Some(e);
                            } else {
                                tracing::warn!("[oss_sync] complete {}: {e}", pu.path);
                            }
                        }
                    }
                }
                continue;
            }
            Err(e) => {
                if is_transient(&e) {
                    stats.deferred += ready.len() as u32;
                    stats.last_transient = Some(e);
                } else {
                    tracing::warn!("[oss_sync] complete-batch: {e}");
                }
                continue;
            }
        };

        for (r, oc) in ready.iter().zip(comp_outcomes.into_iter()) {
            let pu = &prepared[r.idx];
            match oc {
                BatchItemOutcome::Ok(c) => finalize_upload(content_root, pu, c, state, &mut stats),
                BatchItemOutcome::Conflict {
                    remote_version,
                    remote_cipher_hash,
                } => {
                    handle_push_conflict(
                        content_root,
                        &pu.path,
                        remote_version,
                        remote_cipher_hash,
                        key,
                        fc,
                        state,
                        &mut stats,
                    )
                    .await
                }
                // Unreachable in practice — prepare would have refused first —
                // but the arm has to exist and silently dropping it would hide
                // a real change in server behaviour.
                BatchItemOutcome::Forbidden { message } => {
                    record_forbidden(state, "complete", &pu.path, &message)
                }
                BatchItemOutcome::Err { status, message } => {
                    record_item_error(&mut stats, "complete", &pu.path, status, &message)
                }
            }
        }
    }
    stats
}

/// Apply a successful upload-complete to local state (non-dirty), re-statting the
/// file for the current plaintext mtime/size (the basis for dirty detection).
fn finalize_upload(
    content_root: &str,
    pu: &PreparedUpload,
    c: CompleteResult,
    state: &mut LocalSyncState,
    stats: &mut PhaseStats,
) {
    let abs_path = Path::new(content_root).join(&pu.path);
    let (mtime, size) = match std::fs::metadata(&abs_path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (mtime, meta.len())
        }
        Err(_) => (0, pu.size),
    };
    state.upsert(
        &pu.path,
        c.version,
        c.content_hash,
        pu.plain_hash.clone(),
        pu.plain_hash.clone(),
        mtime,
        size,
    );
    stats.pushed += 1;
}

/// Handle a push CAS conflict: save local content as a sidecar, then pull the
/// remote version that beat us. Mirrors the per-file conflict path.
#[allow(clippy::too_many_arguments)]
async fn handle_push_conflict(
    content_root: &str,
    path: &str,
    remote_version: Option<i32>,
    remote_cipher_hash: Option<String>,
    key: Option<&[u8; 32]>,
    fc: &FcClient,
    state: &mut LocalSyncState,
    stats: &mut PhaseStats,
) {
    stats.conflicts += 1;
    tracing::warn!("[oss_sync] push conflict {path}: remote_version={remote_version:?}");
    let abs_path = Path::new(content_root).join(path);
    if let Ok(local_bytes) = std::fs::read(&abs_path) {
        let local_cipher_hash = state
            .files
            .get(path)
            .map(|f| f.synced_cipher_hash.as_str())
            .unwrap_or("unknown");
        let _ = write_conflict_sidecar(
            Path::new(content_root),
            path,
            &local_bytes,
            local_cipher_hash,
        )
        .await;
    }
    if let Some(hash) = remote_cipher_hash {
        let version = remote_version.unwrap_or(0);
        let _ = download_and_write(content_root, path, &hash, version, key, fc, state).await;
    }
}

/// Per-file PUSH fallback (pre-batch FC): one prepare/put/complete per file with
/// in-call transient retry, identical to the pre-batch engine behavior.
async fn apply_push_per_file(
    content_root: &str,
    path: &str,
    team_id: &str,
    key: Option<&[u8; 32]>,
    fc: &FcClient,
    state: &mut LocalSyncState,
    stats: &mut PhaseStats,
) {
    match upload_one_retrying(content_root, path, team_id, fc, state).await {
        Ok(_) => stats.pushed += 1,
        Err(SyncError::Conflict {
            remote_version,
            remote_cipher_hash,
        }) => {
            handle_push_conflict(
                content_root,
                path,
                remote_version,
                remote_cipher_hash,
                key,
                fc,
                state,
                stats,
            )
            .await
        }
        Err(e) => {
            if is_transient(&e) {
                stats.deferred += 1;
                stats.last_transient = Some(e);
            } else {
                tracing::warn!("[oss_sync] push {path}: {e}");
            }
        }
    }
}

/// Batched DELETE: tombstone N locally-deleted files in one FC round-trip.
/// Per-file fallback on a pre-batch FC.
/// After removing a synced file, prune now-empty parent directories so a folder
/// deletion on one device does not leave empty directory shells on the pulling
/// device. Directories are not first-class sync objects (the scanner tracks
/// regular files only), so a deleted folder is just N deleted files — without
/// this the empty parent lingers and the folder browser still lists it.
///
/// Walks up from the file's parent, `remove_dir`-ing each directory that has
/// become empty, and stops at the first non-empty directory, at `content_root`,
/// or at the `ALLOWED_PREFIXES` root (which must never be removed). Best-effort:
/// any error (non-empty dir, permissions, race) simply halts the walk.
async fn prune_empty_parents(content_root: &Path, rel_path: &str) {
    // The prefix root segment (e.g. "skills") must be preserved — never remove it.
    let prefix_root = match ALLOWED_PREFIXES
        .iter()
        .find(|p| rel_path.starts_with(**p))
        .map(|p| p.trim_end_matches('/'))
    {
        Some(r) => r,
        None => return,
    };

    let mut cur = Path::new(rel_path).parent();
    while let Some(rel_dir) = cur {
        let rel_dir_str = rel_dir.to_string_lossy();
        // Stop at the workspace root or the (preserved) prefix root.
        if rel_dir_str.is_empty() || rel_dir == Path::new(prefix_root) {
            break;
        }
        let abs_dir = content_root.join(rel_dir);
        // `remove_dir` only succeeds on an empty directory; a non-empty dir (or
        // any other error) ends the walk.
        if tokio::fs::remove_dir(&abs_dir).await.is_err() {
            break;
        }
        cur = rel_dir.parent();
    }
}

async fn delete_phase(
    content_root: &str,
    team_id: &str,
    fc: &FcClient,
    state: &mut LocalSyncState,
    dels: Vec<(String, i32)>,
) -> PhaseStats {
    let mut stats = PhaseStats::default();
    if dels.is_empty() {
        return stats;
    }

    for chunk in dels.chunks(MAX_BATCH) {
        let items: Vec<DeleteBatchItem> = chunk
            .iter()
            .map(|(p, v)| delete_batch_item_for(p, *v))
            .collect();
        let node_id = knowledge_created_by_node_id();

        let outcomes =
            match with_batch_retry(|| fc.delete_batch(team_id, &items, node_id.as_deref())).await
            {
                Ok(o) => o,
                Err(SyncError::BatchUnsupported) => {
                    for (p, v) in chunk {
                        match delete_file_retrying(fc, team_id, p, *v).await {
                            Ok(version) => {
                                state.mark_tombstoned(p, version);
                                prune_empty_parents(Path::new(content_root), p).await;
                                stats.pushed += 1;
                            }
                            Err(SyncError::Conflict { .. }) => stats.conflicts += 1,
                            Err(e) => {
                                if is_transient(&e) {
                                    stats.deferred += 1;
                                    stats.last_transient = Some(e);
                                } else {
                                    tracing::warn!("[oss_sync] delete {p}: {e}");
                                }
                            }
                        }
                    }
                    continue;
                }
                Err(e) => {
                    if is_transient(&e) {
                        stats.deferred += chunk.len() as u32;
                        stats.last_transient = Some(e);
                    } else {
                        tracing::warn!("[oss_sync] delete-batch: {e}");
                    }
                    continue;
                }
            };

        for ((p, _v), oc) in chunk.iter().zip(outcomes.into_iter()) {
            match oc {
                BatchItemOutcome::Ok(r) => {
                    state.mark_tombstoned(p, r.version);
                    prune_empty_parents(Path::new(content_root), p).await;
                    stats.pushed += 1;
                }
                // Remote advanced since our last sync; leave the entry so the next
                // pull reconciles rather than deleting a file someone else changed.
                BatchItemOutcome::Conflict { .. } => stats.conflicts += 1,
                BatchItemOutcome::Forbidden { message } => {
                    record_forbidden(state, "delete", p, &message)
                }
                BatchItemOutcome::Err { status, message } => {
                    record_item_error(&mut stats, "delete", p, status, &message)
                }
            }
        }
    }
    stats
}

/// Download a remote blob, decode it (envelope or plaintext), write it to disk,
/// and update state to non-dirty.
pub async fn download_and_write(
    content_root: &str,
    rel_path: &str,
    remote_cipher_hash: &str,
    version: i32,
    key: Option<&[u8; 32]>,
    fc: &FcClient,
    state: &mut LocalSyncState,
) -> Result<(), SyncError> {
    let team_id = state.team_id.clone();
    let dl = fc.download(&team_id, remote_cipher_hash).await?;
    let blob = fc.get_blob(&dl.download_url, remote_cipher_hash).await?;

    let plaintext = decode_pulled_blob(blob, key)?;
    let plain_hash = sha256_hex(&plaintext);

    let abs_path = Path::new(content_root).join(rel_path);
    // MUST precede create_dir_all / write: inotify can deliver Local before
    // this task resumes after an await.
    crate::sync::watch::record_pull_write(&team_id, rel_path);
    if let Some(parent) = abs_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| SyncError::Io(e.to_string()))?;
    }
    tokio::fs::write(&abs_path, &plaintext)
        .await
        .map_err(|e| SyncError::Io(e.to_string()))?;

    let meta = std::fs::metadata(&abs_path).map_err(SyncError::from)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.len();

    // Spec §4.3 fix #11: update state to non-dirty after overwrite.
    state.upsert(
        rel_path,
        version,
        remote_cipher_hash.to_string(),
        plain_hash.clone(),
        plain_hash,
        mtime,
        size,
    );

    Ok(())
}

/// Upload one dirty local file, as-is.
async fn upload_one(
    content_root: &str,
    rel_path: &str,
    team_id: &str,
    fc: &FcClient,
    state: &mut LocalSyncState,
) -> Result<(), SyncError> {
    let abs_path = Path::new(content_root).join(rel_path);
    let blob = tokio::fs::read(&abs_path)
        .await
        .map_err(|e| SyncError::Io(e.to_string()))?;
    let plain_hash = sha256_hex(&blob);
    let remote_cipher_hash = plain_hash.clone();

    let parent_version = state
        .files
        .get(rel_path)
        .map(|f| f.synced_version)
        .unwrap_or(0);

    let prepare = fc
        .upload_prepare(
            team_id,
            rel_path,
            parent_version,
            &remote_cipher_hash,
            blob.len() as u64,
            knowledge_created_by_node_id().as_deref(),
        )
        .await?;

    if prepare.requires_upload {
        if let Some(url) = &prepare.presigned_put {
            fc.put_blob(url, blob).await?;
        }
    }

    let complete = fc
        .upload_complete(
            team_id,
            &prepare.upload_session_id,
            knowledge_created_by_node_id().as_deref(),
        )
        .await?;

    let meta = std::fs::metadata(&abs_path).map_err(SyncError::from)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.len();

    state.upsert(
        rel_path,
        complete.version,
        complete.content_hash,
        plain_hash.clone(),
        plain_hash,
        mtime,
        size,
    );

    Ok(())
}

/// Treat FC rate-limiting (HTTP 429) and transient unavailability (503 / timeout)
/// as retryable. These surface as SyncError::Internal/Network carrying the HTTP text.
fn is_transient(e: &SyncError) -> bool {
    let m = e.to_string().to_ascii_lowercase();
    m.contains("429")
        || m.contains("too many requests")
        || m.contains("503")
        || m.contains("temporarily")
        || m.contains("timed out")
        || m.contains("timeout")
}

const MAX_TRANSIENT_RETRIES: u32 = 5;

/// Exponential backoff: ~0.8s, 1.6s, 3.2s, 6.4s, 12s.
async fn backoff_sleep(attempt: u32) {
    let ms = (800u64 << attempt.min(4)).min(12_000);
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// `upload_one` with in-call retry on transient (rate-limit) errors, so a 429 does
/// not silently drop the change. Non-transient errors and Conflict return immediately.
async fn upload_one_retrying(
    content_root: &str,
    rel_path: &str,
    team_id: &str,
    fc: &FcClient,
    state: &mut LocalSyncState,
) -> Result<(), SyncError> {
    let mut attempt = 0u32;
    loop {
        match upload_one(content_root, rel_path, team_id, fc, state).await {
            Err(e) if is_transient(&e) && attempt < MAX_TRANSIENT_RETRIES => {
                attempt += 1;
                backoff_sleep(attempt).await;
            }
            other => return other,
        }
    }
}

/// `fc.delete_file` with in-call retry on transient (rate-limit) errors.
async fn delete_file_retrying(
    fc: &FcClient,
    team_id: &str,
    path: &str,
    parent_version: i32,
) -> Result<i32, SyncError> {
    let mut attempt = 0u32;
    loop {
        match fc
            .delete_file(
                team_id,
                path,
                parent_version,
                knowledge_created_by_node_id().as_deref(),
            )
            .await
        {
            Err(e) if is_transient(&e) && attempt < MAX_TRANSIENT_RETRIES => {
                attempt += 1;
                backoff_sleep(attempt).await;
            }
            other => return other,
        }
    }
}

/// Refresh ONLY the `dirty` flag of existing state entries from the working tree.
/// Used before PULL so conflict/deletion checks see current dirtiness. Deliberately
/// does NOT touch mtime/size (the last-synced baseline the PUSH scan depends on).
fn refresh_dirty(state: &mut LocalSyncState, content_root: &str, rules: &IgnoreRules) {
    let scan = scan_workspace_with(content_root, state, rules);
    for scanned in &scan {
        if let Some(fs) = state.files.get_mut(&scanned.rel_path) {
            fs.dirty = scanned.dirty;
        }
    }
}

/// Scan the working tree and apply current mtime/size/hash/dirty back into the
/// state entries that already exist; returns the scan so callers can also use it
/// for new-file and deletion detection. Used by PUSH (runs once per tick).
fn apply_scan(
    state: &mut LocalSyncState,
    content_root: &str,
    rules: &IgnoreRules,
) -> Vec<ScannedFile> {
    let scan = scan_workspace_with(content_root, state, rules);
    for scanned in &scan {
        if let Some(fs) = state.files.get_mut(&scanned.rel_path) {
            fs.mtime = scanned.mtime;
            fs.size = scanned.size;
            fs.local_plain_hash = scanned.local_plain_hash.clone();
            fs.dirty = scanned.dirty;
        }
    }
    scan
}

/// What a push should actually send, and what it is holding back.
struct PushPlan {
    to_push: Vec<String>,
    oversize: Vec<String>,
    blocked_new_files: Option<u32>,
}

/// Apply the two name-blind guards to the push candidates.
///
/// The ignore rules stop what somebody thought to name. These stop what nobody
/// did — a build tool no one here has heard of, a 4 GB screen recording with a
/// perfectly ordinary filename. That is why they count and measure rather than
/// match.
///
/// Split out of the tick so it can be tested without an FC client: this is the
/// last thing standing between "somebody dropped a repo in the notes folder"
/// and an object store with single-digit GB free.
fn plan_push(
    dirty_paths: Vec<String>,
    mut extra_dirty: Vec<String>,
    mut readd_paths: Vec<String>,
    sizes: &std::collections::HashMap<&str, u64>,
    allow_bulk_add: bool,
) -> PushPlan {
    // Counted before anything is filtered out, so the number the user is asked
    // about is the number of files they actually created.
    let new_file_count = extra_dirty.len();
    if !allow_bulk_add && new_file_count > MAX_NEW_FILES_PER_TICK {
        // Nothing goes up — not even edits to documents that were already
        // there. This tick is a question, not a partial upload: half a source
        // tree in the team's cloud is worse than none of it, and the user
        // should make one decision rather than watch an upload they never
        // asked for get most of the way through.
        return PushPlan {
            to_push: Vec::new(),
            oversize: Vec::new(),
            blocked_new_files: Some(new_file_count as u32),
        };
    }

    let mut to_push = {
        let mut v = dirty_paths;
        v.append(&mut extra_dirty);
        v.append(&mut readd_paths);
        v.sort();
        v.dedup();
        v
    };

    // One file too large to carry does not stop the notes around it: drop it
    // from this push and report it. A path with no recorded size (gone since
    // the scan) stays in — the push path already handles a missing file, and
    // guessing here would drop a document on a race.
    let mut oversize: Vec<String> = Vec::new();
    to_push.retain(|path| {
        let too_big = sizes
            .get(path.as_str())
            .is_some_and(|&n| n > MAX_FILE_BYTES);
        if too_big {
            oversize.push(path.clone());
        }
        !too_big
    });

    PushPlan {
        to_push,
        oversize,
        blocked_new_files: None,
    }
}

/// Paths previously synced (`synced_version > 0`) but absent from the current
/// scan → deleted locally, needing a server-side tombstone. Sorted for determinism.
///
/// **Ignored paths are excluded, and that exclusion is load-bearing.** Becoming
/// ignored also makes a file vanish from the scan, which is indistinguishable
/// here from being deleted. Without this filter, the first tick after any new
/// ignore rule lands would tombstone every file the rule now covers and delete
/// them off every teammate's disk — a client-side change silently destroying
/// server-side data. Ignoring means "stop managing", never "delete": the state
/// entries stay put, so relaxing the rule later lets the files resume syncing.
/// Hold back a tombstone batch that is too large to send unasked.
///
/// All or nothing, matching the add-side guard and for a sharper reason: a
/// tombstone is applied on every member's machine, so a partially sent mass
/// deletion loses files for everyone AND makes the cause harder to find than if
/// nothing had gone at all.
fn apply_delete_guard(
    dels: Vec<(String, i32)>,
    allow_bulk_delete: bool,
) -> (Vec<(String, i32)>, Option<u32>) {
    if !allow_bulk_delete && dels.len() > MAX_DELETES_PER_TICK {
        let count = dels.len() as u32;
        return (Vec::new(), Some(count));
    }
    (dels, None)
}

fn locally_deleted_paths(
    state: &LocalSyncState,
    scan: &[ScannedFile],
    rules: &IgnoreRules,
) -> Vec<(String, i32)> {
    let present: std::collections::HashSet<&str> =
        scan.iter().map(|s| s.rel_path.as_str()).collect();
    let mut out: Vec<(String, i32)> = state
        .files
        .iter()
        .filter(|(p, f)| {
            !f.deleted_local
                && f.synced_version > 0
                && !present.contains(p.as_str())
                && !rules.is_ignored_with_ancestors(p)
        })
        .map(|(p, f)| (p.clone(), f.synced_version))
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::oss::state::FileState;

    /// A transfer that fails leaves through `?` part-way down the future. The
    /// guard is what still counts it — without that a pull where two of ten
    /// files 404 would sit at 8/10 and read as hung rather than finished.
    #[test]
    fn a_pulled_blob_is_decoded_as_plaintext_or_envelope() {
        let key = [7u8; 32];

        // What every new write looks like: no envelope, no key needed.
        let plain = b"# note\n\njust text".to_vec();
        assert_eq!(
            decode_pulled_blob(plain.clone(), None).unwrap(),
            plain,
            "plaintext must pass through untouched, with or without a key"
        );
        assert_eq!(
            decode_pulled_blob(plain.clone(), Some(&key)).unwrap(),
            plain
        );

        // What is already in object storage: an envelope, readable with the key.
        let envelope = crate::sync::oss::crypto::encrypt_blob(&plain, &key).unwrap();
        assert_eq!(
            decode_pulled_blob(envelope.clone(), Some(&key)).unwrap(),
            plain
        );

        // The case that froze whole teams: an envelope this device cannot open.
        // It has to be an error so the file is quarantined and RETRIED, not
        // written to disk as ciphertext.
        assert!(decode_pulled_blob(envelope.clone(), None).is_err());
        assert!(decode_pulled_blob(envelope, Some(&[1u8; 32])).is_err());
    }

    #[test]
    fn a_failed_transfer_still_advances_the_bar() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = {
            let seen = seen.clone();
            ProgressSink::new(move |p| seen.lock().unwrap().push(p))
        };
        let counter = Arc::new(AtomicU32::new(0));

        for _ in 0..3 {
            let _guard = ReportOnDrop {
                progress: &sink,
                phase: SyncPhase::Pulling,
                counter: counter.clone(),
                total: 3,
            };
            // The body is irrelevant — success or `?`, the drop is what reports.
        }

        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[2].done, 3);
        assert_eq!(seen[2].total, 3);
        assert_eq!(seen[2].phase, SyncPhase::Pulling);
    }
    use std::collections::HashMap;

    fn empty_state() -> LocalSyncState {
        LocalSyncState {
            quarantined: Default::default(),
            forbidden: Default::default(),
            last_reconcile_at: 0,
            schema_version: 1,
            team_id: "t".into(),
            last_server_seq: 0,
            last_sync_at: String::new(),
            files: HashMap::new(),
        }
    }

    fn synced_file(version: i32) -> FileState {
        FileState {
            synced_version: version,
            synced_cipher_hash: "c".into(),
            synced_plain_hash: "p".into(),
            local_plain_hash: "p".into(),
            mtime: 1,
            size: 1,
            dirty: false,
            deleted_local: false,
        }
    }

    fn scanned(path: &str) -> ScannedFile {
        ScannedFile {
            rel_path: path.into(),
            mtime: 1,
            size: 1,
            local_plain_hash: "p".into(),
            dirty: false,
        }
    }

    fn sizes_of(pairs: &[(&'static str, u64)]) -> std::collections::HashMap<&'static str, u64> {
        pairs.iter().copied().collect()
    }

    // ── revocation cleanup ────────────────────────────────────────────────
    //
    // The assertion that matters most in this file is
    // `apply_revocations_drops_the_state_entry_so_it_can_never_tombstone`.
    // If that regresses, one member losing access deletes the directory off
    // every teammate who still has it.

    fn revocation_fixture() -> (tempfile::TempDir, LocalSyncState) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("knowledge/hr")).unwrap();
        std::fs::create_dir_all(dir.path().join("knowledge/open")).unwrap();
        std::fs::write(dir.path().join("knowledge/hr/salary.md"), b"secret\n").unwrap();
        std::fs::write(dir.path().join("knowledge/open/notes.md"), b"public\n").unwrap();

        let mut state = empty_state();
        state
            .files
            .insert("knowledge/hr/salary.md".into(), synced_file(1));
        state
            .files
            .insert("knowledge/open/notes.md".into(), synced_file(1));
        (dir, state)
    }

    #[test]
    fn apply_revocations_removes_only_what_the_manifest_no_longer_offers() {
        let (dir, mut state) = revocation_fixture();
        let root = dir.path().to_str().unwrap();
        let rules = IgnoreRules::load(dir.path());

        let visible: std::collections::HashSet<String> = ["knowledge/open/notes.md".to_string()]
            .into_iter()
            .collect();
        let revoked = apply_revocations(root, &mut state, &visible, &rules);

        assert_eq!(revoked, vec!["knowledge/hr/salary.md".to_string()]);
        assert!(!dir.path().join("knowledge/hr/salary.md").exists());
        assert!(
            dir.path().join("knowledge/open/notes.md").exists(),
            "a path still in the manifest must be untouched"
        );
    }

    #[test]
    fn apply_revocations_drops_the_state_entry_so_it_can_never_tombstone() {
        let (dir, mut state) = revocation_fixture();
        let root = dir.path().to_str().unwrap();
        let rules = IgnoreRules::load(dir.path());

        let visible: std::collections::HashSet<String> = ["knowledge/open/notes.md".to_string()]
            .into_iter()
            .collect();
        apply_revocations(root, &mut state, &visible, &rules);

        assert!(
            !state.files.contains_key("knowledge/hr/salary.md"),
            "the entry must be gone, not tombstoned"
        );

        // The real proof: the very next push must not offer a delete for it.
        // With the entry still present this returns the path and the tombstone
        // goes out to the whole team.
        let scan: Vec<ScannedFile> = vec![scanned("knowledge/open/notes.md")];
        let tombstones = locally_deleted_paths(&state, &scan, &rules);
        assert!(
            tombstones.is_empty(),
            "revoked files must never be broadcast as deletions: {tombstones:?}"
        );
    }

    #[test]
    fn apply_revocations_marks_the_path_forbidden_so_push_skips_it() {
        let (dir, mut state) = revocation_fixture();
        let root = dir.path().to_str().unwrap();
        let rules = IgnoreRules::load(dir.path());

        let visible: std::collections::HashSet<String> = ["knowledge/open/notes.md".to_string()]
            .into_iter()
            .collect();
        apply_revocations(root, &mut state, &visible, &rules);

        assert!(state.is_forbidden_now("knowledge/hr/salary.md", now_secs()));
    }

    #[test]
    fn apply_revocations_leaves_never_synced_and_ignored_paths_alone() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("knowledge")).unwrap();
        std::fs::write(dir.path().join("knowledge/pending.md"), b"x").unwrap();
        let root = dir.path().to_str().unwrap();
        let rules = IgnoreRules::load(dir.path());

        let mut state = empty_state();
        // Never synced: nothing was ever distributed, so nothing to revoke.
        state
            .files
            .insert("knowledge/pending.md".into(), synced_file(0));

        let revoked = apply_revocations(root, &mut state, &Default::default(), &rules);
        assert!(revoked.is_empty());
        assert!(dir.path().join("knowledge/pending.md").exists());
    }

    #[test]
    fn forbidden_expires_so_a_later_grant_heals_without_a_notification() {
        let mut state = empty_state();
        state.mark_forbidden("knowledge/hr/a.md", "nope", 1_000);
        assert!(state.is_forbidden_now("knowledge/hr/a.md", 1_000));
        assert!(state.is_forbidden_now(
            "knowledge/hr/a.md",
            1_000 + crate::sync::oss::state::FORBIDDEN_RETRY_SECS - 1
        ));
        assert!(
            !state.is_forbidden_now(
                "knowledge/hr/a.md",
                1_000 + crate::sync::oss::state::FORBIDDEN_RETRY_SECS
            ),
            "the entry must expire, or a grant could never take effect"
        );
    }

    #[test]
    fn marking_forbidden_clears_dirty_so_it_leaves_the_pending_set() {
        let mut state = empty_state();
        let mut f = synced_file(1);
        f.dirty = true;
        state.files.insert("knowledge/hr/a.md".into(), f);

        state.mark_forbidden("knowledge/hr/a.md", "nope", 1_000);
        assert!(
            !state.files.get("knowledge/hr/a.md").unwrap().dirty,
            "a file we may never upload is not pending upload"
        );
    }

    // ── the delete-side guard ─────────────────────────────────────────────
    //
    // `locally_deleted_paths` cannot tell a deletion from a scan that came back
    // short. These pin the arithmetic the guard applies to its result; the
    // all-or-nothing decision itself lives in `tick` and is asserted through
    // the counts below.

    #[test]
    fn delete_guard_threshold_is_all_or_nothing() {
        // Under the limit: everything goes.
        let under: Vec<(String, i32)> = (0..MAX_DELETES_PER_TICK)
            .map(|i| (format!("knowledge/{i}.md"), 1))
            .collect();
        let (kept, blocked) = apply_delete_guard(under.clone(), false);
        assert_eq!(kept.len(), MAX_DELETES_PER_TICK);
        assert_eq!(blocked, None);

        // One over: NOTHING goes. A half-applied mass deletion is the worst
        // outcome — the files are gone for everyone and the cause is harder to
        // see than if none had been.
        let mut over = under.clone();
        over.push(("knowledge/extra.md".into(), 1));
        let (kept, blocked) = apply_delete_guard(over.clone(), false);
        assert!(kept.is_empty(), "a partial mass delete is not an option");
        assert_eq!(blocked, Some(over.len() as u32));
    }

    #[test]
    fn delete_guard_yields_to_an_explicit_confirmation() {
        let over: Vec<(String, i32)> = (0..MAX_DELETES_PER_TICK + 5)
            .map(|i| (format!("knowledge/{i}.md"), 1))
            .collect();
        let (kept, blocked) = apply_delete_guard(over.clone(), true);
        assert_eq!(kept.len(), over.len(), "a person said yes");
        assert_eq!(blocked, None);
    }

    #[test]
    fn plan_push_sends_everything_when_nothing_trips_a_guard() {
        let plan = plan_push(
            vec!["knowledge/a.md".into()],
            vec!["knowledge/b.md".into()],
            vec![],
            &sizes_of(&[("knowledge/a.md", 10), ("knowledge/b.md", 20)]),
            false,
        );
        assert_eq!(plan.to_push, vec!["knowledge/a.md", "knowledge/b.md"]);
        assert!(plan.oversize.is_empty());
        assert_eq!(plan.blocked_new_files, None);
    }

    /// A 4 GB recording has an ordinary name, so no ignore rule will ever match
    /// it. The size guard is what keeps it off an object store with
    /// single-digit GB free.
    #[test]
    fn plan_push_drops_a_file_over_the_size_limit_and_keeps_the_rest() {
        let plan = plan_push(
            vec!["knowledge/notes.md".into(), "knowledge/huge.mov".into()],
            vec![],
            vec![],
            &sizes_of(&[
                ("knowledge/notes.md", 1024),
                ("knowledge/huge.mov", MAX_FILE_BYTES + 1),
            ]),
            false,
        );
        assert_eq!(plan.to_push, vec!["knowledge/notes.md"]);
        assert_eq!(plan.oversize, vec!["knowledge/huge.mov"]);
    }

    #[test]
    fn plan_push_allows_a_file_exactly_at_the_size_limit() {
        let plan = plan_push(
            vec!["knowledge/edge.bin".into()],
            vec![],
            vec![],
            &sizes_of(&[("knowledge/edge.bin", MAX_FILE_BYTES)]),
            false,
        );
        assert_eq!(plan.to_push, vec!["knowledge/edge.bin"]);
        assert!(plan.oversize.is_empty());
    }

    /// A path the scan no longer knows the size of must not be dropped on a
    /// guess — the push path already copes with a file that vanished.
    #[test]
    fn plan_push_keeps_a_path_with_no_recorded_size() {
        let plan = plan_push(
            vec!["knowledge/raced.md".into()],
            vec![],
            vec![],
            &sizes_of(&[]),
            false,
        );
        assert_eq!(plan.to_push, vec!["knowledge/raced.md"]);
    }

    /// What "somebody dropped a repo into the notes folder" looks like from in
    /// here. Nothing goes up, including the ordinary edit alongside it: this
    /// tick is a question, not a partial upload.
    #[test]
    fn plan_push_holds_everything_back_when_too_many_new_files_appear() {
        let new_files: Vec<String> = (0..MAX_NEW_FILES_PER_TICK + 1)
            .map(|i| format!("knowledge/repo/file-{i}.js"))
            .collect();
        let plan = plan_push(
            vec!["knowledge/an-ordinary-edit.md".into()],
            new_files,
            vec![],
            &sizes_of(&[]),
            false,
        );
        assert!(plan.to_push.is_empty());
        assert_eq!(
            plan.blocked_new_files,
            Some(MAX_NEW_FILES_PER_TICK as u32 + 1)
        );
    }

    #[test]
    fn plan_push_lets_exactly_the_limit_through() {
        let new_files: Vec<String> = (0..MAX_NEW_FILES_PER_TICK)
            .map(|i| format!("knowledge/f{i}.md"))
            .collect();
        let plan = plan_push(vec![], new_files, vec![], &sizes_of(&[]), false);
        assert_eq!(plan.blocked_new_files, None);
        assert_eq!(plan.to_push.len(), MAX_NEW_FILES_PER_TICK);
    }

    /// The acknowledgement path: a person saw the count and said yes.
    #[test]
    fn plan_push_sends_the_batch_once_it_is_allowed() {
        let new_files: Vec<String> = (0..MAX_NEW_FILES_PER_TICK + 500)
            .map(|i| format!("knowledge/f{i}.md"))
            .collect();
        let expected = new_files.len();
        let plan = plan_push(vec![], new_files, vec![], &sizes_of(&[]), true);
        assert_eq!(plan.blocked_new_files, None);
        assert_eq!(plan.to_push.len(), expected);
    }

    /// Editing thousands of documents that already sync is not a flood — only
    /// previously-unseen files are counted.
    #[test]
    fn plan_push_does_not_count_edits_to_existing_files_as_new() {
        let edits: Vec<String> = (0..MAX_NEW_FILES_PER_TICK + 1)
            .map(|i| format!("knowledge/existing-{i}.md"))
            .collect();
        let plan = plan_push(edits, vec![], vec![], &sizes_of(&[]), false);
        assert_eq!(plan.blocked_new_files, None);
    }

    #[test]
    fn locally_deleted_detects_synced_file_absent_from_scan() {
        let mut state = empty_state();
        state.files.insert("knowledge/a.md".into(), synced_file(3));
        state.files.insert("knowledge/b.md".into(), synced_file(1));
        // Only a.md is still on disk; b.md was deleted locally.
        let scan = vec![scanned("knowledge/a.md")];
        assert_eq!(
            locally_deleted_paths(&state, &scan, &IgnoreRules::empty()),
            vec![("knowledge/b.md".to_string(), 1)]
        );
    }

    #[test]
    fn locally_deleted_ignores_never_synced_and_already_deleted() {
        let mut state = empty_state();
        // never synced (version 0) — server doesn't have it; nothing to delete.
        state
            .files
            .insert("knowledge/new.md".into(), synced_file(0));
        // already marked deleted_local — don't re-emit.
        let mut d = synced_file(2);
        d.deleted_local = true;
        state.files.insert("knowledge/gone.md".into(), d);
        assert!(locally_deleted_paths(&state, &[], &IgnoreRules::empty()).is_empty());
    }

    #[test]
    fn locally_deleted_empty_when_all_present() {
        let mut state = empty_state();
        state.files.insert("knowledge/a.md".into(), synced_file(2));
        let scan = vec![scanned("knowledge/a.md")];
        assert!(locally_deleted_paths(&state, &scan, &IgnoreRules::empty()).is_empty());
    }

    #[test]
    fn quarantined_files_are_retried_ahead_of_the_new_manifest_items() {
        let mut state = empty_state();
        state.quarantine(
            "knowledge/stuck.md",
            "hash-stuck",
            4,
            "decrypt failed".into(),
        );
        state.quarantine("knowledge/also.md", "hash-also", 6, "download 500".into());

        let fresh = vec![PullItem {
            path: "knowledge/new.md".into(),
            cipher_hash: "hash-new".into(),
            version: 9,
        }];

        let items = with_quarantined_retries(fresh, &state);

        // The cursor has already moved past the stuck files, so this list is the
        // only thing that ever fetches them again.
        let paths: Vec<&str> = items.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "knowledge/also.md",
                "knowledge/stuck.md",
                "knowledge/new.md"
            ]
        );
        assert_eq!(items[1].cipher_hash, "hash-stuck");
        assert_eq!(items[1].version, 4, "retried at the version that failed");
    }

    #[test]
    fn a_file_this_manifest_already_offers_is_not_fetched_twice() {
        let mut state = empty_state();
        state.quarantine("knowledge/stuck.md", "old-hash", 4, "decrypt failed".into());

        // The server has a NEWER version of the same path this tick.
        let fresh = vec![PullItem {
            path: "knowledge/stuck.md".into(),
            cipher_hash: "new-hash".into(),
            version: 7,
        }];

        let items = with_quarantined_retries(fresh, &state);

        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].cipher_hash, "new-hash",
            "the manifest's newer version wins over the quarantined one"
        );
    }

    #[test]
    fn high_water_advances_past_files_it_could_not_apply() {
        // Clean drain → advance.
        assert_eq!(next_high_water(10, Some(42)), 42);
        // Manifest never produced a snapshot → nothing to advance to.
        assert_eq!(next_high_water(10, None), 10);
    }

    #[test]
    fn is_transient_matches_rate_limit_and_unavailable() {
        assert!(is_transient(&SyncError::Internal(
            "FC returned HTTP 429 Too Many Requests: Too many requests".into()
        )));
        assert!(is_transient(&SyncError::Network(
            "503 Service Unavailable".into()
        )));
        assert!(is_transient(&SyncError::Network(
            "connection timed out".into()
        )));
        // Non-transient errors must NOT be retried.
        assert!(!is_transient(&SyncError::Conflict {
            remote_version: Some(2),
            remote_cipher_hash: None
        }));
        assert!(!is_transient(&SyncError::InvalidPath("bad prefix".into())));
        assert!(!is_transient(&SyncError::Auth("forbidden".into())));
    }

    #[test]
    fn refresh_dirty_marks_edit_without_mutating_mtime_size() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        std::fs::create_dir_all(dir.path().join("knowledge")).unwrap();
        let f = dir.path().join("knowledge/x.md");
        std::fs::write(&f, b"base\n").unwrap();

        // State reflects last-synced "base\n" with a baseline mtime/size.
        let mut state = empty_state();
        state.files.insert(
            "knowledge/x.md".into(),
            FileState {
                synced_version: 1,
                synced_cipher_hash: "c".into(),
                synced_plain_hash: sha256_hex(b"base\n"),
                local_plain_hash: sha256_hex(b"base\n"),
                mtime: 111,
                size: 5,
                dirty: false,
                deleted_local: false,
            },
        );

        // Edit the file (different content + size).
        std::fs::write(&f, b"edited-bigger\n").unwrap();
        refresh_dirty(&mut state, root, &IgnoreRules::empty());

        let fs = &state.files["knowledge/x.md"];
        assert!(fs.dirty, "edited file must be flagged dirty before pull");
        // Critical: the last-synced baseline must be untouched so the PUSH scan
        // still detects the change and uploads it.
        assert_eq!(fs.mtime, 111, "refresh_dirty must not mutate mtime");
        assert_eq!(fs.size, 5, "refresh_dirty must not mutate size");
    }

    // ── empty-parent pruning ────────────────────────────────────────────────────

    #[tokio::test]
    async fn prune_empty_parents_walks_up_and_stops_at_prefix_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // skills/a/b/c.md — remove c.md, then a/b and a should be pruned, but
        // the "skills" prefix root must survive.
        std::fs::create_dir_all(root.join("knowledge/a/b")).unwrap();
        std::fs::write(root.join("knowledge/a/b/c.md"), b"x").unwrap();
        std::fs::remove_file(root.join("knowledge/a/b/c.md")).unwrap();

        prune_empty_parents(root, "knowledge/a/b/c.md").await;

        assert!(!root.join("knowledge/a/b").exists(), "empty b/ pruned");
        assert!(!root.join("knowledge/a").exists(), "empty a/ pruned");
        assert!(
            root.join("knowledge").exists(),
            "prefix root skills/ preserved"
        );
    }

    #[tokio::test]
    async fn prune_empty_parents_stops_at_first_nonempty() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // skills/a holds another file, so removing skills/a/b/c.md prunes b/ only.
        std::fs::create_dir_all(root.join("knowledge/a/b")).unwrap();
        std::fs::write(root.join("knowledge/a/keep.md"), b"keep").unwrap();
        std::fs::write(root.join("knowledge/a/b/c.md"), b"x").unwrap();
        std::fs::remove_file(root.join("knowledge/a/b/c.md")).unwrap();

        prune_empty_parents(root, "knowledge/a/b/c.md").await;

        assert!(!root.join("knowledge/a/b").exists(), "empty b/ pruned");
        assert!(root.join("knowledge/a").exists(), "non-empty a/ preserved");
        assert!(
            root.join("knowledge/a/keep.md").exists(),
            "sibling file kept"
        );
    }

    #[tokio::test]
    async fn prune_empty_parents_top_level_file_keeps_prefix_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("knowledge")).unwrap();
        // A file directly under the prefix root: nothing to prune.
        prune_empty_parents(root, "knowledge/x.md").await;
        assert!(root.join("knowledge").exists(), "prefix root never removed");
    }

    // ── batch helpers ──────────────────────────────────────────────────────────

    #[test]
    fn record_item_error_defers_transient_only() {
        let mut s = PhaseStats::default();
        record_item_error(&mut s, "complete", "a.md", 429, "Too Many Requests");
        assert_eq!(s.deferred, 1, "429 must defer for next-tick retry");
        assert!(s.last_transient.is_some());

        let mut s2 = PhaseStats::default();
        record_item_error(&mut s2, "complete", "a.md", 410, "session gone");
        assert_eq!(s2.deferred, 0, "410 is terminal, not deferred");
        assert!(s2.last_transient.is_none());
    }

    #[test]
    fn prepare_then_finalize_marks_synced_non_dirty() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        std::fs::create_dir_all(dir.path().join("knowledge")).unwrap();
        std::fs::write(dir.path().join("knowledge/x.md"), b"hello world\n").unwrap();

        let mut state = empty_state();

        let pu = prepare_upload(root, "knowledge/x.md", &state).unwrap();
        assert_eq!(pu.parent_version, 0, "new file → parentVersion 0");
        // Knowledge goes up as it is on disk — no envelope, so the two hashes
        // are the same thing said twice.
        assert_eq!(pu.blob, b"hello world\n");
        assert_eq!(pu.cipher_hash, pu.plain_hash);
        assert_eq!(pu.cipher_hash, sha256_hex(b"hello world\n"));

        let c = CompleteResult {
            version: 1,
            content_hash: pu.cipher_hash.clone(),
            change_seq: 5,
        };
        let mut stats = PhaseStats::default();
        finalize_upload(root, &pu, c, &mut state, &mut stats);

        assert_eq!(stats.pushed, 1);
        let fs = &state.files["knowledge/x.md"];
        assert_eq!(fs.synced_version, 1);
        assert!(!fs.dirty, "just-synced file must be clean");
        assert_eq!(fs.synced_cipher_hash, pu.cipher_hash);
        assert_eq!(fs.synced_plain_hash, pu.plain_hash);
    }

    #[tokio::test]
    async fn with_batch_retry_does_not_retry_batch_unsupported() {
        let calls = std::cell::Cell::new(0);
        let r: Result<(), SyncError> = with_batch_retry(|| {
            calls.set(calls.get() + 1);
            async { Err(SyncError::BatchUnsupported) }
        })
        .await;
        assert!(matches!(r, Err(SyncError::BatchUnsupported)));
        assert_eq!(calls.get(), 1, "404 is terminal — exactly one attempt");
    }

    #[tokio::test]
    async fn with_batch_retry_does_not_retry_non_transient() {
        let calls = std::cell::Cell::new(0);
        let r: Result<(), SyncError> = with_batch_retry(|| {
            calls.set(calls.get() + 1);
            async { Err(SyncError::Auth("forbidden".into())) }
        })
        .await;
        assert!(matches!(r, Err(SyncError::Auth(_))));
        assert_eq!(calls.get(), 1);
    }

    #[tokio::test]
    async fn with_batch_retry_retries_transient_then_succeeds() {
        let calls = std::cell::Cell::new(0);
        let r: Result<u8, SyncError> = with_batch_retry(|| {
            let n = calls.get();
            calls.set(n + 1);
            async move {
                if n == 0 {
                    Err(SyncError::Network("HTTP 429 Too Many Requests".into()))
                } else {
                    Ok(7u8)
                }
            }
        })
        .await;
        assert_eq!(r.unwrap(), 7);
        assert_eq!(calls.get(), 2, "one transient retry then success");
    }

    // ── re-add after delete ────────────────────────────────────────────────────

    #[test]
    fn mark_tombstoned_retains_entry_with_version() {
        let mut state = empty_state();
        state.files.insert("knowledge/a.md".into(), synced_file(3));
        // Delete bumps the server tombstone to v4.
        state.mark_tombstoned("knowledge/a.md", 4);
        let f = state
            .files
            .get("knowledge/a.md")
            .expect("entry must be RETAINED, not removed");
        assert!(f.deleted_local, "tombstone flagged deleted_local");
        assert_eq!(f.synced_version, 4, "tombstone version recorded");
        assert!(!f.dirty);
    }

    #[test]
    fn readd_after_tombstone_cas_against_tombstone_version_not_zero() {
        // Regression: re-creating a deleted path must CAS against the tombstone
        // version, not parentVersion=0 (which conflicts forever and never resurrects).
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        std::fs::create_dir_all(dir.path().join("knowledge")).unwrap();

        let mut state = empty_state();
        // File was synced at v1, then deleted → server tombstone at v2.
        state.files.insert("knowledge/x.md".into(), synced_file(1));
        state.mark_tombstoned("knowledge/x.md", 2);

        // User re-creates the same path.
        std::fs::write(dir.path().join("knowledge/x.md"), b"reborn\n").unwrap();

        // The tombstoned-but-present entry is selected for push (the all_dirty
        // readd filter), and it CAS-es against v2.
        assert!(state.files["knowledge/x.md"].deleted_local);
        let pu = prepare_upload(root, "knowledge/x.md", &state).unwrap();
        assert_eq!(
            pu.parent_version, 2,
            "re-add must CAS against the tombstone version, not 0"
        );
    }

    #[test]
    fn prepare_and_delete_payloads_carry_daemon_device_id() {
        let expected = crate::device_id::daemon_device_id();
        assert!(!expected.is_empty());

        let prep = prepare_batch_item_for("knowledge/a.md", 0, "abc", 3);
        let del = delete_batch_item_for("knowledge/a.md", 1);

        assert_eq!(prep.node_id.as_deref(), Some(expected.as_str()));
        assert_eq!(del.node_id.as_deref(), Some(expected.as_str()));

        let prep_json = serde_json::to_value(&prep).unwrap();
        assert_eq!(prep_json["nodeId"], expected);
        let del_json = serde_json::to_value(&del).unwrap();
        assert_eq!(del_json["nodeId"], expected);
    }
}
