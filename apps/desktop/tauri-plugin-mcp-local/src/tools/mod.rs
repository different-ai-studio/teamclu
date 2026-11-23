use log::{debug, info};
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::shared::commands;
use crate::socket_server::SocketResponse;

// Export command modules
pub mod app_bridge;
pub mod app_info;
pub mod cookies;
#[cfg(any(debug_assertions, feature = "devtools"))]
pub mod devtools;
pub mod dispatch_pointer;
pub mod events;
pub mod execute_js;
pub mod inspect_element;
pub mod list_windows;
pub mod local_storage;
pub mod mouse_movement;
pub mod navigate_webview;
pub mod log_mark;
pub mod manage_ipc;
pub mod ping;
pub mod push_ipc;
pub mod push_log;
pub mod query_logs;
pub mod read_text;
pub mod restart_app;
pub mod take_screenshot;
pub mod text_input;
pub mod webview;
pub mod webview_state;
pub mod window_manager;
pub mod zoom;

// Re-export command handler functions
pub use app_bridge::handle_app_bridge;
pub use app_info::handle_get_app_info;
pub use cookies::handle_manage_cookies;
#[cfg(any(debug_assertions, feature = "devtools"))]
pub use devtools::handle_manage_devtools;
pub use dispatch_pointer::handle_dispatch_pointer;
pub use events::handle_manage_events;
pub use execute_js::handle_execute_js;
pub use inspect_element::handle_inspect_element;
pub use list_windows::handle_list_windows;
pub use local_storage::handle_get_local_storage;
pub use mouse_movement::handle_simulate_mouse_movement;
pub use navigate_webview::handle_navigate_webview;
pub use log_mark::handle_log_mark;
pub use manage_ipc::handle_manage_ipc;
pub use ping::handle_ping;
pub use query_logs::handle_query_logs;
pub use read_text::handle_read_text;
pub use restart_app::handle_restart_app;
pub use take_screenshot::handle_take_screenshot;
pub use text_input::handle_simulate_text_input;
pub use webview::{
    handle_fill_form, handle_get_dom, handle_get_element_position, handle_get_page_map,
    handle_get_page_state, handle_navigate_back, handle_press_key, handle_scroll_page,
    handle_send_text_to_element, handle_set_file_input, handle_type_into_focused,
    handle_wait_for,
};
pub use webview_state::handle_manage_webview_state;
pub use window_manager::handle_manage_window;
pub use zoom::handle_manage_zoom;

