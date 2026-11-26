//! The two "who gets in" of an app, kept apart (CLI design Q2):
//!
//! - **access** — who may *work on* the app: read, write or admin, granted to
//!   a team member, an agent, or the whole org (`app_grants`);
//! - **gate** — who may *open the deployed site*: the login wall the gateway
//!   enforces (`auth_mode`, `auth_audience`, `auth_scope`, `auth_rules`).
//!
//! Neither asks anyone first: the platform decides whether the caller may
//! (P2.5 §0). A refusal comes back as the server's 403/404, which the CLI
//! answers with exit 4 or 5 and the level it needed.

use serde_json::{json, Value};

use crate::row::{app_path, items_of, row_id, row_str};
use crate::settings::UpdateArgs;
use crate::{AppOps, Named, OpError};

/// What `access grant` may hand out to an actor.
pub const ACCESS_LEVELS: [&str; 3] = ["read", "write", "admin"];

/// `view` / `prompt` are the levels' names before 2026-11-17; the API still
/// takes them, so a caller passing one gets what it meant.
pub fn access_level(level: &str) -> Result<&'static str, OpError> {
    match level.trim() {
        "read" | "view" => Ok("read"),
        "write" | "prompt" => Ok("write"),
        "admin" => Ok("admin"),
        other => Err(OpError::invalid(
            "invalid_level",
            format!("level must be read, write or admin (got {other:?})"),
        )),
    }
}

/// One actor of the app's team that access can be granted to.
#[derive(Debug, Clone)]
struct TeamActor {
    id: String,
    name: String,
    /// `member` or `agent`.
    kind: String,
    /// The member an agent belongs to.
    owner: Option<String>,
}

fn grant_view(g: &Value) -> Value {
    let inherited = g.get("inherited").and_then(Value::as_bool).unwrap_or(false);
    json!({
        "actor_id": g.get("memberId"),
        "name": g.get("displayName"),
        "kind": g.get("actorType"),
        "level": g.get("permissionLevel"),
        // `direct` is a grant of its own; `inherited` follows the agent's
        // owner and cannot be revoked here — revoke the owner's instead.
        "source": if inherited { "inherited" } else { "direct" },
        "inherited_from": g.get("inheritedFrom").filter(|v| !v.is_null()).map(|o| json!({
            "actor_id": o.get("actorId"),
            "name": o.get("displayName"),
        })),
        "connected": g.get("connected"),
        "granted_by": g.get("grantedByMemberId"),
    })
}

/// The org-wide level the row implies: `/v1` still speaks `visibility`, and
/// `team` is exactly an org read grant (P3 Q1).
fn org_level(row: &Value) -> Value {
    match row_str(row, "visibility") {
        Some("team") => json!("read"),
        _ => Value::Null,
    }
}

/// Edits to the login wall; only what is `Some` changes (Q12).
#[derive(Debug, Clone, Default)]
pub struct GateSet {
    /// `none` or `platform`.
    pub mode: Option<String>,
    /// `any` or `org`.
    pub audience: Option<String>,
    /// `all` or `paths`.
    pub scope: Option<String>,
    /// Replaces the whole rule list.
    pub rules: Option<Value>,
}

/// One path rule, as `gate rule add` builds it.
#[derive(Debug, Clone, Default)]
pub struct GateRule {
    pub path: String,
    /// `required` or `public`.
    pub auth: String,
    pub audience: Option<String>,
    pub roles: Option<Vec<String>>,
}

impl GateRule {
    fn to_value(&self) -> Result<Value, OpError> {
        if !self.path.starts_with('/') {
            return Err(OpError::invalid(
                "invalid_rule_path",
                format!("a rule path starts with \"/\" (got {:?})", self.path),
            ));
        }
        if !matches!(self.auth.as_str(), "required" | "public") {
            return Err(OpError::invalid(
                "invalid_rule_auth",
                format!("--auth must be required or public (got {:?})", self.auth),
            ));
        }
        if self.auth == "public" && (self.audience.is_some() || self.roles.is_some()) {
            return Err(OpError::invalid(
                "public_rule_has_audience",
                "a public rule lets everyone in; --audience and --roles only apply to --auth required",
            ));
        }
        let mut rule = json!({ "path": self.path, "auth": self.auth });
        if let Some(audience) = &self.audience {
            if !matches!(audience.as_str(), "any" | "org") {
                return Err(OpError::invalid(
                    "invalid_rule_audience",
                    format!("--audience must be any or org (got {audience:?})"),
                ));
            }
            rule["audience"] = json!(audience);
        }
        if let Some(roles) = &self.roles {
            rule["roles"] = json!(roles);
        }
        Ok(rule)
    }
}

