//! `teams/<id>/state/team.toml` — the team-scoped half of the daemon's config.
//!
//! Holds what changes when the team changes: `[channels]`, `[team_share]` and
//! `local_agent`. `DaemonConfig` keeps these as in-memory fields (every reader
//! is untouched) but no longer serializes them; [`hydrate`] fills them from
//! here at boot and on channel reload.
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
    /// Which runtime this team's agents run ("opencode", "pi", …). `None`
    /// falls back to the built-in default.
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
    if let Some(agent) = team.local_agent {
        if !agent.trim().is_empty() {
            config.agents.local_agent = agent;
        }
    }
    Ok(())
}

/// Give a team that never named a runtime one this machine can actually run.
///
/// `local_agent` is team-scoped, and a team that has never been told otherwise
/// falls back to [`super::daemon_config::default_local_agent`] — the string
/// "opencode", chosen with no knowledge of what is installed. On a machine that
/// runs pi and has never had opencode, that default is a dead end reached by
/// doing nothing wrong: every spawn fails with `agent_binary_missing(opencode)`
/// and the model catalog comes back empty, while the setup that installed pi
/// sits one directory away.
///
/// So: when the team document is silent *and* the default cannot be launched
/// here, adopt the first runtime that can, and write it into the document. A
/// machine that does have the default is left exactly as it was — this only
/// rescues the case that was otherwise unusable.
///
/// Persisted rather than resolved per boot on purpose. Installing a second
/// runtime later must not silently move a team onto it; once a team has an
/// answer, that answer is the user's to change (Settings → Agent).
///
/// Returns whether it seeded anything.
pub fn seed_local_agent_if_unset(config: &mut super::DaemonConfig) -> anyhow::Result<bool> {
    seed_local_agent_with(config, local_agent_launchable)
}

/// The decision, with the host probe injected so it can be tested without
/// depending on what happens to be installed on the machine running the tests.
fn seed_local_agent_with(
    config: &mut super::DaemonConfig,
    launchable: impl Fn(&str) -> bool,
) -> anyhow::Result<bool> {
    let team_id = super::layout::active_team();
    let team = load_typed(&team_id)?;
    if team
        .local_agent
        .as_deref()
        .map(|a| !a.trim().is_empty())
        .unwrap_or(false)
    {
        return Ok(false);
    }
    if launchable(&config.agents.local_agent) {
        return Ok(false);
    }
    let Some(pick) = LOCAL_AGENT_CANDIDATES
        .iter()
        .copied()
        .find(|id| launchable(id))
    else {
        // Nothing runnable at all. Leaving the default in place keeps the error
        // the user sees pointed at a real runtime name rather than at whatever
        // this function happened to try last.
        return Ok(false);
    };
    config.agents.local_agent = pick.to_string();
    persist_from(config)?;
    tracing::info!(
        team = %team_id,
        agent = pick,
        "team named no local agent and the default is not installed; adopted an installed one"
    );
    Ok(true)
}

/// Runtimes worth adopting, most-preferred first. Deliberately short: these are
/// the two the product installs and drives end to end. Cursor needs a node
/// bridge and claude maps onto opencode, so neither is a sensible thing to
/// pick *for* somebody.
const LOCAL_AGENT_CANDIDATES: [&str; 2] = ["opencode", "pi"];

/// Whether `agents.local_agent = <id>` could actually start on this machine.
///
/// Each runtime is asked the way it resolves itself — pi accepts `~/.pi/bin/pi`
/// which `command -v pi` never sees, and opencode has its own installer path.
/// An unknown id is reported launchable so this never demotes a runtime it
/// simply does not know about.
fn local_agent_launchable(id: &str) -> bool {
    match id {
        "opencode" | "claude" => crate::opencode_install::detect_opencode().is_some(),
        "pi" => binary_on_disk_or_path(&crate::runtime::pi_rpc::process::resolve_binary(None)),
        _ => true,
    }
}

/// PATH lookup without a shell: `command -v` would need quoting rules, and the
/// only thing being asked is whether a file of this name is reachable.
fn binary_on_disk_or_path(binary: &str) -> bool {
    let path = std::path::Path::new(binary);
    if path.is_absolute() || binary.contains('/') {
        return path.exists();
    }
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(binary).exists()))
        .unwrap_or(false)
}

/// Persist the team-scoped fields of an in-memory `DaemonConfig` (the
/// channel-save sock path and the channel CLI both mutate those fields).
pub fn persist_from(config: &super::DaemonConfig) -> anyhow::Result<()> {
    let team = TeamFileConfig {
        local_agent: Some(config.agents.local_agent.clone()),
        team_share: config.team_share.clone(),
        channels: config.channels.clone(),
    };
    save_typed(&super::layout::active_team(), &team)
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
    key == "agents.local_agent"
        || key == "local_agent"
        || key == "channels"
        || key.starts_with("channels.")
        || key == "team_share"
        || key.starts_with("team_share.")
}

