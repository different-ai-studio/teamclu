# App public-code migration acceptance

Updated: 2026-10-20 (Asia/Shanghai). Original acceptance snapshot: 2026-10-19.

**Current outcome: all executed integrated suites pass; release acceptance remains
blocked by missing platform/account evidence.** Tested source: **`bf99b359`**.
Frontend: **4,366 passed / 10 skipped** (620 passed files, one skipped).
Backend: **1,982 passed / 0 failed / 13 skipped**, plus five separately skipped
suites. macOS Rust library: **465 passed / 0 failed / 0 ignored**. Backend test
typecheck and production build, frontend typecheck, OpenAPI lint and Rust
`check --tests` exit 0. OpenAPI has **11 warnings**, with identical rules and
locations reproduced on pinned main. Task-scoped integration and final
whole-feature source reviews approved the implementation at **`de097203`**;
release acceptance remains open.

Historical acceptance evidence is preserved below: the exact CI Supabase image
accepted all 130 migrations, feature pgTAP **13/13**, and the full SQL runner
**50 files / 0 failed / 0 quarantined**. Real Chrome interaction passed for the
then-current production frontend confirmation in English and Chinese.

Historical macOS native widget/shared-path acceptance passed the nine observed requests,
including the real 120-second timeout and parent close/hide. Windows and Linux
native execution, ordinary/checkbox mixed sequences, real-account login and
deployed integration acceptance remain incomplete. A local mixed-dialog attempt
was blocked by a concrete CUA safety restriction; ordinary popup teardown is
unobserved, not a demonstrated defect or pass. The authorized dev database
migration was applied and verified through self-hosted MCP on 2026-10-20; see
the live addendum below. Current main was merged into the feature branch; no
push, PR, merge to main, service/client deployment or publication was performed.
Database readiness is not full rollout acceptance.

## Scope, revisions and review status

- Approved requirements: [Permanent app codes and opt-in domain migration](../specs/2026-10-19-app-public-code-design.md).
- Managed worktree: `/Users/dengwei/.codex/worktrees/app-public-code/teamclu`;
  authorized branch: `codex/app-public-code-implementation`.
- Current tested source: **`bf99b359ad08c62f09f27549304dd08e61335d0b`**,
  integrating main `ba604cf9dda7a8f39bd59d576daca19ab91587be`. Task-scoped
  integration review and final whole-feature source review approved quality at
  **`de09720301679e34782dea7e5785599b72a7d629`**, with no Critical/Important
  source findings; minor documentation/coverage follow-ups and release gates
  remain distinct from that approval.
- Historical frontend/backend/Rust checks and frontend/native fixture
  sources: **`25381e6849348f5c8cfc655e23b5559844e5bb58`**.
- Fully migrated database evidence: immutable tracked export of
  **`a7cefd31d227337c57c717d245b3fbe15742bf3e`**. The subsequent `25381e68` changes
  only the acceptance-failure fixtures/private preflight seams and dev-only TLS
  test dependencies; no migration, schema, app-code or deployment semantics changed.
- Original tested implementation: `d15fb2a1ce71e570b1aa987be1e172976f3d2945`;
  specification baseline: `ae418263`; approved implementation plan: `97bfe2c7`.
- Tasks 1–6 reviews completed. Original Task 7 review findings (skip accounting
  and baseline Vite warning) were fixed and independently re-reviewed at
  `a7cefd31`. Whole-branch review `97bfe2c7..a7cefd31` approved implementation
  quality with two minor follow-ups, found no new Critical/Important code defect,
  and explicitly withheld merge/release acceptance for missing acceptance gates.
- Independent follow-up review `a7cefd31..25381e68` approved the failure repairs,
  with no Critical/Important findings. It did not claim the later integrated
  run or platform/account acceptance. Review artifacts retain their original
  dated results; their red-suite/pending-review snapshots are historical.
- Independent review approved evidence commit `18ceba84` within its stated
  boundaries. Scoped review of the mixed-dialog evidence amendment
  `18ceba84..60e1f08a` approved spec/evidence compliance and quality with no
  findings. Remaining release acceptance gates stay open. Documentation changes
  no product code or tests and reruns no suites.

