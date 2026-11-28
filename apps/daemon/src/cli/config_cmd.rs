//! `amuxd config path|ls|show|set|rm` (`list`, `get`, `unset` still parse).
//!
//! A thin CLI over [`crate::config::edit`], which the HTTP config endpoints
//! also use. Keep the logic there, not here, so `amuxd config set` and the
//! setup UI cannot diverge on validation.
//!
//! `show <key>` does *not* redact: its caller already has read access to
//! `daemon.toml`, and redacting would make `config show mqtt.password`
//! useless. `ls` masks credentials, since it is what an agent reaches for to
//! look around and it has no reason to pull every secret into its context.
//! Output: the `amuxd app` contract.

use serde_json::{json, Value};

use super::envelope::{emit, error_envelope, success};
use crate::cli::{ConfigAction, ConfigArgs};
use crate::config::edit;

/// A TOML value as JSON (datetimes as their string form).
fn to_json(value: &toml::Value) -> Value {
    serde_json::to_value(value).unwrap_or_else(|_| json!(value.to_string()))
}

fn failed(e: anyhow::Error) -> Value {
    let message = e.to_string();
    if message.starts_with("missing key") {
        return error_envelope("not_found", &message, Some("amuxd config ls"), 5, false);
    }
    error_envelope("config_error", &message, None, 2, false)
}

fn act(action: ConfigAction, path: &std::path::Path) -> Value {
    match action {
        ConfigAction::Path => success(json!({ "path": path.display().to_string() })),
        ConfigAction::Ls => match edit::flatten_config(path) {
            Ok(pairs) => {
                let rows: Vec<Value> = pairs
                    .into_iter()
                    .map(|(key, value)| {
                        let shown = if edit::is_secret_key(&key) {
                            json!("(set)")
                        } else {
                            to_json(&value)
                        };
                        json!({ "key": key, "value": shown })
                    })
                    .collect();
                success(json!({ "items": rows }))
            }
            Err(e) => failed(e),
        },
        ConfigAction::Show { key } => match edit::get_config_toml_value(path, &key) {
            Ok(value) => success(json!({ "key": key, "value": to_json(&value) })),
            Err(e) => failed(e),
        },
        ConfigAction::Set { key, value } => {
            match edit::set_config_value(path, &key, &value)
                .and_then(|()| edit::get_config_toml_value(path, &key))
            {
                Ok(stored) => success(json!({ "key": key, "value": to_json(&stored) })),
                Err(e) => failed(e),
            }
        }
        ConfigAction::Rm { key } => match edit::unset_config_value(path, &key) {
            Ok(()) => success(json!({ "key": key, "removed": true })),
            Err(e) => failed(e),
        },
    }
}

/// Run one command; returns the process exit status.
pub fn run(args: ConfigArgs, default_config_path: &std::path::Path) -> anyhow::Result<i32> {
    let path = args
        .config
        .clone()
        .unwrap_or_else(|| default_config_path.to_path_buf());
    Ok(emit(&args.output, act(args.action, &path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        std::fs::write(
            &path,
            "[actor]\nid = \"actor-1\"\nname = \"Mac\"\n\n[mqtt]\nbroker_url = \"mqtts://broker.example\"\npassword = \"hunter2\"\n",
        )
        .unwrap();
        (dir, path)
    }

    #[test]
    fn set_show_rm_round_trip_as_json() {
        let (dir, path) = fixture();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(dir.path());
        let key = || "idle_runtime_timeout_secs".to_string();
        let set = act(
            ConfigAction::Set {
                key: key(),
                value: "1800".into(),
            },
            &path,
        );
        assert_eq!(set["data"]["value"], 1800, "{set}");
        let shown = act(ConfigAction::Show { key: key() }, &path);
        assert_eq!(shown["data"]["value"], 1800);
        assert_eq!(act(ConfigAction::Rm { key: key() }, &path)["ok"], true);
        let missing = act(ConfigAction::Show { key: key() }, &path);
        assert_eq!(missing["error"]["exit"], 5, "{missing}");
    }

    #[test]
    fn ls_masks_credentials_and_show_does_not() {
        let (dir, path) = fixture();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(dir.path());
        let listed = act(ConfigAction::Ls, &path);
        let rows = listed["data"]["items"].as_array().unwrap();
        let password = rows.iter().find(|r| r["key"] == "mqtt.password").unwrap();
        assert_eq!(password["value"], "(set)");
        let shown = act(
            ConfigAction::Show {
                key: "mqtt.password".into(),
            },
            &path,
        );
        assert_eq!(shown["data"]["value"], "hunter2");
    }
}
