//! Layout choices the user made (first column pinned or a rail, session drawer
//! pinned), kept in a file under the app config dir.
//!
//! The webview's localStorage holds them too, as the synchronous copy the UI
//! reads at startup, but it lives in WebKit's website data: cleaners, a reset
//! of that data or a changed bundle identifier drop it. This file is beside
//! `window-close.json` and survives updates and reinstalls, so the frontend
//! restores from it when the two disagree.
//!
//! Only the keys in `KNOWN_KEYS` are stored, and only as booleans: this is a
//! place for a handful of switches, not a general-purpose store.

use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

const FILE: &str = "ui-layout.json";
const KNOWN_KEYS: &[&str] = &["navPinned", "sessionDrawerPinned"];

/// Serialises writes so two quick toggles cannot interleave read-modify-write.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    Ok(dir.join(FILE))
}

fn read(path: &PathBuf) -> Map<String, Value> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|v| match v {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn keep_known(map: Map<String, Value>) -> Map<String, Value> {
    map.into_iter()
        .filter(|(k, v)| KNOWN_KEYS.contains(&k.as_str()) && v.is_boolean())
        .collect()
}

#[tauri::command]
pub fn get_ui_layout_prefs(app: tauri::AppHandle) -> Result<Map<String, Value>, String> {
    Ok(keep_known(read(&path(&app)?)))
}

#[tauri::command]
pub fn set_ui_layout_pref(app: tauri::AppHandle, key: String, value: bool) -> Result<(), String> {
    if !KNOWN_KEYS.contains(&key.as_str()) {
        return Err(format!("unknown layout pref: {key}"));
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = path(&app)?;
    let mut map = keep_known(read(&path));
    map.insert(key, Value::Bool(value));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    // Write-then-rename, so a crash mid-write cannot leave a truncated file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write {FILE}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {FILE}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_only_known_boolean_keys() {
        let map = match json!({
            "navPinned": true,
            "sessionDrawerPinned": "yes",
            "other": false,
        }) {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        let kept = keep_known(map);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept.get("navPinned"), Some(&Value::Bool(true)));
    }
}
