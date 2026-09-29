# App Deployment Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents current, app-aware deployment facts and a reusable deployment procedure while preventing routine redeploys from silently changing a live app's runtime.

**Architecture:** The Cloud API returns separate TeamClu requirements, Alibaba regional capabilities, probed image observations, and the app's current deployment. The selected daemon supplies host facts and builds one pinned revision. A server-side preflight compares that revision's declaration with live state before the build/upload, and finalization verifies the same declaration. A built-in skill guides the agent; the session prompt only points to it.

**Tech Stack:** Node.js/TypeScript Cloud API, Alibaba FC 2023-03-30 SDK, Rust desktop and amuxd, MCP introspect sidecar, OpenAPI, repository templates.

**Spec:** `docs/superpowers/specs/2026-09-28-app-deployment-discovery-design.md`

## Global Constraints

- Target is Alibaba FC Linux/x86_64 in the deployment's configured region; builds happen on the selected agent's machine.
- Non-container declarations explicitly name `fcRuntime`, `command`, `args`, `port`, and `layers`. Remove short-form `entry` expansion before merge; preserve the container image contract.
- A routine redeploy preserves live runtime/interpreter/layers. Migration requires explicit intent and the existing native approval. No validation failure may replace the working function.
- `runtime_info` is read-only and app-scoped; it must never return environment values, credentials, or another app's function configuration.
- Provider metadata does not prove a binary path or layer mount point. Mark observations and source freshness honestly.
- Keep database, auth, storage, and published URL behavior intact. No direct Supabase client from app or desktop code.
- Work on the existing PR branch. The user's earlier authorization covers updates to draft PR #1610; do not merge or deploy the platform without separate authorization.
- Existing uncommitted fixes to MCP action exposure, daemon serialization, and the FC test fixture are work in progress. Reuse or replace them deliberately; the current short-form wire fixture must be removed when shorthand is removed.

## Review Focus

1. A live app has a TeamClu `start_spec` but `GetFunction` returns 404 or a different runtime: `runtime_info` reports drift and routine deployment stops before upload (Task 3/4).
2. Alibaba layer pagination includes multiple Java versions and a discovery page fails: all successful pages are preserved with an incomplete/stale marker; no version is invented (Task 2).
3. A visible app belongs to another team or caller lacks app access: neither `runtime_info` nor provider reads leak its existence or configuration (Task 3).
4. The Gitea revision changes between preflight and build, or the daemon returns a different declaration: deployment fails before finalization and never publishes that artifact (Task 4).
5. A Mac or Windows build produces a native binary for the host instead of Linux/x86_64: selected-daemon validation reports the mismatch before publish (Task 6).

---

### Task 1: Explicit declaration contract and existing regression fixes

**Files:** `services/fc/src/lib/provisioning/app-runtime-spec.ts`, `app-runtime-profiles.ts`, `services/fc/test/provisioning/app-runtime-spec.test.ts`, `services/fc/test/app-env.test.ts`, `apps/daemon/src/sync/app_build.rs`, `apps/desktop/crates/teamclu-introspect/src/apps.rs`, their existing tests, `packages/app/src/lib/backend/types.ts`.

**Interfaces:** `parseAppDeployDeclaration(raw): AppDeployDeclaration` accepts explicit non-container starts and the existing container form; `AppStartSpec` serializes absent optional fields by omission; `manage_body` accepts `runtime_info`.

- [ ] Replace the local short-form serialization fixture/test with an explicit declaration passed through the daemon's real `read_app_declaration` and `serde_json::to_value`, then parsed by FC; watch the old null serialization fail that test before applying the existing `skip_serializing_if` fix.
- [ ] Add failing FC tests that `start.entry` is rejected with actionable guidance, while explicit Node/Go/Python/Java and container declarations remain accepted. Remove `SHORT_FORM_PROFILES`, implicit version choice, and `entry` plumbing across daemon, Cloud API, client types, and templates. Run the focused FC and daemon tests to green.
- [ ] Keep the MCP `runtime_info` action regression (definition and forwarded selectors); run it red/green against the action list. Keep the FC environment fixture correction only if it mirrors the actual finalize input and makes the two prior PORT assertions pass.
- [ ] Run `node --import tsx --test test/provisioning/app-runtime-spec.test.ts test/app-env.test.ts` from `services/fc`, `node scripts/daemon-cargo.js test --bin amuxd sync::app_`, and `node scripts/rust-cli.js test -p teamclu-introspect apps::tests::` from repo root. Commit the explicit-contract baseline.

