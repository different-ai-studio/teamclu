//! `teams/<id>/state/team.toml` — the team-scoped half of the daemon's config.
//!
//! Holds what changes when the team changes: `[channels]` and `[team_share]`.
//! `DaemonConfig` keeps these as in-memory fields (every reader is untouched)
//! but no longer serializes them; [`hydrate`] fills them from here at boot and
//! on channel reload. (`local_agent` used to live here too; pi is the only
//! runtime now, so the key is read and ignored — see [`TeamFileConfig`].)
//!
//! **Credentials never touch this file.** On save, every leaf whose name
//! [`super::edit::is_secret_key`] recognises (bot_token, secret, app_secret,
//! imap_pass, …) is moved into the team's encrypted secret store
//! (`secrets.enc`, `TeamSecrets::channel_secrets`) under a stable dotted path;
//! on load it is injected back. Array elements are keyed by their `bot_id`
//! (`channels.wecom.bots[b-1].secret`), not their index — deleting bot 0 must
//! not silently hand bot 1 someone else's secret.
//!
//! An **empty string** in a secret position on save means "keep what is
//! stored": the desktop form can render placeholders instead of plaintext and
//! save the structure without wiping credentials. Deleting the surrounding
//! channel/bot really does drop the secret — save garbage-collects entries
//! whose path no longer resolves.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use toml::Value;

use super::{ChannelsConfig, TeamShareConfig};

/// The typed shape of `team.toml` (with credentials injected).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TeamFileConfig {
    /// Pre-#1247 runtime selector ("opencode", "pi", …). Ignored: pi is the
    /// only runtime. Still parsed so an existing team.toml loads, and kept on
    /// save so a downgrade finds its value where it left it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_agent: Option<String>,
    #[serde(default)]
    pub team_share: TeamShareConfig,
    #[serde(default)]
    pub channels: ChannelsConfig,
}

pub fn path_for(team_id: &str) -> PathBuf {
    super::layout::team_state_dir(team_id).join("team.toml")
}

pub fn active_path() -> PathBuf {
    path_for(&super::layout::active_team())
}

/// Typed load for the active team, credentials injected. Any problem is the
/// default config — a missing/broken team.toml must not take the daemon down.
/// Typed load with credentials injected — the shape the channel manager runs
/// on. An error is an error: "unreadable" must never be conflated with "empty",
/// or a torn team.toml turns into a save that garbage-collects every stored
/// credential.
pub fn load_typed(team_id: &str) -> anyhow::Result<TeamFileConfig> {
    let mut root = load_value(team_id)?;
    for (key, secret) in load_secret_map(team_id)? {
        set_by_path(&mut root, &key, Value::String(secret));
    }
    root.try_into()
        .map_err(|e| anyhow::anyhow!("parse team.toml: {e}"))
}

/// Fill `config`'s team-scoped fields from the active team's team.toml.
///
/// On error the config is left untouched — at boot that means defaults (and
/// the file survives for the operator to fix); on reload it means the running
/// channel config keeps running instead of being replaced by an empty one.
pub fn hydrate(config: &mut super::DaemonConfig) -> anyhow::Result<()> {
    let team = load_typed(&super::layout::active_team())?;
    config.channels = team.channels;
    config.team_share = team.team_share;
    if let Some(agent) = team.local_agent.as_deref().map(str::trim) {
        if !agent.is_empty() && agent != "pi" {
            tracing::warn!(
                local_agent = agent,
                "team.toml names a runtime this daemon no longer runs; pi is the only local agent (#1247)"
            );
        }
    }
    Ok(())
}

/// Persist the team-scoped fields of an in-memory `DaemonConfig` (the
/// channel-save sock path and the channel CLI both mutate those fields).
pub fn persist_from(config: &super::DaemonConfig) -> anyhow::Result<()> {
    // `local_agent` is not a config field any more; `save_value` keeps
    // whatever the document already holds, since this typed shape only
    // replaces the sections it carries.
    let team_id = super::layout::active_team();
    let previous = load_typed(&team_id).ok().and_then(|t| t.local_agent);
    let team = TeamFileConfig {
        local_agent: previous,
        team_share: config.team_share.clone(),
        channels: config.channels.clone(),
    };
    save_typed(&team_id, &team)
}

