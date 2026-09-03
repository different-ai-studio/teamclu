//! Search across the vault: read the pages, match substrings, highlight.
//!
//! **There is no index.** The previous implementation kept an SQLite FTS5
//! table with the `trigram` tokenizer, and it did not deliver what the tool
//! promises for the language this vault is mostly written in:
//!
//! - trigram cannot match a query shorter than three characters, and the most
//!   common Chinese word is two — 渠道, 支付, 对账, 口径, 履约. Those fell back
//!   to a `LIKE` scan of the whole table, so the index was not used on the main
//!   path anyway.
//! - that fallback scanned `body` only, so a term appearing solely in a page's
//!   title missed the page entirely.
//! - `snippet()` in a query with no `MATCH` returns the opening of the document
//!   with no highlight at all, while the MCP manifest promises a highlighted
//!   one.
//!
//! Scanning in memory costs about the same. `search` already walked the whole
//! tree and read every changed file; a vault is a few hundred pages (500 files
//! / 1.2 MiB measures at 26ms in *Python*). In exchange it drops a C
//! dependency — the one whose second copy of sqlite3 broke linking on Linux
//! and Windows — gives Chinese and English identical behaviour, and makes the
//! highlight real for both.
//!
//! If a vault ever grows past the point where this is comfortable, the engine
//! to reach for is `libsql`, already in the dependency tree via
//! `teamclu-gateway`, rather than a second SQLite.

use std::path::Path;

use serde_json::{json, Value};

use super::{collect_md_files, err, ok, str_field, MAX_SEARCH_RESULTS};

/// Characters of context kept either side of the matched term.
const SNIPPET_RADIUS: usize = 40;

/// Lowercase one char to one char.
///
/// `str::to_lowercase` can change a string's length (`İ` becomes two chars),
/// which would misalign the positions found in the lowered text from the
/// original text the snippet is cut out of. A 1:1 mapping keeps the two
/// indexable by the same offsets, and is exact for every script this vault
/// actually holds.
fn lowered(text: &str) -> Vec<char> {
    text.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

fn find_sub(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle)
}

/// A window of `original` around the first occurrence of `needle`, with the
/// match wrapped in `<b>`. Newlines collapse to spaces so the result stays one
/// line in a chat.
fn highlight(original: &[char], lower: &[char], needle: &[char]) -> Option<String> {
    let at = find_sub(lower, needle)?;
    let end_of_match = at + needle.len();
    let start = at.saturating_sub(SNIPPET_RADIUS);
    let end = (end_of_match + SNIPPET_RADIUS).min(original.len());
    let take = |range: std::ops::Range<usize>| -> String {
        original[range]
            .iter()
            .map(|c| if *c == '\n' || *c == '\r' { ' ' } else { *c })
            .collect::<String>()
    };
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(take(start..at).trim_start());
    out.push_str("<b>");
    out.push_str(&take(at..end_of_match));
    out.push_str("</b>");
    out.push_str(take(end_of_match..end).trim_end());
    if end < original.len() {
        out.push('…');
    }
    Some(out)
}

