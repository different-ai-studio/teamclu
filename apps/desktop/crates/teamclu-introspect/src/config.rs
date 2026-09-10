use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub const TEAMCLU_DIR: &str = ".teamclu";
pub const CONFIG_FILE_NAME: &str = "teamclu.json";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn teamclu_dir(workspace: &str) -> PathBuf {
    Path::new(workspace).join(TEAMCLU_DIR)
}

fn config_path(workspace: &str) -> PathBuf {
    teamclu_dir(workspace).join(CONFIG_FILE_NAME)
}

fn cron_jobs_path(workspace: &str) -> PathBuf {
    teamclu_dir(workspace).join("cron-jobs.json")
}

fn cron_runs_path(workspace: &str, job_id: &str) -> PathBuf {
    teamclu_dir(workspace)
        .join("cron-runs")
        .join(format!("{job_id}.jsonl"))
}

fn roles_dir(workspace: &str) -> PathBuf {
    teamclu_dir(workspace).join("roles")
}

// ---------------------------------------------------------------------------
// Generic read helpers
// ---------------------------------------------------------------------------

fn read_json_file_or_default(path: &Path, default: Value) -> Result<Value, String> {
    if !path.exists() {
        return Ok(default);
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create dir {}: {e}", parent.display()))?;
    }
    let mut content = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize JSON: {e}"))?;
    content.push('\n');
    std::fs::write(path, content).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Read `{workspace}/.teamclu/teamclu.json`. Returns `{}` if missing.
pub fn read_teamclu_config(workspace: &str) -> Result<Value, String> {
    read_json_file_or_default(&config_path(workspace), Value::Object(Default::default()))
}

/// Read `{workspace}/.teamclu/cron-jobs.json`. Returns `{ "jobs": [] }` if missing.
pub fn read_cron_jobs(workspace: &str) -> Result<Value, String> {
    read_json_file_or_default(
        &cron_jobs_path(workspace),
        serde_json::json!({ "jobs": [] }),
    )
}

/// Write `{workspace}/.teamclu/cron-jobs.json`.
pub fn write_cron_jobs(workspace: &str, data: &Value) -> Result<(), String> {
    write_json_file(&cron_jobs_path(workspace), data)
}

/// Extract cron jobs from the native `{ jobs: [...] }` shape, while accepting the
/// legacy bare-array shape written by older introspect versions.
pub fn cron_jobs_from_value(data: &Value) -> Vec<Value> {
    data.get("jobs")
        .and_then(|v| v.as_array())
        .or_else(|| data.as_array())
        .cloned()
        .unwrap_or_default()
}

/// Read last `limit` lines from `{workspace}/.teamclu/cron-runs/{job_id}.jsonl`.
/// Returns `[]` if file is missing.
pub fn read_cron_runs(workspace: &str, job_id: &str, limit: usize) -> Result<Vec<Value>, String> {
    let path = cron_runs_path(workspace, job_id);
    if !path.exists() {
        return Ok(vec![]);
    }

    let file = std::fs::File::open(&path)
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    let reader = BufReader::new(file);

    // Collect all non-empty lines then take the last `limit`.
    let lines: Vec<String> = reader
        .lines()
        .filter_map(|l| l.ok())
        .filter(|l| !l.trim().is_empty())
        .collect();

    let start = if lines.len() > limit {
        lines.len() - limit
    } else {
        0
    };

    let mut result = Vec::new();
    for line in &lines[start..] {
        match serde_json::from_str::<Value>(line) {
            Ok(v) => result.push(v),
            Err(e) => {
                eprintln!(
                    "Warning: skipping malformed JSONL line in {}: {e}",
                    path.display()
                );
            }
        }
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// Role parsing
// ---------------------------------------------------------------------------

/// Scan `{workspace}/.teamclu/roles/*/ROLE.md`, parse YAML frontmatter
/// (name, description) and `## Working style` section.
/// Skips entries named "skill" or "config.json".
pub fn read_roles(workspace: &str) -> Result<Vec<Value>, String> {
    let dir = roles_dir(workspace);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read roles dir {}: {e}", dir.display()))?;

    let mut roles = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Error reading roles dir entry: {e}"))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // Skip special names
        if name_str == "skill" || name_str == "config.json" {
            continue;
        }

        // Only process directories
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }

        let role_md = entry.path().join("ROLE.md");
        if !role_md.exists() {
            continue;
        }

        match parse_role_md(&role_md) {
            Ok(role) => roles.push(role),
            Err(e) => {
                eprintln!("Warning: failed to parse {}: {e}", role_md.display());
            }
        }
    }

    // Sort by name for deterministic output
    roles.sort_by(|a, b| {
        let na = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let nb = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
        na.cmp(nb)
    });

    Ok(roles)
}

/// Parse a ROLE.md file and extract frontmatter fields + working style section.
fn parse_role_md(path: &Path) -> Result<Value, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;

    let mut name = String::new();
    let mut description = String::new();
    let mut working_style = String::new();

    // --- Parse YAML frontmatter ---
    let rest = if content.starts_with("---") {
        let after_open = &content[3..];
        if let Some(close_pos) = after_open.find("\n---") {
            let frontmatter = &after_open[..close_pos];
            let rest = &after_open[close_pos + 4..]; // skip "\n---"

            for line in frontmatter.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("name:") {
                    name = val.trim().trim_matches('"').trim_matches('\'').to_string();
                } else if let Some(val) = line.strip_prefix("description:") {
                    description = val.trim().trim_matches('"').trim_matches('\'').to_string();
                }
            }
            rest
        } else {
            &content[3..]
        }
    } else {
        &content
    };

    // --- Parse ## Working style section ---
    let lower = rest.to_lowercase();
    let section_marker = "## working style";
    if let Some(start) = lower.find(section_marker) {
        let after_section = &rest[start + section_marker.len()..];
        // Content runs until the next `##` heading or end of file
        let end = after_section.find("\n##").unwrap_or(after_section.len());
        working_style = after_section[..end].trim().to_string();
    }

    let mut obj = serde_json::Map::new();
    obj.insert("name".to_string(), Value::String(name));
    obj.insert("description".to_string(), Value::String(description));
    if !working_style.is_empty() {
        obj.insert("working_style".to_string(), Value::String(working_style));
    }

    Ok(Value::Object(obj))
}
