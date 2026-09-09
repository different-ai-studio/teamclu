//! Pure helpers for WeCom long-turn delivery: ack classification, progress
//! copy, stream-window decisions, and markdown chunking.
//!
//! The websocket I/O stays in `wecom.rs`; this module exists so the retry
//! policy and the 240s early-close state machine can be unit-tested without
//! a live bot.

use serde_json::Value;
use std::time::Duration;

/// Default stream bubble lifetime before WeComDriver closes it and switches
/// the final answer onto `aibot_send_msg`. Kept on the driver, not ChannelCaps.
pub const DEFAULT_STREAM_MAX_SECS: u64 = 240;
/// Progress frames share the 30/minute conversation quota with everything
/// else. 10s → 6 frames/minute, leaving room for the answer.
pub const DEFAULT_PROGRESS_FRAME_GAP_SECS: u64 = 10;
pub const DEFAULT_FINAL_MAX_RETRIES: u32 = 3;

/// WeCom `stream.content` / markdown hard cap, UTF-8 bytes.
pub const WECOM_CONTENT_MAX_BYTES: usize = 20480;
/// Segment size for follow-up markdown. Far below the 20KB cap so a `(n/m)`
/// prefix still fits, and a long answer stays readable.
pub const MARKDOWN_SEGMENT_MAX_BYTES: usize = 8192;

/// Quota-safe gap between two independent sends (outbox flush, multi-segment
/// markdown). Matches WeCom's 30/minute conversation budget.
pub const QUOTA_SAFE_GAP: Duration = Duration::from_millis(2100);

/// Progress / stream-finish ack wait.
pub const STREAM_FRAME_ACK_TIMEOUT: Duration = Duration::from_secs(5);
/// Proactive `aibot_send_msg` and the stream's terminal frame.
pub const PROACTIVE_ACK_TIMEOUT: Duration = Duration::from_secs(15);

/// errcode 6000 retry delays, in order.
pub const CONFLICT_BACKOFF_MS: &[u64] = &[100, 300, 1000];
pub const RATE_LIMIT_RETRY_MS: u64 = 2000;

/// Fallback when every delivery path failed. The session already has the
/// reply (`write_reply` runs before the final `update`).
pub const FALLBACK_SEE_SESSION: &str = "答案生成完毕但推送失败，请在会话中查看";

const PROGRESS_HEAD: &str = "💭 执行中";

/// How a WS ack (or the lack of one) is classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    /// errcode 6000 — concurrent rewrite; retry with backoff.
    Conflict,
    RateLimited {
        retry_after_ms: Option<u64>,
    },
    Rejected(String),
    Transport(String),
    Timeout,
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict => write!(f, "wecom errcode 6000 (conflict)"),
            Self::RateLimited { retry_after_ms } => {
                write!(f, "wecom rate limited (retry_after_ms={retry_after_ms:?})")
            }
            Self::Rejected(s) => write!(f, "wecom rejected: {s}"),
            Self::Transport(s) => write!(f, "wecom transport: {s}"),
            Self::Timeout => write!(f, "wecom ack timeout"),
        }
    }
}

impl std::error::Error for SendError {}

