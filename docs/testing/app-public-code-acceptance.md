# App public-code migration acceptance

Date: 2026-10-19 (Asia/Shanghai)

**Outcome: qualified automated evidence; release acceptance remains blocked.**
The final frontend, backend and desktop library suites are not all green. Their
actual failures, narrow follow-ups and baseline evidence are retained below.
No live migration, push, PR, merge, deployment or publication was performed.

## Scope and tested revision

- Approved requirements: [Permanent app codes and opt-in domain migration](../specs/2026-10-19-app-public-code-design.md).
- Managed execution worktree: `/Users/dengwei/.codex/worktrees/app-public-code/teamclu`.
- Authorized execution branch: `codex/app-public-code-implementation`.
- Tested implementation: `d15fb2a1ce71e570b1aa987be1e172976f3d2945`, containing Tasks 1–6.
- Specification comparison baseline: `ae418263` (specification commit); implementation follows plan commit `97bfe2c7`.
- Acceptance task changes only this document; no product code or tests changed.
- Read the approved specification alongside the cumulative implementation diff.
  Task implementation reviews were completed before this run. Independent Task 7
  and whole-branch reviews are **PENDING**, to be dispatched by the controller.

The package-script equivalents below use installed binaries because pnpm tries
to install against this worktree's existing dependency links. No installation
was performed. Original source/tracked files were preserved. Existing
`packages/app/node_modules/.vite` and `.vite-temp` links target ignored caches in
the original checkout; tool runs may have changed those cache files. This is
not a claim of zero writes anywhere in the original checkout.

## Requirements matrix

“PASS (automated)” means the named behavior is covered by passing tests within
this run, not that live/native/manual acceptance has passed.

| Requirement | Evidence in tested implementation | Result / limit |
| --- | --- | --- |
| Permanent 12-character lowercase Crockford Base32 code; 60 secure random bits; global uniqueness, non-nullness, format and immutability | Actual migration executed by `app-code-schema.test.ts`; three tests include exact tail-bit fixtures, format/null/duplicate/reassignment rejection and 1,003 distinct codes | PASS (automated PGlite); full-schema pgTAP BLOCKED |
| Existing apps backfilled into legacy mode without changing IDs, deployment endpoints/function/status; new rows default to code mode | PGlite migration preservation/default assertions; deterministic backfill collision retry | PASS (automated); live preservation verification BLOCKED |
| Creation retries only the code uniqueness conflict, at most five attempts, reusing the workspace; slug/other errors propagate | `supabase-repo.test.ts` collision success/exhaustion, slug conflict and wrong-SQLSTATE tests | PASS (automated) |
| Read-only API fields and current/candidate URL distinction; no configured domain fallback | OpenAPI App schema/deploy request; `app-code.test.ts`, repository mapping/route tests; frontend/backend typechecks | PASS (automated); OpenAPI has 10 existing warnings |
| Exact indexed code equality; unknown, disabled and ambiguous code hosts fail closed; ASCII/Punycode legacy aliases retained | `apps-vanity.test.ts`, `app-code.test.ts`; exact `app_code` equality plus active-mode query | PASS (automated) |
| Candidate code URL neither routes nor becomes a login origin before activation | Vanity and login tests for false/missing mode; code-host cache-miss tests | PASS (automated) |
| Checkbox choice bound to deploy token; only successful finalization activates; omitted/false, failure and unchecked retry preserve legacy; active code mode never reverts | `supabase-repo.test.ts` lifecycle cases, replacement-token fencing, auth env and activation cache invalidation; UI cancellation tests | PASS (automated) |
| Legacy undeployed app gets no implicit switch | Backend undeployed lifecycle test and frontend/native eligibility cases | PASS (automated) |
| One existing frontend confirmation, initially unchecked, exact eligibility, checked/unchecked acceptance, cancellation/Escape and next-attempt reset | `AppDeployConfirmDialog.test.tsx`, `app-domain-choice.test.ts`, `apps-store.test.ts`; real Radix/StrictMode interaction | PASS (automated); visual/manual acceptance PENDING |
| Native agent approval owns the choice; agent cannot preselect it; shared 120-second timeout and serialized display | macOS adapter compiled; shared production orchestration tests cover choices, decline/dismiss/parent close, timeout, queued retry, stale completion and requester disconnect; eligibility test passed | PASS for shared automated logic and macOS compile; all platform GUI acceptance PENDING |
| Real native checkbox adapters on macOS, Windows and Linux | AppKit, TaskDialogIndirect verification checkbox and GTK CheckButton implementations inspected | macOS compilation PASS; Windows/Linux compilation and interaction BLOCKED (no hosts/targets) |
| Old and code aliases retain the same auth/permissions; login origins match active mode and verified custom domains only | `apps-auth-gate.test.ts`, `apps-login-service.test.ts`, real lookup/cache gateway cases and repository auth-write invalidation tests | PASS (automated); real-account login PENDING |
| Auth env, custom-domain DNS target, Traefik forwarding and scheduled requests use active mode; verified bindings retained | `provisioning/app-auth-mode.test.ts`, custom-domain, Traefik, cron and repository metadata-selection tests | PASS (automated); deployed integration checks PENDING |
| Routing answers and misses invalidated for both aliases after activation/auth/custom-domain changes/deletion | Vanity and repository tests plus cumulative source inspection | PASS (automated within covered paths) |
| Cloud API remains the client business-data boundary | Existing frontend backend-import guard passes in full suite; all feature operations use the provider/API boundary | PASS (automated/source inspection) |

