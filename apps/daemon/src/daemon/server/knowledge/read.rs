//! Read a handful of vault pages (or heading sections) for the agent.
//!
//! Path-locked to the vault. No index. `maxChars` is a hard budget across all
//! returned chunks so a single tool call cannot dump the vault into context.

use serde_json::{json, Value};

use super::source_ref::{decode_source_ref, extract_section, page_title};
use super::{err, ok, resolve_in_vault, str_field};

const DEFAULT_MAX_CHARS: usize = 8000;
const HARD_MAX_CHARS: usize = 12_000;
const MAX_REFS: usize = 8;

pub(super) fn read(root: &std::path::Path, payload: &Value) -> String {
    let refs = collect_refs(payload);
    if refs.is_empty() {
        return err(
            "invalid_query",
            "sourceRefs is required (1–8 paths or kb:v1: refs)",
        );
    }
    if refs.len() > MAX_REFS {
        return err("invalid_query", "sourceRefs is capped at 8");
    }
    let max_chars = payload
        .get("maxChars")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_MAX_CHARS)
        .clamp(1, HARD_MAX_CHARS);

    let mut chunks = Vec::new();
    let mut omitted = Vec::new();
    let mut used = 0usize;

    for raw in refs {
        let (path, heading) = match decode_source_ref(&raw) {
            Ok(v) => v,
            Err(_) => {
                omitted.push(json!({ "sourceRef": raw, "reason": "invalid_ref" }));
                continue;
            }
        };
        let abs = match resolve_in_vault(root, &path) {
            Ok(p) => p,
            Err(_) => {
                omitted.push(json!({ "sourceRef": raw, "reason": "not_in_vault" }));
                continue;
            }
        };
        let Ok(content) = std::fs::read_to_string(&abs) else {
            omitted.push(json!({ "sourceRef": raw, "reason": "not_found" }));
            continue;
        };
        let section = extract_section(&content, heading.as_deref());
        let remaining = max_chars.saturating_sub(used);
        if remaining == 0 {
            omitted.push(json!({ "sourceRef": raw, "reason": "budget" }));
            continue;
        }
        let body = if section.chars().count() > remaining {
            section.chars().take(remaining).collect::<String>()
        } else {
            section
        };
        used += body.chars().count();
        let title = {
            let t = page_title(&content);
            if t.is_empty() {
                path.clone()
            } else {
                t
            }
        };
        chunks.push(json!({
            "sourceRef": super::source_ref::encode_source_ref(&path, heading.as_deref()),
            "path": path,
            "title": title,
            "heading": heading,
            "content": body,
            "contentHash": crate::sync::oss::crypto::sha256_hex(content.as_bytes()),
        }));
    }

    ok(json!({ "chunks": chunks, "omitted": omitted }))
}

fn collect_refs(payload: &Value) -> Vec<String> {
    if let Some(arr) = payload.get("sourceRefs").and_then(Value::as_array) {
        return arr
            .iter()
            .filter_map(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
    }
    if let Some(one) = str_field(payload, "sourceRef") {
        return vec![one.to_string()];
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    fn vault() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("40-runbooks")).unwrap();
        std::fs::write(
            root.join("40-runbooks/payment.md"),
            "# 支付回调故障处理\n\nintro\n\n## 回滚步骤\n\n先停渠道再回滚。\n\n## 超时策略\n\n别读这段。\n",
        )
        .unwrap();
        tmp
    }

    fn run(root: &Path, payload: Value) -> Value {
        serde_json::from_str(&read(root, &payload)).unwrap()
    }

    #[test]
    fn reads_a_heading_section_and_hashes_the_page() {
        let tmp = vault();
        let v = run(
            tmp.path(),
            json!({ "sourceRefs": ["40-runbooks/payment.md#回滚步骤"] }),
        );
        assert_eq!(v["ok"], true, "{v}");
        let chunks = v["result"]["chunks"].as_array().unwrap();
        assert_eq!(chunks.len(), 1, "{v}");
        let content = chunks[0]["content"].as_str().unwrap();
        assert!(content.contains("先停渠道再回滚"), "{content}");
        assert!(!content.contains("别读这段"), "{content}");
        assert_eq!(chunks[0]["title"], "支付回调故障处理");
        assert_eq!(chunks[0]["heading"], "回滚步骤");
        assert_eq!(chunks[0]["contentHash"].as_str().unwrap().len(), 64);
        assert!(v["result"]["omitted"].as_array().unwrap().is_empty());
    }

    #[test]
    fn missing_files_are_omitted_not_fatal() {
        let tmp = vault();
        let v = run(
            tmp.path(),
            json!({ "sourceRefs": ["nope.md", "40-runbooks/payment.md"] }),
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["result"]["chunks"].as_array().unwrap().len(), 1);
        assert_eq!(v["result"]["omitted"][0]["reason"], "not_found");
    }

    #[test]
    fn traversal_is_rejected() {
        let tmp = vault();
        let v = run(tmp.path(), json!({ "sourceRefs": ["../secret.md"] }));
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["result"]["chunks"].as_array().unwrap().len(), 0);
        assert_eq!(v["result"]["omitted"][0]["reason"], "not_in_vault");
    }

    #[test]
    fn max_chars_is_a_hard_budget() {
        let tmp = vault();
        let v = run(
            tmp.path(),
            json!({
                "sourceRefs": ["40-runbooks/payment.md"],
                "maxChars": 8
            }),
        );
        let content = v["result"]["chunks"][0]["content"].as_str().unwrap();
        assert!(content.chars().count() <= 8, "{content}");
    }
}
