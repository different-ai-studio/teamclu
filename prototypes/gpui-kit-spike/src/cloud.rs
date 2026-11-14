//! Throwaway Cloud API read client — list sessions + messages only.

use serde::Deserialize;

#[derive(Clone, Debug)]
pub struct CloudConfig {
    pub base_url: String,
    pub token: String,
    pub team_id: String,
    /// Current member + local daemon agent: a roster made only of these is
    /// "solo with local agent" and Desktop hides its participants row.
    pub solo_actor_ids: Vec<String>,
}

impl CloudConfig {
    pub fn from_env() -> Result<Self, String> {
        let token = std::env::var("TEAMCLU_ACCESS_TOKEN")
            .map_err(|_| "missing TEAMCLU_ACCESS_TOKEN".to_string())?
            .trim()
            .to_string();
        if token.is_empty() {
            return Err("empty TEAMCLU_ACCESS_TOKEN".into());
        }
        let team_id = std::env::var("TEAMCLU_TEAM_ID")
            .map_err(|_| "missing TEAMCLU_TEAM_ID".to_string())?
            .trim()
            .to_string();
        if team_id.is_empty() {
            return Err("empty TEAMCLU_TEAM_ID".into());
        }
        let base_url = std::env::var("TEAMCLU_CLOUD_API_URL")
            .unwrap_or_else(|_| "https://api.teamclu-dev.ucar.cc".into())
            .trim_end_matches('/')
            .to_string();
        let solo_actor_ids = std::env::var("TEAMCLU_SOLO_ACTOR_IDS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Ok(Self {
            base_url,
            token,
            team_id,
            solo_actor_ids,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ParticipantChip {
    pub name: String,
    pub is_agent: bool,
    /// Disc colour when the source knows it; otherwise hashed from the name.
    pub color: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub last_message_at: Option<String>,
    pub is_pinned: bool,
    pub has_unread: bool,
    /// Short app label when the session belongs to an app.
    pub app_label: Option<String>,
    pub participants: Vec<ParticipantChip>,
    pub participant_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    Ok,
    Error,
    Pending,
}

#[derive(Clone, Debug)]
pub struct ToolCallRow {
    pub name: String,
    /// Compact arg snippet, e.g. `path: "~/.amuxd"`.
    pub args_summary: String,
    pub status: ToolStatus,
    pub duration_label: Option<String>,
    pub result: Option<String>,
}

#[derive(Clone, Debug)]
pub enum BubbleKind {
    User,
    Agent,
    Other(String),
}

#[derive(Clone, Debug)]
pub struct MessageRow {
    pub kind: BubbleKind,
    pub body: String,
    pub created_at: String,
    pub actor_name: String,
    pub model: Option<String>,
    pub tools: Vec<ToolCallRow>,
    /// `[Mentioned agents: X]` prefix on a user message, shown as the
    /// bubble's `AGENT @X` header.
    pub mention: Option<String>,
}

#[derive(Clone, Debug)]
pub enum LiveStep {
    Tool(ToolCallRow),
    Thinking,
}

/// The in-flight agent turn docked above the composer (ComposerStack).
#[derive(Clone, Debug)]
pub struct LiveTurn {
    pub agent_name: String,
    pub agent_color: u32,
    pub steps: Vec<LiveStep>,
}

pub fn split_mention_prefix(body: &str) -> (Option<String>, String) {
    const PREFIX: &str = "[Mentioned agents: ";
    let trimmed = body.trim_start();
    if let Some(rest) = trimmed.strip_prefix(PREFIX) {
        if let Some(end) = rest.find(']') {
            let names = rest[..end].trim().to_string();
            let tail = rest[end + 1..].trim_start().to_string();
            return (Some(names), tail);
        }
    }
    (None, body.to_string())
}

#[derive(Deserialize)]
struct Page<T> {
    items: Vec<T>,
    #[serde(rename = "nextCursor")]
    #[allow(dead_code)]
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct CloudSession {
    id: String,
    title: String,
    #[serde(rename = "lastMessagePreview")]
    last_message_preview: Option<String>,
    #[serde(rename = "lastMessageAt")]
    last_message_at: Option<String>,
    #[serde(rename = "hasUnread", default)]
    has_unread: bool,
    #[serde(rename = "appId")]
    app_id: Option<String>,
    #[serde(rename = "participantCount")]
    participant_count: Option<u32>,
}

#[derive(Deserialize)]
struct CloudMessage {
    kind: String,
    content: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    model: Option<String>,
    #[serde(rename = "senderDisplayName")]
    sender_display_name: Option<String>,
}

pub fn list_sessions(cfg: &CloudConfig, limit: u32) -> Result<Vec<SessionRow>, String> {
    // Desktop's list (session-list-store) reads the partitioned v2 list; v1
    // `kind=regular` still includes app sessions.
    let url = format!(
        "{}/v2/sessions?limit={limit}&teamId={}&kind=regular",
        cfg.base_url,
        urlencoding_lite(&cfg.team_id)
    );
    let page: Page<CloudSession> = get_json(cfg, &url)?;
    let rosters: Vec<Vec<ParticipantChip>> = std::thread::scope(|scope| {
        let handles: Vec<_> = page
            .items
            .iter()
            .map(|s| scope.spawn(|| list_participants(cfg, &s.id).unwrap_or_default()))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_default())
            .collect()
    });
    Ok(page
        .items
        .into_iter()
        .zip(rosters)
        .map(|(s, participants)| {
            let count = s.participant_count.unwrap_or(0) as usize;
            SessionRow {
                id: s.id,
                title: if s.title.trim().is_empty() {
                    "新会话".into()
                } else {
                    s.title
                },
                preview: s
                    .last_message_preview
                    .unwrap_or_default()
                    .chars()
                    .take(90)
                    .collect(),
                last_message_at: s.last_message_at,
                is_pinned: false,
                has_unread: s.has_unread,
                app_label: s.app_id.filter(|id| !id.is_empty()).map(|id| {
                    let short: String = id.chars().take(8).collect();
                    format!("App · {short}")
                }),
                participant_count: if participants.is_empty() {
                    count
                } else {
                    participants.len()
                },
                participants,
            }
        })
        .collect())
}

#[derive(Deserialize)]
struct CloudParticipant {
    #[serde(rename = "actorId")]
    actor_id: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "actorType")]
    actor_type: Option<String>,
}

#[derive(Deserialize)]
struct Items<T> {
    items: Vec<T>,
}

/// Same roster Desktop's `session-participant-store` shows: mentionable
/// actors only, disc colour hashed from the actor id.
fn list_participants(cfg: &CloudConfig, session_id: &str) -> Result<Vec<ParticipantChip>, String> {
    let url = format!(
        "{}/v1/sessions/{}/participants",
        cfg.base_url,
        urlencoding_lite(session_id)
    );
    let out: Items<CloudParticipant> = get_json(cfg, &url)?;
    let mentionable: Vec<CloudParticipant> = out
        .items
        .into_iter()
        .filter(|p| {
            matches!(
                p.actor_type.as_deref().unwrap_or(""),
                "agent" | "personal_agent" | "role_agent" | "member" | "external"
            )
        })
        .collect();
    if mentionable
        .iter()
        .all(|p| cfg.solo_actor_ids.contains(&p.actor_id))
    {
        return Ok(Vec::new());
    }
    Ok(mentionable
        .into_iter()
        .filter_map(|p| {
            let kind = p.actor_type.as_deref().unwrap_or("");
            let is_agent = matches!(kind, "agent" | "personal_agent" | "role_agent");
            if !(is_agent || kind == "member" || kind == "external") {
                return None;
            }
            let name = p
                .display_name
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| p.actor_id.clone());
            Some(ParticipantChip {
                color: Some(crate::theme::actor_avatar_color(&p.actor_id)),
                name,
                is_agent,
            })
        })
        .collect())
}

