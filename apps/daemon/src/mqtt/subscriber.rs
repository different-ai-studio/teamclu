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
    /// `amux/{team}/{actor}/voice/mic` — an Opus 20 ms frame from a paired
    /// device. QoS 0. `payload` is raw Opus bytes; intent is *not* here, it
    /// arrives on `voice/ctl` `turn_start`. See `crate::voice::ctl`.
    VoiceMic {
        team_id: String,
        actor_id: String,
        payload: Vec<u8>,
    },
    /// `amux/{team}/{actor}/voice/ctl` — a parsed control JSON. QoS 1.
    VoiceCtl {
        team_id: String,
        actor_id: String,
        ctl: crate::voice::ctl::VoiceCtl,
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

    // Device voice topics: amux/{team}/{actor}/voice/{mic,ctl} (5 segments).
    // `voice/spk` is amuxd→device (outbound) and `voice/state` is retained
    // device→broker; neither is routed here. `voice/ctl` is parsed here so
    // the business loop sees a structured message, not raw JSON.
    if topic.starts_with("amux/") {
        let parts: Vec<&str> = topic.split('/').collect();
        if parts.len() == 5 && parts[3] == "voice" {
            let team_id = parts[1].to_string();
            let actor_id = parts[2].to_string();
            return match parts[4] {
                "mic" => Some(IncomingMessage::VoiceMic {
                    team_id,
                    actor_id,
                    payload: payload.clone(),
                }),
                "ctl" => match crate::voice::ctl::VoiceCtl::parse(payload) {
                    Ok(ctl) => Some(IncomingMessage::VoiceCtl {
                        team_id,
                        actor_id,
                        ctl,
                    }),
                    Err(e) => {
                        warn!(
                            team = %team_id,
                            actor = %actor_id,
                            error = %e,
                            "voice/ctl JSON parse failed; dropping"
                        );
                        None
                    }
                },
                _ => None,
            };
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
}
