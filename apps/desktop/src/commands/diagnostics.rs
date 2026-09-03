//! One-click diagnostic bundle: doctor output, requirements, team env chain, log tails.

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use super::env_vars::TeamEnvDiagnostics;
use super::setup::{read_doctor, setup_list_requirements, RequirementStatus};

const LOG_TAIL_LINES: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTails {
    pub amuxd: Option<String>,
    pub acp_stream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTailsExpanded {
    pub app: Option<String>,
    /// The daemon's own rotating diary (`logs/amuxd.log`) — its tracing output.
    pub amuxd_log: Option<String>,
    /// Desktop-managed spawn redirect (`amuxd.managed.log`): panics, pre-init
    /// prints and child output — everything tracing cannot capture.
    pub amuxd_managed: Option<String>,
    /// Legacy LaunchAgent-era stdout (may be absent under managed mode).
    pub amuxd_out: Option<String>,
    /// Legacy LaunchAgent-era stderr (may be absent under managed mode).
    pub amuxd_err: Option<String>,
    pub acp_stream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBundleParts {
    pub doctor: Option<serde_json::Value>,
    pub requirements: Vec<RequirementStatus>,
    pub team_env: Option<TeamEnvDiagnostics>,
    pub log_tails: LogTails,
}

fn amuxd_dir() -> Option<PathBuf> {
    Some(super::amuxd_home_dir())
}

fn amuxd_logs_dir_opt() -> Option<PathBuf> {
    Some(super::amuxd_logs_dir())
}

fn amuxd_out_log_path() -> Option<PathBuf> {
    amuxd_logs_dir_opt().map(|d| d.join("amuxd.out.log"))
}

fn amuxd_err_log_path() -> Option<PathBuf> {
    amuxd_logs_dir_opt().map(|d| d.join("amuxd.err.log"))
}

fn amuxd_log_path() -> Option<PathBuf> {
    amuxd_logs_dir_opt().map(|d| d.join("amuxd.log"))
}

fn amuxd_managed_log_path() -> Option<PathBuf> {
    amuxd_logs_dir_opt().map(|d| d.join("amuxd.managed.log"))
}

fn tail_file(path: &Path, max_lines: usize) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    Some(lines[start..].join("\n"))
}

fn redact_log_text(input: &str) -> String {
    static RE_BEARER: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static RE_JWT: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static RE_SK: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

    let bearer = RE_BEARER.get_or_init(|| Regex::new(r"(?i)(Bearer\s+)\S+").unwrap());
    let jwt = RE_JWT
        .get_or_init(|| Regex::new(r"\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b").unwrap());
    let sk = RE_SK.get_or_init(|| Regex::new(r"\bsk-[A-Za-z0-9_-]{8,}\b").unwrap());

    let mut out = bearer.replace_all(input, "${1}[redacted]").into_owned();
    out = jwt.replace_all(&out, "[redacted-jwt]").into_owned();
    out = sk.replace_all(&out, "[redacted-key]").into_owned();
    out
}

fn tail_app_logs<R: Runtime>(app: &AppHandle<R>, max_lines: usize) -> Option<String> {
    let dir = app.path().app_log_dir().ok()?;
    let mut parts = Vec::new();
    let entries = std::fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        if let Some(tail) = tail_file(&path, max_lines) {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "app.log".into());
            parts.push(format!("=== {name} ===\n{tail}"));
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(redact_log_text(&parts.join("\n\n")))
    }
}

fn merge_amuxd_logs(
    rotating: Option<String>,
    managed: Option<String>,
    out: Option<String>,
    err: Option<String>,
) -> Option<String> {
    // The daemon's own rotating diary carries its tracing output; the managed
    // redirect only catches panics / pre-init prints. Prefer the diary, fall
    // back to the redirect, then to the legacy LaunchAgent streams.
    if rotating.is_some() {
        return rotating;
    }
    if managed.is_some() {
        return managed;
    }
    match (out, err) {
        (None, None) => None,
        (Some(o), None) => Some(o),
        (None, Some(e)) => Some(e),
        (Some(o), Some(e)) => Some(format!("=== stdout ===\n{o}\n\n=== stderr ===\n{e}")),
    }
}

fn collect_log_tails_expanded<R: Runtime>(
    app: &AppHandle<R>,
    max_lines: usize,
) -> LogTailsExpanded {
    let amuxd_log = amuxd_log_path()
        .filter(|p| p.exists())
        .and_then(|p| tail_file(&p, max_lines))
        .map(|s| redact_log_text(&s));

    let amuxd_managed = amuxd_managed_log_path()
        .filter(|p| p.exists())
        .and_then(|p| tail_file(&p, max_lines))
        .map(|s| redact_log_text(&s));

    let amuxd_out = amuxd_out_log_path()
        .filter(|p| p.exists())
        .and_then(|p| tail_file(&p, max_lines))
        .map(|s| redact_log_text(&s));

    let amuxd_err = amuxd_err_log_path()
        .filter(|p| p.exists())
        .and_then(|p| tail_file(&p, max_lines))
        .map(|s| redact_log_text(&s));

    let acp_stream = app
        .path()
        .app_log_dir()
        .ok()
        .map(|d| d.join("acp-stream").join("_all.log"))
        .filter(|p| p.exists())
        .and_then(|p| tail_file(&p, max_lines))
        .map(|s| redact_log_text(&s));

    LogTailsExpanded {
        app: tail_app_logs(app, max_lines),
        amuxd_log,
        amuxd_managed,
        amuxd_out,
        amuxd_err,
        acp_stream,
    }
}

