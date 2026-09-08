//! Build an app workspace into a deployable artifact zip.
//!
//! The async presigned-URL upload lives in the HTTP handler (reqwest is async);
//! this module stays sync so it can run inside `spawn_blocking`.

use crate::process_util::CommandNoWindow;
use crate::sync::app_git::{self, SshEnv};
use serde::{Deserialize, Serialize};
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
/// The app has no code to build. `pnpm install` reports it as
/// `ERR_PNPM_NO_PKG_MANIFEST`, which is accurate and says nothing a user can
/// act on; the desktop turns this marker into the two things they can do.
pub const ERR_NO_PACKAGE_JSON: &str = "the app's folder has no package.json to build";
pub const ERR_LOCKFILE_MISMATCH: &str =
    "lockfile out of sync with package.json; commit updated pnpm-lock.yaml";
pub const ERR_INSTALL_TIMEOUT: &str = "pnpm install timed out after 10 minutes";
pub const ERR_BUILD_TIMEOUT: &str = "pnpm build timed out after 10 minutes";

/// Cap on the command output carried in a failure message.
///
/// Uncapped it was the whole of a failing `pnpm build`'s log, in an HTTP 500
/// body and the desktop console. The tail is the useful end: pnpm's `ERR_PNPM_*`
/// line is the whole of a failed install, and a build tool's own error is the
/// last thing it prints before it gives up.
const MAX_FAILURE_OUTPUT: usize = 2000;

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

/// Last `max` bytes of `text`, cut on a char boundary and marked when cut.
fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &text[start..])
}

/// The failure message for a pnpm command, from **both** of its streams.
///
/// pnpm writes its `ERR_PNPM_*` diagnostics to stdout, not stderr. Reading only
/// stderr made a failed command report whatever happened to be on stderr as the
/// cause — on a machine whose `~/.npmrc` interpolates an unset variable, that is
/// a `${NODE_AUTH_TOKEN}` warning, reported verbatim as the reason a deploy
/// failed while `ERR_PNPM_NO_PKG_MANIFEST` on stdout was thrown away.
fn map_pnpm_failure(cmd: &str, args: &[&str], stdout: &str, stderr: &str) -> String {
    let combined = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let lower = combined.to_ascii_lowercase();
    // pnpm's own error marker, not the bare word: a normal install prints
    // "Lockfile is up to date, resolution step is skipped", so matching
    // "lockfile" now that stdout is in scope would call every other failure a
    // stale lockfile.
    if args.contains(&"--frozen-lockfile")
        && (lower.contains("err_pnpm_outdated_lockfile") || lower.contains("cannot install with"))
    {
        return ERR_LOCKFILE_MISMATCH.to_string();
    }
    // An empty workdir is the failure a user is most likely to hit and least
    // likely to diagnose: nothing about "no package.json found in
    // /Users/…/apps/<uuid>" says the app was never given any code.
    if lower.contains("err_pnpm_no_pkg_manifest") {
        return ERR_NO_PACKAGE_JSON.to_string();
    }
    format!(
        "{cmd} {:?} failed: {}",
        args,
        tail(&combined, MAX_FAILURE_OUTPUT)
    )
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
                let msg = map_pnpm_failure(
                    cmd,
                    args,
                    &String::from_utf8_lossy(&out.stdout),
                    &String::from_utf8_lossy(&out.stderr),
                );
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

/// Message on the commit a deploy makes for work the agent left uncommitted.
const DEPLOY_COMMIT_MESSAGE: &str = "chore(app): publish workdir for deploy";

/// Prepare the workdir for a deploy build: fetch, publish pending work,
/// checkout what is to be built.
///
/// The fetch runs **before** anything reads ahead/behind state on purpose. That
/// state compares HEAD against remote-tracking refs, and refs left over from
/// the previous deploy report a commit that was pushed minutes ago as unpushed
/// local work — every deploy after the first one was refused as dirty.
///
/// Returns the sha to build when publishing moved HEAD past the one the caller
/// asked for, and `None` when the caller's sha is what got checked out.
pub fn prepare_git_build(
    workdir: &Path,
    git: &BuildGitContext<'_>,
) -> anyhow::Result<Option<String>> {
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

    // Before anything is staged: the deploy commits the workdir now, and the
    // daemon's own runtime files sit in it untracked. Best-effort — a checkout
    // we cannot write an exclude file into should still deploy.
    if let Err(e) = app_git::ensure_runtime_excludes(workdir) {
        tracing::warn!(app_id = git.app_id, error = %e, "could not write .git/info/exclude");
    }

    // Whatever the agent left behind gets committed and pushed rather than
    // refused. When that happens HEAD is already the commit to build, and
    // checking out the caller's older sha would ship without it.
    if let Some(published) =
        app_git::publish_pending_work(workdir, Some(&ssh), DEPLOY_COMMIT_MESSAGE)?
    {
        return Ok(Some(published));
    }

    app_git::checkout_fetched_sha(workdir, git.commit_sha)?;
    Ok(None)
}

/// What an app declares about how it is built and run.
///
/// Every field was a constant until an app turned up that builds to `dist/` and
/// starts `node dist/index.js`: the deploy failed on a missing `.output/`, and
/// the only place the real contract was written down was a template file the
/// agent had already rewritten to describe its own code. A declaration in the
/// repo is something an app can satisfy without us guessing.
///
/// Absent or unparseable means the defaults, which are exactly what every app
/// deployed before this got — so nothing that works today needs the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRuntimeManifest {
    /// Directory to package, relative to the workdir.
    pub output: String,
    /// Interpreter family. The deployment maps this to a runtime layer and a
    /// binary; an unknown value is the control plane's to reject, not the
    /// daemon's — it is the side that knows which layers exist.
    pub runtime: String,
    /// Entry path inside the packaged directory.
    pub entry: String,
    /// Port the app listens on.
    pub port: u16,
}

