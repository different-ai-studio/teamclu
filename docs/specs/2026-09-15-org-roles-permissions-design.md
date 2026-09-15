# Org Roles & Permissions — Design

Date: 2026-09-15
Status: Draft (awaiting review)
Branch context: `task/yong-hu-quan-xian-gu`

## Goal

Introduce org-scoped RBAC via `public.roles` and `public.roles_users`, and wire
it through:

1. **Settings** — new top-level group「团队管理」with 账单 / Token 用量 / 团队角色.
2. **Contacts** — member detail roles come from `roles_users`; owner/admin can
   add/remove roles.
3. **App auth control plane** — per-path rules become three columns: path,
   requires login, roles (multi-select). Drop the employee (`audience: org`)
   concept from the UI.

`amux.team_members.role` is fully replaced as the source of truth (approach A):
backfill into `roles_users`, stop reading/writing the column in this change set,
drop the column in a later PR.

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Source of truth | `roles_users` only; deprecate `team_members.role` |
| Scope | Org-level (`org_id`); shared across all teams under the same org |
| System roles | `owner`, `admin`, `member`, `finance` (`is_system=true`) |
| Who edits role definitions | owner or admin; system roles fully read-only |
| Who assigns member roles | owner or admin |
| Owner protection | admin cannot grant/revoke `owner`; cannot remove last org `owner` |
| Invite default | `member` |
| Team create | creator gets `owner` |
| App auth empty roles + login required | any authenticated user |
| App auth no login | roles column disabled and cleared |
| API shape | Team-prefixed routes; server resolves `org_id = teams.oid` |
| Member role write API | `PUT` replaces the full set |
| `store_id` | Column kept for schema parity; UI/API always `NULL` this round |
| Shortcuts RBAC | `amux.team_roles` / `team_member_roles` untouched |
| Mobile | API ready; iOS/Expo UI out of scope this round |

## Non-goals

- Store /门店 dimension UI
- Invite-time role selection (beyond default `member`)
- Extra privileges for `finance` beyond being a selectable role
- Dropping `amux.team_members.role` in this PR
- Reworking app「协作权限」(who can edit the app)
- Changing `amux.team_roles` (shortcuts)
- iOS / Expo settings & contacts UI for roles

---

## 1. Data model

### 1.1 Tables

Add to `public`, matching:

- `docs/database/roles.sql`
- `docs/database/roles_users.sql`

(Those files are created in-repo from the agreed DDL if missing.)

**`roles`** — org role catalog: `id`, `name`, `code`, `description`, `org_id`,
`is_system`, `status`, `parent_role_id`, `sort`, audit columns.
Constraints: `UNIQUE(org_id, code)`, code format `^[a-z][a-z0-9_]*$`,
status in (`active`,`inactive`).

**`roles_users`** — assignment: `user_id` → `public.users`, `role_id` → `roles`,
optional `store_id`, `org_id`, `status`, `is_primary`, `expires_at`, audit.
Constraints: `UNIQUE(user_id, role_id, store_id)`, status check, expires_at check.

This round: always write `store_id = NULL`, `is_primary = false`,
`expires_at = NULL`. Do not surface `parent_role_id` / `is_primary` /
`expires_at` / `store_id` in the UI. DDL may keep a saas-mono default
`org_id`; TeamClu writers **must** set `org_id` explicitly from `teams.oid`
and never rely on that default.

If PostgreSQL NULL-unique behavior allows duplicate `(user_id, role_id)` with
`store_id IS NULL`, add a partial unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_users_user_role_null_store
  ON roles_users (user_id, role_id) WHERE store_id IS NULL;