impl AppOps<'_> {
    async fn team_actors(&self, row: &Value) -> Result<Vec<TeamActor>, OpError> {
        let team_id = row_str(row, "teamId").ok_or("app row has no team")?;
        let page = self
            .get(
                &format!(
                    "/v1/teams/{}/actors?limit=500",
                    urlencoding::encode(team_id)
                ),
                "Listing the team's members and agents",
            )
            .await?;
        Ok(items_of(&page)
            .iter()
            .filter_map(|a| {
                let id = row_str(a, "id")?.to_string();
                let kind = row_str(a, "kind")?.to_string();
                if kind != "member" && kind != "agent" {
                    return None;
                }
                Some(TeamActor {
                    name: row_str(a, "displayName").unwrap_or(&id).to_string(),
                    owner: row_str(a, "agentOwnerMemberId").map(str::to_string),
                    id,
                    kind,
                })
            })
            .collect())
    }

    /// The actor `who` names. An id is taken as given even when it is not in
    /// the team list: a grant can outlive its holder's place on the team, and
    /// revoking it is exactly what someone cleaning up wants.
    async fn grantee(&self, row: &Value, who: &Named) -> Result<(String, String), OpError> {
        let actors = self.team_actors(row).await?;
        match who {
            Named::Id(id) => Ok((
                id.clone(),
                actors
                    .iter()
                    .find(|a| &a.id == id)
                    .map(|a| a.name.clone())
                    .unwrap_or_else(|| id.clone()),
            )),
            Named::Name(name) => {
                let pairs: Vec<(String, String)> = actors
                    .iter()
                    .map(|a| (a.id.clone(), a.name.clone()))
                    .collect();
                crate::pick_by_name(&pairs, name, "team member or agent", "actor_id")
                    .cloned()
                    .map_err(|e| e.with_next(crate::step("access ls")))
            }
        }
    }

    /// `access ls` — every grant with where it comes from, the org-wide level,
    /// and who else could be granted, people and agents apart.
    pub async fn access_list(&self, row: &Value) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let listing = self
            .get(
                &app_path(&app_id, "/access"),
                "Reading who has access to the app (needs admin on it)",
            )
            .await?;
        let grants = items_of(&listing);
        let actors = self.team_actors(row).await?;
        let creator = row_str(row, "createdByActorId").unwrap_or_default();
        let held =
            |id: &str| id == creator || grants.iter().any(|g| row_str(g, "memberId") == Some(id));
        let name_of = |id: &str| actors.iter().find(|a| a.id == id).map(|a| a.name.clone());
        let candidates = |kind: &str| -> Vec<Value> {
            actors
                .iter()
                .filter(|a| a.kind == kind && !held(&a.id))
                .map(|a| {
                    let mut c = json!({ "actor_id": a.id, "name": a.name });
                    if let Some(owner) = &a.owner {
                        c["owner"] = json!({ "actor_id": owner, "name": name_of(owner) });
                    }
                    c
                })
                .collect()
        };
        Ok(json!({
            "action": "access_ls",
            "app_id": app_id,
            // Admin by having created the app; never in the grant list, and
            // cannot be downgraded or revoked.
            "creator": { "actor_id": creator, "name": name_of(creator) },
            "org": org_level(row),
            "grants": grants.iter().map(grant_view).collect::<Vec<_>>(),
            "candidates": { "members": candidates("member"), "agents": candidates("agent") },
        }))
    }

    /// `access grant <who> <level>` — upserts the actor's own grant.
    pub async fn access_grant(
        &self,
        row: &Value,
        who: &Named,
        level: &str,
    ) -> Result<Value, OpError> {
        let level = access_level(level)?;
        let app_id = row_id(row)?;
        let (actor_id, name) = self.grantee(row, who).await?;
        if Some(actor_id.as_str()) == row_str(row, "createdByActorId") {
            return Err(OpError::conflict(
                "grantee_is_creator",
                format!(
                    "{name} created this app and is always admin on it; there is nothing to grant."
                ),
            ));
        }
        let saved = self
            .put(
                &app_path(
                    &app_id,
                    &format!("/access/{}", urlencoding::encode(&actor_id)),
                ),
                &json!({ "permissionLevel": level }),
                "Granting access (needs admin on the app, held directly — not through an owner)",
            )
            .await?;
        self.host.app_changed(row);
        Ok(json!({
            "ok": true,
            "action": "access_grant",
            "app_id": app_id,
            "grant": {
                "actor_id": actor_id,
                "name": name,
                "level": saved.get("permissionLevel").cloned().unwrap_or(json!(level)),
            },
        }))
    }

    /// `access revoke <who>` — removes the actor's own grant. An agent's
    /// inherited level is its owner's and stays until the owner's goes.
    pub async fn access_revoke(&self, row: &Value, who: &Named) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let (actor_id, name) = self.grantee(row, who).await?;
        if Some(actor_id.as_str()) == row_str(row, "createdByActorId") {
            return Err(OpError::conflict(
                "grantee_is_creator",
                format!("{name} created this app; the creator's admin cannot be revoked."),
            ));
        }
        self.del(
            &app_path(
                &app_id,
                &format!("/access/{}", urlencoding::encode(&actor_id)),
            ),
            "Revoking access (needs admin on the app, held directly — not through an owner)",
        )
        .await?;
        self.host.app_changed(row);
        Ok(json!({
            "ok": true,
            "action": "access_revoke",
            "app_id": app_id,
            "actor_id": actor_id,
            "name": name,
        }))
    }

    /// `access grant --org <level>` / `access revoke --org` (`level` None).
    ///
    /// `/v1` carries the org grant as `visibility` (P3 Q1): `team` is an org
    /// read grant, `personal` none. The platform can store an org write grant
    /// but nothing writes one yet, so it is refused rather than quietly
    /// turned into read.
    pub async fn access_org(&self, row: &Value, level: Option<&str>) -> Result<Value, OpError> {
        let visibility = match level.map(access_level).transpose()? {
            None => "personal",
            Some("read") => "team",
            Some(other) => {
                return Err(OpError::invalid(
                    "org_level_unsupported",
                    format!("the whole org can be granted read for now, not {other}; grant write to people or agents one by one"),
                )
                .with_next(crate::step("access grant")))
            }
        };
        let out = self
            .update(
                row,
                &UpdateArgs {
                    visibility: Some(visibility.to_string()),
                    ..Default::default()
                },
            )
            .await?;
        Ok(json!({
            "ok": true,
            "action": if level.is_some() { "access_grant" } else { "access_revoke" },
            "app_id": row_id(row)?,
            "org": org_level(&json!({ "visibility": out["app"]["visibility"] })),
            "notes": out["notes"],
        }))
    }

    /// `gate show` — the wall as configured, the policy each path resolves
    /// to, and the org's role catalog that `--roles` picks from.
    pub async fn gate_show(&self, row: &Value) -> Result<Value, OpError> {
        let app_id = row_id(row)?;
        let info = self
            .get(
                &app_path(&app_id, "/auth-info"),
                "Reading the app's login wall and the org's roles",
            )
            .await?;
        Ok(json!({
            "action": "gate_show",
            "app_id": app_id,
            "mode": info.get("authMode"),
            "audience": info.get("authAudience"),
            "scope": info.get("authScope"),
            "rules": info.get("authRules").cloned().unwrap_or(json!([])),
            "effective_policies": info.get("effectivePolicies").cloned().unwrap_or(json!([])),
            "organization": info.get("organization"),
            "organization_status": info.get("organizationStatus"),
            "roles": info.get("roles").cloned().unwrap_or(json!([])),
        }))
    }

    /// `gate set` — the fields given, nothing else.
    pub async fn gate_set(&self, row: &Value, set: &GateSet) -> Result<Value, OpError> {
        if set.mode.is_none()
            && set.audience.is_none()
            && set.scope.is_none()
            && set.rules.is_none()
        {
            return Err(OpError::invalid(
                "nothing_to_set",
                "gate set needs at least one of --mode, --audience, --scope, --rules-file",
            ));
        }
        self.write_gate(
            row,
            "gate_set",
            UpdateArgs {
                auth_mode: set.mode.clone(),
                auth_audience: set.audience.clone(),
                auth_scope: set.scope.clone(),
                auth_rules: set.rules.clone(),
                ..Default::default()
            },
        )
        .await
    }

    /// `gate rule add` — adds the rule, or replaces the one on the same path.
    pub async fn gate_rule_add(&self, row: &Value, rule: &GateRule) -> Result<Value, OpError> {
        let new_rule = rule.to_value()?;
        let mut rules = current_rules(row);
        match rules.iter_mut().find(|r| r["path"] == new_rule["path"]) {
            Some(existing) => *existing = new_rule,
            None => rules.push(new_rule),
        }
        self.write_gate(
            row,
            "gate_rule_add",
            UpdateArgs {
                auth_rules: Some(Value::Array(rules)),
                ..Default::default()
            },
        )
        .await
    }

    /// `gate rule rm` — removes the rule on exactly that path.
    pub async fn gate_rule_rm(&self, row: &Value, path: &str) -> Result<Value, OpError> {
        let mut rules = current_rules(row);
        let before = rules.len();
        rules.retain(|r| r["path"].as_str() != Some(path));
        if rules.len() == before {
            return Err(OpError::not_found(
                "no_such_rule",
                format!(
                    "No rule on {path:?}. Rules: {}",
                    Value::Array(current_rules(row))
                ),
            )
            .with_next(crate::step("gate show")));
        }
        self.write_gate(
            row,
            "gate_rule_rm",
            UpdateArgs {
                auth_rules: Some(Value::Array(rules)),
                ..Default::default()
            },
        )
        .await
    }

    async fn write_gate(
        &self,
        row: &Value,
        action: &str,
        args: UpdateArgs,
    ) -> Result<Value, OpError> {
        let out = self.update(row, &args).await?;
        let app = &out["app"];
        Ok(json!({
            "ok": true,
            "action": action,
            "app_id": row_id(row)?,
            "gate": {
                "mode": app["auth_mode"],
                "audience": app["auth_audience"],
                "scope": app["auth_scope"],
                "rules": app["auth_rules"],
            },
            "notes": out["notes"],
        }))
    }
}

