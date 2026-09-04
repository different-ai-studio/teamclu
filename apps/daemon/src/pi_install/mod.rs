//! The managed pi runtime: pi + the MCP SDK, installed by amuxd into one
//! directory on amuxd's own Node (#1250).
//!
//! `apps/daemon/pi-runtime/package.json` + `package-lock.json` pin the two
//! packages exactly; `pi.lock.json` repeats those versions for the mirror
//! workflows and doctor, and pins the Node they run on. Installing means:
//!
//! 1. [`crate::node_install::run_install`] — the pinned Node under
//!    `<amuxd cache>/node/<version>/`.
//! 2. `node npm-cli.js ci` in `<amuxd cache>/pi/`, with the two manifests
//!    materialized there. The package root is then a *constant*
//!    (`<cache>/pi/node_modules/@earendil-works/pi-coding-agent`): no `pi`
//!    shim, no PATH, no `~/.pi`, no global npm prefix, nothing of the user's.
//!
//! On Windows a prebuilt archive of exactly that layout is tried first
//! (`bundle`), because npm writing thousands of small files is the slow part
//! of a first run there.
//!
//! Layout under `<amuxd cache>/pi/`:
//!
//! ```text
//! package.json  package-lock.json      ← materialized from pi-runtime/
//! node_modules/@earendil-works/pi-coding-agent/   ← package root
//! node_modules/@modelcontextprotocol/sdk/
//! extensions/teamclu.ts                ← resolves the SDK one level up
//! host/host.mjs
//! ```
//!
//! Developers who need a different pi or Node set `[agents.pi] package_root`
//! / `[agents.pi] node` in daemon.toml. Those are explicit paths, never
//! searches.

pub mod bundle;
pub mod mcp_sdk;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::opencode_install::version_ge;
use crate::process_util::CommandNoWindow;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiLock {
    /// The Node.js release the runtime runs on (`node_install`).
    #[serde(default)]
    pub node: String,
    pub version: String,
    /// `@modelcontextprotocol/sdk` version the pi extension's MCP bridge is
    /// written against. Defaulted rather than required so a lock file from an
    /// older build still parses (the SDK step then simply does not run).
    #[serde(default)]
    pub mcp_sdk_version: String,
}

/// Embedded at compile time from apps/daemon/pi.lock.json
pub const LOCK_JSON: &str = include_str!("../../pi.lock.json");

/// The npm project that *is* the runtime. Materialized verbatim into
/// `<cache>/pi/` and installed with `npm ci`, so what runs is exactly what the
/// lock resolved — on every machine, from any registry.
pub const RUNTIME_PACKAGE_JSON: &str = include_str!("../../pi-runtime/package.json");
pub const RUNTIME_PACKAGE_LOCK: &str = include_str!("../../pi-runtime/package-lock.json");

fn lock() -> Option<PiLock> {
    serde_json::from_str::<PiLock>(LOCK_JSON).ok()
}

/// The pi version this build runs (lock version, no leading `v`).
pub fn required_version() -> String {
    lock()
        .map(|l| l.version.trim().trim_start_matches('v').to_string())
        .unwrap_or_default()
}

/// The `@modelcontextprotocol/sdk` version this build's extension requires.
/// Empty means the lock file does not pin one — treat MCP as unmanaged.
pub fn required_mcp_sdk_version() -> String {
    lock()
        .map(|l| l.mcp_sdk_version.trim().trim_start_matches('v').to_string())
        .unwrap_or_default()
}

