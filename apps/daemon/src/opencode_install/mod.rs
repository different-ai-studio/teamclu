//! opencode discovery + install for amuxd.
//!
//! Policy (revised 2026-07-26): the opencode VERSION belongs to the user, not to
//! amuxd. amuxd no longer pins a version — there is no lock file and no minimum.
//! It only answers "is opencode there, and where": if none is installed we fetch
//! the latest release, and `--force` re-fetches the latest on demand (what the
//! settings "Update" button does). An already-installed opencode is never
//! touched otherwise, whatever its version.
//!
//! opencode is installed via its OFFICIAL installer into its own default dir
//! `~/.opencode/bin` (NOT into ~/.amuxd). amuxd resolves it by absolute path
//! (`~/.opencode/bin/opencode`) so a background launchd/systemd service finds it
//! without a login PATH.

use crate::process_util::CommandNoWindow;
use serde::Serialize;
use std::path::PathBuf;

/// opencode's official installer always installs to `~/.opencode/bin` (hardcoded upstream).
pub fn opencode_default_bin() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "opencode.exe"
    } else {
        "opencode"
    };
    dirs::home_dir().map(|h| h.join(".opencode").join("bin").join(name))
}

/// Resolve the opencode binary amuxd should run. Order:
///   explicit daemon.toml config -> ~/.opencode/bin/opencode (absolute) -> "opencode" (PATH).
/// The absolute step matters for a background service whose PATH excludes ~/.opencode/bin.
fn resolve_binary_with(configured: Option<&str>, default_bin: Option<PathBuf>) -> String {
    if let Some(b) = configured {
        // AgentBackendConfig.binary serde default is the shared "claude"; when
        // [agents.opencode] exists but omits `binary`, treat that as "not configured".
        if !b.is_empty() && b != "claude" {
            return b.to_string();
        }
    }
    if let Some(p) = default_bin {
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    "opencode".to_string()
}

pub fn resolve_binary(configured: Option<&str>) -> String {
    resolve_binary_with(configured, opencode_default_bin())
}

/// Re-exported so the daemon and the desktop compare versions the same way.
/// The implementation lives in `teamclu_runtime_env::version`.
pub use teamclu_runtime_env::version::{parse_semver, version_ge};

/// `<bin> --version`, returning the first token that looks like a version.
fn opencode_version_of(bin: &str) -> Option<String> {
    let out = std::process::Command::new(bin)
        .no_window()
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

/// Detect the opencode amuxd would run + its reported version.
pub fn detect_opencode() -> Option<(String, String)> {
    let bin = resolve_binary(None);
    let version = opencode_version_of(&bin)?;
    Some((bin, version))
}

fn progress(event: &str, message: &str) {
    println!(
        "{}",
        serde_json::json!({ "event": event, "message": message })
    );
}

/// A progress line that also names the source this install is pulling from.
///
/// `route` is one of [`crate::route_probe::route`]. Emitted at the download
/// itself rather than at the decision above it, so the mirror-failed fallback
/// inside [`direct_install`] corrects the answer instead of leaving the wizard
/// claiming a source we stopped using.
fn progress_route(event: &str, message: &str, route: &str) {
    println!(
        "{}",
        serde_json::json!({ "event": event, "message": message, "route": route })
    );
}

/// Final "ok" line after an install/update, naming the version that actually
/// landed — the UI surfaces this, and it is the only version amuxd reports.
fn report_installed() {
    match detect_opencode() {
        Some((path, version)) => progress("ok", &format!("opencode {version} installed ({path})")),
        None => progress("ok", "opencode installed"),
    }
}

/// Upstream source of truth for opencode release assets — the official
/// sst/opencode `latest` release. Used directly when the mirror can't answer.
const DEFAULT_DOWNLOAD_BASE: &str = "https://github.com/sst/opencode/releases/latest/download";

/// OSS mirror root, for networks where GitHub is slow or unreachable. Fixed —
/// there is deliberately no per-brand override, since a build-config knob is
/// what let a stale mirror silently downgrade opencode before.
///
/// Layout (see .github/workflows/mirror-opencode-oss.yml):
///   `<base>/latest.json`         `{"version": "1.18.5"}` — never cached
///   `<base>/<version>/<asset>`   immutable, cached hard
///
/// The version lives in the PATH on purpose. The mirror used to overwrite one
/// fixed path behind a caching CDN, so clients could be handed a months-old
/// build with no way to tell — "update to latest" downgraded 1.18.5 -> 1.17.7.
/// A versioned URL names exactly one build, so only the tiny manifest has to be
/// fresh, and a stale manifest can at worst cost us one release of latency.
const MIRROR_BASE: &str = "https://teamclaw.ucar.cc/opencode";

/// How long to wait on the mirror manifest before giving up and using upstream.
/// Deliberately short: this runs before any progress output, so a hung mirror
/// would look like a frozen install.
const MANIFEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How much of the real asset to pull when measuring the upstream route.
///
/// 2 MiB rather than a few hundred KB: the first half-megabyte arrives in an
/// initial burst (server-side buffer plus a grown receive window) and measured
/// 10 MB/s on a route whose sustained rate was 3 MB/s. Sampling past the burst
/// is what makes the number mean anything. Still only ~3% of the ~60 MB asset.
const PROBE_BYTES: u64 = 2 * 1024 * 1024;

/// Hard stop for the sample transfer, measured from the first byte. A route
/// that cannot deliver `PROBE_BYTES` inside this window is already far below
/// the bar, so there is nothing to learn by waiting longer.
const PROBE_TRANSFER_DEADLINE: std::time::Duration = std::time::Duration::from_secs(4);

/// A sample below this says more about handshake jitter than about the route.
const MIN_PROBE_SAMPLE: u64 = 64 * 1024;

/// Throughput at or above which upstream is worth using. The asset is ~60 MB,
/// so this is the "upstream finishes in about a minute" line. Below it the OSS
/// mirror is very likely faster, and being wrong there costs one mirror
/// download rather than the ten-minute crawl this replaces.
const MIN_UPSTREAM_BYTES_PER_SEC: f64 = 1024.0 * 1024.0;

/// Official opencode CLI release asset for an (os, arch) pair, using
/// `std::env::consts` names. Returns None for unsupported targets.
fn asset_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("opencode-darwin-arm64.zip"),
        ("macos", "x86_64") => Some("opencode-darwin-x64.zip"),
        ("linux", "aarch64") => Some("opencode-linux-arm64.tar.gz"),
        ("linux", "x86_64") => Some("opencode-linux-x64.tar.gz"),
        ("windows", "x86_64") => Some("opencode-windows-x64.zip"),
        ("windows", "aarch64") => Some("opencode-windows-arm64.zip"),
        _ => None,
    }
}

