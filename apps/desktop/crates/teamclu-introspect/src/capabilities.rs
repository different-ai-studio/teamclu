use serde_json::{json, Value};

// ─── Channel bound checking ──────────────────────────────────────────────────

/// Check whether a named channel is bound (has required credentials).
/// `config` is the parsed channels sub-object from teamclu.json.
pub fn is_channel_bound_pub(name: &str, channels: &Value) -> bool {
    let ch = &channels[name];
    match name {
        "wecom" => {
            // WeCom uses bot_id + secret (camelCase in JSON: botId/secret)
            let bot_id = ch.get("botId").or_else(|| ch.get("bot_id"));
            let secret = ch.get("secret");
            non_empty_str(bot_id) && non_empty_str(secret)
        }
        "discord" => non_empty_str(ch.get("token")),
        "email" => {
            non_empty_str(ch.get("gmailEmail").or_else(|| ch.get("gmail_email")))
                || non_empty_str(ch.get("username"))
        }
        "feishu" => {
            non_empty_str(ch.get("appId").or_else(|| ch.get("app_id")))
                && non_empty_str(ch.get("appSecret").or_else(|| ch.get("app_secret")))
        }
        "seatalk" => {
            non_empty_str(ch.get("appId").or_else(|| ch.get("app_id")))
                && non_empty_str(ch.get("appSecret").or_else(|| ch.get("app_secret")))
        }
        "kook" => non_empty_str(ch.get("token")),
        "wechat" => non_empty_str(ch.get("botToken").or_else(|| ch.get("bot_token"))),
        _ => false,
    }
}

fn non_empty_str(v: Option<&Value>) -> bool {
    v.and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

// ─── Main handler ────────────────────────────────────────────────────────────

pub async fn handle(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let category = arguments.get("category").and_then(|v| v.as_str());

    match category {
        None => build_overview(workspace),
        Some("channels") => build_channels(workspace),
        Some("role") => build_role(workspace),
        Some("team_members") => build_team_members(workspace),
        Some("env_vars") => build_env_vars(workspace),
        Some("team_info") => build_team_info(workspace),
        Some("cron_jobs") => build_cron_jobs(workspace),
        Some(other) => Err(format!("Unknown category: {other}")),
    }
}

// ─── Overview ────────────────────────────────────────────────────────────────

fn build_overview(workspace: &str) -> Result<Value, String> {
    let config = crate::config::read_teamclu_config(workspace)?;

    let channels_val = config.get("channels").cloned().unwrap_or(json!({}));
    let channel_names = [
        "wecom", "discord", "email", "feishu", "kook", "wechat", "seatalk",
    ];
    let mut bound = Vec::new();
    let mut unbound = Vec::new();
    for name in channel_names {
        if is_channel_bound_pub(name, &channels_val) {
            bound.push(name);
        } else {
            unbound.push(name);
        }
    }

    let env_vars = config
        .get("envVars")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    let team = config.get("team").cloned().unwrap_or(json!(null));
    let team_enabled = team
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let team_mode = if team_enabled { "git" } else { "none" };

    let roles = crate::config::read_roles(workspace).unwrap_or_default();
    let role_count = roles.len();

    let members = crate::config::read_team_members(workspace).unwrap_or(json!({}));
    let member_count = members.as_object().map(|m| m.len()).unwrap_or(0);

    let cron_jobs = crate::config::cron_jobs_from_value(&crate::config::read_cron_jobs(workspace)?);
    let cron_total = cron_jobs.len();
    let cron_enabled = cron_jobs
        .iter()
        .filter(|j| j.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false))
        .count();

    Ok(json!({
        "channels": {
            "bound": bound,
            "unbound": unbound
        },
        "roles": {
            "count": role_count
        },
        "team_members": {
            "count": member_count
        },
        "env_vars": {
            "count": env_vars
        },
        "team_info": {
            "enabled": team_enabled,
            "mode": team_mode
        },
        "cron_jobs": {
            "total": cron_total,
            "enabled": cron_enabled
        }
    }))
}

// ─── Channels ────────────────────────────────────────────────────────────────

fn build_channels(workspace: &str) -> Result<Value, String> {
    let config = crate::config::read_teamclu_config(workspace)?;
    let channels = config.get("channels").cloned().unwrap_or(json!({}));

    let mut result = json!({});

    // wecom
    {
        let bound = is_channel_bound_pub("wecom", &channels);
        let ch = &channels["wecom"];
        let bot_name = ch
            .get("botId")
            .or_else(|| ch.get("bot_id"))
            .and_then(|v| v.as_str())
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(json!(null));
        result["wecom"] = json!({
            "bound": bound,
            "enabled": ch.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
            "bot_name": bot_name
        });
    }

    // discord
    {
        let bound = is_channel_bound_pub("discord", &channels);
        let ch = &channels["discord"];
        result["discord"] = json!({
            "bound": bound,
            "enabled": ch.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false)
        });
    }

    // email
    {
        let bound = is_channel_bound_pub("email", &channels);
        let ch = &channels["email"];
        let address = ch
            .get("gmailEmail")
            .or_else(|| ch.get("gmail_email"))
            .or_else(|| ch.get("username"))
            .and_then(|v| v.as_str())
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(json!(null));
        result["email"] = json!({
            "bound": bound,
            "enabled": ch.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
            "address": address
        });
    }

    // feishu
    {
        let bound = is_channel_bound_pub("feishu", &channels);
        let ch = &channels["feishu"];
        let app_id = ch
            .get("appId")
            .or_else(|| ch.get("app_id"))
            .and_then(|v| v.as_str())
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(json!(null));
        result["feishu"] = json!({
            "bound": bound,
            "enabled": ch.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
            "app_id": app_id
        });
    }

    // kook
    {
        let bound = is_channel_bound_pub("kook", &channels);
        let ch = &channels["kook"];
        result["kook"] = json!({
            "bound": bound,
            "enabled": ch.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false)
        });
    }

    // wechat
    {
        let bound = is_channel_bound_pub("wechat", &channels);
        let ch = &channels["wechat"];
        let account_id = ch
            .get("accountId")
            .or_else(|| ch.get("account_id"))
            .and_then(|v| v.as_str())
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(json!(null));
        result["wechat"] = json!({
            "bound": bound,
            "enabled": ch.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
            "account_id": account_id
        });
    }

    Ok(result)
}