fn current_rules(row: &Value) -> Vec<Value> {
    row.get("authRules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_level_names_mean_the_new_ones() {
        assert_eq!(access_level("view").unwrap(), "read");
        assert_eq!(access_level("prompt").unwrap(), "write");
        assert_eq!(access_level("admin").unwrap(), "admin");
        assert_eq!(access_level("owner").unwrap_err().code, "invalid_level");
    }

    #[test]
    fn a_rule_is_checked_before_any_round_trip() {
        let rule = |path: &str, auth: &str, audience: Option<&str>| GateRule {
            path: path.into(),
            auth: auth.into(),
            audience: audience.map(str::to_string),
            roles: None,
        };
        assert_eq!(
            rule("/admin", "required", Some("org")).to_value().unwrap(),
            json!({"path":"/admin","auth":"required","audience":"org"})
        );
        assert_eq!(
            rule("admin", "required", None).to_value().unwrap_err().code,
            "invalid_rule_path"
        );
        assert_eq!(
            rule("/a", "open", None).to_value().unwrap_err().code,
            "invalid_rule_auth"
        );
        assert_eq!(
            rule("/health", "public", Some("org"))
                .to_value()
                .unwrap_err()
                .code,
            "public_rule_has_audience"
        );
    }

    #[test]
    fn the_org_level_is_read_off_visibility() {
        assert_eq!(org_level(&json!({"visibility":"team"})), json!("read"));
        assert_eq!(org_level(&json!({"visibility":"personal"})), Value::Null);
    }
}
