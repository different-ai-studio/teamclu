use serde::Deserialize;

use crate::local_cache::{
    commands::LocalCacheState,
    store::{LocalCacheStore, MessageRow},
};
use crate::session_export::{export_from_rows, ExportOptions};

#[derive(Debug, Clone, Deserialize)]
pub struct SessionExportRequest {
    pub session_id: Option<String>,
    pub workspace_path: Option<String>,
    pub format: Option<String>,
    pub include_thinking: Option<bool>,
    pub include_tools: Option<bool>,
    pub sanitize: Option<bool>,
}

fn default_format() -> &'static str {
    "opencode_compat"
}

async fn get_db(state: &LocalCacheState) -> Result<LocalCacheStore, String> {
    let mut db_lock = state.db.lock().await;
    if let Some(ref db) = *db_lock {
        return Ok(db.clone());
    }
    let db_path = crate::commands::brand_home_dir().join("local-cache.db");
    let db = LocalCacheStore::new(&db_path).await?;
    *db_lock = Some(db.clone());
    Ok(db)
}

fn resolve_session_id(req: &SessionExportRequest) -> Result<String, String> {
    let session_id = req
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "session_id is required".to_string())?;
    Ok(session_id.to_string())
}

fn validate_format(req: &SessionExportRequest) -> Result<(), String> {
    let format = req.format.as_deref().unwrap_or(default_format());
    if format != default_format() {
        return Err(format!(
            "Unsupported format: {} (expected {})",
            format,
            default_format()
        ));
    }
    Ok(())
}

async fn load_messages_for_export(
    cache_state: &LocalCacheState,
    session_id: &str,
    workspace_path: Option<&str>,
) -> Result<Vec<MessageRow>, String> {
    let db = get_db(cache_state).await?;
    db.message_load_session(session_id, false, workspace_path)
        .await
}

pub async fn export_session_handler(
    cache_state: &LocalCacheState,
    req: SessionExportRequest,
) -> Result<String, String> {
    validate_format(&req)?;
    let session_id = resolve_session_id(&req)?;
    let rows =
        load_messages_for_export(cache_state, &session_id, req.workspace_path.as_deref()).await?;

    let bundle = export_from_rows(
        &session_id,
        &rows,
        ExportOptions {
            include_thinking: req.include_thinking.unwrap_or(true),
            include_tools: req.include_tools.unwrap_or(true),
            sanitize: req.sanitize.unwrap_or(true),
            include_system: true,
        },
    )?;

    serde_json::to_string(&bundle).map_err(|e| format!("Failed to serialize export bundle: {e}"))
}
