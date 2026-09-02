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
//! import. It keeps the parallel (rayon) directory walk, because a zip can
//! carry its `SKILL.md` at any depth.

use std::path::{Path, PathBuf};

use teamclu_skillpack::{build_manifest, write_origin, SkillOrigin, ORIGIN_VERSION};

use super::clawhub::{extract_zip_to_dir, now_millis};

const SOURCE_IMPORT: &str = "import";

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
pub fn import_skill_from_zip(
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

// ─── Legacy helpers (still used by import_skill_from_zip) ───────────────────

/// Copy skill directory excluding .git and other metadata
fn copy_skill_directory(src: &Path, dst: &Path) -> Result<(), String> {
    use std::fs;

    let exclude_files = ["metadata.json"];
    let exclude_dirs = [".git", "__pycache__", "__pypackages__"];

    let mut copy_dirs = vec![(src.to_path_buf(), dst.to_path_buf())];

    while let Some((src_dir, dst_dir)) = copy_dirs.pop() {
        if let Ok(entries) = fs::read_dir(&src_dir) {
            for entry in entries.flatten() {
                let src_path = entry.path();
                let file_name = entry.file_name();
                let name = file_name.to_string_lossy();

                // Skip excluded files and directories
                if exclude_files.contains(&name.as_ref()) {
                    continue;
                }

                if src_path.is_dir() {
                    if exclude_dirs.contains(&name.as_ref()) || name.starts_with('.') {
                        continue;
                    }

                    let dst_path = dst_dir.join(&file_name);
                    if fs::create_dir_all(&dst_path).is_ok() {
                        copy_dirs.push((src_path, dst_path));
                    }
                } else {
                    // Skip hidden files (starting with .)
                    if name.starts_with('.') {
                        continue;
                    }

                    let dst_path = dst_dir.join(&file_name);
                    let _ = fs::copy(&src_path, &dst_path);
                }
            }
        }
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
        import_skill_from_zip(None, zip.display().to_string(), true, force)
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
}
