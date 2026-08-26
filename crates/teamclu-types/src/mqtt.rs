/// Team-id stand-in used in MQTT topics when the device has no team yet.
///
/// This is a wire constant, not a brand string: it is a path segment in
/// `amux/<team>/<actor>/…` that a desktop daemon and an iOS app — which update
/// independently of each other — have to agree on. The teamclaw → teamclu
/// rebrand deliberately did not touch it. There is no migration available for a
/// rendezvous point (unlike on-disk state, neither side can rewrite the other),
/// so renaming it would silently stop every mixed-version, team-less device pair
/// from seeing each other's messages — no error, just silence.
///
/// The Swift mirror is `MQTTTopics.normalizedTeamID`; the two must stay equal.
pub const MQTT_FALLBACK_TEAM_ID: &str = "teamclaw";

/// Builds MQTT topic paths for a given team-scoped actor namespace.
#[derive(Clone, Debug)]
pub struct Topics {
    team_id: String,
    actor_id: String,
}

impl Topics {
    pub fn new(team_id: &str, actor_id: &str) -> Self {
        Self {
            team_id: team_id.to_string(),
            actor_id: actor_id.to_string(),
        }
    }

    fn actor_base(&self) -> String {
        format!("amux/{}/{}", self.team_id, self.actor_id)
    }

    /// RPC response topic for an arbitrary actor.
    pub fn rpc_res_for(&self, actor_id: &str) -> String {
        format!("amux/{}/{}/rpc/res", self.team_id, actor_id)
    }

    pub fn actor_rpc_req(&self) -> String {
        format!("{}/rpc/req", self.actor_base())
    }

    pub fn actor_rpc_res(&self) -> String {
        format!("{}/rpc/res", self.actor_base())
    }

    pub fn actor_notify(&self) -> String {
        format!("{}/notify", self.actor_base())
    }

    pub fn session_live(&self, session_id: &str) -> String {
        session_live(&self.team_id, session_id)
    }

    pub fn actor_state(&self) -> String {
        actor_state(&self.team_id, &self.actor_id)
    }

    pub fn runtime_commands(&self, runtime_id: &str) -> String {
        format!("{}/runtime/{}/commands", self.actor_base(), runtime_id)
    }

    pub fn runtime_state_wildcard(&self) -> String {
        format!("{}/runtime/+/state", self.actor_base())
    }

    pub fn runtime_commands_wildcard(&self) -> String {
        format!("{}/runtime/+/commands", self.actor_base())
    }

    pub fn user_notify(&self, actor_id: &str) -> String {
        format!("amux/{}/user/{}/notify", self.team_id, actor_id)
    }

    /// Team-scoped sync hint topic for a resource (resource segment last).
    pub fn sync(&self, resource: &str) -> String {
        sync_topic(&self.team_id, resource)
    }
}

pub fn session_live(team_id: &str, session_id: &str) -> String {
    format!("amux/{team_id}/session/{session_id}/live")
}

pub fn actor_state(team_id: &str, actor_id: &str) -> String {
    format!("amux/{team_id}/{actor_id}/state")
}

/// Sync hint topic: `amux/<team_id>/sync/<resource>`.
///
/// Resource is the last segment so a single ACL `amux/%s/sync/+` covers every
/// future resource without migration. Mirrored in FC (`mqtt-topics.ts`).
pub fn sync_topic(team_id: &str, resource: &str) -> String {
    format!("amux/{team_id}/sync/{resource}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_topic_functions_match_wire_paths() {
        assert_eq!(session_live("t1", "s1"), "amux/t1/session/s1/live");
        assert_eq!(actor_state("t1", "d1"), "amux/t1/d1/state");
        // Resource segment last so ACL `amux/%s/sync/+` covers future resources.
        assert_eq!(sync_topic("TEAM", "knowledge"), "amux/TEAM/sync/knowledge");
    }

    #[test]
    fn actor_topic_builder_matches_daemon_paths() {
        let t = Topics::new("team1", "actor-a");
        assert_eq!(t.actor_rpc_req(), "amux/team1/actor-a/rpc/req");
        assert_eq!(t.actor_rpc_res(), "amux/team1/actor-a/rpc/res");
        assert_eq!(t.actor_notify(), "amux/team1/actor-a/notify");
        assert_eq!(t.session_live("s1"), "amux/team1/session/s1/live");
        assert_eq!(t.actor_state(), "amux/team1/actor-a/state");
        assert_eq!(
            t.runtime_commands("r1"),
            "amux/team1/actor-a/runtime/r1/commands"
        );
        assert_eq!(
            t.runtime_state_wildcard(),
            "amux/team1/actor-a/runtime/+/state"
        );
        assert_eq!(
            t.runtime_commands_wildcard(),
            "amux/team1/actor-a/runtime/+/commands"
        );
        assert_eq!(t.rpc_res_for("actor-b"), "amux/team1/actor-b/rpc/res");
        assert_eq!(
            t.user_notify("actor-xyz"),
            "amux/team1/user/actor-xyz/notify"
        );
        assert_eq!(t.sync("knowledge"), "amux/team1/sync/knowledge");
    }
}
