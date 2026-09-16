//! Git helpers for app seed (init / push) and build (fetch / checkout).
//!
//! Team-share managed-git is gone; this module is scoped to per-app Gitea
//! checkouts only. Deploy keys are written to a temp file with restrictive
//! permissions and passed via `GIT_SSH_COMMAND`.

use crate::process_util::CommandNoWindow;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

/// English messages the HTTP layer maps to user-facing copy.
/// No longer raised by a deploy — [`publish_pending_work`] publishes that state
/// instead of refusing it. Kept because the desktop still maps this text: a
/// current client talking to an older daemon gets it, and the mapping is the
/// only thing that turns it into something a user can act on.
pub const ERR_DIRTY: &str = "uncommitted or unpushed changes; commit and push first";
/// Deploy committed the workdir but could not publish it: `origin` has commits
/// this checkout does not. Resolving that is a merge, and a deploy must not
/// guess at one.
pub const ERR_PUSH_REJECTED: &str =
    "origin has commits this checkout does not; pull and resolve them, then deploy again";
pub const ERR_SHA_NOT_ON_REMOTE: &str = "git commit not found on remote";
pub const ERR_INVALID_SHA: &str = "gitCommitSha must be a 7–40 character hex object id";

const GIT_USER_NAME: &str = "TeamClu";
const GIT_USER_EMAIL: &str = "apps@teamclu.local";

/// Remote URL forms we hand to git.
///
/// Same allowlist as [`super::app_clone`] — URLs arrive from the desktop over
/// loopback and git's remote-helper syntax can turn some inputs into command
/// execution.
pub fn validate_remote_url(raw: &str) -> anyhow::Result<String> {
    let url = raw.trim();
    if url.is_empty() {
        anyhow::bail!("git repo URL must not be empty");
    }
    if url.starts_with('-') {
        anyhow::bail!("git repo URL must not start with '-'");
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        anyhow::bail!("git repo URL must not contain whitespace or control characters");
    }
    if url.contains("::") && !url.contains("://") {
        anyhow::bail!("unsupported git transport in URL");
    }

    let scheme_ok = ["https://", "http://", "ssh://", "git://"]
        .iter()
        .any(|s| url.starts_with(s));
    let scp_like = match (url.find('@'), url.find(':')) {
        (Some(at), Some(colon)) => at < colon && !url.contains("://"),
        _ => false,
    };
    if !scheme_ok && !scp_like {
        anyhow::bail!("git repo URL must be an http(s), ssh or git:// address");
    }
    Ok(url.to_string())
}

/// Validate a client-supplied object id before passing it to git.
pub fn validate_commit_sha(raw: &str) -> anyhow::Result<String> {
    let sha = raw.trim();
    if !(7..=40).contains(&sha.len()) || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        anyhow::bail!("{ERR_INVALID_SHA}");
    }
    Ok(sha.to_string())
}

/// Branch names we are willing to hand to `git checkout -B`.
///
/// These come from git's own remote-tracking output rather than from a client,
/// but they still land in an argv position where a leading `-` is a flag.
fn validate_branch_name(raw: &str) -> anyhow::Result<String> {
    let branch = raw.trim();
    if branch.is_empty() || branch.starts_with('-') || branch.contains("..") {
        anyhow::bail!("invalid git branch name");
    }
    let ok = branch
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
    if !ok {
        anyhow::bail!("invalid git branch name");
    }
    Ok(branch.to_string())
}

fn git_bin() -> PathBuf {
    PathBuf::from(crate::runtime::well_known_bin::resolve_binary(
        "git",
        None,
        &[],
    ))
}

fn base_command(cwd: &Path, ssh: Option<&SshEnv>) -> Command {
    let mut cmd = Command::new(git_bin());
    cmd.no_window()
        .current_dir(cwd)
        .env("PATH", crate::runtime::well_known_bin::augmented_path())
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(ssh) = ssh {
        cmd.env("GIT_SSH_COMMAND", ssh.git_ssh_command());
    } else {
        cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
    }
    cmd
}

fn run_git(cwd: &Path, ssh: Option<&SshEnv>, args: &[&str]) -> anyhow::Result<Output> {
    output_of(base_command(cwd, ssh), args)
}

fn output_of(mut cmd: Command, args: &[&str]) -> anyhow::Result<Output> {
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| anyhow::anyhow!("could not run git: {e}"))
}

fn ensure_success(out: &Output, context: &str) -> anyhow::Result<()> {
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let reason = git_failure_reason(&stderr).unwrap_or(context);
    anyhow::bail!("{context}: {reason}");
}

/// What git prints after every failed ssh transport, whatever went wrong.
const GIT_SSH_ADVICE: [&str; 2] = [
    "Please make sure you have the correct access rights",
    "and the repository exists.",
];
const GIT_SSH_FATAL: &str = "fatal: Could not read from remote repository.";

/// The one line of a failed git command's stderr to show the user.
///
/// The last line, except that git's closing ssh advice is never the reason.
/// Taking it literally reported "and the repository exists." and dropped the
/// line ssh wrote above it — "Permission denied (publickey)", "Host key
/// verification failed", "Connection refused". Only one line either way: git
/// echoes the remote URL in other lines, and that can carry a token.
pub(crate) fn git_failure_reason(stderr: &str) -> Option<&str> {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !GIT_SSH_ADVICE.contains(l) && !l.starts_with("Cloning into "))
        .collect();
    lines
        .iter()
        .rfind(|l| **l != GIT_SSH_FATAL)
        .or(lines.last())
        .copied()
}

/// Whether `out` failed because another `git` process held `.git/config.lock`
/// at the same moment, rather than because the write itself was invalid.
fn is_config_lock_contention(out: &Output) -> bool {
    !out.status.success()
        && String::from_utf8_lossy(&out.stderr).contains("could not lock config file")
}

const CONFIG_LOCK_RETRIES: u32 = 5;
const CONFIG_LOCK_RETRY_DELAY: Duration = Duration::from_millis(150);

/// A `.git/config` write, retried while another git process holds the config lock.
/// `LC_ALL=C` keeps that lock message matchable on a translated git.
fn run_git_config_write(cwd: &Path, ssh: Option<&SshEnv>, args: &[&str]) -> anyhow::Result<Output> {
    retry_on_config_lock(
        || {
            let mut cmd = base_command(cwd, ssh);
            cmd.env("LC_ALL", "C");
            output_of(cmd, args)
        },
        CONFIG_LOCK_RETRY_DELAY,
    )
}

fn retry_on_config_lock(
    mut attempt: impl FnMut() -> anyhow::Result<Output>,
    delay: Duration,
) -> anyhow::Result<Output> {
    let mut out = attempt()?;
    for _ in 1..CONFIG_LOCK_RETRIES {
        if !is_config_lock_contention(&out) {
            break;
        }
        std::thread::sleep(delay);
        out = attempt()?;
    }
    Ok(out)
}

/// SSH environment for a deploy-key-backed remote.
pub struct SshEnv {
    key_path: PathBuf,
    _guard: tempfile::NamedTempFile,
}

impl SshEnv {
    /// Write `pem` to a temp file with mode 0600 and return an env wrapper.
    pub fn from_deploy_key_pem(pem: &str) -> anyhow::Result<Self> {
        let pem = pem.trim();
        if pem.is_empty() {
            anyhow::bail!("deploy key PEM must not be empty");
        }
        let mut file = tempfile::Builder::new()
            .prefix("amuxd-deploy-key-")
            .tempfile()
            .map_err(|e| anyhow::anyhow!("could not create deploy key temp file: {e}"))?;
        // The trailing newline is not cosmetic: OpenSSH's key parser rejects a
        // key file whose final armour line is not terminated, and `pem.trim()`
        // above has just removed it.
        file.write_all(pem.as_bytes())
            .and_then(|()| file.write_all(b"\n"))
            .map_err(|e| anyhow::anyhow!("could not write deploy key: {e}"))?;
        file.flush()
            .map_err(|e| anyhow::anyhow!("could not flush deploy key: {e}"))?;
        set_restrictive_permissions(file.path())?;
        Ok(Self {
            key_path: file.path().to_path_buf(),
            _guard: file,
        })
    }

