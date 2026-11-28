//! `amuxd team secrets` — provision team-share credentials on a daemon that has
//! no desktop app to push them over `POST /v1/team/secrets`.
//!
//! Writes the same store the HTTP path does (`~/.amuxd/team-secrets/<id>.enc`),
//! offline: the daemon need not be running, and a running daemon picks the
//! secrets up on its next sync tick without a reload signal.

use serde_json::{json, Value};

use crate::config::DaemonConfig;
use crate::sync::secret_store::{validate_team_secret, SecretStore, TeamSecrets};

use super::envelope::{emit, error_envelope, success, usage};
use super::{TeamAction, TeamArgs, TeamSecretsAction};

/// Run one command; returns the process exit status. Output: the
/// `amuxd app` contract.
pub fn run(args: TeamArgs) -> anyhow::Result<i32> {
    let envelope = match args.action {
        TeamAction::Sync => return sync(&args.output),
        TeamAction::Secrets(TeamSecretsAction::Set {
            team_id,
            team_secret_file,
            team_secret,
        }) => set(team_id, team_secret_file, team_secret),
        TeamAction::Secrets(TeamSecretsAction::Show { team_id }) => show(team_id),
        TeamAction::Secrets(TeamSecretsAction::Rm { team_id, yes }) => clear(team_id, yes),
    };
    Ok(emit(&args.output, envelope))
}

fn resolve_team_id(explicit: Option<String>) -> anyhow::Result<String> {
    if let Some(id) = explicit {
        let id = id.trim().to_string();
        if id.is_empty() {
            anyhow::bail!("--team-id is empty");
        }
        return Ok(id);
    }
    let path = DaemonConfig::default_path();
    let config = DaemonConfig::load(&path).map_err(|e| {
        anyhow::anyhow!(
            "read {}: {e}. Run `amuxd init <teamclu://invite?token=...>` first, or pass --team-id.",
            path.display()
        )
    })?;
    config
        .team_id
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no team_id in {}. Run `amuxd init <teamclu://invite?token=...>` first, or pass --team-id.",
                path.display()
            )
        })
}

fn no_team(e: anyhow::Error) -> Value {
    error_envelope(
        "no_team",
        &e.to_string(),
        Some("amuxd init <invite-url>"),
        3,
        false,
    )
}

fn store_error(e: impl std::fmt::Display) -> Value {
    error_envelope("secret_store", &e.to_string(), None, 7, false)
}

/// What is set, masked.
fn state(store: &SecretStore, team_id: &str) -> Value {
    match store.load(team_id) {
        Ok(s) => success(json!({
            "teamId": team_id,
            "teamSecret": mask(s.oss_team_secret.as_deref()),
        })),
        Err(e) => store_error(e),
    }
}

fn read_secret_file(path: &str) -> Result<String, Value> {
    let text = if path == "-" {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)
            .map_err(|e| usage("unreadable_file", format!("read stdin: {e}"), None).envelope())?;
        s
    } else {
        std::fs::read_to_string(path)
            .map_err(|e| usage("unreadable_file", format!("read {path}: {e}"), None).envelope())?
    };
    Ok(text.trim().to_string())
}

fn set(
    team_id: Option<String>,
    team_secret_file: Option<String>,
    team_secret: Option<String>,
) -> Value {
    let team_id = match resolve_team_id(team_id) {
        Ok(id) => id,
        Err(e) => return no_team(e),
    };
    let secret = match (team_secret_file, team_secret) {
        (Some(path), _) => match read_secret_file(&path) {
            Ok(s) => s,
            Err(envelope) => return envelope,
        },
        (None, Some(s)) => s.trim().to_string(),
        (None, None) => {
            return usage(
                "missing_secret",
                "nothing to set: pass --team-secret-file <path> (or - for stdin)",
                Some("printf %s \"$SECRET\" | amuxd team secrets set --team-secret-file -"),
            )
            .envelope()
        }
    };
    if let Err(e) = validate_team_secret(&secret) {
        return usage("invalid_secret", format!("team secret: {e}"), None).envelope();
    }
    let incoming = TeamSecrets {
        oss_team_secret: Some(secret),
        user_jwt: None,
        channel_secrets: Default::default(),
    };
    let store = SecretStore::new();
    if let Err(e) = store.merge(&team_id, &incoming) {
        return store_error(e);
    }
    let mut envelope = state(&store, &team_id);
    if envelope["ok"] == true {
        envelope["data"]["next"] =
            json!("restart the daemon (`amuxd stop && amuxd start`) so sync picks it up");
    }
    envelope
}

fn show(team_id: Option<String>) -> Value {
    match resolve_team_id(team_id) {
        Ok(id) => state(&SecretStore::new(), &id),
        Err(e) => no_team(e),
    }
}

use crate::sync::secret_store::mask_secret as mask;

fn clear(team_id: Option<String>, yes: bool) -> Value {
    let team_id = match resolve_team_id(team_id) {
        Ok(id) => id,
        Err(e) => return no_team(e),
    };
    if !yes {
        return usage(
            "confirm_required",
            format!("this removes every stored secret for team {team_id} and cannot be undone"),
            Some("amuxd team secrets rm --yes"),
        )
        .envelope();
    }
    match SecretStore::new().clear(&team_id) {
        Ok(()) => success(json!({ "teamId": team_id, "removed": true })),
        Err(e) => store_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_secret_must_be_64_hex() {
        assert!(validate_team_secret(&"ab".repeat(32)).is_ok());
        assert!(validate_team_secret(&"AB".repeat(32)).is_ok());
        // Too short, and the length is what a user is most likely to get wrong.
        assert!(validate_team_secret("abcd").is_err());
        // Right length, but 'z' is not hex — would fail at HKDF decode.
        assert!(validate_team_secret(&"z".repeat(64)).is_err());
    }

    #[test]
    fn mask_reveals_only_the_edges() {
        assert_eq!(mask(None), "(unset)");
        // A short value has no safe middle to elide.
        assert_eq!(mask(Some("short")), "(set)");
        assert_eq!(mask(Some("0123456789abcdef")), "(set, 0123…cdef)");
    }

    #[test]
    fn explicit_team_id_wins_and_rejects_blank() {
        assert_eq!(resolve_team_id(Some("t-1".into())).unwrap(), "t-1");
        assert!(resolve_team_id(Some("   ".into())).is_err());
    }
}

/// `amuxd team sync`: push local changes to the team's shared folder and pull
/// remote ones now, through the running daemon (`POST /v1/team/sync`, forced).
/// It replaced the `teamclu-introspect` `sync_team_dir` MCP tool, so it keeps
/// the agent output contract (`amuxd app`'s), unlike `team secrets`.
///
/// No workspace is named: sync is per team, and naming one only asks the
/// daemon to repair that folder's team links — from an agent's arbitrary
/// current directory that would plant links where nobody wants them.
fn sync(output: &str) -> anyhow::Result<i32> {
    super::envelope::run_http(
        output,
        "team-sync-cli",
        reqwest::Method::POST,
        "/v1/team/sync",
        Some(serde_json::json!({ "forceSync": true, "allowBulkAdd": false })),
        None,
    )
}
