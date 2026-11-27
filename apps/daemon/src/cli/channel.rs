use crate::cli::{ChannelAction, ChannelArgs, ChannelBindArgs, ChannelBindPlatform};
use crate::config::DaemonConfig;
use std::path::Path;

pub fn run(args: ChannelArgs, config_path: &Path) -> anyhow::Result<()> {
    match args.action {
        ChannelAction::List => {
            let mut cfg = DaemonConfig::load_hydrated(config_path)?;
            list(&cfg);
        }
        ChannelAction::Bind(b) => {
            let mut cfg = DaemonConfig::load_hydrated(config_path)?;
            bind(&mut cfg, b)?;
            crate::config::team_config::persist_from(&cfg)
                .map_err(|e| crate::error::AmuxError::Config(format!("write team.toml: {e}")))?;
            println!("bound.");
        }
        ChannelAction::Unbind { platform } => {
            let mut cfg = DaemonConfig::load_hydrated(config_path)?;
            unbind(&mut cfg, &platform)?;
            crate::config::team_config::persist_from(&cfg)
                .map_err(|e| crate::error::AmuxError::Config(format!("write team.toml: {e}")))?;
            println!("unbound.");
        }
        ChannelAction::Test { platform } => {
            let mut cfg = DaemonConfig::load_hydrated(config_path)?;
            test_channel(&cfg, &platform)?;
        }
        ChannelAction::Reload => {
            reload()?;
        }
        ChannelAction::Show { platform, output } => {
            let code = super::envelope::emit(&output, show(platform.as_deref()));
            if code != 0 {
                std::process::exit(code);
            }
        }
        ChannelAction::Set {
            platform,
            config_file,
            output,
        } => {
            let code = super::envelope::emit(&output, set(&platform, &config_file));
            if code != 0 {
                std::process::exit(code);
            }
        }
    }
    Ok(())
}

const PLATFORMS: &[&str] = &[
    "discord",
    "wecom",
    "feishu",
    "kook",
    "wechat",
    "wechatpad",
    "email",
    "seatalk",
];

/// The active team's `[channels]` from team.toml, as JSON, or the envelope
/// to print instead.
fn team_channels() -> Result<serde_json::Map<String, serde_json::Value>, serde_json::Value> {
    use super::envelope::error_envelope;
    let team = crate::config::layout::active_team();
    if team == crate::config::layout::UNCLAIMED_TEAM {
        return Err(error_envelope(
            "not_onboarded",
            "this daemon is not onboarded to a team, so it has no channels",
            Some("amuxd init <invite-url>"),
            3,
            false,
        ));
    }
    let path = crate::config::team_config::path_for(&team);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err(error_envelope(
                "config_unreadable",
                &format!("read {}: {e}", path.display()),
                None,
                7,
                false,
            ))
        }
    };
    let doc: toml::Value = toml::from_str(&text).map_err(|e| {
        error_envelope(
            "config_unreadable",
            &format!("parse {}: {e}", path.display()),
            None,
            7,
            false,
        )
    })?;
    let channels = doc
        .get("channels")
        .cloned()
        .unwrap_or(toml::Value::Table(Default::default()));
    match serde_json::to_value(channels) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        _ => Ok(serde_json::Map::new()),
    }
}

