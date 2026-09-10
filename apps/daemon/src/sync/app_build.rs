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
pub const ERR_NO_PYTHON_PROJECT: &str =
    "the app declares build.kind \"python\" but has no requirements.txt, pyproject.toml, or build output";
pub const ERR_NO_GO_MOD: &str = "the app declares build.kind \"go\" but has no go.mod";
pub const ERR_NO_JAVA_BUILD: &str =
    "the app declares build.kind \"java\" but has no pom.xml, build.gradle, or build.gradle.kts";
pub const ERR_LOCKFILE_MISMATCH: &str =
    "lockfile out of sync with package.json; commit updated pnpm-lock.yaml";
pub const ERR_INSTALL_TIMEOUT: &str = "pnpm install timed out after 10 minutes";
pub const ERR_BUILD_TIMEOUT: &str = "pnpm build timed out after 10 minutes";
pub const ERR_BUILD_COMMAND_TIMEOUT: &str = "build command timed out after 10 minutes";
/// pnpm could not be started at all. Distinct from every failure above, which
/// are pnpm's own: this one is a fact about the machine, and on Windows it used
/// to surface as a bare "the system cannot find the file specified" with no
/// mention of pnpm in it.
pub const ERR_NO_PNPM: &str =
    "pnpm is not installed or not on PATH; an app with a package.json is built with it on this machine";
/// Container-build markers. Each names the one thing the user can do about it:
/// every one of these is a fact about their machine, not about the app.
pub const ERR_NO_DOCKER: &str =
    "Docker is not installed or not on PATH; a container app is built with it on this machine";
pub const ERR_DOCKER_NOT_RUNNING: &str = "Docker is installed but not running; start it and retry";
pub const ERR_NO_BUILDX: &str =
    "this Docker has no buildx; a container app is cross-built for linux/amd64 with it";
pub const ERR_NO_DOCKERFILE: &str =
    "the app declares build.kind \"container\" but has no Dockerfile";
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

/// The program to hand `Command::new` for a build tool.
///
/// Two problems, one answer. On Windows, Rust resolves a bare program name by
/// appending `.exe` and nothing else — it never consults `PATHEXT` — and
/// everything npm ships is a `.cmd` shim: there is no `pnpm.exe`. So
/// `Command::new("pnpm")` cannot start pnpm on a machine where `pnpm --version`
/// works perfectly in a shell, and the deploy died with a bare "the system
/// cannot find the file specified". #1046 established the rule for `npm`/`npx`
/// (`well_known_bin::spawn_name`); this path was simply never taught it.
///
/// The absolute path is preferred over the name because amuxd is usually
/// started by the desktop app rather than a login shell, and the PATH it
/// inherits then is not the user's own. Falling back to the shim name keeps a
/// machine whose PATH we cannot reproduce working exactly as before.
fn build_tool_program(cmd: &str) -> String {
    use crate::runtime::well_known_bin;
    well_known_bin::find_in_path(cmd, None)
        .or_else(|| well_known_bin::find(cmd, &[]))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| well_known_bin::spawn_name(cmd))
}

fn run_with_timeout(
    cmd: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
    timeout_msg: &str,
) -> anyhow::Result<Output> {
    run_with_timeout_env(cmd, args, cwd, timeout, timeout_msg, &[])
}

fn run_with_timeout_env(
    cmd: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
    timeout_msg: &str,
    env: &[(&str, &str)],
) -> anyhow::Result<Output> {
    let mut command = Command::new(build_tool_program(cmd));
    command
        .no_window()
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .envs(env.iter().copied());

    // The spawn, the pipe draining and the kill live in `bounded_proc`: the
    // clone path needs exactly the same thing, and two copies of a poll loop
    // that kills process groups is one copy too many.
    let out = match crate::sync::bounded_proc::run_bounded(command, timeout, timeout_msg) {
        Ok(out) => out,
        Err(e) => {
            // `run_bounded` reports a spawn failure as "could not run <program>"
            // and the io::ErrorKind is gone by here, so match on what it says —
            // the same shape `run_docker` uses one screen down. Without this the
            // user is told the system cannot find a file, and not which.
            if cmd == "pnpm" && format!("{e}").starts_with("could not run ") {
                anyhow::bail!("{ERR_NO_PNPM}");
            }
            return Err(e);
        }
    };
    if !out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let msg = if cmd == "pnpm" {
            map_pnpm_failure(cmd, args, &stdout, &stderr)
        } else {
            let combined = [stdout.trim(), stderr.trim()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "{cmd} {:?} failed: {}",
                args,
                tail(&combined, MAX_FAILURE_OUTPUT)
            )
        };
        anyhow::bail!("{msg}");
    }
    Ok(out)
}

