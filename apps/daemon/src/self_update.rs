//! Self-update for the standalone amuxd — the `<amuxd home>/bin/amuxd` that
//! `install-amuxd.sh` / `.ps1` put there and `amuxd install-service` runs.
//!
//! `amuxd update` and the daemon's background check share one path:
//!
//! 1. Fetch `<channel>/amuxd/latest.json`, which `scripts/publish-oss-release.py`
//!    writes on every release. The channel (`<CDN>/<OSS prefix>`) is baked in
//!    by `build.rs` from the release job's environment; `AMUXD_UPDATE_BASE_URL`
//!    overrides it at runtime. A build without one — a source build, the
//!    self-host container — has nothing to update from.
//! 2. Download this platform's binary from the manifest's own origin over
//!    https, and check its size and SHA-256 against the manifest.
//! 3. Write it beside the installed binary and run its `--version`. A build for
//!    the wrong architecture or a truncated file fails here, before anything
//!    is replaced.
//! 4. Swap it in by rename, keeping the previous binary as `amuxd.old`. A
//!    running executable can be renamed everywhere, Windows included, where it
//!    cannot be overwritten.
//! 5. Record the swap in `update-state.json`. Every boot of the new version
//!    counts an attempt and staying up for [`HEALTHY_AFTER`] clears the record.
//!    A version that gets through [`MAX_BOOT_ATTEMPTS`] boots without staying
//!    up is replaced by `amuxd.old`, and the background check skips it.
//!
//! Only that installed binary updates itself. The desktop sidecar runs from the
//! app bundle and follows the desktop updater; a container is replaced with its
//! image. Both run from somewhere other than `<amuxd home>/bin`, which is how
//! they are told apart.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{debug, info, warn};

use crate::process_util::CommandNoWindow;

include!(concat!(env!("OUT_DIR"), "/update_channel.rs"));

/// Runtime override for the baked-in channel, e.g. `https://cdn.example.com/beta`.
pub const BASE_URL_ENV: &str = "AMUXD_UPDATE_BASE_URL";
/// Any value other than empty, `0` or `false` turns the background check off.
pub const DISABLE_ENV: &str = "AMUXD_NO_AUTO_UPDATE";

/// Boots a freshly installed version gets before it is rolled back.
pub const MAX_BOOT_ATTEMPTS: u32 = 3;
/// How long a freshly installed version has to stay up to count as good.
pub const HEALTHY_AFTER: Duration = Duration::from_secs(120);

const DEFAULT_CHECK_INTERVAL_MINUTES: u64 = 6 * 60;
const MIN_CHECK_INTERVAL_MINUTES: u64 = 10;
/// Delay before the first background check, so a daemon that keeps restarting
/// does not fetch the manifest on every start.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(10 * 60);
const IDLE_POLL: Duration = Duration::from_secs(30);
/// Consecutive idle polls before the restart.
const IDLE_POLLS_REQUIRED: u32 = 2;
/// A daemon never seen idle restarts into the update anyway after this long —
/// the same ceiling the desktop's auto-restart uses.
const RESTART_WAIT_CEILING: Duration = Duration::from_secs(24 * 60 * 60);
/// How long a Windows successor waits for the exiting daemon's lock.
const SUCCESSOR_LOCK_WAIT_SECS: u64 = 300;
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_BINARY_BYTES: u64 = 512 * 1024 * 1024;
const SMOKE_TIMEOUT: Duration = Duration::from_secs(30);
const STATE_FILE: &str = "update-state.json";

/// The channel to update from: the runtime override, else the baked-in one.
pub fn channel_base() -> Option<String> {
    std::env::var(BASE_URL_ENV)
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| BAKED_UPDATE_BASE.map(|v| v.trim_end_matches('/').to_string()))
}

pub fn manifest_url(base: &str) -> String {
    format!("{}/amuxd/latest.json", base.trim_end_matches('/'))
}

