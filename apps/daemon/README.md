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
| `remote-tools-mcp` | pi, as a stdio MCP server proxying client tools over MQTT RPC |
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
amuxd team secrets set --team-secret <64-hex>   # --team-id defaults to daemon.toml's
amuxd team secrets show                         # values masked
amuxd team secrets clear --force
```

Restart the daemon after `team secrets set`; the sync timer reads its
workspace list at startup.

## Config

`amuxd config` edits `~/.amuxd/daemon.toml` by default. Use
`--config <path>` to target another file.

```bash
amuxd config path
amuxd config list
amuxd config get mqtt.broker_url
amuxd config set mqtt.broker_url mqtts://broker.example.com:8883
amuxd config set idle_runtime_timeout_secs 1800
amuxd config unset idle_runtime_timeout_secs
```

Values are parsed as TOML literals. If a value is not valid TOML, it is written
as a string. Edits are validated against `DaemonConfig` before the file is
overwritten.

## Channels

```bash
amuxd channel list
amuxd channel bind wecom --bot-id <id> --secret <secret> [--encoding-aes-key <key>]
amuxd channel bind feishu --app-id <id> --app-secret <secret>
amuxd channel bind discord --bot-token <token> [--default-username <name>]
amuxd channel bind kook --bot-token <token>
amuxd channel bind wechat --ilink-account <account> --ilink-token <token>
amuxd channel bind seatalk --app-id <id> --app-secret <secret>
amuxd channel bind email --imap-host … --imap-port … --imap-user … --imap-pass … \
                         --smtp-host … --smtp-port … --smtp-user … --smtp-pass …
amuxd channel test <platform>     # are the credentials configured
amuxd channel unbind <platform>
amuxd channel reload              # make a running daemon re-read channel config
```

## Apps from the command line (for other agents)

`amuxd app` creates, deploys and inspects TeamClu apps, so an agent amuxd did
not start — Claude Code, Codex, a CI job — can publish one. It needs
`amuxd start` to be running and acts as **this daemon's agent account**: the
apps it creates belong to that agent, which can change, deploy and delete them.
A teammate's team app it can list, inspect and download, but not deploy; a
teammate's personal app it cannot see at all. Per-app access in TeamClu is
granted to members, never to an agent.

Every command prints JSON on stdout. A failure prints
`{"ok": false, "error": "…"}` and exits 1; the error names the next command to
run where there is one.

```bash
amuxd app list                                   # this team's apps, with local checkouts
amuxd app create --name 记账                      # starter template (static_web)
amuxd app create --name site --dir ./site        # an existing folder, used in place
amuxd app create --name api --git-remote <url>   # import a repository
amuxd app status                                 # the app whose checkout cwd is in
amuxd app deploy --app 记账                       # build here, publish
amuxd app deploy --app 记账 --use-app-code-domain # and move it to its app-code domain
amuxd app logs --id <app-id> --since 10 --kind all
amuxd app reseed --id <app-id>                   # re-write code that never got seeded
amuxd app download --app 记账                     # a teammate's app, onto this machine
amuxd app update --id <app-id> --visibility team --auth-mode platform
amuxd app undeploy --id <app-id>                 # site offline; app, code and data kept
amuxd app delete --id <app-id> --yes             # after undeploy; repository archived
```

With neither `--id` nor `--app`, a command acts on the app whose checkout the
current directory is in — except `undeploy` and `delete`, which need the app
named (`delete` also `--yes`). A deployed app is undeployed before it can be
deleted. A Gitea-hosted app deploys its pushed `HEAD`, so
commit and push before `deploy`; pass `--migration` when the deploy carries a
database migration. There is no approval prompt — whoever can run
this as the daemon's user can drive the daemon outright already.

The flows are `crates/teamclu-apps`, the same code the desktop's `manage_app`
MCP tool runs (as the signed-in user, with an approval dialog for deploys).
