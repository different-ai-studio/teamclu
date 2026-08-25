//! Autonomous 300s sync loop: covers the app-closed / headless case. The
//! desktop's HTTP trigger handles instant sync while the app is open.
//!
//! Keyed by team, not by workspace. The synced tree is
//! `~/.amuxd[-<brand>]/teams/<id>/shared`, which exists whether or not this
//! device has a folder open — the old form captured a cloud workspace list at
//! boot and skipped the team entirely when it came back empty, so a device that
//! had not registered a workspace yet never auto-synced at all.

use std::time::Duration;

use crate::sync::dispatch::{SyncDispatcher, SyncOptions};

pub fn spawn(dispatcher: SyncDispatcher, team_id: String) {
    let team_id = team_id.trim().to_string();
    if team_id.is_empty() {
        tracing::debug!("sync timer not started: daemon is not onboarded to a team");
        return;
    }
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(300));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            if !crate::config::DaemonConfig::team_share_auto_sync_enabled_from_disk() {
                tracing::debug!("timer sync skipped: team_share.auto_sync is disabled");
                continue;
            }
            if dispatcher.status(&team_id).await.syncing {
                tracing::debug!(team_id, "timer sync skipped: sync already in progress");
                continue;
            }
            let st = dispatcher.sync_team(&team_id, SyncOptions::default()).await;
            if let Some(err) = &st.last_error {
                tracing::warn!(team_id, "timer sync error: {err}");
            }
        }
    });
}
