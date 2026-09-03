use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

const SUBDIR: &str = "acp-stream";

fn acp_stream_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("app_log_dir: {e}"))?;
    let dir = base.join(SUBDIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir)
}

fn safe_session_filename(session_id: &str) -> String {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return "_global.log".to_string();
    }
    let safe: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}.log")
}

fn append_to(path: &Path, text: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    file.flush()
        .map_err(|e| format!("flush {}: {e}", path.display()))?;
    Ok(())
}

/// Run a blocking filesystem step off the main thread.
///
/// Every command here does disk IO (two appends with an fsync-ish flush each,
/// or a process spawn), and a non-`async` Tauri command runs inline in the IPC
/// handler — on macOS, the main thread. The debug log is written per streamed
/// chunk, so this was a main-thread disk write per token.
async fn off_main_thread<T, F>(what: &'static str, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("{what} task failed: {e}"))?
}

/// Append one formatted ACP debug block (session file + combined log).
#[tauri::command]
pub async fn acp_debug_append_log(
    app: AppHandle,
    session_id: String,
    text: String,
) -> Result<(), String> {
    off_main_thread("acp_debug_append_log", move || {
        let dir = acp_stream_log_dir(&app)?;
        let session_path = dir.join(safe_session_filename(&session_id));
        let combined_path = dir.join("_all.log");
        append_to(&session_path, &text)?;
        append_to(&combined_path, &text)?;
        Ok(())
    })
    .await
}

/// Directory where ACP stream logs are written (`app_log_dir/acp-stream`).
#[tauri::command]
pub async fn acp_debug_log_directory(app: AppHandle) -> Result<String, String> {
    off_main_thread("acp_debug_log_directory", move || {
        let dir = acp_stream_log_dir(&app)?;
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
}

/// Reveal the session log file (or the log directory when session id is empty).
#[tauri::command]
pub async fn acp_debug_reveal_log(
    app: AppHandle,
    session_id: Option<String>,
) -> Result<(), String> {
    off_main_thread("acp_debug_reveal_log", move || {
        let dir = acp_stream_log_dir(&app)?;
        let session_id = session_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        match session_id {
            Some(id) => {
                let file = dir.join(safe_session_filename(id));
                if !file.exists() {
                    std::fs::write(&file, "")
                        .map_err(|e| format!("create {}: {e}", file.display()))?;
                }
                crate::commands::show_in_folder_blocking(file.to_string_lossy().into_owned())
            }
            None => open_path_in_file_manager(&dir),
        }
    })
    .await
}

fn open_path_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open in Finder: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open in Explorer: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open in file manager: {e}"))?;
    }
    Ok(())
}