/// The default command table. Conditional rows are selected by
/// [`run_default_build`]; this pure view keeps the six-kind contract explicit
/// and cheaply testable.
pub fn default_build_plan(kind: &str) -> Option<&'static [&'static str]> {
    match kind {
        "node" => Some(&["pnpm install --frozen-lockfile", "pnpm build"]),
        "python" => Some(&["pip install -r requirements.txt -t <output> (when present)"]),
        "go" => Some(&["CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o <output>/main ."]),
        "php" => Some(&["composer install --no-dev (when composer.json is present)"]),
        "java" => Some(&[
            "./mvnw package or mvn package",
            "./gradlew build or gradle build",
        ]),
        "container" => Some(&["docker buildx build", "docker push"]),
        _ => None,
    }
}

fn run_shell_override(command: &str, workdir: &Path, image: Option<&str>) -> anyhow::Result<()> {
    let image_env = image.map(|value| [("TEAMCLU_IMAGE", value)]);
    run_with_timeout_env(
        "sh",
        &["-c", command],
        workdir,
        BUILD_TIMEOUT,
        ERR_BUILD_COMMAND_TIMEOUT,
        image_env.as_ref().map_or(&[], |env| env.as_slice()),
    )
    .map(|_| ())
}

fn run_default_build(kind: &str, output: &str, workdir: &Path) -> anyhow::Result<()> {
    match kind {
        "node" => {
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
        }
        "python" => {
            if workdir.join("requirements.txt").is_file() {
                run_with_timeout(
                    "pip",
                    &["install", "-r", "requirements.txt", "-t", output],
                    workdir,
                    INSTALL_TIMEOUT,
                    ERR_INSTALL_TIMEOUT,
                )?;
            }
        }
        "go" => {
            std::fs::create_dir_all(workdir.join(output))?;
            let output_main = format!("{output}/main");
            let mut command = Command::new(build_tool_program("go"));
            command
                .no_window()
                .args(["build", "-o", &output_main, "."])
                .current_dir(workdir)
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("CGO_ENABLED", "0")
                .env("GOOS", "linux")
                .env("GOARCH", "amd64");
            let out =
                crate::sync::bounded_proc::run_bounded(
                    command,
                    BUILD_TIMEOUT,
                    ERR_BUILD_COMMAND_TIMEOUT,
                )?;
            if !out.status.success() {
                let combined = [
                    String::from_utf8_lossy(&out.stdout).trim().to_string(),
                    String::from_utf8_lossy(&out.stderr).trim().to_string(),
                ]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
                anyhow::bail!("go build failed: {}", tail(&combined, MAX_FAILURE_OUTPUT));
            }
        }
        "php" => {
            if workdir.join("composer.json").is_file() {
                run_with_timeout(
                    "composer",
                    &["install", "--no-dev"],
                    workdir,
                    INSTALL_TIMEOUT,
                    ERR_INSTALL_TIMEOUT,
                )?;
            }
        }
        "java" => {
            if workdir.join("pom.xml").is_file() {
                if workdir.join("mvnw").is_file() {
                    run_with_timeout(
                        "./mvnw",
                        &["package"],
                        workdir,
                        BUILD_TIMEOUT,
                        ERR_BUILD_COMMAND_TIMEOUT,
                    )?;
                } else {
                    run_with_timeout(
                        "mvn",
                        &["package"],
                        workdir,
                        BUILD_TIMEOUT,
                        ERR_BUILD_COMMAND_TIMEOUT,
                    )?;
                }
            } else if workdir.join("gradlew").is_file() {
                run_with_timeout(
                    "./gradlew",
                    &["build"],
                    workdir,
                    BUILD_TIMEOUT,
                    ERR_BUILD_COMMAND_TIMEOUT,
                )?;
            } else {
                run_with_timeout(
                    "gradle",
                    &["build"],
                    workdir,
                    BUILD_TIMEOUT,
                    ERR_BUILD_COMMAND_TIMEOUT,
                )?;
            }
        }
        other => anyhow::bail!("unsupported build.kind {other}"),
    }
    Ok(())
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

const DEFAULT_OUTPUT: &str = ".output";
const DEFAULT_DOCKERFILE: &str = "Dockerfile";
const DEFAULT_CONTEXT: &str = ".";
const VALID_BUILD_KINDS: &[&str] = &["node", "python", "go", "php", "java", "container"];

pub const ERR_LEGACY_MANIFEST: &str = "teamclu.app.json uses legacy runtime/entry; declare build+start (see docs/specs/2026-09-11-fc-runtime-passthrough-design.md)";
pub const ERR_MISSING_MANIFEST: &str = "teamclu.app.json is required (build+start)";

fn default_output() -> String {
    DEFAULT_OUTPUT.to_string()
}

fn default_dockerfile() -> String {
    DEFAULT_DOCKERFILE.to_string()
}

fn default_context() -> String {
    DEFAULT_CONTEXT.to_string()
}

/// How the daemon turns an app checkout into an artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBuildSpec {
    pub kind: String,
    #[serde(default = "default_output")]
    pub output: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default = "default_dockerfile")]
    pub dockerfile: String,
    #[serde(default = "default_context")]
    pub context: String,
}

