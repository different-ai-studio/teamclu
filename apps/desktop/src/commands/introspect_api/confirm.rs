//! Actions the user has to approve before an agent may take them.
//!
//! Publishing an app, deleting it, changing who can reach it (visibility, login
//! wall, access grants, custom domain) and replacing a workspace's MCP servers —
//! which is running commands on this machine — each wait for a native dialog in
//! this app. Declined, or unanswered for [`CONFIRM_TIMEOUT`], and nothing
//! happens. Native on purpose: the webview renders model output, and nothing in
//! it can press a system dialog's button.
//!
//! The handlers ask after resolving the app, so the dialog can name it, and the
//! question stands for every caller that gets past the bearer gate.
//!
//! The dialog shows on this machine even when the agent was driven from
//! elsewhere — WeCom, iOS, a cron run — so with nobody here those calls time out.
//! That is the chosen trade: nothing irreversible or public happens unless
//! someone at the computer holding the credentials says yes.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::AppHandle;

/// How long a dialog waits before the call is refused.
pub(crate) const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

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
    static ONE_AT_A_TIME: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
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

fn app_name(row: &Value) -> String {
    row.get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| row.get("id").and_then(Value::as_str))
        .unwrap_or("?")
        .to_string()
}

fn declined_hint(zh: bool) -> &'static str {
    if zh {
        "如果不是你让它做的，请点「拒绝」。"
    } else {
        "If you did not ask for this, choose Decline."
    }
}

/// An approval the user has already given for a publish, waiting to be spent.
///
/// Keyed on what the dialog actually told them — which agent host asked, which
/// app, at which address, reachable by whom — because that is the whole of what
/// they agreed to. A retry after a failed deploy publishes the same app to the
/// same address; only the bundle differs, and the dialog never described the
/// bundle. Re-asking there conveys nothing and trains people to click through.
///
/// Change any field and the user would be shown a *different* dialog, so they
/// get one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeployKey {
    /// The agent host that asked. One agent's yes is not another's.
    pub(crate) host_generation_id: String,
    pub(crate) app_id: String,
    /// `None` until the first publish assigns one, exactly as the dialog says.
    pub(crate) url: Option<String>,
    /// Whether the dialog said "anyone with the link" or "sign-in required".
    pub(crate) open_to_anyone: bool,
}

impl DeployKey {
    pub(crate) fn new(host_generation_id: &str, row: &Value) -> Self {
        let brief = super::apps::app_brief(row);
        Self {
            host_generation_id: host_generation_id.to_string(),
            app_id: row
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            url: brief["url"].as_str().map(str::to_string),
            open_to_anyone: !matches!(brief["auth_mode"].as_str(), Some("platform" | "third")),
        }
    }
}

/// How long a remembered approval survives without being used.
///
/// The backstop, not the mechanism: a deploy that succeeds spends the approval
/// outright (see [`spend_deploy_approval`]), so in practice this only matters to
/// a fix-and-retry loop somebody walked away from.
pub(crate) const DEPLOY_APPROVAL_IDLE: Duration = Duration::from_secs(600);

struct Granted {
    key: DeployKey,
    last_used: Instant,
}

/// One slot, not a map. Two concurrent publish loops for different apps is
/// far-fetched, and with a single slot the second app evicts the first — which
/// fails towards asking rather than towards silence.
fn granted() -> &'static Mutex<Option<Granted>> {
    static GRANTED: OnceLock<Mutex<Option<Granted>>> = OnceLock::new();
    GRANTED.get_or_init(|| Mutex::new(None))
}

/// Whether this exact publish is already approved, refreshing its idle timer.
pub(crate) fn deploy_already_approved(key: &DeployKey) -> bool {
    approved_at(key, Instant::now())
}

/// Remember an approval the user just gave.
pub(crate) fn remember_deploy_approval(key: DeployKey) {
    remember_at(key, Instant::now());
}

/// Spend the approval: the publish went through, so the next one asks again.
pub(crate) fn spend_deploy_approval(key: &DeployKey) {
    let mut slot = granted().lock().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().is_some_and(|g| &g.key == key) {
        *slot = None;
    }
}

/// [`deploy_already_approved`] with the clock passed in, so tests need no sleep.
fn approved_at(key: &DeployKey, now: Instant) -> bool {
    let mut slot = granted().lock().unwrap_or_else(|e| e.into_inner());
    match slot.as_mut() {
        Some(g) if &g.key == key && now.duration_since(g.last_used) < DEPLOY_APPROVAL_IDLE => {
            g.last_used = now;
            true
        }
        _ => false,
    }
}