fn collect_log_tails<R: Runtime>(app: &AppHandle<R>) -> LogTails {
    let expanded = collect_log_tails_expanded(app, LOG_TAIL_LINES);
    LogTails {
        amuxd: merge_amuxd_logs(
            expanded.amuxd_log.clone(),
            expanded.amuxd_managed.clone(),
            expanded.amuxd_out.clone(),
            expanded.amuxd_err.clone(),
        ),
        acp_stream: expanded.acp_stream,
    }
}

fn gather_team_env_diagnostics(workspace_path: &str, team_id: Option<&str>) -> TeamEnvDiagnostics {
    let team_id_trimmed = team_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let ws = Path::new(workspace_path);

    let link = teamclu_runtime_env::env_catalog::resolve_team_dir_for_workspace(ws);
    let symlink_meta = std::fs::symlink_metadata(&link).ok();
    let link_is_symlink = symlink_meta
        .as_ref()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    let link_target = if link_is_symlink {
        std::fs::read_link(&link)
            .ok()
            .map(|p| p.display().to_string())
    } else {
        None
    };
    let target_accessible = std::fs::metadata(&link).is_ok();

    let (cloud_secrets_dir, secrets_dir_exists, secret_file_count) =
        super::env_vars::team_cloud_secrets_diag(team_id_trimmed.as_deref());

    let legacy_secrets_dir = link.join(super::shared_secrets::SECRETS_DIR);
    let legacy_secrets_dir_exists = legacy_secrets_dir.exists();
    let legacy_secret_file_count = super::env_vars::count_enc_json_files(&legacy_secrets_dir);

    let secret_configured = teamclu_runtime_env::env_catalog::resolve_team_env_secret(
        ws,
        team_id_trimmed.as_deref(),
        None,
    )
    .is_some();

    TeamEnvDiagnostics {
        team_id_present: team_id_trimmed.is_some(),
        team_link_path: link.display().to_string(),
        link_exists: symlink_meta.is_some(),
        link_is_symlink,
        link_target,
        target_accessible,
        secrets_dir_exists,
        secret_file_count,
        cloud_secrets_dir,
        legacy_secrets_dir_exists,
        legacy_secret_file_count,
        secret_configured,
    }
}

#[tauri::command]
pub async fn collect_diagnostic_bundle<R: Runtime>(
    app: AppHandle<R>,
    team_id: Option<String>,
    workspace_path: Option<String>,
    local_agent: Option<String>,
) -> Result<DiagnosticBundleParts, String> {
    let doctor = read_doctor(&app, local_agent.as_deref()).await;
    let requirements = setup_list_requirements(app.clone(), local_agent).await?;

    let team_env = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|wp| gather_team_env_diagnostics(wp, team_id.as_deref()));

    let log_tails = collect_log_tails(&app);

    Ok(DiagnosticBundleParts {
        doctor,
        requirements,
        team_env,
        log_tails,
    })
}

/// Tail every log the debug console shows.
///
/// `async` + `spawn_blocking` because this reads six files, several of them
/// hundreds of KB, and the console polls it while open; inline it ran on the
/// main thread once a second.
#[tauri::command]
pub async fn tail_log_files<R: Runtime>(
    app: AppHandle<R>,
    max_lines: usize,
) -> Result<LogTailsExpanded, String> {
    let lines = if max_lines == 0 {
        LOG_TAIL_LINES
    } else {
        max_lines
    };
    tokio::task::spawn_blocking(move || collect_log_tails_expanded(&app, lines))
        .await
        .map_err(|e| format!("tail_log_files task failed: {e}"))
}

#[tauri::command]
pub async fn reveal_log_directory<R: Runtime>(
    app: AppHandle<R>,
    kind: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = match kind.as_str() {
            "app" => app
                .path()
                .app_log_dir()
                .map_err(|e| format!("app log dir: {e}"))?,
            "daemon" => amuxd_dir().ok_or_else(|| "home dir unavailable".to_string())?,
            "acp" => app
                .path()
                .app_log_dir()
                .map_err(|e| format!("app log dir: {e}"))?
                .join("acp-stream"),
            other => return Err(format!("unknown log directory kind: {other}")),
        };

        if !path.exists() {
            std::fs::create_dir_all(&path)
                .map_err(|e| format!("create {}: {e}", path.display()))?;
        }

        super::show_in_folder_blocking(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("reveal_log_directory task failed: {e}"))?
}

