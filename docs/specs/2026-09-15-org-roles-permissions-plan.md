# Org Roles & Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship org-scoped RBAC (`public.roles` / `public.roles_users`) as the sole membership-role source of truth, with Settings「团队管理」, member role editing, and app-auth path rules that multi-select roles.

**Architecture:** Supabase migration creates tables + seeds + backfill + rewrites `amux.current_team_role` to derive from `roles_users`. Cloud API (OpenAPI → FC routes → supabase-repo) exposes team-prefixed role CRUD and member role PUT. App gateway `admit()` checks role-code intersection. Desktop client wires permissions, settings, contacts, and AppAuth UI. No direct Supabase from `packages/app`.

**Tech Stack:** PostgreSQL (Supabase migrations + pgTAP), Node 20 FC (`services/fc`), OpenAPI `docs/openapi/teamclu-api.v1.yaml`, React 19 / TypeScript / Zustand / Vitest (`packages/app`).

**Spec:** `docs/specs/2026-09-15-org-roles-permissions-design.md`

## Global Constraints

- Source of truth: `public.roles_users` only; stop read/write of `amux.team_members.role` (nullable, do not DROP).
- Org scope: `org_id = amux.teams.oid`; roles shared across teams in the same org.
- System roles (read-only): `owner`, `admin`, `member`, `finance`.
- Manage role definitions / assign member roles: holder of `owner` or `admin`.
- Admin cannot grant/revoke `owner`; cannot remove last org `owner` (409).
- Invite default: `member`. Team creator: `owner`.
- App auth: `roles: string[]` (codes); empty + required = any logged-in user; public clears roles.
- Legacy read: `audience: any` → `roles: []`; `audience: org` → any active `roles_users` in app org.
- `store_id` / `is_primary` / `expires_at` / `parent_role_id`: unused in UI; writes use `store_id=NULL`, `is_primary=false`, `expires_at=NULL`.
- Always set `org_id` explicitly from `teams.oid` (ignore DDL default UUID).
- Do not touch `amux.team_roles` / shortcuts RBAC.
- iOS/Expo UI out of scope; API must still work for them later.
- Never push to `main`; commit per task on `task/yong-hu-quan-xian-gu`.
- Cloud API boundary: no `@supabase/supabase-js` in `packages/app`.

## File map

| Area | Create | Modify |
|------|--------|--------|
| DDL docs | `docs/database/roles.sql`, `docs/database/roles_users.sql` | — |
| Migration | `services/supabase/migrations/20260915200000_org_roles.sql` | — |
| pgTAP | `services/supabase/tests/040_org_roles.sql` | — |
| OpenAPI | — | `docs/openapi/teamclu-api.v1.yaml` |
| FC routes | `services/fc/src/lib/routes/org-roles.ts` | `services/fc/src/lib/routes/index.ts` |
| FC repo | `services/fc/src/lib/supabase-repo/org-roles.ts` | `supabase-repo.ts` (wire), `repository-contract.ts` |
| Auth rules | — | `services/fc/src/lib/apps-auth-paths.ts`, `apps-auth-gate.ts` |
| FC tests | `services/fc/test/org-roles.test.ts` | `apps-auth-paths.test.ts`, `apps-auth-gate.test.ts` |
| Client API | `packages/app/src/lib/backend/cloud-api/org-roles.ts` | `types.ts`, `index.ts`, `directory.ts`, `actors.ts` |
| Permissions | — | `team-permissions.ts`, `current-team.ts` |
| Settings | `TeamRolesSection.tsx` (+ test) | `ui.ts`, `Settings.tsx`, `section-registry.tsx` |
| Contacts | — | `ActorDetailContent.tsx`, `ActorsView.tsx`, actor types |
| App auth UI | — | `AppAuthTabContent.tsx`, `AppSettingsPanel.tsx`, related tests |

---

### Task 1: DDL docs + Supabase migration (tables, seed, backfill, `current_team_role`)

**Files:**
- Create: `docs/database/roles.sql`
- Create: `docs/database/roles_users.sql`
- Create: `services/supabase/migrations/20260915200000_org_roles.sql`
- Create: `services/supabase/tests/040_org_roles.sql`

**Interfaces:**
- Produces tables `public.roles`, `public.roles_users` (as in spec DDL).
- Produces seed of four system roles per org.
- Rewrites `amux.current_team_role(uuid) returns text` to highest privilege among caller's active org roles for that team (`owner > admin > finance > member > other`).
- Produces helper `amux.has_org_role_code(p_team_id uuid, p_code text) returns boolean` (optional but preferred for clarity in later RLS).