pub fn list_messages(cfg: &CloudConfig, session_id: &str, limit: u32) -> Result<Vec<MessageRow>, String> {
    let url = format!(
        "{}/v1/sessions/{}/messages?limit={limit}",
        cfg.base_url,
        urlencoding_lite(session_id),
    );
    let page: Page<CloudMessage> = get_json(cfg, &url)?;
    Ok(group_turn_messages(page.items))
}

/// Fold AGENT_TOOL_CALL rows into the following agent reply (Desktop turn shape).
fn group_turn_messages(raw: Vec<CloudMessage>) -> Vec<MessageRow> {
    let mut out: Vec<MessageRow> = Vec::new();
    let mut pending_tools: Vec<ToolCallRow> = Vec::new();

    for m in raw {
        let kind_l = m.kind.to_ascii_lowercase();
        if kind_l.contains("thinking") {
            continue;
        }

        if kind_l.contains("tool") {
            if let Some(tool) = parse_tool_from_message(&m) {
                pending_tools.push(tool);
            }
            continue;
        }

        let (body, inline_tools) = parse_body_and_tools(&m.content);
        let mut tools = std::mem::take(&mut pending_tools);
        tools.extend(inline_tools);

        let kind = if kind_l == "user" || kind_l.contains("user") {
            BubbleKind::User
        } else if kind_l.contains("agent")
            || kind_l.contains("assistant")
            || kind_l.contains("reply")
        {
            BubbleKind::Agent
        } else {
            BubbleKind::Other(m.kind.clone())
        };

        if matches!(kind, BubbleKind::User) {
            // Tools before a user message are orphaned — emit as a bare agent note.
            if !tools.is_empty() {
                out.push(MessageRow {
                    kind: BubbleKind::Agent,
                    body: String::new(),
                    created_at: m.created_at.clone(),
                    actor_name: "Agent".into(),
                    model: None,
                    tools,
                    mention: None,
                });
            } else {
                // discard empty tools take already done
                let _ = tools;
            }
            let (mention, body) = split_mention_prefix(&body);
            if body.trim().is_empty() {
                continue;
            }
            out.push(MessageRow {
                kind: BubbleKind::User,
                body,
                created_at: m.created_at,
                actor_name: "你".into(),
                model: None,
                tools: Vec::new(),
                mention,
            });
            continue;
        }

        if body.trim().is_empty() && tools.is_empty() {
            continue;
        }

        let actor_name = m
            .sender_display_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Agent".into());

        out.push(MessageRow {
            kind,
            body,
            created_at: m.created_at,
            actor_name,
            model: m.model.filter(|s| !s.trim().is_empty()),
            tools,
            mention: None,
        });
    }

    if !pending_tools.is_empty() {
        out.push(MessageRow {
            kind: BubbleKind::Agent,
            body: String::new(),
            created_at: String::new(),
            actor_name: "Agent".into(),
            model: None,
            tools: pending_tools,
            mention: None,
        });
    }

    out
}

