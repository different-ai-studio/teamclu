//! Build an app workspace into a deployable artifact zip.
//!
//! The async presigned-URL upload lives in the HTTP handler (reqwest is async);
//! this module stays sync so it can run inside `spawn_blocking`.

use crate::process_util::CommandNoWindow;
use crate::sync::app_git::{self, SshEnv};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// OSS object key for an app's built code artifact.
pub fn oss_object_key(app_id: &str) -> String {
    format!("apps/{app_id}/code.zip")
}

/// English messages the HTTP layer maps to user-facing copy.
pub const ERR_OUTPUT_MISSING: &str = "build output missing in .output/";
pub const ERR_ARTIFACT_TOO_LARGE: &str = "artifact exceeds 50 MiB limit";
pub const ERR_LOCKFILE_MISMATCH: &str =
    "lockfile out of sync with package.json; commit updated pnpm-lock.yaml";
pub const ERR_INSTALL_TIMEOUT: &str = "pnpm install timed out after 10 minutes";
pub const ERR_BUILD_TIMEOUT: &str = "pnpm build timed out after 10 minutes";

const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const BUILD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Align with Phase 1 FC code-package budget documented in the Gitea design spec.
pub const MAX_ARTIFACT_BYTES: usize = 50 * 1024 * 1024;

/// Git context for a deploy build (fetch + checkout of the deployed commit).
///
/// Absent for an app imported from an external remote: this deployment holds
/// no credential for it, so its build is of the workdir as it sits.
pub struct BuildGitContext<'a> {
    /// The app being built. Used to re-point the checkout at the
    /// `amuxd git-ssh` shim, which bakes in the amuxd path.
    pub app_id: &'a str,
    pub commit_sha: &'a str,
    pub remote_url: &'a str,
    pub deploy_key_pem: &'a str,
}

/// Recursively zip `dir` into in-memory deflate bytes, with paths relative to `dir`.
pub fn zip_dir(dir: &Path) -> anyhow::Result<Vec<u8>> {
    let buf = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(buf);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for entry in walkdir::WalkDir::new(dir) {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
            let rel = path.strip_prefix(dir)?.to_string_lossy().replace('\\', "/");
            zip.start_file(rel, opts)?;
            let bytes = std::fs::read(path)?;
            zip.write_all(&bytes)?;
        }
    }
    let cursor = zip.finish()?;
    Ok(cursor.into_inner())
}

fn output_dir_has_files(dir: &Path) -> bool {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .any(|e| e.path().is_file())
}

fn map_pnpm_stderr(cmd: &str, args: &[&str], stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if args.contains(&"--frozen-lockfile")
        && (lower.contains("frozen-lockfile")
            || lower.contains("lockfile")
            || lower.contains("pnpm-lock.yaml"))
    {
        return ERR_LOCKFILE_MISMATCH.to_string();
    }
    format!("{cmd} {:?} failed: {}", args, stderr.trim())
}

fn run_with_timeout(
    cmd: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
    timeout_msg: &str,
) -> anyhow::Result<Output> {
    let mut command = Command::new(cmd);
    command
        .no_window()
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|e| anyhow::anyhow!("could not run {cmd}: {e}"))?;

    // Drain both pipes on their own threads for the whole life of the child.
    // Reading them only after it exits deadlocks any build that writes more
    // than a pipe buffer (`pnpm install` on the tanstack template is well over
    // 64 KiB): the child blocks on a full pipe, never exits, and the poll loop
    // below spins until the 10-minute timeout kills it.
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
            let out = Output {
                status,
                stdout: join(stdout_reader),
                stderr: join(stderr_reader),
            };
            if !out.status.success() {
                let msg = map_pnpm_stderr(cmd, args, &String::from_utf8_lossy(&out.stderr));
                anyhow::bail!("{msg}");
            }
            return Ok(out);
        }
        if start.elapsed() >= timeout {
            kill_process_tree(&mut child);
            let _ = join(stdout_reader);
            let _ = join(stderr_reader);
            anyhow::bail!("{timeout_msg}");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(unix)]
