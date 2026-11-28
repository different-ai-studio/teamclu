//! `amuxd session …` — the team's conversations, for agents first.
//!
//! Read another session's history, open a new one with someone (to hand a
//! piece of work to another agent, say), post into it, and keep its seats and
//! title in order. Every command acts as this daemon's agent account, so it
//! sees and changes what that account may: a session it is not in is a 403
//! or 404 from the Cloud API, not something this side decides.
//!
//! A thin client over the daemon's `/v1/team/sessions*`. People are named by
//! id or by name (`amuxd member` resolves them). Output: the `amuxd app`
//! contract.

use clap::{Args, Subcommand};
use serde_json::{json, Value};

use super::daemon_http::LocalDaemonClient;
use super::envelope::{emit, http_envelope, unreachable, usage, Usage};
use super::member::resolve_actor;

/// `ls` and `messages` without `--limit`.
const DEFAULT_PAGE_SIZE: u32 = 20;

#[derive(Args, Debug)]
pub struct SessionArgs {
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
    pub action: SessionAction,
}

#[derive(Subcommand, Debug)]
pub enum SessionAction {
    /// Sessions this agent is in, most recent first.
    ///
    /// Example: amuxd session ls --limit 10 -o table
    #[command(alias = "list")]
    Ls {
        /// all (default), regular or cron.
        #[arg(long)]
        kind: Option<String>,
        /// Page size (default 20).
        #[arg(long)]
        limit: Option<u32>,
        /// `nextCursor` from the previous page.
        #[arg(long)]
        cursor: Option<String>,
    },
    /// One session and who is in it.
    ///
    /// Example: amuxd session show <session-id>
    Show { session: String },
    /// A session's messages, newest first.
    ///
    /// Example: amuxd session messages <session-id> --limit 50
    Messages {
        session: String,
        /// Page size (default 20).
        #[arg(long)]
        limit: Option<u32>,
        /// `nextCursor` from the previous page.
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Open a session as this agent, with others seated in it.
    ///
    /// To hand work to another agent: create with it as --agent, then `send`
    /// the brief. --with seats people or agents by id or name; repeatable.
    ///
    /// Example: amuxd session create "整理周报" --agent 写作助手 --with 海港
    #[command(alias = "add")]
    Create {
        title: String,
        /// Seat this person or agent too (id or name); repeatable.
        #[arg(long = "with")]
        with: Vec<String>,
        /// The agent that answers by default (id or name). Default: this one.
        #[arg(long)]
        agent: Option<String>,
    },
    /// Post a message in a session as this agent.
    ///
    /// The text from --message, or from --message-file (`-` for stdin) for
    /// anything long or with quotes in it.
    ///
    /// Example: amuxd session send <session-id> --message "初稿已放到 team-documents/周报.md"
    Send {
        session: String,
        #[arg(long, conflicts_with = "message_file")]
        message: Option<String>,
        /// Read the message from a file (`-` for stdin).
        #[arg(long)]
        message_file: Option<String>,
    },
    /// Rename a session. A renamed title is kept; generated titles stop.
    ///
    /// Example: amuxd session update <session-id> --title "Q4 规划"
    #[command(alias = "edit")]
    Update {
        session: String,
        #[arg(long)]
        title: String,
    },
    /// Archive a session: it leaves everyone's list, its history stays.
    ///
    /// Example: amuxd session archive <session-id>
    Archive { session: String },
    /// Bring an archived session back.
    ///
    /// Example: amuxd session unarchive <session-id>
    Unarchive { session: String },
    /// Who sits in a session: add or remove people and agents.
    #[command(subcommand)]
    Participant(ParticipantAction),
}

#[derive(Subcommand, Debug)]
pub enum ParticipantAction {
    /// Seat a person or agent (id or name) in a session.
    ///
    /// Example: amuxd session participant add <session-id> 海港
    Add { session: String, who: String },
    /// Take a person or agent (id or name) out of a session.
    ///
    /// Example: amuxd session participant rm <session-id> 海港
    #[command(alias = "remove")]
    Rm { session: String, who: String },
}

fn enc(s: &str) -> String {
    urlencoding::encode(s.trim()).into_owned()
}

fn query(pairs: &[(&str, Option<String>)]) -> String {
    let parts: Vec<String> = pairs
        .iter()
        .filter_map(|(k, v)| {
            v.as_deref()
                .filter(|v| !v.trim().is_empty())
                .map(|v| format!("{k}={}", enc(v)))
        })
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

fn read_message(message: &Option<String>, file: &Option<String>) -> Result<String, Usage> {
    let text = match (message, file) {
        (Some(m), _) => m.clone(),
        (None, Some(path)) if path == "-" => {
            let mut s = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)
                .map_err(|e| usage("unreadable_file", format!("read stdin: {e}"), None))?;
            s
        }
        (None, Some(path)) => std::fs::read_to_string(path)
            .map_err(|e| usage("unreadable_file", format!("read {path}: {e}"), None))?,
        (None, None) => {
            return Err(usage(
                "missing_message",
                "pass --message or --message-file",
                Some("--message-file -"),
            ))
        }
    };
    if text.trim().is_empty() {
        return Err(usage("empty_message", "the message is empty", None));
    }
    Ok(text)
}

/// A session as `ls` lists it.
fn session_summary(s: &Value) -> Value {
    json!({
        "id": s["id"],
        "title": s["title"],
        "source": s["source"],
        "primaryAgentId": s["primaryAgentId"],
        "lastMessageAt": s["lastMessageAt"],
        "lastMessagePreview": s["lastMessagePreview"],
        "archivedAt": s["archivedAt"],
    })
}

/// A message as `messages` lists it: who said what, when. Metadata (tool
/// parts, traces) stays out.
fn message_summary(m: &Value) -> Value {
    json!({
        "id": m["id"],
        "senderActorId": m["senderActorId"],
        "kind": m["kind"],
        "content": m["content"],
        "replyToMessageId": m["replyToMessageId"],
        "createdAt": m["createdAt"],
    })
}

/// `items` of a page envelope mapped through `f`, the rest kept.
fn map_items(mut envelope: Value, f: fn(&Value) -> Value) -> Value {
    if let Some(items) = envelope["data"]["items"].as_array() {
        envelope["data"]["items"] = Value::Array(items.iter().map(f).collect());
    }
    envelope
}

async fn call(
    daemon: &LocalDaemonClient,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Value {
    http_envelope(
        daemon.send(method, path, body).await,
        Some("amuxd session ls"),
    )
}

async fn run_async(action: &SessionAction) -> Value {
    // Local input first: nothing is sent for a bad line.
    let message = match action {
        SessionAction::Send {
            message,
            message_file,
            ..
        } => match read_message(message, message_file) {
            Ok(text) => Some(text),
            Err(u) => return u.envelope(),
        },
        SessionAction::Ls {
            kind: Some(kind), ..
        } if !matches!(kind.as_str(), "all" | "regular" | "cron") => {
            return usage("invalid_kind", "--kind takes all, regular or cron", None).envelope()
        }
        _ => None,
    };
    let daemon = match LocalDaemonClient::connect("session-cli").await {
        Ok(d) => d,
        Err(e) => return unreachable(e),
    };
    use reqwest::Method;
    match action {
        SessionAction::Ls {
            kind,
            limit,
            cursor,
        } => {
            let path = format!(
                "/v1/team/sessions{}",
                query(&[
                    ("kind", kind.clone()),
                    (
                        "limit",
                        Some(limit.unwrap_or(DEFAULT_PAGE_SIZE).to_string())
                    ),
                    ("cursor", cursor.clone()),
                ])
            );
            map_items(
                call(&daemon, Method::GET, &path, None).await,
                session_summary,
            )
        }
        SessionAction::Show { session } => {
            call(
                &daemon,
                Method::GET,
                &format!("/v1/team/sessions/{}", enc(session)),
                None,
            )
            .await
        }
        SessionAction::Messages {
            session,
            limit,
            cursor,
        } => {
            let path = format!(
                "/v1/team/sessions/{}/messages{}",
                enc(session),
                query(&[
                    (
                        "limit",
                        Some(limit.unwrap_or(DEFAULT_PAGE_SIZE).to_string())
                    ),
                    ("cursor", cursor.clone()),
                ])
            );
            map_items(
                call(&daemon, Method::GET, &path, None).await,
                message_summary,
            )
        }
        SessionAction::Create { title, with, agent } => {
            let mut seats = Vec::new();
            for who in with {
                match resolve_actor(&daemon, who).await {
                    Ok(id) => seats.push(id),
                    Err(envelope) => return envelope,
                }
            }
            let mut body = json!({ "title": title, "participantActorIds": seats });
            if let Some(agent) = agent {
                match resolve_actor(&daemon, agent).await {
                    Ok(id) => {
                        if !seats.contains(&id) {
                            seats.push(id.clone());
                            body["participantActorIds"] = json!(seats);
                        }
                        body["primaryAgentActorId"] = json!(id);
                    }
                    Err(envelope) => return envelope,
                }
            }
            call(&daemon, Method::POST, "/v1/team/sessions", Some(body)).await
        }
        SessionAction::Send { session, .. } => {
            call(
                &daemon,
                Method::POST,
                &format!("/v1/team/sessions/{}/messages", enc(session)),
                Some(json!({ "content": message })),
            )
            .await
        }
        SessionAction::Update { session, title } => {
            call(
                &daemon,
                Method::PATCH,
                &format!("/v1/team/sessions/{}", enc(session)),
                Some(json!({ "title": title })),
            )
            .await
        }
        SessionAction::Archive { session } | SessionAction::Unarchive { session } => {
            let archived = matches!(action, SessionAction::Archive { .. });
            call(
                &daemon,
                Method::PATCH,
                &format!("/v1/team/sessions/{}", enc(session)),
                Some(json!({ "archived": archived })),
            )
            .await
        }
        SessionAction::Participant(ParticipantAction::Add { session, who }) => {
            let id = match resolve_actor(&daemon, who).await {
                Ok(id) => id,
                Err(envelope) => return envelope,
            };
            call(
                &daemon,
                Method::POST,
                &format!("/v1/team/sessions/{}/participants", enc(session)),
                Some(json!({ "actorId": id })),
            )
            .await
        }
        SessionAction::Participant(ParticipantAction::Rm { session, who }) => {
            let id = match resolve_actor(&daemon, who).await {
                Ok(id) => id,
                Err(envelope) => return envelope,
            };
            call(
                &daemon,
                Method::DELETE,
                &format!(
                    "/v1/team/sessions/{}/participants/{}",
                    enc(session),
                    enc(&id)
                ),
                None,
            )
            .await
        }
    }
}

/// Run one command; returns the process exit status.
pub fn run(args: SessionArgs) -> anyhow::Result<i32> {
    let rt = tokio::runtime::Runtime::new()?;
    let envelope = rt.block_on(run_async(&args.action));
    Ok(emit(&args.output, envelope))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn parse(words: &[&str]) -> SessionAction {
        match crate::cli::Cli::try_parse_from(words).unwrap().command {
            crate::cli::Commands::Session(args) => args.action,
            _ => unreachable!(),
        }
    }

    #[test]
    fn create_takes_repeated_with() {
        match parse(&[
            "amuxd", "session", "create", "周报", "--with", "海港", "--with", "Matt", "--agent",
            "助手",
        ]) {
            SessionAction::Create { title, with, agent } => {
                assert_eq!(title, "周报");
                assert_eq!(with, ["海港", "Matt"]);
                assert_eq!(agent.as_deref(), Some("助手"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_message_is_required_and_not_empty() {
        assert_eq!(
            read_message(&None, &None).unwrap_err().code,
            "missing_message"
        );
        assert_eq!(
            read_message(&Some("  ".into()), &None).unwrap_err().code,
            "empty_message"
        );
        assert_eq!(read_message(&Some("hi".into()), &None).unwrap(), "hi");
    }

    #[test]
    fn messages_keep_who_said_what_and_drop_metadata() {
        let row = message_summary(&json!({
            "id": "m1", "senderActorId": "a1", "kind": "text", "content": "hi",
            "createdAt": "2026-11-28T00:00:00Z", "metadata": { "parts": [1, 2, 3] },
        }));
        assert!(row.get("metadata").is_none());
        assert_eq!(row["content"], "hi");
    }

    #[test]
    fn page_items_are_summarised_and_the_cursor_kept() {
        let envelope = json!({ "v": 1, "ok": true, "data": {
            "items": [{ "id": "s1", "title": "t", "binding": { "x": 1 } }],
            "nextCursor": "c2",
        }});
        let out = map_items(envelope, session_summary);
        assert!(out["data"]["items"][0].get("binding").is_none());
        assert_eq!(out["data"]["nextCursor"], "c2");
    }

    #[test]
    fn the_old_verbs_still_parse() {
        assert!(matches!(
            parse(&["amuxd", "session", "list"]),
            SessionAction::Ls { .. }
        ));
        assert!(matches!(
            parse(&["amuxd", "session", "participant", "remove", "s", "x"]),
            SessionAction::Participant(ParticipantAction::Rm { .. })
        ));
    }
}