Direct installed binaries were used because pnpm can attempt automatic
installation against existing dependency links. No dependency installation was
performed through those Node links. Follow-up frontend caches `.vite` and
`.vite-temp` are real worktree-local directories. The first 2026-10-19 run used
pre-existing links into ignored original-checkout caches; it was never evidence
of zero writes anywhere in the original checkout.

## Requirements matrix

“PASS (automated)” means the named behavior is covered by passing tests in the
final integrated run. Local database/browser/native evidence is named separately;
no live, real-account or untested platform acceptance is implied.

| Requirement | Evidence in tested implementation | Result / limit |
| --- | --- | --- |
| Permanent 12-character lowercase Crockford Base32 code; 60 secure random bits; global uniqueness, non-nullness, format and immutability | Actual migration executed by `app-code-schema.test.ts`; three tests include exact tail-bit fixtures, format/null/duplicate/reassignment rejection and 1,003 distinct codes | PASS (PGlite and fully migrated isolated Supabase pgTAP) |
| Existing apps backfilled into legacy mode without changing IDs, deployment endpoints/function/status; new rows default to code mode | PGlite migration preservation/default assertions; deterministic backfill collision retry | PASS (automated); live preservation verification BLOCKED |
| Creation retries only the code uniqueness conflict, at most five attempts, reusing the workspace; slug/other errors propagate | `supabase-repo.test.ts` collision success/exhaustion, slug conflict and wrong-SQLSTATE tests | PASS (automated) |
| Read-only API fields and current/candidate URL distinction; no configured domain fallback | OpenAPI App schema/deploy request; `app-code.test.ts`, repository mapping/route tests; frontend/backend typechecks | PASS (automated); OpenAPI has 11 pinned-main baseline warnings |
| Exact indexed code equality; unknown, disabled and ambiguous code hosts fail closed; ASCII/Punycode legacy aliases retained | `apps-vanity.test.ts`, `app-code.test.ts`; exact `app_code` equality plus active-mode query | PASS (automated) |
| Candidate code URL neither routes nor becomes a login origin before activation | Vanity and login tests for false/missing mode; code-host cache-miss tests | PASS (automated) |
| Checkbox choice bound to deploy token; only successful finalization activates; omitted/false, failure and unchecked retry preserve legacy; active code mode never reverts | `supabase-repo.test.ts` lifecycle cases, replacement-token fencing, auth env and activation cache invalidation; UI cancellation tests | PASS (automated) |
| Legacy undeployed app gets no implicit switch | Backend undeployed lifecycle test and frontend/native eligibility cases | PASS (automated) |
| One existing frontend confirmation, initially unchecked, exact eligibility, checked/unchecked acceptance, cancellation/Escape and next-attempt reset | `AppDeployConfirmDialog.test.tsx`, `app-domain-choice.test.ts`, `apps-store.test.ts`; real Radix/StrictMode interaction | PASS (automated and real Chrome EN/ZH component interaction) |
| Native agent approval owns the choice; agent cannot preselect it; shared 120-second timeout and serialized display | macOS adapter compiled; shared production orchestration tests cover choices, decline/dismiss/parent close, timeout, queued retry, stale completion and requester disconnect; eligibility test passed | PASS for shared automated logic and macOS compile; macOS widget/shared-path GUI acceptance PASS; Windows/Linux BLOCKED |
| Real native checkbox adapters on macOS, Windows and Linux | AppKit, TaskDialogIndirect verification checkbox and GTK CheckButton implementations inspected | macOS compilation PASS; Windows unavailable; Linux guest available but pinned compiler download TLS-blocked; neither platform compiled/interacted |
| Old and code aliases retain the same auth/permissions; login origins match active mode and verified custom domains only | `apps-auth-gate.test.ts`, `apps-login-service.test.ts`, real lookup/cache gateway cases and repository auth-write invalidation tests | PASS (automated); real-account login PENDING |
| Auth env, custom-domain DNS target, Traefik forwarding and scheduled requests use active mode; verified bindings retained | `provisioning/app-auth-mode.test.ts`, custom-domain, Traefik, cron and repository metadata-selection tests | PASS (automated); deployed integration checks PENDING |
| Routing answers and misses invalidated for both aliases after activation/auth/custom-domain changes/deletion | Vanity and repository tests plus cumulative source inspection | PASS (automated within covered paths) |
| Cloud API remains the client business-data boundary | Existing frontend backend-import guard passes in full suite; all feature operations use the provider/API boundary | PASS (automated/source inspection) |

