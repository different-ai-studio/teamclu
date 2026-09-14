//! Importing a skill from a local `.zip`.
//!
//! This module used to be the skills.sh marketplace: an HTML scraper for its
//! leaderboard, per-platform content fetchers (GitHub / GitLab / Gitee /
//! Bitbucket), GitHub Code Search for locating `SKILL.md`, and five commands
//! that shelled out to the `npx skills` CLI. ClawHub replaced all of it — the
//! skills.sh source was retired from the UI, which left ~1200 lines that no
//! screen could reach any more, so they are gone (#1049 follow-up).
//!
//! What survives is the one command that was never part of that: manual zip
//! import. It walks the whole archive rather than just the root, because a zip
//! can carry its `SKILL.md` at any depth.

use std::path::{Path, PathBuf};

use teamclu_skillpack::{
    build_manifest, build_package_index, write_origin, SkillOrigin, ORIGIN_VERSION,
};

use super::clawhub::{extract_zip_to_dir, now_millis};

const SOURCE_IMPORT: &str = "import";

/// Paths manual zip import refuses to adopt, on top of what the pack's own
/// selector already excludes.
///
/// This is not a content rule — `teamclu_skillpack::build_package_index` decides
/// what the pack is, and the pack's own `.teamcluignore` is part of that. This
/// is the import entry point's guard, and it exists because a zip is untrusted
/// input: VCS metadata and Python bytecode caches are never skill content, can
/// be arbitrarily large, and the built-in ignore layer does not cover them yet.
/// When it does, these move there and this list goes away.
///
/// An entry belongs here only if it stops a harm the index does not already
/// stop. `__MACOSX/` is deliberately absent for that reason — it is already a
/// built-in rule. `metadata.json` is absent because nothing in this repo writes
/// or reads it; excluding it would only mean silently dropping a file from a zip
/// that happened to carry one.
///
/// Directory entries end in `/` and match by prefix; file entries match exactly.
const IMPORT_NEVER_COPY: &[&str] = &[".git/", ".svn/", ".hg/", "__pycache__/", "__pypackages__/"];

fn import_never_copies(rel: &str) -> bool {
    IMPORT_NEVER_COPY
        .iter()
        .any(|rule| match rule.strip_suffix('/') {
            Some(dir) => rel == dir || rel.starts_with(&format!("{dir}/")),
            None => rel == *rule,
        })
}

// ─── Import skill from local .zip (manual upload) ─────────────────────────────

fn skill_md_paths_under(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .max_depth(64)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.file_name() != "SKILL.md" {
            continue;
        }
        let p = entry.path();
        if p.components().any(|c| c.as_os_str() == "__MACOSX") {
            continue;
        }
        out.push(p.to_path_buf());
    }
    Ok(out)
}

fn slug_from_zip_filename(zip_path: &Path) -> String {
    let stem = zip_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-skill");
    let s: String = stem
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "imported-skill".to_string()
    } else {
        s
    }
}

fn validate_skill_import_slug(slug: &str) -> Result<(), String> {
    if slug.trim().is_empty() {
        return Err("Derived skill folder name is empty".to_string());
    }
    if slug.contains('/') || slug.contains('\\') || slug.contains("..") {
        return Err(format!("Invalid skill folder name: {}", slug));
    }
    Ok(())
}

/// Import a skill from a `.zip` file. The archive must contain exactly one `SKILL.md`.
/// The parent directory of that file is copied as the skill folder. If `SKILL.md` is at the
/// archive root, the install folder name is derived from the zip file name.
#[tauri::command]
pub async fn import_skill_from_zip(
    workspace_path: Option<String>,
    zip_path: String,
    is_global: bool,
    force: Option<bool>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        import_skill_from_zip_blocking(workspace_path, zip_path, is_global, force)
    })
    .await
    .map_err(|e| format!("import_skill_from_zip task failed: {e}"))?
}