/// Lifecycle of one WeCom stream bubble.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamPhase {
    /// `aibot_respond_msg` is still accepted on this callback.
    Open,
    /// Early `finish=true` already sent; later progress is swallowed and the
    /// answer goes out as markdown.
    ClosedForFollowup,
    /// Terminal finish (answer or cancelled) already sent.
    Finished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressDecision {
    SendProgress,
    CloseEarly,
    Swallow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishDecision {
    FinishInStream,
    FollowupMarkdown,
    Swallow,
}

pub fn decide_progress(phase: StreamPhase, past_deadline: bool) -> ProgressDecision {
    match phase {
        StreamPhase::ClosedForFollowup | StreamPhase::Finished => ProgressDecision::Swallow,
        StreamPhase::Open if past_deadline => ProgressDecision::CloseEarly,
        StreamPhase::Open => ProgressDecision::SendProgress,
    }
}

pub fn decide_finish(phase: StreamPhase) -> FinishDecision {
    match phase {
        StreamPhase::Open => FinishDecision::FinishInStream,
        StreamPhase::ClosedForFollowup => FinishDecision::FollowupMarkdown,
        StreamPhase::Finished => FinishDecision::Swallow,
    }
}

/// Pull errcode/errmsg from either the top level or `body` (WeCom uses both).
pub fn errcode_and_msg(v: &Value) -> (i64, String) {
    let code = v
        .get("body")
        .and_then(|b| b.get("errcode"))
        .and_then(|c| c.as_i64())
        .or_else(|| v.get("errcode").and_then(|c| c.as_i64()))
        .unwrap_or(0);
    let msg = v
        .get("body")
        .and_then(|b| b.get("errmsg"))
        .and_then(|m| m.as_str())
        .or_else(|| v.get("errmsg").and_then(|m| m.as_str()))
        .unwrap_or("")
        .to_string();
    (code, msg)
}

pub fn classify_errcode(code: i64, errmsg: &str) -> Result<(), SendError> {
    if code == 0 {
        return Ok(());
    }
    if code == 6000 {
        return Err(SendError::Conflict);
    }
    if is_rate_limited(code, errmsg) {
        return Err(SendError::RateLimited {
            retry_after_ms: None,
        });
    }
    Err(SendError::Rejected(format!("errcode={code} {errmsg}")))
}

pub fn classify_response(v: &Value) -> Result<(), SendError> {
    let (code, msg) = errcode_and_msg(v);
    classify_errcode(code, &msg)
}

fn is_rate_limited(code: i64, errmsg: &str) -> bool {
    matches!(code, 45009 | 45011 | 45033)
        || errmsg.contains("freq")
        || errmsg.contains("limit")
        || errmsg.contains("busy")
        || errmsg.contains("频")
}

pub fn format_elapsed(d: Duration) -> String {
    let secs = d.as_secs();
    let m = secs / 60;
    let s = secs % 60;
    if m == 0 {
        format!("{s}秒")
    } else {
        format!("{m}分{s}秒")
    }
}

/// Progress bubble: elapsed time only. Intermediate agent text stays off the
/// stream card; the answer is the finish frame / follow-up markdown.
pub fn progress_frame(elapsed: Duration) -> String {
    format!("{PROGRESS_HEAD} · {}", format_elapsed(elapsed))
}

/// Append a queue notice so it is visible while the stream bubble is the only
/// thing WeCom will reliably rewrite.
pub fn progress_frame_with_notice(elapsed: Duration, notice: Option<&str>) -> String {
    let base = progress_frame(elapsed);
    match notice {
        Some(n) if !n.trim().is_empty() => format!("{base}\n\n{n}"),
        _ => base,
    }
}

/// `finish=true` body used when the stream window is exhausted but the turn
/// is still running.
pub fn still_running_close_text(elapsed: Duration) -> String {
    let mins = elapsed.as_secs().div_ceil(60).max(1);
    format!("⏳ 任务仍在执行（已 {mins} 分钟），完成后将单独推送结果")
}

pub fn still_running_close_with_notice(elapsed: Duration, notice: Option<&str>) -> String {
    let base = still_running_close_text(elapsed);
    match notice {
        Some(n) if !n.trim().is_empty() => format!("{base}\n\n{n}"),
        _ => base,
    }
}

/// Split a markdown answer on blank lines, then lines, then char boundaries,
/// so each piece stays under `max_bytes`. Multi-part replies get `（n/m）`.
pub fn split_markdown_segments(text: &str, max_bytes: usize) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    if max_bytes == 0 {
        return vec![text.to_string()];
    }
    if text.len() <= max_bytes {
        return vec![text.to_string()];
    }

    let mut raw = Vec::new();
    for para in text.split("\n\n") {
        if para.is_empty() {
            continue;
        }
        if para.len() <= max_bytes {
            raw.push(para.to_string());
            continue;
        }
        for line in para.split('\n') {
            if line.len() <= max_bytes {
                raw.push(line.to_string());
                continue;
            }
            raw.extend(split_char_boundary(line, max_bytes));
        }
    }
    if raw.is_empty() {
        raw.extend(split_char_boundary(text, max_bytes));
    }

    let packed = pack_segments(raw, max_bytes);
    let total = packed.len();
    if total <= 1 {
        return packed;
    }
    packed
        .into_iter()
        .enumerate()
        .map(|(i, body)| format!("（{}/{}）\n{body}", i + 1, total))
        .collect()
}

