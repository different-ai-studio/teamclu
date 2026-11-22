//! Agent `manage_channels` against the team gateway config.
//!
//! Settings and amuxd share one document: `[channels.*]` in the active team's
//! `team.toml`, with secrets in `secrets.enc`. The tool used to shallow-merge a
//! camelCase patch into the workspace `teamclu.json`, which nothing that runs a
//! channel reads. This module is the patch those calls apply instead.
//!
//! The patch uses the same names as the settings page (`botId`, `token`, …).
//! The document it returns uses the daemon struct names (`bot_id`, `bot_token`,
//! …) and is a full channel section, because `channel-save` replaces the
//! section and fills anything missing from serde defaults. Fields the patch
//! does not mention stay as they were, including an omitted `enabled`.

use serde_json::{Map, Value};
use std::collections::HashSet;

/// Channels the agent tool can see. WeChat Pad stays a settings-only channel.
pub(crate) const PLATFORMS: &[&str] = &[
    "wecom", "discord", "feishu", "email", "kook", "wechat", "seatalk",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Change {
    Enabled {
        from: bool,
        to: bool,
    },
    /// A credential will be replaced. `what` names the field, never the value.
    Secret {
        what: String,
    },
    Text {
        what: String,
        value: String,
    },
    Cleared {
        what: String,
    },
    AddedBot {
        what: String,
        id: String,
    },
}

impl Change {
    pub(crate) fn format(&self, zh: bool) -> String {
        match self {
            Change::Enabled { from, to } => {
                if zh {
                    format!("启用：{} → {}", zh_on(*from), zh_on(*to))
                } else {
                    format!("enabled: {} → {}", en_on(*from), en_on(*to))
                }
            }
            Change::Secret { what } => {
                if zh {
                    format!("{what}：更新密钥（对话框不显示内容）")
                } else {
                    format!("{what}: secret will be updated")
                }
            }
            Change::Text { what, value } => format!("{what}: {value}"),
            Change::Cleared { what } => {
                if zh {
                    format!("{what}：清空")
                } else {
                    format!("{what}: cleared")
                }
            }
            Change::AddedBot { what, id } => {
                if zh {
                    format!("新增{what} {id}")
                } else {
                    format!("add {what} {id}")
                }
            }
        }
    }
}

#[derive(Debug)]
pub(crate) struct ChannelPlan {
    pub document: Value,
    pub changes: Vec<Change>,
}

/// `current` is one channel section as `load_channel_config` reads it (daemon
/// field names, secrets usually absent). `None` means the section does not
/// exist yet.
pub(crate) fn plan_update(
    platform: &str,
    current: Option<&Value>,
    patch: &Value,
) -> Result<ChannelPlan, String> {
    if !PLATFORMS.contains(&platform) {
        return Err(format!(
            "unknown channel '{platform}'. Valid: {}",
            PLATFORMS.join(", ")
        ));
    }
    let patch = patch
        .as_object()
        .ok_or_else(|| "config must be a JSON object".to_string())?;
    let existed = current.is_some();
    let mut doc = match current {
        None => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return Err("stored channel config is not an object".to_string()),
    };
    let mut changes = Vec::new();
    match platform {
        "wecom" => apply_wecom(&mut doc, patch, existed, &mut changes)?,
        "seatalk" => apply_seatalk(&mut doc, patch, existed, &mut changes)?,
        "discord" => apply_discord(&mut doc, patch, existed, &mut changes)?,
        "feishu" => apply_feishu(&mut doc, patch, existed, &mut changes)?,
        "kook" => apply_kook(&mut doc, patch, existed, &mut changes)?,
        "wechat" => apply_wechat(&mut doc, patch, existed, &mut changes)?,
        "email" => apply_email(&mut doc, patch, existed, &mut changes)?,
        _ => unreachable!("platform checked above"),
    }
    Ok(ChannelPlan {
        document: Value::Object(doc),
        changes,
    })
}

/// Settings-shaped view of one stored section. Secret leaves are never copied
/// out: a non-empty value in the file, or a key the secret store says is set,
/// becomes `"[configured]"`; an unset secret is omitted.
pub(crate) fn agent_view(
    platform: &str,
    current: Option<&Value>,
    secret_keys: &HashSet<String>,
    secrets_known: bool,
) -> Value {
    let Some(doc) = current.and_then(Value::as_object) else {
        return Value::Object(Map::new());
    };
    match platform {
        "wecom" => view_wecom(doc, secret_keys, secrets_known),
        "seatalk" => view_seatalk(doc, secret_keys, secrets_known),
        "discord" => view_simple(
            doc,
            &[
                ("token", "bot_token", "channels.discord.bot_token"),
                ("defaultUsername", "default_username", ""),
                ("workspaceId", "workspace_id", ""),
                ("model", "model", ""),
            ],
            secret_keys,
            secrets_known,
        ),
        "feishu" => view_simple(
            doc,
            &[
                ("appId", "app_id", ""),
                ("appSecret", "app_secret", "channels.feishu.app_secret"),
                ("workspaceId", "workspace_id", ""),
                ("model", "model", ""),
            ],
            secret_keys,
            secrets_known,
        ),
        "kook" => view_simple(
            doc,
            &[
                ("token", "bot_token", "channels.kook.bot_token"),
                ("workspaceId", "workspace_id", ""),
                ("model", "model", ""),
            ],
            secret_keys,
            secrets_known,
        ),
        "wechat" => view_simple(
            doc,
            &[
                ("accountId", "ilink_account", ""),
                ("botToken", "ilink_token", "channels.wechat.ilink_token"),
                ("workspaceId", "workspace_id", ""),
                ("model", "model", ""),
            ],
            secret_keys,
            secrets_known,
        ),
        "email" => view_email(doc, secret_keys, secrets_known),
        _ => Value::Object(Map::new()),
    }
}

/// Whether amuxd will run this section. A missing `enabled` flag reads as on,
/// matching `configured_channels_in`.
pub(crate) fn is_enabled(current: Option<&Value>) -> bool {
    let Some(doc) = current.and_then(Value::as_object) else {
        return false;
    };
    match doc.get("enabled") {
        Some(Value::Bool(on)) => *on,
        Some(_) => false,
        None => true,
    }
}

fn apply_wecom(
    doc: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    existed: bool,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "enabled",
        "botId",
        "secret",
        "encodingAesKey",
        "botName",
        "apiKey",
        "systemPrompt",
        "workspaceId",
        "model",
    ];
    reject_unknown(patch, ALLOWED)?;
    let enabled = set_enabled(doc, patch, existed, changes)?;
    let target = wecom_target(doc, patch, changes)?;
    match target {
        BotTarget::None => {}
        BotTarget::Legacy => {
            assign_secret(doc, "secret", patch.get("secret"), "WeCom secret", changes)?;
            assign_secret(
                doc,
                "encoding_aes_key",
                patch.get("encodingAesKey"),
                "WeCom encodingAesKey",
                changes,
            )?;
        }
        BotTarget::Index(index) => {
            let bot = bot_mut(doc, index)?;
            assign_secret(bot, "secret", patch.get("secret"), "WeCom secret", changes)?;
            assign_secret(
                bot,
                "encoding_aes_key",
                patch.get("encodingAesKey"),
                "WeCom encodingAesKey",
                changes,
            )?;
            assign_secret(bot, "api_key", patch.get("apiKey"), "WeCom apiKey", changes)?;
            assign_text(
                bot,
                "bot_name",
                patch.get("botName"),
                "WeCom bot name",
                changes,
            )?;
            assign_text(
                bot,
                "system_prompt",
                patch.get("systemPrompt"),
                "WeCom system prompt",
                changes,
            )?;
            assign_text(
                bot,
                "workspace_id",
                patch.get("workspaceId"),
                "WeCom workspace",
                changes,
            )?;
            assign_text(bot, "model", patch.get("model"), "WeCom model", changes)?;
        }
    }
    if enabled && !wecom_has_bot(doc) {
        return Err("WeCom cannot be turned on without a botId".to_string());
    }
    Ok(())
}