- [ ] **Step 1: Write failing pgTAP skeleton**

Create `services/supabase/tests/040_org_roles.sql` following `015_rbac_shortcuts.sql` harness style:

```sql
begin;
select plan(8);

select has_table('public', 'roles', 'roles exists');
select has_table('public', 'roles_users', 'roles_users exists');
-- more assertions after migration exists
select finish();
rollback;
```

- [ ] **Step 2: Run test — expect FAIL (tables missing)**

Run: `pnpm --filter` or the repo's usual supabase db test command for a single file (see `services/supabase/README` / CI). If local DB unavailable, note and continue; CI must run it.

Expected: FAIL on `has_table('public','roles')`.

- [ ] **Step 3: Add `docs/database/*.sql` copies of agreed DDL**

Paste the user-provided `CREATE TABLE` for `roles` and `roles_users` (indexes included). Add partial unique:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_users_user_role_null_store
  ON public.roles_users (user_id, role_id) WHERE store_id IS NULL;
```

- [ ] **Step 4: Write migration `20260915200000_org_roles.sql`**

Must include, in order:

1. `CREATE TABLE IF NOT EXISTS` for both tables (from docs/database).
2. Partial unique index above.
3. RLS enable + policies: members of an org (via `amux.teams.oid = org_id` and membership) can SELECT; only owner/admin (via new helper or role codes) can INSERT/UPDATE/DELETE. Service role full access.
4. Seed function / DO block: for every `public.orgs` id, upsert four system roles.
5. Backfill from `amux.team_members`:

```sql
insert into public.roles_users (user_id, role_id, org_id, status, store_id, is_primary)
select distinct
  a.user_id,
  r.id,
  t.oid,
  'active',
  null,
  false
from amux.team_members tm
join amux.teams t on t.id = tm.team_id
join amux.actors a on a.id = tm.member_id
join public.roles r
  on r.org_id = t.oid
 and r.code = lower(tm.role)
 and r.is_system = true
where a.user_id is not null
  and t.oid is not null
  and tm.role is not null
on conflict do nothing;
```

(Adjust conflict target to the partial unique index / constraint name.)

6. Replace `amux.current_team_role`:

```sql
create or replace function amux.current_team_role(target_team_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public', 'auth', 'amux'
as $$
  select r.code
  from amux.teams t
  join public.roles_users ru
    on ru.org_id = t.oid
   and ru.user_id = auth.uid()
   and ru.status = 'active'
  join public.roles r on r.id = ru.role_id and r.status = 'active'
  where t.id = target_team_id
  order by case r.code
    when 'owner' then 1
    when 'admin' then 2
    when 'finance' then 3
    when 'member' then 4
    else 5
  end
  limit 1
$$;
```

7. `alter table amux.team_members alter column role drop not null;` (if currently NOT NULL).
8. Grants on tables to `authenticated` / `service_role` as needed.

- [ ] **Step 5: Expand pgTAP — seed, backfill union, last-owner helper if any, system codes present**

Assert at least:

- Each fixture org has four system role codes.
- Member with `team_members.role='owner'` backfills `roles_users` for `owner`.
- `current_team_role(team)` returns `owner` for that user.
- User with both admin and member rows → `current_team_role` returns `admin`.

- [ ] **Step 6: Run pgTAP — expect PASS**

- [ ] **Step 7: Commit**

```bash
git add docs/database/roles.sql docs/database/roles_users.sql \
  services/supabase/migrations/20260915200000_org_roles.sql \
  services/supabase/tests/040_org_roles.sql
git commit -m "$(cat <<'EOF'
feat(db): add public.roles / roles_users and migrate team_members.role

Seed system owner/admin/member/finance per org, backfill assignments,
and derive current_team_role from roles_users.
EOF
)"
```

---

### Task 2: OpenAPI — role schemas and team-prefixed paths

**Files:**
- Modify: `docs/openapi/teamclu-api.v1.yaml`

**Interfaces:**
- Produces schemas: `OrgRole`, `OrgRoleCreate`, `OrgRolePatch`, `MemberRolesPut`, `MemberRoleRef`.
- Produces paths listed in spec §2.1.
- Extends member/directory actor shapes with `roles: MemberRoleRef[]` and keeps transitional `teamRole` / `role` as derived highest privilege.

- [ ] **Step 1: Add schemas under `components.schemas`**

```yaml
OrgRole:
  type: object
  required: [id, orgId, name, code, isSystem, status, sort]
  properties:
    id: { type: string, format: uuid }
    orgId: { type: string, format: uuid }
    name: { type: string }
    code: { type: string, pattern: '^[a-z][a-z0-9_]*$' }
    description: { type: [string, "null"] }
    isSystem: { type: boolean }
    status: { type: string, enum: [active, inactive] }
    sort: { type: integer }
    parentRoleId: { type: [string, "null"], format: uuid }
