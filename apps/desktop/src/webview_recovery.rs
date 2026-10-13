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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub enum RecoveryAction {
    ClearCount,
    Restart,
    LaunchHelper,
}

/// White-screen budget on Windows and macOS: one automatic restart, then the support helper.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub fn recovery_action(probe: MainWebviewProbe, prior_restarts: u32) -> RecoveryAction {
    if !should_restart_for_probe(probe) {
        return RecoveryAction::ClearCount;
    }
    if prior_restarts == 0 {
        RecoveryAction::Restart
    } else {
        RecoveryAction::LaunchHelper
    }
}

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub fn recorded_restart_count(action: RecoveryAction, prior_restarts: u32) -> u32 {
    match action {
        RecoveryAction::ClearCount => 0,
        RecoveryAction::Restart => prior_restarts.saturating_add(1),
        RecoveryAction::LaunchHelper => prior_restarts,
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn probe_name(probe: MainWebviewProbe) -> &'static str {
    match probe {
        MainWebviewProbe::Healthy => "Healthy",
        MainWebviewProbe::MissingWindow => "MissingWindow",
        MainWebviewProbe::Unresponsive => "Unresponsive",
    }
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

/// `true` means the caller should not also focus the main window.
/// A healthy probe returns `false`, so a macOS dock click still shows the window.
/// Launching the helper returns `true`, so that dock handler does not raise a blank window.
pub fn request_restart_if_main_webview_unhealthy(app: &tauri::AppHandle, reason: &str) -> bool {
    let probe = probe_main_webview(app);
    #[cfg(any(windows, target_os = "macos"))]
    {
        apply_support_recovery(app, probe, reason)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        if !should_restart_for_probe(probe) {
            return false;
        }
        restart_now(app, probe, reason)
    }
}

fn restart_now(app: &tauri::AppHandle, probe: MainWebviewProbe, reason: &str) -> bool {
    let message = format!(
        "[WebViewRecovery] Requesting app restart after {reason}; main webview probe: {probe:?}"
    );
    log::warn!("{message}");
    crate::sentry_utils::capture_warning(&message);
    app.request_restart();
    true
}

#[cfg(any(windows, target_os = "macos"))]
fn apply_support_recovery(app: &tauri::AppHandle, probe: MainWebviewProbe, reason: &str) -> bool {
    let Some(dir) = crate::support_journal::support_dir() else {
        return if should_restart_for_probe(probe) {
            restart_now(app, probe, reason)
        } else {
            false
        };
    };
    let prior = crate::support_journal::read_restart_count(&dir);
    match recovery_action(probe, prior) {
        RecoveryAction::ClearCount => {
            if prior != 0 {
                let _ = crate::support_journal::write_restart_count(
                    &dir,
                    recorded_restart_count(RecoveryAction::ClearCount, prior),
                );
            }
            false
        }
        RecoveryAction::Restart => {
            let next = recorded_restart_count(RecoveryAction::Restart, prior);
            if crate::support_journal::write_restart_count(&dir, next).is_err() {
                let launched = launch_support_helper();
                crate::support_journal::append_journal(
                    "webview_launch_helper",
                    launched,
                    probe_name(probe),
                );
                return true;
            }
            crate::support_journal::append_journal("webview_restart", true, probe_name(probe));
            restart_now(app, probe, reason)
        }
        RecoveryAction::LaunchHelper => {
            let launched = launch_support_helper();
            crate::support_journal::append_journal(
                "webview_launch_helper",
                launched,
                probe_name(probe),
            );
            let message = format!(
                "[WebViewRecovery] Support helper after {reason}; main webview probe: {probe:?}; launched={launched}"
            );
            log::warn!("{message}");
            true
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn helper_filename() -> &'static str {
    if cfg!(windows) {
        "teamclu-support.exe"
    } else {
        "teamclu-support"
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn launch_support_helper() -> bool {
    let helper = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(helper_filename())));
    let Some(helper) = helper.filter(|path| path.is_file()) else {
        message_box_missing_helper();
        return false;
    };
    let mut command = std::process::Command::new(&helper);
    command.arg("--phase").arg("webview");
    if let Some(url) = option_env!("CLOUD_API_URL") {
        if !url.is_empty() {
            command.arg("--api-url").arg(url);
        }
    }
    match command.spawn() {
        Ok(_) => true,
        Err(err) => {
            log::warn!("[WebViewRecovery] failed to start support helper: {err}");
            message_box_missing_helper();
            false
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn message_box_missing_helper() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK};
        let text: Vec<u16> = "找不到 TeamClu 支持助手。请从开始菜单打开「TeamClu 支持助手」，或向支持人员索取单独的 teamclu-support.exe。\0"
            .encode_utf16()
            .collect();
        let title: Vec<u16> = "TeamClu\0".encode_utf16().collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONINFORMATION,
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        let script = "display alert \"TeamClu\" message \"找不到 TeamClu 支持助手。请向支持人员索取单独的 teamclu-support。\"";
        let _ = std::process::Command::new("osascript")
            .args(["-e", script])
            .spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_main_webview_url, recorded_restart_count, recovery_action,
        should_restart_for_probe, MainWebviewProbe, RecoveryAction,
    };

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

    #[test]
    fn recovery_action_restarts_once_then_launches_the_helper() {
        assert_eq!(
            recovery_action(MainWebviewProbe::Healthy, 4),
            RecoveryAction::ClearCount
        );
        assert_eq!(
            recovery_action(MainWebviewProbe::MissingWindow, 0),
            RecoveryAction::Restart
        );
        assert_eq!(
            recovery_action(MainWebviewProbe::Unresponsive, 0),
            RecoveryAction::Restart
        );
        assert_eq!(
            recovery_action(MainWebviewProbe::MissingWindow, 1),
            RecoveryAction::LaunchHelper
        );
        assert_eq!(
            recovery_action(MainWebviewProbe::Unresponsive, 2),
            RecoveryAction::LaunchHelper
        );
    }

    #[test]
    fn healthy_clears_the_restart_count() {
        let dir = std::env::temp_dir().join(format!("teamclu-recovery-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        crate::support_journal::write_restart_count(&dir, 2).unwrap();
        let prior = crate::support_journal::read_restart_count(&dir);
        let action = recovery_action(MainWebviewProbe::Healthy, prior);
        assert_eq!(action, RecoveryAction::ClearCount);
        crate::support_journal::write_restart_count(&dir, recorded_restart_count(action, prior))
            .unwrap();
        assert_eq!(crate::support_journal::read_restart_count(&dir), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
