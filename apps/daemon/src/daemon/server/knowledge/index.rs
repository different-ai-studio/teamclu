//! Full-text search over the knowledge vault via SQLite FTS5.
//!
//! The index lives at `<vault>/.index/fts.sqlite` — inside the vault root so
//! it survives with the vault, but dot-prefixed so the sync scanner and the
//! Obsidian file tree both ignore it (see `collect_md_files`'s dot-skip).
//!
//! Strategy: open-and-sync. Each `search` call first reconciles the index
//! with the files currently on disk (cheap: we compare mtime per path),
//! then runs the FTS query. The vault is a few hundred files at most, so a
//! full reconcile is a few milliseconds; incremental updates keep it O(changed).
//!
//! Tokenizer: FTS5 `trigram`. `unicode61` treats a run of CJK ideographs as
//! one token, so a query for 渠道 never matches 检查渠道状态页 — the exact
//! query shape a Chinese-first vault produces. Trigram indexes 3-character
//! substrings of every script, which gives real substring recall for both
//! CJK and latin text at the cost of a larger index (fine at vault scale).
//!
//! Query path: terms shorter than 3 chars (every 2-char Chinese word —
//! 渠道, 支付, 对账 — is one) can't trigram-match, so those go through a
//! plain LIKE scan. Longer terms use FTS5 with ranking. Mixed queries AND
//! both paths.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::{collect_md_files, err, ok, str_field, MAX_SEARCH_RESULTS};

fn db_path(root: &Path) -> PathBuf {
    root.join(".index").join("fts.sqlite")
}

fn open_db(root: &Path) -> Result<Connection, String> {
    let path = db_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating index dir failed: {e}"))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("opening index failed: {e}"))?;
    conn.pragma_update(None, "journal_mode", "wal")
        .map_err(|e| format!("pragma failed: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            mtime INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(
            path UNINDEXED,
            title,
            body,
            tokenize = 'trigram'
        );",
    )
    .map_err(|e| format!("schema failed: {e}"))?;
    Ok(conn)
}

/// Reconcile the index with what's on disk. Returns (indexed, removed).
fn sync_index(conn: &Connection, root: &Path) -> Result<(usize, usize), String> {
    let mut files = Vec::new();
    collect_md_files(root, root, &mut files);

    let mut on_disk: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for (rel, abs) in &files {
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let mtime = abs
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        on_disk.insert(rel_str, mtime);
    }

    // Drop indexed rows for files that disappeared.
    let mut removed = 0usize;
    {
        let mut stmt = conn
            .prepare("SELECT path FROM files")
            .map_err(|e| e.to_string())?;
        let stale: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .filter(|p| !on_disk.contains_key(p))
            .collect();
        for p in &stale {
            conn.execute("DELETE FROM files WHERE path = ?1", params![p])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM pages WHERE path = ?1", params![p])
                .map_err(|e| e.to_string())?;
            removed += 1;
        }
    }

    // Reindex new or changed files.
    let mut indexed = 0usize;
    for (rel_str, mtime) in &on_disk {
        let current: Option<i64> = conn
            .query_row(
                "SELECT mtime FROM files WHERE path = ?1",
                params![rel_str],
                |r| r.get(0),
            )
            .ok();
        if current == Some(*mtime) {
            continue;
        }
        let abs = root.join(rel_str);
        let Ok(content) = std::fs::read_to_string(&abs) else {
            continue;
        };
        let title = content
            .lines()
            .find(|l| l.starts_with("# "))
            .map(|l| l.trim_start_matches('#').trim().to_string())
            .unwrap_or_else(|| rel_str.clone());
        conn.execute(
            "INSERT OR REPLACE INTO files (path, mtime) VALUES (?1, ?2)",
            params![rel_str, mtime],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM pages WHERE path = ?1", params![rel_str])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO pages (path, title, body) VALUES (?1, ?2, ?3)",
            params![rel_str, title, content],
        )
        .map_err(|e| e.to_string())?;
        indexed += 1;
    }
    Ok((indexed, removed))
}

