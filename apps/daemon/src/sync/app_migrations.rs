//! An app's database migrations: the `migrations/*.sql` files of its checkout.
//!
//! The daemon only reads them; the Cloud API runs them at deploy finalize,
//! because it is the one place that can reach the app's database (see
//! `services/fc/src/lib/provisioning/app-migrations.ts`). They are read from
//! the checkout the build just used, so what runs is what that revision holds.
//!
//! The rules here mirror the server's so a bad folder fails before a build
//! spends minutes, with a message about the file rather than a 400.

use std::path::Path;

use serde::Serialize;

/// The folder, relative to the checkout root.
pub const MIGRATIONS_DIR: &str = "migrations";
pub const MAX_MIGRATIONS: usize = 500;
pub const MAX_MIGRATION_BYTES: u64 = 512 * 1024;
pub const MAX_MIGRATIONS_TOTAL_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppMigration {
    /// File name, e.g. `0001_create_scan_tasks.sql`.
    pub name: String,
    pub sql: String,
}

/// `0001_create_tasks.sql`: 1–16 digits, `_`, then a letter or digit and up to
/// 100 of `[A-Za-z0-9_.-]`, ending `.sql`. Same grammar as the server.
pub fn is_migration_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".sql") else {
        return false;
    };
    let Some((digits, rest)) = stem.split_once('_') else {
        return false;
    };
    // `rest` is what sits between the first `_` and `.sql`: one letter or
    // digit, then up to 100 more.
    (1..=16).contains(&digits.len())
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (1..=101).contains(&rest.len())
        && rest.starts_with(|c: char| c.is_ascii_alphanumeric())
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// Read the checkout's migrations, sorted by name (the order they run in).
///
/// No folder means none. Inside it, every `.sql` file must be a well-named
/// migration: a stray `create_tables.sql` would otherwise never run and nobody
/// would know why the table is missing. Files that are not `.sql` (a README)
/// and subfolders are left alone. A symlink is refused, since it can point
/// outside the checkout.
pub fn read_app_migrations(workdir: &Path) -> anyhow::Result<Vec<AppMigration>> {
    let dir = workdir.join(MIGRATIONS_DIR);
    let meta = match std::fs::symlink_metadata(&dir) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => anyhow::bail!("could not read {MIGRATIONS_DIR}/: {e}"),
    };
    if !meta.is_dir() {
        anyhow::bail!("{MIGRATIONS_DIR} must be a folder of .sql files");
    }
    let mut out = Vec::new();
    let mut total = 0u64;
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.to_ascii_lowercase().ends_with(".sql") {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            anyhow::bail!("{MIGRATIONS_DIR}/{name} is a symlink; migrations must be plain files in the checkout");
        }
        if !file_type.is_file() {
            continue;
        }
        if !is_migration_name(&name) {
            anyhow::bail!(
                "{MIGRATIONS_DIR}/{name} is not named like a migration; use 0001_description.sql (digits, underscore, then letters, digits, _ . -)"
            );
        }
        let size = entry.metadata()?.len();
        if size > MAX_MIGRATION_BYTES {
            anyhow::bail!("{MIGRATIONS_DIR}/{name} is larger than {MAX_MIGRATION_BYTES} bytes");
        }
        total += size;
        if total > MAX_MIGRATIONS_TOTAL_BYTES {
            anyhow::bail!(
                "{MIGRATIONS_DIR}/ holds more than {MAX_MIGRATIONS_TOTAL_BYTES} bytes of SQL"
            );
        }
        let sql = std::fs::read_to_string(entry.path()).map_err(|e| {
            anyhow::anyhow!("could not read {MIGRATIONS_DIR}/{name} as UTF-8 text: {e}")
        })?;
        out.push(AppMigration { name, sql });
        if out.len() > MAX_MIGRATIONS {
            anyhow::bail!("{MIGRATIONS_DIR}/ holds more than {MAX_MIGRATIONS} migrations");
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_server_grammar() {
        for ok in [
            "0001_a.sql",
            "20261124_add-index.v2.sql",
            "1_x.sql",
            "0001_A_b.sql",
        ] {
            assert!(is_migration_name(ok), "{ok}");
        }
        for bad in [
            "a.sql",
            "0001.sql",
            "0001_.sql",
            "0001_x.txt",
            "0001_ x.sql",
            "_0001_x.sql",
            "0001_-x.sql",
            "12345678901234567_x.sql",
        ] {
            assert!(!is_migration_name(bad), "{bad}");
        }
        let longest = format!("0001_{}.sql", "a".repeat(101));
        assert!(is_migration_name(&longest));
        let too_long = format!("0001_{}.sql", "a".repeat(102));
        assert!(!is_migration_name(&too_long));
    }

    #[test]
    fn no_folder_is_no_migrations() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_app_migrations(dir.path()).unwrap(), vec![]);
    }

    #[test]
    fn reads_sql_files_in_name_order_and_skips_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let m = dir.path().join(MIGRATIONS_DIR);
        std::fs::create_dir_all(m.join("old")).unwrap();
        std::fs::write(m.join("0002_b.sql"), "create index b on t (x);").unwrap();
        std::fs::write(m.join("0001_a.sql"), "create table t (x int);").unwrap();
        std::fs::write(m.join("README.md"), "how to write one").unwrap();
        std::fs::write(m.join("old").join("0000_ignored.sql"), "nope").unwrap();
        let got = read_app_migrations(dir.path()).unwrap();
        assert_eq!(
            got.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
            ["0001_a.sql", "0002_b.sql"]
        );
        assert_eq!(got[0].sql, "create table t (x int);");
    }

    #[test]
    fn a_badly_named_sql_file_stops_the_deploy() {
        let dir = tempfile::tempdir().unwrap();
        let m = dir.path().join(MIGRATIONS_DIR);
        std::fs::create_dir_all(&m).unwrap();
        std::fs::write(m.join("create_tables.sql"), "create table t ();").unwrap();
        let err = read_app_migrations(dir.path()).unwrap_err().to_string();
        assert!(
            err.contains("create_tables.sql") && err.contains("0001_description.sql"),
            "{err}"
        );
    }

    #[test]
    fn oversize_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let m = dir.path().join(MIGRATIONS_DIR);
        std::fs::create_dir_all(&m).unwrap();
        std::fs::write(
            m.join("0001_big.sql"),
            "x".repeat(MAX_MIGRATION_BYTES as usize + 1),
        )
        .unwrap();
        assert!(read_app_migrations(dir.path())
            .unwrap_err()
            .to_string()
            .contains("larger than"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.sql"), "select 1").unwrap();
        let m = dir.path().join(MIGRATIONS_DIR);
        std::fs::create_dir_all(&m).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.sql"), m.join("0001_x.sql"))
            .unwrap();
        assert!(read_app_migrations(dir.path())
            .unwrap_err()
            .to_string()
            .contains("symlink"));
    }
}
