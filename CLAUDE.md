# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For **UI / visual design** work, source-of-truth depends on the platform:

- **iOS** (`apps/ios/`): `apps/ios/DESIGN.md` — the Hai 灰 palette, wabi-sabi
  language, and SwiftUI implementation conventions (tokens, Hai sheets, iOS 26
  toolbar rules). Read this before touching anything in `apps/ios/`.
- **Web / desktop** (`packages/app/`): `AGENTS.md` at the repo root — the
  Editorial Calm direction (paper neutrals, coral accent, Chinese-first type).

## Git Workflow

**Never push directly to `main`.** All changes go through a feature branch and a
Pull Request:

1. Work on a task-scoped branch, never on `main`.
2. **Wait for the user to explicitly ask you to open the PR.** Do not `git push`
   or run `gh pr create` on your own initiative, even if the work looks "done"
   and tests pass. An explicit "open the PR", "ship it", "提 PR", or
   "可以提 PR 了" is the trigger; absent that, stop after committing and report
   back.
3. Do not merge or push to `main` directly, even for small fixes.

If `SDLC.md` exists at the repo root of this checkout, read it before starting
any change.
It is a local, git-ignored SDLC override that can layer additional personal
workflow (e.g. worktree + preview-integration conventions) on top of the rules
above. It is intentionally not checked in, so it only affects the workspace that
has it.

## Project Overview

TeamClu is an AI Agent Desktop Platform built with Tauri 2.0 + React 19. Three-column layout chat/collaboration tool with local AI agents, team sync (Git / OSS, owned by the amuxd daemon), and multi-channel gateways.

## Commands

```bash
# Install
pnpm install

# Dev
pnpm dev                    # Frontend only (Vite)
pnpm tauri:dev              # Full Tauri desktop app
pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding  # Dev: skip first-run wizards
pnpm rust:check             # Fast Rust compile check with shared .cargo-target
pnpm rust:build             # Rust build with shared .cargo-target
# Always go through these wrappers rather than bare cargo. `binaries/` is fully
# gitignored, but tauri.conf.json globs binaries/{cursor,claude}-bridge/**/* as
# bundle resources — on a fresh checkout that glob matches nothing and
# tauri-build fails before any crate compiles. The wrappers stage the bridge
# trees for real builds and drop the globs for analysis-only runs.
pnpm daemon:run             # Run amuxd from apps/daemon
pnpm ios:run                # Build, install, and launch iOS app on booted Simulator

# Build
pnpm tauri:build            # Production build
pnpm tauri:build:debug      # Debug build
pnpm tauri:build:mac:all    # macOS dual-arch (ARM64 + Intel)
pnpm daemon:build           # Build daemon
pnpm ios:build              # Build iOS simulator app

# Lint & Typecheck
pnpm lint                   # ESLint (frontend)
pnpm typecheck              # TypeScript strict
cargo fmt --check --manifest-path apps/desktop/Cargo.toml
pnpm rust:clippy            # clippy -D warnings; use this over bare `cargo clippy`,
                            # which fails on a fresh checkout (see rust:check below)

# Test
pnpm test:unit              # Vitest unit tests
pnpm test:e2e               # E2E (requires built app + tauri-mcp)
pnpm test:smoke             # Smoke subset
pnpm daemon:test            # Daemon tests
pnpm ios:test:core          # AMUXCore SwiftPM tests
pnpm ios:test               # iOS UI tests

# Deploy — automatic: push to main touching deploy/self-host/**, services/fc/**,
# or services/supabase/migrations/** triggers self-host-deploy.yml.
```

## Architecture

**Monorepo layout:**
- `packages/app/` — React 19 frontend (TypeScript, Tailwind 4, Zustand, Vite)
- `apps/desktop/` — Rust/Tauri backend (commands, RAG via Tantivy)
- `apps/daemon/` — amuxd daemon (opencode HTTP runtime, MQTT/Supabase bridge)
- `apps/ios/` — iOS app, Xcode project, and Swift packages
- `services/supabase/` — Supabase migrations, seed, and database tests
- `services/fc/` — Cloud API service (Node.js 20). Deploys two ways: as the
  self-host container (what runs today) or to Alibaba Function Compute (`s.yaml`)
- `crates/` — shared Rust crates (`teamclu-proto`, `teamclu-types`, `teamclu-transport`)
- `tests/` — E2E tests (tauri-mcp): smoke, regression, performance, functional

**Frontend key paths:**
- `packages/app/src/stores/` — Zustand stores (50+ files, global state)
- `packages/app/src/components/` — React components (editors, chat, diff)
- `packages/app/src/lib/` — Utilities (RAG, git, skills)
- `packages/app/src/hooks/` — React hooks

**Rust backend key paths:**
- `apps/desktop/src/commands/` — Tauri IPC commands (oss_sync/, team_share/, team_git.rs, gateway/, cron/, etc.)
- `apps/desktop/crates/teamclu-rag/` — Full-text search (Tantivy) + embeddings
- `apps/desktop/binaries/` — sidecar binaries (teamclu-introspect, etc.)

