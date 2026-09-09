use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Schedule kind for a cron job
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleKind {
    /// One-time execution at a specific timestamp
    At,
    /// Recurring execution at a fixed interval
    Every,
    /// Recurring execution using a cron expression
    Cron,
}

/// Schedule configuration for a cron job
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronSchedule {
    /// Schedule type
    pub kind: ScheduleKind,
    /// ISO 8601 timestamp for one-time execution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// Interval in milliseconds for recurring execution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every_ms: Option<u64>,
    /// 5-field cron expression (e.g., "*/30 * * * *")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expr: Option<String>,
    /// Optional IANA timezone for cron expression (e.g. `Asia/Shanghai`). When omitted, the
    /// expression uses the **system local** wall clock (Unix crontab semantics), not UTC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tz: Option<String>,
}

/// Legacy marker written by older cron timeout handling when it aborted an AI response.
pub const LEGACY_TIMEOUT_CUT_SHORT_MARKER: &str = "AI response was cut short after";

/// Payload configuration - what to send to OpenCode
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronPayload {
    /// Prompt text to send to OpenCode
    pub message: String,
    /// Optional model override ("provider/model")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Backend the job runs on: "opencode" | "claude" | "codex". `None`/empty
    /// means "auto" — the daemon picks its `default_agent_type`. Pairs with
    /// `model`: the model ref is selected from this backend's catalog group.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// Wall-clock cap for one agent turn, in seconds. When absent the scheduler
    /// uses [`DEFAULT_CRON_WALL_TIMEOUT_SECS`] (60 minutes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    /// Permission mode for the run: `"full_access"` (default) or `"default"`.
    /// Cron runs unattended, so an approval prompt has nobody to answer it and
    /// the turn just burns its timeout — hence full access unless the job
    /// explicitly opts out. `None` (old job JSON) means full access too.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
}

/// Wire value for [`CronPayload::permission_mode`] when the job does not pin
/// one. Kept as the single definition so the scheduler and the default-job
/// constructors cannot drift apart.
pub const DEFAULT_CRON_PERMISSION_MODE: &str = "full_access";

/// Default hard wall-clock budget for one unattended cron turn (60 minutes).
pub const DEFAULT_CRON_WALL_TIMEOUT_SECS: u64 = 3600;

/// Maximum wall-clock budget a job may request (also 60 minutes today).
pub const MAX_CRON_WALL_TIMEOUT_SECS: u64 = 3600;

/// Minimum wall-clock budget the scheduler will honor.
pub const MIN_CRON_WALL_TIMEOUT_SECS: u64 = 60;

/// How long a cron turn may go without ACP progress before timing out. The
/// daemon resets this on every event (tool start/end, streaming delta, etc.).
pub const DEFAULT_CRON_IDLE_TIMEOUT_SECS: u64 = 300;

/// Extra seconds the desktop waits beyond the job wall clock when talking to
/// amuxd, so a slow persist/finalize does not look like a client hang.
pub const CRON_CLIENT_TIMEOUT_SLACK_SECS: u64 = 60;

/// Resolve the wall-clock timeout for a cron job payload.
pub fn resolve_cron_wall_timeout_seconds(raw: Option<u64>) -> u64 {
    raw.unwrap_or(DEFAULT_CRON_WALL_TIMEOUT_SECS)
        .clamp(MIN_CRON_WALL_TIMEOUT_SECS, MAX_CRON_WALL_TIMEOUT_SECS)
}

/// Delivery mode for cron job results
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryMode {
    /// Deliver a summary to the specified channel
    Announce,
    /// Run silently without delivering results
    None,
}

/// Delivery channel type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryChannel {
    Discord,
    Feishu,
    Email,
    Kook,
    Wechat,
    Wecom,
    Seatalk,
}

/// Delivery configuration for cron job results
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronDelivery {
    /// Delivery mode
    pub mode: DeliveryMode,
    /// Channel to deliver through
    pub channel: DeliveryChannel,
    /// Channel-specific target (user ID, chat ID, email address)
    pub to: String,
    /// Whether to continue even if delivery fails
    #[serde(default)]
    pub best_effort: bool,
}

/// Run status for a cron job execution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Success,
    Failed,
    Timeout,
    Running,
    Stale,
}

/// A cron job definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJob {
    /// Unique job identifier (UUID)
    pub id: String,
    /// Human-readable job name
    pub name: String,
    /// Optional description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Whether the job is active
    #[serde(default)]
    pub enabled: bool,
    /// Schedule configuration
    pub schedule: CronSchedule,
    /// What to send to OpenCode
    pub payload: CronPayload,
    /// Optional notification delivery
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    /// Auto-delete after successful one-time run
    #[serde(default)]
    pub delete_after_run: bool,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Last update timestamp
    pub updated_at: DateTime<Utc>,
    /// Last execution time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<DateTime<Utc>>,
    /// Computed next execution time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<DateTime<Utc>>,
}

/// A record of a single cron job execution
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunRecord {
    /// Unique run identifier
    pub run_id: String,
    /// Job ID this run belongs to
    pub job_id: String,
    /// When the run started
    pub started_at: DateTime<Utc>,
    /// When the run finished
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    /// Run status
    pub status: RunStatus,
    /// Last executor heartbeat while the run was active
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_heartbeat_at: Option<DateTime<Utc>>,
    /// OpenCode session ID used for this run
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Truncated AI response summary
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_summary: Option<String>,
    /// Whether notification was delivered
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_status: Option<String>,
    /// Error message if failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CronRunRecord {
    pub fn has_legacy_timeout_cut_short_text(&self) -> bool {
        self.response_summary
            .as_deref()
            .is_some_and(|text| text.contains(LEGACY_TIMEOUT_CUT_SHORT_MARKER))
            || self
                .error
                .as_deref()
                .is_some_and(|text| text.contains(LEGACY_TIMEOUT_CUT_SHORT_MARKER))
    }
}

pub fn normalize_legacy_timeout_status(record: &mut CronRunRecord) {
    if record.has_legacy_timeout_cut_short_text() && record.status == RunStatus::Success {
        record.status = RunStatus::Timeout;
    }
}

/// Persistent storage structure for all cron jobs
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CronJobsData {
    pub jobs: Vec<CronJob>,
}

/// Request to create a new cron job (from frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCronJobRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub enabled: bool,
    pub schedule: CronSchedule,
    pub payload: CronPayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    #[serde(default)]
    pub delete_after_run: bool,
}

/// Request to update an existing cron job (from frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCronJobRequest {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<CronSchedule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<CronPayload>,
    /// Use Some(None) to clear delivery, Some(Some(...)) to set, None to leave unchanged
    #[serde(default)]
    pub delivery: Option<Option<CronDelivery>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_after_run: Option<bool>,
}
