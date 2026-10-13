use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
use teamclu_support::collect::interpret_webview2;
use teamclu_support::collect::{
    amuxd_log, build_bundle, desktop_log_dir_for, journal_path, last_detail, parse_journal,
    process_flags_for, read_desktop_logs, read_named_log, Gathered, WebView2,
};

pub fn bundle(phase: &str) -> serde_json::Value {
    let os = host_os();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let journal_text = std::fs::read_to_string(journal_path(&home)).unwrap_or_default();
    let entries = parse_journal(&journal_text);
    let installer = last_detail(&entries, "installer_image").map(str::to_string);
    let config = dirs::config_dir().unwrap_or_else(|| home.join("AppData").join("Roaming"));
    let running = |image: &str| image_running(image);
    build_bundle(Gathered {
        os,
        phase: phase.to_string(),
        helper_version: env!("TEAMCLU_SUPPORT_VERSION").to_string(),
        os_version: os_version(),
        arch: std::env::consts::ARCH.to_string(),
        journal_text,
        webview2: webview(),
        processes: process_flags_for(os, running, installer.as_deref()),
        logs: vec![
            read_named_log("amuxd.log", &amuxd_log(&home, "amuxd.log")),
            read_named_log("amuxd.managed.log", &amuxd_log(&home, "amuxd.managed.log")),
            read_desktop_logs(&desktop_log_dir_for(os, &home, &config)),
        ],
    })
}

fn host_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "macos"
    }
}

fn webview() -> WebView2 {
    #[cfg(windows)]
    {
        interpret_webview2(&[read_pv(true), read_pv(false)])
    }
    #[cfg(not(windows))]
    {
        // System WebKit. `snapshot.os` tells the agent this is not Edge WebView2.
        WebView2 {
            present: Some(true),
            version: None,
        }
    }
}

fn os_version() -> String {
    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/C", "ver"])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "windows".into())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "macos".into())
    }
}

fn image_running(image: &str) -> bool {
    #[cfg(windows)]
    {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH"])
            .output();
        match output {
            Ok(output) => String::from_utf8_lossy(&output.stdout)
                .to_ascii_lowercase()
                .contains(&image.to_ascii_lowercase()),
            Err(_) => false,
        }
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("pgrep")
            .args(["-x", image])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}

#[cfg(windows)]
fn read_pv(machine: bool) -> Result<Option<String>, ()> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegGetValueW, RegOpenKeyExW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ,
        RRF_RT_REG_SZ,
    };
    let subkey = if machine {
        wide("SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}")
    } else {
        wide("SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}")
    };
    let root = if machine {
        HKEY_LOCAL_MACHINE
    } else {
        HKEY_CURRENT_USER
    };
    unsafe {
        let mut key = std::ptr::null_mut();
        let opened = RegOpenKeyExW(root, subkey.as_ptr(), 0, KEY_READ, &mut key);
        if opened != 0 {
            return if opened == 2 || opened == 3 {
                Ok(None)
            } else {
                Err(())
            };
        }
        let name = wide("pv");
        let mut bytes = [0u8; 128];
        let mut size = bytes.len() as u32;
        let status = RegGetValueW(
            key,
            std::ptr::null(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            bytes.as_mut_ptr().cast(),
            &mut size,
        );
        let _ = RegCloseKey(key);
        if status != 0 {
            return Err(());
        }
        let wide_bytes = &bytes[..size as usize];
        let units: Vec<u16> = wide_bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .take_while(|unit| *unit != 0)
            .collect();
        Ok(Some(String::from_utf16_lossy(&units)))
    }
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}
