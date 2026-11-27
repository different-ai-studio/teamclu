//! Save and open dialogs that must not take down the process.
//!
//! `tauri-plugin-dialog` → rfd → `NSSavePanel::savePanel` can panic with
//! `unexpected NULL returned from +[NSSavePanel savePanel]` when AppKit is not
//! ready (background, teardown). The async waiter then hits `RecvError` on
//! unwrap (TEAMCLU-RUST-11 / TEAMCLU-RUST-10). `NSOpenPanel::openPanel` fails
//! the same way (TEAMCLU-RUST-16 / RUST-17). These commands activate the app,
//! run the dialog on the main thread, and turn panics into `Err` for JS.

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

/// Run `dialog` on the main thread with panics turned into `Err`.
///
/// Tauri runs synchronous commands on the main thread, so `run_on_main_thread`
/// executes the closure inline and the slot is filled by the time it returns.
fn run_guarded<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    label: &'static str,
    dialog: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    activate_app();

    let slot: Arc<Mutex<Option<Result<T, ()>>>> = Arc::new(Mutex::new(None));
    let slot_for_main = Arc::clone(&slot);
    app.run_on_main_thread(move || {
        let outcome = std::panic::catch_unwind(AssertUnwindSafe(dialog)).map_err(|_| {
            crate::soft_log::error(&format!(
                "[safe-dialog] {label}: native panel panicked; returning error instead of aborting"
            ));
            crate::sentry_utils::capture_warning(&format!(
                "{label}: native panel panicked (NSOpenPanel/NSSavePanel NULL / rfd)"
            ));
        });
        if let Ok(mut guard) = slot_for_main.lock() {
            *guard = Some(outcome);
        }
    })
    .map_err(|e| format!("run_on_main_thread: {e}"))?;

    let outcome = slot
        .lock()
        .map_err(|_| "dialog lock poisoned".to_string())?
        .take();
    match outcome {
        Some(Ok(value)) => Ok(value),
        Some(Err(())) => Err(
            "File dialog failed (native panel unavailable). Try again with the app focused.".into(),
        ),
        None => Err("File dialog did not run on the main thread".into()),
    }
}

fn path_string(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Native save dialog. Returns `Ok(None)` on cancel, `Err` if AppKit/rfd panics.
#[tauri::command]
pub fn safe_save_dialog<R: Runtime>(
    app: AppHandle<R>,
    args: SafeSaveArgs,
) -> Result<Option<String>, String> {
    run_guarded(&app, "safe_save_dialog", move || run_save_dialog(&args))
        .map(|path| path.map(path_string))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeOpenArgs {
    pub title: Option<String>,
    pub default_path: Option<String>,
    pub filters: Option<Vec<DialogFilter>>,
    #[serde(default)]
    pub directory: bool,
    #[serde(default)]
    pub multiple: bool,
}

fn run_open_dialog(args: &SafeOpenArgs) -> Option<Vec<PathBuf>> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = &args.title {
        dialog = dialog.set_title(title);
    }
    if let Some(default_path) = &args.default_path {
        dialog = dialog.set_directory(default_path);
    }
    if !args.directory {
        if let Some(filters) = &args.filters {
            for filter in filters {
                let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
                dialog = dialog.add_filter(&filter.name, &exts);
            }
        }
    }
    match (args.directory, args.multiple) {
        (true, true) => dialog.pick_folders(),
        (true, false) => dialog.pick_folder().map(|p| vec![p]),
        (false, true) => dialog.pick_files(),
        (false, false) => dialog.pick_file().map(|p| vec![p]),
    }
}

/// Native open dialog (files or folders). Returns `Ok(None)` on cancel and
/// `Err` if AppKit/rfd panics — `+[NSOpenPanel openPanel]` returning NULL is
/// the same failure as the save panel (TEAMCLU-RUST-16 / RUST-17, with the
/// plugin's waiter then dying on `RecvError`, RUST-15 / RUST-18).
#[tauri::command]
pub fn safe_open_dialog<R: Runtime>(
    app: AppHandle<R>,
    args: SafeOpenArgs,
) -> Result<Option<Vec<String>>, String> {
    run_guarded(&app, "safe_open_dialog", move || run_open_dialog(&args))
        .map(|paths| paths.map(|v| v.into_iter().map(path_string).collect()))
}
