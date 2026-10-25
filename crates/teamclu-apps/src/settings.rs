//! `update` and `delete` — the app row's settings, and the app itself.

use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::row::{app_path, app_settings, row_id, row_str, APP_TYPES};
use crate::{AppOps, Method, Surface};

/// An `update` call: every setting an operator may change, all optional.
///
/// Only those: status fields are the deploy's to write, and `runtime` is
/// derived from the checkout on every deploy, so a setter for it would be
/// overwritten by the next one.
#[derive(Debug, Clone, Default)]
pub struct UpdateArgs {
    pub name: Option<String>,
    pub app_type: Option<String>,
    /// `personal` or `team`.
    pub visibility: Option<String>,
    /// `none` or `platform`.
    pub auth_mode: Option<String>,
    /// `any` or `org`.
    pub auth_audience: Option<String>,
    /// `all` or `paths`.
    pub auth_scope: Option<String>,
    /// `[{ path, auth, audience?, roles? }]`, as the row stores it.
    pub auth_rules: Option<Value>,
}

fn one_of(field: &str, value: &Option<String>, allowed: &[&str]) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(value) if allowed.contains(&value.as_str()) => Ok(Some(value.clone())),
        Some(value) => Err(format!(
            "{field} must be one of: {} (got {value:?})",
            allowed.join(", ")
        )),
    }
}

impl UpdateArgs {
    /// The `PATCH /v1/apps/:id` body, checked for the errors that need no
    /// round trip. The server validates again (rules as a set, the scope/rules
    /// pair) and its message is passed on.
    pub fn patch(&self) -> Result<Value, String> {
        let mut patch = Map::new();
        if let Some(name) = &self.name {
            patch.insert("name".into(), json!(name));
        }
        if let Some(app_type) = one_of("type", &self.app_type, &APP_TYPES)? {
            patch.insert("type".into(), json!(app_type));
        }
        if let Some(visibility) = one_of("visibility", &self.visibility, &["personal", "team"])? {
            patch.insert("visibility".into(), json!(visibility));
        }
        // `third` exists in the schema and is disabled in the UI: it cannot be
        // deployed, so offering it here would only produce apps that fail to.
        if let Some(mode) = one_of("auth_mode", &self.auth_mode, &["none", "platform"])? {
            patch.insert("authMode".into(), json!(mode));
        }
        if let Some(audience) = one_of("auth_audience", &self.auth_audience, &["any", "org"])? {
            patch.insert("authAudience".into(), json!(audience));
        }
        if let Some(scope) = one_of("auth_scope", &self.auth_scope, &["all", "paths"])? {
            patch.insert("authScope".into(), json!(scope));
        }
        if let Some(rules) = &self.auth_rules {
            let list = rules
                .as_array()
                .ok_or("auth_rules must be an array of {path, auth, audience?, roles?}")?;
            for rule in list {
                let path = rule.get("path").and_then(Value::as_str).unwrap_or("");
                let auth = rule.get("auth").and_then(Value::as_str).unwrap_or("");
                if !path.starts_with('/') || !matches!(auth, "required" | "public") {
                    return Err(format!(
                        "each auth rule needs a path starting with \"/\" and auth \"required\" or \"public\" (got {rule})"
                    ));
                }
            }
            patch.insert("authRules".into(), rules.clone());
        }
        if patch.is_empty() {
            return Err(
                "update needs at least one of: name, type, visibility, auth_mode, auth_audience, auth_scope, auth_rules"
                    .to_string(),
            );
        }
        Ok(Value::Object(patch))
    }
}

/// Whether an app of this type gets a Postgres schema on deploy. Mirrors
/// `needsDatabase` in `services/fc/src/lib/provisioning/app-deploy.ts`, where
/// anything unrecognised — the legacy stored value included — is a data app.
fn needs_database(app_type: &str) -> bool {
    !matches!(app_type.trim(), "static_web" | "slides" | "imported")
}

