/// Map a session binding URI to a `(channel, default_target)` pair. The
/// channel scheme determines the platform; the rest of the URI determines
/// the per-platform target shape used by `ChannelManager::dispatch_send`
/// (`user:<id>` or `chat:<id>`).
///
/// Binding shapes (from `crates/teamclu-gateway/src/binding.rs`):
///   wecom://{corp_id}/{agent_id}/single/{userid}
///   wecom://{corp_id}/{agent_id}/external-single/{ext_userid}
///   wecom://{corp_id}/{agent_id}/group/{chat_id}
///   feishu://{app_id}/{chat_id}
///   discord://{application_id}/{channel_id}
///   kook://{scope}/{channel_id}
///   wechat://{ilink_account}/single/{from_user_id}
///   email://{account_key}/thread/{thread_key}
///
/// Only WeCom defaults are wired today; other channels return
/// `Ok((channel, None))` so the agent can still send by providing an explicit
/// target override even before per-channel dispatch lands.
pub(crate) fn parse_binding_to_target(
    binding: &str,
) -> anyhow::Result<(&'static str, Option<String>)> {
    let (scheme, rest) = binding
        .split_once("://")
        .ok_or_else(|| anyhow::anyhow!("binding missing scheme: {binding}"))?;
    let parts: Vec<&str> = rest.split('/').collect();
    match scheme {
        "wecom" => {
            if parts.len() < 4 {
                anyhow::bail!("wecom binding malformed: {binding}");
            }
            let kind = parts[2];
            let id = parts[3];
            let target = match kind {
                "single" | "external-single" => format!("user:{id}"),
                "group" => format!("chat:{id}"),
                other => anyhow::bail!("unknown wecom binding kind: {other}"),
            };
            Ok(("wecom", Some(target)))
        }
        "feishu" => Ok(("feishu", None)),
        "discord" => Ok(("discord", None)),
        "kook" => Ok(("kook", None)),
        "wechat" => Ok(("wechat", None)),
        "email" => Ok(("email", None)),
        "cron" => Ok(("cron", None)),
        other => anyhow::bail!("unknown binding scheme: {other}"),
    }
}

/// Turn an mcp-send binding plus optional overrides into a dispatch route.
///
/// A `cron://` token authorizes the send but names no chat — the caller must
/// pass both `channel` and `target`. WeCom MCP targets (`single:` / `group:`)
/// are translated to the daemon shape (`user:` / `chat:`).
pub(crate) fn resolve_mcp_send_route(
    binding: &str,
    channel_override: Option<&str>,
    target_override: Option<&str>,
) -> anyhow::Result<(String, String)> {
    let (default_channel, default_target) = parse_binding_to_target(binding)?;
    let channel = channel_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(default_channel);

    if channel == "cron" {
        anyhow::bail!(
            "mcp-send: cron runs have no default chat — pass `channel` and `target` with the reply_token"
        );
    }

    let raw_target = match target_override.map(str::trim).filter(|s| !s.is_empty()) {
        Some(t) => t.to_string(),
        None => default_target.ok_or_else(|| {
            anyhow::anyhow!(
                "mcp-send: binding '{binding}' has no default target — pass an explicit 'target' override"
            )
        })?,
    };

    Ok((
        channel.to_string(),
        normalize_dispatch_target(channel, &raw_target),
    ))
}

/// Cron announce delivery stores WeCom as `single:<id>` / `group:<id>`
/// (the settings picker and `wecom_cron_target_to_dispatch`). Dispatch uses
/// `user:` / `chat:`. Pin the current chat at job-create time by mapping the
/// gateway binding onto that stored shape.
pub(crate) fn cron_delivery_target(binding: &str) -> anyhow::Result<(String, String)> {
    let (channel, dispatch) = parse_binding_to_target(binding)?;
    let to = match (channel, dispatch.as_deref()) {
        ("wecom", Some(t)) => wecom_dispatch_to_cron_to(t)?,
        ("cron", _) => anyhow::bail!(
            "this reply_token is a cron run, not a chat — pass single:<userid> or group:<chatid>"
        ),
        (_, Some(t)) => t.to_string(),
        (ch, None) => anyhow::bail!(
            "channel {ch} has no pin-able chat id; set delivery.to to an explicit target \
             (wecom: single:<userid> or group:<chatid>)"
        ),
    };
    Ok((channel.to_string(), to))
}

