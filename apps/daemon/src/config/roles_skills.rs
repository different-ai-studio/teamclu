//! Workspace roles + skills inventory for the settings UI.
//!
//! Scans the same on-disk layouts the frontend loaders use (`{meta}/skills`,
//! `{meta}/roles`, global skill dirs, etc.) and returns a single aggregated
//! payload so the app no longer needs direct filesystem access for listing.
//! Meta dir follows the process brand (see `teamclu_runtime_env` workspace helpers).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use teamclu_types::skill_frontmatter::parse_frontmatter;

use super::global_team_store::TEAM_LINK_NAME;
use super::workspace_control::WorkspaceControlError;

// ── DTOs (camelCase JSON for the frontend) ───────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSkillLinkDto {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleRecordDto {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub role: String,
    pub when_to_use: String,
    pub working_style: String,
    pub role_skills: Vec<RoleSkillLinkDto>,
    pub file_path: String,
    pub raw_markdown: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillDto {
    pub filename: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invocation_name: Option<String>,
    pub content: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub dir_path: String,
    pub linked_roles: Vec<String>,
    pub is_role_skill: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolesSkillsMetricsDto {
    pub roles_count: usize,
    pub skills_count: usize,
    pub linked_skills_count: usize,
    pub unlinked_skills_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolesSkillsStateDto {
    pub roles: Vec<RoleRecordDto>,
    pub skills: Vec<ManagedSkillDto>,
    pub role_usage_by_skill: HashMap<String, Vec<String>>,
    pub skill_names_by_role: HashMap<String, Vec<String>>,
    pub metrics: RolesSkillsMetricsDto,
}

// ── Scanner ──────────────────────────────────────────────────────────────────

const ROLE_SKILL_DIR: &str = "skills";
const INHERENT_SKILL_NAMES: &[&str] = &["create-role", "macos-control", "windows-control"];

/// Skills that ship with the binary. They are read-only everywhere — the
/// scanner classifies them as `builtin`, and the agent-management RPC refuses
/// to delete them — so the list has exactly one home.
pub fn is_inherent_skill(name: &str) -> bool {
    INHERENT_SKILL_NAMES.contains(&name)
}

fn process_brand() -> String {
    teamclu_runtime_env::brand_short_name_from_env()
}

/// Canonical (write) skills directory for the process brand.
fn brand_skills_dir(workspace_path: &Path) -> PathBuf {
    teamclu_runtime_env::workspace_meta_write_path_from_env(workspace_path, "skills")
}

/// Meta skills roots to scan (canonical first, then legacy `.teamclu/skills`).
fn meta_skills_dirs(workspace_path: &Path) -> Vec<PathBuf> {
    teamclu_runtime_env::workspace_meta_read_roots(workspace_path, &process_brand())
        .into_iter()
        .map(|root| root.join("skills"))
        .collect()
}

fn meta_roles_dirs(workspace_path: &Path) -> Vec<PathBuf> {
    teamclu_runtime_env::workspace_meta_read_roots(workspace_path, &process_brand())
        .into_iter()
        .map(|root| root.join("roles"))
        .collect()
}

fn brand_roles_dir(workspace_path: &Path) -> PathBuf {
    teamclu_runtime_env::workspace_meta_write_path_from_env(workspace_path, "roles")
}

fn workspace_brand_config_rel() -> String {
    format!(
        "{}/{}",
        teamclu_runtime_env::workspace_meta_dir_name(&process_brand()),
        teamclu_runtime_env::workspace_config_file_name(&process_brand())
    )
}

struct RawSkill {
    filename: String,
    name: String,
    invocation_name: String,
    content: String,
    source: String,
    dir_path: String,
    is_role_skill: bool,
}

/// The brand meta directory outranks every other root.
const RANK_META: u8 = 0;

struct SkillDirSpec {
    path: PathBuf,
    /// Display label. Never used to order anything — see `rank`.
    source: &'static str,
    /// Precedence when the same slug exists in more than one root: lowest wins.
    ///
    /// Kept on the spec rather than derived from `source` so that changing what
    /// a skill is *called* cannot silently change which copy the app opens,
    /// edits, and feeds to an agent. The numbers mirror the frontend's
    /// `SKILL_SOURCE_PRIORITY` so both loaders resolve a collision the same way.
    rank: u8,
    /// The brand meta directory, where `builtin` / `clawhub` classification
    /// applies. Stated here instead of inferred from the path: the inference
    /// (`is_meta_skills_dir`) matched any `skills` directory under a dot-prefixed
    /// parent, which is all of them.
    is_meta: bool,
}

fn io_err(e: std::io::Error) -> WorkspaceControlError {
    WorkspaceControlError::Io(e.to_string())
}

fn read_clawhub_slugs(workspace_path: &Path) -> HashSet<String> {
    for lock_name in [".clawhub/lock.json", ".clawdhub/lock.json"] {
        let lock_path = workspace_path.join(lock_name);
        let Ok(content) = std::fs::read_to_string(&lock_path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        if let Some(skills) = parsed.get("skills").and_then(|v| v.as_object()) {
            return skills.keys().cloned().collect();
        }
    }
    HashSet::new()
}

fn read_json_paths(workspace_path: &Path, config_rel: &str, key: &str) -> Vec<PathBuf> {
    let config_path = workspace_path.join(config_rel);
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return vec![];
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
        return vec![];
    };
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    let home_str = home.to_string_lossy();
    let home_trimmed = home_str.trim_end_matches('/');

    parsed
        .pointer(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|raw| {
                    let trimmed = raw.trim();
                    if trimmed == "~" {
                        home.clone()
                    } else if let Some(rest) = trimmed.strip_prefix("~/") {
                        PathBuf::from(format!("{home_trimmed}/{rest}"))
                    } else if trimmed.starts_with('/') {
                        PathBuf::from(trimmed)
                    } else {
                        workspace_path.join(trimmed.trim_start_matches("./"))
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_skill_name(content: &str, fallback: &str) -> String {
    if let Some(name) = parse_frontmatter(content).string("name") {
        return name.to_owned();
    }
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix('#') {
            let title = rest.trim_start_matches('#').trim();
            if !title.is_empty() {
                return title.to_owned();
            }
        }
    }
    fallback.to_owned()
}

fn extract_skill_description(content: &str, fallback: &str) -> String {
    match parse_frontmatter(content).string("description") {
        Some(d) => d.to_owned(),
        None => extract_skill_name(content, fallback),
    }
}

fn build_invocation_name(parent_dir: &Path, filename: &str) -> String {
    parent_dir
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|scope| *scope != "skills")
        .map(|scope| format!("{scope}/{filename}"))
        .unwrap_or_else(|| filename.to_owned())
}

fn try_load_skill_from_root(
    skill_root: &Path,
    filename: &str,
    parent_dir: &Path,
    source: &str,
) -> Result<Option<RawSkill>, WorkspaceControlError> {
    let skill_md = skill_root.join("SKILL.md");
    if !skill_md.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&skill_md).map_err(io_err)?;
    let name = extract_skill_name(&content, filename);
    Ok(Some(RawSkill {
        filename: filename.to_owned(),
        name: name.clone(),
        invocation_name: build_invocation_name(parent_dir, filename),
        content,
        source: source.to_owned(),
        dir_path: parent_dir.to_string_lossy().into_owned(),
        is_role_skill: false,
    }))
}

fn load_skills_from_dir(dir: &Path, source: &str) -> Result<Vec<RawSkill>, WorkspaceControlError> {
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut skills = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(io_err)? {
        let entry = entry.map_err(io_err)?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if let Some(skill) = try_load_skill_from_root(&path, filename, dir, source)? {
            skills.push(skill);
            continue;
        }

        // Bundle layout: `<dir>/<bundle>/<skill>/SKILL.md` (matches desktop skill-loader).
        for nested in std::fs::read_dir(&path).map_err(io_err)? {
            let nested = nested.map_err(io_err)?;
            let nested_path = nested.path();
            if !nested_path.is_dir() {
                continue;
            }
            let Some(nested_name) = nested_path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Some(skill) = try_load_skill_from_root(&nested_path, nested_name, &path, source)?
            {
                skills.push(skill);
            }
        }
    }
    Ok(skills)
}

fn classify_teamclu_skill(filename: &str, clawhub_slugs: &HashSet<String>) -> &'static str {
    if is_inherent_skill(filename) {
        "builtin"
    } else if clawhub_slugs.contains(filename) {
        "clawhub"
    } else {
        "local"
    }
}

fn onboarded_team_id() -> Option<String> {
    super::DaemonConfig::load(&super::DaemonConfig::default_path())
        .ok()
        .and_then(|cfg| {
            cfg.team_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
}

fn remap_team_skill_path(workspace_path: &Path, path: PathBuf, team_id: &str) -> PathBuf {
    let link_root = workspace_path.join(TEAM_LINK_NAME);
    if path.is_dir() {
        return path;
    }
    if path.starts_with(&link_root) {
        let rel = path.strip_prefix(&link_root).unwrap_or(path.as_path());
        return super::global_team_store::resolve_team_dir(workspace_path, team_id).join(rel);
    }
    path
}

/// Team skill directory roots for a workspace (config paths + default team
/// share + the registry install dir).
///
/// `~/.agents/skills` is where the team skills registry installs packages, and
/// it has to be in here rather than only in `load_all_skills`: this list is the
/// sole input to the `.claude/skills/` symlink bridge
/// (`runtime::claude_skills`), and `teamclu-team/skills` no longer receives
/// anything — file sync carries documents only. Without this, registry-installed
/// team skills reach OpenCode (via `skills.paths`) but are invisible to Claude
/// Code, and an empty list makes the bridge prune every team symlink it had.
pub fn team_skill_roots(workspace_path: &Path) -> Vec<PathBuf> {
    let mut roots = collect_team_skill_paths(workspace_path);
    // The daemon's own install root, for skills an admin assigned to this
    // hosted agent. Separate from `~/.agents/skills` because that one belongs
    // to the desktop's member-side reconcile — see `runtime::team_skills` for
    // why sharing it would make the two loops delete each other's packs.
    //
    // Ordered *before* `~/.agents/skills`, and that ordering is the whole
    // point: consumers resolve a slug collision by taking the first root that
    // has it. On a machine that both hosts a shared agent and is signed in as a
    // member, the same slug exists twice — once at the version an admin
    // assigned to the agent, once at whatever the member happens to have,
    // possibly edited and held back by a conflict. Putting the member's copy
    // first would let a private edit decide what a team agent executes, which
    // is exactly the veto the agent-side reconcile refuses to grant.
    if let Some(team_id) = onboarded_team_id() {
        let agent_dir = crate::runtime::team_skills::team_cloud_skills_dir(&team_id);
        if agent_dir.is_dir() && !roots.contains(&agent_dir) {
            roots.push(agent_dir);
        }
    }
    if let Some(home) = dirs::home_dir() {
        let registry_dir = home.join(".agents/skills");
        if registry_dir.is_dir() && !roots.contains(&registry_dir) {
            roots.push(registry_dir);
        }
    }
    roots
}

fn collect_team_skill_paths(workspace_path: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut seen = HashSet::new();
    let team_id = onboarded_team_id();

    let mut push = |path: PathBuf| {
        let resolved = team_id
            .as_deref()
            .map(|id| remap_team_skill_path(workspace_path, path.clone(), id))
            .unwrap_or(path);
        if resolved.is_dir() && seen.insert(resolved.clone()) {
            paths.push(resolved);
        }
    };

    for config_rel in [
        workspace_brand_config_rel(),
        format!(
            "{}/{}",
            teamclu_runtime_env::WORKSPACE_META_DIR,
            teamclu_runtime_env::WORKSPACE_CONFIG_FILE
        ),
        "teamclu.json".to_string(),
    ] {
        for extra in read_json_paths(workspace_path, &config_rel, "/skills/paths") {
            push(extra);
        }
    }
    for extra in read_json_paths(workspace_path, "opencode.json", "/skills/paths") {
        push(extra);
    }

    // The team-share drive's own `skills/` used to be a root here. It no longer
    // has a writer: `skills/` is in the OSS sync's RETIRED_PREFIXES (it moved to
    // the skills registry), so nothing has landed there since that migration.
    //
    // Dropping it is a real behaviour change on machines that synced skills
    // *before* the migration — the retirement stopped the syncing but never
    // deleted anything, so those files are still on disk and were still being
    // scanned. They stop reaching agents now, which is the point: a pack the
    // registry has since superseded is exactly the "quietly running a version
    // the team retired" case the registry exists to end.
    //
    // Config-declared `/skills/paths` entries pointing into the team drive are
    // untouched — those are somebody's explicit choice, not a default.

    paths
}

/// Every root scanned for skills, in one place so the ranks can be read — and
/// tested — as a table rather than inferred from call order.
fn skill_dir_specs(workspace_path: &Path, home: &Path) -> Vec<SkillDirSpec> {
    let home_str = home.to_string_lossy();
    let home_trimmed = home_str.trim_end_matches('/');

    let mut specs: Vec<SkillDirSpec> = meta_skills_dirs(workspace_path)
        .into_iter()
        .map(|path| SkillDirSpec {
            path,
            source: "local",
            rank: RANK_META,
            is_meta: true,
        })
        .collect();
    specs.extend([
        SkillDirSpec {
            path: workspace_path.join(".opencode/skills"),
            source: "opencode",
            rank: 11,
            is_meta: false,
        },
        SkillDirSpec {
            path: workspace_path.join(".claude/skills"),
            source: "claude",
            rank: 1,
            is_meta: false,
        },
        SkillDirSpec {
            path: workspace_path.join(".agents/skills"),
            source: "shared",
            rank: 3,
            is_meta: false,
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.config/teamclu/skills")),
            source: "global-teamclu",
            rank: 7,
            is_meta: false,
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.config/opencode/skills")),
            source: "global-opencode",
            rank: 10,
            is_meta: false,
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.claude/skills")),
            source: "global-claude",
            rank: 8,
            is_meta: false,
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.agents/skills")),
            source: "global-agent",
            // Ahead of every personal root, which is the opposite of where a
            // "global" root would sit on generality alone. This is where team
            // packs are installed, and a team skill is a team standard: a member
            // keeping a same-named file of their own must not silently decide
            // what the team's procedure is on their machine. It is also the only
            // ordering consistent with auto-follow, whose entire premise is that
            // nobody should be left quietly running a version the team retired.
            //
            // A member who wants their own version keeps it under another name;
            // the install path offers exactly that when it has to take a path
            // over (`archive_unmanaged`).
            rank: 2,
            is_meta: false,
        },
    ]);

    for extra in collect_team_skill_paths(workspace_path) {
        specs.push(SkillDirSpec {
            path: extra,
            source: "team",
            rank: 4,
            is_meta: false,
        });
    }

    specs
}

fn load_all_skills(
    workspace_path: &Path,
    home: &Path,
) -> Result<Vec<RawSkill>, WorkspaceControlError> {
    let clawhub_slugs = read_clawhub_slugs(workspace_path);
    let specs = skill_dir_specs(workspace_path, home);

    // Which copy of a duplicated slug survives is decided by the *directory* it
    // came from, carried on the spec, never by the label the skill ends up
    // wearing. Deriving the order from the label made display and precedence
    // one decision: `is_meta_skills_dir` relabelled several unrelated roots to
    // `local`, they all tied at the same priority, and the tie fell to whichever
    // spec happened to be listed first. A team pack in `~/.agents/skills` then
    // always lost to the member's own copy in `~/.claude/skills` — not by any
    // rule, just by array position.
    let mut merged: HashMap<String, (u8, RawSkill)> = HashMap::new();
    for spec in specs {
        let mut batch = load_skills_from_dir(&spec.path, spec.source)?;
        for skill in batch.drain(..) {
            // `builtin` / `clawhub` are properties of the brand meta directory —
            // they are read out of that workspace's own lockfile and inherent
            // list — so the classification only applies there. The frontend
            // loader has always scoped it that way (`skill-loader.ts`:
            // "`.teamclu/skills/` → 'local' / 'builtin' / 'clawhub'"); this used
            // to apply it to every root whose parent name began with a dot,
            // which is every skills root there is.
            let source = if spec.is_meta {
                classify_teamclu_skill(&skill.filename, &clawhub_slugs).to_owned()
            } else {
                skill.source.clone()
            };
            let skill = RawSkill { source, ..skill };
            match merged.get(&skill.filename) {
                Some((seen_rank, _)) if *seen_rank <= spec.rank => {}
                _ => {
                    merged.insert(skill.filename.clone(), (spec.rank, skill));
                }
            }
        }
    }

    Ok(merged.into_values().map(|(_, skill)| skill).collect())
}

fn get_section(body: &str, heading: &str) -> String {
    let marker = format!("## {heading}");
    let mut in_section = false;
    let mut section_lines = Vec::new();
    for line in body.lines() {
        if line.trim().eq_ignore_ascii_case(marker.trim()) {
            in_section = true;
            continue;
        }
        if in_section {
            if line.starts_with("## ") {
                break;
            }
            section_lines.push(line);
        }
    }
    section_lines.join("\n").trim().to_owned()
}

fn parse_role_skill_links(section: &str) -> Vec<RoleSkillLinkDto> {
    section
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if !trimmed.starts_with('-') {
                return None;
            }
            let rest = trimmed.trim_start_matches('-').trim();
            let (name_part, desc) = rest.split_once(':')?;
            let name = name_part.trim().trim_matches('`').trim();
            if name.is_empty() {
                return None;
            }
            Some(RoleSkillLinkDto {
                name: name.to_owned(),
                description: desc.trim().to_owned(),
            })
        })
        .collect()
}

fn parse_role_markdown(content: &str, slug: &str, file_path: &Path) -> RoleRecordDto {
    let normalized = content.replace("\r\n", "\n");
    let (frontmatter, body) = if let Some(stripped) = normalized.strip_prefix("---\n") {
        if let Some((fm, body)) = stripped.split_once("\n---") {
            (Some(fm), body.trim_start_matches('\n'))
        } else {
            (None, normalized.as_str())
        }
    } else {
        (None, normalized.as_str())
    };

    let mut name = slug.to_owned();
    let mut description = String::new();
    if let Some(fm) = frontmatter {
        for line in fm.lines() {
            if let Some((k, v)) = line.split_once(':') {
                match k.trim() {
                    "name" => name = v.trim().to_owned(),
                    "description" => description = v.trim().to_owned(),
                    _ => {}
                }
            }
        }
    }

    RoleRecordDto {
        slug: slug.to_owned(),
        name,
        description,
        body: body.to_owned(),
        role: get_section(body, "Role"),
        when_to_use: get_section(body, "When to use"),
        working_style: get_section(body, "Working style"),
        role_skills: parse_role_skill_links(&get_section(body, "Available role skills")),
        file_path: file_path.to_string_lossy().into_owned(),
        raw_markdown: normalized.trim().to_owned(),
    }
}

fn role_roots(workspace_path: &Path) -> Vec<PathBuf> {
    let mut roots = meta_roles_dirs(workspace_path);
    let config_candidates: Vec<PathBuf> = roots
        .iter()
        .map(|root| {
            root.strip_prefix(workspace_path)
                .map(|p| p.join("config.json"))
                .unwrap_or_else(|_| PathBuf::from("roles/config.json"))
        })
        .collect();
    for config_rel in config_candidates {
        for extra in read_json_paths(workspace_path, &config_rel.to_string_lossy(), "/paths") {
            if !roots.contains(&extra) {
                roots.push(extra);
            }
        }
    }
    roots
}

fn load_all_roles(workspace_path: &Path) -> Result<Vec<RoleRecordDto>, WorkspaceControlError> {
    let mut roles = Vec::new();
    let mut seen = HashSet::new();
    for root in role_roots(workspace_path) {
        if !root.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&root).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(slug) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if slug == ROLE_SKILL_DIR || seen.contains(slug) {
                continue;
            }
            let role_md = path.join("ROLE.md");
            if !role_md.is_file() {
                continue;
            }
            let content = std::fs::read_to_string(&role_md).map_err(io_err)?;
            roles.push(parse_role_markdown(&content, slug, &role_md));
            seen.insert(slug.to_owned());
        }
    }
    roles.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(roles)
}

