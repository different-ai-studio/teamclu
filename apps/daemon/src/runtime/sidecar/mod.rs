//! Pieces shared by sidecar-style agent backends.
//!
//! A "sidecar backend" spawns a Node child per worktree and speaks JSONL over
//! its stdin/stdout. `cursor_sdk` and `claude_agent` are both built this way,
//! and these two modules are the parts that are genuinely identical between
//! them — the JSONL request/response client, and the translation of TeamClu's
//! MCP manifest into the `{stdio|http}` server map both SDKs accept.
//!
//! Everything else (event vocabulary, session identity, permission semantics)
//! differs per SDK and lives in the backend's own module.

// Nothing constructs this backend since pi became the only runtime (#1247 /
// #1250). The module is compiled until #1247 deletes it, so dead-code lints
// are silenced here rather than chased through every function.
#![allow(dead_code)]

pub mod bridge_path;
pub mod client;
pub mod mcp;
