use serde::{Deserialize, Serialize};
use std::io::Read as IoRead;
use std::path::PathBuf;

const DEFAULT_REGISTRY: &str = "https://cn.clawhub-mirror.com";
const REQUEST_TIMEOUT_SECS: u64 = 30;

// ─── API Response Types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultEntry {
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ApiSearchResponse {
    results: Vec<SearchResultEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersionInfo {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub changelog: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillOwner {
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillModeration {
    #[serde(default)]
    pub is_suspicious: bool,
    #[serde(default)]
    pub is_malware_blocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub slug: String,
    pub display_name: String,
    #[serde(default)]
    pub tags: serde_json::Value,
    #[serde(default)]
    pub stats: serde_json::Value,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiSkillResponse {
    skill: Option<SkillInfo>,
    latest_version: Option<SkillVersionInfo>,
    owner: Option<SkillOwner>,
    moderation: Option<SkillModeration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListItem {
    pub slug: String,
    pub display_name: String,
    #[serde(default)]
    pub tags: serde_json::Value,
    #[serde(default)]
    pub stats: serde_json::Value,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<SkillVersionInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ApiSkillListResponse {
    items: Vec<SkillListItem>,
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiSearchBrowseResponse {
    results: Vec<SearchResultEntry>,
    next_marker: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ApiResolveResponse {
    #[serde(rename = "match")]
    matched: Option<VersionRef>,
    latest_version: Option<VersionRef>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct VersionRef {
    version: String,
}

// ─── Frontend-facing types ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubSkillDetail {
    pub skill: Option<SkillInfo>,
    pub latest_version: Option<SkillVersionInfo>,
    pub owner: Option<SkillOwner>,
    pub moderation: Option<SkillModeration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubSearchResults {
    pub results: Vec<SearchResultEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubExploreResults {
    pub items: Vec<SkillListItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClawHubUpdateInfo {
    pub slug: String,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub has_update: bool,
}

// ─── Lockfile ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockfileEntry {
    pub version: Option<String>,
    pub installed_at: u64,
    /// Which registry this came from. `None` on entries written before the
    /// team registry existed, which are all ClawHub — so absent reads as
    /// "clawhub" rather than forcing a lockfile migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

pub(crate) const SOURCE_CLAWHUB: &str = "clawhub";
pub(crate) const SOURCE_TEAM: &str = "team";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lockfile {
    pub version: u32,
    pub skills: std::collections::HashMap<String, LockfileEntry>,
}

impl Default for Lockfile {
    fn default() -> Self {
        Self {
            version: 1,
            skills: std::collections::HashMap::new(),
        }
    }
}

// ─── Origin file (per-skill) ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillOrigin {
    pub version: u32,
    pub registry: String,
    pub slug: String,
    pub installed_version: String,
    pub installed_at: u64,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn get_registry() -> String {
    std::env::var("CLAWHUB_REGISTRY").unwrap_or_else(|_| DEFAULT_REGISTRY.to_string())
}

pub(crate) fn build_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

fn lockfile_path(workspace_path: &str) -> PathBuf {
    PathBuf::from(workspace_path)
        .join(".clawhub")
        .join("lock.json")
}

pub(crate) fn read_lockfile(workspace_path: &str) -> Lockfile {
    let path = lockfile_path(workspace_path);
    if !path.exists() {
        let legacy = PathBuf::from(workspace_path)
            .join(".clawdhub")
            .join("lock.json");
        if legacy.exists() {
            if let Ok(raw) = std::fs::read_to_string(&legacy) {
                if let Ok(lock) = serde_json::from_str::<Lockfile>(&raw) {
                    return lock;
                }
            }
        }
        return Lockfile::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Lockfile::default(),
    }
}

pub(crate) fn write_lockfile(workspace_path: &str, lock: &Lockfile) -> Result<(), String> {
    let path = lockfile_path(workspace_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .clawhub dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(lock)
        .map_err(|e| format!("Failed to serialize lockfile: {}", e))?;
    std::fs::write(&path, format!("{}\n", json))
        .map_err(|e| format!("Failed to write lockfile: {}", e))
}

pub(crate) fn skills_dir(_workspace_path: &str) -> PathBuf {
    // All TeamClu / ClawHub / marketplace installs land in the shared Agents
    // skills root so OpenCode, Claude Code, and Pi can discover the same pack.
    agents_skills_dir().unwrap_or_else(|_| PathBuf::from(".agents/skills"))
}

pub(crate) fn global_skills_dir() -> Result<PathBuf, String> {
    agents_skills_dir()
}

fn agents_skills_dir() -> Result<PathBuf, String> {
    super::agents_skills::agents_skills_dir()
}

pub(crate) fn validate_slug(slug: &str) -> Result<(), String> {
    let trimmed = slug.trim();
    if trimmed.is_empty() {
        return Err("Slug is required".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(format!("Invalid slug: {}", trimmed));
    }
    Ok(())
}

/// Safely sanitize a relative path from a zip entry.
/// Returns None for entries that are directories or contain path traversal.
// The traversal guard lives in `teamclu-skillpack` because the daemon unpacks
// the same archives during its reconcile. The unpacking loops stay separate —
// the two crates are on different major versions of `zip` — but the rule for
// which entry names may become paths has exactly one definition.
use teamclu_skillpack::sanitize_zip_path;

pub(crate) fn extract_zip_to_dir(
    zip_bytes: &[u8],
    target_dir: &std::path::Path,
) -> Result<(), String> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip: {}", e))?;

    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create target dir: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry {}: {}", i, e))?;

        let raw_name = file.name().to_string();
        let safe_path = match sanitize_zip_path(&raw_name) {
            Some(p) => p,
            None => continue,
        };

        let out_path = target_dir.join(&safe_path);

        // Extra safety: ensure the resolved path is inside target_dir
        let canonical_target = target_dir
            .canonicalize()
            .unwrap_or_else(|_| target_dir.to_path_buf());
        if let Ok(canonical_out) = out_path.canonicalize() {
            if !canonical_out.starts_with(&canonical_target) {
                eprintln!(
                    "[ClawHub] Skipping zip entry with path traversal: {}",
                    raw_name
                );
                continue;
            }
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dir for {}: {}", safe_path, e))?;
        }

        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read zip entry {}: {}", safe_path, e))?;
        std::fs::write(&out_path, &buf)
            .map_err(|e| format!("Failed to write {}: {}", safe_path, e))?;
        teamclu_skillpack::apply_zip_mode(&out_path, file.unix_mode())
            .map_err(|e| format!("Failed to set mode on {}: {}", safe_path, e))?;
    }

    Ok(())
}

pub(crate) fn write_skill_origin(
    skill_folder: &std::path::Path,
    origin: &SkillOrigin,
) -> Result<(), String> {
    let origin_dir = skill_folder.join(".clawhub");
    std::fs::create_dir_all(&origin_dir)
        .map_err(|e| format!("Failed to create .clawhub origin dir: {}", e))?;
    let json = serde_json::to_string_pretty(origin)
        .map_err(|e| format!("Failed to serialize origin: {}", e))?;
    std::fs::write(origin_dir.join("origin.json"), format!("{}\n", json))
        .map_err(|e| format!("Failed to write origin.json: {}", e))
}

pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Write permission.skill entry for newly installed ClawHub skills.
pub(crate) fn set_skill_permission_ask(workspace_path: &str, slug: &str) {
    let config_path = PathBuf::from(workspace_path).join("opencode.json");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };

    let permission = json.as_object_mut().and_then(|o| {
        o.entry("permission")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
    });
    if let Some(perm_obj) = permission {
        let skill_perms = perm_obj
            .entry("skill")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(skill_obj) = skill_perms.as_object_mut() {
            if !skill_obj.contains_key(slug) {
                skill_obj.insert(slug.to_string(), serde_json::json!("ask"));
            }
        }
    }

    if let Ok(out) = serde_json::to_string_pretty(&json) {
        let _ = std::fs::write(&config_path, format!("{}\n", out));
    }
}

/// Drop a skill's `permission.skill` entry when its pack leaves the machine.
///
/// The entry is a decision about *content*, keyed by slug — and a slug is
/// reusable. Delete a team skill, publish a different one under the same name,
/// and the old decision silently governs the new code: `set_skill_permission_ask`
/// only ever inserts when the key is absent, so the reinstall does not reset it
/// to `ask`. Nothing else removed it, so the entry outlived every pack it was
/// ever about.
///
/// The cost is that uninstalling and reinstalling the *same* skill also forgets
/// the decision and asks once more. That is the direction to err in: the
/// alternative silently grants a skill an approval that was granted to
/// different code.
///
/// Written back only when something actually changed. The daemon watches this
/// file and a permission write means "restart the runtime", so a no-op rewrite
/// on every background reconcile tick would churn the agent for nothing.
pub(crate) fn clear_skill_permission(workspace_path: &str, slug: &str) {
    let config_path = PathBuf::from(workspace_path).join("opencode.json");
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return;
    };
    let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };

    let removed = json
        .get_mut("permission")
        .and_then(|p| p.get_mut("skill"))
        .and_then(|s| s.as_object_mut())
        .map(|skills| skills.remove(slug).is_some())
        .unwrap_or(false);
    if !removed {
        return;
    }

    if let Ok(out) = serde_json::to_string_pretty(&json) {
        let _ = std::fs::write(&config_path, format!("{}\n", out));
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn clawhub_search(
    query: String,
    limit: Option<u32>,
) -> Result<ClawHubSearchResults, String> {
    tokio::task::spawn_blocking(move || -> Result<ClawHubSearchResults, String> {
        let registry = get_registry();
        let client = build_client()?;

        let mut url = format!(
            "{}/api/v1/search?q={}",
            registry,
            urlencoding::encode(&query)
        );
        if let Some(l) = limit {
            url.push_str(&format!("&limit={}", l.min(200)));
        }

        let resp = client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .map_err(|e| format!("Search request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("Search failed with status {}", resp.status()));
        }

        let data: ApiSearchResponse = resp
            .json()
            .map_err(|e| format!("Failed to parse search response: {}", e))?;

        Ok(ClawHubSearchResults {
            results: data.results,
        })
    })
    .await
    .map_err(|e| format!("clawhub task failed: {}", e))?
}

#[tauri::command]
pub async fn clawhub_explore(
    limit: Option<u32>,
    sort: Option<String>,
    cursor: Option<String>,
) -> Result<ClawHubExploreResults, String> {
    tokio::task::spawn_blocking(move || -> Result<ClawHubExploreResults, String> {
        let registry = get_registry();
        let client = build_client()?;

        let bounded_limit = limit.unwrap_or(25).clamp(1, 200);
        let mut url = format!("{}/api/v1/search?q=&limit={}", registry, bounded_limit);
        if let Some(ref s) = sort {
            url.push_str(&format!("&sort={}", urlencoding::encode(s)));
        }
        if let Some(ref c) = cursor {
            url.push_str(&format!("&marker={}", urlencoding::encode(c)));
        }

        let resp = client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .map_err(|e| format!("Explore request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("Explore failed with status {}", resp.status()));
        }

        let data: ApiSearchBrowseResponse = resp
            .json()
            .map_err(|e| format!("Failed to parse explore response: {}", e))?;

        let items: Vec<SkillListItem> = data
            .results
            .into_iter()
            .map(|r| SkillListItem {
                slug: r.slug.unwrap_or_default(),
                display_name: r.display_name.unwrap_or_default(),
                tags: serde_json::Value::Array(vec![]),
                stats: serde_json::Value::Object(serde_json::Map::new()),
                created_at: 0,
                updated_at: r.updated_at.unwrap_or(0),
                summary: r.summary,
                latest_version: r.version.map(|v| SkillVersionInfo {
                    version: v,
                    created_at: None,
                    changelog: String::new(),
                }),
            })
            .collect();

        Ok(ClawHubExploreResults {
            items,
            next_cursor: data.next_marker,
        })
    })
    .await
    .map_err(|e| format!("clawhub task failed: {}", e))?
}

#[tauri::command]
pub async fn clawhub_get_skill(slug: String) -> Result<ClawHubSkillDetail, String> {
    tokio::task::spawn_blocking(move || -> Result<ClawHubSkillDetail, String> {
        validate_slug(&slug)?;
        let registry = get_registry();
        let client = build_client()?;

        let url = format!(
            "{}/api/v1/skills/{}",
            registry,
            urlencoding::encode(slug.trim())
        );

        let resp = client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .map_err(|e| format!("Get skill request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("Get skill failed with status {}", resp.status()));
        }

        let data: ApiSkillResponse = resp
            .json()
            .map_err(|e| format!("Failed to parse skill response: {}", e))?;

        Ok(ClawHubSkillDetail {
            skill: data.skill,
            latest_version: data.latest_version,
            owner: data.owner,
            moderation: data.moderation,
        })
    })
    .await
    .map_err(|e| format!("clawhub task failed: {}", e))?
}

#[tauri::command]
pub async fn clawhub_install(
    workspace_path: Option<String>,
    slug: String,
    version: Option<String>,
    force: Option<bool>,
    is_global: Option<bool>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        clawhub_install_blocking(workspace_path, slug, version, force, is_global)
    })
    .await
    .map_err(|e| format!("clawhub task failed: {}", e))?
}

/// Blocking implementation of skill installation. Runs inside `spawn_blocking`
/// (never on the Tauri main thread) because it performs blocking HTTP + zip IO.
fn clawhub_install_blocking(
    workspace_path: Option<String>,
    slug: String,
    version: Option<String>,
    force: Option<bool>,
    is_global: Option<bool>,
) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;

    let registry = get_registry();
    let client = build_client()?;

    // Always install under ~/.agents/skills; `is_global` kept for API stability.
    let _ = is_global;
    let skills = global_skills_dir()?;

    std::fs::create_dir_all(&skills).map_err(|e| format!("Failed to create skills dir: {}", e))?;

    let target = skills.join(&slug);
    let force = force.unwrap_or(false);

    if target.exists() && !force {
        return Err(format!(
            "Already installed: {} (use force=true to overwrite)",
            target.display()
        ));
    }

    // Fetch skill metadata to check moderation
    let meta_url = format!("{}/api/v1/skills/{}", registry, urlencoding::encode(&slug));
    let meta_resp = client
        .get(&meta_url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Failed to fetch skill metadata: {}", e))?;

    if !meta_resp.status().is_success() {
        return Err(format!("Skill '{}' not found", slug));
    }

    let meta: ApiSkillResponse = meta_resp
        .json()
        .map_err(|e| format!("Failed to parse skill metadata: {}", e))?;

    if let Some(ref moderation) = meta.moderation {
        if moderation.is_malware_blocked {
            return Err(format!(
                "Skill '{}' is flagged as malware and cannot be installed",
                slug
            ));
        }
    }

    let resolved_version = version
        .or_else(|| meta.latest_version.as_ref().map(|v| v.version.clone()))
        .ok_or_else(|| format!("Could not resolve latest version for '{}'", slug))?;

    // Download zip
    let download_url = format!(
        "{}/api/v1/download?slug={}&version={}",
        registry,
        urlencoding::encode(&slug),
        urlencoding::encode(&resolved_version)
    );
    let zip_resp = client
        .get(&download_url)
        .send()
        .map_err(|e| format!("Download failed: {}", e))?;

    if !zip_resp.status().is_success() {
        return Err(format!("Download failed with status {}", zip_resp.status()));
    }

    let zip_bytes = zip_resp
        .bytes()
        .map_err(|e| format!("Failed to read download body: {}", e))?;

    // Remove existing if force
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to remove existing skill dir: {}", e))?;
    }

    extract_zip_to_dir(&zip_bytes, &target)?;

    // Write origin
    write_skill_origin(
        &target,
        &SkillOrigin {
            version: 1,
            registry: registry.clone(),
            slug: slug.clone(),
            installed_version: resolved_version.clone(),
            installed_at: now_millis(),
        },
    )?;

    // Lockfile + default permission when a workspace is open (tracking only).
    if let Some(ws_path) = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let mut lock = read_lockfile(ws_path);
        lock.skills.insert(
            slug.clone(),
            LockfileEntry {
                version: Some(resolved_version.clone()),
                installed_at: now_millis(),
                source: Some(SOURCE_CLAWHUB.to_string()),
            },
        );
        write_lockfile(ws_path, &lock)?;
        set_skill_permission_ask(ws_path, &slug);
    }

    Ok(format!(
        "Installed {}@{} -> {}",
        slug,
        resolved_version,
        target.display()
    ))
}

#[tauri::command]
pub fn clawhub_uninstall(workspace_path: String, slug: String) -> Result<String, String> {
    let slug = slug.trim().to_string();
    validate_slug(&slug)?;

    let mut lock = read_lockfile(&workspace_path);
    let Some(entry) = lock.skills.get(&slug) else {
        return Err(format!("Skill '{}' is not installed via ClawHub", slug));
    };
    // The lockfile is shared with the team registry so update checks run once
    // over one list. Uninstalling a team skill has to go through
    // team_skill_uninstall, which also clears the server-side install record.
    if entry.source.as_deref() == Some(SOURCE_TEAM) {
        return Err(format!(
            "Skill '{}' came from the team registry — uninstall it there",
            slug
        ));
    }

    let target = skills_dir(&workspace_path).join(&slug);
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to remove skill directory: {}", e))?;
    }

    lock.skills.remove(&slug);
    write_lockfile(&workspace_path, &lock)?;
    // Slug is reusable. Left behind, the old decision governs whatever pack
    // claims the name next -- set_skill_permission_ask only writes ask
    // when the key is absent. Same helper, same reason as team uninstall.
    clear_skill_permission(&workspace_path, &slug);

    Ok(format!("Uninstalled {}", slug))
}

#[tauri::command]
pub fn clawhub_list_installed(workspace_path: String) -> Result<Lockfile, String> {
    Ok(read_lockfile(&workspace_path))
}

#[tauri::command]
pub async fn clawhub_update(
    workspace_path: String,
    slug: String,
    version: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let slug = slug.trim().to_string();
        validate_slug(&slug)?;

        let lock = read_lockfile(&workspace_path);
        if !lock.skills.contains_key(&slug) {
            return Err(format!("Skill '{}' is not installed via ClawHub", slug));
        }

        // Re-install with force to update (workspace install)
        clawhub_install_blocking(Some(workspace_path), slug, version, Some(true), Some(false))
    })
    .await
    .map_err(|e| format!("clawhub task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_home::HomeGuard;
    use tempfile::tempdir;

    /// Every ClawHub / marketplace install lands in the shared Agents skills root
    /// so OpenCode, Claude Code and pi all discover the same pack. This asserted
    /// the pre-move `~/.config/opencode/skills` long after the move — and nothing
    /// caught it, because CI never ran this crate's tests.
    #[test]
    fn global_skills_dir_uses_the_shared_agents_skills_root() {
        let home_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());
        let dir = global_skills_dir().unwrap();
        assert_eq!(dir, home_dir.path().join(".agents/skills"));
    }

    fn workspace_with_permission(value: &str) -> tempfile::TempDir {
        let ws = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            ws.path().join("opencode.json"),
            serde_json::json!({
                "permission": { "bash": "ask", "skill": { "deploy-check": value, "other": "allow" } }
            })
            .to_string(),
        )
        .unwrap();
        ws
    }

    fn skill_permissions(ws: &std::path::Path) -> serde_json::Value {
        let raw = std::fs::read_to_string(ws.join("opencode.json")).unwrap();
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()["permission"]["skill"].clone()
    }

    fn write_clawhub_lock(ws: &std::path::Path, slug: &str) {
        let mut lock = Lockfile::default();
        lock.skills.insert(
            slug.to_string(),
            LockfileEntry {
                version: Some("1.0.0".into()),
                installed_at: 1,
                source: Some(SOURCE_CLAWHUB.to_string()),
            },
        );
        write_lockfile(&ws.display().to_string(), &lock).unwrap();
    }

    /// A slug is reusable, so an approval that outlives its pack ends up
    /// governing whatever content claims the name next.
    #[test]
    fn uninstall_forgets_the_skills_permission() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = HomeGuard::set(home.path());
        let ws = workspace_with_permission("allow");
        write_clawhub_lock(ws.path(), "deploy-check");
        std::fs::create_dir_all(global_skills_dir().unwrap().join("deploy-check")).unwrap();

        clawhub_uninstall(ws.path().display().to_string(), "deploy-check".into())
            .expect("uninstall");

        let skills = skill_permissions(ws.path());
        assert!(skills.get("deploy-check").is_none(), "the entry must go");
        assert_eq!(skills["other"], "allow");
        let raw = std::fs::read_to_string(ws.path().join("opencode.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["permission"]["bash"], "ask");
    }

    #[test]
    fn uninstall_leaves_the_config_untouched_when_there_is_no_entry() {
        let home = tempfile::tempdir().expect("tempdir");
        let _home = HomeGuard::set(home.path());
        let ws = tempfile::tempdir().expect("tempdir");
        let config = ws.path().join("opencode.json");
        std::fs::write(&config, r#"{"permission":{"skill":{"other":"allow"}}}"#).unwrap();
        write_clawhub_lock(ws.path(), "deploy-check");
        let before = std::fs::read_to_string(&config).unwrap();

        clawhub_uninstall(ws.path().display().to_string(), "deploy-check".into())
            .expect("uninstall");

        assert_eq!(std::fs::read_to_string(&config).unwrap(), before);
    }
}