MemberRoleRef:
  type: object
  required: [id, code, name]
  properties:
    id: { type: string, format: uuid }
    code: { type: string }
    name: { type: string }
OrgRoleCreate:
  type: object
  required: [name, code]
  properties:
    name: { type: string }
    code: { type: string, pattern: '^[a-z][a-z0-9_]*$' }
    description: { type: string }
    sort: { type: integer, default: 50 }
OrgRolePatch:
  type: object
  properties:
    name: { type: string }
    description: { type: [string, "null"] }
    status: { type: string, enum: [active, inactive] }
    sort: { type: integer }
MemberRolesPut:
  type: object
  required: [roleIds]
  properties:
    roleIds:
      type: array
      items: { type: string, format: uuid }
```

- [ ] **Step 2: Add paths** after `/v1/teams/{teamId}/members/{actorId}`:

- `GET/POST /v1/teams/{teamId}/roles`
- `PATCH/DELETE /v1/teams/{teamId}/roles/{roleId}`
- `GET/PUT /v1/teams/{teamId}/members/{actorId}/roles`

Document 403/409 cases from spec §2.5.

- [ ] **Step 3: Extend `AppAuthRule`**

Add:

```yaml
roles:
  type: array
  items: { type: string }
  description: >-
    Role codes that may access this path when auth=required.
    Empty or omitted = any authenticated user. Ignored when auth=public.
    Prefer this over audience; audience is legacy-read only.
```

Keep `audience` marked deprecated in description.

- [ ] **Step 4: Commit**

```bash
git add docs/openapi/teamclu-api.v1.yaml
git commit -m "docs(openapi): add org roles endpoints and AppAuthRule.roles"
```

---

### Task 3: FC — org roles CRUD (repo + routes + tests)

**Files:**
- Create: `services/fc/src/lib/supabase-repo/org-roles.ts`
- Create: `services/fc/src/lib/routes/org-roles.ts`
- Create: `services/fc/test/org-roles.test.ts`
- Modify: `services/fc/src/lib/routes/index.ts` (register)
- Modify: `services/fc/src/lib/supabase-repo.ts` (attach methods)
- Modify: `services/fc/src/lib/repository-contract.ts` (optional stub methods if contract enumerates)

**Interfaces:**
- Produces repo methods:

```ts
listOrgRoles(teamId: string): Promise<OrgRole[]>
createOrgRole(teamId: string, input: { name: string; code: string; description?: string; sort?: number }): Promise<OrgRole>
patchOrgRole(teamId: string, roleId: string, patch: OrgRolePatch): Promise<OrgRole>
deleteOrgRole(teamId: string, roleId: string): Promise<void> // 409 if bindings
```

- Authz inside repo/RPC: `current_team_role` in (`owner`,`admin`); reject `is_system` mutations.

- [ ] **Step 1: Write failing route/unit tests** in `org-roles.test.ts`

Cover: list returns seeded system roles; create custom; patch system → 403; delete with binding → 409; non-admin → 403.

- [ ] **Step 2: Run — expect FAIL**

Run: `cd services/fc && node --test test/org-roles.test.ts` (or package script used by CI).

- [ ] **Step 3: Implement `org-roles.ts` repo**

Resolve `org_id` via `select oid from amux.teams where id = $teamId`. Use service-role or user JWT supabase client consistent with neighboring modules (`knowledge-acl.ts` pattern). Map snake_case → camelCase response.

- [ ] **Step 4: Implement routes**

```ts
// services/fc/src/lib/routes/org-roles.ts
export function registerOrgRoles(router) {
  router.get("/v1/teams/:teamId/roles", async (ctx) => {
    const items = await ctx.repository.listOrgRoles(ctx.params.teamId);
    return { body: { items } };
  });
  router.post("/v1/teams/:teamId/roles", async (ctx) => {
    const row = await ctx.repository.createOrgRole(ctx.params.teamId, ctx.json);
    return { status: 201, body: row };
  });
  router.patch("/v1/teams/:teamId/roles/:roleId", async (ctx) => {
    const row = await ctx.repository.patchOrgRole(ctx.params.teamId, ctx.params.roleId, ctx.json);
    return { body: row };
  });
  router.delete("/v1/teams/:teamId/roles/:roleId", async (ctx) => {
    await ctx.repository.deleteOrgRole(ctx.params.teamId, ctx.params.roleId);
    return { status: 204 };
  });
}
```

Register in `routes/index.ts`.

- [ ] **Step 5: Run tests — PASS**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(fc): org roles CRUD under /v1/teams/:teamId/roles"
```