    /// `IdentitiesOnly=yes` is load-bearing, not belt-and-braces.
    ///
    /// `-i` only *adds* a key to the candidates: OpenSSH still offers every
    /// identity in the agent and the default `~/.ssh/id_*` files, and Gitea
    /// closes the connection after `MaxAuthTries` (6). On a developer machine
    /// with a few keys loaded, the JIT deploy key was never reached — the fetch
    /// failed with "Too many authentication failures" and read as a bad
    /// credential. `cli/git_ssh.rs` has always passed it; this path had not.
    pub fn git_ssh_command(&self) -> String {
        format!(
            "ssh -i {} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
            shell_quote(&self.key_path.to_string_lossy())
        )
    }
}

#[cfg(unix)]
fn set_restrictive_permissions(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| anyhow::anyhow!("could not chmod deploy key: {e}"))
}

#[cfg(not(unix))]
fn set_restrictive_permissions(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

/// One word for the POSIX shell git runs `GIT_SSH_COMMAND`, `core.sshCommand`
/// and a `!` credential helper through — on Windows too, where that shell is
/// Git for Windows' bash.
///
/// Anything beyond plain path characters goes in single quotes, the one form
/// where nothing but the closing quote is special. A bare word loses its
/// backslashes: a deploy key at `C:\Users\me\AppData\Local\Temp\…` reached ssh
/// as `C:UsersmeAppDataLocalTemp…`, ssh loaded no key and offered none, and
/// every clone on Windows failed as "Permission denied (publickey)". Double
/// quotes would not do either — `$` and backticks still expand inside them.
fn shell_quote(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c));
    if plain {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// Whether `dir` is already a git work tree.
pub fn is_git_repo(dir: &Path) -> bool {
    run_git(dir, None, &["rev-parse", "--git-dir"])
        .ok()
        .is_some_and(|o| o.status.success())
}

/// `origin`'s URL, when the checkout has one.
///
/// Used when binding an app to a repo the user already had: the app records
/// where its code came from, so a teammate opening it later is told the
/// address rather than left with a name and nothing else.
pub fn origin_url(dir: &Path) -> Option<String> {
    let out = run_git(dir, None, &["remote", "get-url", "origin"]).ok()?;
    if !out.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!url.is_empty()).then_some(url)
}

/// `git init` when `dir` is not yet a repo.
pub fn init_if_needed(dir: &Path) -> anyhow::Result<()> {
    if is_git_repo(dir) {
        return Ok(());
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::create_dir_all(dir)?;
    let out = run_git(dir, None, &["init", "-q"])?;
    ensure_success(&out, "git init")
}

fn origin_exists(dir: &Path, ssh: Option<&SshEnv>) -> bool {
    run_git(dir, ssh, &["remote", "get-url", "origin"])
        .ok()
        .is_some_and(|o| o.status.success())
}

/// Set `origin` to `url`, replacing any existing origin remote.
pub fn set_remote_origin(dir: &Path, url: &str, ssh: Option<&SshEnv>) -> anyhow::Result<()> {
    let url = validate_remote_url(url)?;
    if !origin_exists(dir, ssh) {
        let out = run_git_config_write(dir, ssh, &["remote", "add", "origin", &url])?;
        if out.status.success() {
            return Ok(());
        }
        // `remote add` writes url and fetch separately: a concurrent writer, or our own
        // half-landed attempt, can leave origin in place while this call reports failure.
        if !origin_exists(dir, ssh) {
            return ensure_success(&out, "git remote add");
        }
    }
    let out = run_git_config_write(dir, ssh, &["remote", "set-url", "origin", &url])?;
    ensure_success(&out, "git remote set-url")?;
    ensure_origin_fetch_refspec(dir)
}

fn ensure_origin_fetch_refspec(dir: &Path) -> anyhow::Result<()> {
    let present = run_git(dir, None, &["config", "--get", "remote.origin.fetch"])
        .ok()
        .is_some_and(|o| o.status.success());
    if present {
        return Ok(());
    }
    let out = run_git_config_write(
        dir,
        None,
        &[
            "config",
            "remote.origin.fetch",
            "+refs/heads/*:refs/remotes/origin/*",
        ],
    )?;
    ensure_success(&out, "git config remote.origin.fetch")
}

/// Stage all changes (`git add -A`).
pub fn add_all(dir: &Path) -> anyhow::Result<()> {
    let out = run_git(dir, None, &["add", "-A"])?;
    ensure_success(&out, "git add")
}

/// Write repo-local `user.name` / `user.email` into `.git/config`.
///
/// Empty or missing values fall back to [`GIT_USER_NAME`] / [`GIT_USER_EMAIL`]
/// so seed commits still work when the desktop omits identity fields.
pub fn set_repo_user_identity(
    dir: &Path,
    name: Option<&str>,
    email: Option<&str>,
) -> anyhow::Result<()> {
    let name = name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(GIT_USER_NAME);
    let email = email
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(GIT_USER_EMAIL);
    let out = run_git_config_write(dir, None, &["config", "user.name", name])?;
    ensure_success(&out, "git config user.name")?;
    let out = run_git_config_write(dir, None, &["config", "user.email", email])?;
    ensure_success(&out, "git config user.email")?;
    Ok(())
}

/// Point the checkout's git at the `amuxd git-ssh` shim, so an agent's own
/// `git push` gets a just-in-time deploy key instead of falling through to the
/// machine's ssh identity — which Gitea has never been shown and never accepts.
///
/// Repo-local (`.git/config`), so it is scoped to exactly this checkout and
/// touches no other repo the agent works in. `current_exe` is re-resolved on
/// every seed, clone and deploy fetch, which is what keeps the path honest
/// across an app upgrade that moves the binary.
///
/// Best-effort: a checkout that cannot be pointed at the shim still seeds and
/// clones fine (the daemon does those pushes itself with a key it already
/// holds). Only the agent's later `git push` is affected, and it reports its
/// own reason.
pub fn set_repo_ssh_command(dir: &Path, app_id: &str) -> anyhow::Result<()> {
    let exe = std::env::current_exe()
        .map_err(|e| anyhow::anyhow!("could not resolve the amuxd binary: {e}"))?;
    // The trailing `--` is not decoration: git appends its own ssh arguments to
    // this string, and they lead with flags (`-o SendEnv=…`, `-p`). Without the
    // separator those flags are offered to our own argument parser first.
    let command = format!(
        "{} git-ssh --app {} --",
        shell_quote(&exe.to_string_lossy()),
        shell_quote(app_id)
    );
    let out = run_git_config_write(dir, None, &["config", "core.sshCommand", &command])?;
    ensure_success(&out, "git config core.sshCommand")?;

    // Git guesses how to call `core.sshCommand` from its basename, and an
    // unrecognised one is assumed to be the `simple` variant — which it
    // believes cannot take `-p`. The app remotes are on port 2222, so without
    // this every push died before the shim was even executed, with
    // "ssh variant 'simple' does not support setting port".
    let out = run_git_config_write(dir, None, &["config", "ssh.variant", "ssh"])?;
    ensure_success(&out, "git config ssh.variant")
}

/// `authKind` the cloud gives a token stored for an imported http(s) repo.
pub const HTTPS_TOKEN_AUTH_KIND: &str = "https_token";

/// Username sent when none was given. The cloud applies the same default, so a
/// token typed on the create form and the stored copy authenticate identically.
pub const DEFAULT_GIT_HTTPS_USERNAME: &str = "x-access-token";

/// Environment the daemon's own clone hands `amuxd git-credential`: the
/// credential the desktop passed in, and the repo it belongs to.
pub const ENV_GIT_HTTPS_REMOTE: &str = "AMUXD_GIT_HTTPS_REMOTE";
pub const ENV_GIT_HTTPS_USERNAME: &str = "AMUXD_GIT_HTTPS_USERNAME";
pub const ENV_GIT_HTTPS_TOKEN: &str = "AMUXD_GIT_HTTPS_TOKEN";

/// A username and token for an http(s) remote, as handed to one clone.
#[derive(Clone)]
pub struct HttpsCredential {
    pub username: String,
    pub token: String,
}

impl std::fmt::Debug for HttpsCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpsCredential")
            .field("username", &self.username)
            .finish_non_exhaustive()
    }
}

