//! pi coding-agent discovery + install for amuxd (parity with `opencode_install`).
//!
//! `pi.lock.json` records the MINIMUM pi version this build requires. pi is
//! installed via npm (`npm install -g @earendil-works/pi-coding-agent@<lock>`,
//! bun fallback); the global `pi` binary is resolved via `~/.pi/bin/pi` when
//! present, otherwise `pi` on PATH (including `~/.npm-global/bin`).
//!
//! The same lock file pins `@modelcontextprotocol/sdk`, which the TeamClu pi
//! extension imports to bridge MCP servers into pi (pi itself ships no MCP —
//! see `mcp_sdk`). Installing pi installs that too: they are one runtime.

pub mod mcp_sdk;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::opencode_install::{parse_semver, version_ge};
use crate::process_util::CommandNoWindow;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiLock {
    pub version: String,
    /// `@modelcontextprotocol/sdk` version the pi extension's MCP bridge is
    /// written against. Defaulted rather than required so a lock file from an
    /// older build still parses (the SDK step then simply does not run).
    #[serde(default)]
    pub mcp_sdk_version: String,
}

/// Embedded at compile time from apps/daemon/pi.lock.json
pub const LOCK_JSON: &str = include_str!("../../pi.lock.json");

/// The minimum pi version this build requires (lock version, no leading `v`).
pub fn required_version() -> String {
    serde_json::from_str::<PiLock>(LOCK_JSON)
        .map(|l| l.version.trim().trim_start_matches('v').to_string())
        .unwrap_or_default()
}

/// The `@modelcontextprotocol/sdk` version this build's extension requires.
/// Empty means the lock file does not pin one — treat MCP as unmanaged.
pub fn required_mcp_sdk_version() -> String {
    serde_json::from_str::<PiLock>(LOCK_JSON)
        .map(|l| l.mcp_sdk_version.trim().trim_start_matches('v').to_string())
        .unwrap_or_default()
}

/// Resolve the pi binary amuxd should run. Order: explicit daemon config
/// override (`agents.pi.binary`) → `~/.pi/bin/pi` → `pi` on PATH.
pub fn resolve_binary(configured: Option<&str>) -> String {
    crate::runtime::pi_rpc::process::resolve_binary(configured)
}

/// `<bin> --version` → the first version-like token.
fn pi_version_of(bin: &str) -> Option<String> {
    // PATH augmented: pi installs as an npm shim whose shebang is
    // `#!/usr/bin/env node`, so finding the file is not enough to run it.
    let out = command_with_runtime_path(bin)
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().next().unwrap_or("").trim();
    line.split_whitespace()
        .find(|tok| parse_semver(tok).is_some())
        .map(|t| t.to_string())
        .or_else(|| (!line.is_empty()).then(|| line.to_string()))
}

