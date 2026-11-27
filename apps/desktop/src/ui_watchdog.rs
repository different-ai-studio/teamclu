//! Reports a frozen UI to Sentry from the Rust process.
//!
//! When the WebView's renderer is stuck (a long render, a layout loop), the
//! page itself cannot report anything: its JS thread is the thing that is
//! stuck. Windows then shows "TeamClu 未响应" (WER `AppHangXProcB1`, a
//! cross-process hang: the window thread waits on the renderer) and the user
//! force-closes the app. None of that reached Sentry.
//!
//! The page sends `ui_heartbeat` every couple of seconds while it is visible.
//! A thread here notices when the heartbeats stop and reports the stall from
//! the Rust side, where the event loop and Sentry's transport thread are still
//! free. Three events can come out of one freeze:
//!
//! - `ui_unresponsive`: no heartbeat for [`STALL_THRESHOLD`] while visible.
//! - `ui_unresponsive_recovered`: heartbeats came back; carries how long.
//! - `ui_unresponsive_quit`: the app was quit or killed while still frozen,
//!   found on the next launch through a marker file.
//!
//! The watchdog never calls window APIs: on macOS those dispatch to the main
//! thread and would block on the very freeze being measured. Visibility comes
//! from the page (`document.visibilityState`), which also covers minimized
//! windows, where browsers throttle timers and heartbeats legitimately stop.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// No heartbeat for this long while visible counts as a freeze. Windows marks
/// a window "not responding" after ~5s; 15s keeps slow-but-alive moments out.
const STALL_THRESHOLD: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// A poll that wakes up much later than [`POLL_INTERVAL`] means the machine
/// slept (Windows' monotonic clock keeps counting through sleep). Heartbeats
/// could not arrive either, so the gap is not a freeze.
const SLEEP_GAP: Duration = Duration::from_secs(10);
const MARKER_FILE: &str = "ui-hang.json";

/// The most recent long task the page observed before this heartbeat.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LongTaskInfo {
    pub duration_ms: f64,
    /// Milliseconds before the heartbeat was sent.
    pub ago_ms: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiBeat {
    pub visible: bool,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub last_long_task: Option<LongTaskInfo>,
    #[serde(default)]
    pub long_tasks_last_minute: u32,
}

#[derive(Debug, Default)]
struct WatchState {
    last_beat: Option<Instant>,
    visible: bool,
    route: String,
    last_long_task: Option<LongTaskInfo>,
    long_tasks_last_minute: u32,
    /// Set once a stall has been reported, so one freeze is one event.
    stalled_since: Option<Instant>,
}

#[derive(Debug, PartialEq)]
enum PollAction {
    Nothing,
    ReportStall { silent_for: Duration },
}

#[derive(Debug, PartialEq)]
enum BeatAction {
    Nothing,
    ReportRecovered { frozen_for: Duration },
}

fn state() -> &'static Mutex<WatchState> {
    static STATE: OnceLock<Mutex<WatchState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(WatchState::default()))
}

impl WatchState {
    fn on_beat(&mut self, beat: UiBeat, now: Instant) -> BeatAction {
        let action = match (self.stalled_since, self.last_beat) {
            (Some(_), Some(last)) => BeatAction::ReportRecovered {
                frozen_for: now.saturating_duration_since(last),
            },
            _ => BeatAction::Nothing,
        };
        self.last_beat = Some(now);
        self.visible = beat.visible;
        if let Some(route) = beat.route {
            self.route = route;
        }
        self.last_long_task = beat.last_long_task;
        self.long_tasks_last_minute = beat.long_tasks_last_minute;
        self.stalled_since = None;
        action
    }