/// How the control plane starts the built artifact in Function Compute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStartSpec {
    #[serde(default)]
    pub fc_runtime: Option<String>,
    #[serde(default)]
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    pub port: u16,
    #[serde(default)]
    pub layers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_check_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDeclaration {
    pub build: AppBuildSpec,
    pub start: AppStartSpec,
}

/// The declaration file, at the app's root. Named for the brand's config file
/// so it sits beside the app's other TeamClu-owned config rather than inventing
/// a second convention.
const MANIFEST_FILE: &str = "teamclu.app.json";

/// Read and validate the required app declaration. There are deliberately no
/// checkout-derived defaults: missing, malformed, and legacy declarations stop
/// the deploy so the repository remains the single source of truth.
pub fn read_app_declaration(workdir: &Path) -> anyhow::Result<AppDeclaration> {
    let path = workdir.join(MANIFEST_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            anyhow::bail!("{ERR_MISSING_MANIFEST}")
        }
        Err(e) => anyhow::bail!("could not read {}: {e}", path.display()),
    };
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| anyhow::anyhow!("invalid {MANIFEST_FILE}: {e}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("{MANIFEST_FILE} must be a JSON object with build+start"))?;
    if object.contains_key("runtime") || object.contains_key("entry") {
        anyhow::bail!("{ERR_LEGACY_MANIFEST}");
    }

    let mut declaration: AppDeclaration = serde_json::from_value(value)
        .map_err(|e| anyhow::anyhow!("invalid {MANIFEST_FILE} build+start declaration: {e}"))?;
    declaration.build.kind = declaration.build.kind.trim().to_string();
    if !VALID_BUILD_KINDS.contains(&declaration.build.kind.as_str()) {
        anyhow::bail!(
            "{MANIFEST_FILE} has invalid build.kind {:?}; expected one of {}",
            declaration.build.kind,
            VALID_BUILD_KINDS.join(", ")
        );
    }
    for (name, path) in [
        ("build.output", &declaration.build.output),
        ("build.dockerfile", &declaration.build.dockerfile),
        ("build.context", &declaration.build.context),
    ] {
        if !is_inside_workdir(path) {
            anyhow::bail!("{MANIFEST_FILE} {name} must stay inside the workdir");
        }
    }
    if declaration.start.port == 0 {
        anyhow::bail!("{MANIFEST_FILE} start.port must be between 1 and 65535");
    }
    if declaration.build.kind != "container" {
        let runtime_present = declaration
            .start
            .fc_runtime
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        let command_present = declaration.start.command.as_ref().is_some_and(|command| {
            !command.is_empty() && command.iter().all(|part| !part.trim().is_empty())
        });
        if !runtime_present || !command_present {
            anyhow::bail!(
                "{MANIFEST_FILE} code apps require non-empty start.fcRuntime and start.command"
            );
        }
    }
    if declaration
        .start
        .health_check_path
        .as_deref()
        .is_some_and(|path| !path.starts_with('/'))
    {
        anyhow::bail!("{MANIFEST_FILE} start.healthCheckPath must start with '/'");
    }
    Ok(declaration)
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
    /// Full reference to push: `<registry>/<namespace>/<repo>:<tag>`. The tag
    /// is the control plane's best guess at the time it minted this; the build
    /// corrects it when it turns out to name the wrong commit, which is what
    /// [`image_tagged_with`] is for.
    pub image: &'a str,
    /// Registry host, as it appears in the reference — the key `docker` looks
    /// its credentials up under.
    pub registry: &'a str,
    pub username: &'a str,
    pub password: &'a str,
}