fn wecom_dispatch_to_cron_to(dispatch: &str) -> anyhow::Result<String> {
    if let Some(id) = dispatch.strip_prefix("user:") {
        if id.is_empty() {
            anyhow::bail!("wecom user id is empty");
        }
        return Ok(format!("single:{id}"));
    }
    if let Some(id) = dispatch.strip_prefix("chat:") {
        if id.is_empty() {
            anyhow::bail!("wecom chat id is empty");
        }
        return Ok(format!("group:{id}"));
    }
    anyhow::bail!("unexpected wecom dispatch target: {dispatch}");
}

fn normalize_dispatch_target(channel: &str, target: &str) -> String {
    let target = target.trim();
    if target.starts_with("user:") || target.starts_with("chat:") || target.starts_with("bot:") {
        return target.to_string();
    }
    if matches!(channel, "wecom" | "seatalk") {
        if let Some(id) = target.strip_prefix("single:") {
            return format!("user:{id}");
        }
        if let Some(id) = target.strip_prefix("group:") {
            return format!("chat:{id}");
        }
    }
    target.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wecom_single_maps_to_user_target() {
        let (channel, target) =
            parse_binding_to_target("wecom://corp/agent/single/user-1").unwrap();
        assert_eq!(channel, "wecom");
        assert_eq!(target.as_deref(), Some("user:user-1"));
    }

    #[test]
    fn wecom_external_single_maps_to_user_target() {
        let (channel, target) =
            parse_binding_to_target("wecom://corp/agent/external-single/ext-1").unwrap();
        assert_eq!(channel, "wecom");
        assert_eq!(target.as_deref(), Some("user:ext-1"));
    }

    #[test]
    fn wecom_group_maps_to_chat_target() {
        let (channel, target) = parse_binding_to_target("wecom://corp/agent/group/chat-1").unwrap();
        assert_eq!(channel, "wecom");
        assert_eq!(target.as_deref(), Some("chat:chat-1"));
    }

    #[test]
    fn non_wecom_binding_has_channel_but_no_default_target() {
        let (channel, target) = parse_binding_to_target("feishu://app/chat-1").unwrap();
        assert_eq!(channel, "feishu");
        assert!(target.is_none());
    }

    #[test]
    fn rejects_binding_without_scheme() {
        let err = parse_binding_to_target("not-a-binding").unwrap_err();
        assert!(err.to_string().contains("missing scheme"), "got: {err}");
    }

    #[test]
    fn rejects_malformed_wecom_binding() {
        let err = parse_binding_to_target("wecom://corp/agent/single").unwrap_err();
        assert!(err.to_string().contains("malformed"), "got: {err}");
    }

    #[test]
    fn rejects_unknown_wecom_kind() {
        let err = parse_binding_to_target("wecom://corp/agent/channel/id").unwrap_err();
        assert!(
            err.to_string().contains("unknown wecom binding kind"),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_unknown_scheme() {
        let err = parse_binding_to_target("slack://team/channel").unwrap_err();
        assert!(
            err.to_string().contains("unknown binding scheme"),
            "got: {err}"
        );
    }

    #[test]
    fn cron_binding_has_no_default_chat() {
        let (channel, target) = parse_binding_to_target("cron://job-key/run-1").unwrap();
        assert_eq!(channel, "cron");
        assert!(target.is_none());
    }

    #[test]
    fn cron_send_requires_explicit_channel_and_target() {
        let err = resolve_mcp_send_route("cron://job-key", None, Some("single:HuangWeiGan"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("no default chat"), "got: {err}");
    }

    #[test]
    fn cron_send_with_wecom_overrides_reaches_dispatch_shape() {
        let (channel, target) =
            resolve_mcp_send_route("cron://job-key", Some("wecom"), Some("single:HuangWeiGan"))
                .unwrap();
        assert_eq!(channel, "wecom");
        assert_eq!(target, "user:HuangWeiGan");
    }

    #[test]
    fn wecom_dm_binding_pins_cron_single_target() {
        let (channel, to) = cron_delivery_target("wecom://corp/agent/single/HuangWeiGan").unwrap();
        assert_eq!(channel, "wecom");
        assert_eq!(to, "single:HuangWeiGan");
    }

    #[test]
    fn wecom_group_binding_pins_cron_group_target() {
        let (channel, to) = cron_delivery_target("wecom://corp/agent/group/chat-1").unwrap();
        assert_eq!(channel, "wecom");
        assert_eq!(to, "group:chat-1");
    }

    #[test]
    fn cron_binding_cannot_be_a_delivery_target() {
        let err = cron_delivery_target("cron://job-key/run-1")
            .unwrap_err()
            .to_string();
        assert!(err.contains("cron run"), "got: {err}");
    }
}