    fn on_poll(&mut self, now: Instant, slept: bool) -> PollAction {
        let Some(last) = self.last_beat else {
            return PollAction::Nothing; // page has not loaded yet
        };
        if slept {
            // Restart the clock instead of reporting the sleep as a freeze.
            self.last_beat = Some(now);
            return PollAction::Nothing;
        }
        if !self.visible || self.stalled_since.is_some() {
            return PollAction::Nothing;
        }
        let silent_for = now.saturating_duration_since(last);
        if silent_for < STALL_THRESHOLD {
            return PollAction::Nothing;
        }
        self.stalled_since = Some(now);
        PollAction::ReportStall { silent_for }
    }
}

/// Heartbeat from the page. Async so it runs on the runtime pool rather than
/// queueing behind the main thread.
#[tauri::command]
pub async fn ui_heartbeat(beat: UiBeat) {
    let action = match state().lock() {
        Ok(mut guard) => guard.on_beat(beat, Instant::now()),
        Err(_) => return,
    };
    if let BeatAction::ReportRecovered { frozen_for } = action {
        clear_marker();
        let snapshot = snapshot();
        report(
            "ui_unresponsive_recovered",
            sentry::Level::Warning,
            &snapshot,
            Some(frozen_for),
        );
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    route: String,
    last_long_task: Option<LongTaskInfo>,
    long_tasks_last_minute: u32,
    /// Unix seconds when the stall was detected (marker file only).
    #[serde(default)]
    detected_at: u64,
}

fn snapshot() -> Snapshot {
    state()
        .lock()
        .map(|s| Snapshot {
            route: s.route.clone(),
            last_long_task: s.last_long_task.clone(),
            long_tasks_last_minute: s.long_tasks_last_minute,
            detected_at: 0,
        })
        .unwrap_or_default()
}

fn webview_version() -> String {
    tauri::webview_version().unwrap_or_else(|_| "unknown".into())
}

/// Coarse duration bucket for a tag, so issues can be filtered by severity.
fn duration_bucket(d: Duration) -> &'static str {
    match d.as_secs() {
        0..=29 => "15-30s",
        30..=59 => "30-60s",
        60..=299 => "1-5min",
        _ => "5min+",
    }
}

fn report(kind: &str, level: sentry::Level, snap: &Snapshot, duration: Option<Duration>) {
    let route = if snap.route.is_empty() {
        "unknown"
    } else {
        snap.route.as_str()
    };
    let message = match duration {
        Some(d) => format!("{kind}: route={route} for {}s", d.as_secs()),
        None => format!("{kind}: route={route}"),
    };
    crate::soft_log::warn(&format!("[UiWatchdog] {message}"));
    sentry::with_scope(
        |scope| {
            scope.set_tag("ui.kind", kind);
            scope.set_tag("ui.route", route);
            scope.set_tag("webview.version", webview_version());
            if let Some(d) = duration {
                scope.set_tag("ui.frozen", duration_bucket(d));
                scope.set_extra("frozen_secs", d.as_secs().into());
            }
            if let Some(task) = &snap.last_long_task {
                scope.set_extra("last_long_task_ms", task.duration_ms.into());
                scope.set_extra("last_long_task_ago_ms", task.ago_ms.into());
            }
            scope.set_extra("long_tasks_last_minute", snap.long_tasks_last_minute.into());
            // One issue per kind and page, not one per duration.
            scope.set_fingerprint(Some(&[kind, route]));
        },
        || sentry::capture_message(&message, level),
    );
}

fn marker_path() -> PathBuf {
    crate::commands::brand_home_dir().join(MARKER_FILE)
}

fn write_marker(snap: &Snapshot) {
    let mut snap = snap.clone();
    snap.detected_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(json) = serde_json::to_vec(&snap) {
        let _ = std::fs::write(marker_path(), json);
    }
}

fn clear_marker() {
    let _ = std::fs::remove_file(marker_path());
}

/// A marker left by the previous run means it ended while frozen.
fn report_previous_run() {
    let path = marker_path();
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    let Ok(snap) = serde_json::from_slice::<Snapshot>(&bytes) else {
        return;
    };
    report("ui_unresponsive_quit", sentry::Level::Error, &snap, None);
}

