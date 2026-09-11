use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::proto::teamclu;

/// In-memory session metadata cache for the daemon process.
///
/// There is no on-disk index (`index.toml` was removed): Cloud API is the source
/// of truth; this store only holds rows the running daemon has touched.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TeamcluSessionStore {
    #[serde(default)]
    pub sessions: Vec<StoredSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    pub session_id: String,
    pub team_id: String,
    pub title: String,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub summary: String,
    #[serde(default)]
    pub idea_id: String,
    #[serde(default)]
    pub participants: Vec<StoredParticipant>,
    /// The host's primary agent_id when this session was created. Used to
    /// populate `SessionInfo.primary_agent_id` so clients know which agent
    /// receives messages by default. Empty for sessions created when no
    /// agent was running, for non-host views, or for pre-Plan-6 sessions.
    #[serde(default)]
    pub primary_agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredParticipant {
    pub actor_id: String,
    pub actor_type: String,
    pub display_name: String,
    pub joined_at: DateTime<Utc>,
}

impl TeamcluSessionStore {
    pub fn upsert(&mut self, session: StoredSession) {
        if let Some(existing) = self
            .sessions
            .iter_mut()
            .find(|s| s.session_id == session.session_id)
        {
            *existing = session;
        } else {
            self.sessions.push(session);
        }
    }

    pub fn find_by_id(&self, session_id: &str) -> Option<&StoredSession> {
        self.sessions.iter().find(|s| s.session_id == session_id)
    }

    pub fn find_by_id_mut(&mut self, session_id: &str) -> Option<&mut StoredSession> {
        self.sessions
            .iter_mut()
            .find(|s| s.session_id == session_id)
    }

    #[allow(dead_code)]
    pub fn remove(&mut self, session_id: &str) -> bool {
        let len = self.sessions.len();
        self.sessions.retain(|s| s.session_id != session_id);
        self.sessions.len() < len
    }

    pub fn to_proto_session_info(&self, session_id: &str) -> Option<teamclu::SessionInfo> {
        self.find_by_id(session_id).map(|s| {
            let participants = s
                .participants
                .iter()
                .map(|p| teamclu::Participant {
                    actor_id: p.actor_id.clone(),
                    actor_type: actor_type_to_proto(&p.actor_type) as i32,
                    display_name: p.display_name.clone(),
                    joined_at: p.joined_at.timestamp(),
                })
                .collect();
            teamclu::SessionInfo {
                session_id: s.session_id.clone(),
                // session_type is a deprecated proto field — every iOS-created
                // session is a single kind now. Stamp UNKNOWN (0) for back-compat.
                session_type: teamclu::SessionType::Unknown as i32,
                team_id: s.team_id.clone(),
                title: s.title.clone(),
                created_by: s.created_by.clone(),
                created_at: s.created_at.timestamp(),
                participants,
                summary: s.summary.clone(),
                primary_agent_id: s.primary_agent_id.clone(),
                idea_id: s.idea_id.clone(),
                last_message_preview: String::new(),
                last_message_at: 0,
            }
        })
    }
}

fn actor_type_to_proto(s: &str) -> teamclu::ActorType {
    match s {
        "human" => teamclu::ActorType::Human,
        "personal_agent" => teamclu::ActorType::PersonalAgent,
        "role_agent" => teamclu::ActorType::RoleAgent,
        _ => teamclu::ActorType::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn make_session(id: &str, _session_type: &str) -> StoredSession {
        StoredSession {
            session_id: id.to_string(),
            team_id: "team1".to_string(),
            title: format!("Session {}", id),
            created_by: "user1".to_string(),
            created_at: Utc::now(),
            summary: String::new(),
            idea_id: String::new(),
            participants: vec![],
            primary_agent_id: String::new(),
        }
    }

    fn make_participant(actor_id: &str, actor_type: &str) -> StoredParticipant {
        StoredParticipant {
            actor_id: actor_id.to_string(),
            actor_type: actor_type.to_string(),
            display_name: actor_id.to_string(),
            joined_at: Utc::now(),
        }
    }

    #[test]
    fn test_upsert_insert() {
        let mut store = TeamcluSessionStore::default();
        store.upsert(make_session("s1", "collab"));
        assert_eq!(store.sessions.len(), 1);
        assert_eq!(store.sessions[0].session_id, "s1");
    }

    #[test]
    fn test_upsert_update() {
        let mut store = TeamcluSessionStore::default();
        store.upsert(make_session("s1", "collab"));
        let mut updated = make_session("s1", "collab");
        updated.title = "Updated Title".to_string();
        store.upsert(updated);
        assert_eq!(store.sessions.len(), 1);
        assert_eq!(store.sessions[0].title, "Updated Title");
    }

    #[test]
    fn test_find_by_id() {
        let mut store = TeamcluSessionStore::default();
        store.upsert(make_session("s1", "collab"));
        store.upsert(make_session("s2", "control"));
        assert!(store.find_by_id("s1").is_some());
        assert!(store.find_by_id("s3").is_none());
    }

    #[test]
    fn test_remove() {
        let mut store = TeamcluSessionStore::default();
        store.upsert(make_session("s1", "collab"));
        store.upsert(make_session("s2", "control"));
        assert!(store.remove("s1"));
        assert_eq!(store.sessions.len(), 1);
        assert!(!store.remove("s1")); // already removed
    }

    #[test]
    fn test_to_proto_session_info() {
        let mut store = TeamcluSessionStore::default();
        let mut s = make_session("s1", "collab");
        s.participants = vec![make_participant("p1", "human")];
        s.summary = "test summary".to_string();
        store.upsert(s);

        let info = store.to_proto_session_info("s1").unwrap();
        assert_eq!(info.session_id, "s1");
        assert_eq!(info.summary, "test summary");
        assert_eq!(info.participants.len(), 1);

        assert!(store.to_proto_session_info("nonexistent").is_none());
    }
}
