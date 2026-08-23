//! `@modelcontextprotocol/sdk` install for the TeamClu pi extension.
//!
//! pi ships no MCP client ("**No MCP.** … or build an extension that adds MCP
//! support" — pi's own README), so `assets/pi-extension/teamclu.ts` is the MCP
//! client: it connects to every configured server and republishes their tools
//! as pi tools. That file imports the official SDK, and pi resolves an
//! extension's bare imports from a `node_modules/` next to it
//! (`docs/extensions.md`: "Add a package.json next to your extension … and
//! imports from node_modules/ are resolved automatically").
//!
//! So the SDK is installed into the directory the extension is materialized to
//! — `<cache>/pi/extensions/` — and is treated as part of the pi install
//! rather than an optional extra: without it there is no remote-tools bridge
//! and no workspace MCP at all.
//!
//! Mainland users get the same OSS fallback pi itself has: when the official
//! registry is unreachable, a dependency-bundled tarball is downloaded from
//! `https://teamclaw.ucar.cc/mcp-sdk` (published by
//! `.github/workflows/mirror-pi-oss.yml`) and installed with `npm --offline`.

use std::path::PathBuf;

use super::{
    command_with_runtime_path, has_command, mirrored_bundle, official_registry_available, progress,
    required_mcp_sdk_version,
};
use crate::opencode_install::version_ge;

pub(super) const NPM_PKG: &str = "@modelcontextprotocol/sdk";
const MIRROR_BASE: &str = "https://teamclaw.ucar.cc/mcp-sdk";

/// The directory the extension is materialized into. npm installs here, and
/// pi's loader resolves the extension's imports from `<here>/node_modules`.
pub fn deps_dir() -> PathBuf {
    crate::runtime::pi_rpc::process::extension_dir()
}

fn sdk_package_json_path() -> PathBuf {
    deps_dir()
        .join("node_modules")
        .join("@modelcontextprotocol")
        .join("sdk")
        .join("package.json")
}

/// The manifest that makes `<cache>/pi/extensions/` an npm root. Written before
/// installing so npm has a project to install into, and kept afterwards so a
/// user can repair the tree by hand with a plain `npm install` there.
pub fn package_json(version: &str) -> String {
    format!(
        r#"{{
  "name": "teamclu-pi-extension",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "description": "amuxd-managed directory: teamclu.ts is materialized here and its npm dependencies live in ./node_modules. Edits are overwritten.",
  "dependencies": {{
    "{NPM_PKG}": "{version}"
  }},
  "pi": {{
    "extensions": ["./teamclu.ts"]
  }}
}}
"#
    )
}

/// Write the manifest when it is missing or out of date. Same "only on change"
/// rule the extension itself uses, so mtimes stay stable across spawns.
pub fn materialize_package_json() -> std::io::Result<Option<PathBuf>> {
    let want = required_mcp_sdk_version();
    if want.is_empty() {
        return Ok(None);
    }
    let dir = deps_dir();
    let path = dir.join("package.json");
    let content = package_json(&want);
    if std::fs::read_to_string(&path).unwrap_or_default() != content {
        std::fs::create_dir_all(&dir)?;
        std::fs::write(&path, &content)?;
    }
    Ok(Some(path))
}