fn load_role_managed_skills(workspace_path: &Path) -> Result<Vec<RawSkill>, WorkspaceControlError> {
    let mut skills = Vec::new();
    let mut seen = HashSet::new();
    for root in role_roots(workspace_path) {
        let role_skill_root = root.join(ROLE_SKILL_DIR);
        if !role_skill_root.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&role_skill_root).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if seen.contains(filename) {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let content = std::fs::read_to_string(&skill_md).map_err(io_err)?;
            seen.insert(filename.to_owned());
            skills.push(RawSkill {
                filename: filename.to_owned(),
                name: filename.to_owned(),
                invocation_name: filename.to_owned(),
                content,
                source: "local".to_owned(),
                dir_path: role_skill_root.to_string_lossy().into_owned(),
                is_role_skill: true,
            });
        }
    }
    Ok(skills)
}

/// Scan a workspace directory and build the aggregated roles/skills state.
pub fn scan_roles_skills_state(
    workspace_path: &Path,
) -> Result<RolesSkillsStateDto, WorkspaceControlError> {
    let home = dirs::home_dir()
        .ok_or_else(|| WorkspaceControlError::Io("home directory not found".to_owned()))?;

    let roles = load_all_roles(workspace_path)?;
    let normal_skills = load_all_skills(workspace_path, &home)?;
    let role_managed = load_role_managed_skills(workspace_path)?;

    let mut role_usage_by_skill: HashMap<String, Vec<String>> = HashMap::new();
    let mut skill_names_by_role: HashMap<String, Vec<String>> = HashMap::new();

    for role in &roles {
        let names: Vec<String> = role.role_skills.iter().map(|s| s.name.clone()).collect();
        skill_names_by_role.insert(role.slug.clone(), names.clone());
        for link in &role.role_skills {
            role_usage_by_skill
                .entry(link.name.clone())
                .or_default()
                .push(role.slug.clone());
        }
    }

    let mut by_key: HashMap<String, ManagedSkillDto> = HashMap::new();

    for skill in normal_skills {
        let key = format!("{}:{}", skill.dir_path, skill.filename);
        by_key.insert(
            key,
            ManagedSkillDto {
                filename: skill.filename.clone(),
                name: skill.name.clone(),
                invocation_name: Some(skill.invocation_name),
                content: skill.content.clone(),
                description: extract_skill_description(&skill.content, &skill.name),
                source: Some(skill.source),
                dir_path: skill.dir_path,
                linked_roles: role_usage_by_skill
                    .get(&skill.filename)
                    .cloned()
                    .unwrap_or_default(),
                is_role_skill: false,
            },
        );
    }

    for skill in role_managed {
        let key = format!("{}:{}", skill.dir_path, skill.filename);
        by_key.insert(
            key,
            ManagedSkillDto {
                filename: skill.filename.clone(),
                name: skill.name.clone(),
                invocation_name: Some(skill.invocation_name),
                content: skill.content.clone(),
                description: extract_skill_description(&skill.content, &skill.name),
                source: Some(skill.source),
                dir_path: skill.dir_path,
                linked_roles: role_usage_by_skill
                    .get(&skill.filename)
                    .cloned()
                    .unwrap_or_default(),
                is_role_skill: true,
            },
        );
    }

    let mut skills: Vec<ManagedSkillDto> = by_key.into_values().collect();
    skills.sort_by(|a, b| {
        a.is_role_skill
            .cmp(&b.is_role_skill)
            .then(a.filename.cmp(&b.filename))
    });

    let linked_skills_count = role_usage_by_skill
        .keys()
        .filter(|name| skills.iter().any(|s| s.filename == **name))
        .count();

    Ok(RolesSkillsStateDto {
        metrics: RolesSkillsMetricsDto {
            roles_count: roles.len(),
            skills_count: skills.len(),
            linked_skills_count,
            unlinked_skills_count: skills.len().saturating_sub(linked_skills_count),
        },
        roles,
        skills,
        role_usage_by_skill,
        skill_names_by_role,
    })
}