## Historical commands and results — source `25381e68`

These are the historical controller-owned checks after the reviewed failure repairs.
Current integrated-source totals are in the overview and current-main addendum.
Exit status comes from `/tmp/app-code-followup-final-{frontend,backend,rust}-summary.json`;
counts below were checked against the referenced logs. Logs under `/tmp` are
local evidence and may be removed by the operating system; durable results are
recorded here. Package-script equivalents run in the stated directory.

| Directory | Exact command | Actual result | Evidence log |
| --- | --- | --- | --- |
| `packages/app` | `node node_modules/vitest/vitest.mjs run` | exit 0; 602 files passed, 1 skipped; **4,128 passed / 10 skipped**; 53.39 s | `/tmp/app-code-followup-final-frontend-unit.log` |
| `packages/app` | `node node_modules/typescript/bin/tsc --noEmit` | exit 0; no diagnostics | `/tmp/app-code-followup-final-frontend-typecheck.log` |
| `services/fc` | `node --import tsx --test "test/**/*.test.ts"` | exit 0; **1,573 passed / 0 failed / 13 skipped**; 18.26 s; five additional skipped suites | `/tmp/app-code-followup-final-backend-unit.log` |
| `services/fc` | `node node_modules/typescript/bin/tsc -p tsconfig.test.json` | exit 0; no diagnostics | `/tmp/app-code-followup-final-backend-typecheck.log` |
| `services/fc` | `node node_modules/@redocly/cli/bin/cli.js lint ../../docs/openapi/teamclu-api.v1.yaml` | exit 0; 0 errors / **10 existing warnings** | `/tmp/app-code-followup-final-backend-openapi.log` |
| repository root | `node scripts/rust-cli.js test -p teamclu --lib --locked` with prefix below | exit 0; **436 passed / 0 failed / 0 ignored**; 0.64 s test time | `/tmp/app-code-followup-final-rust-unit.log` |
| repository root | `node scripts/rust-cli.js check --tests -p teamclu --locked` with prefix below | exit 0; 17.39 s | `/tmp/app-code-followup-final-rust-check.log` |

Both Rust commands use this command-local prefix and the worktree's own target:

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

The existing same-version static library was a read-only input. Host: Darwin
arm64. These are check/test builds, not valid configured release builds.

### Skips and warnings in that historical run

- Frontend **10 skipped tests**: nine opt-in live session-binding cases
  (`SESSION_BINDING_LIVE`) and one mid-turn follow-up case
  (`REPRO_MID_TURN_LIVE`). No live daemon acceptance is implied.
- Backend **13 skipped tests**: three `live-sync-query.test.ts` cases require
  `FC_LIVE_TEST=1`; five `sync-flow.test.ts` cases cannot reach local Supabase
  at `127.0.0.1:54321` (`TypeError: fetch failed`); five `sync-mode.test.ts`
  cases report “local Supabase not available or fixtures failed” (current mode,
  unknown team, owner mode change, invalid mode, direct UPDATE guard).
- Separately, **five skipped suites** in `self-host-e2e.test.ts` require
  `FC_E2E=1`: Auth, Runtime config, Team lifecycle, Session + Messages, Storage.
  These suites are not part of the 13 skipped-test count. The isolated SQL
  acceptance below does not retroactively execute these HTTP/account suites.
- OpenAPI: six pre-existing `no-ambiguous-paths` warnings (sessions by-acp,
  threads, thread-summaries, messages, mute; actor access), three
  `operation-4xx-response` warnings (public config, team quotas, workspace git
  config), one `operation-2xx-response` warning (OAuth authorize).
- Frontend: existing Vite future-native-loader `__dirname` warning at
  `vite.config.ts:9:41`; jsdom canvas/navigation notices remain visible.
- Rust: ignored nested package profiles, unset check/test `CLOUD_API_URL`,
  upstream `block`/`imap-proto` future incompatibility. Existing backend fixture
  warnings, including app-grants without a service-role key, remain classified
  as test-environment noise. No credentials or global warning suppression added.

### Historical red snapshot and resolved causes

