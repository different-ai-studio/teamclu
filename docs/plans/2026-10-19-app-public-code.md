# Permanent App Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every app a permanent random 12-character code, with code domains for new apps and a successful-deployment-only domain opt-in for existing live apps.

**Architecture:** Store code identity separately from the current domain mode and the deployment attempt's requested mode. Resolve active code hosts through exact database lookup while preserving legacy aliases and auth. Put the unchecked migration choice inside the existing frontend/native deployment approval, using a native checkbox adapter on each desktop platform.

**Tech Stack:** PostgreSQL/Supabase migrations and pgTAP; Cloud API TypeScript/Node.js and PGlite; React/Zustand/Vitest; Rust/Tauri; AppKit, Windows Task Dialog, GTK 3.

**Spec:** `docs/specs/2026-10-19-app-public-code-design.md` (approved 2026-10-19, initially committed as `ae418263`). Read both documents before execution.

## Global Constraints

- The random portion is exactly 12 characters, alphabet `0123456789abcdefghjkmnpqrstvwxyz`, preserving 60 cryptographically secure random bits. The hostname is `a-<appCode>.<APPS_PUBLIC_DOMAIN>`.
- Existing UUIDs, resources, deployments, endpoints, and domain bindings remain intact during backfill. Existing apps retain legacy mode until explicit successful opt-in; new rows default to code mode.
- Only a legacy app with `fcStatus: live`, a deployment endpoint, and distinct nonempty current/candidate URLs gets the unchecked checkbox in its existing confirmation. No second popup or button-only substitute.
- An agent cannot provide or preselect the checkbox value. Preserve native approval, its 120-second timeout, and serialized display.
- Keep aliases behind the same auth gate. A candidate code URL must not route or be an allowed login origin before activation.
- Cloud API remains the only client backend. Define API changes in OpenAPI before providers. Database tests stay alongside migration SQL.
- Work on `codex/app-public-code`; preserve unrelated checkout edits. No push, PR, publishing, or live deployment without the corresponding user authorization.
- Live schema changes require Supabase MCP, which is currently unavailable. Local database commands below apply only to an isolated local test database, never a live environment.
- Use repository Rust wrappers. Validate native adapters on their own operating systems; a macOS build does not verify Windows/Linux code.

## Review Focus

1. A failed checked deployment followed by an unchecked retry must not inherit the failed attempt's migration choice (Task 4).
2. Candidate-host negative caching must clear on activation, and auth changes through one alias must protect both aliases immediately on that instance (Tasks 2–3).
3. Concurrent/forced code collisions must retry only code uniqueness failures, stop after five creation attempts, and reuse one workspace (Task 1).
4. A timed-out or dismissed native dialog must close and ignore late callbacks; a checkbox from the previous attempt must not carry over (Task 6).
5. Missing mode fields from an older server, identical current/candidate URLs, and non-live legacy rows must hide the checkbox and never submit migration (Task 5).

---

## Execution context and file structure

This plan reconciles an existing uncommitted draft; it is not a greenfield implementation. Keep correct draft work after review. Do not replay completed edits or claim an existing green test is a new failing test. For retained draft behavior, demonstrate the regression test with a temporary, narrowly scoped mutation and restore it; never reset whole files containing unrelated edits.

The checkout already contains unrelated changes in `apps/daemon/src/sync/app_build.rs`, `apps/desktop/crates/teamclu-introspect/src/apps.rs`, `services/fc/test/app-env.test.ts`, `services/fc/test/provisioning/app-runtime-spec.test.ts`, and `services/fc/test/fixtures/daemon-short-form-declaration.json`. Exclude these from task commits. Snapshot and inspect the full working diff before execution to identify any additional concurrent edits.

