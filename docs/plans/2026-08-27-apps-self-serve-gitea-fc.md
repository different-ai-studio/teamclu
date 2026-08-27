# Apps 自助发布（Gitea + Node FC）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development to implement this plan task-by-task.

**Goal:** Phase 1 — 团队用户在平台内创建 app → Gitea 私有仓播种 → 本机 daemon 按远端 commit 构建 → OSS → Node FC live，并支持可选 `auth_mode=platform` OAuth 与公开性显式确认。

**Architecture:** 桌面端继续编排发布（云端 start → 本机 daemon build → 云端 finalize）。控制面在 `createApp` 时调 Gitea 建仓；凭证 JIT 下发 **per-repo deploy key**（Gitea PAT 无法限定单仓）。产物 OSS key 始终由服务端推导。OAuth client secret 存 `amux.app_secrets`（方案 A）。

**Tech Stack:** FC TypeScript (`services/fc`)、Supabase SQL migrations、amuxd Rust (`apps/daemon`)、React/Zustand (`packages/app`)、Gitea REST API、saas-mono GoTrue OAuth admin API。

**Spec:** `docs/specs/2026-08-27-apps-self-serve-gitea-fc-design.md`

**Locked decisions (from design + this plan):**

| Item | Choice |
|------|--------|
| §6.3 secret storage | **A** — `amux.app_secrets` + env `APP_SECRETS_ENCRYPTION_KEY` |
| Gitea credential | **Per-repo deploy key** (write); mint on `GET …/git-credential`, discard after use |
| Deploy identity | `gitCommitSha` + server-minted `deployToken` (uuid); finalize must match |
| Artifact key | Keep `apps/{appId}/code.zip` (server-derived); sha stored on row only |
| Membership check | New `GET /v1/apps/:id/membership` for platform-auth templates |

**SDLC note:** 本 worktree 不跑 `cargo` / `pnpm rust:*`（共享 `CARGO_TARGET_DIR` 锁）。Daemon 侧：写测试与实现，Rust 编译/测试留到 preview 验收。FC / 前端照跑 `pnpm` 测试。

**Commit discipline:** 每完成一个 Task 停一下；仅在用户明确要求时 `git commit`。勿 push / 勿开 PR。

---

### Task 1: Schema — apps 新字段 + `app_secrets`

**Files:**
- Create: `services/supabase/migrations/20260827000000_apps_self_serve_gitea.sql`
- Modify: `services/fc/src/db/schema/apps.ts`
- Modify: `services/fc/src/lib/pg-repo/apps.ts` (`mapApp`)
- Modify: `services/fc/src/lib/supabase-repo/shared.ts` (`APP_COLUMNS` + `mapApp`)
- Test: extend `services/fc/test/pg-repo-apps.test.ts` / `app-v1.test.ts` for new mapped fields

**Step 1: Write the migration**

```sql
-- amux.apps extensions for self-serve Gitea + auth_mode
alter table amux.apps
  add column if not exists git_commit_sha text,
  add column if not exists runtime text not null default 'node',
  add column if not exists auth_mode text not null default 'none',
  add column if not exists oauth_client_id text,
  add column if not exists oauth_app_id uuid,
  add column if not exists deploy_token text,
  add column if not exists deploy_started_at timestamptz;

alter table amux.apps
  drop constraint if exists apps_runtime_check;
alter table amux.apps
  add constraint apps_runtime_check check (runtime in ('node', 'container'));

alter table amux.apps
  drop constraint if exists apps_auth_mode_check;
alter table amux.apps
  add constraint apps_auth_mode_check check (auth_mode in ('none', 'platform', 'third'));

create table if not exists amux.app_secrets (
  app_id uuid not null references amux.apps(id) on delete cascade,
  kind text not null,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (app_id, kind)
);

-- RLS: service_role only for secrets (FC uses service role / pg path)
alter table amux.app_secrets enable row level security;
-- no authenticated policies — clients never read this table

grant all on amux.app_secrets to service_role;
```

