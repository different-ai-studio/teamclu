//! `amuxd member …` — the team's people and agents, for agents first.
//!
//! What an agent needs before it can seat someone in a session, grant them an
//! app, or say who did what: an actor id. `show` takes a name as readily as
//! an id, and an ambiguous name is exit 5 with the candidates, never a guess.
//!
//! A thin client over the daemon's `/v1/team/members*`, which asks the Cloud
//! API as this daemon's agent account. Output: the `amuxd app` contract.

use clap::{Args, Subcommand};
use serde_json::{json, Value};

use super::daemon_http::LocalDaemonClient;
use super::envelope::{emit, error_envelope, http_envelope, success, unreachable, usage};

#[derive(Args, Debug)]
pub struct MemberArgs {
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
    pub action: MemberAction,
}

#[derive(Subcommand, Debug)]
pub enum MemberAction {
    /// The team's people and agents: id, kind, name, roles, status.
    ///
    /// Example: amuxd member ls --kind agent -o table
    #[command(alias = "list")]
    Ls {
        /// member or agent.
        #[arg(long)]
        kind: Option<String>,
        /// Only names containing this (case-insensitive).
        #[arg(long)]
        name: Option<String>,
    },
    /// One person or agent, by id or name (an ambiguous name lists the
    /// candidates and exits 5).
    ///
    /// Example: amuxd member show 海港
    Show { who: String },
    /// The agent this daemon acts as.
    ///
    /// Example: amuxd member whoami
    Whoami,
}

/// An actor as `ls` lists it. Contact details stay out of the list; `show`
/// has them.
fn summary(actor: &Value) -> Value {
    let status = if actor["kind"] == "agent" {
        &actor["agentStatus"]
    } else {
        &actor["memberStatus"]
    };
    json!({
        "id": actor["id"],
        "kind": actor["kind"],
        "displayName": actor["displayName"],
        "roles": actor["roles"],
        "status": status,
        "ownerMemberId": actor["agentOwnerMemberId"],
        "lastActiveAt": actor["lastActiveAt"],
    })
}

fn looks_like_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s.trim()).is_ok()
}

/// The actors whose name matches `name`: exact (case-insensitive) matches if
/// there are any, else those containing it.
fn matching<'a>(actors: &'a [Value], name: &str) -> Vec<&'a Value> {
    let needle = name.trim().to_lowercase();
    let label = |a: &Value| a["displayName"].as_str().unwrap_or("").to_lowercase();
    let exact: Vec<&Value> = actors.iter().filter(|a| label(a) == needle).collect();
    if !exact.is_empty() {
        return exact;
    }
    actors
        .iter()
        .filter(|a| label(a).contains(&needle))
        .collect()
}

