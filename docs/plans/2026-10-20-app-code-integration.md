# App-code integration implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. The user
> explicitly authorized resolving integration conflicts; execute this maintenance
> continuation of the approved app-code specification without adding features.

**Goal:** Integrate main `ba604cf9dda7a8f39bd59d576daca19ab91587be` into
`codex/app-public-code-implementation`, resolving conflicts without losing either
current-main behavior or the approved app-code feature.

**Architecture:** One serial merge task owns all coupled backend, client and
contract resolutions. Independently review its integration changes and the final
feature diff against pinned main. Keep source integration separate from rollout.

**Tech stack:** TypeScript Cloud API/React, Rust/Tauri, OpenAPI, PostgreSQL.

**Spec:** `docs/specs/2026-10-19-app-public-code-design.md`.

## Global constraints

- Permanent unique random 12-character lowercase Crockford Base32 app codes;
  DNS is `a-<code>.<APPS_PUBLIC_DOMAIN>`; codes are identifiers, not authorization.
- Existing apps retain current domains until explicit approved deployment succeeds.
  Checkbox starts unchecked and appears only for explicit legacy mode plus a live
  deployment with a different candidate domain. Agent input cannot preselect it.
- Domain choice belongs to its matching deploy token. Only successful finalization
  activates code mode; failed, cancelled and unchecked attempts preserve mode;
  active code mode never reverts. Legacy aliases keep identical authentication.
- Preserve newer main behavior, particularly deploy reservation/lifecycle ownership,
  cleanup, auth-origin protection, cron and client/backend contracts. No wholesale
  replacement of current-main implementations with older feature files.
- Work only in the existing managed worktree. Preserve original checkout edits.
  No push, PR, merge to main, deployment, live schema changes or unrelated cleanup.
- Existing migration is already applied on dev; keep its exact source unchanged.
  Retain existing acceptance boundaries; integration tests cannot imply missing
  native Windows/Linux or real-account rollout acceptance.

## Review focus

- Stale deploy tokens and failed attempts must not activate a code domain or release
  another attempt's reservation; retain main's lifecycle concurrency tests.
- Retained legacy aliases and new code hosts must preserve origin/login protections.
- Missing/null mode or undeployed apps must not unexpectedly offer migration UI.
- New main API fields must survive DTO mapping and deploy option propagation.
- Non-conflicted auto-merges can lose semantics too; review final main-to-feature
  app-code diff, rather than looking only for conflict markers.

### Task 1: Merge and verify the integrated app-code feature

**Files:** Resolve the 17 conflicts listed in
`docs/testing/app-public-code-dev-deployment.md`, and any related semantic/type/test
integration errors. Auto-merged main files stay included. Update the deployment
preparation and acceptance documents only with fresh observed integration evidence.

**Interfaces:** Consume current-main repository/deploy/auth contracts and approved
feature app-code fields/choice lifecycle; produce a committed merge with a clean
index and no conflict markers, tested and ready for independent review.

- [ ] Confirm clean worktree and pinned main; merge the pinned SHA with `--no-commit`
  on the existing feature branch. Record parents and exact conflict list.
- [ ] Read the approved spec plus both sides of each conflict and resolve as one
  coherent integration. Do not choose ours/theirs indiscriminately. Preserve both
  relevant test families and newest DTO/reservation/auth contracts.
- [ ] For an actual behavior regression uncovered during integration, follow
  systematic debugging and add a meaningful failing regression test before fixing;
  conflict-marker and type reconciliation alone needs no artificial red test.
- [ ] Run focused backend domain/deploy/auth/repository tests while iterating.
  Use direct installed Node binaries, not pnpm auto-install. Existing Node dependency
  symlinks may target original checkout: do not write through those links or mutate
  its dependencies/caches. Install missing worktree-local dependencies only if needed.
- [ ] Run full backend tests, backend typecheck/build, OpenAPI lint, full frontend
  tests and typecheck, and macOS Rust check/tests covering desktop integration.
  Use the repository Rust wrapper, task-local target metadata, existing read-only
  Sherpa static libraries and analysis-only Tauri config as established below.
  Record failures/skips honestly; diagnose/fix introduced regressions, preserve
  unrelated source. No live fixture or deployment is required for this task.
- [ ] Self-review both merge-parent changes and `pinned-main..HEAD` feature diff.
  Commit the resolved merge, then any necessary verified fixes. Update evidence with
  exact commands, totals, remaining limits and newly integrated base. Do not overwrite
  historical acceptance snapshots or mark release gates complete without evidence.
- [ ] Report commits, checks and concerns to the controller for independent review.

**Commands:** Backend cwd `services/fc`: `node --import tsx --test "test/**/*.test.ts"`,
`node node_modules/typescript/bin/tsc -p tsconfig.test.json`,
`node node_modules/typescript/bin/tsc -p tsconfig.json`,
`node node_modules/@redocly/cli/bin/cli.js lint ../../docs/openapi/teamclu-api.v1.yaml`.
Frontend cwd `packages/app`: `node node_modules/vitest/vitest.mjs run`,
`node node_modules/typescript/bin/tsc --noEmit`.
Rust root: `CI=1 RUSTC_WRAPPER=/usr/bin/env TAURI_CONFIG='{"bundle":{"resources":[],"externalBin":[]}}'
SHERPA_ONNX_LIB_DIR=/Users/dengwei/git/teamclu/.cargo-target/sherpa-onnx-prebuilt/sherpa-onnx-v1.13.7-osx-arm64-static-lib/lib
node scripts/rust-cli.js check --tests -p teamclu --locked`, then same env with
`test -p teamclu --lib --locked`. Adapt only to current-main wrapper requirements
and document changes; no sharing original mutable target directories.
