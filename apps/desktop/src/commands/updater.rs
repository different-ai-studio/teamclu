use base64::{engine::general_purpose::STANDARD, Engine};
#[cfg(target_os = "macos")]
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::io::Cursor;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Runtime};

const DEFAULT_REPO_OWNER: &str = "different-ai-studio";
const DEFAULT_REPO_NAME: &str = "teamclu";
const DEFAULT_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDFEMDg3REY5MEI2RDAyMzMKUldRekFtMEwrWDBJSFhTdHYvbStkclEvTEVRNFlpZExxSHNTSTA2V2ZHS0xPUEZ4WnF5d2RxQ0gK";
const APP_USER_AGENT: &str = concat!("teamclu-updater/", env!("CARGO_PKG_VERSION"));

fn has_custom_endpoints() -> bool {
    custom_endpoint_list().next().is_some()
}

fn custom_endpoint_list() -> impl Iterator<Item = &'static str> {
    option_env!("UPDATER_ENDPOINTS")
        .into_iter()
        .flat_map(|raw| raw.split(','))
        .map(str::trim)
        .filter(|endpoint| !endpoint.is_empty())
}

fn get_updater_pubkey() -> &'static str {
    option_env!("UPDATER_PUBKEY").unwrap_or(DEFAULT_PUBKEY)
}

// ---------- Types ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
    pub download_url: String,
    pub signature: String,
}

/// Progress events emitted during download
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub content_length: Option<u64>,
}

// GitHub API response types
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct GhRelease {
    tag_name: String,
    body: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    url: String, // api.github.com asset URL
}

/// Tauri updater static JSON format (latest.json)
#[derive(Debug, Deserialize)]
struct UpdateManifest {
    version: String,
    notes: Option<String>,
    platforms: HashMap<String, PlatformEntry>,
}

#[derive(Debug, Deserialize)]
struct PlatformEntry {
    signature: String,
    url: String,
}

// ---------- Helpers ----------

fn get_token() -> Option<&'static str> {
    option_env!("UPDATER_GITHUB_TOKEN")
}

fn build_headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
    );
    headers.insert(USER_AGENT, HeaderValue::from_static(APP_USER_AGENT));
    headers
}

fn current_target() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        #[cfg(target_arch = "aarch64")]
        return "darwin-aarch64";
        #[cfg(target_arch = "x86_64")]
        return "darwin-x86_64";
    }
    #[cfg(target_os = "linux")]
    {
        #[cfg(target_arch = "x86_64")]
        return "linux-x86_64";
        #[cfg(target_arch = "aarch64")]
        return "linux-aarch64";
    }
    #[cfg(target_os = "windows")]
    {
        #[cfg(target_arch = "x86_64")]
        return "windows-x86_64";
        #[cfg(target_arch = "aarch64")]
        return "windows-aarch64";
    }
}

/// Fetch manifests from every configured endpoint and return the newest version.
async fn fetch_newest_manifest_from_endpoints(
    client: &reqwest::Client,
    endpoints: impl IntoIterator<Item = &'static str>,
) -> Result<UpdateManifest, String> {
    let mut best: Option<UpdateManifest> = None;
    let mut last_err = String::new();

    for endpoint in endpoints {
        match fetch_manifest_from_endpoint(client, endpoint).await {
            Ok(manifest) => {
                let remote_version = match Version::parse(&manifest.version) {
                    Ok(version) => version,
                    Err(e) => {
                        last_err = format!(
                            "Invalid remote version '{}' from {}: {}",
                            manifest.version, endpoint, e
                        );
                        continue;
                    }
                };

                let replace = match &best {
                    None => true,
                    Some(current) => Version::parse(&current.version)
                        .map(|current_version| remote_version > current_version)
                        .unwrap_or(true),
                };

                if replace {
                    best = Some(manifest);
                }
            }
            Err(e) => {
                log::warn!("Updater endpoint {} failed: {}", endpoint, e);
                last_err = e;
            }
        }
    }

    best.ok_or_else(|| {
        if last_err.is_empty() {
            "No updater endpoints configured".to_string()
        } else {
            format!("All updater endpoints failed; last error: {}", last_err)
        }
    })
}

