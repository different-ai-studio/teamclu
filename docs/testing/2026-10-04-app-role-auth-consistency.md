# Application role authorization consistency verification

Date: 2026-10-04. Worktree: `.worktrees/app5-deploy`; branch: `docs/app-role-auth-spec`.
Task 4 base: `69f4a76f`. Implementation/regressions/guidance commit: `1017b51d`.
Approved scope is platform code, local mocks and documentation. No live app permission,
organization role/member, schema, service deployment, application deployment, push or PR writes.

## Changes and evidence

- Stored root paths `/ ` and `///` now produce one non-inherited root explanation,
  matching gateway read normalization while leaving raw rules unchanged. Leading-space
  ` /` remains unreadable. RED: auth-info suite 3 passed/1 failed (duplicate root and
  inherited flag); GREEN included in focused FC regression.
- An empty directory still exposes selected orphan-role checkboxes. RED: editor suite
  23 passed/1 failed (checkbox absent). GREEN: 24 passed, including actual inactive
  catalog entries, explicit removal blocked from saving an empty fixed list, and old
  write/readback completion ignored after switching apps.
- Local persistent mock repository behind the real business PATCH/GET routes feeds
  `buildAppAuthInfo` and the gateway. Same cookie: reviewer passes dynamic org;
  fixed admin denies; admin OR reviewer allows; withdrawn active roles deny; future
  active role denies fixed list and passes dynamic org. Creator metadata does not
  bypass access. Denied PATCH preserves storage and discovery readback. No real
  database or member fixtures were changed.
- Resolver regression covers public, inherited, dynamic, fixed and roles=[] longest
  prefixes, encoded path fail-closed and malformed role arrays. Identity repository
  fixture proves the same auth account loses eligibility when its active binding
  becomes inactive or is removed. Existing gateway/proxy regressions continue to
  cover forged user/email/org header stripping and trusted header injection.
- Desktop local authenticated HTTP regression adds missing-field response handling:
  `App auth discovery unavailable: unreadable Cloud API response`, without bearer
  disclosure. Existing native approval and caller authorization behavior is unchanged.

## Commands and actual results

All commands ran from the task worktree unless a subdirectory is noted. Logs are
local `/private/tmp/task4-*.log` artifacts, not repository fixtures.

| Command | Result |
| --- | --- |
| `cd services/fc && node --import tsx --test test/apps-auth-paths.test.ts test/apps-auth-gate.test.ts test/apps-vanity.test.ts test/apps-org-role-identity.test.ts test/apps-auth-info.test.ts test/routes-apps.test.ts` | 196 passed, 0 failed |
| `pnpm --dir services/fc test` | 1661 passed, 0 failed, 13 skipped; this full run preceded two final test-only additions, which passed the focused run |
| `pnpm --dir services/fc typecheck` | Passed |
| `pnpm --dir packages/app test:unit src/components/apps/__tests__/AppAuthTabContent.test.tsx` | 24 passed |
| `pnpm --dir packages/app test:unit` | 4179 passed, 10 skipped; 606 files passed, 1 skipped |
| `pnpm --dir packages/app typecheck` | Passed |
| `node --test scripts/lib/deploy-app-skill.test.js` | 2 passed; existing source-contract gates preserved, not treated as consumer behavior proof |
| `pnpm --dir services/fc openapi:lint` | Passed with 11 existing warnings |
| `pnpm --dir services/fc openapi:types` | Passed, generated temporary `/tmp/teamclu-api.v1.d.ts` |
| `node scripts/rust-cli.js test --manifest-path apps/desktop/Cargo.toml commands::introspect_api::apps::tests -- --test-threads=1` | 25 passed |
| `pnpm rust:check` | Passed |
| `git diff --check` | Passed before commit |

Rust commands used `RUSTC_WRAPPER=/usr/bin/env`,
`CARGO_TARGET_DIR=/Users/dengwei/git/teamclu/.cargo-target`, and
`SHERPA_ONNX_LIB_DIR=/Users/dengwei/git/teamclu/.cargo-target/sherpa-onnx-prebuilt/sherpa-onnx-v1.13.7-osx-arm64-static-lib/lib`.
The first wrapper attempts failed on the inaccessible sccache socket; an empty
`RUSTC_WRAPPER` was automatically repopulated by the repository wrapper, so the
pass-through wrapper was used without altering repository configuration.
The initial FC RED invocation from repository root could not find `tsx`; the real
RED/verification commands ran from `services/fc`. Local Supabase was unreachable
for skipped FC integration tests. Existing Vite/jsdom and Rust dependency/config
warnings remain. Task 2's full desktop/tool suites and Task 3's broader checks are
recorded in their reports; unchanged full Rust suites were not redundantly run.

## Deployment reference consumer verification

Controller ran one read-only mock deployment scenario before the skill update and
again after it. Public SMS applicant flow and employee approval flow shared
`/_serverFn`; `/staff` login succeeded but an app creator-ID check denied, role
facts were initially unknown. Baseline did discover `auth_info`, and did **not**
propose fabricated IDs, but required “staff identity and role assignments” and
omitted a concrete gateway policy/actual endpoint/readback sequence.