/// [`remember_deploy_approval`] with the clock passed in.
fn remember_at(key: DeployKey, now: Instant) {
    *granted().lock().unwrap_or_else(|e| e.into_inner()) = Some(Granted {
        key,
        last_used: now,
    });
}

/// `manage_app` `deploy`: publishing to the public internet.
pub(crate) fn app_deploy(zh: bool, row: &Value) -> Confirmation {
    let name = app_name(row);
    let brief = super::apps::app_brief(row);
    let url = brief["url"].as_str();
    let open = !matches!(brief["auth_mode"].as_str(), Some("platform" | "third"));
    let hint = declined_hint(zh);
    if zh {
        Confirmation {
            title: "发布应用到公网？".into(),
            message: format!(
                "一个 agent 请求把应用「{name}」发布到公网。\n\n地址：{}\n访问：{}\n\n{hint}",
                url.unwrap_or("首次发布后分配"),
                if open {
                    "拿到链接的任何人都能打开"
                } else {
                    "需要登录才能打开"
                },
            ),
            accept: "发布".into(),
        }
    } else {
        Confirmation {
            title: "Publish this app to the internet?".into(),
            message: format!(
                "An agent wants to publish “{name}” to the public internet.\n\nAddress: {}\nAccess: {}\n\n{hint}",
                url.unwrap_or("assigned on first publish"),
                if open {
                    "anyone with the link"
                } else {
                    "sign-in required"
                },
            ),
            accept: "Publish".into(),
        }
    }
}

/// `manage_app` `delete`.
pub(crate) fn app_delete(zh: bool, row: &Value) -> Confirmation {
    let name = app_name(row);
    let hint = declined_hint(zh);
    if zh {
        Confirmation {
            title: "删除应用？".into(),
            message: format!("一个 agent 请求删除应用「{name}」，删除后它会永久下线。\n\n{hint}"),
            accept: "删除".into(),
        }
    } else {
        Confirmation {
            title: "Delete this app?".into(),
            message: format!(
                "An agent wants to delete “{name}”. It goes offline for good.\n\n{hint}"
            ),
            accept: "Delete".into(),
        }
    }
}

/// `manage_app` `update` touching who can reach the app. `None` when `patch`
/// (the Cloud API body `update_patch` built) changes none of those fields, or
/// sets each to what it already is.
pub(crate) fn app_exposure_change(zh: bool, row: &Value, patch: &Value) -> Option<Confirmation> {
    const FIELDS: [&str; 5] = [
        "visibility",
        "authMode",
        "authAudience",
        "authScope",
        "authRules",
    ];
    let lines: Vec<String> = FIELDS
        .iter()
        .filter_map(|field| {
            let to = patch.get(*field)?;
            (row.get(*field) != Some(to)).then(|| exposure_line(zh, field, to))
        })
        .collect();
    if lines.is_empty() {
        return None;
    }
    let name = app_name(row);
    let lines = lines.join("\n");
    let hint = declined_hint(zh);
    Some(if zh {
        Confirmation {
            title: "修改应用的访问设置？".into(),
            message: format!("一个 agent 请求修改应用「{name}」：\n\n{lines}\n\n{hint}"),
            accept: "修改".into(),
        }
    } else {
        Confirmation {
            title: "Change who can reach this app?".into(),
            message: format!("An agent wants to change “{name}”:\n\n{lines}\n\n{hint}"),
            accept: "Change".into(),
        }
    })
}

fn exposure_line(zh: bool, field: &str, to: &Value) -> String {
    let value = to.as_str().unwrap_or_default();
    match (field, zh) {
        ("visibility", true) => format!(
            "可见范围 → {}",
            if value == "team" {
                "团队所有人"
            } else {
                "个人（自己和被授权的成员）"
            }
        ),
        ("visibility", false) => format!(
            "Visibility → {}",
            if value == "team" {
                "everyone on the team"
            } else {
                "personal (you and members granted access)"
            }
        ),
        ("authMode", true) => format!(
            "登录墙 → {}",
            if value == "none" {
                "关闭（拿到链接的任何人都能打开）"
            } else {
                "开启"
            }
        ),
        ("authMode", false) => format!(
            "Login wall → {}",
            if value == "none" {
                "off (anyone with the link can open it)"
            } else {
                "on"
            }
        ),
        ("authAudience", true) => format!(
            "允许进入 → {}",
            if value == "org" {
                "同组织的员工"
            } else {
                "任何登录用户"
            }
        ),
        ("authAudience", false) => format!(
            "Who may enter → {}",
            if value == "org" {
                "people in the organization"
            } else {
                "anyone signed in"
            }
        ),
        ("authScope", true) => format!(
            "拦截范围 → {}",
            if value == "paths" {
                "只拦列出的路径"
            } else {
                "整站"
            }
        ),
        ("authScope", false) => format!(
            "Protected → {}",
            if value == "paths" {
                "only the listed paths"
            } else {
                "the whole site"
            }
        ),
        (_, true) => format!("路径规则 → {} 条", to.as_array().map_or(0, Vec::len)),
        (_, false) => format!("Path rules → {}", to.as_array().map_or(0, Vec::len)),
    }
}

