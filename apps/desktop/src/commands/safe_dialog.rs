//! Save dialog that must not take down the process.
//!
//! `tauri-plugin-dialog` → rfd → `NSSavePanel::savePanel` can panic with
//! `unexpected NULL returned from +[NSSavePanel savePanel]` when AppKit is not
//! ready (background, teardown). The async waiter then hits `RecvError` on
//! unwrap (TEAMCLU-RUST-11 / TEAMCLU-RUST-10). This command activates the app,
//! runs the dialog on the main thread, and turns panics into `Err` for JS.

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::{AppHandle, Runtime};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeSaveArgs {
    pub title: Option<String>,
    pub default_path: Option<String>,
    pub filters: Option<Vec<DialogFilter>>,
}

#[cfg(target_os = "macos")]
fn activate_app() {
    use cocoa::appkit::NSApp;
    use cocoa::base::nil;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let ns_app = NSApp();
        if ns_app != nil {
            let _: () = msg_send![ns_app, activateIgnoringOtherApps: true];
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn activate_app() {}

fn run_save_dialog(args: &SafeSaveArgs) -> Option<PathBuf> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = &args.title {
        dialog = dialog.set_title(title);
    }
    if let Some(default_path) = &args.default_path {
        let path = PathBuf::from(default_path);
        if let Some(parent) = path.parent() {
            dialog = dialog.set_directory(parent);
        }
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            dialog = dialog.set_file_name(name);
        }
    }
    if let Some(filters) = &args.filters {
        for filter in filters {
            let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&filter.name, &exts);
        }
    }
    dialog.save_file()
}

type DialogOutcome = Result<Option<PathBuf>, ()>;

/// Native save dialog. Returns `Ok(None)` on cancel, `Err` if AppKit/rfd panics.
#[tauri::command]
pub fn safe_save_dialog<R: Runtime>(
    app: AppHandle<R>,
    args: SafeSaveArgs,
) -> Result<Option<String>, String> {
    activate_app();

    let slot: Arc<Mutex<Option<DialogOutcome>>> = Arc::new(Mutex::new(None));
    let slot_for_main = Arc::clone(&slot);
    app.run_on_main_thread(move || {
        let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| run_save_dialog(&args)));
        let mapped = match outcome {
            Ok(path) => Ok(path),
            Err(_) => {
                crate::soft_log::error(
                    "[safe-dialog] NSSavePanel/rfd panicked; returning error instead of aborting",
                );
                crate::sentry_utils::capture_warning(
                    "safe_save_dialog: native save panel panicked (NSSavePanel NULL / rfd)",
                );
                Err(())
            }
        };
        if let Ok(mut guard) = slot_for_main.lock() {
            *guard = Some(mapped);
        }
    })
    .map_err(|e| format!("run_on_main_thread: {e}"))?;

    let outcome = slot
        .lock()
        .map_err(|_| "dialog lock poisoned".to_string())?
        .take();
    match outcome {
        Some(Ok(path)) => Ok(path.map(|p| p.to_string_lossy().into_owned())),
        Some(Err(())) => Err(
            "Save dialog failed (native panel unavailable). Try again with the app focused.".into(),
        ),
        None => Err("Save dialog did not run on the main thread".into()),
    }
}