| Unit | Files and responsibility |
| --- | --- |
| Identity storage | `services/supabase/migrations/20261019000000_apps_public_code.sql`, `services/supabase/tests/043_apps_public_code.sql`; generation, backfill, constraints |
| Creation/API | `services/fc/src/lib/supabase-repo.ts`, `services/fc/src/lib/supabase-repo/shared.ts`, `docs/openapi/teamclu-api.v1.yaml`, `packages/app/src/lib/backend/types.ts`; bounded retries and representation |
| Routing | `services/fc/src/lib/apps-public-host.ts`, `services/fc/src/lib/apps-vanity.ts`; URL construction, parsing, exact lookup, cache invalidation |
| Integrations | `apps-auth-gate.ts`, `apps-login-service.ts`, `apps-custom-domain.ts`, `apps-traefik-provider.ts`, `app-cron-runner.ts` under `services/fc/src/lib/`, plus `provisioning/app-auth-mode.ts`; current-domain consumers |
| Deployment | `services/fc/src/lib/supabase-repo.ts`, `services/fc/src/lib/provisioning/app-deploy.ts`; token-bound requested mode and success-only activation |
| Frontend approval | `packages/app/src/lib/apps/app-deploy-confirm.ts`, `packages/app/src/components/apps/AppDeployConfirmDialog.tsx`, `packages/app/src/stores/apps-store.ts`, both locale files |
| Native approval | `apps/desktop/src/commands/introspect_api/confirm.rs`, `confirm/app_domain.rs`, new `confirm/app_domain/{macos,windows,linux}.rs`, and `apps/desktop/src/commands/introspect_api/apps.rs`; orchestration separated from OS widgets |
| Evidence | Existing domain/deploy tests plus `services/fc/test/app-code.test.ts`, `packages/app/src/lib/apps/__tests__/app-domain-choice.test.ts`, and new `docs/testing/app-public-code-acceptance.md` |

Tasks 1–4 establish shared backend interfaces. Tasks 5–6 consume them; do not run overlapping edits to the same files concurrently. Task 7 validates the final integrated branch. Each commit stages only that task's intended hunks/paths, never `git add -A`.

### Task 1: Reconcile permanent code generation and creation retries

**Files:** Migration and pgTAP paths above; modify `services/fc/src/lib/supabase-repo.ts` creation only; create `services/fc/test/app-code-schema.test.ts` by moving the draft PGlite schema test out of `app-code.test.ts`; test `services/fc/test/supabase-repo.test.ts` creation cases.

**Interfaces:** Consumes the existing `createApp(input)` and app/workspace schema. Produces `amux.generate_app_code() RETURNS text`, immutable unique `app_code text NOT NULL`, `uses_app_code_domain boolean NOT NULL`, and nullable `deploy_use_app_code_domain boolean`.

- [ ] **Step 1: Inventory and preserve the checkout.** Record `git status --short`, current branch, and staged/unstaged diffs. Keep the existing task branch; if isolation is needed, follow using-git-worktrees without discarding or duplicating these drafts. Save the relevant draft/test baseline outside the index.
- [ ] **Step 2: Add missing failing behavior tests.** In PGlite, create two legacy rows with existing endpoints/functions, run the actual migration, and assert those fields are identical, both modes are false, and codes match `/^[0-9a-hjkmnp-tv-z]{12}$/`. Insert a new row and assert mode true. Assert rename preserves code; malformed, null, duplicate, and reassigned codes fail. Inject code-conflict errors into `appsRepo`: the sixth insert is never attempted, only one workspace is inserted, and a slug conflict is not retried.
  Name the schema case `backfill preserves existing deployments and assigns independent codes`; keep `deploymentsBefore`/`deploymentsAfter` as queries of the same original columns:

  ```ts
  assert.deepEqual(deploymentsAfter.rows, deploymentsBefore.rows);
  assert.equal(legacyRow.uses_app_code_domain, false);
  assert.equal(newRow.uses_app_code_domain, true);
  assert.match(newRow.app_code, /^[0-9a-hjkmnp-tv-z]{12}$/);
  ```

