//! Who holds `<amuxd home>/run/introspect.http.{token,port}`.
//!
//! Every desktop process that shares an amuxd home writes these two files when
//! its introspect API starts, and the sidecar trusts whatever they say. That
//! made them last-writer-wins with nobody cleaning up: a second process on the
//! same home — in practice a `tauri:dev` build next to the installed app —
//! overwrote both, exited, and left the app still running with a bearer no file
//! held any more. Every sidecar call then went to a dead port or got 401 until
//! the app was restarted.
//!
//! So the process that published keeps an eye on them:
//!
//! - every [`WATCH_INTERVAL`] it checks the files, and writes its own back when
//!   they are missing or name a port nobody is listening on;
//! - when they name *another live* listener it leaves them alone. Two live
//!   processes on one home is already a misconfiguration; taking turns
//!   overwriting each other would only make it flap;
//! - on exit it removes them, but only while they are still its own, so a
//!   process quitting never deletes what a still-running one published.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// How often the publisher re-checks its files. The sidecar reads them on
/// every call, so this bounds how long tools stay broken after another process
/// overwrites them and goes away.
pub(super) const WATCH_INTERVAL: Duration = Duration::from_secs(5);

/// How long a probe of another process's port may take before it counts as
/// nobody listening. Loopback connects either succeed or are refused at once.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// What the files say right now, from one publisher's point of view.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Holder {
    /// Both files hold this process's token and port.
    Ours,
    /// The port file names a port someone else is listening on.
    LiveOther(u16),
    /// Missing, unreadable, or left behind by a process that is gone.
    Stale,
}

pub(super) struct Publication {
    token: Arc<str>,
    port: u16,
    token_path: PathBuf,
    port_path: PathBuf,
}

/// The publication of this process, for [`withdraw`] at exit.
static CURRENT: OnceLock<Arc<Publication>> = OnceLock::new();

impl Publication {
    pub(super) fn new(token: Arc<str>, port: u16, token_path: PathBuf, port_path: PathBuf) -> Self {
        Self {
            token,
            port,
            token_path,
            port_path,
        }
    }

    /// Write both files, token first: a sidecar that reads the new port must
    /// already find the token that port accepts.
    pub(super) fn write(&self) -> std::io::Result<()> {
        super::write_token_file(&self.token_path, &self.token)?;
        super::write_token_file(&self.port_path, &self.port.to_string())
    }

    fn token_is_ours(&self) -> bool {
        read_trimmed(&self.token_path).as_deref() == Some(&*self.token)
    }

    fn published_port(&self) -> Option<u16> {
        read_trimmed(&self.port_path)?
            .parse::<u16>()
            .ok()
            .filter(|p| *p != 0)
    }

    pub(super) async fn holder(&self) -> Holder {
        let port = self.published_port();
        if port == Some(self.port) && self.token_is_ours() {
            return Holder::Ours;
        }
        match port {
            Some(other) if other != self.port && is_listening(other).await => {
                Holder::LiveOther(other)
            }
            _ => Holder::Stale,
        }
    }

    /// Remove both files if they are still this process's. Best effort: this
    /// runs on the way out, and a leftover is reclaimed by the next publisher.
    pub(super) fn withdraw(&self) {
        if !self.token_is_ours() {
            return;
        }
        let _ = std::fs::remove_file(&self.token_path);
        if self.published_port() == Some(self.port) {
            let _ = std::fs::remove_file(&self.port_path);
        }
    }
}

fn read_trimmed(path: &Path) -> Option<String> {
    Some(std::fs::read_to_string(path).ok()?.trim().to_string())
}

