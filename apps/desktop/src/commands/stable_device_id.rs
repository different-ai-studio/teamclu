//! Peek this machine's daemon device id without starting amuxd and without
//! minting a new one.
//!
//! The Cloud API binds an agent to `(team, device id, account)`. Classifying
//! "this account already installed a local agent here" has to use the same id
//! the daemon would bind with. Starting the daemon just to read `GET /v1/info`
//! is the install path, so this command stops one step earlier:
//!
//! 1. `AMUXD_DEVICE_ID`
//! 2. `<amuxd home>/device-id`
//! 3. the same hardware UUIDv5 the daemon derives
//!
//! A missing cache file is not "no device". The daemon recomputes step 3.
//! What this command never does is step 4 of `apps/daemon/src/device_id.rs`:
//! a random UUID. No readable machine identity means `None`, and the caller
//! treats that as unknown — it must not skip the install gate, and it must
//! not write a new id the daemon would not have chosen the same way.
//!
//! The namespace and the `{platform}:{raw}` input are copied from the daemon.
//! `derives_the_daemon_golden_vector` fails if they drift.

use std::path::Path;

use crate::commands::amuxd_home_dir;

const DEVICE_ID_ENV: &str = "AMUXD_DEVICE_ID";

/// Same constant as `apps/daemon/src/device_id.rs`. Never change it.
const DEVICE_ID_NAMESPACE: uuid::Uuid =
    uuid::Uuid::from_u128(0x6f2a_1c84_9d3b_4e57_a0f1_5c8e_7b26_d431);

/// Actor id the daemon is already running for `team_id`, read from that
/// team's `backend.toml`. Does not start amuxd and does not return the
/// refresh token that sits next to the id.
///
/// Used to stamp `agents.device_id` onto a pre-device-binding install.
/// Anything that is not a team uuid, or a file whose `team_id` does not
/// match, is `None`.
#[tauri::command]
pub fn read_local_daemon_actor_id(team_id: String) -> Option<String> {
    let team_id = team_id.trim();
    if !is_team_uuid(team_id) {
        return None;
    }
    let path = super::amuxd_team_state_dir(team_id).join("backend.toml");
    actor_id_in_backend(&path, team_id)
}

fn is_team_uuid(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_hexdigit(),
    })
}

fn actor_id_in_backend(path: &Path, team_id: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let parsed: BackendProbe = toml::from_str(&text).ok()?;
    let cloud = parsed.cloud_api?;
    if cloud.team_id.as_deref().unwrap_or("").trim() != team_id {
        return None;
    }
    let actor = cloud.actor_id.unwrap_or_default();
    let actor = actor.trim();
    (!actor.is_empty()).then(|| actor.to_string())
}

#[derive(serde::Deserialize)]
struct BackendProbe {
    cloud_api: Option<CloudApiProbe>,
}

#[derive(serde::Deserialize)]
struct CloudApiProbe {
    team_id: Option<String>,
    actor_id: Option<String>,
}

/// `Some` is an id the daemon would bind with. `None` means we could not
/// resolve one without inventing it.
#[tauri::command]
pub fn read_stable_device_id() -> Option<String> {
    peek(
        std::env::var(DEVICE_ID_ENV).ok(),
        &amuxd_home_dir().join("device-id"),
        machine_id(),
    )
}