// ─── Role ────────────────────────────────────────────────────────────────────

fn build_role(workspace: &str) -> Result<Value, String> {
    let roles = crate::config::read_roles(workspace)?;
    Ok(json!({
        "available_roles": roles
    }))
}

// ─── Team members ────────────────────────────────────────────────────────────

fn build_team_members(workspace: &str) -> Result<Value, String> {
    let raw = crate::config::read_team_members(workspace)?;

    // members.json is an object keyed by member id/name
    // Each value may have name, role, label fields
    let members: Vec<Value> = match raw {
        Value::Object(map) => map
            .values()
            .map(|m| {
                let mut entry = serde_json::Map::new();
                if let Some(n) = m.get("name").and_then(|v| v.as_str()) {
                    entry.insert("name".to_string(), Value::String(n.to_string()));
                }
                if let Some(r) = m.get("role").and_then(|v| v.as_str()) {
                    entry.insert("role".to_string(), Value::String(r.to_string()));
                }
                if let Some(l) = m.get("label") {
                    entry.insert("label".to_string(), l.clone());
                }
                Value::Object(entry)
            })
            .collect(),
        Value::Array(arr) => arr
            .into_iter()
            .map(|m| {
                let mut entry = serde_json::Map::new();
                if let Some(n) = m.get("name").and_then(|v| v.as_str()) {
                    entry.insert("name".to_string(), Value::String(n.to_string()));
                }
                if let Some(r) = m.get("role").and_then(|v| v.as_str()) {
                    entry.insert("role".to_string(), Value::String(r.to_string()));
                }
                if let Some(l) = m.get("label") {
                    entry.insert("label".to_string(), l.clone());
                }
                Value::Object(entry)
            })
            .collect(),
        _ => vec![],
    };

    Ok(json!({
        "team_members": members
    }))
}

// ─── Env vars ────────────────────────────────────────────────────────────────

fn build_env_vars(workspace: &str) -> Result<Value, String> {
    let listings = teamclu_runtime_env::env_catalog::load_agent_env_listings(
        std::path::Path::new(workspace),
        None,
        None,
    );
    let safe: Vec<Value> = listings
        .into_iter()
        .map(|entry| {
            let mut out = serde_json::Map::new();
            out.insert("key".to_string(), Value::String(entry.key));
            if let Some(description) = entry.description {
                out.insert("description".to_string(), Value::String(description));
            }
            if let Some(category) = entry.category {
                out.insert("category".to_string(), Value::String(category));
            }
            Value::Object(out)
        })
        .collect();

    Ok(json!({
        "env_vars": safe
    }))
}

// ─── Team info ───────────────────────────────────────────────────────────────

fn build_team_info(workspace: &str) -> Result<Value, String> {
    let config = crate::config::read_teamclu_config(workspace)?;
    let team = config.get("team").cloned().unwrap_or(json!(null));

    // Strip sensitive tokens
    let safe_team = match team {
        Value::Object(mut map) => {
            map.remove("gitToken");
            map.remove("git_token");
            Value::Object(map)
        }
        other => other,
    };

    Ok(json!({
        "team_info": safe_team
    }))
}

// ─── Cron jobs ───────────────────────────────────────────────────────────────

fn build_cron_jobs(workspace: &str) -> Result<Value, String> {
    let raw = crate::config::read_cron_jobs(workspace)?;
    let jobs = crate::config::cron_jobs_from_value(&raw);

    let safe: Vec<Value> = jobs
        .iter()
        .map(|job| {
            let mut out = serde_json::Map::new();
            for field in &[
                "id",
                "name",
                "description",
                "enabled",
                "schedule",
                "lastRunAt",
                "nextRunAt",
                "last_run_at",
                "next_run_at",
            ] {
                if let Some(v) = job.get(*field) {
                    // Normalize field names to snake_case for output
                    let key = match *field {
                        "lastRunAt" => "last_run_at",
                        "nextRunAt" => "next_run_at",
                        other => other,
                    };
                    out.insert(key.to_string(), v.clone());
                }
            }
            Value::Object(out)
        })
        .collect();

    Ok(json!({
        "cron_jobs": safe
    }))
}