- [ ] **Step 3: Run the regression tests before implementation.** From `services/fc`, run `node --import tsx --test --test-name-pattern='migration|code collision|slug conflict' test/app-code-schema.test.ts test/supabase-repo.test.ts`. Expect the missing assertions to fail for their named behavior. For already-green draft coverage, use the scoped regression-proof procedure above.
- [ ] **Step 4: Reconcile the migration and retry loop.** Preserve 60 secure random bits without UUID version/variant bits. Backfill with collision retry and false domain mode, then default new rows to true. Keep code immutability in a database trigger. Retry only PostgreSQL `23505` for `apps_app_code_key`, up to five attempts, reusing the workspace. Do not change the team-local slug constraint or external resources.
- [ ] **Step 5: Verify and commit this deliverable.** Run the Task 1 tests and `bash services/supabase/tests/run.sh 043_apps_public_code.sql` only against a migrated isolated local database. Expect all assertions to pass; if local PostgreSQL/pgTAP is absent, record that acceptance gap while keeping PGlite mandatory. Stage migration, pgTAP, creation hunks, and owning tests; commit `feat: assign permanent random app codes`.

### Task 2: Define code URLs, app responses, and exact routing

**Files:** Modify OpenAPI first, then `apps-public-host.ts`, `apps-vanity.ts`, `supabase-repo/shared.ts`, and frontend `backend/types.ts`; test `app-code.test.ts`, `apps-vanity.test.ts`, `supabase-repo.test.ts`.

**Interfaces:** Consumes Task 1 columns. Produces `appPublicUrl(slug: string | null | undefined, appId: string | null | undefined, env?: NodeJS.ProcessEnv, appCode?: string | null): string | null`; `parseAppPublicHost(host, env)` returns `{appCode: string}` or legacy `{slug: string, idPrefix: string}` or null. App responses expose `appCode: string`, `usesAppCodeDomain: boolean`, `appCodeUrl: string | null`, and existing `publicUrl: string | null`. Frontend fields may be optional for older-server compatibility.

- [ ] **Step 1: Pin missing routing assertions.** Use code `k7m2q9vx4n8p` and assert the exact URL `https://a-k7m2q9vx4n8p.apps.example.com` survives Chinese names, rename, empty slug, and long slug. Disabled/unknown codes return no app; exact matches never select another team's app. Two matches fail closed. Reject malformed codes, nested labels, and wrong suffixes; allow hostname case/port normalization. No configured domain yields null.
  Keep `app-code.test.ts` focused on public identity/routing; move schema coverage to Task 1 and integration coverage into Task 3's owning files. Name the URL test `Chinese names do not affect code hosts`:

  ```ts
  assert.equal(appPublicUrl("门店大盘", "18e4ecad-6189-495b-a873-7fe09179a5f5",
    { APPS_PUBLIC_DOMAIN: "apps.example.com" }, "k7m2q9vx4n8p"),
    "https://a-k7m2q9vx4n8p.apps.example.com");
  ```

- [ ] **Step 2: Run tests red.** From `services/fc`, run `node --import tsx --test test/app-code.test.ts test/apps-vanity.test.ts`; expect the newly uncovered behavior to fail before adding it.
- [ ] **Step 3: Define the API contract and implement.** Document the read-only fields and optional boolean deployment-start `useAppCodeDomain` in OpenAPI before providers. Keep the old URL helper call form valid. Query code hosts with exact `app_code` equality and active mode, using the unique index; preserve ASCII/Punycode legacy parsing and ambiguity rejection. `appCodeUrl` is only a candidate; `publicUrl` follows current mode. Update selected columns and mapping together.
- [ ] **Step 4: Test cached misses.** In `apps-vanity.test.ts`, cache a disabled code host as absent, activate the row, invalidate app hosts, and assert the next lookup sees it immediately. Include legacy and code entries; never turn an invalidation into a throwing URL parse.
- [ ] **Step 5: Verify and commit.** Run the owning tests, `pnpm openapi:lint` and `pnpm typecheck` from `services/fc`; expect zero errors and classify pre-existing warnings. Commit only Task 2 files/hunks as `feat: resolve apps by active code domains`.