fn apply_seatalk(
    doc: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    existed: bool,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "enabled",
        "appId",
        "appSecret",
        "systemPrompt",
        "workspaceId",
        "model",
        "mode",
        "dmPolicy",
        "allowFrom",
        "groupPolicy",
        "groupAllowFrom",
    ];
    reject_unknown(patch, ALLOWED)?;
    let enabled = set_enabled(doc, patch, existed, changes)?;
    if let Some(mode) = patch.get("mode") {
        let mode = expect_string(mode, "mode")?;
        if mode != "websocket" && mode != "webhook" {
            return Err("SeaTalk mode must be 'websocket' or 'webhook'".to_string());
        }
        assign_exact(doc, "mode", &mode, "SeaTalk mode", changes);
    }
    if let Some(policy) = patch.get("dmPolicy") {
        let policy = expect_choice(policy, "dmPolicy", &["open", "allowlist"])?;
        assign_exact(doc, "dm_policy", &policy, "SeaTalk dmPolicy", changes);
    }
    if let Some(policy) = patch.get("groupPolicy") {
        let policy = expect_choice(policy, "groupPolicy", &["open", "allowlist", "disabled"])?;
        assign_exact(doc, "group_policy", &policy, "SeaTalk groupPolicy", changes);
    }
    if let Some(list) = patch.get("allowFrom") {
        assign_list(doc, "allow_from", list, "SeaTalk allowFrom", changes)?;
    }
    if let Some(list) = patch.get("groupAllowFrom") {
        assign_list(
            doc,
            "group_allow_from",
            list,
            "SeaTalk groupAllowFrom",
            changes,
        )?;
    }
    let target = seatalk_target(doc, patch, changes)?;
    match target {
        BotTarget::None => {}
        BotTarget::Legacy => {
            assign_secret(
                doc,
                "app_secret",
                patch.get("appSecret"),
                "SeaTalk appSecret",
                changes,
            )?;
            assign_text(
                doc,
                "system_prompt",
                patch.get("systemPrompt"),
                "SeaTalk system prompt",
                changes,
            )?;
        }
        BotTarget::Index(index) => {
            let bot = bot_mut(doc, index)?;
            assign_secret(
                bot,
                "app_secret",
                patch.get("appSecret"),
                "SeaTalk appSecret",
                changes,
            )?;
            assign_text(
                bot,
                "system_prompt",
                patch.get("systemPrompt"),
                "SeaTalk system prompt",
                changes,
            )?;
            assign_text(
                bot,
                "workspace_id",
                patch.get("workspaceId"),
                "SeaTalk workspace",
                changes,
            )?;
            assign_text(bot, "model", patch.get("model"), "SeaTalk model", changes)?;
        }
    }
    if enabled && !seatalk_has_app(doc) {
        return Err("SeaTalk cannot be turned on without an appId".to_string());
    }
    Ok(())
}

fn apply_discord(
    doc: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    existed: bool,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    reject_unknown(
        patch,
        &[
            "enabled",
            "token",
            "defaultUsername",
            "workspaceId",
            "model",
        ],
    )?;
    reject_legacy(patch, &[("dm", "Discord"), ("guilds", "Discord")])?;
    set_enabled(doc, patch, existed, changes)?;
    assign_secret(
        doc,
        "bot_token",
        patch.get("token"),
        "Discord token",
        changes,
    )?;
    assign_text(
        doc,
        "default_username",
        patch.get("defaultUsername"),
        "Discord default username",
        changes,
    )?;
    assign_runtime(doc, patch, "Discord", changes)?;
    Ok(())
}

fn apply_feishu(
    doc: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    existed: bool,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    reject_unknown(
        patch,
        &["enabled", "appId", "appSecret", "workspaceId", "model"],
    )?;
    reject_legacy(patch, &[("chats", "Feishu")])?;
    let enabled = set_enabled(doc, patch, existed, changes)?;
    if let Some(id) = patch.get("appId") {
        let id = expect_string(id, "appId")?;
        assign_exact(doc, "app_id", &id, "Feishu appId", changes);
    } else if !doc.contains_key("app_id") {
        doc.insert("app_id".into(), Value::String(String::new()));
    }
    assign_secret(
        doc,
        "app_secret",
        patch.get("appSecret"),
        "Feishu appSecret",
        changes,
    )?;
    assign_runtime(doc, patch, "Feishu", changes)?;
    if enabled && text_of(doc, "app_id").is_empty() {
        return Err("Feishu cannot be turned on without an appId".to_string());
    }
    Ok(())
}

fn apply_kook(
    doc: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    existed: bool,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    reject_unknown(patch, &["enabled", "token", "workspaceId", "model"])?;
    reject_legacy(patch, &[("dm", "KOOK"), ("guilds", "KOOK")])?;
    set_enabled(doc, patch, existed, changes)?;
    assign_secret(doc, "bot_token", patch.get("token"), "KOOK token", changes)?;
    assign_runtime(doc, patch, "KOOK", changes)?;
    Ok(())
}

fn apply_wechat(
    doc: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    existed: bool,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    reject_unknown(
        patch,
        &["enabled", "accountId", "botToken", "workspaceId", "model"],
    )?;
    reject_legacy(patch, &[("baseUrl", "WeChat"), ("contextTokens", "WeChat")])?;
    set_enabled(doc, patch, existed, changes)?;
    if let Some(id) = patch.get("accountId") {
        let id = expect_string(id, "accountId")?;
        assign_exact(doc, "ilink_account", &id, "WeChat accountId", changes);
    } else if !doc.contains_key("ilink_account") {
        doc.insert("ilink_account".into(), Value::String(String::new()));
    }
    assign_secret(
        doc,
        "ilink_token",
        patch.get("botToken"),
        "WeChat botToken",
        changes,
    )?;
    assign_runtime(doc, patch, "WeChat", changes)?;
    Ok(())
}

