//! `@modelcontextprotocol/sdk` — the MCP client the TeamClu pi extension runs on.
//!
//! pi ships no MCP client ("**No MCP.** … or build an extension that adds MCP
//! support" — pi's own README), so `assets/pi-extension/teamclu.ts` is the MCP
//! client: it connects to every configured server and republishes their tools
//! as pi tools. That file imports the official SDK.
//!
//! The SDK is one of the two dependencies of the managed pi runtime
//! (`apps/daemon/pi-runtime/package.json`), so it is installed by the same
//! `npm ci` that installs pi, into `<cache>/pi/node_modules`. The extension is
//! materialized at `<cache>/pi/extensions/teamclu.ts`; pi loads extensions
//! through jiti in place, so a bare import resolves the way Node's does —
//! walking up from the extension's directory — and finds that `node_modules`
//! one level up (verified against pi 0.84.4 in both host and `--mode rpc`
//! modes, #1250). Without the SDK there is no remote-tools bridge and no
//! workspace MCP at all, which is why it counts towards `doctor().satisfied`.

use std::path::PathBuf;

use super::{required_mcp_sdk_version, version_of_manifest};
use teamclu_runtime_env::version::version_ge;

pub(crate) const NPM_PKG: &str = "@modelcontextprotocol/sdk";

/// OSS copy of the dependency-bundled SDK tarball, for networks where no npm
/// registry is usable (published by `.github/workflows/mirror-pi-oss.yml`).
pub(super) const MIRROR_BASE: &str = "https://teamclaw.ucar.cc/mcp-sdk";

fn sdk_package_json_path() -> PathBuf {
    super::node_modules_dir()
        .join("@modelcontextprotocol")
        .join("sdk")
        .join("package.json")
}

/// The SDK version installed in the managed runtime, if any.
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