### Task 3: Keep login, custom domains, and cron consistent

**Files:** Integration files from the structure map; tests `services/fc/test/apps-login-service.test.ts`, `apps-auth-gate.test.ts`, `apps-custom-domain.test.ts`, `apps-traefik-provider.test.ts`, `app-cron-runner.test.ts`, `apps-vanity.test.ts`.

**Interfaces:** Consumes Task 2 URL helper and app fields. Produces `appOrigins(app: {id: string; slug: string; appCode?: string | null; usesAppCodeDomain?: boolean; customDomain?: string | null; customDomainVerifiedAt?: string | null}, env?: NodeJS.ProcessEnv): string[]`. Extend `buildPlatformAuthEnv(input: {appId: string; slug: string; appCode?: string | null}, env?): Record<string,string>` without changing other env semantics.

- [ ] **Step 1: Add failing integration cases.** In legacy mode, login rejects the code origin and custom-domain CNAME/cron use the old URL. After activation, login accepts both aliases, CNAME/Traefik/cron use the code URL, and verified custom domains remain accepted. For an unauthenticated protected request, both aliases redirect to login; an unverified custom domain remains refused. Change auth via one alias, invalidate, and assert the other immediately enforces it on the same instance.
  Name the login-origin case `disabled code origins are rejected until activation`:

  ```ts
  assert.deepEqual(appOrigins({ id: "18e4ecad-6189-495b-a873-7fe09179a5f5",
    slug: "shop", appCode: "k7m2q9vx4n8p", usesAppCodeDomain: false },
    { APPS_PUBLIC_DOMAIN: "apps.example.com" }),
    ["https://shop-18e4ecad.apps.example.com"]);
  ```

- [ ] **Step 2: Run tests red.** From `services/fc`, run `node --import tsx --test test/apps-login-service.test.ts test/apps-auth-gate.test.ts test/apps-custom-domain.test.ts test/apps-traefik-provider.test.ts test/app-cron-runner.test.ts test/apps-vanity.test.ts`. Expect failures specifically for any missing code-mode propagation.
- [ ] **Step 3: Propagate current mode at every read boundary.** Select and map both code and mode in gateway/login/custom-domain/Traefik/cron reads. Use one address-selection rule rather than reconstructing names. Preserve role checks, auth policies, verified-domain checks, and origin endpoints. Pass code metadata into invalidations after auth, domain, deploy, and delete operations.
- [ ] **Step 4: Verify and commit.** Repeat the Task 3 command and backend typecheck; expect all integration assertions to pass. Commit `fix: keep app domain integrations consistent` with only owning changes.

### Task 4: Bind domain choice to one deployment attempt

**Files:** Modify `services/fc/src/lib/supabase-repo.ts`, `services/fc/src/lib/provisioning/app-deploy.ts`; test `services/fc/test/supabase-repo.test.ts` and `services/fc/test/routes-apps.test.ts`.

**Interfaces:** Consumes Task 1 state and Task 2 contract. `deployApp(appId: string, input: {gitCommitSha?: string; runtime?: string; useAppCodeDomain?: boolean})` records `currentMode || input.useAppCodeDomain === true` alongside the new token. `finalizeDeploy(appId, input)` retains its token/declaration API and activates only the persisted attempt's requested mode after success.

