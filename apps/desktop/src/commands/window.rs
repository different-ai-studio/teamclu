//! Multi-window support — Phase 2 MVP.
//!
//! The window registry maps window labels to workspace paths so that
//! commands can resolve the correct workspace for the calling window.

use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// window_label → workspace_path mapping for every workspace-owning window.
///
/// Both the main window (label `"main"`) and secondary windows opened via
/// `create_workspace_window` register here. Commands resolve their workspace
/// from the calling window's label so that, in multi-window mode, an event
/// from window A never routes to window B's workspace.
#[derive(Default)]
pub struct WindowRegistry {
    pub windows: Mutex<HashMap<String, String>>,
    /// Single-window fallback: last registered workspace path.
    pub current_workspace: Mutex<Option<String>>,
}

/// Insert or update the label → workspace mapping.
/// Also updates the single-window fallback.
pub fn bind_window_to_workspace(registry: &WindowRegistry, label: &str, workspace_path: &str) {
    if let Ok(mut windows) = registry.windows.lock() {
        windows.insert(label.to_string(), workspace_path.to_string());
    }
    if let Ok(mut cw) = registry.current_workspace.lock() {
        *cw = Some(workspace_path.to_string());
    }
}

/// Look up the workspace path associated with a window label.
pub fn workspace_for_window(registry: &WindowRegistry, label: &str) -> Option<String> {
    registry.windows.lock().ok()?.get(label).cloned()
}

/// Resolve the workspace for the calling window.
///
/// Strategy:
/// 1. Look up the window label in `WindowRegistry` — this is authoritative once
///    the workspace is selected.
/// 2. Fall back to `current_workspace` for the single-window flow before
///    the registry is populated.
pub fn current_workspace_for_window(
    window: &tauri::WebviewWindow,
    registry: &WindowRegistry,
) -> Result<String, String> {
    if let Some(ws) = workspace_for_window(registry, window.label()) {
        return Ok(ws);
    }
    registry
        .current_workspace
        .lock()
        .ok()
        .and_then(|cw| cw.clone())
        .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())
}

const LOCAL_AGENT_PANEL_LABEL: &str = "local-agent-panel";

/// Open (or focus) a compact window that hosts only the LocalDaemon settings
/// panel — used from the system tray so the main desktop UI stays hidden.
#[tauri::command]
pub fn open_local_agent_panel_window(app: AppHandle) -> Result<(), String> {
    // Match the main app Settings dialog: ~960×780.
    const WIDTH: f64 = 960.0;
    const HEIGHT: f64 = 780.0;

    if let Some(existing) = app.get_webview_window(LOCAL_AGENT_PANEL_LABEL) {
        let _ = existing.set_size(tauri::LogicalSize::new(WIDTH, HEIGHT));
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let brand = crate::branding::brand_name(app.config().product_name.as_deref());
    let title = format!("{brand} · Settings");

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(
        &app,
        LOCAL_AGENT_PANEL_LABEL,
        WebviewUrl::App("index.html?panel=local-agent".into()),
    )
    .title(&title)
    .inner_size(WIDTH, HEIGHT)
    .min_inner_size(800.0, 600.0)
    .resizable(true)
    .decorations(true)
    .always_on_top(false)
    .skip_taskbar(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    let win = builder
        .build()
        .map_err(|e| format!("Failed to create local-agent panel: {e}"))?;
    let _ = win.set_title(&title);

    #[cfg(target_os = "macos")]
    super::window_chrome::reposition_traffic_lights(&win);

    Ok(())
}

/// Bind the calling window to a workspace path.
///
/// Daemon-mode startup no longer goes through `start_opencode`, so the frontend
/// must call this after `setWorkspace` so window-scoped IPC commands can resolve
/// the active workspace (env catalog, MCP, etc.).
#[tauri::command]
pub async fn register_window_workspace(
    window: WebviewWindow,
    registry: tauri::State<'_, WindowRegistry>,
    workspace_path: String,
) -> Result<(), String> {
    if workspace_path.trim().is_empty() {
        return Err("workspace_path is empty".to_string());
    }
    // The binding itself is a map insert and happens before the first await, so
    // a command issued right after this one already resolves the workspace.
    bind_window_to_workspace(&registry, window.label(), &workspace_path);
    // Identity == daemon actor_id (empty until the daemon is onboarded or
    // reachable; a generator that needs it then yields None and seeds nothing).
    // Steady state this is the cached answer of `GET /v1/setup/status`; on a
    // cold cache we ask the daemon once instead of reading its private
    // backend.toml.
    let actor_id = match crate::daemon_client::cached_actor_id() {
        Some(id) => id,
        None => match crate::daemon_client::discover() {
            Ok(endpoint) => crate::daemon_client::refresh_actor_id(&endpoint)
                .await
                .ok()
                .flatten()
                .unwrap_or_default(),
            Err(_) => String::new(),
        },
    };
    // Everything below touches disk (env index, personal secret blob) and used
    // to run inline on the main thread (PERF-3).
    tokio::task::spawn_blocking(move || {
        if let Err(e) = super::env_vars::ensure_system_env_vars(&workspace_path, &actor_id) {
            eprintln!(
                "[EnvVars] Warning: failed to ensure system env vars on workspace bind: {}",
                e
            );
        }
        // Personal values are machine-global; backfill this workspace's envVars
        // cache so settings/diagnostics stay aligned after switching projects.
        if let Err(e) = super::env_vars::derive_personal_env_index_from_blob(&workspace_path) {
            eprintln!(
                "[EnvVars] Warning: failed to derive personal env index on workspace bind: {}",
                e
            );
        }
    })
    .await
    .map_err(|e| format!("register_window_workspace task failed: {e}"))
}

/// Update the title of the calling window (used by the frontend after workspace selection).
/// This keeps the dock right-click menu label in sync with the active workspace.
#[tauri::command]
pub fn set_window_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}
