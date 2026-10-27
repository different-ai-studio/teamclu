use serde::{Deserialize, Serialize};

/// Personal WeChat through a self-hosted iPad-protocol server.
///
/// Separate from [`crate::wechat_config::WeChatConfig`] (iLink) on purpose:
/// the two share nothing on the wire. This one talks to an HTTP server the
/// operator runs next to the daemon — a closed-source container that holds a
/// logged-in WeChat account — and receives that server's pushes on a loopback
/// port. See `docs/features/wechatpad.md`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeChatPadConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Base URL of the protocol server, without `/api`.
    #[serde(default = "default_server_url")]
    pub server_url: String,
    /// Loopback port the server's callbacks (`WECHAT_CLIENT_HOST`) reach.
    #[serde(default = "default_callback_port")]
    pub callback_port: u16,
    /// wxid of the logged-in account. Its own messages come back as pushes and
    /// are dropped by this.
    #[serde(default)]
    pub account_wxid: String,
    /// When the account was last QR-logged in, unix seconds. Sending runs on a
    /// stricter policy for two days after — see [`crate::wechatpad::SendPlanner`].
    #[serde(default)]
    pub login_at: Option<i64>,
    /// `allowlist` (default) | `open`. Gateway sessions auto-approve tools, so
    /// a stranger who can DM the account must not reach the agent by default.
    #[serde(default = "default_dm_policy")]
    pub dm_policy: String,
    /// wxids allowed to talk to the agent — in DMs, and in groups.
    #[serde(default)]
    pub allow_from: Vec<String>,
    /// `allowlist` (default) | `open` | `disabled`.
    #[serde(default = "default_group_policy")]
    pub group_policy: String,
    /// `…@chatroom` ids where the agent answers. Empty with `allowlist` means
    /// every group, still limited to `allow_from` senders.
    #[serde(default)]
    pub group_allow_from: Vec<String>,
}

pub fn default_server_url() -> String {
    "http://127.0.0.1:3010".to_string()
}

pub fn default_callback_port() -> u16 {
    9101
}

fn default_dm_policy() -> String {
    "allowlist".to_string()
}

fn default_group_policy() -> String {
    "allowlist".to_string()
}

impl Default for WeChatPadConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            server_url: default_server_url(),
            callback_port: default_callback_port(),
            account_wxid: String::new(),
            login_at: None,
            dm_policy: default_dm_policy(),
            allow_from: Vec::new(),
            group_policy: default_group_policy(),
            group_allow_from: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum WeChatPadGatewayStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WeChatPadGatewayStatusResponse {
    pub status: WeChatPadGatewayStatus,
    pub error_message: Option<String>,
}