/// `version` out of an npm package manifest.
fn version_of_manifest(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let version = value.get("version")?.as_str()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// The SDK version currently installed next to the extension, if any.
pub fn installed_version() -> Option<String> {
    version_of_manifest(&std::fs::read_to_string(sdk_package_json_path()).ok()?)
}

/// True when the installed SDK satisfies the lock (or the lock pins nothing).
pub fn satisfied() -> bool {
    let want = required_mcp_sdk_version();
    if want.is_empty() {
        return true;
    }
    installed_version()
        .map(|have| version_ge(&have, &want))
        .unwrap_or(false)
}

/// Install or upgrade the SDK into the extension directory.
///
/// Runs as part of `pi_install::run_install`; safe to call on its own.
pub fn run_install(force: bool) -> anyhow::Result<()> {
    let want = required_mcp_sdk_version();
    if want.is_empty() {
        return Ok(());
    }
    if !force {
        if let Some(have) = installed_version() {
            if version_ge(&have, &want) {
                progress(
                    "ok",
                    &format!("MCP SDK {have} already satisfies >= {want} (pi extension)"),
                );
                return Ok(());
            }
        }
    }

    // npm only: the offline fallback installs a tarball, which bun cannot
    // consume the same way (the pi install path makes the same call).
    if !has_command("npm") {
        anyhow::bail!("npm not found; the pi MCP bridge needs npm to install {NPM_PKG}");
    }

    let dir = deps_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow::anyhow!("cannot create {}: {e}", dir.display()))?;
    materialize_package_json()
        .map_err(|e| anyhow::anyhow!("cannot write the pi extension package.json: {e}"))?;
    let prefix = dir.to_string_lossy().to_string();

    let (spec, offline, _bundle) = if official_registry_available(NPM_PKG, &want) {
        progress(
            "source",
            "official npm registry is reachable; installing the MCP SDK from upstream",
        );
        (format!("{NPM_PKG}@{want}"), false, None)
    } else {
        let bundle = mirrored_bundle("MCP SDK", MIRROR_BASE, &want)?;
        let path = bundle.path().to_string_lossy().to_string();
        (path, true, Some(bundle))
    };

    let mut args: Vec<String> = vec![
        "install".into(),
        "--prefix".into(),
        prefix,
        "--no-audit".into(),
        "--no-fund".into(),
        "--omit=dev".into(),
        // npm rewrites the manifest's dependency range on install. Without
        // this it writes `^1.30.0` over the exact pin, and the next spawn
        // rewrites it back — a file that churns on every launch for no reason.
        "--save-exact".into(),
    ];
    if offline {
        args.push("--offline".into());
    }
    args.push(spec);

    progress("install", &format!("running npm {}", args.join(" ")));
    let output = command_with_runtime_path("npm")
        .args(args.iter().map(String::as_str))
        .output()
        .map_err(|e| anyhow::anyhow!("failed to run npm: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        anyhow::bail!(
            "MCP SDK install failed ({}): {}",
            output.status,
            if stderr.is_empty() { stdout } else { stderr }
        );
    }
    // An `--offline` install of a bundled tarball can succeed while resolving
    // to a different version than the manifest asked for; check the tree, not
    // npm's exit code.
    match installed_version() {
        Some(have) if version_ge(&have, &want) => {
            progress(
                "ok",
                &format!("MCP SDK {have} installed (require >= {want})"),
            );
            Ok(())
        }
        Some(have) => anyhow::bail!("MCP SDK install produced {have}, but {want} is required"),
        None => anyhow::bail!(
            "MCP SDK install reported success but {} is missing",
            sdk_package_json_path().display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_json_pins_the_locked_version_and_points_pi_at_the_extension() {
        let manifest = package_json("1.30.0");
        let parsed: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(
            parsed["dependencies"]["@modelcontextprotocol/sdk"],
            serde_json::json!("1.30.0")
        );
        // Exact pin, not a caret range: the extension is written against a
        // known client API and the OSS mirror serves exactly one version.
        assert!(!manifest.contains("^1"), "must not widen to a range");
        assert_eq!(
            parsed["pi"]["extensions"],
            serde_json::json!(["./teamclu.ts"])
        );
        assert_eq!(parsed["private"], serde_json::json!(true));
    }

    #[test]
    fn deps_dir_is_where_the_extension_is_materialized() {
        // pi resolves an extension's imports from a node_modules next to it;
        // installing anywhere else silently yields "no MCP servers". Both
        // paths derive from HOME, so hold the lock the HOME-mutating tests use
        // rather than race one of them between the two calls.
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let extension = crate::runtime::pi_rpc::process::extension_path();
        assert_eq!(deps_dir(), extension.parent().unwrap());
    }

    #[test]
    fn version_is_read_from_the_installed_manifest() {
        assert_eq!(
            version_of_manifest(r#"{"name":"@modelcontextprotocol/sdk","version":"1.30.0"}"#)
                .as_deref(),
            Some("1.30.0")
        );
        // A half-written or version-less manifest must read as "not installed"
        // so the next `pi install` repairs it, not as a satisfied requirement.
        assert_eq!(version_of_manifest(r#"{"version":""}"#), None);
        assert_eq!(version_of_manifest("{"), None);
    }
}
