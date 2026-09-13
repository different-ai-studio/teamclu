//! `amuxd update` — install the release channel's latest amuxd over this one.
//!
//! The mechanics (manifest, checksum, swap, rollback record) live in
//! `crate::self_update`, shared with the daemon's background check. This file
//! adds the terminal side: flags, messages, and restarting the service.

use anyhow::anyhow;

use crate::self_update::{self, Options, Outcome};
use crate::service::RestartOutcome;

pub fn run(check: bool, force: bool, no_restart: bool) -> anyhow::Result<()> {
    let base = self_update::channel_base().ok_or_else(|| {
        anyhow!(
            "this amuxd build has no release channel to update from (source builds and container images are rebuilt instead); set {} to point at one",
            self_update::BASE_URL_ENV
        )
    })?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let current = env!("CARGO_PKG_VERSION");
    let platform = self_update::platform_key();

    if check {
        let (url, manifest) = rt.block_on(self_update::fetch_manifest(&base))?;
        let latest = manifest.version.trim().trim_start_matches('v');
        println!("channel  {url}");
        println!("current  {current}");
        println!("latest   {latest}");
        if !manifest.platforms.contains_key(&platform) {
            println!("That release has no build for {platform}.");
        } else if self_update::is_newer(latest, current) {
            println!("An update is available: run `amuxd update`.");
        } else {
            println!("amuxd is up to date.");
        }
        return Ok(());
    }

    let target = self_update::managed_binary().map_err(|reason| anyhow!(reason))?;
    println!("checking {}", self_update::manifest_url(&base));
    let outcome = rt.block_on(self_update::update_installed(
        &target,
        &base,
        Options {
            force,
            respect_skip: false,
        },
    ))?;
    let to = match outcome {
        Outcome::UpToDate { current, latest } => {
            println!("amuxd {current} is up to date (the channel has {latest}).");
            return Ok(());
        }
        Outcome::Skipped { version } => {
            println!("skipped amuxd {version}.");
            return Ok(());
        }
        Outcome::Installed { from, to } => {
            println!(
                "installed amuxd {to} at {} (was {from}; the previous binary is kept at {})",
                target.display(),
                self_update::backup_path(&target).display()
            );
            to
        }
    };

    if no_restart {
        println!("The running daemon is unchanged; restart it to run {to}.");
        return Ok(());
    }
    match crate::service::restart_installed()? {
        RestartOutcome::Restarted => println!("restarted the amuxd service on {to}."),
        RestartOutcome::NotRunning => {
            println!("amuxd is not running; it starts on {to} next time.")
        }
        RestartOutcome::Unsupervised => println!(
            "amuxd is running outside a service manager; restart it to run {to}: amuxd stop && amuxd start"
        ),
    }
    Ok(())
}
