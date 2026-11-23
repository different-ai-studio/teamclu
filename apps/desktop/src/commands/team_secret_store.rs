fn team_secret_blob_key(team_id: &str) -> String {
    format!("_team_secret.{}", team_id)
}

/// Save the team secret, returning a notice when the local store had to be
/// rebuilt to make that possible.
///
/// The team secret lives inside the personal secret blob, so saving it is a
/// read-modify-write. When the blob will not decrypt — a master key that no
/// longer matches — that read used to fail the whole save with
/// "Failed to decrypt secret blob (authentication failed)": a cryptic message
/// about a file the user never mentioned, and no way forward. The value they
/// typed is new and does not depend on anything in that blob, so blocking it
/// bought nothing.
///
/// Now the unreadable blob is set aside (never deleted — see
/// `quarantine_unreadable_blob`), a fresh store is written, and the caller gets
/// a sentence saying what happened. Any *other* read failure still aborts:
/// those are transient or unknown, and rebuilding the store over one would
/// discard readable secrets.
pub fn save_team_secret(
    workspace_path: &str,
    team_id: &str,
    secret: &str,
) -> Result<Option<String>, String> {
    let (mut blob, notice) = match super::env_vars::read_env_blob(workspace_path) {
        Ok(blob) => (blob, None),
        Err(e) if super::local_secret_store::is_undecryptable(&e) => {
            let paths = super::local_secret_store::SecretStorePaths::for_home_dir()?;
            let backup = super::local_secret_store::quarantine_unreadable_blob(&paths)?;
            log::warn!(
                "team secret save: local secret store was unreadable; set aside at {}",
                backup.display()
            );
            (
                serde_json::Map::new(),
                Some(format!(
                    "Your local secret store could not be decrypted, so it was set aside at {} and a new one was started. \
                     The team secret is saved. Personal environment variables stored before this are not readable here — \
                     restore the matching master.key from a backup to recover them.",
                    backup.display()
                )),
            )
        }
        Err(e) => return Err(e),
    };
    blob.insert(
        team_secret_blob_key(team_id),
        serde_json::Value::String(secret.to_string()),
    );
    super::env_vars::write_env_blob(&blob)?;
    Ok(notice)
}

/// Why a team secret could not be read back.
#[derive(Debug)]
pub enum TeamSecretReadError {
    /// No secret has been saved for this team yet.
    NotConfigured,
    /// The store could not be read at all — a different fact, and one the user
    /// needs to see rather than have shown as an empty field.
    StoreUnreadable(String),
}

impl std::fmt::Display for TeamSecretReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Kept close to the old string so log greps and existing call sites
            // that only forward the message read the same as before.
            Self::NotConfigured => write!(f, "Team secret not found"),
            Self::StoreUnreadable(e) => write!(f, "{e}"),
        }
    }
}

impl From<TeamSecretReadError> for String {
    fn from(e: TeamSecretReadError) -> Self {
        e.to_string()
    }
}

pub fn load_team_secret(
    workspace_path: &str,
    team_id: &str,
) -> Result<String, TeamSecretReadError> {
    let blob = super::env_vars::read_env_blob(workspace_path)
        .map_err(TeamSecretReadError::StoreUnreadable)?;
    let key = team_secret_blob_key(team_id);
    if let Some(value) = blob.get(&key).and_then(|v| v.as_str()) {
        return Ok(value.to_string());
    }
    Err(TeamSecretReadError::NotConfigured)
}
