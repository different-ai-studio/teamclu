use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub fn support_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".teamclu").join("support"))
}

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub fn read_restart_count(dir: &Path) -> u32 {
    fs::read_to_string(dir.join("webview-restart-count"))
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub fn write_restart_count(dir: &Path, count: u32) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    fs::write(dir.join("webview-restart-count"), count.to_string())
}

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub fn append_journal(step: &str, ok: bool, detail: &str) {
    let Some(dir) = support_dir() else {
        return;
    };
    let _ = append_journal_at(&dir, step, ok, detail);
}

pub fn append_journal_at(dir: &Path, step: &str, ok: bool, detail: &str) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let line = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "step": step,
        "ok": ok,
        "detail": detail,
    });
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("journal.jsonl"))?;
    writeln!(file, "{line}")
}

#[cfg(test)]
mod tests {
    use super::{append_journal_at, read_restart_count, write_restart_count};

    #[test]
    fn restart_count_missing_is_zero_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("teamclu-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read_restart_count(&dir), 0);
        write_restart_count(&dir, 1).unwrap();
        assert_eq!(read_restart_count(&dir), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn journal_line_keeps_step_and_detail() {
        let dir = std::env::temp_dir().join(format!("teamclu-journal-line-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        append_journal_at(&dir, "webview_restart", true, "Unresponsive").unwrap();
        let text = std::fs::read_to_string(dir.join("journal.jsonl")).unwrap();
        let value: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(value["step"], "webview_restart");
        assert_eq!(value["ok"], true);
        assert_eq!(value["detail"], "Unresponsive");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
