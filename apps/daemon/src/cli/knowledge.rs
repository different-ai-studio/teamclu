//! `amuxd knowledge …` — the team's knowledge vault, for agents first.
//!
//! `search` and `read` answer from the vault (the same handler as the
//! `knowledge_search` / `knowledge_read` MCP tools). `inbox` is the review
//! queue: an agent proposes a page, a person (or an agent told to) publishes
//! it. Nothing reaches the vault, or the team, until `inbox publish`.
//!
//! Each command is one `cmd: knowledge` line on the daemon's control socket.
//! Output: the `amuxd app` contract.

use clap::{Args, Subcommand};
use serde_json::{json, Map, Value};

use super::envelope::{emit, error_envelope, success, unreachable, usage, Usage};
use crate::config::DaemonConfig;

#[derive(Args, Debug)]
pub struct KnowledgeArgs {
    /// json (default), table, or file:<path>.
    #[arg(
        short = 'o',
        long = "output",
        global = true,
        default_value = "json",
        hide_default_value = true
    )]
    pub output: String,
    #[command(subcommand)]
    pub action: KnowledgeAction,
}

#[derive(Subcommand, Debug)]
pub enum KnowledgeAction {
    /// Search the vault. Every word must appear in a page's title or body;
    /// title hits first. Nothing found means the vault does not say — do not
    /// invent an answer.
    ///
    /// Example: amuxd knowledge search 渠道 接入 --limit 5
    Search {
        /// Words to look for (all of them).
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
        /// Max hits, 1 to 8 (default 8).
        #[arg(long)]
        limit: Option<u32>,
        /// Only pages under this vault folder, e.g. 40-runbooks/.
        #[arg(long)]
        path_prefix: Option<String>,
    },
    /// Read pages or sections a search returned (its sourceRef values, or
    /// vault paths). Quote only what this returns.
    ///
    /// Example: amuxd knowledge read kb:v1:…
    Read {
        #[arg(required = true, num_args = 1..)]
        refs: Vec<String>,
        /// Cap on characters across everything returned (default 8000).
        #[arg(long)]
        max_chars: Option<u32>,
    },
    /// The review inbox: pages proposed for the vault.
    #[command(subcommand)]
    Inbox(InboxAction),
}

#[derive(Subcommand, Debug)]
pub enum InboxAction {
    /// Pages waiting for review.
    ///
    /// Example: amuxd knowledge inbox ls
    #[command(alias = "list")]
    Ls,
    /// One proposed page, with its text.
    ///
    /// Example: amuxd knowledge inbox show <id>
    Show { id: String },
    /// Propose a page for the vault from a Markdown file. It waits in the
    /// inbox; nothing is written to the vault yet.
    ///
    /// Example: amuxd knowledge inbox propose --title "渠道接入手册" --file /tmp/page.md --path 40-runbooks/渠道接入.md
    #[command(alias = "create")]
    Propose {
        #[arg(long)]
        title: String,
        /// The page body (`-` for stdin).
        #[arg(long)]
        file: String,
        /// Where it should go in the vault.
        #[arg(long)]
        path: Option<String>,
        /// One line on what it is, for the reviewer.
        #[arg(long)]
        summary: Option<String>,
        /// The session it came from.
        #[arg(long)]
        session: Option<String>,
    },
    /// Publish a proposed page into the vault; it syncs to the team.
    ///
    /// Example: amuxd knowledge inbox publish <id> --path 40-runbooks/渠道接入.md
    Publish {
        id: String,
        /// Vault path to write (default: the proposal's own).
        #[arg(long)]
        path: Option<String>,
        /// Replace a page already at that path.
        #[arg(long)]
        overwrite: bool,
    },
    /// Discard a proposed page.
    ///
    /// Example: amuxd knowledge inbox rm <id>
    #[command(alias = "discard")]
    Rm { id: String },
}

fn read_body(path: &str) -> Result<String, Usage> {
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
        return Err(usage("empty_page", "the page is empty", None));
    }
    Ok(text)
}

