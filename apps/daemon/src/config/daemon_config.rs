use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonConfig {
    /// Actor identity for this daemon. `id` is the actor_id (routing
    /// identity used in `amux/{team}/{actor}/...` topics); `name` is a
    /// human host/daemon label. Accepts the legacy `[device]` section via
    /// serde alias so existing `daemon.toml` files keep parsing.
    #[serde(rename = "actor", alias = "device")]
    pub actor: ActorConfig,
    pub mqtt: MqttConfig,
    /// Transport selector. Defaults to MQTT when omitted so existing
    /// `daemon.toml` files keep working unchanged. Set
    /// `[transport] kind = "nats"` + `url = "nats://..."` to use NATS.
    #[serde(default)]
    pub transport: Option<TransportConfig>,
    #[serde(default)]
    pub agents: AgentsConfig,
    /// Which `teams/<id>/` directory this daemon currently works out of.
    ///
    /// Serialized as `active_team`: it is a **pointer**, not an identity. The
    /// team's identity (`team_id` + `actor_id`) lives in that directory's
    /// `state/backend.toml` and only there; this field exists so the daemon
    /// knows which directory to look in. For a claimed daemon the pointer and
    /// `backend.toml`'s `team_id` carry the same UUID by construction — the
    /// file sits inside the directory the pointer names — and
    /// `DaemonServer::new` rejects the pair when they disagree, which can only
    /// mean a `backend.toml` was hand-copied into the wrong team directory.
    ///
    /// Kept as `team_id` in Rust because that is what it is to every reader;
    /// the on-disk name says what is different about it.
    #[serde(default, rename = "active_team", alias = "team_id")]
    pub team_id: Option<String>,
    /// Team-scoped; lives in `teams/<id>/state/team.toml` and is hydrated from
    /// there (`config::team_config::hydrate`). Never serialized here — a
    /// `[channels]` section in daemon.toml is simply ignored.
    #[serde(skip)]
    pub channels: ChannelsConfig,
    /// Detach an Attachment whose `last_active_at` is older than this many
    /// seconds. `None` means the built-in default, not "disabled" — see
    /// [`Self::idle_timeout_secs`]. Manual stops via the RuntimeStop RPC are
    /// unaffected. Very short values will kill mid-stream replies that exceed
    /// the threshold.
    #[serde(default)]
    pub idle_runtime_timeout_secs: Option<u64>,
    /// Hard ceiling on concurrent Attachments; the least recently used is
    /// detached to make room. `None` means the built-in default — see
    /// [`Self::max_attachments`].
    #[serde(default)]
    pub max_attachments: Option<usize>,
    /// Browser-facing HTTP/SSE API, bound alongside the Unix control socket.
    ///
    /// Omitting the section does **not** disable the listener — the daemon
    /// falls back to `HttpConfig::default()` (loopback, ephemeral port). The
    /// section only exists to override those defaults. The listener is how the
    /// setup UI is served, so an unconfigured daemon needs it most.
    #[serde(default)]
    pub http: Option<HttpConfig>,
    /// Local control over automatic team-share sync (git/OSS). Cloud `share_mode`
    /// is unchanged; this only gates timer / workspace-registration / runtime
    /// triggers on this daemon. Manual sync via `POST /v1/team/sync` with
    /// `forceSync: true` still runs.
    /// Team-scoped; lives in team.toml, hydrated like `channels`.
    #[serde(skip)]
    pub team_share: TeamShareConfig,
    /// `logs/amuxd.log` rotation. Consumed by a probe in `crate::logging`
    /// before the full config loads; declared here so `save()` round-trips a
    /// hand-added `[log]` section instead of silently erasing it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log: Option<LogConfig>,
    /// Language the gateways reply in (`"zh-CN"`, `"en"`), mirroring the desktop
    /// app's UI language. Device-scoped on purpose: language is one app-level
    /// preference, not a per-team or per-workspace one, so it belongs in
    /// daemon.toml rather than team.toml. `None` means English.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// App URL scheme for this deployment (e.g. `teamclu`, `acme`). Captured
    /// from the onboarding invite and fed to workspace-scoped MCP tools as
    /// `TEAMCLU_APP_SCHEME` so branded builds emit deeplinks with their own
    /// scheme instead of the default `teamclu://`. `None` on legacy/pre-fix
    /// `daemon.toml` — the MCP tool then falls back to `teamclu`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_scheme: Option<String>,
}

/// `[log]` — caps for the daemon's own rotating log file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogConfig {
    /// Rotate `amuxd.log` when a write would cross this. Default 32 MiB.
    #[serde(default)]
    pub max_bytes: Option<u64>,
    /// Rotated files kept beside the active one. Default 2.
    #[serde(default)]
    pub keep: Option<u32>,
}

