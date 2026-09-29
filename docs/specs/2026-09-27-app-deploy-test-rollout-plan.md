# App Deployment Test Rollout Plan

> **For agentic workers:** Use `superpowers:executing-plans` to execute this plan task by task. This document prepares a rollout; it does not authorize pushing, merging, or changing the shared server.

**Goal:** Deploy the runtime-facts contract to self-host test, verify Node and Python app deployment, and preserve a usable rollback.

**Architecture:** The Mac runs this branch's desktop and daemon; the self-host Cloud API publishes runtime facts and validates declarations. Builds happen on the selected agent's machine; deployed app functions run on Alibaba Function Compute. The existing GitHub workflow deploys main to the shared self-host stack.

**Tech Stack:** Tauri/Rust, Node.js Cloud API, Docker Compose, GitHub Actions, Alibaba FC/OSS.

**Spec:** `docs/specs/2026-09-23-app-deploy-intent-contract-design.md`

## Global constraints

- Target only `https://api.teamclu-dev.ucar.cc` on self-host ECS `47.112.210.217`, checkout `/opt/teamclaw`; do not deploy Belayo.
- Candidate code: branch `design/app-deploy-intent-contract`, commit `1ef5b9c7de9c1005a412863d9d897b7c57869513`. Record the actual merge/deploy SHA at execution time.
- Platform publishes facts; agent decides; preflight validates. Host facts belong to the selected agent, not the app.
- Keep Python/PHP/Java on explicit startup configuration. Do not remove database or authentication features to obtain a green deployment.
- No schema migrations or new environment keys are introduced by this branch. Review intervening main changes before rollout; they may differ.
- Use disposable apps and synthetic data. Leave `james-test1` and `james-test2` unchanged.
- Real mutations must run through a verified TeamClu agent or the normal UI. Do not forge caller tokens or bypass native deployment approval.
- No push or PR until the user explicitly requests it. Merge and deployment require their own authorized scope.

## Current evidence

- Desktop library suite: 428 passed after both regressions were demonstrated failing.
- Provisioning suite: 226 passed; daemon app/build/template tests: 100 passed.
- Live `manage_app list`: HTTP 200 after fixing the request limit to 100.
- Live `manage_app runtime_info` by `app_name: james-test1`: now clears the read-only caller gate and app resolution, but upstream returns HTTP 404 `Route not found`.
- Earlier full Cloud API suite had two failures in `test/app-env.test.ts`; recheck and report them explicitly. Do not treat the focused green runs as a green full suite.
- Nothing in this plan has been deployed.

## Review focus

1. Wrong server revision: health alone is insufficient; an authenticated runtime-info response must succeed (Tasks 2–3).
2. Host facts confused with target facts: compare two selected agents where available; otherwise record multi-host coverage as untested (Task 3).
3. Green deploy with broken native dependencies or missing features: exercise Python imports, login, and persistent database writes (Task 5).
4. Rejected deployment damages a working app: verify the prior deployment still serves after each invalid declaration (Task 4).
5. Rollback restores API but leaves incompatible declarations: preserve explicit declarations and redeploy one disposable app after API rollback (Task 6).

## Task 1: Freeze the candidate and verify prerequisites

**References:** root `CLAUDE.md`, `.github/workflows/self-host-deploy.yml`, `deploy/self-host/docker-compose.yml`, `services/fc/Dockerfile`.

- [ ] Verify the branch is clean and includes `1ef5b9c7`; record candidate SHA, desktop/daemon versions, selected agent, and Cloud API URL in the test report.
- [ ] Run `pnpm --dir services/fc test`, `pnpm --dir services/fc typecheck`, `pnpm --dir services/fc openapi:lint`, `pnpm typecheck`, and `node scripts/rust-cli.js test -p teamclu --lib`. Capture logs and exit codes. Any accepted baseline failures need an explicit recorded disposition before rollout.
- [ ] Read-only host inspection: verify SSH access, active FC container/image ID, current server SHA, container health, free disk, and whether another self-host/daemon deployment is running. Check environment key presence without printing secret values.
- [ ] Confirm a TeamClu agent is online on the Mac and can create/build a disposable app. The external Codex session can do read-only introspection, but is intentionally blocked from direct deployment mutations.
- [ ] Record a baseline of existing test app URLs and response status without changing their contents.

