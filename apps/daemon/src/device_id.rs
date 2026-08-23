use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Namespace for hashing a raw machine identifier into this product's device id.
///
/// NEVER change this constant, and never change the input format built in
/// [`derive_device_id`]: both feed a UUIDv5, so any edit re-derives a different
/// id for every machine on earth and silently provisions each of them a second
/// agent. `derives_a_stable_known_value` is the golden test that stops a
/// refactor from doing it by accident.
const DEVICE_ID_NAMESPACE: uuid::Uuid =
    uuid::Uuid::from_u128(0x6f2a_1c84_9d3b_4e57_a0f1_5c8e_7b26_d431);

/// Explicit override, highest precedence.
///
/// Containers and cloned VMs are the reason this exists: a Docker image with a
/// baked `/etc/machine-id` derives the SAME id in every container, and they
/// would then fight over one agent. A deployment that runs many daemons on one
/// image must give each of them an id here.
const DEVICE_ID_ENV: &str = "AMUXD_DEVICE_ID";

/// This machine's stable id.
///
/// Two roles, and the second is why it must stay stable: it separates two
/// machines' rows in client-version telemetry, AND it is the key the Cloud API
/// binds an agent actor to (`agents.device_id`, unique per team). A rotated id
/// means the next login silently provisions a second agent for this machine.
///
/// Resolution order:
///
/// 1. `AMUXD_DEVICE_ID`
/// 2. `~/.amuxd/device-id` — existing installs keep the id they already
///    registered with the server, and it caches the answer for everyone else
/// 3. a value derived from the machine's own hardware/OS identity, written to
///    that file
/// 4. a random UUID, written to that file
///
/// Step 3 is what makes deleting the file survivable: it recomputes the same
/// value instead of inventing a new one. Step 2 must stay ahead of it — this
/// changed the *generator* from random to deterministic, and re-deriving over a
/// file that already exists would rotate the id of every machine that predates
/// the change, which is exactly the failure being fixed.
///
/// Not to be confused with the webview's `teamclu.client-version.device-id`,
/// which lives in local storage and is telemetry-only.
pub fn daemon_device_id() -> String {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            resolve(
                std::env::var(DEVICE_ID_ENV).ok(),
                device_id_path(),
                machine_id(),
            )
        })
        .clone()
}