Updated bundled reference produced status/runtime_info/auth_info discovery,
organization codes and raw/effective rules, no member-list dependency or creator-ID
allowlist, actual employee endpoint coverage without locking shared public paths,
untouched full-rule preservation, native approval and auth-info readback. A focused
followup after clarifying gateway ownership confirmed current organization roles
are checked by the gateway on protected requests; app code consumes trusted
platform identity and its business rules instead of reconstructing organization
authorization. This is one reference-consumer scenario plus clarification, not a
statistical study or a real deployment. Personal installed skills and session
prompt were not edited.

## Isolated dev desktop acceptance

Used the already running dev desktop at `http://127.0.0.1:1420/`, launched earlier
from this worktree. No production bundle was opened. Authenticated local
`execute_js` bridge mounted the actual React/Radix permission editor in a temporary
subtree with a fabricated app/org/reviewer catalog. Only that fixture's update
function wrote an in-memory object; all original interfaces were restored and the
webview reloaded after the probe. No remote permission write was performed.

Observed DOM/interaction assertions:

1. On open: `Any active organization role`; original rule
   `{path:'/reports',auth:'required',audience:'org'}`; Save disabled; zero mock writes.
2. Selecting fixed mode starts empty: `Select at least one role`; Save disabled.
3. Selecting reviewer and saving: persisted raw rule remains
   `{path:'/reports',auth:'required',roles:['reviewer']}`; code label `reviewer`;
   Save disabled after confirmation readback.
4. Rejected save: persisted fixed rule remains `/reports`; draft path
   `/reports/denied-draft` remains; `Saving failed. Your draft is preserved.`
5. Switching back to dynamic and saving: raw rule contains `audience:'org'`, no
   roles key; dynamic label displayed; Save disabled after readback.
6. Real read-only dev discovery returns `CloudApiError: Route not found`. New API
   is not deployed; no role catalog was guessed and no live write/deploy attempted.
7. Final cleanup readback: URL still dev, temporary fixture roots `0`, fixture
   handle absent. React import export and Vite HMR timestamp mismatches required
   probe retries and reloads; they were harness issues, not production changes.

The existing screenshot surface returned a black image; two initial output-dir
attempts were rejected by its temp-directory guard, and the accepted capture was
visually inspected. Therefore this record claims DOM and interaction verification,
**not successful screenshot visual QA**. Native interactive approval decline was
not exercised; unchanged confirmation/caller tests supply regression evidence.
Tool discovery mapping is verified by local HTTP Rust tests, rather than a fully
live UI-to-tool integration against an undeployed API.

## Remaining authorized deployment boundary

Deployment remains separate: first the compatible FC API, then updated desktop/
introspect, with isolated temporary accounts/fixtures and explicit platform deploy
authorization. Nothing here repairs app7's independent application-level creator
check, changes app6/app7 permissions, migrates authRules, or creates new roles.


## Final review compatibility fixes (base `3e2371f4`)

FC discovery now uses the gateway stored-rule reader for normalized non-root
explanation paths. Raw rules remain unchanged. Nullable roles/audience inherit
exactly as absent keys; public WHO fields do not affect editor meaning, and
nullable raw fields survive untouched/path-only edits. UI regression mounts the
real editor with successful nullable discovery and verifies zero initial writes
and preservation in an unrelated save payload.

Baseline editing and summaries use the first normalized root in either scope,
including public-first/required-later configurations. Only the selected root is
removed from exception rows; nonselected duplicates remain in original order for
write validation. Unrelated edits preserve original authScope. The controller
approved this correction to the plan's limited all-scope baseline discussion.
The matrix includes both scopes, both first/second verdicts and `/`, `/ `, `///`.

RED observed: FC auth-info 4 pass/2 fail (public misexplanation and null
inheritance); helper 17 pass/2 fail (null crash and public-root precedence).
Expanding the root matrix to paths then produced 43 pass/1 fail in combined UI
checks before correcting paths-scope baseline selection. Final results:

| Command | Result |
| --- | --- |
| `cd services/fc && node --import tsx --test test/apps-auth-info.test.ts test/apps-auth-paths.test.ts` | 44 passed |
| `pnpm --dir packages/app test:unit src/lib/apps/__tests__/app-auth-access.test.ts src/components/apps/__tests__/AppAuthTabContent.test.tsx` | 44 passed (19 helper + 25 editor) |
| `pnpm --dir services/fc test` | 1665 passed, 13 skipped, 0 failed |
| `pnpm --dir packages/app test:unit` | 4182 passed, 10 skipped; 606 files passed, 1 skipped |
| `pnpm --dir services/fc typecheck` | Passed |
| `pnpm --dir packages/app typecheck` | Passed |
| `cd packages/app && pnpm exec eslint src/lib/apps/app-auth-access.ts src/lib/apps/__tests__/app-auth-access.test.ts src/components/apps/__tests__/AppAuthTabContent.test.tsx` | Passed |
| `git diff --check` | Passed |

Logs: `/private/tmp/final-fix-fc.log`, `/private/tmp/final-fix-app.log`.
Supabase integration skips and existing Vite/jsdom warnings remain. This wave
made no live writes or deployment, no Rust production edits and no repeated
unrelated Rust checks; prior evidence above remains intact. A mistaken initial
test-writing cwd failed before editing files and was corrected; that unchanged
4-test pass was not counted as RED. A read-only process-list attempt was denied
by the sandbox; completed suite logs supply verification instead.