// ── Write API ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSkillRequest {
    pub content: String,
    #[serde(default)]
    pub skill_name: Option<String>,
    #[serde(default)]
    pub install_location: Option<String>,
    #[serde(default)]
    pub dir_path: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertRoleRequest {
    pub raw_markdown: String,
    #[serde(default)]
    pub target_file_path: Option<String>,
}

fn slugify(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

fn ensure_frontmatter(content: &str, slug: &str, display_name: &str) -> String {
    let trimmed = content.trim();
    if trimmed.starts_with("---") {
        return format!("{trimmed}\n");
    }
    let description = trimmed
        .lines()
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect::<String>();
    format!("---\nname: {slug}\ndescription: {description}\n---\n\n# {display_name}\n\n{trimmed}\n")
}

/// Lexically resolve `.` / `..` components without touching the filesystem,
/// so we can confine caller-supplied paths even when the target doesn't exist
/// yet (`std::fs::canonicalize` requires the path to exist).
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// True when `candidate` equals or nests under `base` (compared lexically).
fn is_within(base: &Path, candidate: &Path) -> bool {
    normalize_lexical(candidate).starts_with(normalize_lexical(base))
}

/// Reject a single path segment (skill slug, dir name, role slug) that could
/// escape its parent directory via separators or `..`.
fn ensure_safe_segment(seg: &str) -> Result<(), WorkspaceControlError> {
    if seg.is_empty() || seg.contains('/') || seg.contains('\\') || seg == "." || seg == ".." {
        return Err(WorkspaceControlError::InvalidInput(format!(
            "unsafe path segment {seg:?}"
        )));
    }
    Ok(())
}

/// Resolve a caller-supplied path (absolute, or relative to the workspace) and
/// confine it to the workspace directory or the user's home. The daemon runs as
/// the local user and legitimately manages skill/role dirs under both roots;
/// anything outside (e.g. `/etc`, another user's home) is rejected.
fn confine_path(
    raw: &str,
    workspace_path: &Path,
    home: &Path,
) -> Result<PathBuf, WorkspaceControlError> {
    let raw_path = Path::new(raw);
    let abs = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        workspace_path.join(raw_path)
    };
    let normalized = normalize_lexical(&abs);
    if is_within(workspace_path, &normalized) || is_within(home, &normalized) {
        Ok(normalized)
    } else {
        Err(WorkspaceControlError::InvalidInput(format!(
            "path escapes workspace and home: {}",
            normalized.display()
        )))
    }
}

