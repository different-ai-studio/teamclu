//! Installed-state bookkeeping for skill packages.
//!
//! Design: `docs/architecture/team-skills-registry.md` §8.2.
//!
//! A team skill auto-follows `latest_version` — nobody clicks "update". That
//! makes overwriting an unattended operation, so before replacing anything we
//! have to be able to answer "did a human change this on disk since we put it
//! there?". This crate is that answer, and nothing else: no network, no Tauri,
//! no filesystem layout knowledge beyond the directory it is handed.
//!
//! It lives in `crates/` rather than next to the Tauri commands because the
//! reconcile loop moves into the daemon (P2) and this is the part that has to
//! move with it. Keeping it dependency-free from the start is cheaper than
//! untangling it later.
//!
//! # Why a per-file manifest and not one directory hash
//!
//! A single tree hash is less code and answers the question wrong three ways:
//!
//! 1. **Runtime artifacts.** Skills ship scripts, and scripts write caches and
//!    logs next to themselves. Under a tree hash the first such write pins the
//!    skill as permanently dirty, auto-follow stops forever, and the user is
//!    never told why. With a manifest, a file nobody registered is simply not
//!    ours to care about.
//! 2. **Upgrades destroy bystanders.** Knowing exactly which files we installed
//!    is what lets an upgrade replace those and leave everything else alone,
//!    instead of `remove_dir_all` taking the user's own notes with it.
//! 3. **The conflict UI has nothing to say.** "This skill was modified" does not
//!    help someone decide; "SKILL.md and scripts/check.sh changed, refs/old.md
//!    was deleted" does.

pub mod commit;
pub mod frontmatter;
pub mod manifest;
pub mod origin;
pub mod swap;
pub mod zip_path;

pub use commit::commit_staged_pack;
pub use frontmatter::{write_registry_frontmatter, RegistryFields, SOURCE_TEAM};
pub use manifest::{
    build_manifest, build_manifest_for, inspect, list_managed_paths, sha256_hex, DirtyState,
    FileManifest, ManagedFile,
};
pub use origin::{read_origin, write_origin, SkillOrigin, ORIGIN_DIR, ORIGIN_VERSION};
pub use swap::{remove_managed_files, swap_managed_files};
pub use zip_path::{apply_zip_mode, sanitize_zip_path};
