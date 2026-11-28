//! `amuxd skill …` — personal skills and this agent's installed team Skills,
//! for agents first. It replaced the `teamclu-introspect` `manage_skills` and
//! `manage_team_skills` MCP tools: a skill is a folder, so the CLI reads the
//! folder instead of the model inlining every file into a tool call.
//!
//! Personal skills go through the daemon's control socket (`skills-manage`,
//! which writes `~/.agents/skills/<slug>/` and refreshes the runtimes); team
//! Skills through its HTTP API (`/v1/team/skills/*`). The output follows
//! `amuxd app`'s contract: one line of JSON, `{"v":1,"ok":…}`, exit 0 done,
//! 2 arguments, 4 not allowed, 5 not found, 6 conflict, 7 daemon.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use clap::{Args, Subcommand};
use serde_json::{json, Value};

use super::app::{emit, error_envelope};
use super::daemon_http::LocalDaemonClient;

#[derive(Args, Debug)]
pub struct SkillArgs {
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
    pub action: SkillAction,
}

#[derive(Subcommand, Debug)]
pub enum SkillAction {
    /// A personal skill's path and digest.
    ///
    /// Example: amuxd skill show weekly-report
    Show { slug: String },
    /// Create a personal skill from a folder holding SKILL.md.
    ///
    /// Stored under ~/.agents/skills/<slug>/; the frontmatter `name` must be
    /// the slug. Write the folder anywhere (e.g. /tmp/<slug>), then create.
    /// Never write skills under .pi/skills, .claude/skills or .opencode/skills.
    /// Existing or built-in skills cannot be overwritten.
    ///
    /// Example: amuxd skill create weekly-report --from-dir /tmp/weekly-report
    Create {
        slug: String,
        /// Folder with SKILL.md and any other files of the skill.
        #[arg(long)]
        from_dir: PathBuf,
    },
    /// Change a personal skill: files in the folder are added or replaced,
    /// files not in it are kept.
    ///
    /// Example: amuxd skill update weekly-report --from-dir /tmp/changes --delete old.md
    Update {
        slug: String,
        /// Folder with the files to add or replace (SKILL.md optional).
        #[arg(long)]
        from_dir: Option<PathBuf>,
        /// Skill-relative path to remove; repeatable.
        #[arg(long = "delete")]
        delete: Vec<String>,
        /// Refuse if the skill changed since this digest (from show/create).
        #[arg(long)]
        digest: Option<String>,
    },
    /// The team's Skills catalog, and editing installed team Skills.
    #[command(subcommand)]
    Team(TeamSkillAction),
    /// The skills marketplace: search it, and adopt a skill into the team.
    #[command(subcommand)]
    Market(MarketAction),
}

/// The categories the marketplace accepts (`TeamSkillCategory`).
const MARKET_CATEGORIES: &[&str] = &[
    "general",
    "coding",
    "devops",
    "data",
    "research",
    "writing",
    "communication",
    "integration",
];