- [ ] **Step 1: Add failing transition tests.** Assert false/omitted preserve legacy mode, including an existing row with no endpoint; true does not activate during build; successful matching-token finalize activates; failure preserves mode; stale/mismatched token is refused; already-active mode never reverts. Pass `"true"` as a string and expect validation failure. Fail a checked attempt, start an unchecked retry, finish it, and assert false. Reuse the existing `appsRepo`, `APP_DEPLOY`, and `appFinalize(token)` fixtures.
  Name the retry case `unchecked retry does not inherit a failed domain switch`; `repo` uses the existing `appsRepo` fixture seeded with a legacy row and a finalize dependency that fails only on the first attempt:

  ```ts
  const first = await repo.deployApp("app-1", { ...APP_DEPLOY, useAppCodeDomain: true });
  await assert.rejects(() => repo.finalizeDeploy("app-1", appFinalize(first.deployToken)));
  const retry = await repo.deployApp("app-1", { ...APP_DEPLOY, useAppCodeDomain: false });
  const live = await repo.finalizeDeploy("app-1", appFinalize(retry.deployToken));
  assert.equal(live.usesAppCodeDomain, false);
  ```

- [ ] **Step 2: Run tests red.** From `services/fc`, run `node --import tsx --test --test-name-pattern='domain|code|deployToken' test/supabase-repo.test.ts test/routes-apps.test.ts`; expect any missing transition to fail.
- [ ] **Step 3: Reconcile start/finalize writes.** Reject non-booleans. Overwrite requested mode on every new token. Keep current mode untouched at start and on errors; update active mode and clear requested mode in the successful app-row update. Build platform-auth URL values from that attempt's requested mode. Do not infer migration from a missing endpoint. Invalidate both host aliases after success.
- [ ] **Step 4: Verify and commit.** Repeat tests and backend typecheck; expect the full transition matrix to pass. Commit `feat: activate app code domains after approved deploy success`.

### Task 5: Add the checkbox to the existing frontend confirmation

**Files:** Frontend approval files from the map; `packages/app/src/locales/{en,zh-CN}.json`; tests `packages/app/src/lib/apps/__tests__/app-domain-choice.test.ts`, `components/apps/__tests__/AppDeployConfirmDialog.test.tsx`, `stores/apps-store.test.ts`.

**Interfaces:** Consumes Task 2 `AppRow` and Task 4 deploy input. `legacyAppDomainChoice(app: Pick<AppRow, 'usesAppCodeDomain' | 'fcStatus' | 'fcEndpoint' | 'publicUrl' | 'appCodeUrl'>): {currentUrl: string; codeUrl: string} | null`. Extend `DeployConfirmPrompt` with optional `domainChoice` and `onDomainChoice(checked: boolean): void`; preserve `publicDeployConfirm.run(message, options?): Promise<boolean>`.

- [ ] **Step 1: Add failing interaction tests.** All eligibility predicates must hold, including explicit false mode and live status. Missing old-server fields, identical URLs, null endpoint, and non-live states hide the checkbox. In the existing confirmation, assert unchecked initially; checking and continuing submits true; unchecked submits no opt-in; cancel/dismiss submits no deploy and never invokes the choice callback. Reopen after a checked attempt and assert reset to unchecked. Count one domain-aware confirmation, not a second migration popup; retain the independent active-agent-turn warning.
  Extend the dialog fixture with `domainChoice`; name the case `migration checkbox resets between accepted attempts`. Assert both presentations start unchecked:

  ```ts
  expect((await screen.findByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByText("继续部署"));
  // Open the next prompt with the same eligible row, then assert again.
  expect((await screen.findByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  ```

- [ ] **Step 2: Run tests red.** From the repository root, run `pnpm --filter @teamclu/app test:unit src/lib/apps/__tests__/app-domain-choice.test.ts src/components/apps/__tests__/AppDeployConfirmDialog.test.tsx src/stores/apps-store.test.ts`. Expect missing/reset behavior to fail; avoid unused queued mock responses after cancellation.
- [ ] **Step 3: Reconcile the component/store.** Render an ordinary unchecked checkbox in the current confirmation with existing tokens. Translate `apps.deployDomainSwitch` as “Use the app-code domain after deployment succeeds” / “部署成功后，改用应用代码域名”. Show both addresses and that the old address remains available. Capture the choice only on acceptance. If no handler can present the checkbox, preserve legacy mode rather than inventing consent.
- [ ] **Step 4: Verify and commit.** Repeat tests; run `pnpm typecheck` and locale-key/parity tests. Expect zero missing keys and unchanged noneligible flows. Commit `feat: offer domain migration in deploy confirmation`.

