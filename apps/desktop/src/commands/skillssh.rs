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

use std::io::Read;
use std::path::{Path, PathBuf};

// ─── Import skill from local .zip (manual upload) ─────────────────────────────

/// Sanitize a relative path inside a zip (same rules as ClawHub).
fn sanitize_skill_zip_path(raw: &str) -> Option<String> {
    let normalized = raw.trim_start_matches("./").trim_start_matches('/');
    if normalized.is_empty() || normalized.ends_with('/') {
        return None;
    }
    if normalized.contains("..") || normalized.contains('\\') {
        return None;
    }
    Some(normalized.to_string())
}

fn extract_skill_zip_to_dir(zip_path: &Path, target_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {}", e))?;

    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create extract dir: {}", e))?;

    let canonical_target = target_dir
        .canonicalize()
        .unwrap_or_else(|_| target_dir.to_path_buf());

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry {}: {}", i, e))?;

        let raw_name = file.name().to_string();
        let safe_path = match sanitize_skill_zip_path(&raw_name) {
            Some(p) => p,
            None => continue,
        };

        let out_path = target_dir.join(&safe_path);

        if let Ok(canonical_out) = out_path.canonicalize() {
            if !canonical_out.starts_with(&canonical_target) {
                eprintln!(
                    "[Skills] Skipping zip entry with path traversal: {}",
                    raw_name
                );
                continue;
            }
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create parent dir for zip entry {}: {}",
                    safe_path, e
                )
            })?;
        }

        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read zip entry bytes {}: {}", safe_path, e))?;
        std::fs::write(&out_path, &buf)
            .map_err(|e| format!("Failed to write extracted file {}: {}", safe_path, e))?;
    }

    Ok(())
}

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
        extract_skill_zip_to_dir(&zip_path, &temp_dir)?;

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

        if target_dir.exists() {
            let _ = fs::remove_dir_all(&target_dir);
        }

        fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Failed to create target directory: {}", e))?;

        copy_skill_directory(&skill_src_dir.to_path_buf(), &target_dir)?;

        Ok(format!(
            "Imported skill '{}' to {}",
            slug,
            target_dir.display()
        ))
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    import_result
}

/// Discover skill directory in cloned repo following vercel-labs/skills pattern
fn discover_skill_directory(
    repo_path: &std::path::PathBuf,
    slug: &str,
) -> Result<std::path::PathBuf, String> {
    use std::fs;

    // Priority search paths (same as vercel-labs/skills)
    let search_dirs = vec![
        repo_path.clone(),
        repo_path.join("skills"),
        repo_path.join("skills").join(".curated"),
        repo_path.join("skills").join(".experimental"),
        repo_path.join("skills").join(".system"),
        repo_path.join(".agent").join("skills"),
        repo_path.join(".agents").join("skills"),
        repo_path.join(".claude").join("skills"),
        repo_path.join(".cline").join("skills"),
        repo_path.join(".codebuddy").join("skills"),
        repo_path.join(".codex").join("skills"),
        repo_path.join(".commandcode").join("skills"),
        repo_path.join(".continue").join("skills"),
        repo_path.join(".github").join("skills"),
        repo_path
            .join(".github")
            .join("plugins")
            .join("azure-skills")
            .join("skills"), // Microsoft Azure Skills
        repo_path.join(".goose").join("skills"),
        repo_path.join(".iflow").join("skills"),
        repo_path.join(".junie").join("skills"),
        repo_path.join(".kilocode").join("skills"),
        repo_path.join(".kiro").join("skills"),
        repo_path.join(".mux").join("skills"),
        repo_path.join(".neovate").join("skills"),
        repo_path.join(".opencode").join("skills"),
        repo_path.join(".openhands").join("skills"),
        repo_path.join(".pi").join("skills"),
        repo_path.join(".qoder").join("skills"),
        repo_path.join(".roo").join("skills"),
        repo_path.join(".trae").join("skills"),
        repo_path.join(".windsurf").join("skills"),
        repo_path.join(".zencoder").join("skills"),
    ];

    let mut all_skills = Vec::new();

    // First, search in priority directories
    for dir in &search_dirs {
        if dir.exists() && dir.is_dir() {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() && path.join("SKILL.md").exists() {
                        all_skills.push(path);
                    }
                }
            }
        }

        // Also check if the directory itself has SKILL.md (for root-level skills)
        if dir.join("SKILL.md").exists() {
            all_skills.push(dir.clone());
        }
    }

    // If nothing found in priority paths, do recursive search
    if all_skills.is_empty() {
        all_skills = find_all_skill_dirs(repo_path, 0, 5)?;
    }

    // Find the best match
    let mut found_dir = None;

    // Priority 1: Match by frontmatter name in SKILL.md
    for skill_dir in &all_skills {
        let skill_md = skill_dir.join("SKILL.md");
        if let Ok(content) = fs::read_to_string(&skill_md) {
            if let Some(name) = extract_frontmatter_name(&content) {
                if name == slug {
                    found_dir = Some(skill_dir.clone());
                    break;
                }
            }
        }
    }

    // Priority 2: Match by directory name
    if found_dir.is_none() {
        for skill_dir in &all_skills {
            if let Some(dir_name) = skill_dir.file_name() {
                if dir_name.to_string_lossy() == slug {
                    found_dir = Some(skill_dir.clone());
                    break;
                }
            }
        }
    }

    // Priority 3: If only one skill found, use it
    if found_dir.is_none() && all_skills.len() == 1 {
        found_dir = Some(all_skills[0].clone());
    }

    found_dir.ok_or_else(|| format!("Could not find skill '{}' in repository", slug))
}

