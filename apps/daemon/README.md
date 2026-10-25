# amuxd — AMUX Daemon

Rust daemon that spawns and manages AI coding agents (Claude Code via ACP/stdio), publishes events over MQTT, and syncs state to Supabase.

## Build prerequisites

`amuxd init` reads the Supabase project URL and anon key from the environment. Set:

```bash
export SUPABASE_URL=https://srhaytajyfrniuvnkfpd.supabase.co
export SUPABASE_ANON_KEY=<anon key from Supabase dashboard or amux-api/.env>
```

Before running `amuxd init`.

### Recommended setup

Copy `daemon/.env.example` to `daemon/.env` and fill in the values, then either:

- Source it before init: `source daemon/.env && cargo run -- init <invite-url>`
- Or use [direnv](https://direnv.net/): place a `.envrc` in `daemon/` with `dotenv .env`

The `.env` file is gitignored and must not be committed.

## Build

```bash
cd daemon && cargo build
```

## First-time setup (daemon onboarding)

1. On the owner's iOS device, create an agent invite — copy the `teamclu://invite?...` deeplink.
2. Run:

```bash
./target/release/amuxd init "teamclu://invite?token=<token>&broker=<mqtt-url>&username=<user>&password=<pass>"
```

Expected output: `Daemon onboarded. actor_id=<uuid> team_id=<uuid> display_name=<name> config=<path>`

This writes `~/.amuxd/supabase.toml` with the daemon's credentials.

## Run

```bash
./target/release/amuxd start
```

## Headless configuration (no GUI)

After onboarding with `amuxd init`, use the interactive menu for LLM providers
and team-share secrets on servers without a browser:

```bash
./target/release/amuxd manage
```

This writes the same stores as the desktop app and the browser setup UI
(`<workspace>/opencode.json`, `~/.amuxd/team-secrets/`). Workspaces are loaded
from the cloud (same list as Desktop → Daemon → Workspace) and you pick one
before editing LLM or triggering sync. Onboarding stays on `amuxd init`.

Non-interactive equivalents:

```bash
amuxd team secrets set --team-secret <64-hex> [--git-credential-file ~/.ssh/id_ed25519]
amuxd config set …   # daemon.toml
```

## Apps from the command line (for other agents)

`amuxd app` creates, deploys and inspects TeamClu apps, so an agent amuxd did
not start — Claude Code, Codex, a CI job — can publish one. It needs
`amuxd start` to be running and acts as **this daemon's agent account**: the
apps it creates belong to that agent, and a member's personal app is invisible
to it until the member grants it access in TeamClu.

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
amuxd app logs --id <app-id> --since 10 --kind all
amuxd app reseed --id <app-id>                   # re-write code that never got seeded
amuxd app download --app 记账                     # a teammate's app, onto this machine
amuxd app update --id <app-id> --visibility team --auth-mode platform
amuxd app delete --id <app-id> --yes             # site offline, repository archived
```

With neither `--id` nor `--app`, a command acts on the app whose checkout the
current directory is in — except `delete`, which needs the app named and
`--yes`. A Gitea-hosted app deploys its pushed `HEAD`, so
commit and push before `deploy`. There is no approval prompt — whoever can run
this as the daemon's user can drive the daemon outright already.

The flows are `crates/teamclu-apps`, the same code the desktop's `manage_app`
MCP tool runs (as the signed-in user, with an approval dialog for deploys).

## Config

`amuxd config` edits `~/.amuxd/daemon.toml` by default. Use
`--config <path>` to target another file.

```bash
amuxd config path
amuxd config list
amuxd config get mqtt.broker_url
amuxd config set mqtt.broker_url mqtts://broker.example.com:8883
amuxd config set idle_runtime_timeout_secs 1800
amuxd config set agents.codex.binary codex
amuxd config set agents.codex.default_flags '["--foo", "bar"]'
amuxd config unset idle_runtime_timeout_secs
```

Values are parsed as TOML literals. If a value is not valid TOML, it is written
as a string. Edits are validated against `DaemonConfig` before the file is
overwritten.

## Test

```bash
cd daemon && cargo test
```