### Task 6: Use native checkboxes on macOS, Windows, and Linux

**Files:** Modify `apps/desktop/src/commands/introspect_api/confirm.rs`, `confirm/app_domain.rs`, `apps.rs`; create `confirm/app_domain/{macos,windows,linux}.rs`; modify platform-scoped dependencies in `apps/desktop/Cargo.toml` and matching `Cargo.lock` only as needed. Keep native adapter unit tests beside their modules and orchestration tests in `apps.rs`.

**Interfaces:** Consumes the same API fields/eligibility as Task 5. Preserve `legacy_app_domain_choice(row: &Value): Option<(String,String)>` and `confirm_app_deploy_domain(app: &AppHandle, zh: bool, row: &Value): Result<bool,String>` (async). Introduce `CheckboxApproval { title: String, message: String, accept: String, decline: String, checkbox_label: String }` and OS-selected `show_checkbox(app: &AppHandle, request: CheckboxApproval, timeout: Duration): Result<bool,String>` (async). `Ok(false)` means approved/unchecked; `Ok(true)` means approved/checked; decline, dismissal, timeout, and widget failure are `Err`.

- [ ] **Step 1: Add failing orchestration tests.** Pin the eligibility matrix and map publish+unchecked to false, publish+checked to true, all rejection paths to error/no deployment. Verify two requests serialize, initial checkbox is false each time, timeout closes the native dialog, and late completion cannot approve a later attempt. Use a fake adapter only at the OS-widget boundary; exercise the real shared decision/timeout logic with paused Tokio time where practical.
  Keep the Rust case `only_an_old_live_domain_is_offered_the_deploy_checkbox`, using its existing `legacy` JSON fixture:

  ```rust
  assert!(legacy_app_domain_choice(&legacy).is_some());
  let mut undeployed = legacy.clone();
  undeployed["fcStatus"] = serde_json::json!("not_deployed");
  assert_eq!(legacy_app_domain_choice(&undeployed), None);
  ```

- [ ] **Step 2: Run tests red.** On the host OS, run `CI=1 RUSTC_WRAPPER=/usr/bin/env TAURI_CONFIG='{"bundle":{"resources":[],"externalBin":[]}}' node scripts/rust-cli.js test -p teamclu --lib app_domain --locked` using equivalent environment syntax on Windows. Expect missing adapters/timeout behavior to fail, not merely source-text assertions.
- [ ] **Step 3: Reconcile shared orchestration and macOS adapter.** Move OS widget code out of `app_domain.rs`; preserve the shared native-dialog mutex and `CONFIRM_TIMEOUT = 120s`. Use an AppKit NSAlert checkbox initialized to off, main-thread presentation/cleanup, and single-owner completion. Native choice is never taken from agent tool arguments; forward it into `useAppCodeDomain` only after acceptance. Preserve ordinary noneligible native approval and never reuse a cached approval to preselect migration.
- [ ] **Step 4: Implement Windows adapter.** Add only required target-scoped Windows API features (`Win32_UI_Controls` and dependencies required by their generated bindings). Use `TaskDialogIndirect`, `TASKDIALOGCONFIG.pszVerificationText`, an enabled verification output, and no initially-checked flag. Parent the dialog to the app HWND; bind timer/cancellation to close this exact dialog. Keep native Publish/Decline buttons, default false checkbox, and treat widget errors as rejection. Remove the draft's three-button fallback.
- [ ] **Step 5: Implement Linux adapter.** Add target-scoped `gtk = "0.18"`, matching the existing lockfile's GTK 3 line; refresh the lockfile without unrelated upgrades. Use a parented `GtkDialog` with content `GtkCheckButton`, `set_active(false)`, and Publish/Decline responses. Dispatch widgets on the GTK main thread; close/destroy on timeout or parent close and complete the result once. Do not render agent approval in a webview.
- [ ] **Step 6: Verify on each native host and commit.** Run the Task 6 tests plus `node scripts/rust-cli.js check --tests -p teamclu --locked` on macOS, Windows, and Linux. On Linux supply a real display or Xvfb. Manually verify checkbox initial state, both publish choices, decline, Escape/window close, parent close, timeout, and a second request. Expected: one native popup and only approved values forwarded. Missing build hosts or APIs are recorded blockers, never grounds to ship buttons instead. Commit `feat: support native deploy domain checkboxes across desktops` after available checks; record pending platform acceptance explicitly.

