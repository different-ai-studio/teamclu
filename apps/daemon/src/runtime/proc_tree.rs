//! Who is on the other end of a local connection, as the kernel sees it.
//!
//! The cloud-token socket (`http::runtime_context_unix`) does not ask its
//! caller for a secret. A secret handed to an agent host has to sit in the
//! host's environment to reach the skills the host runs, and anything in a
//! process's environment is readable by every process of the same OS user —
//! `sysctl KERN_PROCARGS2` on macOS, `/proc/<pid>/environ` on Linux. What a
//! same-user process cannot forge is its own ancestry: the kernel assigns the
//! parent pid, and an orphan is re-parented to pid 1, never to a process of
//! the attacker's choosing. So the socket identifies a caller by walking
//! `ppid` upwards until it meets a host this daemon spawned.
//!
//! A pid is reused once its process is gone, so a host is identified by
//! `(pid, start time)` and the start time is checked again on every lookup.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessInfo {
    pub ppid: u32,
    /// Start time in a unit that is stable for the life of the process and
    /// differs between a process and its pid's previous owner. Microseconds
    /// since the epoch on macOS, clock ticks since boot on Linux; the two are
    /// never compared with each other.
    pub start_time: u64,
}

/// Longest ancestry walked before giving up. Real trees are five or six deep
/// (host → bash → python → curl); the cap only bounds a pathological `/proc`.
pub const MAX_ANCESTRY_DEPTH: usize = 64;

/// The parent pid and start time of `pid`, or `None` when no such process
/// exists (or it cannot be inspected).
#[cfg(target_os = "macos")]
pub fn process_info(pid: u32) -> Option<ProcessInfo> {
    use std::mem::{size_of, MaybeUninit};
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `info` is a correctly sized, writable buffer for the flavour
    // requested, and the kernel writes at most `size` bytes into it.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: the call wrote the full struct.
    let info = unsafe { info.assume_init() };
    Some(ProcessInfo {
        ppid: info.pbi_ppid,
        start_time: info
            .pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
    })
}

#[cfg(target_os = "linux")]
pub fn process_info(pid: u32) -> Option<ProcessInfo> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_linux_stat(&stat)
}

/// `/proc/<pid>/stat`: `pid (comm) state ppid … starttime …`. `comm` may hold
/// spaces and parentheses, so the fields are counted from the last `)`.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_linux_stat(stat: &str) -> Option<ProcessInfo> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // fields[0] = state (3rd field), so field N of the man page is fields[N - 3].
    let ppid = fields.get(4 - 3)?.parse().ok()?;
    let start_time = fields.get(22 - 3)?.parse().ok()?;
    Some(ProcessInfo { ppid, start_time })
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
pub fn process_info(_pid: u32) -> Option<ProcessInfo> {
    None
}

/// `pid` and its ancestors, nearest first, stopping before pid 0/1 or after
/// [`MAX_ANCESTRY_DEPTH`] steps. The first entry is always `pid` itself.
#[cfg(unix)]
pub fn ancestry(pid: u32) -> Vec<u32> {
    let mut chain = vec![pid];
    let mut current = pid;
    while chain.len() < MAX_ANCESTRY_DEPTH {
        let Some(info) = process_info(current) else {
            break;
        };
        if info.ppid <= 1 || info.ppid == current {
            break;
        }
        chain.push(info.ppid);
        current = info.ppid;
    }
    chain
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_stat_is_parsed_past_a_comm_with_spaces_and_parens() {
        let stat = "4242 (tmux: server) (x) S 1 4242 4242 0 -1 4194560 10 0 0 0 1 2 0 0 20 0 1 0 987654 1000 0 18446744073709551615";
        let info = parse_linux_stat(stat).expect("parsed");
        assert_eq!(info.ppid, 1);
        assert_eq!(info.start_time, 987654);
        assert!(parse_linux_stat("garbage").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn this_process_knows_its_own_parent_and_start_time() {
        let me = std::process::id();
        let info = process_info(me).expect("own process info");
        assert!(info.start_time > 0);
        // SAFETY: getppid has no preconditions.
        let ppid = unsafe { libc::getppid() } as u32;
        assert_eq!(info.ppid, ppid);
        let chain = ancestry(me);
        assert_eq!(chain[0], me);
        assert!(
            chain.len() >= 2,
            "a test binary always has a parent: {chain:?}"
        );
        assert_eq!(chain[1], ppid);
        assert!(!chain.contains(&1));
    }

    #[cfg(unix)]
    #[test]
    fn a_spawned_child_has_this_process_in_its_ancestry_and_a_dead_pid_has_none() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        let chain = ancestry(pid);
        assert_eq!(chain[0], pid);
        assert_eq!(chain[1], std::process::id());
        let before = process_info(pid).expect("live child");
        child.kill().unwrap();
        child.wait().unwrap();
        // Reaped: the pid is free, and whoever gets it next will not carry
        // this start time.
        match process_info(pid) {
            None => {}
            Some(after) => assert_ne!(after.start_time, before.start_time),
        }
    }
}
