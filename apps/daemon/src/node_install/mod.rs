//! The Node.js that amuxd's pi runtime runs on — installed and owned by amuxd.
//!
//! pi is a Node CLI, and every "pi is installed but does not start" report
//! traced back to *which* Node the daemon found: a GUI-launched process reads
//! no `~/.zshrc`, so nvm/fnm/n/volta installs were invisible; Windows never
//! repairs the PATH at all, so a Node installed after the app started was
//! invisible until reboot; and a machine holding three Nodes answered "v24"
//! in the terminal and "v20" in the app (#1049, #1232). Every one of those was
//! a heuristic trying to guess the user's Node.
//!
//! So amuxd stops guessing. The version pinned in `apps/daemon/pi.lock.json`
//! (`node`) is downloaded as the official portable distribution and unpacked
//! under `<amuxd cache>/node/<version>/`; pi, its npm install, the multi-session
//! host and every MCP bridge run on that binary and nothing else. The system
//! Node — whichever of them — is never consulted. A developer who needs to run
//! pi on a different Node sets `[agents.pi] node = "<path>"` in daemon.toml,
//! which is an explicit override, not a search.
//!
//! Sources, chosen by measured throughput (see `crate::route_probe`): the
//! official `nodejs.org/dist`, the public `npmmirror.com` mirror of it, and our
//! own OSS copy (`.github/workflows/mirror-node-oss.yml`). Every download is
//! checked against the source's SHA-256 before it is unpacked.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::opencode_install::version_ge;
use crate::pi_install::{download_bytes, progress, progress_route, sha256_hex};
use crate::process_util::CommandNoWindow;

/// Official distribution root.
const OFFICIAL_BASE: &str = "https://nodejs.org/dist";
/// Alibaba's public mirror of the official distribution — the route that
/// actually works from mainland China. Same layout as upstream.
const PUBLIC_MIRROR_BASE: &str = "https://npmmirror.com/mirrors/node";
/// Our own OSS copy. Layout (see `.github/workflows/mirror-node-oss.yml`):
///   `<base>/latest.json`        `{"version": "24.20.0", "assets": {"<asset>": "<sha256>"}}`
///   `<base>/<version>/<asset>`  immutable
const SELF_HOSTED_BASE: &str = "https://teamclaw.ucar.cc/node";

/// How much of the real archive to pull when measuring a route. The archives
/// are 30–50 MB, so 2 MiB samples past the initial burst (see
/// `opencode_install::PROBE_BYTES` for why the first half-megabyte lies).
const PROBE_BYTES: u64 = 2 * 1024 * 1024;
const MIN_PROBE_SAMPLE: u64 = 64 * 1024;
const PROBE_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const PROBE_TRANSFER_DEADLINE: std::time::Duration = std::time::Duration::from_secs(4);
/// Throughput at which a route counts as usable: "the archive lands in well
/// under a minute".
const MIN_USABLE_BYTES_PER_SEC: f64 = 1024.0 * 1024.0;
/// How much faster the public mirror has to be before it overrides a working
/// official route. Same hysteresis as the npm registry decision in
/// `pi_install`: a healthy route that dipped during the probe must not send a
/// user outside China to a Chinese mirror.
const MIRROR_ADVANTAGE: f64 = 1.5;

/// The Node version this build's pi runtime runs on (lock value, no `v`).
pub fn required_version() -> String {
    crate::pi_install::required_node_version()
}

/// `<amuxd cache>/node` — one subdirectory per installed version.
pub fn managed_root() -> PathBuf {
    crate::config::layout::cache_dir().join("node")
}

/// Where the pinned version lives (or will live once installed).
pub fn install_dir() -> PathBuf {
    managed_root().join(required_version())
}

/// Path of the `node` executable inside an unpacked official distribution.
fn node_relative() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "bin/node"
    }
}