/// The same repository, tagged with the commit the build actually used.
///
/// The push target is minted before the build runs, from the sha the client
/// read off the forge. But the build publishes whatever the agent left
/// uncommitted first (see [`prepare_git_build`]), and after that HEAD is a
/// commit the minted tag never named. Pushing under it does two wrong things:
/// the image is labelled with a commit it was not built from, and the tag
/// stops being immutable — two deploys off the same forge HEAD carrying
/// different uncommitted work put different bytes on one tag, and Function
/// Compute pulls by tag, so a function that was never redeployed can come back
/// from a cold start running someone else's build.
///
/// Only the tag is rewritten. The registry, namespace and repository stay
/// exactly what the control plane authorised, so this cannot push anywhere it
/// was not given credentials for. `None` leaves the minted reference alone:
/// when it names a digest there is no tag to correct, and a tag the registry
/// would reject is not an improvement on a stale one.
fn image_tagged_with(reference: &str, tag: &str) -> Option<String> {
    if reference.contains('@') || !is_docker_tag(tag) {
        return None;
    }
    // A registry host may carry a port, so the tag separator is the last `:`
    // *after* the last `/` — in `localhost:5000/app` that colon is the port and
    // the reference has no tag at all.
    let repo = match reference.rfind('/') {
        Some(slash) => reference[slash + 1..]
            .rfind(':')
            .map_or(reference, |colon| &reference[..slash + 1 + colon]),
        None => reference.rfind(':').map_or(reference, |c| &reference[..c]),
    };
    Some(format!("{repo}:{tag}"))
}