/// `<os>-<arch>` as Rust spells them — the keys `publish-oss-release.py` writes.
pub fn platform_key() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// The installed binary this process may replace, or why it may not.
pub fn managed_binary() -> Result<PathBuf, String> {
    let target = crate::service::amuxd_exe_path();
    let current = std::env::current_exe()
        .map_err(|e| format!("cannot resolve the running amuxd binary: {e}"))?;
    if same_file(&current, &target) {
        Ok(target)
    } else {
        Err(format!(
            "this amuxd runs from {}, not the standalone install at {}; it is updated by whatever installed it (the desktop app, a container image, or a source build)",
            current.display(),
            target.display()
        ))
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// `amuxd/latest.json`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub platforms: BTreeMap<String, Asset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Asset {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

/// Whether `candidate` is a later release than `current`. Pre-release numbers
/// compare numerically (`beta.10` > `beta.9`), and a release is later than its
/// own pre-releases. Anything unparseable is not an update.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| semver::Version::parse(v.trim().trim_start_matches('v'));
    match (parse(candidate), parse(current)) {
        (Ok(candidate), Ok(current)) => candidate > current,
        _ => false,
    }
}

/// `scheme://authority` of `url`.
fn origin(url: &str) -> Option<&str> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    Some(&url[..scheme.len() + 3 + authority.len()])
}

/// Plain http is only for a channel on this machine (tests, local mirrors).
fn is_loopback(url: &str) -> bool {
    let Some(authority) = origin(url).and_then(|o| o.strip_prefix("http://")) else {
        return false;
    };
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

fn ensure_transport(url: &str) -> anyhow::Result<()> {
    if url.starts_with("https://") || is_loopback(url) {
        Ok(())
    } else {
        bail!("refusing to fetch {url}: amuxd updates are only fetched over https")
    }
}

/// A binary is only taken from where its manifest came from, so whoever can
/// edit the manifest cannot point it at a host of their choosing.
pub fn check_asset_url(manifest_url: &str, asset_url: &str) -> anyhow::Result<()> {
    ensure_transport(asset_url)?;
    match (origin(manifest_url), origin(asset_url)) {
        (Some(m), Some(a)) if m.eq_ignore_ascii_case(a) => Ok(()),
        _ => bail!(
            "the manifest at {manifest_url} points outside its own origin ({asset_url}); refusing to install it"
        ),
    }
}

fn http_client(timeout: Duration) -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(concat!("amuxd/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("build the update HTTP client")
}

/// Fetch the channel's manifest. Returns the URL it came from with it.
pub async fn fetch_manifest(base: &str) -> anyhow::Result<(String, Manifest)> {
    let url = manifest_url(base);
    ensure_transport(&url)?;
    let manifest = http_client(MANIFEST_TIMEOUT)?
        .get(&url)
        .send()
        .await
        .with_context(|| format!("fetch {url}"))?
        .error_for_status()
        .with_context(|| format!("fetch {url}"))?
        .json::<Manifest>()
        .await
        .with_context(|| format!("parse {url}"))?;
    Ok((url, manifest))
}

async fn download(asset: &Asset) -> anyhow::Result<Vec<u8>> {
    if asset.size == 0 || asset.size > MAX_BINARY_BYTES {
        bail!(
            "the manifest lists an implausible size ({} bytes) for {}",
            asset.size,
            asset.url
        );
    }
    let mut response = http_client(DOWNLOAD_TIMEOUT)?
        .get(&asset.url)
        .send()
        .await
        .with_context(|| format!("download {}", asset.url))?
        .error_for_status()
        .with_context(|| format!("download {}", asset.url))?;
    let mut bytes = Vec::with_capacity(asset.size as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .with_context(|| format!("download {}", asset.url))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > asset.size {
            bail!(
                "{} is larger than the {} bytes the manifest lists",
                asset.url,
                asset.size
            );
        }
    }
    verify(&bytes, asset)?;
    Ok(bytes)
}

pub fn verify(bytes: &[u8], asset: &Asset) -> anyhow::Result<()> {
    if bytes.len() as u64 != asset.size {
        bail!(
            "{}: got {} bytes, the manifest lists {}",
            asset.url,
            bytes.len(),
            asset.size
        );
    }
    let digest = hex::encode(Sha256::digest(bytes));
    let expected = asset.sha256.trim();
    if !digest.eq_ignore_ascii_case(expected) {
        bail!(
            "{}: SHA-256 {digest} does not match the manifest's {expected}",
            asset.url
        );
    }
    Ok(())
}

/// Where the binary an install replaced is kept.
pub fn backup_path(target: &Path) -> PathBuf {
    sibling(target, "old")
}

fn sibling(target: &Path, suffix: &str) -> PathBuf {
    let mut name = target
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".");
    name.push(suffix);
    target.with_file_name(name)
}

/// Put `bytes` in place of `target` once it runs as `version`, keeping the
/// previous binary at [`backup_path`]. Blocking.
pub fn install(target: &Path, bytes: &[u8], version: &str) -> anyhow::Result<()> {
    let staged = sibling(target, "new");
    let _ = std::fs::remove_file(&staged);
    write_executable(&staged, bytes)?;
    if let Err(e) = smoke_test(&staged, version) {
        let _ = std::fs::remove_file(&staged);
        return Err(e);
    }
    swap_in(target, &staged, &backup_path(target))
}

fn write_executable(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut file =
        std::fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .with_context(|| format!("write {}", path.display()))?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("chmod {}", path.display()))?;
    }
    Ok(())
}

