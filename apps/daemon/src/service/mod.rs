use std::path::Path;

pub const LAUNCHD_LABEL: &str = "cc.ucar.amuxd";

pub fn launchd_plist(exe: &Path, log_dir: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{out}</string>
  <key>StandardErrorPath</key>
  <string>{err}</string>
</dict>
</plist>
"#,
        label = LAUNCHD_LABEL,
        exe = exe.display(),
        out = log_dir.join("amuxd.out.log").display(),
        err = log_dir.join("amuxd.err.log").display(),
    )
}

pub fn systemd_unit(exe: &Path) -> String {
    format!(
        r#"[Unit]
Description=amuxd (TeamClu agent daemon)
After=network-online.target

[Service]
ExecStart="{exe}" start
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
"#,
        exe = exe.display(),
    )
}

use crate::config::DaemonConfig;

fn amuxd_exe_path() -> std::path::PathBuf {
    DaemonConfig::config_dir()
        .join("bin")
        .join(if cfg!(windows) { "amuxd.exe" } else { "amuxd" })
}

#[cfg(target_os = "macos")]
pub fn install_service() -> anyhow::Result<()> {
    let exe = amuxd_exe_path();
    anyhow::ensure!(exe.exists(), "amuxd binary not found at {}", exe.display());
    let plist_dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join("Library/LaunchAgents");
    std::fs::create_dir_all(&plist_dir)?;
    let plist_path = plist_dir.join(format!("{LAUNCHD_LABEL}.plist"));
    // launchd redirects amuxd's stdout/stderr into `logs/` so they survive
    // restarts and are tailable. launchd will not create the directory, and it
    // silently declines to start the job when the redirect target's parent is
    // missing, so create it here.
    let log_dir = crate::config::layout::logs_dir();
    std::fs::create_dir_all(&log_dir)?;
    std::fs::write(&plist_path, launchd_plist(&exe, &log_dir))?;
    let uid = nix_uid();
    let target = format!("gui/{uid}/{LAUNCHD_LABEL}");

    // `launchctl bootout` is asynchronous; a bootout-then-bootstrap pair races and
    // hits "Bootstrap failed: 5: Input/output error" when the job was already loaded.
    // Instead: if already loaded, restart in place (kickstart -k re-execs the same
    // program path, picking up an upgraded binary); only bootstrap when not loaded.
    let already_loaded = std::process::Command::new("launchctl")
        .args(["print", &target])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if already_loaded {
        let status = std::process::Command::new("launchctl")
            .args(["kickstart", "-k", &target])
            .status()?;
        anyhow::ensure!(status.success(), "launchctl kickstart failed");
    } else {
        let status = std::process::Command::new("launchctl")
            .args(["bootstrap", &format!("gui/{uid}")])
            .arg(&plist_path)
            .status()?;
        anyhow::ensure!(status.success(), "launchctl bootstrap failed");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn uninstall_service() -> anyhow::Result<()> {
    let uid = nix_uid();
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
        .status();
    let plist_path = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join("Library/LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist"));
    let _ = std::fs::remove_file(plist_path);
    Ok(())
}

#[cfg(target_os = "macos")]
fn nix_uid() -> u32 {
    // SAFETY: getuid() is always safe to call.
    unsafe { libc::getuid() }
}

#[cfg(target_os = "linux")]
pub fn install_service() -> anyhow::Result<()> {
    let exe = amuxd_exe_path();
    anyhow::ensure!(exe.exists(), "amuxd binary not found at {}", exe.display());
    let unit_dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join(".config/systemd/user");
    std::fs::create_dir_all(&unit_dir)?;
    std::fs::write(unit_dir.join("amuxd.service"), systemd_unit(&exe))?;
    // Best-effort: keep the user manager running after logout so the service
    // survives across login sessions (no-op / may fail on headless setups).
    let _ = std::process::Command::new("loginctl")
        .args(["enable-linger"])
        .status();
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "enable", "amuxd.service"])
        .status();
    // `restart` starts the unit if stopped and restarts it if running, so an
    // upgraded binary takes effect on re-install.
    let status = std::process::Command::new("systemctl")
        .args(["--user", "restart", "amuxd.service"])
        .status()?;
    anyhow::ensure!(status.success(), "systemctl --user restart failed");
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn uninstall_service() -> anyhow::Result<()> {
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "disable", "--now", "amuxd.service"])
        .status();
    let unit = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join(".config/systemd/user/amuxd.service");
    let _ = std::fs::remove_file(unit);
    Ok(())
}

