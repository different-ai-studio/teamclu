//! Per-session system prompt for managed agent backends (Pi v1).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::backend::{Backend, SessionRoster, SessionRosterEntry, SessionRosterSelfAgent};
use crate::runtime::RuntimeManager;

/// One seat in the session roster surfaced to the Pi extension.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptParticipant {
    pub actor_id: String,
    pub display_name: String,
    pub kind: Option<String>,
    pub is_self: bool,
}

/// Loopback response for `POST /internal/runtime-context/session-prompt`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptResponse {
    pub teamclu_session_id: String,
    pub runtime_id: String,
    pub agent_display_name: String,
    pub participants: Vec<SessionPromptParticipant>,
    pub append_system_prompt: String,
    /// False when roster data was unavailable or incomplete; callers must not
    /// cache or inject a prompt for this host generation.
    pub roster_resolved: bool,
}

pub struct SessionPromptService {
    manager: Arc<tokio::sync::Mutex<RuntimeManager>>,
    backend: Arc<dyn Backend>,
}

impl SessionPromptService {
    pub fn new(manager: Arc<tokio::sync::Mutex<RuntimeManager>>, backend: Arc<dyn Backend>) -> Self {
        Self { manager, backend }
    }

    pub async fn build_for_resolved(
        &self,
        teamclu_session_id: &str,
        runtime_id: &str,
    ) -> SessionPromptResponse {
        let owner_actor_id = {
            let mgr = self.manager.lock().await;
            mgr.get_handle(runtime_id)
                .map(|h| h.owner_actor_id.clone())
                .unwrap_or_default()
        };
        let owner_trimmed = owner_actor_id.trim();

        let base = SessionPromptResponse {
            teamclu_session_id: teamclu_session_id.to_string(),
            runtime_id: runtime_id.to_string(),
            agent_display_name: agent_display_name_fallback(owner_trimmed),
            participants: Vec::new(),
            append_system_prompt: String::new(),
            roster_resolved: false,
        };

        let roster = match self.backend.get_session_roster(teamclu_session_id).await {
            Ok(roster) => roster,
            Err(err) => {
                warn!(
                    event = "runtime_context_session_prompt",
                    teamclu_session_id,
                    runtime_id,
                    error = %err,
                    "session roster fetch failed; skipping session prompt injection"
                );
                return base;
            }
        };

        let Some(agent_display_name) =
            resolve_agent_display_name_from_roster(&roster, owner_trimmed)
        else {
            warn!(
                event = "runtime_context_session_prompt",
                teamclu_session_id,
                runtime_id,
                "session roster missing agent display name; skipping session prompt injection"
            );
            return base;
        };

        let participants =
            roster_to_participants(&roster, owner_trimmed, &agent_display_name);
        if participants.is_empty() {
            warn!(
                event = "runtime_context_session_prompt",
                teamclu_session_id,
                runtime_id,
                "session roster empty; skipping session prompt injection"
            );
            return base;
        }

        let brand = teamclu_runtime_env::brand_display_name_from_env();
        let host_label = crate::config::daemon_machine_hostname();
        let append_system_prompt = build_session_prompt(
            &brand,
            roster.title.as_deref(),
            &host_label,
            &agent_display_name,
            roster.self_agent.as_ref(),
            &participants,
        );

        SessionPromptResponse {
            agent_display_name,
            participants,
            append_system_prompt,
            roster_resolved: true,
            ..base
        }
    }
}

fn resolve_agent_display_name_from_roster(
    roster: &SessionRoster,
    owner_actor_id: &str,
) -> Option<String> {
    if let Some(name) = roster_entry_display_name(roster.items.iter().find(|item| item.is_self)) {
        return Some(name);
    }
    if !owner_actor_id.is_empty() {
        if let Some(item) = roster
            .items
            .iter()
            .find(|item| item.actor_id == owner_actor_id)
        {
            if let Some(name) = roster_entry_display_name(Some(item)) {
                return Some(name);
            }
        }
    }
    None
}