/// Names of the stored credentials, asked of the running daemon (it holds
/// the key to the secret store). Empty when it does not answer.
fn stored_secret_keys() -> Vec<String> {
    let sock = DaemonConfig::sock_path();
    super::sock::sock_roundtrip(&sock, "channel-secret-keys")
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v["keys"].as_array().cloned())
        .map(|keys| {
            keys.into_iter()
                .filter_map(|k| k.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn unknown_platform(platform: &str) -> serde_json::Value {
    super::envelope::error_envelope(
        "unknown_platform",
        &format!(
            "unknown channel {platform:?}; one of {}",
            PLATFORMS.join(", ")
        ),
        None,
        2,
        false,
    )
}

/// Every channel's section (or one), each with the credentials stored for it.
fn show(platform: Option<&str>) -> serde_json::Value {
    use serde_json::json;
    if let Some(p) = platform.filter(|p| !PLATFORMS.contains(p)) {
        return unknown_platform(p);
    }
    let channels = match team_channels() {
        Ok(c) => c,
        Err(envelope) => return envelope,
    };
    let secrets = stored_secret_keys();
    let entry = |name: &str, config: &serde_json::Value| {
        let prefix = format!("channels.{name}.");
        let set: Vec<String> = secrets
            .iter()
            .filter_map(|k| k.strip_prefix(&prefix).map(str::to_owned))
            .collect();
        json!({ "platform": name, "config": config, "secretsSet": set })
    };
    match platform {
        Some(p) => match channels.get(p) {
            Some(config) => super::envelope::success(entry(p, config)),
            None => super::envelope::error_envelope(
                "not_configured",
                &format!("channel {p} is not configured"),
                Some("amuxd channel show"),
                5,
                false,
            ),
        },
        None => {
            let list: Vec<serde_json::Value> = channels
                .iter()
                .filter(|(name, v)| v.is_object() && PLATFORMS.contains(&name.as_str()))
                .map(|(name, v)| entry(name, v))
                .collect();
            let mut data = json!({ "channels": list });
            if let Some(model) = channels.get("model") {
                data["model"] = model.clone();
            }
            super::envelope::success(data)
        }
    }
}

/// `patch` merged over `current`, one level deep: a field in the patch
/// replaces the field, others stay. A credential left out stays stored
/// (the daemon reads an empty credential as "keep").
fn merged(
    current: Option<&serde_json::Value>,
    patch: serde_json::Map<String, serde_json::Value>,
) -> serde_json::Value {
    let mut out = current
        .and_then(|c| c.as_object().cloned())
        .unwrap_or_default();
    out.extend(patch);
    serde_json::Value::Object(out)
}

fn set(platform: &str, config_file: &str) -> serde_json::Value {
    use super::envelope::{error_envelope, success, unreachable};
    if !PLATFORMS.contains(&platform) {
        return unknown_platform(platform);
    }
    let patch = match super::envelope::read_json_object(config_file) {
        Ok(p) => p,
        Err(u) => return u.envelope(),
    };
    let channels = match team_channels() {
        Ok(c) => c,
        Err(envelope) => return envelope,
    };
    let line = serde_json::json!({
        "cmd": "channel-set",
        "platform": platform,
        "config": merged(channels.get(platform), patch),
    });
    let sock = DaemonConfig::sock_path();
    let raw = match super::sock::sock_roundtrip(&sock, &line.to_string()) {
        Ok(raw) => raw,
        Err(e) => return unreachable(e),
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(reply) if reply["ok"] == true => {
            success(serde_json::json!({ "platform": platform, "saved": true }))
        }
        Ok(reply) => error_envelope(
            "invalid_config",
            reply["error"]
                .as_str()
                .unwrap_or("the daemon refused the config"),
            Some("amuxd channel show <platform>"),
            2,
            false,
        ),
        Err(_) if raw.trim().is_empty() => error_envelope(
            "daemon_too_old",
            "the running amuxd does not answer channel-set",
            Some("restart amuxd so it runs this version"),
            7,
            false,
        ),
        Err(e) => unreachable(e),
    }
}

#[cfg(test)]
mod agent_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_patch_replaces_its_fields_and_keeps_the_rest() {
        let current = json!({ "enabled": true, "bot_id": "b1", "bots": [{ "bot_id": "x" }] });
        let patch = json!({ "enabled": false, "secret": "s" })
            .as_object()
            .cloned()
            .unwrap();
        assert_eq!(
            merged(Some(&current), patch),
            json!({ "enabled": false, "bot_id": "b1", "bots": [{ "bot_id": "x" }], "secret": "s" })
        );
        let patch = json!({ "enabled": true }).as_object().cloned().unwrap();
        assert_eq!(merged(None, patch), json!({ "enabled": true }));
    }

    #[test]
    fn unknown_platforms_are_refused_before_anything_is_read() {
        assert_eq!(show(Some("slack"))["error"]["exit"], 2);
        assert_eq!(
            set("slack", "/nonexistent")["error"]["code"],
            "unknown_platform"
        );
    }
}

fn list(cfg: &DaemonConfig) {
    let line =
        |k: &str, on: bool| println!("  {:<8} {}", k, if on { "enabled" } else { "disabled" });
    line(
        "discord",
        cfg.channels.discord.as_ref().is_some_and(|c| c.enabled),
    );
    line(
        "wecom",
        cfg.channels.wecom.as_ref().is_some_and(|c| c.enabled),
    );
    line(
        "feishu",
        cfg.channels.feishu.as_ref().is_some_and(|c| c.enabled),
    );
    line(
        "kook",
        cfg.channels.kook.as_ref().is_some_and(|c| c.enabled),
    );
    line(
        "wechat",
        cfg.channels.wechat.as_ref().is_some_and(|c| c.enabled),
    );
    line(
        "wechatpad",
        cfg.channels.wechatpad.as_ref().is_some_and(|c| c.enabled),
    );
    line(
        "email",
        cfg.channels.email.as_ref().is_some_and(|c| c.enabled),
    );
    line(
        "seatalk",
        cfg.channels.seatalk.as_ref().is_some_and(|c| c.enabled),
    );
}

fn bind(cfg: &mut DaemonConfig, b: ChannelBindArgs) -> anyhow::Result<()> {
    use crate::config::{
        DiscordChannel, EmailChannel, FeishuChannel, KookChannel, SeaTalkBot, SeaTalkChannel,
        WeChatChannel, WeComChannel,
    };
    match b.platform {
        ChannelBindPlatform::Discord {
            bot_token,
            default_username,
        } => {
            cfg.channels.discord = Some(DiscordChannel {
                enabled: true,
                bot_token,
                default_username,
                workspace_id: None,
                model: None,
            });
        }
        ChannelBindPlatform::Wecom {
            bot_id,
            secret,
            encoding_aes_key,
        } => {
            cfg.channels.wecom = Some(WeComChannel {
                enabled: true,
                bot_id,
                secret,
                encoding_aes_key,
                bots: vec![],
                stream_max_secs: 240,
                progress_frame_gap_secs: 10,
                final_max_retries: 3,
            });
        }
        ChannelBindPlatform::Feishu { app_id, app_secret } => {
            cfg.channels.feishu = Some(FeishuChannel {
                enabled: true,
                app_id,
                app_secret,
                workspace_id: None,
                model: None,
            });
        }
        ChannelBindPlatform::Kook { bot_token } => {
            cfg.channels.kook = Some(KookChannel {
                enabled: true,
                bot_token,
                workspace_id: None,
                model: None,
            });
        }
        ChannelBindPlatform::Wechat {
            ilink_account,
            ilink_token,
        } => {
            cfg.channels.wechat = Some(WeChatChannel {
                enabled: true,
                ilink_account,
                ilink_token,
                workspace_id: None,
                model: None,
            });
        }
        ChannelBindPlatform::Email {
            imap_host,
            imap_port,
            imap_user,
            imap_pass,
            smtp_host,
            smtp_port,
            smtp_user,
            smtp_pass,
        } => {
            cfg.channels.email = Some(EmailChannel {
                enabled: true,
                imap_host,
                imap_port,
                imap_user,
                imap_pass,
                smtp_host,
                smtp_port,
                smtp_user,
                smtp_pass,
                allowed_senders: vec![],
                workspace_id: None,
                model: None,
            });
        }
        ChannelBindPlatform::Seatalk { app_id, app_secret } => {
            cfg.channels.seatalk = Some(SeaTalkChannel {
                enabled: true,
                app_id: String::new(),
                app_secret: String::new(),
                mode: "websocket".to_string(),
                dm_policy: "open".to_string(),
                allow_from: vec![],
                group_policy: "open".to_string(),
                group_allow_from: vec![],
                system_prompt: None,
                bots: vec![SeaTalkBot {
                    enabled: true,
                    app_id,
                    app_secret,
                    system_prompt: None,
                    workspace_id: None,
                    model: None,
                }],
            });
        }
    }
    Ok(())
}

fn unbind(cfg: &mut DaemonConfig, platform: &str) -> anyhow::Result<()> {
    match platform {
        "discord" => {
            cfg.channels.discord = None;
        }
        "wecom" => {
            cfg.channels.wecom = None;
        }
        "feishu" => {
            cfg.channels.feishu = None;
        }
        "kook" => {
            cfg.channels.kook = None;
        }
        "wechat" => {
            cfg.channels.wechat = None;
        }
        "wechatpad" => {
            cfg.channels.wechatpad = None;
        }
        "email" => {
            cfg.channels.email = None;
        }
        "seatalk" => {
            cfg.channels.seatalk = None;
        }
        other => anyhow::bail!("unknown platform: {other}"),
    }
    Ok(())
}

fn test_channel(cfg: &DaemonConfig, platform: &str) -> anyhow::Result<()> {
    let ok = match platform {
        "discord" => cfg.channels.discord.is_some(),
        "wecom" => cfg.channels.wecom.is_some(),
        "feishu" => cfg.channels.feishu.is_some(),
        "kook" => cfg.channels.kook.is_some(),
        "wechat" => cfg.channels.wechat.is_some(),
        "wechatpad" => cfg.channels.wechatpad.is_some(),
        "email" => cfg.channels.email.is_some(),
        "seatalk" => cfg.channels.seatalk.is_some(),
        other => anyhow::bail!("unknown platform: {other}"),
    };
    println!(
        "{platform}: {}",
        if ok { "configured" } else { "not configured" }
    );
    Ok(())
}

fn reload() -> anyhow::Result<()> {
    let sock = DaemonConfig::sock_path();
    if !sock.exists() {
        anyhow::bail!("amuxd not running (no socket at {})", sock.display());
    }
    crate::cli::process::send_control(&sock, "channel-reload")?;
    println!("reload requested.");
    Ok(())
}
