//! Skill-id rules shared by the desktop installer and the daemon.
//!
//! The id is one directory name. Chinese is allowed (`整车成本智能表格`).
//! The install path still refuses separators, `..`, controls, Windows-forbidden
//! characters, and a non-canonical form. Existing ASCII ids that already match
//! `^[a-z0-9][a-z0-9-]{1,63}$` stay installable even when they are a Windows
//! device name — those rows may already be in the registry. New publishes go
//! through `skill_slug_is_publishable`, which rejects the device names.

use unicode_normalization::UnicodeNormalization;

pub const SKILL_SLUG_MAX_CHARS: usize = 64;
pub const SKILL_SLUG_MAX_BYTES: usize = 255;

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// NFC form used when a directory listing must be compared with a registry id.
pub fn skill_slug_nfc(slug: &str) -> String {
    slug.nfc().collect()
}

/// True when this string may be joined onto a skills directory.
///
/// Accepts a canonical Unicode id, and also any legacy ASCII id the database
/// already allowed.
pub fn skill_slug_is_installable(slug: &str) -> bool {
    skill_slug_is_publishable(slug) || is_legacy_ascii(slug)
}

/// True when a new registry row may store this id.
pub fn skill_slug_is_publishable(slug: &str) -> bool {
    slug_shape_ok(slug) && !is_windows_reserved(slug)
}

/// `Err` when the id must not become a path. Installers call this.
pub fn validate_skill_slug(slug: &str) -> Result<(), &'static str> {
    if skill_slug_is_installable(slug) {
        Ok(())
    } else if is_windows_reserved(slug) {
        Err("slug is reserved on Windows and cannot be a skill folder name")
    } else {
        Err("slug must be 2-64 letters or digits, any language, NFC, with hyphens only in the middle")
    }
}

fn is_legacy_ascii(slug: &str) -> bool {
    let mut chars = slug.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    let mut len = 1usize;
    for c in chars {
        len += 1;
        if len > SKILL_SLUG_MAX_CHARS {
            return false;
        }
        if !c.is_ascii_lowercase() && !c.is_ascii_digit() && c != '-' {
            return false;
        }
    }
    len >= 2
}

fn slug_shape_ok(slug: &str) -> bool {
    if slug.nfc().collect::<String>() != slug {
        return false;
    }
    let mut count = 0usize;
    for (index, ch) in slug.chars().enumerate() {
        count = index + 1;
        if count > SKILL_SLUG_MAX_CHARS {
            return false;
        }
        if !allowed_char(ch, index) {
            return false;
        }
    }
    if count < 2 || slug.len() > SKILL_SLUG_MAX_BYTES {
        return false;
    }
    if slug.ends_with('-') {
        return false;
    }
    true
}

fn allowed_char(ch: char, index: usize) -> bool {
    let cp = ch as u32;
    if cp <= 0x1f || cp == 0x7f || (0x80..=0x9f).contains(&cp) {
        return false;
    }
    if cp == 0xa0 || cp == 0x3000 || cp == 0xfeff {
        return false;
    }
    if (0x200b..=0x200d).contains(&cp) || cp == 0x2028 || cp == 0x2029 {
        return false;
    }
    if (0x202a..=0x202e).contains(&cp) || (0x2066..=0x2069).contains(&cp) {
        return false;
    }
    if cp < 128 {
        let digit = ch.is_ascii_digit();
        let lower = ch.is_ascii_lowercase();
        let hyphen = ch == '-';
        if hyphen && index == 0 {
            return false;
        }
        return digit || lower || hyphen;
    }
    !ch.is_control()
}

fn is_windows_reserved(slug: &str) -> bool {
    let stem = slug.split('.').next().unwrap_or(slug);
    RESERVED.iter().any(|name| stem.eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const CHINESE: &str = "整车成本智能表格";

    #[test]
    fn chinese_is_one_folder_name_and_publishable() {
        assert!(skill_slug_is_publishable(CHINESE));
        assert!(validate_skill_slug(CHINESE).is_ok());
        let path = Path::new("/tmp/skills").join(CHINESE);
        assert_eq!(path.file_name().and_then(|s| s.to_str()), Some(CHINESE));
        assert_eq!(path.parent(), Some(Path::new("/tmp/skills")));
    }

    #[test]
    fn nfc_is_required_and_nfd_is_not_a_second_id() {
        let nfd_cafe = "cafe\u{0301}";
        assert_ne!(skill_slug_nfc(nfd_cafe), nfd_cafe);
        assert!(!skill_slug_is_publishable(nfd_cafe));
        assert!(skill_slug_is_publishable("caf\u{00e9}"));
        assert_eq!(skill_slug_nfc(CHINESE), CHINESE);
    }

    #[test]
    fn rejects_traversal_controls_and_windows_punctuation() {
        for slug in [
            "../x",
            "a/b",
            "a\\b",
            "a:b",
            "a?b",
            "con",
            "NUL",
            "com1",
            "整车/成本",
            "a ",
            " a",
            "",
        ] {
            assert!(
                !skill_slug_is_publishable(slug),
                "{slug:?} must not be publishable"
            );
        }
        assert!(validate_skill_slug("..").is_err());
        assert!(validate_skill_slug("a/b").is_err());
    }

    #[test]
    fn legacy_ascii_still_installs_including_a_device_name_already_stored() {
        assert!(skill_slug_is_installable("deploy-check"));
        assert!(skill_slug_is_installable("zheng-che-cheng-ben"));
        assert!(skill_slug_is_installable("con"));
        assert!(!skill_slug_is_publishable("con"));
        assert!(validate_skill_slug("deploy-check").is_ok());
        assert!(validate_skill_slug("con").is_ok());
    }
}
