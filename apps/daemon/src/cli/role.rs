//! `amuxd role …` — this workspace's agent roles, for agents first. It
//! replaced the `teamclu-introspect` `manage_roles` MCP tool.
//!
//! A role is one `ROLE.md`; the daemon's `/v1/workspaces/:id/roles` reads and
//! writes it (the same store the desktop's roles page uses), so the CLI hands
//! over the file instead of assembling it from fields.

use clap::{Args, Subcommand};
use serde_json::json;

use super::envelope::{call_http, emit, usage, workspace_id, Usage};

#[derive(Args, Debug)]
pub struct RoleArgs {
    /// json (default), table, or file:<path>.
    #[arg(
        short = 'o',
        long = "output",
        global = true,
        default_value = "json",
        hide_default_value = true
    )]
    pub output: String,
    /// The workspace. Default: the current directory.
    #[arg(long, global = true)]
    pub workspace: Option<std::path::PathBuf>,
    #[command(subcommand)]
    pub action: RoleAction,
}

#[derive(Subcommand, Debug)]
pub enum RoleAction {
    /// This workspace's roles.
    ///
    /// Example: amuxd role ls -o table
    Ls,
    /// Create or replace a role from a ROLE.md file.
    ///
    /// The file: frontmatter with `name` and `description`, then sections
    /// `## Role`, `## When to use`, `## Working style`, and optionally
    /// `## Available role skills`. Write it anywhere (e.g. /tmp/ROLE.md),
    /// then set it. `amuxd role ls` shows existing ones to start from.
    ///
    /// Example: amuxd role set code-reviewer --file /tmp/ROLE.md
    #[command(name = "set", alias = "put")]
    Put {
        /// Role identifier: lowercase letters, digits, hyphens.
        slug: String,
        /// The ROLE.md (`-` for stdin).
        #[arg(long)]
        file: String,
    },
    /// Delete a role.
    ///
    /// Example: amuxd role rm code-reviewer
    Rm { slug: String },
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !slug.starts_with('-')
}

fn read_markdown(path: &str) -> Result<String, Usage> {
    let text = if path == "-" {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)
            .map_err(|e| usage("unreadable_file", format!("read stdin: {e}"), None))?;
        s
    } else {
        std::fs::read_to_string(path)
            .map_err(|e| usage("unreadable_file", format!("read {path}: {e}"), None))?
    };
    if text.trim().is_empty() {
        return Err(usage("empty_role", "the ROLE.md is empty", None));
    }
    Ok(text)
}

/// What one command sends: method, path, body.
fn build(
    action: &RoleAction,
    workspace_id: &str,
) -> Result<(reqwest::Method, String, Option<serde_json::Value>), Usage> {
    let base = format!("/v1/workspaces/{workspace_id}/roles");
    let check = |slug: &str| {
        if valid_slug(slug) {
            Ok(())
        } else {
            Err(usage(
                "invalid_slug",
                format!("role slug {slug:?}: use lowercase letters, digits and hyphens"),
                None,
            ))
        }
    };
    Ok(match action {
        RoleAction::Ls => (reqwest::Method::GET, base, None),
        RoleAction::Put { slug, file } => {
            check(slug)?;
            let raw = read_markdown(file)?;
            (
                reqwest::Method::PUT,
                format!("{base}/{slug}"),
                Some(json!({ "rawMarkdown": raw })),
            )
        }
        RoleAction::Rm { slug } => {
            check(slug)?;
            (reqwest::Method::DELETE, format!("{base}/{slug}"), None)
        }
    })
}

/// Run one command; returns the process exit status.
pub fn run(args: RoleArgs) -> anyhow::Result<i32> {
    let workspace_id = match workspace_id(args.workspace.as_deref()) {
        Ok(id) => id,
        Err(u) => return Ok(emit(&args.output, u.envelope())),
    };
    let (method, path, body) = match build(&args.action, &workspace_id) {
        Ok(r) => r,
        Err(u) => return Ok(emit(&args.output, u.envelope())),
    };
    let mut envelope = call_http("role-cli", method, &path, body, Some("amuxd role ls"))?;
    if matches!(args.action, RoleAction::Ls) {
        if let Some(roles) = envelope["data"].as_array() {
            envelope["data"] = serde_json::Value::Array(roles.iter().map(summary).collect());
        }
    }
    Ok(emit(&args.output, envelope))
}

/// A role as `ls` lists it: which one and where its ROLE.md is. The full
/// text is that file (or what `put` answers), not repeated per role here.
fn summary(role: &serde_json::Value) -> serde_json::Value {
    json!({
        "slug": role["slug"],
        "name": role["name"],
        "description": role["description"],
        "filePath": role["filePath"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn parse(words: &[&str]) -> RoleAction {
        match crate::cli::Cli::try_parse_from(words).unwrap().command {
            crate::cli::Commands::Role(args) => args.action,
            _ => unreachable!(),
        }
    }

    #[test]
    fn put_sends_the_file_as_raw_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("ROLE.md");
        std::fs::write(&file, "---\nname: Reviewer\n---\n## Role\nreview\n").unwrap();
        let action = parse(&[
            "amuxd",
            "role",
            "put",
            "reviewer",
            "--file",
            file.to_str().unwrap(),
        ]);
        let (method, path, body) = build(&action, "d3M").unwrap();
        assert_eq!(method, reqwest::Method::PUT);
        assert_eq!(path, "/v1/workspaces/d3M/roles/reviewer");
        // The daemon's own request type must accept it: a field-name slip
        // here is a 422 at runtime, so check against the real struct.
        let req: crate::config::workspace_control::UpsertRoleRequest =
            serde_json::from_value(body.unwrap()).unwrap();
        assert!(req.raw_markdown.contains("## Role"));
    }

    #[test]
    fn ls_lists_roles_without_their_text() {
        let role = json!({
            "slug": "dev", "name": "Dev", "description": "d", "body": "long",
            "rawMarkdown": "long", "filePath": "/w/.teamclu/roles/dev/ROLE.md",
        });
        assert_eq!(
            summary(&role),
            json!({ "slug": "dev", "name": "Dev", "description": "d", "filePath": "/w/.teamclu/roles/dev/ROLE.md" })
        );
    }

    #[test]
    fn slugs_that_could_escape_the_roles_dir_are_refused() {
        for bad in ["", "..", "../x", "a/b", "Dev", "-x"] {
            let action = RoleAction::Rm { slug: bad.into() };
            assert_eq!(
                build(&action, "d3M").unwrap_err().code,
                "invalid_slug",
                "{bad:?}"
            );
        }
        assert!(build(
            &RoleAction::Rm {
                slug: "code-reviewer".into()
            },
            "d3M"
        )
        .is_ok());
    }
}
