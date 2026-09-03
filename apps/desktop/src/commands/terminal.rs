use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Emitter, State};

use super::window::{current_workspace_for_window, WindowRegistry};
use crate::terminal::pty::{DataSink, EmitContext, PtyHandle, SpawnArgs};
use crate::terminal::registry::{Registry, TerminalError, TerminalStatus, TerminalSummary};

#[derive(serde::Serialize)]
pub struct OpenResult {
    pub id: String,
    pub shell: String,
    pub pid: u32,
}

/// What `terminal_subscribe` answers. The scrollback itself is not in here: it
/// arrives as the first message on the channel the caller passed, followed by
/// live output, so the frontend never has to reconcile two snapshots.
#[derive(serde::Serialize)]
pub struct SubscribeResult {
    /// Hand this back to `terminal_detach` when the view goes away.
    pub sink_id: u64,
    pub cols: u16,
    pub rows: u16,
    pub status: TerminalStatus,
    pub exit_code: Option<i32>,
}

/// Open a PTY inside the calling window's workspace.
///
/// The cwd fence is derived from the workspace this window registered
/// (`register_window_workspace`), not from what the webview sends: the origin
/// that renders agent output must not be the one that decides where a shell
/// may start (SEC-10). `allowed_roots` stays in the signature for API
/// compatibility and is accepted only when every entry lies inside that
/// workspace.
#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    window: tauri::WebviewWindow,
    window_registry: State<'_, WindowRegistry>,
    registry: State<'_, Arc<Registry>>,
    workspace_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    allowed_roots: Option<Vec<String>>,
) -> Result<OpenResult, TerminalError> {
    let workspace_root = current_workspace_for_window(&window, &window_registry)
        .map_err(TerminalError::CwdNotAllowed)?;
    if let Some(requested) = allowed_roots.as_deref() {
        ensure_roots_within(requested, &workspace_root)?;
    }
    let cwd_path = canonicalize_cwd(&cwd, std::slice::from_ref(&workspace_root))?;
    let shell = resolve_shell(shell);
    let id = uuid::Uuid::now_v7().to_string();

    let app_for_exit = app.clone();
    let emit = EmitContext {
        emit_exit: Arc::new(move |name, code| {
            let _ = app_for_exit.emit(name, code);
        }),
    };

    let handle = PtyHandle::spawn(
        SpawnArgs {
            id: id.clone(),
            workspace_id,
            cwd: cwd_path,
            shell: shell.clone(),
            cols,
            rows,
        },
        emit,
    )?;
    let pid = handle.pid;
    registry.insert(id.clone(), handle);

    Ok(OpenResult { id, shell, pid })
}

/// Attach a view to a terminal's output.
///
/// `on_data` is a Tauri IPC channel: each PTY chunk is sent as raw bytes and
/// lands in the webview as an `ArrayBuffer`, ordered, and only in the window
/// that asked. The first message is the ring snapshot (the scrollback so far,
/// possibly empty); everything after it is live. Before this, output went out
/// as a `terminal://<id>/data` event whose payload was a JSON `number[]` —
/// three to four bytes of text per byte, one `JSON.parse` per 4 KiB on the main
/// thread, broadcast to every window — and the 8 MiB ring travelled the same
/// way on every re-attach.
#[tauri::command]
pub async fn terminal_subscribe(
    registry: State<'_, Arc<Registry>>,
    id: String,
    on_data: Channel<InvokeResponseBody>,
) -> Result<SubscribeResult, TerminalError> {
    let h = registry.get(&id).ok_or(TerminalError::NotFound(id))?;
    let sink: DataSink = Arc::new(move |chunk: &[u8]| {
        on_data
            .send(InvokeResponseBody::Raw(chunk.to_vec()))
            .is_ok()
    });
    let sink_id = h.attach(sink);
    Ok(SubscribeResult {
        sink_id,
        cols: 80,
        rows: 24,
        status: h.status(),
        exit_code: h.exit_code(),
    })
}

/// Stop delivering output to a sink `terminal_subscribe` registered. A view
/// that unmounts without this leaves its channel attached until the terminal
/// closes or a send fails.
#[tauri::command]
pub async fn terminal_detach(
    registry: State<'_, Arc<Registry>>,
    id: String,
    sink_id: u64,
) -> Result<(), TerminalError> {
    if let Some(h) = registry.get(&id) {
        h.detach(sink_id);
    }
    Ok(())
}

