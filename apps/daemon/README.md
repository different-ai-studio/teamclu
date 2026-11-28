# amuxd — AMUX Daemon

Rust daemon that runs the team's AI agents on this machine. It drives **pi**
over stdio JSONL host processes (ADR-0014), talks to clients over MQTT, reaches
business data only through the TeamClu Cloud API, and owns team sync and the
app checkouts. See `docs/architecture/pi-agent-backend.md`.

## Build and test

From the repo root, through the wrappers (bare `cargo` fails on a fresh
checkout — see the root `CLAUDE.md`):

```bash
pnpm daemon:build
pnpm daemon:run -- <args>   # e.g. pnpm daemon:run -- start
pnpm daemon:test
```

## First-time setup

1. In the desktop or iOS app, create an agent invite and copy the
   `teamclu://invite?...` link.
2. Run:

```bash
amuxd init "teamclu://invite?token=<token>&..."
```

The invite carries the Cloud API URL to claim it against. To point at another
deployment, set `TEAMCLU_CLOUD_API_URL` (process env, or `apps/daemon/.env` for
a dev build — see `.env.example`); there is no built-in default.

`init` prints the new `actor_id`, `team_id`, `display_name` and the path of
the `backend.toml` it wrote. Then:

```bash
amuxd start                 # foreground; `-d` to daemonize
amuxd install-service       # or: run it as a user-level background service
```

With the daemon running, `amuxd setup` opens a browser UI that covers
onboarding and every daemon setting (`--print-only` on a headless host).

## Commands

| Command | What it does |
|---|---|
| `start [-d] [--config <path>]` | Run the daemon; writes `amuxd.pid` while running |
| `stop` / `status` | Stop it (SIGTERM via the pidfile) / report whether it runs |
| `install-service` / `uninstall-service` | Register as a launchd / systemd-user / scheduled-task service and start it; or remove it |
| `update [--check] [--force] [--no-restart]` | Replace `<amuxd home>/bin/amuxd` with the latest build on its channel and restart. A running daemon checks by itself unless `[update] auto = false` |
| `init [<invite-url>]` | Onboard this daemon onto a team |
| `setup [--print-only]` | Open the browser setup UI of the running daemon |
| `manage` | Interactive menu for LLM providers and team secrets, for hosts with no browser |
| `clear [--force]` | Delete local daemon state; use before `init` against another team |
| `config …` | Read and edit `daemon.toml` (below) |
| `team secrets set\|show\|clear` | Provision the team secret a headless daemon cannot fetch (below) |
| `channel …` | Bind IM channels (below) |
| `app …` | Create, deploy and inspect TeamClu apps (below) |
| `doctor` | Install status of amuxd, the managed Node, pi and git, as JSON |
| `install-pi [--force]` | Install or repair the managed pi runtime: the pinned Node, then pi and the MCP SDK |

Internal, run by other programs rather than by hand:

| Command | Run by |
|---|---|
| `git-ssh --app <id>` | git, as `core.sshCommand` in an app checkout; fetches a just-in-time Gitea deploy key per connection |
| `git-credential --app <id> <op>` | git, as `credential.helper` in an app checkout reached over http(s) |
| `test-client watch\|start-agent\|announce\|e2e` | developers, to simulate an iOS client against the broker |

## Headless configuration

`amuxd manage` writes the same stores as the desktop app and the browser UI:
the workspace's `opencode.json` for LLM settings and
`~/.amuxd/team-secrets/<team>.enc` for secrets. Workspaces come from the cloud
(the same list as Desktop → Daemon → Workspace), and you pick one before
editing LLM settings or triggering a sync.

Non-interactive equivalents:

```bash
printf %s "$SECRET" | amuxd team secrets set --team-secret-file -   # --team-id defaults to daemon.toml's
amuxd team secrets show                         # values masked
amuxd team secrets rm --yes
```

Restart the daemon after `team secrets set`; the sync timer reads its
workspace list at startup.

## Config

`amuxd config` edits `~/.amuxd/daemon.toml` by default. Use
`--config <path>` to target another file.

```bash
amuxd config path
amuxd config ls
amuxd config show mqtt.broker_url
amuxd config set mqtt.broker_url mqtts://broker.example.com:8883
amuxd config set idle_runtime_timeout_secs 1800
amuxd config rm idle_runtime_timeout_secs
```

Values are parsed as TOML literals. If a value is not valid TOML, it is written
as a string. Edits are validated against `DaemonConfig` before the file is
overwritten.