fn roster_to_participants(
    roster: &SessionRoster,
    owner_actor_id: &str,
    agent_display_name: &str,
) -> Vec<SessionPromptParticipant> {
    roster
        .items
        .iter()
        .map(|item| {
            let is_self = (!owner_actor_id.is_empty() && item.actor_id == owner_actor_id)
                || item.is_self;
            SessionPromptParticipant {
                actor_id: item.actor_id.clone(),
                display_name: if is_self {
                    agent_display_name.to_string()
                } else {
                    display_label(&item.actor_id, item.display_name.as_deref())
                },
                kind: item.kind.clone(),
                is_self,
            }
        })
        .collect()
}

fn roster_entry_display_name(item: Option<&SessionRosterEntry>) -> Option<String> {
    item.and_then(|entry| {
        entry
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
    })
}

fn agent_display_name_fallback(owner_actor_id: &str) -> String {
    if owner_actor_id.is_empty() {
        "this agent".to_string()
    } else {
        display_label(owner_actor_id, None)
    }
}

fn display_label(actor_id: &str, display_name: Option<&str>) -> String {
    display_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| actor_id_short_label(actor_id))
}

fn actor_id_short_label(actor_id: &str) -> String {
    let trimmed = actor_id.trim();
    if trimmed.len() <= 8 {
        trimmed.to_string()
    } else {
        trimmed[..8].to_string()
    }
}

fn kind_label(kind: Option<&str>) -> &str {
    match kind.map(str::trim).filter(|k| !k.is_empty()) {
        Some("member") => "member",
        Some("agent") => "agent",
        Some("external") => "external",
        Some(other) => other,
        None => "participant",
    }
}

fn append_holder_relationship(out: &mut String, self_agent: Option<&SessionRosterSelfAgent>) {
    let Some(meta) = self_agent else {
        return;
    };
    let visibility = meta.visibility.as_deref().unwrap_or("").trim();
    if visibility.eq_ignore_ascii_case("personal") {
        if let Some(owner) = meta
            .owner_display_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            out.push_str("You are the personal AI assistant of ");
            out.push_str(owner);
            out.push_str(
                ". You run on their machine and operate on their behalf in this session.\n\n",
            );
        } else {
            out.push_str(
                "You are a personal AI assistant bound to one member. \
You run on your holder's machine and operate on their behalf in this session.\n\n",
            );
        }
    } else if visibility.eq_ignore_ascii_case("team") {
        out.push_str(
            "You are a team-shared AI assistant available to the whole team. \
You run on this host machine for the team.\n\n",
        );
    }
}