/// Per-daemon team-share behavior. Distinct from the cloud team's `share_mode`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamShareConfig {
    /// When `false`, skip automatic git/OSS sync (300s timer, workspace add,
    /// runtime start). Defaults to `true` so existing installs keep syncing.
    #[serde(default = "default_team_share_auto_sync")]
    pub auto_sync: bool,
}

fn default_team_share_auto_sync() -> bool {
    true
}

impl Default for TeamShareConfig {
    fn default() -> Self {
        Self {
            auto_sync: default_team_share_auto_sync(),
        }
    }
}

/// Configuration for the browser-facing HTTP+SSE listener. Defaults are tuned
/// for "localhost browser connecting to a single user's daemon"; cross-host
/// deployments must set `bind` + a TLS terminator in front.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpConfig {
    /// Socket address to bind. Use `127.0.0.1:0` (default) to pick an
    /// ephemeral loopback port — the actual port is written to
    /// `<config_dir>/amuxd.http.port` so clients can discover it.
    #[serde(default = "default_http_bind")]
    pub bind: String,
    /// Origins allowed by the CORS layer. `*` is rejected; supply
    /// concrete origins like `http://localhost:5173`. Empty list disables
    /// CORS (same-origin only).
    #[serde(default = "default_allowed_origins")]
    pub allowed_origins: Vec<String>,
    /// Idle session TTL. Sessions with no activity for this long are
    /// closed and removed from the registry.
    #[serde(default = "default_session_idle_ttl", with = "humantime_serde")]
    pub session_idle_ttl: std::time::Duration,
    /// SSE comment-frame heartbeat interval.
    #[serde(default = "default_heartbeat_interval", with = "humantime_serde")]
    pub heartbeat_interval: std::time::Duration,
    /// Max sessions a single session-token may own concurrently.
    #[serde(default = "default_max_sessions_per_token")]
    pub max_sessions_per_token: u32,
    /// Per-session event ring buffer size. Drives `Last-Event-ID` replay
    /// window — events beyond this point return `410 Gone`.
    #[serde(default = "default_max_event_backlog")]
    pub max_event_backlog: usize,
    /// Per-token request rate (sustained req/sec). Bursts allowed up to
    /// `rate_limit_burst`.
    #[serde(default = "default_rate_limit_rps")]
    pub rate_limit_rps: u32,
    #[serde(default = "default_rate_limit_burst")]
    pub rate_limit_burst: u32,
    /// Max concurrent SSE streams per token.
    #[serde(default = "default_max_sse_per_token")]
    pub max_sse_per_token: u32,
    /// Hard cap on POST body size in bytes (applies to /prompt etc.).
    #[serde(default = "default_max_body_bytes")]
    pub max_body_bytes: usize,
    /// Root-token file. Mode 0600. Auto-generated if missing on startup.
    #[serde(default)]
    pub token_file: Option<PathBuf>,
    /// File that receives the actually-bound port (useful when `bind`
    /// uses port 0). Defaults to `<config_dir>/amuxd.http.port`.
    #[serde(default)]
    pub port_file: Option<PathBuf>,
    /// Default scopes granted to session tokens minted via
    /// `POST /v1/auth/exchange` when the caller does not pass `scopes`.
    #[serde(default = "default_scopes")]
    pub default_scopes: Vec<String>,
}

fn default_allowed_origins() -> Vec<String> {
    // TeamClu desktop (Tauri devUrl + packaged WebView2 origins) and Vite dev.
    vec![
        "http://127.0.0.1:1420".into(),
        "http://localhost:1420".into(),
        "http://127.0.0.1:5173".into(),
        "http://localhost:5173".into(),
        "tauri://localhost".into(),
        "https://tauri.localhost".into(),
        // WebView2 may emit http (not https) for the tauri.localhost scheme.
        "http://tauri.localhost".into(),
        // Tauri 2 asset protocol fallback seen on some Windows builds.
        "https://asset.localhost".into(),
    ]
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            bind: default_http_bind(),
            allowed_origins: default_allowed_origins(),
            session_idle_ttl: default_session_idle_ttl(),
            heartbeat_interval: default_heartbeat_interval(),
            max_sessions_per_token: default_max_sessions_per_token(),
            max_event_backlog: default_max_event_backlog(),
            rate_limit_rps: default_rate_limit_rps(),
            rate_limit_burst: default_rate_limit_burst(),
            max_sse_per_token: default_max_sse_per_token(),
            max_body_bytes: default_max_body_bytes(),
            token_file: None,
            port_file: None,
            default_scopes: default_scopes(),
        }
    }
}