Native API references: [Windows configuration](https://learn.microsoft.com/en-us/windows/win32/api/commctrl/ns-commctrl-taskdialogconfig), [Windows dialog timer/control messages](https://learn.microsoft.com/en-us/windows/win32/controls/task-dialogs), [GTK dialog responses](https://docs.gtk.org/gtk3/class.Dialog.html), [GTK checkbox](https://docs.gtk.org/gtk3/class.CheckButton.html). These establish widget capabilities; target-host builds remain required.

### Task 7: Validate the integrated result and prepare rollout evidence

**Files:** Create `docs/testing/app-public-code-acceptance.md`; modify owning tests only if integration reveals missing coverage. Read the approved spec and current diff together.

**Interfaces:** Consumes Tasks 1–6. Produces a checked acceptance matrix with actual commands, platform coverage, failures/skips, and rollout blockers; it does not apply a live migration or publish software.

- [ ] **Step 1: Run final integrated checks.** Root: `pnpm test:unit` and `pnpm typecheck`. In `services/fc`: `pnpm test`, `pnpm typecheck`, `pnpm openapi:lint`. Desktop on each available native host: repository wrapper `test -p teamclu --lib --locked` and `check --tests -p teamclu --locked`. Run pgTAP against the migrated isolated local database. Expect zero new failures and classify every existing/environmental failure by name. Run `git diff --check` and inspect staged paths.
- [ ] **Step 2: Record acceptance limits.** Prior draft runs saw local Supabase integration skips and `commands::webview::tests::ensure_http_host_resolvable_rejects_unresolvable_host` fail because this machine resolved a `.invalid` host to `198.18.0.72`. Recheck rather than assuming the result persists; do not fix unrelated DNS code or report all suites green if it still fails. Record real-account login and each native UI check as passed or pending with evidence.
- [ ] **Step 3: Request independent code review.** Use requesting-code-review on the final task changes against the specification commit, excluding the enumerated unrelated edits. Fix actionable findings using tests, then rerun only affected checks plus any required integrated gates.
- [ ] **Step 4: Prepare the release checklist.** Record ordering: obtain live-change authorization, configure Supabase MCP, apply migration through MCP, read-only verify constraints/codes/preserved legacy mode, then release the updated Cloud API and desktop clients. Use the existing feature release process. Do not execute these live steps from this plan's implementation authorization.
- [ ] **Step 5: Commit evidence and hand off.** Commit only the acceptance document and any reviewed integration-test fixes as `docs: record app code migration acceptance`. Preserve unrelated working edits, keep the task branch, and report what remains blocked. No automatic push, PR, or merge.

## Plan self-review and execution gate

Coverage mapping: storage/backfill → Task 1; representation/routing → Task 2; auth/custom-domain/cron compatibility → Task 3; token-bound activation → Task 4; same-popup frontend eligibility/state → Task 5; all native platforms and approval trust → Task 6; integrated testing/review/rollout → Task 7. Every Review Focus item has an explicit owning test step.

Before execution, the user must review this plan and select **Subagent-driven** or **Native**. Recommended: **Subagent-driven**, because seven tasks cross shared database/API interfaces and native approval boundaries, and a wrong transition could change a public app's address without consent. Implement tasks serially where they share files, with fresh task review gates and a final whole-branch review. This recommendation is not execution authorization.