async fn is_listening(port: u16) -> bool {
    matches!(
        tokio::time::timeout(
            PROBE_TIMEOUT,
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await,
        Ok(Ok(_))
    )
}

/// Remember `publication` for [`withdraw`] and keep its files in place for as
/// long as this process runs.
pub(super) fn watch(publication: Publication) {
    let publication = Arc::new(publication);
    let _ = CURRENT.set(publication.clone());
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(WATCH_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await; // the first tick is immediate; we just wrote them
        let mut deferring_to: Option<u16> = None;
        loop {
            interval.tick().await;
            match publication.holder().await {
                Holder::Ours => deferring_to = None,
                Holder::LiveOther(other) => {
                    if deferring_to != Some(other) {
                        log::warn!(
                            "[IntrospectAPI] another process on 127.0.0.1:{other} published \
                             into this amuxd home; leaving it until it stops listening"
                        );
                        deferring_to = Some(other);
                    }
                }
                Holder::Stale => {
                    deferring_to = None;
                    match publication.write() {
                        Ok(()) => log::info!(
                            "[IntrospectAPI] port/token files were missing or stale; \
                             republished 127.0.0.1:{}",
                            publication.port
                        ),
                        Err(e) => {
                            log::warn!("[IntrospectAPI] cannot republish port/token files: {e}")
                        }
                    }
                }
            }
        }
    });
}

/// Called at app exit: take down this process's port and token files, unless
/// another process has published since.
pub fn withdraw() {
    if let Some(publication) = CURRENT.get() {
        publication.withdraw();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn publication(dir: &Path, token: &str, port: u16) -> Publication {
        Publication::new(
            Arc::from(token),
            port,
            dir.join("introspect.http.token"),
            dir.join("introspect.http.port"),
        )
    }

    /// A port nothing listens on: bind, note it, drop.
    fn dead_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[tokio::test]
    async fn freshly_written_files_are_ours() {
        let dir = tempfile::tempdir().unwrap();
        let me = publication(dir.path(), "mine", 4100);
        me.write().unwrap();
        assert_eq!(me.holder().await, Holder::Ours);
    }

    #[tokio::test]
    async fn files_left_by_a_process_that_exited_are_stale_and_get_reclaimed() {
        // The incident: a dev build overwrote both files, then quit.
        let dir = tempfile::tempdir().unwrap();
        let me = publication(dir.path(), "mine", 4100);
        me.write().unwrap();
        publication(dir.path(), "dev-build", dead_port())
            .write()
            .unwrap();

        assert_eq!(me.holder().await, Holder::Stale);
        me.write().unwrap();
        assert_eq!(me.holder().await, Holder::Ours);
    }

    #[tokio::test]
    async fn missing_files_are_stale() {
        let dir = tempfile::tempdir().unwrap();
        let me = publication(dir.path(), "mine", 4100);
        assert_eq!(me.holder().await, Holder::Stale);
    }

    #[tokio::test]
    async fn a_live_publisher_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let other_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let other_port = other_listener.local_addr().unwrap().port();
        let me = publication(dir.path(), "mine", 4100);
        me.write().unwrap();
        publication(dir.path(), "other", other_port)
            .write()
            .unwrap();

        assert_eq!(me.holder().await, Holder::LiveOther(other_port));
    }

    #[tokio::test]
    async fn our_port_with_someone_elses_token_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let me = publication(dir.path(), "mine", 4100);
        me.write().unwrap();
        std::fs::write(dir.path().join("introspect.http.token"), "other").unwrap();
        assert_eq!(me.holder().await, Holder::Stale);
    }

    #[test]
    fn withdraw_removes_our_files() {
        let dir = tempfile::tempdir().unwrap();
        let me = publication(dir.path(), "mine", 4100);
        me.write().unwrap();
        me.withdraw();
        assert!(!dir.path().join("introspect.http.token").exists());
        assert!(!dir.path().join("introspect.http.port").exists());
    }

    #[test]
    fn withdraw_keeps_files_another_process_published_since() {
        let dir = tempfile::tempdir().unwrap();
        let me = publication(dir.path(), "mine", 4100);
        me.write().unwrap();
        publication(dir.path(), "newer", 4200).write().unwrap();
        me.withdraw();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("introspect.http.token")).unwrap(),
            "newer"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("introspect.http.port")).unwrap(),
            "4200"
        );
    }
}
