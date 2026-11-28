//! `amuxd channel …` — the team's channel bindings (WeCom, Feishu, …), for
//! agents first and people second. One set of commands, one source:
//! everything reads the team's team.toml and writes through the running
//! daemon's `channel-set`, which stores credentials encrypted and reloads the
//! channel. Output: the `amuxd app` contract.
//!
//! `bind` / `unbind` / `list` were a second, offline set that wrote the file
//! directly and printed text. `list` and `unbind` are now aliases of `ls` and
//! `rm`; `bind` survives hidden, translated into a `set`.

use crate::cli::{ChannelAction, ChannelArgs, ChannelBindPlatform};
use crate::config::DaemonConfig;
use serde_json::{json, Map, Value};

/// Run one command; returns the process exit status.
pub fn run(args: ChannelArgs) -> anyhow::Result<i32> {
    let envelope = match args.action {
        ChannelAction::Ls => list(),
        ChannelAction::Show { platform } => show(platform.as_deref()),
        ChannelAction::Set {
            platform,
            config_file,
        } => set(&platform, &config_file),
        ChannelAction::Rm { platform } => remove(&platform),
        ChannelAction::Test { platform } => test_channel(&platform),
        ChannelAction::Reload => reload(),
        ChannelAction::Bind(b) => {
            let (platform, patch) = bind_patch(b.platform);
            set_patch(platform, patch)
        }
    };
    Ok(super::envelope::emit(&args.output, envelope))
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
    if !PLATFORMS.contains(&platform) {
        return unknown_platform(platform);
    }
    match super::envelope::read_json_object(config_file) {
        Ok(patch) => set_patch(platform, patch),
        Err(u) => u.envelope(),
    }
}

/// `patch` merged over the channel's current settings, saved by the daemon.
fn set_patch(platform: &str, patch: Map<String, Value>) -> serde_json::Value {
    if !PLATFORMS.contains(&platform) {
        return unknown_platform(platform);
    }
    let channels = match team_channels() {
        Ok(c) => c,
        Err(envelope) => return envelope,
    };
    save(platform, merged(channels.get(platform), patch))
}

/// Take a channel out: settings and stored credentials.
fn remove(platform: &str) -> serde_json::Value {
    if !PLATFORMS.contains(&platform) {
        return unknown_platform(platform);
    }
    let channels = match team_channels() {
        Ok(c) => c,
        Err(envelope) => return envelope,
    };
    if !channels.contains_key(platform) {
        return super::envelope::error_envelope(
            "not_configured",
            &format!("channel {platform} is not configured"),
            Some("amuxd channel ls"),
            5,
            false,
        );
    }
    let mut envelope = save(platform, Value::Null);
    if envelope["ok"] == true {
        envelope["data"] = json!({ "platform": platform, "removed": true });
    }
    envelope
}