fn apply_email(
    doc: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    existed: bool,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "enabled",
        "imapServer",
        "imapPort",
        "smtpServer",
        "smtpPort",
        "username",
        "password",
        "allowedSenders",
        "workspaceId",
        "model",
    ];
    reject_unknown(patch, ALLOWED)?;
    for key in [
        "provider",
        "gmailEmail",
        "gmailClientId",
        "gmailClientSecret",
    ] {
        if patch.contains_key(key) {
            return Err(
                "Email in the gateway is IMAP/SMTP. Use imapServer, smtpServer, username and password."
                    .to_string(),
            );
        }
    }
    let enabled = set_enabled(doc, patch, existed, changes)?;
    if let Some(host) = patch.get("imapServer") {
        assign_exact(
            doc,
            "imap_host",
            &expect_string(host, "imapServer")?,
            "IMAP host",
            changes,
        );
    }
    if let Some(host) = patch.get("smtpServer") {
        assign_exact(
            doc,
            "smtp_host",
            &expect_string(host, "smtpServer")?,
            "SMTP host",
            changes,
        );
    }
    if let Some(port) = patch.get("imapPort") {
        assign_port(doc, "imap_port", port, "IMAP port", changes)?;
    } else if !doc.contains_key("imap_port") {
        doc.insert("imap_port".into(), json_u16(993));
    }
    if let Some(port) = patch.get("smtpPort") {
        assign_port(doc, "smtp_port", port, "SMTP port", changes)?;
    } else if !doc.contains_key("smtp_port") {
        doc.insert("smtp_port".into(), json_u16(587));
    }
    if let Some(user) = patch.get("username") {
        let user = expect_string(user, "username")?;
        let imap_changed = text_of(doc, "imap_user") != user;
        let smtp_changed = text_of(doc, "smtp_user") != user;
        if imap_changed || smtp_changed {
            doc.insert("imap_user".into(), Value::String(user.clone()));
            doc.insert("smtp_user".into(), Value::String(user.clone()));
            changes.push(Change::Text {
                what: "email username".into(),
                value: truncate(&user, 80),
            });
        }
    } else {
        if !doc.contains_key("imap_user") {
            doc.insert("imap_user".into(), Value::String(String::new()));
        }
        if !doc.contains_key("smtp_user") {
            doc.insert("smtp_user".into(), Value::String(String::new()));
        }
    }
    if !doc.contains_key("imap_host") {
        doc.insert("imap_host".into(), Value::String(String::new()));
    }
    if !doc.contains_key("smtp_host") {
        doc.insert("smtp_host".into(), Value::String(String::new()));
    }
    assign_password(doc, patch.get("password"), changes)?;
    if let Some(list) = patch.get("allowedSenders") {
        assign_list(
            doc,
            "allowed_senders",
            list,
            "email allowed senders",
            changes,
        )?;
    }
    assign_runtime(doc, patch, "email", changes)?;
    if enabled
        && (text_of(doc, "imap_host").is_empty()
            || text_of(doc, "smtp_host").is_empty()
            || text_of(doc, "imap_user").is_empty())
    {
        return Err(
            "Email cannot be turned on without imapServer, smtpServer and username".to_string(),
        );
    }
    Ok(())
}

enum BotTarget {
    None,
    Legacy,
    Index(usize),
}

fn wecom_target(
    doc: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    changes: &mut Vec<Change>,
) -> Result<BotTarget, String> {
    const BOT_KEYS: &[&str] = &[
        "botId",
        "secret",
        "encodingAesKey",
        "botName",
        "apiKey",
        "systemPrompt",
        "workspaceId",
        "model",
    ];
    if !BOT_KEYS.iter().any(|key| patch.contains_key(*key)) {
        return Ok(BotTarget::None);
    }
    const EXTENDED: &[&str] = &["botName", "apiKey", "systemPrompt", "workspaceId", "model"];
    let requested = match patch.get("botId") {
        Some(value) => Some(require_id(value, "botId")?),
        None => None,
    };
    match bot_layout(doc, "bot_id") {
        Layout::Empty => {
            let id = requested
                .ok_or_else(|| "WeCom has no bot yet. Pass botId to add one.".to_string())?;
            push_bot(doc, "bot_id", &id);
            changes.push(Change::AddedBot {
                what: "WeCom bot".into(),
                id,
            });
            Ok(BotTarget::Index(0))
        }
        Layout::Legacy { id } => {
            if let Some(requested) = requested.as_ref() {
                if requested != &id {
                    upgrade_wecom(doc);
                    let index = push_bot(doc, "bot_id", requested);
                    changes.push(Change::AddedBot {
                        what: "WeCom bot".into(),
                        id: requested.clone(),
                    });
                    return Ok(BotTarget::Index(index));
                }
            }
            if EXTENDED.iter().any(|key| patch.contains_key(*key)) {
                upgrade_wecom(doc);
                return Ok(BotTarget::Index(0));
            }
            Ok(BotTarget::Legacy)
        }
        Layout::Bots => {
            ensure_unique_bots(doc, "bot_id", "WeCom")?;
            if let Some(requested) = requested {
                if let Some(index) = find_bot(doc, "bot_id", &requested) {
                    return Ok(BotTarget::Index(index));
                }
                let index = push_bot(doc, "bot_id", &requested);
                changes.push(Change::AddedBot {
                    what: "WeCom bot".into(),
                    id: requested,
                });
                return Ok(BotTarget::Index(index));
            }
            let n = bots(doc).map(Vec::len).unwrap_or(0);
            if n == 1 {
                return Ok(BotTarget::Index(0));
            }
            Err(format!(
                "WeCom has {n} bots ({}). Pass botId to choose one.",
                bot_ids(doc, "bot_id").join(", ")
            ))
        }
    }
}

