//! Build an app workspace into a deployable artifact zip.
//!
//! The async presigned-URL upload lives in the HTTP handler (reqwest is async);
//! this module stays sync so it can run inside `spawn_blocking`.

use crate::process_util::CommandNoWindow;
use crate::sync::app_git::{self, SshEnv};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output};
use std::time::Duration;

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
/// Container-build markers. Each names the one thing the user can do about it:
/// every one of these is a fact about their machine, not about the app.
pub const ERR_NO_DOCKER: &str =
    "Docker is not installed or not on PATH; a container app is built with it on this machine";
pub const ERR_DOCKER_NOT_RUNNING: &str = "Docker is installed but not running; start it and retry";
pub const ERR_NO_BUILDX: &str =
    "this Docker has no buildx; a container app is cross-built for linux/amd64 with it";
pub const ERR_NO_DOCKERFILE: &str = "the app declares runtime \"container\" but has no Dockerfile";
pub const ERR_IMAGE_BUILD_TIMEOUT: &str = "docker build timed out after 30 minutes";
pub const ERR_IMAGE_PUSH_TIMEOUT: &str = "docker push timed out after 15 minutes";
pub const ERR_IMAGE_PUSH_DENIED: &str =
    "the registry refused the push; the deployment's registry credentials may have expired — retry deploy";
/// A container app reached the daemon without a registry to push to. The
/// control plane decides which handle a deploy gets, so this is a bug there
/// rather than anything the user can fix — but it must not read as a build
/// failure in their app.
pub const ERR_NO_PUSH_TARGET: &str =
    "this deploy supplied no image registry, and the app declares runtime \"container\"";

/// Cap on the command output carried in a failure message.
///
/// Uncapped it was the whole of a failing `pnpm build`'s log, in an HTTP 500
/// body and the desktop console. The tail is the useful end: pnpm's `ERR_PNPM_*`
/// line is the whole of a failed install, and a build tool's own error is the
/// last thing it prints before it gives up.
const MAX_FAILURE_OUTPUT: usize = 2000;

const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const BUILD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Longer than the node build's, because the image is cross-built: Function
/// Compute runs x86_64 only, and the machines these apps are written on are
/// mostly arm64, so every RUN line goes through emulation. Measured on a
/// two-stage Flask + Vite app on an M-series Mac with a cold cache: 1m55s.
const IMAGE_BUILD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const IMAGE_PUSH_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The one architecture Function Compute runs. Not a preference: the FC 3.0
/// API has no architecture field at all, so an arm64 image is accepted by the
/// registry and then fails to start with an exec-format error.
const FC_PLATFORM: &str = "linux/amd64";
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
        .env("GIT_TERMINAL_PROMPT", "0");

    // The spawn, the pipe draining and the kill live in `bounded_proc`: the
    // clone path needs exactly the same thing, and two copies of a poll loop
    // that kills process groups is one copy too many.
    let out = crate::sync::bounded_proc::run_bounded(command, timeout, timeout_msg)?;
    if !out.status.success() {
        let msg = map_pnpm_failure(
            cmd,
            args,
            &String::from_utf8_lossy(&out.stdout),
            &String::from_utf8_lossy(&out.stderr),
        );
        anyhow::bail!("{msg}");
    }
    Ok(out)
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
    /// Directory to package, relative to the workdir. Unused by `container`,
    /// which ships an image rather than an archive.
    pub output: String,
    /// Interpreter family, or `container`. The deployment maps this to a
    /// runtime layer and a binary; an unknown value is the control plane's to
    /// reject, not the daemon's — it is the side that knows which layers exist.
    pub runtime: String,
    /// Entry path inside the packaged directory. Unused by `container`: the
    /// image's own `CMD`/`ENTRYPOINT` is its entry.
    pub entry: String,
    /// Port the app listens on. For `container` this is what the deployment
    /// tells Function Compute to send requests to, so it has to match what the
    /// image actually listens on — the image's `EXPOSE` is documentation and
    /// nothing reads it.
    pub port: u16,
    /// `container`: the Dockerfile, relative to the workdir.
    pub dockerfile: String,
    /// `container`: the build context, relative to the workdir.
    pub context: String,
    /// `container`: a path the app answers 200 on, used as the function's
    /// health check. Absent means the deployment's default check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_check_path: Option<String>,
}

/// Whether this manifest asks for an image rather than a code archive.
pub const CONTAINER_RUNTIME: &str = "container";

impl AppRuntimeManifest {
    pub fn is_container(&self) -> bool {
        self.runtime == CONTAINER_RUNTIME
    }
}