fn split_char_boundary(text: &str, max_bytes: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        if rest.len() <= max_bytes {
            out.push(rest.to_string());
            break;
        }
        let mut end = max_bytes;
        while end > 0 && !rest.is_char_boundary(end) {
            end -= 1;
        }
        if end == 0 {
            end = rest.chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        }
        out.push(rest[..end].to_string());
        rest = &rest[end..];
    }
    out
}

fn pack_segments(parts: Vec<String>, max_bytes: usize) -> Vec<String> {
    let mut packed = Vec::new();
    let mut current = String::new();
    for part in parts {
        if current.is_empty() {
            current = part;
            continue;
        }
        let join_len = current.len() + 1 + part.len(); // newline
        if join_len <= max_bytes {
            current.push('\n');
            current.push_str(&part);
        } else {
            packed.push(std::mem::take(&mut current));
            current = part;
        }
    }
    if !current.is_empty() {
        packed.push(current);
    }
    packed
}

/// After an acked send has already applied in-flight retries, decide whether
/// a failed proactive message belongs back on the outbox.
pub fn should_requeue(retry_count: u32, max_retries: u32, err: &SendError) -> bool {
    if retry_count + 1 >= max_retries {
        return false;
    }
    matches!(
        err,
        SendError::Transport(_) | SendError::Timeout | SendError::Conflict
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn success_is_zero_or_missing_errcode() {
        assert!(classify_response(&json!({})).is_ok());
        assert!(classify_response(&json!({"errcode": 0})).is_ok());
        assert!(classify_response(&json!({"body": {"errcode": 0}})).is_ok());
    }

    #[test]
    fn errcode_6000_is_conflict() {
        assert_eq!(
            classify_response(&json!({"body": {"errcode": 6000, "errmsg": "conflict"}})),
            Err(SendError::Conflict)
        );
        assert_eq!(
            classify_errcode(6000, "数据版本冲突"),
            Err(SendError::Conflict)
        );
    }

    #[test]
    fn known_freq_codes_are_rate_limited() {
        assert!(matches!(
            classify_errcode(45009, ""),
            Err(SendError::RateLimited { .. })
        ));
        assert!(matches!(
            classify_errcode(1, "api freq out of limit"),
            Err(SendError::RateLimited { .. })
        ));
        assert!(matches!(
            classify_errcode(1, "超过频率限制"),
            Err(SendError::RateLimited { .. })
        ));
    }

    #[test]
    fn other_nonzero_is_rejected() {
        match classify_errcode(40013, "invalid appid") {
            Err(SendError::Rejected(s)) => {
                assert!(s.contains("40013"));
                assert!(s.contains("invalid appid"));
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[test]
    fn body_errcode_wins_over_missing_top_level() {
        let (code, msg) = errcode_and_msg(&json!({
            "headers": {"req_id": "x"},
            "body": {"errcode": 6000, "errmsg": "conflict"}
        }));
        assert_eq!(code, 6000);
        assert_eq!(msg, "conflict");
    }

    #[test]
    fn elapsed_format_matches_the_progress_copy() {
        assert_eq!(format_elapsed(Duration::from_secs(0)), "0秒");
        assert_eq!(format_elapsed(Duration::from_secs(12)), "12秒");
        assert_eq!(format_elapsed(Duration::from_secs(192)), "3分12秒");
        assert_eq!(format_elapsed(Duration::from_secs(60)), "1分0秒");
    }

    #[test]
    fn progress_frame_is_elapsed_only() {
        let frame = progress_frame(Duration::from_secs(192));
        assert_eq!(frame, "💭 执行中 · 3分12秒");
    }

    #[test]
    fn progress_notice_is_appended_not_inline() {
        let frame = progress_frame_with_notice(Duration::from_secs(5), Some("上一条还在处理"));
        assert!(frame.starts_with("💭 执行中 · 5秒"));
        assert!(frame.contains("上一条还在处理"));
        assert!(frame.contains("\n\n"));
        assert!(!frame.contains("工具中"));
    }

    #[test]
    fn still_running_copy_rounds_up_to_a_minute() {
        let text = still_running_close_text(Duration::from_secs(240));
        assert!(text.contains("4 分钟"));
        assert!(text.contains("完成后将单独推送结果"));
    }

    #[test]
    fn progress_state_machine() {
        assert_eq!(
            decide_progress(StreamPhase::Open, false),
            ProgressDecision::SendProgress
        );
        assert_eq!(
            decide_progress(StreamPhase::Open, true),
            ProgressDecision::CloseEarly
        );
        assert_eq!(
            decide_progress(StreamPhase::ClosedForFollowup, true),
            ProgressDecision::Swallow
        );
        assert_eq!(
            decide_progress(StreamPhase::Finished, false),
            ProgressDecision::Swallow
        );
    }

    #[test]
    fn finish_state_machine() {
        assert_eq!(
            decide_finish(StreamPhase::Open),
            FinishDecision::FinishInStream
        );
        assert_eq!(
            decide_finish(StreamPhase::ClosedForFollowup),
            FinishDecision::FollowupMarkdown
        );
        assert_eq!(
            decide_finish(StreamPhase::Finished),
            FinishDecision::Swallow
        );
    }

    #[test]
    fn short_markdown_is_one_segment_without_index() {
        let parts = split_markdown_segments("广州今日多云。", 8192);
        assert_eq!(parts, vec!["广州今日多云。".to_string()]);
    }

    #[test]
    fn long_markdown_splits_on_blank_lines_and_indexes() {
        let a = "甲".repeat(2000);
        let b = "乙".repeat(2000);
        let text = format!("{a}\n\n{b}");
        let parts = split_markdown_segments(&text, 8192);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].starts_with("（1/2）\n"));
        assert!(parts[1].starts_with("（2/2）\n"));
        assert!(parts[0].contains("甲"));
        assert!(parts[1].contains("乙"));
    }

    #[test]
    fn oversized_line_splits_on_char_boundary() {
        let text = "中".repeat(100);
        let parts = split_markdown_segments(&text, 10);
        assert!(parts.len() > 1);
        for p in &parts {
            let body = p.split_once('\n').map(|(_, b)| b).unwrap_or(p);
            assert!(body.len() <= 10 || p.starts_with('（'));
            assert!(p.is_char_boundary(p.len()));
        }
        let joined: String = parts
            .iter()
            .map(|p| p.split_once('\n').map(|(_, b)| b).unwrap_or(p.as_str()))
            .collect();
        assert_eq!(joined, text);
    }

    #[test]
    fn empty_markdown_yields_no_segments() {
        assert!(split_markdown_segments("", 8192).is_empty());
    }

    #[test]
    fn outbox_requeue_stops_at_the_retry_cap() {
        let err = SendError::Timeout;
        assert!(should_requeue(0, 3, &err));
        assert!(should_requeue(1, 3, &err));
        assert!(!should_requeue(2, 3, &err));
        assert!(!should_requeue(0, 3, &SendError::Rejected("no".into())));
        assert!(should_requeue(0, 3, &SendError::Transport("down".into())));
    }
}
