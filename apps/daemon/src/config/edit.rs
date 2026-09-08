//! Dotted-key reads and writes against `daemon.toml`.
//!
//! One implementation shared by `amuxd config …` (see `cli::config_cmd`) and
//! the HTTP config endpoints (see `http::config`), so the CLI and the setup UI
//! cannot drift on validation or redaction rules.
//!
//! Every write goes through [`write_config`], which round-trips the edited
//! document through [`DaemonConfig`] and refuses to persist anything that
//! would not parse back. That is what makes a config API safe to expose: a
//! browser cannot brick the daemon by PUTting a malformed value.

use std::path::Path;
use toml::Value;

/// Leaf key names whose values are credentials.
///
/// Matched on the **leaf** rather than the full dotted path so nested and
/// repeated sections are covered without enumeration — notably
/// `channels.wecom.bots[N].secret`, where N is unbounded.
///
/// Erring toward over-redaction is deliberate: a new secret-bearing channel
/// field is far more likely to reuse one of these names than to invent a new
/// one, and over-redacting hides a value the operator can still overwrite,
/// while under-redacting leaks it to any browser holding a scoped token.
const SECRET_LEAF_KEYS: &[&str] = &[
    "password",
    "secret",
    "api_key",
    "bot_token",
    "app_secret",
    "encoding_aes_key",
    "ilink_token",
    "imap_pass",
    "smtp_pass",
    "refresh_token",
    "token",
];

/// Whether a dotted key addresses a credential.
///
/// `mqtt.username` is not secret; `mqtt.password` is.
pub fn is_secret_key(key: &str) -> bool {
    key.rsplit('.')
        .next()
        .map(|leaf| SECRET_LEAF_KEYS.contains(&leaf))
        .unwrap_or(false)
}

pub fn read_config(path: &Path) -> anyhow::Result<Value> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
    text.parse::<Value>()
        .map_err(|e| anyhow::anyhow!("parse {}: {e}", path.display()))
}

/// Persist `root`, but only if it still parses as a [`DaemonConfig`].
///
/// The validation round-trip runs *before* the write, so a rejected edit
/// leaves the on-disk config byte-for-byte unchanged.
pub fn write_config(path: &Path, root: &Value) -> anyhow::Result<()> {
    let content = toml::to_string_pretty(root)?;
    toml::from_str::<crate::config::DaemonConfig>(&content)
        .map_err(|e| anyhow::anyhow!("validate {}: {e}", path.display()))?;
    std::fs::write(path, content)?;
    Ok(())
}

/// Point one WeCom bot at `workspace_id`, persisting to `daemon.toml`.
///
/// Not expressible through [`set_config_toml_value`]: bots live in a
/// `[[channels.wecom.bots]]` array and the dotted-key walker only descends
/// tables, so the row has to be located by its `bot_id`.
pub fn set_wecom_bot_workspace(
    _path: &Path,
    bot_id: &str,
    workspace_id: &str,
) -> anyhow::Result<()> {
    // Bots are team config: the document is the active team's team.toml, not
    // the daemon.toml the caller holds (kept in the signature so call sites
    // did not have to change).
    let team = crate::config::layout::active_team();
    let mut root = super::team_config::load_value(&team)?;
    let bots = root
        .get_mut("channels")
        .and_then(|c| c.get_mut("wecom"))
        .and_then(|w| w.get_mut("bots"))
        .and_then(|b| b.as_array_mut())
        .ok_or_else(|| anyhow::anyhow!("no [[channels.wecom.bots]] in team.toml"))?;
    let bot = bots
        .iter_mut()
        .find(|bot| bot.get("bot_id").and_then(Value::as_str) == Some(bot_id))
        .ok_or_else(|| anyhow::anyhow!("no wecom bot with bot_id {bot_id}"))?;
    let table = bot
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("wecom bot {bot_id} is not a table"))?;
    table.insert(
        "workspace_id".to_string(),
        Value::String(workspace_id.to_string()),
    );
    super::team_config::save_value(&team, root)
}

pub fn get_config_value(path: &Path, key: &str) -> anyhow::Result<String> {
    let root = doc_for_key(path, key)?;
    let value =
        value_at_key(&root, doc_key(key)).ok_or_else(|| anyhow::anyhow!("missing key: {key}"))?;
    Ok(format_inline_value(value))
}

/// The raw TOML value at `key`, for callers that need the value rather than
/// its display form (the HTTP layer, which re-encodes it as JSON).
pub fn get_config_toml_value(path: &Path, key: &str) -> anyhow::Result<Value> {
    let root = doc_for_key(path, key)?;
    value_at_key(&root, doc_key(key))
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("missing key: {key}"))
}

