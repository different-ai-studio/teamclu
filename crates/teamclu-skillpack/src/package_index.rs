//! The single file selector for a skill pack.
//!
//! Dirty detection, diffs, zip packing, content hashes, rebaseline, and the
//! daemon draft inventory must all agree on which files are in the package.
//! This module is that agreement: walk the directory once, apply the same
//! ignore rules, and hand back included / ignored / invalid paths.
//!
//! Ignore sources, later overriding earlier:
//!
//! 1. Built-in OS junk (`.DS_Store`, `Thumbs.db`, …).
//! 2. The skill's own `.teamcluignore`, gitignore syntax, paths relative to
//!    the skill root. Only the root file is read — nested copies are ordinary
//!    pack files.
//!
//! Hard exclusions that ignore rules cannot undo:
//!
//! - Top-level `.clawhub/` (install bookkeeping).
//! - `SKILL.md` (the pack is not a pack without it).
//! - `.teamcluignore` itself (other members need the same rules).

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::path::{Path, PathBuf};

use crate::origin::ORIGIN_DIR;

/// New-publish caps. Historical versions stay downloadable; these only bind
/// the pack we are about to upload.

/// Declares files that are not part of the published pack.
pub const IGNORE_FILE: &str = ".teamcluignore";

pub const SKILL_MD: &str = "SKILL.md";

/// System litter that is never a skill file, on any machine.
pub const BUILTIN_IGNORE_RULES: &[&str] = &[
    ".DS_Store",
    "._*",
    "Thumbs.db",
    "desktop.ini",
    "__MACOSX/",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackagePathErrorKind {
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackagePathError {
    pub path: String,
    pub kind: PackagePathErrorKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PackageIndex {
    pub included: Vec<String>,
    pub ignored: Vec<String>,
    pub invalid: Vec<PackagePathError>,
}

/// Compiled ignore rules for one skill directory.
pub struct PackIgnore {
    matcher: Gitignore,
}

impl PackIgnore {
    pub fn load(root: &Path) -> Self {
        let mut builder = GitignoreBuilder::new(root);
        let _ = builder.case_insensitive(true);
        for rule in BUILTIN_IGNORE_RULES {
            let _ = builder.add_line(None, rule);
        }
        let ignore_file = root.join(IGNORE_FILE);
        if ignore_file.is_file() {
            if let Some(_err) = builder.add(&ignore_file) {
                // A malformed line must not refuse the whole pack; skip the
                // unreadable file and keep the builtins.
            }
        }
        let matcher = builder.build().unwrap_or_else(|_| Gitignore::empty());
        Self { matcher }
    }

    /// Whether `rel` (always `/`-separated, relative to the skill root) is
    /// outside the published pack.
    pub fn is_ignored(&self, rel: &str, is_dir: bool) -> bool {
        if is_protected(rel) {
            return false;
        }
        self.matcher
            .matched_path_or_any_parents(rel, is_dir)
            .is_ignore()
    }
}

fn is_protected(rel: &str) -> bool {
    rel == SKILL_MD || rel == IGNORE_FILE
}

pub fn build_package_index(root: &Path) -> std::io::Result<PackageIndex> {
    let ignore = PackIgnore::load(root);
    let mut index = PackageIndex::default();
    walk(root, root, &ignore, &mut index)?;
    index.included.sort();
    index.ignored.sort();
    Ok(index)
}

fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn walk(
    root: &Path,
    current: &Path,
    ignore: &PackIgnore,
    index: &mut PackageIndex,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            if let Some(rel) = rel_of(root, &path) {
                index.invalid.push(PackagePathError {
                    path: rel,
                    kind: PackagePathErrorKind::Symlink,
                });
            }
            continue;
        }
        if file_type.is_dir() {
            if path.parent() == Some(root) && entry.file_name() == ORIGIN_DIR {
                continue;
            }
            let Some(rel) = rel_of(root, &path) else {
                continue;
            };
            if ignore.is_ignored(&rel, true) {
                collect_ignored(root, &path, index)?;
                continue;
            }
            walk(root, &path, ignore, index)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some(rel) = rel_of(root, &path) else {
            continue;
        };
        if ignore.is_ignored(&rel, false) {
            index.ignored.push(rel);
        } else {
            index.included.push(rel);
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackLimitError {
    TooManyFiles { count: usize },
    FileTooLarge { path: String, size: u64 },
    PackTooLarge { size: u64 },
}

impl std::fmt::Display for PackLimitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooManyFiles { count } => {
                write!(f, "skill pack has {count} files (limit {MAX_PACK_FILES})")
            }
            Self::FileTooLarge { path, size } => write!(
                f,
                "file {path} is {size} bytes (limit {MAX_SINGLE_FILE_BYTES})"
            ),
            Self::PackTooLarge { size } => {
                write!(f, "skill pack is {size} bytes (limit {MAX_PACK_TOTAL_BYTES})")
            }
        }
    }
}

fn to_native(rel: &str) -> PathBuf {
    if std::path::MAIN_SEPARATOR == '/' {
        PathBuf::from(rel)
    } else {
        PathBuf::from(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
    }
}

/// Uncompressed size of `included`, or a limit error. Missing paths are skipped.
pub fn check_publish_limits(root: &Path, included: &[String]) -> Result<u64, PackLimitError> {
    if included.len() > MAX_PACK_FILES {
        return Err(PackLimitError::TooManyFiles {
            count: included.len(),
        });
    }
    let mut total = 0u64;
    for rel in included {
        let path = root.join(to_native(rel));
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let size = meta.len();
        if size > MAX_SINGLE_FILE_BYTES {
            return Err(PackLimitError::FileTooLarge {
                path: rel.clone(),
                size,
            });
        }
        total = total.saturating_add(size);
        if total > MAX_PACK_TOTAL_BYTES {
            return Err(PackLimitError::PackTooLarge { size: total });
        }
    }
    Ok(total)
}

fn collect_ignored(root: &Path, current: &Path, index: &mut PackageIndex) -> std::io::Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            if let Some(rel) = rel_of(root, &path) {
                index.invalid.push(PackagePathError {
                    path: rel,
                    kind: PackagePathErrorKind::Symlink,
                });
            }
            continue;
        }
        if file_type.is_dir() {
            collect_ignored(root, &path, index)?;
            continue;
        }
        if file_type.is_file() {
            if let Some(rel) = rel_of(root, &path) {
                index.ignored.push(rel);
            }
        }
    }
    Ok(())
}