fn parse_body_and_tools(content: &str) -> (String, Vec<ToolCallRow>) {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return (String::new(), Vec::new());
    }
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            let text = extract_text_from_parts(&value).unwrap_or_default();
            let tools = extract_tools_from_parts(&value);
            if !text.is_empty() || !tools.is_empty() {
                return (text, tools);
            }
        }
    }
    (trimmed.to_string(), Vec::new())
}

fn parse_tool_from_message(m: &CloudMessage) -> Option<ToolCallRow> {
    let trimmed = m.content.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(mut tools) = Some(extract_tools_from_parts(&value)).filter(|t| !t.is_empty()) {
            return tools.pop();
        }
        if let Some(tool) = tool_from_object(&value) {
            return Some(tool);
        }
        // Plain `{name, arguments, result, status}` wire shapes.
        if value.get("name").is_some() || value.get("toolName").is_some() {
            return tool_from_object(&value);
        }
    }
    // Fallback: treat whole content as a shell-ish result line.
    Some(ToolCallRow {
        name: "tool".into(),
        args_summary: String::new(),
        status: ToolStatus::Ok,
        duration_label: None,
        result: Some(trimmed.chars().take(160).collect()),
    })
}

fn extract_text_from_parts(value: &serde_json::Value) -> Option<String> {
    let parts = value.as_array().or_else(|| value.get("parts")?.as_array())?;
    let mut texts = Vec::new();
    for part in parts {
        let ty = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if ty.eq_ignore_ascii_case("text") {
            if let Some(t) = part
                .get("text")
                .or_else(|| part.get("content"))
                .and_then(|t| t.as_str())
            {
                texts.push(t.to_string());
            }
        }
    }
    if texts.is_empty() {
        None
    } else {
        Some(texts.join("\n\n"))
    }
}

