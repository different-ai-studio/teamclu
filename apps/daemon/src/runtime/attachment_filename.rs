//! Object-store-safe attachment path segments (shared by channel send and pi attach).

/// An object-store-safe form of `filename`, for use inside a bucket key.
///
/// The attachment store rejects keys with non-ASCII bytes — a reply carrying
/// `诗一首.md` came back `validation_failed: Invalid key`, so the file reached
/// the chat while the session copy had no download. Only the *path* is
/// sanitized: `AttachmentRecord.filename` keeps the original, which is what
/// clients display.
pub fn safe_object_name(filename: &str) -> String {
    fn scrub(part: &str) -> String {
        let mut out = String::with_capacity(part.len());
        let mut last_underscore = false;
        for c in part.chars() {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                out.push(c);
                last_underscore = false;
            } else if !last_underscore {
                out.push('_');
                last_underscore = true;
            }
        }
        out.trim_matches(['_', '.'].as_slice()).to_string()
    }

    let (stem, ext) = match filename.rsplit_once('.') {
        Some((stem, ext)) if !ext.is_empty() => (stem, Some(ext)),
        _ => (filename, None),
    };
    let stem = match scrub(stem) {
        s if s.is_empty() => "file".to_string(),
        s => s,
    };
    match ext.map(scrub) {
        Some(e) if !e.is_empty() => format!("{stem}.{e}"),
        _ => stem,
    }
}

#[cfg(test)]
mod tests {
    use super::safe_object_name;

    #[test]
    fn non_ascii_names_keep_extension() {
        assert_eq!(safe_object_name("诗一首.md"), "file.md");
        assert_eq!(safe_object_name("报告 final.pdf"), "final.pdf");
    }

    #[test]
    fn ascii_names_unchanged() {
        assert_eq!(safe_object_name("report-v2.pdf"), "report-v2.pdf");
        assert_eq!(safe_object_name("a_b.c-d.txt"), "a_b.c-d.txt");
    }

    #[test]
    fn emptyish_stem_becomes_file() {
        assert!(!safe_object_name("中文").is_empty());
        assert!(!safe_object_name("...").is_empty());
        assert_eq!(safe_object_name("中文"), "file");
    }
}
