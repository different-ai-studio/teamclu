//! Per-PTY state. Holds the master handle, child, ring buffer, and reader thread.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use super::registry::{TerminalError, TerminalStatus};
use super::ring::RingBuffer;
use super::shell_integration;

const READ_BUF_BYTES: usize = 4096;

/// Where PTY output goes. Called with each chunk as it is read; returns `false`
/// once the receiver is gone, and the sink is dropped.
///
/// The desktop wires a Tauri IPC channel in here so bytes reach the webview as
/// an `ArrayBuffer`. They used to travel as a JSON `number[]` event payload —
/// three to four bytes of text per byte of output, parsed on the main thread,
/// and broadcast to every window whether or not it showed the terminal.
pub type DataSink = Arc<dyn Fn(&[u8]) -> bool + Send + Sync>;

/// The ring and its sinks share one lock on purpose: [`PtyHandle::attach`]
/// hands the sink the ring's contents and registers it under the same guard,
/// so no chunk can land in between and be both missing from the snapshot and
/// never delivered. That ordering guarantee is what let the frontend drop its
/// snapshot / subscribe / re-snapshot / de-duplicate dance.
struct Output {
    ring: RingBuffer,
    sinks: Vec<(u64, DataSink)>,
}

pub struct PtyHandle {
    pub id: String,
    pub workspace_id: String,
    #[allow(dead_code)]
    pub cwd: PathBuf,
    pub shell: String,
    pub pid: u32,

    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    output: Arc<Mutex<Output>>,
    next_sink_id: AtomicU64,
    status: Mutex<TerminalStatus>,
    exit_code: Mutex<Option<i32>>,
}

pub struct SpawnArgs {
    pub id: String,
    pub workspace_id: String,
    pub cwd: PathBuf,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
}

pub struct EmitContext {
    /// Called once with `(event_name, code)` when the child exits or reader stops.
    pub emit_exit: Arc<dyn Fn(&str, Option<i32>) + Send + Sync>,
}

impl PtyHandle {
    pub fn spawn(args: SpawnArgs, emit: EmitContext) -> Result<Arc<Self>, TerminalError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: args.rows,
                cols: args.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&args.shell);
        configure_shell_command(&mut cmd, &args.shell);
        cmd.cwd(&args.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TEAMCLU_TERMINAL", "1");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
        let pid = child.process_id().unwrap_or(0);
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let handle = Arc::new(Self {
            id: args.id.clone(),
            workspace_id: args.workspace_id,
            cwd: args.cwd,
            shell: args.shell,
            pid,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            output: Arc::new(Mutex::new(Output {
                ring: RingBuffer::new(),
                sinks: Vec::new(),
            })),
            next_sink_id: AtomicU64::new(1),
            status: Mutex::new(TerminalStatus::Running),
            exit_code: Mutex::new(None),
        });

        Self::start_reader_thread(handle.clone(), reader, emit);
        Ok(handle)
    }

    fn start_reader_thread(
        handle: Arc<Self>,
        mut reader: Box<dyn std::io::Read + Send>,
        emit: EmitContext,
    ) {
        let exit_event = format!("terminal://{}/exit", handle.id);
        let output = handle.output.clone();

        std::thread::Builder::new()
            .name(format!("pty-reader-{}", handle.id))
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut tmp = [0u8; READ_BUF_BYTES];

                    // `reader.read` blocks until bytes are available, so the OS
                    // already coalesces short bursts into a single syscall.
                    // Emit each returned chunk immediately — holding bytes back
                    // for further batching stalls short writes (e.g. a freshly
                    // drawn prompt) until the *next* read returns, which can
                    // take seconds if the user is idle.
                    loop {
                        match reader.read(&mut tmp) {
                            Ok(0) => break,
                            Ok(n) => {
                                let chunk = &tmp[..n];
                                let mut out = output.lock().unwrap();
                                out.ring.write(chunk);
                                // Under the same guard as the ring write — see
                                // `Output`. A sink that reports its receiver
                                // gone is dropped here rather than retried.
                                out.sinks.retain(|(_, sink)| sink(chunk));
                            }
                            Err(_) => break,
                        }
                    }
                }));

                let exit_code = match handle.child.lock().unwrap().wait() {
                    Ok(status) => status.exit_code() as i32,
                    Err(_) => -1,
                };

                *handle.exit_code.lock().unwrap() = Some(exit_code);
                *handle.status.lock().unwrap() = TerminalStatus::Exited;

                let code = if result.is_err() {
                    Some(-1)
                } else {
                    Some(exit_code)
                };
                (emit.emit_exit)(&exit_event, code);
            })
            .expect("failed to spawn reader thread");
    }

    pub fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        if matches!(*self.status.lock().unwrap(), TerminalStatus::Exited) {
            return Err(TerminalError::PtyClosed);
        }
        let mut w = self.writer.lock().unwrap();
        w.write_all(data).map_err(|_| TerminalError::PtyClosed)?;
        w.flush().map_err(|_| TerminalError::PtyClosed)?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let master = self.master.lock().unwrap();
        master
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
        Ok(())
    }

    pub fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
    }

    /// Register a sink and hand it everything the ring holds, atomically.
    ///
    /// The snapshot is delivered as the sink's first call — possibly empty, so
    /// a receiver can treat "first message" as "replay complete". Every chunk
    /// read after this call follows in order. Returns the id [`detach`] takes.
    ///
    /// [`detach`]: PtyHandle::detach
    pub fn attach(&self, sink: DataSink) -> u64 {
        let id = self.next_sink_id.fetch_add(1, Ordering::Relaxed);
        let mut out = self.output.lock().unwrap();
        let snapshot = out.ring.snapshot();
        if sink(&snapshot) {
            out.sinks.push((id, sink));
        }
        id
    }

    /// Stop delivering to the sink `attach` returned this id for. Unknown ids
    /// are a no-op: the reader thread may already have dropped it.
    pub fn detach(&self, sink_id: u64) {
        self.output
            .lock()
            .unwrap()
            .sinks
            .retain(|(id, _)| *id != sink_id);
    }

    #[cfg(test)]
    pub fn snapshot(&self) -> Vec<u8> {
        self.output.lock().unwrap().ring.snapshot()
    }

    pub fn status(&self) -> TerminalStatus {
        *self.status.lock().unwrap()
    }
    pub fn exit_code(&self) -> Option<i32> {
        *self.exit_code.lock().unwrap()
    }
}