/// Every team actor, or the envelope to print instead.
async fn all_actors(daemon: &LocalDaemonClient, kind: Option<&str>) -> Result<Vec<Value>, Value> {
    let path = match kind {
        Some(k) => format!("/v1/team/members?kind={}", urlencoding::encode(k)),
        None => "/v1/team/members".to_string(),
    };
    let envelope = http_envelope(daemon.send(reqwest::Method::GET, &path, None).await, None);
    if envelope["ok"] != true {
        return Err(envelope);
    }
    Ok(envelope["data"]["items"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}

/// `who` (an actor id, a name, or `me`) as an actor id, or the envelope to
/// print instead. Shared with `amuxd session`.
pub(crate) async fn resolve_actor(daemon: &LocalDaemonClient, who: &str) -> Result<String, Value> {
    let who = who.trim();
    if who.is_empty() {
        return Err(usage("invalid_actor", "an empty name is not a member", None).envelope());
    }
    if looks_like_uuid(who) {
        return Ok(who.to_string());
    }
    if who == "me" {
        let envelope = http_envelope(
            daemon
                .send(reqwest::Method::GET, "/v1/team/members/me", None)
                .await,
            None,
        );
        return envelope["data"]["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or(envelope);
    }
    let actors = all_actors(daemon, None).await?;
    let found = matching(&actors, who);
    match found.as_slice() {
        [one] => one["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| error_envelope("not_found", "that actor has no id", None, 5, false)),
        [] => Err(error_envelope(
            "not_found",
            &format!("no one in the team is called {who:?}"),
            Some("amuxd member ls"),
            5,
            false,
        )),
        many => {
            let mut envelope = error_envelope(
                "ambiguous",
                &format!(
                    "{} people or agents match {who:?}; pass one's id",
                    many.len()
                ),
                Some("amuxd member show <id>"),
                5,
                false,
            );
            envelope["error"]["candidates"] =
                Value::Array(many.iter().map(|a| summary(a)).collect());
            Err(envelope)
        }
    }
}

async fn run_async(action: &MemberAction) -> Value {
    if let MemberAction::Ls {
        kind: Some(kind), ..
    } = action
    {
        if !matches!(kind.as_str(), "member" | "agent") {
            return usage(
                "invalid_kind",
                "--kind takes member or agent",
                Some("--kind agent"),
            )
            .envelope();
        }
    }
    let daemon = match LocalDaemonClient::connect("member-cli").await {
        Ok(d) => d,
        Err(e) => return unreachable(e),
    };
    match action {
        MemberAction::Ls { kind, name } => {
            let actors = match all_actors(&daemon, kind.as_deref()).await {
                Ok(a) => a,
                Err(envelope) => return envelope,
            };
            let rows: Vec<Value> = match name.as_deref().filter(|n| !n.trim().is_empty()) {
                Some(name) => matching(&actors, name).into_iter().map(summary).collect(),
                None => actors.iter().map(summary).collect(),
            };
            success(json!({ "items": rows }))
        }
        MemberAction::Show { who } => {
            let id = match resolve_actor(&daemon, who).await {
                Ok(id) => id,
                Err(envelope) => return envelope,
            };
            http_envelope(
                daemon
                    .send(
                        reqwest::Method::GET,
                        &format!("/v1/team/members/{}", urlencoding::encode(&id)),
                        None,
                    )
                    .await,
                Some("amuxd member ls"),
            )
        }
        MemberAction::Whoami => http_envelope(
            daemon
                .send(reqwest::Method::GET, "/v1/team/members/me", None)
                .await,
            None,
        ),
    }
}

/// Run one command; returns the process exit status.
pub fn run(args: MemberArgs) -> anyhow::Result<i32> {
    let rt = tokio::runtime::Runtime::new()?;
    let envelope = rt.block_on(run_async(&args.action));
    Ok(emit(&args.output, envelope))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actors() -> Vec<Value> {
        vec![
            json!({ "id": "a1", "kind": "member", "displayName": "海港", "memberStatus": "active", "email": "x@y" }),
            json!({ "id": "a2", "kind": "agent", "displayName": "海港的助手", "agentStatus": "online", "agentOwnerMemberId": "a1" }),
            json!({ "id": "a3", "kind": "member", "displayName": "Matt" }),
        ]
    }

    #[test]
    fn an_exact_name_wins_over_names_containing_it() {
        let all = actors();
        let found = matching(&all, "海港");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["id"], "a1");
        assert_eq!(matching(&all, "matt")[0]["id"], "a3");
        assert_eq!(matching(&all, "助手")[0]["id"], "a2");
        assert!(matching(&all, "nobody").is_empty());
    }

    #[test]
    fn the_list_leaves_contact_details_out() {
        let row = summary(&actors()[0]);
        assert!(row.get("email").is_none());
        assert_eq!(row["status"], "active");
        let agent = summary(&actors()[1]);
        assert_eq!(agent["status"], "online");
        assert_eq!(agent["ownerMemberId"], "a1");
    }

    #[test]
    fn ids_are_taken_as_ids() {
        assert!(looks_like_uuid("0b9c7a3e-6a55-4d3c-9f0f-2d3c4b5a6e7f"));
        assert!(!looks_like_uuid("海港"));
    }
}
