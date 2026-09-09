//! Run a child process under a hard time limit.
//!
//! `Command::output()` waits forever, which is right for a program that always
//! exits and wrong for anything that can sit on a prompt nobody can answer.
//! `git clone` over https is the case that matters: `GIT_TERMINAL_PROMPT=0`
//! stops git from asking for a password itself, but it does not stop the
//! machine's **credential helper** from running, and a helper that opens a
//! window (git-credential-manager) blocks until someone clicks it — on a screen
//! the daemon does not have. Without a bound, the seed request never answers
//! and the app sits at "初始化中" forever.
//!
//! Both pipes are drained on their own threads for the whole life of the child.
//! Reading them only after it exits deadlocks any process that writes more than
//! a pipe buffer: the child blocks on a full pipe, never exits, and the poll
//! loop spins until the timeout kills work that was doing fine.

use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

/// How often the loop checks whether the child is done.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Spawn `command`, wait at most `timeout`, and hand back its output.
///
/// Takes over stdio (stdin null, both outputs piped) because draining is what
/// makes the bound safe. A non-zero exit is NOT an error here — the caller owns
/// that decision, exactly as with `Command::output()`. Only the timeout is,
/// and it reports `timeout_msg` verbatim so callers can hand the user a
/// sentence about their own operation rather than about processes.
pub fn run_bounded(
    mut command: Command,
    timeout: Duration,
    timeout_msg: &str,
) -> anyhow::Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Its own process group, so the kill below reaches whatever the child
    // spawned. git runs its credential helper as a child; killing only git
    // leaves the helper (and its window) behind.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let program = command.get_program().to_string_lossy().into_owned();
    let mut child = command
        .spawn()
        .map_err(|e| anyhow::anyhow!("could not run {program}: {e}"))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = std::io::Read::read_to_end(&mut pipe, &mut buf);
        }
        buf
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = std::io::Read::read_to_end(&mut pipe, &mut buf);
        }
        buf
    });
    let join = |h: std::thread::JoinHandle<Vec<u8>>| h.join().unwrap_or_default();

    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            // Both pipes are closed now, so the readers finish on their own.
            return Ok(Output {
                status,
                stdout: join(stdout_reader),
                stderr: join(stderr_reader),
            });
        }
        if start.elapsed() >= timeout {
            kill_process_tree(&mut child);
            let _ = join(stdout_reader);
            let _ = join(stderr_reader);
            anyhow::bail!("{timeout_msg}");
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(unix)]
pub fn kill_process_tree(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        let pgid = libc::getpgid(pid);
        if pgid > 1 {
            let _ = libc::kill(-pgid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(unix))]
pub fn kill_process_tree(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_output_and_leaves_the_exit_status_to_the_caller() {
        let mut ok = Command::new("sh");
        ok.arg("-c").arg("printf out; printf err >&2; exit 3");
        let out = run_bounded(ok, Duration::from_secs(30), "unused").unwrap();
        assert_eq!(out.status.code(), Some(3), "a failure is not an error here");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "out");
        assert_eq!(String::from_utf8_lossy(&out.stderr), "err");
    }

    #[test]
    fn a_process_that_never_exits_is_killed_and_reported() {
        let mut hang = Command::new("sh");
        hang.arg("-c").arg("sleep 30");
        let start = Instant::now();
        let err = run_bounded(hang, Duration::from_millis(300), "took too long").unwrap_err();
        assert_eq!(format!("{err}"), "took too long");
        assert!(start.elapsed() < Duration::from_secs(10), "did not give up");
    }

    #[test]
    fn output_larger_than_a_pipe_buffer_does_not_deadlock() {
        // The reason the readers are threads: 1 MiB is well past the 64 KiB a
        // pipe holds, so a child whose output is read only after it exits would
        // never exit at all.
        let mut chatty = Command::new("sh");
        chatty.arg("-c").arg("dd if=/dev/zero bs=1024 count=1024 2>/dev/null");
        let out = run_bounded(chatty, Duration::from_secs(30), "unused").unwrap();
        assert_eq!(out.stdout.len(), 1024 * 1024);
    }

    #[test]
    fn a_child_that_outlives_its_parent_is_killed_too() {
        // git spawns its credential helper; killing only git would leave the
        // helper holding the terminal (or a window) open.
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("still-alive");
        let mut parent = Command::new("sh");
        parent
            .arg("-c")
            .arg(format!(
                "sh -c 'sleep 2; touch {}' & sleep 30",
                marker.display()
            ));
        let _ = run_bounded(parent, Duration::from_millis(200), "gone").unwrap_err();
        std::thread::sleep(Duration::from_secs(3));
        assert!(
            !marker.exists(),
            "the grandchild survived the timeout and kept working"
        );
    }

    #[test]
    fn a_missing_program_names_itself() {
        let err = run_bounded(
            Command::new("definitely-not-a-real-binary"),
            Duration::from_secs(1),
            "unused",
        )
        .unwrap_err();
        assert!(
            format!("{err}").contains("definitely-not-a-real-binary"),
            "{err}"
        );
    }
}
