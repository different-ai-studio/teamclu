---
name: sentry-fix
description: Use when the user wants to fix a Sentry issue, auto-repair a bug from Sentry, or create a fix PR for a Sentry error. Triggers on "修复 sentry", "fix sentry issue", "sentry 修复", "sentry fix".
---

# Sentry Fix — Auto-Fix Issue with Test

Fix a specific Sentry issue: gather context, confirm with user, implement fix,
write regression test, verify, commit.

## Arguments

- `<ISSUE-ID>` (required): Sentry issue short ID, e.g. `TEAMCLU-REACT-7Q`

The issue ID is passed as the skill argument: `/sentry-fix TEAMCLU-REACT-7Q`

## Projects

Route on the issue ID prefix. Every project's short ID carries its own segment,
so the prefix alone identifies the codebase:

| Prefix | Sentry Slug | Code | Test | Lint / typecheck |
|---|---|---|---|---|
| `TEAMCLU-REACT-` | `ucar-inc/teamclu-react` | `packages/app/` | `pnpm test:unit` | `pnpm typecheck && pnpm lint` |
| `TEAMCLU-RUST-` | `ucar-inc/teamclu-rust` | `apps/desktop/` | see **Rust tests** below | `pnpm rust:clippy` |
| `TEAMCLU-IOS-` | `ucar-inc/teamclu-ios` | `apps/ios/` | `pnpm ios:test:core` | — |
| `TEAMCLU-EXPO-` | `ucar-inc/teamclu-expo` | `apps/expo/` | `pnpm expo:test` | `pnpm typecheck:expo` |

`ucar-inc/teamclu` (a bare `TEAMCLU-` prefix with no platform segment) is the
**old, deleted** project. An issue ID in that shape is from before 2026-09-04 and
cannot be fetched; ask the user for a current one.

`teamclu-react` covers both the web app and the desktop webview — the desktop
Rust process reports separately under `teamclu-rust`.

### Rust tests

Do **not** run bare `cargo test`. It exits 101 on
`teamclu-introspect sidecar binary not found`: `check`/`clippy` are analysis
paths, but `test` is a real build and runs `apps/desktop/build.rs`, which panics
when `binaries/` (entirely gitignored) has no sidecar and `CI` is unset.

Main checkout — the wrapper builds the sidecar first:

```bash
node scripts/rust-cli.js test --manifest-path apps/desktop/Cargo.toml --lib <filter>
```

Fresh worktree — `CI=1` alone is not enough, because tauri-build still globs
`bundle.resources` paths that do not exist there:

```bash
CI=1 TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}' \
  node scripts/rust-cli.js test --manifest-path apps/desktop/Cargo.toml --lib <filter>
```

Always go through `pnpm rust:*` / `scripts/rust-cli.js` rather than bare cargo —
bare `cargo clippy` fails on a fresh checkout for the same reason.

## Execution Steps

### Phase 1: Gather Context

1. Fetch issue details with stack trace. `issue view` resolves a short ID across
   projects, so no slug is needed:

```bash
sentry issue view <ISSUE-ID> --json
```

This is also the only place volume numbers come from — `count`, `userCount`,
`firstSeen` and `lastSeen` are silently dropped from `issue list --fields` on
CLI 0.26.1.

2. From the stack trace and error message, identify the relevant source files
   and functions in the codebase.

3. Read those source files to understand the code context around the error site.

4. Perform local root cause analysis. Produce a clear root cause summary.

Two checks worth making before writing it up:

- **Is this one of several groups for the same defect?** A sourcemapped build
  and a minified one group separately. Search sibling issues for the same
  `metadata.value`; if they match, one fix closes all of them, and the plan
  should say so.
- **Is there a group with a sourcemapped frame?** Prefer analyzing the one whose
  `culprit` is a repo path (`/src/...`) over a bundle (`assets/index-*.js`) — it
  names the file directly instead of needing to be reverse-engineered.

**If the stack trace is insufficient to identify the root cause:** Stop and ask
the user for additional context. Do NOT guess.

### Phase 2: Confirm with User

Present a fix plan in the terminal. It MUST include:

1. **Root cause** — one paragraph from local analysis
2. **Files to modify** — exact paths and what changes in each
3. **Proposed fix** — description of the code changes
4. **Regression test plan** — what test is added and what it verifies
5. **Verification commands** — which commands will be run

