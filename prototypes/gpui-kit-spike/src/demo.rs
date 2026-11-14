//! Demo fixtures mirroring the Desktop capture in `compare/desktop.png`,
//! plus relative-time helpers ported from `lib/ui/date-format.ts`.

use crate::cloud::{
    BubbleKind, LiveStep, LiveTurn, MessageRow, ParticipantChip, SessionRow, ToolCallRow,
    ToolStatus,
};
use std::time::{SystemTime, UNIX_EPOCH};

const BOT: &str = "研小蕉Bot";
const ME: &str = "周金亮";

const OLIVE: u32 = 0x56663a;
const GREEN: u32 = 0x2f7a52;
const VIOLET: u32 = 0x6b5ce7;
const SLATE: u32 = 0x3e4b5c;
const CLAY: u32 = 0x8a5a3c;

fn chips(names: &[(&str, bool, u32)]) -> Vec<ParticipantChip> {
    names
        .iter()
        .map(|(name, is_agent, color)| ParticipantChip {
            name: (*name).into(),
            is_agent: *is_agent,
            color: Some(*color),
        })
        .collect()
}

fn row(id: &str, title: &str, preview: &str, secs_ago: u64, parts: &[(&str, bool, u32)]) -> SessionRow {
    let participants = chips(parts);
    SessionRow {
        id: id.into(),
        title: title.into(),
        preview: preview.into(),
        last_message_at: Some(iso_secs_ago(secs_ago)),
        is_pinned: false,
        has_unread: false,
        app_label: None,
        participant_count: participants.len(),
        participants,
    }
}

const DAY: u64 = 86_400;

impl SessionRow {
    fn with_count(mut self, n: usize) -> Self {
        self.participant_count = n;
        self
    }
}

pub fn demo_sessions() -> Vec<SessionRow> {
    vec![
        row(
            "demo-1",
            "GL-MiFi A69 管理密码无法重置",
            "[Mentioned agents: 研小蕉Bot] 我重新插上了，现在的问题是 5g 报错",
            5,
            &[("研", true, OLIVE), ("研", true, GREEN), (ME, false, VIOLET)],
        )
        .with_count(4),
        row("demo-2", "Skill Creation Guidelines", "Hi 周金亮 👋 有什么可以帮你的?", 3 * DAY + 60, &[]),
        row("demo-3", "继续 Mac-mini 任务", "已完成「一页图」共 **1440×1208**（单页高清）", 3 * DAY + 600, &[]),
        row(
            "demo-4",
            "过去30天签到量趋势图",
            "已卸载 H96 本机的 `dynamic-query` 残缺版本",
            4 * DAY,
            &[("H96", true, SLATE), (ME, false, VIOLET)],
        ),
        row(
            "demo-5",
            "过去30天",
            "当前后台未登录，暂时无法动态取数。请先登录",
            4 * DAY + 900,
            &[("H96", true, SLATE), (ME, false, VIOLET)],
        ),
        row(
            "demo-6",
            "安装团队 Skills",
            "已安装 ✅ **personal-performance-usage**",
            5 * DAY,
            &[(ME, false, CLAY), ("研", true, GREEN)],
        ),
        row(
            "demo-7",
            "今日各门店营业额及最高门店",
            "柱状图已经生成了。 **2026-11-06 门店耗卡**",
            7 * DAY,
            &[("M", true, VIOLET), (ME, false, VIOLET)],
        ),
        row("demo-8", "性能测试E：5+4计算", "查询没跑通 —— 接口返回 **403 权限不足**", 12 * DAY, &[]),
        row("demo-9", "性能测试A：2+3计算", "3", 16 * DAY, &[]),
        row("demo-10", "性能测试：1+1计算", "2", 16 * DAY + 60, &[]),
    ]
}

fn agent(body: &str) -> MessageRow {
    MessageRow {
        kind: BubbleKind::Agent,
        body: body.into(),
        created_at: String::new(),
        actor_name: BOT.into(),
        model: None,
        tools: Vec::new(),
        mention: None,
    }
}

pub fn demo_messages(id: &str) -> Vec<MessageRow> {
    match id {
        "demo-1" => vec![
            agent("用户名 `root`，密码 `191005`。"),
            agent("你现在先把网线插上（**Mac 网口 ↔ 路由器 LAN 口**），插完告诉我，或者直接跑第②步那条命令把输出发我，我帮你确认。"),
            MessageRow {
                kind: BubbleKind::User,
                body: "我重新插上了，现在的问题是 5g 报错，我的 4g 网卡手机可以使用，插入到我们的路由器：sim 卡不能注册，请检查：是否用了正确型号的猫，是否需运营商需要一个特别的 APN。 之前能用，突然不能用了".into(),
                created_at: "20:16".into(),
                actor_name: "你".into(),
                model: None,
                tools: Vec::new(),
                mention: Some(BOT.into()),
            },
        ],
        "demo-2" => vec![agent("Hi 周金亮 👋 有什么可以帮你的?")],
        _ => vec![agent("（尖兵 demo：这条会话没有离线样本。）")],
    }
}