/// Fetch update manifest directly from configured endpoint
async fn fetch_manifest_from_endpoint(
    client: &reqwest::Client,
    endpoint: &str,
) -> Result<UpdateManifest, String> {
    let resp = client
        .get(endpoint)
        .header(USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch update manifest: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Update endpoint returned status {}: {}",
            resp.status(),
            endpoint
        ));
    }

    resp.json::<UpdateManifest>()
        .await
        .map_err(|e| format!("Failed to parse update manifest: {}", e))
}

/// Fetch the latest GitHub release metadata via the API.
async fn fetch_latest_release(client: &reqwest::Client, token: &str) -> Result<GhRelease, String> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        DEFAULT_REPO_OWNER, DEFAULT_REPO_NAME
    );
    let resp = client
        .get(&url)
        .headers(build_headers(token))
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "GitHub API returned status {} when fetching latest release",
            resp.status()
        ));
    }

    resp.json::<GhRelease>()
        .await
        .map_err(|e| format!("Failed to parse release JSON: {}", e))
}

/// Download a release asset by its API URL, returning raw bytes.
async fn download_asset(
    client: &reqwest::Client,
    token: &str,
    api_url: &str,
) -> Result<Vec<u8>, String> {
    let mut headers = build_headers(token);
    headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));

    let resp = client
        .get(api_url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Failed to download asset: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Asset download returned status {}", resp.status()));
    }

    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Failed to read asset bytes: {}", e))
}

/// Download a release asset with progress events emitted to the frontend.
/// Retries up to MAX_DOWNLOAD_RETRIES times with exponential backoff on network errors.
async fn download_asset_with_progress<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    token: &str,
    api_url: &str,
) -> Result<Vec<u8>, String> {
    let mut last_err = String::new();

    for attempt in 0..=MAX_DOWNLOAD_RETRIES {
        if attempt > 0 {
            let delay = RETRY_BASE_DELAY_MS * 2u64.pow(attempt - 1);
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            let _ = app.emit(
                "update-download-progress",
                DownloadProgress {
                    downloaded: 0,
                    content_length: None,
                },
            );
        }

        match try_download_asset(app, client, token, api_url).await {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                last_err = e;
                if attempt < MAX_DOWNLOAD_RETRIES {
                    log::warn!(
                        "Asset download attempt {}/{} failed: {}. Retrying...",
                        attempt + 1,
                        MAX_DOWNLOAD_RETRIES + 1,
                        last_err
                    );
                }
            }
        }
    }

    Err(format!(
        "Download failed after {} attempts: {}",
        MAX_DOWNLOAD_RETRIES + 1,
        last_err
    ))
}

/// Single asset download attempt with progress events.
async fn try_download_asset<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    token: &str,
    api_url: &str,
) -> Result<Vec<u8>, String> {
    let mut headers = build_headers(token);
    headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));

    let resp = client
        .get(api_url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Failed to download asset: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Asset download returned status {}", resp.status()));
    }

    let content_length = resp.content_length();
    let mut downloaded: u64 = 0;
    let mut buffer = Vec::new();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        downloaded += chunk.len() as u64;
        buffer.extend_from_slice(&chunk);

        if downloaded % (100 * 1024) < chunk.len() as u64
            || content_length.map_or(false, |cl| downloaded >= cl)
        {
            let _ = app.emit(
                "update-download-progress",
                DownloadProgress {
                    downloaded,
                    content_length,
                },
            );
        }
    }

    let _ = app.emit(
        "update-download-progress",
        DownloadProgress {
            downloaded,
            content_length,
        },
    );

    Ok(buffer)
}