**Editor system:** Markdown (Tiptap) / HTML (Tiptap + sandbox preview) / Code (CodeMirror 6 + Shiki)

**Agent runtime:** the amuxd daemon drives official opencode (sst/opencode)
over `opencode serve` HTTP — a single global opencode instance per device, one
opencode session per TeamClu session. The former multi-agent ACP layer
(claude-code / codex adapters, per-runtime processes) has been removed. See
`docs/architecture/single-agent-opencode-http.md`.

## Backend Access Boundary — Cloud API is the only client backend

**`cloud_api` is the only backend kind for clients. The `supabase` and `pocketbase` backend kinds have been removed from `packages/app/`. Direct `@supabase/supabase-js` usage in client code is forbidden and enforced by a guardrail test (`packages/app/src/lib/backend/__tests__/no-supabase-import.test.ts`).**

The API contract is defined in `docs/openapi/teamclu-api.v1.yaml`. All business data operations must go through the TeamClu Cloud API (`/v1`) rather than direct Supabase client calls.

The Cloud API facade (`services/fc/lib/business-api.mjs`) is the canonical entry point for teams, sessions, messages, and invite operations. Clients (Tauri, Expo, iOS, daemon) should use their respective Cloud API providers:

- **Web/Desktop** (`packages/app/`): `CloudApiProvider` in `packages/app/src/lib/backend/provider.ts`
- **Expo** (`apps/expo/`): `createCloudSessionsApi` in `apps/expo/src/features/sessions/cloud-api.ts`
- **iOS** (`apps/ios/`): `CloudAPIClient` / `CloudAPIRepositories` in `apps/ios/Packages/AMUXCore/Sources/AMUXCore/CloudAPI/`
- **daemon** (`apps/daemon/`): `cloud_api` backend module in `apps/daemon/src/backend/cloud_api.rs`

Direct Supabase client usage (e.g. `supabase.from('sessions').select()`) is **reserved for internal FC repository implementation only** (`services/fc/lib/supabase-repo.mjs`). The FC facade forwards caller bearer tokens to Supabase, preserving RLS and auth semantics.

**When adding new business endpoints:**

1. Define the endpoint in `docs/openapi/teamclu-api.v1.yaml` first.
2. Implement the repository contract in `services/fc/lib/repository-contract.mjs`.
3. Add the route handler in `services/fc/lib/business-api.mjs`.
4. Implement the Supabase passthrough in `services/fc/lib/supabase-repo.mjs`.
5. Add tests in `services/fc/test/` (route, repository, contract).
6. Wire the endpoint into client Cloud API providers.

Do not bypass the Cloud API and call Supabase directly from client code. The facade exists so future backend replacements (MySQL, other storage) happen inside FC without client rewrites.

## Streaming Architecture (Critical)

Single source of truth principle — **never mix content sources**:
- **Streaming phase**: display from `streamingContent` (built from delta buffer)
- **Completed phase**: display from `message.content` (built from `message.parts[]`)
- **Never** write to `msg.content` during streaming
- **Never** use "longest content" strategy on completion

## Team Collaboration

Team sync is owned by the amuxd daemon (OSS engine). The legacy iroh-based P2P
mode has been removed, and so has git share — `git` is not invoked anywhere in
the product.

**There is no share-mode switch any more.** It was a one-shot cloud flag with no
producer left in the product — nothing shipped a call that set it — so every team
created since read as "off", and everything branching on it silently did nothing
(the sync button, the status poll, the daemon's sync, and a link sweep that
*removed* the team links it exists to create). Whether a team can sync is decided
by its **team secret**, checked where the sync runs
(`sync::dispatch::run_once`): no secret → nothing to encrypt or decrypt with →
`skipped`; secret → sync.

The `teams.share_mode` column and its Postgres enum are still there (in-use enum
values cannot be dropped, and dropping the column is a one-way door on
production data), but no code reads or writes them. Do not reintroduce a branch
on them.

Shared: `skills/`, `.mcp/`, `knowledge/`

## Versioning & Release

**Version numbers** — Desktop version must match across **five** places: `package.json`,
`apps/desktop/Cargo.toml`, `apps/desktop/tauri.conf.json`, `apps/daemon/Cargo.toml`
(bundled `amuxd` sidecar), and **`Cargo.lock`** (the `teamclu` and `amuxd` entries).

`Cargo.lock` is not optional: CI builds the daemon with `--locked`
(`cargo test/check/build -p amuxd --locked`), which fails outright when the lockfile
disagrees with the manifests. Verify with `cargo metadata --locked` before tagging.

**Release process:**
1. Bump desktop version in all 5 places above
2. Commit, push to main
3. `git tag v<desktop-version> && git push origin v<desktop-version>`
4. Tag push triggers `release.yml` (macOS desktop)

## iOS TestFlight Release

**Version file:** `apps/ios/project.yml` — `MARKETING_VERSION` (e.g. `1.2`) +
`CURRENT_PROJECT_VERSION`.