### Task 2: Provider catalog and probed observations

**Files:** Create `services/fc/src/lib/provisioning/app-runtime-catalog.ts`, `app-runtime-observations.ts`; modify `fc-client.ts`, `app-runtime-profiles.ts`, `services/fc/test/provisioning/app-runtime-profiles.test.ts`; add catalog tests.

**Interfaces:** `readRuntimeCatalog(region: string, language?: AppLanguage): Promise<{candidates: RuntimeCandidate[]; sourceStatus: SourceStatus}>`; `readRuntimeObservations(language?: AppLanguage): RuntimeObservation[]`. Inject the FC SDK client into the catalog adapter for tests. `RuntimeCandidate` includes source, region, version/ARN, compatible runtime, and `teamcluDeployable` classification.

- [ ] Write failing adapter tests using paginated `ListLayers` and `ListLayerVersions` responses: `language=java` includes every available Java version in region, filters unrelated languages, and marks built-in Java versions from a dated documentation snapshot separately from TeamClu-deployable candidates. Include a failed later page and verify incomplete source status.
- [ ] Implement catalog discovery using the existing FC credentials/client setup, with a bounded region-keyed cache and timestamp; keep provider errors visible. Do not infer layer mount paths or image binaries from layer names. Move the old hand-probed paths into dated observations with provenance, dropping silent profile defaults.
- [ ] Run focused catalog/observation tests and `pnpm --dir services/fc typecheck`. Commit.

### Task 3: App-aware runtime information

**Files:** `docs/openapi/teamclu-api.v1.yaml`, `services/fc/src/lib/routes/apps.ts`, `services/fc/src/lib/supabase-repo.ts`, `services/fc/src/lib/repository-contract.ts`, `services/fc/test/routes-apps.test.ts`, repository tests, `apps/desktop/src/commands/introspect_api/apps.rs`, `apps/desktop/crates/teamclu-introspect/src/apps.rs`.

**Interfaces:** `getAppRuntimeInfo(appId: string, language?: AppLanguage): Promise<AppRuntimeInfo | null>`. `AppRuntimeInfo` contains `deploymentContract`, `currentDeployment`, `capabilities`, `observations`, and `sourceStatus`. The desktop `runtime_info` action forwards `language` and returns `runtime` and separately sourced `this_machine`.

- [ ] Specify the response and optional `language` query in OpenAPI. Add failing route/repository tests for app access, no deployment, stored function name, safe `GetFunction` projection, TeamClu/provider drift, missing function, Java filter, and no secret fields.
- [ ] Implement the repository read after app authorization, using Task 2's catalog and the existing FC client adapter; compare provider runtime/start/layers to the last successful TeamClu snapshot. Make provider read failure explicit in `sourceStatus`, never `currentDeployment: null` for an app known to have deployed.
- [ ] Extend MCP and desktop forwarding for `language` with a failing test, then green. Run route/repository tests, OpenAPI lint, FC typecheck, and MCP tests. Commit.

### Task 4: Same-revision preflight and migration guard

**Files:** Create `services/fc/src/lib/provisioning/app-deploy-preflight.ts`; modify `services/fc/src/lib/provisioning/app-deploy.ts`, `services/fc/src/lib/routes/apps.ts`, `services/fc/src/lib/supabase-repo.ts`, `apps/desktop/src/commands/introspect_api/apps.rs`, `apps/desktop/src/commands/introspect_api/confirm.rs`, `apps/daemon/src/http/apps.rs` (`app_manifest` and build response), `apps/daemon/src/sync/app_git.rs` (revision/cleanliness check), `docs/openapi/teamclu-api.v1.yaml`, and provisioning tests.