Also ensure `git_auth_kind` is selected in `APP_COLUMNS` if missing (existing drift).

**Step 2: Mirror in Drizzle + both mappers**

Add to drizzle `apps` table: `gitCommitSha`, `runtime`, `authMode`, `oauthClientId`, `oauthAppId`, `deployToken`, `deployStartedAt`. Add `appSecrets` table.

`mapApp` must expose: `gitCommitSha`, `runtime`, `authMode`, `oauthClientId` (never secret), keep `publicUrl` derived.

**Step 3: Run FC unit tests that touch mapApp**

```bash
cd services/fc && node --test test/pg-repo-apps.test.ts test/app-v1.test.ts
```

Expected: PASS after mapper updates; fix any snapshot/field asserts.

**Step 4: Stop for commit (when user asks)**

```bash
git add services/supabase/migrations/20260827000000_apps_self_serve_gitea.sql \
  services/fc/src/db/schema/apps.ts \
  services/fc/src/lib/pg-repo/apps.ts \
  services/fc/src/lib/supabase-repo/shared.ts \
  services/fc/test/
```

---

### Task 2: Env 三写 — Gitea + secrets key

**Files:**
- Modify: `services/fc/s.yaml` (`environmentVariables:`)
- Modify: `deploy/self-host/docker-compose.yml` (`fc:` → `environment:`)
- Modify: `deploy/self-host/.env.example`
- Modify: `services/fc/src/lib/feature-profiles.ts` / `index.ts` if needed for unavailable reasons
- Test: `services/fc/test/deploy-env-parity.test.ts`

**New vars (all three places):**

| Var | Purpose |
|-----|---------|
| `GITEA_URL` | Base URL, no trailing slash |
| `GITEA_TOKEN` | Bot token (org admin; only used server-side to create repos + deploy keys) |
| `GITEA_OWNER` | Org/user that owns repos (e.g. `teamclaw-apps`) |
| `APP_SECRETS_ENCRYPTION_KEY` | 32-byte base64 for AES-GCM over `app_secrets` |

**Step 1: Add vars; leave empty-default pattern like other APPS_***

**Step 2: Run parity test**

```bash
cd services/fc && node --test test/deploy-env-parity.test.ts
```

Expected: PASS. If a var is declared but unread, either wire a reader stub in Task 3 or the orphan check fails — prefer reading in `makeGiteaDeps()` early.

**Step 3: `deployUnavailable`-style helper for Gitea**

```ts
// services/fc/src/lib/provisioning/gitea.ts
export function giteaUnavailable(reason?: string): ApiError {
  return new ApiError(503, "gitea_unavailable",
    reason ? `gitea not configured: ${reason}` : "gitea not configured");
}
```

Name the empty var (`GITEA_URL` / `GITEA_TOKEN` / `GITEA_OWNER`).

---

### Task 3: Gitea client — create private repo

**Files:**
- Create: `services/fc/src/lib/provisioning/gitea.ts`
- Create: `services/fc/test/provisioning/gitea.test.ts`
- Modify: `createApp` in `pg-repo/apps.ts` + supabase-repo equivalent + route wiring
- Modify: OpenAPI `App` schema + `POST /v1/apps` if needed

**Step 1: Failing test — createRepo naming + private flag**

```ts
test("createAppRepo posts private repo named tc-app-{appId}", async () => {
  const calls = [];
  const client = makeGiteaClient({
    url: "https://gitea.example",
    token: "tok",
    owner: "teamclaw-apps",
    fetch: async (input, init) => { calls.push({ input, init }); return json(201, { clone_url: "https://gitea.example/teamclaw-apps/tc-app-uuid.git", ssh_url: "git@gitea.example:teamclaw-apps/tc-app-uuid.git" }); },
  });
  const r = await client.createAppRepo("uuid");
  // ssh_url is the one persisted as the app remote — the deploy key is an SSH
  // key and authenticates nothing over HTTPS.
  assert.equal(r.sshUrl, "git@gitea.example:teamclaw-apps/tc-app-uuid.git");
  assert.match(String(calls[0].input), /\/api\/v1\/orgs\/teamclaw-apps\/repos$/);
  assert.equal(JSON.parse(calls[0].init.body).private, true);
  assert.equal(JSON.parse(calls[0].init.body).name, "tc-app-uuid");
});
```