fn smoke_test(binary: &Path, version: &str) -> anyhow::Result<()> {
    let output = run_version(binary)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let want = version.trim_start_matches('v');
    let reports_version = stdout
        .split_whitespace()
        .any(|token| token.trim_start_matches('v') == want);
    if !output.status.success() || !reports_version {
        bail!(
            "the downloaded amuxd does not run as {want}: `--version` exited {} with {:?}",
            output.status,
            stdout.trim()
        );
    }
    Ok(())
}

fn run_version(binary: &Path) -> anyhow::Result<std::process::Output> {
    use std::process::{Command, Stdio};
    let mut attempts = 0;
    let mut child = loop {
        match Command::new(binary)
            .no_window()
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => break child,
            // Another thread forking while the file was still open for writing
            // leaves it "busy" for a moment on Linux.
            Err(e) if is_text_file_busy(&e) && attempts < 10 => {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(anyhow!(e).context(format!("run {} --version", binary.display()))),
        }
    };
    let deadline = Instant::now() + SMOKE_TIMEOUT;
    while child.try_wait()?.is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "{} --version did not exit within {}s",
                binary.display(),
                SMOKE_TIMEOUT.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(child.wait_with_output()?)
}

fn is_text_file_busy(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(libc::ETXTBSY)
    }
    #[cfg(not(unix))]
    {
        let _ = e;
        false
    }
}

fn swap_in(target: &Path, staged: &Path, backup: &Path) -> anyhow::Result<()> {
    let had_target = target.exists();
    if had_target {
        if backup.exists() {
            std::fs::remove_file(backup)
                .with_context(|| format!("remove the previous backup {}", backup.display()))?;
        }
        std::fs::rename(target, backup)
            .with_context(|| format!("move {} aside", target.display()))?;
    }
    if let Err(e) = std::fs::rename(staged, target) {
        if had_target {
            let _ = std::fs::rename(backup, target);
        }
        let _ = std::fs::remove_file(staged);
        return Err(anyhow!(e).context(format!("move the new binary into {}", target.display())));
    }
    Ok(())
}

/// `update-state.json`, beside the binary.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct UpdateState {
    /// Written by an install, cleared once that version stays up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<PendingBoot>,
    /// A version that was rolled back. The background check does not install
    /// it again; `amuxd update` does not look at this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    skip_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PendingBoot {
    from_version: String,
    to_version: String,
    boot_attempts: u32,
}

