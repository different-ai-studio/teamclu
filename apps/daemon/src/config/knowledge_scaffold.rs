//! Knowledge vault scaffold — generate the standard directory tree and
//! bilingual (zh/en) templates for a team's `shared/knowledge/` vault.
//!
//! Layout and template rules follow
//! `docs/plans/2026-08-31-team-knowledge-base-program.md` (§2.1, §2.2,
//! Appendix C). Idempotent: existing files are never overwritten.

use std::io;
use std::path::{Path, PathBuf};

/// Directories created (empty) by scaffold, relative to the knowledge root.
const SCAFFOLD_DIRS: &[&str] = &[
    "10-onboarding",
    "20-domains",
    "30-decisions",
    "40-runbooks",
    "70-vendors", // optional but common; empty dir is harmless
    "90-archive",
    "attachments",
];

/// Files written by scaffold, relative to the knowledge root.
/// Each entry is (target path, template source under `assets/knowledge-templates/`).
const SCAFFOLD_FILES: &[(&str, &str)] = &[
    ("00-home.md", "00-home.md"),
    ("50-glossary.md", "50-glossary.md"),
    ("knowledge.manifest.yaml", "knowledge.manifest.yaml"),
    ("30-decisions/adr-template.md", "adr-template.md"),
    ("40-runbooks/runbook-template.md", "runbook-template.md"),
];

/// One scaffold outcome line, for logging / UI display.
#[derive(Debug)]
pub struct ScaffoldReport {
    pub knowledge_root: PathBuf,
    pub dirs_created: Vec<PathBuf>,
    pub files_created: Vec<PathBuf>,
    pub files_skipped: Vec<PathBuf>, // already existed
}

/// Scaffold the knowledge vault for `team_id`.
///
/// Creates the standard directory tree and writes bilingual templates for any
/// file that doesn't already exist. `team_name` is interpolated into
/// `{{TEAM_NAME}}` placeholders; `{{TEAM_ID}}` gets `team_id`;
/// `{{DATE}}` gets today's ISO date.
///
/// Idempotent: re-running on an existing vault is a no-op for existing files.
pub fn scaffold_knowledge(team_id: &str, team_name: &str) -> io::Result<ScaffoldReport> {
    let root = super::global_team_store::sync_content_root(team_id).join("knowledge");
    scaffold_at(&root, team_id, team_name)
}

/// Scaffold into an arbitrary root. Split from [`scaffold_knowledge`] so tests
/// can point at a tempdir without touching `~/.amuxd`.
pub fn scaffold_at(root: &Path, team_id: &str, team_name: &str) -> io::Result<ScaffoldReport> {
    std::fs::create_dir_all(root)?;

    let mut report = ScaffoldReport {
        knowledge_root: root.to_path_buf(),
        dirs_created: Vec::new(),
        files_created: Vec::new(),
        files_skipped: Vec::new(),
    };

    for dir in SCAFFOLD_DIRS {
        let p = root.join(dir);
        if !p.exists() {
            std::fs::create_dir_all(&p)?;
            report.dirs_created.push(p);
        }
    }

    let today = today_iso();
    for (target, template) in SCAFFOLD_FILES {
        let p = root.join(target);
        if p.exists() {
            report.files_skipped.push(p);
            continue;
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let raw = template_source(template);
        let content = raw
            .replace("{{TEAM_ID}}", team_id)
            .replace("{{TEAM_NAME}}", team_name)
            .replace("{{DATE}}", &today);
        std::fs::write(&p, content)?;
        report.files_created.push(p);
    }

    Ok(report)
}

fn template_source(name: &str) -> &'static str {
    match name {
        "00-home.md" => include_str!("../../assets/knowledge-templates/00-home.md"),
        "50-glossary.md" => include_str!("../../assets/knowledge-templates/50-glossary.md"),
        "knowledge.manifest.yaml" => {
            include_str!("../../assets/knowledge-templates/knowledge.manifest.yaml")
        }
        "adr-template.md" => include_str!("../../assets/knowledge-templates/adr-template.md"),
        "runbook-template.md" => {
            include_str!("../../assets/knowledge-templates/runbook-template.md")
        }
        "_index.md" => include_str!("../../assets/knowledge-templates/_index.md"),
        _ => unreachable!("unknown knowledge template: {}", name),
    }
}

/// The `_index.md` (domain MOC) template, exposed so callers can scaffold
/// additional domains on demand without re-running the full scaffold.
pub fn domain_index_template() -> &'static str {
    template_source("_index.md")
}

/// Today as `YYYY-MM-DD` (UTC). Exposed for the knowledge MCP handlers
/// (template stamping in `daemon::server::knowledge`).
pub(crate) fn today_iso() -> String {
    // Local date, not UTC. These stamps are read by people — a salvage filename
    // and an `updated:` line — and UTC files anything done before 08:00 in
    // China under yesterday. `chrono` is already a direct dependency of this
    // crate (`Cargo.toml`), which the hand-rolled civil-from-days algorithm
    // this replaces was written to avoid.
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_creates_tree_and_templates() {
        let tmp = tempfile::tempdir().unwrap();
        let report = scaffold_at(tmp.path(), "t1", "测试团队").unwrap();

        assert!(tmp.path().join("10-onboarding").is_dir());
        assert!(tmp.path().join("20-domains").is_dir());
        assert!(tmp.path().join("attachments").is_dir());
        assert!(tmp.path().join("00-home.md").is_file());
        assert!(tmp.path().join("knowledge.manifest.yaml").is_file());
        assert!(tmp.path().join("30-decisions/adr-template.md").is_file());
        assert_eq!(report.files_created.len(), 5);
        assert!(report.files_skipped.is_empty());

        let home = std::fs::read_to_string(tmp.path().join("00-home.md")).unwrap();
        assert!(home.contains("测试团队"));
        assert!(home.contains("/ Knowledge Base"));

        let manifest = std::fs::read_to_string(tmp.path().join("knowledge.manifest.yaml")).unwrap();
        assert!(manifest.contains("visibility: private"));
        assert!(manifest.contains("team: t1"));
    }

    #[test]
    fn scaffold_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_at(tmp.path(), "t1", "A").unwrap();
        // User edits a file
        std::fs::write(tmp.path().join("00-home.md"), "my edits").unwrap();
        let report = scaffold_at(tmp.path(), "t1", "A").unwrap();
        assert!(report.files_created.is_empty());
        assert_eq!(report.files_skipped.len(), 5);
        let home = std::fs::read_to_string(tmp.path().join("00-home.md")).unwrap();
        assert_eq!(home, "my edits"); // not overwritten
    }

    #[test]
    fn date_stamp_is_iso() {
        let d = today_iso();
        assert_eq!(d.len(), 10);
        assert_eq!(&d[4..5], "-");
        assert_eq!(&d[7..8], "-");
    }
}
