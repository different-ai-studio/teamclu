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

/// What a directory adopted as an app repo gets ignored by default.
///
/// Only written when the directory has no `.gitignore` of its own, and only on
/// the path that is about to commit the whole tree. The user picked a folder to
/// build an app in, not to publish their dependency tree or their secrets to a
/// forge — and a first commit is not something they can take back.
const ADOPT_GITIGNORE: &str = "\
node_modules/
dist/
.output/
.nitro/
.vinxi/
.DS_Store
.env
.env.*
";

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

/// Publish a directory the user already had as this app's repo.
///
/// The other half of "pick a local folder": no starter template is written, so
/// whatever is in the directory is what the app is. Three shapes, and the
/// difference between them is what a user would expect us NOT to touch:
///
/// - **Not a repo** — `git init`, a default `.gitignore` if there is none, then
///   commit and push. There is no history to respect and nothing to lose.
/// - **A repo with commits** — set `origin` and push the history that is
///   already there. Uncommitted work stays uncommitted: adopting a folder is
///   not a licence to commit whatever the user had open in it.
/// - **A repo with no commits** — treated as the first case. An unborn HEAD is
///   nothing to push.
pub fn adopt_app_repo(workdir: &Path, push: &SeedGitPush<'_>) -> anyhow::Result<SeedOutcome> {
    std::fs::create_dir_all(workdir)?;
    let commit_worktree = adopt_commits_worktree(workdir);
    if commit_worktree {
        write_default_gitignore(workdir)?;
    }
    let sha = app_git::adopt_commit_push(
        workdir,
        push.app_id,
        push.remote_url,
        push.deploy_key_pem,
        "Adopt existing directory as app",
        push.git_user_name,
        push.git_user_email,
        commit_worktree,
    )?;
    Ok(SeedOutcome {
        git_commit_sha: Some(sha),
    })
}

/// Whether adopting this directory should commit its working tree.
///
/// Only when there is no history to publish instead. A repo with commits gets
/// its history pushed and its uncommitted work left alone; a plain folder (or a
/// `git init` nobody ever committed in) has nothing to push, so its contents
/// are the first commit.
fn adopt_commits_worktree(workdir: &Path) -> bool {
    !app_git::has_commits(workdir)
}

/// Never overwrites: a directory that already declares what it ignores has
/// already answered this question.
fn write_default_gitignore(workdir: &Path) -> anyhow::Result<()> {
    let path = workdir.join(".gitignore");
    if path.exists() {
        return Ok(());
    }
    std::fs::write(&path, ADOPT_GITIGNORE)
        .map_err(|e| anyhow::anyhow!("could not write .gitignore: {e}"))
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
    fn a_plain_folder_is_committed_whole_and_a_repo_is_not() {
        // The one decision adopting makes about the user's files. A folder they
        // picked has nothing to publish but its contents; a repo they already
        // work in has history, and committing whatever they had open would be a
        // surprise nobody asked for.
        let tmp = tempfile::tempdir().unwrap();

        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(
            adopt_commits_worktree(&plain),
            "a plain folder is the commit"
        );

        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        if app_git::init_if_needed(&repo).is_err() {
            eprintln!("git not usable; skipping");
            return;
        }
        // `git init` with nothing committed: an unborn HEAD is not history.
        assert!(adopt_commits_worktree(&repo), "no commits is not a history");

        std::fs::write(repo.join("README.md"), b"theirs").unwrap();
        app_git::set_repo_user_identity(&repo, None, None).unwrap();
        app_git::add_all(&repo).unwrap();
        app_git::commit_if_needed(&repo, "their own commit").unwrap();
        assert!(
            !adopt_commits_worktree(&repo),
            "a repo with commits publishes its history, not the worktree"
        );
    }

    #[test]
    fn a_folder_with_no_gitignore_gets_one_before_its_first_commit() {
        // That first commit goes to a forge and cannot be taken back, and the
        // folder the user picked is as likely to hold node_modules and a .env
        // as it is to hold the app.
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("mine");
        std::fs::create_dir_all(&work).unwrap();

        write_default_gitignore(&work).unwrap();
        let written = std::fs::read_to_string(work.join(".gitignore")).unwrap();
        for entry in ["node_modules/", ".env", "dist/", ".output/"] {
            assert!(written.contains(entry), "missing {entry} in {written}");
        }
    }

    #[test]
    fn a_gitignore_the_folder_already_had_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("mine");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join(".gitignore"), "theirs/\n").unwrap();

        write_default_gitignore(&work).unwrap();
        assert_eq!(
            std::fs::read_to_string(work.join(".gitignore")).unwrap(),
            "theirs/\n"
        );
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