/// What an operator needs to hear about the change they just made — the
/// consequences that are not visible on the row itself.
pub fn update_notes(surface: Surface, before: &Value, patch: &Value, after: &Value) -> Vec<String> {
    let mut notes = Vec::new();

    if patch.get("name").is_some() {
        notes.push("The public URL does not change when an app is renamed.".to_string());
    }

    if let Some(next) = patch
        .get("type")
        .and_then(Value::as_str)
        .filter(|next| Some(*next) != row_str(before, "type"))
    {
        let prev = row_str(before, "type").unwrap_or("data_app");
        if needs_database(prev) && !needs_database(next) {
            notes.push(format!(
                "WARNING: from the next deploy on this app has no database — DATABASE_URL disappears from it, and code that uses the database will fail. The data is kept, and comes back if the type is set to data_app again. {} already reports no database. Type was {prev}.",
                match surface {
                    Surface::Mcp => "manage_app_data",
                    Surface::Cli => "Its data API",
                }
            ));
        } else if !needs_database(prev) && needs_database(next) {
            notes.push(
                "The next deploy creates this app's database and gives the app DATABASE_URL. The code is not changed — the app has to use the database itself."
                    .to_string(),
            );
        } else if !needs_database(next) {
            notes.push(
                "static_web, slides and imported deploy the same way: this changes the app's label and the starter template a reseed would write, not the running site."
                    .to_string(),
            );
        }
        if after.get("typePendingRedeploy").and_then(Value::as_bool) == Some(true) {
            notes.push(format!(
                "The running app still has the old type; deploy ({}) for it to take effect.",
                surface.step("manage_app", "deploy")
            ));
        }
    }

    if let Some(visibility) = patch.get("visibility").and_then(Value::as_str) {
        // The two consequences people get backwards, named (design §10):
        // granted members keep seeing a personal app, and the daemon does not —
        // it holds no member grant it could be given.
        notes.push(if visibility == "personal" {
            format!(
                "Only the creator and members granted access ({}) see this app now. The local daemon cannot see it either unless it created it, so agents it runs lose sight of it.",
                surface.step("manage_app_access", "grant")
            )
        } else {
            "Everyone on the team can see this app now.".to_string()
        });
    }

    let auth_changed = ["authMode", "authAudience", "authScope", "authRules"]
        .iter()
        .any(|k| patch.get(*k).is_some());
    if auth_changed {
        notes.push(
            "The login wall is enforced by the gateway, so this applies from the next request — no deploy needed."
                .to_string(),
        );
        if row_str(after, "authMode") == Some("none") {
            notes.push("auth_mode is none: anyone with the URL can open the site.".to_string());
        }
        if after
            .get("authModePendingRedeploy")
            .and_then(Value::as_bool)
            == Some(true)
        {
            notes.push(
                "auth_mode_pending_redeploy only means the app's own login variables update on the next deploy; the wall itself is already in force."
                    .to_string(),
            );
        }
    }
    notes
}