/// The release asset for the platform this binary is running on.
fn current_asset() -> Option<&'static str> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// Download URL for a release asset on the official upstream.
fn download_url(asset: &str) -> String {
    let base = DEFAULT_DOWNLOAD_BASE.trim_end_matches('/');
    format!("{base}/{asset}")
}

/// How the upstream route is sampled, and the bar it has to clear.
///
/// The asset is ~60 MB, so `min_bytes_per_sec` is the "upstream finishes in
/// about a minute" line. Below it the OSS mirror is very likely faster, and
/// being wrong there costs one mirror download rather than the ten-minute
/// crawl this replaces.
fn upstream_probe() -> crate::route_probe::Probe {
    crate::route_probe::Probe {
        bytes: PROBE_BYTES,
        min_sample: MIN_PROBE_SAMPLE,
        connect_timeout: MANIFEST_TIMEOUT,
        transfer_deadline: PROBE_TRANSFER_DEADLINE,
        min_bytes_per_sec: MIN_UPSTREAM_BYTES_PER_SEC,
    }
}

/// Measure what the official CDN actually delivers on this network.
///
/// This replaces a HEAD reachability check — see `crate::route_probe` for why
/// reachability was the wrong question.
fn measure_upstream_route(asset: &str) -> Option<crate::route_probe::RouteSample> {
    upstream_probe().measure(&download_url(asset))
}

