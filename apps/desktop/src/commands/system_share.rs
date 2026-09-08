//! Native share sheet — hand a piece of text to the OS share UI.
//!
//! Skill tenet T3 (*adopt the platform; don't compete with it*): the user
//! already has Messages / Mail / AirDrop / Notes wired up in the system share
//! sheet, so a session link goes out through that instead of the app growing
//! its own integrations.
//!
//! macOS only. Windows' equivalent (`DataTransferManager`) is only reachable
//! through an `IDataTransferManagerInterop` HWND shim, which is a different
//! piece of work; the frontend hides the entry there and keeps copy-only, so
//! this returning `Err` on Windows is a bug path, not the normal one.

use serde::Deserialize;

/// Where to hang the popover: the trigger's `getBoundingClientRect()`, in CSS
/// pixels relative to the webview viewport.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ShareAnchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Present the OS share sheet for `text`, anchored under `anchor`.
///
/// Resolves once the sheet has been put on screen — not when the user picks a
/// service. AppKit gives no completion callback for the picker, and the caller
/// only needs to know that the sheet opened.
#[tauri::command]
pub async fn system_share_text(
    window: tauri::WebviewWindow,
    text: String,
    anchor: Option<ShareAnchor>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("nothing to share".into());
    }
    share_text_inner(window, text, anchor).await
}

#[cfg(target_os = "macos")]
async fn share_text_inner(
    window: tauri::WebviewWindow,
    text: String,
    anchor: Option<ShareAnchor>,
) -> Result<(), String> {
    // Every AppKit call below has to happen on the main thread; a Tauri command
    // runs on a worker. The oneshot carries the result back so a failure to
    // build the sheet still reaches the caller as an error toast.
    let (tx, rx) = tokio::sync::oneshot::channel();
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(unsafe { present_share_picker(&win, &text, anchor) });
        })
        .map_err(|e| format!("main thread dispatch: {e}"))?;
    rx.await
        .map_err(|_| "share sheet did not report back".to_string())?
}

#[cfg(target_os = "macos")]
unsafe fn present_share_picker(
    window: &tauri::WebviewWindow,
    text: &str,
    anchor: Option<ShareAnchor>,
) -> Result<(), String> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSArray, NSAutoreleasePool, NSPoint, NSRect, NSSize, NSString};
    use objc::{class, msg_send, sel, sel_impl};

    /// `NSRectEdgeMinY` — the sheet hangs below the anchor, like the app's own
    /// header menus.
    const NS_RECT_EDGE_MIN_Y: u64 = 1;

    let ns_window = window.ns_window().map_err(|e| format!("ns_window: {e}"))? as id;
    if ns_window == nil {
        return Err("window has no NSWindow".into());
    }
    let content_view: id = msg_send![ns_window, contentView];
    if content_view == nil {
        return Err("window has no content view".into());
    }
    let bounds: NSRect = msg_send![content_view, bounds];

    // The webview's Y grows downward from the top of the view; AppKit's grows
    // upward from its bottom, so the anchor rect has to be flipped. CSS pixels
    // and AppKit points are 1:1 here (the webview fills the content view at
    // the window's scale factor), so only Y moves.
    let rect = match anchor {
        Some(a) => NSRect::new(
            NSPoint::new(a.x, bounds.size.height - (a.y + a.height)),
            NSSize::new(a.width.max(1.0), a.height.max(1.0)),
        ),
        None => NSRect::new(NSPoint::new(0.0, bounds.size.height), NSSize::new(1.0, 1.0)),
    };

    let item = NSString::alloc(nil).init_str(text).autorelease();
    let items = NSArray::arrayWithObject(nil, item);
    let picker: id = msg_send![class!(NSSharingServicePicker), alloc];
    let picker: id = msg_send![picker, initWithItems: items];
    if picker == nil {
        return Err("could not create the share sheet".into());
    }
    let _: () = msg_send![
        picker,
        showRelativeToRect: rect
        ofView: content_view
        preferredEdge: NS_RECT_EDGE_MIN_Y
    ];
    // Deliberately not released: the picker owns the popover that is still on
    // screen after this returns, and AppKit hands us no dismissal callback to
    // release it from. One small leak per share beats a use-after-free.
    Ok(())
}

#[cfg(not(target_os = "macos"))]
async fn share_text_inner(
    _window: tauri::WebviewWindow,
    _text: String,
    _anchor: Option<ShareAnchor>,
) -> Result<(), String> {
    Err("the system share sheet is only available on macOS".into())
}
