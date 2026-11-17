use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
pub struct MemberStore {
    #[serde(default)]
    pub members: Vec<StoredMember>,
    #[serde(default)]
    pub pending_invites: Vec<PendingInvite>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMember {
    pub member_id: String,
    pub display_name: String,
    pub role: String,
    pub token: String,
    pub joined_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub department: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingInvite {
    pub invite_token: String,
    pub display_name: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    #[serde(default = "default_role")]
    pub role: String,
}

fn default_role() -> String {
    "member".into()
}

impl StoredMember {
    pub fn is_owner(&self) -> bool {
        self.role == "owner"
    }
}

impl PendingInvite {
    pub fn is_expired(&self) -> bool {
        Utc::now() > self.expires_at
    }
}

impl MemberStore {
    #[allow(dead_code)]
    pub fn default_path() -> PathBuf {
        super::layout::active_state_dir().join("members.toml")
    }

    pub fn load(path: &Path) -> crate::error::Result<Self> {
        if !path.exists() {
            return Ok(Self {
                members: vec![],
                pending_invites: vec![],
            });
        }
        let content = std::fs::read_to_string(path).map_err(|e| {
            crate::error::AmuxError::Config(format!("read {}: {}", path.display(), e))
        })?;
        toml::from_str(&content).map_err(|e| {
            crate::error::AmuxError::Config(format!("parse {}: {}", path.display(), e))
        })
    }

    pub fn save(&self, path: &Path) -> crate::error::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| crate::error::AmuxError::Config(e.to_string()))?;
        super::atomic_file::write(path, &content)?;
        Ok(())
    }

    pub fn find_member_by_token(&self, token: &str) -> Option<&StoredMember> {
        self.members.iter().find(|m| m.token == token)
    }

    pub fn find_pending_invite(&self, token: &str) -> Option<&PendingInvite> {
        self.pending_invites
            .iter()
            .find(|i| i.invite_token == token && !i.is_expired())
    }

    pub fn add_member(&mut self, member: StoredMember) {
        self.members.push(member);
    }

    pub fn remove_member(&mut self, member_id: &str) -> bool {
        let len = self.members.len();
        self.members.retain(|m| m.member_id != member_id);
        self.members.len() < len
    }

    pub fn consume_invite(&mut self, token: &str) -> Option<PendingInvite> {
        if let Some(pos) = self
            .pending_invites
            .iter()
            .position(|i| i.invite_token == token)
        {
            Some(self.pending_invites.remove(pos))
        } else {
            None
        }
    }

    pub fn add_invite(&mut self, invite: PendingInvite) {
        self.pending_invites.push(invite);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn sample_member(member_id: &str, department: Option<&str>) -> StoredMember {
        StoredMember {
            member_id: member_id.to_string(),
            display_name: format!("Member {}", member_id),
            role: "member".into(),
            token: format!("tok-{}", member_id),
            joined_at: Utc.with_ymd_and_hms(2026, 4, 17, 12, 0, 0).unwrap(),
            department: department.map(|s| s.to_string()),
        }
    }

    #[test]
    fn toml_roundtrip_with_department() {
        let store = MemberStore {
            members: vec![sample_member("alice", Some("Engineering"))],
            pending_invites: vec![],
        };
        let serialized = toml::to_string_pretty(&store).unwrap();
        assert!(
            serialized.contains("department = \"Engineering\""),
            "serialized:\n{serialized}"
        );

        let parsed: MemberStore = toml::from_str(&serialized).unwrap();
        assert_eq!(parsed.members[0].department.as_deref(), Some("Engineering"));
    }

    #[test]
    fn toml_roundtrip_without_department() {
        let store = MemberStore {
            members: vec![sample_member("bob", None)],
            pending_invites: vec![],
        };
        let serialized = toml::to_string_pretty(&store).unwrap();
        assert!(
            !serialized.contains("department"),
            "department should be omitted when None; got:\n{serialized}"
        );

        let parsed: MemberStore = toml::from_str(&serialized).unwrap();
        assert!(parsed.members[0].department.is_none());
    }

    #[test]
    fn loads_old_toml_without_department_field() {
        // Simulates members.toml written before the department field existed.
        let legacy_toml = r#"
[[members]]
member_id = "carol"
display_name = "Carol"
role = "owner"
token = "tok-carol"
joined_at = "2026-01-01T00:00:00Z"
"#;
        let parsed: MemberStore = toml::from_str(legacy_toml).unwrap();
        assert_eq!(parsed.members.len(), 1);
        assert_eq!(parsed.members[0].department, None);
    }
}
