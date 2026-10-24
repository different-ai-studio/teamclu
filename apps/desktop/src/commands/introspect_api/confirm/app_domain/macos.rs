//! AppKit sheet with a real NSButton checkbox. All object access is main-thread only.
use super::{CheckboxApproval, DialogState, NativeClose, DECLINED};
use block2::RcBlock;
use objc2::{class, msg_send, runtime::AnyObject};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::AppHandle;

unsafe fn string(text: &str) -> *mut AnyObject {
    let text = std::ffi::CString::new(text.replace('\0', " ")).unwrap();
    msg_send![class!(NSString), stringWithUTF8String: text.as_ptr()]
}

fn choice(response: isize, checked: isize) -> Result<bool, String> {
    if response == 1000 {
        Ok(checked == 1)
    } else {
        Err(DECLINED.into())
    }
}

pub(super) fn present(
    app: &AppHandle,
    request: CheckboxApproval,
    state: Arc<DialogState>,
) -> Result<NativeClose, String> {
    let window = crate::commands::window_chrome::get_main_window(app)
        .ok_or("The app has no window for the native deployment approval. Nothing was deployed.")?;
    super::watch_parent(&window, &state);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let live = Arc::new(AtomicUsize::new(0));
    let active = live.clone();
    let showing = state.clone();
    app.run_on_main_thread(move || unsafe {
        if !showing.is_pending() {
            showing.finish(Err(DECLINED.into()));
            return;
        }
        let Ok(parent) = window.ns_window() else {
            showing.finish(Err("The parent window is unavailable. Nothing was deployed.".into()));
            return;
        };
        let alert: *mut AnyObject = msg_send![class!(NSAlert), new];
        if alert.is_null() {
            showing.finish(Err("Could not create the native deployment approval.".into()));
            return;
        }
        let _: () = msg_send![alert, setMessageText: string(&request.title)];
        let _: () = msg_send![alert, setInformativeText: string(&request.message)];
        let _: () = msg_send![alert, setAlertStyle: 1usize];
        let _: *mut AnyObject = msg_send![alert, addButtonWithTitle: string(&request.accept)];
        let decline: *mut AnyObject = msg_send![alert, addButtonWithTitle: string(&request.decline)];
        let _: () = msg_send![decline, setKeyEquivalent: string("\u{1b}")];
        let _: () = msg_send![alert, setShowsSuppressionButton: true];
        let checkbox: *mut AnyObject = msg_send![alert, suppressionButton];
        if checkbox.is_null() {
            objc2::ffi::objc_release(alert.cast());
            showing.finish(Err("Could not create the native deployment checkbox.".into()));
            return;
        }
        let _: () = msg_send![checkbox, setTitle: string(&request.checkbox_label)];
        let _: () = msg_send![checkbox, setState: 0isize];
        let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
        let on_parent_close = showing.clone();
        let parent_closed = RcBlock::new(move |_: *mut AnyObject| {
            // Rejection wins before AppKit can deliver a sheet completion.
            on_parent_close.decide(Err(DECLINED.into()));
        });
        let observer: *mut AnyObject = msg_send![center,
            addObserverForName: string("NSWindowWillCloseNotification"),
            object: parent.cast::<AnyObject>(), queue: std::ptr::null::<AnyObject>(),
            usingBlock: &*parent_closed];
        active.store(alert as usize, Ordering::Release);
        let completion = RcBlock::new(move |response: isize| {
            let checked: isize = msg_send![checkbox, state];
            let sheet: *mut AnyObject = msg_send![alert, window];
            let _: () = msg_send![sheet, orderOut: std::ptr::null::<AnyObject>()];
            active.store(0, Ordering::Release);
            let _: () = msg_send![center, removeObserver: observer];
            objc2::ffi::objc_release(alert.cast());
            showing.finish(choice(response, checked));
        });
        let _: () = msg_send![alert, beginSheetModalForWindow: parent.cast::<AnyObject>(), completionHandler: &*completion];
    }).map_err(|e| format!("Could not show the native deployment approval: {e}"))?;
    let app = app.clone();
    Ok(Box::new(move || {
        // Read the pointer only on the same main thread that clears/releases it.
        if let Err(error) = app.run_on_main_thread(move || unsafe {
            let alert = live.load(Ordering::Acquire) as *mut AnyObject;
            if !alert.is_null() {
                let sheet: *mut AnyObject = msg_send![alert, window];
                let parent: *mut AnyObject = msg_send![sheet, sheetParent];
                if !parent.is_null() {
                    let _: () = msg_send![parent, endSheet: sheet, returnCode: 1001isize];
                }
            }
        }) {
            // Fail closed: retain the display lock until native completion.
            log::error!("Could not dispatch deployment approval cleanup: {error}");
        }
    }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_domain_macos_only_publish_returns_checkbox_value() {
        assert_eq!(super::choice(1000, 0), Ok(false));
        assert_eq!(super::choice(1000, 1), Ok(true));
        for response in [1001, 1002, 0, -1000] {
            assert!(super::choice(response, 1).is_err());
        }
    }
}