**Step 2: Implement `createAppRepo` + `createDeployKey` + `deleteDeployKey`**

- Create repo: `POST /api/v1/orgs/{owner}/repos` (or user repos if owner is a user)
- Deploy key: `POST /api/v1/repos/{owner}/{repo}/keys` with `{ title, key, read_only: false }`
- Delete: `DELETE /api/v1/repos/{owner}/{repo}/keys/{id}`

**Step 3: Wire into `createApp`**

After inserting the apps row:
1. Call `createAppRepo(appId)`
2. Update row: `gitRemoteUrl`, `gitAuthKind='gitea_deploy_key'`, `provisionStatus='repo_created'`
3. On Gitea failure → set `provisionStatus='error'`, `provisionError`, return/throw readable 502/503

Missing Gitea env → 503 with named var (do not create orphan DB rows if possible; if row exists, mark error).

**Step 4: Run tests**

```bash
cd services/fc && node --test test/provisioning/gitea.test.ts test/routes-apps.test.ts
```

---

### Task 4: `GET /v1/apps/:appId/git-credential` (JIT deploy key)

**Files:**
- Create route handler (near apps routes)
- OpenAPI path
- Tests in `services/fc/test/routes-apps.test.ts`
- Client: `packages/app/src/lib/backend/cloud-api/apps.ts` + `types.ts`

**Contract:**

```http
GET /v1/apps/{appId}/git-credential
Authorization: Bearer …
→ 200 { remoteUrl, authKind: "deploy_key", privateKeyPem, deployKeyId, expiresAt }
```

Authz: **creator-only** (same as deploy). Response must never be logged.

**Step 1: Failing route test — non-creator 404; creator gets key**

**Step 2: Implement**

1. Generate ed25519 or RSA keypair in Node (`crypto.generateKeyPairSync`)
2. Register public key as write deploy key on `tc-app-{appId}`
3. Return private key PEM + `deployKeyId` for later delete (optional: desktop/daemon calls delete after push; or short-lived GC later)
4. Do **not** persist private key in DB

**Step 3: Client method `getGitCredential(appId)`**

Desktop seed/deploy will fetch this and pass to daemon over loopback only.

---

### Task 5: Deploy single-flight + sha + finalize trust boundary

**Files:**
- Modify: `services/fc/src/lib/pg-repo/apps.ts` (`deployApp`, `finalizeDeploy`)
- Mirror supabase-repo apps methods
- Modify: `services/fc/src/lib/provisioning/app-deploy.ts` (OAuth env injection hook later)
- Modify: OpenAPI deploy/finalize request bodies
- Tests: `services/fc/test/provisioning/app-deploy.test.ts`, `pg-repo-apps.test.ts`, `routes-apps.test.ts`

**Step 1: Failing tests**

```ts
test("second deploy while awaiting_build returns 409", …);
test("finalize without matching deployToken returns 409", …);
test("finalize with auth_mode=third returns 409", …);
test("finalize with runtime=container returns 409", …);
test("finalize writes gitCommitSha from body; oss key still apps/{id}/code.zip", …);
```

**Step 2: `deployApp` changes**

Request body: `{ gitCommitSha: string }` (required, 7–40 hex).