## Exact integrated commands and results

All commands ran once against the final implementation, except explicitly named
narrow diagnostic/baseline commands. Logs are local evidence under `/tmp` and
may be removed by the operating system. Counts/results are preserved here.
`pnpm test:unit` and root `pnpm typecheck` delegate to `packages/app`; their
exact package-script equivalents were run from that directory.

| Working directory | Exact command | Actual result | Log |
| --- | --- | --- | --- |
| `packages/app` | `node node_modules/vitest/vitest.mjs run` | exit 1; 601 files passed, 1 failed, 1 skipped; **4,127 passed, 1 failed, 10 skipped**; 51.36 s | `/tmp/task7-frontend-unit.log` |
| `packages/app` | `node node_modules/typescript/bin/tsc --noEmit` | exit 0; no diagnostics | `/tmp/task7-frontend-typecheck.log` |
| `services/fc` | `node --import tsx --test "test/**/*.test.ts"` | exit 1; **1,571 passed, 2 failed, 13 skipped**; 17.54 s | `/tmp/task7-backend-unit.log` |
| `services/fc` | `node node_modules/typescript/bin/tsc -p tsconfig.test.json` | exit 0; no diagnostics | `/tmp/task7-backend-typecheck.log` |
| `services/fc` | `node node_modules/@redocly/cli/bin/cli.js lint ../../docs/openapi/teamclu-api.v1.yaml` | exit 0; valid; 0 errors, **10 warnings** | `/tmp/task7-openapi-lint.log` |
| repository root | `node scripts/rust-cli.js test -p teamclu --lib --locked` with environment below | exit 101; **430 passed, 1 failed**, 0 ignored; 1.71 s test execution | `/tmp/task7-rust-lib.log` |
| repository root | `node scripts/rust-cli.js check --tests -p teamclu --locked` with environment below | exit 0; completed in 0.97 s | `/tmp/task7-rust-check-tests.log` |
| repository root | `git diff --check` | exit 0 | no diagnostics |

Both Rust commands used the repository wrapper, this worktree's real
`.cargo-target`, and these command-local values (no global settings changes):

```sh
CI=1 RUSTC_WRAPPER=/usr/bin/env \
TAURI_CONFIG='{"bundle":{"resources":[],"externalBin":[]}}' \
SHERPA_ONNX_LIB_DIR=/Users/dengwei/git/teamclu/.cargo-target/sherpa-onnx-prebuilt/sherpa-onnx-v1.13.7-osx-arm64-static-lib/lib \
node scripts/rust-cli.js test -p teamclu --lib --locked

CI=1 RUSTC_WRAPPER=/usr/bin/env \
TAURI_CONFIG='{"bundle":{"resources":[],"externalBin":[]}}' \
SHERPA_ONNX_LIB_DIR=/Users/dengwei/git/teamclu/.cargo-target/sherpa-onnx-prebuilt/sherpa-onnx-v1.13.7-osx-arm64-static-lib/lib \
node scripts/rust-cli.js check --tests -p teamclu --locked
```

The existing same-version static library was a read-only input. Native host:
Darwin, installed Rust target only `aarch64-apple-darwin`. Compilation checks do
not substitute for launching and interacting with the native popup. Existing
Rust warnings include unset release CLOUD_API_URL and future incompatibility in
`block`/`imap-proto`; this check is not a release build.

### Failures, skips and baseline evidence

