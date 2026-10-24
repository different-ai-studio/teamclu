//! GTK 3 native dialog and check button; all GTK access stays on the main thread.
use super::{CheckboxApproval, DialogState, NativeClose, DECLINED};
use gtk::{prelude::*, DialogFlags, ResponseType};
use std::{sync::Arc, time::Duration};
use tauri::AppHandle;

fn choice(response: ResponseType, checked: bool) -> Result<bool, String> {
    if response == ResponseType::Accept {
        Ok(checked)
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
    app.run_on_main_thread(move || {
        if !state.is_pending() {
            state.finish(Err(DECLINED.into()));
            return;
        }
        let Ok(parent) = window.gtk_window() else {
            state.finish(Err(DECLINED.into()));
            return;
        };
        let dialog = gtk::Dialog::with_buttons(
            Some(&request.title),
            Some(&parent),
            DialogFlags::MODAL | DialogFlags::DESTROY_WITH_PARENT,
            &[
                (&request.decline, ResponseType::Cancel),
                (&request.accept, ResponseType::Accept),
            ],
        );
        dialog.set_default_response(ResponseType::Cancel);
        let content = dialog.content_area();
        content.set_spacing(12);
        content.set_border_width(18);
        let message = gtk::Label::new(Some(&request.message));
        message.set_line_wrap(true);
        message.set_max_width_chars(72);
        message.set_xalign(0.0);
        content.add(&message);
        let checkbox = gtk::CheckButton::with_label(&request.checkbox_label);
        checkbox.set_active(false);
        content.add(&checkbox);
        let decision = state.clone();
        dialog.connect_response(move |dialog, response| {
            decision.decide(choice(response, checkbox.is_active()));
            unsafe {
                dialog.destroy();
            }
        });
        let finished = state.clone();
        dialog.connect_destroy(move |_| finished.finish(Err(DECLINED.into())));
        let weak_dialog = dialog.downgrade();
        // A GTK timer runs on this main context. It closes only this widget;
        // timeout does not send a command through any agent-controlled webview.
        gtk::glib::timeout_add_local(Duration::from_millis(50), move || {
            let Some(dialog) = weak_dialog.upgrade() else {
                return gtk::glib::ControlFlow::Break;
            };
            if !state.is_pending() {
                unsafe {
                    dialog.destroy();
                }
                gtk::glib::ControlFlow::Break
            } else {
                gtk::glib::ControlFlow::Continue
            }
        });
        dialog.show_all();
    })
    .map_err(|e| format!("Could not show the native deployment approval: {e}"))?;
    Ok(Box::new(|| {}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_domain_linux_only_accept_returns_checkbox_value() {
        use gtk::ResponseType;
        assert_eq!(super::choice(ResponseType::Accept, false), Ok(false));
        assert_eq!(super::choice(ResponseType::Accept, true), Ok(true));
        for response in [
            ResponseType::Cancel,
            ResponseType::DeleteEvent,
            ResponseType::Close,
            ResponseType::None,
        ] {
            assert!(super::choice(response, true).is_err());
        }
    }
}