pub fn list_config_values(path: &Path) -> anyhow::Result<Vec<String>> {
    Ok(flatten_config(path)?
        .into_iter()
        .map(|(key, value)| format!("{key} = {}", format_inline_value(&value)))
        .collect())
}

/// Every dotted key and its value, as `(key, value)` pairs sorted by key.
///
/// Secrets are **not** filtered here — callers decide. The HTTP layer redacts;
/// the CLI does not, since its reader already has filesystem access to
/// `daemon.toml` anyway and redacting would only break `config get`.
pub fn flatten_config(path: &Path) -> anyhow::Result<Vec<(String, Value)>> {
    let root = read_config(path)?;
    let mut out = Vec::new();
    flatten_pairs(None, &root, &mut out);
    // The team document (`channels.*`, `team_share.*`). Best-effort: a broken
    // team.toml must not take the whole settings list down with it.
    if let Ok(team_root) = super::team_config::load_value(&crate::config::layout::active_team()) {
        let mut team_pairs = Vec::new();
        flatten_pairs(None, &team_root, &mut team_pairs);
        out.extend(team_pairs);
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

pub fn set_config_value(path: &Path, key: &str, raw_value: &str) -> anyhow::Result<()> {
    set_config_toml_value(path, key, parse_cli_value(raw_value))
}

pub fn set_config_toml_value(path: &Path, key: &str, value: Value) -> anyhow::Result<()> {
    if super::team_config::is_team_key(key) {
        let team = crate::config::layout::active_team();
        let mut root = super::team_config::load_value(&team)?;
        set_value_at_key(&mut root, doc_key(key), value)?;
        return super::team_config::save_value(&team, root);
    }
    let mut root = read_config(path)?;
    set_value_at_key(&mut root, key, value)?;
    write_config(path, &root)
}

pub fn unset_config_value(path: &Path, key: &str) -> anyhow::Result<()> {
    if super::team_config::is_team_key(key) {
        let team = crate::config::layout::active_team();
        let mut root = super::team_config::load_value(&team)?;
        // Credentials never sit in the document — deleting one means dropping
        // it from the secret store. (Only non-array keys are addressable here;
        // for those the dotted key and the stored path are identical.)
        if is_secret_key(key) && remove_value_at_key(&mut root, doc_key(key)).is_err() {
            return super::team_config::forget_secret(&team, doc_key(key));
        }
        remove_value_at_key(&mut root, doc_key(key))?;
        return super::team_config::save_value(&team, root);
    }
    let mut root = read_config(path)?;
    remove_value_at_key(&mut root, key)?;
    write_config(path, &root)
}

/// Which document a key lives in: team keys read the active team's team.toml
/// (credentials injected), everything else the given daemon.toml.
///
/// The team side deliberately ignores `path` — the team document's location
/// follows the `active_team` pointer, not the daemon.toml the caller holds.
fn doc_for_key(path: &Path, key: &str) -> anyhow::Result<Value> {
    if super::team_config::is_team_key(key) {
        super::team_config::load_value(&crate::config::layout::active_team())
    } else {
        read_config(path)
    }
}

/// Team and daemon keys share one spelling; the split is only which document
/// a key is read from and written to (`is_team_key`).
fn doc_key(key: &str) -> &str {
    key
}

/// Parse a CLI-supplied value as TOML, falling back to a bare string.
///
/// Lets `config set x.y 8883` store an integer and `config set x.y '["a"]'`
/// an array, while `config set x.y hello` still stores `"hello"`.
fn parse_cli_value(raw: &str) -> Value {
    let wrapped = format!("value = {raw}");
    wrapped
        .parse::<Value>()
        .ok()
        .and_then(|value| value.get("value").cloned())
        .unwrap_or_else(|| Value::String(raw.to_string()))
}

fn key_parts(key: &str) -> anyhow::Result<Vec<&str>> {
    let parts: Vec<_> = key.split('.').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        anyhow::bail!("config key cannot be empty");
    }
    Ok(parts)
}

fn value_at_key<'a>(root: &'a Value, key: &str) -> Option<&'a Value> {
    let mut current = root;
    for part in key_parts(key).ok()? {
        current = current.get(part)?;
    }
    Some(current)
}

fn set_value_at_key(root: &mut Value, key: &str, value: Value) -> anyhow::Result<()> {
    let parts = key_parts(key)?;
    let mut current = root;
    for part in &parts[..parts.len() - 1] {
        let table = current
            .as_table_mut()
            .ok_or_else(|| anyhow::anyhow!("{} is not a table", part))?;
        current = table
            .entry((*part).to_string())
            .or_insert_with(|| Value::Table(Default::default()));
    }
    let table = current
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("parent for {key} is not a table"))?;
    table.insert(parts[parts.len() - 1].to_string(), value);
    Ok(())
}

