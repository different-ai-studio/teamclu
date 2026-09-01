//! SKILL.md frontmatter — parse and serialize.
//!
//! Twin of `packages/app/src/lib/skills/frontmatter.ts`. The same frontmatter
//! is read by the desktop (TypeScript) and here, and the two must agree
//! exactly: a field parsed one way in the UI and another way in the daemon
//! means the settings screen shows one thing while the agent gets another.
//! Two different YAML engines disagree on plenty of edge cases, so this is one
//! small format specified once and implemented twice against shared fixtures
//! rather than a dependency on each side.
//!
//! Supported (deliberately a subset of YAML):
//!
//! ```text
//! key: value        plain scalar
//! key: "value"      quoted, \" and \\ unescaped
//! key: 'value'      single-quoted, no escapes
//! key: |            literal block — newlines preserved
//! key: >            folded block — newlines become spaces
//! key:              list, one "- item" per line
//!   - item
//! key: [a, b]       inline list
//! ```
//!
//! Anything else is kept as a raw string rather than rejected: a skill with an
//! exotic field should still load, it just does not get structured access.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrontmatterValue {
    Scalar(String),
    List(Vec<String>),
}

impl FrontmatterValue {
    pub fn as_scalar(&self) -> Option<&str> {
        match self {
            Self::Scalar(s) => Some(s.as_str()),
            Self::List(_) => None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ParsedFrontmatter {
    /// Insertion order is not preserved; callers that re-serialize supply an
    /// explicit key order, so a stable map is the more useful shape here.
    pub data: BTreeMap<String, FrontmatterValue>,
    pub body: String,
    pub has_frontmatter: bool,
}

impl ParsedFrontmatter {
    /// A single string field, trimmed, `None` when absent, empty, or a list.
    pub fn string(&self, key: &str) -> Option<&str> {
        self.data
            .get(key)
            .and_then(FrontmatterValue::as_scalar)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    /// `Some` when the key is present, including an empty scalar or a list.
    /// Distinguishes "agent cleared this field" from "the draft never had it".
    pub fn present_string(&self, key: &str) -> Option<String> {
        self.data.get(key).map(|v| match v {
            FrontmatterValue::Scalar(s) => s.trim().to_string(),
            FrontmatterValue::List(items) => items.join(", "),
        })
    }

    /// `Some` when the key is present. Empty scalar → empty vec; scalar with
    /// commas is split so a one-line `requires: a, b` still round-trips.
    pub fn present_list(&self, key: &str) -> Option<Vec<String>> {
        self.data.get(key).map(|v| match v {
            FrontmatterValue::List(items) => items.clone(),
            FrontmatterValue::Scalar(s) => {
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    Vec::new()
                } else {
                    trimmed
                        .split(',')
                        .map(|part| part.trim().to_string())
                        .filter(|part| !part.is_empty())
                        .collect()
                }
            }
        })
    }
}

fn is_fence(line: &str) -> bool {
    let t = line.trim_end_matches([' ', '\t']);
    t == "---"
}

fn unquote(raw: &str) -> String {
    let s = raw.trim();
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        let inner = &s[1..s.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some(next @ ('"' | '\\')) => out.push(next),
                    Some(other) => {
                        out.push('\\');
                        out.push(other);
                    }
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        return out;
    }
    if bytes.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        return s[1..s.len() - 1].to_owned();
    }
    s.to_owned()
}

fn indent_of(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').count()
}

/// Block scalars are dedented by their own first line's indent, not by a fixed
/// amount — an editor that reindents the file must not change the value.
fn read_block(lines: &[&str], start: usize, fold: bool) -> (String, usize) {
    let mut collected: Vec<String> = Vec::new();
    let mut i = start;
    let mut base_indent: Option<usize> = None;

    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            collected.push(String::new());
            i += 1;
            continue;
        }
        let ind = indent_of(line);
        match base_indent {
            None => {
                // A block whose first line is not indented is an empty block.
                if ind == 0 {
                    break;
                }
                base_indent = Some(ind);
            }
            Some(base) => {
                if ind < base {
                    break;
                }
            }
        }
        let base = base_indent.unwrap_or(0);
        collected.push(line.chars().skip(base).collect());
        i += 1;
    }

    // Trailing blank lines belong to the document, not the value.
    while collected.last().is_some_and(|l| l.is_empty()) {
        collected.pop();
    }

    let value = if fold {
        collected
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        collected.join("\n")
    };
    (value, i)
}

fn split_key(line: &str) -> Option<(&str, &str)> {
    let colon = line.find(':')?;
    let key = &line[..colon];
    if key.is_empty() {
        return None;
    }
    let mut chars = key.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    Some((key, line[colon + 1..].trim()))
}