The 2026-10-19 logs remain valid evidence for the earlier revision, not the final
current outcome: `/tmp/task7-frontend-unit.log` recorded **4,127 pass / 1 fail /
10 skip**; `/tmp/task7-backend-unit.log` **1,571 pass / 2 fail / 13 skip**;
`/tmp/task7-rust-lib.log` **430 pass / 1 fail**. Both typechecks, lint and Rust
check already passed. Earlier focused/baseline green runs did not override that
red snapshot. The user's resumed Task 7 explicitly authorized repairing those
failures; reviewed commit `25381e68` contains the following repairs:

1. **Offline reconnect test:** seeing the offline notice did not prove React's
   passive `online` subscription was installed before a synthetic event. Initial
   render now uses awaited asynchronous `act`. The production component,
   behavioral assertions and default `waitFor` deadline are unchanged. Temporary
   diagnostic stress reproduced **1 failure / 1,001 passes** before the change
   and **1,002/1,002** after it; ordinary focused result **3/3**.
2. **PORT environment fixtures:** finalization gets its port from the parsed
   deployment declaration. The old fixture omitted that input. It now supplies
   actual parsed node/.output/server/index.mjs/port 9000 settings; platform
   override and no-user-env assertions remain. Focused app-env/provisioning
   result **238/238**; no production environment behavior changed.
3. **DNS/HTTPS tests:** the actual local resolver returned an address for the
   old `.invalid` name, and external HTTPS tests depended on Internet/proxy
   behavior. Small private seams retain real OS lookup, 3-second budgets,
   HEAD/user-agent/any-status behavior, certificate/hostname verification and
   existing macOS-blocking/nonmacOS-advisory policy. Tests now use injected
   resolver outcomes plus real loopback HTTP/TLS, with a fresh in-memory CA and
   signed leaf (`rcgen`/`tokio-rustls`, dev-only). Matching TLS passes; wrong
   hostname and missing-root cases require certificate-specific errors.
   Mutating hostname enforcement caused the intended **0/1** failure;
   bypassing DNS rejection caused **0/2** failures; mutations were restored.
   Focused final webview result **29/29**. No production `.invalid` exception,
   TLS relaxation, test skip, longer deadline or retry was introduced.

Detailed RED/GREEN/mutation and dependency evidence is retained in the ignored
plan artifact `task-7-followup-failures-report.md`; its independent review
approved the repairs. The historical `example.com` reachability timeout from
Task 6 was not an additional failure in the original final run.

## Historical fully migrated isolated database acceptance

**PASS: 130/130 migrations; feature `043_apps_public_code.sql` 13/13 assertions;
full pgTAP runner 50 files / 0 failed / 0 quarantined, exit 0.** No failed SQL
test was quarantined, skipped or removed.

This used the exact CI image `public.ecr.aws/supabase/postgres:17.6.1.106`:
OCI index SHA256 `21ab971149317ea9cd12a8126fe4ebb34def08c8972956b0958cba0924409dab`,
linux/arm64 manifest SHA256
`fe361a60055b8970e35f4d4a5cd9b85388b711db2ad66815d8dd9e9968b9c3dd`.
Actual runtime: **PostgreSQL 17.6 aarch64, pgTAP 1.3.3, pg_net 0.20.0,
supabase_vault 0.3.1, pgcrypto 1.3, uuid-ossp 1.1**. Migrations run from
`20260601000000_baseline.sql` through
`20261019000000_apps_public_code.sql`, with the repository's explicit CI
GoTrue/Storage bootstrap. This proves the fully migrated CI schema, not a real
GoTrue account or live schema.

Commands executed in a fresh task-only Linux guest (`nc` is its task runtime):

```sh
nc() { sudo env PATH=/tmp/ac-tools/bin:/usr/local/bin:/usr/bin:/bin /tmp/ac-tools/bin/nerdctl --address /tmp/ac-containerd/containerd.sock "$@"; }
nc run -d --network none --name app-code-pgtap --mount type=bind,src=/tmp/app-code-repo,dst=/work,ro -e POSTGRES_PASSWORD=postgres public.ecr.aws/supabase/postgres:17.6.1.106
# Wait for the second ready message and a successful superuser query, as CI does.
pgexec() { nc exec -e PGUSER=supabase_admin -e PGPASSWORD=postgres -e PGDATABASE=postgres app-code-pgtap "$@"; }
pgexec psql -v ON_ERROR_STOP=1 -f /work/services/supabase/tests/ci-bootstrap.sql
pgexec bash -c 'MIGRATIONS_DIR=/work/services/supabase/migrations bash /work/deploy/self-host/init/apply-migrations.sh'
pgexec psql -v ON_ERROR_STOP=1 -qtA -f /work/services/supabase/tests/043_apps_public_code.sql
pgexec bash -c 'cd /work/services/supabase/tests && bash run.sh 043_apps_public_code.sql'
pgexec bash -c 'cd /work/services/supabase/tests && bash run.sh'
```