/// `manage_app_access` `grant`.
pub(crate) fn app_access_grant(zh: bool, row: &Value, member: &str, level: &str) -> Confirmation {
    let name = app_name(row);
    let hint = declined_hint(zh);
    if zh {
        let level = match level {
            "admin" => "管理（可以发布、改设置、授权）",
            "prompt" => "协作（改代码、看数据和日志）",
            _ => "查看",
        };
        Confirmation {
            title: "修改应用的协作权限？".into(),
            message: format!(
                "一个 agent 请求给「{member}」应用「{name}」的{level}权限。\n\n{hint}"
            ),
            accept: "授权".into(),
        }
    } else {
        let level = match level {
            "admin" => "admin (deploy, change settings, grant access)",
            "prompt" => "prompt (work on its code, read its data and logs)",
            _ => "view",
        };
        Confirmation {
            title: "Change who can work on this app?".into(),
            message: format!(
                "An agent wants to give {member} {level} access to “{name}”.\n\n{hint}"
            ),
            accept: "Grant".into(),
        }
    }
}

/// `manage_app_access` `revoke`.
pub(crate) fn app_access_revoke(zh: bool, row: &Value, member: &str) -> Confirmation {
    let name = app_name(row);
    let hint = declined_hint(zh);
    if zh {
        Confirmation {
            title: "修改应用的协作权限？".into(),
            message: format!("一个 agent 请求收回「{member}」对应用「{name}」的权限。\n\n{hint}"),
            accept: "收回".into(),
        }
    } else {
        Confirmation {
            title: "Change who can work on this app?".into(),
            message: format!("An agent wants to remove {member}'s access to “{name}”.\n\n{hint}"),
            accept: "Remove".into(),
        }
    }
}

/// `manage_app_domain` `set`. `None` when the app is already bound to `domain`:
/// setting it again only shows the DNS records again.
pub(crate) fn app_domain_set(zh: bool, row: &Value, domain: &str) -> Option<Confirmation> {
    let bound = row.get("customDomain").and_then(Value::as_str);
    if bound.is_some_and(|b| b.eq_ignore_ascii_case(domain.trim())) {
        return None;
    }
    let name = app_name(row);
    let hint = declined_hint(zh);
    Some(if zh {
        Confirmation {
            title: "修改应用的自定义域名？".into(),
            message: format!(
                "一个 agent 请求把应用「{name}」绑定到 {domain}。DNS 验证通过后，这个域名就会对外提供这个应用。\n\n{hint}"
            ),
            accept: "绑定".into(),
        }
    } else {
        Confirmation {
            title: "Change this app's custom domain?".into(),
            message: format!(
                "An agent wants to serve “{name}” on {domain}. Once DNS verifies, that domain serves the app publicly.\n\n{hint}"
            ),
            accept: "Bind".into(),
        }
    })
}

