//! macOS screenshot thumbnails are file promises, not files.
//!
//! After ⌘⇧4 the floating thumbnail's pasteboard has
//! `NSFilePromiseReceiver` (and sometimes PNG/TIFF bytes), not
//! `NSFilenamesPboardType`. wry's drag handler only reads filenames, and with
//! `dragDropEnabled` it accepts the drop anyway, so WebKit never sees it and
//! the webview gets a `tauri://drag-drop` with an empty path list.
//!
//! This module teaches `WryWebView` to accept those pasteboard types, writes
//! the promised image into the app cache, and emits a second drag-drop whose
//! paths the chat composer already knows how to attach.

use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use block2::RcBlock;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::sel as objc_sel;
use objc2::ClassType;
use objc2_app_kit::{
    NSDraggingInfo, NSFilePromiseReceiver, NSPasteboard, NSPasteboardType, NSPasteboardTypeFileURL,
    NSPasteboardTypePNG, NSPasteboardTypeTIFF, NSView,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSOperationQueue, NSString, NSURL};
use tauri::{Emitter, Manager};

use crate::commands::APP_SHORT_NAME;

const DROP_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// `NSBitmapImageFileType.png` in AppKit.
const BITMAP_PNG: usize = 4;
#[cfg(test)]
const REQUIRED_DRAG_TYPES: &[&str] = &[
    "NSFilenamesPboardType",
    "public.file-url",
    "public.png",
    "public.tiff",
];

type PerformDragOp = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool;
type ViewDidMoveOp = unsafe extern "C-unwind" fn(*mut AnyObject, Sel);
type RegisterTypesOp = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static ORIGINAL_DRAG: OnceLock<PerformDragOp> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DropKind {
    /// A real file path is already on the pasteboard. wry emits it.
    Passthrough,
    FilePromise,
    InlinePng,
    InlineTiff,
}

enum InlineImage {
    Png(Vec<u8>),
    Tiff(Vec<u8>),
}

#[derive(serde::Serialize)]
struct DragPayload {
    paths: Vec<String>,
    position: DragPosition,
}

#[derive(serde::Serialize)]
struct DragPosition {
    x: f64,
    y: f64,
}

pub fn install(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
    let root = drop_root();
    if let Err(err) = std::fs::create_dir_all(&root) {
        log::warn!("[screenshot-drop] could not create cache dir: {err}");
    }
    if let Err(err) = crate::fs_scope::allow_directory(app, &root) {
        log::warn!("[screenshot-drop] could not grant fs scope: {err}");
    }
    if let Err(err) = install_hooks() {
        log::error!("[screenshot-drop] {err}");
        return;
    }
    register_existing_webviews(app);
}