/// Detect the pi amuxd would run + its reported version.
pub fn detect_pi() -> Option<(String, String)> {
    let bin = resolve_binary(None);
    let version = pi_version_of(&bin)?;
    Some((bin, version))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiStatus {
    pub present: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// Pi is a Node CLI. Keep this separate from Pi's own version so onboarding
    /// can explain the real prerequisite before attempting `npm install`.
    pub node_present: bool,
    pub node_version: Option<String>,
    pub node_satisfied: bool,
    pub required_version: String,
    /// `@modelcontextprotocol/sdk` under the materialized extension directory.
    /// Reported separately from pi's own version because it is installed
    /// separately, but folded into `satisfied` — without it the extension
    /// bridges no MCP servers at all, which costs remote-tools and every team
    /// tool with it.
    pub mcp_sdk_present: bool,
    pub mcp_sdk_version: Option<String>,
    pub required_mcp_sdk_version: String,
    pub mcp_sdk_satisfied: bool,
    pub satisfied: bool,
}

/// Pi 0.84.x declares `node >=22.19.0`. Keep the check in the daemon (rather
/// than the React onboarding screen) so CLI, Settings and first-run setup all
/// make the same decision.
const MIN_NODE_VERSION: &str = "22.19.0";

fn node_version() -> Option<String> {
    let out = command_with_runtime_path("node")
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    (!line.is_empty()).then_some(line)
}

pub fn doctor() -> PiStatus {
    let want = required_version();
    let node_version = node_version();
    let node_satisfied = node_version
        .as_deref()
        .map(|v| version_ge(v, MIN_NODE_VERSION))
        .unwrap_or(false);
    let detected = detect_pi();
    let (present, version, path) = match &detected {
        Some((p, v)) => (true, Some(v.clone()), Some(p.clone())),
        None => (false, None, None),
    };
    let pi_satisfied = version
        .as_deref()
        .map(|v| version_ge(v, &want))
        .unwrap_or(false);
    let want_sdk = required_mcp_sdk_version();
    let sdk_version = mcp_sdk::installed_version();
    let sdk_satisfied = if want_sdk.is_empty() {
        true
    } else {
        sdk_version
            .as_deref()
            .map(|v| version_ge(v, &want_sdk))
            .unwrap_or(false)
    };
    PiStatus {
        present,
        version,
        path,
        node_present: node_version.is_some(),
        node_version,
        node_satisfied,
        required_version: want,
        mcp_sdk_present: sdk_version.is_some(),
        mcp_sdk_version: sdk_version,
        required_mcp_sdk_version: want_sdk,
        mcp_sdk_satisfied: sdk_satisfied,
        satisfied: pi_satisfied && node_satisfied && sdk_satisfied,
    }
}

pub(super) fn progress(event: &str, message: &str) {
    println!(
        "{}",
        serde_json::json!({ "event": event, "message": message })
    );
}

const PI_NPM_PKG: &str = "@earendil-works/pi-coding-agent";
const PI_MIRROR_BASE: &str = "https://teamclaw.ucar.cc/pi";
const OFFICIAL_REGISTRY: &str = "https://registry.npmjs.org";

/// Alibaba's public npm mirror — a full sync of the official registry, and the
/// route that actually works from mainland China. Verified to carry both
/// packages we pin, at the pinned versions.
///
/// Only ever applied to our own `npm`/`bun` invocation (via the environment),
/// never written to the user's npmrc.
const CN_NPM_REGISTRY: &str = "https://registry.npmmirror.com";

pub(super) const NETWORK_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

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

fn npm_package_spec(min_version: &str) -> String {
    format!("{PI_NPM_PKG}@{min_version}")
}

/// `Command` for a CLI we shell out to, with every platform repair applied:
/// the enriched PATH, the Windows shim name (`npm` is `npm.cmd` — see
/// `well_known_bin::spawn_name`), and no console window (#1045).
///
/// Routing the version probes through here is why they no longer call
/// `.no_window()` themselves: one helper, one place to get it right.
pub(super) fn command_with_runtime_path(command: &str) -> std::process::Command {
    let mut process =
        std::process::Command::new(crate::runtime::well_known_bin::spawn_name(command));
    process.no_window();
    process.env("PATH", crate::runtime::well_known_bin::augmented_path());
    process
}

pub(super) fn has_command(cmd: &str) -> bool {
    command_with_runtime_path(cmd)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Where the npm packages should come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RegistrySource {
    /// Whatever npm (or bun) is already configured with. No override.
    NpmDefault,
    /// Override our own invocation with this registry.
    Mirror(&'static str),
    /// No registry is usable from here; install from the OSS tarball bundle.
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

/// What `npm config get registry` reports, or None when npm cannot answer
/// (not installed, or a bun-only machine).
fn npm_configured_registry() -> Option<String> {
    let out = command_with_runtime_path("npm")
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
            progress(
                "source",
                &format!("npm is configured with {configured}; installing through it"),
            );
            return RegistrySource::NpmDefault;
        }
    }

    // Both routes are measured every time. Skipping the mirror whenever the
    // official registry cleared some bar was the tempting shortcut, and it is
    // exactly how a user on a 1.2 MB/s route keeps an install that the mirror
    // would have served six times faster. One 512 KiB sample is cheaper than
    // being wrong about that.
    let probe = registry_probe();
    let official = probe.measure(&tarball_url(OFFICIAL_REGISTRY, package, version));
    let mirror = probe.measure(&tarball_url(CN_NPM_REGISTRY, package, version));
    match (&official, &mirror) {
        (_, Some(mirror_sample)) if mirror_wins(official.as_ref(), mirror_sample, &probe) => {
            progress(
                "source",
                &format!(
                    "{CN_NPM_REGISTRY} measured at {:.1} MB/s against {} for the official registry; \
                     installing through the mirror",
                    mirror_sample.mib_per_sec(),
                    official
                        .map(|s| format!("{:.1} MB/s", s.mib_per_sec()))
                        .unwrap_or_else(|| "no answer".to_string())
                ),
            );
            RegistrySource::Mirror(CN_NPM_REGISTRY)
        }
        (Some(sample), _) => {
            progress(
                "source",
                &format!(
                    "npm registry measured at {:.1} MB/s and the mirror is no better; \
                     installing from upstream",
                    sample.mib_per_sec()
                ),
            );
            RegistrySource::NpmDefault
        }
        (None, _) => {
            progress(
                "source",
                "no npm registry is reachable; falling back to the OSS bundle",
            );
            RegistrySource::OssBundle
        }
    }
}

/// The registry decision, made once per process.
///
/// Route speed is a property of the network, not of the package, so pi and the
/// MCP SDK share one measurement instead of probing twice. Resolved lazily:
/// an install that early-returns "already satisfied" must not pay for a probe.
pub(super) fn registry_source() -> RegistrySource {
    static SOURCE: std::sync::OnceLock<RegistrySource> = std::sync::OnceLock::new();
    *SOURCE.get_or_init(|| resolve_registry_source(PI_NPM_PKG, &required_version()))
}

/// Apply a chosen registry to a child process.
///
/// Through the environment rather than a flag: npm and bun spell the flag
/// differently, but both read their config from the environment, and neither
/// user's npmrc is touched.
pub(super) fn apply_registry(command: &mut std::process::Command, source: RegistrySource) {
    if let RegistrySource::Mirror(url) = source {
        command.env("NPM_CONFIG_REGISTRY", url);
        command.env("BUN_CONFIG_REGISTRY", url);
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

pub(super) fn download_bytes(url: &str) -> anyhow::Result<Vec<u8>> {
    let url = url.to_owned();
    let bytes = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let response = reqwest::get(url).await?.error_for_status()?;
            Ok::<_, anyhow::Error>(response.bytes().await?)
        })?;
    Ok(bytes.to_vec())
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
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

/// Install or upgrade the whole pi runtime: the agent itself, then the MCP SDK
/// its extension needs.
///
/// The two steps are separate functions rather than one body because
/// `ensure_pi` returns early on every "nothing to do" path, and an early return
/// there used to skip the SDK — which is the path *every existing install*
/// takes, so the bridge silently never appeared.
pub fn run_install(force: bool) -> anyhow::Result<()> {
    ensure_pi(force)?;
    mcp_sdk::run_install(force)
}

/// Install or upgrade pi via `npm install -g @earendil-works/pi-coding-agent@<lock>`
/// (falls back to `bun add -g` when npm is absent).
fn ensure_pi(force: bool) -> anyhow::Result<()> {
    let want = required_version();
    let node = node_version();
    if !node
        .as_deref()
        .map(|v| version_ge(v, MIN_NODE_VERSION))
        .unwrap_or(false)
    {
        let found = node.as_deref().unwrap_or("not found");
        anyhow::bail!(
            "Pi requires Node.js >= {MIN_NODE_VERSION}; found {found}. Install or upgrade Node.js first"
        );
    }

    if !force {
        if let Some((path, have)) = detect_pi() {
            if version_ge(&have, &want) {
                progress(
                    "ok",
                    &format!("pi {have} already satisfies >= {want} ({path})"),
                );
                return Ok(());
            }
            progress(
                "upgrade",
                &format!("pi {have} is older than required {want}; upgrading"),
            );
        } else {
            progress("install", &format!("installing pi (require >= {want})"));
        }
    }

    if !has_command("npm") && !has_command("bun") {
        // Node was already proved present above, so reaching here with a Node
        // install means npm is missing from *this process's* PATH rather than
        // from the machine — say which one to check.
        anyhow::bail!(
            "neither npm nor bun found on PATH (node {} is installed); \
             install Node.js or Bun first, or add npm's directory to PATH",
            node.as_deref().unwrap_or("?")
        );
    }

    let pkg = npm_package_spec(&want);
    let source = registry_source();
    let (cmd, args, _bundle): (&str, Vec<String>, Option<tempfile::NamedTempFile>) =
        if source == RegistrySource::OssBundle {
            // Node distributions include npm. Only npm can reliably consume our
            // bundled tarball in offline mode, so do not silently send a blocked
            // network to Bun when the fallback has been selected.
            if !has_command("npm") {
                anyhow::bail!(
                    "official npm registry is unreachable and the Pi OSS fallback requires npm"
                );
            }
            let bundle = mirrored_bundle("Pi", PI_MIRROR_BASE, &want)?;
            let local = bundle.path().to_string_lossy().to_string();
            (
                "npm",
                vec![
                    "install".into(),
                    "-g".into(),
                    "--offline".into(),
                    "--no-audit".into(),
                    "--no-fund".into(),
                    local,
                ],
                Some(bundle),
            )
        } else if has_command("npm") {
            ("npm", vec!["install".into(), "-g".into(), pkg], None)
        } else {
            ("bun", vec!["add".into(), "-g".into(), pkg], None)
        };

    progress("install", &format!("running {cmd} {}", args.join(" ")));
    let mut command = command_with_runtime_path(cmd);
    apply_registry(&mut command, source);
    let output = command
        .args(args.iter().map(String::as_str))
        .output()
        .map_err(|e| anyhow::anyhow!("failed to run {cmd}: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stdout.is_empty() {
        progress("output", &stdout);
    }
    if !output.status.success() {
        anyhow::bail!(
            "pi install failed ({}): {}",
            output.status,
            if stderr.is_empty() { stdout } else { stderr }
        );
    }
    progress("ok", &format!("pi installed/upgraded (require >= {want})"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_parses_and_pins_0_84_2_minimum() {
        // 0.84.2 is the SDK surface the multi-session host (`assets/pi-host/`)
        // is written against (createAgentSessionServices / SessionManager.open
        // signatures); older installs must be flagged by doctor.
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
    fn npm_package_spec_uses_pi_coding_agent() {
        assert_eq!(
            npm_package_spec("0.81.1"),
            "@earendil-works/pi-coding-agent@0.81.1"
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
            version: Some("0.81.1".into()),
            path: Some("/x/pi".into()),
            node_present: true,
            node_version: Some("v22.19.0".into()),
            node_satisfied: true,
            required_version: "0.81.1".into(),
            mcp_sdk_present: true,
            mcp_sdk_version: Some("1.30.0".into()),
            required_mcp_sdk_version: "1.30.0".into(),
            mcp_sdk_satisfied: true,
            satisfied: true,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["requiredVersion"], serde_json::json!("0.81.1"));
        assert_eq!(v["nodeSatisfied"], serde_json::json!(true));
        assert_eq!(v["mcpSdkVersion"], serde_json::json!("1.30.0"));
        assert_eq!(v["requiredMcpSdkVersion"], serde_json::json!("1.30.0"));
        assert_eq!(v["satisfied"], serde_json::json!(true));
    }
}
