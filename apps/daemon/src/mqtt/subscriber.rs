use prost::Message;
use rumqttc::Publish;
use teamclu_transport::IncomingFrame;
use tracing::warn;

use crate::proto::amux;

pub enum IncomingMessage {
    // Decoded from amux/{team}/{actor}/runtime/+/commands.
    RuntimeCommand {
        /// Target agent actor from the topic (`parts[2]`).
        actor_id: String,
        runtime_id: String,
        envelope: amux::RuntimeCommandEnvelope,
    },
    TeamcluRpc {
        topic: String,
        payload: Vec<u8>,
    },
    TeamcluRpcResponse {
        topic: String,
        payload: Vec<u8>,
    },
    TeamcluNotify {
        actor_id: String,
        payload: Vec<u8>,
    },
    TeamcluSessionLive {
        session_id: String,
        payload: Vec<u8>,
    },
    /// Team-scoped sync hint: `amux/{team}/sync/{resource}`.
    SyncHint {
        team_id: String,
        resource: String,
        payload: Vec<u8>,
    },
}

pub fn parse_incoming(publish: &Publish) -> Option<IncomingMessage> {
    parse_frame(&IncomingFrame {
        topic: publish.topic.clone(),
        payload: publish.payload.to_vec(),
        retained: publish.retain,
    })
}

pub fn parse_frame(frame: &IncomingFrame) -> Option<IncomingMessage> {
    let topic = &frame.topic;
    let payload = &frame.payload;

    if topic.starts_with("amux/") && topic.ends_with("/rpc/req") {
        return Some(IncomingMessage::TeamcluRpc {
            topic: topic.clone(),
            payload: payload.clone(),
        });
    }

    if topic.starts_with("amux/") && topic.ends_with("/rpc/res") {
        return Some(IncomingMessage::TeamcluRpcResponse {
            topic: topic.clone(),
            payload: payload.clone(),
        });
    }

    // Team-scoped collaboration live topic: amux/{team}/session/{sid}/live.
    if topic.starts_with("amux/") {
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() == 5 && parts[2] == "session" && parts[4] == "live" {
            return Some(IncomingMessage::TeamcluSessionLive {
                session_id: parts[3].to_string(),
                payload: payload.clone(),
            });
        }
    }

    // Actor notify: amux/{team}/{actor}/notify (4 segments).
    if topic.starts_with("amux/") && topic.ends_with("/notify") {
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() == 4 {
            return Some(IncomingMessage::TeamcluNotify {
                actor_id: parts[2].to_string(),
                payload: payload.clone(),
            });
        }
    }

    // Sync hint: amux/{team}/sync/{resource} (4 segments). Unknown resources
    // are ignored so an older daemon does not log on future topic families.
    if topic.starts_with("amux/") {
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() == 4 && parts[2] == "sync" {
            let resource = parts[3];
            if resource == "knowledge" {
                return Some(IncomingMessage::SyncHint {
                    team_id: parts[1].to_string(),
                    resource: resource.to_string(),
                    payload: payload.clone(),
                });
            }
            return None;
        }
    }

    if topic.contains("/runtime/") && topic.ends_with("/commands") {
        let parts: Vec<&str> = topic.split('/').collect();
        // amux / {team} / {actor} / runtime / {runtime_id} / commands
        // = 6 segments
        if parts.len() == 6 && parts[3] == "runtime" {
            let actor_id = parts[2].to_string();
            let runtime_id = parts[4].to_string();
            match amux::RuntimeCommandEnvelope::decode(payload.as_slice()) {
                Ok(envelope) => {
                    return Some(IncomingMessage::RuntimeCommand {
                        actor_id,
                        runtime_id,
                        envelope,
                    });
                }
                Err(e) => warn!("failed to decode RuntimeCommandEnvelope: {}", e),
            }
        }
    }

    None
}

/// Extract the protocol-level id used to deduplicate MQTT redeliveries. A
/// local durable queue id is intentionally not used here: it changes every
/// time the broker redelivers the same packet.
pub fn stable_message_id(frame: &IncomingFrame) -> Option<String> {
    if frame.topic.ends_with("/rpc/req") {
        return teamclu_proto::teamclu::RpcRequest::decode(frame.payload.as_slice())
            .ok()
            .map(|request| request.request_id)
            .filter(|id| !id.is_empty());
    }
    if frame.topic.contains("/session/") && frame.topic.ends_with("/live") {
        if let Ok(envelope) =
            teamclu_proto::teamclu::LiveEventEnvelope::decode(frame.payload.as_slice())
        {
            if !envelope.event_id.is_empty() {
                return Some(envelope.event_id);
            }
            if let Ok(message) =
                teamclu_proto::teamclu::SessionMessageEnvelope::decode(envelope.body.as_slice())
            {
                return message
                    .message
                    .map(|message| message.message_id)
                    .filter(|id| !id.is_empty());
            }
        }
        return None;
    }
    if frame.topic.ends_with("/notify") {
        return teamclu_proto::teamclu::SessionMessageEnvelope::decode(frame.payload.as_slice())
            .ok()
            .and_then(|envelope| envelope.message)
            .map(|message| message.message_id)
            .filter(|id| !id.is_empty());
    }
    if frame.topic.contains("/runtime/") && frame.topic.ends_with("/commands") {
        return amux::RuntimeCommandEnvelope::decode(frame.payload.as_slice())
            .ok()
            .map(|envelope| envelope.command_id)
            .filter(|id| !id.is_empty());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message as ProstMessage;
    use rumqttc::Publish;

    #[test]
    fn parse_runtime_commands_routes_to_new_variant() {
        let envelope = amux::RuntimeCommandEnvelope {
            runtime_id: "rt1".to_string(),
            actor_id: "actor-a".to_string(),
            ..Default::default()
        };
        let p = Publish::new(
            "amux/team1/actor-a/runtime/rt1/commands",
            rumqttc::QoS::AtLeastOnce,
            envelope.encode_to_vec(),
        );
        let msg = parse_incoming(&p).expect("should parse");
        match msg {
            IncomingMessage::RuntimeCommand {
                actor_id,
                runtime_id,
                ..
            } => {
                assert_eq!(actor_id, "actor-a");
                assert_eq!(runtime_id, "rt1");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parse_sync_knowledge_hint() {
        let payload = br#"{"v":1,"changeSeq":42,"originNodeId":"n1"}"#.to_vec();
        let frame = IncomingFrame {
            topic: "amux/team-a/sync/knowledge".to_string(),
            payload: payload.clone(),
            retained: false,
        };
        match parse_frame(&frame).expect("should parse") {
            IncomingMessage::SyncHint {
                team_id,
                resource,
                payload: got,
            } => {
                assert_eq!(team_id, "team-a");
                assert_eq!(resource, "knowledge");
                assert_eq!(got, payload);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parse_sync_unknown_resource_is_ignored() {
        let frame = IncomingFrame {
            topic: "amux/team-a/sync/skills".to_string(),
            payload: br#"{"v":1,"changeSeq":1}"#.to_vec(),
            retained: false,
        };
        assert!(parse_frame(&frame).is_none());
    }

    #[test]
    fn parse_sync_wrong_segment_count_is_ignored() {
        let frame = IncomingFrame {
            topic: "amux/team-a/sync/knowledge/extra".to_string(),
            payload: br#"{}"#.to_vec(),
            retained: false,
        };
        assert!(parse_frame(&frame).is_none());
    }
}
