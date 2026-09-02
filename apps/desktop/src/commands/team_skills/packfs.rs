//! Copying and zipping a skill directory.

use zip::write::SimpleFileOptions;
use zip::ZipWriter;

pub(super) fn copy_dir_recursive(
    src: &std::path::Path,
    dst: &std::path::Path,
) -> Result<(), String> {
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

/// Zip a skill directory for upload.
///
/// `.clawhub/` is left out. It is this machine's private record of what was
/// installed here — including the full file manifest — and shipping it means
/// every member downloads the publisher's bookkeeping and then overwrites it
/// with their own on install. A package that carries one machine's install
/// state is also the kind of thing that makes two installs of the "same"
/// version differ.
pub(super) fn zip_skill_dir(dir: &std::path::Path) -> Result<Vec<u8>, String> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    fn add_tree(
        writer: &mut ZipWriter<std::io::Cursor<Vec<u8>>>,
        opts: SimpleFileOptions,
        base: &std::path::Path,
        rel: &std::path::Path,
    ) -> Result<(), String> {
        let full = base.join(rel);
        if full.is_dir() {
            for entry in std::fs::read_dir(&full)
                .map_err(|e| format!("Failed to read {}: {}", full.display(), e))?
            {
                let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
                let name = entry.file_name();
                // Only the top-level bookkeeping dir is ours; one nested deeper
                // belongs to the package, same rule the manifest walk uses.
                if rel.as_os_str().is_empty() && name == teamclu_skillpack::ORIGIN_DIR {
                    continue;
                }
                let child_rel = rel.join(&name);
                add_tree(writer, opts, base, &child_rel)?;
            }
        } else if full.is_file() {
            let name = rel.to_string_lossy().replace('\\', "/");
            let mut opts = opts;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&full) {
                    // Carry the exec bit into the archive, or every member
                    // downloads a script they cannot run.
                    opts = opts.unix_permissions(meta.permissions().mode() & 0o777);
                }
            }
            writer
                .start_file(name, opts)
                .map_err(|e| format!("zip start: {}", e))?;
            let bytes = std::fs::read(&full)
                .map_err(|e| format!("Failed to read {}: {}", full.display(), e))?;
            use std::io::Write;
            writer
                .write_all(&bytes)
                .map_err(|e| format!("zip write: {}", e))?;
        }
        Ok(())
    }

    add_tree(&mut writer, opts, dir, std::path::Path::new(""))?;
    let finished = writer.finish().map_err(|e| format!("zip finish: {}", e))?;
    Ok(finished.into_inner())
}