fn load_state(dir: &Path) -> UpdateState {
    std::fs::read(dir.join(STATE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_state(dir: &Path, state: &UpdateState) -> anyhow::Result<()> {
    let path = dir.join(STATE_FILE);
    if *state == UpdateState::default() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        };
    }
    let tmp = dir.join(format!("{STATE_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(state)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

pub enum BootCheck {
    Continue,
    /// This version never stayed up; the previous binary is back at `binary`
    /// and this process should exit so it runs.
    RolledBack {
        failed: String,
        restored: String,
        binary: PathBuf,
    },
}

/// Called by `amuxd start` as soon as it holds the daemon lock, before
/// anything else can fail.
pub fn on_boot() -> BootCheck {
    match managed_binary() {
        Ok(target) => boot_check(&target, env!("CARGO_PKG_VERSION")),
        Err(_) => BootCheck::Continue,
    }
}

fn boot_check(target: &Path, running: &str) -> BootCheck {
    let Some(dir) = target.parent() else {
        return BootCheck::Continue;
    };
    let mut state = load_state(dir);
    let Some(pending) = state.pending.take() else {
        return BootCheck::Continue;
    };
    if pending.to_version != running {
        // Not the version that was installed: the backup runs again, or the
        // binary was replaced by hand. Nothing is left to watch.
        if let Err(e) = save_state(dir, &state) {
            warn!(error = %e, "clear the amuxd update record");
        }
        return BootCheck::Continue;
    }
    if pending.boot_attempts < MAX_BOOT_ATTEMPTS {
        state.pending = Some(PendingBoot {
            boot_attempts: pending.boot_attempts + 1,
            ..pending
        });
        if let Err(e) = save_state(dir, &state) {
            warn!(error = %e, "record an amuxd boot attempt");
        }
        return BootCheck::Continue;
    }
    let backup = backup_path(target);
    if !backup.exists() {
        warn!(
            version = %pending.to_version,
            "amuxd keeps failing to stay up after an update, and there is no previous binary to restore"
        );
        let _ = save_state(dir, &state);
        return BootCheck::Continue;
    }
    if let Err(e) = restore(target, &backup) {
        warn!(error = %format!("{e:#}"), "restore the previous amuxd");
        return BootCheck::Continue;
    }
    state.skip_version = Some(pending.to_version.clone());
    if let Err(e) = save_state(dir, &state) {
        warn!(error = %e, "record the amuxd rollback");
    }
    BootCheck::RolledBack {
        failed: pending.to_version,
        restored: pending.from_version,
        binary: target.to_path_buf(),
    }
}

fn restore(target: &Path, backup: &Path) -> anyhow::Result<()> {
    let failed = sibling(target, "failed");
    let _ = std::fs::remove_file(&failed);
    std::fs::rename(target, &failed).with_context(|| format!("move {} aside", target.display()))?;
    if let Err(e) = std::fs::rename(backup, target) {
        let _ = std::fs::rename(&failed, target);
        return Err(anyhow!(e).context(format!("restore {}", backup.display())));
    }
    Ok(())
}

/// This version has stayed up: stop counting its boots.
fn mark_boot_healthy() {
    if let Some(dir) = managed_binary().ok().as_deref().and_then(Path::parent) {
        clear_pending_for(dir, env!("CARGO_PKG_VERSION"));
    }
}

fn clear_pending_for(dir: &Path, running: &str) {
    let mut state = load_state(dir);
    if state
        .pending
        .as_ref()
        .is_some_and(|p| p.to_version == running)
    {
        state.pending = None;
        match save_state(dir, &state) {
            Ok(()) => info!(version = running, "amuxd update is up and healthy"),
            Err(e) => warn!(error = %e, "clear the amuxd update record"),
        }
    }
}

#[derive(Debug)]
pub enum Outcome {
    UpToDate { current: String, latest: String },
    Skipped { version: String },
    Installed { from: String, to: String },
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// Install even when the channel's version is not newer.
    pub force: bool,
    /// Pass over a version this machine rolled back.
    pub respect_skip: bool,
}

/// Bring `target` up to the channel's version. Does not restart anything.
pub async fn update_installed(
    target: &Path,
    base: &str,
    options: Options,
) -> anyhow::Result<Outcome> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let (manifest_url, manifest) = fetch_manifest(base).await?;
    let latest = manifest.version.trim().trim_start_matches('v').to_string();
    if !options.force && !is_newer(&latest, &current) {
        return Ok(Outcome::UpToDate { current, latest });
    }
    let dir = target
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", target.display()))?
        .to_path_buf();
    if options.respect_skip && load_state(&dir).skip_version.as_deref() == Some(latest.as_str()) {
        return Ok(Outcome::Skipped { version: latest });
    }
    let key = platform_key();
    let asset = manifest
        .platforms
        .get(&key)
        .cloned()
        .ok_or_else(|| anyhow!("amuxd {latest} has no build for {key}"))?;
    check_asset_url(&manifest_url, &asset.url)?;
    let bytes = download(&asset).await?;
    let install_target = target.to_path_buf();
    let install_version = latest.clone();
    tokio::task::spawn_blocking(move || install(&install_target, &bytes, &install_version))
        .await
        .context("the install task panicked")??;

    let mut state = load_state(&dir);
    state.skip_version = None;
    state.pending = Some(PendingBoot {
        from_version: current.clone(),
        to_version: latest.clone(),
        boot_attempts: 0,
    });
    if let Err(e) = save_state(&dir, &state) {
        warn!(error = %e, "record the amuxd update; it will not be rolled back if it fails to boot");
    }
    Ok(Outcome::Installed {
        from: current,
        to: latest,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartMode {
    /// A service manager relaunches the daemon when it exits (launchd
    /// `KeepAlive`, systemd `Restart=always`).
    Exit,
    /// Nothing relaunches it (the Windows logon task): start the new daemon,
    /// which waits for the lock, then exit.
    SpawnSuccessor,
    /// Started by hand. Whoever started it restarts it.
    Manual,
}

pub fn restart_mode() -> RestartMode {
    if cfg!(windows) {
        return RestartMode::SpawnSuccessor;
    }
    if started_by_service_manager() {
        RestartMode::Exit
    } else {
        RestartMode::Manual
    }
}

#[cfg(target_os = "macos")]
fn started_by_service_manager() -> bool {
    // launchd names the job in the environment of every process it starts.
    std::env::var("XPC_SERVICE_NAME").is_ok_and(|label| label == crate::service::LAUNCHD_LABEL)
}

#[cfg(target_os = "linux")]
fn started_by_service_manager() -> bool {
    // systemd sets this for every unit it starts, user units included.
    std::env::var_os("INVOCATION_ID").is_some()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn started_by_service_manager() -> bool {
    false
}

/// Start `binary` as the next daemon. It waits for this one's lock.
pub fn spawn_successor(binary: &Path) -> anyhow::Result<()> {
    use std::process::{Command, Stdio};
    Command::new(binary)
        .no_window()
        .arg("start")
        .env(
            crate::cli::process::LOCK_WAIT_ENV,
            SUCCESSOR_LOCK_WAIT_SECS.to_string(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("start {}", binary.display()))?;
    Ok(())
}

struct Plan {
    target: PathBuf,
    base: String,
    interval: Duration,
}

fn background_plan(auto: Option<bool>, interval_minutes: Option<u64>) -> Result<Plan, String> {
    let disabled_by_env = std::env::var(DISABLE_ENV).is_ok_and(|v| {
        let v = v.trim();
        !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false")
    });
    if disabled_by_env {
        return Err(format!("{DISABLE_ENV} is set"));
    }
    if auto == Some(false) {
        return Err("[update] auto = false in daemon.toml".into());
    }
    let base = channel_base().ok_or("this build has no release channel")?;
    let target = managed_binary()?;
    let minutes = interval_minutes
        .unwrap_or(DEFAULT_CHECK_INTERVAL_MINUTES)
        .max(MIN_CHECK_INTERVAL_MINUTES);
    Ok(Plan {
        target,
        base,
        interval: Duration::from_secs(minutes * 60),
    })
}

/// Start the daemon's update tasks: confirming a fresh install stayed up, and —
/// when this daemon is a standalone install with a channel — the periodic check.
/// `is_busy` reports whether a turn is running; `request_shutdown` asks the
/// daemon to exit gracefully.
pub fn spawn_background<B, BF, S, SF>(
    auto: Option<bool>,
    check_interval_minutes: Option<u64>,
    is_busy: B,
    request_shutdown: S,
) where
    B: Fn() -> BF + Send + Sync + 'static,
    BF: Future<Output = bool> + Send + 'static,
    S: FnOnce() -> SF + Send + 'static,
    SF: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async {
        tokio::time::sleep(HEALTHY_AFTER).await;
        let _ = tokio::task::spawn_blocking(mark_boot_healthy).await;
    });
    match background_plan(auto, check_interval_minutes) {
        Ok(plan) => {
            info!(
                channel = %plan.base,
                interval_minutes = plan.interval.as_secs() / 60,
                "amuxd auto-update enabled"
            );
            tokio::spawn(run_background(plan, is_busy, request_shutdown));
        }
        Err(reason) => info!(%reason, "amuxd auto-update disabled"),
    }
}

async fn run_background<B, BF, S, SF>(plan: Plan, is_busy: B, request_shutdown: S)
where
    B: Fn() -> BF + Send + Sync + 'static,
    BF: Future<Output = bool> + Send + 'static,
    S: FnOnce() -> SF + Send + 'static,
    SF: Future<Output = ()> + Send + 'static,
{
    tokio::time::sleep(FIRST_CHECK_AFTER).await;
    let options = Options {
        force: false,
        respect_skip: true,
    };
    loop {
        match update_installed(&plan.target, &plan.base, options).await {
            Ok(Outcome::Installed { from, to }) => {
                info!(%from, %to, "amuxd update installed");
                restart_when_idle(&plan.target, &to, is_busy, request_shutdown).await;
                return;
            }
            Ok(Outcome::UpToDate { current, latest }) => {
                debug!(%current, %latest, "amuxd is up to date");
            }
            Ok(Outcome::Skipped { version }) => {
                debug!(%version, "skipping an amuxd version this machine rolled back");
            }
            Err(e) => warn!(error = %format!("{e:#}"), "amuxd update check failed"),
        }
        tokio::time::sleep(plan.interval).await;
    }
}

async fn restart_when_idle<B, BF, S, SF>(
    binary: &Path,
    version: &str,
    is_busy: B,
    request_shutdown: S,
) where
    B: Fn() -> BF + Send + Sync + 'static,
    BF: Future<Output = bool> + Send + 'static,
    S: FnOnce() -> SF + Send + 'static,
    SF: Future<Output = ()> + Send + 'static,
{
    let mode = restart_mode();
    if mode == RestartMode::Manual {
        warn!(
            %version,
            "amuxd {version} is installed, but this daemon was not started by a service manager; restart it to run the new version"
        );
        return;
    }
    let deadline = Instant::now() + RESTART_WAIT_CEILING;
    let mut idle_polls = 0;
    loop {
        if is_busy().await {
            idle_polls = 0;
        } else {
            idle_polls += 1;
        }
        if idle_polls >= IDLE_POLLS_REQUIRED {
            break;
        }
        if Instant::now() >= deadline {
            warn!(%version, "amuxd has not been idle for 24h; restarting into the update anyway");
            break;
        }
        tokio::time::sleep(IDLE_POLL).await;
    }
    if mode == RestartMode::SpawnSuccessor {
        if let Err(e) = spawn_successor(binary) {
            warn!(
                error = %format!("{e:#}"),
                "could not start the updated amuxd; it runs from the next start"
            );
            return;
        }
    }
    info!(%version, "restarting into the updated amuxd");
    request_shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_later_beta_or_the_release_itself_is_an_update() {
        assert!(is_newer("0.4.1-beta.56", "0.4.1-beta.55"));
        assert!(is_newer("0.4.1-beta.10", "0.4.1-beta.9"));
        assert!(is_newer("0.4.1", "0.4.1-beta.99"));
        assert!(is_newer("v0.4.2", "0.4.1"));
        assert!(!is_newer("0.4.1-beta.55", "0.4.1-beta.55"));
        assert!(!is_newer("0.4.0", "0.4.1-beta.1"));
        assert!(!is_newer("garbage", "0.4.1"));
    }

    #[test]
    fn the_manifest_publish_oss_release_writes_parses() {
        let manifest: Manifest = serde_json::from_str(
            r#"{
              "version": "0.4.1-beta.56",
              "pub_date": "2026-09-13T16:00:00+00:00",
              "platforms": {
                "linux-x86_64": {
                  "url": "https://cdn.example.com/beta/amuxd/0.4.1-beta.56/amuxd-linux-x86_64",
                  "sha256": "ab",
                  "size": 2
                }
              }
            }"#,
        )
        .unwrap();
        assert_eq!(manifest.version, "0.4.1-beta.56");
        assert_eq!(manifest.platforms["linux-x86_64"].size, 2);
    }

    #[test]
    fn a_binary_is_only_taken_from_the_manifest_origin() {
        let m = "https://cdn.example.com/beta/amuxd/latest.json";
        assert!(check_asset_url(m, "https://cdn.example.com/beta/amuxd/1/amuxd").is_ok());
        assert!(check_asset_url(m, "https://CDN.example.com/beta/amuxd/1/amuxd").is_ok());
        assert!(check_asset_url(m, "https://evil.example.com/amuxd").is_err());
        assert!(check_asset_url(m, "https://cdn.example.com.evil.com/amuxd").is_err());
        assert!(check_asset_url(m, "https://cdn.example.com@evil.com/amuxd").is_err());
        assert!(check_asset_url(m, "http://cdn.example.com/beta/amuxd/1/amuxd").is_err());

        let local = "http://127.0.0.1:8080/beta/amuxd/latest.json";
        assert!(check_asset_url(local, "http://127.0.0.1:8080/beta/amuxd/1/amuxd").is_ok());
        assert!(ensure_transport("http://localhost.evil.com/amuxd").is_err());
    }

    #[test]
    fn a_download_must_match_the_manifest_size_and_digest() {
        let bytes = b"amuxd";
        let good = Asset {
            url: "https://cdn.example.com/amuxd".into(),
            sha256: hex::encode(Sha256::digest(bytes)),
            size: 5,
        };
        assert!(verify(bytes, &good).is_ok());
        assert!(verify(b"amux", &good).is_err());
        let wrong_digest = Asset {
            sha256: "00".repeat(32),
            ..good.clone()
        };
        assert!(verify(bytes, &wrong_digest).is_err());
    }

    #[cfg(unix)]
    fn fake_binary(version: &str) -> Vec<u8> {
        format!("#!/bin/sh\necho \"amuxd {version}\"\n").into_bytes()
    }

    #[cfg(unix)]
    #[test]
    fn an_install_swaps_the_binary_and_keeps_the_previous_one() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("amuxd");
        write_executable(&target, &fake_binary("0.1.0")).unwrap();

        install(&target, &fake_binary("9.9.9"), "9.9.9").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), fake_binary("9.9.9"));
        assert_eq!(
            std::fs::read(backup_path(&target)).unwrap(),
            fake_binary("0.1.0")
        );
        assert!(!sibling(&target, "new").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_binary_that_runs_as_another_version_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("amuxd");
        write_executable(&target, &fake_binary("0.1.0")).unwrap();

        assert!(install(&target, &fake_binary("9.9.8"), "9.9.9").is_err());

        assert_eq!(std::fs::read(&target).unwrap(), fake_binary("0.1.0"));
        assert!(!backup_path(&target).exists());
        assert!(!sibling(&target, "new").exists());
    }

    fn record_install(dir: &Path, to: &str, boot_attempts: u32) {
        let state = UpdateState {
            pending: Some(PendingBoot {
                from_version: "0.1.0".into(),
                to_version: to.into(),
                boot_attempts,
            }),
            skip_version: None,
        };
        save_state(dir, &state).unwrap();
    }

    #[test]
    fn a_version_that_never_stays_up_is_rolled_back_and_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("amuxd");
        std::fs::write(&target, "new").unwrap();
        std::fs::write(backup_path(&target), "old").unwrap();
        record_install(dir.path(), "9.9.9", 0);

        for _ in 0..MAX_BOOT_ATTEMPTS {
            assert!(matches!(boot_check(&target, "9.9.9"), BootCheck::Continue));
        }
        match boot_check(&target, "9.9.9") {
            BootCheck::RolledBack {
                failed, restored, ..
            } => {
                assert_eq!(failed, "9.9.9");
                assert_eq!(restored, "0.1.0");
            }
            BootCheck::Continue => panic!("expected a rollback"),
        }
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old");
        assert_eq!(
            load_state(dir.path()).skip_version.as_deref(),
            Some("9.9.9")
        );

        // The restored version boots without touching the skip.
        assert!(matches!(boot_check(&target, "0.1.0"), BootCheck::Continue));
        let state = load_state(dir.path());
        assert_eq!(state.pending, None);
        assert_eq!(state.skip_version.as_deref(), Some("9.9.9"));
    }

    #[test]
    fn a_version_that_stays_up_clears_its_record() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("amuxd");
        std::fs::write(&target, "new").unwrap();
        record_install(dir.path(), "9.9.9", 0);

        assert!(matches!(boot_check(&target, "9.9.9"), BootCheck::Continue));
        assert_eq!(
            load_state(dir.path()).pending.map(|p| p.boot_attempts),
            Some(1)
        );
        clear_pending_for(dir.path(), "9.9.9");
        assert!(!dir.path().join(STATE_FILE).exists());
    }

    #[test]
    fn another_version_booting_drops_a_stale_record() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("amuxd");
        std::fs::write(&target, "hand-installed").unwrap();
        record_install(dir.path(), "9.9.9", 1);

        assert!(matches!(boot_check(&target, "0.2.0"), BootCheck::Continue));
        assert_eq!(load_state(dir.path()), UpdateState::default());
    }
}