```

### 1.2 Seed (every org)

| code | name | is_system |
|------|------|-----------|
| `owner` | 拥有者 | true |
| `admin` | 管理员 | true |
| `member` | 成员 | true |
| `finance` | 财务 | true |

Upsert per `public.orgs` row on `ON CONFLICT (org_id, code)`. New orgs get the
same four rows (trigger or create-org path).

System roles: no delete, no `code`/`is_system` change, no name/description/sort
edits (fully read-only).

### 1.3 Migration from `team_members.role`

1. **Backfill:** For each `amux.team_members` row, resolve
   `user_id` (member → actor → auth/public user) and `org_id` (`teams.oid`).
   Insert `roles_users` for the matching system role code, `status=active`,
   `store_id=NULL`. Same user in one org across teams with different roles →
   **union** of roles.
2. **Stop writes** to `team_members.role`; invite → `member`; team create →
   `owner`.
3. **Stop reads**; permission helpers and RPCs use `roles_users`.
4. **Column:** make `amux.team_members.role` nullable and unused; **do not DROP**
   in this PR.

### 1.4 Boundary

`amux.team_roles` / `amux.team_member_roles` / `amux.permissions` (shortcuts RBAC)
are out of scope and unchanged.

---

## 2. Cloud API & authorization

Follow the Cloud API boundary: OpenAPI → repository-contract → business-api →
supabase-repo → client provider. No direct Supabase from `packages/app`.

### 2.1 Endpoints

Team-prefixed; server uses `teams.oid` as `org_id`:

| Method | Path | Authz | Purpose |
|--------|------|-------|---------|
| `GET` | `/v1/teams/{teamId}/roles` | team member | List org roles |
| `POST` | `/v1/teams/{teamId}/roles` | owner/admin | Create custom role |
| `PATCH` | `/v1/teams/{teamId}/roles/{roleId}` | owner/admin | Update custom role (system → 403) |
| `DELETE` | `/v1/teams/{teamId}/roles/{roleId}` | owner/admin | Hard-delete custom role with **zero** bindings (system → 403; any bindings → 409). Soft-deactivate (`status=inactive`) is via `PATCH`, not `DELETE`. |
| `GET` | `/v1/teams/{teamId}/members/{actorId}/roles` | team member | Member's org roles |
| `PUT` | `/v1/teams/{teamId}/members/{actorId}/roles` | owner/admin | Replace role set `{ roleIds: uuid[] }` |

Directory / actors / `members/me` responses include:

```ts
roles: Array<{ id: string; code: string; name: string }>
```

Optional transitional `teamRole`: derived highest privilege among
`owner > admin > finance > member` for old callers; UI must use `roles[]`.

### 2.2 Permission helpers

Replace `permissionsForRole` / `useTeamPermissions` input:

- `isOwner` ⇔ active `owner` in `roles_users` for current org
- `canManageTeam` ⇔ active `owner` **or** `admin`
- Role definition CRUD and member role PUT require `canManageTeam`
- Admin cannot grant or revoke `owner`
- Removing the last active `owner` assignment in the org → `409`

Server RPCs such as `current_team_role` (and any RLS relying on it) must be
rewritten to derive from `roles_users` (or replaced with helpers like
`has_org_role(org_id, code)` / `has_any_org_role(org_id, codes[])`).

### 2.3 App auth rules

Stored on `amux.apps.auth_rules` (jsonb), shape:

```json
[
  { "path": "/admin", "auth": "required", "roles": ["admin", "finance"] },
  { "path": "/", "auth": "required", "roles": [] },
  { "path": "/health", "auth": "public" }
]
```

Semantics:

- `auth: "public"` → ignore `roles`
- `auth: "required"` + missing/`[]` `roles` → any logged-in user
- `auth: "required"` + non-empty `roles` → caller must have an **intersection**
  between their active org role **codes** and the list

**Legacy read compatibility:**

- `audience: "any"` → treat as `roles: []`
- `audience: "org"` → admit if user has **any** active `roles_users` row in the
  app's org

New writes from the UI never emit `audience`. Baseline app-level
`auth_audience` remains for old rows until a follow-up cleanup; effective
per-path evaluation prefers rule `roles` / legacy `audience` as above.

### 2.4 Gateway admit

FC app proxy `admit()`:

1. Resolve path rule (longest prefix; same single match as today).
2. If public → allow.
3. If required and no session → login redirect.
4. If `roles` empty → allow any authenticated user.
5. Else load caller's active role codes for the app org; allow iff intersection
   non-empty; else 403.

### 2.5 Errors

| Case | Status | Note |
|------|--------|------|
| Mutate system role | 403 | 系统角色不可修改 |
| Delete role with bindings | 409 | Include binding count |
| Non owner/admin write | 403 | |
| Admin grants/revokes owner | 403 | |
| Remove last owner | 409 | |
| Bad/duplicate role code | 400/409 | |
| Unknown role code in auth_rules | 400 | |
| Gateway role mismatch | 403 | Same family of deny UX as today's org deny |

---

## 3. Client UI

### 3.1 Settings nav

New top-level group **「团队管理」**:

1. 账单 (`billing`) — moved out of primary
2. Token 用量 (`tokenUsage`) — moved out of primary
3. 团队角色 (`teamRoles`) — new

Do not confuse with Local Agent section id `roles` (agent role markdown; remains
hidden). New id must be `teamRoles`.

### 3.2 Team roles page

Paper list +「新建角色」(owner/admin only).

Row: name, code (mono), description, status, system badge.

- System four: read-only, no actions.
- Custom: edit name/description/sort/status via PATCH; hard-delete only when
  binding count is 0 (else 409 with count).
- `code` immutable after create; must match DB format check.
- Members without manage permission: read-only list.

### 3.3 Contacts · member detail

Replace single role label with **role chips** from `roles[]`.

- Non managers: read-only chips.
- owner/admin:「编辑角色」multi-select → `PUT .../members/{actorId}/roles`.
- Enforce last-owner and admin-cannot-touch-owner in UI (server remains source of
  enforcement).

List ranking: has `owner` → has `admin` → others, then display name.

### 3.4 App auth three columns

Replace the single Access select (`public` / `any` / `org`):

| Column | Control |
|--------|---------|
| 页面地址 | path input |
| 是否需要登录 | binary: no / yes |
| 角色 | multi-select of org roles; disabled + cleared when login not required |

Baseline row uses the same model. Save writes `auth` + `roles[]` only.
Summary copy examples: `需要登录 · admin, finance` / `需要登录 · 任意用户` /
`不需要登录`.

「协作权限」unchanged.

### 3.5 Visual language

Editorial Calm tokens in `AGENTS.md`. Coral only for approved accents (e.g.
primary save). No new purple/cream marketing palette.

---

## 4. Implementation order

1. DDL docs + Supabase migration (tables, indexes, RLS/grants, seed, backfill)
2. OpenAPI + FC repo/routes + gateway `admit` + tests
3. Client Cloud API types/provider
4. Settings nav + team roles page
5. Member detail role editor
6. App auth three-column UI + summary strings
7. Update `useTeamPermissions` / directory mapping / related unit tests

## 5. Test plan (minimum)

- **pgTAP:** constraints, seed per org, backfill union, last-owner reject,
  system role immutability.
- **FC:** roles CRUD, member PUT roles, auth_rules validation, admit with role
  intersection + legacy audience read.
- **Frontend:** settings「团队管理」group, system roles read-only, member
  multi-select, AppAuth columns (roles disabled without login; empty roles =
  any user).

## 6. Open follow-ups (not this PR)

- DROP `amux.team_members.role`
- Remove `auth_audience` / `audience` after traffic is clean
- Invite payload role selection
- iOS / Expo parity
- `store_id` scoping UI if saas-mono needs it