**Exit:** candidate, access, known failures, and rollback prerequisites are documented.

## Task 2: Deploy through the existing self-host workflow

**Important:** `workflow_dispatch` has no candidate-ref input. The SSH script fetches `origin/main` and runs `git reset --hard origin/main`, regardless of the workflow's selected branch. Dispatching on this feature branch will NOT deploy the feature.

- [ ] After explicit PR authorization, push and open the PR; get checks/review and merge through the repository workflow. Record merge SHA. Do not push directly to main.
- [ ] Before replacing the server image, preserve the running FC image with a unique rollback tag and record that tag plus its image ID. Capture the deployed Compose revision and a secure server-local backup of deployment config/environment. Never copy secrets into the repository or test report.
- [ ] Review all changes between the server's current SHA and the intended main SHA. Stop if unexpected migrations or unrelated infrastructure changes expand the agreed scope.
- [ ] Choose a test window outside the nightly 00:00 Asia/Shanghai deployment. Record the workflow concurrency group `selfhost-ecs` and avoid concurrent manual server operations. Check main has not advanced beyond the reviewed revision immediately before dispatch.
- [ ] With deployment authorization, dispatch `self-host-deploy.yml` on main and record the run URL and SHA actually checked out on the host.
- [ ] Observe every workflow phase. It updates environment values, builds **FC and ai-gateway**, runs Compose across the stack, restarts Kong/Caddy, and runs smoke checks. It is not an FC-only update and may cause brief shared-test downtime.
- [ ] Require a healthy FC container and successful `GET https://api.teamclu-dev.ucar.cc/healthz`. Also check workflow gateway/auth/MQTT smoke results. The workflow chooses a different verification path when `FC_SUPABASE_URL` is set; record which path ran.

**Exit:** reviewed main revision deployed and shared-service health recovered. If pre-merge testing is required instead, prepare a separately reviewed FC-only image rollout; do not repurpose this workflow or silently reset the shared checkout to the branch.

## Task 3: Verify facts through the actual app

- [ ] Run `pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding` from the candidate checkout. Confirm only the intended app owns local port 13144 and the current daemon is connected.
- [ ] Call `manage_app list`: expect success and the existing apps, not the old limit error. This endpoint currently returns at most 100 apps; exhaustive pagination is not added by these fixes.
- [ ] Call `manage_app runtime_info` for a visible app by name: expect runtime facts and machine facts, no 403 and no upstream route-not-found. Record actual region, Linux/x86_64 target, interpreter paths, PATH gotchas, and provenance/unverified fields.
- [ ] Start a fresh app session with a selected Mac agent. Check the prompt's `thisMachine` describes that daemon host and the runtime target remains separate. Repeat on a second OS if an agent is available; otherwise mark this case untested.
- [ ] Verify read-only access did not broaden mutation access: rely on the caller middleware regression tests asserting create/deploy remain agent-only; do not attempt a real mutation from an external process just to probe it.

**Exit:** the feature is present end to end before spending a deployment on it.

## Task 4: Node deployment and rejection cases

**Fixture:** create a disposable static-web app named `codex-runtime-node-<timestamp>` from `templates/static-web/`. Record app ID, repo commit, selected agent, deployment revision, and URL.