impl Default for AppRuntimeManifest {
    fn default() -> Self {
        Self {
            output: ".output".to_string(),
            runtime: "node".to_string(),
            entry: "server/index.mjs".to_string(),
            port: 9000,
            dockerfile: "Dockerfile".to_string(),
            context: ".".to_string(),
            health_check_path: None,
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
    dockerfile: Option<String>,
    context: Option<String>,
    health_check_path: Option<String>,
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
            // A path that climbs out of the workdir is dropped rather than
            // refused: the file is a hint, and the defaults still describe a
            // deployable app. Refusing would let a typo in an optional field
            // stop a deploy that has nothing else wrong with it.
            dockerfile: pick(
                self.dockerfile.filter(|p| is_inside_workdir(p)),
                d.dockerfile,
            ),
            context: pick(self.context.filter(|p| is_inside_workdir(p)), d.context),
            health_check_path: self
                .health_check_path
                .map(|s| s.trim().to_string())
                .filter(|s| s.starts_with('/')),
        }
    }
}

/// Whether a manifest-declared relative path stays under the workdir.
///
/// The daemon joins these against the checkout and hands them to `docker`, so
/// an absolute path or a `..` segment would build someone else's directory.
fn is_inside_workdir(path: &str) -> bool {
    let p = path.trim();
    // `starts_with('/')` as well as `is_absolute`: a unix-style absolute path
    // is not absolute *on Windows*, and it is still not a path inside the
    // checkout there either.
    !p.is_empty()
        && !p.starts_with('/')
        && !p.starts_with('~')
        && !Path::new(p).is_absolute()
        && !Path::new(p)
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
}

/// Where a container build pushes its image, and how it authenticates.
///
/// Minted per deploy by the control plane, which is the only side holding the
/// registry account. Short-lived, and never logged or put in a command line —
/// see [`push_image`] for why the password reaches `docker` through a config
/// file rather than an argument.
pub struct ImagePushTarget<'a> {
    /// Full reference to push: `<registry>/<namespace>/<repo>:<tag>`.
    pub image: &'a str,
    /// Registry host, as it appears in the reference — the key `docker` looks
    /// its credentials up under.
    pub registry: &'a str,
    pub username: &'a str,
    pub password: &'a str,
}

/// What a build produced, which is not the same kind of thing for every app.
pub enum BuildProduct {
    /// A zip of the app's output directory, for the presigned OSS upload.
    Archive(Vec<u8>),
    /// An image already in the registry. Nothing is uploaded through the
    /// control plane: the daemon pushed it, and the reference is what the
    /// function is pointed at.
    Image(String),
}

impl BuildProduct {
    /// The archive bytes, for the caller that has an upload to do.
    pub fn archive(self) -> Option<Vec<u8>> {
        match self {
            Self::Archive(bytes) => Some(bytes),
            Self::Image(_) => None,
        }
    }

    /// The pushed image reference, when this build produced one.
    pub fn image(&self) -> Option<&str> {
        match self {
            Self::Image(reference) => Some(reference),
            Self::Archive(_) => None,
        }
    }
}

/// A finished build: the artifact, and the commit it was made from.
pub struct BuildOutput {
    pub product: BuildProduct,
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

/// Build the app, however this app is built.
///
/// When `git` is present the workdir is fetched, published and checked out
/// first (see [`prepare_git_build`]). What happens after that is the app's own
/// declaration: `container` builds and pushes an image, everything else runs
/// `pnpm install` then `pnpm build` and zips the output directory.
///
/// The manifest is read **before** the build rather than after. It used to be
/// read only to find the output directory, which a node build has already
/// produced by then; a container app has to be recognised before anything runs
/// `pnpm` at it, or the failure is a missing `package.json` in an app that
/// never had one.
pub fn build_artifact(
    workdir: &Path,
    git: Option<&BuildGitContext<'_>>,
    push: Option<&ImagePushTarget<'_>>,
) -> anyhow::Result<BuildOutput> {
    let mut git_commit_sha = None;
    if let Some(ctx) = git {
        git_commit_sha = prepare_git_build(workdir, ctx)?;
    }
    let manifest = read_runtime_manifest(workdir);
    if manifest.is_container() {
        let target = push.ok_or_else(|| anyhow::anyhow!("{ERR_NO_PUSH_TARGET}"))?;
        build_image(workdir, &manifest, target)?;
        return Ok(BuildOutput {
            product: BuildProduct::Image(target.image.to_string()),
            git_commit_sha,
            manifest,
        });
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
        product: BuildProduct::Archive(bytes),
        git_commit_sha,
        manifest,
    })
}