fn import_skill_from_zip_blocking(
    workspace_path: Option<String>,
    zip_path: String,
    is_global: bool,
    force: Option<bool>,
) -> Result<String, String> {
    use std::fs;

    // Always lands in ~/.agents/skills; params kept for API stability.
    let _ = (workspace_path.as_ref(), is_global);

    let zip_path = PathBuf::from(zip_path.trim());
    if !zip_path.is_file() {
        return Err("Zip file not found".to_string());
    }

    let hash_input = zip_path.to_string_lossy();
    let temp_dir = std::env::temp_dir().join(format!(
        "teamclu-skill-zip-{:x}",
        md5::compute(hash_input.as_bytes())
    ));

    if temp_dir.exists() {
        let _ = fs::remove_dir_all(&temp_dir);
    }

    let import_result = (|| -> Result<String, String> {
        let zip_bytes = fs::read(&zip_path).map_err(|e| format!("Failed to read zip: {}", e))?;
        extract_zip_to_dir(&zip_bytes, &temp_dir)?;

        let extract_root = temp_dir
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize extract dir: {}", e))?;

        let skill_md_paths = skill_md_paths_under(&extract_root)?;

        if skill_md_paths.is_empty() {
            return Err("No SKILL.md found in archive".to_string());
        }
        if skill_md_paths.len() > 1 {
            return Err(
                "Archive contains multiple SKILL.md files; use one skill per archive".to_string(),
            );
        }

        let skill_md_path = &skill_md_paths[0];
        let skill_src_dir = skill_md_path
            .parent()
            .ok_or_else(|| "Invalid SKILL.md path".to_string())?;
        let skill_src_dir = skill_src_dir
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize skill directory: {}", e))?;

        let slug = if skill_src_dir == extract_root {
            slug_from_zip_filename(&zip_path)
        } else {
            skill_src_dir
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| "Invalid skill folder name".to_string())?
                .to_string()
        };

        validate_skill_import_slug(&slug)?;

        let home = dirs::home_dir().ok_or_else(|| "HOME directory not found".to_string())?;
        let target_dir = home.join(".agents").join("skills").join(&slug);

        let force = force.unwrap_or(false);
        if target_dir.exists() && !force {
            return Err(format!(
                "Already installed: {} (use force=true to overwrite)",
                target_dir.display()
            ));
        }
        if target_dir.exists() {
            fs::remove_dir_all(&target_dir)
                .map_err(|e| format!("Failed to remove existing skill dir: {}", e))?;
        }

        fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Failed to create target directory: {}", e))?;

        copy_skill_directory(&skill_src_dir.to_path_buf(), &target_dir)?;

        let files = build_manifest(&target_dir)
            .map_err(|e| format!("Failed to measure imported skill: {}", e))?;
        write_origin(
            &target_dir,
            &SkillOrigin {
                version: ORIGIN_VERSION,
                registry: SOURCE_IMPORT.to_string(),
                slug: slug.clone(),
                installed_version: "1".to_string(),
                installed_at: now_millis(),
                team_id: None,
                files: Some(files),
            },
        )
        .map_err(|e| format!("Failed to write origin.json: {}", e))?;

        Ok(format!(
            "Imported skill '{}' to {}",
            slug,
            target_dir.display()
        ))
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    import_result
}

// ─── Import helpers ─────────────────────────────────────────────────────────

/// Copy a skill tree as the pack defines it.
///
/// The file set comes from `teamclu_skillpack::build_package_index` — the same
/// selector dirty detection, packing and the content digest use — so an
/// imported pack starts life clean against the baseline `build_manifest` is
/// about to record for it.
///
/// This used to walk the tree by hand and skip every entry whose name began
/// with a dot. That is how `.teamcluignore` was lost on import: the one file
/// that tells every other member what must not be published vanished at exactly
/// the moment it arrived, so a skill's ignore rules survived the round trip
/// through the registry but not the round trip through a zip. OS junk and
/// symlinks are already out of the index, and the pack's own rules apply here
/// too — which is the point, not a side effect.
///
/// `.clawhub/` needs no special case: the index excludes it at the pack root,
/// and this import writes its own origin record.
fn copy_skill_directory(src: &Path, dst: &Path) -> Result<(), String> {
    use std::fs;

    let index = build_package_index(src)
        .map_err(|e| format!("Failed to list skill files in {}: {}", src.display(), e))?;

    for rel in &index.included {
        if import_never_copies(rel) {
            continue;
        }
        // `included` is `/`-separated on every platform; the filesystem is not.
        let from = src.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let to = dst.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
        }
        // `fs::copy` carries the permission bits across, which is what keeps a
        // shipped script executable after the import. Errors used to be
        // swallowed here, so a half-copied skill still reported success.
        fs::copy(&from, &to).map_err(|e| {
            format!(
                "Failed to copy {} to {}: {}",
                from.display(),
                to.display(),
                e
            )
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_home::HomeGuard;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn write_zip(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default();
        for (name, bytes) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn import(zip: &std::path::Path, force: Option<bool>) -> Result<String, String> {
        import_skill_from_zip_blocking(None, zip.display().to_string(), true, force)
    }

    #[test]
    fn import_refuses_overwrite_unless_force() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = HomeGuard::set(home.path());
        let skill_dir = home.path().join(".agents/skills/my-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "ORIGINAL\n").unwrap();

        let zip_dir = tempfile::tempdir().expect("tempdir");
        let zip_path = zip_dir.path().join("pack.zip");
        write_zip(
            &zip_path,
            &[("my-skill/SKILL.md", b"---\nname: my-skill\n---\nNEW\n")],
        );

        let err = import(&zip_path, None).expect_err("must refuse");
        assert!(err.contains("Already installed"), "{err}");
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            "ORIGINAL\n"
        );

        import(&zip_path, Some(true)).expect("force overwrite");
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            "---\nname: my-skill\n---\nNEW\n"
        );
        let origin = teamclu_skillpack::read_origin(&skill_dir).expect("origin");
        assert_eq!(origin.registry, SOURCE_IMPORT);
        assert_eq!(origin.slug, "my-skill");
    }

    #[test]
    fn import_skips_zip_path_traversal() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = HomeGuard::set(home.path());

        let zip_dir = tempfile::tempdir().expect("tempdir");
        let zip_path = zip_dir.path().join("safe-skill.zip");
        write_zip(
            &zip_path,
            &[
                ("SKILL.md", b"---\nname: safe-skill\n---\nbody\n"),
                ("../../outside.txt", b"pwned\n"),
            ],
        );

        import(&zip_path, None).expect("import");

        assert!(!home.path().join("outside.txt").exists());
        assert!(!zip_dir.path().join("outside.txt").exists());
        let installed = home.path().join(".agents/skills/safe-skill/SKILL.md");
        assert!(installed.is_file(), "skill should still install");
        assert!(!home.path().join(".agents/skills/outside.txt").exists());
    }

    #[test]
    fn import_keeps_the_ignore_file_and_starts_clean() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = HomeGuard::set(home.path());

        let zip_dir = tempfile::tempdir().expect("tempdir");
        let zip_path = zip_dir.path().join("deploy-check.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "deploy-check/SKILL.md",
                    b"---\nname: deploy-check\n---\nbody\n",
                ),
                ("deploy-check/.teamcluignore", b"results/\n"),
                ("deploy-check/scripts/check.sh", b"#!/bin/sh\necho hi\n"),
                ("deploy-check/results/run-1.json", b"{}\n"),
                ("deploy-check/.DS_Store", b"finder\n"),
                // Not `._*`: that pattern already covers macOS litter on its own, and
                // using it here would hide whether the `__MACOSX/` rule works.
                ("deploy-check/__MACOSX/plain.txt", b"x\n"),
            ],
        );

        import(&zip_path, None).expect("import");

        let installed = home.path().join(".agents/skills/deploy-check");
        assert_eq!(
            std::fs::read_to_string(installed.join(".teamcluignore")).unwrap(),
            "results/\n",
            "the ignore file is the whole point of importing the pack as-is"
        );
        assert!(installed.join("scripts/check.sh").is_file());
        // The arrived rules apply to the import itself, so the pack starts life
        // without the files it just declared as non-content.
        assert!(!installed.join("results").exists());
        // OS junk comes from the built-in layer, which is why the import guard
        // does not need its own `__MACOSX/` / `.DS_Store` / `Thumbs.db` entries.
        assert!(!installed.join(".DS_Store").exists());
        assert!(!installed.join("__MACOSX").exists());

        let origin = teamclu_skillpack::read_origin(&installed).expect("origin");
        let baseline = origin.files.expect("baseline");
        assert_eq!(
            teamclu_skillpack::inspect(&installed, Some(&baseline)),
            teamclu_skillpack::DirtyState::Clean,
            "an imported pack must not be born dirty"
        );
    }

    #[test]
    fn import_never_adopts_vcs_metadata_or_python_caches() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = HomeGuard::set(home.path());

        let zip_dir = tempfile::tempdir().expect("tempdir");
        let zip_path = zip_dir.path().join("vendored.zip");
        write_zip(
            &zip_path,
            &[
                ("vendored/SKILL.md", b"---\nname: vendored\n---\nbody\n"),
                ("vendored/.git/HEAD", b"ref: refs/heads/main\n"),
                ("vendored/.git/objects/ab/cdef", b"x\n"),
                ("vendored/__pycache__/mod.cpython-312.pyc", b"x\n"),
            ],
        );

        import(&zip_path, None).expect("import");

        let installed = home.path().join(".agents/skills/vendored");
        assert!(
            !installed.join(".git").exists(),
            "VCS metadata is not content"
        );
        assert!(!installed.join("__pycache__").exists());
        assert!(installed.join("SKILL.md").is_file());
    }

    /// `metadata.json` used to be excluded here by a rule inherited from the
    /// pre-migration codebase. Nothing in the repo writes or reads it, so the
    /// exclusion only meant dropping a file the zip deliberately carried.
    /// Pinned as ordinary content so it cannot be re-added as a "fix".
    #[test]
    fn import_keeps_a_metadata_json_the_zip_actually_carries() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = HomeGuard::set(home.path());

        let zip_dir = tempfile::tempdir().expect("tempdir");
        let zip_path = zip_dir.path().join("described.zip");
        write_zip(
            &zip_path,
            &[
                ("described/SKILL.md", b"---\nname: described\n---\nbody\n"),
                ("described/metadata.json", b"{\"version\":1}\n"),
            ],
        );

        import(&zip_path, None).expect("import");

        let installed = home.path().join(".agents/skills/described");
        assert_eq!(
            std::fs::read_to_string(installed.join("metadata.json")).unwrap(),
            "{\"version\":1}\n"
        );
    }
}
