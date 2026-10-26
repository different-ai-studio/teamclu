//! Win32 TaskDialog verification checkbox, parented to the app HWND.
use super::{CheckboxApproval, DialogState, NativeClose, DECLINED};
use std::sync::Arc;
use tauri::AppHandle;
use windows_sys::Win32::{
    Foundation::HWND,
    UI::{
        Controls::*,
        WindowsAndMessaging::{IsWindow, SendMessageW},
    },
};

const PUBLISH: i32 = 100;
const DECLINE: i32 = 2; // IDCANCEL: Escape/window close has the same rejection path.

fn wide(text: &str) -> Vec<u16> {
    text.replace('\0', " ")
        .encode_utf16()
        .chain(Some(0))
        .collect()
}
fn choice(status: i32, button: i32, checked: i32) -> Result<bool, String> {
    if status < 0 {
        Err(format!(
            "The native deployment approval failed ({status:#x}). Nothing was deployed."
        ))
    } else if button == PUBLISH {
        Ok(checked != 0)
    } else {
        Err(DECLINED.into())
    }
}

struct Callback {
    state: Arc<DialogState>,
    parent: HWND,
}

unsafe extern "system" fn callback(
    hwnd: HWND,
    notification: u32,
    _: usize,
    _: isize,
    data: isize,
) -> i32 {
    let callback = &*(data as *const Callback);
    if notification == TDN_CREATED as u32 || notification == TDN_TIMER as u32 {
        if IsWindow(callback.parent) == 0 {
            callback.state.decide(Err(DECLINED.into()));
        }
        if !callback.state.is_pending() {
            // This HWND comes from this exact dialog's callback. No global HWND
            // or posted stale handle can close/approve a later request.
            SendMessageW(hwnd, TDM_CLICK_BUTTON as u32, DECLINE as usize, 0);
        }
    }
    0 // S_OK
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
    app.run_on_main_thread(move || unsafe {
        if !state.is_pending() {
            state.finish(Err(DECLINED.into()));
            return;
        }
        let Ok(parent) = window.hwnd() else {
            state.finish(Err(DECLINED.into()));
            return;
        };
        let title = wide(&request.title);
        let message = wide(&request.message);
        let accept = wide(&request.accept);
        let decline = wide(&request.decline);
        let label = wide(&request.checkbox_label);
        let buttons = [
            TASKDIALOG_BUTTON {
                nButtonID: PUBLISH,
                pszButtonText: accept.as_ptr(),
            },
            TASKDIALOG_BUTTON {
                nButtonID: DECLINE,
                pszButtonText: decline.as_ptr(),
            },
        ];
        let callback_data = Callback {
            state: state.clone(),
            parent: parent.0 as HWND,
        };
        let config = TASKDIALOGCONFIG {
            cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
            hwndParent: callback_data.parent,
            dwFlags: TDF_ALLOW_DIALOG_CANCELLATION
                | TDF_CALLBACK_TIMER
                | TDF_POSITION_RELATIVE_TO_WINDOW,
            pszWindowTitle: title.as_ptr(),
            pszMainInstruction: title.as_ptr(),
            pszContent: message.as_ptr(),
            cButtons: buttons.len() as u32,
            pButtons: buttons.as_ptr(),
            nDefaultButton: DECLINE,
            pszVerificationText: label.as_ptr(),
            pfCallback: Some(callback),
            lpCallbackData: &callback_data as *const Callback as isize,
            ..std::mem::zeroed()
        };
        let mut button = DECLINE;
        let mut checked = 0; // No TDF_VERIFICATION_FLAG_CHECKED; always off initially.
        let status = TaskDialogIndirect(&config, &mut button, std::ptr::null_mut(), &mut checked);
        // TaskDialogIndirect returns only after native destruction. A non-null
        // checked output enables the verification widget.
        state.finish(choice(status, button, checked));
    })
    .map_err(|e| format!("Could not show the native deployment approval: {e}"))?;
    // Shared timeout changes state; the dialog's native timer closes it even
    // while TaskDialogIndirect runs its modal message loop on the main thread.
    Ok(Box::new(|| {}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_domain_windows_errors_and_cancel_never_approve() {
        assert_eq!(super::choice(0, 100, 0), Ok(false));
        assert_eq!(super::choice(0, 100, 1), Ok(true));
        assert!(super::choice(-1, 100, 1).is_err());
        for button in [0, 2, 101] {
            assert!(super::choice(0, button, 1).is_err());
        }
    }
}
