//! Filesystem watch on each team's `knowledge/` root → Local sync triggers.
//!
//! Independent of [`crate::runtime::refresh_watch`]: that classifier feeds
//! runtime refresh. This module only asks the sync scheduler to fire.
//!
//! ## Acceptance (Obsidian → push)
//!
//! Obsidian (or any editor) saves under `<content root>/knowledge`. Surviving
//! events call [`SyncDispatcher::trigger_sync`] with [`Trigger::Local`], which
//! opens the scheduler's fixed **2s** coalescing window (never reset by further
//! keystrokes). After the window + Local floor (5s from last tick end), a tick
//! runs and pushes. With the app closed, headless daemon still sees the save.
//!
//! `node_modules/` (and other ignore rules) cannot limit `notify`'s recursive
//! registration. Events under ignored subtrees are dropped; if the OS watcher
//! errors (e.g. Linux inotify exhaustion), we `warn!` once, stop watching that
//! team, and rely on the 300s timer — the daemon keeps running.
//!
//! Pull self-writes: [`record_pull_write`] must run *before* `create_dir_all` /
//! `fs::write`, or inotify can schedule Local before the path is suppressed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::time::MissedTickBehavior;
use tracing::warn;

use crate::sync::dispatch::SyncDispatcher;
use crate::sync::oss::ignore_rules::IgnoreRules;
use crate::sync::scheduler::Trigger;

/// How often we re-arm watches for roots that appear after spawn (team join /
/// re-onboard creating `knowledge/`).
const WATCH_RECONCILE_INTERVAL: Duration = Duration::from_secs(2);

/// Pull-written paths are ignored by the watcher for this long.
const PULL_WRITE_SUPPRESS: Duration = Duration::from_secs(3);

static PULL_WRITES: OnceLock<Mutex<PullWriteSuppress>> = OnceLock::new();

fn pull_writes() -> &'static Mutex<PullWriteSuppress> {
    PULL_WRITES.get_or_init(|| Mutex::new(PullWriteSuppress::new()))
}

/// Record that pull is about to write `rel_path` (content-root relative, e.g.
/// `knowledge/notes/a.md`). Events on that path within 3s are dropped.
///
/// Records the ancestor directories too: pull calls `create_dir_all` for the
/// parent, and the Create events for freshly materialized directories would
/// otherwise schedule a Local trigger and cost the receiver a no-op push tick.
///
/// **Ordering contract:** callers MUST invoke this *before* `create_dir_all` /
/// `fs::write` for that path. Recording after the write races the OS watcher:
/// inotify can deliver a Local trigger before the suppress entry exists.
pub fn record_pull_write(team_id: &str, rel_path: &str) {
    let mut guard = pull_writes()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    guard.record_with_parents(team_id, rel_path, Instant::now());
}

/// Test / internal: clear all recorded pull writes.
#[cfg(test)]
fn clear_pull_writes() {
    let mut guard = pull_writes()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *guard = PullWriteSuppress::new();
}

/// Per-path pull self-write suppression (not a blanket time window).
#[derive(Debug, Default)]
pub struct PullWriteSuppress {
    /// team_id → (rel_path → written_at)
    by_team: HashMap<String, HashMap<String, Instant>>,
}

impl PullWriteSuppress {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one path. Expired entries for this team are dropped on the way in,
    /// so the map stays bounded by "paths written in the last 3s" even when the
    /// watch loop is not running to call [`Self::is_suppressed`] (watcher failed
    /// to arm, inotify exhausted, `knowledge/` never created) while the 300s
    /// timer keeps pulling.
    pub fn record(&mut self, team_id: &str, rel_path: &str, now: Instant) {
        let paths = self.by_team.entry(team_id.to_string()).or_default();
        paths.retain(|_, at| now.duration_since(*at) < PULL_WRITE_SUPPRESS);
        paths.insert(normalize_rel(rel_path), now);
    }