#[derive(Subcommand, Debug)]
pub enum MarketAction {
    /// Search the marketplace catalog. With no query, lists the first page.
    ///
    /// Each row has `adoptedByTeam` when the team already adopted it.
    ///
    /// Example: amuxd skill market search review --category coding
    Search {
        /// Free-text query over name, summary and tags.
        query: Option<String>,
        /// general, coding, devops, data, research, writing, communication or integration.
        #[arg(long)]
        category: Option<String>,
        /// Page size, 1 to 200 (default 100).
        #[arg(long)]
        limit: Option<u32>,
        /// `nextCursor` from the previous reply.
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Adopt a marketplace skill into the team's Skills, following its
    /// marketplace updates. This does not install it for this agent: then run
    /// `amuxd skill team install <slug> --version <n>`.
    ///
    /// Example: amuxd skill market adopt review-checklist --slug team-review
    Adopt {
        /// The marketplace slug.
        marketplace_slug: String,
        /// The team slug to adopt it as (default: the marketplace slug).
        #[arg(long)]
        slug: Option<String>,
        /// The version to adopt (default: the catalog's latest).
        #[arg(long)]
        version: Option<i64>,
    },
}

#[derive(Subcommand, Debug)]
pub enum TeamSkillAction {
    /// The team's Skills, with which are installed for this agent.
    ///
    /// Example: amuxd skill team ls -o table
    Ls,
    /// Install a version of a team Skill for this agent.
    ///
    /// Example: amuxd skill team install review-checklist --version 3
    Install {
        slug: String,
        #[arg(long)]
        version: i64,
    },
    /// Uninstall a team Skill from this agent.
    ///
    /// Example: amuxd skill team uninstall review-checklist
    Uninstall { slug: String },
    /// This machine's working copy of an installed team Skill.
    ///
    /// Draft edits stay on this machine until published from the team Skills
    /// page: new sessions here use the draft; other members are unaffected.
    #[command(subcommand)]
    Draft(DraftAction),
}

#[derive(Subcommand, Debug)]
pub enum DraftAction {
    /// The draft: state, digest, SKILL.md and its file list.
    ///
    /// Example: amuxd skill team draft show review-checklist
    Show { slug: String },
    /// One draft file, in chunks.
    ///
    /// Example: amuxd skill team draft cat review-checklist scripts/run.py --offset 16384
    Cat {
        slug: String,
        /// Skill-relative path.
        path: String,
        /// Byte offset.
        #[arg(long, default_value_t = 0)]
        offset: u64,
        /// Max bytes (default 16384, at most 32768).
        #[arg(long)]
        limit: Option<u64>,
    },
    /// Edit the draft: files in the folder are added or replaced, files not
    /// in it are kept.
    ///
    /// Tell the user: new sessions on this machine use the draft; others are
    /// unaffected until it is published from the team Skills page.
    ///
    /// Example: amuxd skill team draft push review-checklist --digest sha256:… --from-dir /tmp/rc
    Push {
        slug: String,
        /// The digest `draft show` returned; refused if the draft changed since.
        #[arg(long)]
        digest: String,
        /// Folder with the files to add or replace (SKILL.md optional).
        #[arg(long)]
        from_dir: Option<PathBuf>,
        /// Skill-relative path to remove; repeatable.
        #[arg(long = "delete")]
        delete: Vec<String>,
    },
}

#[derive(Debug)]
struct Usage {
    code: &'static str,
    message: String,
    next: Option<String>,
}

fn usage(code: &'static str, message: impl Into<String>, next: Option<&str>) -> Usage {
    Usage {
        code,
        message: message.into(),
        next: next.map(str::to_owned),
    }
}

/// A skill folder read for the wire: SKILL.md's text and every other file.
#[derive(Debug, Default)]
struct Pack {
    content: String,
    files: Vec<Value>,
}

/// Read `dir` the way the daemon wants a pack. Hidden entries (`.git`,
/// `.DS_Store`) are skipped. A file that is not UTF-8 goes as base64 when
/// `binary` allows it (team drafts), and is refused otherwise.
fn read_pack(dir: &Path, binary: bool) -> Result<Pack, Usage> {
    if !dir.is_dir() {
        return Err(usage(
            "not_a_folder",
            format!("{} is not a folder", dir.display()),
            None,
        ));
    }
    let mut pack = Pack::default();
    let walker = walkdir::WalkDir::new(dir)
        .min_depth(1)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'));
    for entry in walker {
        let entry = entry.map_err(|e| usage("unreadable_file", e.to_string(), None))?;
        if entry.file_type().is_dir() {
            continue;
        }
        if !entry.file_type().is_file() {
            return Err(usage(
                "not_a_file",
                format!(
                    "{} is a link or special file; skills hold plain files",
                    entry.path().display()
                ),
                None,
            ));
        }
        let rel = entry
            .path()
            .strip_prefix(dir)
            .unwrap_or(entry.path())
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let bytes = std::fs::read(entry.path()).map_err(|e| {
            usage(
                "unreadable_file",
                format!("read {}: {e}", entry.path().display()),
                None,
            )
        })?;
        let text = String::from_utf8(bytes);
        if rel == "SKILL.md" {
            pack.content =
                text.map_err(|_| usage("invalid_skill_md", "SKILL.md is not UTF-8 text", None))?;
            continue;
        }
        match text {
            Ok(text) => pack
                .files
                .push(json!({ "path": rel, "content": text, "encoding": "utf8" })),
            Err(e) if binary => pack.files.push(json!({
                "path": rel,
                "content": base64::engine::general_purpose::STANDARD.encode(e.into_bytes()),
                "encoding": "base64",
            })),
            Err(_) => {
                return Err(usage(
                    "binary_file",
                    format!("{rel} is not UTF-8 text; personal skills hold text files only"),
                    None,
                ))
            }
        }
    }
    Ok(pack)
}

fn urlencode(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

/// What one command sends.
#[derive(Debug, PartialEq)]
enum Request {
    /// A `skills-manage` line on the control socket.
    Sock(Value),
    /// A daemon HTTP call.
    Http {
        method: reqwest::Method,
        path: String,
        body: Option<Value>,
    },
}

fn build(action: &SkillAction, workspace: &Path) -> Result<Request, Usage> {
    let sock = |mut v: Value| {
        v["cmd"] = json!("skills-manage");
        v["workspace_path"] = json!(workspace.to_string_lossy());
        Request::Sock(v)
    };
    let http = |method, path: String, body| Request::Http { method, path, body };
    Ok(match action {
        SkillAction::Show { slug } => sock(json!({ "action": "get", "slug": slug })),
        SkillAction::Create { slug, from_dir } => {
            let pack = read_pack(from_dir, false)?;
            if pack.content.trim().is_empty() {
                return Err(usage(
                    "missing_skill_md",
                    format!("{} has no SKILL.md", from_dir.display()),
                    None,
                ));
            }
            sock(json!({
                "action": "create",
                "slug": slug,
                "content": pack.content,
                "files": pack.files,
            }))
        }
        SkillAction::Update {
            slug,
            from_dir,
            delete,
            digest,
        } => {
            let pack = match from_dir {
                Some(dir) => read_pack(dir, false)?,
                None => Pack::default(),
            };
            if pack.content.is_empty() && pack.files.is_empty() && delete.is_empty() {
                return Err(usage(
                    "nothing_to_change",
                    "update needs --from-dir or --delete",
                    Some("amuxd skill update --help"),
                ));
            }
            let mut body = json!({
                "action": "update",
                "slug": slug,
                "content": pack.content,
                "files": pack.files,
                "deleteFiles": delete,
            });
            if let Some(d) = digest {
                body["expectedDigest"] = json!(d);
            }
            sock(body)
        }
        SkillAction::Market(MarketAction::Search {
            query,
            category,
            limit,
            cursor,
        }) => {
            if let Some(category) = category {
                if !MARKET_CATEGORIES.contains(&category.as_str()) {
                    return Err(usage(
                        "invalid_category",
                        format!("category must be one of: {}", MARKET_CATEGORIES.join(", ")),
                        Some("amuxd skill market search --help"),
                    ));
                }
            }
            if let Some(limit) = limit {
                if !(1..=200).contains(limit) {
                    return Err(usage(
                        "invalid_limit",
                        "--limit must be from 1 to 200",
                        None,
                    ));
                }
            }
            let mut qs: Vec<String> = Vec::new();
            for (key, value) in [
                ("q", query.as_deref()),
                ("category", category.as_deref()),
                ("cursor", cursor.as_deref()),
            ] {
                if let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) {
                    qs.push(format!("{key}={}", urlencode(value)));
                }
            }
            if let Some(limit) = limit {
                qs.push(format!("limit={limit}"));
            }
            let path = if qs.is_empty() {
                "/v1/team/marketplace/skills".to_string()
            } else {
                format!("/v1/team/marketplace/skills?{}", qs.join("&"))
            };
            http(reqwest::Method::GET, path, None)
        }
        SkillAction::Market(MarketAction::Adopt {
            marketplace_slug,
            slug,
            version,
        }) => {
            let marketplace_slug = marketplace_slug.trim();
            if marketplace_slug.is_empty() {
                return Err(usage(
                    "missing_slug",
                    "the marketplace slug must not be empty",
                    Some("amuxd skill market search <query>"),
                ));
            }
            if let Some(version) = version {
                if *version < 1 {
                    return Err(usage(
                        "invalid_version",
                        "--version must be at least 1",
                        None,
                    ));
                }
            }
            let mut body = json!({ "marketplaceSlug": marketplace_slug });
            if let Some(slug) = slug {
                body["slug"] = json!(slug);
            }
            if let Some(version) = version {
                body["version"] = json!(version);
            }
            http(
                reqwest::Method::POST,
                "/v1/team/marketplace/adopt".into(),
                Some(body),
            )
        }
        SkillAction::Team(TeamSkillAction::Ls) => {
            http(reqwest::Method::GET, "/v1/team/skills".into(), None)
        }
        SkillAction::Team(TeamSkillAction::Install { slug, version }) => {
            if *version < 1 {
                return Err(usage(
                    "invalid_version",
                    "--version must be at least 1",
                    None,
                ));
            }
            http(
                reqwest::Method::PUT,
                format!("/v1/team/skills/{}/install", urlencode(slug)),
                Some(json!({ "slug": slug, "version": version })),
            )
        }
        SkillAction::Team(TeamSkillAction::Uninstall { slug }) => http(
            reqwest::Method::DELETE,
            format!("/v1/team/skills/{}/install", urlencode(slug)),
            None,
        ),
        SkillAction::Team(TeamSkillAction::Draft(DraftAction::Show { slug })) => http(
            reqwest::Method::GET,
            format!("/v1/team/skills/{}/draft", urlencode(slug)),
            None,
        ),
        SkillAction::Team(TeamSkillAction::Draft(DraftAction::Cat {
            slug,
            path,
            offset,
            limit,
        })) => {
            let mut qs = format!(
                "/v1/team/skills/{}/draft/file?path={}",
                urlencode(slug),
                urlencode(path)
            );
            if *offset > 0 {
                qs.push_str(&format!("&offset={offset}"));
            }
            if let Some(limit) = limit {
                qs.push_str(&format!("&limit={limit}"));
            }
            http(reqwest::Method::GET, qs, None)
        }
        SkillAction::Team(TeamSkillAction::Draft(DraftAction::Push {
            slug,
            digest,
            from_dir,
            delete,
        })) => {
            let pack = match from_dir {
                Some(dir) => read_pack(dir, true)?,
                None => Pack::default(),
            };
            if pack.content.is_empty() && pack.files.is_empty() && delete.is_empty() {
                return Err(usage(
                    "nothing_to_change",
                    "push needs --from-dir or --delete",
                    Some("amuxd skill team draft push --help"),
                ));
            }
            let mut body = json!({
                "slug": slug,
                "files": pack.files,
                "deleteFiles": delete,
                "expectedDigest": digest,
            });
            if !pack.content.is_empty() {
                body["content"] = json!(pack.content);
            }
            http(
                reqwest::Method::PUT,
                format!("/v1/team/skills/{}/draft", urlencode(slug)),
                Some(body),
            )
        }
    })
}

/// A `skills-manage` reply as an envelope: `{ok, result, partialFailures}`
/// or `{ok:false, error, errorCode}`.
fn sock_envelope(raw: &str) -> Value {
    let Ok(reply) = serde_json::from_str::<Value>(raw) else {
        return error_envelope(
            "daemon_error",
            &format!("amuxd answered something that is not JSON: {raw}"),
            Some("amuxd update"),
            7,
            false,
        );
    };
    if reply["ok"] == true {
        let mut data = reply.get("result").cloned().unwrap_or(Value::Null);
        if let Some(failures) = reply["partialFailures"]
            .as_array()
            .filter(|f| !f.is_empty())
        {
            data["partialFailures"] = Value::Array(failures.clone());
        }
        return json!({ "v": 1, "ok": true, "data": data });
    }
    let code = reply["errorCode"].as_str().unwrap_or("skill_write_failed");
    let message = reply["error"].as_str().unwrap_or("skill operation failed");
    let (exit, next) = skill_error_exit(code);
    error_envelope(code, message, next, exit, false)
}

fn skill_error_exit(code: &str) -> (i32, Option<&'static str>) {
    match code {
        "skill_not_found" => (5, None),
        "skill_changed" => (
            6,
            Some("amuxd skill show <slug>, then retry with its digest"),
        ),
        "skill_already_exists" => (6, Some("amuxd skill update <slug> --from-dir <dir>")),
        "team_skill_read_only" => (4, Some("amuxd skill team draft push <slug> …")),
        "builtin_skill_read_only" => (4, None),
        "invalid_skill_slug"
        | "invalid_skill_frontmatter"
        | "invalid_skill_file_path"
        | "skill_pack_too_large" => (2, None),
        _ => (7, None),
    }
}

fn http_envelope(outcome: anyhow::Result<Result<Value, (u16, String)>>) -> Value {
    match outcome {
        Ok(Ok(value)) => json!({ "v": 1, "ok": true, "data": value }),
        // An unclaimed daemon answers team calls with a 422; it is not the
        // caller's arguments but this daemon having no team identity.
        Ok(Err((_, detail))) if detail.contains("not onboarded") => error_envelope(
            "not_onboarded",
            &detail,
            Some("amuxd init <invite-url>"),
            3,
            false,
        ),
        Ok(Err((status, detail))) => {
            let (code, exit, retryable, next) = match status {
                400 | 422 => ("invalid", 2, false, None),
                401 => ("daemon_unauthorized", 3, false, None),
                403 => ("forbidden", 4, false, None),
                404 => ("not_found", 5, false, Some("amuxd skill team ls")),
                409 => (
                    "draft_changed",
                    6,
                    false,
                    Some("amuxd skill team draft show <slug>, then retry with its digest"),
                ),
                503 => ("daemon_unavailable", 7, true, None),
                _ => ("daemon_error", 7, false, None),
            };
            error_envelope(code, &detail, next, exit, retryable)
        }
        Err(e) => unreachable_envelope(e),
    }
}

fn unreachable_envelope(e: impl std::fmt::Display) -> Value {
    error_envelope(
        "daemon_unreachable",
        &format!("the local amuxd did not answer: {e}"),
        Some("amuxd status"),
        7,
        true,
    )
}

/// Run one command; returns the process exit status.
pub fn run(args: SkillArgs) -> anyhow::Result<i32> {
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let request = match build(&args.action, &workspace) {
        Ok(r) => r,
        Err(u) => {
            return Ok(emit(
                &args.output,
                error_envelope(u.code, &u.message, u.next.as_deref(), 2, false),
            ))
        }
    };
    let envelope = match request {
        Request::Sock(line) => {
            let sock = crate::config::DaemonConfig::sock_path();
            // A big pack plus the runtime refresh can take a while.
            match super::sock::sock_roundtrip_with_read_timeout(
                &sock,
                &line.to_string(),
                std::time::Duration::from_secs(120),
            ) {
                Ok(raw) => sock_envelope(&raw),
                Err(e) => unreachable_envelope(e),
            }
        }
        Request::Http { method, path, body } => {
            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
                match LocalDaemonClient::connect("skill-cli").await {
                    Ok(daemon) => http_envelope(daemon.send(method, &path, body).await),
                    Err(e) => unreachable_envelope(e),
                }
            })
        }
    };
    Ok(emit(&args.output, envelope))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn parse(words: &[&str]) -> SkillAction {
        match crate::cli::Cli::try_parse_from(words).unwrap().command {
            crate::cli::Commands::Skill(args) => args.action,
            _ => unreachable!(),
        }
    }

    fn pack_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("SKILL.md"),
            "---\nname: demo\ndescription: d\n---\n",
        )
        .unwrap();
        std::fs::create_dir(dir.path().join("scripts")).unwrap();
        std::fs::write(dir.path().join("scripts/run.py"), "print(1)\n").unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), "x").unwrap();
        dir
    }

    #[test]
    fn create_reads_the_folder_into_one_skills_manage_line() {
        let dir = pack_dir();
        let action = parse(&[
            "amuxd",
            "skill",
            "create",
            "demo",
            "--from-dir",
            dir.path().to_str().unwrap(),
        ]);
        let Request::Sock(line) = build(&action, Path::new("/ws")).unwrap() else {
            panic!("create goes over the socket")
        };
        assert_eq!(line["cmd"], "skills-manage");
        assert_eq!(line["workspace_path"], "/ws");
        assert_eq!(line["action"], "create");
        assert!(line["content"].as_str().unwrap().contains("name: demo"));
        assert_eq!(
            line["files"],
            json!([{ "path": "scripts/run.py", "content": "print(1)\n", "encoding": "utf8" }])
        );
    }

    #[test]
    fn create_needs_skill_md_and_text() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        let action = parse(&[
            "amuxd",
            "skill",
            "create",
            "demo",
            "--from-dir",
            dir.path().to_str().unwrap(),
        ]);
        assert_eq!(
            build(&action, Path::new("/ws")).unwrap_err().code,
            "missing_skill_md"
        );
        std::fs::write(dir.path().join("SKILL.md"), "---\nname: demo\n---\n").unwrap();
        std::fs::write(dir.path().join("logo.png"), [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(
            build(&action, Path::new("/ws")).unwrap_err().code,
            "binary_file"
        );
    }

    #[test]
    fn a_team_draft_push_sends_binary_as_base64_and_the_digest() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("logo.png"), [0xff, 0xfe]).unwrap();
        let action = parse(&[
            "amuxd",
            "skill",
            "team",
            "draft",
            "push",
            "rc",
            "--digest",
            "sha256:ab",
            "--from-dir",
            dir.path().to_str().unwrap(),
            "--delete",
            "old.md",
        ]);
        let Request::Http { method, path, body } = build(&action, Path::new("/ws")).unwrap() else {
            panic!("team drafts go over HTTP")
        };
        assert_eq!(method, reqwest::Method::PUT);
        assert_eq!(path, "/v1/team/skills/rc/draft");
        assert_eq!(
            body.unwrap(),
            json!({
                "slug": "rc",
                "files": [{ "path": "logo.png", "content": "//4=", "encoding": "base64" }],
                "deleteFiles": ["old.md"],
                "expectedDigest": "sha256:ab",
            })
        );
    }

    #[test]
    fn an_update_with_nothing_in_it_is_refused() {
        let action = parse(&["amuxd", "skill", "update", "demo"]);
        assert_eq!(
            build(&action, Path::new("/ws")).unwrap_err().code,
            "nothing_to_change"
        );
    }

    #[test]
    fn market_search_builds_the_query_string_and_checks_its_flags() {
        let action = parse(&[
            "amuxd",
            "skill",
            "market",
            "search",
            "代码 审查",
            "--category",
            "coding",
            "--limit",
            "5",
        ]);
        assert_eq!(
            build(&action, Path::new("/ws")).unwrap(),
            Request::Http {
                method: reqwest::Method::GET,
                path: "/v1/team/marketplace/skills?q=%E4%BB%A3%E7%A0%81%20%E5%AE%A1%E6%9F%A5&category=coding&limit=5".into(),
                body: None,
            }
        );
        let bare = parse(&["amuxd", "skill", "market", "search"]);
        assert_eq!(
            build(&bare, Path::new("/ws")).unwrap(),
            Request::Http {
                method: reqwest::Method::GET,
                path: "/v1/team/marketplace/skills".into(),
                body: None,
            }
        );
        let bad_category = parse(&["amuxd", "skill", "market", "search", "--category", "games"]);
        assert_eq!(
            build(&bad_category, Path::new("/ws")).unwrap_err().code,
            "invalid_category"
        );
        let bad_limit = parse(&["amuxd", "skill", "market", "search", "--limit", "0"]);
        assert_eq!(
            build(&bad_limit, Path::new("/ws")).unwrap_err().code,
            "invalid_limit"
        );
    }

    #[test]
    fn market_adopt_sends_only_the_fields_given() {
        let action = parse(&["amuxd", "skill", "market", "adopt", "review-checklist"]);
        assert_eq!(
            build(&action, Path::new("/ws")).unwrap(),
            Request::Http {
                method: reqwest::Method::POST,
                path: "/v1/team/marketplace/adopt".into(),
                body: Some(json!({ "marketplaceSlug": "review-checklist" })),
            }
        );
        let renamed = parse(&[
            "amuxd",
            "skill",
            "market",
            "adopt",
            "review-checklist",
            "--slug",
            "team-review",
            "--version",
            "3",
        ]);
        let Request::Http { body, .. } = build(&renamed, Path::new("/ws")).unwrap() else {
            panic!("adopt goes over HTTP")
        };
        assert_eq!(
            body.unwrap(),
            json!({
                "marketplaceSlug": "review-checklist",
                "slug": "team-review",
                "version": 3,
            })
        );
        let blank = parse(&["amuxd", "skill", "market", "adopt", " "]);
        assert_eq!(
            build(&blank, Path::new("/ws")).unwrap_err().code,
            "missing_slug"
        );
    }

    #[test]
    fn draft_cat_builds_the_chunked_read() {
        let action = parse(&[
            "amuxd",
            "skill",
            "team",
            "draft",
            "cat",
            "rc",
            "scripts/run me.py",
            "--offset",
            "10",
        ]);
        assert_eq!(
            build(&action, Path::new("/ws")).unwrap(),
            Request::Http {
                method: reqwest::Method::GET,
                path: "/v1/team/skills/rc/draft/file?path=scripts%2Frun%20me.py&offset=10".into(),
                body: None,
            }
        );
    }

    #[test]
    fn sock_replies_become_envelopes_with_exits() {
        let ok = sock_envelope(
            r#"{"ok":true,"result":{"slug":"demo","digest":"sha256:1"},"partialFailures":[{"errorCode":"skill_refresh_failed","message":"m"}]}"#,
        );
        assert_eq!(ok["data"]["slug"], "demo");
        assert_eq!(
            ok["data"]["partialFailures"][0]["errorCode"],
            "skill_refresh_failed"
        );
        let exists = sock_envelope(
            r#"{"ok":false,"error":"skill demo exists","errorCode":"skill_already_exists"}"#,
        );
        assert_eq!(exists["error"]["exit"], 6);
        assert_eq!(exists["error"]["code"], "skill_already_exists");
    }

    #[test]
    fn an_unclaimed_daemon_is_no_identity_not_bad_arguments() {
        let reply = http_envelope(Ok(Err((422, "daemon is not onboarded to a team".into()))));
        assert_eq!(reply["error"]["exit"], 3);
        assert_eq!(reply["error"]["code"], "not_onboarded");
        let bad = http_envelope(Ok(Err((422, "slug is required".into()))));
        assert_eq!(bad["error"]["exit"], 2);
    }
}