fn seatalk_target(
    doc: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    changes: &mut Vec<Change>,
) -> Result<BotTarget, String> {
    const BOT_KEYS: &[&str] = &["appId", "appSecret", "systemPrompt", "workspaceId", "model"];
    if !BOT_KEYS.iter().any(|key| patch.contains_key(*key)) {
        return Ok(BotTarget::None);
    }
    let requested = match patch.get("appId") {
        Some(value) => Some(require_id(value, "appId")?),
        None => None,
    };
    match bot_layout(doc, "app_id") {
        Layout::Empty => {
            let id = requested
                .ok_or_else(|| "SeaTalk has no app yet. Pass appId to add one.".to_string())?;
            push_bot(doc, "app_id", &id);
            changes.push(Change::AddedBot {
                what: "SeaTalk app".into(),
                id,
            });
            Ok(BotTarget::Index(0))
        }
        Layout::Legacy { id } => {
            if let Some(requested) = requested.as_ref() {
                if requested != &id {
                    upgrade_seatalk(doc);
                    let index = push_bot(doc, "app_id", requested);
                    changes.push(Change::AddedBot {
                        what: "SeaTalk app".into(),
                        id: requested.clone(),
                    });
                    return Ok(BotTarget::Index(index));
                }
            }
            if patch.contains_key("workspaceId") || patch.contains_key("model") {
                upgrade_seatalk(doc);
                return Ok(BotTarget::Index(0));
            }
            Ok(BotTarget::Legacy)
        }
        Layout::Bots => {
            ensure_unique_bots(doc, "app_id", "SeaTalk")?;
            if let Some(requested) = requested {
                if let Some(index) = find_bot(doc, "app_id", &requested) {
                    return Ok(BotTarget::Index(index));
                }
                let index = push_bot(doc, "app_id", &requested);
                changes.push(Change::AddedBot {
                    what: "SeaTalk app".into(),
                    id: requested,
                });
                return Ok(BotTarget::Index(index));
            }
            let n = bots(doc).map(Vec::len).unwrap_or(0);
            if n == 1 {
                return Ok(BotTarget::Index(0));
            }
            Err(format!(
                "SeaTalk has {n} apps ({}). Pass appId to choose one.",
                bot_ids(doc, "app_id").join(", ")
            ))
        }
    }
}

enum Layout {
    Empty,
    Legacy { id: String },
    Bots,
}

fn bot_layout(doc: &Map<String, Value>, id_key: &str) -> Layout {
    if bots(doc).is_some_and(|list| !list.is_empty()) {
        return Layout::Bots;
    }
    let id = text_of(doc, id_key);
    if id.is_empty() {
        Layout::Empty
    } else {
        Layout::Legacy { id }
    }
}

/// Move a legacy single WeCom bot into `bots[0]`, keeping a plaintext secret
/// on that bot. A secret that lives only in the secret store is moved by
/// `team_config`'s save migration; this copy covers a value still sitting in
/// the toml.
fn upgrade_wecom(doc: &mut Map<String, Value>) {
    let id = text_of(doc, "bot_id");
    let secret = take_nonempty(doc, "secret");
    let aes = take_nonempty(doc, "encoding_aes_key");
    doc.remove("bot_id");
    let mut bot = Map::new();
    bot.insert("enabled".into(), Value::Bool(true));
    bot.insert("bot_id".into(), Value::String(id));
    if let Some(secret) = secret {
        bot.insert("secret".into(), Value::String(secret));
    }
    if let Some(aes) = aes {
        bot.insert("encoding_aes_key".into(), Value::String(aes));
    }
    doc.insert("bots".into(), Value::Array(vec![Value::Object(bot)]));
}

fn upgrade_seatalk(doc: &mut Map<String, Value>) {
    let id = text_of(doc, "app_id");
    let secret = take_nonempty(doc, "app_secret");
    let prompt = take_nonempty(doc, "system_prompt");
    doc.remove("app_id");
    let mut bot = Map::new();
    bot.insert("enabled".into(), Value::Bool(true));
    bot.insert("app_id".into(), Value::String(id));
    if let Some(secret) = secret {
        bot.insert("app_secret".into(), Value::String(secret));
    }
    if let Some(prompt) = prompt {
        bot.insert("system_prompt".into(), Value::String(prompt));
    }
    doc.insert("bots".into(), Value::Array(vec![Value::Object(bot)]));
}

fn push_bot(doc: &mut Map<String, Value>, id_key: &str, id: &str) -> usize {
    let mut bot = Map::new();
    bot.insert("enabled".into(), Value::Bool(true));
    bot.insert(id_key.to_string(), Value::String(id.to_string()));
    let list = doc
        .entry(String::from("bots"))
        .or_insert_with(|| Value::Array(Vec::new()));
    if !list.is_array() {
        *list = Value::Array(Vec::new());
    }
    let list = list.as_array_mut().expect("bots just set to an array");
    list.push(Value::Object(bot));
    list.len() - 1
}

fn wecom_has_bot(doc: &Map<String, Value>) -> bool {
    !matches!(bot_layout(doc, "bot_id"), Layout::Empty)
}

fn seatalk_has_app(doc: &Map<String, Value>) -> bool {
    !matches!(bot_layout(doc, "app_id"), Layout::Empty)
}

fn ensure_unique_bots(doc: &Map<String, Value>, id_key: &str, channel: &str) -> Result<(), String> {
    let mut seen = HashSet::new();
    for id in bot_ids(doc, id_key) {
        if !seen.insert(id.clone()) {
            return Err(format!(
                "{channel} has two bots with id {id}. Fix that in Settings before changing one."
            ));
        }
    }
    Ok(())
}

fn find_bot(doc: &Map<String, Value>, id_key: &str, id: &str) -> Option<usize> {
    bots(doc)?
        .iter()
        .position(|bot| bot.get(id_key).and_then(Value::as_str) == Some(id))
}

fn bots(doc: &Map<String, Value>) -> Option<&Vec<Value>> {
    doc.get("bots")?.as_array()
}