fn kill_process_tree(child: &mut std::process::Child) {
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
fn kill_process_tree(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Prepare the workdir for a deploy build: fetch, clean tree, checkout `sha`.
///
/// The fetch runs **before** the clean/pushed gate on purpose. That gate
/// compares HEAD against remote-tracking refs, and refs left over from the
/// previous deploy report a commit that was pushed minutes ago as unpushed
/// local work — every deploy after the first one was refused as dirty.
pub fn prepare_git_build(workdir: &Path, git: &BuildGitContext<'_>) -> anyhow::Result<()> {
    app_git::init_if_needed(workdir)?;
    // Re-stamped on every deploy so the shim path survives an amuxd upgrade
    // that moves the binary. Cheap, idempotent, and the only self-healing this
    // needs for a checkout that deploys at all.
    if let Err(e) = app_git::set_repo_ssh_command(workdir, git.app_id) {
        tracing::warn!(app_id = git.app_id, error = %e, "could not refresh core.sshCommand");
    }
    let ssh = SshEnv::from_deploy_key_pem(git.deploy_key_pem)?;
    app_git::set_remote_origin(workdir, git.remote_url, Some(&ssh))?;
    app_git::fetch_origin(workdir, Some(&ssh))?;
    app_git::ensure_clean_and_pushed(workdir)?;
    app_git::checkout_fetched_sha(workdir, git.commit_sha)
}

/// Run `pnpm install` then `pnpm build` in `workdir`, then zip the `.output` dir.
///
/// When `git` is present the workdir must be clean, fetched, and checked out
/// at `git.commit_sha` before building (see [`prepare_git_build`]).
pub fn build_artifact(
    workdir: &Path,
    git: Option<&BuildGitContext<'_>>,
) -> anyhow::Result<Vec<u8>> {
    if let Some(ctx) = git {
        prepare_git_build(workdir, ctx)?;
    }
    run_with_timeout(
        "pnpm",
        &["install", "--frozen-lockfile"],
        workdir,
        INSTALL_TIMEOUT,
        ERR_INSTALL_TIMEOUT,
    )?;
    run_with_timeout(
        "pnpm",
        &["build"],
        workdir,
        BUILD_TIMEOUT,
        ERR_BUILD_TIMEOUT,
    )?;

    let output_dir = workdir.join(".output");
    if !output_dir.is_dir() || !output_dir_has_files(&output_dir) {
        anyhow::bail!("{ERR_OUTPUT_MISSING}");
    }

    let bytes = zip_dir(&output_dir)?;
    if bytes.is_empty() {
        anyhow::bail!("{ERR_OUTPUT_MISSING}");
    }
    if bytes.len() > MAX_ARTIFACT_BYTES {
        anyhow::bail!("{ERR_ARTIFACT_TOO_LARGE}");
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn oss_object_key_is_apps_appid_codezip() {
        assert_eq!(oss_object_key("app-123"), "apps/app-123/code.zip");
    }

    #[test]
    fn zip_dir_archives_files_with_relative_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("out");
        std::fs::create_dir_all(root.join("server")).unwrap();
        std::fs::write(root.join("server/index.mjs"), b"console.log(1)").unwrap();
        std::fs::write(root.join("public.txt"), b"hi").unwrap();

        let bytes = zip_dir(&root).unwrap();
        assert!(!bytes.is_empty());

        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert!(
            names.iter().any(|n| n == "server/index.mjs"),
            "names: {names:?}"
        );
        assert!(names.iter().any(|n| n == "public.txt"), "names: {names:?}");

        let mut f = archive.by_name("server/index.mjs").unwrap();
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        assert_eq!(s, "console.log(1)");
    }

    #[test]
    fn output_dir_has_files_detects_empty_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let empty = tmp.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(!output_dir_has_files(&empty));

        std::fs::write(empty.join("x.txt"), b"x").unwrap();
        assert!(output_dir_has_files(&empty));
    }

    #[test]
    fn map_pnpm_stderr_detects_frozen_lockfile() {
        let msg = map_pnpm_stderr(
            "pnpm",
            &["install", "--frozen-lockfile"],
            "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile",
        );
        assert_eq!(msg, ERR_LOCKFILE_MISMATCH);
    }

    #[test]
    fn max_artifact_bytes_is_fifty_mebibytes() {
        assert_eq!(MAX_ARTIFACT_BYTES, 50 * 1024 * 1024);
    }

    #[cfg(unix)]
    #[test]
    fn a_noisy_command_does_not_deadlock_on_a_full_pipe() {
        // Draining the pipes only after the child exits deadlocks anything that
        // writes more than a pipe buffer (~64 KiB) — which `pnpm install` on the
        // tanstack template comfortably does. The child blocked on a full pipe,
        // never exited, and the build died at the 10-minute timeout instead.
        let tmp = tempfile::tempdir().unwrap();
        let script = "i=0; while [ $i -lt 3000 ]; do \
             echo 0123456789012345678901234567890123456789012345678901234567890123; \
             echo 0123456789012345678901234567890123456789012345678901234567890123 >&2; \
             i=$((i+1)); done";
        let out = run_with_timeout(
            "sh",
            &["-c", script],
            tmp.path(),
            Duration::from_secs(60),
            "timed out",
        )
        .expect("a chatty command must finish, not time out");
        assert!(
            out.stdout.len() > 128 * 1024,
            "stdout: {}",
            out.stdout.len()
        );
        assert!(
            out.stderr.len() > 128 * 1024,
            "stderr: {}",
            out.stderr.len()
        );
    }
}