pub fn parse_frontmatter(content: &str) -> ParsedFrontmatter {
    let normalized = content.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    if lines.first().map(|l| is_fence(l)) != Some(true) {
        return ParsedFrontmatter {
            data: BTreeMap::new(),
            body: normalized,
            has_frontmatter: false,
        };
    }

    // An unterminated fence is a malformed file, not frontmatter — treating the
    // whole document as frontmatter would swallow the body.
    let Some(end) = lines.iter().skip(1).position(|l| is_fence(l)).map(|p| p + 1) else {
        return ParsedFrontmatter {
            data: BTreeMap::new(),
            body: normalized,
            has_frontmatter: false,
        };
    };

    let region = &lines[1..end];
    let mut data: BTreeMap<String, FrontmatterValue> = BTreeMap::new();
    let mut i = 0usize;

    while i < region.len() {
        let line = region[i];
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            i += 1;
            continue;
        }
        let Some((key, rest)) = split_key(line) else {
            i += 1;
            continue;
        };

        if matches!(rest, "|" | "|-" | ">" | ">-") {
            let (value, next) = read_block(region, i + 1, rest.starts_with('>'));
            data.insert(key.to_owned(), FrontmatterValue::Scalar(value));
            i = next;
            continue;
        }

        if rest.is_empty() {
            // Either a list on following lines, or an empty value.
            let mut items = Vec::new();
            let mut j = i + 1;
            while j < region.len() {
                let item = region[j].trim();
                let Some(stripped) = item.strip_prefix("- ") else {
                    break;
                };
                items.push(unquote(stripped));
                j += 1;
            }
            if items.is_empty() {
                data.insert(key.to_owned(), FrontmatterValue::Scalar(String::new()));
                i += 1;
            } else {
                data.insert(key.to_owned(), FrontmatterValue::List(items));
                i = j;
            }
            continue;
        }

        if rest.starts_with('[') && rest.ends_with(']') {
            let inner = rest[1..rest.len() - 1].trim();
            let items = if inner.is_empty() {
                Vec::new()
            } else {
                inner.split(',').map(unquote).collect()
            };
            data.insert(key.to_owned(), FrontmatterValue::List(items));
            i += 1;
            continue;
        }

        data.insert(key.to_owned(), FrontmatterValue::Scalar(unquote(rest)));
        i += 1;
    }

    ParsedFrontmatter {
        data,
        body: lines[end + 1..].join("\n"),
        has_frontmatter: true,
    }
}

fn needs_quoting(value: &str) -> bool {
    value != value.trim()
        || value
            .chars()
            .next()
            .is_some_and(|c| "[]{}>|*&!%@`'\"".contains(c))
        || value.contains(": ")
        || value.ends_with(':')
}