/// Start the watchdog thread. Call once from setup.
pub fn spawn(app: tauri::AppHandle) {
    report_previous_run();
    let spawned = std::thread::Builder::new()
        .name("ui-watchdog".into())
        .spawn(move || {
            let mut last_poll = Instant::now();
            loop {
                std::thread::sleep(POLL_INTERVAL);
                let now = Instant::now();
                let slept = now.saturating_duration_since(last_poll) > SLEEP_GAP;
                last_poll = now;

                if is_exiting(&app) {
                    return;
                }
                let action = match state().lock() {
                    Ok(mut guard) => guard.on_poll(now, slept),
                    Err(_) => return,
                };
                if let PollAction::ReportStall { silent_for } = action {
                    let snap = snapshot();
                    write_marker(&snap);
                    report(
                        "ui_unresponsive",
                        sentry::Level::Error,
                        &snap,
                        Some(silent_for),
                    );
                }
            }
        });
    if let Err(err) = spawned {
        log::warn!("[UiWatchdog] failed to start: {err}");
    }
}

fn is_exiting(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    app.try_state::<crate::commands::amuxd_supervisor::AmuxdSupervisor>()
        .is_some_and(|s| s.is_exiting())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn beat(visible: bool) -> UiBeat {
        UiBeat {
            visible,
            route: Some("skills".into()),
            last_long_task: None,
            long_tasks_last_minute: 0,
        }
    }

    #[test]
    fn no_report_before_first_heartbeat() {
        let mut s = WatchState::default();
        let t0 = Instant::now();
        assert_eq!(
            s.on_poll(t0 + Duration::from_secs(60), false),
            PollAction::Nothing
        );
    }

    #[test]
    fn reports_once_per_freeze_and_then_recovery() {
        let mut s = WatchState::default();
        let t0 = Instant::now();
        s.on_beat(beat(true), t0);
        assert_eq!(
            s.on_poll(t0 + Duration::from_secs(10), false),
            PollAction::Nothing
        );
        assert_eq!(
            s.on_poll(t0 + Duration::from_secs(16), false),
            PollAction::ReportStall {
                silent_for: Duration::from_secs(16)
            }
        );
        // Still frozen: not reported again.
        assert_eq!(
            s.on_poll(t0 + Duration::from_secs(40), false),
            PollAction::Nothing
        );
        assert_eq!(
            s.on_beat(beat(true), t0 + Duration::from_secs(50)),
            BeatAction::ReportRecovered {
                frozen_for: Duration::from_secs(50)
            }
        );
        // A later freeze is a new event.
        assert!(matches!(
            s.on_poll(t0 + Duration::from_secs(70), false),
            PollAction::ReportStall { .. }
        ));
    }

    #[test]
    fn hidden_page_is_not_a_freeze() {
        let mut s = WatchState::default();
        let t0 = Instant::now();
        s.on_beat(beat(false), t0);
        assert_eq!(
            s.on_poll(t0 + Duration::from_secs(120), false),
            PollAction::Nothing
        );
        assert_eq!(
            s.on_beat(beat(true), t0 + Duration::from_secs(121)),
            BeatAction::Nothing
        );
    }

    #[test]
    fn machine_sleep_restarts_the_clock() {
        let mut s = WatchState::default();
        let t0 = Instant::now();
        s.on_beat(beat(true), t0);
        assert_eq!(
            s.on_poll(t0 + Duration::from_secs(600), true),
            PollAction::Nothing
        );
        assert_eq!(
            s.on_poll(t0 + Duration::from_secs(605), false),
            PollAction::Nothing
        );
    }

    #[test]
    fn route_is_kept_when_a_beat_omits_it() {
        let mut s = WatchState::default();
        let t0 = Instant::now();
        s.on_beat(beat(true), t0);
        let mut b = beat(true);
        b.route = None;
        s.on_beat(b, t0 + Duration::from_secs(2));
        assert_eq!(s.route, "skills");
    }
}