fn skills_dir_for_request(
    workspace_path: &Path,
    home: &Path,
    req: &UpsertSkillRequest,
) -> Result<PathBuf, WorkspaceControlError> {
    if let Some(dir) = req.dir_path.as_deref().filter(|d| !d.is_empty()) {
        return confine_path(dir, workspace_path, home);
    }
    if req.install_location.as_deref() == Some("global") {
        return Ok(home.join(".agents/skills"));
    }
    Ok(brand_skills_dir(workspace_path))
}

pub fn upsert_skill(
    workspace_path: &Path,
    slug: &str,
    req: &UpsertSkillRequest,
) -> Result<ManagedSkillDto, WorkspaceControlError> {
    let home = dirs::home_dir()
        .ok_or_else(|| WorkspaceControlError::Io("home directory not found".to_owned()))?;
    let skills_dir = skills_dir_for_request(workspace_path, &home, req)?;
    std::fs::create_dir_all(&skills_dir).map_err(io_err)?;

    let dir_name = req
        .filename
        .as_deref()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            req.skill_name
                .as_deref()
                .map(slugify)
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| slug.to_owned());
    // `dir_name` becomes a child directory of `skills_dir`; reject traversal.
    ensure_safe_segment(&dir_name)?;

    let display_name = req
        .skill_name
        .as_deref()
        .filter(|v| !v.is_empty())
        .unwrap_or(slug);

    let skill_dir = skills_dir.join(&dir_name);
    std::fs::create_dir_all(&skill_dir).map_err(io_err)?;
    let final_content = ensure_frontmatter(&req.content, &dir_name, display_name);
    std::fs::write(skill_dir.join("SKILL.md"), final_content.as_bytes()).map_err(io_err)?;

    let state = scan_roles_skills_state(workspace_path)?;
    let linked_roles = state
        .skills
        .iter()
        .find(|skill| skill.filename == dir_name)
        .map(|skill| skill.linked_roles.clone())
        .unwrap_or_default();

    // Read back the directory we wrote, rather than looking for it in the
    // scan's merged view.
    //
    // `load_all_skills` keeps one entry per slug — the highest-priority source
    // wins — so a slug that exists in two roots appears once, under whichever
    // root won. Requiring the scan to return *our* `dir_path` therefore fails
    // whenever a higher-priority copy of the same slug exists anywhere, and the
    // Claude bridge guarantees exactly that for team packs: it symlinks
    // `~/.agents/skills/<slug>` into the workspace's `.claude/skills/`, whose
    // `claude` source outranks `global-agent`. Editing any installed team skill
    // then wrote the file correctly and answered 404 "not found after write" —
    // the write had landed, only the confirmation could not see it.
    let written = load_skills_from_dir(&skills_dir, "local")?
        .into_iter()
        .find(|skill| skill.filename == dir_name)
        .ok_or_else(|| {
            WorkspaceControlError::NotFound(format!("skill {dir_name} not found after write"))
        })?;

    Ok(ManagedSkillDto {
        filename: written.filename,
        name: written.name.clone(),
        invocation_name: Some(written.invocation_name),
        description: extract_skill_description(&written.content, &written.name),
        content: written.content,
        // The source label describes which root a skill was found under, and
        // this one is reported by the scan, not invented here — an upsert
        // answering "local" for a pack under `~/.agents/skills` would relabel it
        // on every save.
        source: state
            .skills
            .iter()
            .find(|skill| {
                skill.filename == dir_name && skill.dir_path == skills_dir.to_string_lossy()
            })
            .and_then(|skill| skill.source.clone()),
        dir_path: skills_dir.to_string_lossy().into_owned(),
        linked_roles,
        is_role_skill: false,
    })
}

