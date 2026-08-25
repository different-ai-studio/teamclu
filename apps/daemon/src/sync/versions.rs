//! Per-file version history + content resolution for team workspaces.
//!
//! Backed by the FC version list + blob download/decrypt (see http/team_sync.rs).

use serde::Serialize;

/// One entry in a file's version history. `reference` is an OSS content hash.
/// Serialized as `ref`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    #[serde(rename = "ref")]
    pub reference: String,
    pub author: Option<String>,
    pub timestamp: String,
    pub deleted: bool,
    pub message: Option<String>,
}

/// A file with local changes (feeds the "changed files" list).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted"
}

/// A file the cloud has that this device keeps failing to apply.
///
/// Carries the path, not just a count: "3 files cannot sync" is not something a
/// person can act on, and the whole reason the quarantine exists is that these
/// files need a human to notice them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StuckFile {
    pub path: String,
    pub reason: String,
    pub attempts: u32,
}