**STOP HERE and wait for user confirmation.** Do NOT proceed until the user says
yes. This applies even when the root cause looks obvious.

### Phase 3: Implement Fix

1. Branch. Never work on `main` (see the Git Workflow section of `CLAUDE.md`):

```bash
git checkout -b sentry-fix/<issue-id-lowercase>
```

This checkout is often shared with other sessions. Before branching, run
`git status --short` and confirm the tree is clean — a dirty tree means someone
else's work in progress, and carrying it onto your branch (or committing it) has
happened before. Never `git reset --hard` here.

2. Implement the fix:
   - Follow existing code patterns and style
   - Only modify files directly related to the issue
   - No gratuitous refactoring

3. Write a regression test:
   - **Rust:** `#[test]` in the relevant module's test section, or a test file in
     the same directory.
   - **React / Expo:** a vitest test in the corresponding `.test.ts(x)`, creating
     one if none exists and following neighbouring test files.
   - **iOS:** a SwiftPM test under `apps/ios/Packages/AMUXCore/Tests/`.

   The test must reproduce the scenario that caused the original error.

4. **Prove the test catches the bug.** Stash or revert the fix, run the new test,
   and confirm it fails for the expected reason; then restore the fix and confirm
   it passes. A regression test that was never seen red is not evidence. Use a
   file copy plus `git checkout -- <path>` rather than `git stash` on a shared
   checkout.

### Phase 4: Verify

Run the full suite for the platform, **including the test just written** — not
just the linter:

- **React:** `pnpm test:unit && pnpm typecheck && pnpm lint`
- **Rust:** the `rust-cli.js test` command above, plus `pnpm rust:clippy` and
  `cargo fmt --check --manifest-path apps/desktop/Cargo.toml`
- **Expo:** `pnpm expo:test && pnpm typecheck:expo`
- **iOS:** `pnpm ios:test:core` (`pnpm ios:test` additionally needs a booted
  simulator; skip it unless the fix is UI-level and say that you did)

Never pipe these through `tail`/`head` when you care about the result — the
pipeline's exit code is the pager's, so a failure reads as exit 0. Redirect to a
file and check `$?`.

Compare lint output against the pre-change baseline rather than counting
warnings in the absolute: this repo carries known warnings, and "0 errors" with
an unchanged warning set is the bar.

If verification fails:
1. Read the error output
2. Fix the issue
3. Re-run verification
4. Maximum 2 retry rounds. If still failing, stop and report to the user.

If a failure looks unrelated to the change, check it against the known-flaky and
known-broken memories before assuming you caused it — several suites in this
repo fail on a clean `main` for environmental reasons.

### Phase 5: Commit, then stop

1. Stage only the files you changed, by explicit path. Never `git add -A` — an
   unscoped add on this shared checkout is what put a private document into a
   public commit once already:

```bash
git add <changed-files>
git commit -m "fix(<scope>): <description> (Sentry <ISSUE-ID>)"
```

`<scope>` is the module/component (e.g. `chat`, `settings`, `daemon`, `editor`).

2. **Stop here and report back.** Per `CLAUDE.md`, do not `git push` or run
   `gh pr create` on your own initiative, even when everything is green. Wait for
   an explicit "open the PR" / "ship it" / "提 PR" / "可以提 PR 了".

Report: what was fixed, the verification results (including the red-then-green
evidence for the regression test), and anything left unverified.

### Phase 6: PR — only when the user asks

```bash
git push -u origin sentry-fix/<issue-id-lowercase>
gh pr create --title "fix(<scope>): <short description>" --body "$(cat <<'PREOF'
## Sentry Issue

Fixes [<ISSUE-ID>](<sentry-issue-permalink>)

## Root Cause

<root cause summary from local analysis>

## Fix

<description of code changes>

## Test Coverage

<the regression test, and the failure it produces without the fix>

## Verification

<commands run and their results; name anything not verified and why>
PREOF
)"
```

State verification honestly in the PR body — if something could not be run, say
which and why rather than omitting it.

## Constraints

- NEVER modify code before the user confirms the fix plan (Phase 2)
- NEVER modify files unrelated to the issue
- ALWAYS write a regression test, and always see it fail before it passes
- NEVER push or open a PR without an explicit request (Phase 5/6)
- If `sentry` CLI is not authenticated, prompt the user to run `sentry auth login`
- If `gh` CLI is not authenticated, prompt the user to run `gh auth login`
