//! Stamping the registry's structured fields into an installed `SKILL.md`.
//!
//! This is the point of the registry: an agent reads the file on disk, not
//! Postgres, so tidy `when_not_to_use` columns are worth nothing until they
//! land in frontmatter.
//!
//! It lives here rather than beside either installer because both of them do
//! it — the desktop when a member installs, the daemon when it reconciles a
//! shared agent. Two copies would mean the same skill acquires different
//! frontmatter depending on who installed it, and the resulting "why does this
//! agent behave differently" is close to un-debuggable from the outside.

use std::path::Path;

use teamclu_types::skill_frontmatter::{write_frontmatter, FrontmatterValue};

/// `source:` value for anything that came from a team registry, and the
/// lockfile marker for the same. One definition so the installer's bookkeeping
/// and the file on disk cannot disagree about what a team pack is.
pub const SOURCE_TEAM: &str = "team";

/// Key order matters only for diff noise: a reinstall must not reshuffle the
/// file. `name` and `description` stay first and keep their original meaning so
/// any reader that predates the registry still works.
const KEY_ORDER: &[&str] = &[
    "name",
    "description",
    "owner",
    "category",
    "when_to_use",
    "when_not_to_use",
    "requires",
    "version",
    "source",
];

#[derive(Debug, Clone, Default)]
pub struct RegistryFields<'a> {
    pub slug: &'a str,
    pub version: i64,
    pub owner: Option<&'a str>,
    pub category: Option<&'a str>,
    pub summary: Option<&'a str>,
    pub when_to_use: Option<&'a str>,
    pub when_not_to_use: Option<&'a str>,
    pub requires: Option<&'a [String]>,
}

fn scalar(value: Option<&str>) -> Option<FrontmatterValue> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(FrontmatterValue::Scalar(trimmed.to_owned()))
    }
}

/// Rewrite `<dir>/SKILL.md`'s frontmatter from the registry row.
///
/// Returns `false` when the package has no `SKILL.md` at all. That is reported
/// rather than raised: by this point the files are already on disk, so a hard
/// error would leave the caller unable to say what state the install is in. A
/// broken package should read as "installed but unusable", not as "install
/// failed".
pub fn write_registry_frontmatter(
    dir: &Path,
    fields: &RegistryFields<'_>,
) -> std::io::Result<bool> {
    let skill_md = dir.join("SKILL.md");
    if !skill_md.is_file() {
        return Ok(false);
    }
    let content = std::fs::read_to_string(&skill_md)?;

    let requires = fields
        .requires
        .filter(|items| !items.is_empty())
        .map(|items| FrontmatterValue::List(items.to_vec()));

    let updates: Vec<(&str, Option<FrontmatterValue>)> = vec![
        ("name", scalar(Some(fields.slug))),
        ("description", scalar(fields.summary)),
        ("owner", scalar(fields.owner)),
        ("category", scalar(fields.category)),
        ("when_to_use", scalar(fields.when_to_use)),
        ("when_not_to_use", scalar(fields.when_not_to_use)),
        ("requires", requires),
        (
            "version",
            Some(FrontmatterValue::Scalar(fields.version.to_string())),
        ),
        (
            "source",
            Some(FrontmatterValue::Scalar(SOURCE_TEAM.to_owned())),
        ),
    ];

    std::fs::write(&skill_md, write_frontmatter(&content, &updates, KEY_ORDER))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use teamclu_types::skill_frontmatter::parse_frontmatter;

    fn fields<'a>() -> RegistryFields<'a> {
        RegistryFields {
            slug: "deploy-check",
            version: 3,
            owner: Some("张三"),
            category: Some("devops"),
            summary: Some("发布前检查清单"),
            when_to_use: Some("发布前确认 CI 绿"),
            when_not_to_use: Some("不要用于本地开发\n不要用于 hotfix 流程"),
            requires: None,
        }
    }

    #[test]
    fn writes_structured_fields_and_keeps_the_body() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("deploy-check");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: deploy-check\ndescription: old blurb\n---\n# Deploy check\n\nsteps\n",
        )
        .unwrap();

        assert!(write_registry_frontmatter(&dir, &fields()).unwrap());

        let parsed = parse_frontmatter(&std::fs::read_to_string(dir.join("SKILL.md")).unwrap());
        assert_eq!(parsed.string("category"), Some("devops"));
        assert_eq!(parsed.string("owner"), Some("张三"));
        // The multi-line field is the one the old regex parser could not carry.
        assert_eq!(
            parsed.string("when_not_to_use"),
            Some("不要用于本地开发\n不要用于 hotfix 流程")
        );
        assert_eq!(parsed.string("version"), Some("3"));
        assert_eq!(parsed.string("source"), Some("team"));
        // description tracks summary so pre-registry readers still see a blurb.
        assert_eq!(parsed.string("description"), Some("发布前检查清单"));
        assert_eq!(parsed.body, "# Deploy check\n\nsteps\n");
    }

    #[test]
    fn chinese_slug_is_the_skill_name() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("整车成本智能表格");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: old\n---\n# body\n").unwrap();
        let mut fields = fields();
        fields.slug = "整车成本智能表格";
        assert!(write_registry_frontmatter(&dir, &fields).unwrap());
        let parsed = parse_frontmatter(&std::fs::read_to_string(dir.join("SKILL.md")).unwrap());
        assert_eq!(parsed.string("name"), Some("整车成本智能表格"));
        assert_eq!(
            dir.file_name().and_then(|s| s.to_str()),
            Some("整车成本智能表格")
        );
    }

    #[test]
    fn a_package_without_skill_md_reports_rather_than_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("empty");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!write_registry_frontmatter(&dir, &fields()).unwrap());
    }

    #[test]
    fn empty_optional_fields_are_not_emitted() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bare");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: bare\n---\nbody\n").unwrap();

        let empty: Vec<String> = Vec::new();
        let mut f = fields();
        f.slug = "bare";
        f.owner = None;
        f.when_not_to_use = Some("   ");
        f.requires = Some(&empty);
        write_registry_frontmatter(&dir, &f).unwrap();

        let parsed = parse_frontmatter(&std::fs::read_to_string(dir.join("SKILL.md")).unwrap());
        assert_eq!(parsed.string("owner"), None);
        assert_eq!(parsed.string("when_not_to_use"), None);
        assert!(parsed.data.get("requires").is_none());
    }
}