/// The Node.js release the runtime runs on (no leading `v`).
pub fn required_node_version() -> String {
    lock()
        .map(|l| l.node.trim().trim_start_matches('v').to_string())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

pub const PI_NPM_PKG: &str = "@earendil-works/pi-coding-agent";

/// `<amuxd cache>/pi` — the runtime's npm project root and everything amuxd
/// materializes for pi (extension, host script, permissions, tool cache).
pub fn pi_dir() -> PathBuf {
    crate::config::layout::cache_dir().join("pi")
}

pub(crate) fn node_modules_dir() -> PathBuf {
    pi_dir().join("node_modules")
}

/// `[agents.pi] package_root = "<dir>"` — a developer's explicit pi checkout
/// (the directory holding pi's `package.json` and `dist/`). Read at call time
/// so a config edit applies on the next spawn.
fn configured_package_root() -> Option<PathBuf> {
    crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
        .ok()
        .and_then(|c| c.agents.pi.and_then(|pi| pi.package_root))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// The npm package root of the pi the daemon runs: the directory whose
/// `dist/index.js` the multi-session host imports and whose
/// `dist/cli.js` legacy `--mode rpc` runs.
pub fn package_root() -> PathBuf {
    configured_package_root().unwrap_or_else(|| {
        node_modules_dir()
            .join("@earendil-works")
            .join("pi-coding-agent")
    })
}

/// Whether [`package_root`] is amuxd's own install rather than an override.
pub fn is_managed() -> bool {
    configured_package_root().is_none()
}

/// `version` out of an npm package manifest.
pub(crate) fn version_of_manifest(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let version = value.get("version")?.as_str()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// The pi version installed at [`package_root`], read off its manifest. No
/// `--version` spawn: the manifest is the truth and reading it is free.
pub fn installed_version() -> Option<String> {
    let manifest = std::fs::read_to_string(package_root().join("package.json")).ok()?;
    // A wrapper package at the configured root would also have a version;
    // only pi's own manifest counts.
    if !manifest.contains(&format!("\"{PI_NPM_PKG}\"")) {
        return None;
    }
    version_of_manifest(&manifest)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiStatus {
    pub present: bool,
    pub version: Option<String>,
    /// The package root (see [`package_root`]).
    pub path: Option<String>,
    /// Pi is a Node CLI. Kept separate from Pi's own version so onboarding and
    /// diagnostics can say which half is missing.
    pub node_present: bool,
    pub node_version: Option<String>,
    pub node_path: Option<String>,
    pub node_satisfied: bool,
    pub required_node_version: String,
    /// amuxd's own Node (true) or a `[agents.pi] node` override (false).
    pub node_managed: bool,
    pub required_version: String,
    /// `@modelcontextprotocol/sdk` in the managed runtime. Reported separately
    /// because it is a separate package, but folded into `satisfied` — without
    /// it the extension bridges no MCP servers at all, which costs remote-tools
    /// and every team tool with it.
    pub mcp_sdk_present: bool,
    pub mcp_sdk_version: Option<String>,
    pub required_mcp_sdk_version: String,
    pub mcp_sdk_satisfied: bool,
    /// Whether amuxd installed pi (true) or `[agents.pi] package_root` points
    /// at the user's own (false).
    pub managed: bool,
    pub satisfied: bool,
}

pub fn doctor() -> PiStatus {
    let want = required_version();
    let managed = is_managed();
    let version = installed_version();
    let pi_satisfied = version
        .as_deref()
        .map(|have| {
            if managed {
                have == want
            } else {
                version_ge(have, &want)
            }
        })
        .unwrap_or(false);
    let node = crate::node_install::doctor();
    let want_sdk = required_mcp_sdk_version();
    let sdk_version = mcp_sdk::installed_version();
    let sdk_satisfied = mcp_sdk::satisfied();
    PiStatus {
        present: version.is_some(),
        path: version
            .is_some()
            .then(|| package_root().to_string_lossy().to_string()),
        version,
        node_present: node.present,
        node_version: node.version.clone(),
        node_path: node.path.clone(),
        node_satisfied: node.satisfied,
        required_node_version: node.required_version.clone(),
        node_managed: node.managed,
        required_version: want,
        mcp_sdk_present: sdk_version.is_some(),
        mcp_sdk_version: sdk_version,
        required_mcp_sdk_version: want_sdk,
        mcp_sdk_satisfied: sdk_satisfied,
        managed,
        satisfied: pi_satisfied && node.satisfied && sdk_satisfied,
    }
}

// ---------------------------------------------------------------------------
// Progress narration
// ---------------------------------------------------------------------------

pub(crate) fn progress(event: &str, message: &str) {
    println!(
        "{}",
        serde_json::json!({ "event": event, "message": message })
    );
}

/// A progress line that also names the source this install settled on.
///
/// `route` is one of [`crate::route_probe::route`]. The message stays the
/// human-readable detail (measured speeds, which URL); `route` is the part the
/// wizard can translate and keep on screen after the line itself scrolls away.
pub(crate) fn progress_route(event: &str, message: &str, route: &str) {
    println!(
        "{}",
        serde_json::json!({ "event": event, "message": message, "route": route })
    );
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

/// `node npm-cli.js …` on the managed Node, in the runtime directory.
///
/// Never `npm` by name: the shim is `npm.cmd` on Windows (#1046), and whichever
/// Node is first on PATH is the one a shim would run under (#1232). Spelling
/// out both files removes both questions. `PATH` is still led by the managed
/// Node's `bin` for the `#!/usr/bin/env node` scripts npm itself spawns.
pub(crate) fn npm_command() -> std::process::Command {
    let node = crate::node_install::node_binary();
    let mut command = std::process::Command::new(&node);
    command.no_window();
    command.arg(crate::node_install::npm_cli_for(&node));
    command.env(
        "PATH",
        crate::runtime::well_known_bin::augmented_path_led_by(node.parent()),
    );
    let dir = pi_dir();
    let _ = std::fs::create_dir_all(&dir);
    command.current_dir(dir);
    command
}

const PI_MIRROR_BASE: &str = "https://teamclaw.ucar.cc/pi";
const OFFICIAL_REGISTRY: &str = "https://registry.npmjs.org";

/// Alibaba's public npm mirror — a full sync of the official registry, and the
/// route that actually works from mainland China. Verified to carry both
/// packages we pin, at the pinned versions.
///
/// Only ever applied to our own npm invocation (via the environment), never
/// written to the user's npmrc.
const CN_NPM_REGISTRY: &str = "https://registry.npmmirror.com";

pub(crate) const NETWORK_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Sample size for a registry route. The pi tarball is ~5 MB, so 512 KiB is a
/// tenth of it: past the initial burst, cheap enough to throw away.
const REGISTRY_PROBE_BYTES: u64 = 512 * 1024;

/// Below this the sample says more about handshake jitter than the route.
const REGISTRY_MIN_SAMPLE: u64 = 64 * 1024;

const REGISTRY_PROBE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(4);

/// The floor for a route to count as usable when it is the only one left.
/// npm pulls the tarball plus a dependency tree, so this is a "the install
/// finishes in seconds, not minutes" line rather than a precise one.
const REGISTRY_USABLE_BYTES_PER_SEC: f64 = 1024.0 * 1024.0;

/// How much faster the mirror has to be before it overrides a *working*
/// official route. Without this hysteresis, a healthy route that happened to
/// dip during the probe would send a user outside China to a Chinese registry.
const MIRROR_ADVANTAGE: f64 = 1.5;

/// `latest.json` served next to an OSS-mirrored npm bundle.
#[derive(Debug, Deserialize)]
pub(super) struct MirrorManifest {
    pub version: String,
    pub asset: String,
    pub sha256: String,
}

/// Where the npm packages should come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RegistrySource {
    /// Whatever npm is already configured with. No override.
    NpmDefault,
    /// Override our own invocation with this registry.
    Mirror(&'static str),
    /// No registry is usable from here; install from the OSS tarball bundles.
    OssBundle,
}

/// npm's tarball URL convention: `<registry>/<pkg>/-/<name>-<version>.tgz`,
/// where the scope is dropped from the file name.
fn tarball_url(registry: &str, package: &str, version: &str) -> String {
    let file = package.rsplit('/').next().unwrap_or(package);
    format!(
        "{}/{package}/-/{file}-{version}.tgz",
        registry.trim_end_matches('/')
    )
}

fn registry_probe() -> crate::route_probe::Probe {
    crate::route_probe::Probe {
        bytes: REGISTRY_PROBE_BYTES,
        min_sample: REGISTRY_MIN_SAMPLE,
        connect_timeout: NETWORK_PROBE_TIMEOUT,
        transfer_deadline: REGISTRY_PROBE_DEADLINE,
        min_bytes_per_sec: REGISTRY_USABLE_BYTES_PER_SEC,
    }
}

/// What `npm config get registry` reports, or None when npm cannot answer.
///
/// Our npm, but the *user's* config: npm reads `~/.npmrc` regardless of which
/// copy runs, so a registry the user configured is still honoured.
fn npm_configured_registry() -> Option<String> {
    let out = npm_command()
        .args(["config", "get", "registry"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!value.is_empty() && value != "undefined").then_some(value)
}

fn is_official_registry(url: &str) -> bool {
    url.trim_end_matches('/') == OFFICIAL_REGISTRY
}

/// Is the mirror worth overriding the official registry for?
///
/// Pure, so the hysteresis is testable without a network. `official: None`
/// means that route failed outright, in which case anything that answers wins.
fn mirror_wins(
    official: Option<&crate::route_probe::RouteSample>,
    mirror: &crate::route_probe::RouteSample,
    probe: &crate::route_probe::Probe,
) -> bool {
    if mirror.bytes < probe.min_sample {
        return false;
    }
    match official {
        // Nothing else answered, so the bar is absolute: a mirror that is
        // itself crawling loses to the OSS bundle on our own CDN.
        None => mirror.meets(probe),
        Some(official) => mirror.bytes_per_sec() >= official.bytes_per_sec() * MIRROR_ADVANTAGE,
    }
}

/// Pick the registry to install from, by measuring both routes.
///
/// The old check asked only whether registry.npmjs.org answered, and answered
/// it with a metadata GET — so a mainland install passed the preflight and
/// then spent minutes pulling tarballs at a trickle. Timing a few hundred KB
/// of the real tarball is the question that was meant.
fn resolve_registry_source(package: &str, version: &str) -> RegistrySource {
    // A user who configured their own registry has already answered this
    // question, quite possibly with a mirror of their own. Overriding that
    // would be worse than anything we could pick for them.
    if let Some(configured) = npm_configured_registry() {
        if !is_official_registry(&configured) {
            progress_route(
                "source",
                &format!("npm is configured with {configured}; installing through it"),
                crate::route_probe::route::CUSTOM,
            );
            return RegistrySource::NpmDefault;
        }
    }

    // Said before the measuring starts, not after it. Each sample gets a 5s
    // connect budget and a 4s transfer deadline, so this decision is up to nine
    // seconds of pure network work — and it used to announce itself only once it
    // was over, leaving the wizard frozen on the previous line for the whole
    // window. On the networks where the answer actually matters, that is exactly
    // the window that runs long.
    progress("probe", "checking which download route is fastest");

    // Both routes are measured every time, concurrently. A panicking probe
    // counts as "no answer" rather than taking the install down with it.
    let probe = registry_probe();
    let (official, mirror) = std::thread::scope(|scope| {
        let official =
            scope.spawn(|| probe.measure(&tarball_url(OFFICIAL_REGISTRY, package, version)));
        let mirror = scope.spawn(|| probe.measure(&tarball_url(CN_NPM_REGISTRY, package, version)));
        (official.join().ok().flatten(), mirror.join().ok().flatten())
    });
    match (&official, &mirror) {
        (_, Some(mirror_sample)) if mirror_wins(official.as_ref(), mirror_sample, &probe) => {
            progress_route(
                "source",
                &format!(
                    "{CN_NPM_REGISTRY} measured at {:.1} MB/s against {} for the official registry; \
                     installing through the mirror",
                    mirror_sample.mib_per_sec(),
                    official
                        .map(|s| format!("{:.1} MB/s", s.mib_per_sec()))
                        .unwrap_or_else(|| "no answer".to_string())
                ),
                crate::route_probe::route::PUBLIC_MIRROR,
            );
            RegistrySource::Mirror(CN_NPM_REGISTRY)
        }
        (Some(sample), _) => {
            progress_route(
                "source",
                &format!(
                    "npm registry measured at {:.1} MB/s and the mirror is no better; \
                     installing from upstream",
                    sample.mib_per_sec()
                ),
                crate::route_probe::route::OFFICIAL,
            );
            RegistrySource::NpmDefault
        }
        (None, _) => {
            progress_route(
                "source",
                "no npm registry is reachable; falling back to the OSS bundles",
                crate::route_probe::route::SELF_HOSTED,
            );
            RegistrySource::OssBundle
        }
    }
}

/// The registry decision, made once per process. Resolved lazily: an install
/// that early-returns "already satisfied" must not pay for a probe.
pub(super) fn registry_source() -> RegistrySource {
    static SOURCE: std::sync::OnceLock<RegistrySource> = std::sync::OnceLock::new();
    *SOURCE.get_or_init(|| resolve_registry_source(PI_NPM_PKG, &required_version()))
}

/// Apply a chosen registry to a child process, through the environment: the
/// user's npmrc is never touched.
pub(super) fn apply_registry(command: &mut std::process::Command, source: RegistrySource) {
    if let RegistrySource::Mirror(url) = source {
        command.env("NPM_CONFIG_REGISTRY", url);
    }
}

pub(super) fn mirror_manifest(base: &str) -> Option<MirrorManifest> {
    let url = format!("{}/latest.json", base.trim_end_matches('/'));
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()
        .and_then(|runtime| {
            runtime.block_on(async {
                let response = reqwest::Client::builder()
                    .timeout(NETWORK_PROBE_TIMEOUT)
                    .build()
                    .ok()?
                    .get(url)
                    .send()
                    .await
                    .ok()?
                    .error_for_status()
                    .ok()?;
                response.json::<MirrorManifest>().await.ok()
            })
        })
}

/// Streams byte-count progress lines while the body arrives, so a slow OSS
/// route shows movement instead of a frozen "installing…".
pub(crate) fn download_bytes(url: &str) -> anyhow::Result<Vec<u8>> {
    crate::download_progress::download(url)
}

/// How much of a command's output to keep for its failure message. The lines
/// themselves are streamed as they arrive; this is only what gets quoted back
/// if the command exits non-zero.
const OUTPUT_TAIL_LINES: usize = 20;

/// Read one pipe to EOF on its own thread, emitting each line as it arrives and
/// keeping the tail for the caller's error message.
fn pump_output<R: std::io::Read + Send + 'static>(
    reader: R,
    tail: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    use std::io::BufRead;
    std::thread::spawn(move || {
        // `lines()` would be the obvious call and is the wrong one: it yields
        // `Err(InvalidData)` for any line that is not valid UTF-8, and one such
        // line would end this thread, drop the pipe, and take the rest of the
        // install narration with it. npm on a non-English Windows console emits
        // its output in the OEM codepage (GBK on zh-CN), so that is not a
        // hypothetical — it is the platform this streaming exists for. Read raw
        // and transcode lossily.
        let mut reader = std::io::BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buf).trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            progress("output", &line);
            let mut tail = tail.lock().unwrap_or_else(|e| e.into_inner());
            if tail.len() == OUTPUT_TAIL_LINES {
                tail.remove(0);
            }
            tail.push(line);
        }
    })
}

/// Run `command`, streaming both pipes as `output` progress lines instead of
/// holding them until the process exits.
///
/// npm spends minutes on a slow route and writes its status to *stderr*.
/// `.output()` buffered every byte of that until exit, so the wizard's install
/// row had nothing to show for the whole wait. Returns the exit status and the
/// tail of the combined output, which is what callers quote when it fails.
pub(super) fn run_streaming(
    cmd: &str,
    command: &mut std::process::Command,
) -> anyhow::Result<(std::process::ExitStatus, String)> {
    use std::process::Stdio;
    use std::sync::{Arc, Mutex};

    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("failed to run {cmd}: {e}"))?;

    let tail = Arc::new(Mutex::new(Vec::new()));
    let pumps: Vec<_> = [
        child
            .stdout
            .take()
            .map(|r| pump_output(r, Arc::clone(&tail))),
        child
            .stderr
            .take()
            .map(|r| pump_output(r, Arc::clone(&tail))),
    ]
    .into_iter()
    .flatten()
    .collect();

    let status = child
        .wait()
        .map_err(|e| anyhow::anyhow!("{cmd} did not exit cleanly: {e}"))?;
    // Join after wait(): a pipe can still hold buffered lines when the child
    // exits, and dropping them would empty the failure message.
    for pump in pumps {
        let _ = pump.join();
    }

    let tail = tail.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
    Ok((status, tail))
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Fetch the versioned, dependency-bundled package from OSS and materialize it
/// as a temporary `.tgz` that npm can install without contacting a registry.
///
/// `label` only names the thing in errors and progress lines; `base` is the
/// OSS prefix that serves `latest.json` and `<version>/<asset>`.
pub(super) fn mirrored_bundle(
    label: &str,
    base: &str,
    version: &str,
) -> anyhow::Result<tempfile::NamedTempFile> {
    let manifest = mirror_manifest(base)
        .ok_or_else(|| anyhow::anyhow!("{label} OSS mirror is unavailable"))?;
    if manifest.version.trim_start_matches('v') != version {
        anyhow::bail!(
            "{label} OSS mirror has {}, but this build requires {version}",
            manifest.version
        );
    }
    if !safe_mirror_asset(&manifest.asset) {
        anyhow::bail!("{label} OSS mirror returned an invalid asset name");
    }
    let url = format!(
        "{}/{}/{}",
        base.trim_end_matches('/'),
        version,
        manifest.asset
    );
    progress("mirror", &format!("downloading {label} from OSS: {url}"));
    let bytes = download_bytes(&url)?;
    if sha256_hex(&bytes) != manifest.sha256.to_ascii_lowercase() {
        anyhow::bail!(
            "{label} OSS bundle checksum mismatch; retry later or use the official npm registry"
        );
    }
    let file = tempfile::Builder::new().suffix(".tgz").tempfile()?;
    std::fs::write(file.path(), bytes)?;
    Ok(file)
}

pub(super) fn safe_mirror_asset(asset: &str) -> bool {
    !asset.is_empty() && !asset.contains('/') && !asset.contains('\\') && asset.ends_with(".tgz")
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/// Write embedded content to its on-disk path (only when the content changed,
/// so mtimes stay stable).
pub(crate) fn materialize(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    let current = std::fs::read_to_string(path).unwrap_or_default();
    if current != content {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, content)?;
    }
    Ok(())
}

/// Put the runtime's `package.json` + `package-lock.json` in place for `npm ci`.
fn materialize_runtime_manifests() -> anyhow::Result<()> {
    let dir = pi_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow::anyhow!("cannot create {}: {e}", dir.display()))?;
    materialize(&dir.join("package.json"), RUNTIME_PACKAGE_JSON)
        .map_err(|e| anyhow::anyhow!("cannot write the pi runtime package.json: {e}"))?;
    materialize(&dir.join("package-lock.json"), RUNTIME_PACKAGE_LOCK)
        .map_err(|e| anyhow::anyhow!("cannot write the pi runtime package-lock.json: {e}"))?;
    Ok(())
}

/// `npm ci` against the lock, through the chosen registry.
fn install_with_npm_ci(source: RegistrySource) -> anyhow::Result<()> {
    let args = ["ci", "--omit=dev", "--no-audit", "--no-fund"];
    progress("install", &format!("running npm {}", args.join(" ")));
    let mut command = npm_command();
    apply_registry(&mut command, source);
    let (status, tail) = run_streaming("npm", command.args(args))?;
    if !status.success() {
        anyhow::bail!("pi install failed ({status}): {tail}");
    }
    Ok(())
}

/// No registry reachable: install the two dependency-bundled tarballs from
/// OSS with `npm --offline`. Their dependencies are inlined
/// (`bundledDependencies`, see `mirror-pi-oss.yml`), so nothing is fetched.
/// `--no-save` keeps the materialized manifests exactly as the lock has them.
fn install_from_oss_bundles(pi_version: &str, sdk_version: &str) -> anyhow::Result<()> {
    let pi = mirrored_bundle("Pi", PI_MIRROR_BASE, pi_version)?;
    let sdk = if sdk_version.is_empty() {
        None
    } else {
        Some(mirrored_bundle(
            "MCP SDK",
            mcp_sdk::MIRROR_BASE,
            sdk_version,
        )?)
    };
    let mut args: Vec<String> = vec![
        "install".into(),
        "--offline".into(),
        "--no-save".into(),
        "--no-audit".into(),
        "--no-fund".into(),
        "--omit=dev".into(),
        pi.path().to_string_lossy().to_string(),
    ];
    if let Some(sdk) = &sdk {
        args.push(sdk.path().to_string_lossy().to_string());
    }
    progress("install", &format!("running npm {}", args.join(" ")));
    let mut command = npm_command();
    let (status, tail) = run_streaming("npm", command.args(args.iter().map(String::as_str)))?;
    if !status.success() {
        anyhow::bail!("pi install from the OSS bundles failed ({status}): {tail}");
    }
    Ok(())
}

/// Check the tree, not npm's exit code: an `--offline` install of a bundled
/// tarball can succeed while resolving to a different version.
fn verify_installed(pi_version: &str, sdk_version: &str) -> anyhow::Result<()> {
    match installed_version() {
        Some(have) if have == pi_version => {}
        Some(have) => anyhow::bail!("pi install produced {have}, but {pi_version} is required"),
        None => anyhow::bail!(
            "pi install reported success but {} holds no pi",
            package_root().display()
        ),
    }
    if !sdk_version.is_empty() {
        match mcp_sdk::installed_version() {
            Some(have) if have == sdk_version => {}
            Some(have) => {
                anyhow::bail!("MCP SDK install produced {have}, but {sdk_version} is required")
            }
            None => anyhow::bail!(
                "pi install reported success but {} is missing",
                mcp_sdk::NPM_PKG
            ),
        }
    }
    Ok(())
}

/// Older builds installed the SDK into `extensions/node_modules` beside the
/// extension; the managed runtime has it one level up. Leave nothing that
/// could shadow it. Best-effort.
fn cleanup_legacy_layout() {
    let extensions = pi_dir().join("extensions");
    let _ = std::fs::remove_dir_all(extensions.join("node_modules"));
    let _ = std::fs::remove_file(extensions.join("package.json"));
    let _ = std::fs::remove_file(extensions.join("package-lock.json"));
}

/// Install (or repair) the whole runtime: the managed Node, then pi and the MCP
/// SDK on it. Idempotent; `force` reinstalls even when everything is in place.
pub fn run_install(force: bool) -> anyhow::Result<()> {
    if !is_managed() {
        let status = doctor();
        if status.satisfied {
            progress(
                "ok",
                &format!(
                    "using the configured pi {} ({}); nothing to install",
                    status.version.unwrap_or_default(),
                    package_root().display()
                ),
            );
            return Ok(());
        }
        anyhow::bail!(
            "[agents.pi] package_root ({}) is not a usable pi {} install; fix the override or remove it to let amuxd manage pi",
            package_root().display(),
            required_version()
        );
    }

    crate::node_install::run_install(force)?;

    let want = required_version();
    let want_sdk = required_mcp_sdk_version();
    if want.is_empty() {
        anyhow::bail!("pi.lock.json pins no pi version");
    }
    if !force && doctor().satisfied {
        cleanup_legacy_layout();
        progress(
            "ok",
            &format!("pi {want} already installed ({})", package_root().display()),
        );
        return Ok(());
    }

    if bundle::try_install(force)? {
        verify_installed(&want, &want_sdk)?;
        cleanup_legacy_layout();
        progress(
            "ok",
            &format!("pi {want} installed from the prebuilt bundle"),
        );
        return Ok(());
    }

    progress(
        "install",
        &format!("installing pi {want} and {} {want_sdk}", mcp_sdk::NPM_PKG),
    );
    materialize_runtime_manifests()?;
    match registry_source() {
        RegistrySource::OssBundle => install_from_oss_bundles(&want, &want_sdk)?,
        source => install_with_npm_ci(source)?,
    }
    verify_installed(&want, &want_sdk)?;
    cleanup_legacy_layout();
    progress(
        "ok",
        &format!("pi {want} installed ({})", package_root().display()),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_pins_pi_0_84_2_or_newer() {
        // 0.84.2 is the SDK surface the multi-session host (`assets/pi-host/`)
        // is written against (createAgentSessionServices / SessionManager.open
        // signatures); older builds must never be pinned.
        let v = required_version();
        assert!(!v.starts_with('v'), "got {v}");
        assert!(version_ge(&v, "0.84.2"), "lock too old: {v}");
    }

    #[test]
    fn lock_pins_the_mcp_sdk_the_extension_imports() {
        // The extension's MCP bridge is written against the 1.x client API
        // (`Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`).
        let v = required_mcp_sdk_version();
        assert!(!v.is_empty(), "lock must pin an MCP SDK version");
        assert!(version_ge(&v, "1.29.0"), "MCP SDK lock too old: {v}");
    }

    #[test]
    fn lock_pins_a_node_pi_can_run_on() {
        // pi 0.84.x declares `engines.node >= 22.19.0`.
        let v = required_node_version();
        assert!(!v.is_empty(), "lock must pin a Node.js version");
        assert!(version_ge(&v, "22.19.0"), "Node lock too old for pi: {v}");
    }

    #[test]
    fn the_runtime_manifest_and_the_lock_agree() {
        // Two files pin the same versions on purpose (the mirror workflows read
        // pi.lock.json; npm ci reads package.json + package-lock.json). This is
        // what keeps a bump to one from silently leaving the other behind.
        let manifest: serde_json::Value = serde_json::from_str(RUNTIME_PACKAGE_JSON).unwrap();
        let deps = &manifest["dependencies"];
        assert_eq!(deps[PI_NPM_PKG], serde_json::json!(required_version()));
        assert_eq!(
            deps[mcp_sdk::NPM_PKG],
            serde_json::json!(required_mcp_sdk_version())
        );

        let lock: serde_json::Value = serde_json::from_str(RUNTIME_PACKAGE_LOCK).unwrap();
        assert_eq!(lock["lockfileVersion"], serde_json::json!(3));
        let packages = &lock["packages"];
        assert_eq!(
            packages[format!("node_modules/{PI_NPM_PKG}")]["version"],
            serde_json::json!(required_version())
        );
        assert_eq!(
            packages[format!("node_modules/{}", mcp_sdk::NPM_PKG)]["version"],
            serde_json::json!(required_mcp_sdk_version())
        );
        // Exact pins: a caret here would let `npm install` drift the tree.
        assert!(!deps[PI_NPM_PKG].as_str().unwrap().starts_with('^'));
        assert!(!deps[mcp_sdk::NPM_PKG].as_str().unwrap().starts_with('^'));
    }

    #[test]
    fn the_package_root_is_a_constant_under_the_runtime_dir() {
        // No shim walking, no `~/.pi`, no PATH: the root is where npm ci puts
        // it. (Only holds without a `[agents.pi] package_root` override, which
        // the test machine must not carry.)
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu-test-pi-layout");
        let root = package_root();
        assert!(
            root.ends_with("pi/node_modules/@earendil-works/pi-coding-agent"),
            "{}",
            root.display()
        );
        assert!(root.starts_with(pi_dir()));
    }

    #[test]
    fn version_of_manifest_reads_the_version_field_only() {
        assert_eq!(
            version_of_manifest(r#"{"name":"x","version":" 0.84.2 "}"#).as_deref(),
            Some("0.84.2")
        );
        assert!(version_of_manifest(r#"{"name":"x"}"#).is_none());
        assert!(version_of_manifest("not json").is_none());
    }

    #[test]
    fn tarball_url_follows_npms_convention() {
        // The scope stays in the path and is dropped from the file name.
        assert_eq!(
            tarball_url(OFFICIAL_REGISTRY, "@earendil-works/pi-coding-agent", "0.84.2"),
            "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.84.2.tgz"
        );
        assert_eq!(
            tarball_url(CN_NPM_REGISTRY, "@modelcontextprotocol/sdk", "1.30.0"),
            "https://registry.npmmirror.com/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz"
        );
        // Unscoped, and a registry given with a trailing slash.
        assert_eq!(
            tarball_url("https://registry.npmjs.org/", "typescript", "5.9.2"),
            "https://registry.npmjs.org/typescript/-/typescript-5.9.2.tgz"
        );
    }

    #[test]
    fn a_configured_registry_is_recognised_with_or_without_a_slash() {
        assert!(is_official_registry("https://registry.npmjs.org"));
        assert!(is_official_registry("https://registry.npmjs.org/"));
        // A user who set their own mirror must be left alone.
        assert!(!is_official_registry("https://registry.npmmirror.com/"));
        assert!(!is_official_registry("https://npm.internal.corp/"));
    }

    fn sample(bytes: u64, millis: u64) -> crate::route_probe::RouteSample {
        crate::route_probe::RouteSample {
            bytes,
            elapsed: std::time::Duration::from_millis(millis),
        }
    }

    #[test]
    fn the_mirror_needs_a_real_margin_to_take_over() {
        // 1 MB/s official. A mirror has to beat it by MIRROR_ADVANTAGE before
        // we override the user's default registry, so a healthy route that
        // dipped during the probe does not ship someone to a CN mirror.
        let probe = registry_probe();
        let official = sample(1024 * 1024, 1_000);
        assert!(!mirror_wins(
            Some(&official),
            &sample(1024 * 1024, 800),
            &probe
        ));
        assert!(mirror_wins(
            Some(&official),
            &sample(1024 * 1024, 600),
            &probe
        ));
    }

    #[test]
    fn a_slow_official_registry_is_overridden_even_though_it_works() {
        // The case the "official cleared the bar, stop looking" shortcut got
        // wrong: 1.2 MB/s is usable, and 8 MB/s is six times better.
        let probe = registry_probe();
        let official = sample(REGISTRY_PROBE_BYTES, 416); // ~1.2 MB/s
        assert!(official.meets(&probe));
        let mirror = sample(REGISTRY_PROBE_BYTES, 62); // ~8 MB/s
        assert!(mirror_wins(Some(&official), &mirror, &probe));
    }

    #[test]
    fn an_unreachable_official_registry_yields_only_to_a_usable_mirror() {
        let probe = registry_probe();
        assert!(mirror_wins(
            None,
            &sample(REGISTRY_PROBE_BYTES, 100),
            &probe
        ));
        // A mirror that is itself crawling loses to the OSS bundle.
        assert!(!mirror_wins(
            None,
            &sample(REGISTRY_PROBE_BYTES, 4_000),
            &probe
        ));
        // ...as does a transfer that died on the handshake.
        assert!(!mirror_wins(None, &sample(1024, 1), &probe));
    }

    #[test]
    fn the_oss_bundle_stays_the_last_resort() {
        // Guards the arm order in resolve_registry_source: the bundle is only
        // for "no registry answered at all".
        assert_ne!(RegistrySource::OssBundle, RegistrySource::NpmDefault);
        assert_eq!(
            RegistrySource::Mirror(CN_NPM_REGISTRY),
            RegistrySource::Mirror("https://registry.npmmirror.com")
        );
    }

    #[test]
    fn pi_mirror_manifest_is_versioned_and_uses_a_safe_asset_name() {
        let manifest: MirrorManifest = serde_json::from_str(
            r#"{"version":"0.84.2","asset":"earendil-works-pi-coding-agent-0.84.2.tgz","sha256":"abc"}"#,
        )
        .unwrap();
        assert_eq!(manifest.version, "0.84.2");
        assert!(safe_mirror_asset(&manifest.asset));
        assert!(!safe_mirror_asset("../pi.tgz"));
        assert!(!safe_mirror_asset("pi.zip"));
    }

    #[test]
    fn pi_status_serializes_camel_case() {
        let s = PiStatus {
            present: true,
            version: Some("0.84.2".into()),
            path: Some("/x/pi".into()),
            node_present: true,
            node_version: Some("24.20.0".into()),
            node_path: Some("/x/node".into()),
            node_satisfied: true,
            required_node_version: "24.20.0".into(),
            node_managed: true,
            required_version: "0.84.2".into(),
            mcp_sdk_present: true,
            mcp_sdk_version: Some("1.30.0".into()),
            required_mcp_sdk_version: "1.30.0".into(),
            mcp_sdk_satisfied: true,
            managed: true,
            satisfied: true,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["requiredVersion"], serde_json::json!("0.84.2"));
        assert_eq!(v["nodeSatisfied"], serde_json::json!(true));
        assert_eq!(v["nodePath"], serde_json::json!("/x/node"));
        assert_eq!(v["requiredNodeVersion"], serde_json::json!("24.20.0"));
        assert_eq!(v["nodeManaged"], serde_json::json!(true));
        assert_eq!(v["mcpSdkVersion"], serde_json::json!("1.30.0"));
        assert_eq!(v["requiredMcpSdkVersion"], serde_json::json!("1.30.0"));
        assert_eq!(v["managed"], serde_json::json!(true));
        assert_eq!(v["satisfied"], serde_json::json!(true));
    }
}
