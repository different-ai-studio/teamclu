pub mod agent_handle;
pub mod backend_store;
mod bot_prompt_file;
/// The one channel→session pipeline
/// (`docs/specs/2026-08-18-gateway-transport-architecture.md`). Every channel
/// goes through it; the per-gateway inline handlers it replaced are gone.
pub mod core;
pub mod live_notify;
pub mod manager;
pub mod reply_token;
/// Per-session serialization for channel turns. Moved out of the gateway crate
/// in #933: queueing is runtime behaviour, not protocol.
pub mod session_queue;
pub mod wecom_mcp;
pub use agent_handle::{AmuxdAgentHandle, BotRuntimeConfig, GatewaySpawnEnv};
pub use backend_store::AmuxdChannelStore;
pub use manager::ChannelManager;