pub fn delete_skill(
    workspace_path: &Path,
    slug: &str,
    dir_path: Option<&str>,
) -> Result<(), WorkspaceControlError> {
    let home = dirs::home_dir()
        .ok_or_else(|| WorkspaceControlError::Io("home directory not found".to_owned()))?;
    // `slug` is the leaf skill directory; it must not contain separators/`..`.
    ensure_safe_segment(slug)?;
    let candidates: Vec<PathBuf> = if let Some(dir) = dir_path.filter(|d| !d.is_empty()) {
        vec![confine_path(dir, workspace_path, &home)?.join(slug)]
    } else {
        {
            let mut paths: Vec<PathBuf> = meta_skills_dirs(workspace_path)
                .into_iter()
                .map(|dir| dir.join(slug))
                .collect();
            paths.push(workspace_path.join(".opencode/skills").join(slug));
            for roles in meta_roles_dirs(workspace_path) {
                paths.push(roles.join(ROLE_SKILL_DIR).join(slug));
            }
            paths.push(home.join(".config/opencode/skills").join(slug));
            paths
        }
    };

    for path in candidates {
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(io_err)?;
            return Ok(());
        }
    }
    Err(WorkspaceControlError::NotFound(format!(
        "skill {slug} not found"
    )))
}

pub fn upsert_role(
    workspace_path: &Path,
    slug: &str,
    req: &UpsertRoleRequest,
) -> Result<RoleRecordDto, WorkspaceControlError> {
    let home = dirs::home_dir()
        .ok_or_else(|| WorkspaceControlError::Io("home directory not found".to_owned()))?;
    let role_path = match req.target_file_path.as_deref().filter(|p| !p.is_empty()) {
        Some(target) => confine_path(target, workspace_path, &home)?,
        None => {
            ensure_safe_segment(slug)?;
            brand_roles_dir(workspace_path).join(slug).join("ROLE.md")
        }
    };

    if let Some(parent) = role_path.parent() {
        std::fs::create_dir_all(parent).map_err(io_err)?;
    }
    let markdown = if req.raw_markdown.ends_with('\n') {
        req.raw_markdown.clone()
    } else {
        format!("{}\n", req.raw_markdown)
    };
    std::fs::write(&role_path, markdown.as_bytes()).map_err(io_err)?;
    let parsed_slug = role_path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or(slug);
    Ok(parse_role_markdown(&markdown, parsed_slug, &role_path))
}