Logic:
1. Existing creator + `provision_status=ready` checks
2. Reject if `runtime !== 'node'`
3. Reject if `auth_mode === 'third'` with message about unsupported third-party login
4. Reject if `auth_mode === 'platform'` and `appPublicUrl(slug,id)` is null → 409 `vanity_required`
5. If `fcStatus ∈ {awaiting_build, building, deploying}` → **409** `deploy_in_progress`
6. Stale recovery: if `deploy_started_at` is older than 30m → allow overwrite after setting `deploy_error`. This must cover `building` and `deploying` too, not just `awaiting_build`: finalize sets `deploying` before calling FC, so a process killed there would otherwise block every future deploy forever
7. Mint `deployToken = randomUUID()`, set `deploy_started_at=now()`, store pending sha optionally on row or only require it again at finalize
8. Call `startDeploy`; return `{ …mapApp, ossObjectName, presignedPut, deployToken, gitCommitSha }`

**Step 3: `finalizeDeploy` changes**

Body: `{ gitCommitSha, deployToken }`.

1. Match `deployToken` to row; mismatch → 409
2. Re-check auth_mode / runtime
3. `ossObjectName = appOssObjectName(appId)` only (ignore any client path)
4. On success: `fc_status=live`, `git_commit_sha=body.gitCommitSha`, clear `deploy_token` / `deploy_started_at`
5. Hook for OAuth env (Task 7) — leave TODO callback in finalize deps

**Step 4: Run FC tests**

```bash
cd services/fc && node --test test/provisioning/app-deploy.test.ts test/pg-repo-apps.test.ts test/routes-apps.test.ts
```

---

### Task 6: OpenAPI + client types for new app fields & endpoints

**Files:**
- Modify: `docs/openapi/teamclu-api.v1.yaml`
- Modify: `packages/app/src/lib/backend/types.ts`
- Modify: `packages/app/src/lib/backend/cloud-api/apps.ts`

**Add/update:**
- `App` schema: `gitCommitSha`, `runtime`, `authMode`, `oauthClientId`
- `POST /deploy` body: `gitCommitSha`
- `POST /deploy/finalize` body: `gitCommitSha`, `deployToken`
- `GET /v1/apps/{appId}/git-credential`
- `GET /v1/apps/{appId}/membership` (stub schema; implement Task 8)
- `PATCH /v1/apps/{appId}`: allow `authMode` (with platform side effects in Task 7)

Keep camelCase JSON as existing Cloud API.

---

### Task 7: `auth_mode` + GoTrue OAuth client + `app_secrets`

**Files:**
- Create: `services/fc/src/lib/provisioning/app-secrets.ts` (encrypt/decrypt AES-GCM)
- Create: `services/fc/src/lib/provisioning/gotrue-oauth.ts` (admin register/update/disable)
- Modify: `updateApp` / finalize env builder
- Tests: new unit tests with mocked GoTrue fetch
- Gate: if `BACKEND_KIND=postgres` (Better Auth), reject setting `auth_mode=platform` with clear error (§6.7)

**Step 1: Secrets helper tests**

```ts
test("roundtrip encrypt/decrypt oauth_client_secret", () => {
  process.env.APP_SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const ct = seal("oauth_client_secret", "super-secret");
  assert.equal(open("oauth_client_secret", ct), "super-secret");
});
```

**Step 2: On `authMode → platform` (first time)**

1. Require `APPS_PUBLIC_DOMAIN` non-empty
2. Register OAuth client in GoTrue (redirect may be placeholder until first deploy)
3. Store `oauth_client_id`, `oauth_app_id` on apps row
4. Seal secret into `app_secrets` kind=`oauth_client_secret`

**Step 3: On finalize with `auth_mode=platform`**