---

### Task 4: FC — member roles GET/PUT + directory `roles[]`

**Files:**
- Modify: `services/fc/src/lib/supabase-repo/org-roles.ts` (add member methods)
- Modify: `services/fc/src/lib/routes/org-roles.ts`
- Modify: directory/actors mapping in supabase-repo (wherever `teamRole` is set)
- Modify: `services/fc/test/org-roles.test.ts`
- Modify: invite/create-team paths that set `team_members.role` → also write `roles_users`

**Interfaces:**
- Produces:

```ts
listMemberRoles(teamId: string, actorId: string): Promise<MemberRoleRef[]>
putMemberRoles(teamId: string, actorId: string, roleIds: string[]): Promise<MemberRoleRef[]>
```

- PUT replaces all active assignments for that user in the org (delete missing, insert new). Enforce admin-cannot-touch-owner and last-owner.
- Directory/list actors: include `roles: MemberRoleRef[]` and derived `teamRole`.

- [ ] **Step 1: Failing tests** for PUT replace, admin cannot grant owner, last owner 409, invite creates member `roles_users`.

- [ ] **Step 2: Implement put/list + wire directory**

Resolve actor → `user_id` via `amux.actors`. On team create / invite claim, insert `roles_users` for `owner` / `member` respectively; stop depending on `team_members.role` for authz (may still write nullable role for one release as unused mirror — prefer **stop writing** per spec).

- [ ] **Step 3: Tests PASS + commit**

```bash
git commit -m "feat(fc): member org role assignment and directory roles[]"
```

---

### Task 5: FC — `AppAuthRule.roles` parse + gateway admit

**Files:**
- Modify: `services/fc/src/lib/apps-auth-paths.ts`
- Modify: `services/fc/src/lib/apps-auth-gate.ts`
- Modify: `services/fc/test/apps-auth-paths.test.ts`
- Modify: `services/fc/test/apps-auth-gate.test.ts`
- Possibly: `services/fc/src/lib/supabase-repo.ts` (validate role codes exist on save)

**Interfaces:**
- Extends `AuthRule`:

```ts
export type AuthRule = {
  path: string;
  auth: "required" | "public";
  audience?: AuthAudience; // legacy read
  roles?: string[];        // codes
};
```

- `parseAuthRules`: accept `roles` array of strings matching `^[a-z][a-z0-9_]*$`; strip on `public`; do not require `audience`.
- `admit`: if effective roles non-empty, load visitor's active role codes for `app.orgId` / team oid; allow on intersection; else 403. Empty roles → any authenticated (skip org check). Legacy: no `roles` key but `audience: org` → any `roles_users` row; `audience: any` → allow.

- [ ] **Step 1: Failing tests**

```ts
// paths: roles preserved; public drops roles; invalid code throws
// gate: required+roles [admin] admits admin user; denies member; [] admits any login
// gate: legacy audience org still works via roles_users presence
```

- [ ] **Step 2: Implement parse + admit changes**

Update `matchAuthRule` / callers that currently pass `pathAudience` to also pass `pathRoles`. Single match function should return `{ auth, audience?, roles? }`.

- [ ] **Step 3: Tests PASS + commit**

```bash
git commit -m "feat(fc): app auth rules roles[] and gateway role admit"
```

---

### Task 6: Client Cloud API types + `org-roles` module

**Files:**
- Create: `packages/app/src/lib/backend/cloud-api/org-roles.ts`
- Modify: `packages/app/src/lib/backend/types.ts`
- Modify: `packages/app/src/lib/backend/cloud-api/index.ts`
- Modify: `packages/app/src/lib/backend/cloud-api/directory.ts`
- Modify: `packages/app/src/lib/backend/cloud-api/actors.ts`
- Test: `packages/app/src/lib/backend/cloud-api/__tests__/org-roles.test.ts`