pub fn delete_role(
    workspace_path: &Path,
    slug: &str,
    file_path: Option<&str>,
) -> Result<(), WorkspaceControlError> {
    let roots: Vec<PathBuf> = role_roots(workspace_path)
        .iter()
        .map(|r| normalize_lexical(r))
        .collect();

    if let Some(path) = file_path.filter(|p| !p.is_empty()) {
        // `delete_role` recursively removes the role directory (the parent of
        // ROLE.md). Confine that directory to a managed role root and require it
        // to be a strict child of the root — never the root itself or anything
        // outside it — so a crafted `filePath` can't delete arbitrary dirs.
        let role_path = normalize_lexical(Path::new(path));
        let role_dir = role_path.parent().ok_or_else(|| {
            WorkspaceControlError::InvalidInput("role file path has no parent".to_owned())
        })?;
        let confined = roots
            .iter()
            .any(|root| is_within(root, role_dir) && role_dir != root.as_path());
        if !confined {
            return Err(WorkspaceControlError::InvalidInput(format!(
                "role path outside managed role roots: {}",
                role_dir.display()
            )));
        }
        if role_dir.is_dir() {
            std::fs::remove_dir_all(role_dir).map_err(io_err)?;
            return Ok(());
        }
    }

    ensure_safe_segment(slug)?;
    for root in role_roots(workspace_path) {
        let role_dir = root.join(slug);
        if role_dir.is_dir() {
            std::fs::remove_dir_all(&role_dir).map_err(io_err)?;
            return Ok(());
        }
    }
    Err(WorkspaceControlError::NotFound(format!(
        "role {slug} not found"
    )))
}

#[cfg(test)]
mod tests {
    // EVERY test here takes a `BrandEnvGuard`, including the ones that never
    // change the brand. The workspace meta dir is named after the *process*
    // brand (`workspace_meta_read_roots` + `brand_short_name_from_env`), which
    // is a process-global env var, and the white-label tests below flip it to
    // `copilot361` under `TEST_HOME_LOCK`. A test that only reads those paths
    // and does not take the lock therefore has the directory renamed out from
    // under it mid-run: `upsert_skill` writes `.teamclu/skills/<slug>` and the
    // `delete_skill` that follows looks in `.copilot361/skills/` and reports
    // NotFound. That is a real CI failure, not a hypothetical. Pinning the
    // official brand takes the same lock and makes the name deterministic.
    use super::*;

