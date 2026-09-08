//! Prebuilt runtime bundle: Node + pi + the MCP SDK as one archive (#1250).
//!
//! On Windows the slow part of a first run is not the download, it is npm
//! writing thousands of small files while Defender scans each one, plus the
//! temp-then-rename double write npm does per package. A bundle built by
//! `.github/workflows/mirror-pi-bundle-oss.yml` — the exact `<cache>/node/<v>`
//! and `<cache>/pi` trees `npm ci` would produce — turns that into one
//! download and one extraction, with no npm and no second network round trip.
//!
//! Layout on OSS (`BUNDLE_BASE`):
//!
//! ```text
//! <base>/<platform>/latest.json
//!     {"piVersion","nodeVersion","mcpSdkVersion","asset","sha256"}
//! <base>/<platform>/<piVersion>-<nodeVersion>/<asset>      immutable
//! ```
//!
//! Inside the archive:
//!
//! ```text
//! node/<nodeVersion>/…      ← the unpacked official Node distribution
//! pi/package.json  pi/package-lock.json  pi/node_modules/…
//! ```
//!
//! The manifest's three versions must equal this build's locks, or the bundle
//! is ignored: a bundle is a shortcut to the same result, never a different
//! result. Only Windows bundles are published today, so other platforms skip
//! straight to `npm ci`; the code is platform-neutral so publishing more later
//! needs no daemon change.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::{download_bytes, progress, progress_route, sha256_hex, NETWORK_PROBE_TIMEOUT};

const BUNDLE_BASE: &str = "https://teamclaw.ucar.cc/pi-bundle";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BundleManifest {
    pub pi_version: String,
    pub node_version: String,
    #[serde(default)]
    pub mcp_sdk_version: String,
    pub asset: String,
    pub sha256: String,
}

/// The OSS platform key for this binary. `None` where no bundle is published.
pub(crate) fn platform(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("win-x64"),
        ("windows", "aarch64") => Some("win-arm64"),
        _ => None,
    }
}

fn manifest_url(platform: &str) -> String {
    format!(
        "{}/{platform}/latest.json",
        BUNDLE_BASE.trim_end_matches('/')
    )
}

fn asset_url(platform: &str, manifest: &BundleManifest) -> String {
    format!(
        "{}/{platform}/{}-{}/{}",
        BUNDLE_BASE.trim_end_matches('/'),
        manifest.pi_version.trim_start_matches('v'),
        manifest.node_version.trim_start_matches('v'),
        manifest.asset
    )
}

/// Does the manifest describe exactly the runtime this build wants?
pub(crate) fn matches_locks(
    manifest: &BundleManifest,
    pi: &str,
    node: &str,
    mcp_sdk: &str,
) -> bool {
    let strip = |v: &str| v.trim().trim_start_matches('v').to_string();
    strip(&manifest.pi_version) == pi
        && strip(&manifest.node_version) == node
        && (mcp_sdk.is_empty() || strip(&manifest.mcp_sdk_version) == mcp_sdk)
        && manifest.asset.ends_with(".zip")
        && !manifest.asset.contains('/')
        && !manifest.asset.contains('\\')
        && manifest.sha256.len() == 64
}

fn fetch_manifest(platform: &str) -> Option<BundleManifest> {
    let url = manifest_url(platform);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?
        .block_on(async {
            reqwest::Client::builder()
                .timeout(NETWORK_PROBE_TIMEOUT)
                .build()
                .ok()?
                .get(url)
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?
                .json::<BundleManifest>()
                .await
                .ok()
        })
}

/// Unpack the bundle's `node/<v>` and `pi/` trees into a staging directory,
/// refusing anything that would land outside it.
fn unpack_to(bytes: &[u8], staging: &Path) -> anyhow::Result<()> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        let Some(rel) = file.enclosed_name() else {
            continue;
        };
        let first = rel
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .unwrap_or_default();
        if first != "node" && first != "pi" {
            continue;
        }
        let out = staging.join(&rel);
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

/// Move `from` to `to`, replacing whatever is there. A rename, so a live host
/// holding files under the old tree keeps them (deleting is what fails).
fn replace_dir(from: &Path, to: &Path) -> anyhow::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if to.exists() {
        let old = to.with_extension("old");
        let _ = std::fs::remove_dir_all(&old);
        std::fs::rename(to, &old)?;
        let _ = std::fs::remove_dir_all(&old);
    }
    std::fs::rename(from, to)?;
    Ok(())
}