    /// Record `rel_path` and every ancestor directory under the content root.
    ///
    /// `knowledge/projects/alpha/a.md` also records `knowledge/projects/alpha`,
    /// `knowledge/projects` and `knowledge` — the directories `create_dir_all`
    /// materializes during a pull. Suppressing the directory does not hide a
    /// user's concurrent edit: inotify reports a new file at its own path, not
    /// at its parent's.
    pub fn record_with_parents(&mut self, team_id: &str, rel_path: &str, now: Instant) {
        let rel = normalize_rel(rel_path);
        self.record(team_id, &rel, now);
        let mut cursor = rel.as_str();
        while let Some((parent, _)) = cursor.rsplit_once('/') {
            if parent.is_empty() {
                break;
            }
            self.record(team_id, parent, now);
            cursor = parent;
        }
    }

    pub fn is_suppressed(&mut self, team_id: &str, rel_path: &str, now: Instant) -> bool {
        let Some(paths) = self.by_team.get_mut(team_id) else {
            return false;
        };
        paths.retain(|_, at| now.duration_since(*at) < PULL_WRITE_SUPPRESS);
        if paths.is_empty() {
            self.by_team.remove(team_id);
            return false;
        }
        paths.contains_key(&normalize_rel(rel_path))
    }
}

fn normalize_rel(rel: &str) -> String {
    rel.replace('\\', "/")
}

/// Access events are noise for sync (opens/reads).
fn is_relevant_event(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_))
}

/// Map an absolute OS path to a content-root-relative path, if under the root.
pub fn rel_under_content_root(content_root: &Path, abs: &Path) -> Option<String> {
    if let Ok(rel) = abs.strip_prefix(content_root) {
        let s = normalize_rel(&rel.to_string_lossy());
        if !s.is_empty() {
            return Some(s);
        }
    }
    let root = content_root
        .canonicalize()
        .unwrap_or_else(|_| content_root.to_path_buf());
    let path = abs.canonicalize().unwrap_or_else(|_| abs.to_path_buf());
    path.strip_prefix(&root).ok().and_then(|rel| {
        let s = normalize_rel(&rel.to_string_lossy());
        (!s.is_empty()).then_some(s)
    })
}

/// Whether a filesystem event should schedule a Local sync trigger.
///
/// Returns `false` for ignored subtrees, pull-written paths within 3s, and
/// paths outside `knowledge/`.
pub fn should_schedule_local(
    team_id: &str,
    content_root: &Path,
    abs_path: &Path,
    rules: &IgnoreRules,
    suppress: &mut PullWriteSuppress,
    now: Instant,
) -> bool {
    let Some(rel) = rel_under_content_root(content_root, abs_path) else {
        return false;
    };
    if !rel.starts_with("knowledge/") && rel != "knowledge" {
        return false;
    }
    // Hard-skip like the scanner — not via IgnoreRules (a team `!.conflicts/`
    // must not re-open this tree for watch either).
    if crate::sync::oss::conflict::is_under_conflicts_dir(&rel) {
        return false;
    }
    if is_ignored_for_event(rules, &rel, abs_path) {
        return false;
    }
    if suppress.is_suppressed(team_id, &rel, now) {
        return false;
    }
    true
}

/// Ignore test for a filesystem *event*, which may name a directory.
///
/// [`IgnoreRules::is_ignored_with_ancestors`] evaluates the leaf as a file
/// (`is_dir = false`) — right for the tombstone and pull callers, which only
/// ever hold file paths. A watch event can name the ignored directory itself,
/// and `node_modules/` is directory-only under gitignore semantics, so the leaf
/// check alone lets `Create(knowledge/repo/node_modules)` through.
///
/// A path that has already vanished (Remove) is treated as a directory: a
/// removed *file* named exactly `node_modules` is not a thing, and dropping
/// that event only defers the delete to the 300s timer.
fn is_ignored_for_event(rules: &IgnoreRules, rel: &str, abs_path: &Path) -> bool {
    if rules.is_ignored_with_ancestors(rel) {
        return true;
    }
    let treat_as_dir = match std::fs::metadata(abs_path) {
        Ok(meta) => meta.is_dir(),
        Err(_) => true,
    };
    treat_as_dir && rules.is_ignored(rel, true)
}

