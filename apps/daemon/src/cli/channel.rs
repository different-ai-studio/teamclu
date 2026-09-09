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
    }
    Ok(())
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
        DiscordChannel, EmailChannel, FeishuChannel, KookChannel, SeaTalkChannel, WeChatChannel,
        WeComChannel,
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
            });
        }
        ChannelBindPlatform::Kook { bot_token } => {
            cfg.channels.kook = Some(KookChannel {
                enabled: true,
                bot_token,
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
            });
        }
        ChannelBindPlatform::Seatalk { app_id, app_secret } => {
            cfg.channels.seatalk = Some(SeaTalkChannel {
                enabled: true,
                app_id,
                app_secret,
                mode: "websocket".to_string(),
                dm_policy: "open".to_string(),
                allow_from: vec![],
                group_policy: "open".to_string(),
                group_allow_from: vec![],
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
