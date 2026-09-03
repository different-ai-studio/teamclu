use std::path::{Component, Path, PathBuf};

#[derive(Debug, serde::Serialize)]
pub struct WorkspaceDirectoryEntry {
    name: String,
    path: String,
    #[serde(rename = "type")]
    kind: String,
}

fn normalize_absolute_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("Path must be absolute: {}", path.display()));
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!("Path escapes root: {}", path.display()));
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }

    Ok(normalized)
}

fn resolve_workspace_view_path(workspace_path: &str, path: &str) -> Result<PathBuf, String> {
    let normalized_workspace = normalize_absolute_path(Path::new(workspace_path))?;
    let normalized_target = normalize_absolute_path(Path::new(path))?;

    if !normalized_target.starts_with(&normalized_workspace) {
        return Err(format!(
            "Path is outside workspace view: {}",
            normalized_target.display()
        ));
    }

    Ok(normalized_target)
}

/// Classify a directory entry as `"directory"` or `"file"`, **following
/// symlinks**.
///
/// A symlink that resolves to a directory must browse as a directory — e.g. the
/// per-workspace `teamclu-team` link into the daemon's global team dir
/// (`~/.amuxd/teams/<id>/teamclu-team`). The previous
/// `metadata().or_else(symlink_metadata)` form silently degraded *any* symlink
/// whose `metadata()` (follow) call failed into a plain `"file"`, so a
/// symlinked directory that momentarily failed to stat would render in the file
/// tree as an unexpandable file — with no chevron and no way to browse into it.
///
/// Here we follow explicitly. When the follow fails we still probe `read_dir`
/// before giving up, and log the underlying error so a genuine
/// permission/resolution failure is *visible* instead of being silently
/// mislabeled as a file.
fn classify_entry(entry_path: &Path) -> Result<&'static str, String> {
    let lmeta = std::fs::symlink_metadata(entry_path)
        .map_err(|e| format!("Failed to read metadata '{}': {}", entry_path.display(), e))?;

    if !lmeta.file_type().is_symlink() {
        return Ok(if lmeta.is_dir() { "directory" } else { "file" });
    }

    // Symlink: classify by the target it resolves to.
    match std::fs::metadata(entry_path) {
        Ok(target_meta) => Ok(if target_meta.is_dir() {
            "directory"
        } else {
            "file"
        }),
        Err(follow_err) => {
            // Follow failed (dangling, permission, transient). Probe
            // directory-ness directly before falling back to "file".
            if std::fs::read_dir(entry_path).is_ok() {
                Ok("directory")
            } else {
                eprintln!(
                    "[workspace_files] symlink '{}' did not resolve: {follow_err}",
                    entry_path.display()
                );
                Ok("file")
            }
        }
    }
}

/// List one directory of a workspace view, as the file tree renders it.
///
/// Off the main thread: Tauri runs a non-`async` command inline in the IPC
/// handler, and `read_dir` plus a `stat` per entry on a network volume or a
/// directory of thousands of files froze the window for the duration. The
/// blocking body lives in [`list_workspace_directory`] so tests can call it
/// without a runtime.
#[tauri::command]
pub async fn read_workspace_directory(
    workspace_path: String,
    path: String,
) -> Result<Vec<WorkspaceDirectoryEntry>, String> {
    tokio::task::spawn_blocking(move || list_workspace_directory(&workspace_path, &path))
        .await
        .map_err(|e| format!("read_workspace_directory task failed: {e}"))?
}

pub(crate) fn list_workspace_directory(
    workspace_path: &str,
    path: &str,
) -> Result<Vec<WorkspaceDirectoryEntry>, String> {
    let target = resolve_workspace_view_path(workspace_path, path)?;
    let entries = std::fs::read_dir(&target)
        .map_err(|e| format!("Failed to read directory '{}': {}", target.display(), e))?;

    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| {
            format!(
                "Failed to read directory entry in '{}': {}",
                target.display(),
                e
            )
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = target.join(&name);
        let kind = classify_entry(&entry_path)?;

        result.push(WorkspaceDirectoryEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            kind: kind.to_string(),
        });
    }

    Ok(result)
}

