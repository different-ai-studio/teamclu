//! Clone an existing repository into an app's checkout.
//!
//! Used when the user imports an external repo (`gitRemoteUrl` without a deploy
//! key). The Gitea seed-and-push path lives in [`super::app_seed`] +
//! [`super::app_git`] instead.
//!
//! An app created with a repo URL is NOT seeded with a starter template. The
//! repo is the user's own project; writing our `AGENTS.md`/`build.mjs` over the
//! top would rewrite files it may already have.

use crate::process_util::CommandNoWindow;
use std::path::Path;
use std::process::Command;

use crate::sync::app_git;

/// Whether `dir` has anything in it (a missing directory counts as empty).
fn is_empty_dir(dir: &Path) -> bool {
    match std::fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => true,
    }
}

/// Clone `url` into `workdir`.
///
/// Refuses a non-empty `workdir`: cloning into an app that already has files
/// would either fail halfway or bury work the agent has already done, and the
/// caller (app creation) only ever passes a fresh directory.
///
/// Runs non-interactively. A private repo the machine has no credential for
/// must fail with an error the user can read, not park a `git` process on a
/// password prompt no one can see — hence `GIT_TERMINAL_PROMPT=0` and ssh's
/// `BatchMode`.
pub fn clone_app_repo(url: &str, workdir: &Path) -> anyhow::Result<()> {
    let url = app_git::validate_remote_url(url)?;
    if !is_empty_dir(workdir) {
        anyhow::bail!(
            "refusing to clone into a non-empty directory: {}",
            workdir.display()
        );
    }
    if let Some(parent) = workdir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // A directory we created ourselves is fine for `git clone` as long as it is
    // empty, but leaving it behind on failure would make the next attempt look
    // like a half-finished checkout.
    let _ = std::fs::remove_dir(workdir);
    run_clone(&url, workdir, None)
}

/// Clone `url` into `workdir` using a Gitea deploy key (on-demand checkout for
/// collaborators — §5.4). Same empty-dir rule as [`clone_app_repo`].
pub fn clone_app_repo_with_deploy_key(
    url: &str,
    workdir: &Path,
    deploy_key_pem: &str,
    git_user_name: Option<&str>,
    git_user_email: Option<&str>,
) -> anyhow::Result<()> {
    let url = app_git::validate_remote_url(url)?;
    if !is_empty_dir(workdir) {
        anyhow::bail!(
            "refusing to clone into a non-empty directory: {}",
            workdir.display()
        );
    }
    if let Some(parent) = workdir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_dir(workdir);
    let ssh = app_git::SshEnv::from_deploy_key_pem(deploy_key_pem)?;
    run_clone(&url, workdir, Some(&ssh))?;
    // Same identity the seed path writes. Without it a collaborator's checkout
    // has no repo-local `user.name` / `user.email`, so their commits either
    // take that machine's global git config or fail outright with "Please tell
    // me who you are" — and the attribution the deploy-key title provides ends
    // at "which machine pushed", not "who wrote it".
    app_git::set_repo_user_identity(workdir, git_user_name, git_user_email)
}

/// `git clone <remote> <workdir>`, with the environment that keeps it
/// non-interactive. Split out so tests can drive a real clone from a local
/// path — which [`validate_remote_url`] rejects, by design.
fn run_clone(remote: &str, workdir: &Path, ssh: Option<&app_git::SshEnv>) -> anyhow::Result<()> {
    let git = crate::runtime::well_known_bin::resolve_binary("git", None, &[]);
    let mut cmd = Command::new(&git);
    cmd.no_window()
        .arg("clone")
        .arg("--")
        .arg(remote)
        .arg(workdir)
        .env("PATH", crate::runtime::well_known_bin::augmented_path())
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(ssh) = ssh {
        cmd.env("GIT_SSH_COMMAND", ssh.git_ssh_command());
    } else {
        cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
    }
    let out = cmd
        .output()
        .map_err(|e| anyhow::anyhow!("could not run git ({git}): {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // git prints the URL back in most failures; that is the user's own
        // input, and it can carry a token in the userinfo field, so only the
        // last line goes into the error the desktop shows.
        let reason = stderr
            .lines()
            .filter(|l| !l.trim().is_empty())
            .next_back()
            .unwrap_or("git clone failed")
            .trim();
        anyhow::bail!("git clone failed: {reason}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_usual_remote_forms() {
        for url in [
            "https://github.com/owner/repo.git",
            "http://git.internal/owner/repo",
            "ssh://git@github.com/owner/repo.git",
            "git://example.com/repo.git",
            "git@github.com:owner/repo.git",
        ] {
            assert!(app_git::validate_remote_url(url).is_ok(), "rejected {url}");
        }
    }

    #[test]
    fn rejects_transport_helpers_and_option_lookalikes() {
        // `ext::` runs a command; a leading dash is read by git as an option.
        for url in [
            "ext::sh -c 'touch /tmp/pwned'",
            "--upload-pack=touch /tmp/pwned",
            "-u",
            "file:///etc/passwd",
            "/etc/passwd",
            "",
            "   ",
            "https://example.com/repo .git",
        ] {
            assert!(
                app_git::validate_remote_url(url).is_err(),
                "accepted {url:?}"
            );
        }
    }

    #[test]
    fn refuses_to_clone_over_existing_work() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("index.html"), b"the agent wrote this").unwrap();

        let err = clone_app_repo("https://example.com/repo.git", &work).unwrap_err();
        assert!(format!("{err}").contains("non-empty"), "got {err}");
        // and the existing file is still there
        assert!(work.join("index.html").is_file());
    }

    /// A repo with one commit, or None when git is unusable on this machine.
    fn local_origin(root: &Path) -> Option<std::path::PathBuf> {
        let git = crate::runtime::well_known_bin::resolve_binary("git", None, &[]);
        let origin = root.join("origin");
        std::fs::create_dir_all(&origin).ok()?;
        let run = |args: &[&str]| {
            Command::new(&git)
                .args(args)
                .current_dir(&origin)
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        if !run(&["init", "-q"]) {
            return None;
        }
        std::fs::write(origin.join("README.md"), b"hello").ok()?;
        if !run(&["add", "."]) {
            return None;
        }
        let committed = run(&[
            "-c",
            "user.email=t@e.st",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            "init",
        ]);
        committed.then_some(origin)
    }

    #[test]
    fn clones_a_repo_with_its_history() {
        let tmp = tempfile::tempdir().unwrap();
        let Some(origin) = local_origin(tmp.path()) else {
            eprintln!("git not usable here; skipping");
            return;
        };
        let work = tmp.path().join("app");
        run_clone(&origin.to_string_lossy(), &work, None).unwrap();

        assert!(work.join("README.md").is_file());
        assert!(work.join(".git").exists(), "history comes with it");
    }

    #[test]
    fn a_failed_clone_reports_gits_own_reason() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("no-such-repo");
        let work = tmp.path().join("app");
        let err = run_clone(&missing.to_string_lossy(), &work, None)
            .expect_err("cloning a repo that is not there must fail");
        let msg = format!("{err}");
        if msg.contains("could not run git") {
            eprintln!("git not usable here; skipping");
            return;
        }
        assert!(msg.starts_with("git clone failed"), "got {msg}");
        assert!(!work.join(".git").exists());
    }
}