1. Decrypt secret
2. Update GoTrue redirect to `{publicUrl}/auth/callback`
3. Inject into FC env: `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `APP_PUBLIC_URL`, `API_BASE` (no service role)

**Step 4: On `authMode → none|third`**

Disable GoTrue client; next finalize omits OAuth env.

**Step 5: Delete app** — cascade disable OAuth + secrets (DB cascade handles secrets row).

> **Open dependency §11.1:** If GoTrue admin API is not exposed in this environment, implement the client behind a feature flag and fail closed with `oauth_unavailable` naming the missing config — do not silently deploy as `none`.

---

### Task 8: `GET /v1/apps/:id/membership`

**Files:**
- Route + repo helper
- OpenAPI
- Test: team member → `{ member: true }`; outsider → 404 or `{ member: false }` (prefer 200 `{ member: boolean }` for app UX with user token)

Used by `platform` templates with the end-user’s bearer token (no service role in the app).

```ts
// pseudocode
async membership(appId) {
  const app = await loadVisibleApp… // or load by id if public membership check needs different gate
  // Spec §6.6: user token proves identity; check actor in app.team_id
  return { member: Boolean(await resolveActorForTeam(db, userId, app.teamId)) };
}
```

Visibility nuance: endpoint must be callable by a logged-in platform user who may not yet be an “app viewer” in control plane — they are logging into the *deployed* app. Prefer: any authenticated user can ask; answer is solely team membership of `app.teamId`. Do not leak existence of personal apps to non-members if product requires — Phase 1: return `{ member: false }` for non-members without distinguishing 404 vs false (or 404 if app missing).

---

### Task 9: Daemon — git helpers + seed push + build checkout

**Files:**
- Create: `apps/daemon/src/sync/app_git.rs` (init, remote, commit, push, fetch, checkout, dirty check)
- Modify: `apps/daemon/src/sync/app_seed.rs`
- Modify: `apps/daemon/src/sync/app_build.rs`
- Modify: `apps/daemon/src/http/apps.rs` (seed + build request bodies)
- Unit tests in each module (`#[cfg(test)]`)

**SDLC:** 写完即可；`cargo test -p amuxd …` 放到 preview。

**Seed body additions:** `git_remote_url`, `deploy_key_pem` (or path via temp file), optional `git_credential`

Seed flow:
1. `git init` if needed
2. Write template (existing)
3. Configure remote + `GIT_SSH_COMMAND` with deploy key
4. `git add -A && git commit && git push -u origin HEAD`
5. Return `{ status: "seeded", gitCommitSha }`

Build body additions: `git_commit_sha`, `git_remote_url`, `deploy_key_pem`

Build flow:
1. `git fetch` FIRST — the dirty/unpushed check compares HEAD against
   remote-tracking refs, and stale ones read a just-pushed commit as local work
2. Dirty / unpushed check → validation error with Chinese-friendly message mapping in desktop later: "请先 commit 并 push"
3. `git checkout -B {branch} {sha}` (sha must exist on remote). NOT
   `--detach`: a detached workdir cannot `push -u origin HEAD`, so the first
   deploy would leave the checkout in a state no later deploy or reseed could
   get out of
4. Timeouts on `pnpm install` / `pnpm build` (e.g. 10m / 10m) via `Command` + kill.
   Drain stdout/stderr on their own threads while the child runs — reading the
   pipes only after it exits deadlocks any build that outgrows a pipe buffer
5. Zip `.output`; if missing/empty → explicit error `"构建产物不在 .output/"`
6. Size cap (check阿里云 FC limit before coding; start with e.g. 50MiB or documented quota) → explicit error
7. Map frozen-lockfile failure stderr → `"lockfile 与 package.json 不一致，请提交更新后的 pnpm-lock.yaml"`
8. PUT; if HTTP 403 → surface `presign_expired` style message

Do **not** trust client `ossObjectName`; daemon already only uses `presigned_put`.

---

### Task 10: Desktop — seed/deploy orchestration + public confirm UI

**Files:**
- Modify: `packages/app/src/lib/daemon-local-client.ts` (`seedDaemonApp`, `buildDaemonApp`)
- Modify: `packages/app/src/stores/apps-store.ts` + `apps-store.test.ts`
- Modify: `packages/app/src/components/sidebar/AppsListColumn.tsx` (+ any create/settings dialog)
- i18n keys as needed

**Seed path:**
1. After `createApp` returns `repo_created` + `gitRemoteUrl`
2. `getGitCredential(appId)` → pass to `seedDaemonApp`
3. On success → `updateAppProvisionStatus(ready)` (existing)