/// Writes raw bytes to a PTY.
///
/// Uses Tauri raw-body IPC instead of a JSON `Vec<u8>` to keep per-keystroke
/// latency low — JSON-encoding each byte as a decimal number doubles to triples
/// the payload size and adds parse work on both sides for every keypress. The
/// terminal id rides in the `x-terminal-id` header so the body can stay raw.
#[tauri::command]
pub async fn terminal_write(
    registry: State<'_, Arc<Registry>>,
    request: Request<'_>,
) -> Result<(), TerminalError> {
    let id = request
        .headers()
        .get("x-terminal-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| TerminalError::BadRequest("missing x-terminal-id header".into()))?
        .to_string();
    let bytes: &[u8] = match request.body() {
        InvokeBody::Raw(b) => b.as_slice(),
        InvokeBody::Json(_) => {
            return Err(TerminalError::BadRequest(
                "terminal_write expects raw body, got JSON".into(),
            ))
        }
    };
    let h = registry.get(&id).ok_or(TerminalError::NotFound(id))?;
    h.write(bytes)
}

#[tauri::command]
pub async fn terminal_resize(
    registry: State<'_, Arc<Registry>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), TerminalError> {
    let h = registry.get(&id).ok_or(TerminalError::NotFound(id))?;
    h.resize(cols, rows)
}

#[tauri::command]
pub async fn terminal_close(
    registry: State<'_, Arc<Registry>>,
    id: String,
) -> Result<(), TerminalError> {
    if let Some(h) = registry.remove(&id) {
        h.kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_list(
    registry: State<'_, Arc<Registry>>,
    workspace_id: Option<String>,
) -> Result<Vec<TerminalSummary>, TerminalError> {
    Ok(registry.list_summaries(workspace_id.as_deref()))
}

fn resolve_shell(explicit: Option<String>) -> String {
    if let Some(s) = explicit.filter(|s| !s.is_empty()) {
        return s;
    }
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() && Path::new(&s).exists() {
            return s;
        }
    }
    #[cfg(target_os = "macos")]
    {
        "/bin/zsh".into()
    }
    #[cfg(target_os = "linux")]
    {
        "/bin/bash".into()
    }
    #[cfg(target_os = "windows")]
    {
        "powershell.exe".into()
    }
}

fn canonicalize_cwd(cwd: &str, allowed_roots: &[String]) -> Result<PathBuf, TerminalError> {
    let raw = PathBuf::from(cwd);
    let canon = match raw.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // Fall back to home dir
            return dirs::home_dir().ok_or(TerminalError::CwdNotFound(cwd.to_string()));
        }
    };

    if allowed_roots.is_empty() {
        // Defensive: never allow arbitrary cwd if frontend didn't supply roots.
        return Err(TerminalError::CwdNotAllowed(cwd.to_string()));
    }

    let allowed: Vec<PathBuf> = allowed_roots
        .iter()
        .filter_map(|r| PathBuf::from(r).canonicalize().ok())
        .collect();

    let permitted = allowed.iter().any(|root| canon.starts_with(root))
        || dirs::home_dir().map(|h| canon == h).unwrap_or(false);

    if !permitted {
        return Err(TerminalError::CwdNotAllowed(cwd.to_string()));
    }

    Ok(canon)
}

/// Every caller-supplied root must resolve inside the window's registered
/// workspace; anything else is a bug in the frontend or an attempt to widen the
/// fence, and both get the same answer.
fn ensure_roots_within(requested: &[String], workspace_root: &str) -> Result<(), TerminalError> {
    let root = PathBuf::from(workspace_root)
        .canonicalize()
        .map_err(|_| TerminalError::CwdNotFound(workspace_root.to_string()))?;
    for r in requested {
        let canon = PathBuf::from(r)
            .canonicalize()
            .map_err(|_| TerminalError::CwdNotAllowed(r.clone()))?;
        if !canon.starts_with(&root) {
            return Err(TerminalError::CwdNotAllowed(r.clone()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_inside_the_workspace_pass() {
        let ws = tempfile::tempdir().unwrap();
        let sub = ws.path().join("src");
        std::fs::create_dir_all(&sub).unwrap();
        let root = ws.path().display().to_string();
        let requested = vec![root.clone(), sub.display().to_string()];
        assert!(ensure_roots_within(&requested, &root).is_ok());
        assert!(ensure_roots_within(&[], &root).is_ok());
    }

    #[test]
    fn roots_outside_the_workspace_are_rejected() {
        let ws = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let root = ws.path().display().to_string();
        let err = ensure_roots_within(&[other.path().display().to_string()], &root).unwrap_err();
        assert!(matches!(err, TerminalError::CwdNotAllowed(_)));
    }

    #[test]
    fn roots_that_do_not_exist_are_rejected() {
        let ws = tempfile::tempdir().unwrap();
        let root = ws.path().display().to_string();
        let missing = ws.path().join("nope").display().to_string();
        let err = ensure_roots_within(&[missing], &root).unwrap_err();
        assert!(matches!(err, TerminalError::CwdNotAllowed(_)));
    }

    #[test]
    fn cwd_is_fenced_to_the_registered_root() {
        let ws = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let root = ws.path().display().to_string();
        let roots = vec![root.clone()];
        assert!(canonicalize_cwd(&root, &roots).is_ok());
        let err = canonicalize_cwd(&other.path().display().to_string(), &roots).unwrap_err();
        assert!(matches!(err, TerminalError::CwdNotAllowed(_)));
    }
}