fn bot_ids(doc: &Map<String, Value>, id_key: &str) -> Vec<String> {
    bots(doc)
        .map(|list| {
            list.iter()
                .filter_map(|bot| bot.get(id_key).and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn bot_mut(doc: &mut Map<String, Value>, index: usize) -> Result<&mut Map<String, Value>, String> {
    doc.get_mut("bots")
        .and_then(Value::as_array_mut)
        .and_then(|list| list.get_mut(index))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "internal error: bot slot missing".to_string())
}

fn set_enabled(
    doc: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    existed: bool,
    changes: &mut Vec<Change>,
) -> Result<bool, String> {
    let from = match doc.get("enabled") {
        Some(Value::Bool(on)) => *on,
        Some(_) => return Err("stored enabled flag is not a boolean".to_string()),
        // An existing section with no flag is running. A section we are about
        // to create stays off until the patch says otherwise.
        None => existed,
    };
    let to = match patch.get("enabled") {
        Some(value) => expect_bool(value, "enabled")?,
        None => from,
    };
    doc.insert("enabled".into(), Value::Bool(to));
    if to != from {
        changes.push(Change::Enabled { from, to });
    }
    Ok(to)
}

fn assign_runtime(
    doc: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    channel: &str,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    assign_text(
        doc,
        "workspace_id",
        patch.get("workspaceId"),
        &format!("{channel} workspace"),
        changes,
    )?;
    assign_text(
        doc,
        "model",
        patch.get("model"),
        &format!("{channel} model"),
        changes,
    )?;
    Ok(())
}

fn assign_secret(
    obj: &mut Map<String, Value>,
    key: &str,
    patch_value: Option<&Value>,
    what: &str,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    let Some(value) = patch_value else {
        return Ok(());
    };
    let next = match value {
        Value::Null => return Ok(()),
        Value::String(text) if text.trim().is_empty() || is_placeholder(text) => return Ok(()),
        Value::String(text) => text.clone(),
        _ => return Err(format!("{what} must be a string")),
    };
    if text_of(obj, key) == next {
        return Ok(());
    }
    obj.insert(key.to_string(), Value::String(next));
    changes.push(Change::Secret {
        what: what.to_string(),
    });
    Ok(())
}

fn assign_password(
    doc: &mut Map<String, Value>,
    patch_value: Option<&Value>,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    let Some(value) = patch_value else {
        return Ok(());
    };
    let next = match value {
        Value::Null => return Ok(()),
        Value::String(text) if text.trim().is_empty() || is_placeholder(text) => return Ok(()),
        Value::String(text) => text.clone(),
        _ => return Err("email password must be a string".to_string()),
    };
    if text_of(doc, "imap_pass") == next && text_of(doc, "smtp_pass") == next {
        return Ok(());
    }
    doc.insert("imap_pass".into(), Value::String(next.clone()));
    doc.insert("smtp_pass".into(), Value::String(next));
    changes.push(Change::Secret {
        what: "email password".into(),
    });
    Ok(())
}

fn assign_text(
    obj: &mut Map<String, Value>,
    key: &str,
    patch_value: Option<&Value>,
    what: &str,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    let Some(value) = patch_value else {
        return Ok(());
    };
    let text = match value {
        Value::Null => "",
        Value::String(text) => text.trim(),
        _ => return Err(format!("{what} must be a string")),
    };
    if text.is_empty() {
        if obj
            .remove(key)
            .is_some_and(|old| old.as_str().is_some_and(|s| !s.is_empty()))
        {
            changes.push(Change::Cleared {
                what: what.to_string(),
            });
        }
        return Ok(());
    }
    assign_exact(obj, key, text, what, changes);
    Ok(())
}

fn assign_exact(
    obj: &mut Map<String, Value>,
    key: &str,
    next: &str,
    what: &str,
    changes: &mut Vec<Change>,
) {
    if text_of(obj, key) == next {
        return;
    }
    obj.insert(key.to_string(), Value::String(next.to_string()));
    changes.push(Change::Text {
        what: what.to_string(),
        value: truncate(next, 80),
    });
}

fn assign_port(
    obj: &mut Map<String, Value>,
    key: &str,
    value: &Value,
    what: &str,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    let port = expect_port(value, what)?;
    let current = obj.get(key).and_then(Value::as_u64);
    if current == Some(u64::from(port)) {
        return Ok(());
    }
    obj.insert(key.to_string(), json_u16(port));
    changes.push(Change::Text {
        what: what.to_string(),
        value: port.to_string(),
    });
    Ok(())
}

fn assign_list(
    obj: &mut Map<String, Value>,
    key: &str,
    value: &Value,
    what: &str,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    let next = expect_string_list(value, what)?;
    let current = string_list(obj.get(key));
    if current == next {
        return Ok(());
    }
    obj.insert(
        key.to_string(),
        Value::Array(next.iter().cloned().map(Value::String).collect()),
    );
    let shown = if next.is_empty() {
        "(none)".to_string()
    } else {
        truncate(&next.join(", "), 80)
    };
    changes.push(Change::Text {
        what: what.to_string(),
        value: shown,
    });
    Ok(())
}

fn view_wecom(doc: &Map<String, Value>, secrets: &HashSet<String>, known: bool) -> Value {
    let mut out = Map::new();
    out.insert("enabled".into(), Value::Bool(flag_or_true(doc)));
    let bots = if let Some(list) = bots(doc).filter(|list| !list.is_empty()) {
        list.iter()
            .filter_map(Value::as_object)
            .map(|bot| {
                let id = text_of(bot, "bot_id");
                view_wecom_bot(bot, &id, secrets, known, false)
            })
            .collect()
    } else {
        let id = text_of(doc, "bot_id");
        if id.is_empty() {
            Vec::new()
        } else {
            vec![view_wecom_bot(doc, &id, secrets, known, true)]
        }
    };
    out.insert("bots".into(), Value::Array(bots));
    Value::Object(out)
}

fn view_wecom_bot(
    source: &Map<String, Value>,
    id: &str,
    secrets: &HashSet<String>,
    known: bool,
    legacy: bool,
) -> Value {
    let mut bot = Map::new();
    let enabled = if legacy {
        true
    } else {
        source
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    };
    bot.insert("enabled".into(), Value::Bool(enabled));
    bot.insert("botId".into(), Value::String(id.to_string()));
    let secret_key = if legacy {
        "channels.wecom.secret".to_string()
    } else {
        format!("channels.wecom.bots[{id}].secret")
    };
    let aes_key = if legacy {
        "channels.wecom.encoding_aes_key".to_string()
    } else {
        format!("channels.wecom.bots[{id}].encoding_aes_key")
    };
    insert_secret(
        &mut bot,
        "secret",
        source.get("secret"),
        &secret_key,
        secrets,
        known,
    );
    insert_secret(
        &mut bot,
        "encodingAesKey",
        source.get("encoding_aes_key"),
        &aes_key,
        secrets,
        known,
    );
    if !legacy {
        insert_secret(
            &mut bot,
            "apiKey",
            source.get("api_key"),
            &format!("channels.wecom.bots[{id}].api_key"),
            secrets,
            known,
        );
        copy_text(&mut bot, "botName", source.get("bot_name"));
        copy_text(&mut bot, "systemPrompt", source.get("system_prompt"));
        copy_text(&mut bot, "workspaceId", source.get("workspace_id"));
        copy_text(&mut bot, "model", source.get("model"));
    }
    Value::Object(bot)
}

fn view_seatalk(doc: &Map<String, Value>, secrets: &HashSet<String>, known: bool) -> Value {
    let mut out = Map::new();
    out.insert("enabled".into(), Value::Bool(flag_or_true(doc)));
    copy_text(&mut out, "mode", doc.get("mode"));
    copy_text(&mut out, "dmPolicy", doc.get("dm_policy"));
    copy_text(&mut out, "groupPolicy", doc.get("group_policy"));
    if let Some(list) = doc.get("allow_from").and_then(Value::as_array) {
        out.insert("allowFrom".into(), Value::Array(list.clone()));
    }
    if let Some(list) = doc.get("group_allow_from").and_then(Value::as_array) {
        out.insert("groupAllowFrom".into(), Value::Array(list.clone()));
    }
    let bots = if let Some(list) = bots(doc).filter(|list| !list.is_empty()) {
        list.iter()
            .filter_map(Value::as_object)
            .map(|bot| view_seatalk_bot(bot, secrets, known, false))
            .collect()
    } else {
        let id = text_of(doc, "app_id");
        if id.is_empty() {
            Vec::new()
        } else {
            vec![view_seatalk_bot(doc, secrets, known, true)]
        }
    };
    out.insert("bots".into(), Value::Array(bots));
    Value::Object(out)
}

fn view_seatalk_bot(
    source: &Map<String, Value>,
    secrets: &HashSet<String>,
    known: bool,
    legacy: bool,
) -> Value {
    let id = text_of(source, "app_id");
    let mut bot = Map::new();
    bot.insert(
        "enabled".into(),
        Value::Bool(if legacy {
            true
        } else {
            source
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        }),
    );
    bot.insert("appId".into(), Value::String(id.clone()));
    let secret_key = if legacy {
        "channels.seatalk.app_secret".to_string()
    } else {
        format!("channels.seatalk.bots[{id}].app_secret")
    };
    insert_secret(
        &mut bot,
        "appSecret",
        source.get("app_secret"),
        &secret_key,
        secrets,
        known,
    );
    copy_text(&mut bot, "systemPrompt", source.get("system_prompt"));
    if !legacy {
        copy_text(&mut bot, "workspaceId", source.get("workspace_id"));
        copy_text(&mut bot, "model", source.get("model"));
    }
    Value::Object(bot)
}

fn view_simple(
    doc: &Map<String, Value>,
    fields: &[(&str, &str, &str)],
    secrets: &HashSet<String>,
    known: bool,
) -> Value {
    let mut out = Map::new();
    out.insert("enabled".into(), Value::Bool(flag_or_true(doc)));
    for (camel, snake, secret_path) in fields {
        if secret_path.is_empty() {
            copy_text(&mut out, camel, doc.get(*snake));
        } else {
            insert_secret(
                &mut out,
                camel,
                doc.get(*snake),
                secret_path,
                secrets,
                known,
            );
        }
    }
    Value::Object(out)
}

fn view_email(doc: &Map<String, Value>, secrets: &HashSet<String>, known: bool) -> Value {
    let mut out = Map::new();
    out.insert("enabled".into(), Value::Bool(flag_or_true(doc)));
    copy_text(&mut out, "imapServer", doc.get("imap_host"));
    if let Some(port) = doc.get("imap_port").and_then(Value::as_u64) {
        out.insert("imapPort".into(), Value::from(port));
    }
    copy_text(&mut out, "smtpServer", doc.get("smtp_host"));
    if let Some(port) = doc.get("smtp_port").and_then(Value::as_u64) {
        out.insert("smtpPort".into(), Value::from(port));
    }
    copy_text(&mut out, "username", doc.get("imap_user"));
    let password_known = (known
        && (secrets.contains("channels.email.imap_pass")
            || secrets.contains("channels.email.smtp_pass")))
        || nonempty(doc.get("imap_pass"))
        || nonempty(doc.get("smtp_pass"));
    if password_known {
        out.insert("password".into(), Value::String("[configured]".into()));
    }
    if let Some(list) = doc.get("allowed_senders").and_then(Value::as_array) {
        out.insert("allowedSenders".into(), Value::Array(list.clone()));
    }
    copy_text(&mut out, "workspaceId", doc.get("workspace_id"));
    copy_text(&mut out, "model", doc.get("model"));
    Value::Object(out)
}

fn insert_secret(
    out: &mut Map<String, Value>,
    camel: &str,
    stored: Option<&Value>,
    path: &str,
    secrets: &HashSet<String>,
    known: bool,
) {
    if nonempty(stored) || (known && secrets.contains(path)) {
        out.insert(camel.to_string(), Value::String("[configured]".into()));
    }
}

fn copy_text(out: &mut Map<String, Value>, camel: &str, stored: Option<&Value>) {
    if let Some(text) = stored.and_then(Value::as_str).filter(|s| !s.is_empty()) {
        out.insert(camel.to_string(), Value::String(text.to_string()));
    }
}

fn flag_or_true(doc: &Map<String, Value>) -> bool {
    doc.get("enabled").and_then(Value::as_bool).unwrap_or(true)
}

fn nonempty(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
}

fn text_of(obj: &Map<String, Value>, key: &str) -> String {
    obj.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn take_nonempty(doc: &mut Map<String, Value>, key: &str) -> Option<String> {
    match doc.remove(key) {
        Some(Value::String(text)) if !text.is_empty() => Some(text),
        _ => None,
    }
}

fn is_placeholder(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.eq_ignore_ascii_case("[configured]") || trimmed.eq_ignore_ascii_case("[redacted]")
}

fn reject_unknown(patch: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    for key in patch.keys() {
        if !allowed.contains(&key.as_str()) {
            let hint = if key.contains('_') {
                " Use the settings-page name (camelCase)."
            } else if key == "ownerId" {
                " ownerId is not a channel setting."
            } else if key == "bots" {
                " Pass botId or appId to choose one bot; the bot list is edited in Settings."
            } else {
                ""
            };
            return Err(format!("unknown field '{key}'.{hint}"));
        }
    }
    Ok(())
}

fn reject_legacy(patch: &Map<String, Value>, fields: &[(&str, &str)]) -> Result<(), String> {
    for (key, channel) in fields {
        if patch.contains_key(*key) {
            return Err(format!(
                "{channel} no longer stores '{key}'. It is not part of the gateway config."
            ));
        }
    }
    Ok(())
}

fn require_id(value: &Value, field: &str) -> Result<String, String> {
    let id = expect_string(value, field)?;
    let id = id.trim();
    if id.is_empty() {
        return Err(format!("{field} is empty"));
    }
    if id.contains('[') || id.contains(']') || id.contains('\n') || id.contains('\r') {
        return Err(format!("{field} must not contain brackets or line breaks"));
    }
    Ok(id.to_string())
}

fn expect_bool(value: &Value, field: &str) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| format!("{field} must be a boolean"))
}

fn expect_string(value: &Value, field: &str) -> Result<String, String> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{field} must be a string"))
}

fn expect_choice(value: &Value, field: &str, allowed: &[&str]) -> Result<String, String> {
    let text = expect_string(value, field)?;
    if allowed.contains(&text.as_str()) {
        Ok(text)
    } else {
        Err(format!("{field} must be one of: {}", allowed.join(", ")))
    }
}

fn expect_port(value: &Value, field: &str) -> Result<u16, String> {
    let port = value
        .as_u64()
        .ok_or_else(|| format!("{field} must be a port number"))?;
    u16::try_from(port)
        .map_err(|_| format!("{field} must be a port number"))
        .and_then(|port| {
            if port == 0 {
                Err(format!("{field} must be a port number"))
            } else {
                Ok(port)
            }
        })
}

fn expect_string_list(value: &Value, field: &str) -> Result<Vec<String>, String> {
    let list = value
        .as_array()
        .ok_or_else(|| format!("{field} must be an array of strings"))?;
    let mut out = Vec::new();
    for item in list {
        let text = item
            .as_str()
            .ok_or_else(|| format!("{field} must be an array of strings"))?;
        let text = text.trim();
        if !text.is_empty() {
            out.push(text.to_string());
        }
    }
    Ok(out)
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn json_u16(port: u16) -> Value {
    Value::from(u64::from(port))
}

fn truncate(text: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if out.len() >= max {
            out.push('…');
            break;
        }
        if ch == '\n' || ch == '\r' {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out
}

fn en_on(on: bool) -> &'static str {
    if on {
        "on"
    } else {
        "off"
    }
}

fn zh_on(on: bool) -> &'static str {
    if on {
        "开"
    } else {
        "关"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plan(platform: &str, current: Value, patch: Value) -> Result<ChannelPlan, String> {
        let current = if current.is_null() {
            None
        } else {
            Some(current)
        };
        plan_update(platform, current.as_ref(), &patch)
    }

    fn lines(changes: &[Change]) -> String {
        changes
            .iter()
            .map(|change| change.format(false))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn omitted_enabled_stays_on_and_a_placeholder_is_not_a_secret() {
        let current = json!({
            "enabled": true,
            "bots": [
                {"enabled": true, "bot_id": "a", "bot_name": "A", "secret": "keep"},
                {"enabled": true, "bot_id": "b", "bot_name": "B"}
            ],
            "stream_max_secs": 90
        });
        let planned = plan(
            "wecom",
            current,
            json!({"botId": "b", "secret": "[configured]"}),
        )
        .unwrap();
        assert!(planned.changes.is_empty(), "{}", lines(&planned.changes));
        assert_eq!(planned.document["enabled"], true);
        assert_eq!(planned.document["stream_max_secs"], 90);
        assert_eq!(planned.document["bots"][0]["secret"], "keep");
        assert_eq!(planned.document["bots"][0]["bot_name"], "A");
        assert!(planned.document["bots"][1].get("secret").is_none());
    }

    #[test]
    fn omitted_enabled_does_not_turn_a_channel_off() {
        let planned = plan("discord", json!({"enabled": true}), json!({})).unwrap();
        assert!(planned.changes.is_empty());
        assert_eq!(planned.document["enabled"], true);
    }

    #[test]
    fn a_new_channel_stays_off_until_enabled_is_set() {
        let planned = plan(
            "discord",
            Value::Null,
            json!({"token": "discord-secret-value"}),
        )
        .unwrap();
        assert_eq!(planned.document["enabled"], false);
        assert_eq!(planned.document["bot_token"], "discord-secret-value");
        assert!(planned.document.get("token").is_none());
        assert!(!lines(&planned.changes).contains("discord-secret-value"));
        assert!(lines(&planned.changes).contains("Discord token"));
    }

    #[test]
    fn explicit_enabled_false_is_a_real_change() {
        let planned = plan(
            "discord",
            json!({"enabled": true}),
            json!({"enabled": false}),
        )
        .unwrap();
        assert_eq!(planned.document["enabled"], false);
        assert!(lines(&planned.changes).contains("enabled: on → off"));
    }

    #[test]
    fn several_wecom_bots_require_an_id() {
        let err = plan(
            "wecom",
            json!({"enabled": true, "bots": [
                {"bot_id": "a"},
                {"bot_id": "b"}
            ]}),
            json!({"secret": "x"}),
        )
        .unwrap_err();
        assert!(err.contains("bot a") || err.contains('a'), "{err}");
        assert!(err.contains('b'), "{err}");
    }

    #[test]
    fn bot_id_updates_only_that_bot_and_keeps_the_other() {
        let planned = plan(
            "wecom",
            json!({
                "enabled": true,
                "bots": [
                    {"enabled": true, "bot_id": "a", "bot_name": "A", "api_key": "k"},
                    {"enabled": false, "bot_id": "b", "bot_name": "B"}
                ]
            }),
            json!({"botId": "b", "secret": "new-secret", "botName": "Bee"}),
        )
        .unwrap();
        assert_eq!(planned.document["bots"][0]["bot_name"], "A");
        assert_eq!(planned.document["bots"][0]["api_key"], "k");
        assert_eq!(planned.document["bots"][0].get("secret"), None);
        assert_eq!(planned.document["bots"][1]["secret"], "new-secret");
        assert_eq!(planned.document["bots"][1]["bot_name"], "Bee");
        assert_eq!(planned.document["bots"][1]["enabled"], false);
        let summary = lines(&planned.changes);
        assert!(!summary.contains("new-secret"));
        assert!(summary.contains("WeCom secret"));
    }

    #[test]
    fn an_unknown_bot_id_adds_a_bot_without_touching_the_existing_one() {
        let planned = plan(
            "wecom",
            json!({"enabled": true, "bots": [{"enabled": true, "bot_id": "a", "bot_name": "A"}]}),
            json!({"botId": "c", "secret": "s3"}),
        )
        .unwrap();
        assert_eq!(planned.document["bots"].as_array().unwrap().len(), 2);
        assert_eq!(planned.document["bots"][0]["bot_name"], "A");
        assert_eq!(planned.document["bots"][1]["bot_id"], "c");
        assert_eq!(planned.document["bots"][1]["secret"], "s3");
        assert!(lines(&planned.changes).contains("add WeCom bot c"));
    }

    #[test]
    fn one_bot_can_be_patched_without_repeating_its_id() {
        let planned = plan(
            "wecom",
            json!({"enabled": true, "bots": [{"enabled": true, "bot_id": "only"}]}),
            json!({"botName": "Only"}),
        )
        .unwrap();
        assert_eq!(planned.document["bots"][0]["bot_name"], "Only");
        assert!(planned
            .changes
            .iter()
            .all(|change| !matches!(change, Change::AddedBot { .. })));
    }

    #[test]
    fn a_legacy_wecom_secret_stays_on_the_legacy_fields() {
        let planned = plan(
            "wecom",
            json!({"enabled": true, "bot_id": "legacy", "stream_max_secs": 120}),
            json!({"secret": "rotated"}),
        )
        .unwrap();
        assert!(planned.document.get("bots").is_none());
        assert_eq!(planned.document["bot_id"], "legacy");
        assert_eq!(planned.document["secret"], "rotated");
        assert_eq!(planned.document["stream_max_secs"], 120);
        assert_eq!(planned.document["enabled"], true);
    }

    #[test]
    fn bot_only_fields_upgrade_legacy_wecom_and_keep_an_inline_secret() {
        let planned = plan(
            "wecom",
            json!({"enabled": true, "bot_id": "legacy", "secret": "inline-secret"}),
            json!({"botName": "Named"}),
        )
        .unwrap();
        assert!(planned.document.get("bot_id").is_none());
        assert_eq!(planned.document["bots"][0]["bot_id"], "legacy");
        assert_eq!(planned.document["bots"][0]["secret"], "inline-secret");
        assert_eq!(planned.document["bots"][0]["bot_name"], "Named");
        assert!(!lines(&planned.changes).contains("inline-secret"));
    }

    #[test]
    fn unknown_and_snake_case_fields_are_rejected() {
        let err = plan(
            "wecom",
            json!({"enabled": true, "bot_id": "b"}),
            json!({"ownerId": "u"}),
        )
        .unwrap_err();
        assert!(err.contains("ownerId"), "{err}");
        let err = plan(
            "discord",
            json!({"enabled": true}),
            json!({"bot_token": "x"}),
        )
        .unwrap_err();
        assert!(err.contains("camelCase"), "{err}");
        let err = plan(
            "discord",
            json!({"enabled": true}),
            json!({"dm": {"enabled": true}}),
        )
        .unwrap_err();
        assert!(err.contains("dm"), "{err}");
        let err = plan(
            "feishu",
            json!({"enabled": true, "app_id": "a"}),
            json!({"chats": []}),
        )
        .unwrap_err();
        assert!(err.contains("chats"), "{err}");
    }

    #[test]
    fn feishu_and_email_use_the_daemon_field_names() {
        let planned = plan(
            "feishu",
            json!({"enabled": true, "app_id": "cli"}),
            json!({"appSecret": "[configured]", "appId": "cli"}),
        )
        .unwrap();
        assert!(planned.changes.is_empty(), "{}", lines(&planned.changes));

        let planned = plan(
            "email",
            json!({
                "enabled": true,
                "imap_host": "imap.example",
                "imap_port": 993,
                "smtp_host": "smtp.example",
                "smtp_port": 587,
                "imap_user": "a@example",
                "smtp_user": "a@example"
            }),
            json!({"password": "[configured]", "username": "a@example"}),
        )
        .unwrap();
        assert!(planned.changes.is_empty(), "{}", lines(&planned.changes));
        assert!(planned.document.get("password").is_none());
        assert!(planned.document.get("imap_pass").is_none());
    }

    #[test]
    fn email_password_sets_both_passes_and_blank_does_not() {
        let current = json!({
            "enabled": true,
            "imap_host": "imap.example",
            "imap_port": 993,
            "smtp_host": "smtp.example",
            "smtp_port": 587,
            "imap_user": "a@example",
            "smtp_user": "a@example",
            "imap_pass": "old"
        });
        let untouched = plan("email", current.clone(), json!({"password": ""})).unwrap();
        assert!(untouched.changes.is_empty());
        assert_eq!(untouched.document["imap_pass"], "old");
        assert!(untouched.document.get("smtp_pass").is_none());

        let planned = plan("email", current, json!({"password": "new-pass"})).unwrap();
        assert_eq!(planned.document["imap_pass"], "new-pass");
        assert_eq!(planned.document["smtp_pass"], "new-pass");
        assert!(!lines(&planned.changes).contains("new-pass"));
    }

    #[test]
    fn email_cannot_be_enabled_without_servers() {
        let err = plan(
            "email",
            Value::Null,
            json!({"enabled": true, "username": "a@example"}),
        )
        .unwrap_err();
        assert!(err.contains("imapServer"), "{err}");
    }

    #[test]
    fn several_seatalk_apps_require_an_id_and_a_new_id_adds_one() {
        let err = plan(
            "seatalk",
            json!({"enabled": true, "bots": [{"app_id": "one"}, {"app_id": "two"}]}),
            json!({"appSecret": "x"}),
        )
        .unwrap_err();
        assert!(err.contains("one") && err.contains("two"), "{err}");

        let planned = plan(
            "seatalk",
            json!({
                "enabled": true,
                "mode": "websocket",
                "bots": [{"enabled": true, "app_id": "one", "system_prompt": "keep"}]
            }),
            json!({"appId": "two", "appSecret": "sec", "mode": "websocket"}),
        )
        .unwrap();
        assert_eq!(planned.document["mode"], "websocket");
        assert_eq!(planned.document["bots"][0]["system_prompt"], "keep");
        assert_eq!(planned.document["bots"][1]["app_id"], "two");
        assert_eq!(planned.document["bots"][1]["app_secret"], "sec");
        assert_eq!(planned.document["enabled"], true);
    }

    #[test]
    fn a_bracket_in_a_bot_id_is_rejected() {
        let err = plan(
            "wecom",
            json!({"enabled": false}),
            json!({"botId": "a[b]", "secret": "x"}),
        )
        .unwrap_err();
        assert!(err.contains("brackets"), "{err}");
    }

    #[test]
    fn enabled_must_be_a_boolean() {
        let err = plan(
            "discord",
            json!({"enabled": true}),
            json!({"enabled": "yes"}),
        )
        .unwrap_err();
        assert!(err.contains("boolean"), "{err}");
    }

    #[test]
    fn the_view_redacts_plaintext_and_store_presence() {
        let current = json!({
            "enabled": true,
            "bots": [{
                "bot_id": "a",
                "secret": "do-not-leak",
                "bot_name": "Ann"
            }]
        });
        let mut keys = HashSet::new();
        keys.insert("channels.wecom.bots[a].api_key".into());
        let view = agent_view("wecom", Some(&current), &keys, true);
        let text = view.to_string();
        assert!(!text.contains("do-not-leak"), "{text}");
        assert_eq!(view["bots"][0]["secret"], "[configured]");
        assert_eq!(view["bots"][0]["apiKey"], "[configured]");
        assert_eq!(view["bots"][0]["botName"], "Ann");
        assert!(view["bots"][0].get("encodingAesKey").is_none());
        assert!(is_enabled(Some(&current)));
    }

    #[test]
    fn a_legacy_wecom_section_is_shown_as_one_bot_without_its_secret() {
        let current = json!({"enabled": true, "bot_id": "legacy", "secret": "hidden"});
        let view = agent_view("wecom", Some(&current), &HashSet::new(), true);
        let text = view.to_string();
        assert!(!text.contains("hidden"), "{text}");
        assert_eq!(view["bots"][0]["botId"], "legacy");
        assert_eq!(view["bots"][0]["secret"], "[configured]");
    }

    #[test]
    fn unknown_secret_presence_still_hides_a_plaintext_token() {
        let current = json!({"enabled": true, "bot_token": "discord-token"});
        let view = agent_view("discord", Some(&current), &HashSet::new(), false);
        assert!(!view.to_string().contains("discord-token"));
        assert_eq!(view["token"], "[configured]");
        let mut keys = HashSet::new();
        keys.insert("channels.discord.bot_token".into());
        let from_store = agent_view("discord", Some(&json!({"enabled": false})), &keys, true);
        assert_eq!(from_store["token"], "[configured]");
        assert_eq!(from_store["enabled"], false);
        assert!(!is_enabled(Some(&json!({"enabled": false}))));
    }

    #[test]
    fn replacing_the_bot_list_is_rejected() {
        let err = plan(
            "wecom",
            json!({"enabled": true, "bots": [{"bot_id": "a"}]}),
            json!({"bots": []}),
        )
        .unwrap_err();
        assert!(err.contains("botId"), "{err}");
    }
}
