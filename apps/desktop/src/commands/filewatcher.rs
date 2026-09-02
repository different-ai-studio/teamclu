use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

/// File change event sent to frontend, one per changed path.
///
/// Kept for the listeners that key off a single path (the open editor, the
/// team-config reloader, the skill watcher). The file tree does not use it any
/// more — it listens to [`FileChangeBatch`] and re-lists only what changed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChangeEvent {
    pub path: String,
    pub kind: String, // "create", "modify", "remove", "rename", "any"
}

/// Every path that changed in one debounce window, emitted once per window as
/// `file-change-batch`.
///
/// `directories` is the set of parent directories whose listing may differ
/// now — what a tree has to re-read to catch a create, delete or rename. A
/// file changing in place lands its parent here too; a directory listing does
/// not carry mtimes, so that re-list is a no-op for the tree, and cheap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChangeBatch {
    pub paths: Vec<String>,
    pub directories: Vec<String>,
}

/// Directory trees whose churn is never something the UI wants to hear about.
///
/// Dependency and build output: a `pnpm install` or a `cargo build` writes tens
/// of thousands of files under these, and before this list every one of them
/// woke every `file-change` listener in every window. Written as gitignore
/// patterns so the trailing slash means "directory", at any depth.
///
/// The workspace's own `.gitignore` is deliberately *not* applied. This app
/// writes `.teamclu/` and `opencode.json` into it (`ensureGitignoreEntries`),
/// and `.teamclu/teamclu.json` is exactly the file the team-config reloader and
/// the skill watcher listen for — honouring the user's ignore file would
/// silence the app's own config changes.
const IGNORED_TREE_PATTERNS: &[&str] = &[
    "node_modules/",
    ".git/",
    "target/",
    ".cargo-target*/",
    "dist/",
    ".next/",
    ".turbo/",
    "__pycache__/",
    ".venv/",
    ".DS_Store",
];

/// State for managing file watchers
pub struct FileWatcherState {
    watchers: Arc<Mutex<HashMap<String, WatcherHandle>>>,
}

struct WatcherHandle {
    /// Keep the debouncer alive so the watcher keeps running.
    /// Dropping this stops the watcher.
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
    /// Window labels currently subscribed to this path. The watcher is dropped
    /// only when the last subscriber unwatches — so closing window A doesn't
    /// kill window B's watcher when both watch the same workspace tree.
    subscribers: HashSet<String>,
}