fn remove_value_at_key(root: &mut Value, key: &str) -> anyhow::Result<()> {
    let parts = key_parts(key)?;
    let mut current = root;
    for part in &parts[..parts.len() - 1] {
        current = current
            .get_mut(*part)
            .ok_or_else(|| anyhow::anyhow!("missing key: {key}"))?;
    }
    let table = current
        .as_table_mut()
        .ok_or_else(|| anyhow::anyhow!("parent for {key} is not a table"))?;
    table
        .remove(parts[parts.len() - 1])
        .ok_or_else(|| anyhow::anyhow!("missing key: {key}"))?;
    Ok(())
}

fn flatten_values(prefix: Option<&str>, value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Table(table) => {
            for (key, child) in table {
                let dotted = match prefix {
                    Some(prefix) => format!("{prefix}.{key}"),
                    None => key.to_string(),
                };
                flatten_values(Some(&dotted), child, out);
            }
        }
        other => {
            if let Some(prefix) = prefix {
                out.push(format!("{prefix} = {}", format_inline_value(other)));
            }
        }
    }
}

fn flatten_pairs(prefix: Option<&str>, value: &Value, out: &mut Vec<(String, Value)>) {
    match value {
        Value::Table(table) => {
            for (key, child) in table {
                let dotted = match prefix {
                    Some(prefix) => format!("{prefix}.{key}"),
                    None => key.to_string(),
                };
                flatten_pairs(Some(&dotted), child, out);
            }
        }
        other => {
            if let Some(prefix) = prefix {
                out.push((prefix.to_string(), other.clone()));
            }
        }
    }
}