fn extract_tools_from_parts(value: &serde_json::Value) -> Vec<ToolCallRow> {
    let Some(parts) = value
        .as_array()
        .or_else(|| value.get("parts").and_then(|p| p.as_array()))
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for part in parts {
        let ty = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if !(ty.eq_ignore_ascii_case("tool-call")
            || ty.eq_ignore_ascii_case("tool_call")
            || ty.eq_ignore_ascii_case("tool"))
        {
            continue;
        }
        let obj = part
            .get("toolCall")
            .or_else(|| part.get("tool_call"))
            .unwrap_or(part);
        if let Some(tool) = tool_from_object(obj) {
            out.push(tool);
        }
    }
    out
}

fn tool_from_object(value: &serde_json::Value) -> Option<ToolCallRow> {
    let name = value
        .get("name")
        .or_else(|| value.get("toolName"))
        .or_else(|| value.get("tool_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();

    let args = value
        .get("arguments")
        .or_else(|| value.get("args"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let args_summary = summarize_args(&args);

    let status_raw = value
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("completed")
        .to_ascii_lowercase();
    let status = if status_raw.contains("fail") || status_raw.contains("error") {
        ToolStatus::Error
    } else if status_raw.contains("pend")
        || status_raw.contains("call")
        || status_raw.contains("run")
        || status_raw.contains("wait")
    {
        ToolStatus::Pending
    } else {
        ToolStatus::Ok
    };

    let duration_label = value
        .get("duration")
        .and_then(|v| {
            if let Some(ms) = v.as_u64() {
                Some(format_duration_ms(ms))
            } else if let Some(ms) = v.as_f64() {
                Some(format_duration_ms(ms as u64))
            } else {
                v.as_str().map(|s| s.to_string())
            }
        })
        .or_else(|| {
            value
                .get("durationMs")
                .and_then(|v| v.as_u64())
                .map(format_duration_ms)
        });

    let result = value
        .get("result")
        .or_else(|| value.get("output"))
        .map(stringify_result)
        .filter(|s| !s.trim().is_empty());

    Some(ToolCallRow {
        name,
        args_summary,
        status,
        duration_label,
        result,
    })
}

fn summarize_args(args: &serde_json::Value) -> String {
    let Some(obj) = args.as_object() else {
        return String::new();
    };
    for key in [
        "path",
        "command",
        "query",
        "pattern",
        "url",
        "file",
        "description",
        "title",
    ] {
        if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
            let clipped: String = v.chars().take(48).collect();
            let more = if v.chars().count() > 48 { "…" } else { "" };
            return format!("{key}: \"{clipped}{more}\"");
        }
    }
    if let Some((k, v)) = obj.iter().next() {
        let s = match v {
            serde_json::Value::String(s) => format!("\"{}\"", s.chars().take(40).collect::<String>()),
            other => other.to_string().chars().take(40).collect(),
        };
        return format!("{k}: {s}");
    }
    String::new()
}

fn stringify_result(v: &serde_json::Value) -> String {
    if let Some(s) = v.as_str() {
        return s.chars().take(180).collect();
    }
    if let Some(obj) = v.as_object() {
        if let Some(s) = obj.get("text").and_then(|t| t.as_str()) {
            return s.chars().take(180).collect();
        }
        if let Some(s) = obj.get("output").and_then(|t| t.as_str()) {
            return s.chars().take(180).collect();
        }
        if let Some(arr) = obj.get("content").and_then(|c| c.as_array()) {
            let joined: String = arr
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string())
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !joined.is_empty() {
                return joined.chars().take(180).collect();
            }
        }
    }
    let s = v.to_string();
    s.chars().take(180).collect()
}

fn format_duration_ms(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else {
        format!("{:.1}s", ms as f64 / 1000.0)
    }
}

fn get_json<T: for<'de> Deserialize<'de>>(cfg: &CloudConfig, url: &str) -> Result<T, String> {
    let response = ureq::get(url)
        .set("Authorization", &format!("Bearer {}", cfg.token))
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?;
    let status = response.status();
    let body = response
        .into_string()
        .map_err(|e| format!("read body: {e}"))?;
    if !(200..300).contains(&status) {
        let snippet: String = body.chars().take(240).collect();
        return Err(format!("HTTP {status}: {snippet}"));
    }
    serde_json::from_str(&body).map_err(|e| {
        format!(
            "json: {e}; body={}",
            body.chars().take(120).collect::<String>()
        )
    })
}

fn urlencoding_lite(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