**Interfaces:**
- Backend interface additions:

```ts
orgRoles: {
  list(teamId: string): Promise<OrgRole[]>
  create(teamId: string, input: OrgRoleCreate): Promise<OrgRole>
  patch(teamId: string, roleId: string, patch: OrgRolePatch): Promise<OrgRole>
  remove(teamId: string, roleId: string): Promise<void>
  listMemberRoles(teamId: string, actorId: string): Promise<MemberRoleRef[]>
  putMemberRoles(teamId: string, actorId: string, roleIds: string[]): Promise<MemberRoleRef[]>
}
```

- `CurrentTeamMemberSummary` / actor rows: `roles?: MemberRoleRef[]` plus derived `role` / `teamRole`.

- [ ] **Step 1: Failing unit test** mocking `client.get/post/...` for list/put.

- [ ] **Step 2: Implement module + wire provider**

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(app): Cloud API client for org roles"
```

---

### Task 7: `useTeamPermissions` + current member from `roles[]`

**Files:**
- Modify: `packages/app/src/lib/team/team-permissions.ts`
- Modify: `packages/app/src/lib/team/__tests__/team-permissions.test.ts`
- Modify: `packages/app/src/stores/current-team.ts`
- Modify: any mapper that sets `currentMember.role` from API

**Interfaces:**
- Change to:

```ts
export function permissionsForRoles(roles: Array<{ code: string }> | null | undefined): TeamPermissions
export function highestRoleCode(roles: Array<{ code: string }>): CloudRole | null
```

- `useTeamPermissions` reads `currentMember.roles` (fallback: derive from legacy `role` string if `roles` absent during rollout).
- `CloudRole` stays `owner|admin|member` for `role` field; `finance` counts as non-managing (`canManageTeam=false`, `canEditFiles=true` unless also member-only — treat finance like member for file edit: **canEditFiles = has owner|admin|finance OR (not only-member)** → simplest: `canEditFiles = !isOnlyMember` where only-member means roles ⊆ {member} or empty. Spec: keep previous semantics: member read-only files; owner/admin edit. Finance alone → treat as **can edit** (non-member privilege) OR as member — **choose: finance alone ⇒ canEditFiles true, canManageTeam false**.

- [ ] **Step 1: Update unit tests first** (owner+member codes, admin, finance-only, empty).

- [ ] **Step 2: Implement + wire current-team load**

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(app): derive team permissions from roles_users roles[]"
```

---

### Task 8: Settings —「团队管理」group + TeamRolesSection

**Files:**
- Modify: `packages/app/src/stores/ui.ts` — add `'teamRoles'` to `SettingsSection`
- Modify: `packages/app/src/components/settings/Settings.tsx` — new accordion group
- Modify: `packages/app/src/components/settings/section-registry.tsx`
- Create: `packages/app/src/components/settings/TeamRolesSection.tsx`
- Create: `packages/app/src/components/settings/__tests__/TeamRolesSection.test.tsx`
- Modify: `packages/app/src/components/settings/__tests__/SettingsNavigation.test.tsx`

**Interfaces:**
- Nav group label: `团队管理` / `settings.navGroup.teamManagement`
- Items order: billing, tokenUsage, teamRoles
- Remove billing & tokenUsage from `primarySections`

- [ ] **Step 1: Failing nav test** — group contains three ids; primary no longer has billing/tokenUsage.

- [ ] **Step 2: Implement nav regroup**

- [ ] **Step 3: Failing TeamRolesSection tests** — lists roles; system rows have no edit/delete; create calls API; delete 409 shows binding count.

- [ ] **Step 4: Implement TeamRolesSection** (Editorial Calm: paper list, mono code, coral only on primary button)

- [ ] **Step 5: PASS + commit**

```bash
git commit -m "feat(app): 团队管理 settings group and team roles page"
```

---

### Task 9: Contacts — member detail role chips + editor

**Files:**
- Modify: `packages/app/src/components/sidebar/ActorDetailContent.tsx`
- Modify: `packages/app/src/components/panel/ActorsView.tsx` (sorting / pills)
- Modify: `packages/app/src/stores/actor-directory-store.ts` (map `roles`)
- Modify: related tests (`ActorDetailDialog.test.tsx`, `ActorsView.test.tsx`)

**Interfaces:**
- Display `roles.map(r => chip)`; empty → fallback "成员" only if no roles.
- owner/admin: button「编辑角色」→ multi-select dialog → `putMemberRoles`.
- Disable owner checkbox for non-owner editors; block clearing last owner in UI.