**Interfaces:** `preflightAppDeploy(appId, gitCommitSha, declaration, migrationIntent?)` returns a token bound to the SHA and canonical declaration digest, plus a field-by-field preview. Finalize requires that token and the matching built SHA/declaration; it rechecks live state before `ensureFunction`.

- [ ] Add failing tests for first deploy, unchanged runtime, changed interpreter version/layers without migration intent (`runtime_migration_required`), explicit migration with approval context, changed entry/port preview, provider drift, unsupported layer, and prior app still serving after every rejected case.
- [ ] Extend the daemon manifest read to return the declaration plus checkout SHA and cleanliness. For a Gitea-managed app, require a clean checkout at the exact remote HEAD selected for build; imported checkouts use a content digest. Send that declaration and revision through `/deploy` so the server performs authorization, provider comparison, capability checks, and preflight **before** minting an upload handle or running the build. Bind the token to the revision and canonical declaration digest; fail if the daemon build returns a different revision/declaration.
- [ ] Recheck the token, current deployed baseline, and built declaration at finalize before database provisioning or FC mutation. For agent-driven deploys, move the native confirmation to after preflight so its preview names the exact migration fields; keep the equivalent check on the UI deploy path. Run provisioning/API/desktop tests. Commit.

### Task 5: Built-in deployment skill and smaller prompt

**Files:** Create `packages/app/src/lib/skills/deploy-app/SKILL.md`; modify `apps/daemon/src/runtime/supervisor.rs`, `session_prompt.rs`, `services/fc/src/lib/supabase-repo.ts` app-context producer, `templates/{static-web,slides,tanstack-postgres}/AGENTS.md`, and matching daemon tests.

**Interfaces:** Inherent skill name `deploy-app`; the app prompt supplies app identity, escaped compact snapshot, selected-machine facts, and a pointer to the skill. Detailed runtime facts remain behind `manage_app runtime_info`.

- [ ] Write failing tests that the managed skill is installed/discoverable, the prompt refers to it without a runtime catalog or deploy checklist, the app snapshot omits full runtime facts, and seeded templates contain only app-specific artifact guidance plus the skill pointer.
- [ ] Write the skill's procedure: `status` → language-filtered `runtime_info` → preserve or explicitly migrate → verify selected host and Linux/x86_64 artifact → commit/push app revision → deploy only on explicit request/native approval → verify live behavior. Install it through the existing inherent-skill path and trim prompt/templates.
- [ ] Run daemon prompt, skill, template, and FC app-context tests. Commit.

### Task 6: Selected-host artifact checks and end-to-end validation

**Files:** `apps/daemon/src/sync/app_build.rs` and build tests; `docs/specs/2026-09-27-app-deploy-test-rollout-plan.md` or a linked test report; PR description.

**Interfaces:** Before upload, the selected daemon returns an artifact/host verification result associated with the pinned revision. A mismatch is a build error, not a successful publish.

- [ ] Add failing daemon tests for macOS and Windows hosts targeting Linux/x86_64, a missing declared entry/output, and a native library built for the wrong architecture. Implement only checks that can be made reliably from output metadata; where a binary cannot be classified, return `unknown` and require the skill's explicit runtime test rather than claim compatibility.
- [ ] Run full `pnpm --dir services/fc test`, `pnpm --dir services/fc typecheck`, `pnpm --dir services/fc openapi:lint`, `pnpm typecheck`, `node scripts/daemon-cargo.js test --bin amuxd`, and `node scripts/rust-cli.js test -p teamclu-introspect`. Record exact counts/failures and any local Supabase skips. Run desktop library tests for changed commands.
- [ ] Re-review the branch, fix findings, update draft PR #1610 with its final behavior and validation, and keep it draft until review. After a separately authorized platform rollout, perform the manual Node/Python/live-redeploy cases from the rollout plan; do not mark those cases passed from unit tests.
