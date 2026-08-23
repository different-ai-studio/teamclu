//! Build an app workspace into a deployable artifact zip.
//!
//! The async presigned-URL upload lives in the HTTP handler (reqwest is async);
//! this module stays sync so it can run inside `spawn_blocking`.

use crate::process_util::CommandNoWindow;
use std::io::Write;
use std::path::Path;
use std::process::Command;
use walkdir::WalkDir;

/// OSS object key for an app's built code artifact.
pub fn oss_object_key(app_id: &str) -> String {
    format!("apps/{app_id}/code.zip")
}

/// Recursively zip `dir` into in-memory deflate bytes, with paths relative to `dir`.
pub fn zip_dir(dir: &Path) -> anyhow::Result<Vec<u8>> {
    let buf = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(buf);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for entry in WalkDir::new(dir) {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
            let rel = path.strip_prefix(dir)?.to_string_lossy().replace('\\', "/");
            zip.start_file(rel, opts)?;
            let bytes = std::fs::read(path)?;
            zip.write_all(&bytes)?;
        }
    }
    let cursor = zip.finish()?;
    Ok(cursor.into_inner())
}

fn run(cmd: &str, args: &[&str], cwd: &Path) -> anyhow::Result<()> {
    let out = Command::new(cmd)
        .no_window()
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()?;
    if !out.status.success() {
        anyhow::bail!(
            "{cmd} {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// Run `pnpm install` then `pnpm build` in `workdir`, then zip the `.output` dir.
///
/// The install is `--frozen-lockfile`: the app template ships a committed
/// `pnpm-lock.yaml` with exact versions, and resolving fresh here would let a
/// new upstream release break the build of an app whose own code never changed.
pub fn build_artifact(workdir: &Path) -> anyhow::Result<Vec<u8>> {
    run("pnpm", &["install", "--frozen-lockfile"], workdir)?;
    run("pnpm", &["build"], workdir)?;
    zip_dir(&workdir.join(".output"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn oss_object_key_is_apps_appid_codezip() {
        assert_eq!(oss_object_key("app-123"), "apps/app-123/code.zip");
    }

    #[test]
    fn zip_dir_archives_files_with_relative_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("out");
        std::fs::create_dir_all(root.join("server")).unwrap();
        std::fs::write(root.join("server/index.mjs"), b"console.log(1)").unwrap();
        std::fs::write(root.join("public.txt"), b"hi").unwrap();

        let bytes = zip_dir(&root).unwrap();
        assert!(!bytes.is_empty());

        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert!(
            names.iter().any(|n| n == "server/index.mjs"),
            "names: {names:?}"
        );
        assert!(names.iter().any(|n| n == "public.txt"), "names: {names:?}");

        let mut f = archive.by_name("server/index.mjs").unwrap();
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        assert_eq!(s, "console.log(1)");
    }
}