Source export `repo-a7cefd31.tar` SHA256:
`e35517edf712d3d64d327c7c340f1a2c6c4d7a99bf95e83e4deeb03de240a6d2`.
Local report: `/tmp/app-code-database-acceptance.md`; raw evidence:
`/private/tmp/ac-lima.pdWEEx/evidence/`, especially `database/migrations.log`,
`database/043-raw-tap.log`, `database/043-runner.log`,
`database/full-pgtap.log` and `database/database-metadata.log`.

Task-only Lima guest `ac` was shut down and confirmed **Stopped aarch64**; no
task service remains running. Its approximately 7.9 GiB disk is retained for
possible resumption. Existing user VMs were never started or changed. Setup
TLS/readiness/disk issues and cleanup warnings remain in the local report;
none is counted as a passing native/account check.

## Historical frontend browser and native acceptance

**Frontend production-component browser acceptance: PASS.** Real Chrome via CUA
at `http://127.0.0.1:43191` rendered actual worktree
`AppDeployConfirmDialog`, `publicDeployConfirm`, `legacyAppDomainChoice`, i18n
catalogues and production globals/Tailwind, in a temporary harness with no Cloud
API, daemon, real deployment consumer or account. Synthetic URLs use
`example.test`; callback logs are stub intent, not deployed requests.

Observed in English and Chinese at 1920×837: checkbox and both URLs/hint visible,
addresses wrap without clipping; initially unchecked; unchecked accept forwards
false, checked accept true; reopening resets to unchecked, including after a
language change; checked Cancel and Escape return rejection with zero stub
deploy calls/no choice callback; already-code and undeployed fixtures hide the
checkbox while preserving ordinary confirmation. One dialog is present per
attempt, initial focus is Cancel, and the checkbox label includes both URLs and
hint. Temporary harness CSS scanning was corrected before these observations;
no tracked component/style was edited.

Detailed local evidence: `/tmp/app-code-ui-acceptance/report.md` and
`results-ax.txt`. This accepts the actual dialog in a browser; full app/store
flow remains automated evidence, and live login/deployment remains untested.

**macOS native widget/shared-path acceptance: PASS within the following fixture
boundary.** A standalone temporary Tauri app imports unchanged production
`confirm/app_domain.rs`, which imports the exact AppKit adapter. Production
`show_checkbox`, shared lifecycle/native presentation, the same 120-second
timeout, display mutex and parent watcher execute. Build exit 0; the controller
operated the actual native checkbox/sheet through CUA accessibility/native input.
No deployment, Cloud API, daemon or network consumer exists. In this original
nine-case phase, unused outer ordinary-confirmation/deploy helpers panic if
reached. These nine cases do not exercise real `handle_app_manage`, the then-existing
approval-cache bypass, eligibility, localized deployment text, API serialization, finalization
or ordinary/checkbox mixed sequences. The later mixed attempt is separate below.

All **nine request outcomes matched their observed choices** in
`/tmp/app-code-native-acceptance/results.jsonl`:

| Request | Actual native observation and result |
| --- | --- |
| 1 | Starts unchecked; Record approval returns `accepted:true, switch_domain:false` (`Ok(false)`, not rejection). |
| 2 | Starts unchecked; actual checkbox selected; approval returns `accepted:true, switch_domain:true`. |
| 3 | Reopened after checked approval starts unchecked; checked then Decline returns rejection. |
| 4 | Starts unchecked; checked then Escape returns rejection. |
| 5 / 6 | Two requests queued, only #5 shown. Unattended unchanged timeout rejects/closes #5 at **120,277 ms**; only then #6 appears unchecked and approves false at **151,093 ms total including queue wait**. |
| 7 | Checked sheet; actual parent `close()` rejects at 11,334 ms and closes the sheet; parent restored. |
| 8 | Checked sheet; actual `CloseRequested` is prevented and parent hidden by the fixture tray hook; production parent watcher rejects at 12,449 ms and closes the sheet. Log records `parent_close_prevented_hidden`. |
| 9 | Same hidden parent restored; fresh unchecked sheet approves false, demonstrating cleanup releases the next display. |