/// Recursively find all directories containing SKILL.md (parallel version)
/// Uses rayon for parallel directory traversal, significantly faster for large repositories
fn find_all_skill_dirs(
    dir: &std::path::PathBuf,
    depth: usize,
    max_depth: usize,
) -> Result<Vec<std::path::PathBuf>, String> {
    use rayon::prelude::*;
    use std::fs;

    if depth > max_depth {
        return Ok(Vec::new());
    }

    let skip_dirs = vec![
        ".git",
        "node_modules",
        "dist",
        "build",
        "__pycache__",
        "target",
    ];
    let mut result = Vec::new();

    // Check if current dir has SKILL.md
    if dir.join("SKILL.md").exists() {
        result.push(dir.clone());
    }

    // Search subdirectories in parallel
    // Performance: 3-10x speedup compared to serial search (scales with CPU cores)
    if let Ok(entries) = fs::read_dir(dir) {
        // Phase 1: Collect all valid subdirectories (sequential, fast)
        // Filter out .git, node_modules, etc. to avoid wasting thread resources
        let subdirs: Vec<std::path::PathBuf> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(name) = path.file_name() {
                        let name_str = name.to_string_lossy();
                        if !skip_dirs.contains(&name_str.as_ref()) {
                            return Some(path);
                        }
                    }
                }
                None
            })
            .collect();

        // Phase 2: Parallel recursive search on all subdirectories
        // Each subdir is processed by a separate thread from rayon's thread pool
        // Threads automatically "steal" work from each other for load balancing
        let parallel_results: Vec<std::path::PathBuf> = subdirs
            .par_iter() // 🚀 Parallel iterator - uses all CPU cores
            .flat_map(|subdir| {
                // Recursively search each subdir in parallel
                // unwrap_or_default() isolates errors (one failing subdir doesn't affect others)
                find_all_skill_dirs(subdir, depth + 1, max_depth).unwrap_or_default()
            })
            .collect();

        result.extend(parallel_results);
    }

    Ok(result)
}

/// Extract name from SKILL.md frontmatter (YAML)
fn extract_frontmatter_name(content: &str) -> Option<String> {
    // Simple YAML frontmatter parser for name field
    let lines: Vec<&str> = content.lines().collect();

    if lines.is_empty() || !lines[0].starts_with("---") {
        return None;
    }

    for line in lines.iter().skip(1) {
        if line.starts_with("---") {
            break;
        }

        if line.trim_start().starts_with("name:") {
            let name = line.split(':').nth(1)?.trim();
            // Remove quotes if present
            let name = name.trim_matches('"').trim_matches('\'');
            return Some(name.to_string());
        }
    }

    None
}

// ─── Legacy helpers (still used by import_skill_from_zip) ───────────────────

/// Copy skill directory excluding .git and other metadata
fn copy_skill_directory(src: &std::path::PathBuf, dst: &std::path::PathBuf) -> Result<(), String> {
    use std::fs;

    let exclude_files = vec!["metadata.json"];
    let exclude_dirs = vec![".git", "__pycache__", "__pypackages__"];

    let mut copy_dirs = vec![(src.clone(), dst.clone())];

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
                    if let Ok(_) = fs::create_dir_all(&dst_path) {
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
