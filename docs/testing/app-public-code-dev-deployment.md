# App-code dev API deployment preparation

Prepared 2026-10-20 (Asia/Shanghai). **Not executed; no deployable integrated
revision yet.** This is a rollout checklist, not deployment authorization.

## Target and observed state

- Only target: self-hosted dev ECS `47.112.210.217`, `/opt/teamclaw`, Compose
  directory `/opt/teamclaw/deploy/self-host`; Cloud API
  `https://api.teamclu-dev.ucar.cc`. SSH alias `teamclu-dev` succeeded with
  key-only authentication and strict host verification.
- Feature revision: `5eb5c0d67f969ad07517d5e00145a1d681c377d0` on
  `codex/app-public-code-implementation`, clean before this preparation record.
- Fresh remote main: `ba604cf9dda7a8f39bd59d576daca19ab91587be`.
  Main has 215 commits absent from the feature branch; the feature has 15 absent
  from main. This is a snapshot; refresh it before integration/deployment.
- Remote checkout: `e4525dd780595641bc7591d65e352e9bdfc0e36f`, no tracked edits.
  Untracked operational files, backups, local catalog/static files and AppleDouble
  files exist. Preserve them; do not run clean or reset without reinspection.
- Running FC image ID:
  `sha256:fdbf82a472e19d3c496326120deff587ac5d0b8fea27506d848dece6f8d16fdd`.
  Image created `2026-10-18T22:51:26.418701346+08:00`; no OCI revision label.
  Checkout SHA and workflow head SHA do not establish this image's source SHA.
- FC, AI gateway, Kong and auth running; FC and gateway report healthy.
  Public `/healthz` returned `{"ok":true}`. Root disk: 8.3 GiB free, 78% used.
  Build space needs rechecking before rollout; this is not a capacity guarantee.
- Effective FC database is bundled. Required settings are present:
  `APPS_PUBLIC_DOMAIN`, distinct `APPS_FC_ROUTE_DOMAIN`,
  `APPS_FC_ORIGIN_KEYRING`, `AUTH_BASE_URL`, `APP_CRON_SECRET`.
  AUTH_BASE_URL matches the intended API. Presence does not validate credentials,
  key rotation, external DNS/certificates or end-to-end authorization.