fn install_hooks() -> Result<(), String> {
    static ONCE: std::sync::Once = std::sync::Once::new();
    let mut error: Option<String> = None;
    ONCE.call_once(|| {
        if let Err(err) = install_hooks_once() {
            error = Some(err);
        }
    });
    match error {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

fn install_hooks_once() -> Result<(), String> {
    let Some(cls) = AnyClass::get(c"WryWebView") else {
        return Err("WryWebView is not registered".to_string());
    };
    let method = cls
        .instance_method(objc_sel!(performDragOperation:))
        .ok_or_else(|| "WryWebView has no performDragOperation:".to_string())?;
    let drag: PerformDragOp = perform_drag_operation;
    let previous = unsafe { method.set_implementation(fn_to_imp(&drag)) };
    let _ = ORIGINAL_DRAG.set(imp_to_fn(previous));

    let moved: ViewDidMoveOp = view_did_move_to_window;
    add_method(
        cls,
        objc_sel!(viewDidMoveToWindow),
        fn_to_imp(&moved),
        c"v@:",
    );
    let register: RegisterTypesOp = register_for_dragged_types;
    add_method(
        cls,
        objc_sel!(registerForDraggedTypes:),
        fn_to_imp(&register),
        c"v@:@",
    );
    log::info!("[screenshot-drop] screenshot thumbnail drops enabled");
    Ok(())
}

fn add_method(cls: &AnyClass, name: Sel, imp: Imp, types: &std::ffi::CStr) {
    let added = unsafe {
        objc2::ffi::class_addMethod(
            std::ptr::from_ref(cls).cast_mut(),
            name,
            imp,
            types.as_ptr(),
        )
    };
    if !added.as_bool() {
        log::warn!("[screenshot-drop] {name:?} was already on WryWebView");
    }
}

fn register_existing_webviews(app: &tauri::AppHandle) {
    for (_, webview) in app.webviews() {
        let _ = webview.with_webview(|platform| {
            union_drag_types(platform.inner().cast());
        });
    }
}

unsafe extern "C-unwind" fn view_did_move_to_window(this: *mut AnyObject, _cmd: Sel) {
    if this.is_null() {
        return;
    }
    let Some(superclass) = wry_superclass() else {
        return;
    };
    let this_ref = unsafe { &*this };
    unsafe {
        let _: () = objc2::msg_send![super(this_ref, superclass), viewDidMoveToWindow];
    }
    union_drag_types(this);
}

unsafe extern "C-unwind" fn register_for_dragged_types(
    this: *mut AnyObject,
    _cmd: Sel,
    types: *mut AnyObject,
) {
    if this.is_null() {
        return;
    }
    if !types.is_null() {
        if let Some(superclass) = wry_superclass() {
            let this_ref = unsafe { &*this };
            let types_ref = unsafe { &*types };
            unsafe {
                let _: () = objc2::msg_send![
                    super(this_ref, superclass),
                    registerForDraggedTypes: types_ref
                ];
            }
        }
    }
    union_drag_types(this);
}

unsafe extern "C-unwind" fn perform_drag_operation(
    this: *mut AnyObject,
    cmd: Sel,
    sender: *mut AnyObject,
) -> Bool {
    if let Err(err) = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
        capture_screenshot(this, sender);
    })) {
        log::warn!("[screenshot-drop] pasteboard exception: {err:?}");
    }
    match ORIGINAL_DRAG.get() {
        Some(original) => unsafe { original(this, cmd, sender) },
        None => Bool::YES,
    }
}

fn capture_screenshot(view: *mut AnyObject, sender: *mut AnyObject) {
    if view.is_null() || sender.is_null() {
        return;
    }
    let drag = unsafe { &*sender.cast::<ProtocolDrag>() };
    let pasteboard = drag.draggingPasteboard();
    let has_filenames = pasteboard_has_filenames(&pasteboard);
    let has_promise = !has_filenames && pasteboard_has_promise(&pasteboard);
    let image = if has_filenames || has_promise {
        None
    } else {
        pasteboard_image(&pasteboard)
    };
    let kind = classify_drop(
        has_filenames,
        has_promise,
        matches!(image, Some(InlineImage::Png(_))),
        matches!(image, Some(InlineImage::Tiff(_))),
    );
    let view_ref = unsafe { &*view.cast::<NSView>() };
    let (x, y) = drop_position(view_ref, drag);
    let view_ptr = view as usize;
    match kind {
        DropKind::Passthrough => {}
        DropKind::FilePromise => {
            start_file_promises(&pasteboard, view_ptr, x, y);
        }
        DropKind::InlinePng => {
            if let Some(InlineImage::Png(bytes)) = image {
                emit_written(view_ptr, x, y, write_png(&bytes));
            }
        }
        DropKind::InlineTiff => {
            if let Some(InlineImage::Tiff(bytes)) = image {
                emit_written(
                    view_ptr,
                    x,
                    y,
                    tiff_to_png(&bytes).and_then(|png| write_png(&png)),
                );
            }
        }
    }
}

/// `ProtocolObject<dyn NSDraggingInfo>` is a thin wrapper over the object.
/// The drag callback hands us that object directly.
type ProtocolDrag = objc2::runtime::ProtocolObject<dyn NSDraggingInfo>;

fn drop_position(view: &NSView, drag: &ProtocolDrag) -> (f64, f64) {
    let loc = drag.draggingLocation();
    let height = view.frame().size.height;
    // Match wry: logical points, origin at the top of the webview, truncated
    // to integers. The composer compares these with getBoundingClientRect.
    (loc.x as i32 as f64, (height - loc.y) as i32 as f64)
}

