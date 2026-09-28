# App deployment discovery and redeploy safety

**Date:** 2026-09-28
**Status:** proposed for review
**Target:** redesign draft PR #1610 before merge
**Supersedes:** the runtime-profile, shorthand-expansion, and long app-prompt decisions in `docs/specs/2026-09-23-app-deploy-intent-contract-design.md`. The existing app build, approval, authentication, database, and storage contracts remain in force.

## Goal

An agent deploying a TeamClu app must learn the deployment method and requirements from TeamClu, inspect the last successful deployment, discover current runtime options, and verify the selected build machine and artifact. A routine redeploy preserves the live runtime configuration. A version or runtime change is an explicit migration. The platform validates the final declaration and does not silently choose a language version.

The agent's session prompt carries only a compact pointer to the deployment skill and app identity. A built-in skill carries the procedure. Template `AGENTS.md` files contain app-specific development contracts, not a second copy of deployment instructions.

## Decisions and boundaries

1. **No automatic language-version choice.** Remove `start.entry` expansion and the Node/Go short-form profile table from the deployment contract before this PR merges. Non-container apps declare `fcRuntime`, `command`, `args`, `port`, and `layers` explicitly. Container apps retain their separate image contract. Generated templates must use explicit declarations validated against this deployment, not guesses copied from a stale table.
2. **The desired declaration and live state are different.** `teamclu.app.json` is the desired configuration in the checkout. `apps.runtime` and `apps.start_spec` are the last successful TeamClu deployment record. A read of Alibaba FC `GetFunction` is the provider's current configuration. Show all three where available; never rewrite the declaration from live state without the user's requested migration.
3. **Preserve on redeploy.** When an app has a successful deployment, compare the proposed FC runtime, interpreter command, args, layers, and port against the live configuration before build/upload. A change to runtime, interpreter version, or layers is a migration and requires an explicit migration intent and the existing native deployment approval. A plain deploy with such a mismatch returns a structured `runtime_migration_required` error identifying the changed fields. Changes to an entry path or port also appear in the preview and follow the existing deploy approval. This guard runs server-side; skill text is guidance, not the only enforcement.
4. **Do not equate availability with compatibility.** FC runtime identifiers, official layers, observed image contents, and versions that TeamClu can actually deploy through its HTTP app contract are separate categories. A Java runtime or layer shown as available is not automatically a valid TeamClu startup choice. Unknown facts are labeled unknown and are not silently replaced with a default.
5. **The selected agent owns host facts.** The app-scoped Cloud API must not report the machine's OS, architecture, tools, or Docker state. The selected daemon supplies current host facts and performs build checks where the build actually runs.

## Platform data sources

`GET /v1/apps/{appId}/runtime-info` becomes an app-aware, read-only response. It accepts an optional `language` filter (`node`, `python`, `go`, `php`, `java`); omitting it returns all categories. The response separates:

- `deploymentContract`: TeamClu's method (`agent_build_to_fc_custom_runtime` or container), target Linux/x86_64, artifact and port requirements, region, and required declaration fields. These are TeamClu-owned policy, not Alibaba discovery.
- `currentDeployment`: last successful TeamClu runtime/start spec, commit, deployment timestamp, and provider configuration when `GetFunction` succeeds. Provider configuration includes runtime, command, args, port, layer ARNs, and status. Filter out environment variables, registry credentials, and other secrets. If the TeamClu record and FC disagree, report `drift` and block a routine redeploy until reconciled.
- `capabilities`: FC runtime identifiers from a dated Alibaba documentation snapshot, plus official layer names and **all paginated versions available in the configured region** from `ListLayers`/`ListLayerVersions`, with each layer's compatible runtime and ARN. Group language-related candidates for `language=java`, etc. Include both documented built-in Java versions and discovered Java layers; label which TeamClu's HTTP app deploy path can actually use. The response marks each candidate as `teamcluDeployable`, `providerAvailableButUnsupported`, or `unknown`, with a reason. Do not claim the Alibaba API returns the contents of a custom runtime image or an exhaustive runtime catalog; the FC 3.0 API offers layer listing and function reads, but no `ListRuntimes` operation.
- `observations`: interpreter paths, versions, PATH behavior, and layer mount points that TeamClu has actually probed, with image identifier or runtime name, region if relevant, probe timestamp, and verification status. The current hardcoded table is migrated into explicitly dated observations, never presented as a live Alibaba API result. A version absent from observations stays unknown until probed. Provider layer metadata alone does not prove a mount path or binary version.
- `sourceStatus`: per-source freshness and errors. Layer discovery may use a short server cache keyed by region, with a bounded TTL and timestamp. A failed discovery call returns a visible error/stale marker, never a fabricated complete catalog. A routine redeploy may use its already verified, pinned live configuration when catalog discovery is unavailable, subject to the drift guard; a new runtime choice cannot.