AppKit provides no independent popup-close button on this sheet; Escape and
parent close were exercised. Late callbacks/requester disconnect are covered by
the shared automated tests; no physical stale callback was fabricated in GUI
acceptance. Queue timings include scheduling and interaction, not a shortened
approval deadline.

Detailed controller observations: `/tmp/app-code-native-acceptance/manual-results.md`;
full AX proof: `queued-after-timeout-ax.txt`; source hashes, build/runtime logs and
raw records remain in that directory. Recorded production source SHA256 hashes
match the current source: shared module
`8a57af40a10118d04f2d0651c4f6487198c4016ad1a2dcc2ac1c1436ab4c5780`,
AppKit adapter
`6f1ec10d041189310a5129eaf8255ab35c5692f69f80b2740f16e3cf1d2aafc3`.
The earlier harness setup report's “pending” entries precede these final manual
observations. Harness-only setup corrections (valid temporary app bundle, event
bindings without changing CSP, tray-close control) changed no tracked product
code or approval choice. No host security/global trust/proxy setting changed.

### Attempted mixed ordinary/checkbox acceptance: tool blocked

A later harness extension included a byte-exact slice of production
`confirm_with_user`, its single `ONE_AT_A_TIME` mutex and unchanged 120-second
timeout, alongside the existing production checkbox module and actual
`tauri-plugin-dialog` 2.7.0. The ordinary call held that same mutex before the
checkbox queued. Its installed rfd 0.16.0 unparented macOS path uses
`CFUserNotificationDisplayAlert`, hosted by system UserNotificationCenter.
CUA explicitly denied access: **“Computer Use is not allowed to use app
com.apple.UserNotificationCenter.”** No alternative automation route, system
helper termination or security-setting change was attempted.

Ordinary request **#10** returned real timeout rejection at **120,005 ms**;
`ordinary-accept` was only the intended scenario label, not an observed approval.
Queued checkbox **#11** then appeared unchecked and was manually Declined for
cleanup, returning rejection at **147,776 ms including queue wait**. Ordinary
approve/decline could not be exercised, and ordinary popup visibility/disposal
after timeout remains **UNKNOWN / NOT OBSERVED**. This is an attempted check
blocked by the tool restriction, neither a mixed GUI pass nor an observed orphan
or product-defect reproduction. Original checkbox-only requests **1–9 remain
9/9 passed**, independently of this blocked mixed phase.

Final evidence: `/tmp/app-code-native-acceptance/mixed-report.md`,
`ordinary-source-provenance.json`, `post-mixed-results.jsonl` and `results.jsonl`.
The owned harness app was quit after #11 cleanup and its process absence checked;
UserNotificationCenter remained untouched. A system-hosted acceptance-test
notification might need the user's own dismissal if still visible; its current
visibility could not be inspected, so no stale-notification claim is made.

## Live dev migration addendum — 2026-10-20

Applied and verified at approximately 20:33 Asia/Shanghai, after the user explicitly
requested review and application. Target: self-hosted dev ECS `47.112.210.217`,
bundled `postgres` database, `amux.apps`. The running FC uses bundled Kong;
Studio uses the same API target and pg-meta points to `db` / `postgres`.
Remote checkout observed during connection setup: `e4525dd780595641bc7591d65e352e9bdfc0e36f`;
this is a checkout observation, not proof of the FC image's source revision.

- Connection: Codex server `supabase-self-hosted-dev`, through an SSH tunnel
  bound only to `127.0.0.1:18080`, to the existing internal Studio `/api/mcp`.
  Native tools were exposed in this chat and a read-only query succeeded.
  No gateway edits, container restarts, public MCP port or credential disclosure.
