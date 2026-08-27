//! The team-share sync engine (OSS) owned entirely by the daemon.
//!
//! The desktop no longer syncs; it triggers sync over HTTP and renders status.
//! See docs/superpowers/specs/2026-06-02-daemon-owns-team-sync-design.md.

pub mod app_build;
pub mod app_clone;
pub mod app_git;
pub mod app_seed;
pub mod app_templates;
pub mod app_workdir;
pub mod dispatch;
pub mod oss;
pub mod scheduler;
pub mod secret_store;
pub mod timer;
pub mod versions;
pub mod watch;
