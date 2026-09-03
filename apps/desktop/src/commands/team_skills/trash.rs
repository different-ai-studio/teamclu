//! The local trash: where a discarded or retired skill goes, the recovery
//! record that lets it come back, and the pruning that bounds both.

use super::types::DraftRecoveryRecord;
use crate::commands::clawhub::now_millis;
use std::collections::BTreeSet;
use teamclu_skillpack::read_origin;

/// Discarded packs land here — outside `~/.agents/skills` on purpose, so the
/// skill loaders and the daemon's file watcher never see them.
pub(super) fn trash_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "HOME directory not found".to_string())?;
    Ok(home.join(".agents").join(".skill-trash"))
}

/// How long a discarded pack stays recoverable, and how many are kept.
///
/// The undo in the conflict UI lives for the length of a toast, so anything
/// beyond that is insurance against a user who realises tomorrow. Keeping it
/// forever is not more generous — skill packs carry binaries and reference
/// material, and an unbounded directory nobody can see is how a few hundred
/// megabytes accumulates in a home folder with no way to attribute it.
pub(super) const TRASH_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
pub(super) const TRASH_MAX_ENTRIES: usize = 20;

/// Drop trashed packs that are past the retention window or past the count.
///
/// Both bounds are needed. Age alone lets a bad afternoon leave fifty packs
/// sitting there for a week; count alone lets two forgotten packs live forever.
///
/// Timestamps come from the directory name rather than mtime: the name is what
/// we wrote, and `rename` preserves whatever mtime the pack already had, which
/// can predate the discard by months. An entry whose name we cannot parse is
/// left alone — it is not ours to guess about.
pub(super) fn prune_trash(trash: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(trash) else {
        return;
    };
    let mut dated: Vec<(u64, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(stamp) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.rsplit_once('-'))
            .and_then(|(_, ts)| ts.parse::<u64>().ok())
        else {
            continue;
        };
        dated.push((stamp, path));
    }

    // Newest first, so the survivors are a prefix.
    dated.sort_by_key(|(stamp, _)| std::cmp::Reverse(*stamp));
    let now = now_millis();
    for (index, (stamp, path)) in dated.into_iter().enumerate() {
        if index < TRASH_MAX_ENTRIES && now.saturating_sub(stamp) < TRASH_TTL_MS {
            continue;
        }
        let _ = std::fs::remove_dir_all(&path);
    }
}

pub(super) fn recovery_record_for_path(source: &std::path::Path) -> Option<DraftRecoveryRecord> {
    let sidecar = source.join(".clawhub").join("recovery.json");
    if sidecar.is_file() {
        if let Ok(text) = std::fs::read_to_string(&sidecar) {
            if let Ok(rec) = serde_json::from_str::<DraftRecoveryRecord>(&text) {
                return Some(rec);
            }
        }
    }
    let trash = trash_dir().ok()?;
    let log = trash.join("recovery.jsonl");
    if !log.is_file() {
        return None;
    }
    let canonical = std::fs::canonicalize(source).ok()?;
    let content = std::fs::read_to_string(&log).ok()?;
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<DraftRecoveryRecord>(line).ok())
        .find(|rec| {
            std::fs::canonicalize(&rec.path)
                .ok()
                .is_some_and(|p| p == canonical)
        })
}

/// Load recovery records from trash sidecars and the JSONL index.
///
/// Sidecars are authoritative; JSONL is a rebuildable cache for fast listing.
pub(super) fn load_draft_recovery_records(trash: &std::path::Path) -> Vec<DraftRecoveryRecord> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();

    let mut push = |rec: DraftRecoveryRecord| {
        if !std::path::Path::new(&rec.path).is_dir() {
            return;
        }
        if seen.insert(rec.path.clone()) {
            out.push(rec);
        }
    };

    if let Ok(entries) = std::fs::read_dir(trash) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let sidecar = path.join(".clawhub").join("recovery.json");
            if !sidecar.is_file() {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&sidecar) {
                if let Ok(rec) = serde_json::from_str::<DraftRecoveryRecord>(&text) {
                    push(rec);
                }
            }
        }
    }

    let log = trash.join("recovery.jsonl");
    if log.is_file() {
        if let Ok(content) = std::fs::read_to_string(&log) {
            for line in content.lines() {
                if let Ok(rec) = serde_json::from_str::<DraftRecoveryRecord>(line) {
                    push(rec);
                }
            }
        }
    }

    out
}

