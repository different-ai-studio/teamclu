//! Copying and zipping a skill directory.

use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

pub(super) fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create {}: {}", dst.display(), e))?;
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("Failed to read {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("Failed to stat {}: {}", entry.path().display(), e))?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &to)
                .map_err(|e| format!("Failed to copy {}: {}", entry.path().display(), e))?;
        }
    }
    Ok(())
}

pub(super) fn zip_skill_files(dir: &Path, included: &[String]) -> Result<Vec<u8>, String> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for rel in included {
        let full = dir.join(if std::path::MAIN_SEPARATOR == '/' {
            std::path::PathBuf::from(rel)
        } else {
            std::path::PathBuf::from(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
        });
        let mut file_opts = opts;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::symlink_metadata(&full) {
                if !meta.is_file() {
                    continue;
                }
                file_opts = file_opts.unix_permissions(meta.permissions().mode() & 0o777);
            }
        }
        writer
            .start_file(rel, file_opts)
            .map_err(|e| format!("zip start: {e}"))?;
        let bytes =
            std::fs::read(&full).map_err(|e| format!("Failed to read {}: {e}", full.display()))?;
        writer
            .write_all(&bytes)
            .map_err(|e| format!("zip write: {e}"))?;
    }

    let finished = writer.finish().map_err(|e| format!("zip finish: {e}"))?;
    Ok(finished.into_inner())
}

#[cfg(test)]
mod tests {
    use super::zip_skill_files;

    fn write(dir: &std::path::Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn zip_names(bytes: &[u8]) -> Vec<String> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names = Vec::new();
        for i in 0..archive.len() {
            names.push(archive.by_index(i).unwrap().name().to_string());
        }
        names.sort();
        names
    }

    #[test]
    fn zip_matches_the_package_index() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("pack");
        write(&dir, "SKILL.md", "---\nname: pack\n---\nbody\n");
        write(&dir, "scripts/run.sh", "#!/bin/sh\n");
        write(&dir, ".DS_Store", "finder");
        write(&dir, ".teamcluignore", "results/\n");
        write(&dir, "results/out.json", "{}\n");
        write(&dir, ".clawhub/origin.json", "{}\n");

        let included = teamclu_skillpack::list_managed_paths(&dir).unwrap();
        let names = zip_names(&zip_skill_files(&dir, &included).unwrap());
        assert_eq!(
            names,
            vec![
                ".teamcluignore".to_string(),
                "SKILL.md".to_string(),
                "scripts/run.sh".to_string(),
            ]
        );
    }
}