/// The precedence chain, with every input injected so it can be tested without
/// a real home directory or real hardware.
fn resolve(
    env_override: Option<String>,
    path: Option<PathBuf>,
    machine: Option<(&'static str, String)>,
) -> String {
    if let Some(v) = env_override {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    if let Some(p) = &path {
        if let Some(existing) = read_nonempty(p) {
            return existing;
        }
    }

    let id = match machine {
        Some((platform, raw)) => derive_device_id(platform, &raw),
        // No readable machine identity (an unusual platform, a locked-down
        // container). Falling back to random keeps the daemon working; it just
        // gives up deletion-resistance, exactly as before this change.
        None => uuid::Uuid::new_v4().to_string(),
    };

    if let Some(p) = &path {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(p, &id);
    }
    id
}

/// Hash a raw machine identifier into a device id.
///
/// Hashed rather than sent as-is for three reasons: the raw values are hardware
/// fingerprints other software also reads, a product-specific namespace keeps
/// this id from correlating with those uses, and the output stays UUID-shaped so
/// `agents.device_id` and everything downstream is unchanged. `machine-id(5)`
/// makes the same recommendation for its own value.
///
/// The platform tag is part of the input so two platforms that somehow report
/// the same raw string still land on different ids.
fn derive_device_id(platform: &str, raw: &str) -> String {
    uuid::Uuid::new_v5(
        &DEVICE_ID_NAMESPACE,
        format!("{platform}:{}", raw.trim()).as_bytes(),
    )
    .to_string()
}

fn read_nonempty(p: &Path) -> Option<String> {
    let contents = fs::read_to_string(p).ok()?;
    let trimmed = contents.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Resolved through the daemon's own home, never a hand-written `~/.amuxd`.
///
/// It used to be hardcoded, which mattered more here than anywhere else: this
/// id is what the Cloud API binds an agent actor to, so a white-label daemon
/// reading the official build's cached id would claim the official machine's
/// agent. `$AMUXD_HOME` — the override every test and ops runbook uses — was
/// also ignored here alone.
///
/// Infallible now: [`crate::config::DaemonConfig::config_dir`] falls back to
/// `/tmp` rather than returning `None`, so the caller's "no path, derive but
/// don't persist" branch is only reachable in tests.
fn device_id_path() -> Option<PathBuf> {
    Some(crate::config::DaemonConfig::config_dir().join("device-id"))
}

// ── Per-platform machine identity ───────────────────────────────────────────
//
// Each returns (platform tag, raw identifier). Parsing is split into free
// functions so it can be tested on any host; only the acquisition is gated.

/// `IOPlatformUUID`, tied to the logic board and readable without privileges.
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

/// `MachineGuid`, written once at OS install.
///
/// Read through `reg.exe` rather than the registry API: this repo has no Windows
/// toolchain in the loop for most changes, and a text query is far less to get
/// wrong unverified than hand-rolled UTF-16 FFI. `/reg:64` is required — a
/// 32-bit process would otherwise be redirected to `WOW6432Node` and read a
/// different value than a 64-bit one on the same machine.
#[cfg(target_os = "windows")]
fn machine_id() -> Option<(&'static str, String)> {
    use crate::process_util::CommandNoWindow;

    let out = std::process::Command::new("reg")
        .no_window()
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
            "/reg:64",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = parse_reg_machine_guid(&String::from_utf8_lossy(&out.stdout))?;
    Some(("windows", raw))
}

/// `/etc/machine-id`, with the pre-systemd D-Bus location as a fallback.
///
/// Deliberately not `/sys/class/dmi/id/product_uuid`: it is mode 0400 on most
/// kernels, so a non-root daemon would read nothing and silently drop to the
/// random fallback.
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

#[cfg(target_os = "macos")]
fn parse_ioreg_platform_uuid(stdout: &str) -> Option<String> {
    parse_ioreg_platform_uuid_impl(stdout)
}

#[cfg(target_os = "windows")]
fn parse_reg_machine_guid(stdout: &str) -> Option<String> {
    parse_reg_machine_guid_impl(stdout)
}

/// `"IOPlatformUUID" = "0A1B2C3D-..."` out of an ioreg property dump.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_ioreg_platform_uuid_impl(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.split_once("\"IOPlatformUUID\""))
        .and_then(|(_, rest)| rest.split('"').nth(1))
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// The value column of `reg query ... /v MachineGuid`, whose line reads
/// `    MachineGuid    REG_SZ    <guid>`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_reg_machine_guid_impl(stdout: &str) -> Option<String> {
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

    /// The cache file must follow `$AMUXD_HOME` / the brand, not a hardcoded
    /// `~/.amuxd`. Two brands sharing one cached id would have them claim the
    /// same `agents.device_id` row.
    #[test]
    fn cache_path_follows_the_daemon_home() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(dir.path());

        assert_eq!(device_id_path(), Some(dir.path().join("device-id")));
    }

    #[test]
    fn returns_nonempty_stable_id() {
        let a = super::daemon_device_id();
        let b = super::daemon_device_id();
        assert!(!a.is_empty());
        assert_eq!(a, b, "device id must be stable across calls");
    }

    /// Golden vector. If this fails, the namespace or the input format changed —
    /// which re-derives a different id for every machine and gives each one a
    /// second agent. Fix the code, never this expectation.
    #[test]
    fn derives_a_stable_known_value() {
        assert_eq!(
            derive_device_id("macos", "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"),
            "cbeb25f1-bbf8-595d-9d0a-7f32278ddb7c"
        );
    }

    #[test]
    fn derivation_is_deterministic_and_platform_scoped() {
        let a = derive_device_id("linux", "same-raw-value");
        assert_eq!(a, derive_device_id("linux", "same-raw-value"));
        assert_ne!(
            a,
            derive_device_id("windows", "same-raw-value"),
            "the platform tag must separate identical raw values"
        );
    }

    #[test]
    fn derivation_ignores_surrounding_whitespace() {
        assert_eq!(
            derive_device_id("linux", "abc"),
            derive_device_id("linux", "  abc\n")
        );
    }

    #[test]
    fn env_override_wins_over_everything() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "from-file").unwrap();

        let id = resolve(
            Some("  from-env  ".to_string()),
            Some(path.clone()),
            Some(("linux", "raw".to_string())),
        );

        assert_eq!(id, "from-env", "env must win and be trimmed");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "from-file",
            "an override must not rewrite the cached id"
        );
    }

    #[test]
    fn blank_env_override_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "from-file").unwrap();

        assert_eq!(
            resolve(Some("   ".to_string()), Some(path), None),
            "from-file"
        );
    }

    /// The load-bearing case for existing installs: a machine that registered a
    /// random id with the server must keep it, not switch to the derived one.
    #[test]
    fn existing_file_wins_over_hardware() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "legacy-random-id\n").unwrap();

        let id = resolve(None, Some(path.clone()), Some(("linux", "raw".to_string())));

        assert_eq!(id, "legacy-random-id");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "legacy-random-id\n"
        );
    }

    /// The point of the change: losing the file recomputes the same id.
    #[test]
    fn deleting_the_file_recovers_the_same_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("device-id");
        let machine = || Some(("macos", "STABLE-HARDWARE-ID".to_string()));

        let first = resolve(None, Some(path.clone()), machine());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);

        std::fs::remove_file(&path).unwrap();
        let second = resolve(None, Some(path.clone()), machine());

        assert_eq!(
            first, second,
            "a deleted cache must not rotate the identity"
        );
    }

    /// Without a machine identity the daemon still has to work; it just loses
    /// deletion-resistance, as it did before this change.
    #[test]
    fn falls_back_to_random_and_persists_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-id");

        let first = resolve(None, Some(path.clone()), None);
        assert!(uuid::Uuid::parse_str(&first).is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);

        let second = resolve(None, Some(path), None);
        assert_eq!(first, second, "the persisted random id must be reused");
    }

    #[test]
    fn empty_file_is_treated_as_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "   \n").unwrap();

        let id = resolve(None, Some(path), Some(("linux", "raw".to_string())));

        assert_eq!(id, derive_device_id("linux", "raw"));
    }

    /// Runs the real acquisition path on the host. The parse tests below use a
    /// synthetic sample; this is what catches the sample drifting away from what
    /// the platform actually prints (a wrong parse is indistinguishable from
    /// "no hardware here" — it just silently falls back to random).
    #[test]
    fn reads_a_stable_machine_identity_on_this_host() {
        let Some((platform, raw)) = machine_id() else {
            // A platform with no readable identity is a supported outcome, not a
            // failure — the random fallback covers it.
            return;
        };
        assert!(!platform.is_empty());
        assert!(
            !raw.trim().is_empty(),
            "a blank raw id would hash to a constant"
        );
        let (_, again) = machine_id().expect("machine identity must not disappear between calls");
        assert_eq!(raw, again, "machine identity must be stable across calls");
    }

    #[test]
    fn parses_ioreg_platform_uuid() {
        let sample = r#"
+-o J316cAP  <class IOPlatformExpertDevice, id 0x100000272, registered>
  {
    "IOPlatformSerialNumber" = "ABCD1234EFGH"
    "IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"
    "IOPolledInterface" = "AppleARMWatchdogTimerHibernateHandler is not serializable"
  }
"#;
        assert_eq!(
            parse_ioreg_platform_uuid_impl(sample).as_deref(),
            Some("0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9")
        );
    }

    #[test]
    fn ioreg_without_the_property_yields_none() {
        assert!(parse_ioreg_platform_uuid_impl("\"IOPlatformSerialNumber\" = \"X\"").is_none());
    }

    #[test]
    fn parses_reg_machine_guid() {
        let sample = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    9f8c1d2e-3a4b-5c6d-7e8f-90a1b2c3d4e5\r\n\r\n";
        assert_eq!(
            parse_reg_machine_guid_impl(sample).as_deref(),
            Some("9f8c1d2e-3a4b-5c6d-7e8f-90a1b2c3d4e5")
        );
    }

    /// `reg query` prints the key path and, when the value is missing, an error
    /// line — neither may be mistaken for a value.
    #[test]
    fn reg_output_without_a_value_yields_none() {
        assert!(parse_reg_machine_guid_impl(
            "ERROR: The system was unable to find the specified registry key or value."
        )
        .is_none());
        assert!(parse_reg_machine_guid_impl("    MachineGuid").is_none());
    }
}