`CURRENT_PROJECT_VERSION` does NOT decide what TestFlight receives. fastlane asks
App Store Connect for the latest build number and increments that at build time, so
the uploaded build comes from ASC. This field governs local builds only. The two
drift far apart — on the 1.2 release the file said 25 while ASC was already at 52,
so the upload went out as 53. Setting it by hand cannot fix a rejected upload.

**Release process:**
1. Bump `MARKETING_VERSION` if the user-facing version changes; `CURRENT_PROJECT_VERSION`
   is cosmetic (see above) but keep it moving so the checked-in value stays honest
2. Commit and push to main
3. `git tag ios-v<version>-<build> && git push origin ios-v<version>-<build>`
   - Example: `git tag ios-v1.2-25 && git push origin ios-v1.2-25`
4. Tag push triggers `.github/workflows/testflight.yml` (runs `fastlane beta` on CI)

**Tag format must be `ios-v*`** — other formats (e.g. `ios-1.1.5-4`) do not trigger the workflow.

`testflight.yml` also runs on pushes to `main` touching `apps/ios/**`, so the normal
release flow (merge, then tag) fires it twice for the same commit. A `guard` job
handles that: after the debounce it checks whether HEAD carries an `ios-v*` tag and
stands down if so, leaving the tag's run to publish. A main push with no tag behind
it still releases as before.

## Deployment — one environment, two deploy targets

There is exactly **one** running environment: a single self-hosted ECS box. The
old hosted endpoints (`teamclu-sync` / `cloud.ucar.cc`) and the standalone RDS
instances are gone; do not reintroduce references to those hosts.

`services/fc/` is the Cloud API service, and it supports **two deploy targets**
from the same source:

- **self-host (what runs today)** — built as a container by
  `deploy/self-host/docker-compose.yml` (`build: context: ../../services/fc`).
  Env comes from the `fc:` service's `environment:` map, which is an explicit
  allowlist: a var absent from it never reaches the container.
- **Alibaba Function Compute** — `services/fc/s.yaml` (Serverless Devs) +
  `services/fc/deploy-aliyun-fc.sh`. Kept deliberately; the directory name is
  not vestigial. Deploying this way is manual, not wired to CI.

Both targets must keep working. When adding an FC env var, declare it in **both**
`s.yaml` and the compose `environment:` map, or it silently goes missing on one
of them.

**Host:** `47.112.210.217` (ECS `i-wz90nb0me448q3k22fxt`). Every subdomain below
resolves to it:

| URL | What |
|---|---|
| `https://api.teamclu-dev.ucar.cc` | Cloud API (`/v1`) — what clients call |
| `https://supabase.teamclu-dev.ucar.cc` | Supabase gateway (PostgREST / GoTrue / Storage) |
| `https://studio.teamclu-dev.ucar.cc` | Supabase Studio |
| `https://emqx.teamclu-dev.ucar.cc` | EMQX dashboard |
| `wss://mqtt.teamclu-dev.ucar.cc/mqtt` | MQTT over WSS (JWT access_token as password) |

The `-dev` in the hostnames is historical: **this is the only environment**, not
a dev tier alongside a production one. `build.config.production.json` and
`build.config.dev.json` both point here, which is correct.

**Deploy is automatic.** Pushing to `main` with changes under
`deploy/self-host/**`, `services/fc/**`, or `services/supabase/migrations/**`
triggers `.github/workflows/self-host-deploy.yml`, which SSHes to the box,
`git pull`s, `docker compose build fc`, `docker compose up -d`, waits for FC
health, then runs `run-e2e.sh`. Database migrations are applied by the `migrate`
compose service (`deploy/self-host/init/apply-migrations.sh`, tracked in
`_selfhost.schema_migrations`, idempotent, lexical order).

Credentials (SSH, Postgres, service-role key, dashboard logins) live in the
box's `.env` and GitHub Actions secrets — never in this repo.

Cloud API endpoints: see `docs/openapi/teamclu-api.v1.yaml` (the contract) —
`/v1/teams`, `/v1/sessions`, `/v1/messages`, `/v1/invites`, plus `/ai/*`.

Team share onboarding endpoints (see `docs/openapi/teamclu-api.v1.yaml`):

- `GET  /v1/teams/:id/workspace-config` — merged shape `{ syncMode, litellmTeamId, llm }`. The legacy `{ defaultWorkspaceId, pinnedWorkspaceIds }` shape now lives at `GET /v1/teams/:id/workspace-defaults` (PUT path is unchanged).
- `POST /v1/teams/:id/litellm/setup` — provisions LiteLLM and returns `{ aiGatewayEndpoint, litellmKey }`; 503 `litellm_unavailable` if FC is not configured.

<!-- seahelm:suggest:start -->
## Quick options for the user (seahelm)

When you finish a turn and can anticipate the user's likely next steps, end your
reply with one final plain-text line formatted exactly as:

    ::seahelm-suggest:: first option | second option

Give 2-5 short imperative phrases separated by ` | `. seahelm turns that line into
clickable buttons for the user. Make it the LAST line of your message; do NOT run
a tool or shell command to produce it.
<!-- seahelm:suggest:end -->
