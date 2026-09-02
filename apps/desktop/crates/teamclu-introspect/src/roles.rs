use crate::config;
use serde_json::{json, Value};
use std::path::Path;

pub async fn handle(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let action = arguments
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: action")?;

    match action {
        "list" => {
            let roles = config::read_roles(workspace)?;
            let with_slugs = roles_with_slugs(workspace);
            Ok(json!({ "roles": with_slugs }))
        }

        "create" => {
            let name = arguments
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: name")?;
            let slug = arguments
                .get("slug")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| slugify(name));
            let description = arguments
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let working_style = arguments
                .get("working_style")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let role_dir = role_dir(workspace, &slug);
            if role_dir.exists() {
                return Err(format!("Role '{}' already exists", slug));
            }
            std::fs::create_dir_all(&role_dir)
                .map_err(|e| format!("Failed to create role dir: {e}"))?;

            let content = build_role_md(name, description, working_style);
            let role_md = role_dir.join("ROLE.md");
            std::fs::write(&role_md, content)
                .map_err(|e| format!("Failed to write ROLE.md: {e}"))?;

            Ok(json!({ "ok": true, "slug": slug, "name": name }))
        }

        "update" => {
            let slug = arguments
                .get("slug")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: slug")?;

            let role_md_path = role_dir(workspace, slug).join("ROLE.md");
            if !role_md_path.exists() {
                return Err(format!("Role '{}' not found", slug));
            }

            let raw = std::fs::read_to_string(&role_md_path)
                .map_err(|e| format!("Failed to read ROLE.md: {e}"))?;
            let (mut cur_name, mut cur_desc, mut cur_ws) = parse_role_fields(&raw);

            if let Some(v) = arguments.get("name").and_then(|v| v.as_str()) {
                cur_name = v.to_string();
            }
            if let Some(v) = arguments.get("description").and_then(|v| v.as_str()) {
                cur_desc = v.to_string();
            }
            if let Some(v) = arguments.get("working_style").and_then(|v| v.as_str()) {
                cur_ws = v.to_string();
            }

            let content = build_role_md(&cur_name, &cur_desc, &cur_ws);
            std::fs::write(&role_md_path, content)
                .map_err(|e| format!("Failed to write ROLE.md: {e}"))?;

            Ok(json!({ "ok": true, "slug": slug }))
        }

        "delete" => {
            let slug = arguments
                .get("slug")
                .and_then(|v| v.as_str())
                .ok_or("Missing field: slug")?;

            let dir = role_dir(workspace, slug);
            if !dir.exists() {
                return Err(format!("Role '{}' not found", slug));
            }

            std::fs::remove_dir_all(&dir)
                .map_err(|e| format!("Failed to delete role '{}': {e}", slug))?;

            Ok(json!({ "ok": true, "slug": slug }))
        }

        unknown => Err(format!(
            "Unknown action: '{}'. Valid actions: list, create, update, delete",
            unknown
        )),
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn role_dir(workspace: &str, slug: &str) -> std::path::PathBuf {
    Path::new(workspace)
        .join(config::TEAMCLU_DIR)
        .join("roles")
        .join(slug)
}

/// Like `read_roles` but includes the slug (directory name) in each entry.
fn roles_with_slugs(workspace: &str) -> Vec<Value> {
    let roles_dir = Path::new(workspace).join(config::TEAMCLU_DIR).join("roles");

    if !roles_dir.exists() {
        return vec![];
    }

    let Ok(entries) = std::fs::read_dir(&roles_dir) else {
        return vec![];
    };

    let mut roles: Vec<Value> = entries
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let name_str = name.to_string_lossy();
            name_str != "skill"
                && name_str != "config.json"
                && e.file_type().map(|t| t.is_dir()).unwrap_or(false)
        })
        .filter_map(|e| {
            let slug = e.file_name().to_string_lossy().to_string();
            let role_md = e.path().join("ROLE.md");
            if !role_md.exists() {
                return None;
            }
            let raw = std::fs::read_to_string(&role_md).ok()?;
            let (name, desc, ws) = parse_role_fields(&raw);
            let mut obj = serde_json::Map::new();
            obj.insert("slug".to_string(), json!(slug));
            obj.insert("name".to_string(), json!(name));
            obj.insert("description".to_string(), json!(desc));
            if !ws.is_empty() {
                obj.insert("working_style".to_string(), json!(ws));
            }
            Some(Value::Object(obj))
        })
        .collect();

    roles.sort_by(|a, b| {
        let na = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let nb = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
        na.cmp(nb)
    });

    roles
}

fn build_role_md(name: &str, description: &str, working_style: &str) -> String {
    let mut out = format!("---\nname: \"{name}\"\ndescription: \"{description}\"\n---\n");
    if !working_style.is_empty() {
        out.push_str(&format!("\n## Working style\n\n{working_style}\n"));
    }
    out
}

fn slugify(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Parse name, description, working_style from a ROLE.md string.
fn parse_role_fields(raw: &str) -> (String, String, String) {
    let mut name = String::new();
    let mut description = String::new();
    let mut working_style = String::new();

    let rest = if raw.starts_with("---") {
        let after = &raw[3..];
        if let Some(close) = after.find("\n---") {
            let fm = &after[..close];
            for line in fm.lines() {
                let line = line.trim();
                if let Some(v) = line.strip_prefix("name:") {
                    name = v.trim().trim_matches('"').trim_matches('\'').to_string();
                } else if let Some(v) = line.strip_prefix("description:") {
                    description = v.trim().trim_matches('"').trim_matches('\'').to_string();
                }
            }
            &after[close + 4..]
        } else {
            after
        }
    } else {
        raw
    };

    let lower = rest.to_lowercase();
    let marker = "## working style";
    if let Some(start) = lower.find(marker) {
        let after = &rest[start + marker.len()..];
        let end = after.find("\n##").unwrap_or(after.len());
        working_style = after[..end].trim().to_string();
    }

    (name, description, working_style)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("My Role Name"), "my-role-name");
        assert_eq!(slugify("dev assistant"), "dev-assistant");
        assert_eq!(slugify("  --hello--  "), "hello");
    }

    #[test]
    fn test_parse_role_fields() {
        let raw = "---\nname: \"Dev\"\ndescription: \"coding\"\n---\n\n## Working style\n\nfast\n";
        let (name, desc, ws) = parse_role_fields(raw);
        assert_eq!(name, "Dev");
        assert_eq!(desc, "coding");
        assert_eq!(ws, "fast");
    }

    #[test]
    fn test_build_role_md_roundtrip() {
        let md = build_role_md("Dev", "coding", "fast");
        let (name, desc, ws) = parse_role_fields(&md);
        assert_eq!(name, "Dev");
        assert_eq!(desc, "coding");
        assert_eq!(ws, "fast");
    }

    #[tokio::test]
    async fn test_unknown_action() {
        let args = serde_json::json!({ "action": "nope" });
        let result = handle(".", &args).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown action"));
    }
}
