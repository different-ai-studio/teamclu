//! Make a staged pack live without leaving mixed versions behind.
//!
//! Design: `docs/architecture/hosted-skill-reconcile-fail-closed.md` §2.
//!
//! The installer used to swap files into the live directory and only then write
//! `origin.json`. `swap_managed_files` never touches `.clawhub/` — the
//! bookkeeping directory is excluded from the manifest — so a failed origin
//! write left vN files sitting next to a vN-1 baseline. `inspect` reads that
//! as Dirty, auto-follow skips the pack forever, and nothing rolls the swap
//! back.
//!
//! The contract here is: `staged` is already the complete new tree (extracted
//! files, rewritten frontmatter, matching origin.json). We snapshot `target`,
//! copy the managed files, copy origin last. Any failure after the live tree
//! is touched restores the snapshot. Success means origin version and files
//! are the same version.

use std::io;
use std::path::{Path, PathBuf};

use crate::origin::{read_origin, ORIGIN_DIR};
use crate::swap::swap_managed_files;

const ORIGIN_FILE: &str = "origin.json";

fn origin_file(dir: &Path) -> PathBuf {
    dir.join(ORIGIN_DIR).join(ORIGIN_FILE)
}

/// Copy `staged` onto `target` as one install.
///
/// `staged` must already contain `.clawhub/origin.json`. Missing origin is
/// refused before `target` is touched — a pack without a baseline is how the
/// mixed-version bug starts.
pub fn commit_staged_pack(target: &Path, staged: &Path) -> io::Result<()> {
    commit_staged_pack_with(target, staged, copy_origin)
}

fn copy_origin(staged: &Path, target: &Path) -> io::Result<()> {
    let src = origin_file(staged);
    let dest_dir = target.join(ORIGIN_DIR);
    std::fs::create_dir_all(&dest_dir)?;
    std::fs::copy(&src, dest_dir.join(ORIGIN_FILE))?;
    Ok(())
}

fn commit_staged_pack_with(
    target: &Path,
    staged: &Path,
    write_origin: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    if !origin_file(staged).is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "staged pack is missing origin.json; refusing to make it live",
        ));
    }

    let snapshot = snapshot_tree(target)?;
    let baseline = read_origin(target).and_then(|o| o.files);

    let result = (|| {
        swap_managed_files(target, staged, baseline.as_ref())?;
        write_origin(staged, target)?;
        Ok(())
    })();

    if let Err(e) = result {
        if let Err(restore_err) = restore_tree(target, snapshot.as_ref().map(|d| d.path())) {
            return Err(io::Error::other(format!(
                "commit failed ({e}); restore failed ({restore_err})"
            )));
        }
        return Err(e);
    }
    Ok(())
}

fn snapshot_tree(target: &Path) -> io::Result<Option<tempfile::TempDir>> {
    if !target.exists() {
        return Ok(None);
    }
    let backup = tempfile::tempdir()?;
    copy_tree(target, backup.path())?;
    Ok(Some(backup))
}