/// `[agents.pi] node = "<path>"` — a developer's explicit choice of Node. Read
/// at call time, like `session_host`, so a config edit takes effect on the
/// next spawn without a daemon restart.
fn configured_override() -> Option<PathBuf> {
    crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
        .ok()
        .and_then(|c| c.agents.pi.and_then(|pi| pi.node))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// The `node` binary every pi-related child runs on.
///
/// Managed unless overridden. This is a fixed path, not a lookup: it does not
/// consult PATH, `~/.nvm`, Homebrew, or anything else on the machine.
pub fn node_binary() -> PathBuf {
    configured_override().unwrap_or_else(|| install_dir().join(node_relative()))
}

/// Whether [`node_binary`] is amuxd's own install rather than a configured one.
pub fn is_managed() -> bool {
    configured_override().is_none()
}

/// `npm-cli.js` that ships inside the distribution [`node`] belongs to.
///
/// Invoking npm as `node npm-cli.js` rather than through its shim is what
/// makes Windows work without `npm.cmd`, `cmd.exe`, or PATHEXT (#1046), and
/// what guarantees npm runs on the same Node that pi will (#1232).
pub fn npm_cli_for(node: &Path) -> PathBuf {
    let dir = node.parent().map(Path::to_path_buf).unwrap_or_default();
    if cfg!(windows) {
        dir.join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js")
    } else {
        // `<prefix>/bin/node` → `<prefix>/lib/node_modules/npm/bin/npm-cli.js`
        dir.parent()
            .map(Path::to_path_buf)
            .unwrap_or_default()
            .join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js")
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    pub present: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub required_version: String,
    /// amuxd's own install (true) or a `[agents.pi] node` override (false).
    pub managed: bool,
    /// Managed: the installed version *is* the pinned one. Override: it is at
    /// least the pinned one — a developer running a newer Node is fine, an
    /// older one is not.
    pub satisfied: bool,
}

/// `<node> --version` → `24.20.0` (no `v`), or `None` when it cannot run.
pub(crate) fn probe_version(node: &Path) -> Option<String> {
    let out = std::process::Command::new(node)
        .no_window()
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches('v')
        .to_string();
    (!line.is_empty()).then_some(line)
}

pub fn doctor() -> NodeStatus {
    let required = required_version();
    let node = node_binary();
    let managed = is_managed();
    let version = probe_version(&node);
    let satisfied = version
        .as_deref()
        .map(|have| {
            if managed {
                have == required
            } else {
                version_ge(have, &required)
            }
        })
        .unwrap_or(false);
    NodeStatus {
        present: version.is_some(),
        path: version
            .is_some()
            .then(|| node.to_string_lossy().to_string()),
        version,
        required_version: required,
        managed,
        satisfied,
    }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/// Official distribution asset for an (os, arch) pair, using
/// `std::env::consts` names. `None` for targets Node does not ship.
pub(crate) fn asset_for(os: &str, arch: &str, version: &str) -> Option<String> {
    let suffix = match (os, arch) {
        ("macos", "aarch64") => "darwin-arm64.tar.gz",
        ("macos", "x86_64") => "darwin-x64.tar.gz",
        ("linux", "x86_64") => "linux-x64.tar.gz",
        ("linux", "aarch64") => "linux-arm64.tar.gz",
        ("windows", "x86_64") => "win-x64.zip",
        ("windows", "aarch64") => "win-arm64.zip",
        _ => return None,
    };
    Some(format!("node-v{version}-{suffix}"))
}

fn current_asset(version: &str) -> anyhow::Result<String> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH, version).ok_or_else(|| {
        anyhow::anyhow!(
            "Node.js ships no build for {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })
}

/// `<base>/v<version>/<asset>` — the layout nodejs.org and its mirrors share.
fn dist_url(base: &str, version: &str, asset: &str) -> String {
    format!("{}/v{version}/{asset}", base.trim_end_matches('/'))
}

fn shasums_url(base: &str, version: &str) -> String {
    format!("{}/v{version}/SHASUMS256.txt", base.trim_end_matches('/'))
}

/// `<base>/<version>/<asset>` — our OSS layout (version in the path, no `v`).
fn self_hosted_url(version: &str, asset: &str) -> String {
    format!(
        "{}/{version}/{asset}",
        SELF_HOSTED_BASE.trim_end_matches('/')
    )
}

/// Pick `asset`'s digest out of a `SHASUMS256.txt` body (`<sha>  <file>` lines).
pub(crate) fn sha_from_shasums(body: &str, asset: &str) -> Option<String> {
    body.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let sha = parts.next()?;
        let name = parts.next()?;
        (name == asset && sha.len() == 64).then(|| sha.to_ascii_lowercase())
    })
}

/// `latest.json` on our OSS copy.
#[derive(Debug, Deserialize)]
struct SelfHostedManifest {
    version: String,
    #[serde(default)]
    assets: std::collections::BTreeMap<String, String>,
}

fn fetch_text(url: &str, timeout: std::time::Duration) -> Option<String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?
        .block_on(async {
            reqwest::Client::builder()
                .timeout(timeout)
                .build()
                .ok()?
                .get(url)
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?
                .text()
                .await
                .ok()
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Source {
    Official,
    PublicMirror,
    SelfHosted,
}

impl Source {
    fn route(self) -> &'static str {
        match self {
            Source::Official => crate::route_probe::route::OFFICIAL,
            Source::PublicMirror => crate::route_probe::route::PUBLIC_MIRROR,
            Source::SelfHosted => crate::route_probe::route::SELF_HOSTED,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Source::Official => "nodejs.org",
            Source::PublicMirror => "npmmirror.com",
            Source::SelfHosted => "the OSS mirror",
        }
    }

    /// The archive URL and the digest the source publishes for it. `Err` when
    /// the source cannot vouch for the asset — an archive with no checksum is
    /// not installed, whichever route it came from.
    fn locate(self, version: &str, asset: &str) -> anyhow::Result<(String, String)> {
        match self {
            Source::Official | Source::PublicMirror => {
                let base = if self == Source::Official {
                    OFFICIAL_BASE
                } else {
                    PUBLIC_MIRROR_BASE
                };
                let shasums = fetch_text(&shasums_url(base, version), PROBE_CONNECT_TIMEOUT * 3)
                    .ok_or_else(|| {
                        anyhow::anyhow!("{} did not serve SHASUMS256.txt", self.label())
                    })?;
                let sha = sha_from_shasums(&shasums, asset).ok_or_else(|| {
                    anyhow::anyhow!("{} lists no checksum for {asset}", self.label())
                })?;
                Ok((dist_url(base, version, asset), sha))
            }
            Source::SelfHosted => {
                let url = format!("{}/latest.json", SELF_HOSTED_BASE.trim_end_matches('/'));
                let body = fetch_text(&url, PROBE_CONNECT_TIMEOUT)
                    .ok_or_else(|| anyhow::anyhow!("the OSS mirror is unavailable"))?;
                let manifest: SelfHostedManifest = serde_json::from_str(&body)
                    .map_err(|e| anyhow::anyhow!("the OSS mirror manifest is malformed: {e}"))?;
                if manifest.version.trim_start_matches('v') != version {
                    anyhow::bail!(
                        "the OSS mirror has Node {}, but this build requires {version}",
                        manifest.version
                    );
                }
                let sha = manifest
                    .assets
                    .get(asset)
                    .map(|s| s.to_ascii_lowercase())
                    .ok_or_else(|| anyhow::anyhow!("the OSS mirror carries no {asset}"))?;
                Ok((self_hosted_url(version, asset), sha))
            }
        }
    }
}

fn probe() -> crate::route_probe::Probe {
    crate::route_probe::Probe {
        bytes: PROBE_BYTES,
        min_sample: MIN_PROBE_SAMPLE,
        connect_timeout: PROBE_CONNECT_TIMEOUT,
        transfer_deadline: PROBE_TRANSFER_DEADLINE,
        min_bytes_per_sec: MIN_USABLE_BYTES_PER_SEC,
    }
}

/// The order to try sources in, from two measured samples.
///
/// Pure so the policy is testable without a network. `None` means that route
/// failed outright.
pub(crate) fn source_order(
    official: Option<crate::route_probe::RouteSample>,
    mirror: Option<crate::route_probe::RouteSample>,
    probe: &crate::route_probe::Probe,
) -> [Source; 3] {
    let mirror_wins = match (&official, &mirror) {
        (_, Some(m)) if m.bytes < probe.min_sample => false,
        (None, Some(m)) => m.meets(probe),
        (Some(o), Some(m)) => m.bytes_per_sec() >= o.bytes_per_sec() * MIRROR_ADVANTAGE,
        (_, None) => false,
    };
    if mirror_wins {
        [Source::PublicMirror, Source::SelfHosted, Source::Official]
    } else if official.map(|o| o.meets(probe)).unwrap_or(false) {
        [Source::Official, Source::SelfHosted, Source::PublicMirror]
    } else {
        // Neither public route is usable: our own CDN first, then whatever
        // answered at all, slow as it may be.
        [Source::SelfHosted, Source::Official, Source::PublicMirror]
    }
}

fn measured_source_order(version: &str, asset: &str) -> [Source; 3] {
    // Said before the measuring starts: up to nine seconds of network work
    // that would otherwise look like a frozen wizard.
    progress("probe", "checking which Node.js download route is fastest");
    let probe = probe();
    let (official, mirror) = std::thread::scope(|scope| {
        let official = scope.spawn(|| probe.measure(&dist_url(OFFICIAL_BASE, version, asset)));
        let mirror = scope.spawn(|| probe.measure(&dist_url(PUBLIC_MIRROR_BASE, version, asset)));
        (official.join().ok().flatten(), mirror.join().ok().flatten())
    });
    let describe = |s: Option<crate::route_probe::RouteSample>| {
        s.map(|s| format!("{:.1} MB/s", s.mib_per_sec()))
            .unwrap_or_else(|| "no answer".to_string())
    };
    let order = source_order(official, mirror, &probe);
    progress_route(
        "source",
        &format!(
            "nodejs.org measured at {}, npmmirror at {}; downloading Node.js from {} first",
            describe(official),
            describe(mirror),
            order[0].label()
        ),
        order[0].route(),
    );
    order
}

/// Download the pinned Node from the first source that delivers a checksum-
/// verified archive.
fn fetch_verified(version: &str, asset: &str) -> anyhow::Result<Vec<u8>> {
    let mut failures = Vec::new();
    for source in measured_source_order(version, asset) {
        let (url, expected) = match source.locate(version, asset) {
            Ok(located) => located,
            Err(e) => {
                progress(
                    "download",
                    &format!("{}: {e}; trying the next source", source.label()),
                );
                failures.push(format!("{}: {e}", source.label()));
                continue;
            }
        };
        progress_route("download", &format!("downloading {url}"), source.route());
        let bytes = match download_bytes(&url) {
            Ok(bytes) => bytes,
            Err(e) => {
                progress(
                    "download",
                    &format!("{}: {e}; trying the next source", source.label()),
                );
                failures.push(format!("{}: {e}", source.label()));
                continue;
            }
        };
        if sha256_hex(&bytes) != expected {
            let msg = format!("{}: checksum mismatch for {asset}", source.label());
            progress("download", &format!("{msg}; trying the next source"));
            failures.push(msg);
            continue;
        }
        return Ok(bytes);
    }
    anyhow::bail!(
        "could not download Node.js {version} from any source: {}",
        failures.join("; ")
    )
}

/// The path of an archive entry with its top-level directory
/// (`node-v24.20.0-darwin-arm64/`) removed. `None` for the directory itself
/// and for anything that would escape `dest`.
pub(crate) fn strip_top_level(path: &Path) -> Option<PathBuf> {
    use std::path::Component;
    let mut components = path.components();
    match components.next()? {
        Component::Normal(_) => {}
        _ => return None,
    }
    let rest: PathBuf = components
        .map(|c| match c {
            Component::Normal(part) => Some(PathBuf::from(part)),
            Component::CurDir => Some(PathBuf::new()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?
        .into_iter()
        .collect();
    (!rest.as_os_str().is_empty()).then_some(rest)
}

fn unpack_tar_gz(bytes: &[u8], dest: &Path) -> anyhow::Result<()> {
    let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
    let mut archive = tar::Archive::new(gz);
    archive.set_preserve_permissions(true);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let Some(rel) = strip_top_level(&entry.path()?) else {
            continue;
        };
        let out = dest.join(rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // `unpack` handles directories, files, symlinks and modes; the
        // distribution's `bin/npm` is a symlink into `lib/node_modules`.
        entry.unpack(&out)?;
    }
    Ok(())
}

fn unpack_zip(bytes: &[u8], dest: &Path) -> anyhow::Result<()> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        // `enclosed_name` rejects `..` and absolute names.
        let Some(name) = file.enclosed_name() else {
            continue;
        };
        let Some(rel) = strip_top_level(&name) else {
            continue;
        };
        let out = dest.join(rel);
        if file.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut sink = std::fs::File::create(&out)?;
        std::io::copy(&mut file, &mut sink)?;
        #[cfg(unix)]
        if let Some(mode) = file.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

fn unpack(asset: &str, bytes: &[u8], dest: &Path) -> anyhow::Result<()> {
    if asset.ends_with(".tar.gz") {
        unpack_tar_gz(bytes, dest)
    } else if asset.ends_with(".zip") {
        unpack_zip(bytes, dest)
    } else {
        anyhow::bail!("unsupported Node.js asset type: {asset}")
    }
}

/// Drop every managed version other than the pinned one. Best-effort: a
/// leftover directory costs disk, not correctness.
fn prune_other_versions(keep: &str) {
    let Ok(entries) = std::fs::read_dir(managed_root()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy() != keep {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Install the pinned Node under [`install_dir`], unless it is already there
/// and runs (or a `[agents.pi] node` override is configured).
pub fn run_install(force: bool) -> anyhow::Result<()> {
    let version = required_version();
    if version.is_empty() {
        anyhow::bail!("pi.lock.json pins no Node.js version");
    }
    if !is_managed() {
        let status = doctor();
        match (&status.version, status.satisfied) {
            (Some(have), true) => {
                progress(
                    "ok",
                    &format!(
                        "using the configured Node.js {have} ({}); nothing to install",
                        node_binary().display()
                    ),
                );
                return Ok(());
            }
            (Some(have), false) => anyhow::bail!(
                "the configured Node.js ({}) is {have}, but pi needs {version} or later",
                node_binary().display()
            ),
            (None, _) => anyhow::bail!(
                "the configured Node.js ({}) cannot run",
                node_binary().display()
            ),
        }
    }

    let dest = install_dir();
    if !force {
        let status = doctor();
        if status.satisfied {
            progress(
                "ok",
                &format!("Node.js {version} already installed ({})", dest.display()),
            );
            return Ok(());
        }
    }

    let asset = current_asset(&version)?;
    progress(
        "install",
        &format!("installing Node.js {version} ({asset})"),
    );
    let bytes = fetch_verified(&version, &asset)?;

    let partial = managed_root().join(format!("{version}.partial"));
    let _ = std::fs::remove_dir_all(&partial);
    std::fs::create_dir_all(&partial)?;
    progress("unpack", &format!("unpacking {asset}"));
    unpack(&asset, &bytes, &partial)?;
    drop(bytes);

    // A running host holds files under the old directory open; renaming a
    // directory is allowed everywhere even then, deleting it is not.
    if dest.exists() {
        let old = managed_root().join(format!("{version}.old"));
        let _ = std::fs::remove_dir_all(&old);
        std::fs::rename(&dest, &old)?;
        let _ = std::fs::remove_dir_all(&old);
    }
    std::fs::rename(&partial, &dest)?;

    let status = doctor();
    if !status.satisfied {
        anyhow::bail!(
            "Node.js {version} unpacked to {} but reports {}",
            dest.display(),
            status.version.unwrap_or_else(|| "nothing".to_string())
        );
    }
    prune_other_versions(&version);
    progress(
        "ok",
        &format!("Node.js {version} installed ({})", node_binary().display()),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assets_follow_the_official_naming() {
        assert_eq!(
            asset_for("macos", "aarch64", "24.20.0").as_deref(),
            Some("node-v24.20.0-darwin-arm64.tar.gz")
        );
        assert_eq!(
            asset_for("macos", "x86_64", "24.20.0").as_deref(),
            Some("node-v24.20.0-darwin-x64.tar.gz")
        );
        assert_eq!(
            asset_for("linux", "x86_64", "24.20.0").as_deref(),
            Some("node-v24.20.0-linux-x64.tar.gz")
        );
        assert_eq!(
            asset_for("linux", "aarch64", "24.20.0").as_deref(),
            Some("node-v24.20.0-linux-arm64.tar.gz")
        );
        assert_eq!(
            asset_for("windows", "x86_64", "24.20.0").as_deref(),
            Some("node-v24.20.0-win-x64.zip")
        );
        assert_eq!(
            asset_for("windows", "aarch64", "24.20.0").as_deref(),
            Some("node-v24.20.0-win-arm64.zip")
        );
        assert!(asset_for("freebsd", "x86_64", "24.20.0").is_none());
    }

    #[test]
    fn this_build_targets_a_platform_node_ships() {
        // A daemon that cannot name its own Node archive cannot onboard anyone.
        assert!(current_asset("24.20.0").is_ok());
    }

    #[test]
    fn urls_match_the_distribution_layout() {
        assert_eq!(
            dist_url(
                OFFICIAL_BASE,
                "24.20.0",
                "node-v24.20.0-darwin-arm64.tar.gz"
            ),
            "https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz"
        );
        assert_eq!(
            shasums_url(PUBLIC_MIRROR_BASE, "24.20.0"),
            "https://npmmirror.com/mirrors/node/v24.20.0/SHASUMS256.txt"
        );
        // Our own copy keys by bare version, like the pi and opencode mirrors.
        assert_eq!(
            self_hosted_url("24.20.0", "node-v24.20.0-win-x64.zip"),
            "https://teamclaw.ucar.cc/node/24.20.0/node-v24.20.0-win-x64.zip"
        );
    }

    #[test]
    fn shasums_lookup_matches_the_exact_asset() {
        let body = "\
abc0000000000000000000000000000000000000000000000000000000000000  node-v24.20.0-darwin-arm64.tar.gz
def0000000000000000000000000000000000000000000000000000000000000  node-v24.20.0-darwin-arm64.tar.xz
";
        assert_eq!(
            sha_from_shasums(body, "node-v24.20.0-darwin-arm64.tar.gz").as_deref(),
            Some("abc0000000000000000000000000000000000000000000000000000000000000")
        );
        // `.tar.gz` must not match the `.tar.xz` line by prefix, and vice versa.
        assert!(sha_from_shasums(body, "node-v24.20.0-darwin-arm64").is_none());
        assert!(sha_from_shasums("garbage", "x").is_none());
    }

    #[test]
    fn the_top_level_directory_is_stripped_and_escapes_are_refused() {
        assert_eq!(
            strip_top_level(Path::new("node-v24.20.0-darwin-arm64/bin/node")),
            Some(PathBuf::from("bin/node"))
        );
        assert_eq!(
            strip_top_level(Path::new("node-v24.20.0-win-x64/node.exe")),
            Some(PathBuf::from("node.exe"))
        );
        // The directory entry itself has nothing left.
        assert!(strip_top_level(Path::new("node-v24.20.0-darwin-arm64/")).is_none());
        assert!(strip_top_level(Path::new("node-v24.20.0-darwin-arm64")).is_none());
        // Traversal and absolute paths are not unpacked.
        assert!(strip_top_level(Path::new("node-v1/../../etc/passwd")).is_none());
        assert!(strip_top_level(Path::new("/etc/passwd")).is_none());
    }

    #[test]
    fn npm_cli_sits_where_the_distribution_puts_it() {
        let node = if cfg!(windows) {
            Path::new(r"C:\amuxd\node\24.20.0\node.exe")
        } else {
            Path::new("/amuxd/node/24.20.0/bin/node")
        };
        let cli = npm_cli_for(node);
        if cfg!(windows) {
            assert!(
                cli.ends_with(r"node_modules\npm\bin\npm-cli.js"),
                "{}",
                cli.display()
            );
        } else {
            assert_eq!(
                cli,
                PathBuf::from("/amuxd/node/24.20.0/lib/node_modules/npm/bin/npm-cli.js")
            );
        }
    }

    fn sample(bytes: u64, millis: u64) -> crate::route_probe::RouteSample {
        crate::route_probe::RouteSample {
            bytes,
            elapsed: std::time::Duration::from_millis(millis),
        }
    }

    #[test]
    fn a_fast_official_route_is_used_first() {
        let probe = probe();
        let order = source_order(
            Some(sample(PROBE_BYTES, 200)),
            Some(sample(PROBE_BYTES, 210)),
            &probe,
        );
        assert_eq!(order[0], Source::Official);
        // Our own CDN backs it up before the slower public mirror.
        assert_eq!(order[1], Source::SelfHosted);
    }

    #[test]
    fn the_mirror_needs_a_real_margin_to_take_over() {
        let probe = probe();
        // 1.2× faster is jitter, not a better route.
        let order = source_order(
            Some(sample(PROBE_BYTES, 1000)),
            Some(sample(PROBE_BYTES, 800)),
            &probe,
        );
        assert_eq!(order[0], Source::Official);
        // 2× faster is a better route.
        let order = source_order(
            Some(sample(PROBE_BYTES, 1000)),
            Some(sample(PROBE_BYTES, 500)),
            &probe,
        );
        assert_eq!(order[0], Source::PublicMirror);
    }

    #[test]
    fn with_nothing_usable_our_own_copy_goes_first() {
        let probe = probe();
        // Both crawling: one 2 MiB sample took 8s.
        let order = source_order(
            Some(sample(PROBE_BYTES, 8000)),
            Some(sample(PROBE_BYTES, 8000)),
            &probe,
        );
        assert_eq!(order[0], Source::SelfHosted);
        // Both dead.
        let order = source_order(None, None, &probe);
        assert_eq!(order[0], Source::SelfHosted);
        // A handshake-sized mirror sample is not a route.
        let order = source_order(None, Some(sample(1024, 1)), &probe);
        assert_eq!(order[0], Source::SelfHosted);
    }

    #[test]
    fn unpacking_a_zip_strips_the_top_level_directory() {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            w.add_directory("node-v1-win-x64/", opts).unwrap();
            w.start_file("node-v1-win-x64/node.exe", opts).unwrap();
            std::io::Write::write_all(&mut w, b"MZ").unwrap();
            w.start_file("node-v1-win-x64/node_modules/npm/bin/npm-cli.js", opts)
                .unwrap();
            std::io::Write::write_all(&mut w, b"// npm").unwrap();
            w.finish().unwrap();
        }
        let dest = tempfile::tempdir().unwrap();
        unpack("node-v1-win-x64.zip", buf.get_ref(), dest.path()).unwrap();
        assert_eq!(std::fs::read(dest.path().join("node.exe")).unwrap(), b"MZ");
        assert!(dest
            .path()
            .join("node_modules/npm/bin/npm-cli.js")
            .is_file());
        assert!(!dest.path().join("node-v1-win-x64").exists());
    }

    #[cfg(unix)]
    #[test]
    fn unpacking_a_tarball_keeps_modes_and_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let src = tempfile::tempdir().unwrap();
        let root = src.path().join("node-v1-darwin-arm64");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("lib/node_modules/npm/bin")).unwrap();
        std::fs::write(root.join("bin/node"), b"#!/bin/sh\necho v1\n").unwrap();
        std::fs::set_permissions(
            root.join("bin/node"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        std::fs::write(root.join("lib/node_modules/npm/bin/npm-cli.js"), b"// npm").unwrap();
        std::os::unix::fs::symlink(
            "../lib/node_modules/npm/bin/npm-cli.js",
            root.join("bin/npm"),
        )
        .unwrap();

        let mut bytes = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut bytes, flate2::Compression::fast());
            let mut tar = tar::Builder::new(gz);
            tar.follow_symlinks(false);
            tar.append_dir_all("node-v1-darwin-arm64", &root).unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }

        let dest = tempfile::tempdir().unwrap();
        unpack("node-v1-darwin-arm64.tar.gz", &bytes, dest.path()).unwrap();
        let node = dest.path().join("bin/node");
        assert!(node.is_file());
        assert_ne!(
            std::fs::metadata(&node).unwrap().permissions().mode() & 0o111,
            0
        );
        assert!(dest
            .path()
            .join("bin/npm")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(dest
            .path()
            .join("lib/node_modules/npm/bin/npm-cli.js")
            .is_file());
        assert!(!dest.path().join("node-v1-darwin-arm64").exists());
    }

    #[test]
    fn node_status_serializes_camel_case() {
        let s = NodeStatus {
            present: true,
            version: Some("24.20.0".into()),
            path: Some("/x/node".into()),
            required_version: "24.20.0".into(),
            managed: true,
            satisfied: true,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["requiredVersion"], serde_json::json!("24.20.0"));
        assert_eq!(v["managed"], serde_json::json!(true));
        assert_eq!(v["satisfied"], serde_json::json!(true));
    }
}