fn peek(
    env_override: Option<String>,
    path: &Path,
    machine: Option<(&str, String)>,
) -> Option<String> {
    if let Some(v) = env_override {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(existing) = read_nonempty(path) {
        return Some(existing);
    }
    machine.map(|(platform, raw)| derive_device_id(platform, &raw))
}

fn derive_device_id(platform: &str, raw: &str) -> String {
    uuid::Uuid::new_v5(
        &DEVICE_ID_NAMESPACE,
        format!("{platform}:{}", raw.trim()).as_bytes(),
    )
    .to_string()
}

fn read_nonempty(path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(path).ok()?;
    let trimmed = contents.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
fn device_id_path() -> std::path::PathBuf {
    amuxd_home_dir().join("device-id")
}

#[cfg(target_os = "macos")]
fn machine_id() -> Option<(&'static str, String)> {
    let out = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = parse_ioreg_platform_uuid(&String::from_utf8_lossy(&out.stdout))?;
    Some(("macos", raw))
}

#[cfg(target_os = "windows")]
fn machine_id() -> Option<(&'static str, String)> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
            "/reg:64",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = parse_reg_machine_guid(&String::from_utf8_lossy(&out.stdout))?;
    Some(("windows", raw))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn machine_id() -> Option<(&'static str, String)> {
    let raw = read_nonempty(Path::new("/etc/machine-id"))
        .or_else(|| read_nonempty(Path::new("/var/lib/dbus/machine-id")))?;
    Some(("linux", raw))
}

#[cfg(not(any(unix, target_os = "windows")))]
fn machine_id() -> Option<(&'static str, String)> {
    None
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_ioreg_platform_uuid(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.split_once("\"IOPlatformUUID\""))
        .and_then(|(_, rest)| rest.split('"').nth(1))
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_reg_machine_guid(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find(|line| line.contains("MachineGuid"))
        .and_then(|line| line.split_whitespace().last())
        .map(str::to_string)
        .filter(|s| !s.is_empty() && *s != "MachineGuid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_daemon_golden_vector() {
        assert_eq!(
            derive_device_id("macos", "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"),
            "cbeb25f1-bbf8-595d-9d0a-7f32278ddb7c"
        );
    }

    #[test]
    fn env_override_wins_and_does_not_require_a_file() {
        let id = peek(
            Some("  from-env  ".into()),
            Path::new("/no/such/device-id"),
            None,
        );
        assert_eq!(id.as_deref(), Some("from-env"));
    }

    #[test]
    fn blank_env_falls_through_to_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "legacy-random-id\n").unwrap();
        assert_eq!(
            peek(Some("   ".into()), &path, Some(("linux", "raw".into()))).as_deref(),
            Some("legacy-random-id")
        );
    }

    #[test]
    fn existing_file_wins_over_hardware() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "legacy-random-id\n").unwrap();
        assert_eq!(
            peek(None, &path, Some(("macos", "STABLE".into()))).as_deref(),
            Some("legacy-random-id")
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "legacy-random-id\n"
        );
    }

    #[test]
    fn missing_file_rederives_and_does_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-id");
        let id = peek(None, &path, Some(("macos", "STABLE-HARDWARE-ID".into())));
        assert_eq!(
            id.as_deref(),
            Some(derive_device_id("macos", "STABLE-HARDWARE-ID").as_str())
        );
        assert!(!path.exists(), "peeking must not create a device id");
    }

    #[test]
    fn no_machine_identity_is_none_and_does_not_mint_a_random_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-id");
        assert_eq!(peek(None, &path, None), None);
        assert!(!path.exists());
    }

    #[test]
    fn cache_path_is_the_branded_daemon_home() {
        assert_eq!(device_id_path(), amuxd_home_dir().join("device-id"));
    }

    #[test]
    fn backend_actor_id_matches_the_requested_team_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backend.toml");
        let team = "30b7006d-4225-4160-8c12-0a057268a914";
        std::fs::write(
            &path,
            format!(
                "kind = \"cloud_api\"\n\n[cloud_api]\nurl = \"https://example.test\"\nrefresh_token = \"secret\"\nteam_id = \"{team}\"\nactor_id = \"e35db247-fe50-4a8a-bf1f-9974807e7f6b\"\n"
            ),
        )
        .unwrap();
        assert_eq!(
            actor_id_in_backend(&path, team).as_deref(),
            Some("e35db247-fe50-4a8a-bf1f-9974807e7f6b")
        );
        assert_eq!(
            actor_id_in_backend(&path, "00000000-0000-4000-8000-000000000001"),
            None
        );
    }

    #[test]
    fn non_uuid_team_id_is_not_a_path() {
        assert!(!is_team_uuid("../secrets"));
        assert!(!is_team_uuid(""));
        assert!(is_team_uuid("30b7006d-4225-4160-8c12-0a057268a914"));
    }
}