**Deploy path:**
1. If `authMode === 'none'`: show confirm dialog — "任何拿到链接的人都能访问" — before continuing
2. Resolve target sha: call Gitea via **credential + daemon** or add lightweight `GET /v1/apps/:id/git-head` on FC (preferred: FC uses bot token to read default branch SHA so desktop need not speak Gitea). **Add thin `GET …/git-head` in Task 4/5** returning `{ sha }` for default branch.
3. `deployApp({ gitCommitSha })` → receive `presignedPut`, `deployToken`
4. `getGitCredential` → `buildDaemonApp(…, { sha, remote, key, presignedPut })`
5. `finalizeDeploy({ gitCommitSha, deployToken })`
6. Map distinguishable errors (daemon offline, dirty tree, timeout, size, presign, third, vanity)

**UI (§7):**
- Deploy button disabled when `authMode==='third'` or `runtime==='container'` with tooltip
- App row/detail always shows public badge when `authMode==='none' && fcStatus==='live'`
- Clarify copy: visibility ≠ public web access
- `platform` option hidden when control-plane is Better Auth / self-host without GoTrue (feature flag from backend or omit in UI when create returns error)

**Tests:** update `apps-store.test.ts` for new deploy args and confirm gating (mock confirm as accepted).

```bash
pnpm exec vitest run packages/app/src/stores/apps-store.test.ts
```

---

### Task 11: Templates — platform auth notes + AGENTS.md

**Files:**
- Under daemon app templates (`apps/daemon/src/sync/app_templates…`)
- Ensure `AGENTS.md` documents: commit+push before deploy; `.output` contract; `auth_mode` behavior; use `APP_PUBLIC_URL` / forwarded headers for redirect

For `platform` template variant (or shared snippet): PKCE login using injected `OAUTH_CLIENT_ID`; call `/v1/apps/:id/membership` with user access token.

Phase 1 minimum: document + minimal stub pages if templates already have auth placeholders; do not build a full IdP UI framework.

---

### Task 12: Stale deploy sweeper (minimal)

**Files:**
- On `deployApp` entry (Task 5) already reclaims any >30m in-flight deploy
- Optional: small helper `reclaimStaleDeploy(row)` used by getApp/list for honesty in UI

No separate cron in Phase 1.

---

### Task 13: Verification checklist (map to design §9)

Run what SDLC allows in this worktree:

```bash
cd services/fc && node --test test/provisioning/*.test.ts test/routes-apps.test.ts test/deploy-env-parity.test.ts test/pg-repo-apps.test.ts
pnpm exec vitest run packages/app/src/stores/apps-store.test.ts packages/app/src/components/sidebar/__tests__/AppsListColumn.helpers.test.ts
pnpm typecheck
```

Preview / manual (§9):
1. Create → Gitea repo exists → seed push → `ready`
2. App A credential cannot access App B repo (deploy key isolation)
3. Deploy binds sha; vanity URL opens
4. Dirty tree rejected
5. Daemon offline → visible error
6. Concurrent deploy → 409
7. Timeout / size / presign errors distinct
8. `none` confirm + detail “公开”
9. `platform` OAuth on vanity; second deploy still logs in; secret not plaintext in DB
10. `third` save OK, deploy rejected
11. No `container` create/deploy
12. Empty `APPS_PUBLIC_DOMAIN` → platform rejected
13. Env parity green

---

## Execution order (dependency graph)

```text
T1 schema → T2 env → T3 gitea create → T4 credential (+ git-head)
       ↘ T5 deploy sha/single-flight → T6 openapi/client
                         ↘ T7 oauth/secrets → T8 membership
T9 daemon git (parallel after T4 contract known)
T10 desktop (after T5+T6+T9)
T11 templates (with T9/T10)
T12 sweeper (fold into T5)
T13 verify
```

## Out of scope (do not implement)

- Server→daemon build dispatch, Gitea Actions, container runtime, env panel, custom domain, quotas, per-team Gitea org, GitForge abstraction, CodeUp, real `third` OIDC