- [ ] Build and deploy via the TeamClu agent using `build.kind: node`, `build.output: .output`, and `start: {entry: "server/index.mjs", port: 9000}`. Handle the normal native approval. Expect live status, HTTP 200, and a unique fixture marker in the response.
- [ ] Omit `start.port`, redeploy, and verify HTTP 200 with platform port 9000.
- [ ] One at a time, try these invalid declarations: entry plus fcRuntime; entry escaping the package; explicit bare `node` on custom.debian10; `/opt/nodejs20/bin/node` with no layers; official layer ARN with a different region. Expect actionable validation errors. Save the response and verify the previous fixture still serves after each rejection.
- [ ] Restore a valid explicit declaration using `/var/fc/lang/nodejs20/bin/node`, args `server/index.mjs`, port 9000, and `layers: []`. Deploy successfully to establish passthrough compatibility.
- [ ] Exercise a valid official `Name:version` layer shorthand from the published facts. Verify its resolved region matches the deployment region and the app still starts.
- [ ] Restore the last known-good fixture declaration and save all results. Deployment success must include the URL check, not merely an accepted request or queued build.

## Task 5: Python regression without feature removal

**Fixture:** a separate disposable Python data app with synthetic records and test-only authentication; never copy real user data or secrets from `james-test1`.

- [ ] First request Python short form with `entry`; expect rejection directing the author to explicit startup configuration.
- [ ] Use runtime_info to author explicit Python 3.10 startup, including the absolute interpreter, module target, host/port, and app-owned import path. Package dependencies into the artifact.
- [ ] On the Mac, target CPython 3.10/Linux x86_64 wheels explicitly, for example `--platform manylinux2014_x86_64 --implementation cp --python-version 3.10 --only-binary=:all:`. Use a portable build script rather than host-specific shell commands.
- [ ] Inspect packaged native extensions for the target architecture; then verify imports inside the deployed function. File names alone do not prove runtime compatibility.
- [ ] Deploy, exercise login and an authenticated request, create/read a synthetic database record, and verify persistence after a subsequent deployment. Exercise the native dependencies that previously failed; do not accept a home page as sufficient evidence.
- [ ] Test a source-only dependency separately: expect an honest missing-target-wheel failure, not removal of application features or an unrelated version downgrade.

**Exit:** working Python runtime, native dependencies, database and authentication, with no feature degradation.

## Task 6: Rollback and evidence

- [ ] Roll back immediately for failed health recovery, sign-in/session regressions, existing app outages, or incorrect runtime facts. Collect redacted failure logs first when doing so will not delay recovery.
- [ ] For an FC-only regression, use the preserved image tag in a temporary server-local Compose override:

```yaml
services:
  fc:
    image: teamclu-fc:rollback-<recorded-tag>
```

Run from `/opt/teamclaw/deploy/self-host` after substituting the recorded tag and override path:

```sh
docker compose -f docker-compose.yml -f /absolute/path/fc-rollback.yml up -d --no-deps --no-build --pull never fc
```

- [ ] Verify the running image ID matches the saved image, FC health recovers, login/listing work, and existing apps remain reachable. This only rolls back FC: unrelated workflow configuration, gateway changes, or migrations require their recorded recovery procedure, not an assumption that the FC image reverses them.
- [ ] Existing deployed functions are separate from the Cloud API image. Before deploying through the older API again, restore an explicit declaration on the disposable Node app and prove one redeploy works. Short-form declarations cannot be assumed compatible with the old API.
- [ ] Record the temporary rollback override and reconcile the source/release before the next nightly rollout; otherwise the next workflow may overwrite the rollback.
- [ ] Produce a test report with each case marked pass/fail/blocked/untested, timestamps, SHAs, image IDs, app IDs, selected hosts, sanitized errors, and URLs. Keep disposable apps until evidence is reviewed; delete them only through the normal authorized cleanup flow.

## Acceptance and next authorization

Accept only after the runtime-info route works on the actual target, both Node forms deploy, rejection cases preserve the previous app, Python retains its features, and shared-service smoke checks pass. Record Windows and unverified language/layer coverage honestly.

The next action after reviewing this plan is PR authorization. Deployment is a later explicit step after reviewing the merged revision and the shared workflow's scope. No server, cloud app, or database is changed by preparing this document.