/// Handle command routing for socket requests
pub async fn handle_command<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    payload: Value,
) -> crate::Result<SocketResponse> {
    debug!("[TAURI_MCP] Received command: {}", command);
    debug!(
        "[TAURI_MCP] Command {} payload: {}",
        command,
        serde_json::to_string_pretty(&payload)
            .unwrap_or_else(|_| "[failed to serialize]".to_string())
    );

    let result = match command {
        commands::PING => handle_ping(app, payload),
        commands::TAKE_SCREENSHOT => handle_take_screenshot(app, payload).await,
        commands::GET_DOM => handle_get_dom(app, payload).await,
        commands::MANAGE_LOCAL_STORAGE => handle_get_local_storage(app, payload).await,
        commands::EXECUTE_JS => handle_execute_js(app, payload).await,
        commands::MANAGE_WINDOW => handle_manage_window(app, payload).await,
        commands::SIMULATE_TEXT_INPUT => handle_simulate_text_input(app, payload).await,
        commands::SIMULATE_MOUSE_MOVEMENT => handle_simulate_mouse_movement(app, payload).await,
        commands::GET_ELEMENT_POSITION => handle_get_element_position(app, payload).await,
        commands::SEND_TEXT_TO_ELEMENT => handle_send_text_to_element(app, payload).await,
        commands::GET_PAGE_MAP => handle_get_page_map(app, payload).await,
        commands::GET_PAGE_STATE => handle_get_page_state(app, payload).await,
        commands::NAVIGATE_BACK => handle_navigate_back(app, payload).await,
        commands::SCROLL_PAGE => handle_scroll_page(app, payload).await,
        commands::FILL_FORM => handle_fill_form(app, payload).await,
        commands::WAIT_FOR => handle_wait_for(app, payload).await,
        commands::GET_APP_INFO => handle_get_app_info(app, payload).await,
        commands::LIST_WINDOWS => handle_list_windows(app, payload).await,
        commands::NAVIGATE_WEBVIEW => handle_navigate_webview(app, payload).await,
        commands::MANAGE_EVENTS => handle_manage_events(app, payload).await,
        commands::MANAGE_COOKIES => handle_manage_cookies(app, payload).await,
        #[cfg(any(debug_assertions, feature = "devtools"))]
        commands::MANAGE_DEVTOOLS => handle_manage_devtools(app, payload).await,
        #[cfg(not(any(debug_assertions, feature = "devtools")))]
        commands::MANAGE_DEVTOOLS => Ok(SocketResponse::err(None, "manage_devtools is only available in debug builds (or with the plugin's 'devtools' feature)".to_string())),
        commands::MANAGE_ZOOM => handle_manage_zoom(app, payload).await,
        commands::MANAGE_WEBVIEW_STATE => handle_manage_webview_state(app, payload).await,
        commands::TYPE_INTO_FOCUSED => handle_type_into_focused(app, payload).await,
        commands::PRESS_KEY => handle_press_key(app, payload).await,
        commands::SET_FILE_INPUT => handle_set_file_input(app, payload).await,
        commands::MANAGE_IPC => handle_manage_ipc(app, payload).await,
        commands::RESTART_APP => handle_restart_app(app, payload).await,
        commands::QUERY_LOGS => handle_query_logs(app, payload).await,
        commands::LOG_MARK => handle_log_mark(app, payload).await,
        commands::READ_TEXT => handle_read_text(app, payload).await,
        commands::INSPECT_ELEMENT => handle_inspect_element(app, payload).await,
        commands::DISPATCH_POINTER => handle_dispatch_pointer(app, payload).await,
        commands::APP_BRIDGE => handle_app_bridge(app, payload).await,
        _ => Ok(SocketResponse::err(None, format!("Unknown command: {}", command))),
    };

    // Log the response before returning it
    if let Ok(ref response) = result {
        let success_str = if response.success {
            "SUCCESS"
        } else {
            "FAILURE"
        };
        debug!(
            "[TAURI_MCP] Command {} completed with status: {}",
            command, success_str
        );

        if let Some(ref data) = response.data {
            let data_str =
                serde_json::to_string(data).unwrap_or_else(|_| "[failed to serialize]".to_string());
            if data_str.len() > 1000 {
                debug!(
                    "[TAURI_MCP] Response data preview (first 1000 chars): {}",
                    &data_str[..1000.min(data_str.len())]
                );
                debug!(
                    "[TAURI_MCP] ... (response data truncated, total length: {} bytes)",
                    data_str.len()
                );
            } else {
                debug!("[TAURI_MCP] Response data: {}", data_str);
            }
        }

        if let Some(ref err) = response.error {
            info!("[TAURI_MCP] Error: {}", err);
        }
    } else if let Err(ref e) = result {
        info!("[TAURI_MCP] Command {} failed with error: {}", command, e);
    }

    result
}

#[cfg(test)]
mod tests {
    use crate::shared::commands;

    #[test]
    fn test_command_constants_are_unique() {
        let all_commands = [
            commands::PING,
            commands::TAKE_SCREENSHOT,
            commands::GET_DOM,
            commands::MANAGE_LOCAL_STORAGE,
            commands::EXECUTE_JS,
            commands::MANAGE_WINDOW,
            commands::SIMULATE_TEXT_INPUT,
            commands::SIMULATE_MOUSE_MOVEMENT,
            commands::GET_ELEMENT_POSITION,
            commands::SEND_TEXT_TO_ELEMENT,
            commands::GET_PAGE_MAP,
            commands::GET_PAGE_STATE,
            commands::NAVIGATE_BACK,
            commands::SCROLL_PAGE,
            commands::FILL_FORM,
            commands::WAIT_FOR,
            commands::GET_APP_INFO,
            commands::LIST_WINDOWS,
            commands::NAVIGATE_WEBVIEW,
            commands::MANAGE_EVENTS,
            commands::MANAGE_COOKIES,
            commands::MANAGE_DEVTOOLS,
            commands::MANAGE_ZOOM,
            commands::MANAGE_WEBVIEW_STATE,
            commands::TYPE_INTO_FOCUSED,
            commands::PRESS_KEY,
            commands::SET_FILE_INPUT,
            commands::MANAGE_IPC,
            commands::RESTART_APP,
            commands::QUERY_LOGS,
            commands::LOG_MARK,
            commands::READ_TEXT,
            commands::INSPECT_ELEMENT,
            commands::DISPATCH_POINTER,
            commands::APP_BRIDGE,
        ];

        let mut seen = std::collections::HashSet::new();
        for cmd in &all_commands {
            assert!(seen.insert(*cmd), "Duplicate command constant: {}", cmd);
        }
        assert_eq!(seen.len(), 35, "Expected 35 unique commands");
    }
}