/// Normalize signature string so minisign_verify can parse it.
/// Handles: CRLF/CR line endings; signature stored as single-line base64 (decode to get 4-line .sig content).
fn normalize_signature(s: &str) -> String {
    let trimmed = s.trim();
    // If it looks like a single line of base64 (no newline, alphanumeric+/=), decode to get .sig text
    if !trimmed.contains('\n') && trimmed.len() > 100 {
        if let Ok(decoded) = STANDARD.decode(trimmed) {
            if let Ok(text) = String::from_utf8(decoded) {
                if text.contains("untrusted comment:") && text.contains("trusted comment:") {
                    return text;
                }
            }
        }
    }
    // Normalize line endings so minisign_verify's .lines() and base64 decode don't see \r
    trimmed
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .to_string()
}

fn verify_signature(data: &[u8], release_signature: &str, pub_key_str: &str) -> Result<(), String> {
    // Decode base64-encoded minisign public key format
    let decoded_key = STANDARD
        .decode(pub_key_str)
        .map_err(|e| format!("Failed to decode base64 public key: {}", e))?;
    let key_string = String::from_utf8(decoded_key)
        .map_err(|e| format!("Invalid UTF-8 in decoded public key: {}", e))?;

    let pub_key =
        PublicKey::decode(&key_string).map_err(|e| format!("Invalid public key: {}", e))?;
    let normalized = normalize_signature(release_signature);
    let signature =
        Signature::decode(&normalized).map_err(|e| format!("Invalid signature: {}", e))?;
    pub_key
        .verify(data, &signature, false)
        .map_err(|e| format!("Signature verification failed: {}", e))
}

/// Extract the .app bundle path from the current executable.
/// e.g. /Applications/TeamClu.app/Contents/MacOS/TeamClu -> /Applications/TeamClu.app
#[cfg(target_os = "macos")]
fn get_app_bundle_path() -> Result<PathBuf, String> {
    let exe = tauri::utils::platform::current_exe()
        .map_err(|e| format!("Cannot get current exe: {}", e))?;
    // exe:        .../TeamClu.app/Contents/MacOS/TeamClu
    // parent 1:   .../TeamClu.app/Contents/MacOS
    // parent 2:   .../TeamClu.app/Contents
    // parent 3:   .../TeamClu.app
    exe.parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Cannot determine .app bundle path from executable".to_string())
}

/// The `.app` bundle path captured before any update replaces it on disk.
#[cfg(target_os = "macos")]
static STARTING_BUNDLE_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Record the running `.app` bundle path at startup.
///
/// `install_update` renames the live bundle away and moves a fresh one into its
/// place, so anything resolved *after* an install can point at a bundle that no
/// longer exists. Restart must relaunch the path captured here.
pub fn remember_app_bundle_path() {
    #[cfg(target_os = "macos")]
    match get_app_bundle_path() {
        Ok(path) => {
            let _ = STARTING_BUNDLE_PATH.set(path);
        }
        Err(e) => log::warn!("[updater] cannot resolve .app bundle path at startup: {e}"),
    }
}

/// Returns true when `path` looks like a macOS application bundle directory.
#[cfg(target_os = "macos")]
fn is_app_bundle(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "app")
        && path.is_dir()
        && path.join("Contents/MacOS").is_dir()
}

/// Find a `.app` bundle under `root`, searching up to `max_depth` levels deep.
#[cfg(target_os = "macos")]
fn find_app_bundle(root: &Path, max_depth: u32) -> Option<PathBuf> {
    if max_depth == 0 {
        return None;
    }

    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if is_app_bundle(&path) {
            return Some(path);
        }
        if path.is_dir() && max_depth > 1 {
            if let Some(found) = find_app_bundle(&path, max_depth - 1) {
                return Some(found);
            }
        }
    }

    None
}

/// Extract updater tar.gz bytes into `dest`.
#[cfg(target_os = "macos")]
fn extract_updater_archive(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let archive = Cursor::new(bytes);
    let decoder = GzDecoder::new(archive);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(dest)
        .map_err(|e| format!("Failed to extract archive: {}", e))
}

