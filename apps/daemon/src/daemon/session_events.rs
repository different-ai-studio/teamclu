use crate::proto::teamclu::IdeaEvent;

pub(crate) fn format_idea_prompt(session_id: &str, event: &IdeaEvent) -> String {
    use crate::proto::teamclu::idea_event::Event;
    match &event.event {
        Some(Event::Created(item)) => format!(
            "[Collab session: {}] New idea: {} - {}",
            session_id, item.title, item.description
        ),
        Some(Event::Updated(item)) => format!(
            "[Collab session: {}] Idea updated: {}",
            session_id, item.title
        ),
        Some(Event::Claimed(claim)) => format!(
            "[Collab session: {}] Idea {} claimed by {}",
            session_id, claim.idea_id, claim.actor_id
        ),
        Some(Event::Submitted(sub)) => format!(
            "[Collab session: {}] Submission for {}: {}",
            session_id, sub.idea_id, sub.content
        ),
        None => String::new(),
    }
}

/// Extract the `mention_actor_ids` array from a cloud `messages.metadata`
/// JSON string. Returns an empty Vec when the field is absent or malformed.
pub(crate) fn is_mentioned_to(metadata_json: &str, my_actor: &str) -> bool {
    parse_mention_actor_ids(metadata_json)
        .iter()
        .any(|a| a == my_actor)
}

pub(crate) fn parse_mention_actor_ids(metadata_json: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(metadata_json)
        .ok()
        .and_then(|v| v.get("mention_actor_ids").cloned())
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
}

/// Prefer envelope mentions; fall back to message metadata when the envelope
/// field is empty (older clients or partial encodes).
pub(crate) fn resolve_mention_actor_ids(
    envelope_mentions: &[String],
    metadata_json: &str,
) -> Vec<String> {
    if !envelope_mentions.is_empty() {
        return envelope_mentions.to_vec();
    }
    parse_mention_actor_ids(metadata_json)
}

pub(crate) fn parse_attachment_urls(metadata_json: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(metadata_json)
        .ok()
        .and_then(|v| v.get("attachment_urls").cloned())
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
}

pub(crate) fn message_attachment_urls(message: &crate::proto::teamclu::Message) -> Vec<String> {
    if !message.attachment_urls.is_empty() {
        return message.attachment_urls.clone();
    }
    parse_attachment_urls(&message.metadata_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::teamclu;

    #[test]
    fn parse_mention_actor_ids_extracts_ids() {
        let json = r#"{"mention_actor_ids":["agent_X","agent_Y"]}"#;
        assert_eq!(
            parse_mention_actor_ids(json),
            vec!["agent_X".to_string(), "agent_Y".to_string()]
        );
    }

    #[test]
    fn parse_mention_actor_ids_returns_empty_for_empty_object() {
        assert!(parse_mention_actor_ids("{}").is_empty());
    }

    #[test]
    fn parse_mention_actor_ids_returns_empty_for_invalid_json() {
        assert!(parse_mention_actor_ids("not json").is_empty());
    }

    #[test]
    fn parse_mention_actor_ids_returns_empty_when_field_absent() {
        assert!(parse_mention_actor_ids(r#"{"other":"value"}"#).is_empty());
    }

    #[test]
    fn parse_mention_actor_ids_handles_empty_array() {
        assert!(parse_mention_actor_ids(r#"{"mention_actor_ids":[]}"#).is_empty());
    }

    #[test]
    fn resolve_mention_actor_ids_prefers_envelope() {
        let meta = r#"{"mention_actor_ids":["from-meta"]}"#;
        assert_eq!(
            resolve_mention_actor_ids(&["from-env".to_string()], meta),
            vec!["from-env".to_string()]
        );
    }

    #[test]
    fn resolve_mention_actor_ids_falls_back_to_metadata() {
        let meta = r#"{"mention_actor_ids":["from-meta"]}"#;
        assert_eq!(
            resolve_mention_actor_ids(&[], meta),
            vec!["from-meta".to_string()]
        );
    }

    #[test]
    fn format_idea_prompt_formats_created_event() {
        let event = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Created(teamclu::Idea {
                title: "Draft launch".to_string(),
                description: "Ship the beta".to_string(),
                ..Default::default()
            })),
        };

        assert_eq!(
            format_idea_prompt("sess-1", &event),
            "[Collab session: sess-1] New idea: Draft launch - Ship the beta"
        );
    }

    #[test]
    fn format_idea_prompt_formats_updated_event() {
        let event = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Updated(teamclu::Idea {
                title: "Revised scope".to_string(),
                ..Default::default()
            })),
        };

        assert_eq!(
            format_idea_prompt("sess-1", &event),
            "[Collab session: sess-1] Idea updated: Revised scope"
        );
    }

    #[test]
    fn format_idea_prompt_formats_claimed_event() {
        let event = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Claimed(teamclu::Claim {
                idea_id: "idea-1".to_string(),
                actor_id: "agent-1".to_string(),
                ..Default::default()
            })),
        };

        assert_eq!(
            format_idea_prompt("sess-1", &event),
            "[Collab session: sess-1] Idea idea-1 claimed by agent-1"
        );
    }

    #[test]
    fn format_idea_prompt_formats_submitted_event() {
        let event = teamclu::IdeaEvent {
            event: Some(teamclu::idea_event::Event::Submitted(teamclu::Submission {
                idea_id: "idea-1".to_string(),
                content: "Done".to_string(),
                ..Default::default()
            })),
        };

        assert_eq!(
            format_idea_prompt("sess-1", &event),
            "[Collab session: sess-1] Submission for idea-1: Done"
        );
    }

    #[test]
    fn format_idea_prompt_returns_empty_for_missing_event() {
        assert_eq!(
            format_idea_prompt("sess-1", &teamclu::IdeaEvent { event: None }),
            ""
        );
    }
}
