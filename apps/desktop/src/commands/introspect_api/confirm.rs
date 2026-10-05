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

use std::sync::OnceLock;
use std::time::Duration;

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

pub(crate) fn app_deploy_with_preview(zh: bool, row: &Value, preview: &Value) -> Confirmation {
    let mut request = app_deploy(zh, row);
    let changes = preview["changes"].as_array();
    if let Some(changes) = changes {
        if !changes.is_empty() {
            request.message.push_str(if zh {
                "\n\n本次配置变更："
            } else {
                "\n\nConfiguration changes:"
            });
            for change in changes {
                let field = change["field"].as_str().unwrap_or("?");
                request
                    .message
                    .push_str(&format!("\n{field}: {} → {}", change["from"], change["to"]));
            }
        }
    }
    request
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
    let mut effective = row.clone();
    for field in FIELDS {
        if let Some(value) = patch.get(field) {
            effective[field] = value.clone();
        }
    }
    let summary = access_policy_summary(zh, &effective);
    let lines = format!("{}\n\n{summary}", lines.join("\n"));
    let hint = declined_hint(zh);
    Some(if zh {
        Confirmation {
            title: "修改应用访问权限？".into(),
            message: format!("一个 agent 请求修改应用「{name}」：\n\n{lines}\n\n{hint}"),
            accept: "应用权限设置".into(),
        }
    } else {
        Confirmation {
            title: "Change who can reach this app?".into(),
            message: format!("An agent wants to change “{name}”:\n\n{lines}\n\n{hint}"),
            accept: "Apply access settings".into(),
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

/// Describe the resulting policy, including defaults omitted from the patch.
/// Keep precedence aligned with the gateway: roles, rule audience, app audience.
fn access_rule_audience(zh: bool, rule: Option<&Value>, app: &Value) -> String {
    if let Some(roles) = rule.and_then(|r| r.get("roles")).and_then(Value::as_array) {
        if roles.is_empty() {
            return if zh {
                "需要平台登录，允许任何已登录用户"
            } else {
                "platform sign-in required; any signed-in user"
            }
            .into();
        }
        let codes = roles
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", ");
        return if zh {
            format!("需要平台登录，指定组织角色：{codes}")
        } else {
            format!("platform sign-in required; organization roles: {codes}")
        };
    }
    let audience = rule
        .and_then(|r| r.get("audience"))
        .and_then(Value::as_str)
        .or_else(|| app.get("authAudience").and_then(Value::as_str))
        .unwrap_or("org");
    match (audience, zh) {
        ("any", true) => "需要平台登录，允许任何已登录用户",
        ("any", false) => "platform sign-in required; any signed-in user",
        (_, true) => "需要平台登录，仅允许当前组织成员（需有有效组织角色）",
        (_, false) => {
            "platform sign-in required; organization members (active organization role required)"
        }
    }
    .into()
}

fn access_policy_summary(zh: bool, app: &Value) -> String {
    if app.get("authMode").and_then(Value::as_str) != Some("platform") {
        return if zh {
            "变更后：平台登录保护未启用；所有路径公开"
        } else {
            "After this change: platform login protection is disabled; all paths are public"
        }
        .into();
    }
    let public = if zh { "公开" } else { "public" };
    let separator = if zh { "：" } else { ": " };
    let mut lines = vec![if zh {
        "变更后的访问规则："
    } else {
        "Access rules after this change:"
    }
    .to_string()];
    let rules = match app.get("authRules") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(rules)) => rules.as_slice(),
        _ => {
            return if zh {
                "变更后的路径规则无法解析，请核对配置"
            } else {
                "Resulting path rules cannot be read; verify the configuration"
            }
            .into()
        }
    };
    let mut root = None;
    for rule in rules {
        let path = rule.get("path").and_then(Value::as_str).unwrap_or("?");
        if path.trim().trim_end_matches('/').is_empty() {
            root = Some(rule);
        }
        let policy = if rule.get("auth").and_then(Value::as_str) == Some("public") {
            public.to_string()
        } else {
            access_rule_audience(zh, Some(rule), app)
        };
        lines.push(format!("{path}{separator}{policy}"));
    }
    let fallback = if let Some(rule) = root {
        if rule.get("auth").and_then(Value::as_str) == Some("public") {
            public.to_string()
        } else {
            access_rule_audience(zh, Some(rule), app)
        }
    } else if app.get("authScope").and_then(Value::as_str) == Some("paths") {
        public.to_string()
    } else {
        access_rule_audience(zh, None, app)
    };
    lines.push(format!(
        "{}{separator}{fallback}",
        if zh {
            "未匹配路径"
        } else {
            "Unmatched paths"
        }
    ));
    lines.push(if zh { "路径按前缀匹配，以最长匹配规则为准。组织角色由平台动态检查。" } else { "Paths match by prefix; the longest matching rule wins. Organization roles are checked dynamically by the platform." }.into());
    lines.join("\n")
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
    fn deployment_confirmation_names_preflight_changes() {
        let row = json!({ "id": "a1", "name": "Notes", "authMode": "platform" });
        let preview = json!({ "changes": [{ "field": "layers", "from": ["Nodejs20:3"], "to": ["Nodejs22:1"] }] });
        let confirmation = app_deploy_with_preview(false, &row, &preview);
        assert!(confirmation.message.contains("layers"));
        assert!(confirmation.message.contains("Nodejs20:3"));
        assert!(confirmation.message.contains("Nodejs22:1"));
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
    fn access_approval_describes_paths_and_inherited_org_audience() {
        let row = json!({"name":"Test", "authMode":"none", "authAudience":"org", "authScope":"all", "authRules":[]});
        let patch = json!({"authMode":"platform", "authScope":"paths", "authRules":[
            {"path":"/staff", "auth":"required"},
            {"path":"/api/staff", "auth":"required", "audience":"org"}
        ]});
        let asked = app_exposure_change(true, &row, &patch).unwrap();
        assert!(
            asked
                .message
                .contains("/staff：需要平台登录，仅允许当前组织成员"),
            "{}",
            asked.message
        );
        assert!(asked
            .message
            .contains("/api/staff：需要平台登录，仅允许当前组织成员"));
        assert!(asked.message.contains("未匹配路径：公开"));
        assert!(asked.message.contains("路径按前缀匹配，以最长匹配规则为准"));
        assert_eq!(asked.accept, "应用权限设置");
    }

    #[test]
    fn access_approval_explains_role_precedence_public_exceptions_and_root() {
        let row = json!({"name":"Test", "authMode":"platform", "authAudience":"org", "authScope":"all", "authRules":[]});
        let patch = json!({"authRules":[
            {"path":"/", "auth":"required", "roles":[]},
            {"path":"/staff", "auth":"required", "roles":["admin","finance"], "audience":"any"},
            {"path":"/public", "auth":"public"}
        ]});
        let asked = app_exposure_change(false, &row, &patch).unwrap();
        assert!(
            asked
                .message
                .contains("/staff: platform sign-in required; organization roles: admin, finance"),
            "{}",
            asked.message
        );
        assert!(asked
            .message
            .contains("/: platform sign-in required; any signed-in user"));
        assert!(asked.message.contains("/public: public"));
        assert!(asked
            .message
            .contains("Unmatched paths: platform sign-in required; any signed-in user"));
        assert_eq!(asked.accept, "Apply access settings");
    }

    #[test]
    fn disabled_login_wall_does_not_describe_stored_rules_as_protection() {
        let row = json!({"name":"Test", "authMode":"platform", "authScope":"paths", "authRules":[{"path":"/staff","auth":"required","roles":["admin"]}]});
        let asked = app_exposure_change(true, &row, &json!({"authMode":"none"})).unwrap();
        assert!(
            asked.message.contains("平台登录保护未启用；所有路径公开"),
            "{}",
            asked.message
        );
        assert!(!asked.message.contains("/staff：需要"));
    }

    #[test]
    fn access_approval_preserves_defaults_on_partial_updates_and_rule_removal() {
        let row = json!({"name":"Test", "authMode":"platform", "authAudience":"org", "authScope":"all", "authRules":[{"path":"/public","auth":"public"}]});
        let asked = app_exposure_change(false, &row, &json!({"authAudience":"any"})).unwrap();
        assert!(asked.message.contains("/public: public"));
        assert!(asked
            .message
            .contains("Unmatched paths: platform sign-in required; any signed-in user"));
        let removed = app_exposure_change(false, &row, &json!({"authRules":[]})).unwrap();
        assert!(!removed.message.contains("/public: public"));
        assert!(removed
            .message
            .contains("Unmatched paths: platform sign-in required; organization members"));
        assert_eq!(
            app_exposure_change(false, &row, &json!({"authAudience":"org"})),
            None
        );
    }

    #[test]
    fn access_approval_does_not_treat_unreadable_rules_as_public() {
        let row = json!({"name":"Test", "authMode":"platform", "authScope":"paths", "authRules":"invalid"});
        let asked = app_exposure_change(false, &row, &json!({"authAudience":"any"})).unwrap();
        assert!(asked.message.contains("path rules cannot be read"));
        assert!(!asked.message.contains("Unmatched paths: public"));
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