impl Default for AppRuntimeManifest {
    fn default() -> Self {
        Self {
            output: ".output".to_string(),
            runtime: "node".to_string(),
            entry: "server/index.mjs".to_string(),
            port: 9000,
        }
    }
}

/// The declaration file, at the app's root. Named for the brand's config file
/// so it sits beside the app's other TeamClu-owned config rather than inventing
/// a second convention.
const MANIFEST_FILE: &str = "teamclu.app.json";

/// Read the app's declaration, falling back to the built-in contract.
///
/// A malformed file is a warning, not a failure: the defaults still describe a
/// deployable app, and refusing to build because a hint file has a typo would
/// be a worse trade than deploying what the app actually produced.
pub fn read_runtime_manifest(workdir: &Path) -> AppRuntimeManifest {
    let path = workdir.join(MANIFEST_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return AppRuntimeManifest::default();
    };
    match serde_json::from_str::<PartialManifest>(&text) {
        Ok(partial) => partial.resolve(),
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "ignoring unreadable app manifest");
            AppRuntimeManifest::default()
        }
    }
}

/// Every field optional, so a file that names only what it changes is valid.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialManifest {
    output: Option<String>,
    runtime: Option<String>,
    entry: Option<String>,
    port: Option<u16>,
}

impl PartialManifest {
    fn resolve(self) -> AppRuntimeManifest {
        let d = AppRuntimeManifest::default();
        let pick = |v: Option<String>, fallback: String| {
            v.map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or(fallback)
        };
        AppRuntimeManifest {
            output: pick(self.output, d.output),
            runtime: pick(self.runtime, d.runtime),
            entry: pick(self.entry, d.entry),
            port: self.port.filter(|p| *p > 0).unwrap_or(d.port),
        }
    }
}

/// A finished build: the artifact, and the commit it was made from.
pub struct BuildOutput {
    pub bytes: Vec<u8>,
    /// What the app declared about how it is run. Reported so the control plane
    /// can start the function the way the app expects instead of the one way it
    /// used to assume.
    pub manifest: AppRuntimeManifest,
    /// Set only when the deploy published pending work and so built a commit
    /// the caller did not know about. The caller must finalize with this one:
    /// recording the sha it started with would name a commit that is not what
    /// is now running.
    pub git_commit_sha: Option<String>,
}