/// Maximum size for a single workspace file read. Files larger than this are
/// rejected instead of blindly buffered into memory on the (blocking) IO thread.
const MAX_WORKSPACE_FILE_BYTES: u64 = 25 * 1024 * 1024; // 25 MiB

/// Reject files above `MAX_WORKSPACE_FILE_BYTES` before reading them, so a
/// pathologically large file cannot exhaust memory or stall the read.
fn guard_file_size(target: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(target)
        .map_err(|e| format!("Failed to stat file '{}': {}", target.display(), e))?;
    if meta.len() > MAX_WORKSPACE_FILE_BYTES {
        return Err(format!(
            "File '{}' is too large to open ({} bytes; limit is {} bytes)",
            target.display(),
            meta.len(),
            MAX_WORKSPACE_FILE_BYTES
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn read_workspace_text_file(
    workspace_path: String,
    path: String,
) -> Result<String, String> {
    let target = resolve_workspace_view_path(&workspace_path, &path)?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        guard_file_size(&target)?;
        std::fs::read_to_string(&target)
            .map_err(|e| format!("Failed to read text file '{}': {}", target.display(), e))
    })
    .await
    .map_err(|e| format!("read task failed: {}", e))?
}

/// Returns the file base64-encoded, not as `Vec<u8>`.
///
/// PERF-16: a `Vec<u8>` crosses the IPC boundary as a JSON array of decimal
/// numbers — `[137,80,78,71,…]`, three to four bytes of wire and one JS number
/// per byte of file — and every caller's next move was to base64 it anyway for
/// a `data:` URL. Encoding here makes the payload ~1.33× the file instead of
/// ~4×, and hands the webview a string it can use directly.
#[tauri::command]
pub async fn read_workspace_binary_file(
    workspace_path: String,
    path: String,
) -> Result<String, String> {
    use base64::Engine as _;

    let target = resolve_workspace_view_path(&workspace_path, &path)?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        guard_file_size(&target)?;
        let bytes = std::fs::read(&target)
            .map_err(|e| format!("Failed to read binary file '{}': {}", target.display(), e))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| format!("read task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_outside_workspace_view() {
        let workspace = "/tmp/workspace";
        let result = list_workspace_directory(workspace, "/tmp/other");

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("outside workspace view"));
    }

    #[cfg(unix)]
    #[test]
    fn lists_files_inside_symlinked_directory_using_view_path() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        std::fs::write(external.path().join("README.md"), "linked content").unwrap();
        symlink(external.path(), workspace.path().join("linked-dir")).unwrap();

        let entries = list_workspace_directory(
            &workspace.path().to_string_lossy(),
            &workspace.path().join("linked-dir").to_string_lossy(),
        )
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "README.md");
        assert_eq!(entries[0].kind, "file");
        assert_eq!(
            entries[0].path,
            workspace
                .path()
                .join("linked-dir")
                .join("README.md")
                .to_string_lossy()
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_symlinked_directory_entries_as_directories() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        symlink(external.path(), workspace.path().join("linked-dir")).unwrap();

        let entries = list_workspace_directory(
            &workspace.path().to_string_lossy(),
            &workspace.path().to_string_lossy(),
        )
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "linked-dir");
        assert_eq!(entries[0].kind, "directory");
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlink_classifies_as_file_without_erroring() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        // Target does not exist: the follow (`metadata`) fails and the
        // `read_dir` probe also fails, so it falls back to "file" — but the
        // listing itself must still succeed.
        symlink(
            workspace.path().join("does-not-exist"),
            workspace.path().join("broken-link"),
        )
        .unwrap();

        let entries = list_workspace_directory(
            &workspace.path().to_string_lossy(),
            &workspace.path().to_string_lossy(),
        )
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "broken-link");
        assert_eq!(entries[0].kind, "file");
    }
}