pub(super) fn search(root: &Path, payload: &Value) -> String {
    let Some(query) = str_field(payload, "query") else {
        return err("invalid_query", "query is required");
    };
    if !root.is_dir() {
        return ok(json!({ "results": [], "vaultExists": false }));
    }
    let conn = match open_db(root) {
        Ok(c) => c,
        Err(e) => return err("index_failed", e),
    };
    if let Err(e) = sync_index(&conn, root) {
        return err("index_failed", e);
    }
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| {
            t.chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || (*c as u32) > 0x2E7F)
                .collect()
        })
        .filter(|s: &String| !s.is_empty())
        .collect();
    if terms.is_empty() {
        return ok(json!({ "results": [], "vaultExists": true }));
    }

    // Every term must match (AND). Per term, FTS when it's long enough for the
    // trigram index, LIKE otherwise — see the module docs for why.
    let mut clauses = Vec::new();
    let mut binds: Vec<String> = Vec::new();
    let mut used_fts = false;
    for t in &terms {
        if t.chars().count() >= 3 {
            clauses.push("pages MATCH ?".to_string());
            binds.push(format!("\"{}\"", t.replace('"', "")));
            used_fts = true;
        } else {
            clauses.push("body LIKE ?".to_string());
            binds.push(format!("%{}%", t.replace('%', "").replace('_', "")));
        }
    }
    let sql = format!(
        "SELECT path, title, snippet(pages, 2, '<b>', '</b>', '…', 24) \
         FROM pages WHERE {} LIMIT ?",
        clauses.join(" AND ")
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return err("query_failed", e.to_string()),
    };
    let mut params: Vec<&dyn rusqlite::ToSql> =
        binds.iter().map(|b| b as &dyn rusqlite::ToSql).collect();
    let limit = MAX_SEARCH_RESULTS as i64;
    params.push(&limit);
    let rows = stmt.query_map(params.as_slice(), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    });
    let mut hits = Vec::new();
    match rows {
        Ok(mapped) => {
            for r in mapped.flatten() {
                hits.push(json!({
                    "path": r.0,
                    "title": r.1,
                    "snippet": r.2,
                }));
            }
        }
        Err(e) => return err("query_failed", e.to_string()),
    }
    ok(json!({
        "results": hits,
        "vaultExists": true,
        "engine": if used_fts { "fts5+like" } else { "like" },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_finds_cjk_and_english() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("40-runbooks")).unwrap();
        std::fs::write(
            root.join("40-runbooks/push-outage.md"),
            "# Push outage\n\n检查渠道状态页 / Check the channel status page\n",
        )
        .unwrap();
        std::fs::write(root.join("00-home.md"), "# Home\nnothing relevant\n").unwrap();

        let v: Value = serde_json::from_str(&search(root, &json!({ "query": "渠道" }))).unwrap();
        assert_eq!(v["ok"], true);
        let results = v["result"]["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["path"], "40-runbooks/push-outage.md");

        let v2: Value =
            serde_json::from_str(&search(root, &json!({ "query": "channel status" }))).unwrap();
        assert_eq!(v2["result"]["results"].as_array().unwrap().len(), 1);

        // Re-run against the existing index — exercises the incremental path.
        let v3: Value = serde_json::from_str(&search(root, &json!({ "query": "渠道" }))).unwrap();
        assert_eq!(v3["result"]["results"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn deleted_files_leave_the_index() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("a.md"), "# alpha\n").unwrap();
        let _: Value = serde_json::from_str(&search(root, &json!({ "query": "alpha" }))).unwrap();
        std::fs::remove_file(root.join("a.md")).unwrap();
        let v: Value = serde_json::from_str(&search(root, &json!({ "query": "alpha" }))).unwrap();
        assert_eq!(v["result"]["results"].as_array().unwrap().len(), 0);
    }
}