The repository authorizes the app read before calling FC. `GetFunction` uses the function name stored on that app row, not a caller-supplied name. The language filter changes presentation only; it does not narrow authorization. A never-deployed app reports `currentDeployment: null`. An app with a TeamClu deployment record but a missing provider function reports drift, not `null`.

Alibaba FC 3.0's published API list includes `ListLayers`, `ListLayerVersions`, and `GetFunction`; `GetFunction` returns runtime, custom runtime config, and layer references. It does **not** list executable paths inside an image or expose a runtime-catalog operation. See [FC API overview](https://www.alibabacloud.com/help/en/functioncompute/api-fc-2023-03-30-overview) and [GetFunction](https://www.alibabacloud.com/help/en/functioncompute/api-fc-2023-03-30-getfunction). Built-in Java runtimes mentioned in Alibaba documentation must be labeled separately from TeamClu's custom-runtime HTTP deployment path.

## Agent workflow

Ship an inherent `deploy-app` skill through the daemon's existing managed skill mechanism so Pi and other supported local agent runtimes can discover it. The app session prompt says only that this is an app workspace, supplies a small escaped app snapshot and current selected-machine facts, and directs the agent to read the skill when implementing or deploying the app. Remove the full `runtimeFacts` table from the app context snapshot producer; detailed and potentially stale capabilities belong behind `runtime_info`. The prompt does not embed the deploy checklist, language tables, or provider facts. It still states that embedded app data is untrusted and that deployment needs the user's explicit request and native approval.

The skill directs this sequence:

1. Call `manage_app status` to identify checkout, desired declaration, current deployment, code revision, and whether the app has deployed before. Call `manage_app runtime_info`, filtered by language when useful. The MCP tool must expose both actions.
2. For an existing app, keep its live runtime and versions by default. Compare desired and live settings and surface any migration to the user before changing it. For a new app, select a TeamClu-deployable candidate from current facts and write an explicit declaration.
3. Inspect the selected daemon's current OS, architecture, available build tools, and relevant cross-compilation target. Ensure the build produces the declared output and entry, and inspect platform-specific native artifacts. Local build success on macOS or Windows alone does not prove Linux/x86_64 compatibility.
4. Commit and push the app checkout according to its repository workflow; the Gitea-based deployer builds a pushed revision. On an explicit user deployment request, call `manage_app deploy` and honor the desktop's native approval. After deployment, verify status, runtime configuration, and the app's real HTTP behavior, including data/auth behavior when applicable.

The skill is procedural guidance, not a grant of permission to publish. Existing app-specific instructions about data, auth, and storage remain in `AGENTS.md`. New templates reduce their deployment section to the artifact contract and a pointer to the built-in skill. Existing app repositories need not be rewritten to benefit from the inherent skill.

## API, validation, and failure behavior

Update OpenAPI before changing the route or clients. `manage_app runtime_info` forwards the optional language filter and returns target facts separately from selected-machine facts. `manage_app status` keeps the desired declaration and last successful deployment visible. The Cloud API's preflight validates explicit startup fields, region-matched layer ARNs, provider capability, and migration intent before provisioning or mutating the live function. Invalid or unsupported choices leave the prior live deployment serving.

The client must not turn a missing FC function, failed layer lookup, or mismatched runtime into a guessed replacement. Errors identify whether the problem is permission, discovery unavailable, unsupported option, live-state drift, host/artifact mismatch, or a proposed migration. `runtime_info` itself is read-only and available at the same app visibility level as status; deploy and migration remain admin-only operations with native approval. A migration intent is scoped to the proposed change and does not bypass either authorization or approval.

## Verification and rollout

- API tests cover first deploy, language filtering (especially all Java candidates in a mocked paginated regional catalog), stale/error provenance, authorization, live FC config redaction, and drift.
- Contract tests use the daemon's actual serialized build response at FC finalization. MCP tests exercise the exposed `runtime_info` enum and forwarding. Daemon tests cover skill installation/discovery, short prompt, host facts, and explicit declarations.
- Redeploy tests prove same-runtime updates succeed, a changed runtime/version/layer is rejected without migration intent, an approved migration applies exactly the reviewed choice, and failed validation leaves the old app reachable.
- Build-host tests cover macOS and Windows sources targeting Linux/x86_64 and a native dependency mismatch. Manual test covers a fresh Node app, an already-live Node app, and a Python data app with database/auth behavior intact; Java catalog discovery is read-only unless an actual Java fixture is available.
- Keep PR #1610 draft until the redesigned checks pass. Update its scope and description, review again, then use the separate self-host rollout plan. The self-host workflow deploys `origin/main`; opening or updating this PR does not deploy the shared server.