impl HttpsCredential {
    /// Blank username → [`DEFAULT_GIT_HTTPS_USERNAME`]. Refuses what git's
    /// line-based credential protocol cannot carry.
    pub fn new(username: Option<&str>, token: &str) -> anyhow::Result<Self> {
        let token = token.trim();
        if token.is_empty() {
            anyhow::bail!("git credential token must not be empty");
        }
        let username = username
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .unwrap_or(DEFAULT_GIT_HTTPS_USERNAME);
        if [username, token]
            .iter()
            .any(|v| v.contains(['\n', '\r', '\0']))
        {
            anyhow::bail!("git credential must not contain newlines or NUL");
        }
        Ok(Self {
            username: username.to_string(),
            token: token.to_string(),
        })
    }
}

/// `(scheme, host[:port])` of an http(s) remote — lowercased, without userinfo —
/// which are the two attributes git's credential protocol names a request by.
/// None for any other kind of address.
pub fn http_remote_authority(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if host.is_empty() {
        return None;
    }
    Some((scheme, host.to_ascii_lowercase()))
}

/// Whether `url` is reached over http(s), where a credential helper applies.
pub fn is_http_remote(url: &str) -> bool {
    http_remote_authority(url).is_some()
}

/// What marks a `credential.helper` entry as ours.
const CREDENTIAL_HELPER_MARKER: &str = " git-credential --app ";

/// The `credential.helper` value that runs `amuxd git-credential` for this app.
///
/// The leading `!` makes git run it through the shell as written. Without it
/// git decides by the first character, and a quoted path — which any amuxd
/// under "Application Support" is — does not look absolute to git, so it
/// prepends `git credential-` and runs a command that does not exist.
pub fn credential_helper_command(app_id: &str) -> anyhow::Result<String> {
    let exe = std::env::current_exe()
        .map_err(|e| anyhow::anyhow!("could not resolve the amuxd binary: {e}"))?;
    Ok(format!(
        "!{}{}{}",
        shell_quote(&exe.to_string_lossy()),
        CREDENTIAL_HELPER_MARKER,
        shell_quote(app_id)
    ))
}

/// Point the checkout's git at `amuxd git-credential`, so an agent's own
/// `git pull` / `git push` over http(s) gets the app's stored token.
///
/// `exclusive` writes an empty `credential.helper` first, which git reads as
/// "forget every helper configured before this one" — for this repo only. Set
/// when the app has a stored token: otherwise a stale keychain entry for the
/// same host is tried first, fails, and git gives up before it reaches ours.
/// Left off when there is none, so a repo that authenticates through the
/// machine's own helper keeps doing so and ours is asked last.
///
/// Repo-local, and best-effort for the reasons [`set_repo_ssh_command`] gives.
pub fn set_repo_credential_helper(dir: &Path, app_id: &str, exclusive: bool) -> anyhow::Result<()> {
    let helper = credential_helper_command(app_id)?;
    let out = run_git_config_write(
        dir,
        None,
        &["config", "--local", "--unset-all", "credential.helper"],
    )?;
    // Exit 5 is "there was nothing to unset".
    if out.status.code() != Some(5) {
        ensure_success(&out, "git config --unset-all credential.helper")?;
    }
    if exclusive {
        let out = run_git_config_write(
            dir,
            None,
            &["config", "--local", "--add", "credential.helper", ""],
        )?;
        ensure_success(&out, "git config credential.helper")?;
    }
    let out = run_git_config_write(
        dir,
        None,
        &["config", "--local", "--add", "credential.helper", &helper],
    )?;
    ensure_success(&out, "git config credential.helper")
}