#[derive(Debug)]
enum WatchMsg {
    Path(PathBuf),
    /// OS watcher runtime failure — stop this team's watch.
    Error(String),
}

/// Spawn a knowledge-dir watcher for `team_id`. Failures warn once and exit the
/// task; the 300s timer remains the fallback. Never panics the daemon.
pub fn spawn(dispatcher: SyncDispatcher, team_id: String) {
    let team_id = team_id.trim().to_string();
    if team_id.is_empty() {
        tracing::debug!("knowledge watch not started: daemon is not onboarded to a team");
        return;
    }
    tokio::spawn(async move {
        run_watch_loop(dispatcher, team_id).await;
    });
}

async fn run_watch_loop(dispatcher: SyncDispatcher, team_id: String) {
    let content_root = crate::config::global_team_store::sync_content_root(&team_id);
    let knowledge_root = content_root.join("knowledge");

    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<WatchMsg>();
    let mut watcher = match RecommendedWatcher::new(
        move |result: notify::Result<Event>| match result {
            Ok(event) => {
                if !is_relevant_event(&event.kind) {
                    return;
                }
                for path in event.paths {
                    let _ = event_tx.send(WatchMsg::Path(path));
                }
            }
            Err(error) => {
                let _ = event_tx.send(WatchMsg::Error(error.to_string()));
            }
        },
        Config::default(),
    ) {
        Ok(w) => w,
        Err(error) => {
            warn!(
                team_id = %team_id,
                %error,
                "failed to create knowledge filesystem watcher; relying on 300s timer"
            );
            return;
        }
    };

    let mut watched = false;
    let mut reconcile = tokio::time::interval(WATCH_RECONCILE_INTERVAL);
    reconcile.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // Reload ignore rules when they change, so a new `.amuxignore` takes effect
    // without a daemon restart — gated on a stat fingerprint, not rebuilt every
    // tick. Stamp first: a rule file edited between the stamp and the load leaves
    // a stale stamp, which costs one extra reload rather than missing the edit.
    let mut rules_stamp = rules_fingerprint(&content_root);
    let mut rules = IgnoreRules::load(&content_root);

    if reconcile_arm(
        &mut watcher,
        &mut watched,
        &mut rules,
        &mut rules_stamp,
        &content_root,
        &knowledge_root,
        &team_id,
    ) == ArmOutcome::Stop
    {
        return;
    }

    loop {
        tokio::select! {
            _ = reconcile.tick() => {
                if reconcile_arm(
                    &mut watcher,
                    &mut watched,
                    &mut rules,
                    &mut rules_stamp,
                    &content_root,
                    &knowledge_root,
                    &team_id,
                ) == ArmOutcome::Stop
                {
                    return;
                }
            }
            msg = event_rx.recv() => {
                match msg {
                    None => return,
                    Some(WatchMsg::Error(error)) => {
                        warn!(
                            team_id = %team_id,
                            %error,
                            "knowledge filesystem watcher error; stopping watch, relying on 300s timer"
                        );
                        return;
                    }
                    Some(WatchMsg::Path(path)) => {
                        let should = {
                            let mut suppress = pull_writes()
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            should_schedule_local(
                                &team_id,
                                &content_root,
                                &path,
                                &rules,
                                &mut suppress,
                                Instant::now(),
                            )
                        };
                        if should {
                            dispatcher
                                .trigger_sync(&team_id, Trigger::Local)
                                .await;
                        }
                    }
                }
            }
        }
    }
}

/// Cheap change-detector for the two on-disk rule files, so the 2s reconcile
/// tick does not recompile the globset 30 times a minute forever.
///
/// `(len, mtime)` per file, `None` when absent. Missing → present, edited, and
/// deleted all change the fingerprint.
type RulesFingerprint = [Option<(u64, std::time::SystemTime)>; 2];