fn pasteboard_has_filenames(pasteboard: &NSPasteboard) -> bool {
    let marker = filenames_pboard_type();
    let types = NSArray::from_slice(&[marker]);
    if pasteboard.availableTypeFromArray(&types).is_none() {
        return false;
    }
    let Some(list) = pasteboard.propertyListForType(marker) else {
        return false;
    };
    list.downcast_ref::<NSArray>()
        .is_some_and(|paths| !paths.is_empty())
}

fn pasteboard_has_promise(pasteboard: &NSPasteboard) -> bool {
    let classes = NSArray::from_slice(&[NSFilePromiseReceiver::class()]);
    unsafe { pasteboard.canReadObjectForClasses_options(&classes, None) }
}

fn pasteboard_image(pasteboard: &NSPasteboard) -> Option<InlineImage> {
    if let Some(data) = pasteboard.dataForType(unsafe { NSPasteboardTypePNG }) {
        if !data.is_empty() {
            return Some(InlineImage::Png(data.to_vec()));
        }
    }
    if let Some(data) = pasteboard.dataForType(unsafe { NSPasteboardTypeTIFF }) {
        if !data.is_empty() {
            return Some(InlineImage::Tiff(data.to_vec()));
        }
    }
    None
}

fn start_file_promises(pasteboard: &NSPasteboard, view_ptr: usize, x: f64, y: f64) {
    let classes = NSArray::from_slice(&[NSFilePromiseReceiver::class()]);
    let Some(promises) = (unsafe { pasteboard.readObjectsForClasses_options(&classes, None) })
    else {
        return;
    };
    let Some(destination) = promise_destination() else {
        log::warn!("[screenshot-drop] could not create a destination directory");
        return;
    };
    let destination_url = ns_url_dir(&destination);
    let options = NSDictionary::dictionary();
    let queue = NSOperationQueue::mainQueue();
    for index in 0..promises.count() {
        let item = promises.objectAtIndex(index);
        let Some(receiver) = item.downcast_ref::<NSFilePromiseReceiver>() else {
            continue;
        };
        let dest_root = drop_root();
        let block = RcBlock::new(move |url: NonNull<NSURL>, error: *mut NSError| {
            if !error.is_null() {
                log::warn!("[screenshot-drop] file promise failed");
                return;
            }
            let path = ns_url_path(unsafe { url.as_ref() });
            let Some(path) = path.and_then(|path| contained_file(&dest_root, &path)) else {
                log::warn!("[screenshot-drop] promised file was not written into the cache dir");
                return;
            };
            emit_drop(view_ptr, x, y, vec![path]);
        });
        unsafe {
            receiver.receivePromisedFilesAtDestination_options_operationQueue_reader(
                &destination_url,
                &options,
                &queue,
                &block,
            );
        }
    }
}

fn emit_written(view_ptr: usize, x: f64, y: f64, path: Option<PathBuf>) {
    let Some(path) = path else {
        log::warn!("[screenshot-drop] could not write the screenshot");
        return;
    };
    let Some(path) = contained_file(&drop_root(), &path) else {
        return;
    };
    emit_drop(view_ptr, x, y, vec![path]);
}

fn emit_drop(view_ptr: usize, x: f64, y: f64, paths: Vec<PathBuf>) {
    let Some(app) = APP.get() else {
        log::warn!("[screenshot-drop] app handle missing");
        return;
    };
    if paths.is_empty() {
        return;
    }
    for path in &paths {
        if let Some(parent) = path.parent() {
            if let Err(err) = crate::fs_scope::allow_directory(app, parent) {
                log::warn!("[screenshot-drop] scope: {err}");
            }
        }
    }
    let payload = DragPayload {
        paths: paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        position: DragPosition { x, y },
    };
    for (_, webview) in app.webviews() {
        if webview_pointer(&webview) != Some(view_ptr) {
            continue;
        }
        if let Err(err) = webview.emit("tauri://drag-drop", &payload) {
            log::warn!("[screenshot-drop] emit failed: {err}");
        } else if let Some(name) = paths.first().and_then(|path| path.file_name()) {
            log::info!("[screenshot-drop] attached {}", name.to_string_lossy());
        }
        return;
    }
    log::warn!("[screenshot-drop] no webview matched the drop target {view_ptr:#x}");
}

