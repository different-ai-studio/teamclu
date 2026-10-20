//! Message-derived runtime cursor helpers (Plan A).
//!
//! `last_processed_message_id` tracks the last inbound user message routed to
//! the runtime. These helpers reconcile that cursor against conversation
//! facts: an @mention is "answered" when a later message from the agent actor
//! exists in the thread.

use crate::backend::StoredMessage;
use crate::daemon::session_events::is_mentioned_to;

/// Message ids are UUIDs and compare case-insensitively: a cursor taken from
/// an upper-case MQTT id must still find its lower-case persisted row (#1696).
pub(crate) fn message_index(messages: &[StoredMessage], id: &str) -> Option<usize> {
    messages.iter().position(|m| m.id.eq_ignore_ascii_case(id))
}

/// Later of two cursor ids by position in `messages` (API sort order).
pub(crate) fn later_cursor_id(
    messages: &[StoredMessage],
    a: Option<&str>,
    b: Option<&str>,
) -> Option<String> {
    let idx_a = a.and_then(|id| message_index(messages, id));
    let idx_b = b.and_then(|id| message_index(messages, id));
    match (idx_a, idx_b) {
        (Some(ia), Some(ib)) => Some(if ia >= ib {
            messages[ia].id.clone()
        } else {
            messages[ib].id.clone()
        }),
        (Some(ia), None) => Some(messages[ia].id.clone()),
        (None, Some(ib)) => Some(messages[ib].id.clone()),
        (None, None) => None,
    }
}

pub(crate) fn has_agent_reply_after(
    messages: &[StoredMessage],
    after_idx: usize,
    my_actor: &str,
) -> bool {
    messages
        .get(after_idx + 1..)
        .is_some_and(|tail| tail.iter().any(|m| m.sender_actor_id == my_actor))
}

/// Last inbound @mention to `my_actor` that already has an agent reply after it.
pub(crate) fn compute_effective_cursor_from_messages(
    messages: &[StoredMessage],
    my_actor: &str,
    floor: Option<&str>,
) -> Option<String> {
    let mut answered_last: Option<&str> = None;
    for (idx, m) in messages.iter().enumerate() {
        if m.sender_actor_id == my_actor {
            continue;
        }
        if !is_mentioned_to(&m.metadata_json, my_actor) {
            continue;
        }
        if has_agent_reply_after(messages, idx, my_actor) {
            answered_last = Some(m.id.as_str());
        }
    }
    later_cursor_id(messages, answered_last, floor)
}

/// Last index in `messages` with an inbound @mention that still needs a turn.
pub(crate) fn last_unanswered_mention_idx(
    messages: &[StoredMessage],
    my_actor: &str,
) -> Option<usize> {
    messages.iter().enumerate().rev().find_map(|(idx, m)| {
        if m.sender_actor_id == my_actor {
            return None;
        }
        if !is_mentioned_to(&m.metadata_json, my_actor) {
            return None;
        }
        if has_agent_reply_after(messages, idx, my_actor) {
            return None;
        }
        Some(idx)
    })
}

/// Rows strictly after `cursor` in API sort order. Unknown cursor → full slice.
pub(crate) fn messages_strictly_after_cursor(
    messages: &[StoredMessage],
    cursor: Option<&str>,
) -> Vec<StoredMessage> {
    let Some(cursor_id) = cursor.filter(|s| !s.is_empty()) else {
        return messages.to_vec();
    };
    let Some(idx) = message_index(messages, cursor_id) else {
        return messages.to_vec();
    };
    messages
        .get(idx + 1..)
        .map(|s| s.to_vec())
        .unwrap_or_default()
}

/// Whether any inbound row in the slice still needs routing (unanswered @ or silent).
pub(crate) fn slice_has_actionable_inbound(messages: &[StoredMessage], my_actor: &str) -> bool {
    messages.iter().any(|m| {
        if m.sender_actor_id == my_actor {
            return false;
        }
        if is_mentioned_to(&m.metadata_json, my_actor) {
            let Some(idx) = message_index(messages, &m.id) else {
                return true;
            };
            return !has_agent_reply_after(messages, idx, my_actor);
        }
        true
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, sender: &str, mentions: &[&str], created_at: i64) -> StoredMessage {
        let mention_json: Vec<String> = mentions.iter().map(|s| (*s).to_string()).collect();
        StoredMessage {
            id: id.to_string(),
            session_id: "s1".to_string(),
            sender_actor_id: sender.to_string(),
            kind: "text".to_string(),
            content: id.to_string(),
            metadata_json: serde_json::json!({ "mention_actor_ids": mention_json }).to_string(),
            created_at,
        }
    }

    #[test]
    fn effective_cursor_uses_last_answered_mention() {
        let msgs = vec![
            row("u1", "human", &["agent"], 1),
            row("a1", "agent", &[], 2),
            row("u2", "human", &["agent"], 3),
            row("a2", "agent", &[], 4),
        ];
        assert_eq!(
            compute_effective_cursor_from_messages(&msgs, "agent", None).as_deref(),
            Some("u2")
        );
    }

    #[test]
    fn effective_cursor_respects_floor_when_ahead() {
        let msgs = vec![
            row("u1", "human", &["agent"], 1),
            row("a1", "agent", &[], 2),
        ];
        assert_eq!(
            compute_effective_cursor_from_messages(&msgs, "agent", Some("u1")).as_deref(),
            Some("u1")
        );
    }

    #[test]
    fn last_unanswered_mention_skips_answered() {
        let msgs = vec![
            row("u1", "human", &["agent"], 1),
            row("a1", "agent", &[], 2),
            row("u2", "human", &["agent"], 3),
        ];
        assert_eq!(last_unanswered_mention_idx(&msgs, "agent"), Some(2));
    }

    #[test]
    fn messages_after_cursor_excludes_through_cursor_id() {
        let msgs = vec![
            row("u1", "human", &["agent"], 1),
            row("a1", "agent", &[], 2),
            row("u2", "human", &["agent"], 3),
        ];
        let tail = messages_strictly_after_cursor(&msgs, Some("u1"));
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].id, "a1");
        assert_eq!(tail[1].id, "u2");
    }

    #[test]
    fn messages_after_cursor_matches_cursor_case_insensitively() {
        let msgs = vec![
            row(
                "76f88f18-cb4c-49f0-a4a1-b08c9f81b583",
                "human",
                &["agent"],
                1,
            ),
            row("a1", "agent", &[], 2),
        ];
        let tail =
            messages_strictly_after_cursor(&msgs, Some("76F88F18-CB4C-49F0-A4A1-B08C9F81B583"));
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].id, "a1");
    }

    #[test]
    fn slice_not_actionable_when_only_answered_mentions() {
        let msgs = vec![
            row("u1", "human", &["agent"], 1),
            row("a1", "agent", &[], 2),
        ];
        assert!(!slice_has_actionable_inbound(&msgs, "agent"));
    }
}