pub fn format_inline_value(value: &Value) -> String {
    match value {
        Value::String(s) => format!("{s:?}"),
        Value::Integer(i) => i.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::Datetime(dt) => dt.to_string(),
        Value::Array(items) => {
            let values = items
                .iter()
                .map(format_inline_value)
                .collect::<Vec<_>>()
                .join(", ");
            format!("[{values}]")
        }
        Value::Table(_) => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    #[test]
    fn set_wecom_bot_workspace_targets_the_matching_bot_only() {
        // Bots live in the team document now; route the whole test through a
        // temp amuxd home so the team doc resolves under it.
        let dir = tempdir().unwrap();
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(dir.path());
        let path = dir.path().join("daemon.toml");
        std::fs::write(&path, "active_team = \"team-1\"\n[actor]\nname = \"Mac\"\n[mqtt]\nbroker_url = \"mqtts://example\"\n").unwrap();
        crate::config::team_config::save_value(
            "team-1",
            toml::from_str(
                r#"
[channels.wecom]
enabled = true
bot_id = ""
secret = ""

[[channels.wecom.bots]]
enabled = true
bot_id = "bot-a"
secret = "sa"
workspace_id = "ws-old"

[[channels.wecom.bots]]
enabled = true
bot_id = "bot-b"
secret = "sb"
"#,
            )
            .unwrap(),
        )
        .unwrap();

        super::set_wecom_bot_workspace(&path, "bot-b", "ws-new").unwrap();
        let cfg = crate::config::team_config::load_value("team-1").unwrap();
        let bots = cfg["channels"]["wecom"]["bots"].as_array().unwrap();
        // The sibling bot stays untouched; the editable document never carries
        // credentials, so the stored secrets are checked via the typed load.
        assert_eq!(bots[0]["workspace_id"].as_str(), Some("ws-old"));
        assert_eq!(bots[1]["workspace_id"].as_str(), Some("ws-new"));
        assert!(bots[0].get("secret").is_none());
        let typed = crate::config::team_config::load_typed("team-1").unwrap();
        let typed_bots = typed.channels.wecom.unwrap().bots;
        assert_eq!(typed_bots[0].secret, "sa");
        assert_eq!(typed_bots[1].secret, "sb");

        // An unknown bot is an error, not a silently appended row.
        let err = super::set_wecom_bot_workspace(&path, "bot-missing", "ws-x").unwrap_err();
        assert!(err.to_string().contains("bot-missing"), "{err}");
        let cfg = crate::config::team_config::load_value("team-1").unwrap();
        assert_eq!(
            cfg["channels"]["wecom"]["bots"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn set_get_and_unset_nested_config_values() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        std::fs::write(
            &path,
            r#"
team_id = "team-1"

[device]
id = "actor-1"
name = "Mac"

[mqtt]
broker_url = "mqtts://old.example"
"#,
        )
        .unwrap();

        super::set_config_value(&path, "agents.codex.binary", "codex").unwrap();
        super::set_config_value(&path, "agents.codex.default_flags", r#"["--foo", "bar"]"#)
            .unwrap();
        super::set_config_value(&path, "idle_runtime_timeout_secs", "1800").unwrap();

        assert_eq!(
            super::get_config_value(&path, "agents.codex.binary").unwrap(),
            "\"codex\""
        );
        assert_eq!(
            super::get_config_value(&path, "agents.codex.default_flags").unwrap(),
            "[\"--foo\", \"bar\"]"
        );
        assert_eq!(
            super::get_config_value(&path, "idle_runtime_timeout_secs").unwrap(),
            "1800"
        );

        let cfg = crate::config::DaemonConfig::load(&path).unwrap();
        assert_eq!(cfg.agents.codex.as_ref().unwrap().binary, "codex");
        assert_eq!(
            cfg.agents.codex.as_ref().unwrap().default_flags,
            vec!["--foo".to_string(), "bar".to_string()]
        );
        assert_eq!(cfg.idle_runtime_timeout_secs, Some(1800));

        super::unset_config_value(&path, "team_id").unwrap();
        assert!(super::get_config_value(&path, "team_id").is_err());
        assert_eq!(
            crate::config::DaemonConfig::load(&path).unwrap().team_id,
            None
        );
    }

    #[test]
    fn list_config_values_flattens_nested_tables() {
        let dir = tempdir().unwrap();
        // flatten merges the active team's document; pin the home so the test
        // sees an empty one instead of whatever this machine has.
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(dir.path());
        let path = dir.path().join("daemon.toml");
        std::fs::write(
            &path,
            r#"
[device]
id = "actor-1"
name = "Mac"

[mqtt]
broker_url = "mqtts://broker.example"
"#,
        )
        .unwrap();

        assert_eq!(
            super::list_config_values(&path).unwrap(),
            vec![
                "device.id = \"actor-1\"".to_string(),
                "device.name = \"Mac\"".to_string(),
                "mqtt.broker_url = \"mqtts://broker.example\"".to_string(),
            ]
        );
    }

    #[test]
    fn invalid_edits_do_not_overwrite_existing_config() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        let original = r#"
[device]
id = "actor-1"
name = "Mac"

[mqtt]
broker_url = "mqtts://broker.example"
"#;
        std::fs::write(&path, original).unwrap();

        // `name` is the required actor field now — `id` grew a serde default
        // when it stopped being persisted (backend.toml owns the identity), so
        // unsetting it no longer fails validation.
        let err = super::unset_config_value(&path, "device.name").unwrap_err();

        assert!(err.to_string().contains("validate"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn secret_keys_are_detected_by_leaf_name() {
        assert!(super::is_secret_key("mqtt.password"));
        assert!(super::is_secret_key("channels.discord.bot_token"));
        assert!(super::is_secret_key("channels.feishu.app_secret"));
        assert!(super::is_secret_key("channels.email.imap_pass"));
        assert!(super::is_secret_key("channels.email.smtp_pass"));
        assert!(super::is_secret_key("channels.wechat.ilink_token"));
        assert!(super::is_secret_key("channels.wecom.encoding_aes_key"));

        // Nested/repeated sections are covered without enumerating indices.
        assert!(super::is_secret_key("channels.wecom.bots.0.secret"));
        assert!(super::is_secret_key("agents.cursor.api_key"));

        assert!(!super::is_secret_key("mqtt.username"));
        assert!(!super::is_secret_key("mqtt.broker_url"));
        assert!(!super::is_secret_key("actor.id"));
        assert!(!super::is_secret_key("channels.discord.default_username"));
    }

    #[test]
    fn flatten_config_returns_sorted_typed_pairs() {
        let dir = tempdir().unwrap();
        // flatten merges the active team's document; pin the home so the test
        // sees an empty one instead of whatever this machine has.
        let _guard = crate::test_brand_env::BrandEnvGuard::set_amuxd_home(dir.path());
        let path = dir.path().join("daemon.toml");
        std::fs::write(
            &path,
            r#"
[actor]
id = "actor-1"
name = "Mac"

[mqtt]
broker_url = "mqtts://broker.example"
password = "hunter2"
"#,
        )
        .unwrap();

        let pairs = super::flatten_config(&path).unwrap();
        let keys: Vec<_> = pairs.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            vec!["actor.id", "actor.name", "mqtt.broker_url", "mqtt.password"]
        );

        // Values keep their TOML type — the HTTP layer re-encodes them as JSON.
        let password = pairs.iter().find(|(k, _)| k == "mqtt.password").unwrap();
        assert_eq!(password.1.as_str(), Some("hunter2"));
        assert!(super::is_secret_key(&password.0));
    }
}