/// `manage_app_domain` `remove`. `None` when no domain is bound.
pub(crate) fn app_domain_remove(zh: bool, row: &Value) -> Option<Confirmation> {
    let domain = row.get("customDomain").and_then(Value::as_str)?;
    let name = app_name(row);
    let hint = declined_hint(zh);
    Some(if zh {
        Confirmation {
            title: "修改应用的自定义域名？".into(),
            message: format!(
                "一个 agent 请求解绑应用「{name}」的自定义域名 {domain}。应用仍可通过自己的地址访问。\n\n{hint}"
            ),
            accept: "解绑".into(),
        }
    } else {
        Confirmation {
            title: "Change this app's custom domain?".into(),
            message: format!(
                "An agent wants to unbind {domain} from “{name}”. The app stays reachable on its own address.\n\n{hint}"
            ),
            accept: "Unbind".into(),
        }
    })
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

    fn row(id: &str, url: Option<&str>, auth: &str) -> Value {
        let mut row = json!({ "id": id, "name": id, "authMode": auth });
        if let Some(url) = url {
            row["publicUrl"] = json!(url);
        }
        row
    }

    #[test]
    fn deploy_key_matches_only_a_publish_the_dialog_would_word_the_same() {
        let live = row("a1", Some("https://a1.example.com"), "none");
        let base = DeployKey::new("host-1", &live);

        // The same publish, retried.
        assert_eq!(base, DeployKey::new("host-1", &live));

        // Another agent host does not inherit this yes.
        assert_ne!(base, DeployKey::new("host-2", &live));
        // A different app.
        assert_ne!(
            base,
            DeployKey::new("host-1", &row("a2", Some("https://a1.example.com"), "none"))
        );
        // A different address — including the first one ever assigned, which is
        // the first time the dialog can name it.
        assert_ne!(
            base,
            DeployKey::new(
                "host-1",
                &row("a1", Some("https://moved.example.com"), "none")
            )
        );
        assert_ne!(base, DeployKey::new("host-1", &row("a1", None, "none")));
        // Open to anyone versus behind a sign-in.
        assert_ne!(
            base,
            DeployKey::new(
                "host-1",
                &row("a1", Some("https://a1.example.com"), "platform")
            )
        );
    }

    /// One test owns the approval slot: it is process-global, so splitting this
    /// across tests would have them race each other under the parallel runner.
    #[test]
    fn a_remembered_approval_covers_retries_until_it_is_spent() {
        let live = row("a1", Some("https://a1.example.com"), "none");
        let key = DeployKey::new("host-1", &live);
        let start = Instant::now();

        // Nothing is approved until the user says so.
        assert!(!approved_at(&key, start));

        remember_at(key.clone(), start);
        // The fix-and-retry loop: attempt after attempt, no new dialog.
        assert!(approved_at(&key, start));
        assert!(approved_at(&key, start + Duration::from_secs(60)));

        // Not for anything the user was not shown.
        let other = DeployKey::new("host-2", &live);
        assert!(!approved_at(&other, start));

        // The publish goes through, and the approval is spent with it.
        spend_deploy_approval(&key);
        assert!(!approved_at(&key, start));

        // Idle expiry is the backstop for a loop nobody came back to. It counts
        // from the last use, not from the approval.
        remember_at(key.clone(), start);
        assert!(approved_at(
            &key,
            start + DEPLOY_APPROVAL_IDLE - Duration::from_secs(1)
        ));
        assert!(approved_at(
            &key,
            start + DEPLOY_APPROVAL_IDLE + Duration::from_secs(60)
        ));
        assert!(!approved_at(
            &key,
            start + DEPLOY_APPROVAL_IDLE * 2 + Duration::from_secs(120)
        ));

        // A second app's publish evicts the first: one slot, and eviction fails
        // towards asking.
        remember_at(key.clone(), start);
        let second = DeployKey::new("host-1", &row("a2", None, "none"));
        remember_at(second.clone(), start);
        assert!(approved_at(&second, start));
        assert!(!approved_at(&key, start));

        spend_deploy_approval(&second);
    }

    #[test]
    fn deploy_says_where_it_goes_and_who_can_open_it() {
        let open = json!({ "id": "a1", "name": "Notes", "publicUrl": "https://notes.example.com", "authMode": "none" });
        let zh = app_deploy(true, &open);
        assert!(zh.message.contains("「Notes」"), "{}", zh.message);
        assert!(zh.message.contains("https://notes.example.com"));
        assert!(zh.message.contains("任何人"));
        assert_eq!(zh.accept, "发布");

        let walled = json!({ "id": "a1", "name": "Notes", "authMode": "platform" });
        let en = app_deploy(false, &walled);
        assert!(en.message.contains("sign-in required"), "{}", en.message);
        assert!(en.message.contains("assigned on first publish"));
    }

    #[test]
    fn only_a_real_change_to_who_can_reach_the_app_asks() {
        let row = json!({ "name": "Notes", "visibility": "personal", "authMode": "platform" });
        // Renames and no-op sets do not bother anyone.
        assert_eq!(
            app_exposure_change(true, &row, &json!({ "name": "N2" })),
            None
        );
        assert_eq!(
            app_exposure_change(true, &row, &json!({ "visibility": "personal" })),
            None
        );

        let asked = app_exposure_change(
            false,
            &row,
            &json!({ "visibility": "team", "authMode": "none", "name": "N2" }),
        )
        .expect("visibility and login wall both change");
        assert!(
            asked.message.contains("Visibility → everyone on the team"),
            "{}",
            asked.message
        );
        assert!(
            asked.message.contains("Login wall → off"),
            "{}",
            asked.message
        );
    }

    #[test]
    fn rebinding_the_same_domain_does_not_ask() {
        let row = json!({ "name": "Notes", "customDomain": "notes.example.com" });
        assert_eq!(app_domain_set(true, &row, "Notes.Example.com"), None);
        assert!(app_domain_set(true, &row, "other.example.com").is_some());
        assert!(app_domain_remove(false, &row)
            .expect("a bound domain")
            .message
            .contains("notes.example.com"));
        assert_eq!(app_domain_remove(false, &json!({ "name": "Notes" })), None);
    }

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