/// Try the bundle route. `Ok(true)` means the runtime is in place; `Ok(false)`
/// means the caller should install the normal way (no bundle for this
/// platform, bundle unavailable, or bundle for a different pin). Only a
/// corrupt archive that was already unpacked is an `Err`.
pub(crate) fn try_install(force: bool) -> anyhow::Result<bool> {
    let _ = force;
    if !super::is_managed() || !crate::node_install::is_managed() {
        return Ok(false);
    }
    let Some(platform) = platform(std::env::consts::OS, std::env::consts::ARCH) else {
        return Ok(false);
    };
    let Some(manifest) = fetch_manifest(platform) else {
        progress(
            "bundle",
            "no prebuilt runtime bundle reachable; installing with npm",
        );
        return Ok(false);
    };
    let pi = super::required_version();
    let node = super::required_node_version();
    let sdk = super::required_mcp_sdk_version();
    if !matches_locks(&manifest, &pi, &node, &sdk) {
        progress(
            "bundle",
            &format!(
                "prebuilt bundle is pi {} / node {}, this build wants pi {pi} / node {node}; installing with npm",
                manifest.pi_version, manifest.node_version
            ),
        );
        return Ok(false);
    }

    let url = asset_url(platform, &manifest);
    progress_route(
        "download",
        &format!("downloading the prebuilt runtime bundle {url}"),
        crate::route_probe::route::SELF_HOSTED,
    );
    let bytes = match download_bytes(&url) {
        Ok(bytes) => bytes,
        Err(e) => {
            progress(
                "bundle",
                &format!("bundle download failed ({e}); installing with npm"),
            );
            return Ok(false);
        }
    };
    if sha256_hex(&bytes) != manifest.sha256.to_ascii_lowercase() {
        progress("bundle", "bundle checksum mismatch; installing with npm");
        return Ok(false);
    }

    let cache = crate::config::layout::cache_dir();
    let staging: PathBuf = cache.join(".pi-bundle.partial");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    progress("unpack", &format!("unpacking {}", manifest.asset));
    unpack_to(&bytes, &staging)?;
    drop(bytes);

    let staged_node = staging.join("node").join(&node);
    let staged_pi = staging.join("pi");
    if !staged_node.is_dir() || !staged_pi.join("node_modules").is_dir() {
        let _ = std::fs::remove_dir_all(&staging);
        anyhow::bail!(
            "prebuilt bundle {} has an unexpected layout",
            manifest.asset
        );
    }

    replace_dir(&staged_node, &crate::node_install::install_dir())?;
    let pi_dir = super::pi_dir();
    replace_dir(
        &staged_pi.join("node_modules"),
        &pi_dir.join("node_modules"),
    )?;
    for name in ["package.json", "package-lock.json"] {
        let from = staged_pi.join(name);
        if from.is_file() {
            std::fs::copy(&from, pi_dir.join(name))?;
        }
    }
    let _ = std::fs::remove_dir_all(&staging);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(pi: &str, node: &str, sdk: &str) -> BundleManifest {
        BundleManifest {
            pi_version: pi.into(),
            node_version: node.into(),
            mcp_sdk_version: sdk.into(),
            asset: "pi-bundle-win-x64.zip".into(),
            sha256: "a".repeat(64),
        }
    }

    #[test]
    fn only_windows_has_bundles_today() {
        assert_eq!(platform("windows", "x86_64"), Some("win-x64"));
        assert_eq!(platform("windows", "aarch64"), Some("win-arm64"));
        assert_eq!(platform("macos", "aarch64"), None);
        assert_eq!(platform("linux", "x86_64"), None);
    }

    #[test]
    fn urls_follow_the_oss_layout() {
        let m = manifest("0.84.2", "24.20.0", "1.30.0");
        assert_eq!(
            manifest_url("win-x64"),
            "https://teamclaw.ucar.cc/pi-bundle/win-x64/latest.json"
        );
        assert_eq!(
            asset_url("win-x64", &m),
            "https://teamclaw.ucar.cc/pi-bundle/win-x64/0.84.2-24.20.0/pi-bundle-win-x64.zip"
        );
    }

    #[test]
    fn a_bundle_is_only_used_when_every_version_matches_the_locks() {
        assert!(matches_locks(
            &manifest("0.84.2", "24.20.0", "1.30.0"),
            "0.84.2",
            "24.20.0",
            "1.30.0"
        ));
        // A `v` prefix is tolerated on the manifest side.
        assert!(matches_locks(
            &manifest("v0.84.2", "v24.20.0", "1.30.0"),
            "0.84.2",
            "24.20.0",
            "1.30.0"
        ));
        // Any drift means "not this build's runtime".
        assert!(!matches_locks(
            &manifest("0.84.4", "24.20.0", "1.30.0"),
            "0.84.2",
            "24.20.0",
            "1.30.0"
        ));
        assert!(!matches_locks(
            &manifest("0.84.2", "22.23.2", "1.30.0"),
            "0.84.2",
            "24.20.0",
            "1.30.0"
        ));
        assert!(!matches_locks(
            &manifest("0.84.2", "24.20.0", "1.29.0"),
            "0.84.2",
            "24.20.0",
            "1.30.0"
        ));
        // An unpinned SDK does not block a bundle.
        assert!(matches_locks(
            &manifest("0.84.2", "24.20.0", "1.30.0"),
            "0.84.2",
            "24.20.0",
            ""
        ));
        // Unsafe asset names are refused.
        let mut m = manifest("0.84.2", "24.20.0", "1.30.0");
        m.asset = "../x.zip".into();
        assert!(!matches_locks(&m, "0.84.2", "24.20.0", "1.30.0"));
    }

    #[test]
    fn unpacking_keeps_only_the_node_and_pi_trees() {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("node/24.20.0/node.exe", opts).unwrap();
            std::io::Write::write_all(&mut w, b"MZ").unwrap();
            w.start_file("pi/package.json", opts).unwrap();
            std::io::Write::write_all(&mut w, b"{}").unwrap();
            w.start_file(
                "pi/node_modules/@earendil-works/pi-coding-agent/package.json",
                opts,
            )
            .unwrap();
            std::io::Write::write_all(&mut w, b"{}").unwrap();
            w.start_file("README.txt", opts).unwrap();
            std::io::Write::write_all(&mut w, b"ignored").unwrap();
            w.finish().unwrap();
        }
        let staging = tempfile::tempdir().unwrap();
        unpack_to(buf.get_ref(), staging.path()).unwrap();
        assert!(staging.path().join("node/24.20.0/node.exe").is_file());
        assert!(staging
            .path()
            .join("pi/node_modules/@earendil-works/pi-coding-agent/package.json")
            .is_file());
        assert!(!staging.path().join("README.txt").exists());
    }
}
