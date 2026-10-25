//! Which app: listing a team's apps, and turning an id, a name or a directory
//! into exactly one app row.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::row::{app_brief, app_path, items_of, row_str};
use crate::AppOps;

/// How a call names its app. With neither `app_id` nor `app_name`, the app is
/// the one whose checkout `workspace_path` is, or is inside.
#[derive(Debug, Clone, Default)]
pub struct AppSelector {
    pub app_id: Option<String>,
    pub app_name: Option<String>,
    /// The directory the caller is working in: an MCP sidecar's
    /// `--workspace`, a CLI's current directory.
    pub workspace_path: Option<String>,
}

impl AppSelector {
    /// Whether the app is named outright, rather than inferred from a
    /// directory. Irreversible actions require it.
    pub fn is_explicit(&self) -> bool {
        self.app_id.is_some() || self.app_name.is_some()
    }
}

/// Resolve symlinks so two spellings of one directory compare equal.
///
/// macOS reaches the same tree as `/tmp/x` and `/private/tmp/x`, and a
/// workspace under a symlinked mount is routinely handed to the agent by one
/// spelling while the daemon reports the other. A path that cannot be
/// canonicalized (it no longer exists) is left as it was, which still matches
/// an identical string.
pub fn canonical_path(path: &str) -> PathBuf {
    let raw = PathBuf::from(path);
    std::fs::canonicalize(&raw).unwrap_or(raw)
}

/// The app whose checkout is, or contains, `workspace`.
///
/// Component-wise so a sibling directory cannot match on a shared prefix
/// (`…/apps/foo-2` is not inside `…/apps/foo`), and longest match first so a
/// checkout nested inside another checkout resolves to the inner one.
pub fn app_owning_path(workspace: &Path, apps: &[(String, PathBuf)]) -> Option<String> {
    apps.iter()
        .filter(|(_, dir)| workspace.starts_with(dir))
        .max_by_key(|(_, dir)| dir.components().count())
        .map(|(id, _)| id.clone())
}