impl Default for FileWatcherState {
    fn default() -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// The matcher that decides which changed paths under `root` are worth
/// reporting. `None` only if the patterns themselves fail to compile, which is
/// a programming error; the caller then reports everything rather than nothing.
fn build_ignore_matcher(root: &Path) -> Option<Gitignore> {
    let mut builder = GitignoreBuilder::new(root);
    for pattern in IGNORED_TREE_PATTERNS {
        builder.add_line(None, pattern).ok()?;
    }
    builder.build().ok()
}

/// Whether a change at `path` is noise per [`IGNORED_TREE_PATTERNS`].
///
/// A removed path cannot be stat'ed, so its own directory-ness is unknown and
/// taken as "file"; the check still walks its parents as directories, which is
/// where `node_modules/` and friends match.
fn is_ignored(matcher: Option<&Gitignore>, path: &Path) -> bool {
    let Some(matcher) = matcher else {
        return false;
    };
    matcher
        .matched_path_or_any_parents(path, path.is_dir())
        .is_ignore()
}

/// Collapse one debounce window's events into the batch the frontend gets.
///
/// Paths are deduplicated (the debouncer already coalesces per path, but a
/// rename reports both ends and both can hit the same parent), ignored trees
/// are dropped, and each survivor contributes its parent to `directories`.
/// Sorted so the output is deterministic, which the tests lean on.
fn collapse_events<I>(matcher: Option<&Gitignore>, changed: I) -> FileChangeBatch
where
    I: IntoIterator<Item = PathBuf>,
{
    let mut paths = BTreeSet::new();
    let mut directories = BTreeSet::new();
    for path in changed {
        if is_ignored(matcher, &path) {
            continue;
        }
        if let Some(parent) = path.parent() {
            directories.insert(parent.to_string_lossy().to_string());
        }
        paths.insert(path.to_string_lossy().to_string());
    }
    FileChangeBatch {
        paths: paths.into_iter().collect(),
        directories: directories.into_iter().collect(),
    }
}

/// Start watching a directory for file changes on behalf of the calling window.
///
/// If another window is already watching this path, the existing debouncer
/// is reused and the calling window's label is added as a subscriber. The
/// watcher is only torn down when the last subscriber unwatches.
#[tauri::command]
pub async fn watch_directory(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileWatcherState>,
    path: String,
) -> Result<bool, String> {
    let label = window.label().to_string();
    let mut watchers = state.watchers.lock().await;

    if let Some(handle) = watchers.get_mut(&path) {
        handle.subscribers.insert(label);
        return Ok(true);
    }

    let watch_path = PathBuf::from(&path);
    if !watch_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let app_handle = app.clone();
    let matcher = build_ignore_matcher(&watch_path);
    if matcher.is_none() {
        eprintln!("[FileWatcher] ignore patterns failed to compile; reporting every change");
    }

    // Create a debounced watcher with 500ms delay to batch rapid changes.
    //
    // The debouncer callback is synchronous and broadcasts to every window.
    // Per-window routing would require locking the subscribers map from inside
    // the callback (tokio::Mutex needs an async context), and the frontend
    // already filters by `path.startsWith(workspacePath)`. Tauri skips webviews
    // with no listener for the event, so the broadcast itself is cheap.
    //
    // Two emits per window: one `file-change` per surviving path for the
    // single-path listeners, then one `file-change-batch` carrying the whole
    // window for the tree. Before this it was one emit per event with nothing
    // filtered, so a `pnpm install` was thousands of wakeups.
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |result: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
            match result {
                Ok(events) => {
                    let batch =
                        collapse_events(matcher.as_ref(), events.into_iter().map(|e| e.path));
                    if batch.paths.is_empty() {
                        return;
                    }
                    for path in &batch.paths {
                        let change_event = FileChangeEvent {
                            path: path.clone(),
                            kind: "any".to_string(),
                        };
                        if let Err(e) = app_handle.emit("file-change", change_event) {
                            eprintln!("[FileWatcher] Failed to emit event: {}", e);
                        }
                    }
                    if let Err(e) = app_handle.emit("file-change-batch", batch) {
                        eprintln!("[FileWatcher] Failed to emit batch: {}", e);
                    }
                }
                Err(e) => {
                    eprintln!("[FileWatcher] Watch error: {:?}", e);
                }
            }
        },
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    debouncer
        .watcher()
        .watch(&watch_path, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    println!(
        "[FileWatcher] Started watching: {} (subscriber: {})",
        path, label
    );

    let mut subscribers = HashSet::new();
    subscribers.insert(label);
    watchers.insert(
        path,
        WatcherHandle {
            _debouncer: debouncer,
            subscribers,
        },
    );

    Ok(true)
}

/// Stop watching a directory on behalf of the calling window.
///
/// Decrements the subscriber set for the path. Only when the last subscriber
/// unwatches is the underlying debouncer dropped. Returns `true` if the path
/// was being watched (regardless of whether the watcher was actually stopped).
#[tauri::command]
pub async fn unwatch_directory(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileWatcherState>,
    path: String,
) -> Result<bool, String> {
    let label = window.label();
    let mut watchers = state.watchers.lock().await;

    let Some(handle) = watchers.get_mut(&path) else {
        return Ok(false);
    };

    handle.subscribers.remove(label);
    if handle.subscribers.is_empty() {
        watchers.remove(&path);
        println!(
            "[FileWatcher] Stopped watching: {} (last subscriber gone)",
            path
        );
    } else {
        println!(
            "[FileWatcher] Unsubscribed {} from {}; {} subscriber(s) remain",
            label,
            path,
            handle.subscribers.len()
        );
    }
    Ok(true)
}

/// Stop watching every directory the calling window has subscribed to.
///
/// Removes the calling window's label from every watcher. Watchers with no
/// remaining subscribers are dropped. Other windows' subscriptions are
/// preserved — this is what fixes the cross-window unwatch bug.
#[tauri::command]
pub async fn unwatch_all(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileWatcherState>,
) -> Result<(), String> {
    let label = window.label();
    let mut watchers = state.watchers.lock().await;

    let mut paths_to_drop: Vec<String> = Vec::new();
    for (path, handle) in watchers.iter_mut() {
        if handle.subscribers.remove(label) && handle.subscribers.is_empty() {
            paths_to_drop.push(path.clone());
        }
    }
    let dropped = paths_to_drop.len();
    for path in paths_to_drop {
        watchers.remove(&path);
    }
    println!(
        "[FileWatcher] Unsubscribed {} from all watchers; {} watcher(s) dropped",
        label, dropped
    );
    Ok(())
}

/// Get list of currently watched directories.
#[tauri::command]
pub async fn get_watched_directories(
    state: tauri::State<'_, FileWatcherState>,
) -> Result<Vec<String>, String> {
    let watchers = state.watchers.lock().await;
    Ok(watchers.keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\ws")
        } else {
            PathBuf::from("/ws")
        }
    }