/// The tag grammar a registry accepts: 1–128 of `[A-Za-z0-9_.-]`, not opening
/// with a separator.
fn is_docker_tag(tag: &str) -> bool {
    (1..=128).contains(&tag.len())
        && tag.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
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
    pub declaration: AppDeclaration,
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
/// declaration: `container` builds and pushes an image; the five archive kinds
/// use their row in the build table (or `build.command`) and zip `build.output`.
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
    let declaration = read_app_declaration(workdir)?;
    let build_override = declaration
        .build
        .command
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty());
    if declaration.build.kind == "container" {
        let minted = push.ok_or_else(|| anyhow::anyhow!("{ERR_NO_PUSH_TARGET}"))?;
        // `git_commit_sha` is set only when the build published work the client
        // did not know about, which is exactly when the minted tag is stale.
        // Nothing to correct otherwise — the tag already names this commit.
        let corrected = git_commit_sha
            .as_deref()
            .and_then(|sha| image_tagged_with(minted.image, sha));
        let target = ImagePushTarget {
            image: corrected.as_deref().unwrap_or(minted.image),
            registry: minted.registry,
            username: minted.username,
            password: minted.password,
        };
        if let Some(command) = build_override {
            // For containers the override must build and tag
            // `$TEAMCLU_IMAGE`; pushing remains daemon-owned so registry
            // credentials stay out of the app command and the user's Docker
            // config.
            run_shell_override(command, workdir, Some(target.image))?;
            push_image(workdir, &target)?;
        } else {
            build_image(workdir, &declaration.build, &target)?;
        }
        return Ok(BuildOutput {
            product: BuildProduct::Image(target.image.to_string()),
            git_commit_sha,
            declaration,
        });
    }

    let output_dir = workdir.join(&declaration.build.output);
    if let Some(command) = build_override {
        // An override is the complete build, not an extra post-build step.
        run_shell_override(command, workdir, None)?;
    } else {
        match declaration.build.kind.as_str() {
            "node" if !workdir.join("package.json").is_file() => {
                anyhow::bail!("{ERR_NO_PACKAGE_JSON}")
            }
            "python"
                if !workdir.join("requirements.txt").is_file()
                    && !workdir.join("pyproject.toml").is_file()
                    && (!output_dir.is_dir() || !output_dir_has_files(&output_dir)) =>
            {
                anyhow::bail!("{ERR_NO_PYTHON_PROJECT}")
            }
            "go" if !workdir.join("go.mod").is_file() => anyhow::bail!("{ERR_NO_GO_MOD}"),
            "java"
                if !workdir.join("pom.xml").is_file()
                    && !workdir.join("build.gradle").is_file()
                    && !workdir.join("build.gradle.kts").is_file() =>
            {
                anyhow::bail!("{ERR_NO_JAVA_BUILD}")
            }
            _ => {}
        }
        run_default_build(&declaration.build.kind, &declaration.build.output, workdir)?;
    }

    if !output_dir.is_dir() || !output_dir_has_files(&output_dir) {
        // Name what was looked for. The message used to say only ".output/",
        // which is unhelpful precisely when an app builds somewhere else — the
        // case this whole manifest exists for.
        anyhow::bail!("{ERR_OUTPUT_MISSING}: {}", declaration.build.output);
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
        declaration,
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
    build: &AppBuildSpec,
    target: &ImagePushTarget<'_>,
) -> anyhow::Result<()> {
    let dockerfile = workdir.join(&build.dockerfile);
    if !dockerfile.is_file() {
        anyhow::bail!("{ERR_NO_DOCKERFILE}: {}", build.dockerfile);
    }
    run_docker(
        &[
            "buildx",
            "build",
            "--platform",
            FC_PLATFORM,
            "--file",
            &build.dockerfile,
            "--tag",
            target.image,
            // Into the local image store, which is what `docker push` reads.
            "--load",
            &build.context,
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

    /// A checkout that looks like a node app, for the cases about everything
    /// *except* which kind of app it is.
    fn node_checkout() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("package.json"), "{}").unwrap();
        tmp
    }

    fn write_container_declaration(
        workdir: &Path,
        dockerfile: &str,
        health_check_path: Option<&str>,
    ) {
        std::fs::write(
            workdir.join(MANIFEST_FILE),
            serde_json::json!({
                "build": {
                    "kind": "container",
                    "output": ".output",
                    "dockerfile": dockerfile,
                    "context": "."
                },
                "start": {
                    "port": 5000,
                    "healthCheckPath": health_check_path
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    fn write_code_declaration(workdir: &Path, kind: &str, output: &str) {
        std::fs::write(
            workdir.join(MANIFEST_FILE),
            serde_json::json!({
                "build": {"kind": kind, "output": output},
                "start": {
                    "fcRuntime": "custom.debian12",
                    "command": ["run"],
                    "port": 9000
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn an_app_with_no_manifest_is_refused() {
        let tmp = node_checkout();
        let err = read_app_declaration(tmp.path()).unwrap_err().to_string();
        assert_eq!(err, ERR_MISSING_MANIFEST);
    }

    #[test]
    fn an_app_with_no_package_json_is_not_inferred_as_container() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Dockerfile"), "FROM scratch\n").unwrap();
        assert!(read_app_declaration(tmp.path()).is_err());
    }

    #[test]
    fn a_broken_manifest_is_refused() {
        let tmp = node_checkout();
        std::fs::write(tmp.path().join(MANIFEST_FILE), "{not json").unwrap();
        assert!(read_app_declaration(tmp.path()).is_err());
    }

    #[test]
    fn a_legacy_manifest_is_refused_with_migration_guidance() {
        let tmp = node_checkout();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            r#"{"runtime":"node","entry":"server/index.mjs"}"#,
        )
        .unwrap();
        let err = read_app_declaration(tmp.path()).unwrap_err().to_string();
        assert!(
            err.contains("legacy") && err.contains("build+start"),
            "{err}"
        );
    }

    #[test]
    fn legacy_fields_are_refused_even_alongside_build_and_start() {
        let tmp = node_checkout();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            r#"{
                "runtime":"node",
                "build":{"kind":"node","output":".output","command":null,"dockerfile":"Dockerfile","context":"."},
                "start":{"fcRuntime":"custom.debian10","command":["node"],"args":["server/index.mjs"],"port":9000}
            }"#,
        )
        .unwrap();
        assert_eq!(
            read_app_declaration(tmp.path()).unwrap_err().to_string(),
            ERR_LEGACY_MANIFEST
        );
    }

    #[test]
    fn a_valid_node_declaration_is_read_with_camel_case_fields() {
        let tmp = node_checkout();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            r#"{
                "build":{"kind":"node","output":"dist","command":null},
                "start":{
                    "fcRuntime":"custom.debian12",
                    "command":["node"],
                    "args":["index.js"],
                    "port":9000,
                    "layers":[],
                    "healthCheckPath":"/health"
                }
            }"#,
        )
        .unwrap();

        let declaration = read_app_declaration(tmp.path()).unwrap();
        assert_eq!(declaration.build.kind, "node");
        assert_eq!(declaration.build.output, "dist");
        assert_eq!(declaration.build.dockerfile, "Dockerfile");
        assert_eq!(declaration.build.context, ".");
        assert_eq!(
            declaration.start.fc_runtime.as_deref(),
            Some("custom.debian12")
        );
        assert_eq!(declaration.start.command, Some(vec!["node".to_string()]));
        assert_eq!(
            declaration.start.health_check_path.as_deref(),
            Some("/health")
        );
        let wire = serde_json::to_value(&declaration).unwrap();
        assert_eq!(wire["start"]["fcRuntime"], "custom.debian12");
        assert_eq!(wire["start"]["healthCheckPath"], "/health");
        assert!(wire["start"].get("fc_runtime").is_none());
    }

    #[test]
    fn an_unknown_build_kind_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            r#"{
                "build":{"kind":"ruby","output":".","command":null,"dockerfile":"Dockerfile","context":"."},
                "start":{"fcRuntime":"custom.debian12","command":["ruby"],"args":["app.rb"],"port":9000}
            }"#,
        )
        .unwrap();
        let err = read_app_declaration(tmp.path()).unwrap_err().to_string();
        assert!(err.contains("ruby"), "{err}");
    }

    #[test]
    fn default_build_table_covers_all_six_kinds() {
        for kind in VALID_BUILD_KINDS {
            let plan = default_build_plan(kind).unwrap_or_else(|| panic!("missing {kind} plan"));
            assert!(!plan.is_empty(), "{kind} plan must have a default step");
        }
        assert_eq!(
            default_build_plan("node").unwrap(),
            ["pnpm install --frozen-lockfile", "pnpm build"]
        );
        assert!(default_build_plan("ruby").is_none());
    }

    #[test]
    fn project_preconditions_follow_declared_kind_not_file_inference() {
        for (kind, marker) in [
            ("node", ERR_NO_PACKAGE_JSON),
            ("python", ERR_NO_PYTHON_PROJECT),
            ("go", ERR_NO_GO_MOD),
            ("java", ERR_NO_JAVA_BUILD),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            write_code_declaration(tmp.path(), kind, ".output");
            // A Dockerfile must not make any of these kinds pass.
            std::fs::write(tmp.path().join("Dockerfile"), "FROM scratch\n").unwrap();
            let err = match build_artifact(tmp.path(), None, None) {
                Err(e) => e.to_string(),
                Ok(_) => panic!("{kind} app without its project marker must not build"),
            };
            assert_eq!(err, marker, "{kind}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn build_command_replaces_node_defaults_and_their_preconditions() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            serde_json::json!({
                "build": {
                    "kind": "node",
                    "output": "custom-out",
                    "command": "mkdir -p custom-out && printf overridden > custom-out/result.txt"
                },
                "start": {
                    "fcRuntime": "custom.debian12",
                    "command": ["node"],
                    "port": 9000
                }
            })
            .to_string(),
        )
        .unwrap();

        let built = build_artifact(tmp.path(), None, None).unwrap();
        let bytes = built.product.archive().unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut result = String::new();
        archive
            .by_name("result.txt")
            .unwrap()
            .read_to_string(&mut result)
            .unwrap();
        assert_eq!(result, "overridden");
    }

    #[cfg(unix)]
    #[test]
    fn container_override_replaces_dockerfile_precondition_through_build_artifact() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            serde_json::json!({
                "build": {
                    "kind": "container",
                    "command": "printf reached > override-ran && exit 23"
                },
                "start": {"port": 9000}
            })
            .to_string(),
        )
        .unwrap();
        let target = ImagePushTarget {
            image: "registry.example.com/apps/a:sha",
            registry: "registry.example.com",
            username: "u",
            password: "p",
        };

        let err = match build_artifact(tmp.path(), None, Some(&target)) {
            Err(err) => err.to_string(),
            Ok(_) => panic!("the intentionally failing override must stop the build"),
        };
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("override-ran")).unwrap(),
            "reached"
        );
        assert!(!err.contains(ERR_NO_DOCKERFILE), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn container_override_receives_the_minted_image_reference() {
        let tmp = tempfile::tempdir().unwrap();
        run_shell_override(
            "printf %s \"$TEAMCLU_IMAGE\" > image.txt",
            tmp.path(),
            Some("registry.example.com/apps/a:sha"),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("image.txt")).unwrap(),
            "registry.example.com/apps/a:sha"
        );
    }

    #[test]
    fn php_without_composer_archives_declared_output() {
        let tmp = tempfile::tempdir().unwrap();
        write_code_declaration(tmp.path(), "php", "public");
        std::fs::create_dir(tmp.path().join("public")).unwrap();
        std::fs::write(tmp.path().join("public/index.php"), "<?php echo 'ok';").unwrap();

        let built = build_artifact(tmp.path(), None, None).unwrap();
        assert!(built.product.archive().is_some());
    }

    #[test]
    fn a_container_app_declares_its_dockerfile_and_port() {
        let tmp = tempfile::tempdir().unwrap();
        write_container_declaration(tmp.path(), "deploy/Dockerfile", Some("/api/health"));

        let declaration = read_app_declaration(tmp.path()).unwrap();
        assert_eq!(declaration.build.kind, "container");
        assert_eq!(declaration.start.port, 5000);
        assert_eq!(declaration.build.dockerfile, "deploy/Dockerfile");
        assert_eq!(declaration.build.context, ".");
        assert_eq!(
            declaration.start.health_check_path.as_deref(),
            Some("/api/health")
        );
    }

    #[test]
    fn a_declaration_path_that_climbs_out_of_the_checkout_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(MANIFEST_FILE),
            r#"{
                "build":{"kind":"container","output":".output","dockerfile":"../../etc/Dockerfile","context":"/etc"},
                "start":{"port":9000}
            }"#,
        )
        .unwrap();

        assert!(read_app_declaration(tmp.path()).is_err());
    }

    #[test]
    fn a_health_check_path_must_be_a_path() {
        let tmp = tempfile::tempdir().unwrap();
        write_container_declaration(tmp.path(), "Dockerfile", Some("api/health"));
        assert!(read_app_declaration(tmp.path()).is_err());
    }

    #[test]
    fn a_container_build_without_a_registry_says_so() {
        // Not a build failure in the app: the control plane decides which
        // handle a deploy carries, and this one carried none.
        let tmp = tempfile::tempdir().unwrap();
        write_container_declaration(tmp.path(), "Dockerfile", None);
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
    fn an_image_is_retagged_with_the_commit_that_was_built() {
        assert_eq!(
            image_tagged_with("registry.example.com/apps/tc-app-1:303adca", "a43b715").as_deref(),
            Some("registry.example.com/apps/tc-app-1:a43b715"),
        );
    }

    #[test]
    fn retagging_leaves_a_registry_port_alone() {
        // The last `:` is the port, not a tag — appending must not eat it.
        assert_eq!(
            image_tagged_with("localhost:5000/apps/tc-app-1", "a43b715").as_deref(),
            Some("localhost:5000/apps/tc-app-1:a43b715"),
        );
        assert_eq!(
            image_tagged_with("localhost:5000/apps/tc-app-1:old", "a43b715").as_deref(),
            Some("localhost:5000/apps/tc-app-1:a43b715"),
        );
    }

    #[test]
    fn a_digest_reference_and_an_unusable_tag_are_left_as_minted() {
        // Already immutable; there is no tag to correct.
        assert_eq!(
            image_tagged_with("registry.example.com/apps/a@sha256:abc", "a43b715"),
            None,
        );
        // A tag the registry would reject is not an improvement on a stale one.
        for bad in ["", "-leading", "has space", "has/slash"] {
            assert_eq!(
                image_tagged_with("registry.example.com/apps/a:old", bad),
                None,
                "{bad:?}",
            );
        }
    }

    #[test]
    fn a_container_app_without_a_dockerfile_says_which_file_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        write_container_declaration(tmp.path(), "deploy/Dockerfile", None);
        let declaration = read_app_declaration(tmp.path()).unwrap();
        let target = ImagePushTarget {
            image: "registry.example.com/ns/app:sha",
            registry: "registry.example.com",
            username: "u",
            password: "p",
        };

        let err = build_image(tmp.path(), &declaration.build, &target)
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