1. **Frontend intermittent existing-test timeout (not resolved here):**
   `src/components/settings/__tests__/DaemonGeneralSection.offline.test.tsx` →
   `DaemonGeneralSection without a network` →
   `reloads on its own once the network comes back` failed after roughly
   1,000 ms: the offline DOM element remained instead of becoming null.
   The current focused command
   `node node_modules/vitest/vitest.mjs run src/components/settings/__tests__/DaemonGeneralSection.offline.test.tsx`
   passed **3/3**, exit 0 (`/tmp/task7-frontend-offline-focused.log`). The same
   command in exported specification baseline `ae418263`, under
   `/tmp/teamclu-task7-baseline/packages/app`, also passed **3/3**, exit 0
   (`/tmp/task7-baseline-frontend-offline-final.log`). The component and test
   bytes are identical to that baseline. Task 5's earlier full staged-only run
   recorded **4,128 passed / 10 skipped**, exit 0
   (`/tmp/teamclu-task-5-frontend-tests.log`). Root cause remains unproven;
   neither the narrow passes nor the earlier suite replace this final red run.
2. **Two independently reproduced backend fixture failures:**
   `test/app-env.test.ts` → `a user row that reached the table anyway cannot shadow the platform`
   expects PORT `9000`, receives `1`; and
   `no user env leaves the function's environment exactly as before` expects
   PORT `9000`, receives no PORT. Running
   `node --import tsx --test test/app-env.test.ts` in exported `ae418263`
   `services/fc` reproduces the same failures: **8 passed / 2 failed**, exit 1
   (`/tmp/task7-baseline-backend-port.log`). Source and tests are byte-identical
   to that baseline. They also match the Tasks 1–4 recorded failures.
3. **Desktop environment failure:**
   `commands::webview::tests::ensure_http_host_resolvable_rejects_unresolvable_host`
   fails with `unresolvable host: ()`. In the same elevated environment used
   for Rust, this exact diagnostic returned **198.18.0.72**, exit 0:
   `node -e 'require("node:dns").lookup("no-such-host-teamclu-617.invalid",(e,a)=>{console.log(e?e.code:a)})'`.
   A sandbox-only diagnostic returned ENOTFOUND; it is not the environment of
   the failing test. `webview.rs` is byte-identical to `ae418263`. Task 6
   reproduced this test on committed pre-native baseline `a39f47e1`
   (`/tmp/task6-baseline-dns.log`). No DNS or unrelated webview code changed.
   The previously intermittent
   `commands::webview::tests::ensure_http_url_reachable_allows_a_working_origin`
   **passed in this final full run**; Task 6's 3-second reqwest timeout remains
   historical evidence, not an additional current failure.
4. **Frontend 10 skips:** opt-in live daemon tests are disabled: nine session
   binding cases (`SESSION_BINDING_LIVE`) and one mid-turn follow-up case
   (`REPRO_MID_TURN_LIVE`). No real daemon/live acceptance is claimed.
5. **Backend 13 skipped tests, plus five skipped suites:** three
   `live-sync-query.test.ts` cases require `FC_LIVE_TEST=1`; five
   `sync-flow.test.ts` cases skipped because local Supabase at
   `127.0.0.1:54321` is unreachable (`TypeError: fetch failed`); five
   `sync-mode.test.ts` cases skipped with “local Supabase not available or
   fixtures failed”: current mode, unknown team, owner mode change, invalid
   mode and direct UPDATE guard. Separately, five `self-host-e2e.test.ts`
   suites (Auth, Runtime config, Team lifecycle, Session + Messages, Storage)
   require `FC_E2E=1`; these suites are not part of the 13 skipped-test total.
   No flags were enabled to contact live systems.
6. **OpenAPI warnings:** six existing `no-ambiguous-paths` warnings (sessions
   by-acp, threads, thread-summaries, messages, mute; actor access); three
   `operation-4xx-response` warnings (public config, team quotas, workspace
   git config); one `operation-2xx-response` warning (OAuth authorize).
   These locations precede the feature additions and match earlier evidence.
7. **Frontend baseline warning:** the full, focused and exported-baseline
   runs all emit the existing Vite warning that `__dirname` in
   `vite.config.ts:9:41` is unsupported by the future native config loader.
   This is a tooling warning, not a new feature failure; no unrelated config
   was changed.

No new deterministic product defect was demonstrated by this task. This is a
qualified finding, not a fully green-suite or release-ready assertion. No test
was weakened, skipped, or changed to turn a failure into a pass.