/// Download URL for `asset` at `version` on the mirror.
fn mirror_asset_url(version: &str, asset: &str) -> String {
    let base = MIRROR_BASE.trim_end_matches('/');
    format!("{base}/{version}/{asset}")
}

/// The mirror manifest: which version its versioned directories currently hold.
#[derive(Debug, serde::Deserialize)]
struct MirrorManifest {
    version: String,
}

/// Ask the mirror what the newest version it carries is. `None` on any failure
/// (offline, DNS, timeout, malformed JSON) — the mirror is an optimization, so
/// every error path just means "use upstream instead".
pub fn mirror_latest_version() -> Option<String> {
    let url = format!("{}/latest.json", MIRROR_BASE.trim_end_matches('/'));
    // Every failure below used to collapse into a bare `.ok()?`, so a mirror
    // that had been unreachable for weeks looked identical to one that was
    // fine: `latest: null`, no output anywhere. That is what made the settings
    // row offer "Update" forever on an already-current install. Downgrading to
    // upstream is still the right behaviour — it just has to say so.
    let manifest: MirrorManifest = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| eprintln!("[opencode] mirror runtime: {e}"))
        .ok()?
        .block_on(async {
            let client = reqwest::Client::builder()
                .timeout(MANIFEST_TIMEOUT)
                .build()
                .map_err(|e| eprintln!("[opencode] mirror client: {e}"))
                .ok()?;
            let resp = client
                .get(&url)
                .send()
                .await
                .map_err(|e| eprintln!("[opencode] mirror unreachable ({url}): {e}"))
                .ok()?
                .error_for_status()
                .map_err(|e| eprintln!("[opencode] mirror status ({url}): {e}"))
                .ok()?;
            resp.json::<MirrorManifest>()
                .await
                .map_err(|e| eprintln!("[opencode] mirror manifest parse ({url}): {e}"))
                .ok()
        })?;
    let version = manifest.version.trim().trim_start_matches('v').to_string();
    // A manifest we can't parse as a version is a broken mirror, not a hint.
    match parse_semver(&version) {
        Some(_) => Some(version),
        None => {
            eprintln!("[opencode] mirror returned unparseable version {version:?} ({url})");
            None
        }
    }
}

/// Blocking download of `url` into memory, streaming byte-count progress lines
/// as the body arrives (see `crate::download_progress`). Builds its own
/// current-thread tokio runtime so it is safe to call from the synchronous CLI
/// path.
fn download_bytes(url: &str) -> anyhow::Result<Vec<u8>> {
    crate::download_progress::download(url)
}

/// Extract the opencode binary from a downloaded `.zip` or `.tar.gz` asset and
/// install it at `dest`, replacing any existing (possibly running) binary.
fn unpack_opencode(asset: &str, bytes: &[u8], dest: &std::path::Path) -> anyhow::Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bin_suffix = if cfg!(windows) {
        "opencode.exe"
    } else {
        "opencode"
    };
    let tmp = dest.with_extension("download.tmp");

    if asset.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
        // The binary may sit at the zip root or under a directory; match by name.
        let entry_name = zip
            .file_names()
            .find(|n| n.ends_with(bin_suffix))
            .map(|n| n.to_string())
            .ok_or_else(|| anyhow::anyhow!("{bin_suffix} not found in {asset}"))?;
        let mut entry = zip.by_name(&entry_name)?;
        let mut out = std::fs::File::create(&tmp)?;
        std::io::copy(&mut entry, &mut out)?;
    } else if asset.ends_with(".tar.gz") {
        let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
        let mut archive = tar::Archive::new(gz);
        let mut found = false;
        for entry in archive.entries()? {
            let mut entry = entry?;
            let is_bin = entry
                .path()?
                .file_name()
                .map(|n| n == bin_suffix)
                .unwrap_or(false);
            if is_bin {
                let mut out = std::fs::File::create(&tmp)?;
                std::io::copy(&mut entry, &mut out)?;
                found = true;
                break;
            }
        }
        if !found {
            anyhow::bail!("{bin_suffix} not found in {asset}");
        }
    } else {
        anyhow::bail!("unsupported opencode asset type: {asset}");
    }

    if dest.exists() {
        // A running opencode may lock its file against overwrite; move it aside
        // first (renaming a running binary is allowed on every platform).
        let old = dest.with_extension("old");
        let _ = std::fs::remove_file(&old);
        let _ = std::fs::rename(dest, &old);
    }
    std::fs::rename(&tmp, dest)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(dest)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(dest, perms)?;
    }
    Ok(())
}

