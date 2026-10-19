//! The optional code-domain checkbox in the native publish approval.
use super::{app_deploy, confirm_with_user, CONFIRM_TIMEOUT, ONE_AT_A_TIME};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock, Weak,
};
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::{oneshot, Notify};

#[cfg(target_os = "macos")]
#[path = "app_domain/macos.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "app_domain/windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "app_domain/linux.rs"]
mod platform;

pub(crate) const DECLINED: &str = "The user declined or dismissed the deployment. Nothing was deployed; do not retry unless asked.";
const TIMED_OUT: &str = "Nobody approved the deployment within two minutes. Nothing was deployed; do not retry unless asked.";

#[derive(Debug, Clone)]
pub(crate) struct CheckboxApproval {
    pub(crate) title: String,
    pub(crate) message: String,
    pub(crate) accept: String,
    pub(crate) decline: String,
    pub(crate) checkbox_label: String,
}

pub(crate) type NativeClose = Box<dyn FnOnce() + Send>;

/// Each attempt owns its own sender. Taking it is the only transition out of
/// Pending; a late click, timeout, or parent-close cannot replace the decision.
#[derive(Debug)]
pub(crate) struct DialogState {
    sender: Mutex<Option<oneshot::Sender<Result<bool, String>>>>,
    closed: AtomicBool,
    closed_notify: Notify,
}

impl DialogState {
    pub(crate) fn is_pending(&self) -> bool {
        self.sender.lock().unwrap().is_some()
    }

    pub(crate) fn decide(&self, result: Result<bool, String>) {
        if let Some(sender) = self.sender.lock().unwrap().take() {
            let _ = sender.send(result);
        }
    }

    /// Called only after the adapter has disposed of its native window (or
    /// failed to create one). Never release the display mutex just on timeout.
    pub(crate) fn finish(&self, result: Result<bool, String>) {
        self.decide(result);
        self.closed.store(true, Ordering::Release);
        self.closed_notify.notify_one();
    }

    async fn wait_closed(&self) {
        while !self.closed.load(Ordering::Acquire) {
            self.closed_notify.notified().await;
        }
    }
}

/// Shared production orchestration; only OS widget creation/closure is injected.
async fn run_checkbox_inner(
    request: CheckboxApproval,
    timeout: Duration,
    present: impl FnOnce(CheckboxApproval, Arc<DialogState>) -> Result<NativeClose, String>,
) -> Result<bool, String> {
    let _turn = ONE_AT_A_TIME
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let (sender, receiver) = oneshot::channel();
    let state = Arc::new(DialogState {
        sender: Mutex::new(Some(sender)),
        closed: AtomicBool::new(false),
        closed_notify: Notify::new(),
    });
    let close = present(request, state.clone())?;
    let result = match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("The native deployment approval failed. Nothing was deployed.".into()),
        Err(_) => {
            state.decide(Err(TIMED_OUT.into()));
            Err(TIMED_OUT.into())
        }
    };
    close();
    state.wait_closed().await;
    result
}

/// The task owns the mutex until native teardown even if its HTTP caller is dropped.
pub(crate) async fn run_checkbox(
    request: CheckboxApproval,
    timeout: Duration,
    present: impl FnOnce(CheckboxApproval, Arc<DialogState>) -> Result<NativeClose, String>
        + Send
        + 'static,
) -> Result<bool, String> {
    tokio::spawn(run_checkbox_inner(request, timeout, present))
        .await
        .map_err(|e| format!("The native deployment approval failed: {e}"))?
}

pub(crate) async fn show_checkbox(
    app: &AppHandle,
    request: CheckboxApproval,
    timeout: Duration,
) -> Result<bool, String> {
    let app = app.clone();
    run_checkbox(request, timeout, move |request, state| {
        platform::present(&app, request, state)
    })
    .await
}

/// The app may turn CloseRequested into hide-to-tray. Observe the native window
/// event as well as OS destruction. One listener per window, only a weak current
/// attempt: no per-request listener leak and no retained approval value.
pub(super) fn watch_parent(window: &tauri::Window, state: &Arc<DialogState>) {
    static PARENTS: OnceLock<Mutex<std::collections::HashMap<String, Weak<DialogState>>>> =
        OnceLock::new();
    let parents = PARENTS.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let label = window.label().to_owned();
    let first = parents
        .lock()
        .unwrap()
        .insert(label.clone(), Arc::downgrade(state))
        .is_none();
    if first {
        window.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                let state = {
                    let mut parents = parents.lock().unwrap();
                    let state = parents.get(&label).and_then(Weak::upgrade);
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        parents.remove(&label);
                    }
                    state
                };
                if let Some(state) = state {
                    state.decide(Err(DECLINED.into()));
                }
            }
        });
    }
}

/// Only old apps currently serving their old public domain get a checkbox.
pub(crate) fn legacy_app_domain_choice(row: &Value) -> Option<(String, String)> {
    if row.get("usesAppCodeDomain")?.as_bool()? || row.get("fcStatus")?.as_str()? != "live" {
        return None;
    }
    if row.get("fcEndpoint")?.as_str()?.trim().is_empty() {
        return None;
    }
    let current = row.get("publicUrl")?.as_str()?.trim();
    let code = row.get("appCodeUrl")?.as_str()?.trim();
    if current.is_empty() || code.is_empty() || current == code {
        return None;
    }
    Some((current.to_owned(), code.to_owned()))
}

/// The agent never supplies a choice. Every eligible attempt gets a fresh,
/// unchecked native widget, including retries after a failed deployment.
pub(crate) async fn confirm_app_deploy_domain(
    app: &AppHandle,
    zh: bool,
    row: &Value,
) -> Result<bool, String> {
    let Some((_current, code)) = legacy_app_domain_choice(row) else {
        confirm_with_user(app, app_deploy(zh, row)).await?;
        return Ok(false);
    };
    let mut request = app_deploy(zh, row);
    request.message.push_str(&if zh {
        format!("\n\n可选的新域名：{code}\n默认保留当前域名。勾选后仅在本次部署成功时切换，原域名仍可访问。")
    } else {
        format!("\n\nOptional new domain: {code}\nKeep the current domain by default. Switching takes effect only after this deployment succeeds; the old domain remains available.")
    });
    show_checkbox(
        app,
        CheckboxApproval {
            title: request.title,
            message: request.message,
            accept: request.accept,
            decline: if zh { "拒绝" } else { "Decline" }.into(),
            checkbox_label: if zh {
                "部署成功后，改用应用代码域名"
            } else {
                "Use the app-code domain after deployment succeeds"
            }
            .into(),
        },
        CONFIRM_TIMEOUT,
    )
    .await
}