/// The control-socket line one command sends.
fn request(action: &KnowledgeAction) -> Result<Value, Usage> {
    let mut p = Map::new();
    let mut put = |k: &str, v: Value| {
        p.insert(k.to_string(), v);
    };
    put("cmd", json!("knowledge"));
    match action {
        KnowledgeAction::Search {
            query,
            limit,
            path_prefix,
        } => {
            put("action", json!("search"));
            put("query", json!(query.join(" ")));
            put("limit", json!(limit.unwrap_or(8).clamp(1, 8)));
            if let Some(prefix) = path_prefix {
                put("pathPrefix", json!(prefix));
            }
        }
        KnowledgeAction::Read { refs, max_chars } => {
            put("action", json!("read"));
            put("sourceRefs", json!(refs));
            if let Some(n) = max_chars {
                put("maxChars", json!(n));
            }
        }
        KnowledgeAction::Inbox(InboxAction::Ls) => put("action", json!("inbox_list")),
        KnowledgeAction::Inbox(InboxAction::Show { id }) => {
            put("action", json!("inbox_get"));
            put("id", json!(id));
        }
        KnowledgeAction::Inbox(InboxAction::Propose {
            title,
            file,
            path,
            summary,
            session,
        }) => {
            put("action", json!("propose"));
            put("title", json!(title));
            put("content", json!(read_body(file)?));
            put("source", json!("cli"));
            if let Some(path) = path {
                put("suggestedPath", json!(path));
            }
            if let Some(summary) = summary {
                put("summary", json!(summary));
            }
            if let Some(session) = session {
                put("sessionId", json!(session));
            }
        }
        KnowledgeAction::Inbox(InboxAction::Publish {
            id,
            path,
            overwrite,
        }) => {
            put("action", json!("publish"));
            put("id", json!(id));
            put("overwrite", json!(overwrite));
            if let Some(path) = path {
                put("path", json!(path));
            }
        }
        KnowledgeAction::Inbox(InboxAction::Rm { id }) => {
            put("action", json!("inbox_discard"));
            put("id", json!(id));
        }
    }
    Ok(Value::Object(p))
}

/// The daemon's `{ok, result | errorCode, error}` as an envelope.
fn envelope_of(raw: &str) -> Value {
    let reply: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) if raw.trim().is_empty() => {
            return error_envelope(
                "daemon_too_old",
                "the running amuxd does not answer knowledge commands",
                Some("restart amuxd so it runs this version"),
                7,
                false,
            )
        }
        Err(e) => return unreachable(e),
    };
    if reply["ok"] == true {
        return success(reply["result"].clone());
    }
    let code = reply["errorCode"].as_str().unwrap_or("knowledge_failed");
    let message = reply["error"]
        .as_str()
        .unwrap_or("knowledge command failed");
    let (exit, next) = match code {
        "not_found" => (5, Some("amuxd knowledge inbox ls")),
        "already_exists" => (6, Some("--overwrite, or another --path")),
        "no_team" => (3, Some("amuxd init <invite-url>")),
        c if c.starts_with("invalid") || c == "not_pending" || c == "corrupt" => (2, None),
        _ => (7, None),
    };
    error_envelope(code, message, next, exit, false)
}

/// Run one command; returns the process exit status.
pub fn run(args: KnowledgeArgs) -> anyhow::Result<i32> {
    let line = match request(&args.action) {
        Ok(line) => line,
        Err(u) => return Ok(emit(&args.output, u.envelope())),
    };
    let sock = DaemonConfig::sock_path();
    let envelope = match super::sock::sock_roundtrip(&sock, &line.to_string()) {
        Ok(raw) => envelope_of(&raw),
        Err(e) => unreachable(e),
    };
    Ok(emit(&args.output, envelope))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn parse(words: &[&str]) -> KnowledgeAction {
        match crate::cli::Cli::try_parse_from(words).unwrap().command {
            crate::cli::Commands::Knowledge(args) => args.action,
            _ => unreachable!(),
        }
    }

    #[test]
    fn search_joins_the_words_and_caps_the_limit() {
        let line = request(&parse(&[
            "amuxd",
            "knowledge",
            "search",
            "渠道",
            "接入",
            "--limit",
            "50",
        ]))
        .unwrap();
        assert_eq!(line["action"], "search");
        assert_eq!(line["query"], "渠道 接入");
        assert_eq!(line["limit"], 8);
    }

    #[test]
    fn inbox_commands_name_the_daemon_actions() {
        let action = |words: &[&str]| request(&parse(words)).unwrap()["action"].clone();
        assert_eq!(action(&["amuxd", "knowledge", "inbox", "ls"]), "inbox_list");
        assert_eq!(
            action(&["amuxd", "knowledge", "inbox", "rm", "x"]),
            "inbox_discard"
        );
        assert_eq!(
            action(&["amuxd", "knowledge", "inbox", "discard", "x"]),
            "inbox_discard"
        );
        let publish = request(&parse(&[
            "amuxd",
            "knowledge",
            "inbox",
            "publish",
            "x",
            "--overwrite",
        ]))
        .unwrap();
        assert_eq!(publish["overwrite"], true);
    }

    #[test]
    fn daemon_errors_map_to_exit_codes() {
        let exit = |raw: &str| envelope_of(raw)["error"]["exit"].as_i64().unwrap();
        assert_eq!(
            exit(r#"{"ok":false,"errorCode":"not_found","error":"x"}"#),
            5
        );
        assert_eq!(
            exit(r#"{"ok":false,"errorCode":"already_exists","error":"x"}"#),
            6
        );
        assert_eq!(
            exit(r#"{"ok":false,"errorCode":"invalid_path","error":"x"}"#),
            2
        );
        assert_eq!(exit(""), 7);
        assert_eq!(
            envelope_of(r#"{"ok":true,"result":{"hits":[]}}"#)["data"]["hits"],
            json!([])
        );
    }
}