/// Move a skill directory into the trash and return where it went.
///
/// Every path that takes something away from the user goes through here rather
/// than `remove_dir_all`, so "undo" is always a rename back rather than a
/// restore from nothing.
pub(super) fn move_to_trash(
    target: &std::path::Path,
    slug: &str,
    recovery: Option<DraftRecoveryContext>,
) -> Result<String, String> {
    let trash = trash_dir()?;
    std::fs::create_dir_all(&trash).map_err(|e| format!("Failed to create trash dir: {}", e))?;
    let dest = trash.join(format!("{}-{}", slug, now_millis()));
    std::fs::rename(target, &dest).map_err(|e| format!("Failed to move skill aside: {}", e))?;
    if let Some(ctx) = recovery {
        let rec = DraftRecoveryRecord {
            slug: slug.to_string(),
            path: dest.display().to_string(),
            at: now_millis(),
            reason: ctx.reason,
            base_version: ctx.base_version,
            team_id: ctx.team_id,
        };
        if let Err(e) = record_draft_recovery(&dest, &rec) {
            // Undo depends on recovery metadata; without it the pack would sit in
            // trash invisibly. Put it back where the user left it.
            if let Err(rollback) = std::fs::rename(&dest, target) {
                return Err(format!(
                    "{e}; failed to restore skill after recovery write error: {rollback}"
                ));
            }
            return Err(e);
        }
    }
    // Swept here rather than on a timer: this is the only thing that ever adds
    // to the directory, so it is the only place that can let it grow.
    prune_trash(&trash);
    Ok(dest.display().to_string())
}

#[derive(Debug, Clone)]
pub(super) struct DraftRecoveryContext {
    pub(super) reason: String,
    pub(super) base_version: Option<i64>,
    pub(super) team_id: Option<String>,
}

pub(super) fn record_draft_recovery(
    dest: &std::path::Path,
    rec: &DraftRecoveryRecord,
) -> Result<(), String> {
    let sidecar_dir = dest.join(".clawhub");
    std::fs::create_dir_all(&sidecar_dir)
        .map_err(|e| format!("Failed to write recovery metadata: {}", e))?;
    let line = serde_json::to_string(rec)
        .map_err(|e| format!("Failed to serialize recovery metadata: {}", e))?;
    std::fs::write(sidecar_dir.join("recovery.json"), &line)
        .map_err(|e| format!("Failed to write recovery metadata: {}", e))?;

    append_recovery_log(rec);
    Ok(())
}

/// Best-effort index append; listing can rebuild from sidecars.
fn append_recovery_log(rec: &DraftRecoveryRecord) {
    let Ok(trash) = trash_dir() else {
        return;
    };
    let log = trash.join("recovery.jsonl");
    let Ok(line) = serde_json::to_string(rec) else {
        return;
    };
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "{line}")
        });
}

pub(super) fn draft_recovery_context(
    target: &std::path::Path,
    reason: &str,
    team_id: Option<&str>,
) -> DraftRecoveryContext {
    let base_version = read_origin(target).and_then(|o| o.installed_version.parse::<i64>().ok());
    DraftRecoveryContext {
        reason: reason.to_string(),
        base_version,
        team_id: team_id.map(str::to_string),
    }
}

/// Resolve a caller-supplied backup path, refusing anything that is not really
/// inside our own trash.
///
/// The path arrives from the frontend and is used as the source of a `rename`
/// into the skills directory, so a permissive check here is a way to move an
/// arbitrary directory. `Path::starts_with` alone is not that check: it is
/// purely lexical, so `<trash>/../../elsewhere` matches the prefix while naming
/// somewhere else entirely. Canonicalising both sides collapses the `..`
/// segments and resolves symlinks, and it fails outright on a path that does
/// not exist — which is the other case this has to reject.
pub(super) fn resolve_trashed_source(
    trash: &std::path::Path,
    raw: &str,
) -> Result<std::path::PathBuf, String> {
    let reject = || "Not a restorable skill backup".to_string();
    let source = std::fs::canonicalize(raw).map_err(|_| reject())?;
    let root = std::fs::canonicalize(trash).map_err(|_| reject())?;
    if !source.is_dir() || source == root || !source.starts_with(&root) {
        return Err(reject());
    }
    Ok(source)
}