impl AppOps<'_> {
    /// `update` — every setting on the row in one PATCH, the way the control
    /// panel saves a field: name, type, visibility and the login wall.
    ///
    /// Approval of an exposure change, where a surface asks for one, is the
    /// caller's to obtain before this runs: it needs the row and the patch,
    /// and nothing here has changed yet.
    pub async fn update(&self, row: &Value, args: &UpdateArgs) -> Result<Value, String> {
        let patch = args.patch()?;
        let app_id = row_id(row)?;
        let updated = self
            .call(
                Method::Patch,
                &app_path(&app_id, ""),
                Some(&patch),
                None,
                "Updating the app (needs admin on it)",
            )
            .await?;
        self.host.app_changed(&updated);
        Ok(json!({
            "ok": true,
            "action": "update",
            "app": app_settings(&updated),
            "notes": update_notes(self.surface(), row, &patch, &updated),
        }))
    }

    /// `delete` — the app, its function and its login client; the repository
    /// is archived. Cannot be undone from here, so callers name the app
    /// outright ([`crate::AppSelector::is_explicit`]) and confirm first.
    pub async fn delete(&self, row: &Value) -> Result<Value, String> {
        let app_id = row_id(row)?;
        // Tears down the function, its trigger, the artifact and the login
        // client, and archives the repo — well past 30 s on a slow region.
        self.call(
            Method::Delete,
            &app_path(&app_id, ""),
            None,
            Some(Duration::from_secs(120)),
            "Deleting the app (needs admin on it)",
        )
        .await?;
        self.host.app_changed(row);
        Ok(json!({
            "ok": true,
            "action": "delete",
            "app_id": app_id,
            "name": row.get("name"),
            "note": "The deployed site is offline. Its database, stored files and local checkouts were kept; its repository was archived and only an administrator can recover it.",
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{FakeCloud, FakeDaemon, TestHost};

    fn args(f: impl FnOnce(&mut UpdateArgs)) -> UpdateArgs {
        let mut a = UpdateArgs::default();
        f(&mut a);
        a
    }

    #[test]
    fn update_maps_every_setting_to_the_row_s_own_field_names() {
        let patch = UpdateArgs {
            name: Some("记账".into()),
            app_type: Some("data_app".into()),
            visibility: Some("team".into()),
            auth_mode: Some("platform".into()),
            auth_audience: Some("org".into()),
            auth_scope: Some("paths".into()),
            auth_rules: Some(json!([{ "path": "/admin", "auth": "required", "audience": "org" }])),
        }
        .patch()
        .unwrap();
        assert_eq!(
            patch,
            json!({
                "name": "记账",
                "type": "data_app",
                "visibility": "team",
                "authMode": "platform",
                "authAudience": "org",
                "authScope": "paths",
                "authRules": [{ "path": "/admin", "auth": "required", "audience": "org" }],
            })
        );
    }

    #[test]
    fn update_patch_preserves_roles_and_legacy_audience() {
        let rules = json!([
            {"path":"/api/staff/*", "auth":"required", "roles":["custom"]},
            {"path":"/login", "auth":"required", "roles":[]},
            {"path":"/org", "auth":"required", "audience":"org"},
            {"path":"/both", "auth":"required", "roles":[], "audience":"org"}
        ]);
        let patch = args(|a| a.auth_rules = Some(rules.clone()))
            .patch()
            .unwrap();
        assert_eq!(patch["authRules"], rules);
    }

    #[test]
    fn update_refuses_values_the_row_does_not_take() {
        assert!(
            args(|a| a.app_type = Some("fullstack_tanstack_postgres".into()))
                .patch()
                .unwrap_err()
                .contains("static_web")
        );
        // Disabled in the UI because it cannot be deployed.
        assert!(args(|a| a.auth_mode = Some("third".into()))
            .patch()
            .unwrap_err()
            .contains("none, platform"));
        assert!(
            args(|a| a.auth_rules = Some(json!([{ "path": "admin", "auth": "required" }])))
                .patch()
                .unwrap_err()
                .contains("starting with")
        );
        assert!(args(|a| a.auth_rules = Some(json!("/admin")))
            .patch()
            .unwrap_err()
            .contains("array"));
        // Nothing to change is a mistake.
        assert!(UpdateArgs::default()
            .patch()
            .unwrap_err()
            .contains("at least one"));
    }

    #[test]
    fn leaving_data_app_warns_that_the_database_goes_away_on_deploy() {
        let before = json!({ "type": "data_app" });
        let after = json!({ "type": "static_web", "typePendingRedeploy": true });
        let notes = update_notes(
            Surface::Mcp,
            &before,
            &json!({ "type": "static_web" }),
            &after,
        )
        .join("\n");
        assert!(
            notes.contains("WARNING") && notes.contains("DATABASE_URL"),
            "{notes}"
        );
        assert!(notes.contains("data is kept"), "{notes}");
        assert!(notes.contains("manage_app action \"deploy\""), "{notes}");

        // Legacy rows store an unrecognised type, which IS a data app.
        let legacy = json!({ "type": "fullstack_tanstack_postgres" });
        let notes =
            update_notes(Surface::Cli, &legacy, &json!({ "type": "slides" }), &after).join("\n");
        assert!(notes.contains("WARNING"), "{notes}");
        assert!(notes.contains("`amuxd app deploy`"), "{notes}");

        let notes = update_notes(
            Surface::Mcp,
            &json!({ "type": "static_web" }),
            &json!({ "type": "data_app" }),
            &json!({ "type": "data_app" }),
        )
        .join("\n");
        assert!(notes.contains("creates this app's database"), "{notes}");
        assert!(!notes.contains("WARNING"), "{notes}");
    }

    #[test]
    fn a_login_change_says_it_is_live_without_a_deploy() {
        let notes = update_notes(
            Surface::Mcp,
            &json!({ "authMode": "platform" }),
            &json!({ "authMode": "none" }),
            &json!({ "authMode": "none" }),
        )
        .join("\n");
        assert!(notes.contains("no deploy needed"), "{notes}");
        assert!(notes.contains("anyone with the URL"), "{notes}");
    }

    #[tokio::test]
    async fn update_patches_the_row_and_reports_what_changed() {
        let cloud = FakeCloud::default();
        cloud.reply(
            Method::Patch,
            "/v1/apps/a1",
            json!({ "id": "a1", "name": "账本", "visibility": "team" }),
        );
        let daemon = FakeDaemon::default();
        let host = TestHost(Surface::Cli);
        let ops = AppOps::new(&cloud, &daemon, &host);
        let out = ops
            .update(
                &json!({ "id": "a1", "name": "记账" }),
                &args(|a| a.name = Some("账本".into())),
            )
            .await
            .unwrap();
        assert_eq!(out["app"]["name"], "账本");
        assert!(out["notes"][0]
            .as_str()
            .unwrap()
            .contains("URL does not change"));
        assert_eq!(
            cloud.calls_to(Method::Patch, "/v1/apps/a1")[0],
            Some(json!({ "name": "账本" }))
        );
    }

    #[tokio::test]
    async fn delete_says_what_was_kept() {
        let cloud = FakeCloud::default();
        cloud.reply(Method::Delete, "/v1/apps/a1", Value::Null);
        let daemon = FakeDaemon::default();
        let host = TestHost(Surface::Cli);
        let ops = AppOps::new(&cloud, &daemon, &host);
        let out = ops
            .delete(&json!({ "id": "a1", "name": "记账" }))
            .await
            .unwrap();
        assert_eq!(out["app_id"], "a1");
        assert!(out["note"].as_str().unwrap().contains("archived"));
    }
}