/// Re-point an existing `amuxd git-credential` entry at the current binary,
/// keeping whether it was exclusive. A checkout without one is left alone.
///
/// Returns whether anything was rewritten.
pub fn refresh_repo_credential_helper(dir: &Path, app_id: &str) -> anyhow::Result<bool> {
    let out = run_git(
        dir,
        None,
        &["config", "--local", "--get-all", "credential.helper"],
    )?;
    if !out.status.success() {
        return Ok(false);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let entries: Vec<&str> = stdout.lines().collect();
    if !entries.iter().any(|e| e.contains(CREDENTIAL_HELPER_MARKER)) {
        return Ok(false);
    }
    let exclusive = entries.iter().any(|e| e.trim().is_empty());
    set_repo_credential_helper(dir, app_id, exclusive)?;
    Ok(true)
}

/// Create a commit when there are staged changes; no-op when the tree is clean.
///
/// Expects repo-local identity to already be set (see [`set_repo_user_identity`]).
pub fn commit_if_needed(dir: &Path, message: &str) -> anyhow::Result<bool> {
    let staged = run_git(dir, None, &["diff", "--cached", "--quiet"])?;
    if staged.status.success() {
        return Ok(false);
    }
    let out = run_git(dir, None, &["commit", "-m", message])?;
    if out.status.success() {
        return Ok(true);
    }
    // git reports a clean tree on STDOUT ("nothing added to commit ...") and
    // leaves stderr empty, so checking stderr alone turned every no-op commit
    // into a hard failure whose message was the useless "git commit: git commit".
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let nothing_to_commit = [&stdout, &stderr].iter().any(|s| {
        s.contains("nothing to commit")
            || s.contains("nothing added to commit")
            || s.contains("no changes added to commit")
            || s.contains("无文件要提交")
    });
    if nothing_to_commit {
        return Ok(false);
    }
    ensure_success(&out, "git commit")?;
    // Unreachable: the command failed, so ensure_success returned Err.
    Ok(false)
}

/// Push the current branch to `origin`, setting upstream.
pub fn push_origin_head(dir: &Path, ssh: Option<&SshEnv>) -> anyhow::Result<()> {
    let out = run_git(dir, ssh, &["push", "-u", "origin", "HEAD"])?;
    ensure_success(&out, "git push")
}

/// Current `HEAD` object id (full sha when available).
pub fn head_sha(dir: &Path) -> anyhow::Result<String> {
    let out = run_git(dir, None, &["rev-parse", "HEAD"])?;
    ensure_success(&out, "git rev-parse")?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Fetch from `origin`.
pub fn fetch_origin(dir: &Path, ssh: Option<&SshEnv>) -> anyhow::Result<()> {
    let out = run_git(dir, ssh, &["fetch", "origin"])?;
    ensure_success(&out, "git fetch")
}

/// Check out `sha` on `branch`, creating or resetting the branch and leaving
/// HEAD attached to it.
///
/// Deliberately not `checkout --detach`. A detached workdir cannot
/// `push -u origin HEAD` at all, and reads as "unpushed" to the next deploy's
/// gate — so the first deploy used to leave the app checkout in a state no
/// later deploy or reseed could get out of. Resetting the branch to `sha` is
/// safe here because callers refuse to build a dirty or unpushed tree first.
pub fn checkout_branch_at(dir: &Path, branch: &str, sha: &str) -> anyhow::Result<()> {
    let sha = validate_commit_sha(sha)?;
    let branch = validate_branch_name(branch)?;
    let out = run_git(dir, None, &["checkout", "-B", &branch, &sha])?;
    ensure_success(&out, "git checkout")?;
    // Best effort: with an upstream the next deploy's ahead/behind check is
    // exact instead of falling back to "is HEAD on some remote branch".
    let _ = run_git(
        dir,
        None,
        &[
            "branch",
            "--set-upstream-to",
            &format!("origin/{branch}"),
            &branch,
        ],
    );
    Ok(())
}

/// True when HEAD points at no branch. An unborn HEAD on a fresh `git init` is
/// still attached and reports false.
pub fn head_is_detached(dir: &Path) -> bool {
    run_git(dir, None, &["symbolic-ref", "--quiet", "HEAD"])
        .ok()
        .is_some_and(|o| !o.status.success())
}

/// Remote-tracking branches (`origin/…`) that contain `rev`.
fn remote_branches_containing(dir: &Path, rev: &str) -> anyhow::Result<Vec<String>> {
    let out = run_git(
        dir,
        None,
        &[
            "branch",
            "-r",
            "--contains",
            rev,
            "--format=%(refname:short)",
        ],
    )?;
    ensure_success(&out, "git branch -r --contains")?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        // `origin/HEAD -> origin/main` is a symref line, not a branch.
        .filter(|l| !l.is_empty() && !l.contains("->"))
        .collect())
}

/// `origin`'s default branch, when the remote HEAD symref is present locally.
fn origin_default_branch(dir: &Path) -> Option<String> {
    let out = run_git(
        dir,
        None,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .strip_prefix("origin/")
        .map(str::to_string)
}

/// Local branch name to put `rev` on: the remote branch that carries it,
/// preferring origin's default when several do.
fn branch_for_rev(dir: &Path, rev: &str) -> Option<String> {
    let names: Vec<String> = remote_branches_containing(dir, rev)
        .ok()?
        .iter()
        .filter_map(|r| r.strip_prefix("origin/").map(str::to_string))
        .filter(|b| b != "HEAD")
        .collect();
    if names.is_empty() {
        return None;
    }
    if let Some(default) = origin_default_branch(dir) {
        if names.contains(&default) {
            return Some(default);
        }
    }
    names.into_iter().next()
}

/// True when any remote-tracking branch contains `sha`.
pub fn sha_on_origin(dir: &Path, sha: &str) -> anyhow::Result<bool> {
    let sha = validate_commit_sha(sha)?;
    let verify = run_git(
        dir,
        None,
        &["rev-parse", "--verify", &format!("{sha}^{{commit}}")],
    )?;
    if !verify.status.success() {
        return Ok(false);
    }
    Ok(!remote_branches_containing(dir, &sha)?.is_empty())
}

/// Working tree has unstaged/staged changes.
pub fn has_uncommitted_changes(dir: &Path) -> anyhow::Result<bool> {
    let out = run_git(dir, None, &["status", "--porcelain"])?;
    ensure_success(&out, "git status")?;
    Ok(!String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

/// Local branch is ahead of its upstream (unpushed commits).
///
/// Callers must fetch first: with no upstream configured this falls back to
/// asking whether any remote-tracking branch already contains HEAD, which is
/// only as fresh as the last fetch.
pub fn has_unpushed_commits(dir: &Path) -> anyhow::Result<bool> {
    let out = run_git(dir, None, &["rev-list", "--count", "@{upstream}..HEAD"])?;
    if out.status.success() {
        let n: u64 = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(0);
        return Ok(n > 0);
    }
    // No upstream — HEAD is "pushed" exactly when some remote-tracking branch
    // contains it. Comparing against `origin/HEAD`, as this used to, answered
    // wrong twice over: a plain `git fetch` never creates that symref, and a
    // detached HEAD made `@{upstream}..HEAD` fail outright, so every deploy
    // after the first one was refused as dirty.
    if !is_git_repo(dir) {
        return Ok(false);
    }
    // An unborn HEAD (`git init` with no commit) has nothing to push.
    let Ok(head) = head_sha(dir) else {
        return Ok(false);
    };
    Ok(remote_branches_containing(dir, &head)?.is_empty())
}

/// Refuse deploy when the checkout is dirty or has unpushed work.
/// What the daemon and the agents it runs leave inside an app checkout that is
/// not the app's source: per-machine runtime config and agent state.
///
/// Surveyed on a real machine rather than guessed — across the app checkouts
/// there, the untracked entries are the brand meta directory, `.claude/`,
/// `.opencode/` and `opencode.json`. Everything else that turns up untracked is
/// the app's own files, which a deploy *should* commit.
///
/// Brand-aware, so a white-label build excludes its own meta directory; the
/// legacy one is listed too because a checkout seeded before the rename still
/// has it.
///
/// The brand is a parameter rather than read from the environment so the
/// template drift test can ask for the official one without racing whatever
/// else has the brand env set.
pub(crate) fn runtime_exclude_entries(brand: &str) -> Vec<String> {
    let mut entries = vec![
        format!("{}/", teamclu_runtime_env::workspace_meta_dir_name(brand)),
        format!("{}/", teamclu_runtime_env::LEGACY_BRAND_WORKSPACE_META_DIR),
        teamclu_runtime_env::workspace_config_file_name(brand),
    ];
    // Agent-local state, not brand-scoped: whichever agent ran in this checkout
    // wrote it, and none of it describes the app.
    entries.extend([
        ".claude/".to_string(),
        ".opencode/".to_string(),
        "opencode.json".to_string(),
    ]);
    entries.dedup();
    entries
}

/// Keep `.git/info/exclude` covering the daemon's own runtime files.
///
/// Not `.gitignore`: that file belongs to the app, is committed, and for an
/// imported repo is none of our business. `info/exclude` is per-checkout and
/// untracked — exactly the right home for machine-local state, and it reaches
/// the checkouts that already exist, which editing a template never can.
///
/// Best-effort by contract: a deploy that cannot write this should still
/// deploy. Callers log and continue.
pub fn ensure_runtime_excludes(dir: &Path) -> std::io::Result<()> {
    const HEADER: &str = "# managed by amuxd — app runtime files, never app source";
    let path = dir.join(".git").join("info").join("exclude");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    // Replace the whole managed block rather than appending: the entries are
    // brand-derived, so a rebrand must be able to drop the old ones.
    let mut kept: Vec<&str> = Vec::new();
    let mut in_block = false;
    for line in existing.lines() {
        if line.trim() == HEADER {
            in_block = true;
            continue;
        }
        if in_block {
            if line.trim().is_empty() {
                in_block = false;
            }
            continue;
        }
        kept.push(line);
    }

    let mut out = String::new();
    for line in kept {
        out.push_str(line);
        out.push('\n');
    }
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
    }
    out.push_str(HEADER);
    out.push('\n');
    for entry in runtime_exclude_entries(&teamclu_runtime_env::brand_short_name_from_env()) {
        out.push_str(&entry);
        out.push('\n');
    }
    out.push('\n');

    if out == existing {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, out)
}

/// Whether `git commit` would find an author here (repo-local or global).
fn has_commit_identity(dir: &Path) -> bool {
    ["user.name", "user.email"].iter().all(|key| {
        run_git(dir, None, &["config", "--get", key])
            .map(|out| out.status.success())
            .unwrap_or(false)
    })
}

/// Commit and push whatever the workdir has pending; report the new HEAD.
///
/// Deploy used to refuse a workdir with uncommitted or unpushed work
/// ([`ensure_clean_and_pushed`]), which is the state an agent leaves behind
/// every time it edits an app and stops — so the common case was a deploy that
/// could not run until someone went to a terminal. Publishing it is what the
/// user would have done by hand.
///
/// `Ok(None)` means there was nothing to publish and the caller should build
/// the commit it was given. `Ok(Some(sha))` means HEAD moved and *that* is the
/// commit to build — building the caller's older sha would silently ship
/// without the work this just committed.
///
/// A rejected push is [`ERR_PUSH_REJECTED`], never a merge and never a force:
/// diverged history is the one thing here a deploy cannot decide on its own.
pub fn publish_pending_work(
    dir: &Path,
    ssh: Option<&SshEnv>,
    message: &str,
) -> anyhow::Result<Option<String>> {
    let dirty = has_uncommitted_changes(dir)?;
    let ahead = has_unpushed_commits(dir)?;
    if !dirty && !ahead {
        return Ok(None);
    }

    // A detached HEAD cannot be pushed at all, and a previous deploy is the
    // usual way a checkout ends up on one.
    ensure_on_branch(dir)?;
    if dirty {
        // A commit needs an author. The seed path sets one, but a checkout that
        // predates it — or was re-inited by hand — may have neither a repo-local
        // identity nor a global fallback, and `git commit` fails on that rather
        // than on anything to do with the deploy. Filled in only when missing:
        // a repo where someone set their own name keeps it.
        if !has_commit_identity(dir) {
            set_repo_user_identity(dir, None, None)?;
        }
        add_all(dir)?;
        commit_if_needed(dir, message)?;
    }

    let out = run_git(dir, ssh, &["push", "-u", "origin", "HEAD"])?;
    if !out.status.success() {
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let lower = text.to_ascii_lowercase();
        if lower.contains("non-fast-forward")
            || lower.contains("fetch first")
            || lower.contains("rejected")
            || lower.contains("behind its remote")
        {
            anyhow::bail!("{ERR_PUSH_REJECTED}");
        }
        ensure_success(&out, "git push")?;
    }
    Ok(Some(head_sha(dir)?))
}

/// Test-only since deploy stopped gating on it: the assertion that
/// [`publish_pending_work`] left the checkout in the state it claims to.
#[cfg(test)]
pub fn ensure_clean_and_pushed(dir: &Path) -> anyhow::Result<()> {
    if has_uncommitted_changes(dir)? || has_unpushed_commits(dir)? {
        anyhow::bail!("{ERR_DIRTY}");
    }
    Ok(())
}

/// Verify `sha` is on the remote, then check it out on its branch.
///
/// Assumes a fetch has already run: [`prepare_git_build`] fetches first so the
/// clean/pushed gate can run against fresh remote-tracking refs before the
/// checkout moves HEAD.
///
/// [`prepare_git_build`]: super::app_build::prepare_git_build
pub fn checkout_fetched_sha(dir: &Path, sha: &str) -> anyhow::Result<()> {
    let sha = validate_commit_sha(sha)?;
    if !sha_on_origin(dir, &sha)? {
        anyhow::bail!("{ERR_SHA_NOT_ON_REMOTE}");
    }
    let branch = branch_for_rev(dir, &sha).unwrap_or_else(|| "main".to_string());
    checkout_branch_at(dir, &branch, &sha)
}

/// Put HEAD back on a branch when something left the checkout detached.
///
/// A detached HEAD cannot be pushed (`push -u origin HEAD` fails with "not a
/// full refname"), so a reseed of an app that had already been built would
/// otherwise be unable to publish its commit.
pub fn ensure_on_branch(dir: &Path) -> anyhow::Result<()> {
    if !is_git_repo(dir) || !head_is_detached(dir) {
        return Ok(());
    }
    let head = head_sha(dir)?;
    let branch = branch_for_rev(dir, &head)
        .or_else(|| origin_default_branch(dir))
        .unwrap_or_else(|| "main".to_string());
    checkout_branch_at(dir, &branch, &head)
}

/// Seed-time push: init, remote, commit, push; returns HEAD sha when pushed.
pub fn init_commit_push(
    dir: &Path,
    app_id: &str,
    remote_url: &str,
    deploy_key_pem: &str,
    commit_message: &str,
    git_user_name: Option<&str>,
    git_user_email: Option<&str>,
) -> anyhow::Result<String> {
    let ssh = SshEnv::from_deploy_key_pem(deploy_key_pem)?;
    init_if_needed(dir)?;
    set_repo_user_identity(dir, git_user_name, git_user_email)?;
    if let Err(e) = set_repo_ssh_command(dir, app_id) {
        tracing::warn!(app_id, error = %e, "could not point the checkout at git-ssh");
    }
    set_remote_origin(dir, remote_url, Some(&ssh))?;
    ensure_on_branch(dir)?;
    // Same reason as the deploy path: the seed commit is an `add -A`, and a
    // reseed runs over a checkout the daemon has already been living in.
    if let Err(e) = ensure_runtime_excludes(dir) {
        tracing::warn!(app_id, error = %e, "could not write .git/info/exclude");
    }
    add_all(dir)?;
    commit_if_needed(dir, commit_message)?;
    push_origin_head(dir, Some(&ssh))?;
    head_sha(dir)
}

/// Publish a directory the user already had as this app's repo.
///
/// Same shape as [`init_commit_push`] minus the one thing that would be a
/// surprise: `commit_worktree` false pushes the history that is already there
/// and leaves uncommitted work uncommitted. Adopting a folder is not a licence
/// to commit whatever the user happened to have open in it.
///
/// Returns HEAD after the push, or `None` when there was nothing to push —
/// which only happens for a repo with no commits that we were told not to
/// commit, and the caller does not ask for that combination.
pub fn adopt_commit_push(
    dir: &Path,
    app_id: &str,
    remote_url: &str,
    deploy_key_pem: &str,
    commit_message: &str,
    git_user_name: Option<&str>,
    git_user_email: Option<&str>,
    commit_worktree: bool,
) -> anyhow::Result<String> {
    let ssh = SshEnv::from_deploy_key_pem(deploy_key_pem)?;
    init_if_needed(dir)?;
    set_repo_user_identity(dir, git_user_name, git_user_email)?;
    if let Err(e) = set_repo_ssh_command(dir, app_id) {
        tracing::warn!(app_id, error = %e, "could not point the checkout at git-ssh");
    }
    set_remote_origin(dir, remote_url, Some(&ssh))?;
    ensure_on_branch(dir)?;
    if let Err(e) = ensure_runtime_excludes(dir) {
        tracing::warn!(app_id, error = %e, "could not write .git/info/exclude");
    }
    if commit_worktree {
        add_all(dir)?;
        commit_if_needed(dir, commit_message)?;
    }
    push_origin_head(dir, Some(&ssh))?;
    head_sha(dir)
}

/// Whether this checkout has any commit at all.
///
/// A `git init` with nothing committed has an unborn HEAD, which is neither a
/// repo we can push nor one whose history we should leave alone.
pub fn has_commits(dir: &Path) -> bool {
    run_git(dir, None, &["rev-parse", "--verify", "HEAD"])
        .ok()
        .is_some_and(|o| o.status.success())
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
            assert!(validate_remote_url(url).is_ok(), "rejected {url}");
        }
    }

    #[test]
    fn rejects_unsafe_remote_urls() {
        for url in [
            "ext::sh -c touch",
            "--upload-pack=touch",
            "",
            "https://example.com/repo .git",
        ] {
            assert!(validate_remote_url(url).is_err(), "accepted {url:?}");
        }
    }

    #[test]
    fn validates_commit_sha() {
        assert!(validate_commit_sha("abc1234").is_ok());
        assert!(validate_commit_sha("a".repeat(40).as_str()).is_ok());
        assert!(validate_commit_sha("not-hex").is_err());
        assert!(validate_commit_sha("abc").is_err());
    }

    #[test]
    fn deploy_key_temp_file_is_restricted() {
        let ssh = SshEnv::from_deploy_key_pem(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
        )
        .unwrap();
        assert!(ssh.key_path.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&ssh.key_path)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    fn local_origin(root: &Path) -> Option<PathBuf> {
        let git = git_bin();
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
        if !run(&["init", "-q", "--bare"]) {
            return None;
        }
        Some(origin)
    }

    fn ensure_test_identity(dir: &Path) {
        set_repo_user_identity(dir, None, None).unwrap();
    }

    fn set_remote_test(dir: &Path, url: &str) -> anyhow::Result<()> {
        let git = git_bin();
        let has_origin = Command::new(&git)
            .args(["remote", "get-url", "origin"])
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let args = if has_origin {
            vec!["remote", "set-url", "origin", url]
        } else {
            vec!["remote", "add", "origin", url]
        };
        let out = Command::new(&git).args(&args).current_dir(dir).output()?;
        if out.status.success() {
            Ok(())
        } else {
            anyhow::bail!(
                "git remote failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )
        }
    }

    #[test]
    fn init_commit_push_publishes_head() {
        let tmp = tempfile::tempdir().unwrap();
        let Some(bare) = local_origin(tmp.path()) else {
            eprintln!("git not usable; skipping");
            return;
        };
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("README.md"), b"seed").unwrap();

        let url = bare.to_string_lossy().to_string();
        init_if_needed(&work).unwrap();
        ensure_test_identity(&work);
        set_remote_test(&work, &url).unwrap();
        add_all(&work).unwrap();
        commit_if_needed(&work, "seed").unwrap();
        push_origin_head(&work, None).unwrap();
        let sha = head_sha(&work).unwrap();
        assert_eq!(sha.len(), 40);

        std::fs::write(work.join("README.md"), b"dirty").unwrap();
        assert!(has_uncommitted_changes(&work).unwrap());
        ensure_clean_and_pushed(&work).unwrap_err();
    }

    #[test]
    fn the_checkout_is_pointed_at_the_git_ssh_shim() {
        // This config entry is the whole fix: without it an agent's `git push`
        // falls through to the machine's own ssh identity, which Gitea has
        // never been shown.
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        if init_if_needed(&work).is_err() {
            eprintln!("git not usable; skipping");
            return;
        }
        set_repo_ssh_command(&work, "app-42").unwrap();

        let out = run_git(&work, None, &["config", "--get", "core.sshCommand"]).unwrap();
        let configured = String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert!(
            configured.contains("git-ssh --app app-42"),
            "got {configured}"
        );
        // Without this git reads the shim's basename, assumes the `simple`
        // variant, and refuses to pass `-p` — which every app remote needs.
        let out = run_git(&work, None, &["config", "--get", "ssh.variant"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ssh");
        // Repo-local only: it must not leak into any other repo on the machine.
        let out = run_git(
            &work,
            None,
            &["config", "--local", "--get", "core.sshCommand"],
        )
        .unwrap();
        assert!(out.status.success(), "core.sshCommand must be repo-local");
    }

    #[cfg(unix)]
    fn fake_output(code: i32, stderr: &str) -> Output {
        use std::os::unix::process::ExitStatusExt;
        Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[cfg(unix)]
    const LOCK_HELD: &str = "error: could not lock config file .git/config: File exists\n";

    #[cfg(unix)]
    #[test]
    fn a_config_write_is_retried_while_the_lock_is_held() {
        let mut outcomes = vec![
            fake_output(0, ""),
            fake_output(255, LOCK_HELD),
            fake_output(255, LOCK_HELD),
        ];
        let mut attempts = 0;
        let out = retry_on_config_lock(
            || {
                attempts += 1;
                Ok(outcomes.pop().unwrap())
            },
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(attempts, 3);
        assert!(out.status.success());
    }

    #[cfg(unix)]
    #[test]
    fn a_config_write_that_fails_for_another_reason_is_not_retried() {
        let mut attempts = 0;
        let out = retry_on_config_lock(
            || {
                attempts += 1;
                Ok(fake_output(3, "error: remote origin already exists.\n"))
            },
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(attempts, 1);
        assert!(!out.status.success());
    }

    #[cfg(unix)]
    #[test]
    fn a_config_write_stops_retrying_after_its_budget() {
        let mut attempts = 0;
        let out = retry_on_config_lock(
            || {
                attempts += 1;
                Ok(fake_output(255, LOCK_HELD))
            },
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(attempts, CONFIG_LOCK_RETRIES);
        assert!(is_config_lock_contention(&out));
    }

    #[test]
    fn set_remote_origin_repairs_an_origin_left_without_a_fetch_refspec() {
        // What a `remote add` that lost the lock between its two writes leaves behind.
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        if init_if_needed(&work).is_err() {
            eprintln!("git not usable; skipping");
            return;
        }
        let out = run_git(
            &work,
            None,
            &["config", "remote.origin.url", "https://example.com/old.git"],
        )
        .unwrap();
        assert!(out.status.success());

        set_remote_origin(&work, "https://example.com/app.git", None).unwrap();

        let url = run_git(&work, None, &["remote", "get-url", "origin"]).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&url.stdout).trim(),
            "https://example.com/app.git"
        );
        let fetch = run_git(&work, None, &["config", "--get", "remote.origin.fetch"]).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&fetch.stdout).trim(),
            "+refs/heads/*:refs/remotes/origin/*"
        );
    }

    #[test]
    fn a_config_write_gives_up_on_a_lock_that_never_clears() {
        // The other side of the same fix: a lock file left behind by a crashed
        // git process (not a live writer) must still fail — retrying forever
        // would hang the deploy instead of reporting a stale lock.
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        if init_if_needed(&work).is_err() {
            eprintln!("git not usable; skipping");
            return;
        }
        std::fs::write(work.join(".git").join("config.lock"), b"stale").unwrap();
        let err = set_repo_ssh_command(&work, "app-42").unwrap_err();
        assert!(
            err.to_string().contains("could not lock config file"),
            "got {err}"
        );
    }

    #[test]
    fn a_shell_word_reaches_the_command_verbatim() {
        // amuxd ships inside an .app bundle, so its path routinely has spaces;
        // on Windows every path is backslashes, which a bare word loses.
        for word in [
            r"C:\Users\me\AppData\Local\Temp\amuxd-deploy-key-Ab12",
            "/Applications/My App.app/Contents/MacOS/amuxd",
            "/Users/jo/Library/Application Support/TeamClu/amuxd",
            "it's",
            "$HOME `id` \"x\"",
            "",
            "app-42",
        ] {
            let quoted = shell_quote(word);
            let Ok(out) = Command::new("sh")
                .arg("-c")
                .arg(format!("printf %s {quoted}"))
                .output()
            else {
                eprintln!("no sh here; skipping");
                return;
            };
            assert_eq!(
                String::from_utf8_lossy(&out.stdout),
                word,
                "quoted as {quoted}"
            );
        }
        // Plain words stay bare, so the stamped config still reads as written.
        assert_eq!(shell_quote("app-42"), "app-42");
    }

    #[cfg(unix)]
    #[test]
    fn git_hands_ssh_the_deploy_key_path_verbatim() {
        // The Windows clone failure end to end: git runs GIT_SSH_COMMAND through
        // sh, and ssh must receive the key path exactly as written. A stand-in
        // `ssh` on PATH records its argv; sh treats backslashes the same here as
        // Git for Windows' bash does.
        use std::os::unix::fs::PermissionsExt;
        if !Command::new(git_bin())
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
        {
            eprintln!("git not usable; skipping");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let fake_ssh = bin.join("ssh");
        std::fs::write(
            &fake_ssh,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$AMUXD_TEST_SSH_ARGV\"\nexit 255\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake_ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let argv_file = tmp.path().join("argv");

        // No space in it: that is the ordinary Windows temp path, and the one
        // a bare word used to reach ssh with every backslash gone.
        let key_path = r"C:\Users\me\AppData\Local\Temp\amuxd-deploy-key-Ab12";
        let ssh = SshEnv {
            key_path: PathBuf::from(key_path),
            _guard: tempfile::NamedTempFile::new().unwrap(),
        };
        let path = format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let out = Command::new(git_bin())
            .current_dir(tmp.path())
            .env("PATH", path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_SSH_COMMAND", ssh.git_ssh_command())
            .env("AMUXD_TEST_SSH_ARGV", &argv_file)
            .args(["ls-remote", "ssh://git@example.invalid:2222/o/r.git"])
            .output()
            .unwrap();
        assert!(!out.status.success(), "the stand-in ssh always fails");

        let argv = std::fs::read_to_string(&argv_file).expect("git ran the stand-in ssh");
        let args: Vec<&str> = argv.lines().collect();
        let i = args.iter().position(|a| *a == "-i").expect("-i passed");
        assert_eq!(args.get(i + 1).copied(), Some(key_path), "argv: {args:?}");
    }

    #[test]
    fn a_failed_ssh_transport_reports_ssh_s_reason_not_git_s_advice() {
        let windows_clone = "Cloning into 'C:\\app'...\n\
            Warning: Identity file C:UsersmeTempkey not accessible: No such file or directory.\n\
            git@git.example.com: Permission denied (publickey).\n\
            fatal: Could not read from remote repository.\n\
            \n\
            Please make sure you have the correct access rights\n\
            and the repository exists.\n";
        assert_eq!(
            git_failure_reason(windows_clone),
            Some("git@git.example.com: Permission denied (publickey).")
        );
        // ssh said nothing: git's own line still beats its advice.
        let silent = "Cloning into 'app'...\n\
            fatal: Could not read from remote repository.\n\
            \n\
            Please make sure you have the correct access rights\n\
            and the repository exists.\n";
        assert_eq!(git_failure_reason(silent), Some(GIT_SSH_FATAL));
        // An http failure has no advice and keeps reporting its last line.
        assert_eq!(
            git_failure_reason(
                "remote: Repository not found.\nfatal: repository 'https://example.com/o/r.git/' not found\n"
            ),
            Some("fatal: repository 'https://example.com/o/r.git/' not found")
        );
        assert_eq!(git_failure_reason("\n  \n"), None);
    }

    #[test]
    fn fetch_and_checkout_requires_sha_on_remote() {
        let tmp = tempfile::tempdir().unwrap();
        let Some(bare) = local_origin(tmp.path()) else {
            eprintln!("git not usable; skipping");
            return;
        };
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("README.md"), b"x").unwrap();
        let url = bare.to_string_lossy().to_string();
        init_if_needed(&work).unwrap();
        ensure_test_identity(&work);
        set_remote_test(&work, &url).unwrap();
        add_all(&work).unwrap();
        commit_if_needed(&work, "seed").unwrap();
        push_origin_head(&work, None).unwrap();
        let sha = head_sha(&work).unwrap();

        let build = tmp.path().join("build");
        std::fs::create_dir_all(&build).unwrap();
        init_if_needed(&build).unwrap();
        set_remote_test(&build, &url).unwrap();
        fetch_origin(&build, None).unwrap();
        checkout_fetched_sha(&build, &sha).unwrap();

        let missing = "0".repeat(40);
        let err = checkout_fetched_sha(&build, &missing).unwrap_err();
        assert!(format!("{err}").contains(ERR_SHA_NOT_ON_REMOTE));
    }

    #[test]
    fn commit_if_needed_reports_a_clean_tree_instead_of_failing() {
        // git says "nothing added to commit" on STDOUT and leaves stderr empty;
        // reading stderr alone turned a reseed of an unchanged app into an error.
        let tmp = tempfile::tempdir().unwrap();
        let Some(bare) = local_origin(tmp.path()) else {
            eprintln!("git not usable; skipping");
            return;
        };
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("README.md"), b"seed").unwrap();
        let url = bare.to_string_lossy().to_string();
        init_if_needed(&work).unwrap();
        ensure_test_identity(&work);
        set_remote_test(&work, &url).unwrap();
        add_all(&work).unwrap();
        assert!(commit_if_needed(&work, "seed").unwrap());
        assert!(!commit_if_needed(&work, "seed again").unwrap());
    }

    #[test]
    fn set_repo_user_identity_persists_for_later_commits() {
        let tmp = tempfile::tempdir().unwrap();
        if local_origin(tmp.path()).is_none() {
            eprintln!("git not usable; skipping");
            return;
        }
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("README.md"), b"seed").unwrap();
        init_if_needed(&work).unwrap();
        set_repo_user_identity(&work, Some("Alice"), Some("alice@example.com")).unwrap();

        let out = run_git(&work, None, &["config", "user.name"]).unwrap();
        ensure_success(&out, "git config user.name").unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "Alice");

        add_all(&work).unwrap();
        assert!(commit_if_needed(&work, "first").unwrap());
        let out = run_git(&work, None, &["log", "-1", "--format=%an <%ae>"]).unwrap();
        ensure_success(&out, "git log").unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "Alice <alice@example.com>"
        );

        std::fs::write(work.join("README.md"), b"edit").unwrap();
        add_all(&work).unwrap();
        assert!(commit_if_needed(&work, "second").unwrap());
        let out = run_git(&work, None, &["log", "-1", "--format=%an <%ae>"]).unwrap();
        ensure_success(&out, "git log").unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "Alice <alice@example.com>"
        );
    }

    #[test]
    fn set_repo_user_identity_falls_back_to_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        if local_origin(tmp.path()).is_none() {
            eprintln!("git not usable; skipping");
            return;
        }
        let work = tmp.path().join("app");
        init_if_needed(&work).unwrap();
        set_repo_user_identity(&work, Some("  "), Some("")).unwrap();
        let out = run_git(&work, None, &["config", "user.name"]).unwrap();
        ensure_success(&out, "git config user.name").unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "TeamClu");
        let out = run_git(&work, None, &["config", "user.email"]).unwrap();
        ensure_success(&out, "git config user.email").unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "apps@teamclu.local"
        );
    }

    #[test]
    fn a_built_checkout_can_deploy_again_and_be_pushed_to() {
        // The first build checks out the deployed sha. Everything after it —
        // the next deploy's clean/pushed gate, and a reseed's push — used to
        // fail because that checkout was left on a detached HEAD.
        let tmp = tempfile::tempdir().unwrap();
        let Some(bare) = local_origin(tmp.path()) else {
            eprintln!("git not usable; skipping");
            return;
        };
        let url = bare.to_string_lossy().to_string();

        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("README.md"), b"seed").unwrap();
        init_if_needed(&work).unwrap();
        ensure_test_identity(&work);
        set_remote_test(&work, &url).unwrap();
        add_all(&work).unwrap();
        commit_if_needed(&work, "seed").unwrap();
        push_origin_head(&work, None).unwrap();
        let first = head_sha(&work).unwrap();

        // Build #1 — after it the checkout must still be on a branch.
        fetch_origin(&work, None).unwrap();
        checkout_fetched_sha(&work, &first).unwrap();
        assert!(!head_is_detached(&work), "build left HEAD detached");
        ensure_clean_and_pushed(&work).unwrap();

        // The agent commits and pushes; deploy #2 must accept the new sha.
        std::fs::write(work.join("README.md"), b"edited").unwrap();
        add_all(&work).unwrap();
        assert!(commit_if_needed(&work, "edit").unwrap());
        push_origin_head(&work, None).unwrap();
        let second = head_sha(&work).unwrap();
        assert_ne!(first, second);

        fetch_origin(&work, None).unwrap();
        ensure_clean_and_pushed(&work).unwrap();
        checkout_fetched_sha(&work, &second).unwrap();
        assert_eq!(head_sha(&work).unwrap(), second);

        // An unpushed commit is still refused — that gate must keep working.
        std::fs::write(work.join("README.md"), b"local only").unwrap();
        add_all(&work).unwrap();
        commit_if_needed(&work, "local only").unwrap();
        ensure_clean_and_pushed(&work).unwrap_err();
    }

    #[test]
    fn runtime_excludes_are_written_without_touching_what_was_there() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        std::fs::create_dir_all(work.join(".git").join("info")).unwrap();
        std::fs::write(work.join(".git/info/exclude"), "# mine\nscratch/\n").unwrap();

        ensure_runtime_excludes(&work).unwrap();
        let first = std::fs::read_to_string(work.join(".git/info/exclude")).unwrap();
        assert!(
            first.contains("scratch/"),
            "user lines must survive: {first}"
        );
        for entry in runtime_exclude_entries(&teamclu_runtime_env::brand_short_name_from_env()) {
            assert!(first.contains(&entry), "missing {entry} in {first}");
        }

        // Idempotent: a second deploy must not stack another block.
        ensure_runtime_excludes(&work).unwrap();
        let second = std::fs::read_to_string(work.join(".git/info/exclude")).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn runtime_excludes_keep_an_agents_own_files_out_of_the_app_repo() {
        // The point of the whole thing: deploy commits the workdir, so anything
        // the daemon left in it that git can see ends up in the app's history.
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        init_if_needed(&work).unwrap();
        ensure_test_identity(&work);
        ensure_runtime_excludes(&work).unwrap();

        // Built from the helper, not spelled out: `storage_lint` scans test
        // code too, and a quoted brand-directory literal is what it forbids.
        let meta = teamclu_runtime_env::workspace_meta_dir_name(
            &teamclu_runtime_env::brand_short_name_from_env(),
        );
        std::fs::write(work.join("index.html"), b"app source").unwrap();
        std::fs::create_dir_all(work.join(".claude")).unwrap();
        std::fs::write(work.join(".claude/settings.json"), b"{}").unwrap();
        std::fs::create_dir_all(work.join(&meta)).unwrap();
        std::fs::write(work.join(&meta).join("state.json"), b"{}").unwrap();
        std::fs::write(work.join("opencode.json"), b"{}").unwrap();

        add_all(&work).unwrap();
        let out = run_git(&work, None, &["diff", "--cached", "--name-only"]).unwrap();
        let staged = String::from_utf8_lossy(&out.stdout);
        assert!(
            staged.contains("index.html"),
            "app source must be staged: {staged}"
        );
        for runtime in [
            ".claude/".to_string(),
            format!("{meta}/"),
            "opencode.json".to_string(),
        ] {
            assert!(
                !staged.contains(&runtime),
                "{runtime} must not be staged: {staged}"
            );
        }
    }

    #[test]
    fn git_ssh_command_uses_only_the_deploy_key() {
        // `-i` alone only adds a candidate: ssh still offers every agent key
        // and default identity first, and Gitea hangs up after MaxAuthTries.
        let ssh = SshEnv::from_deploy_key_pem("-----BEGIN KEY-----\nx\n-----END KEY-----")
            .expect("temp key");
        let cmd = ssh.git_ssh_command();
        assert!(cmd.contains("IdentitiesOnly=yes"), "{cmd}");
        assert!(cmd.contains("-i "), "{cmd}");
        assert!(cmd.contains("BatchMode=yes"), "{cmd}");
    }

    #[test]
    fn publish_pending_work_commits_and_pushes_what_the_agent_left() {
        // The state an agent leaves behind whenever it edits an app and stops.
        // Deploy used to refuse it outright.
        let tmp = tempfile::tempdir().unwrap();
        let Some(bare) = local_origin(tmp.path()) else {
            eprintln!("git not usable; skipping");
            return;
        };
        let url = bare.to_string_lossy().to_string();
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("README.md"), b"seed").unwrap();
        init_if_needed(&work).unwrap();
        ensure_test_identity(&work);
        set_remote_test(&work, &url).unwrap();
        add_all(&work).unwrap();
        commit_if_needed(&work, "seed").unwrap();
        push_origin_head(&work, None).unwrap();
        let seeded = head_sha(&work).unwrap();

        // Clean and pushed: nothing to do, and the caller's sha still rules.
        fetch_origin(&work, None).unwrap();
        assert_eq!(publish_pending_work(&work, None, "deploy").unwrap(), None);

        // Uncommitted work — including a file git has never seen, which is what
        // `.teamclu/` and friends are.
        std::fs::write(work.join("README.md"), b"edited by the agent").unwrap();
        std::fs::write(work.join("new-file.txt"), b"untracked").unwrap();
        let published = publish_pending_work(&work, None, "deploy")
            .unwrap()
            .expect("a dirty tree must publish");
        assert_ne!(published, seeded, "HEAD must have moved");
        assert_eq!(published, head_sha(&work).unwrap());
        ensure_clean_and_pushed(&work).expect("published work is clean and pushed");
    }

    #[test]
    fn publish_pending_work_publishes_a_commit_that_was_never_pushed() {
        let tmp = tempfile::tempdir().unwrap();
        let Some(bare) = local_origin(tmp.path()) else {
            eprintln!("git not usable; skipping");
            return;
        };
        let url = bare.to_string_lossy().to_string();
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("README.md"), b"seed").unwrap();
        init_if_needed(&work).unwrap();
        ensure_test_identity(&work);
        set_remote_test(&work, &url).unwrap();
        add_all(&work).unwrap();
        commit_if_needed(&work, "seed").unwrap();
        push_origin_head(&work, None).unwrap();

        // Committed but never pushed: clean tree, still not publishable.
        std::fs::write(work.join("README.md"), b"local only").unwrap();
        add_all(&work).unwrap();
        assert!(commit_if_needed(&work, "local only").unwrap());
        let local = head_sha(&work).unwrap();

        let published = publish_pending_work(&work, None, "deploy")
            .unwrap()
            .expect("an unpushed commit must publish");
        assert_eq!(
            published, local,
            "an existing commit is pushed, not re-made"
        );
        ensure_clean_and_pushed(&work).unwrap();
    }

    #[test]
    fn publish_pending_work_refuses_a_diverged_remote() {
        // The one case a deploy must not decide on its own: origin moved. No
        // merge, no force — an error the user can act on.
        let tmp = tempfile::tempdir().unwrap();
        let Some(bare) = local_origin(tmp.path()) else {
            eprintln!("git not usable; skipping");
            return;
        };
        let url = bare.to_string_lossy().to_string();

        let seed = |dir: &Path, body: &[u8], msg: &str| {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("README.md"), body).unwrap();
            init_if_needed(dir).unwrap();
            ensure_test_identity(dir);
            set_remote_test(dir, &url).unwrap();
            add_all(dir).unwrap();
            commit_if_needed(dir, msg).unwrap();
        };

        let work = tmp.path().join("app");
        seed(&work, b"seed", "seed");
        push_origin_head(&work, None).unwrap();

        // Someone else pushes on top of the same branch.
        let other = tmp.path().join("other");
        let git = git_bin();
        assert!(Command::new(&git)
            .args(["clone", "-q", &url, other.to_string_lossy().as_ref()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false));
        ensure_test_identity(&other);
        std::fs::write(other.join("README.md"), b"theirs").unwrap();
        add_all(&other).unwrap();
        commit_if_needed(&other, "theirs").unwrap();
        push_origin_head(&other, None).unwrap();

        // Our checkout still has local work and no idea the remote moved.
        std::fs::write(work.join("README.md"), b"ours").unwrap();
        let err = publish_pending_work(&work, None, "deploy").unwrap_err();
        assert!(
            format!("{err}").contains(ERR_PUSH_REJECTED),
            "expected a rejection, got: {err}"
        );
    }

    #[test]
    fn ensure_on_branch_reattaches_a_detached_head() {
        let tmp = tempfile::tempdir().unwrap();
        let Some(bare) = local_origin(tmp.path()) else {
            eprintln!("git not usable; skipping");
            return;
        };
        let work = tmp.path().join("app");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("README.md"), b"seed").unwrap();
        let url = bare.to_string_lossy().to_string();
        init_if_needed(&work).unwrap();
        ensure_test_identity(&work);
        set_remote_test(&work, &url).unwrap();
        add_all(&work).unwrap();
        commit_if_needed(&work, "seed").unwrap();
        push_origin_head(&work, None).unwrap();
        let sha = head_sha(&work).unwrap();

        let out = run_git(&work, None, &["checkout", "--detach", &sha]).unwrap();
        assert!(out.status.success());
        assert!(head_is_detached(&work));

        ensure_on_branch(&work).unwrap();
        assert!(!head_is_detached(&work));
        // …and from there a push is possible again.
        push_origin_head(&work, None).unwrap();
    }

    #[test]
    fn rejects_unsafe_branch_names() {
        assert!(validate_branch_name("main").is_ok());
        assert!(validate_branch_name("feature/x-1.2").is_ok());
        assert!(validate_branch_name("--upload-pack=touch").is_err());
        assert!(validate_branch_name("a..b").is_err());
        assert!(validate_branch_name("").is_err());
        assert!(validate_branch_name("bad name").is_err());
    }

    #[test]
    fn reads_the_scheme_and_host_git_names_a_request_by() {
        let pair = |s: &str, h: &str| Some((s.to_string(), h.to_string()));
        assert_eq!(
            http_remote_authority("https://GitHub.com/o/r.git"),
            pair("https", "github.com")
        );
        assert_eq!(
            http_remote_authority("http://me:tok@git.internal:8443/o/r"),
            pair("http", "git.internal:8443")
        );
        assert_eq!(
            http_remote_authority("https://example.com"),
            pair("https", "example.com")
        );
        assert_eq!(http_remote_authority("git@github.com:o/r.git"), None);
        assert_eq!(http_remote_authority("ssh://git@github.com/o/r.git"), None);
        assert_eq!(http_remote_authority("https:///o/r"), None);
    }

    #[test]
    fn an_https_credential_defaults_its_username_and_refuses_line_breaks() {
        let credential = HttpsCredential::new(None, " secret-value ").unwrap();
        assert_eq!(credential.username, DEFAULT_GIT_HTTPS_USERNAME);
        assert_eq!(credential.token, "secret-value");
        assert_eq!(
            HttpsCredential::new(Some(" me "), "t").unwrap().username,
            "me"
        );
        assert!(HttpsCredential::new(None, "  ").is_err());
        assert!(HttpsCredential::new(None, "a\nb").is_err());
        assert!(HttpsCredential::new(Some("a\rb"), "t").is_err());
        assert!(
            !format!("{credential:?}").contains("secret-value"),
            "Debug must not print the token"
        );
    }

    fn credential_helpers(dir: &Path) -> Vec<String> {
        let out = run_git(
            dir,
            None,
            &["config", "--local", "--get-all", "credential.helper"],
        )
        .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn the_credential_helper_is_stamped_once_and_refresh_keeps_its_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        init_if_needed(&work).unwrap();

        set_repo_credential_helper(&work, "app-42", true).unwrap();
        // Stamping again replaces rather than piling up entries.
        set_repo_credential_helper(&work, "app-42", true).unwrap();
        let exclusive = credential_helpers(&work);
        assert_eq!(exclusive.len(), 2, "got {exclusive:?}");
        assert_eq!(
            exclusive[0], "",
            "exclusive starts by clearing inherited helpers"
        );
        assert!(
            exclusive[1].starts_with('!') && exclusive[1].contains("git-credential --app app-42"),
            "got {exclusive:?}"
        );
        assert!(refresh_repo_credential_helper(&work, "app-42").unwrap());
        assert_eq!(credential_helpers(&work), exclusive);

        set_repo_credential_helper(&work, "app-42", false).unwrap();
        assert_eq!(credential_helpers(&work).len(), 1);
        assert!(refresh_repo_credential_helper(&work, "app-42").unwrap());
        assert_eq!(
            credential_helpers(&work).len(),
            1,
            "refresh must not add the reset"
        );
    }

    #[test]
    fn refresh_leaves_a_checkout_without_our_helper_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        init_if_needed(&work).unwrap();
        assert!(!refresh_repo_credential_helper(&work, "app-42").unwrap());

        let out = run_git(
            &work,
            None,
            &["config", "--local", "credential.helper", "osxkeychain"],
        )
        .unwrap();
        assert!(out.status.success());
        assert!(!refresh_repo_credential_helper(&work, "app-42").unwrap());
        assert_eq!(credential_helpers(&work), vec!["osxkeychain".to_string()]);
    }
}