fn default_http_bind() -> String {
    "127.0.0.1:0".into()
}
fn default_session_idle_ttl() -> std::time::Duration {
    std::time::Duration::from_secs(30 * 60)
}
fn default_heartbeat_interval() -> std::time::Duration {
    std::time::Duration::from_secs(15)
}
fn default_max_sessions_per_token() -> u32 {
    32
}
fn default_max_event_backlog() -> usize {
    1024
}
fn default_rate_limit_rps() -> u32 {
    20
}
fn default_rate_limit_burst() -> u32 {
    60
}
fn default_max_sse_per_token() -> u32 {
    8
}
fn default_max_body_bytes() -> usize {
    1024 * 1024
}
fn default_scopes() -> Vec<String> {
    // Least privilege: a token minted without an explicit `scopes` list can read
    // sessions/events/workspace config but must request `workspace:write`
    // explicitly to mutate provider/permission/MCP/skill/role state. The desktop
    // client always requests the scopes it needs, so this only narrows the
    // implicit fallback grant.
    vec![
        "sessions:read".into(),
        "sessions:write".into(),
        "events:read".into(),
        "workspace:read".into(),
    ]
}

/// Placeholder `actor.name` written by [`DaemonConfig::bootstrap`].
///
/// Onboarding replaces it with the cloud display name (see
/// `daemon_config_for_invite`). A name that is *not* this sentinel was chosen
/// by the operator and is preserved across re-onboarding.
pub const BOOTSTRAP_ACTOR_NAME: &str = "amuxd (unclaimed)";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActorConfig {
    /// Actor id — the routing identity for this daemon. Used in topic
    /// paths `amux/{team}/{actor}/...`.
    ///
    /// **In-memory only.** On disk this value has exactly one owner:
    /// `teams/<id>/state/backend.toml` (`[cloud_api] actor_id`). It used to be
    /// persisted here too — onboarding wrote both files in one pass and nothing
    /// ever re-checked them, so a drift silently authenticated as one actor
    /// while publishing under another's topics. `DaemonServer::new` now
    /// hydrates this field from the backend config; an unclaimed daemon gets a
    /// per-boot placeholder, which is safe because an unclaimed daemon never
    /// connects MQTT (empty broker + placeholder client).
    ///
    /// Still *deserialized* if present so old fixtures parse; never serialized.
    #[serde(default, skip_serializing)]
    pub id: String,
    /// Human-friendly host/daemon label (e.g. machine name).
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttConfig {
    pub broker_url: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

/// Top-level transport switch. When present and `kind = "nats"`, the
/// daemon connects to `url` instead of `mqtt.broker_url`. URL scheme
/// (`nats://`, `tls://`, `ws://`, `wss://`) is forwarded verbatim to
/// async-nats.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransportConfig {
    #[serde(default = "default_transport_kind")]
    pub kind: TransportKind,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportKind {
    Mqtt,
    Nats,
}

fn default_transport_kind() -> TransportKind {
    TransportKind::Mqtt
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentsConfig {
    /// When true (default), amuxd probes the host for agent binaries on start
    /// and writes missing `[agents.*]` sections to `daemon.toml`.
    #[serde(default = "default_true")]
    pub auto_discover: bool,
    /// Local agent runtime backing this daemon: "opencode" (default), "pi",
    /// "cursor", "claude-code", or "codex". Seeded from the desktop build config's
    /// `localAgent` during onboarding. See `daemon::runtime_resolution::
    /// configured_local_agent` for how this name is resolved to a runnable
    /// backend — claude-code/codex additionally require their `[agents.*]`
    /// config section to be present; an unrunnable selection resolves to
    /// `AgentType::Unknown` rather than silently falling back to opencode.
    /// Team-scoped (the team decides which runtime its agents run), so it
    /// lives in `teams/<id>/state/team.toml` and is hydrated from there.
    /// Never read from or written to daemon.toml.
    #[serde(skip, default = "default_local_agent")]
    pub local_agent: String,
    #[serde(default)]
    pub claude_code: Option<AgentBackendConfig>,
    #[serde(default)]
    pub opencode: Option<AgentBackendConfig>,
    #[serde(default)]
    pub codex: Option<AgentBackendConfig>,
    #[serde(default)]
    pub cursor: Option<CursorAgentConfig>,
    #[serde(default)]
    pub claude: Option<ClaudeAgentConfig>,
    #[serde(default)]
    pub pi: Option<PiAgentConfig>,
}

/// pi backend settings (`agents.local_agent = "pi"`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PiAgentConfig {
    /// Explicit pi binary path. Unset ⇒ discovery (`~/.pi/bin/pi`, then PATH /
    /// well-known dirs). See `runtime::pi_rpc::process::resolve_binary`.
    #[serde(default)]
    pub binary: Option<String>,
    /// Session process mode: `"host"` (default — one Node host per worktree
    /// running N concurrent `AgentSession`s over the pi SDK) or `"rpc"`
    /// (legacy single-session `pi --mode rpc`, one active session per
    /// worktree, prompts for other sessions must wait). The rollback switch
    /// for the multi-session host: set `"rpc"` to get the pre-host behavior
    /// back without a daemon downgrade.
    #[serde(default)]
    pub session_host: Option<String>,
}

/// Cursor SDK backend settings (`agents.local_agent = "cursor"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeAgentConfig {
    // The Anthropic API key used to live here. It is a *personal* credential,
    // so it moved to the personal secret store (`~/.{brand}/secrets`, key
    // `ANTHROPIC_API_KEY`); the pool loader resolves it from there. With
    // neither set, the Agent SDK falls back to the host's own `claude` login.
    /// Sidecar launch command (default: `node …/claude-bridge/src/main.mjs --mode rpc`).
    #[serde(default)]
    pub bridge_command: Option<Vec<String>>,
    /// Preferred model (SDK id, e.g. `claude-opus-5`). Empty = SDK default.
    #[serde(default)]
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CursorAgentConfig {
    // The Cursor API key used to live here. Personal credential → personal
    // secret store (key `CURSOR_API_KEY`); the `CURSOR_API_KEY` env var still
    // wins at spawn.
    /// Sidecar launch command (default: `node …/cursor-bridge/src/main.mjs --mode rpc`).
    #[serde(default)]
    pub bridge_command: Option<Vec<String>>,
    /// SDK model id (not the flat `cursor/…` id). Default: `composer-2.5`.
    #[serde(default = "default_cursor_model")]
    pub default_model: Option<String>,
}

fn default_cursor_model() -> Option<String> {
    Some("composer-2.5".to_string())
}

fn default_local_agent() -> String {
    "opencode".to_string()
}

impl Default for AgentsConfig {
    fn default() -> Self {
        Self {
            auto_discover: true,
            local_agent: default_local_agent(),
            claude_code: None,
            opencode: None,
            codex: None,
            cursor: None,
            claude: None,
            pi: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBackendConfig {
    #[serde(default = "default_claude_binary")]
    pub binary: String,
    #[serde(default)]
    pub default_flags: Vec<String>,
}

fn default_claude_binary() -> String {
    "claude".into()
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ChannelsConfig {
    /// Model every gateway session starts on, as a `provider/model` ref.
    ///
    /// Gateway-level rather than per-platform: the platforms differ in how a
    /// message arrives, not in what should answer it, and a per-platform field
    /// would be seven settings to keep in sync for one decision.
    ///
    /// Before this existed a gateway session started **unpinned** — the backend
    /// picked, and attach-time resolution fell back to the device MRU, so the
    /// same chat answered on a different model depending on which directory the
    /// daemon happened to spawn in. ADR-0007 removes that MRU, so the choice has
    /// to be stated somewhere; this is where.
    ///
    /// `None` keeps the old unpinned behaviour, which is what an existing
    /// team.toml deserializes to — the setting is additive, not a hard cutover.
    /// A chat's own `/model` still wins for that session.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub discord: Option<DiscordChannel>,
    #[serde(default)]
    pub wecom: Option<WeComChannel>,
    #[serde(default)]
    pub feishu: Option<FeishuChannel>,
    #[serde(default)]
    pub kook: Option<KookChannel>,
    #[serde(default)]
    pub wechat: Option<WeChatChannel>,
    #[serde(default)]
    pub email: Option<EmailChannel>,
    #[serde(default)]
    pub seatalk: Option<SeaTalkChannel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordChannel {
    pub enabled: bool,
    /// Stored in the team secret store, not in team.toml (absent = unset).
    #[serde(default)]
    pub bot_token: String,
    #[serde(default)]
    pub default_username: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComBot {
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub bot_id: String,
    /// Stored in the team secret store, not in team.toml (absent = unset).
    #[serde(default)]
    pub secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding_aes_key: Option<String>,
    /// Workspace this bot's sessions run in (resolved against workspaces.toml).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Backend: "claude-code" | "opencode" | "codex". None -> daemon default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// Per-bot system prompt injected into the first turn + CLAUDE.local.md.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// The bot's MCP api key, from WeCom's 「消息」能力授权页.
    ///
    /// Optional and read-only in practice: it is what lets the desktop list the
    /// chats this bot is in (the long connection cannot), so a cron job can pick
    /// a target instead of having a chat id typed in by hand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// The bot's display name in WeCom (`Matt chow的机器人 1`).
    ///
    /// Group messages arrive as `@<name> 正文` with the mention only in the
    /// text, so this is what lets the gateway take it back off cleanly. Absent
    /// is fine — commands still work through a narrower fallback — but the
    /// leftover name then rides along in the prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComChannel {
    pub enabled: bool,
    // ----- legacy single-bot fields (kept for back-compat) -----
    #[serde(default)]
    pub bot_id: String,
    #[serde(default)]
    pub secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding_aes_key: Option<String>,
    // ----- new multi-bot list -----
    #[serde(default)]
    pub bots: Vec<WeComBot>,
}

impl WeComChannel {
    /// Normalize to a flat bot list: prefer the explicit `bots` array; if it
    /// is empty, synthesize a single bot from the legacy top-level fields.
    pub fn resolved_bots(&self) -> Vec<WeComBot> {
        if !self.bots.is_empty() {
            return self.bots.clone();
        }
        if self.bot_id.is_empty() {
            return vec![];
        }
        vec![WeComBot {
            enabled: true,
            bot_id: self.bot_id.clone(),
            secret: self.secret.clone(),
            encoding_aes_key: self.encoding_aes_key.clone(),
            workspace_id: None,
            agent_type: None,
            system_prompt: None,
            bot_name: None,
            api_key: None,
        }]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeishuChannel {
    pub enabled: bool,
    pub app_id: String,
    /// Stored in the team secret store, not in team.toml (absent = unset).
    #[serde(default)]
    pub app_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KookChannel {
    pub enabled: bool,
    /// Stored in the team secret store, not in team.toml (absent = unset).
    #[serde(default)]
    pub bot_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeChatChannel {
    pub enabled: bool,
    pub ilink_account: String,
    /// Stored in the team secret store, not in team.toml (absent = unset).
    #[serde(default)]
    pub ilink_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeaTalkChannel {
    pub enabled: bool,
    pub app_id: String,
    /// Stored in the team secret store, not in team.toml (absent = unset).
    #[serde(default)]
    pub app_secret: String,
    /// `websocket` (default) or `webhook`
    #[serde(default = "default_seatalk_mode")]
    pub mode: String,
    /// `open` | `allowlist`
    #[serde(default = "default_seatalk_dm_policy")]
    pub dm_policy: String,
    #[serde(default)]
    pub allow_from: Vec<String>,
    /// `disabled` | `allowlist` | `open`
    #[serde(default = "default_seatalk_group_policy")]
    pub group_policy: String,
    #[serde(default)]
    pub group_allow_from: Vec<String>,
}

fn default_seatalk_mode() -> String {
    "websocket".to_string()
}

fn default_seatalk_dm_policy() -> String {
    "open".to_string()
}

fn default_seatalk_group_policy() -> String {
    "open".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailChannel {
    pub enabled: bool,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_user: String,
    /// Stored in the team secret store, not in team.toml (absent = unset).
    #[serde(default)]
    pub imap_pass: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    /// Stored in the team secret store, not in team.toml (absent = unset).
    #[serde(default)]
    pub smtp_pass: String,
    #[serde(default)]
    pub allowed_senders: Vec<String>,
}

/// How long an idle Attachment stays warm. Not a tuning knob: it defines the
/// shelf life of the "ready, answers immediately" state a user can feel, and it
/// is half of what keeps `ActorPresence.live_sessions` bounded (ADR-0004).
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 30 * 60;

/// Ceiling on concurrent Attachments. The idle timeout alone bounds the set
/// only by user behaviour — how many sessions someone can open inside 30
/// minutes — so a hard cap backs it up. Each attachment holds an opencode
/// session and an event channel, which is the real resource being protected.
pub const DEFAULT_MAX_ATTACHMENTS: usize = 16;

impl DaemonConfig {
    /// Idle detach threshold, defaulted.
    ///
    /// Historically `None` disabled eviction outright, which meant an
    /// attachment lived until the daemon restarted and `live_sessions` grew
    /// with every session ever opened. Defaulting rather than disabling is what
    /// makes the bound real.
    pub fn idle_timeout_secs(&self) -> u64 {
        self.idle_runtime_timeout_secs
            .unwrap_or(DEFAULT_IDLE_TIMEOUT_SECS)
    }

    /// Concurrent-attachment ceiling, defaulted.
    pub fn max_attachments(&self) -> usize {
        self.max_attachments
            .unwrap_or(DEFAULT_MAX_ATTACHMENTS)
            .max(1)
    }

    /// Whether this daemon should run automatic team-share sync. Defaults to
    /// `true` when `daemon.toml` is missing or unparsable for this field.
    pub fn team_share_auto_sync_enabled(&self) -> bool {
        self.team_share.auto_sync
    }

    /// Read [`TeamShareConfig::auto_sync`] from the active team's team.toml.
    ///
    /// A two-field probe on purpose: this runs on the 300s sync timer, every
    /// runtime spawn and every workspace registration, and the full typed load
    /// would decrypt the whole secret store to answer one non-secret boolean.
    pub fn team_share_auto_sync_enabled_from_disk() -> bool {
        #[derive(Default, serde::Deserialize)]
        struct Probe {
            #[serde(default)]
            team_share: TeamShareConfig,
        }
        std::fs::read_to_string(super::team_config::active_path())
            .ok()
            .and_then(|body| toml::from_str::<Probe>(&body).ok())
            .unwrap_or_default()
            .team_share
            .auto_sync
    }
}

impl DaemonConfig {
    /// Local amuxd state directory.
    ///
    /// Official brands: `~/.amuxd`. White-label: `~/.amuxd-<brand>`.
    /// Override with `AMUXD_HOME`, or derive from `TEAMCLU_BRAND_SHORT_NAME`.
    pub fn config_dir() -> PathBuf {
        teamclu_runtime_env::amuxd_home_from_env()
    }

    /// Just a path now.
    ///
    /// This used to run `migrate_legacy_file`, which copied
    /// `<config_dir>/amux/daemon.toml` back over a missing one — on essentially
    /// every daemon entry point, `amuxd init` included. That is why clearing a
    /// team looped: `clear` deleted the file and the next command resurrected
    /// it, stale `team_id` and all. ADR-0006 drops the legacy directory instead
    /// of deleting it in two places forever.
    pub fn default_path() -> PathBuf {
        Self::config_dir().join("daemon.toml")
    }

    /// [`load`](Self::load) + team hydration, for entry points that go on to
    /// *use or persist* the team half. Loading without hydrating and then
    /// persisting is how a CLI arm wipes a team's channels; making hydration
    /// part of the load is what keeps that unrepresentable.
    pub fn load_hydrated(path: &Path) -> crate::error::Result<Self> {
        let mut config = Self::load(path)?;
        super::team_config::hydrate(&mut config)
            .map_err(|e| crate::error::AmuxError::Config(format!("team.toml: {e}")))?;
        Ok(config)
    }

    pub fn load(path: &Path) -> crate::error::Result<Self> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            crate::error::AmuxError::Config(format!("read {}: {}", path.display(), e))
        })?;
        toml::from_str(&content).map_err(|e| {
            crate::error::AmuxError::Config(format!("parse {}: {}", path.display(), e))
        })
    }

    /// A config for a daemon that has not been onboarded yet.
    ///
    /// `broker_url` is deliberately empty: the daemon resolves the broker from
    /// `/v1/config/bootstrap` once it has credentials, and runs MQTT on a
    /// placeholder client until then. `actor.id` is a locally-minted
    /// placeholder that lives only in memory (the field is never serialized):
    /// a placeholder identity that rotates per boot costs nothing, because an
    /// unclaimed daemon never connects MQTT. The real actor_id arrives with
    /// onboarding, in `backend.toml`, and is hydrated from there.
    pub fn bootstrap() -> Self {
        Self {
            actor: ActorConfig {
                id: uuid::Uuid::new_v4().to_string(),
                name: BOOTSTRAP_ACTOR_NAME.to_string(),
            },
            mqtt: MqttConfig {
                broker_url: String::new(),
                username: None,
                password: None,
            },
            transport: None,
            agents: AgentsConfig::default(),
            team_id: None,
            channels: Default::default(),
            idle_runtime_timeout_secs: None,
            max_attachments: None,
            // Present so the packaged desktop WebView's fetch() can reach the
            // loopback control plane without a hand edit.
            http: Some(HttpConfig::default()),
            team_share: TeamShareConfig::default(),
            log: None,
            locale: None,
            app_scheme: None,
        }
    }

    /// Load `path`, or synthesize and persist a [`bootstrap`](Self::bootstrap)
    /// config when it does not exist.
    ///
    /// An existing-but-unparseable config still errors — only true absence
    /// bootstraps.
    pub fn load_or_bootstrap(path: &Path) -> crate::error::Result<Self> {
        if path.exists() {
            return Self::load(path);
        }
        let config = Self::bootstrap();
        config.save(path)?;
        tracing::info!(
            path = %path.display(),
            "no daemon.toml — wrote a fresh unconfigured one"
        );
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> crate::error::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| crate::error::AmuxError::Config(e.to_string()))?;
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn pid_path() -> PathBuf {
        super::layout::run_dir().join("amuxd.pid")
    }

    pub fn lock_path() -> PathBuf {
        super::layout::run_dir().join("amuxd.lock")
    }

    /// Control endpoint: a Unix socket path on unix, a named-pipe name on
    /// Windows.
    ///
    /// Derived in `teamclu_runtime_env::amuxd_layout` rather than here, because
    /// the desktop has to compute the identical string to connect (#1049) and
    /// two derivations cannot be kept honest by comment alone.
    pub fn sock_path() -> PathBuf {
        super::layout::control_endpoint()
    }

    pub fn http_token_path() -> PathBuf {
        super::layout::run_dir().join("amuxd.http.token")
    }

    /// File the daemon keeps refreshed with the current cloud access token
    /// (JWT), written `0600`. Injected into agent processes as
    /// `TC_ACCESS_TOKEN_FILE` so long-running agents can re-read a fresh token.
    ///
    /// Refreshed from the active team's `backend.toml` and only valid for that
    /// team, so it sits beside it.
    pub fn cloud_token_path() -> PathBuf {
        super::layout::active_state_dir().join("cloud-token")
    }

    pub fn http_port_path() -> PathBuf {
        super::layout::run_dir().join("amuxd.http.port")
    }

    /// Process-group id of the managed `opencode serve` tree (Unix). Written
    /// while serve is live so `amuxd stop` can reap the group even if the
    /// daemon was hard-killed mid-shutdown.
    pub fn opencode_serve_pgid_path() -> PathBuf {
        super::layout::run_dir().join("opencode.serve.pgid")
    }
}

#[cfg(test)]
mod channels_tests {
    use super::*;

    #[test]
    fn agents_pi_section_parses_and_defaults_to_host() {
        // `[agents.pi] session_host = "rpc"` is the multi-session host's
        // rollback switch; it must survive a daemon.toml round trip.
        let toml_src = r#"
[actor]
id = "d1"
name = "Mac"

[mqtt]
broker_url = "tcp://localhost:1883"

[agents.pi]
binary = "/opt/custom/pi"
session_host = "rpc"
"#;
        let cfg: DaemonConfig = toml::from_str(toml_src).unwrap();
        let pi = cfg.agents.pi.as_ref().expect("[agents.pi] parsed");
        assert_eq!(pi.binary.as_deref(), Some("/opt/custom/pi"));
        assert_eq!(pi.session_host.as_deref(), Some("rpc"));

        // Absent section ⇒ host mode by default (pi: None, and the pool's
        // preference reader treats anything but "rpc" as host).
        let bare: DaemonConfig = toml::from_str(
            "[actor]\nid = \"d\"\nname = \"m\"\n[mqtt]\nbroker_url = \"tcp://x:1883\"\n",
        )
        .unwrap();
        assert!(bare.agents.pi.is_none());
    }

    #[test]
    fn channels_roundtrip_wecom() {
        // `[channels]` moved to team.toml (config::team_config); daemon.toml
        // must now *ignore* the section instead of owning it.
        let toml_src = r#"
[actor]
id = "d1"
name = "Mac"

[mqtt]
broker_url = "tcp://localhost:1883"

[agents.opencode]
binary = "opencode"
default_flags = ["acp"]

[channels.wecom]
enabled = true
bot_id = "b1"
secret = "s"
encoding_aes_key = "k"
"#;
        let team: crate::config::team_config::TeamFileConfig = toml::from_str(
            "[channels.wecom]\nenabled = true\nbot_id = \"b1\"\nsecret = \"s\"\nencoding_aes_key = \"k\"\n",
        )
        .unwrap();
        assert_eq!(team.channels.wecom.as_ref().unwrap().bot_id, "b1");

        let cfg: DaemonConfig = toml::from_str(toml_src).unwrap();
        assert!(
            cfg.channels.wecom.is_none(),
            "daemon.toml's [channels] must be ignored, not adopted"
        );
        assert_eq!(
            cfg.agents
                .opencode
                .as_ref()
                .map(|c| (c.binary.clone(), c.default_flags.clone())),
            Some(("opencode".to_string(), vec!["acp".to_string()]))
        );
    }

    // These parse `WeComChannel` directly rather than a full `DaemonConfig`
    // (which requires a top-level `actor`/`device` section). The TOML body is
    // therefore rooted at the `[channels.wecom]` table, so the bots array is
    // `[[bots]]` here.
    #[test]
    fn wecom_parses_multi_bot_array() {
        let toml = r#"
enabled = true

[[bots]]
bot_id = "botA"
secret = "secretA"
workspace_id = "ws111111"
agent_type = "opencode"
system_prompt = "You are A."

[[bots]]
bot_id = "botB"
secret = "secretB"
"#;
        let wecom: WeComChannel = toml::from_str(toml).unwrap();
        let bots = wecom.resolved_bots();
        assert_eq!(bots.len(), 2);
        assert_eq!(bots[0].bot_id, "botA");
        assert_eq!(bots[0].workspace_id.as_deref(), Some("ws111111"));
        assert_eq!(bots[0].agent_type.as_deref(), Some("opencode"));
        assert_eq!(bots[0].system_prompt.as_deref(), Some("You are A."));
        assert!(bots[1].enabled, "bot enabled defaults to true");
        assert_eq!(bots[1].workspace_id, None);
    }

    #[test]
    fn wecom_legacy_single_bot_is_synthesized_into_one_bot() {
        let toml = r#"
enabled = true
bot_id = "legacy"
secret = "legacysecret"
encoding_aes_key = "k"
"#;
        let wecom: WeComChannel = toml::from_str(toml).unwrap();
        let bots = wecom.resolved_bots();
        assert_eq!(bots.len(), 1);
        assert_eq!(bots[0].bot_id, "legacy");
        assert_eq!(bots[0].secret, "legacysecret");
        assert_eq!(bots[0].encoding_aes_key.as_deref(), Some("k"));
    }

    #[test]
    fn wecom_empty_yields_no_bots() {
        let wecom: WeComChannel = toml::from_str("enabled = false\n").unwrap();
        assert!(wecom.resolved_bots().is_empty());
    }

    #[test]
    fn legacy_device_section_still_parses_via_alias() {
        let toml_src = r#"
[device]
id = "legacy-actor"
name = "Old Mac"

[mqtt]
broker_url = "tcp://localhost:1883"
"#;
        let cfg: DaemonConfig = toml::from_str(toml_src).unwrap();
        assert_eq!(cfg.actor.id, "legacy-actor");
        assert_eq!(cfg.actor.name, "Old Mac");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_section_without_allowed_origins_uses_desktop_defaults() {
        let cfg: HttpConfig = toml::from_str("[http]\nbind = \"127.0.0.1:0\"\n").unwrap();
        assert!(cfg
            .allowed_origins
            .iter()
            .any(|o| o == "http://tauri.localhost"));
        assert!(cfg
            .allowed_origins
            .iter()
            .any(|o| o == "https://tauri.localhost"));
    }

    #[test]
    fn bootstrap_is_unconfigured_but_serves_http() {
        let cfg = DaemonConfig::bootstrap();
        // Empty broker keeps MQTT on a placeholder client; the HTTP listener is
        // what serves the setup UI, so it must be configured.
        assert!(cfg.mqtt.broker_url.is_empty());
        assert!(cfg.team_id.is_none());
        assert!(cfg.http.is_some());
        assert!(!cfg.actor.id.is_empty());
    }

    /// The identity has one owner on disk (`backend.toml`), so `daemon.toml`
    /// must never grow an `actor.id` back — that is the duplicate that used to
    /// let auth and MQTT routing disagree. The file key is `active_team`, not
    /// `team_id`: a pointer to a directory, not an identity.
    #[test]
    fn save_persists_the_pointer_but_never_the_actor_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");

        let mut cfg = DaemonConfig::bootstrap();
        cfg.team_id = Some("team-1".to_string());
        cfg.save(&path).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            !written.contains("id ="),
            "actor.id must not be persisted; daemon.toml:\n{written}"
        );
        assert!(written.contains("active_team = \"team-1\""), "{written}");

        let loaded = DaemonConfig::load(&path).unwrap();
        assert_eq!(loaded.team_id.as_deref(), Some("team-1"));
        assert!(
            loaded.actor.id.is_empty(),
            "a loaded config carries no identity until the backend hydrates it"
        );
    }

    /// The gateway reply language is device-scoped, so it round-trips through
    /// daemon.toml — not team.toml, and not a workspace's teamclu.json, which is
    /// where it used to live and where no gateway ever looked.
    #[test]
    fn locale_round_trips_through_daemon_toml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");

        let mut cfg = DaemonConfig::bootstrap();
        cfg.locale = Some("zh-CN".to_string());
        cfg.save(&path).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("locale = \"zh-CN\""), "{written}");
        assert_eq!(
            DaemonConfig::load(&path).unwrap().locale.as_deref(),
            Some("zh-CN")
        );
    }

    /// An existing daemon.toml has no `locale` line; it must keep parsing, and
    /// the absent setting means English rather than a hard failure.
    #[test]
    fn a_config_without_locale_still_parses() {
        let cfg: DaemonConfig = toml::from_str(
            r#"
[actor]
name = "Mac"
[mqtt]
broker_url = ""
"#,
        )
        .unwrap();
        assert!(cfg.locale.is_none());
    }

    /// Interim v2 files (and old fixtures) spell the pointer `team_id`; the
    /// alias keeps them readable.
    #[test]
    fn team_id_spelling_still_parses_as_the_pointer() {
        let cfg: DaemonConfig = toml::from_str(
            r#"
team_id = "team-9"
[actor]
name = "Mac"
[mqtt]
broker_url = ""
"#,
        )
        .unwrap();
        assert_eq!(cfg.team_id.as_deref(), Some("team-9"));
    }

    #[test]
    fn load_or_bootstrap_does_not_clobber_a_corrupt_config() {
        // Only true absence bootstraps. Overwriting a broken config would
        // silently discard an operator's credentials/settings.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        std::fs::write(&path, "this is not = valid toml [[[").unwrap();

        assert!(DaemonConfig::load_or_bootstrap(&path).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "this is not = valid toml [[["
        );
    }
}
