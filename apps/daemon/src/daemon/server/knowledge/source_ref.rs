//! `kb:v1:` refs for knowledge search/read.
//!
//! Path and heading are percent-encoded so a `#` in the path cannot split the
//! ref. A bare vault-relative path is also accepted as a ref, because agents
//! copy `path` off a search hit as often as they copy `sourceRef`.

use urlencoding::{decode, encode};

pub(super) fn encode_source_ref(path: &str, heading: Option<&str>) -> String {
    let mut out = format!("kb:v1:{}", encode(path));
    if let Some(h) = heading.map(str::trim).filter(|h| !h.is_empty()) {
        out.push('#');
        out.push_str(&encode(h));
    }
    out
}

pub(super) fn decode_source_ref(raw: &str) -> Result<(String, Option<String>), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("sourceRef is required".into());
    }
    let rest = raw.strip_prefix("kb:v1:").unwrap_or(raw);
    let (path_part, heading_part) = match rest.split_once('#') {
        Some((p, h)) => (p, Some(h)),
        None => (rest, None),
    };
    let path = decode(path_part)
        .map_err(|e| format!("invalid sourceRef path: {e}"))?
        .into_owned();
    if path.trim().is_empty() {
        return Err("sourceRef path is empty".into());
    }
    let heading = match heading_part {
        Some(h) if !h.is_empty() => Some(
            decode(h)
                .map_err(|e| format!("invalid sourceRef heading: {e}"))?
                .into_owned(),
        ),
        _ => None,
    };
    Ok((path, heading))
}

/// Last ATX heading whose start sits at or before `char_offset`.
pub(super) fn heading_at(content: &str, char_offset: usize) -> Option<String> {
    let mut last = None;
    let mut pos = 0usize;
    for line in content.lines() {
        if pos > char_offset {
            break;
        }
        if let Some((_, text)) = parse_atx(line) {
            last = Some(text);
        }
        pos += line.chars().count() + 1;
    }
    last
}

/// Body of `heading` until the next same-or-higher ATX heading.
/// Whole page (minus leading frontmatter) when `heading` is none or missing.
pub(super) fn extract_section(content: &str, heading: Option<&str>) -> String {
    let body = strip_frontmatter(content);
    let Some(want) = heading.map(str::trim).filter(|h| !h.is_empty()) else {
        return body;
    };
    let mut lines = body.lines();
    let mut out = String::new();
    let mut capturing = false;
    let mut capture_level = 0u8;
    while let Some(line) = lines.next() {
        if let Some((level, text)) = parse_atx(line) {
            if capturing && level <= capture_level {
                break;
            }
            if !capturing && text == want {
                capturing = true;
                capture_level = level;
                out.push_str(line);
                out.push('\n');
                continue;
            }
        }
        if capturing {
            out.push_str(line);
            out.push('\n');
        }
    }
    if capturing {
        return out.trim_end().to_string();
    }
    body
}

pub(super) fn page_title(content: &str) -> String {
    content
        .lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l.trim_start_matches('#').trim().to_string())
        .unwrap_or_default()
}

pub(super) fn updated_at(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            let v = v.trim().trim_matches('"');
            if k == "updated" || k == "last-verified" {
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

fn parse_atx(line: &str) -> Option<(u8, String)> {
    let rest = line.trim_start();
    let hashes = rest.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let after = rest.get(hashes..)?;
    if !after.starts_with(' ') && !after.starts_with('\t') {
        return None;
    }
    let text = after.trim().trim_end_matches('#').trim();
    if text.is_empty() {
        return None;
    }
    Some((hashes as u8, text.to_string()))
}

fn strip_frontmatter(content: &str) -> String {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return content.to_string();
    }
    for line in lines.by_ref() {
        if line.trim() == "---" {
            let rest: Vec<&str> = lines.collect();
            return rest.join("\n");
        }
    }
    content.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encodes_slash_and_hash_in_path() {
        let r = encode_source_ref("40-runbooks/a.md", Some("回滚步骤"));
        assert!(r.starts_with("kb:v1:"));
        let (path, heading) = decode_source_ref(&r).unwrap();
        assert_eq!(path, "40-runbooks/a.md");
        assert_eq!(heading.as_deref(), Some("回滚步骤"));
    }

    #[test]
    fn a_bare_path_is_a_ref() {
        let (path, heading) = decode_source_ref("40-runbooks/a.md").unwrap();
        assert_eq!(path, "40-runbooks/a.md");
        assert_eq!(heading, None);
    }

    #[test]
    fn extract_section_stops_at_next_same_level_heading() {
        let page = "# Title\n\nintro\n\n## 回滚步骤\n\ndo this\n\n## 其他\n\nnope\n";
        let section = extract_section(page, Some("回滚步骤"));
        assert!(section.contains("do this"));
        assert!(!section.contains("nope"));
    }
}