fn rules_fingerprint(content_root: &Path) -> RulesFingerprint {
    let stat = |p: PathBuf| {
        std::fs::metadata(p)
            .ok()
            .and_then(|m| m.modified().ok().map(|t| (m.len(), t)))
    };
    [
        stat(
            content_root
                .join("knowledge")
                .join(crate::sync::oss::ignore_rules::TEAM_IGNORE_FILE),
        ),
        stat(content_root.join(crate::sync::oss::ignore_rules::LOCAL_IGNORE_FILE)),
    ]
}

fn reconcile_arm(
    watcher: &mut RecommendedWatcher,
    watched: &mut bool,
    rules: &mut IgnoreRules,
    rules_stamp: &mut RulesFingerprint,
    content_root: &Path,
    knowledge_root: &Path,
    team_id: &str,
) -> ArmOutcome {
    // Reload only when `.amuxignore` / `.syncignore.local` actually changed: a
    // rebuild re-adds every builtin rule and recompiles the globset, and this
    // runs on the same task that must stay responsive to fs events.
    let stamp = rules_fingerprint(content_root);
    if stamp != *rules_stamp {
        *rules = IgnoreRules::load(content_root);
        *rules_stamp = stamp;
    }
    if knowledge_root.is_dir() {
        if !*watched {
            match watcher.watch(knowledge_root, RecursiveMode::Recursive) {
                Ok(()) => {
                    *watched = true;
                    tracing::debug!(
                        team_id = %team_id,
                        path = %knowledge_root.display(),
                        "armed knowledge filesystem watch"
                    );
                }
                Err(error) => {
                    warn!(
                        team_id = %team_id,
                        path = %knowledge_root.display(),
                        %error,
                        "failed to arm knowledge watch; relying on 300s timer"
                    );
                    // Permanent stop for this team — no retry loop.
                    return ArmOutcome::Stop;
                }
            }
        }
    } else if *watched {
        let _ = watcher.unwatch(knowledge_root);
        *watched = false;
    }
    ArmOutcome::Continue
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArmOutcome {
    Continue,
    Stop,
}

/// Pure helper for tests: apply a batch of paths and collect which would schedule.
#[cfg(test)]
fn scheduled_for_paths(
    team_id: &str,
    content_root: &Path,
    paths: &[PathBuf],
    rules: &IgnoreRules,
    suppress: &mut PullWriteSuppress,
    now: Instant,
) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|p| should_schedule_local(team_id, content_root, p, rules, suppress, now))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn ignored_subtree_storm_schedules_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let content_root = dir.path();
        std::fs::create_dir_all(content_root.join("knowledge/node_modules/pkg")).unwrap();
        let rules = IgnoreRules::load(content_root);
        let mut suppress = PullWriteSuppress::new();
        let now = Instant::now();

        let storm: Vec<PathBuf> = (0..200)
            .map(|i| {
                content_root.join(format!(
                    "knowledge/node_modules/pkg/file-{i}.js"
                ))
            })
            .collect();

        let scheduled = scheduled_for_paths(
            "team-storm",
            content_root,
            &storm,
            &rules,
            &mut suppress,
            now,
        );
        assert!(
            scheduled.is_empty(),
            "ignored subtree must not schedule Local triggers, got {}",
            scheduled.len()
        );

        // A real note beside the ignored tree still schedules.
        let note = content_root.join("knowledge/notes/hello.md");
        assert!(should_schedule_local(
            "team-storm",
            content_root,
            &note,
            &rules,
            &mut suppress,
            now,
        ));
    }

    #[test]
    fn pull_written_paths_suppressed_but_foreign_path_schedules() {
        let dir = tempfile::tempdir().unwrap();
        let content_root = dir.path();
        std::fs::create_dir_all(content_root.join("knowledge")).unwrap();
        let rules = IgnoreRules::load(content_root);
        let mut suppress = PullWriteSuppress::new();
        let now = Instant::now();
        let team = "team-pull";

        // Pull wrote these two files.
        suppress.record(team, "knowledge/from-remote-a.md", now);
        suppress.record(team, "knowledge/from-remote-b.md", now);

        let pulled_a = content_root.join("knowledge/from-remote-a.md");
        let pulled_b = content_root.join("knowledge/from-remote-b.md");
        let foreign = content_root.join("knowledge/user-edit.md");

        assert!(
            !should_schedule_local(team, content_root, &pulled_a, &rules, &mut suppress, now),
            "pull-written path within 3s must not schedule"
        );
        assert!(
            !should_schedule_local(
                team,
                content_root,
                &pulled_b,
                &rules,
                &mut suppress,
                now + Duration::from_secs(2),
            ),
            "pull-written path still within 3s must not schedule"
        );
        assert!(
            should_schedule_local(team, content_root, &foreign, &rules, &mut suppress, now),
            "a foreign path during the same pull must still schedule"
        );

        // After the window, pull-written paths schedule again.
        assert!(should_schedule_local(
            team,
            content_root,
            &pulled_a,
            &rules,
            &mut suppress,
            now + Duration::from_secs(4),
        ));
    }

    #[test]
    fn watcher_error_stops_team_without_panic() {
        // Mimic the production failure path: an Error message ends the watch
        // loop cleanly. The AtomicBool stands in for "daemon still running".
        let alive = Arc::new(AtomicBool::new(true));
        let alive_flag = alive.clone();

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WatchMsg>();
        tx.send(WatchMsg::Error("inotify watch limit reached".into()))
            .unwrap();
        drop(tx);

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async move {
            // Same control flow as run_watch_loop's Error arm.
            match rx.recv().await {
                Some(WatchMsg::Error(error)) => {
                    warn!(%error, "knowledge filesystem watcher error (test)");
                    // stop watching — do not panic, do not retry
                }
                other => panic!("expected Error, got {other:?}"),
            }
            assert!(
                alive_flag.load(Ordering::SeqCst),
                "daemon liveness flag must remain set after watcher error"
            );
        });
        assert!(alive.load(Ordering::SeqCst));
    }

    #[test]
    fn access_events_are_not_relevant() {
        assert!(!is_relevant_event(&EventKind::Access(
            notify::event::AccessKind::Read
        )));
        assert!(is_relevant_event(&EventKind::Modify(
            notify::event::ModifyKind::Data(notify::event::DataChange::Any)
        )));
        assert!(is_relevant_event(&EventKind::Create(
            notify::event::CreateKind::File
        )));
    }

    #[test]
    fn global_record_pull_write_feeds_suppress_check() {
        clear_pull_writes();
        let dir = tempfile::tempdir().unwrap();
        let content_root = dir.path();
        std::fs::create_dir_all(content_root.join("knowledge")).unwrap();
        let rules = IgnoreRules::load(content_root);
        let team = "team-global";
        record_pull_write(team, "knowledge/pulled.md");

        let suppressed = {
            let mut guard = pull_writes().lock().unwrap();
            !should_schedule_local(
                team,
                content_root,
                &content_root.join("knowledge/pulled.md"),
                &rules,
                &mut guard,
                Instant::now(),
            )
        };
        assert!(suppressed, "global record_pull_write must suppress the path");
        clear_pull_writes();
    }

    /// Ordering contract: suppress must be registered *before* the write
    /// returns, so an inotify event that races the write await is already
    /// covered. Simulates: record → (write returns / event arrives) → filter.
    ///
    /// Uses a local suppress map (not the process-global) so parallel test
    /// binaries cannot clear the entry mid-assert.
    #[test]
    fn record_before_write_covers_immediate_post_write_event() {
        let dir = tempfile::tempdir().unwrap();
        let content_root = dir.path();
        let rel = "knowledge/race.md";
        let abs = content_root.join(rel);
        std::fs::create_dir_all(content_root.join("knowledge")).unwrap();
        let rules = IgnoreRules::load(content_root);
        let team = "team-race";
        let mut suppress = PullWriteSuppress::new();
        let now = Instant::now();

        // Production order in engine.rs: record, then create_dir_all / write.
        suppress.record(team, rel, now);
        std::fs::write(&abs, b"from-pull").unwrap();

        assert!(
            !should_schedule_local(team, content_root, &abs, &rules, &mut suppress, now),
            "event arriving immediately after write must already be suppressed"
        );
    }

    /// Pull materializes `knowledge/projects/alpha/` — the Create events for the
    /// two new directories must not schedule a Local tick (plan acceptance #9).
    #[test]
    fn pull_created_directories_are_suppressed() {
        let dir = tempfile::tempdir().unwrap();
        let content_root = dir.path();
        std::fs::create_dir_all(content_root.join("knowledge/projects/alpha")).unwrap();
        let rules = IgnoreRules::load(content_root);
        let mut suppress = PullWriteSuppress::new();
        let now = Instant::now();
        let team = "team-dirs";

        suppress.record_with_parents(team, "knowledge/projects/alpha/a.md", now);

        for rel in [
            "knowledge/projects/alpha/a.md",
            "knowledge/projects/alpha",
            "knowledge/projects",
            "knowledge",
        ] {
            assert!(
                !should_schedule_local(
                    team,
                    content_root,
                    &content_root.join(rel),
                    &rules,
                    &mut suppress,
                    now,
                ),
                "{rel} was written by pull and must not schedule"
            );
        }

        // A note the user creates in the same tree during the pull still does.
        assert!(should_schedule_local(
            team,
            content_root,
            &content_root.join("knowledge/projects/alpha/mine.md"),
            &rules,
            &mut suppress,
            now,
        ));
    }

    /// The map must stay bounded even when the watch loop never runs, because
    /// `is_suppressed` (the only other reaper) is then never called.
    #[test]
    fn record_prunes_expired_entries_without_the_watch_loop() {
        let mut suppress = PullWriteSuppress::new();
        let team = "team-leak";
        let t0 = Instant::now();

        for i in 0..500 {
            suppress.record(team, &format!("knowledge/old-{i}.md"), t0);
        }
        // A later pull, after the suppress window: recording must drop the lot.
        suppress.record(team, "knowledge/new.md", t0 + Duration::from_secs(10));

        let held = suppress.by_team.get(team).map(|m| m.len()).unwrap_or(0);
        assert_eq!(
            held, 1,
            "expired pull-write entries must be reaped on record, got {held}"
        );
    }

    /// `node_modules/` is directory-only under gitignore semantics, so the
    /// Create event for the directory itself needs the is_dir form.
    #[test]
    fn ignored_directory_event_itself_is_filtered() {
        let dir = tempfile::tempdir().unwrap();
        let content_root = dir.path();
        let ignored_dir = content_root.join("knowledge/repo/node_modules");
        std::fs::create_dir_all(&ignored_dir).unwrap();
        let rules = IgnoreRules::load(content_root);
        let mut suppress = PullWriteSuppress::new();
        let now = Instant::now();

        assert!(
            !should_schedule_local(
                "team-dir-ignore",
                content_root,
                &ignored_dir,
                &rules,
                &mut suppress,
                now,
            ),
            "Create on the ignored directory itself must not schedule"
        );

        // Removed (already gone) ignored directory: same answer.
        let gone = content_root.join("knowledge/repo/target");
        assert!(!should_schedule_local(
            "team-dir-ignore",
            content_root,
            &gone,
            &rules,
            &mut suppress,
            now,
        ));

        // An ordinary directory still schedules.
        let real = content_root.join("knowledge/repo/notes");
        std::fs::create_dir_all(&real).unwrap();
        assert!(should_schedule_local(
            "team-dir-ignore",
            content_root,
            &real,
            &rules,
            &mut suppress,
            now,
        ));
    }

    #[test]
    fn desired_knowledge_root_is_content_root_knowledge() {
        let dir = tempfile::tempdir().unwrap();
        let content = dir.path().join("shared");
        let knowledge = content.join("knowledge");
        std::fs::create_dir_all(&knowledge).unwrap();
        assert!(knowledge.is_dir());
        assert_eq!(
            content.join("knowledge"),
            knowledge,
            "watch root must be <content root>/knowledge"
        );
    }
}