## Database, account and platform acceptance gates

| Gate | Status | Evidence / next required action |
| --- | --- | --- |
| Actual migration executed in embedded PostgreSQL | PASS (limited) | Three PGlite schema tests passed in final backend suite; isolated simplified table, not complete migrated Supabase schema |
| Paired pgTAP test on fully migrated isolated local database | BLOCKED | `/opt/homebrew/bin/psql` exists; `pg_config --sharedir` returns `/opt/homebrew/share/postgresql@17`; `extension/pgtap.control` and `pg_prove` absent. No configured migrated isolated pgTAP database is available. `bash services/supabase/tests/run.sh 043_apps_public_code.sql` **not run**; do not run with default/unknown PG connection settings |
| Live migration and read-only schema verification | BLOCKED | Current tool inventory contains no Supabase MCP tool. No psql/REST/CLI fallback or live writes attempted |
| Real-account login on legacy URL, active code URL and retained alias; candidate rejected before activation | PENDING | Only automated/stubbed auth coverage; safe authorized environment and real account still required |
| macOS aarch64 compile/library tests | PASS with environment failure | `check --tests` passes; library 430/431, only named DNS failure; three feature native/eligibility tests pass |
| macOS checkbox visual/interaction acceptance | PENDING; release blocking | No popup was launched for manual acceptance |
| Windows native compilation/tests and GUI acceptance | BLOCKED; release blocking | No Windows host or installed target; source inspection is not platform validation |
| Linux native compilation/tests and GTK interaction acceptance | BLOCKED; release blocking | No Linux host or installed target/display; source inspection is not platform validation |
| Frontend visual/manual acceptance | PENDING | Automated real-dialog interaction only; no screenshot/manual layout check |
| Independent Task 7 and final whole-branch reviews | PENDING | Controller owns dispatch and follow-up after evidence commit |

On each native host, run wrapper library tests and `check --tests` with its
supported toolchain/environment. Exercise a safe stub deployment consumer:
first and repeated prompt unchecked; publish unchecked; publish checked;
Decline; Escape; popup close; parent close/hide-to-tray; unattended 120-second
timeout; queued request; requester disconnect; late callbacks cannot approve
a later request. Observe exactly one native popup and inspect the approved
choice forwarded to the stub. Do not publish an app solely to test the UI.

The new checkbox path retains the display mutex until its own native teardown.
Existing ordinary approval still releases its mutex on timeout/caller drop
without closing its OS popup. This feature does not establish a new teardown
guarantee for every sequence mixing ordinary and checkbox approvals. Native
mixed-sequence manual acceptance remains important. Agent-handler deployment
suppression and approval-cache bypass were code-reviewed but are not directly
covered by a handler-level integration test; shared checkbox lifecycle and
eligibility are covered. These limits remain visible for the final reviewer.

## Release order (not executed)

1. Complete and resolve independent reviews plus the blocked/pending native,
   manual, real-account and full-schema pgTAP acceptance above. Review the
   qualified suite failures rather than marking them green.
2. Obtain explicit authorization for live schema changes and subsequent service
   and client publication; the implementation authorization does not authorize
   those actions. Configure/authenticate the Supabase MCP for the intended
   environment. If it remains unavailable, stop for setup.
3. Through Supabase MCP, apply
   `20261019000000_apps_public_code.sql` before releasing the updated Cloud
   API. Keep that migration and `043_apps_public_code.sql` in version control.
4. Through read-only Supabase MCP queries verify the three columns/defaults,
   generator/immutability functions and trigger, NOT NULL/format/unique
   constraints, valid unique codes on all rows, and preserved legacy false mode
   for pre-existing apps. Compare pre/post UUIDs, resources, deployment fields,
   endpoints and domain bindings; verify a controlled new row defaults to code
   mode only under separately authorized test setup.
5. Release the updated Cloud API through the existing feature-release process
   for the intended target (self-host and Belayo are distinct). Verify legacy
   apps remain on legacy URLs, disabled candidates fail closed, and protected
   routes still enforce existing login/audience/permissions.
6. Release updated desktop clients through the existing feature-release
   process after target-host approval. In an explicitly authorized safe
   deployment, confirm unchecked/cancel/failed attempts retain legacy mode;
   checked successful finalization alone activates the code URL; the old URL
   remains an authenticated alias. Verify login, auth env, custom domain and
   cron behavior in both modes.

No release version was bumped. No branch push, PR creation, merge, tag, service
publishing or live deployment is authorized by this acceptance document.
