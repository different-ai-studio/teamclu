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

/// Probe the main *webview*, not Tauri's `get_webview_window("main")`.
///
/// `get_webview_window` returns `None` as soon as the window hosts any child
/// webview whose label differs from `"main"` (native URL tabs). Tauri 2.11
/// treats that as "not a WebviewWindow" (`is_webview_window` requires every
/// attached webview to share the window label). Dock click / sleep-wake then
/// used to restart the whole app even though the main webview was healthy.
pub fn probe_main_webview(app: &tauri::AppHandle) -> MainWebviewProbe {
    classify_main_webview_url(app.get_webview("main").map(|webview| {
        crate::commands::webview::webview_url_safe(&webview)
            .map(|_| ())
            .map_err(|err| {
                log::error!("[WebViewRecovery] main webview URL probe failed: {err}");
                err
            })
    }))
}

fn classify_main_webview_url(url: Option<Result<(), String>>) -> MainWebviewProbe {
    match url {
        None => MainWebviewProbe::MissingWindow,
        Some(Ok(())) => MainWebviewProbe::Healthy,
        Some(Err(_)) => MainWebviewProbe::Unresponsive,
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
    use super::{classify_main_webview_url, should_restart_for_probe, MainWebviewProbe};

    /// Replica of Tauri 2.11 `Window::is_webview_window`: true iff every
    /// webview on the window uses the window's own label.
    fn tauri_is_webview_window(window_label: &str, webview_labels: &[&str]) -> bool {
        webview_labels.iter().all(|label| *label == window_label)
    }

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

    #[test]
    fn get_webview_window_misses_main_once_a_child_webview_exists() {
        assert!(tauri_is_webview_window("main", &["main"]));
        assert!(!tauri_is_webview_window(
            "main",
            &["main", "wv-main-https___github_com_kunchenguid_gnhf"]
        ));
    }

    #[test]
    fn child_webview_does_not_count_as_missing_main() {
        let probe = classify_main_webview_url(Some(Ok(())));
        assert_eq!(probe, MainWebviewProbe::Healthy);
        assert!(!should_restart_for_probe(probe));
    }

    #[test]
    fn missing_main_webview_still_restarts() {
        let probe = classify_main_webview_url(None);
        assert_eq!(probe, MainWebviewProbe::MissingWindow);
        assert!(should_restart_for_probe(probe));
    }
}