- [ ] **Step 1: Failing tests** for chips render and putMemberRoles on save.

- [ ] **Step 2: Implement UI**

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(app): member detail roles from roles_users with editor"
```

---

### Task 10: App auth UI — three columns (path / login / roles)

**Files:**
- Modify: `packages/app/src/components/apps/AppAuthTabContent.tsx`
- Modify: `packages/app/src/components/apps/AppSettingsPanel.tsx` (summary strings)
- Modify: `packages/app/src/components/apps/AppControlPanel.tsx` if it shows auth summary
- Modify: `packages/app/src/lib/backend/types.ts` (`AppAuthRule.roles?: string[]`)
- Modify: tests `AppAuthTabContent.test.tsx`, `AppSettingsPanel.test.tsx`, `AppControlPanel.test.tsx`

**Interfaces:**
- Replace `Access = public|any|org` with:

```ts
type RowState = {
  path: string
  requiresLogin: boolean
  roleCodes: string[] // only when requiresLogin
}
```

- Load org roles via `orgRoles.list(teamId)` for multi-select options.
- Save: `requiresLogin ? { path, auth:'required', roles: roleCodes } : { path, auth:'public' }`.
- Baseline row: same; map old `authAudience`/`audience` into initial `roleCodes` for display only (any→[]; org→all active role codes or special「任意有角色用户」— **prefer**: org legacy displays as empty roles + a note is wrong; use **legacy org → leave roleCodes empty is wrong**. Spec: legacy org = any roles_users. For UI editing, when loading a rule with `audience: org` and no `roles`, show requiresLogin=true and roleCodes=[] is **incorrect** (that means any login). **Load mapping:** `audience: org` without roles → set a sentinel UI state `legacyOrgOnly=true` OR prefill with all role codes. **Choose: on load, `audience: org` and no roles → roleCodes = all org role codes (explicit)** so save migrates off audience. `audience: any` → roleCodes=[].

- [ ] **Step 1: Rewrite failing AppAuth tests** for three columns and disabled roles when public.

- [ ] **Step 2: Implement UI + summary copy**

Summaries: `不需要登录` / `需要登录 · 任意用户` / `需要登录 · admin, finance`.

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(app): app auth path rules with role multi-select"
```

---

### Task 11: Smoke verification + leftover `team_members.role` write purge

**Files:**
- Grep-driven cleanup across repo for writes to `team_members.role` / `teamRole: 'owner'` create paths
- Modify any remaining FC invite/create handlers missed in Task 4
- Run: `pnpm typecheck` (or app package typecheck), targeted vitest, FC tests

- [ ] **Step 1: Grep and fix stragglers**

```bash
rg -n "team_members\.role|teamRole:\s*'owner'|p_team_role" services/fc packages/app services/supabase/migrations/*.sql
```

Every write path must use `roles_users` (except historical migrations).

- [ ] **Step 2: Run verification**

```bash
pnpm typecheck
cd services/fc && node --test test/org-roles.test.ts test/apps-auth-paths.test.ts test/apps-auth-gate.test.ts
pnpm exec vitest run packages/app/src/lib/team/__tests__/team-permissions.test.ts \
  packages/app/src/components/settings/__tests__/TeamRolesSection.test.tsx \
  packages/app/src/components/apps/__tests__/AppAuthTabContent.test.tsx
```

- [ ] **Step 3: Final commit if cleanup needed**

```bash
git commit -m "chore: purge remaining team_members.role writes after roles_users cutover"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| `public.roles` / `roles_users` DDL + docs/database | 1 |
| Seed four system roles | 1 |
| Backfill from `team_members.role` | 1 |
| Rewrite `current_team_role` | 1 |
| Nullable, no DROP column | 1 |
| OpenAPI endpoints | 2 |
| `AppAuthRule.roles` | 2, 5, 10 |
| FC roles CRUD | 3 |
| Member PUT roles + directory | 4 |
| Invite member / create owner | 4, 11 |
| Gateway admit intersection + legacy audience | 5 |
| Client Cloud API | 6 |
| `useTeamPermissions` from roles | 7 |
| Settings 团队管理 | 8 |
| Team roles page read-only system | 8 |
| Member detail chips + editor | 9 |
| App auth three columns | 10 |
| Non-goals (store UI, iOS, shortcuts, DROP column) | excluded |

No TBD placeholders remain after self-review.