impl AppOps<'_> {
    pub async fn list_team_apps(&self, team_id: &str) -> Result<Vec<Value>, String> {
        let listing = self
            .get(
                &format!("/v1/apps?teamId={}&limit=100", urlencoding::encode(team_id)),
                "Listing this team's apps",
            )
            .await?;
        Ok(items_of(&listing))
    }

    /// Every app this machine holds a checkout for, as `(app_id, workdir)`.
    ///
    /// Best-effort: a daemon that is down means "no local checkouts", which
    /// leaves the caller asking for an explicit app rather than failing on an
    /// unrelated error.
    pub async fn local_app_workdirs(&self, team_id: &str) -> Vec<(String, String)> {
        self.daemon.local_apps(team_id).await.unwrap_or_default()
    }

    /// `list` — the team's apps, each with this machine's checkout when it
    /// has one. One daemon call for every app, not one per app: the path is
    /// how an agent tells the app it is working in from the rest.
    pub async fn list(&self, team_id: &str) -> Result<Value, String> {
        let apps = self.list_team_apps(team_id).await?;
        let local = self.local_app_workdirs(team_id).await;
        let briefs: Vec<Value> = apps
            .iter()
            .map(|row| {
                let mut brief = app_brief(row);
                let id = row_str(row, "id").unwrap_or_default();
                if let Some((_, dir)) = local.iter().find(|(app_id, _)| app_id == id) {
                    brief["workdir"] = json!(dir);
                }
                brief
            })
            .collect();
        Ok(json!({
            "action": "list",
            "team_id": team_id,
            "apps": briefs,
        }))
    }

    /// Resolve a selector to exactly one app row.
    ///
    /// A name is accepted only when it names one app in the team. Deploying
    /// publishes to the internet, so a fuzzy match is not worth the effect:
    /// zero or several matches come back as the candidate list with nothing
    /// done.
    ///
    /// With neither id nor name, the app is the one whose checkout the caller
    /// is working in. That is not a guess in the way a fuzzy name is — the
    /// directory either is that app's checkout or it is not — and it is the
    /// common case: an agent editing an app has no way to learn its own id.
    ///
    /// `team_id` is unused when the selector carries an id.
    pub async fn resolve_app(
        &self,
        team_id: &str,
        selector: &AppSelector,
    ) -> Result<Value, String> {
        if let Some(id) = &selector.app_id {
            return self.get(&app_path(id, ""), "Reading the app").await;
        }
        if team_id.is_empty() {
            return Err(
                "No current team to look the app up in — pass an app id instead".to_string(),
            );
        }
        let Some(name) = &selector.app_name else {
            let id = self.app_id_from_workspace(team_id, selector).await?;
            return self.get(&app_path(&id, ""), "Reading the app").await;
        };
        let apps = self.list_team_apps(team_id).await?;
        let wanted = name.to_lowercase();
        let matches: Vec<&Value> = apps
            .iter()
            .filter(|a| {
                ["name", "slug"].iter().any(|k| {
                    a.get(*k)
                        .and_then(Value::as_str)
                        .map(|n| n.trim().to_lowercase() == wanted)
                        .unwrap_or(false)
                })
            })
            .collect();
        match matches.len() {
            1 => Ok(matches[0].clone()),
            0 => Err(format!(
                "No app named {:?} in this team. Apps: {}",
                name,
                Value::Array(apps.iter().map(app_brief).collect())
            )),
            n => Err(format!(
                "{:?} matches {} apps — pass the app id instead. Matches: {}",
                name,
                n,
                Value::Array(matches.iter().map(|a| app_brief(a)).collect())
            )),
        }
    }

    /// The app the caller is inside, for a call that named none.
    ///
    /// Both failure modes say what to do next rather than what went wrong: a
    /// caller that lands here has already decided it wants "this app", and
    /// the useful reply is the way to name one.
    async fn app_id_from_workspace(
        &self,
        team_id: &str,
        selector: &AppSelector,
    ) -> Result<String, String> {
        let ask = format!(
            "name the app by id or name, or run {} to see this team's apps",
            self.surface().step("manage_app", "list")
        );
        let workspace = selector.workspace_path.as_deref().ok_or_else(|| {
            format!("No app named, and no working directory to resolve one from — {ask}")
        })?;
        let apps: Vec<(String, PathBuf)> = self
            .local_app_workdirs(team_id)
            .await
            .into_iter()
            .map(|(id, dir)| (id, canonical_path(&dir)))
            .collect();
        app_owning_path(&canonical_path(workspace), &apps).ok_or_else(|| {
            format!("{workspace} is not the checkout of any app in this team — {ask}")
        })
    }

    /// Where this machine keeps the app's checkout, and this machine's name.
    ///
    /// The daemon answers for an app it has never seeded too — the path is
    /// derived, not looked up — so this is where the checkout goes, not proof
    /// that one exists. Best-effort: a daemon that is down means "not here".
    pub async fn app_workdir_on_this_machine(
        &self,
        row: &Value,
    ) -> Option<(String, Option<String>)> {
        let app_id = row_str(row, "id")?;
        let team_id = row_str(row, "teamId").unwrap_or("");
        let out = self.daemon.workdir(app_id, team_id).await.ok()?;
        let workdir = row_str(&out, "workdir")?.to_string();
        Some((workdir, row_str(&out, "deviceName").map(str::to_string)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{FakeCloud, FakeDaemon, TestHost};
    use crate::{Method, Surface};

    fn checkouts(pairs: &[(&str, &str)]) -> Vec<(String, PathBuf)> {
        pairs
            .iter()
            .map(|(id, dir)| (id.to_string(), PathBuf::from(dir)))
            .collect()
    }

    #[test]
    fn the_workspace_resolves_to_the_app_whose_checkout_it_is() {
        let apps = checkouts(&[("app-1", "/home/u/apps/notes"), ("app-2", "/work/py")]);
        assert_eq!(
            app_owning_path(Path::new("/work/py"), &apps).as_deref(),
            Some("app-2")
        );
        assert_eq!(
            app_owning_path(Path::new("/work/py/backend/src"), &apps).as_deref(),
            Some("app-2")
        );
    }

    #[test]
    fn a_shared_prefix_is_not_a_match() {
        let apps = checkouts(&[("app-2", "/work/py")]);
        assert!(app_owning_path(Path::new("/work/py-2"), &apps).is_none());
        assert!(app_owning_path(Path::new("/work"), &apps).is_none());
    }

    #[test]
    fn a_checkout_inside_a_checkout_resolves_to_the_inner_one() {
        let apps = checkouts(&[("outer", "/work"), ("inner", "/work/apps/site")]);
        assert_eq!(
            app_owning_path(Path::new("/work/apps/site/public"), &apps).as_deref(),
            Some("inner")
        );
    }

    #[tokio::test]
    async fn a_name_must_match_exactly_one_app() {
        let cloud = FakeCloud::default();
        cloud.reply(
            Method::Get,
            "/v1/apps?teamId=t1&limit=100",
            json!({ "items": [
                { "id": "a1", "name": "Notes", "slug": "notes" },
                { "id": "a2", "name": "notes", "slug": "notes-2" },
                { "id": "a3", "name": "Ledger", "slug": "ledger" },
            ]}),
        );
        let daemon = FakeDaemon::default();
        let host = TestHost(Surface::Cli);
        let ops = AppOps::new(&cloud, &daemon, &host);

        let one = AppSelector {
            app_name: Some("ledger".into()),
            ..Default::default()
        };
        assert_eq!(ops.resolve_app("t1", &one).await.unwrap()["id"], "a3");

        let two = AppSelector {
            app_name: Some("Notes".into()),
            ..Default::default()
        };
        let err = ops.resolve_app("t1", &two).await.unwrap_err();
        assert!(err.contains("matches 2 apps"), "{err}");

        let none = AppSelector {
            app_name: Some("blog".into()),
            ..Default::default()
        };
        assert!(ops
            .resolve_app("t1", &none)
            .await
            .unwrap_err()
            .contains("No app named"));
    }

    #[tokio::test]
    async fn no_name_and_no_checkout_says_how_to_name_one_on_this_surface() {
        let cloud = FakeCloud::default();
        let daemon = FakeDaemon::default();
        let host = TestHost(Surface::Cli);
        let ops = AppOps::new(&cloud, &daemon, &host);
        let err = ops
            .resolve_app(
                "t1",
                &AppSelector {
                    workspace_path: Some("/nowhere/at/all".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(err.contains("`amuxd app list`"), "{err}");
    }
}
