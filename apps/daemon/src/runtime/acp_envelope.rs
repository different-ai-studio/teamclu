//! Runtime envelope classification, carried over from the old ACP adapter.
//!
//! `RuntimeEnvelope` is the daemon-side classification of an ACP event into
//! the higher-level shapes the runtime cares about (token deltas, tool calls,
//! turn boundaries, …); `runtime_envelopes_from_acp_event` derives them from a
//! wire `amux::AcpEvent`. Pure, stateless — no adapter internals.

use crate::proto::amux;

#[derive(Debug, Clone)]
pub enum RuntimeEnvelope {
    TokenDelta {
        text: String,
    },
    ToolCall {
        tool_name: String,
        args: serde_json::Value,
    },
    ToolResult {
        tool_id: String,
        success: bool,
        summary: String,
    },
    MessageCompleted {
        message_id: uuid::Uuid,
        content: String,
    },
    TurnFinished {
        turn_id: uuid::Uuid,
    },
    SessionError {
        message: String,
        details: String,
    },
    StatusChanged {
        status: amux::AgentStatus,
    },
}

pub fn runtime_envelopes_from_acp_event(event: &amux::AcpEvent) -> Vec<RuntimeEnvelope> {
    match event.event.as_ref() {
        Some(amux::acp_event::Event::Output(output)) => {
            if output.text.is_empty() {
                return vec![];
            }
            if output.is_complete {
                vec![RuntimeEnvelope::MessageCompleted {
                    message_id: uuid::Uuid::new_v4(),
                    content: output.text.clone(),
                }]
            } else {
                vec![RuntimeEnvelope::TokenDelta {
                    text: output.text.clone(),
                }]
            }
        }
        Some(amux::acp_event::Event::ToolUse(tool)) => vec![RuntimeEnvelope::ToolCall {
            tool_name: tool.tool_name.clone(),
            args: serde_json::to_value(&tool.params)
                .unwrap_or_else(|_| serde_json::Value::Object(Default::default())),
        }],
        Some(amux::acp_event::Event::ToolResult(tool)) => vec![RuntimeEnvelope::ToolResult {
            tool_id: tool.tool_id.clone(),
            success: tool.success,
            summary: tool.summary.clone(),
        }],
        Some(amux::acp_event::Event::Error(err)) => vec![RuntimeEnvelope::SessionError {
            message: err.message.clone(),
            details: err.details.clone(),
        }],
        Some(amux::acp_event::Event::StatusChange(status)) => {
            vec![RuntimeEnvelope::StatusChanged {
                status: amux::AgentStatus::try_from(status.new_status)
                    .unwrap_or(amux::AgentStatus::Unknown),
            }]
        }
        _ => vec![],
    }
}