pub fn demo_live_turn(id: &str) -> Option<LiveTurn> {
    if id != "demo-1" {
        return None;
    }
    let ssh = "SSH=\"sshpass -p 191005 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@192.168.8.1\"";
    let bash = |status, dur: Option<&str>| {
        LiveStep::Tool(ToolCallRow {
            name: "Bash".into(),
            args_summary: ssh.into(),
            status,
            duration_label: dur.map(Into::into),
            result: None,
        })
    };
    Some(LiveTurn {
        agent_name: BOT.into(),
        agent_color: GREEN,
        steps: vec![
            bash(ToolStatus::Ok, Some("22.7s")),
            LiveStep::Thinking,
            bash(ToolStatus::Ok, Some("6.2s")),
            LiveStep::Thinking,
            bash(ToolStatus::Pending, None),
        ],
    })
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn iso_secs_ago(secs_ago: u64) -> String {
    let t = unix_now_secs().saturating_sub(secs_ago);
    let (days, rem) = (t / DAY, t % DAY);
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        civil_ymd_from_unix_days(days),
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn civil_ymd_from_unix_days(days: u64) -> String {
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn unix_days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// `2026-11-14T08:01:02(.123)Z` / `+08:00` → unix seconds (UTC offset honoured).
fn parse_iso_secs(raw: &str) -> Option<i64> {
    let b = raw.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[10] != b'T' {
        return raw.parse::<i64>().ok();
    }
    let n = |r: std::ops::Range<usize>| raw.get(r)?.parse::<i64>().ok();
    let days = unix_days_from_civil(n(0..4)?, n(5..7)?, n(8..10)?);
    let mut secs = days * DAY as i64 + n(11..13)? * 3600 + n(14..16)? * 60 + n(17..19)?;
    let tail = &raw[19..];
    let tz = tail.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if let Some(sign) = tz.chars().next().filter(|c| *c == '+' || *c == '-') {
        let off = tz.get(1..3)?.parse::<i64>().ok()? * 3600 + tz.get(4..6).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0) * 60;
        secs -= if sign == '+' { off } else { -off };
    }
    Some(secs)
}

/// zh `Intl.RelativeTimeFormat(numeric: 'auto')`, as Desktop's
/// `formatRelativeTime` renders it in the session list.
pub fn format_relative_list_time(iso: &Option<String>) -> String {
    let Some(then) = iso.as_deref().and_then(parse_iso_secs) else {
        return String::new();
    };
    let diff = unix_now_secs() as i64 - then;
    let d = DAY as i64;
    match diff {
        i64::MIN..=59 => "刚刚".into(),
        60..=3599 => format!("{}分钟前", diff / 60),
        3600..=86_399 => format!("{}小时前", diff / 3600),
        _ if diff < 30 * d => match diff / d {
            1 => "昨天".into(),
            2 => "前天".into(),
            n => format!("{n}天前"),
        },
        _ if diff < 365 * d => match diff / (30 * d) {
            1 => "上个月".into(),
            n => format!("{n}个月前"),
        },
        _ => match diff / (365 * d) {
            1 => "去年".into(),
            2 => "前年".into(),
            n => format!("{n}年前"),
        },
    }
}

pub fn message_clock(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    if let Some(t) = raw.split('T').nth(1) {
        return t.chars().take(5).collect();
    }
    raw.chars().take(8).collect()
}

pub fn split_preview_mentions(preview: &str) -> Vec<(bool, String)> {
    let mut out = Vec::new();
    let mut rest = preview;
    while let Some(at) = rest.find('@') {
        if at > 0 {
            out.push((false, rest[..at].to_string()));
        }
        let after = &rest[at..];
        let end = after[1..]
            .find(|c: char| {
                !(c.is_ascii_alphanumeric()
                    || c == '.'
                    || c == '-'
                    || c == '_'
                    || ('\u{4e00}'..='\u{9fff}').contains(&c))
            })
            .map(|i| i + 1)
            .unwrap_or(after.len());
        out.push((true, after[..end].to_string()));
        rest = &after[end..];
    }
    if !rest.is_empty() {
        out.push((false, rest.to_string()));
    }
    if out.is_empty() {
        out.push((false, preview.to_string()));
    }
    out
}

/// Row height for the shared glass Y (no DOM measure in GPUI spike).
/// Preview line (16.5pt text + 2pt gap) that a row without
/// `lastMessagePreview` drops.
const PREVIEW_LINE_H: f32 = 22.;

pub fn estimate_row_height(s: &SessionRow) -> f32 {
    use crate::theme::Layout;
    let mut h = Layout::ROW_H;
    if s.app_label.is_some() {
        h = Layout::ROW_H_WITH_APP;
    }
    if show_participants(s) {
        h = h.max(Layout::ROW_H_WITH_PARTS);
    }
    if !show_preview(s) {
        h -= PREVIEW_LINE_H;
    }
    h
}

/// Desktop: `parts.length > 0 && !isSoloWithLocalAgent`; the solo case is
/// cleared when the roster is loaded.
pub fn show_participants(s: &SessionRow) -> bool {
    !s.participants.is_empty()
}

pub fn show_preview(s: &SessionRow) -> bool {
    !s.preview.trim().is_empty()
}