fn write_zip_entry(
    writer: &mut ZipWriter<Cursor<Vec<u8>>>,
    name: &str,
    content: &str,
) -> Result<(), String> {
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    writer
        .start_file(name, opts)
        .map_err(|e| format!("zip start {name}: {e}"))?;
    writer
        .write_all(content.as_bytes())
        .map_err(|e| format!("zip write {name}: {e}"))?;
    Ok(())
}

/// Zip the report plus every log tail. Reads the same six files as
/// [`tail_log_files`] and deflates them, so it is kept off the main thread too.
#[tauri::command]
pub async fn build_diagnostic_zip<R: Runtime>(
    app: AppHandle<R>,
    report_json: String,
) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || build_diagnostic_zip_blocking(&app, &report_json))
        .await
        .map_err(|e| format!("build_diagnostic_zip task failed: {e}"))?
}

fn build_diagnostic_zip_blocking<R: Runtime>(
    app: &AppHandle<R>,
    report_json: &str,
) -> Result<Vec<u8>, String> {
    let log_tails = collect_log_tails(app);
    let expanded = collect_log_tails_expanded(app, LOG_TAIL_LINES);
    let version = app.package_info().version.to_string();
    let meta = format!(
        "app={}\nversion={}\nos={}\narch={}\ngenerated_at={}\n",
        app.package_info().name,
        version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        chrono::Utc::now().to_rfc3339(),
    );

    let buf = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(buf);

    write_zip_entry(&mut writer, "diagnostic-report.json", report_json)?;
    write_zip_entry(&mut writer, "meta.txt", &meta)?;

    if let Ok(report) = serde_json::from_str::<serde_json::Value>(report_json) {
        if let Some(console) = report.pointer("/details/consoleTail") {
            let text =
                serde_json::to_string_pretty(console).unwrap_or_else(|_| console.to_string());
            write_zip_entry(&mut writer, "logs/console.json", &text)?;
        }
        if let Some(state) = report.pointer("/details/runtimeState") {
            let text = serde_json::to_string_pretty(state).unwrap_or_else(|_| state.to_string());
            write_zip_entry(&mut writer, "state/runtime-snapshot.json", &text)?;
        }
    }

    if let Some(app_log) = expanded.app {
        write_zip_entry(&mut writer, "logs/app.log", &app_log)?;
    }
    if let Some(amuxd) = log_tails.amuxd {
        write_zip_entry(&mut writer, "logs/amuxd.log", &amuxd)?;
    }
    if let Some(managed) = expanded.amuxd_managed {
        write_zip_entry(&mut writer, "logs/amuxd.managed.log", &managed)?;
    }
    if let Some(out) = expanded.amuxd_out {
        write_zip_entry(&mut writer, "logs/amuxd.out.log", &out)?;
    }
    if let Some(err) = expanded.amuxd_err {
        write_zip_entry(&mut writer, "logs/amuxd.err.log", &err)?;
    }
    if let Some(acp) = log_tails.acp_stream {
        write_zip_entry(&mut writer, "logs/acp-stream.log", &acp)?;
    }

    let finished = writer.finish().map_err(|e| format!("zip finish: {e}"))?;
    Ok(finished.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_log_strips_bearer_and_jwt() {
        let input = "auth Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig token sk-abcdefghijklmnop";
        let out = redact_log_text(input);
        assert!(out.contains("Bearer [redacted]"));
        assert!(!out.contains("eyJhbGci"));
        assert!(out.contains("[redacted-key]"));
    }

    #[test]
    fn tail_file_returns_last_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.log");
        std::fs::write(&path, "line1\nline2\nline3\n").unwrap();
        let tail = tail_file(&path, 2).unwrap();
        assert_eq!(tail, "line2\nline3");
    }

    #[test]
    fn merge_amuxd_logs_prefers_the_rotating_diary() {
        let merged = merge_amuxd_logs(
            Some("rotating diary".into()),
            Some("managed diary".into()),
            Some("stdout line".into()),
            Some("stderr line".into()),
        )
        .unwrap();
        assert_eq!(merged, "rotating diary");

        let merged = merge_amuxd_logs(
            None,
            Some("managed diary".into()),
            Some("stdout line".into()),
            None,
        )
        .unwrap();
        assert_eq!(merged, "managed diary");
    }

    #[test]
    fn merge_amuxd_logs_combines_legacy_streams() {
        let merged = merge_amuxd_logs(
            None,
            None,
            Some("stdout line".into()),
            Some("stderr line".into()),
        )
        .unwrap();
        assert!(merged.contains("stdout line"));
        assert!(merged.contains("stderr line"));
    }

    #[test]
    fn amuxd_log_paths_use_amuxd_dir() {
        let out = amuxd_out_log_path().unwrap();
        let err = amuxd_err_log_path().unwrap();
        let managed = amuxd_managed_log_path().unwrap();
        // Logs live under `logs/`, not loose at the amuxd root
        // (docs/architecture/amuxd-home-layout-v2.md §2).
        assert!(out.ends_with(".amuxd/logs/amuxd.out.log"));
        assert!(err.ends_with(".amuxd/logs/amuxd.err.log"));
        assert!(managed.ends_with(".amuxd/logs/amuxd.managed.log"));
    }
}