fn webview_pointer(webview: &tauri::Webview) -> Option<usize> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    if webview
        .with_webview(move |platform| {
            let _ = tx.send(platform.inner() as usize);
        })
        .is_err()
    {
        return None;
    }
    rx.try_recv().ok()
}

fn union_drag_types(view: *mut AnyObject) {
    if view.is_null() {
        return;
    }
    let view_ref = unsafe { &*view.cast::<NSView>() };
    let current = type_names(&view_ref.registeredDraggedTypes());
    let extra = type_names(&NSFilePromiseReceiver::readableDraggedTypes());
    let required = required_type_names();
    let required_refs: Vec<&str> = required.iter().map(String::as_str).collect();
    let merged = merged_type_names(&current, &extra, &required_refs);
    let owned: Vec<_> = merged.iter().map(|name| NSString::from_str(name)).collect();
    let refs: Vec<&NSPasteboardType> = owned.iter().map(|name| name.as_ref()).collect();
    let array = NSArray::from_slice(&refs);
    let Some(superclass) = wry_superclass() else {
        return;
    };
    let this_ref = unsafe { &*view };
    unsafe {
        let _: () = objc2::msg_send![super(this_ref, superclass), registerForDraggedTypes: &*array];
    }
}

fn wry_superclass() -> Option<&'static AnyClass> {
    AnyClass::get(c"WryWebView")?.superclass()
}

fn type_names(types: &NSArray<NSPasteboardType>) -> Vec<String> {
    let mut names = Vec::with_capacity(types.count());
    for index in 0..types.count() {
        names.push(types.objectAtIndex(index).to_string());
    }
    names
}

fn required_type_names() -> Vec<String> {
    [
        filenames_pboard_type(),
        unsafe { NSPasteboardTypeFileURL },
        unsafe { NSPasteboardTypePNG },
        unsafe { NSPasteboardTypeTIFF },
    ]
    .into_iter()
    .map(|name| name.to_string())
    .collect()
}

fn ns_url_dir(path: &Path) -> objc2::rc::Retained<NSURL> {
    let text = path.to_string_lossy();
    NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&text), true)
}

fn ns_url_path(url: &NSURL) -> Option<PathBuf> {
    let path = url.path()?;
    let text = path.to_string();
    if text.is_empty() {
        None
    } else {
        Some(PathBuf::from(text))
    }
}

fn write_png(bytes: &[u8]) -> Option<PathBuf> {
    if bytes.is_empty() {
        return None;
    }
    let dir = fresh_drop_dir()?;
    let path = dir.join(inline_screenshot_name(chrono::Local::now()));
    std::fs::write(&path, bytes).ok()?;
    Some(path)
}

#[allow(deprecated)]
fn filenames_pboard_type() -> &'static NSPasteboardType {
    unsafe { objc2_app_kit::NSFilenamesPboardType }
}

fn tiff_to_png(tiff: &[u8]) -> Option<Vec<u8>> {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};

    if tiff.is_empty() {
        return None;
    }
    let data = objc2_foundation::NSData::with_bytes(tiff);
    let data_id = objc2::rc::Retained::as_ptr(&data) as id;
    unsafe {
        let rep: id = msg_send![class!(NSBitmapImageRep), imageRepWithData: data_id];
        if rep == nil {
            return None;
        }
        let props: id = msg_send![class!(NSDictionary), dictionary];
        let png: id = msg_send![rep, representationUsingType: BITMAP_PNG properties: props];
        if png == nil {
            return None;
        }
        let len: usize = msg_send![png, length];
        if len == 0 {
            return None;
        }
        let bytes: *const u8 = msg_send![png, bytes];
        if bytes.is_null() {
            return None;
        }
        Some(std::slice::from_raw_parts(bytes, len).to_vec())
    }
}

fn promise_destination() -> Option<PathBuf> {
    fresh_drop_dir()
}