/// One `channel-set` to the running daemon (`config: null` removes).
fn save(platform: &str, config: Value) -> serde_json::Value {
    use super::envelope::{error_envelope, success, unreachable};
    let line = json!({
        "cmd": "channel-set",
        "platform": platform,
        "config": config,
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
    fn bind_becomes_an_enabling_patch_without_unset_fields() {
        let (name, patch) = bind_patch(ChannelBindPlatform::Discord {
            bot_token: "t".into(),
            default_username: None,
        });
        assert_eq!(name, "discord");
        assert_eq!(
            serde_json::Value::Object(patch),
            json!({ "enabled": true, "bot_token": "t" })
        );
        let (_, patch) = bind_patch(ChannelBindPlatform::Seatalk {
            app_id: "a".into(),
            app_secret: "s".into(),
        });
        assert_eq!(patch["bots"][0]["app_id"], "a");
    }

    #[test]
    fn the_old_spellings_still_parse() {
        use clap::Parser;
        for (words, want) in [
            (&["amuxd", "channel", "list"][..], "ls"),
            (&["amuxd", "channel", "unbind", "kook"][..], "rm"),
        ] {
            let action = match crate::cli::Cli::try_parse_from(words).unwrap().command {
                crate::cli::Commands::Channel(args) => args.action,
                _ => unreachable!(),
            };
            let got = match action {
                ChannelAction::Ls => "ls",
                ChannelAction::Rm { .. } => "rm",
                _ => "other",
            };
            assert_eq!(got, want);
        }
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

/// Every channel with whether it is on and which credentials are stored.
fn list() -> serde_json::Value {
    let mut envelope = show(None);
    if envelope["ok"] != true {
        return envelope;
    }
    let rows: Vec<Value> = envelope["data"]["channels"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|c| {
            json!({
                "platform": c["platform"],
                "enabled": c["config"]["enabled"].as_bool().unwrap_or(false),
                "secretsSet": c["secretsSet"],
            })
        })
        .collect();
    envelope["data"] = json!({ "items": rows });
    envelope
}

/// Configured, enabled, and the stored credentials of one channel.
fn test_channel(platform: &str) -> serde_json::Value {
    let envelope = show(Some(platform));
    match envelope["error"]["code"].as_str() {
        Some("not_configured") => super::envelope::success(json!({
            "platform": platform, "configured": false, "enabled": false, "secretsSet": [],
        })),
        Some(_) => envelope,
        None => super::envelope::success(json!({
            "platform": platform,
            "configured": true,
            "enabled": envelope["data"]["config"]["enabled"].as_bool().unwrap_or(false),
            "secretsSet": envelope["data"]["secretsSet"],
        })),
    }
}

fn reload() -> serde_json::Value {
    let sock = DaemonConfig::sock_path();
    if !sock.exists() {
        return super::envelope::unreachable(format!("no socket at {}", sock.display()));
    }
    match crate::cli::process::send_control(&sock, "channel-reload") {
        Ok(_) => super::envelope::success(json!({ "reloading": true })),
        Err(e) => super::envelope::unreachable(e),
    }
}

/// The old per-platform `bind` flags as a `set` patch: the same fields the
/// typed bind used to write, enabled.
fn bind_patch(platform: ChannelBindPlatform) -> (&'static str, Map<String, Value>) {
    let (name, value) = match platform {
        ChannelBindPlatform::Discord {
            bot_token,
            default_username,
        } => (
            "discord",
            json!({ "bot_token": bot_token, "default_username": default_username }),
        ),
        ChannelBindPlatform::Wecom {
            bot_id,
            secret,
            encoding_aes_key,
        } => (
            "wecom",
            json!({ "bot_id": bot_id, "secret": secret, "encoding_aes_key": encoding_aes_key }),
        ),
        ChannelBindPlatform::Feishu { app_id, app_secret } => (
            "feishu",
            json!({ "app_id": app_id, "app_secret": app_secret }),
        ),
        ChannelBindPlatform::Kook { bot_token } => ("kook", json!({ "bot_token": bot_token })),
        ChannelBindPlatform::Wechat {
            ilink_account,
            ilink_token,
        } => (
            "wechat",
            json!({ "ilink_account": ilink_account, "ilink_token": ilink_token }),
        ),
        ChannelBindPlatform::Email {
            imap_host,
            imap_port,
            imap_user,
            imap_pass,
            smtp_host,
            smtp_port,
            smtp_user,
            smtp_pass,
        } => (
            "email",
            json!({
                "imap_host": imap_host, "imap_port": imap_port,
                "imap_user": imap_user, "imap_pass": imap_pass,
                "smtp_host": smtp_host, "smtp_port": smtp_port,
                "smtp_user": smtp_user, "smtp_pass": smtp_pass,
            }),
        ),
        ChannelBindPlatform::Seatalk { app_id, app_secret } => (
            "seatalk",
            json!({ "bots": [{ "enabled": true, "app_id": app_id, "app_secret": app_secret }] }),
        ),
    };
    let mut patch: Map<String, Value> = value
        .as_object()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, v)| !v.is_null())
        .collect();
    patch.insert("enabled".into(), json!(true));
    (name, patch)
}
