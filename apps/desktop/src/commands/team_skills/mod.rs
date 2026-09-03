//! Team skills registry — desktop install/uninstall.
//!
//! Design: docs/architecture/team-skills-registry.md
//!
//! Deliberately thin. The package pipeline (zip extract with traversal
//! guarding, `.clawhub/origin.json`, the lockfile, the `permission.skill`
//! entry) already exists for ClawHub, so this reuses it wholesale rather than
//! growing a second one — the only genuinely new steps are talking to the
//! Cloud API instead of the public registry, and writing the structured
//! frontmatter back into SKILL.md.
//!
//! That writeback is the point of the whole feature: the agent reads the file
//! on disk, not Postgres. A registry full of tidy `when_not_to_use` fields is
//! worth nothing if what lands in `.teamclu/skills/` is still one opaque
//! description blob.
//!
//! The commands are grouped by what they do to a skill on disk:
//!
//! | module        | commands                                              |
//! |---------------|-------------------------------------------------------|
//! | `install`     | install, uninstall, rebaseline, pack-and-upload       |
//! | `inspect`     | list installed, resolve a directory, inspect one      |
//! | `diff`        | working copy vs pack, and version vs version          |
//! | `drafts`      | draft metadata, discard, retire, restore, fork        |
//! | `frontmatter` | the SKILL.md writeback and the install stamp          |
//! | `trash`       | the local trash and its recovery records              |
//! | `packfs`      | copying and zipping a skill directory                 |
//! | `types`       | the shapes crossing the IPC boundary                  |

mod diff;
mod drafts;
mod frontmatter;
mod inspect;
mod install;
mod packfs;
mod trash;
mod types;

#[cfg(test)]
mod tests;

// Glob re-exports, not a hand-written list: `#[tauri::command]` also emits a
// hidden `__cmd__<name>` macro next to the function, and `generate_handler!` in
// `lib.rs` resolves it through this same path. Naming the functions one by one
// would leave those macros behind and break the handler registration.
pub use diff::*;
pub use drafts::*;
pub use frontmatter::*;
pub use inspect::*;
pub use install::*;
pub use types::*;

/// Cloud API / SGW-facing blocking client.
///
/// STR-8: this used to be a hand-rolled near-copy of
/// `oss_sync::fc_client::FcClient`'s builder, re-created on every call. Both
/// now come from `crate::http_clients`, which is where the HTTP/1.1 + rustls
/// reason lives and which builds each client once.
pub(super) fn build_cloud_api_client() -> Result<reqwest::blocking::Client, String> {
    crate::http_clients::cloud_api_blocking()
}

/// reqwest's Display omits the source chain, so toast users only see
/// "error sending request for url (...)" with no TLS/connect reason.
pub(super) fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut out = err.to_string();
    let mut src = std::error::Error::source(err);
    while let Some(e) = src {
        out.push_str(": ");
        out.push_str(&e.to_string());
        src = e.source();
    }
    out
}