/// `agents.local_agent` kept its public spelling (the desktop PUTs
/// `/v1/config/agents.local_agent`); inside team.toml it is a root key.
pub fn rewrite_team_key(key: &str) -> &str {
    match key {
        "agents.local_agent" => "local_agent",
        other => other,
    }
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

    fn seed_config() -> super::super::DaemonConfig {
        super::super::DaemonConfig {
            actor: crate::config::ActorConfig {
                id: "dev-1".to_string(),
                name: "Mac".to_string(),
            },
            mqtt: crate::config::MqttConfig {
                broker_url: "tcp://localhost:1883".to_string(),
                username: None,
                password: None,
            },
            agents: crate::config::AgentsConfig::default(),
            transport: None,
            team_id: None,
            channels: crate::config::ChannelsConfig::default(),
            idle_runtime_timeout_secs: None,
            max_attachments: None,
            http: None,
            team_share: crate::config::TeamShareConfig::default(),
            log: None,
            locale: None,
            app_scheme: None,
        }
    }

    /// Sets up a home whose active team is `team-1`, with `team.toml` as given.
    fn seed_home(team_toml: Option<&str>) -> (tempfile::TempDir, BrandEnvGuard) {
        let home = tempfile::tempdir().unwrap();
        let guard = BrandEnvGuard::set_amuxd_home(home.path());
        std::fs::write(
            home.path().join("daemon.toml"),
            "active_team = \"team-1\"\n",
        )
        .unwrap();
        if let Some(text) = team_toml {
            save_value("team-1", doc(text)).unwrap();
        }
        (home, guard)
    }

    #[test]
    fn seeding_leaves_a_team_that_already_named_a_runtime_alone() {
        // Even an uninstalled one: an explicit choice is the user's, and the
        // spawn error names it, which is how they find out what to install.
        let (_home, _guard) = seed_home(Some("local_agent = \"pi\"\n"));
        let mut config = seed_config();
        hydrate(&mut config).unwrap();

        let seeded = seed_local_agent_with(&mut config, |_| false).unwrap();

        assert!(!seeded);
        assert_eq!(config.agents.local_agent, "pi");
    }

    #[test]
    fn seeding_does_nothing_when_the_default_runs_here() {
        // The common machine. Nothing is written, so nothing changes for anyone
        // who was already working.
        let (_home, _guard) = seed_home(None);
        let mut config = seed_config();
        let before = config.agents.local_agent.clone();

        let seeded = seed_local_agent_with(&mut config, |id| id == before).unwrap();

        assert!(!seeded);
        assert_eq!(config.agents.local_agent, before);
        assert!(load_typed("team-1").unwrap().local_agent.is_none());
    }

    #[test]
    fn seeding_adopts_an_installed_runtime_and_writes_it_down() {
        // The reported case: onboarding installed pi, the team never named a
        // runtime, and the "opencode" default cannot start on this machine.
        let (_home, _guard) = seed_home(None);
        let mut config = seed_config();

        let seeded = seed_local_agent_with(&mut config, |id| id == "pi").unwrap();

        assert!(seeded);
        assert_eq!(config.agents.local_agent, "pi");
        // Written down, so installing opencode later cannot move the team.
        assert_eq!(
            load_typed("team-1").unwrap().local_agent.as_deref(),
            Some("pi")
        );
    }

    #[test]
    fn seeding_keeps_the_default_when_nothing_is_installed() {
        // With no runtime at all there is nothing to adopt, and the error the
        // user gets should keep naming the default rather than whatever this
        // tried last.
        let (_home, _guard) = seed_home(None);
        let mut config = seed_config();
        let before = config.agents.local_agent.clone();

        let seeded = seed_local_agent_with(&mut config, |_| false).unwrap();

        assert!(!seeded);
        assert_eq!(config.agents.local_agent, before);
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
        config.agents.local_agent = "pi".into();
        config.team_share.auto_sync = false;
        config.channels.discord = Some(super::super::DiscordChannel {
            enabled: true,
            bot_token: "tok".into(),
            default_username: None,
        });
        persist_from(&config).unwrap();

        let mut fresh = super::super::DaemonConfig::bootstrap();
        hydrate(&mut fresh).unwrap();
        assert_eq!(fresh.agents.local_agent, "pi");
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
            "agents.local_agent",
        ] {
            assert!(is_team_key(key), "{key}");
        }
        for key in ["mqtt.broker_url", "agents.opencode.binary", "actor.name"] {
            assert!(!is_team_key(key), "{key}");
        }
        assert_eq!(rewrite_team_key("agents.local_agent"), "local_agent");
    }
}