    fn batch(paths: &[&str]) -> FileChangeBatch {
        let root = root();
        let matcher = build_ignore_matcher(&root).expect("patterns compile");
        collapse_events(Some(&matcher), paths.iter().map(|p| root.join(p)))
    }

    #[test]
    fn dependency_and_build_trees_are_dropped_at_any_depth() {
        let b = batch(&[
            "node_modules/react/index.js",
            "packages/app/node_modules/.pnpm/x/y.js",
            ".git/index.lock",
            "target/debug/deps/foo.rlib",
            ".cargo-target-audit/debug/x",
            "apps/web/dist/main.js",
            "src/main.rs",
        ]);
        assert_eq!(
            b.paths,
            vec![root().join("src/main.rs").to_string_lossy().to_string()]
        );
        assert_eq!(
            b.directories,
            vec![root().join("src").to_string_lossy().to_string()]
        );
    }

    #[test]
    fn a_top_level_file_reports_the_root_as_its_directory() {
        let b = batch(&["README.md"]);
        assert_eq!(b.directories, vec![root().to_string_lossy().to_string()]);
    }

    #[test]
    fn siblings_share_one_directory_entry_and_paths_dedupe() {
        let b = batch(&["src/a.rs", "src/b.rs", "src/a.rs"]);
        assert_eq!(b.paths.len(), 2);
        assert_eq!(
            b.directories,
            vec![root().join("src").to_string_lossy().to_string()]
        );
    }

    #[test]
    fn app_owned_dot_directories_are_not_ignored() {
        // The point of not applying the workspace .gitignore: these are what
        // the team-config reloader and skill watcher listen for.
        let b = batch(&[".teamclu/teamclu.json", ".teamclu/skills/x/SKILL.md"]);
        assert_eq!(b.paths.len(), 2);
    }

    #[test]
    fn a_missing_matcher_reports_everything() {
        let root = root();
        let b = collapse_events(None, vec![root.join("node_modules/x.js")]);
        assert_eq!(b.paths.len(), 1);
    }

    #[test]
    fn an_all_noise_window_is_empty() {
        let b = batch(&["node_modules/a.js", ".git/HEAD"]);
        assert!(b.paths.is_empty());
        assert!(b.directories.is_empty());
    }
}