fn fresh_drop_dir() -> Option<PathBuf> {
    let root = drop_root();
    prune_old_drops(&root);
    let dir = root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn drop_root() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_SHORT_NAME)
        .join("screenshot-drops")
}

fn prune_old_drops(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let Some(cutoff) = SystemTime::now().checked_sub(DROP_TTL) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified >= cutoff {
            continue;
        }
        if meta.is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        } else if meta.is_file() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn contained_file(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let candidate = candidate.canonicalize().ok()?;
    if candidate.starts_with(&root) && candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn classify_drop(
    has_filenames: bool,
    has_promise: bool,
    has_png: bool,
    has_tiff: bool,
) -> DropKind {
    if has_filenames {
        DropKind::Passthrough
    } else if has_promise {
        DropKind::FilePromise
    } else if has_png {
        DropKind::InlinePng
    } else if has_tiff {
        DropKind::InlineTiff
    } else {
        DropKind::Passthrough
    }
}

fn merged_type_names(current: &[String], extra: &[String], required: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for name in current
        .iter()
        .chain(extra.iter())
        .map(String::as_str)
        .chain(required.iter().copied())
    {
        push_unique(&mut out, name);
    }
    out
}

fn push_unique(out: &mut Vec<String>, name: &str) {
    if name.is_empty() || out.iter().any(|existing| existing == name) {
        return;
    }
    out.push(name.to_string());
}

fn inline_screenshot_name(now: chrono::DateTime<chrono::Local>) -> String {
    format!("Screenshot {}.png", now.format("%Y-%m-%d at %H.%M.%S"))
}

fn fn_to_imp<T>(f: &T) -> Imp {
    assert_eq!(std::mem::size_of::<T>(), std::mem::size_of::<Imp>());
    unsafe { std::mem::transmute_copy(f) }
}

fn imp_to_fn(imp: Imp) -> PerformDragOp {
    unsafe { std::mem::transmute_copy(&imp) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames_win_over_a_screenshot_promise() {
        assert_eq!(classify_drop(true, true, true, true), DropKind::Passthrough);
    }

    #[test]
    fn a_file_promise_is_how_the_thumbnail_arrives() {
        assert_eq!(
            classify_drop(false, true, true, true),
            DropKind::FilePromise
        );
    }

    #[test]
    fn png_bytes_are_used_when_there_is_no_promise() {
        assert_eq!(classify_drop(false, false, true, true), DropKind::InlinePng);
    }

    #[test]
    fn tiff_bytes_are_the_last_resort() {
        assert_eq!(
            classify_drop(false, false, false, true),
            DropKind::InlineTiff
        );
    }

    #[test]
    fn an_unrelated_drag_stays_with_wry() {
        assert_eq!(
            classify_drop(false, false, false, false),
            DropKind::Passthrough
        );
    }

    #[test]
    fn drag_types_keep_what_the_webview_already_registered() {
        let merged = merged_type_names(
            &[
                "public.file-url".to_string(),
                "NSFilenamesPboardType".to_string(),
                "public.utf8-plain-text".to_string(),
            ],
            &["com.apple.pasteboard.promised-file-url".to_string()],
            REQUIRED_DRAG_TYPES,
        );
        assert_eq!(
            merged,
            vec![
                "public.file-url",
                "NSFilenamesPboardType",
                "public.utf8-plain-text",
                "com.apple.pasteboard.promised-file-url",
                "public.png",
                "public.tiff",
            ]
        );
    }

    #[test]
    fn screenshot_name_is_a_single_png_file() {
        let name = inline_screenshot_name(chrono::Local::now());
        assert!(name.ends_with(".png"));
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
    }

    #[test]
    fn a_symlink_out_of_the_cache_dir_is_rejected() {
        let root =
            std::env::temp_dir().join(format!("screenshot-drop-test-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("screenshot-drop-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&outside, b"secret").unwrap();
        let link = root.join("link.png");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(contained_file(&root, &link).is_none());

        let inside = root.join("shot.png");
        std::fs::write(&inside, b"png").unwrap();
        assert_eq!(
            contained_file(&root, &inside).unwrap().file_name().unwrap(),
            "shot.png"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
    }
}
