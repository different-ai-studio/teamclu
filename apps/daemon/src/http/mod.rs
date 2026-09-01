//! Browser-facing HTTP + SSE listener.
//!
//! The historical Unix-socket control plane (`daemon/server.rs`) speaks a
//! line-delimited JSON protocol that is only reachable from the local
//! filesystem. This module adds a second listener — an axum HTTP server
//! bound to a configurable address — so browsers and other non-Unix-socket
//! clients can drive the same `RuntimeManager` over a network-friendly
//! protocol (HTTP + Server-Sent Events).
//!
//! The two listeners share state. They never own divergent business logic.
//! Everything in `http::*` is a thin adapter that translates HTTP requests
//! into the same internal commands the Unix socket already produces, and
//! translates the existing `SessionEvent` broadcast into SSE frames.
//!
//! ### Module layout
//!
//! - [`state`] — `HttpState` (the `Arc`-shared bundle of handles the
//!   router needs)
//! - [`errors`] — RFC 7807 problem+json error helpers
//! - [`cors`] — CORS layer construction from `HttpConfig.allowed_origins`
//! - [`observ`] — request id + tracing middleware
//! - [`tokens`] — root/session token store + file persistence
//! - [`auth`] — `AuthLayer` extractor + scope checks (PR2/3)
//! - [`sessions`] — session CRUD + SSE stream + prompt/cancel/inject
//!   (PR4–6)
//! - [`events`] — typed event schema + ring buffer + replay (PR5/7)
//! - [`limit`] — rate limiting + body limits (PR8)

pub mod ai;
pub mod apps;
pub mod auth;
pub mod config;
pub mod cors;
pub mod errors;
pub mod events;
pub mod limit;
pub mod live_events;
pub mod live_ingest;
pub mod observ;
pub mod rpc;
pub mod runtime_adapter;
pub mod runtime_context;
pub mod sessions;
pub mod setup;
pub mod state;
pub mod team;
pub mod team_sync;
pub mod tokens;
pub mod workspaces;

mod routes;
pub mod server;

pub use server::{spawn, spawn_with_refresh_watch_registry, HttpHandle};
