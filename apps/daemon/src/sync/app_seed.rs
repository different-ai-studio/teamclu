//! Seed an app checkout: write the starter template into the working directory.
//!
//! When a Gitea remote and deploy key are supplied, the checkout is also
//! initialised as a git repo and pushed so the control plane can bind deploys
//! to a commit on the forge. Without git fields, behaviour is unchanged: write
//! the embedded template only.

use std::path::Path;

use crate::sync::app_git;
use crate::sync::app_templates::{write_template, TemplateVars};

/// Remote + deploy key for the Gitea seed-and-push path.
pub struct SeedGitPush<'a> {
    /// The app this checkout belongs to. Baked into the checkout's
    /// `core.sshCommand` so the agent's own pushes can fetch a key later.
    pub app_id: &'a str,
    pub remote_url: &'a str,
    pub deploy_key_pem: &'a str,
    pub git_user_name: Option<&'a str>,
    pub git_user_email: Option<&'a str>,
}

/// Outcome of seeding — `git_commit_sha` is set when a push succeeded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedOutcome {
    pub git_commit_sha: Option<String>,
}

/// Write the template into `workdir`.
///
/// `workdir` is created if missing. Re-seeding an existing checkout restores
/// the starter files over the top, so a wrecked app can be reset; files the
/// template does not know about are left alone.
///
/// When `git_push` is present the repo is initialised (if needed), committed,
/// and pushed to `origin`.
pub fn seed_app_repo(
    workdir: &Path,
    vars: &TemplateVars<'_>,
    git_push: Option<&SeedGitPush<'_>>,
) -> anyhow::Result<SeedOutcome> {
    write_template(workdir, vars)?;
    let Some(push) = git_push else {
        return Ok(SeedOutcome {
            git_commit_sha: None,
        });
    };
    let sha = app_git::init_commit_push(
        workdir,
        push.app_id,
        push.remote_url,
        push.deploy_key_pem,
        "Initial app seed",
        push.git_user_name,
        push.git_user_email,
    )?;
    Ok(SeedOutcome {
        git_commit_sha: Some(sha),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::app_templates::AppType;

    fn vars<'a>(app_type: AppType) -> TemplateVars<'a> {
        TemplateVars {
            app_id: "app-1",
            app_name: "Demo",
            app_type,
        }
    }

    #[test]
    fn seeds_the_starter_files() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::StaticWeb), None).unwrap();

        assert!(work.join("AGENTS.md").is_file());
        assert!(work.join("public/index.html").is_file());
    }

    #[test]
    fn reseeding_restores_a_wrecked_file() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::StaticWeb), None).unwrap();
        std::fs::write(work.join("public/index.html"), "wrecked").unwrap();

        seed_app_repo(&work, &vars(AppType::StaticWeb), None).unwrap();
        let restored = std::fs::read_to_string(work.join("public/index.html")).unwrap();
        assert!(restored.contains("Demo"), "starter content is back");
    }

    #[test]
    fn work_the_template_does_not_know_about_survives_a_reseed() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::StaticWeb), None).unwrap();
        std::fs::write(work.join("public/about.html"), "<h1>agent wrote this</h1>").unwrap();

        seed_app_repo(&work, &vars(AppType::StaticWeb), None).unwrap();
        assert!(work.join("public/about.html").is_file());
    }

    #[test]
    fn reseeding_an_untouched_checkout_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::Slides), None).unwrap();
        seed_app_repo(&work, &vars(AppType::Slides), None).unwrap();
    }

    #[test]
    fn seed_without_git_push_returns_no_sha() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        let out = seed_app_repo(&work, &vars(AppType::DataApp), None).unwrap();
        assert_eq!(out.git_commit_sha, None);
    }
}
