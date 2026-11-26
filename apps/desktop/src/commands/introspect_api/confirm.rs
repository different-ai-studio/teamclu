//! Actions the user has to approve before an agent may take them.
//!
//! Replacing a workspace's MCP servers — which is running commands on this
//! machine — waits for a native dialog in this app. Declined, or unanswered
//! for [`CONFIRM_TIMEOUT`], and nothing happens. (Apps used to ask here too;
//! they are `amuxd app` now, where the platform's grants alone decide.)
//! Native on purpose: the webview renders model output, and nothing in it
//! can press a system dialog's button.
//!
//! The question stands for every caller that gets past the bearer gate.
//!
//! The dialog shows on this machine even when the agent was driven from
//! elsewhere — WeCom, iOS, a cron run — so with nobody here those calls time out.
//! That is the chosen trade: nothing irreversible or public happens unless
//! someone at the computer holding the credentials says yes.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

/// How long a dialog waits before the call is refused.
pub(crate) const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

static ONE_AT_A_TIME: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// One approval dialog: what is asked, and the label of the button that says yes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Confirmation {
    pub(crate) title: String,
    pub(crate) message: String,
    pub(crate) accept: String,
}

/// Show `request` as a native dialog and wait. `Ok` only when someone pressed
/// the accept button; anything else is a sentence for the agent, and the caller
/// must do nothing.
pub(crate) async fn confirm_with_user(
    app: &AppHandle,
    request: Confirmation,
) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};

    // One dialog at a time: stacked alerts from parallel tool calls are easy to
    // answer for the wrong request.
    let _turn = ONE_AT_A_TIME
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;

    // The window may be hidden to the tray or behind other apps, and a dialog
    // nobody sees can only time out.
    if let Some(window) = crate::commands::window_chrome::get_main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }

    let decline = if crate::commands::prefers_zh_locale() {
        "拒绝"
    } else {
        "Decline"
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(request.message)
        .title(request.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            request.accept,
            decline.to_string(),
        ))
        .show(move |accepted| {
            let _ = tx.send(accepted);
        });

    let brand = crate::branding::brand_name();
    match tokio::time::timeout(CONFIRM_TIMEOUT, rx).await {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(format!(
            "The user declined this in the {brand} app, so nothing was done. Do not retry unless \
             they ask for it again."
        )),
        Ok(Err(_)) => Err(format!(
            "The {brand} app could not show its approval dialog, so nothing was done."
        )),
        Err(_) => Err(format!(
            "Nobody approved this in the {brand} app within {} seconds, so nothing was done. It \
             needs someone at this computer to approve it: tell the user, and retry only when they \
             ask.",
            CONFIRM_TIMEOUT.as_secs()
        )),
    }
}

fn declined_hint(zh: bool) -> &'static str {
    if zh {
        "如果不是你让它做的，请点「拒绝」。"
    } else {
        "If you did not ask for this, choose Decline."
    }
}

/// `/mcp-put`: replacing a workspace's MCP servers, each of which is a command
/// this machine will run.
pub(crate) fn mcp_servers_replace(zh: bool, workspace: &str, servers: &Value) -> Confirmation {
    const SHOWN: usize = 12;
    let entries: Vec<String> = servers
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(name, spec)| format!("• {name}: {}", describe_server(spec)))
                .collect()
        })
        .unwrap_or_default();
    let mut listing = entries
        .iter()
        .take(SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    if entries.len() > SHOWN {
        let more = entries.len() - SHOWN;
        listing.push_str(&if zh {
            format!("\n…另有 {more} 个")
        } else {
            format!("\n…and {more} more")
        });
    }
    if entries.is_empty() {
        listing = if zh {
            "（空：删除全部 MCP 服务）".into()
        } else {
            "(empty: removes every MCP server)".into()
        };
    }
    let hint = declined_hint(zh);
    if zh {
        Confirmation {
            title: "替换工作区的 MCP 服务？".into(),
            message: format!(
                "一个 agent 请求替换 {workspace} 的 MCP 服务。MCP 服务会以你的身份在这台电脑上运行命令。\n\n替换后：\n{listing}\n\n{hint}"
            ),
            accept: "替换".into(),
        }
    } else {
        Confirmation {
            title: "Replace this workspace's MCP servers?".into(),
            message: format!(
                "An agent wants to replace the MCP servers of {workspace}. MCP servers run commands on this computer as you.\n\nAfter the change:\n{listing}\n\n{hint}"
            ),
            accept: "Replace".into(),
        }
    }
}

/// One server as a person would recognise it: its command line, or its URL.
fn describe_server(spec: &Value) -> String {
    const MAX_CHARS: usize = 160;
    let strings = |v: Option<&Value>| {
        v.and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default()
    };
    let text = if let Some(url) = spec.get("url").and_then(Value::as_str) {
        url.to_string()
    } else {
        match spec.get("command") {
            Some(Value::Array(_)) => strings(spec.get("command")),
            Some(Value::String(command)) => format!("{command} {}", strings(spec.get("args")))
                .trim()
                .to_string(),
            _ => "?".to_string(),
        }
    };
    if text.chars().count() <= MAX_CHARS {
        text
    } else {
        text.chars().take(MAX_CHARS).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mcp_replacement_lists_the_commands_it_would_run() {
        let servers = json!({
            "local": { "type": "local", "command": ["npx", "-y", "some-mcp"] },
            "cursor": { "command": "node", "args": ["server.js"] },
            "remote": { "type": "remote", "url": "https://mcp.example.com/sse" },
        });
        let en = mcp_servers_replace(false, "/work/app", &servers);
        assert!(
            en.message.contains("• local: npx -y some-mcp"),
            "{}",
            en.message
        );
        assert!(
            en.message.contains("• cursor: node server.js"),
            "{}",
            en.message
        );
        assert!(en.message.contains("• remote: https://mcp.example.com/sse"));

        let many: serde_json::Map<String, Value> = (0..15)
            .map(|i| (format!("s{i:02}"), json!({ "command": ["run"] })))
            .collect();
        let zh = mcp_servers_replace(true, "/work/app", &Value::Object(many));
        assert!(zh.message.contains("…另有 3 个"), "{}", zh.message);

        let empty = mcp_servers_replace(true, "/work/app", &json!({}));
        assert!(empty.message.contains("删除全部 MCP 服务"));
    }
}
