//! `amuxd config path|list|get|set|unset`.
//!
//! A thin CLI over [`crate::config::edit`], which the HTTP config endpoints
//! also use. Keep the logic there, not here, so `amuxd config set` and the
//! setup UI cannot diverge on validation.
//!
//! Note this path does *not* redact secrets: its caller already has read
//! access to `daemon.toml`, and redacting would make `config get
//! mqtt.password` useless. The HTTP layer redacts because a scoped token is
//! not filesystem access.

use crate::cli::{ConfigAction, ConfigArgs};
use crate::config::edit;

pub fn run(args: ConfigArgs, default_config_path: &std::path::Path) -> anyhow::Result<()> {
    let path = args.config.as_deref().unwrap_or(default_config_path);
    match args.action {
        ConfigAction::Path => {
            println!("{}", path.display());
        }
        ConfigAction::List => {
            for line in edit::list_config_values(path)? {
                println!("{line}");
            }
        }
        ConfigAction::Get { key } => {
            println!("{}", edit::get_config_value(path, &key)?);
        }
        ConfigAction::Set { key, value } => {
            edit::set_config_value(path, &key, &value)?;
            // A secret leaf is moved into the team's encrypted store on save,
            // so it is no longer in the document to read back. Echoing the
            // write instead of erroring matters: the set succeeded, and
            // "Error: missing key" after a successful write reads as failure.
            if edit::is_secret_key(&key) {
                println!("{key} = (stored)");
            } else {
                println!("{key} = {}", edit::get_config_value(path, &key)?);
            }
        }
        ConfigAction::Unset { key } => {
            edit::unset_config_value(path, &key)?;
            println!("unset {key}");
        }
    }
    Ok(())
}