- App-code migration applied through private self-hosted MCP; 47 valid distinct
  codes, all legacy modes false and all pending choices null. See
  [acceptance record](app-public-code-acceptance.md#live-dev-migration-addendum--2026-10-20).
  Read-only ledger comparison found **no unapplied top-level main migrations**;
  archived migrations were excluded exactly as the runner excludes them.
  A zero-row request from running FC to its effective PostgREST returned 200 for
  all three new columns, confirming schema-cache visibility without exposing data.

## Integration blocker

A non-checkout `git merge-tree` preview found 17 content conflicts:

- `apps/desktop/src/commands/introspect_api/apps.rs`
- `docs/openapi/teamclu-api.v1.yaml`
- `packages/app/src/lib/backend/types.ts`
- `packages/app/src/stores/apps-store.ts`
- `services/fc/src/lib/app-cron-runner.ts`
- `services/fc/src/lib/apps-auth-gate.ts`
- `services/fc/src/lib/apps-login-service.ts`
- `services/fc/src/lib/apps-vanity.ts`
- `services/fc/src/lib/provisioning/app-deploy.ts`
- `services/fc/src/lib/supabase-repo.ts`
- `services/fc/src/lib/supabase-repo/shared.ts`
- `services/fc/test/app-cron-runner.test.ts`
- `services/fc/test/app-env.test.ts`
- `services/fc/test/apps-auth-gate.test.ts`
- `services/fc/test/apps-login-service.test.ts`
- `services/fc/test/apps-vanity.test.ts`
- `services/fc/test/supabase-repo.test.ts`

Integrate on a task branch, preserving current-main behavior and the approved
app-code contract. Review deploy reservations/lifecycle ownership, matching-token
finalization, successful-only activation, alias authentication and default domain
selection together. Do not replace current-main files wholesale with old feature
versions. Re-run backend tests/typecheck/OpenAPI validation and targeted client
contract tests after resolution, then independent review. Existing green evidence
belongs to the older feature revision and does not validate a future merge.
Full Windows/Linux, real-account and deployed-integration gates remain open.
No integration conflicts were resolved in this preparation-only task.

## Existing rollout route and scope

`.github/workflows/self-host-deploy.yml` supports nightly 00:00 Asia/Shanghai
and manual dispatch, with shared `selfhost-ecs` concurrency and no cancellation.
It explicitly fetches/resets the server to **origin/main**, regardless of a
workflow-dispatch ref. Dispatching it from the feature branch will not publish
that branch's API. Do not use it as a branch-deployment shortcut.

The workflow rebuilds **FC and AI gateway**, runs Compose for the stack, restarts
Kong and Caddy, runs gateway smoke checks, and runs the bundled-database E2E suite.
It is broader than an FC-only restart and can write fixture data. Obtain rollout
approval for this concrete scope. No workflow change is needed for the normal
merge-to-main route. The current repo requires explicit authorization before
push/PR and prohibits direct pushes/merges to main.

After integration checks/review and authorized PR integration:

1. Record the approved main SHA and recheck no competing deploy/daemon job.
   Reinspect remote changes and preserve local operational files. Privately
   preserve current service image IDs and secret configuration for rollback;
   do not print or commit configuration values.
2. Recheck effective database/settings, app-code objects and migration ledger
   through MCP. Reconcile any new migration before dispatch; the existing runner
   must skip the already-recorded app-code migration. Do not introduce unrelated
   live SQL through a workflow as an MCP bypass.
3. Preserve the current FC and gateway images under local rollback tags before
   build, and record exact tag/image mapping. This preparation did not create tags.
4. With explicit deployment authorization, dispatch `Self-Host Deploy` on main.
   Monitor to completion without cancelling shared deployment concurrency.
5. Verify remote main SHA and actual service image IDs, container health and
   public health. Compare build output/source manifests if image labels still
   omit revision; do not infer image provenance from checkout alone.
6. Verify app metadata includes stable app codes, old apps still use existing
   URLs, code candidates for inactive apps fail closed, and old/retained aliases
   keep the same login/audience/permissions. Test custom domains, platform login,
   callback allowlist, Traefik and cron on a separately authorized safe fixture.
   API deployment does not publish existing user Apps or update desktop/daemon.
7. Publish desktop clients only after their platform gates pass. Existing clients
   may lack the opt-in checkbox; backend rollout alone does not deliver that UI.

## Rollback and stop conditions

Stop before deployment if integration/review fails, the target SHA drifts, any
migration is unreviewed, settings change unexpectedly, or rollback images cannot
be retained. Stop acceptance on health/auth/domain regression and preserve only
redacted diagnostic evidence.

Before any new App uses a code domain, reverting the FC/gateway images to the
retained images and original effective configuration is the application rollback
candidate; validate their legacy behavior against the additive schema. Do not
reverse the schema or delete permanent codes. Existing images were observed
healthy after migration, but this is not a full rollback rehearsal.

After any new app defaults to a code domain or an old app activates code mode,
the old API may no longer resolve those active hosts. **Do not blindly roll back
to pre-code images.** Inventory affected apps through MCP and prefer a reviewed
forward fix or a known compatible rollback revision. Never clear activation flags
or regenerate app codes as a rollback shortcut. Configuration snapshots and image
tags are prepared during the separately authorized rollout, not claimed here.

## Preparation outcome

Database and read-only environment preflight passed. Source integration and fresh
verification are required before a deployable SHA can be named. No push, PR,
merge, workflow dispatch, service restart, image retag, fixture creation or further
live database change was performed during this preparation.