/// Install the update by extracting the tar.gz and replacing the .app bundle (macOS).
#[cfg(target_os = "macos")]
fn install_update(bytes: &[u8], _signature: &str) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Auto-update installation is disabled in development builds".to_string());
    }

    let app_path = get_app_bundle_path()?;
    let parent_dir = app_path
        .parent()
        .ok_or_else(|| "Cannot determine parent dir of .app bundle".to_string())?;

    // Create a temp dir on the same volume for atomic move
    let tmp_dir = tempfile::Builder::new()
        .prefix("teamclu-updater-")
        .tempdir_in(parent_dir)
        .map_err(|e| format!("Cannot create temp dir: {}", e))?;

    // Backup current app
    let backup_path = tmp_dir.path().join("backup.app");
    std::fs::rename(&app_path, &backup_path)
        .map_err(|e| format!("Cannot backup current app: {}", e))?;

    let staging_dir = tmp_dir.path().join("staging");
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Cannot create staging dir: {}", e))?;

    let result = (|| -> Result<(), String> {
        extract_updater_archive(bytes, &staging_dir)?;

        let extracted_app = find_app_bundle(&staging_dir, 2).ok_or_else(|| {
            format!(
                "Extracted archive does not contain a .app bundle (expected {})",
                app_path.display()
            )
        })?;

        if extracted_app != app_path {
            if app_path.exists() {
                std::fs::remove_dir_all(&app_path)
                    .map_err(|e| format!("Cannot remove existing app bundle: {}", e))?;
            }
            std::fs::rename(&extracted_app, &app_path).map_err(|e| {
                format!(
                    "Cannot move extracted {} to {}: {}",
                    extracted_app.display(),
                    app_path.display(),
                    e
                )
            })?;
        }

        Ok(())
    })();

    match result {
        Ok(()) => {
            // Clean up backup
            let _ = std::fs::remove_dir_all(&backup_path);
            Ok(())
        }
        Err(e) => {
            // Restore from backup
            if backup_path.exists() {
                let _ = std::fs::remove_dir_all(&app_path);
                let _ = std::fs::rename(&backup_path, &app_path);
            }
            Err(format!("Installation failed (restored backup): {}", e))
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod install_tests {
    use super::*;
    use std::fs;

    fn write_fake_app_bundle(root: &Path, name: &str) -> PathBuf {
        let app_path = root.join(name);
        fs::create_dir_all(app_path.join("Contents/MacOS")).unwrap();
        fs::write(app_path.join("Contents/MacOS/app"), b"bin").unwrap();
        app_path
    }

    #[test]
    fn find_app_bundle_detects_nested_bundle() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("release");
        fs::create_dir_all(&nested).unwrap();
        let app = write_fake_app_bundle(&nested, "TeamClu.app");
        assert_eq!(find_app_bundle(tmp.path(), 2), Some(app));
    }

    #[test]
    fn find_app_bundle_ignores_non_app_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("payload")).unwrap();
        assert!(find_app_bundle(tmp.path(), 2).is_none());
    }
}

/// Where the downloaded Windows installer waits between "install" and "restart".
///
/// macOS replaces the bundle in place while the app runs, so its install step
/// really installs. An NSIS installer cannot patch an install that is still
/// running, so on Windows "install" can only mean *stage*: write the verified
/// installer out and leave it for [`relaunch_and_exit`] to run on the way out.
/// The app's two-step UI — install, then "Restart to apply" — already has the
/// shape that needs, so the split costs the user nothing.
///
/// The consequence worth knowing: on Windows, quitting instead of restarting
/// drops the update on the floor and the next launch offers it again. On macOS
/// the bytes are already on disk by then.
#[cfg(target_os = "windows")]
static STAGED_INSTALLER: std::sync::Mutex<Option<StagedInstaller>> = std::sync::Mutex::new(None);