    #[test]
    fn scan_empty_workspace_returns_empty_state() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let dir = tempfile::tempdir().unwrap();
        let state = scan_roles_skills_state(dir.path()).unwrap();
        assert!(state.roles.is_empty());
        // Global skill dirs (~/.config/…) may contribute skills on a developer
        // machine; assert the workspace-local meta dirs contributed nothing.
        assert!(!state.skills.iter().any(|s| {
            s.dir_path.contains("/.teamclu/skills") || s.dir_path.contains("/.copilot361/skills")
        }));
        assert_eq!(state.metrics.roles_count, 0);
    }

    /// Bundle naming for a team root. Declared via `opencode.json` rather than
    /// the team drive's own `skills/`, which is no longer a root — see
    /// `collect_team_skill_paths`.
    #[test]
    fn scan_finds_nested_team_bundle_skills() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();

        let team_root = ws.join("team-skills");
        std::fs::create_dir_all(&team_root).unwrap();
        std::fs::write(
            ws.join("opencode.json"),
            format!(
                r#"{{"skills":{{"paths":["{}"]}}}}"#,
                team_root.to_string_lossy()
            ),
        )
        .unwrap();

        let bundle_dir = team_root.join("superpowers/brainstorming");
        std::fs::create_dir_all(&bundle_dir).unwrap();
        std::fs::write(
            bundle_dir.join("SKILL.md"),
            "---\nname: brainstorming\ndescription: Brainstorm first\n---\n\n# Brainstorming",
        )
        .unwrap();

        let state = scan_roles_skills_state(ws).unwrap();
        let team_skill = state
            .skills
            .iter()
            .find(|skill| skill.filename == "brainstorming")
            .expect("nested team bundle skill");
        assert_eq!(
            team_skill.invocation_name.as_deref(),
            Some("superpowers/brainstorming")
        );
        assert_eq!(team_skill.source.as_deref(), Some("team"));
    }

    /// The team drive's `skills/` is deliberately NOT a root any more.
    ///
    /// `skills/` is in the OSS sync's RETIRED_PREFIXES — it moved to the skills
    /// registry — but that retirement only stopped the syncing; it never deleted
    /// what earlier syncs had already written. Those leftovers kept reaching
    /// agents through this root, which is how a member ends up running a version
    /// the team retired.
    #[test]
    fn team_share_leftovers_are_no_longer_scanned() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();

        let team_skill_dir = ws.join(TEAM_LINK_NAME).join("skills/shared-skill");
        std::fs::create_dir_all(&team_skill_dir).unwrap();
        std::fs::write(
            team_skill_dir.join("SKILL.md"),
            "---\nname: Shared Skill\ndescription: From team drive\n---\n\n# Shared",
        )
        .unwrap();

        let state = scan_roles_skills_state(ws).unwrap();
        assert!(
            !state.skills.iter().any(|s| s.filename == "shared-skill"),
            "a leftover under the team drive must not reach agents any more"
        );
    }

    #[test]
    fn scan_finds_role_and_skill() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();

        let skill_dir = ws.join(".teamclu/skills/demo-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Demo Skill\ndescription: A demo\n---\n\n# Demo",
        )
        .unwrap();

        let role_dir = ws.join(".teamclu/roles/reviewer");
        std::fs::create_dir_all(&role_dir).unwrap();
        std::fs::write(
            role_dir.join("ROLE.md"),
            "---\nname: reviewer\ndescription: Code reviewer\n---\n\n## Role\nReview code.\n",
        )
        .unwrap();

        let state = scan_roles_skills_state(ws).unwrap();
        assert_eq!(state.roles.len(), 1);
        assert_eq!(state.roles[0].slug, "reviewer");
        assert!(
            state.skills.iter().any(|s| s.filename == "demo-skill"),
            "workspace skill must be found"
        );
    }

    #[test]
    fn upsert_and_delete_skill_round_trip() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let req = UpsertSkillRequest {
            content: "# Demo\n\nBody".to_owned(),
            skill_name: Some("Demo Skill".to_owned()),
            install_location: Some("workspace".to_owned()),
            dir_path: None,
            filename: None,
        };
        let saved = upsert_skill(ws.path(), "demo-skill", &req).unwrap();
        assert_eq!(saved.filename, "demo-skill");

        delete_skill(ws.path(), "demo-skill", None).unwrap();
        let state = scan_roles_skills_state(ws.path()).unwrap();
        assert!(
            !state.skills.iter().any(|s| s.filename == "demo-skill"),
            "deleted workspace skill must be gone"
        );
        assert!(!ws.path().join(".teamclu/skills/demo-skill").exists());
    }

    /// Write a one-file skill and return its directory.
    fn seed_skill(root: &Path, rel: &str, slug: &str, body: &str) -> PathBuf {
        let dir = root.join(rel).join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {slug}\n---\n{body}\n"),
        )
        .unwrap();
        root.join(rel)
    }

    #[test]
    fn the_team_pack_root_outranks_a_personal_copy() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        // A member with a same-named skill of their own must not decide what the
        // team's procedure is. Only the workspace's own meta dir and
        // `.claude/skills` sit above the pack root.
        let ws = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let specs = skill_dir_specs(ws.path(), home.path());
        let rank_of = |path: PathBuf| {
            specs
                .iter()
                .find(|s| s.path == path)
                .map(|s| s.rank)
                .unwrap_or_else(|| panic!("no spec for {}", path.display()))
        };
        let pack_root = rank_of(home.path().join(".agents/skills"));

        assert!(pack_root < rank_of(home.path().join(".claude/skills")));
        assert!(pack_root < rank_of(home.path().join(".config/opencode/skills")));
        assert!(pack_root < rank_of(ws.path().join(".opencode/skills")));
        // The workspace's own dirs still win: a project that ships a skill is
        // making a narrower statement than the team registry.
        assert!(pack_root > rank_of(ws.path().join(".claude/skills")));
        assert!(pack_root > RANK_META);
    }

    #[test]
    fn a_duplicated_slug_resolves_by_root_rank_not_by_scan_order() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        // `.claude/skills` (rank 1) outranks `.agents/skills` (3), which
        // outranks `.opencode/skills` (11) — regardless of the order the specs
        // happen to be listed in. Ordering used to be derived from the source
        // label, and since every dot-prefixed root was relabelled `local` they
        // all tied, leaving the winner to array position.
        let ws = tempfile::tempdir().unwrap();
        seed_skill(ws.path(), ".opencode/skills", "dup", "opencode");
        seed_skill(ws.path(), ".agents/skills", "dup", "agents");
        let expected = seed_skill(ws.path(), ".claude/skills", "dup", "claude");

        let state = scan_roles_skills_state(ws.path()).unwrap();
        let rows: Vec<_> = state
            .skills
            .iter()
            .filter(|s| s.filename == "dup")
            .collect();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].dir_path, expected.to_string_lossy());
        assert!(rows[0].content.contains("claude"));
    }

    #[test]
    fn only_the_brand_meta_dir_gets_the_local_builtin_clawhub_labels() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        // `builtin` and `clawhub` are read out of the workspace's own inherent
        // list and lockfile, so they describe the brand meta directory and
        // nothing else. This used to be applied to every root whose parent name
        // began with a dot — i.e. every skills root — which flattened the
        // settings UI's source badges to one value and, worse, collapsed the
        // precedence order they were being derived from.
        let ws = tempfile::tempdir().unwrap();
        std::fs::write(
            ws.path().join(".clawhub-lock-placeholder"),
            "not the lockfile",
        )
        .unwrap();
        std::fs::create_dir_all(ws.path().join(".clawhub")).unwrap();
        std::fs::write(
            ws.path().join(".clawhub/lock.json"),
            r#"{"skills":{"market-pack":{"version":"1"}}}"#,
        )
        .unwrap();

        seed_skill(ws.path(), ".teamclu/skills", "market-pack", "in meta dir");
        seed_skill(ws.path(), ".teamclu/skills", "create-role", "inherent");
        seed_skill(ws.path(), ".agents/skills", "elsewhere", "shared root");
        seed_skill(ws.path(), ".claude/skills", "claude-one", "claude root");

        let state = scan_roles_skills_state(ws.path()).unwrap();
        let source_of = |name: &str| {
            state
                .skills
                .iter()
                .find(|s| s.filename == name)
                .and_then(|s| s.source.clone())
        };

        // Inside the meta dir: classified.
        assert_eq!(source_of("market-pack").as_deref(), Some("clawhub"));
        assert_eq!(source_of("create-role").as_deref(), Some("builtin"));
        // Outside it: the root's own label, not `local`.
        assert_eq!(source_of("elsewhere").as_deref(), Some("shared"));
        assert_eq!(source_of("claude-one").as_deref(), Some("claude"));
    }

    #[test]
    fn upsert_reports_the_directory_it_wrote_even_when_a_higher_source_shadows_the_slug() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        // The share-then-edit case, which used to 404 with "not found after
        // write".
        //
        // Sharing a personal skill copies it into the team pack root and leaves
        // the original where it was, so the slug now exists in two roots.
        //
        // `load_all_skills` keeps one entry per slug, so a slug present in two
        // roots is only ever reported from the winning one. The post-write
        // lookup demanded an entry whose `dir_path` was the directory it had
        // just written to, which the loser never gets: the file was written
        // correctly and only the confirmation failed.
        let ws = tempfile::tempdir().unwrap();
        // The lower-ranked root, standing in for `~/.agents/skills` (rank 9),
        // where team packs live — without needing to move HOME.
        let pack_dir = ws.path().join(".opencode/skills");
        std::fs::create_dir_all(pack_dir.join("deploy-check")).unwrap();
        std::fs::write(
            pack_dir.join("deploy-check/SKILL.md"),
            "---\nname: deploy-check\n---\noriginal\n",
        )
        .unwrap();

        // The copy that wins — the personal original, in the real case.
        let shadow = ws.path().join(".claude/skills/deploy-check");
        std::fs::create_dir_all(&shadow).unwrap();
        std::fs::write(
            shadow.join("SKILL.md"),
            "---\nname: deploy-check\n---\nshadow\n",
        )
        .unwrap();

        // The precondition this test exists for: the merged scan reports one
        // entry for the slug, and it is not the copy we are about to write.
        let merged = scan_roles_skills_state(ws.path()).unwrap();
        let seen: Vec<_> = merged
            .skills
            .iter()
            .filter(|s| s.filename == "deploy-check")
            .collect();
        assert_eq!(seen.len(), 1, "the scan collapses the slug to one entry");
        assert_ne!(seen[0].dir_path, pack_dir.to_string_lossy());

        let req = UpsertSkillRequest {
            content: "---\nname: deploy-check\n---\nedited by the user\n".to_owned(),
            skill_name: Some("deploy-check".to_owned()),
            install_location: None,
            dir_path: Some(pack_dir.to_string_lossy().into_owned()),
            filename: Some("deploy-check".to_owned()),
        };

        let saved = upsert_skill(ws.path(), "deploy-check", &req).unwrap();

        assert_eq!(saved.filename, "deploy-check");
        assert_eq!(saved.dir_path, pack_dir.to_string_lossy());
        assert!(
            saved.content.contains("edited by the user"),
            "the response must describe the file we wrote, not the shadowing copy: {}",
            saved.content
        );
        // And the shadowing copy is untouched.
        assert!(std::fs::read_to_string(shadow.join("SKILL.md"))
            .unwrap()
            .contains("shadow"));
    }

    #[test]
    fn upsert_skill_rejects_dir_path_outside_workspace_and_home() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let req = UpsertSkillRequest {
            content: "# Evil".to_owned(),
            skill_name: Some("Evil".to_owned()),
            install_location: None,
            dir_path: Some(outside.path().to_string_lossy().into_owned()),
            filename: Some("pwned".to_owned()),
        };
        let err = upsert_skill(ws.path(), "evil", &req).unwrap_err();
        assert!(matches!(err, WorkspaceControlError::InvalidInput(_)));
        assert!(!outside.path().join("pwned").exists());
    }

    #[test]
    fn upsert_skill_rejects_traversal_in_filename() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let req = UpsertSkillRequest {
            content: "# Evil".to_owned(),
            skill_name: None,
            install_location: Some("workspace".to_owned()),
            dir_path: None,
            filename: Some("../../escape".to_owned()),
        };
        let err = upsert_skill(ws.path(), "evil", &req).unwrap_err();
        assert!(matches!(err, WorkspaceControlError::InvalidInput(_)));
    }

    #[test]
    fn delete_skill_rejects_traversal_slug() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let err = delete_skill(ws.path(), "../../../etc", None).unwrap_err();
        assert!(matches!(err, WorkspaceControlError::InvalidInput(_)));
    }

    #[test]
    fn delete_role_rejects_file_path_outside_role_roots() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        // A victim directory that lives under the workspace but NOT under a
        // managed role root. delete_role must refuse to remove it.
        let victim = ws.path().join("important-data");
        std::fs::create_dir_all(victim.join("nested")).unwrap();
        let crafted = victim.join("nested/ROLE.md");
        let err = delete_role(ws.path(), "x", Some(&crafted.to_string_lossy())).unwrap_err();
        assert!(matches!(err, WorkspaceControlError::InvalidInput(_)));
        assert!(victim.is_dir(), "victim dir must survive a rejected delete");
    }

    #[test]
    fn delete_role_removes_managed_role_dir_via_file_path() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("teamclu");
        let ws = tempfile::tempdir().unwrap();
        let role_dir = ws.path().join(".teamclu/roles/reviewer");
        std::fs::create_dir_all(&role_dir).unwrap();
        std::fs::write(role_dir.join("ROLE.md"), "---\nname: reviewer\n---\n").unwrap();
        let file_path = role_dir.join("ROLE.md");
        delete_role(ws.path(), "reviewer", Some(&file_path.to_string_lossy())).unwrap();
        assert!(!role_dir.exists());
    }

    #[test]
    fn white_label_scan_reads_brand_meta_without_teamclu_dir() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("copilot361");
        let ws = tempfile::tempdir().unwrap();
        let skill_dir = ws.path().join(".copilot361/skills/brand-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Brand Skill\ndescription: brand\n---\n\n# Brand",
        )
        .unwrap();
        let role_dir = ws.path().join(".copilot361/roles/brand-role");
        std::fs::create_dir_all(&role_dir).unwrap();
        std::fs::write(
            role_dir.join("ROLE.md"),
            "---\nname: brand-role\ndescription: Brand role\n---\n\n## Role\nDo brand things.\n",
        )
        .unwrap();

        assert!(!ws.path().join(".teamclu").exists());
        let state = scan_roles_skills_state(ws.path()).unwrap();
        assert!(
            state.skills.iter().any(|s| s.filename == "brand-skill"),
            "brand meta skills must be visible"
        );
        assert!(
            state.roles.iter().any(|r| r.slug == "brand-role"),
            "brand meta roles must be visible"
        );
    }

    #[test]
    fn white_label_scan_falls_back_to_legacy_teamclu_meta() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("copilot361");
        let ws = tempfile::tempdir().unwrap();
        let skill_dir = ws.path().join(".teamclu/skills/legacy-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Legacy Skill\ndescription: legacy\n---\n\n# Legacy",
        )
        .unwrap();

        let state = scan_roles_skills_state(ws.path()).unwrap();
        assert!(
            state.skills.iter().any(|s| s.filename == "legacy-skill"),
            "legacy .teamclu/skills must still be scanned for white-label"
        );
    }

    #[test]
    fn white_label_upsert_writes_brand_skills_dir() {
        let _guard = crate::test_brand_env::BrandEnvGuard::set("copilot361");
        let ws = tempfile::tempdir().unwrap();
        let req = UpsertSkillRequest {
            content: "# Brand\n\nBody".to_owned(),
            skill_name: Some("Brand Skill".to_owned()),
            install_location: Some("workspace".to_owned()),
            dir_path: None,
            filename: None,
        };
        let saved = upsert_skill(ws.path(), "brand-skill", &req).unwrap();
        assert_eq!(saved.filename, "brand-skill");
        assert!(ws
            .path()
            .join(".copilot361/skills/brand-skill/SKILL.md")
            .is_file());
        assert!(!ws.path().join(".teamclu/skills/brand-skill").exists());
    }
}
