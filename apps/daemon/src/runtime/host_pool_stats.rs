//! Workspace host-pool statistics exposed on the HTTP activation DTO.
//!
//! Extracted from `opencode_http/host_pool.rs` so `config/workspace_control` and
//! the frontend diagnostics contract survive deletion of the OpenCode host pool.

use std::time::Duration;

/// Lifecycle of a workspace-scoped host generation (HTTP DTO shape).
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostLifecycle {
    Starting,
    Ready,
    Draining,
    Stopped,
}

/// Workspace-scoped host generation and capacity state (HTTP DTO shape).
#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainHostStats {
    pub current_generation: Option<String>,
    pub current_lifecycle: Option<HostLifecycle>,
    pub pending_lifecycle: Option<String>,
    pub current_revision: Option<String>,
    pub requested_revision: Option<String>,
    pub current_routes: usize,
    pub draining_generations: usize,
    pub draining_routes: usize,
    pub idle_age: Option<Duration>,
    pub queued_acquisitions: usize,
    pub last_error: Option<String>,
}