fn restore_tree(target: &Path, backup: Option<&Path>) -> io::Result<()> {
    if target.exists() {
        std::fs::remove_dir_all(target)?;
    }
    if let Some(backup) = backup {
        copy_tree(backup, target)?;
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let dest = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

#[cfg(test)]
fn live_pack_is_clean(target: &Path) -> bool {
    use crate::manifest::inspect;
    let Some(origin) = read_origin(target) else {
        return false;
    };
    matches!(
        inspect(target, origin.files.as_ref()),
        crate::DirtyState::Clean
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::{write_registry_frontmatter, RegistryFields};
    use crate::manifest::{build_manifest_for, inspect, list_managed_paths, DirtyState};
    use crate::origin::{write_origin, SkillOrigin, ORIGIN_VERSION};
    use crate::SOURCE_TEAM;

    fn write(dir: &Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn stamp(dir: &Path, slug: &str, version: i64) {
        let shipped = list_managed_paths(dir).unwrap();
        write_registry_frontmatter(
            dir,
            &RegistryFields {
                slug,
                version,
                owner: None,
                category: Some("devops"),
                summary: Some("check"),
                when_to_use: Some("before release"),
                when_not_to_use: Some("not locally"),
                requires: None,
            },
        )
        .unwrap();
        let files = build_manifest_for(dir, &shipped).unwrap();
        write_origin(
            dir,
            &SkillOrigin {
                version: ORIGIN_VERSION,
                registry: SOURCE_TEAM.to_string(),
                slug: slug.into(),
                installed_version: version.to_string(),
                installed_at: 1,
                team_id: Some("team-a".into()),
                files: Some(files),
            },
        )
        .unwrap();
    }

    fn origin_version(dir: &Path) -> String {
        read_origin(dir).unwrap().installed_version
    }

    fn skill_body(dir: &Path) -> String {
        std::fs::read_to_string(dir.join("SKILL.md")).unwrap()
    }

    #[test]
    fn successful_commit_origin_version_matches_files() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("deploy-check");
        write(&target, "SKILL.md", "---\nname: deploy-check\n---\nv1\n");
        stamp(&target, "deploy-check", 1);
        assert!(live_pack_is_clean(&target));

        let staged = tmp.path().join("staged");
        write(&staged, "SKILL.md", "---\nname: deploy-check\n---\nv2\n");
        write(&staged, "scripts/new.sh", "echo new\n");
        stamp(&staged, "deploy-check", 2);

        commit_staged_pack(&target, &staged).unwrap();

        assert!(skill_body(&target).contains("v2"));
        assert!(target.join("scripts/new.sh").is_file());
        assert_eq!(origin_version(&target), "2");
        assert!(live_pack_is_clean(&target));
    }

    #[test]
    fn origin_write_failure_restores_previous_pack_and_is_not_dirty() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("deploy-check");
        write(&target, "SKILL.md", "---\nname: deploy-check\n---\nv1\n");
        write(&target, "NOTES.md", "mine\n");
        stamp(&target, "deploy-check", 1);
        let v1_body = skill_body(&target);

        let staged = tmp.path().join("staged");
        write(&staged, "SKILL.md", "---\nname: deploy-check\n---\nv2\n");
        stamp(&staged, "deploy-check", 2);

        let err = commit_staged_pack_with(&target, &staged, |_staged, _target| {
            Err(io::Error::other("origin write failed"))
        })
        .unwrap_err();
        assert!(err.to_string().contains("origin write failed"));

        assert_eq!(skill_body(&target), v1_body, "files must roll back to v1");
        assert_eq!(origin_version(&target), "1");
        assert_eq!(
            std::fs::read_to_string(target.join("NOTES.md")).unwrap(),
            "mine\n",
            "files the pack never owned must survive the failed upgrade"
        );
        let baseline = read_origin(&target).and_then(|o| o.files);
        match inspect(&target, baseline.as_ref()) {
            DirtyState::Dirty { .. } => {
                panic!("origin-write failure must not pin the pack Dirty")
            }
            DirtyState::Clean => {}
            other => panic!("expected Clean after rollback, got {other:?}"),
        }
    }

    #[test]
    fn origin_write_failure_on_fresh_install_leaves_no_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("deploy-check");
        let staged = tmp.path().join("staged");
        write(&staged, "SKILL.md", "---\nname: deploy-check\n---\nv1\n");
        stamp(&staged, "deploy-check", 1);

        commit_staged_pack_with(&target, &staged, |_staged, _target| {
            Err(io::Error::other("origin write failed"))
        })
        .unwrap_err();

        assert!(
            !target.exists(),
            "a failed first install must not leave a half tree"
        );
    }

    #[test]
    fn refusing_a_staging_dir_without_origin_does_not_touch_target() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("deploy-check");
        write(&target, "SKILL.md", "---\nname: deploy-check\n---\nv1\n");
        stamp(&target, "deploy-check", 1);
        let before = skill_body(&target);

        let staged = tmp.path().join("staged");
        write(&staged, "SKILL.md", "---\nname: deploy-check\n---\nv2\n");

        let err = commit_staged_pack(&target, &staged).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert_eq!(skill_body(&target), before);
        assert_eq!(origin_version(&target), "1");
    }
}
