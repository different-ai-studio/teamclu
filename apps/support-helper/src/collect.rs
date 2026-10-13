use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

pub const LOG_TAIL_MAX_LINES: usize = 500;
pub const LOG_TAIL_MAX_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalEntry {
    pub ts: String,
    pub step: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WebView2 {
    pub present: Option<bool>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Processes {
    pub teamclu: bool,
    pub amuxd: bool,
    pub installer: bool,
}

pub fn parse_journal(text: &str) -> Vec<JournalEntry> {
    text.lines()
        .filter_map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).ok()?;
            Some(JournalEntry {
                ts: value.get("ts")?.as_str()?.to_string(),
                step: value.get("step")?.as_str()?.to_string(),
                ok: value.get("ok")?.as_bool()?,
                detail: value
                    .get("detail")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

pub fn last_detail<'a>(entries: &'a [JournalEntry], step: &str) -> Option<&'a str> {
    entries
        .iter()
        .rev()
        .find(|entry| entry.step == step)
        .map(|entry| entry.detail.as_str())
        .filter(|detail| !detail.is_empty())
}

pub fn webview_probe(entries: &[JournalEntry]) -> Option<String> {
    entries.iter().rev().find_map(|entry| {
        if entry.step != "webview_restart" && entry.step != "webview_launch_helper" {
            return None;
        }
        match entry.detail.as_str() {
            "MissingWindow" | "Unresponsive" => Some(entry.detail.clone()),
            _ => None,
        }
    })
}

pub fn interpret_webview2(reads: &[Result<Option<String>, ()>]) -> WebView2 {
    for read in reads {
        if let Ok(Some(value)) = read {
            if !value.is_empty() {
                return WebView2 {
                    present: Some(true),
                    version: Some(value.clone()),
                };
            }
        }
    }
    if reads.iter().any(|read| read.is_err()) {
        return WebView2 {
            present: None,
            version: None,
        };
    }
    WebView2 {
        present: Some(false),
        version: None,
    }
}

pub fn process_image_names(os: &str) -> (&'static str, &'static str) {
    if os == "windows" {
        ("TeamClu.exe", "amuxd.exe")
    } else {
        ("TeamClu", "amuxd")
    }
}

pub fn process_flags(running: impl Fn(&str) -> bool, installer_image: Option<&str>) -> Processes {
    process_flags_for("windows", running, installer_image)
}

pub fn process_flags_for(
    os: &str,
    running: impl Fn(&str) -> bool,
    installer_image: Option<&str>,
) -> Processes {
    let (teamclu, amuxd) = process_image_names(os);
    Processes {
        teamclu: running(teamclu),
        amuxd: running(amuxd),
        installer: installer_image.map(running).unwrap_or(false),
    }
}

pub fn probe_writable(dir: &Path) -> bool {
    let probe = dir.join(".teamclu-support-write-test");
    let mut file = match fs::File::create(&probe) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let wrote = file.write_all(b"ok").is_ok();
    drop(file);
    let _ = fs::remove_file(&probe);
    wrote
}

pub fn tail_text(input: &str) -> String {
    let lines: Vec<&str> = input.lines().collect();
    let start = lines.len().saturating_sub(LOG_TAIL_MAX_LINES);
    let mut joined = lines[start..].join("\n");
    if joined.len() <= LOG_TAIL_MAX_BYTES {
        return joined;
    }
    let mut cut = joined.len() - LOG_TAIL_MAX_BYTES;
    while cut < joined.len() && !joined.is_char_boundary(cut) {
        cut += 1;
    }
    joined = joined[cut..].to_string();
    joined
}

pub fn read_log_file(name: &str, path: &Path) -> LogFile {
    match fs::read_to_string(path) {
        Ok(text) => LogFile {
            name: name.into(),
            present: true,
            tail: Some(tail_text(&text)),
        },
        Err(_) => LogFile {
            name: name.into(),
            present: false,
            tail: None,
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogFile {
    pub name: String,
    pub present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tail: Option<String>,
}

pub fn read_named_log(name: &str, path: &Path) -> LogFile {
    read_log_file(name, path)
}

pub fn read_desktop_logs(dir: &Path) -> LogFile {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => {
            return LogFile {
                name: "desktop".into(),
                present: false,
                tail: None,
            };
        }
    };
    let mut parts = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("log") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("app.log");
            parts.push(format!("=== {name} ===\n{}", tail_text(&text)));
        }
    }
    if parts.is_empty() {
        return LogFile {
            name: "desktop".into(),
            present: false,
            tail: None,
        };
    }
    LogFile {
        name: "desktop".into(),
        present: true,
        tail: Some(tail_text(&parts.join("\n\n"))),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub os: &'static str,
    pub os_version: String,
    pub arch: String,
    pub helper_version: String,
    pub phase: String,
    pub webview2: WebView2,
    pub install_dir: Option<String>,
    pub install_dir_writable: Option<bool>,
    pub processes: Processes,
    pub webview_probe: Option<String>,
}

pub struct Gathered {
    pub os: &'static str,
    pub phase: String,
    pub helper_version: String,
    pub os_version: String,
    pub arch: String,
    pub journal_text: String,
    pub webview2: WebView2,
    pub processes: Processes,
    pub logs: Vec<LogFile>,
}

pub fn build_bundle(gathered: Gathered) -> serde_json::Value {
    let entries = parse_journal(&gathered.journal_text);
    let install_dir = last_detail(&entries, "install_dir").map(str::to_string);
    let writable = install_dir
        .as_deref()
        .map(|dir| probe_writable(Path::new(dir)));
    let snapshot = Snapshot {
        os: gathered.os,
        os_version: gathered.os_version,
        arch: gathered.arch,
        helper_version: gathered.helper_version,
        phase: gathered.phase,
        webview2: gathered.webview2,
        install_dir,
        install_dir_writable: writable,
        processes: gathered.processes,
        webview_probe: webview_probe(&entries),
    };
    serde_json::json!({
        "snapshot": snapshot,
        "journal": entries.iter().map(|entry| serde_json::json!({
            "ts": entry.ts,
            "step": entry.step,
            "ok": entry.ok,
            "detail": entry.detail,
        })).collect::<Vec<_>>(),
        "logs": gathered.logs,
    })
}

pub fn journal_path(home: &Path) -> PathBuf {
    home.join(".teamclu").join("support").join("journal.jsonl")
}

pub fn amuxd_log(home: &Path, name: &str) -> PathBuf {
    home.join(".amuxd").join("logs").join(name)
}

pub fn desktop_log_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("com.teamclu.app").join("logs")
}

/// macOS logs live in `~/Library/Logs/<bundle id>`, which is not `config_dir`.
pub fn desktop_log_dir_for(os: &str, home: &Path, config_dir: &Path) -> PathBuf {
    if os == "macos" {
        home.join("Library").join("Logs").join("com.teamclu.app")
    } else {
        desktop_log_dir(config_dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("teamclu-support-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_install_dir_stays_null() {
        let bundle = build_bundle(Gathered {
            os: "windows",
            phase: "install".into(),
            helper_version: "0.0.0".into(),
            os_version: "10.0.1".into(),
            arch: "x86_64".into(),
            journal_text: "{\"ts\":\"2026-10-13T00:00:00Z\",\"step\":\"stop_sidecars\",\"ok\":true,\"detail\":\"0\"}\n".into(),
            webview2: interpret_webview2(&[Ok(None), Ok(None)]),
            processes: process_flags(|_| false, None),
            logs: vec![],
        });
        assert_eq!(bundle["snapshot"]["os"], "windows");
        assert!(bundle["snapshot"]["installDir"].is_null());
        assert!(bundle["snapshot"]["installDirWritable"].is_null());
        assert_eq!(bundle["snapshot"]["webview2"]["present"], false);
        assert_eq!(bundle["snapshot"]["processes"]["installer"], false);
    }

    #[test]
    fn webview2_read_failure_is_unknown() {
        let info = interpret_webview2(&[Err(()), Ok(None)]);
        assert_eq!(info.present, None);
        let found = interpret_webview2(&[Ok(None), Ok(Some("120.0.1".into()))]);
        assert_eq!(found.present, Some(true));
        assert_eq!(found.version.as_deref(), Some("120.0.1"));
    }

    #[test]
    fn missing_log_is_not_a_failure() {
        let file = read_named_log("amuxd.log", Path::new("/no/such/teamclu-support-log"));
        assert!(!file.present);
        assert!(file.tail.is_none());
    }

    #[test]
    fn tail_keeps_the_last_500_lines_and_256_kib() {
        let mut lines = String::new();
        for i in 0..600 {
            lines.push_str(&format!("line-{i}\n"));
        }
        let tailed = tail_text(&lines);
        assert_eq!(tailed.lines().count(), 500);
        assert!(tailed.contains("line-599"));
        assert!(!tailed.contains("line-0\n") && !tailed.starts_with("line-0"));

        let big = "字".repeat(LOG_TAIL_MAX_BYTES);
        let cut = tail_text(&big);
        assert!(cut.len() <= LOG_TAIL_MAX_BYTES);
        assert!(cut.is_char_boundary(0));
    }

    #[test]
    fn writable_probe_uses_the_directory() {
        let dir = scratch();
        assert!(probe_writable(&dir));
        let missing = dir.join("missing");
        assert!(!probe_writable(&missing));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn macos_names_and_log_dir_differ_from_windows() {
        assert_eq!(process_image_names("macos"), ("TeamClu", "amuxd"));
        assert_eq!(process_image_names("windows"), ("TeamClu.exe", "amuxd.exe"));
        let home = Path::new("/Users/ada");
        let config = Path::new("/Users/ada/Library/Application Support");
        assert_eq!(
            desktop_log_dir_for("macos", home, config),
            PathBuf::from("/Users/ada/Library/Logs/com.teamclu.app")
        );
        assert_eq!(
            desktop_log_dir_for("windows", home, config),
            config.join("com.teamclu.app").join("logs")
        );
        let flags = process_flags_for("macos", |image| image == "TeamClu", None);
        assert!(flags.teamclu);
        assert!(!flags.amuxd);
    }

    #[test]
    fn last_webview_probe_wins() {
        let text = "\
{\"ts\":\"t\",\"step\":\"webview_restart\",\"ok\":true,\"detail\":\"MissingWindow\"}
{\"ts\":\"t\",\"step\":\"webview_launch_helper\",\"ok\":true,\"detail\":\"Unresponsive\"}
";
        assert_eq!(
            webview_probe(&parse_journal(text)).as_deref(),
            Some("Unresponsive")
        );
    }
}