- Applied the unchanged versioned `20261019000000_apps_public_code.sql`, SHA-256
  `cfc2f7b603dcd6bcd7adef602a8dd04f269b77e36c790f25097909181a43efe7`,
  using MCP `apply_migration` (`apps_public_code`), which returned success.
  An operational transaction wrapper used a 5-second lock timeout and 30-second
  statement timeout, locked `amux.apps`, captured a temporary before-image,
  asserted every original app field was unchanged and legacy modes stayed false,
  and recorded the exact filename in `_selfhost.schema_migrations` before commit.
  The ledger has exactly one entry for this filename; no CLI/SQL fallback was used.
- Separate post-apply read-only MCP queries confirmed **47 apps, 47 distinct valid
  12-character codes, 47 false legacy domain modes and 47 null pending choices**.
  All original fields, including IDs, names, deployment resources/statuses/tokens,
  endpoints, custom domains and timestamps, have the identical before/after
  ordered-row fingerprint `f14c40e0119549be84baefe462ed4c8a`. The in-transaction
  per-row comparison also passed, so this is not merely a count comparison.
- Verified code NOT NULL/default generator, new-row mode default `true`, nullable
  pending choice, validated unique/format constraints and enabled immutable-code
  trigger. Both new functions are security invoker with fixed `pg_catalog`
  search paths. Existing table grants are unchanged; RLS stays enabled and the
  policy fingerprint remains `02c91cd1cf372b0a744669b33ee0c166`.
- A read-only generator sample produced **1,000 valid, distinct codes**. Live
  fixture inserts or attempted updates of existing apps were not performed;
  immutable behavior/default insertion tests remain covered by the isolated
  feature pgTAP 13/13 run, not a new live behavioral test claim.
- Security advisors returned **123 findings before and 123 after, no new finding
  keys**. A pre-existing warning says `public.execute_sql(query text)` is security
  definer and executable by `anon` / `authenticated`; its actual reachability and
  remediation require a separate review. No unrelated permissions were changed.
  [Advisor remediation](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).

This addendum records direct MCP evidence, not a new independent review or a
service/client rollout. All remaining platform, real-account and deployed
integration gates below remain open. The prior local suite results were not rerun.

## Current-main integration addendum — 2026-10-20

Source merge `bf99b359` combines feature parent
`a2a8d278a0bc858300d7f5c3dc84f07bf8bc45e6` and pinned main
`ba604cf9dda7a8f39bd59d576daca19ab91587be`. The historical results above
remain snapshots of their original revisions. The following checks were freshly
run on the integrated source:

| Check | Fresh result |
| --- | --- |
| Full backend | 1,982 passed, 13 skipped, 0 failed (1,995 tests) |
| Backend test types / production compilation | Exit 0 / exit 0 |
| Full frontend | 4,366 passed, 10 skipped, 0 failed (620 passed files, 1 skipped) |
| Frontend types | Exit 0 |
| macOS Rust check / library tests | Exit 0 / 465 passed, 0 failed, 0 ignored |
| OpenAPI | Valid with 11 warnings; pinned main produces the same 11 rules/locations |

The merge retains main's preflight and lifecycle protections, current
organization authorization and protected-origin signing. Frontend and native
domain choice now share the post-preflight confirmation with the runtime preview.
Both branches' relevant test families were kept; old app-code fixtures now use
current declarations, preflight tokens and artifact verification. The retry
repository double explicitly simulates the existing database failure-cleanup
trigger; this is not a new database behavioral test.

Backend live/local-database skips, frontend skips, jsdom canvas/navigation
diagnostics and Rust analysis-build warnings remain explicit limits. No SQL,
native GUI, Windows/Linux, real-account or deployed integration acceptance was
rerun in this source integration task. The already-applied migration file is
unchanged. Independent task-scoped review of the merge and final whole-feature
source review approved implementation quality at `de097203`, with no
Critical/Important source findings. The remaining rollout gates below are not
closed by these reviews or test results.

## Remaining gates and limits