/// Direct-download install: fetch the current platform's release asset and
/// unpack it into `~/.opencode/bin`.
///
/// Downloads from the requested OSS mirror version, falling back to upstream if
/// that mirror download fails. `mirror_version` is the already-resolved manifest
/// answer, so callers that needed it for an up-to-date check don't fetch it twice.
fn direct_install(mirror_version: Option<&str>) -> anyhow::Result<()> {
    let asset = current_asset().ok_or_else(|| {
        anyhow::anyhow!(
            "unsupported platform for direct opencode install: {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let dest = opencode_default_bin().ok_or_else(|| anyhow::anyhow!("no home dir"))?;

    if let Some(version) = mirror_version {
        let url = mirror_asset_url(version, asset);
        progress_route(
            "download",
            &format!("downloading {url}"),
            crate::route_probe::route::SELF_HOSTED,
        );
        match download_bytes(&url) {
            Ok(bytes) => {
                progress("unpack", &format!("unpacking {asset}"));
                return unpack_opencode(asset, &bytes, &dest);
            }
            Err(e) => {
                // The mirror is an accelerator, never a hard dependency.
                progress(
                    "download",
                    &format!("mirror download failed ({e}); falling back to the official source"),
                );
            }
        }
    }

    let url = download_url(asset);
    progress_route(
        "download",
        &format!("downloading {url}"),
        crate::route_probe::route::OFFICIAL,
    );
    let bytes = download_bytes(&url)?;
    progress("unpack", &format!("unpacking {asset}"));
    unpack_opencode(asset, &bytes, &dest)
}

/// Minimal system PATH for subprocesses spawned from a GUI/sidecar context.
/// Dock-launched apps (and their sidecars) often inherit an empty PATH; the
/// official opencode install script calls `mkdir`, `curl`, `unzip`, etc. by name.
#[cfg(not(windows))]
fn minimal_system_path() -> &'static str {
    if cfg!(target_os = "macos") {
        "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"
    } else if cfg!(target_os = "linux") {
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    } else {
        ""
    }
}

#[cfg(not(windows))]
fn install_command_path() -> String {
    let base = minimal_system_path();
    match std::env::var("PATH") {
        Ok(existing) if !existing.trim().is_empty() => format!("{existing}:{base}"),
        _ => base.to_string(),
    }
}

/// Install opencode, or (with `force`) update it to the latest release.
///
/// Without `force` this is presence-only: any installed opencode is left alone,
/// whatever its version — amuxd does not pin or require a version. `force` is
/// the settings "Update" path and always re-fetches.
///
/// Source selection, in order:
///   * The official GitHub release when a ranged sample of the real asset
///     clears `MIN_UPSTREAM_BYTES_PER_SEC` on this network.
///   * The versioned OSS mirror when the official route is slow or blocked.
///   * macOS/Linux's official opencode.ai installer as a last fallback.
pub fn run_install(force: bool) -> anyhow::Result<()> {
    if !force {
        if let Some((path, have)) = detect_opencode() {
            progress(
                "ok",
                &format!("opencode {have} already installed ({path}); pass --force to update"),
            );
            return Ok(());
        }
        progress("install", "installing the latest opencode");
    } else {
        progress("upgrade", "updating opencode to the latest release");
    }

    // Announced before the sample runs. Measuring the route costs a 5s connect
    // budget plus a 4s transfer deadline, and saying so only afterwards left the
    // wizard sitting on the previous line for all of it.
    progress("probe", "checking which download route is fastest");
    let upstream = current_asset().and_then(measure_upstream_route);
    match upstream {
        Some(sample) if sample.meets(&upstream_probe()) => {
            progress(
                "source",
                &format!(
                    "official OpenCode release measured at {:.1} MB/s; downloading from upstream",
                    sample.mib_per_sec()
                ),
            );
            direct_install(None)?;
            report_installed();
            return Ok(());
        }
        Some(sample) => progress(
            "source",
            &format!(
                "official OpenCode release measured at {:.1} MB/s, below the {:.1} MB/s bar; \
                 trying the OSS mirror",
                sample.mib_per_sec(),
                MIN_UPSTREAM_BYTES_PER_SEC / (1024.0 * 1024.0)
            ),
        ),
        None => progress(
            "source",
            "official OpenCode release is unreachable; trying the OSS mirror",
        ),
    }
    // Resolved once and threaded through: the manifest is a network round-trip.
    let mirror_version = mirror_latest_version();
    if let Some(v) = &mirror_version {
        progress("mirror", &format!("mirror carries opencode {v}"));
    }

    // The mirror serves every platform after the official preflight fails.
    if mirror_version.is_some() || cfg!(windows) {
        direct_install(mirror_version.as_deref())?;
        report_installed();
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        progress_route(
            "install",
            "running the official opencode installer",
            crate::route_probe::route::OFFICIAL,
        );
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg("curl -fsSL https://opencode.ai/install | bash")
            .env("PATH", install_command_path())
            .output()
            .map_err(|e| anyhow::anyhow!("failed to run opencode installer: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("opencode installer exited with {}", output.status)
            };
            anyhow::bail!("{detail}");
        }
        report_installed();
        Ok(())
    }
    #[cfg(windows)]
    {
        // Unreachable: `cfg!(windows)` above always returns early on Windows.
        unreachable!("windows install is handled by direct_install above")
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStatus {
    pub present: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// amuxd pins no version, so "satisfied" means nothing more than "present".
    /// Kept so setup/diagnostics can treat opencode and pi uniformly.
    pub satisfied: bool,
}

#[derive(Debug, Serialize)]
pub struct ComponentStatus {
    pub present: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmuxdStatus {
    /// A daemon binary is installed at ~/.amuxd/bin/amuxd.
    pub present: bool,
    /// Version of the installed binary (`amuxd --version`), if present.
    pub installed_version: Option<String>,
    /// Version bundled with THIS app build (the doctor binary is the bundled one).
    pub bundled_version: String,
    pub path: Option<String>,
    /// present AND installed_version >= bundled_version (no update needed).
    pub satisfied: bool,
}

#[derive(Debug, Serialize)]
pub struct DoctorReport {
    pub opencode: OpencodeStatus,
    pub git: ComponentStatus,
    pub amuxd: AmuxdStatus,
    /// pi runtime status; populated only when `agents.local_agent == "pi"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pi: Option<crate::pi_install::PiStatus>,
    /// Cursor SDK status; populated only when `agents.local_agent == "cursor"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<crate::cursor_install::CursorStatus>,
    /// Claude CLI status; populated only when `agents.local_agent` selects claude.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude: Option<crate::claude_install::ClaudeStatus>,
}

/// `<amuxd> --version` -> the first version-like token (clap prints "amuxd X.Y.Z").
fn amuxd_installed_version(path: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new(path)
        .no_window()
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .find(|t| parse_semver(t).is_some())
        .map(|t| t.to_string())
}

fn probe_version(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd)
        .no_window()
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    Some(s.lines().next().unwrap_or("").trim().to_string())
}

pub fn doctor() -> DoctorReport {
    let detected = detect_opencode();
    let (present, version, path) = match &detected {
        Some((p, v)) => (true, Some(v.clone()), Some(p.clone())),
        None => (false, None, None),
    };
    let opencode = OpencodeStatus {
        present,
        version,
        path,
        // No pinned version: any installed opencode counts as satisfied.
        satisfied: present,
    };

    let git_version = probe_version("git", &["--version"]);
    let git = ComponentStatus {
        present: git_version.is_some(),
        version: git_version,
        path: None,
    };

    let bundled_version = env!("CARGO_PKG_VERSION").to_string();
    // When doctor runs as the desktop sidecar, report *this* binary as amuxd
    // (desktop-managed mode does not copy into ~/.amuxd/bin).
    let self_exe = std::env::current_exe().ok();
    let amuxd_path = crate::config::DaemonConfig::config_dir()
        .join("bin")
        .join(if cfg!(windows) { "amuxd.exe" } else { "amuxd" });
    let (amuxd_present, installed_version, path, amuxd_satisfied) = if let Some(ref p) = self_exe {
        (
            true,
            Some(bundled_version.clone()),
            Some(p.to_string_lossy().to_string()),
            true,
        )
    } else {
        let present = amuxd_path.exists();
        let installed = if present {
            amuxd_installed_version(&amuxd_path)
        } else {
            None
        };
        let satisfied = installed
            .as_deref()
            .map(|v| version_ge(v, &bundled_version))
            .unwrap_or(false);
        (
            present,
            installed,
            present.then(|| amuxd_path.to_string_lossy().to_string()),
            satisfied,
        )
    };
    let amuxd = AmuxdStatus {
        present: amuxd_present,
        installed_version,
        bundled_version,
        path,
        satisfied: amuxd_satisfied,
    };

    DoctorReport {
        opencode,
        git,
        amuxd,
        pi: None,
        cursor: None,
        claude: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_semver_cases() {
        assert_eq!(parse_semver("1.15.13"), Some((1, 15, 13)));
        assert_eq!(parse_semver("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_semver("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_semver("1.15.13-beta"), Some((1, 15, 13)));
        assert_eq!(parse_semver("opencode 1.17.7 teamclu"), Some((1, 17, 7)));
        assert_eq!(parse_semver("opencode 1.17.7-teamclu"), Some((1, 17, 7)));
        assert_eq!(parse_semver("garbage"), None);
    }

    #[test]
    fn version_ge_cases() {
        assert!(version_ge("1.15.13", "1.15.13"));
        assert!(version_ge("1.16.0", "1.15.13"));
        assert!(version_ge("2.0.0", "1.9.9"));
        assert!(!version_ge("1.15.12", "1.15.13"));
        assert!(!version_ge("garbage", "1.0.0"));
    }

    #[test]
    fn resolve_binary_precedence() {
        // explicit config (non-"claude") wins
        assert_eq!(resolve_binary_with(Some("/opt/oc"), None), "/opt/oc");
        // shared "claude" default is treated as unconfigured -> falls through
        assert_eq!(resolve_binary_with(Some("claude"), None), "opencode");
        // no config, no default-dir binary -> PATH fallback
        assert_eq!(resolve_binary_with(None, None), "opencode");
        // no config, default-dir binary exists -> its absolute path
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("opencode");
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(
            resolve_binary_with(None, Some(p.clone())),
            p.to_string_lossy().to_string()
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn install_command_path_includes_system_dirs_when_empty() {
        let prev = std::env::var("PATH").ok();
        std::env::remove_var("PATH");
        let p = install_command_path();
        assert!(p.contains("/usr/bin"), "got {p}");
        assert!(p.contains("/bin"), "got {p}");
        match prev {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
    }

    fn sample(bytes: u64, millis: u64) -> crate::route_probe::RouteSample {
        crate::route_probe::RouteSample {
            bytes,
            elapsed: std::time::Duration::from_millis(millis),
        }
    }

    #[test]
    fn a_slow_upstream_route_loses_to_the_mirror() {
        // The regression this whole change is about: GitHub answers, then
        // trickles. 2 MiB in 4s is ~512 KB/s — a ~2 minute download for the
        // 60 MB asset, and real CN routes are far worse than that.
        assert!(!sample(PROBE_BYTES, 4_000).meets(&upstream_probe()));
    }

    #[test]
    fn a_fast_upstream_route_is_kept() {
        // ~10 MB/s: upstream is fine here, don't send the user to the mirror.
        assert!(sample(PROBE_BYTES, 200).meets(&upstream_probe()));
    }

    #[test]
    fn the_upstream_bar_is_one_mib_per_second() {
        assert!(sample(1024 * 1024, 1_000).meets(&upstream_probe()));
        assert!(!sample(1024 * 1024, 1_100).meets(&upstream_probe()));
    }

    #[test]
    fn asset_for_matches_supported_targets() {
        assert_eq!(
            asset_for("macos", "aarch64"),
            Some("opencode-darwin-arm64.zip")
        );
        assert_eq!(
            asset_for("macos", "x86_64"),
            Some("opencode-darwin-x64.zip")
        );
        assert_eq!(
            asset_for("linux", "aarch64"),
            Some("opencode-linux-arm64.tar.gz")
        );
        assert_eq!(
            asset_for("linux", "x86_64"),
            Some("opencode-linux-x64.tar.gz")
        );
        assert_eq!(
            asset_for("windows", "x86_64"),
            Some("opencode-windows-x64.zip")
        );
        assert_eq!(
            asset_for("windows", "aarch64"),
            Some("opencode-windows-arm64.zip")
        );
        assert_eq!(asset_for("linux", "riscv64"), None);
        assert_eq!(asset_for("freebsd", "x86_64"), None);
    }

    #[test]
    fn current_asset_resolves_on_this_platform() {
        // The test host is one of the supported targets, so this must be Some.
        assert!(current_asset().is_some(), "unsupported test platform");
    }

    #[test]
    fn download_url_points_at_upstream_latest() {
        assert_eq!(
            download_url("opencode-windows-x64.zip"),
            "https://github.com/sst/opencode/releases/latest/download/opencode-windows-x64.zip"
        );
    }

    #[test]
    fn mirror_asset_url_puts_the_version_in_the_path() {
        // The version MUST be in the path, not in an overwritten "stable" dir:
        // that is what makes a CDN unable to serve a different build than asked.
        assert_eq!(
            mirror_asset_url("1.18.5", "opencode-darwin-arm64.zip"),
            "https://teamclaw.ucar.cc/opencode/1.18.5/opencode-darwin-arm64.zip"
        );
        assert!(!mirror_asset_url("1.18.5", "x.zip").contains("stable"));
    }

    #[test]
    fn mirror_manifest_parses_and_strips_v() {
        let m: MirrorManifest = serde_json::from_str(r#"{"version":"v1.18.5"}"#).unwrap();
        assert_eq!(m.version.trim_start_matches('v'), "1.18.5");
        // Extra fields (e.g. the workflow's `assets` list) must not break parsing.
        let m: MirrorManifest =
            serde_json::from_str(r#"{"version":"1.18.5","assets":["a.zip"]}"#).unwrap();
        assert_eq!(m.version, "1.18.5");
    }

    #[test]
    fn doctor_report_serializes() {
        let report = DoctorReport {
            opencode: OpencodeStatus {
                present: true,
                version: Some("1.15.13".into()),
                path: Some("/x".into()),
                satisfied: true,
            },
            git: ComponentStatus {
                present: false,
                version: None,
                path: None,
            },
            amuxd: AmuxdStatus {
                present: true,
                installed_version: Some("0.1.0".into()),
                bundled_version: "0.1.0".into(),
                path: Some("/a".into()),
                satisfied: true,
            },
            pi: None,
            cursor: None,
            claude: None,
        };
        let v: serde_json::Value = serde_json::to_value(&report).unwrap();
        assert!(v.get("pi").is_none(), "pi omitted when None");
        assert!(v.get("cursor").is_none(), "cursor omitted when None");
        assert!(v.get("claude").is_none(), "claude omitted when None");
        assert_eq!(v["opencode"]["satisfied"], serde_json::json!(true));
        assert!(
            v["opencode"].get("requiredVersion").is_none(),
            "amuxd no longer pins an opencode version"
        );
        assert_eq!(v["git"]["present"], serde_json::json!(false));
        assert_eq!(v["amuxd"]["installedVersion"], serde_json::json!("0.1.0"));
        assert_eq!(v["amuxd"]["satisfied"], serde_json::json!(true));
    }
}