/// Cross-build the app's image for Function Compute and push it.
///
/// Two commands rather than `buildx --push`: the build wants the machine's own
/// builder and layer cache (an emulated build with a cold cache is minutes),
/// and the push wants credentials the machine must not keep. Splitting them
/// lets each have what it needs — see [`push_image`].
fn build_image(
    workdir: &Path,
    manifest: &AppRuntimeManifest,
    target: &ImagePushTarget<'_>,
) -> anyhow::Result<()> {
    let dockerfile = workdir.join(&manifest.dockerfile);
    if !dockerfile.is_file() {
        anyhow::bail!("{ERR_NO_DOCKERFILE}: {}", manifest.dockerfile);
    }
    run_docker(
        &[
            "buildx",
            "build",
            "--platform",
            FC_PLATFORM,
            "--file",
            &manifest.dockerfile,
            "--tag",
            target.image,
            // Into the local image store, which is what `docker push` reads.
            "--load",
            &manifest.context,
        ],
        workdir,
        None,
        IMAGE_BUILD_TIMEOUT,
        ERR_IMAGE_BUILD_TIMEOUT,
    )?;
    push_image(workdir, target)
}

/// Push the built image with credentials that touch nothing of the user's.
///
/// `docker login` would write the registry password into the machine's own
/// `~/.docker/config.json` and leave it there; passing it as an argument would
/// put it in every process listing on the machine for as long as the push runs.
/// So the credentials go into a private config directory, mode 0600, that this
/// function deletes — `docker` reads it because `DOCKER_CONFIG` points there
/// for the push and for nothing else.
///
/// The build deliberately does NOT run under that directory: `buildx` keeps its
/// builder state in the config dir, and an empty one makes it create a fresh
/// builder with no layer cache — turning a two-minute rebuild into the full
/// emulated build every time.
fn push_image(workdir: &Path, target: &ImagePushTarget<'_>) -> anyhow::Result<()> {
    let config_dir = tempfile::Builder::new()
        .prefix("teamclu-registry-")
        .tempdir()
        .map_err(|e| anyhow::anyhow!("could not stage registry credentials: {e}"))?;
    write_registry_config(config_dir.path(), target)?;
    let out = run_docker(
        &["push", target.image],
        workdir,
        Some(config_dir.path()),
        IMAGE_PUSH_TIMEOUT,
        ERR_IMAGE_PUSH_TIMEOUT,
    );
    // Explicit, so the credentials are gone before the error is propagated
    // rather than whenever the guard happens to drop.
    drop(config_dir);
    out.map(|_| ())
}

