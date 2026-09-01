//! Desktop-managed amuxd lifecycle.
//!
//! Spawns the **bundled** `amuxd` sidecar (no copy into `~/.amuxd/bin`), does not
//! register LaunchAgent/systemd, and stops the child when the desktop exits.
//! See `docs/specs/2026-07-24-desktop-managed-amuxd-design.md`.
//!
//! Lifecycle rules:
//! - One `lifecycle` mutex serializes ensure / shutdown / restart.
//! - `app_exiting` is set on true quit; ensure must not spawn after that.
//! - Exit: SIGTERM Child → wait/reap (true death), then best-effort `amuxd stop`
//!   for artifacts. Never decide liveness only via `kill(pid,0)` (zombies pass).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::process_util::CommandNoWindow;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_TICK: Duration = Duration::from_millis(200);
/// Heal / restart can afford a longer wait.
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
/// Cmd+Q: brief grace for SIGTERM before SIGKILL + wait (reap).
const EXIT_CHILD_GRACE: Duration = Duration::from_millis(500);
const INTROSPECT_ENV: &str = "TEAMCLU_INTROSPECT_BIN";
const CURSOR_BRIDGE_MAIN_ENV: &str = "TEAMCLU_CURSOR_BRIDGE_MAIN";
const CLAUDE_BRIDGE_MAIN_ENV: &str = "TEAMCLU_CLAUDE_BRIDGE_MAIN";
const LAUNCHD_LABEL: &str = "cc.ucar.amuxd";