/// A staged installer and the signature it was accepted under.
///
/// The signature is kept because staging and launching are separated by however
/// long the user takes to click Restart, and what is launched runs elevated.
#[cfg(target_os = "windows")]
#[derive(Clone)]
struct StagedInstaller {
    path: PathBuf,
    signature: String,
}

/// A fresh, randomly-named staging directory per download.
///
/// The first version used one fixed path, reasoning that overwriting it could
/// not grow without bound. That is true and beside the point: a predictable,
/// user-writable path holding something we later hand to `ShellExecuteW` — which
/// raises a UAC prompt naming *our* installer — is a swap window for any code
/// already running as the user. Randomizing removes the prediction, and
/// `create_new` refuses a directory (or junction) somebody pre-created.
/// tauri-plugin-updater randomizes for the same reason.
///
/// Old staging directories are swept on the way in, so nothing accumulates.
#[cfg(target_os = "windows")]
fn new_staging_dir() -> Result<PathBuf, String> {
    const PREFIX: &str = "teamclu-update-";
    let temp = std::env::temp_dir();

    // Best-effort sweep of previous runs. A directory still in use by another
    // instance fails to remove and is left alone, which is the safe outcome.
    if let Ok(entries) = std::fs::read_dir(&temp) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(PREFIX) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    let dir = temp.join(format!("{PREFIX}{}", nanoid::nanoid!(16)));
    std::fs::create_dir(&dir).map_err(|e| format!("Cannot create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Write the verified installer where [`run_windows_installer`] can find it.
///
/// Deliberately not a `NamedTempFile`: the file has to outlive this process —
/// the installer runs while the app is exiting, and a temp handle dropped at
/// exit would delete the .exe out from under it.
#[cfg(target_os = "windows")]
fn stage_windows_installer(bytes: &[u8]) -> Result<PathBuf, String> {
    // The signature already proved these bytes are ours; this only catches a
    // manifest pointing at the wrong *kind* of artifact (a .msi, a zip), which
    // would otherwise fail much later as an unhelpful shell error.
    if !bytes.starts_with(b"MZ") {
        return Err("Downloaded update is not a Windows installer executable".to_string());
    }
    let path = new_staging_dir()?.join("update-setup.exe");
    std::fs::write(&path, bytes).map_err(|e| format!("Cannot write {}: {}", path.display(), e))?;
    Ok(path)
}

/// Stage the update. See [`STAGED_INSTALLER`] for why this does not install.
#[cfg(target_os = "windows")]
fn install_update(bytes: &[u8], signature: &str) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Auto-update installation is disabled in development builds".to_string());
    }

    let path = stage_windows_installer(bytes)?;
    log::info!("[updater] staged installer at {}", path.display());
    *STAGED_INSTALLER.lock().unwrap_or_else(|e| e.into_inner()) = Some(StagedInstaller {
        path,
        signature: signature.to_string(),
    });
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn install_update(_bytes: &[u8], _signature: &str) -> Result<(), String> {
    Err("Auto-update installation is not supported on this platform yet".to_string())
}

/// Hand the staged NSIS installer to the shell so it can replace this install.
///
/// `ShellExecuteW`, not `Command::spawn`: a per-machine install lives under
/// Program Files and its installer asks for elevation in its manifest.
/// `CreateProcess` — what `Command` uses — refuses that outright with
/// ERROR_ELEVATION_REQUIRED instead of showing the UAC prompt. The shell's
/// "open" verb is what raises it. This is the same call tauri-plugin-updater
/// makes, and the flags are its `Passive` mode:
///
/// - `/P` — progress window, nothing to click
/// - `/R` — relaunch the app once the install finishes
/// - `/UPDATE` — tells the Tauri NSIS template this replaces an existing
///   install (it closes the running app itself) rather than being a first run
#[cfg(target_os = "windows")]
fn run_windows_installer(path: &Path) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOW;

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let verb = wide(OsStr::new("open"));
    let file = wide(path.as_os_str());
    let parameters = wide(OsStr::new("/P /R /UPDATE"));

    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            parameters.as_ptr(),
            std::ptr::null(),
            SW_SHOW,
        )
    };
    // ShellExecuteW returns a fake HINSTANCE; anything <= 32 is an error code,
    // and 1223 (ERROR_CANCELLED) specifically means the user declined UAC.
    let code = result as isize;
    if code <= 32 {
        return Err(format!(
            "Failed to launch the update installer (ShellExecute returned {code})"
        ));
    }
    Ok(())
}