#[cfg(target_os = "windows")]
fn schtasks_task_exists() -> bool {
    use crate::process_util::CommandNoWindow;

    std::process::Command::new("schtasks")
        .no_window()
        .args(["/Query", "/TN", "amuxd"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Start amuxd in the background when login scheduled-task registration is
/// unavailable (common on built-in Administrator accounts or locked-down
/// Task Scheduler policy).
#[cfg(target_os = "windows")]
fn start_daemon_detached(exe: &Path) -> anyhow::Result<()> {
    use crate::process_util::CommandNoWindow;

    if let Ok(Some((pid, path))) = crate::cli::process::read_pidfile_for_service() {
        if crate::cli::process::pid_is_alive(pid) {
            return Ok(());
        }
        let _ = std::fs::remove_file(path);
    }

    // CREATE_NO_WINDOW alone — deliberately *not* `| DETACHED_PROCESS`.
    // CreateProcess ignores CREATE_NO_WINDOW when DETACHED_PROCESS is also set,
    // and DETACHED_PROCESS leaves the daemon with no console at all, so every
    // console child it later spawns (opencode serve, node, tasklist, npm) gets
    // its own *visible* console window. CREATE_NO_WINDOW gives amuxd a private
    // hidden console instead: still isolated from the launching terminal's
    // Ctrl+C / close events, nothing is ever drawn, and children inherit the
    // hidden console.
    std::process::Command::new(exe)
        .arg("start")
        .no_window()
        .spawn()
        .map(|_| ())
        .map_err(|e| anyhow::anyhow!("spawn amuxd start: {e}"))
}

#[cfg(target_os = "windows")]
pub fn install_service() -> anyhow::Result<()> {
    use crate::process_util::CommandNoWindow;
    let exe = amuxd_exe_path();
    anyhow::ensure!(exe.exists(), "amuxd binary not found at {}", exe.display());

    if schtasks_task_exists() {
        let _ = std::process::Command::new("schtasks")
            .no_window()
            .args(["/Run", "/TN", "amuxd"])
            .status();
        start_daemon_detached(&exe)?;
        return Ok(());
    }

    // schtasks /TR wants a bare command line; quote only the exe path (it may
    // contain spaces), not the whole "<exe> start" string.
    let created = std::process::Command::new("schtasks")
        .no_window()
        .args(["/Create", "/F", "/SC", "ONLOGON", "/TN", "amuxd", "/TR"])
        .arg(format!("\"{}\" start", exe.display()))
        .status()?
        .success();

    if created {
        let _ = std::process::Command::new("schtasks")
            .no_window()
            .args(["/Run", "/TN", "amuxd"])
            .status();
        start_daemon_detached(&exe)?;
        return Ok(());
    }

    eprintln!(
        "warning: could not register amuxd login task (schtasks denied); starting daemon directly"
    );
    start_daemon_detached(&exe)
}

#[cfg(target_os = "windows")]
pub fn uninstall_service() -> anyhow::Result<()> {
    use crate::process_util::CommandNoWindow;

    let _ = std::process::Command::new("schtasks")
        .no_window()
        .args(["/Delete", "/F", "/TN", "amuxd"])
        .status();
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn install_service() -> anyhow::Result<()> {
    anyhow::bail!("amuxd service registration is not supported on this platform")
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn uninstall_service() -> anyhow::Result<()> {
    anyhow::bail!("amuxd service registration is not supported on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn launchd_plist_contains_exec_and_label() {
        let p = launchd_plist(
            Path::new("/Users/x/.amuxd/bin/amuxd"),
            Path::new("/Users/x/.amuxd/logs"),
        );
        assert!(p.contains("<string>cc.ucar.amuxd</string>"));
        assert!(p.contains("<string>/Users/x/.amuxd/bin/amuxd</string>"));
        assert!(p.contains("<string>start</string>"));
        assert!(p.contains("<key>RunAtLoad</key>"));
        assert!(p.contains("<key>KeepAlive</key>"));
        assert!(p.contains("<key>StandardOutPath</key>"));
        assert!(p.contains("<string>/Users/x/.amuxd/logs/amuxd.out.log</string>"));
        assert!(p.contains("<key>StandardErrorPath</key>"));
        assert!(p.contains("<string>/Users/x/.amuxd/logs/amuxd.err.log</string>"));
    }

    #[test]
    fn systemd_unit_contains_execstart_and_restart() {
        let u = systemd_unit(Path::new("/home/x/.amuxd/bin/amuxd"));
        assert!(u.contains("ExecStart=\"/home/x/.amuxd/bin/amuxd\" start"));
        assert!(u.contains("Restart=always"));
        assert!(u.contains("[Install]"));
        assert!(u.contains("WantedBy=default.target"));
    }
}
