//! The cloud-token socket: `/internal/runtime-context/cloud-token` served on
//! a Unix domain socket, where the kernel tells us who is calling.
//!
//! The TCP runtime-context routes authenticate a host by the bearer token
//! amuxd put in its environment. For the cloud token that is not a boundary
//! against other processes of the same OS user: the token has to be in the
//! environment of the host's children for skills to use it, and every
//! same-user process can read another's environment (`sysctl KERN_PROCARGS2`
//! on macOS, `/proc/<pid>/environ` on Linux). A Unix socket gives us the
//! peer's pid instead (`LOCAL_PEERPID` / `SO_PEERCRED`), and
//! `runtime::proc_tree` walks its ancestry to a host this daemon spawned.
//! Nothing the caller presents is trusted; only what the kernel says about it.
//!
//! Windows has no equivalent here and keeps the TCP bearer route.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use axum::{routing::post, Extension, Router};
use hyper::server::conn::http1;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use super::state::HttpState;

/// What the kernel reports about the process on the other end of a
/// connection. `None` fields mean the lookup failed, which the handler treats
/// as "not a host".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnixPeer {
    pub pid: Option<u32>,
    pub uid: Option<u32>,
}

impl UnixPeer {
    pub(crate) fn from_stream(stream: &UnixStream) -> Self {
        match stream.peer_cred() {
            Ok(cred) => Self {
                pid: cred.pid().and_then(|p| u32::try_from(p).ok()),
                uid: Some(cred.uid()),
            },
            Err(_) => Self {
                pid: None,
                uid: None,
            },
        }
    }

    /// The process this daemon runs as. A socket file at 0600 already keeps
    /// other users out; this is the check that does not depend on the file.
    pub(crate) fn is_same_user(&self) -> bool {
        // SAFETY: getuid has no preconditions.
        self.uid == Some(unsafe { libc::getuid() })
    }
}

pub(crate) fn router(state: HttpState) -> Router {
    Router::new()
        .route(
            "/internal/runtime-context/cloud-token",
            post(super::runtime_context::cloud_token_unix)
                .get(super::runtime_context::cloud_token_unix),
        )
        .with_state(state)
}

/// Bind the socket at `path`, replacing a stale file from an earlier crash.
/// The file ends up 0600: connecting needs write permission on it.
pub(crate) fn bind(path: &Path) -> std::io::Result<UnixListener> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// Serve the cloud-token route on `listener` until the returned sender fires.
/// Each connection gets the router with its [`UnixPeer`] attached as an
/// extension, so the handler sees the kernel's view of that caller and no
/// other. The socket file is removed on shutdown.
pub(crate) fn spawn(
    listener: UnixListener,
    path: PathBuf,
    state: HttpState,
) -> (JoinHandle<()>, oneshot::Sender<()>) {
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let app = router(state);
    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    let (stream, _) = match accepted {
                        Ok(accepted) => accepted,
                        Err(e) => {
                            tracing::warn!(error = %e, "runtime-context socket accept failed");
                            continue;
                        }
                    };
                    let peer = UnixPeer::from_stream(&stream);
                    let service = TowerToHyperService::new(app.clone().layer(Extension(peer)));
                    tokio::spawn(async move {
                        if let Err(e) = http1::Builder::new()
                            .serve_connection(TokioIo::new(stream), service)
                            .await
                        {
                            tracing::debug!(error = %e, "runtime-context socket connection ended with error");
                        }
                    });
                }
            }
        }
        let _ = std::fs::remove_file(&path);
    });
    (join, shutdown_tx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use crate::runtime::context_registry::HostProcess;
    use crate::runtime::context_service::RuntimeContextService;
    use crate::runtime::proc_tree::process_info;

    fn state_with(service: Arc<RuntimeContextService>, dir: &Path) -> HttpState {
        use crate::config::HttpConfig;
        use crate::http::server::metadata;
        use crate::http::tokens;

        let backend: Arc<dyn crate::backend::Backend> = Arc::new(
            crate::backend::mock::MockBackend::with_identity("team-1", "actor-1"),
        );
        HttpState::new(
            HttpConfig {
                bind: "127.0.0.1:0".into(),
                token_file: Some(dir.join("token")),
                ..Default::default()
            },
            tokens::TokenStore::load_or_init(&dir.join("token")).unwrap(),
            metadata("actor".into(), "test"),
            crate::http::runtime_adapter::StubRuntimeAdapter::new(8),
            None,
            None,
            crate::sync::dispatch::SyncDispatcher::new(
                crate::sync::secret_store::SecretStore::new(),
                None,
            ),
            None,
        )
        .with_runtime_context(service)
        .with_backend(Some(backend))
    }

    /// A short socket path: `sun_path` is 104 bytes on macOS and a tempdir
    /// under `/var/folders` is already most of that.
    fn short_socket_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("amuxd-rtctx-{}-{tag}.sock", std::process::id()))
    }

    async fn request(path: &Path, accept: &str) -> (u16, String) {
        let mut stream = UnixStream::connect(path).await.expect("connect");
        let req = format!(
            "POST /internal/runtime-context/cloud-token HTTP/1.1\r\nHost: amuxd\r\nAccept: {accept}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).into_owned();
        let status: u16 = text
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .expect("status line");
        let body = text
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_string())
            .unwrap_or_default();
        (status, body)
    }

    #[tokio::test]
    async fn over_the_socket_the_callers_own_tree_decides_not_any_token() {
        let service = Arc::new(RuntimeContextService::new());
        let dir = tempfile::tempdir().unwrap();
        let state = state_with(Arc::clone(&service), dir.path());
        let path = short_socket_path("tree");
        let listener = bind(&path).expect("bind");
        let (join, shutdown) = spawn(listener, path.clone(), state);

        // This test process is the "host": until it is registered, the
        // connection — which comes from this very process — is refused.
        let (status, body) = request(&path, "text/plain").await;
        assert_eq!(status, 401, "{body}");
        assert!(!body.contains("mock-token"));

        let me = std::process::id();
        let start_time = process_info(me).expect("own start time").start_time;
        service.register_host_process(
            crate::proto::amux::AgentType::Pi,
            "pi-gen-1",
            HostProcess {
                pid: me,
                start_time,
            },
        );
        let (status, body) = request(&path, "text/plain").await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body, "mock-token");

        let (status, body) = request(&path, "application/json").await;
        assert_eq!(status, 200, "{body}");
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["accessToken"], "mock-token");
        assert_eq!(json["teamId"], "team-1");

        // A registration with a start time the pid does not have (the pid
        // was re-used by something else) is no registration.
        service.clear_generation(crate::proto::amux::AgentType::Pi, "pi-gen-1");
        service.register_host_process(
            crate::proto::amux::AgentType::Pi,
            "pi-gen-2",
            HostProcess {
                pid: me,
                start_time: start_time.wrapping_add(1),
            },
        );
        let (status, body) = request(&path, "text/plain").await;
        assert_eq!(status, 401, "{body}");

        let _ = shutdown.send(());
        let _ = join.await;
        assert!(!path.exists(), "socket file removed on shutdown");
    }

    #[test]
    fn the_socket_file_is_private_to_this_user() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();
        let path = short_socket_path("mode");
        let _listener = bind(&path).expect("bind");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_file(&path);
    }
}