/// Maximum number of download retry attempts
const MAX_DOWNLOAD_RETRIES: u32 = 3;
/// Base delay between retries in milliseconds (doubles each attempt)
const RETRY_BASE_DELAY_MS: u64 = 2000;

/// Download file with progress events (for custom endpoint mode).
/// Retries up to MAX_DOWNLOAD_RETRIES times with exponential backoff on network errors.
async fn download_file_with_progress<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<u8>, String> {
    let mut last_err = String::new();

    for attempt in 0..=MAX_DOWNLOAD_RETRIES {
        if attempt > 0 {
            let delay = RETRY_BASE_DELAY_MS * 2u64.pow(attempt - 1);
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            // Reset progress so the UI shows the retry starting fresh
            let _ = app.emit(
                "update-download-progress",
                DownloadProgress {
                    downloaded: 0,
                    content_length: None,
                },
            );
        }

        match try_download_file(app, client, url).await {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                last_err = e;
                if attempt < MAX_DOWNLOAD_RETRIES {
                    log::warn!(
                        "Download attempt {}/{} failed: {}. Retrying...",
                        attempt + 1,
                        MAX_DOWNLOAD_RETRIES + 1,
                        last_err
                    );
                }
            }
        }
    }

    Err(format!(
        "Download failed after {} attempts: {}",
        MAX_DOWNLOAD_RETRIES + 1,
        last_err
    ))
}

/// Single download attempt with progress events.
async fn try_download_file<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .header(USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Failed to download file: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Download returned status {}", resp.status()));
    }

    let content_length = resp.content_length();
    let mut downloaded: u64 = 0;
    let mut buffer = Vec::new();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        downloaded += chunk.len() as u64;
        buffer.extend_from_slice(&chunk);

        if downloaded % (100 * 1024) < chunk.len() as u64
            || content_length.map_or(false, |cl| downloaded >= cl)
        {
            let _ = app.emit(
                "update-download-progress",
                DownloadProgress {
                    downloaded,
                    content_length,
                },
            );
        }
    }

    let _ = app.emit(
        "update-download-progress",
        DownloadProgress {
            downloaded,
            content_length,
        },
    );

    Ok(buffer)
}

// ---------- Tauri Commands ----------