## Channels

One set of commands, all through the running daemon (it stores credentials
encrypted in the team's secret store and reloads the channel). Settings are a
JSON object merged over the current ones; pass it on stdin so a secret never
sits on a command line. Field names are those `amuxd channel show` prints.

```bash
amuxd channel ls                  # every channel: enabled, stored credentials
amuxd channel show wecom          # one channel's settings (no credentials)
echo '{"enabled":true,"bot_id":"<id>","secret":"<secret>"}' \
  | amuxd channel set wecom --config-file -
echo '{"enabled":false}' | amuxd channel set wecom --config-file -
amuxd channel test <platform>     # configured, enabled, which credentials are stored
amuxd channel rm <platform>       # settings and stored credentials
amuxd channel reload              # make a running daemon re-read channel config
```

`list`, `bind` and `unbind` still parse (`bind`'s per-platform flags become a
`set`), but put secrets on the command line; prefer `set --config-file -`.

## Command conventions

Every agent-facing tree (`app`, `cron`, `skill`, `role`, `session`, `member`,
`workspace`, `knowledge`, `channel`, `config`, `team`) answers with one line of
JSON, `{"v":1,"ok":…}`, `-o table` for people, and the exit codes of
`amuxd app`. Verbs mean the same thing everywhere; see
`docs/specs/2026-11-28-amuxd-cli-conventions.md`.

```bash
amuxd session ls                                  # sessions this agent is in
amuxd session messages <id> --limit 50            # read one
amuxd session create "整理周报" --agent 写作助手    # hand work to another agent
amuxd session send <id> --message-file -          # post into it
amuxd member show 海港                             # a name → an actor id
amuxd workspace show                              # runtime status here
amuxd workspace models                            # models this workspace can use
amuxd knowledge search 渠道 接入                    # the team vault
amuxd knowledge inbox propose --title … --file page.md
```

## Apps from the command line

`amuxd app` is how agents create, deploy and manage TeamClu apps — the agents
amuxd runs, and any other (Claude Code, Codex, a CI job). It needs
`amuxd start` to be running and acts as **this daemon's agent account**. What
it may do is that account's grants on each app, and nothing else decides:
apps it creates are its own; an app someone granted it reaches it at that
level; its owner's apps reach it at the owner's level, up to deploy (never
delete, never managing access). There is no approval prompt — without the
grant a command exits 4 and says what is missing.

Every command prints one line of JSON, `{"v":1,"ok":true,"data":…}` or
`{"v":1,"ok":false,"error":{code,message,next,retryable,…}}`, and exits with
what happened: 0 done, 2 arguments, 3 no identity, 4 not allowed, 5 not found
or ambiguous, 6 conflict, 7 platform or daemon (see `retryable`), 8 outcome
unknown — check before retrying. `-o table` is for people; `amuxd app --help`
and `amuxd app <command> --help` are short and carry examples.

```bash
amuxd app ls -o table                          # this team's apps, with local checkouts
amuxd app create 记账                             # starter template (static_web)
amuxd app create site --from-dir ./site          # an existing folder, used in place
amuxd app show                                 # the app whose checkout cwd is in
amuxd app runtime --language node                # runtimes on offer, and this machine's tools
amuxd app deploy                                 # build here, publish; waits
amuxd app op wait <op>                           # pick a cut-off wait up again
amuxd app logs --since 10m --grep error
printf %s "$KEY" | amuxd app env set STRIPE_KEY --secret
amuxd app access grant 王芳 write                 # who may work on it
amuxd app gate rule set /admin --auth required --audience org   # who may open the site
amuxd app checkout clone --app 记账               # a teammate's app, onto this machine
amuxd app undeploy --app 记账                     # site offline; app, code and data kept
amuxd app rm --app 记账 --yes                 # after undeploy; repository archived
```

With neither `--id` nor `--app`, a command acts on the app whose checkout the
current directory is in — except `undeploy`, `delete` and `files purge`, which
need the app named (`delete` and `purge` also `--yes`). A Gitea-hosted app
deploys its pushed `HEAD`, so commit and push before `deploy`; pass
`--migration` when the deploy carries a database migration. `deploy` and
`undeploy` run inside amuxd: killing the command does not stop them, and
`--detach` returns the operation id at once.

The flows are `crates/teamclu-apps`, served at `/v1/app-ops`
(`src/http/app_ops.rs`); long operations are `src/http/app_op_jobs.rs`.