pub fn build_session_prompt(
    brand_name: &str,
    session_title: Option<&str>,
    host_label: &str,
    agent_display_name: &str,
    self_agent: Option<&SessionRosterSelfAgent>,
    participants: &[SessionPromptParticipant],
) -> String {
    let brand = brand_name.trim();
    let brand = if brand.is_empty() { "this app" } else { brand };
    let host = host_label.trim();
    let host = if host.is_empty() { "this machine" } else { host };

    let mut out = String::from("[");
    out.push_str(brand);
    out.push_str(" Session Context]\n\n");

    if let Some(title) = session_title.map(str::trim).filter(|t| !t.is_empty()) {
        out.push_str("Topic: \"");
        out.push_str(title);
        out.push_str("\"\n\n");
    }

    out.push_str("You are \"");
    out.push_str(agent_display_name.trim());
    out.push_str("\", an AI assistant in a ");
    out.push_str(brand);
    out.push_str(" session.\n\n");

    out.push_str("Hosting: You run on the machine \"");
    out.push_str(host);
    out.push_str(
        "\". Your workspace files and tools are local to this host; \
other participants may be on different devices or machines.\n\n",
    );

    append_holder_relationship(&mut out, self_agent);

    out.push_str("Your display name is \"");
    out.push_str(agent_display_name.trim());
    out.push_str(
        "\". This is the name users assigned you in the UI; when someone @mentions you, \
they usually use this name or a close variant.\n\nParticipants:\n",
    );

    for p in participants {
        let role = kind_label(p.kind.as_deref());
        if p.is_self {
            out.push_str(&format!("- {} ({}, you)\n", p.display_name, role));
        } else {
            out.push_str(&format!("- {} ({})\n", p.display_name, role));
        }
    }
    out.push('\n');
    out.push_str("@mentions in messages indicate who the sender is addressing.");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn participant(
        actor_id: &str,
        display_name: &str,
        kind: Option<&str>,
        is_self: bool,
    ) -> SessionPromptParticipant {
        SessionPromptParticipant {
            actor_id: actor_id.to_string(),
            display_name: display_name.to_string(),
            kind: kind.map(str::to_string),
            is_self,
        }
    }

    fn roster(items: Vec<SessionRosterEntry>) -> SessionRoster {
        SessionRoster {
            session_id: "session-1".to_string(),
            caller_actor_id: "agent-mdc".to_string(),
            title: None,
            self_agent: None,
            items,
        }
    }

    fn personal_self_agent(owner: &str) -> SessionRosterSelfAgent {
        SessionRosterSelfAgent {
            visibility: Some("personal".to_string()),
            owner_member_id: Some("human-1".to_string()),
            owner_display_name: Some(owner.to_string()),
        }
    }

    #[test]
    fn build_session_prompt_includes_title_hosting_and_holder() {
        let text = build_session_prompt(
            "TeamClu",
            Some("Q3 客诉周报"),
            "MacBook-Pro",
            "MDC",
            Some(&personal_self_agent("港爷")),
            &[
                participant("agent-1", "MDC", Some("agent"), true),
                participant("human-1", "港爷", Some("member"), false),
            ],
        );
        assert!(text.contains("Topic: \"Q3 客诉周报\""));
        assert!(text.contains("Hosting: You run on the machine \"MacBook-Pro\""));
        assert!(text.contains("personal AI assistant of 港爷"));
        assert!(text.contains("operate on their behalf"));
        assert!(text.contains("- 港爷 (member)"));
        assert!(text.contains("- MDC (agent, you)"));
    }

    #[test]
    fn build_session_prompt_team_agent_skips_personal_holder_wording() {
        let text = build_session_prompt(
            "TeamClu",
            None,
            "Office-Mini",
            "研发助手",
            Some(&SessionRosterSelfAgent {
                visibility: Some("team".to_string()),
                owner_member_id: None,
                owner_display_name: None,
            }),
            &[participant("agent-1", "研发助手", Some("agent"), true)],
        );
        assert!(text.contains("team-shared AI assistant"));
        assert!(!text.contains("personal AI assistant"));
    }

    #[test]
    fn display_label_falls_back_to_actor_id_prefix() {
        assert_eq!(display_label("abcdef123456", None), "abcdef12");
        assert_eq!(display_label("short", None), "short");
        assert_eq!(display_label("id", Some("  Bob  ")), "Bob");
    }

    #[test]
    fn resolve_agent_display_name_from_roster_prefers_self_item() {
        let roster = roster(vec![
            SessionRosterEntry {
                actor_id: "agent-mdc".to_string(),
                display_name: Some("MDC".to_string()),
                kind: Some("agent".to_string()),
                is_self: true,
            },
            SessionRosterEntry {
                actor_id: "human-1".to_string(),
                display_name: Some("Alice".to_string()),
                kind: Some("member".to_string()),
                is_self: false,
            },
        ]);
        assert_eq!(
            resolve_agent_display_name_from_roster(&roster, "agent-mdc"),
            Some("MDC".to_string())
        );
    }

    #[test]
    fn resolve_agent_display_name_from_roster_returns_none_without_display_name() {
        let roster = roster(vec![]);
        assert_eq!(
            resolve_agent_display_name_from_roster(&roster, "abcdef123456"),
            None
        );
    }

    #[test]
    fn agent_display_name_fallback_defaults_when_owner_missing() {
        assert_eq!(agent_display_name_fallback(""), "this agent");
    }
}