#[tauri::command]
pub async fn check_update<R: Runtime>(app: AppHandle<R>) -> Result<Option<UpdateInfo>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }

    let client = reqwest::Client::builder()
        .user_agent(APP_USER_AGENT)
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Cannot create HTTP client: {}", e))?;

    let current_version = app.package_info().version.clone();
    let target = current_target();

    // Check if custom endpoints are configured (from build.config.json)
    let manifest = if has_custom_endpoints() {
        // Mode 1: Fetch from configured endpoints; pick the newest manifest.
        fetch_newest_manifest_from_endpoints(&client, custom_endpoint_list()).await?
    } else {
        // Mode 2: Fetch from GitHub API (fallback)
        let token = match get_token() {
            Some(t) if !t.is_empty() => t,
            _ => {
                return Err(
                    "Updater token not configured (GitHub mode requires UPDATER_GITHUB_TOKEN)"
                        .to_string(),
                )
            }
        };

        let release = fetch_latest_release(&client, token).await?;
        let manifest_asset = release
            .assets
            .iter()
            .find(|a| a.name == "latest.json")
            .ok_or_else(|| "No latest.json asset found in the latest release".to_string())?;

        let manifest_bytes = download_asset(&client, token, &manifest_asset.url).await?;
        serde_json::from_slice(&manifest_bytes)
            .map_err(|e| format!("Failed to parse latest.json: {}", e))?
    };

    // Compare versions
    let remote_version = Version::parse(&manifest.version)
        .map_err(|e| format!("Invalid remote version '{}': {}", manifest.version, e))?;

    if remote_version <= current_version {
        return Ok(None); // up to date
    }

    // Find the platform entry
    let platform = manifest
        .platforms
        .get(target)
        .ok_or_else(|| format!("No update available for platform '{}'", target))?;

    // For custom endpoint mode, use the URL directly from manifest
    // For GitHub mode, we need to map to API asset URL
    let download_url = if has_custom_endpoints() {
        // Custom endpoint: use URL as-is (should be direct download URL)
        platform.url.clone()
    } else {
        // GitHub mode: map web URL to API asset URL
        let token = get_token().unwrap();
        let release = fetch_latest_release(&client, token).await?;
        let binary_filename = platform
            .url
            .rsplit('/')
            .next()
            .ok_or_else(|| "Cannot extract filename from download URL".to_string())?;

        let binary_asset = release
            .assets
            .iter()
            .find(|a| a.name == binary_filename)
            .ok_or_else(|| {
                format!(
                    "Binary asset '{}' not found in release assets",
                    binary_filename
                )
            })?;
        binary_asset.url.clone()
    };

    Ok(Some(UpdateInfo {
        version: manifest.version,
        notes: manifest.notes.unwrap_or_default(),
        download_url,
        signature: platform.signature.clone(),
    }))
}

#[tauri::command]
pub async fn download_and_install_update<R: Runtime>(
    app: AppHandle<R>,
    download_url: String,
    signature: String,
) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Auto-update installation is disabled in development builds".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent(APP_USER_AGENT)
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Cannot create HTTP client: {}", e))?;

    // 1. Download the binary with progress reporting
    let bytes = if has_custom_endpoints() {
        // Custom endpoint mode: direct HTTP download
        download_file_with_progress(&app, &client, &download_url).await?
    } else {
        // GitHub mode: use GitHub API with token
        let token = match get_token() {
            Some(t) if !t.is_empty() => t,
            _ => return Err("Updater token not configured (GitHub mode)".to_string()),
        };
        download_asset_with_progress(&app, &client, token, &download_url).await?
    };

    // 2. Verify signature
    let pubkey = get_updater_pubkey();
    verify_signature(&bytes, &signature, pubkey)?;

    // 3. Install (extract tar.gz and replace .app bundle)
    install_update(&bytes, &signature)?;

    Ok(())
}

/// Quit and relaunch the app so an installed update takes effect.
///
/// This deliberately does not use `tauri_plugin_process::relaunch`. That path
/// re-execs the binary from inside the dying process and skips LaunchServices,
/// which after an in-place bundle replacement can leave no visible app at all
/// — the window disappears (or never goes away) and nothing comes back.
/// Instead we hand the relaunch to `open(1)` in a detached shell that outlives
/// this process, then exit through the normal Tauri path so `RunEvent::Exit`
/// still stops amuxd and the terminal registry.
#[tauri::command]
pub async fn restart_app<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    relaunch_and_exit(app)
}

#[cfg(target_os = "macos")]
fn relaunch_and_exit<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let bundle = STARTING_BUNDLE_PATH
        .get()
        .cloned()
        .or_else(|| get_app_bundle_path().ok())
        .ok_or_else(|| "Cannot determine .app bundle path to relaunch".to_string())?;

    if !bundle.exists() {
        return Err(format!(
            "App bundle {} no longer exists; cannot relaunch",
            bundle.display()
        ));
    }

    // `sleep 1` gives this process time to tear down amuxd before the new
    // instance starts supervising its own daemon. `-n` forces a new instance
    // instead of reactivating the one that is on its way out.
    let script = format!(
        "sleep 1; exec /usr/bin/open -n {}",
        shell_quote(&bundle.to_string_lossy())
    );
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(&script)
        .spawn()
        .map_err(|e| format!("Failed to schedule relaunch: {e}"))?;

    log::info!("[updater] relaunch scheduled for {}", bundle.display());
    app.exit(0);
    Ok(())
}