/// Remove an index left behind by a build that kept one.
///
/// Named files only, never the directory wholesale: one of these paths is
/// inside a user's vault. Best-effort — a failure just leaves a stale file.
pub(super) fn drop_stale_index(dir: &Path) {
    if !dir.exists() {
        return;
    }
    for name in ["fts.sqlite", "fts.sqlite-wal", "fts.sqlite-shm"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
    // Only if we emptied it; anything else in there is not ours.
    let _ = std::fs::remove_dir(dir);
}

/// One page that matched, and where.
struct Hit {
    path: String,
    title: String,
    snippet: String,
    /// Title matches sort first: a page named for the thing you asked about is
    /// a better answer than one that mentions it in passing.
    title_match: bool,
}

pub(super) fn search(root: &Path, stale_index_dir: &Path, payload: &Value) -> String {
    let Some(query) = str_field(payload, "query") else {
        return err("invalid_query", "query is required");
    };
    if !root.is_dir() {
        return ok(json!({ "results": [], "vaultExists": false }));
    }
    // Both places an older build could have written one: inside the vault
    // (where the sync engine uploaded it to the whole team) and beside the
    // team's state.
    drop_stale_index(&root.join(".index"));
    drop_stale_index(stale_index_dir);

    let terms: Vec<Vec<char>> = query
        .split_whitespace()
        .map(|t| {
            t.chars()
                .filter(|c| c.is_alphanumeric() || *c == '_')
                .collect::<String>()
        })
        .filter(|s: &String| !s.is_empty())
        .map(|s| lowered(&s))
        .collect();
    if terms.is_empty() {
        return ok(json!({ "results": [], "vaultExists": true }));
    }

    let mut files = Vec::new();
    collect_md_files(root, root, &mut files);
    files.sort();

    let mut hits: Vec<Hit> = Vec::new();
    for (rel, abs) in &files {
        let Ok(content) = std::fs::read_to_string(abs) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let title = content
            .lines()
            .find(|l| l.starts_with("# "))
            .map(|l| l.trim_start_matches('#').trim().to_string())
            .unwrap_or_else(|| rel_str.clone());

        let body_chars: Vec<char> = content.chars().collect();
        let body_lower = lowered(&content);
        let title_chars: Vec<char> = title.chars().collect();
        let title_lower = lowered(&title);

        // Every term must appear somewhere on the page — title or body. The
        // old `LIKE` path looked at the body alone, which lost every page whose
        // subject is only ever named in its heading.
        let matched = terms
            .iter()
            .all(|t| find_sub(&body_lower, t).is_some() || find_sub(&title_lower, t).is_some());
        if !matched {
            continue;
        }
        let title_match = terms.iter().any(|t| find_sub(&title_lower, t).is_some());
        // Highlight the first term that occurs in the body; if the match is
        // title-only, show the opening of the page instead of nothing.
        let snippet = terms
            .iter()
            .find_map(|t| highlight(&body_chars, &body_lower, t))
            .unwrap_or_else(|| {
                let end = body_chars.len().min(SNIPPET_RADIUS * 2);
                let mut s: String = body_chars[..end]
                    .iter()
                    .map(|c| if *c == '\n' || *c == '\r' { ' ' } else { *c })
                    .collect();
                if end < body_chars.len() {
                    s.push('…');
                }
                s.trim().to_string()
            });
        hits.push(Hit {
            path: rel_str,
            title,
            snippet,
            title_match,
        });
        // Keep scanning past the limit would only cost time; stop once the
        // title-first ordering can no longer change the head of the list.
        if hits.len() >= MAX_SEARCH_RESULTS * 4 {
            break;
        }
    }

    hits.sort_by(|a, b| b.title_match.cmp(&a.title_match).then(a.path.cmp(&b.path)));
    hits.truncate(MAX_SEARCH_RESULTS);

    let results: Vec<Value> = hits
        .into_iter()
        .map(|h| json!({ "path": h.path, "title": h.title, "snippet": h.snippet }))
        .collect();
    ok(json!({
        "results": results,
        "vaultExists": true,
        "engine": "substring",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("40-runbooks")).unwrap();
        std::fs::write(
            root.join("40-runbooks/push-outage.md"),
            "# Push outage\n\n排查步骤：先看渠道健康度，再看支付回调。\nCheck the channel status page.\n",
        )
        .unwrap();
        std::fs::write(
            root.join("20-domains-index.md"),
            "# 渠道口径\n\n本页解释各项定义。\n",
        )
        .unwrap();
        std::fs::write(root.join("00-home.md"), "# Home\nnothing relevant\n").unwrap();
        tmp
    }

    fn run(root: &Path, query: &str) -> Value {
        let idx = tempfile::tempdir().unwrap();
        serde_json::from_str(&search(root, idx.path(), &json!({ "query": query }))).unwrap()
    }

    /// The case the FTS5 index could never serve: a two-character Chinese word.
    #[test]
    fn a_two_character_chinese_word_matches_and_highlights() {
        let tmp = vault();
        let v = run(tmp.path(), "渠道");
        assert_eq!(v["ok"], true, "{v}");
        let results = v["result"]["results"].as_array().unwrap();
        assert_eq!(results.len(), 2, "{v}");

        // The page titled 渠道口径 sorts above the one that merely mentions it.
        assert_eq!(results[0]["path"], "20-domains-index.md");
        let snippet = results[1]["snippet"].as_str().unwrap();
        assert!(
            snippet.contains("<b>渠道</b>"),
            "the snippet must highlight the term, got {snippet}"
        );
    }

    /// The old `LIKE` fallback searched the body alone.
    #[test]
    fn a_term_only_in_the_title_still_finds_the_page() {
        let tmp = vault();
        let v = run(tmp.path(), "outage");
        let results = v["result"]["results"].as_array().unwrap();
        assert_eq!(results.len(), 1, "{v}");
        assert_eq!(results[0]["path"], "40-runbooks/push-outage.md");
    }

    #[test]
    fn every_term_must_match_and_english_is_case_insensitive() {
        let tmp = vault();
        assert_eq!(
            run(tmp.path(), "CHANNEL status")["result"]["results"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        // 支付 is on the runbook page, 口径 is not — nothing satisfies both.
        assert_eq!(
            run(tmp.path(), "支付 口径")["result"]["results"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn searching_writes_nothing_into_the_vault() {
        let tmp = vault();
        let before: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        let _ = run(tmp.path(), "渠道");
        let after: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(before.len(), after.len(), "vault gained entries");
    }

    /// An index written by an older build is cleared out on the next search —
    /// in the vault it was being uploaded to the whole team.
    #[test]
    fn a_stale_index_is_removed_from_both_places() {
        let tmp = vault();
        let idx = tempfile::tempdir().unwrap();
        for dir in [
            tmp.path().join(".index"),
            idx.path().join("knowledge-index"),
        ] {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("fts.sqlite"), b"stale").unwrap();
            std::fs::write(dir.join("fts.sqlite-wal"), b"stale").unwrap();
        }
        let reply = search(
            tmp.path(),
            &idx.path().join("knowledge-index"),
            &json!({ "query": "渠道" }),
        );
        assert!(reply.contains("\"ok\":true"));
        assert!(!tmp.path().join(".index").exists());
        assert!(!idx.path().join("knowledge-index").exists());
    }

    /// …but only the files we put there.
    #[test]
    fn stale_cleanup_leaves_foreign_files_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".index");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.txt"), b"mine").unwrap();
        drop_stale_index(&dir);
        assert!(dir.join("notes.txt").exists());
    }
}