pub fn save_typed(team_id: &str, team: &TeamFileConfig) -> anyhow::Result<()> {
    let value = Value::try_from(team.clone())?;
    save_value(team_id, value)
}

/// The editable document, **without** credentials: the config read surface
/// (HTTP list/get, `amuxd config`) must never re-serve what the split just
/// moved into `secrets.enc`. Round-trips stay lossless — [`save_value`] keeps
/// a stored secret whenever its parent still resolves, whether the leaf is
/// absent or an empty string.
pub fn load_value(team_id: &str) -> anyhow::Result<Value> {
    let path = path_for(team_id);
    if path.exists() {
        Ok(std::fs::read_to_string(&path)?.parse::<Value>()?)
    } else {
        Ok(Value::Table(Default::default()))
    }
}

/// Validate, split credentials into the secret store, write the rest 0600.
pub fn save_value(team_id: &str, mut root: Value) -> anyhow::Result<()> {
    // Strip first so validation sees exactly what will be written.
    let mut fresh: BTreeMap<String, String> = BTreeMap::new();
    if let Some(channels) = root.get_mut("channels") {
        strip_secrets("channels", channels, &mut fresh);
    }

    let _typed: TeamFileConfig = root
        .clone()
        .try_into()
        .map_err(|e| anyhow::anyhow!("validate team.toml: {e}"))?;
    validate_bot_ids(&root)?;

    // Merge: freshly provided values win; empty-on-save kept the stored value;
    // entries whose path no longer exists in the document are dropped (their
    // channel or bot was deleted). A store read *failure* aborts the save —
    // running the GC against an unreadable store would wipe every credential.
    let previous = load_secret_map(team_id)?;
    let mut merged = fresh;
    for (key, secret) in previous {
        if !merged.contains_key(&key) && path_resolves(&root, &key) {
            merged.insert(key, secret);
        }
    }
    store_secret_map(team_id, merged)?;

    let path = path_for(team_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = toml::to_string_pretty(&root)?;
    // Atomic: a torn team.toml is exactly the "unreadable → looks empty" state
    // the error handling above exists to keep impossible.
    teamclu_runtime_env::atomic_write::atomic_write(&path, &text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Reject bot ids the secret-path scheme cannot key safely: duplicates would
/// collapse two bots onto one credential, and brackets would corrupt the
/// stored path itself.
fn validate_bot_ids(root: &Value) -> anyhow::Result<()> {
    let Some(channels) = root.get("channels").and_then(Value::as_table) else {
        return Ok(());
    };
    for (channel, value) in channels {
        let Some(bots) = value.get("bots").and_then(Value::as_array) else {
            continue;
        };
        let mut seen = std::collections::BTreeSet::new();
        for bot in bots {
            let Some(id) = bot.get("bot_id").and_then(Value::as_str) else {
                continue;
            };
            if id.contains('[') || id.contains(']') {
                anyhow::bail!("channels.{channel}: bot_id {id:?} must not contain brackets");
            }
            if !seen.insert(id) {
                anyhow::bail!(
                    "channels.{channel}: duplicate bot_id {id:?} — each bot needs its own id"
                );
            }
        }
    }
    Ok(())
}

/// Drop one stored credential. The `unset` path for secret keys: the document
/// on disk never holds them, so removing the map entry is the deletion.
pub fn forget_secret(team_id: &str, key: &str) -> anyhow::Result<()> {
    let mut map = load_secret_map(team_id)?;
    if map.remove(key).is_none() {
        anyhow::bail!("missing key: {key}");
    }
    store_secret_map(team_id, map)
}

/// Whether a dotted key belongs to the team document rather than daemon.toml.
/// The routing rule for the shared edit surface (`super::edit`).
pub fn is_team_key(key: &str) -> bool {
    key == "channels"
        || key.starts_with("channels.")
        || key == "team_share"
        || key.starts_with("team_share.")
}

// ── secret split ────────────────────────────────────────────────────────────

fn is_secret_leaf(name: &str) -> bool {
    super::edit::is_secret_key(name)
}

/// Move every non-empty secret leaf under `node` into `out`; remove secret
/// leaves from the document either way (empty string = "keep stored").
fn strip_secrets(prefix: &str, node: &mut Value, out: &mut BTreeMap<String, String>) {
    match node {
        Value::Table(table) => {
            let keys: Vec<String> = table.keys().cloned().collect();
            for key in keys {
                let child_path = format!("{prefix}.{key}");
                if is_secret_leaf(&key) {
                    if let Some(Value::String(s)) = table.get(&key) {
                        if !s.is_empty() {
                            out.insert(child_path, s.clone());
                        }
                        table.remove(&key);
                    }
                } else if let Some(child) = table.get_mut(&key) {
                    strip_secrets(&child_path, child, out);
                }
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter_mut().enumerate() {
                strip_secrets(&format!("{prefix}[{}]", element_id(item, i)), item, out);
            }
        }
        _ => {}
    }
}

/// Stable identity for an array element: its `bot_id` when it has one, else
/// `#<index>` (only id-less arrays keep the positional fragility — and the
/// `#` prefix keeps a purely numeric bot_id from aliasing a position).
fn element_id(item: &Value, index: usize) -> String {
    item.get("bot_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("#{index}"))
}

/// Split `channels.wecom.bots[b-1].secret` into segments; brackets bind to the
/// preceding segment and may contain dots.
fn split_path(key: &str) -> Vec<String> {
    let mut segs = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    for c in key.chars() {
        match c {
            '[' => {
                depth += 1;
                current.push(c);
            }
            ']' => {
                depth = depth.saturating_sub(1);
                current.push(c);
            }
            '.' if depth == 0 => {
                segs.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        segs.push(current);
    }
    segs
}

fn descend<'a>(node: &'a mut Value, seg: &str) -> Option<&'a mut Value> {
    let index = descend_index(node, seg)?;
    match index {
        Descend::Key(name) => node.get_mut(name),
        Descend::Element(name, i) => node.get_mut(name)?.as_array_mut()?.get_mut(i),
    }
}

fn descend_ref<'a>(node: &'a Value, seg: &str) -> Option<&'a Value> {
    let index = descend_index(node, seg)?;
    match index {
        Descend::Key(name) => node.get(name),
        Descend::Element(name, i) => node.get(name)?.as_array()?.get(i),
    }
}

enum Descend<'s> {
    Key(&'s str),
    Element(&'s str, usize),
}

fn descend_index<'s>(node: &Value, seg: &'s str) -> Option<Descend<'s>> {
    let Some(open) = seg.find('[') else {
        return Some(Descend::Key(seg));
    };
    // Malformed segments (a stored key corrupted by hand) resolve to None
    // rather than panicking a slice.
    if !seg.ends_with(']') || open + 1 >= seg.len() - 1 {
        return None;
    }
    let (name, bracket) = seg.split_at(open);
    let id = &bracket[1..bracket.len() - 1];
    let arr = node.get(name)?.as_array()?;
    let index = if let Some(pos) = id.strip_prefix('#') {
        pos.parse::<usize>().ok().filter(|i| *i < arr.len())?
    } else {
        arr.iter()
            .position(|item| item.get("bot_id").and_then(|v| v.as_str()) == Some(id))?
    };
    Some(Descend::Element(name, index))
}

fn set_by_path(root: &mut Value, key: &str, value: Value) {
    let segs = split_path(key);
    let Some((leaf, parents)) = segs.split_last() else {
        return;
    };
    let mut node = root;
    for seg in parents {
        match descend(node, seg) {
            Some(next) => node = next,
            // The channel/bot this secret belonged to is gone from the
            // document; the save-side GC will drop the entry.
            None => return,
        }
    }
    if let Value::Table(table) = node {
        table.insert(leaf.clone(), value);
    }
}

fn path_resolves(root: &Value, key: &str) -> bool {
    let segs = split_path(key);
    let Some((_leaf, parents)) = segs.split_last() else {
        return false;
    };
    let mut cursor = root;
    for seg in parents {
        match descend_ref(cursor, seg) {
            Some(next) => cursor = next,
            None => return false,
        }
    }
    true
}

// ── secret store glue ───────────────────────────────────────────────────────

/// `SecretStore::load` returns `Ok(default)` for a missing file and `Err` only
/// for real failures (decrypt, parse) — precisely the distinction the save
/// path's GC depends on, so errors propagate instead of becoming "empty".
/// Which credential slots have a value stored, by dotted path
/// (`channels.wecom.bots[aibC…].secret`). Never the values themselves.
///
/// The settings form reads secrets back as empty — that is deliberate, the
/// split moved them out of `team.toml` — but an empty box also looks exactly
/// like "never configured", so people retype a key they already had, or avoid
/// pressing save at all. Presence is the part the UI is missing, and it is not
/// a secret.
pub fn stored_secret_keys(team_id: &str) -> anyhow::Result<Vec<String>> {
    Ok(load_secret_map(team_id)?.into_keys().collect())
}

fn load_secret_map(team_id: &str) -> anyhow::Result<BTreeMap<String, String>> {
    crate::sync::secret_store::SecretStore::new()
        .load(team_id)
        .map(|s| s.channel_secrets)
        .map_err(|e| anyhow::anyhow!("read channel secrets: {e}"))
}

fn store_secret_map(team_id: &str, map: BTreeMap<String, String>) -> anyhow::Result<()> {
    let store = crate::sync::secret_store::SecretStore::new();
    let mut secrets = store
        .load(team_id)
        .map_err(|e| anyhow::anyhow!("read secrets before update: {e}"))?;
    if secrets.channel_secrets == map {
        return Ok(());
    }
    secrets.channel_secrets = map;
    store
        .save(team_id, &secrets)
        .map_err(|e| anyhow::anyhow!("store channel secrets: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_brand_env::BrandEnvGuard;

    fn doc(text: &str) -> Value {
        text.parse().unwrap()
    }

    #[test]
    fn a_legacy_local_agent_in_team_toml_is_read_and_kept_but_never_applied() {
        // Most existing teams carry `local_agent = "opencode"`. Loading must
        // not fail, hydrate must not act on it, and a persist must not erase
        // it (a downgrade would want it back).
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();
        save_value("team-1", doc("local_agent = \"opencode\"\n")).unwrap();

        let mut config = super::super::DaemonConfig::bootstrap();
        hydrate(&mut config).unwrap();
        persist_from(&config).unwrap();
        assert_eq!(
            load_typed("team-1").unwrap().local_agent.as_deref(),
            Some("opencode")
        );
    }

    #[test]
    fn save_strips_credentials_and_load_injects_them() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();

        save_value(
            "team-1",
            doc(r#"
[channels.discord]
enabled = true
bot_token = "tok-123"

[channels.wecom]
enabled = true

[[channels.wecom.bots]]
bot_id = "b-1"
secret = "s-1"

[[channels.wecom.bots]]
bot_id = "b-2"
secret = "s-2"
"#),
        )
        .unwrap();

        let written = std::fs::read_to_string(path_for("team-1")).unwrap();
        assert!(!written.contains("tok-123"), "{written}");
        assert!(!written.contains("s-1"), "{written}");
        assert!(written.contains("bot_id"), "{written}");

        let loaded = load_typed("team-1").unwrap();
        let discord = loaded.channels.discord.unwrap();
        assert_eq!(discord.bot_token, "tok-123");
        let wecom = loaded.channels.wecom.unwrap();
        assert_eq!(wecom.bots[0].secret, "s-1");
        assert_eq!(wecom.bots[1].secret, "s-2");
    }

    /// Deleting bot 0 must not hand bot 1 someone else's secret, and must drop
    /// the deleted bot's stored credential.
    #[test]
    fn secrets_follow_bot_ids_not_indices() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();

        save_value(
            "team-1",
            doc(r#"
[channels.wecom]
enabled = true
[[channels.wecom.bots]]
bot_id = "b-1"
secret = "s-1"
[[channels.wecom.bots]]
bot_id = "b-2"
secret = "s-2"
"#),
        )
        .unwrap();

        // Re-save with b-1 deleted and b-2's secret left empty ("keep").
        save_value(
            "team-1",
            doc(r#"
[channels.wecom]
enabled = true
[[channels.wecom.bots]]
bot_id = "b-2"
secret = ""
"#),
        )
        .unwrap();

        let loaded = load_typed("team-1").unwrap();
        let bots = loaded.channels.wecom.unwrap().bots;
        assert_eq!(bots.len(), 1);
        assert_eq!(bots[0].secret, "s-2", "b-2 keeps its own secret");
        assert!(
            !load_secret_map("team-1")
                .unwrap()
                .contains_key("channels.wecom.bots[b-1].secret"),
            "the deleted bot's secret must be garbage-collected"
        );
    }

    #[test]
    fn empty_secret_on_save_keeps_the_stored_value() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();

        save_value(
            "team-1",
            doc("[channels.kook]\nenabled = true\nbot_token = \"kk-1\"\n"),
        )
        .unwrap();
        save_value(
            "team-1",
            doc("[channels.kook]\nenabled = false\nbot_token = \"\"\n"),
        )
        .unwrap();

        let loaded = load_typed("team-1").unwrap();
        let kook = loaded.channels.kook.unwrap();
        assert!(!kook.enabled);
        assert_eq!(kook.bot_token, "kk-1");
    }

    #[test]
    fn hydrate_fills_daemon_config_and_persist_round_trips() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();

        let mut config = super::super::DaemonConfig::bootstrap();
        config.team_share.auto_sync = false;
        config.channels.discord = Some(super::super::DiscordChannel {
            enabled: true,
            bot_token: "tok".into(),
            default_username: None,
        });
        persist_from(&config).unwrap();

        let mut fresh = super::super::DaemonConfig::bootstrap();
        hydrate(&mut fresh).unwrap();
        assert!(!fresh.team_share.auto_sync);
        assert_eq!(fresh.channels.discord.unwrap().bot_token, "tok");
    }

    /// The read surface never carries credentials; the save round-trip keeps
    /// them anyway because the GC only requires the *parent* to resolve.
    #[test]
    fn edit_surface_reads_are_credential_free_and_round_trip_safely() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();

        save_value(
            "team-1",
            doc("[channels.kook]\nenabled = true\nbot_token = \"kk-1\"\n"),
        )
        .unwrap();

        let visible = load_value("team-1").unwrap();
        assert!(
            visible
                .get("channels")
                .and_then(|c| c.get("kook"))
                .and_then(|k| k.get("bot_token"))
                .is_none(),
            "the editable document must not resurrect stripped credentials"
        );

        // Edit something unrelated on the credential-free doc and save.
        let mut edited = visible;
        edited["channels"]["kook"]["enabled"] = Value::Boolean(false);
        save_value("team-1", edited).unwrap();

        assert_eq!(
            load_typed("team-1")
                .unwrap()
                .channels
                .kook
                .unwrap()
                .bot_token,
            "kk-1",
            "a credential-free round-trip must keep the stored secret"
        );

        forget_secret("team-1", "channels.kook.bot_token").unwrap();
        assert_eq!(
            load_typed("team-1")
                .unwrap()
                .channels
                .kook
                .unwrap()
                .bot_token,
            ""
        );
    }

    #[test]
    fn duplicate_or_bracketed_bot_ids_are_rejected() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();

        let dup = doc(
            "[channels.wecom]\nenabled = true\n[[channels.wecom.bots]]\nbot_id = \"b\"\nsecret = \"1\"\n[[channels.wecom.bots]]\nbot_id = \"b\"\nsecret = \"2\"\n",
        );
        assert!(save_value("team-1", dup)
            .unwrap_err()
            .to_string()
            .contains("duplicate"));

        let bracket = doc(
            "[channels.wecom]\nenabled = true\n[[channels.wecom.bots]]\nbot_id = \"b[\"\nsecret = \"1\"\n",
        );
        assert!(save_value("team-1", bracket)
            .unwrap_err()
            .to_string()
            .contains("brackets"));
    }

    #[test]
    fn team_keys_route_to_the_team_document() {
        for key in [
            "channels",
            "channels.wecom.bots.0.secret",
            "team_share.auto_sync",
        ] {
            assert!(is_team_key(key), "{key}");
        }
        // `agents.local_agent` is no longer a key anywhere: pi is the only
        // runtime, and `[agents.pi]` overrides are machine config.
        for key in [
            "mqtt.broker_url",
            "agents.pi.node",
            "agents.local_agent",
            "local_agent",
            "actor.name",
        ] {
            assert!(!is_team_key(key), "{key}");
        }
    }
}