fn serialize_scalar(value: &str) -> String {
    if value.contains('\n') {
        let indented = value
            .split('\n')
            .map(|line| {
                if line.is_empty() {
                    String::new()
                } else {
                    format!("  {line}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        return format!("|\n{indented}");
    }
    if needs_quoting(value) {
        return format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""));
    }
    value.to_owned()
}

/// Rewrite a SKILL.md's frontmatter, preserving the body verbatim.
///
/// `key_order` fixes the emission order of known keys so a rewrite does not
/// produce a diff made entirely of moved lines; unknown keys follow, sorted.
pub fn write_frontmatter(
    content: &str,
    updates: &[(&str, Option<FrontmatterValue>)],
    key_order: &[&str],
) -> String {
    let parsed = parse_frontmatter(content);
    let mut merged = parsed.data.clone();
    for (key, value) in updates {
        match value {
            Some(v) => {
                merged.insert((*key).to_owned(), v.clone());
            }
            None => {
                merged.remove(*key);
            }
        }
    }

    let mut ordered: Vec<String> = key_order
        .iter()
        .filter(|k| merged.contains_key(**k))
        .map(|k| (*k).to_owned())
        .collect();
    for key in merged.keys() {
        if !key_order.contains(&key.as_str()) {
            ordered.push(key.clone());
        }
    }

    let mut out = String::from("---\n");
    for key in ordered {
        match merged.get(&key) {
            Some(FrontmatterValue::List(items)) if items.is_empty() => {
                out.push_str(&format!("{key}: []\n"));
            }
            Some(FrontmatterValue::List(items)) => {
                out.push_str(&format!("{key}:\n"));
                for item in items {
                    out.push_str(&format!("  - {}\n", serialize_scalar(item)));
                }
            }
            Some(FrontmatterValue::Scalar(value)) => {
                out.push_str(&format!("{key}: {}\n", serialize_scalar(value)));
            }
            None => {}
        }
    }
    out.push_str("---");

    let body = if parsed.has_frontmatter {
        parsed.body
    } else {
        format!("\n{}", parsed.body)
    };
    if body.starts_with('\n') {
        out.push_str(&body);
    } else {
        out.push('\n');
        out.push_str(&body);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // These fixtures are duplicated in the TypeScript twin's test file. When you
    // add a case here, add it there — that pairing is the only thing keeping the
    // two implementations honest.

    #[test]
    fn parses_plain_and_quoted_scalars() {
        let src = "---\nname: deploy-check\ndescription: \"a: colon inside\"\nowner: 'zhang san'\n---\n# Body\n";
        let p = parse_frontmatter(src);
        assert!(p.has_frontmatter);
        assert_eq!(p.string("name"), Some("deploy-check"));
        assert_eq!(p.string("description"), Some("a: colon inside"));
        assert_eq!(p.string("owner"), Some("zhang san"));
        assert_eq!(p.body, "# Body\n");
    }

    #[test]
    fn parses_literal_block_preserving_newlines() {
        let src = "---\nwhen_not_to_use: |\n  不要用于本地开发。\n  也不要用于 hotfix 流程。\n---\nbody";
        let p = parse_frontmatter(src);
        assert_eq!(
            p.string("when_not_to_use"),
            Some("不要用于本地开发。\n也不要用于 hotfix 流程。")
        );
    }

    #[test]
    fn parses_folded_block_joining_lines() {
        let src = "---\nsummary: >\n  one\n  two\n---\nbody";
        let p = parse_frontmatter(src);
        assert_eq!(p.string("summary"), Some("one two"));
    }

    #[test]
    fn block_ends_at_next_key() {
        let src = "---\nwhen_to_use: |\n  first\nname: after\n---\nbody";
        let p = parse_frontmatter(src);
        assert_eq!(p.string("when_to_use"), Some("first"));
        assert_eq!(p.string("name"), Some("after"));
    }

    #[test]
    fn parses_block_and_inline_lists() {
        let src = "---\nrequires:\n  - macos\n  - autoui-mcp-server\ntags: [a, b]\nempty: []\n---\nbody";
        let p = parse_frontmatter(src);
        assert_eq!(
            p.data.get("requires"),
            Some(&FrontmatterValue::List(vec![
                "macos".into(),
                "autoui-mcp-server".into()
            ]))
        );
        assert_eq!(
            p.data.get("tags"),
            Some(&FrontmatterValue::List(vec!["a".into(), "b".into()]))
        );
        assert_eq!(p.data.get("empty"), Some(&FrontmatterValue::List(vec![])));
    }

    #[test]
    fn no_frontmatter_keeps_whole_document_as_body() {
        let src = "# Just a heading\n\ntext";
        let p = parse_frontmatter(src);
        assert!(!p.has_frontmatter);
        assert_eq!(p.body, src);
        assert!(p.data.is_empty());
    }

    #[test]
    fn unterminated_fence_is_not_frontmatter() {
        // Otherwise the entire body gets swallowed as metadata.
        let src = "---\nname: x\n\nstill body";
        let p = parse_frontmatter(src);
        assert!(!p.has_frontmatter);
        assert_eq!(p.body, src);
    }

    #[test]
    fn crlf_is_normalized() {
        let src = "---\r\nname: x\r\n---\r\nbody\r\n";
        let p = parse_frontmatter(src);
        assert_eq!(p.string("name"), Some("x"));
        assert_eq!(p.body, "body\n");
    }

    #[test]
    fn write_roundtrips_and_preserves_body() {
        let src = "---\nname: deploy-check\ndescription: old\n---\n# Body\n\ntext\n";
        let out = write_frontmatter(
            src,
            &[
                (
                    "when_not_to_use",
                    Some(FrontmatterValue::Scalar("line one\nline two".into())),
                ),
                ("description", Some(FrontmatterValue::Scalar("new".into()))),
            ],
            &["name", "description", "when_not_to_use"],
        );
        let p = parse_frontmatter(&out);
        assert_eq!(p.string("description"), Some("new"));
        assert_eq!(p.string("when_not_to_use"), Some("line one\nline two"));
        assert_eq!(p.body, "# Body\n\ntext\n");
    }

    #[test]
    fn write_quotes_values_that_would_reparse_wrong() {
        let out = write_frontmatter(
            "---\nname: x\n---\nbody",
            &[(
                "summary",
                Some(FrontmatterValue::Scalar("key: value".into())),
            )],
            &["name"],
        );
        assert!(out.contains("summary: \"key: value\""));
        assert_eq!(
            parse_frontmatter(&out).string("summary"),
            Some("key: value")
        );
    }

    #[test]
    fn write_adds_frontmatter_to_a_bare_document() {
        let out = write_frontmatter(
            "# Heading\n",
            &[("name", Some(FrontmatterValue::Scalar("x".into())))],
            &["name"],
        );
        assert!(out.starts_with("---\nname: x\n---\n"));
        assert_eq!(parse_frontmatter(&out).body.trim(), "# Heading");
    }
}