/// Windows applies the update here rather than in `install_update`: the NSIS
/// installer replaces a *stopped* install, so it can only run as the app leaves.
///
/// With nothing staged this is a plain restart — the same thing every other
/// non-macOS platform does.
#[cfg(target_os = "windows")]
fn relaunch_and_exit<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    // `try_state` lives on the `Manager` trait. Imported inside the function so
    // the other platforms do not carry an unused import — and missing it is why
    // this file first failed to compile for Windows: nothing on a macOS dev
    // machine or in PR CI built this block until the `desktop-windows` job
    // landed in this same branch.
    use tauri::Manager;

    // Read, don't take: a launch that fails (a declined UAC prompt) must leave
    // the staged installer where it is. Taking it up front turned the second
    // click of "Restart Now" into a plain restart that silently skipped the
    // update the user had already downloaded.
    let staged: Option<StagedInstaller> = STAGED_INSTALLER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(staged) = staged else {
        app.request_restart();
        return Ok(());
    };
    let path = staged.path.clone();

    // Re-verify the bytes on disk, not the bytes we downloaded. Everything
    // between staging and here is somebody else's opportunity: this file is
    // about to be launched through `ShellExecuteW`, which raises a UAC prompt
    // in our name, so "we verified it earlier" is not the same claim as "this
    // is what we verified".
    let on_disk = std::fs::read(&path).map_err(|e| {
        format!(
            "The staged installer {} could not be read ({e}); download the update again",
            path.display()
        )
    })?;
    verify_signature(&on_disk, &staged.signature, get_updater_pubkey()).map_err(|e| {
        // Do not launch, and do not keep it around to be launched later.
        let _ = std::fs::remove_dir_all(path.parent().unwrap_or(&path));
        *STAGED_INSTALLER.lock().unwrap_or_else(|e| e.into_inner()) = None;
        format!(
            "The staged installer no longer matches its signature ({e}); download the update again"
        )
    })?;

    // Launch before stopping amuxd, not after: ShellExecuteW reports failure
    // synchronously (a declined UAC prompt, most likely), and on that path the
    // app has to stay usable — killing its daemon first would leave it running
    // against nothing.
    run_windows_installer(&path)?;
    log::info!("[updater] launched {}", path.display());
    *STAGED_INSTALLER.lock().unwrap_or_else(|e| e.into_inner()) = None;

    // Then stop amuxd, before the installer gets as far as copying files.
    // Windows will not overwrite a running binary, and `amuxd.exe` sits in the
    // very directory being replaced — the NSIS template closes the app it knows
    // about, not our sidecar. `RunEvent::Exit` would do this too, but only
    // after the installer is already under way; the supervisor's shutdown is
    // once-only, so doing it here just moves it earlier.
    if let Some(supervisor) = app.try_state::<crate::commands::amuxd_supervisor::AmuxdSupervisor>()
    {
        supervisor.shutdown_blocking();
    }

    // `/R` brings the app back once the install finishes, so this exit is the
    // end of our part. Exit through Tauri rather than `process::exit` so the
    // terminal registry and the rest of `RunEvent::Exit` still run.
    app.exit(0);
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn relaunch_and_exit<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.request_restart();
    Ok(())
}

/// Single-quote a path for `/bin/sh -c`.
#[cfg(target_os = "macos")]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(all(test, target_os = "macos"))]
mod shell_quote_tests {
    use super::shell_quote;

    #[test]
    fn quotes_plain_path() {
        assert_eq!(
            shell_quote("/Applications/TeamClu.app"),
            "'/Applications/TeamClu.app'"
        );
    }

    #[test]
    fn quotes_path_with_spaces_and_quote() {
        assert_eq!(
            shell_quote("/My Apps/Team's.app"),
            r"'/My Apps/Team'\''s.app'"
        );
    }
}
