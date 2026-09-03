use tauri::Manager;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainWebviewProbe {
    Healthy,
    MissingWindow,
    Unresponsive,
}

pub fn should_restart_for_probe(probe: MainWebviewProbe) -> bool {
    matches!(
        probe,
        MainWebviewProbe::MissingWindow | MainWebviewProbe::Unresponsive
    )
}

pub fn probe_main_webview(app: &tauri::AppHandle) -> MainWebviewProbe {
    let Some(window) = app.get_webview_window("main") else {
        return MainWebviewProbe::MissingWindow;
    };

    match window.url() {
        Ok(_) => MainWebviewProbe::Healthy,
        Err(err) => {
            log::error!("[WebViewRecovery] main webview URL probe failed: {err}");
            MainWebviewProbe::Unresponsive
        }
    }
}

pub fn request_restart_if_main_webview_unhealthy(app: &tauri::AppHandle, reason: &str) -> bool {
    let probe = probe_main_webview(app);
    if !should_restart_for_probe(probe) {
        return false;
    }

    let message = format!(
        "[WebViewRecovery] Requesting app restart after {reason}; main webview probe: {probe:?}"
    );
    log::warn!("{message}");
    crate::sentry_utils::capture_warning(&message);
    app.request_restart();
    true
}

#[cfg(test)]
mod tests {
    use super::{should_restart_for_probe, MainWebviewProbe};

    #[test]
    fn restarts_when_main_webview_is_unresponsive() {
        assert!(should_restart_for_probe(MainWebviewProbe::Unresponsive));
    }

    #[test]
    fn does_not_restart_when_main_webview_is_healthy() {
        assert!(!should_restart_for_probe(MainWebviewProbe::Healthy));
    }

    #[test]
    fn restarts_when_main_webview_is_missing() {
        assert!(should_restart_for_probe(MainWebviewProbe::MissingWindow));
    }
}