fn write_registry_config(dir: &Path, target: &ImagePushTarget<'_>) -> anyhow::Result<()> {
    use base64::Engine as _;
    let auth = base64::engine::general_purpose::STANDARD
        .encode(format!("{}:{}", target.username, target.password));
    let config = serde_json::json!({
        "auths": { target.registry: { "auth": auth } }
    });
    let path = dir.join("config.json");
    let mut file = std::fs::File::create(&path)
        .map_err(|e| anyhow::anyhow!("could not stage registry credentials: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Before the secret is written, not after: between create and chmod the
        // file is world-readable, and that is exactly the window that matters.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| anyhow::anyhow!("could not protect registry credentials: {e}"))?;
    }
    file.write_all(config.to_string().as_bytes())
        .map_err(|e| anyhow::anyhow!("could not stage registry credentials: {e}"))?;
    Ok(())
}

/// Run one `docker` command, mapping the failures a user can act on.
fn run_docker(
    args: &[&str],
    cwd: &Path,
    config_dir: Option<&Path>,
    timeout: Duration,
    timeout_msg: &str,
) -> anyhow::Result<Output> {
    let mut command = Command::new("docker");
    command.no_window().args(args).current_dir(cwd);
    if let Some(dir) = config_dir {
        command.env("DOCKER_CONFIG", dir);
    }
    let out = match crate::sync::bounded_proc::run_bounded(command, timeout, timeout_msg) {
        Ok(out) => out,
        Err(e) => {
            // `run_bounded` reports a spawn failure as "could not run docker".
            // On a machine without Docker that is the whole story, and the
            // io::ErrorKind is gone by here — so match on what it says.
            let msg = format!("{e}");
            if msg.contains("could not run docker") {
                anyhow::bail!("{ERR_NO_DOCKER}");
            }
            return Err(e);
        }
    };
    if out.status.success() {
        return Ok(out);
    }
    let combined = [
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    ]
    .into_iter()
    .filter(|p| !p.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    anyhow::bail!("{}", map_docker_failure(args, &combined));
}

/// Turn docker's own output into the one sentence the user can act on.
fn map_docker_failure(args: &[&str], combined: &str) -> String {
    let lower = combined.to_ascii_lowercase();
    if lower.contains("cannot connect to the docker daemon")
        || lower.contains("is the docker daemon running")
    {
        return ERR_DOCKER_NOT_RUNNING.to_string();
    }
    if lower.contains("'buildx' is not a docker command")
        || lower.contains("unknown command \"buildx\"")
    {
        return ERR_NO_BUILDX.to_string();
    }
    if lower.contains("denied: requested access")
        || lower.contains("unauthorized")
        || lower.contains("authentication required")
    {
        return ERR_IMAGE_PUSH_DENIED.to_string();
    }
    format!(
        "docker {:?} failed: {}",
        args,
        tail(combined, MAX_FAILURE_OUTPUT)
    )
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
    fn a_container_app_declares_its_dockerfile_and_port() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            r#"{"runtime":"container","port":5000,"dockerfile":"deploy/Dockerfile","healthCheckPath":"/api/health"}"#,
        )
        .unwrap();

        let m = read_runtime_manifest(tmp.path());
        assert!(m.is_container());
        assert_eq!(m.port, 5000);
        assert_eq!(m.dockerfile, "deploy/Dockerfile");
        assert_eq!(m.context, ".", "unstated context is the checkout root");
        assert_eq!(m.health_check_path.as_deref(), Some("/api/health"));
    }

    #[test]
    fn a_manifest_path_that_climbs_out_of_the_checkout_is_ignored() {
        // These are handed to `docker` as `--file` and as the build context. A
        // path out of the workdir would build a directory that is not the app;
        // the default still describes a buildable one, so it wins.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            r#"{"runtime":"container","dockerfile":"../../etc/Dockerfile","context":"/etc"}"#,
        )
        .unwrap();

        let m = read_runtime_manifest(tmp.path());
        assert_eq!(m.dockerfile, "Dockerfile");
        assert_eq!(m.context, ".");
    }

    #[test]
    fn a_health_check_path_must_be_a_path() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            r#"{"runtime":"container","healthCheckPath":"api/health"}"#,
        )
        .unwrap();
        assert_eq!(read_runtime_manifest(tmp.path()).health_check_path, None);
    }

    #[test]
    fn a_container_build_without_a_registry_says_so() {
        // Not a build failure in the app: the control plane decides which
        // handle a deploy carries, and this one carried none.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(MANIFEST_FILE), r#"{"runtime":"container"}"#).unwrap();
        std::fs::write(tmp.path().join("Dockerfile"), "FROM scratch\n").unwrap();

        // Matched rather than `unwrap_err`, which would need `BuildOutput` to
        // be `Debug` — and the archive variant holds up to 50 MiB of bytes
        // that nothing should ever be able to print into a log.
        let err = match build_artifact(tmp.path(), None, None) {
            Err(e) => e.to_string(),
            Ok(_) => panic!("a container app with no registry must not build"),
        };
        assert_eq!(err, ERR_NO_PUSH_TARGET);
    }

    #[test]
    fn a_container_app_without_a_dockerfile_says_which_file_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            r#"{"runtime":"container","dockerfile":"deploy/Dockerfile"}"#,
        )
        .unwrap();
        let manifest = read_runtime_manifest(tmp.path());
        let target = ImagePushTarget {
            image: "registry.example.com/ns/app:sha",
            registry: "registry.example.com",
            username: "u",
            password: "p",
        };

        let err = build_image(tmp.path(), &manifest, &target)
            .unwrap_err()
            .to_string();
        assert!(err.starts_with(ERR_NO_DOCKERFILE), "{err}");
        assert!(err.contains("deploy/Dockerfile"), "{err}");
    }

    #[test]
    fn registry_credentials_are_staged_private_and_never_in_a_command_line() {
        use base64::Engine as _;
        let dir = tempfile::tempdir().unwrap();
        let target = ImagePushTarget {
            image: "registry.example.com/ns/app:sha",
            registry: "registry.example.com",
            username: "temp-user",
            password: "s3cret",
        };
        write_registry_config(dir.path(), &target).unwrap();

        let raw = std::fs::read_to_string(dir.path().join("config.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let auth = parsed["auths"]["registry.example.com"]["auth"]
            .as_str()
            .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(auth)
                .unwrap(),
            b"temp-user:s3cret"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("config.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "the password is in this file");
        }
    }

    #[test]
    fn docker_failures_name_the_thing_the_user_can_fix() {
        assert_eq!(
            map_docker_failure(
                &["push", "x"],
                "Cannot connect to the Docker daemon at unix:///var/run/docker.sock."
            ),
            ERR_DOCKER_NOT_RUNNING
        );
        assert_eq!(
            map_docker_failure(
                &["buildx", "build"],
                "docker: 'buildx' is not a docker command."
            ),
            ERR_NO_BUILDX
        );
        assert_eq!(
            map_docker_failure(
                &["push", "x"],
                "denied: requested access to the resource is denied"
            ),
            ERR_IMAGE_PUSH_DENIED
        );
        // Anything else keeps docker's own words: they are the only account of
        // what went wrong inside someone's Dockerfile.
        let other = map_docker_failure(&["buildx", "build"], "ERROR: failed to solve: pip died");
        assert!(other.contains("pip died"), "{other}");
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
