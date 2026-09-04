//! `amuxd doctor` — what this machine has of the runtime, as JSON.
//!
//! Four things, and only four: the daemon binary itself, the amuxd-managed
//! Node, the managed pi runtime (pi + MCP SDK), and git. The desktop's
//! first-run wizard and Dependencies page read this by key. It used to probe
//! opencode, cursor and claude as well, spawning each `--version` on a cold
//! start; with pi the only runtime (#1247 / #1250) the report is three file
//! reads and one `node --version`.

use serde::Serialize;

use crate::opencode_install::{parse_semver, version_ge};
use crate::process_util::CommandNoWindow;

#[derive(Debug, Serialize)]
pub struct ComponentStatus {
    pub present: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmuxdStatus {
    /// A daemon binary is installed at ~/.amuxd/bin/amuxd (or this is it).
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
    pub amuxd: AmuxdStatus,
    pub node: crate::node_install::NodeStatus,
    pub pi: crate::pi_install::PiStatus,
    pub git: ComponentStatus,
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

fn amuxd_status() -> AmuxdStatus {
    let bundled_version = env!("CARGO_PKG_VERSION").to_string();
    // When doctor runs as the desktop sidecar, report *this* binary as amuxd
    // (desktop-managed mode does not copy into ~/.amuxd/bin).
    let self_exe = std::env::current_exe().ok();
    let amuxd_path = crate::config::DaemonConfig::config_dir()
        .join("bin")
        .join(if cfg!(windows) { "amuxd.exe" } else { "amuxd" });
    let (present, installed_version, path, satisfied) = if let Some(ref p) = self_exe {
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
    AmuxdStatus {
        present,
        installed_version,
        bundled_version,
        path,
        satisfied,
    }
}

pub fn report() -> DoctorReport {
    let git_version = probe_version("git", &["--version"]);
    DoctorReport {
        amuxd: amuxd_status(),
        // `pi` already carries the node fields the desktop reads per runtime;
        // `node` is the same probe as a top-level row for the Dependencies page.
        node: crate::node_install::doctor(),
        pi: crate::pi_install::doctor(),
        git: ComponentStatus {
            present: git_version.is_some(),
            version: git_version,
            path: None,
        },
    }
}

pub fn run() -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(&report())?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_report_has_exactly_the_four_rows_the_desktop_reads() {
        // The desktop's `setup_list_requirements` and `check_dependencies`
        // index this JSON by key; a renamed or missing row reads as "not
        // installed" on every machine.
        let value = serde_json::to_value(report()).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["amuxd", "git", "node", "pi"]);
        assert!(value["amuxd"]["bundledVersion"].is_string());
        assert!(value["node"]["requiredVersion"].is_string());
        assert!(value["pi"]["requiredVersion"].is_string());
    }
}