/// Run `pnpm install` then `pnpm build` in `workdir`, then zip the `.output` dir.
///
/// When `git` is present the workdir is fetched, published and checked out
/// first (see [`prepare_git_build`]).
pub fn build_artifact(
    workdir: &Path,
    git: Option<&BuildGitContext<'_>>,
) -> anyhow::Result<BuildOutput> {
    let mut git_commit_sha = None;
    if let Some(ctx) = git {
        git_commit_sha = prepare_git_build(workdir, ctx)?;
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

    let manifest = read_runtime_manifest(workdir);
    let output_dir = workdir.join(&manifest.output);
    if !output_dir.is_dir() || !output_dir_has_files(&output_dir) {
        // Name what was looked for. The message used to say only ".output/",
        // which is unhelpful precisely when an app builds somewhere else — the
        // case this whole manifest exists for.
        anyhow::bail!("{ERR_OUTPUT_MISSING}: {}", manifest.output);
    }

    let bytes = zip_dir(&output_dir)?;
    if bytes.is_empty() {
        anyhow::bail!("{ERR_OUTPUT_MISSING}");
    }
    if bytes.len() > MAX_ARTIFACT_BYTES {
        anyhow::bail!("{ERR_ARTIFACT_TOO_LARGE}");
    }
    Ok(BuildOutput {
        bytes,
        git_commit_sha,
        manifest,
    })
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
    fn map_pnpm_failure_detects_frozen_lockfile() {
        // On stdout, which is where pnpm actually puts it.
        let msg = map_pnpm_failure(
            "pnpm",
            &["install", "--frozen-lockfile"],
            "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile",
            "",
        );
        assert_eq!(msg, ERR_LOCKFILE_MISMATCH);
    }

    #[test]
    fn an_app_with_no_manifest_gets_the_built_in_contract() {
        // The file is optional on purpose: every app deployed before it existed
        // must keep deploying with no change.
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            read_runtime_manifest(tmp.path()),
            AppRuntimeManifest::default()
        );
    }

    #[test]
    fn a_manifest_names_only_what_it_changes() {
        // The failure this was written for: an app that builds to `dist/` and
        // starts `dist/index.js`. It should not have to restate the port.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            r#"{"output":"dist","entry":"index.js"}"#,
        )
        .unwrap();

        let m = read_runtime_manifest(tmp.path());
        assert_eq!(m.output, "dist");
        assert_eq!(m.entry, "index.js");
        assert_eq!(m.runtime, "node", "unstated fields keep the default");
        assert_eq!(m.port, 9000);
    }

    #[test]
    fn a_broken_manifest_does_not_stop_a_deploy() {
        // Defaults still describe a deployable app. Refusing to build because a
        // hint file has a typo is a worse trade than building what the app
        // actually produced.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(MANIFEST_FILE), "{not json").unwrap();
        assert_eq!(
            read_runtime_manifest(tmp.path()),
            AppRuntimeManifest::default()
        );

        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            r#"{"output":"  ","port":0}"#,
        )
        .unwrap();
        let m = read_runtime_manifest(tmp.path());
        assert_eq!(m.output, ".output", "an empty value is not a value");
        assert_eq!(m.port, 9000);
    }

    #[test]
    fn map_pnpm_failure_names_an_app_with_no_code() {
        let msg = map_pnpm_failure(
            "pnpm",
            &["install", "--frozen-lockfile"],
            " ERR_PNPM_NO_PKG_MANIFEST  No package.json found in /apps/app-1",
            "",
        );
        assert_eq!(msg, ERR_NO_PACKAGE_JSON);
    }

    #[test]
    fn map_pnpm_failure_reports_what_pnpm_wrote_on_stdout() {
        // The shape of the failure this was written for: the reason is on
        // stdout and stderr holds an unrelated warning, so reading stderr alone
        // reported the warning as the cause. A code with no friendly mapping of
        // its own, so what is being checked is that the raw cause survives.
        let msg = map_pnpm_failure(
            "pnpm",
            &["install", "--frozen-lockfile"],
            " ERR_PNPM_FETCH_404  GET https://registry/x: Not Found",
            " WARN  Issue while reading \"/home/me/.npmrc\". Failed to replace env in config: ${NODE_AUTH_TOKEN}",
        );
        assert!(
            msg.contains("ERR_PNPM_FETCH_404"),
            "the actual cause must survive: {msg}"
        );
        assert_ne!(msg, ERR_LOCKFILE_MISMATCH);
    }

    #[test]
    fn a_healthy_lockfile_line_is_not_a_mismatch() {
        // `pnpm install` says this on the way to succeeding at resolution, so
        // matching the bare word "lockfile" against stdout would report every
        // later failure as a stale lockfile.
        let msg = map_pnpm_failure(
            "pnpm",
            &["install", "--frozen-lockfile"],
            "Lockfile is up to date, resolution step is skipped\nERR_PNPM_FETCH_404  GET https://registry/x: Not Found",
            "",
        );
        assert_ne!(msg, ERR_LOCKFILE_MISMATCH);
        assert!(msg.contains("ERR_PNPM_FETCH_404"), "{msg}");
    }

    #[test]
    fn a_long_log_is_carried_by_its_tail() {
        let noise = "a".repeat(MAX_FAILURE_OUTPUT * 2);
        let msg = map_pnpm_failure("pnpm", &["build"], &format!("{noise}\nthe real error"), "");
        assert!(msg.contains("the real error"), "tail must survive");
        assert!(
            msg.len() < MAX_FAILURE_OUTPUT + 200,
            "message must stay bounded: {}",
            msg.len()
        );
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
