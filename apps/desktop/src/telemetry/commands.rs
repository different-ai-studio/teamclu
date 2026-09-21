use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ConsentState {
    Granted,
    Denied,
    Undecided,
}

#[derive(Serialize, Deserialize)]
struct ConsentFile {
    state: ConsentState,
}

/// Brand-scoped: a white-label build stored the user's telemetry choice in the
/// *official* namespace while this path was hardcoded.
fn consent_path() -> Result<PathBuf, String> {
    Ok(crate::commands::brand_home_dir().join("telemetry-consent.json"))
}

#[tauri::command]
pub async fn telemetry_get_consent(_app: AppHandle) -> Result<ConsentState, String> {
    let path = consent_path()?;
    if !path.exists() {
        return Ok(ConsentState::Undecided);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: ConsentFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(file.state)
}

#[tauri::command]
pub async fn telemetry_set_consent(_app: AppHandle, state: ConsentState) -> Result<(), String> {
    let path = consent_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&ConsentFile { state }).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(())
}

/// Forward a product event to Aptabase, but only when the user has explicitly
/// granted telemetry consent. Lifecycle events (`app_started`/`app_active`/
/// `app_exited`) are emitted unconditionally elsewhere; these richer product
/// events are opt-in.
#[tauri::command]
pub async fn telemetry_track(
    app: AppHandle,
    event_name: String,
    props: Option<serde_json::Value>,
) -> Result<(), String> {
    if !matches!(
        telemetry_get_consent(app.clone()).await?,
        ConsentState::Granted
    ) {
        return Ok(());
    }
    super::track(&app, &event_name, props);
    Ok(())
}
