//! Serialized business command boundary for transport-originated work.
//!
//! The MQTT worker never enters this module. It only persists an inbound frame
//! and forwards an envelope. Keeping the executor as a small owner-facing
//! adapter makes the transport boundary explicit while preserving the daemon's
//! existing single-owner ordering for `DaemonServer` state.

use std::time::{Duration, Instant};

use prost::Message;
use tracing::{error, warn};

use crate::mqtt::{MqttInbound, MqttInboundDisposition, MqttSupervisor};

use super::DaemonServer;

pub(crate) struct DaemonCommandExecutor<'a> {
    server: &'a mut DaemonServer,
}

/// Result of the business side of a durable inbound message. The transport
/// layer owns the durable ACK, so handlers must not ACK MQTT frames directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HandlerOutcome {
    Success,
    Retryable { reason: String },
    Permanent { reason: String },
}

impl<'a> DaemonCommandExecutor<'a> {
    pub(crate) fn new(server: &'a mut DaemonServer) -> Self {
        Self { server }
    }

    /// Execute one durable MQTT envelope while retaining the daemon's
    /// single-owner ordering. The transport worker remains free to poll and
    /// reconnect while this future is running.
    pub(crate) async fn execute_mqtt(
        &mut self,
        envelope: MqttInbound,
        supervisor: &MqttSupervisor,
    ) -> HandlerOutcome {
        let started = Instant::now();
        let id = envelope.id;
        let outcome = if let Some(message) = crate::mqtt::subscriber::parse_frame(&envelope.frame) {
            if let Err(reason) = validate_inbound_message(&message) {
                HandlerOutcome::Permanent { reason }
            } else {
                // Do not cancel a side-effecting handler at an arbitrary wall-clock
                // boundary. Its HTTP/RPC clients own their cancellation and retry
                // semantics; cancelling here could replay a partially applied command.
                self.server.handle_incoming(message).await
            }
        } else {
            HandlerOutcome::Permanent {
                reason: "unsupported or malformed MQTT inbound frame".to_string(),
            }
        };

        let duration = started.elapsed();
        if duration >= Duration::from_secs(10) {
            error!(
                command_id = id,
                source = "mqtt",
                duration_ms = duration.as_millis() as u64,
                "MQTT business command exceeded 10s"
            );
        } else if duration >= Duration::from_secs(5) {
            warn!(
                command_id = id,
                source = "mqtt",
                duration_ms = duration.as_millis() as u64,
                "MQTT business command exceeded 5s"
            );
        }

        let disposition = match &outcome {
            HandlerOutcome::Success => MqttInboundDisposition::Ack,
            HandlerOutcome::Retryable { .. } => MqttInboundDisposition::Retry,
            HandlerOutcome::Permanent { reason } => MqttInboundDisposition::DeadLetter {
                reason: reason.clone(),
            },
        };
        supervisor.dispose_inbound(id, disposition).await;
        outcome
    }
}

fn validate_inbound_message(
    message: &crate::mqtt::subscriber::IncomingMessage,
) -> Result<(), String> {
    use crate::mqtt::subscriber::IncomingMessage;
    match message {
        IncomingMessage::RuntimeCommand { .. } => Ok(()),
        IncomingMessage::TeamcluRpc { payload, .. } => {
            crate::proto::teamclu::RpcRequest::decode(payload.as_slice())
                .map(|_| ())
                .map_err(|error| format!("invalid RpcRequest: {error}"))
        }
        IncomingMessage::TeamcluRpcResponse { payload, .. } => {
            crate::proto::teamclu::RpcResponse::decode(payload.as_slice())
                .map(|_| ())
                .map_err(|error| format!("invalid RpcResponse: {error}"))
        }
        IncomingMessage::TeamcluSessionLive { payload, .. } => {
            crate::proto::teamclu::LiveEventEnvelope::decode(payload.as_slice())
                .map(|_| ())
                .map_err(|error| format!("invalid LiveEventEnvelope: {error}"))
        }
        IncomingMessage::TeamcluNotify { payload, .. } => {
            crate::proto::teamclu::Notify::decode(payload.as_slice())
                .map(|_| ())
                .map_err(|error| format!("invalid Notify: {error}"))
        }
        // Voice frames are raw Opus bytes (QoS 0) — no envelope to validate;
        // an out-of-band frame before turn_start is the router's problem, not
        // a malformed-message problem.
        IncomingMessage::VoiceMic { .. } => Ok(()),
        // VoiceCtl was already JSON-parsed in `parse_frame`; a malformed one
        // was dropped there. Reaching here means it parsed.
        IncomingMessage::VoiceCtl { .. } => Ok(()),
    }
}