#[derive(Clone, Copy)]
enum ShellKind {
    Zsh,
    Bash,
    OtherLogin,
    Other,
}

fn detect_shell_kind(shell: &str) -> ShellKind {
    let name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let name = name.strip_suffix(".exe").unwrap_or(name);
    match name {
        "zsh" => ShellKind::Zsh,
        "bash" => ShellKind::Bash,
        "sh" | "fish" => ShellKind::OtherLogin,
        _ => ShellKind::Other,
    }
}

/// Apply shell-specific args and env so OSC 633 shell integration is sourced
/// when supported. Falls back to a plain login shell if integration can't be
/// materialized.
fn configure_shell_command(cmd: &mut CommandBuilder, shell: &str) {
    match detect_shell_kind(shell) {
        ShellKind::Zsh => {
            cmd.arg("-l");
            if let Some(dir) = shell_integration::ensure_dir() {
                if let Ok(orig) = std::env::var("ZDOTDIR") {
                    if !orig.is_empty() {
                        cmd.env("TEAMCLU_USER_ZDOTDIR", orig);
                    }
                }
                cmd.env("ZDOTDIR", dir);
            }
        }
        ShellKind::Bash => {
            if let Some(dir) = shell_integration::ensure_dir() {
                cmd.arg("--rcfile");
                cmd.arg(shell_integration::bash_rc_path(dir));
                cmd.arg("-i");
            } else {
                cmd.arg("-l");
            }
        }
        ShellKind::OtherLogin => {
            cmd.arg("-l");
        }
        ShellKind::Other => {}
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn make_emit() -> (EmitContext, mpsc::Receiver<(String, Option<i32>)>) {
        let (exit_tx, exit_rx) = mpsc::channel();
        let exit_tx = Mutex::new(exit_tx);
        let emit = EmitContext {
            emit_exit: Arc::new(move |name, code| {
                let _ = exit_tx.lock().unwrap().send((name.to_string(), code));
            }),
        };
        (emit, exit_rx)
    }

    /// A sink that forwards every chunk to an mpsc receiver.
    fn collecting_sink() -> (DataSink, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink: DataSink =
            Arc::new(move |chunk: &[u8]| tx.lock().unwrap().send(chunk.to_vec()).is_ok());
        (sink, rx)
    }

    #[test]
    fn echo_produces_output_and_exit() {
        let tmp = std::env::temp_dir();
        let (emit, exit_rx) = make_emit();
        let handle = PtyHandle::spawn(
            SpawnArgs {
                id: "test-1".into(),
                workspace_id: "ws".into(),
                cwd: tmp.clone(),
                shell: "/bin/sh".into(),
                cols: 80,
                rows: 24,
            },
            emit,
        )
        .expect("spawn");
        let (sink, data_rx) = collecting_sink();
        handle.attach(sink);

        handle.write(b"echo hello\nexit\n").expect("write");

        // Collect data events until exit fires.
        let exit_msg = exit_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("exit event");
        assert!(exit_msg.0.starts_with("terminal://test-1/exit"));

        let mut buf = Vec::new();
        while let Ok(chunk) = data_rx.try_recv() {
            buf.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&buf);
        assert!(
            text.contains("hello"),
            "expected 'hello' in output, got: {text}"
        );
        assert!(matches!(handle.status(), TerminalStatus::Exited));
    }

    #[test]
    fn ring_buffer_replay_after_output() {
        let tmp = std::env::temp_dir();
        let (emit, exit_rx) = make_emit();
        let handle = PtyHandle::spawn(
            SpawnArgs {
                id: "test-2".into(),
                workspace_id: "ws".into(),
                cwd: tmp,
                shell: "/bin/sh".into(),
                cols: 80,
                rows: 24,
            },
            emit,
        )
        .expect("spawn");

        handle.write(b"printf marker_xyz\nexit\n").expect("write");
        let _ = exit_rx.recv_timeout(Duration::from_secs(5));

        let snap = handle.snapshot();
        let text = String::from_utf8_lossy(&snap);
        assert!(
            text.contains("marker_xyz"),
            "snapshot missing marker: {text}"
        );
    }

    /// The reason ring and sinks share a lock: a late attach gets the whole
    /// history as its first chunk, then live output, with nothing lost or
    /// doubled in between.
    #[test]
    fn a_late_attach_replays_the_ring_first_then_streams() {
        let tmp = std::env::temp_dir();
        let (emit, exit_rx) = make_emit();
        let handle = PtyHandle::spawn(
            SpawnArgs {
                id: "test-3".into(),
                workspace_id: "ws".into(),
                cwd: tmp,
                shell: "/bin/sh".into(),
                cols: 80,
                rows: 24,
            },
            emit,
        )
        .expect("spawn");

        handle.write(b"printf first_marker\n").expect("write");
        // Wait until the ring has the first marker before attaching.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !String::from_utf8_lossy(&handle.snapshot()).contains("first_marker") {
            assert!(
                std::time::Instant::now() < deadline,
                "first marker never arrived"
            );
            std::thread::sleep(Duration::from_millis(20));
        }

        let (sink, data_rx) = collecting_sink();
        let sink_id = handle.attach(sink);
        let replay = data_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("replay chunk");
        assert!(
            String::from_utf8_lossy(&replay).contains("first_marker"),
            "first chunk should be the ring snapshot"
        );

        handle
            .write(b"printf second_marker\nexit\n")
            .expect("write");
        let _ = exit_rx.recv_timeout(Duration::from_secs(5));
        let mut live = Vec::new();
        while let Ok(chunk) = data_rx.try_recv() {
            live.extend_from_slice(&chunk);
        }
        let live = String::from_utf8_lossy(&live);
        assert!(
            live.contains("second_marker"),
            "live output missing: {live}"
        );

        handle.detach(sink_id);
        assert!(handle.output.lock().unwrap().sinks.is_empty());
    }

    /// A sink whose receiver is gone must be dropped, not retried forever.
    #[test]
    fn a_dead_sink_is_dropped_on_the_next_chunk() {
        let tmp = std::env::temp_dir();
        let (emit, exit_rx) = make_emit();
        let handle = PtyHandle::spawn(
            SpawnArgs {
                id: "test-4".into(),
                workspace_id: "ws".into(),
                cwd: tmp,
                shell: "/bin/sh".into(),
                cols: 80,
                rows: 24,
            },
            emit,
        )
        .expect("spawn");

        let (sink, data_rx) = collecting_sink();
        handle.attach(sink);
        drop(data_rx);
        handle.write(b"echo x\nexit\n").expect("write");
        let _ = exit_rx.recv_timeout(Duration::from_secs(5));
        assert!(handle.output.lock().unwrap().sinks.is_empty());
    }
}
