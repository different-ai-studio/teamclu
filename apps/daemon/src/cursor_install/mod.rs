//! Cursor SDK bridge discovery for `amuxd doctor`.

use serde::Serialize;

use crate::process_util::CommandNoWindow;
use crate::runtime::cursor_sdk::process::{default_bridge_command, default_bridge_main};
use crate::runtime::sidecar::bridge_path::sdk_installed_for_main;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorStatus {
    pub node_present: bool,
    pub bridge_script_present: bool,
    pub api_key_present: bool,
    pub sdk_installed: bool,
    pub bridge_command: Vec<String>,
    pub satisfied: bool,
}

pub fn doctor() -> CursorStatus {
    let bridge_command = default_bridge_command();
    let main = default_bridge_main();
    let bridge_script_present = main.is_file();
    let node_present = which_node().is_some();
    let api_key_present = std::env::var("CURSOR_API_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
        .is_some()
        || personal_store_has_cursor_api_key();
    let sdk_installed = sdk_installed_for_main(&main);
    let satisfied = node_present && bridge_script_present && api_key_present && sdk_installed;
    CursorStatus {
        node_present,
        bridge_script_present,
        api_key_present,
        sdk_installed,
        bridge_command,
        satisfied,
    }
}

fn which_node() -> Option<String> {
    // node is the one dependency of the cursor bridge we can look for
    // ourselves; a Homebrew node is invisible to a GUI-launched daemon's PATH.
    let out = std::process::Command::new("node")
        .no_window()
        .arg("--version")
        .env("PATH", crate::runtime::well_known_bin::augmented_path())
        .output()
        .ok()?;
    out.status.success().then(|| "node".to_string())
}

fn personal_store_has_cursor_api_key() -> bool {
    crate::runtime::personal_api_key("CURSOR_API_KEY").is_some()
}