| Gate | Current status / next evidence |
| --- | --- |
| Complete isolated migrated CI-schema/feature SQL | PASS as above; supersedes the old missing-local-pgTAP blocker |
| Live migration/read-only schema verification | PASS on self-hosted dev, 2026-10-20: authorized migration applied through `supabase-self-hosted-dev`; post-apply read-only MCP verification passed; see live addendum |
| Real-account legacy/code/retained-alias login and inactive-candidate rejection | BLOCKED: exact GoTrue `v2.188.1` image/blob delivery failed TLS after bounded official-registry/proxy attempts; no real GoTrue process/JWT, RLS/account/callback/cookie flow ran |
| macOS Rust suite/compile | PASS on `bf99b359`: 465/465, check exit 0; not a release-build claim |
| macOS checkbox native GUI | Historical PASS for the nine widget/shared-path requests above; current preflight-first handler acceptance not established |
| macOS ordinary/checkbox mixed GUI | ATTEMPTED / TOOL BLOCKED: CUA forbids UserNotificationCenter; real ordinary timeout and queued unchecked cleanup observed, ordinary decisions/teardown unknown |
| Windows native compile/tests/interaction | BLOCKED: Windows host unavailable; source inspection is not validation |
| Linux native compile/tests/GTK interaction | BLOCKED: fresh Linux guest exists, but pinned Rust 1.97.1 metadata and official image retrieval fail TLS; GTK dependencies/check/tests/Xvfb interaction NOT RUN |
| Frontend browser component layout/interaction | PASS EN/ZH, within the harness boundary above |
| Real deployed auth env/custom-domain/Traefik/cron integration | PENDING: passing automated integration tests do not prove deployment behavior |
| Current evidence review | Task-scoped integration and final whole-feature source reviews approved at `de097203`; historical `18ceba84` evidence and `18ceba84..60e1f08a` mixed-evidence amendment remain approved within their documented boundaries; release gates remain open |

A fresh separate auth DB and exact PostgREST image were prepared; failed GoTrue
retrieval prevented actual account acceptance. Do not describe the reduced CI
auth bootstrap, synthetic JWT/SQL fixtures or Host-header simulation as a real
account pass. The task auth DB was stopped before guest shutdown. No production
credentials/account writes or live-system connection were used for that isolated
account attempt. The later authorized dev migration is recorded in the addendum
above.

Windows/Linux acceptance must include first/repeated unchecked state, both
approved choices, decline, Escape, popup/parent close or hide-to-tray, unattended
120-second timeout and queued requests; cover disconnect/stale callbacks at the
applicable automated and native boundaries. Observe one real popup and inspect
only a safe stub consumer. The macOS result above cannot stand in for either host.

The checkbox path retains the display mutex until its own native teardown.
Pre-existing ordinary approval releases its mutex on timeout/caller drop without
closing its OS popup. This feature establishes no global teardown guarantee for
every ordinary/checkbox sequence; the mixed attempt above could not establish
GUI teardown/decision acceptance because system-helper access was denied.
A direct handler-level regression test for rejection/cancellation, request
serialization and suppression of deployment after the current preflight-first
confirmation remains a minor reviewed follow-up. The old approval-cache bypass
is no longer the production mechanism; source inspection and shared lifecycle
tests are not that handler integration test. Existing warning
cleanup is the other minor follow-up, outside this feature's acceptance scope.

## Release order (database steps completed; publication not executed)

1. Complete remaining native platform/manual, real-account and deployed
   integration gates. Retain the recorded skip and
   harness boundaries; all executed current suites pass, but these missing
   gates are not implied to pass.
2. Live-schema authorization and private self-hosted MCP setup: **completed**
   for dev. Obtain separate service/client publication authorization.
3. Dev migration through Supabase MCP: **completed and recorded** before
   releasing the updated Cloud API. Keep matching migration and
   `043_apps_public_code.sql` versioned.
4. Read-only MCP schema and preservation verification: **completed** for dev,
   as detailed above. Verified columns/defaults, generator and
   immutability functions/trigger, NOT NULL/format/unique constraints, valid
   unique codes on all rows and false legacy mode on pre-existing apps.
   Compared pre/post UUIDs, resources, deployment/status fields, endpoints and
   bindings. A controlled live new-row default check needs separately authorized
   safe setup.
5. Release the updated Cloud API via the existing process for the intended
   target (self-host and Belayo are distinct). Verify legacy apps preserve
   current URLs, inactive candidates fail closed, and auth/audience/permissions
   remain enforced.
6. Release desktop clients after target-host acceptance. In an explicitly
   authorized safe deployment, verify unchecked/cancel/failed attempts preserve
   legacy mode; checked successful finalization alone activates code mode;
   old URL remains an authenticated alias. Verify login/auth env/custom-domain/
   cron behavior in both modes.

No release version was bumped. This document authorizes no push, PR, merge,
tag, publication, live migration or deployment.
