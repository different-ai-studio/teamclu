//! Where a channel's configuration lives, as far as this sidecar can tell.
//!
//! Two places, for historical reasons. Settings saves channels into the team's
//! gateway config, which amuxd owns and runs; that is the only place WeCom and
//! SeaTalk are read from. The workspace `teamclu.json` is what settings used to
//! write, and the direct senders in `send.rs` still read their credentials
//! there.
//!
//! Before this module the tools asked only the second, so a WeCom bot set up
//! in settings read as "not configured / bound" and a send was refused before
//! it reached the process that could have delivered it.

use serde_json::{json, Value};

/// Channels amuxd sends for. Their state and credentials are the daemon's;
/// nothing about them is in the workspace file.
pub const DAEMON_OWNED: &[&str] = &["wecom", "seatalk"];

pub fn is_daemon_owned(channel: &str) -> bool {
    DAEMON_OWNED.contains(&channel)
}

/// The channels configured and enabled in the team's gateway config.
///
/// Best effort: with the desktop app unreachable this is empty and callers
/// fall back to the workspace file, which is how they behaved before.
pub async fn daemon_configured(api_port: u16) -> Vec<String> {
    let Ok(v) = crate::desktop_api::post(api_port, "/channel-state", &json!({})).await else {
        return Vec::new();
    };
    names_from(&v)
}

fn names_from(response: &Value) -> Vec<String> {
    response
        .get("configured")
        .and_then(|c| c.as_array())
        .map(|names| {
            names
                .iter()
                .filter_map(|n| n.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `channel` can be reported as set up.
///
/// A daemon-owned channel counts when the gateway config has it; the others
/// when the workspace file holds their credentials, since that is what their
/// sender here will read.
pub fn is_bound(channel: &str, workspace_channels: &Value, daemon: &[String]) -> bool {
    if is_daemon_owned(channel) {
        return daemon.iter().any(|c| c == channel)
            || crate::capabilities::is_channel_bound_pub(channel, workspace_channels);
    }
    crate::capabilities::is_channel_bound_pub(channel, workspace_channels)
}

/// Why a direct send on `channel` cannot go ahead, for a channel whose
/// credentials are not in the workspace file.
pub fn unavailable_reason(channel: &str, daemon: &[String]) -> String {
    if daemon.iter().any(|c| c == channel) {
        // Configured in settings, but only the gateway holds its credentials
        // and it does not send on this channel outside a conversation yet.
        format!(
            "Channel '{channel}' is set up, but sending to it outside its own chat is not \
             supported yet. Only WeCom and SeaTalk can be sent to directly; on '{channel}', \
             reply inside the chat with that chat's 'reply_token'."
        )
    } else {
        format!("Channel '{channel}' is not configured.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_daemon_owned_channel_is_bound_by_the_gateway_config_alone() {
        let workspace = json!({});
        let daemon = vec!["wecom".to_string()];
        assert!(is_bound("wecom", &workspace, &daemon));
        assert!(!is_bound("seatalk", &workspace, &daemon));
    }

    #[test]
    fn other_channels_need_their_credentials_in_the_workspace_file() {
        let daemon = vec!["discord".to_string()];
        assert!(!is_bound("discord", &json!({}), &daemon));
        assert!(is_bound(
            "discord",
            &json!({ "discord": { "token": "t" } }),
            &[]
        ));
    }

    #[test]
    fn the_reason_tells_a_configured_channel_from_a_missing_one() {
        let daemon = vec!["feishu".to_string()];
        assert!(unavailable_reason("feishu", &daemon).contains("reply_token"));
        assert_eq!(
            unavailable_reason("kook", &daemon),
            "Channel 'kook' is not configured."
        );
    }

    #[test]
    fn an_unexpected_response_reads_as_nothing_configured() {
        assert!(names_from(&json!({ "ok": true })).is_empty());
        assert_eq!(
            names_from(&json!({ "configured": ["wecom", 3, "seatalk"] })),
            vec!["wecom", "seatalk"]
        );
    }
}
