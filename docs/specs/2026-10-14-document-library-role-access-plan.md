# Document Library Role Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A top-level `documents/<folder>/` can be synced only by people who hold one of its org roles, with the owner always included.

**Architecture:** Role grants live in a new table beside the existing per-actor grants. `services/fc/src/lib/sync-acl.ts` stays the only sync decision. A pure helper decides "does this role rule deny this caller?"; the repository writes rules; the desktop file tree edits only top-level document folders. Daemon revocation (`apply_revocations`, 30-minute full manifest) is unchanged.

**Tech Stack:** Supabase migration + FC service-role SQL, Node test runner (`node:test`) in `services/fc`, OpenAPI, Cloud API client in `packages/app`, Vitest + React Testing Library.

**Spec:** `docs/specs/2026-10-14-document-library-role-access-design.md`

## Global Constraints

- A library prefix matches `^documents/[^/]+/$`. `documents/` itself, nested folders, `knowledge/`, and files sitting in `documents/` are not library rules.
- A role rule allows the caller when their active org roles include `owner` or any granted role id. `admin` does not pass by itself.
- The server unions the org's active system role `owner` into every role rule. A client that omits it still gets it stored.
- One documents rule must not be a path-prefix of another. Overlap returns 409. `documents/财务/` and `documents/财务公开/` do not overlap.
- A rule is either role grants or actor grants. Writing roles deletes that rule's `amuxc_path_acl_grants` rows. If both exist, role grants win at read time.
- Do not copy current members into actor grants.
- `affectedFiles > 0` and `affectedMembers > 0` without `confirmRevokeExisting: true` returns 409 and writes nothing. Copy says 停止同步, never 撤回 / 收回 / 吊销访问.
- Role lookup failure fails closed: `aclViewFor` throws, nothing is cached, sync does not fall open.
- Teams with zero ACL rules stay one query and an empty view.
- `listKnowledgeAcl` keeps returning every `amuxc_path_acl` row, including role libraries, so `wiki-maintainer-client.ts` still passes those `pathPrefix` values into the existing preflight. Do not change `scripts/kb-maintainer` or the daemon.
- New `documents/` rules cannot be created on `POST /v1/teams/:teamId/knowledge-acl` (400). Existing documents actor rules can still be member-edited or deleted there. Updating a rule that already has role grants returns 409.
- Management endpoints are owner/admin only. The list is not for ordinary members.
- Grant `service_role` on the new table in the same migration. Do not grant `authenticated`. RLS on, no policy, force RLS.

---

### Task 1: Pure access decision

**Files:**
- Create: `services/fc/src/lib/document-library-access.ts`
- Test: `services/fc/test/document-library-access.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `isDocumentLibraryPrefix(prefix: string): boolean`
  - `documentPrefixesOverlap(a: string, b: string): boolean`
  - `CallerRoles = { ids: string[]; codes: string[] }`
  - `roleRuleDenies(caller: CallerRoles, grantedRoleIds: string[]): boolean`
  - `LibraryAudience = { kind: "open" } | { kind: "actors"; actorIds: string[] } | { kind: "roles"; roleCodes: string[] }`
  - `MemberAccess = { actorId: string; roleCodes: string[] }`
  - `membersLosingLibraryAccess(members: MemberAccess[], previously: LibraryAudience, nextRoleCodes: string[]): string[]`

- [ ] **Step 1: Write the failing test**

Create `services/fc/test/document-library-access.test.ts`:

```ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isDocumentLibraryPrefix,
  documentPrefixesOverlap,
  roleRuleDenies,
  membersLosingLibraryAccess,
} from "../src/lib/document-library-access.js";

describe("document library prefix", () => {
  test("only one documents segment is a library", () => {
    assert.equal(isDocumentLibraryPrefix("documents/财务/"), true);
    assert.equal(isDocumentLibraryPrefix("documents/hr/"), true);
    assert.equal(isDocumentLibraryPrefix("documents/"), false);
    assert.equal(isDocumentLibraryPrefix("documents/财务/工资/"), false);
    assert.equal(isDocumentLibraryPrefix("documents/报表.pdf"), false);
    assert.equal(isDocumentLibraryPrefix("knowledge/财务/"), false);
  });

  test("overlap is segment-prefix, so a sibling folder is not a child", () => {
    assert.equal(documentPrefixesOverlap("documents/财务/", "documents/财务/工资/"), true);
    assert.equal(documentPrefixesOverlap("documents/财务/工资/", "documents/财务/"), true);
    assert.equal(documentPrefixesOverlap("documents/财务/", "documents/财务公开/"), false);
    assert.equal(documentPrefixesOverlap("documents/财务/", "knowledge/财务/"), false);
  });
});

describe("roleRuleDenies", () => {
  test("owner is allowed even when the owner grant row is missing", () => {
    assert.equal(roleRuleDenies({ ids: ["role-owner"], codes: ["owner"] }, []), false);
  });

  test("finance is allowed only on a finance grant", () => {
    const finance = { ids: ["role-finance"], codes: ["finance"] };
    assert.equal(roleRuleDenies(finance, ["role-finance"]), false);
    assert.equal(roleRuleDenies(finance, ["role-hr"]), true);
  });

  test("admin is not an implicit grant", () => {
    assert.equal(roleRuleDenies({ ids: ["role-admin"], codes: ["admin"] }, ["role-finance"]), true);
  });

  test("a member with no roles is denied", () => {
    assert.equal(roleRuleDenies({ ids: [], codes: [] }, ["role-finance"]), true);
  });
});

describe("membersLosingLibraryAccess", () => {
  const members = [
    { actorId: "boss", roleCodes: ["owner"] },
    { actorId: "fin", roleCodes: ["finance"] },
    { actorId: "hr", roleCodes: ["hr"] },
    { actorId: "admin", roleCodes: ["admin"] },
  ];

  test("closing an open folder drops everyone who lacks the next roles", () => {
    const lost = membersLosingLibraryAccess(members, { kind: "open" }, ["owner", "finance"]);
    assert.deepEqual(lost.sort(), ["admin", "hr"]);
  });

  test("owner is not dropped when converting an actor list that forgot the boss", () => {
    const lost = membersLosingLibraryAccess(
      members,
      { kind: "actors", actorIds: ["fin"] },
      ["owner", "finance"],
    );
    assert.deepEqual(lost, []);
  });

  test("an actor-grant member without the role loses access on conversion", () => {
    const lost = membersLosingLibraryAccess(
      members,
      { kind: "actors", actorIds: ["admin", "fin"] },
      ["owner", "finance"],
    );
    assert.deepEqual(lost, ["admin"]);
  });

  test("widening roles drops nobody", () => {
    const lost = membersLosingLibraryAccess(
      members,
      { kind: "roles", roleCodes: ["owner", "finance"] },
      ["owner", "finance", "hr"],
    );
    assert.deepEqual(lost, []);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `services/fc`:

```bash
node --import tsx --test test/document-library-access.test.ts
```

Expected: FAIL, cannot find module `../src/lib/document-library-access.ts`.

- [ ] **Step 3: Write the helper**

Create `services/fc/src/lib/document-library-access.ts`:

```ts
/** Design: docs/specs/2026-10-14-document-library-role-access-design.md */

export type CallerRoles = { ids: string[]; codes: string[] };

export type LibraryAudience =
  | { kind: "open" }
  | { kind: "actors"; actorIds: string[] }
  | { kind: "roles"; roleCodes: string[] };

export type MemberAccess = { actorId: string; roleCodes: string[] };

const LIBRARY_PREFIX = /^documents\/[^/]+\/$/;

export function isDocumentLibraryPrefix(prefix: string): boolean {
  return LIBRARY_PREFIX.test(prefix);
}

/** Both arguments are stored prefixes and already end in `/`. */
export function documentPrefixesOverlap(a: string, b: string): boolean {
  if (!a.startsWith("documents/") || !b.startsWith("documents/")) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * True when this caller must not see a folder granted to `grantedRoleIds`.
 * `owner` passes even if that role id is absent from the grant rows.
 * `admin` does not pass unless it is one of the granted ids.
 */
export function roleRuleDenies(caller: CallerRoles, grantedRoleIds: string[]): boolean {
  if (caller.codes.includes("owner")) return false;
  const held = new Set(caller.ids);
  return !grantedRoleIds.some((id) => held.has(id));
}

function canSee(member: MemberAccess, audience: LibraryAudience): boolean {
  if (audience.kind === "open") return true;
  if (audience.kind === "actors") return audience.actorIds.includes(member.actorId);
  if (member.roleCodes.includes("owner")) return true;
  return member.roleCodes.some((code) => audience.roleCodes.includes(code));
}

/** Member actor ids who can see `previously` and cannot see the next role set. */
export function membersLosingLibraryAccess(
  members: MemberAccess[],
  previously: LibraryAudience,
  nextRoleCodes: string[],
): string[] {
  const next: LibraryAudience = { kind: "roles", roleCodes: nextRoleCodes };
  return members.filter((member) => canSee(member, previously) && !canSee(member, next)).map((member) => member.actorId);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --import tsx --test test/document-library-access.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/document-library-access.ts services/fc/test/document-library-access.test.ts
git commit -m "feat: decide document-library role access without a database"
```

---

### Task 2: Role-grant table

**Files:**
- Create: `services/supabase/migrations/20261014000000_document_library_role_grants.sql`
- Create: `services/fc/src/db/migrations/0024_document_library_role_grants.sql`

**Interfaces:**
- Consumes: `amux.amuxc_path_acl`, `public.roles`, `amux.actors`
- Produces: `amux.amuxc_path_acl_role_grants (acl_id, role_id, granted_by, granted_at)` primary key `(acl_id, role_id)`

- [ ] **Step 1: Add the Supabase migration**

`services/supabase/migrations/20261014000000_document_library_role_grants.sql`:

```sql
-- Document library role grants.
-- Design: docs/specs/2026-10-14-document-library-role-access-design.md
--
-- A path-acl row is either granted to actors (amuxc_path_acl_grants) or to
-- org roles (this table). Sync reads both. Prefix names stay sensitive, so
-- this table matches its parent: RLS forced on, no policy, no grant to
-- authenticated. service_role is granted here, in the same migration —
-- BYPASSRLS without a table grant fails closed and stops every sync manifest.

CREATE TABLE amux.amuxc_path_acl_role_grants (
    acl_id uuid NOT NULL,
    role_id uuid NOT NULL,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT amuxc_path_acl_role_grants_pkey PRIMARY KEY (acl_id, role_id)
);

ALTER TABLE ONLY amux.amuxc_path_acl_role_grants
    ADD CONSTRAINT amuxc_path_acl_role_grants_acl_id_fkey
    FOREIGN KEY (acl_id) REFERENCES amux.amuxc_path_acl(id) ON DELETE CASCADE;

ALTER TABLE ONLY amux.amuxc_path_acl_role_grants
    ADD CONSTRAINT amuxc_path_acl_role_grants_role_id_fkey
    FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE RESTRICT;

ALTER TABLE ONLY amux.amuxc_path_acl_role_grants
    ADD CONSTRAINT amuxc_path_acl_role_grants_granted_by_fkey
    FOREIGN KEY (granted_by) REFERENCES amux.actors(id) ON DELETE RESTRICT;

CREATE INDEX idx_amuxc_path_acl_role_grants_role
    ON amux.amuxc_path_acl_role_grants USING btree (role_id);

ALTER TABLE amux.amuxc_path_acl_role_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY amux.amuxc_path_acl_role_grants FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE amux.amuxc_path_acl_role_grants IS
  'Org roles allowed to sync a document-library prefix. Owner is always stored. RLS with no policy: the role list names the folder.';

GRANT SELECT, INSERT, UPDATE, DELETE ON amux.amuxc_path_acl_role_grants TO service_role;
```

- [ ] **Step 2: Mirror it for the postgres backend**

`services/fc/src/db/migrations/0024_document_library_role_grants.sql` is the same `CREATE TABLE` / constraints / index, using the drizzle breakpoint between statements and the quoted identifiers already used in `services/fc/src/db/migrations/0022_knowledge_path_acl.sql`. Include the `GRANT` and the two `ALTER TABLE ... ROW LEVEL SECURITY` statements. Do not add a policy.

- [ ] **Step 3: Commit**

```bash
git add services/supabase/migrations/20261014000000_document_library_role_grants.sql services/fc/src/db/migrations/0024_document_library_role_grants.sql
git commit -m "feat: store document-library access as org role grants"
```

No test runner covers SQL. The next task's sync query is what proves the table name and columns.

---

### Task 3: Sync view reads role grants

**Files:**
- Modify: `services/fc/src/lib/sync-acl.ts` (`SyncAclDeps`, `loadView`)
- Modify: `services/fc/test/sync-acl.test.ts` (stub + new cases)

**Interfaces:**
- Consumes: `roleRuleDenies`, `CallerRoles` from `document-library-access.ts`
- Produces: `aclViewFor` denies a prefix when that rule has any `amuxc_path_acl_role_grants` row and `roleRuleDenies` is true. Actor-only rules stay on `amuxc_path_acl_grants`. `SyncAclDeps.activeRoleCodes?: (teamId: string, actorId: string) => Promise<CallerRoles>`. Exported `loadCallerRoles(supabase, teamId, actorId): Promise<CallerRoles>`.

- [ ] **Step 1: Extend the stub and write failing tests**

In `fakeSupabase`, add `roleGrants = [] as { acl_id: string; role_id: string }[]` and `roleGrantsError`. On `select()`, return an object whose `eq` stays the current Promise (rules and actor grants), and whose `in` records `{ table, columns, op: "in", column, value }` and resolves `amuxc_path_acl_role_grants` to `roleGrants`.

Add tests inside `describe("sync-acl view")`:

```ts
test("a role grant allows finance and still denies hr", async () => {
  const supabase = fakeSupabase({
    rules: [{ id: "acl-fin", path_prefix: "documents/财务/" }],
    grants: [],
    roleGrants: [{ acl_id: "acl-fin", role_id: "role-finance" }],
  });
  const roles = async () => ({ ids: ["role-finance"], codes: ["finance"] });
  const view = await aclViewFor(TEAM, ALICE, { supabase, activeRoleCodes: roles });
  assert.deepEqual(view.denied, []);
  assert.deepEqual(view.allPrefixes, ["documents/财务/"]);

  const hr = await aclViewFor(TEAM, "actor-hr", {
    supabase,
    activeRoleCodes: async () => ({ ids: ["role-hr"], codes: ["hr"] }),
  });
  assert.deepEqual(hr.denied, ["documents/财务/"]);
});

test("owner sees a role library even when activeRoleCodes returns no grant id", async () => {
  const supabase = fakeSupabase({
    rules: [{ id: "acl-fin", path_prefix: "documents/财务/" }],
    roleGrants: [{ acl_id: "acl-fin", role_id: "role-finance" }],
  });
  const view = await aclViewFor(TEAM, ALICE, {
    supabase,
    activeRoleCodes: async () => ({ ids: ["role-owner"], codes: ["owner"] }),
  });
  assert.deepEqual(view.denied, []);
});

test("admin is denied a finance library", async () => {
  const supabase = fakeSupabase({
    rules: [{ id: "acl-fin", path_prefix: "documents/财务/" }],
    roleGrants: [{ acl_id: "acl-fin", role_id: "role-finance" }],
  });
  const view = await aclViewFor(TEAM, ALICE, {
    supabase,
    activeRoleCodes: async () => ({ ids: ["role-admin"], codes: ["admin"] }),
  });
  assert.deepEqual(view.denied, ["documents/财务/"]);
});

test("an actor grant still lifts its own rule and does not ask for roles", async () => {
  let roleCalls = 0;
  const supabase = fakeSupabase({
    rules: [{ id: "acl-1", path_prefix: "knowledge/hr/" }],
    grants: [{ acl_id: "acl-1" }],
  });
  const view = await aclViewFor(TEAM, ALICE, {
    supabase,
    activeRoleCodes: async () => {
      roleCalls += 1;
      return { ids: [], codes: [] };
    },
  });
  assert.deepEqual(view.denied, []);
  assert.equal(roleCalls, 0);
});

test("a role-code lookup failure is not cached and not turned into an empty deny list", async () => {
  const supabase = fakeSupabase({
    rules: [{ id: "acl-fin", path_prefix: "documents/财务/" }],
    roleGrants: [{ acl_id: "acl-fin", role_id: "role-finance" }],
  });
  await assert.rejects(
    () => aclViewFor(TEAM, ALICE, {
      supabase,
      activeRoleCodes: async () => {
        throw new Error("roles down");
      },
    }),
    /roles down/,
  );
  const later = await aclViewFor(TEAM, ALICE, {
    supabase,
    activeRoleCodes: async () => ({ ids: ["role-finance"], codes: ["finance"] }),
  });
  assert.deepEqual(later.denied, []);
});

test("a file in the documents root stays visible when a sibling library is denied", async () => {
  const supabase = fakeSupabase({
    rules: [{ id: "acl-fin", path_prefix: "documents/财务/" }],
    roleGrants: [{ acl_id: "acl-fin", role_id: "role-finance" }],
  });
  const view = await aclViewFor(TEAM, ALICE, {
    supabase,
    activeRoleCodes: async () => ({ ids: [], codes: ["member"] }),
  });
  assert.equal(isDenied("documents/报表.pdf", view), false);
  assert.equal(isDenied("documents/财务/工资.xlsx", view), true);
});
```

Keep the existing unrestricted-team test asserting exactly one query. It must stay green: no role-grant query when `rules` is empty.

Add one test that calls `loadCallerRoles` (import it next to `aclViewFor`) with a fake client, so the production lookup is not only described:

```ts
test("loadCallerRoles returns active role ids and fails closed on a role error", async () => {
  const supabase = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => {
                      if (table === "actors") return { data: { user_id: "user-1" }, error: null };
                      if (table === "teams") return { data: { oid: "org-1" }, error: null };
                      throw new Error(table);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    schema() {
      return {
        from(table: string) {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        eq() {
                          return {
                            is: async () => {
                              if (table === "roles_users") return { data: [{ role_id: "role-finance" }], error: null };
                              throw new Error(table);
                            },
                          };
                        },
                        in() {
                          return {
                            eq() {
                              return {
                                eq: async () => ({ data: [{ id: "role-finance", code: "finance" }], error: null }),
                              };
                            },
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  const roles = await loadCallerRoles(supabase, TEAM, ALICE);
  assert.deepEqual(roles, { ids: ["role-finance"], codes: ["finance"] });
});
```

`loadCallerRoles` must use this call shape: `actors` and `teams` via `from().select().eq().eq().maybeSingle()`, `roles_users` via `schema("public").from().select().eq().eq().eq().is("store_id", null)`, `roles` via `schema("public").from().select().in().eq().eq()`. A null `user_id` returns `{ ids: [], codes: [] }` without calling `schema`. An error from `roles` throws. Adjust the fake's chain if the implementation nests `eq` in a different order, but keep those filters.

- [ ] **Step 2: Run the new tests to verify they fail**

```bash
node --import tsx --test test/sync-acl.test.ts
```

Expected: FAIL. The stub's `select().in` is missing, or `activeRoleCodes` is ignored and finance is denied for lack of an actor grant.

- [ ] **Step 3: Teach `loadView`**

Add to `SyncAclDeps`:

```ts
activeRoleCodes?: (teamId: string, actorId: string) => Promise<CallerRoles>;
```

Import `CallerRoles` and `roleRuleDenies`.

Export `loadCallerRoles`. It uses the service-role client (schema `amux` by default, `public` via `.schema("public")`, same fallback as `publicFrom` in `services/fc/src/lib/supabase-repo/org-roles.ts`):

1. `actors` select `user_id` where `id = actorId` and `team_id = teamId`. No row or null `user_id` returns `{ ids: [], codes: [] }`.
2. `teams` select `oid` where `id = teamId`. Missing oid throws.
3. `public.roles_users` select `role_id` where `org_id`, `user_id`, `status = active`, `store_id` is null.
4. If that set is empty, return `{ ids: [], codes: [] }`.
5. `public.roles` select `id, code` where `id` in those ids, `status = active`, `org_id` matches. Any error throws. Return the active ids and codes.

In `loadView`, after the existing actor-grant read, `select('acl_id, role_id').in('acl_id', ruleIds)` from `amuxc_path_acl_role_grants`. Error throws. Group role ids by `acl_id`. If any rule has at least one role id, `const caller = await (deps.activeRoleCodes ?? ((teamId, actorId) => loadCallerRoles(supabase, teamId, actorId)))(teamId, actorId)`. If no rule has role ids, do not call it.

Denied prefix:

```ts
const grantedRoleIds = rolesByAcl.get(rule.id) ?? [];
if (grantedRoleIds.length > 0) {
  if (roleRuleDenies(caller, grantedRoleIds)) denied.push(rule.path_prefix);
} else if (!granted.has(rule.id)) {
  denied.push(rule.path_prefix);
}
```

`caller` is `{ ids: [], codes: [] }` when no role rule exists, and is only read inside the role branch.

Do not cache a thrown load. `aclViewFor` already caches only after `loadView` resolves. Leave that as it is.

- [ ] **Step 4: Run the sync-acl tests**

```bash
node --import tsx --test test/sync-acl.test.ts test/document-library-access.test.ts
```

Expected: PASS, including the original "unrestricted team never asks about grants" test (still one call).

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/sync-acl.ts services/fc/test/sync-acl.test.ts
git commit -m "feat: deny document libraries by org role during sync"
```

---

### Task 4: Register the management routes

**Files:**
- Create: `services/fc/src/lib/routes/document-libraries.ts`
- Modify: `services/fc/src/lib/routes/index.ts` (call `registerDocumentLibraries` immediately after `registerKnowledgeAcl`)
- Modify: `services/fc/test/knowledge-acl-routes.test.ts` (add the five paths to the same loop, or a sibling describe)
- Modify: `docs/openapi/teamclu-api.v1.yaml`

**Interfaces:**
- Consumes: `ctx.repository.listDocumentLibraries`, `previewDocumentLibrary`, `createDocumentLibrary`, `putDocumentLibrary`, `deleteDocumentLibrary`
- Produces: those five route paths. Handlers do not check admin themselves; the repository does, matching `knowledge-acl.ts`.

- [ ] **Step 1: Write the failing route test**

Add to the routes table in `services/fc/test/knowledge-acl-routes.test.ts`:

```ts
["GET", `/v1/teams/${TEAM}/document-libraries`],
["POST", `/v1/teams/${TEAM}/document-libraries/preview`],
["POST", `/v1/teams/${TEAM}/document-libraries`],
["PUT", `/v1/teams/${TEAM}/document-libraries/${ACL}`],
["DELETE", `/v1/teams/${TEAM}/document-libraries/${ACL}`],
```

The existing stub repository returns `{ items: [] }` for every method, and the assertion is "body is not the unknown-route 404". Preview is registered before `/:aclId` is not required on this router because preview is a separate path, but register preview before any `/:aclId` anyway.

- [ ] **Step 2: Run it**

```bash
node --import tsx --test test/knowledge-acl-routes.test.ts
```

Expected: FAIL, unknown route for `/document-libraries`.

- [ ] **Step 3: Register routes and OpenAPI**

`services/fc/src/lib/routes/document-libraries.ts`:

```ts
/** Design: docs/specs/2026-10-14-document-library-role-access-design.md */
export function registerDocumentLibraries(router) {
  router.get("/v1/teams/:teamId/document-libraries", async (ctx) => {
    return { body: await ctx.repository.listDocumentLibraries(ctx.params.teamId) };
  });
  router.post("/v1/teams/:teamId/document-libraries/preview", async (ctx) => {
    return { body: await ctx.repository.previewDocumentLibrary(ctx.params.teamId, ctx.json ?? {}) };
  });
  router.post("/v1/teams/:teamId/document-libraries", async (ctx) => {
    const rule = await ctx.repository.createDocumentLibrary(ctx.params.teamId, ctx.json ?? {});
    return { statusCode: 201, body: rule };
  });
  router.put("/v1/teams/:teamId/document-libraries/:aclId", async (ctx) => {
    const rule = await ctx.repository.putDocumentLibrary(
      ctx.params.teamId,
      ctx.params.aclId,
      ctx.json ?? {},
    );
    return { body: rule };
  });
  router.delete("/v1/teams/:teamId/document-libraries/:aclId", async (ctx) => {
    await ctx.repository.deleteDocumentLibrary(ctx.params.teamId, ctx.params.aclId);
    return { statusCode: 204, body: null };
  });
}
```

Call it from `registerAllRoutes` directly after `registerKnowledgeAcl(router)`, with the same comment: this owns `/v1/teams/:teamId/document-libraries*` and must precede `registerWorkspaces`.

In `docs/openapi/teamclu-api.v1.yaml`, next to the knowledge-acl paths, add the five operations. Schemas:

```yaml
DocumentLibraryRole:
  type: object
  required: [id, code, name, status]
  properties:
    id: { type: string, format: uuid }
    code: { type: string }
    name: { type: string }
    status: { type: string, enum: [active, inactive] }
DocumentLibrary:
  type: object
  required: [id, pathPrefix, audience]
  properties:
    id: { type: string, format: uuid }
    pathPrefix: { type: string, example: "documents/财务/" }
    audience: { type: string, enum: [roles, actors] }
    roles:
      type: array
      items: { $ref: "#/components/schemas/DocumentLibraryRole" }
    actorIds:
      type: array
      items: { type: string, format: uuid }
    affectedFiles: { type: integer }
    affectedMembers: { type: integer }
DocumentLibraryWrite:
  type: object
  required: [roleIds]
  properties:
    pathPrefix: { type: string }
    roleIds:
      type: array
      items: { type: string, format: uuid }
    confirmRevokeExisting: { type: boolean, default: false }
```

`POST` create requires `pathPrefix` and `roleIds`. `PUT` requires `roleIds` only. Preview body is `{ pathPrefix, roleIds }` and returns `{ pathPrefix, affectedFiles, affectedMembers }`. List returns `{ items: DocumentLibrary[] }`. Responses: 400, 403, 409, 500 as in the spec's error table. Owner/admin is described on each operation, not as a separate security scheme.

- [ ] **Step 4: Run the route test**

```bash
node --import tsx --test test/knowledge-acl-routes.test.ts
```

Expected: PASS. The repository methods can still be missing: the test stub answers every property. Do not add the real repository in this task.

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/routes/document-libraries.ts services/fc/src/lib/routes/index.ts services/fc/test/knowledge-acl-routes.test.ts docs/openapi/teamclu-api.v1.yaml
git commit -m "feat: add document-library role routes"
```

---

### Task 5: Repository writes

**Files:**
- Create: `services/fc/src/lib/supabase-repo/document-libraries.ts`
- Modify: `services/fc/src/lib/supabase-repo/knowledge-acl.ts` (export `resurfaceAclPrefix`)
- Modify: `services/fc/src/lib/supabase-repo.ts` (spread `makeDocumentLibrariesRepo` next to `makeKnowledgeAclRepo`, same host)
- Test: `services/fc/test/document-libraries-repo.test.ts`

**Interfaces:**
- Consumes: `isDocumentLibraryPrefix`, `documentPrefixesOverlap`, `membersLosingLibraryAccess`, `invalidateTeamAcl`, `resurfaceAclPrefix`, `requireTeamAdmin` behavior from knowledge-acl (duplicate the small admin check in this file; do not export the closure)
- Produces:
  - `listDocumentLibraries(teamId) => { items: DocumentLibrary[] }`
  - `previewDocumentLibrary(teamId, body) => { pathPrefix, affectedFiles, affectedMembers }`
  - `createDocumentLibrary(teamId, body) => DocumentLibrary & counts` status is set by the route
  - `putDocumentLibrary(teamId, aclId, body)`
  - `deleteDocumentLibrary(teamId, aclId)`
  - `resurfaceAclPrefix(admin, teamId, pathPrefix): Promise<void>` — the existing bump of `team_workspace_config.oss_change_seq` then `amuxc_files.change_seq`, moved out of the closure without behavior change

`DocumentLibrary` fields: `id`, `pathPrefix`, `audience: "roles" | "actors"`, `roles` (role rows; empty when audience is actors), `actorIds` (empty when audience is roles).

- [ ] **Step 1: Write the failing repository test**

Export the decision helpers from `services/fc/src/lib/supabase-repo/document-libraries.ts` and import them in the test as `../src/lib/supabase-repo/document-libraries.js`. The helpers take plain data, so the test does not build a Supabase client:

```ts
export function prepareRoleIds(
  orgRoles: Array<{ id: string; code: string; status: string; isSystem: boolean }>,
  requestedIds: string[],
): { roleIds: string[] } {
  // throws ApiError 500 if no active system owner
  // throws ApiError 400 if a requested id is missing or not active
  // returns unique ids with owner first
}
```

Tests:

```ts
test("owner is stored even when the client omits it", () => {
  const out = prepareRoleIds(
    [
      { id: "owner", code: "owner", status: "active", isSystem: true },
      { id: "fin", code: "finance", status: "active", isSystem: true },
    ],
    ["fin"],
  );
  assert.deepEqual(out.roleIds, ["owner", "fin"]);
});

test("an empty roleIds list is owner-only", () => {
  const out = prepareRoleIds(
    [{ id: "owner", code: "owner", status: "active", isSystem: true }],
    [],
  );
  assert.deepEqual(out.roleIds, ["owner"]);
});

test("inactive and foreign ids are rejected", () => {
  const roles = [
    { id: "owner", code: "owner", status: "active", isSystem: true },
    { id: "old", code: "hr", status: "inactive", isSystem: false },
  ];
  assert.throws(() => prepareRoleIds(roles, ["old"]), (err: any) => err.statusCode === 400);
  assert.throws(() => prepareRoleIds(roles, ["other-org"]), (err: any) => err.statusCode === 400);
});

test("missing owner role refuses to create a library", () => {
  assert.throws(() => prepareRoleIds([], []), (err: any) => err.statusCode === 500);
});

test("a child documents prefix overlaps; a sibling does not", () => {
  assert.throws(
    () => assertNoDocumentOverlap(
      [{ id: "old", pathPrefix: "documents/财务/工资/" }],
      "documents/财务/",
      null,
    ),
    (err: any) => err.statusCode === 409,
  );
  assert.doesNotThrow(() => assertNoDocumentOverlap(
    [{ id: "sib", pathPrefix: "documents/财务公开/" }],
    "documents/财务/",
    null,
  ));
});

test("confirm is required only when files exist and someone loses access", () => {
  assert.equal(needsRevokeConfirm({ affectedFiles: 2, affectedMembers: 1, confirm: false }), true);
  assert.equal(needsRevokeConfirm({ affectedFiles: 2, affectedMembers: 0, confirm: false }), false);
  assert.equal(needsRevokeConfirm({ affectedFiles: 0, affectedMembers: 3, confirm: false }), false);
  assert.equal(needsRevokeConfirm({ affectedFiles: 2, affectedMembers: 1, confirm: true }), false);
});
```

`needsRevokeConfirm` returns boolean. The repository throws 409 `confirmation_required` when it is true, with `details: { affectedFiles, affectedMembers }`.

- [ ] **Step 2: Run the test**

```bash
node --import tsx --test test/document-libraries-repo.test.ts
```

Expected: FAIL, module missing.

- [ ] **Step 3: Implement the repository**

`prepareRoleIds`, `assertNoDocumentOverlap`, and `needsRevokeConfirm` match the tests. `assertNoDocumentOverlap` skips the row whose id is `selfId`, ignores prefixes that do not start with `documents/`, and throws `ApiError(409, "conflict", ...)` on overlap.

`makeDocumentLibrariesRepo(host)` uses the same host type as `makeKnowledgeAclRepo`. `requireTeamAdmin` is copied from `knowledge-acl.ts` (caller actor, then `current_team_role` in `owner` | `admin`).

`listDocumentLibraries`: admin check, load `amuxc_path_acl` rows for the team whose `path_prefix` passes `isDocumentLibraryPrefix`, load actor grants and role grants for those ids, load `public.roles` for the role ids (id, code, name, status). A row with any role grant has `audience: "roles"` and `actorIds: []`. A row with only actor grants has `audience: "actors"` and `roles: []`.

`previewDocumentLibrary` / `createDocumentLibrary` / `putDocumentLibrary` share `resolveWrite`:

1. Admin check. Create also checks `isDocumentLibraryPrefix`; otherwise 400.
2. Load org id from `teams.oid`. Load active and inactive roles for that org (`public.roles`). `prepareRoleIds`.
3. Load member actors (`actor_type = member`) with `user_id`. Load their active role codes the same way as `loadCallerRoles`, but for each user. Skip actors with null `user_id`.
4. Existing rule on that exact prefix (create) or by `aclId` (put). Previously: no row → `{ kind: "open" }`; role grants → `{ kind: "roles", roleCodes }`; else `{ kind: "actors", actorIds }`. Put on a missing id is 404. Put on a prefix that is not a library prefix is 400.
5. `affectedMembers` is `membersLosingLibraryAccess(...).length` using the codes from `prepareRoleIds` (map ids back to codes, always including `owner`). `affectedFiles` is the live `amuxc_files` count under the prefix (`deleted = false`), same query as `impactOf`.
6. If `needsRevokeConfirm`, throw 409 with those counts and do not write.
7. Create inserts `amuxc_path_acl` (`created_by` = caller). If the exact prefix already exists, reuse that row (this is the actor-to-role conversion) and do not insert a second row. Then delete `amuxc_path_acl_grants` for that acl id, replace `amuxc_path_acl_role_grants` with the prepared ids (`granted_by` = caller).
8. Put replaces role grants the same way and clears actor grants.
9. If `affectedMembers === 0` (nobody lost access) call `resurfaceAclPrefix`. Create of a brand-new restriction where someone lost access does not need resurface for the people who kept access if they already have the files; still call `resurfaceAclPrefix` when the write adds a role that previous audience did not have, including conversion that newly includes owner. Simplest rule that matches the spec: call `resurfaceAclPrefix` on every successful create and put. A seq bump is a no-op for clients that already hold the same version.
10. `invalidateTeamAcl(teamId)`.
11. Enforce `MAX_ACL_RULES_PER_TEAM` only when inserting a new `amuxc_path_acl` row, using the same 422 as `createKnowledgeAcl`.

`deleteDocumentLibrary`: admin, load the row, 404 if missing, 400 if the prefix is not a library prefix. Delete the `amuxc_path_acl` row (role grants cascade). `resurfaceAclPrefix`. `invalidateTeamAcl`.

Move `resurfacePrefix` from inside `makeKnowledgeAclRepo` to exported `resurfaceAclPrefix` and call it from the old create/update/delete paths so their behavior stays.

Wire in `supabase-repo.ts`:

```ts
...makeDocumentLibrariesRepo({
  supabase,
  serviceRoleClient,
  resolveCallerActorForTeam: /* same function already passed to makeKnowledgeAclRepo */,
}),
```

- [ ] **Step 4: Run the repository test and the knowledge ACL tests**

```bash
node --import tsx --test test/document-libraries-repo.test.ts test/sync-acl.test.ts
```

Expected: PASS. There is no existing knowledge-acl repository unit test; the route test does not execute the repo.

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/supabase-repo/document-libraries.ts services/fc/src/lib/supabase-repo/knowledge-acl.ts services/fc/src/lib/supabase-repo.ts services/fc/test/document-libraries-repo.test.ts
git commit -m "feat: save document libraries as role grants"
```

---

### Task 6: Keep the old ACL API from creating document rules

**Files:**
- Modify: `services/fc/src/lib/supabase-repo/knowledge-acl.ts` (`createKnowledgeAcl`, `updateKnowledgeAcl`)
- Test: `services/fc/test/document-libraries-repo.test.ts` (add cases against the exported guards)

**Interfaces:**
- Consumes: `isDocumentLibraryPrefix` is not used to block nested paths. Any `pathPrefix` that starts with `documents/` is rejected on create.
- Produces: `assertLegacyDocumentCreate(pathPrefix: string): void` and `assertLegacyDocumentUpdate(roleGrantCount: number): void`

- [ ] **Step 1: Write the failing test**

Import the guards from `../src/lib/supabase-repo/knowledge-acl.js` in `services/fc/test/document-libraries-repo.test.ts`:

```ts
test("legacy create refuses every documents prefix", () => {
  assert.throws(() => assertLegacyDocumentCreate("documents/财务/"), (err: any) => err.statusCode === 400);
  assert.throws(() => assertLegacyDocumentCreate("documents/财务/工资/"), (err: any) => err.statusCode === 400);
  assert.doesNotThrow(() => assertLegacyDocumentCreate("knowledge/hr/"));
});

test("legacy update refuses a rule that already has role grants", () => {
  assert.throws(() => assertLegacyDocumentUpdate(1), (err: any) => err.statusCode === 409);
  assert.doesNotThrow(() => assertLegacyDocumentUpdate(0));
});
```

- [ ] **Step 2: Run it**

```bash
node --import tsx --test test/document-libraries-repo.test.ts
```

Expected: FAIL, functions not exported.

- [ ] **Step 3: Call the guards**

`assertLegacyDocumentCreate` throws `ApiError(400, "validation_failed", "document folders are restricted via /v1/teams/{teamId}/document-libraries")` when `pathPrefix.startsWith("documents/")`.

`assertLegacyDocumentUpdate` throws `ApiError(409, "conflict", "this folder is granted by role")` when `roleGrantCount > 0`.

`createKnowledgeAcl` calls the create guard immediately after `assertPrefix`. `updateKnowledgeAcl` counts `amuxc_path_acl_role_grants` for that `aclId` and calls the update guard before adding or removing actor ids.

`listKnowledgeAcl` stays a list of every rule for the team. Do not filter out `documents/` rows. `mapRule` may add `audience: roleGrantCount > 0 ? "roles" : "actors"` but must still return `pathPrefix` and `actorIds`. The wiki client only reads `pathPrefix`.

- [ ] **Step 4: Re-run**

```bash
node --import tsx --test test/document-libraries-repo.test.ts test/knowledge-acl-routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/supabase-repo/knowledge-acl.ts services/fc/test/document-libraries-repo.test.ts
git commit -m "fix: stop the legacy ACL API from creating document rules"
```

---

### Task 7: Role assignment and role delete

**Files:**
- Modify: `services/fc/src/lib/supabase-repo/org-roles.ts`
- Modify: `services/fc/src/lib/supabase-repo.ts` (pass `serviceRoleClient` into `makeOrgRolesRepo`)
- Test: `services/fc/test/document-library-access.test.ts` (prefixes to resurface)

**Interfaces:**
- Consumes: `invalidateTeamAcl`, `resurfaceAclPrefix`
- Produces: `libraryPrefixesToResurface(input: { libraries: Array<{ pathPrefix: string; roleIds: string[] }>; addedRoleIds: string[]; addedOwner: boolean; ownerRoleId: string | null }): string[]`

- [ ] **Step 1: Write the failing test**

```ts
test("adding finance resurfaces only libraries that grant finance", () => {
  const prefixes = libraryPrefixesToResurface({
    libraries: [
      { pathPrefix: "documents/财务/", roleIds: ["role-finance", "role-owner"] },
      { pathPrefix: "documents/人事/", roleIds: ["role-hr", "role-owner"] },
    ],
    addedRoleIds: ["role-finance"],
    addedOwner: false,
    ownerRoleId: "role-owner",
  });
  assert.deepEqual(prefixes, ["documents/财务/"]);
});

test("adding owner resurfaces every role library", () => {
  const prefixes = libraryPrefixesToResurface({
    libraries: [
      { pathPrefix: "documents/财务/", roleIds: ["role-finance"] },
      { pathPrefix: "documents/人事/", roleIds: ["role-hr"] },
    ],
    addedRoleIds: ["role-owner"],
    addedOwner: true,
    ownerRoleId: "role-owner",
  });
  assert.deepEqual(prefixes, ["documents/财务/", "documents/人事/"]);
});

test("removing a role resurfaces nothing", () => {
  assert.deepEqual(libraryPrefixesToResurface({
    libraries: [{ pathPrefix: "documents/财务/", roleIds: ["role-finance"] }],
    addedRoleIds: [],
    addedOwner: false,
    ownerRoleId: "role-owner",
  }), []);
});
```

- [ ] **Step 2: Run it**

```bash
node --import tsx --test test/document-library-access.test.ts
```

Expected: FAIL, `libraryPrefixesToResurface` is not exported.

- [ ] **Step 3: Implement the side effects**

Add `libraryPrefixesToResurface` to `document-library-access.ts`. A library is included when `addedOwner` is true, or when its `roleIds` intersect `addedRoleIds`.

Extend `OrgRolesHost` with `serviceRoleClient: (what: string) => Promise<any>`.

At the end of a successful `putMemberRoles`, after `dualWriteTeamMembersRole`:

1. `const admin = await host.serviceRoleClient("refresh document libraries after role change")`.
2. Load team ids: `teams` select `id` where `oid = orgId`.
3. `invalidateTeamAcl` for each id.
4. Load `amuxc_path_acl` id and `path_prefix` for those teams where `path_prefix` like `documents/%`, then their role grants. Ignore rows with no role grants.
5. `addedOwner` is the existing `grantingOwner` boolean. `addedRoleIds` is `toAdd`.
6. For each prefix from `libraryPrefixesToResurface`, `resurfaceAclPrefix(admin, teamId, prefix)`. Match the prefix back to its team id; do not resurface a prefix onto a different team.

`deleteOrgRole`: keep the current `roles_users` binding check. Then delete. If the PostgREST error `code === "23503"`, throw `ApiError(409, "conflict", "role is still used by a document library")`. The new foreign key is what produces 23503. Do not delete role-grant rows to make the role delete succeed.

Pass `serviceRoleClient` at the `makeOrgRolesRepo({...})` call site in `supabase-repo.ts`.

- [ ] **Step 4: Run the tests**

`makeStubHost` in `services/fc/test/org-roles.test.ts` must grow `serviceRoleClient`. Return a client whose `from("teams")` and `from("amuxc_path_acl")` resolve `{ data: [], error: null }` through the same chain the stub already uses (`select().eq()`). Existing `putMemberRoles` tests then invalidate nothing and resurface nothing.

```bash
node --import tsx --test test/document-library-access.test.ts test/org-roles.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/document-library-access.ts services/fc/src/lib/supabase-repo/org-roles.ts services/fc/src/lib/supabase-repo.ts services/fc/test/document-library-access.test.ts services/fc/test/org-roles.test.ts
git commit -m "feat: refresh document libraries when org roles change"
```

---

### Task 8: Desktop Cloud API client

**Files:**
- Create: `packages/app/src/lib/backend/cloud-api/document-libraries.ts`
- Modify: `packages/app/src/lib/backend/cloud-api/index.ts`
- Modify: `packages/app/src/lib/backend/types.ts`
- Test: `packages/app/src/lib/backend/cloud-api/__tests__/document-libraries.test.ts`

**Interfaces:**
- Consumes: `CloudApiClient` (`get` / `post` / `put` / `delete`)
- Produces: `DocumentLibrariesBackend` on `TeamCluBackend.documentLibraries`

```ts
export interface DocumentLibraryRole {
  id: string;
  code: string;
  name: string;
  status: "active" | "inactive";
}
export interface DocumentLibrary {
  id: string;
  pathPrefix: string;
  audience: "roles" | "actors";
  roles: DocumentLibraryRole[];
  actorIds: string[];
  affectedFiles?: number;
  affectedMembers?: number;
}
export interface DocumentLibrariesBackend {
  listDocumentLibraries(teamId: string): Promise<DocumentLibrary[]>;
  previewDocumentLibrary(teamId: string, input: { pathPrefix: string; roleIds: string[] }): Promise<{ pathPrefix: string; affectedFiles: number; affectedMembers: number }>;
  createDocumentLibrary(teamId: string, input: { pathPrefix: string; roleIds: string[]; confirmRevokeExisting?: boolean }): Promise<DocumentLibrary>;
  putDocumentLibrary(teamId: string, aclId: string, input: { roleIds: string[]; confirmRevokeExisting?: boolean }): Promise<DocumentLibrary>;
  deleteDocumentLibrary(teamId: string, aclId: string): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test**

Follow `packages/app/src/lib/backend/cloud-api/knowledge-acl.ts` only if a client test already exists; it does not. New test mocks `{ get, post, put, delete }` and asserts paths:

```ts
await api.listDocumentLibraries("team-1");
expect(get).toHaveBeenCalledWith("/v1/teams/team-1/document-libraries");

await api.previewDocumentLibrary("team-1", { pathPrefix: "documents/财务/", roleIds: ["fin"] });
expect(post).toHaveBeenCalledWith("/v1/teams/team-1/document-libraries/preview", {
  pathPrefix: "documents/财务/",
  roleIds: ["fin"],
});

await api.createDocumentLibrary("team-1", { pathPrefix: "documents/财务/", roleIds: ["fin"], confirmRevokeExisting: true });
await api.putDocumentLibrary("team-1", "acl-1", { roleIds: ["fin"] });
await api.deleteDocumentLibrary("team-1", "acl-1");
```

`list` reads `items` and returns `[]` when `items` is missing. `delete` sends no body.

- [ ] **Step 2: Run it**

```bash
pnpm --filter @teamclu/app exec vitest run src/lib/backend/cloud-api/__tests__/document-libraries.test.ts
```

Expected: FAIL, module missing.

- [ ] **Step 3: Implement and register**

`createDocumentLibrariesModule(client)` as above. Add `documentLibraries: createDocumentLibrariesModule(client)` in `createCloudApiBackend`. Add the field to `TeamCluBackend` in `types.ts`. Any test double that builds a full `TeamCluBackend` and now fails typecheck gets `documentLibraries` with `vi.fn()` methods. Search for `knowledgeAcl:` object literals in `packages/app` and add the sibling only where TypeScript requires a full backend, not where the test passes a partial `getBackend()` mock.

- [ ] **Step 4: Run the client test**

```bash
pnpm --filter @teamclu/app exec vitest run src/lib/backend/cloud-api/__tests__/document-libraries.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/backend/cloud-api/document-libraries.ts packages/app/src/lib/backend/cloud-api/index.ts packages/app/src/lib/backend/types.ts packages/app/src/lib/backend/cloud-api/__tests__/document-libraries.test.ts
git commit -m "feat: call the document-library role API from the desktop client"
```

---

### Task 9: File-tree dialog

**Files:**
- Create: `packages/app/src/components/teamshare/DocumentLibraryDialog.tsx`
- Create: `packages/app/src/components/teamshare/__tests__/DocumentLibraryDialog.test.tsx`
- Modify: `packages/app/src/components/workspace/FileTree.tsx` (`onManagePermissions` and the mounted dialog)
- Modify: `packages/app/src/locales/zh-CN.json` and `packages/app/src/locales/en.json` under a new `documentLibrary` object

**Interfaces:**
- Consumes: `documentLibraries.*`, `orgRoles.listOrgRoles` (already on the backend)
- Produces: dialog title 「谁可以看」. Owner checkbox checked and disabled. `member` is not listed. Save sends `roleIds` without the owner id (the server adds it). Confirm button text is 「停止同步」.

- [ ] **Step 1: Write the failing dialog test**

Model the mock on `KnowledgeAclDialog.test.tsx` (`getBackend` returning `documentLibraries` and `orgRoles`). Cases:

1. Prefix `documents/财务/工资/` renders nothing and does not call `listDocumentLibraries`. The file tree should not open this prefix; the dialog also refuses it.
2. No rule: text says the whole team can sync. Saving with finance calls `previewDocumentLibrary` then, when `affectedMembers > 0` and `affectedFiles > 0`, shows 「停止同步」 and does not call `createDocumentLibrary` until that button is clicked with `confirmRevokeExisting: true`.
3. Owner row is checked and disabled. The `member` role from `listOrgRoles` is absent. `admin` and `finance` are present.
4. Existing `audience: "actors"` shows 「当前仍按成员授权」. Saving calls `createDocumentLibrary` for that same `pathPrefix`, not `putDocumentLibrary`.
5. Existing role rule save calls `putDocumentLibrary`.
6. Preview with `affectedMembers: 0` calls `createDocumentLibrary` immediately and does not show the confirm step.

Use `pathPrefix: "documents/财务/"`. Roles fixture: owner, admin, member, finance.

- [ ] **Step 2: Run it**

```bash
pnpm --filter @teamclu/app exec vitest run src/components/teamshare/__tests__/DocumentLibraryDialog.test.tsx
```

Expected: FAIL, component missing.

- [ ] **Step 3: Implement the dialog and point the tree at it**

`DocumentLibraryDialog` props: `{ prefix: string; open: boolean; onOpenChange: (open: boolean) => void }`. If `!/^documents\/[^/]+\/$/.test(prefix)` return null.

Load `listDocumentLibraries` and `listOrgRoles` when opened. The rule is the item whose `pathPrefix === prefix`.

Role rows: org roles with `status === "active"`, `code !== "owner"`, `code !== "member"`. Owner is a separate disabled checked row labeled with the owner role's `name`.

Copy, via `t()` with these defaults:

- title: `谁可以看`
- open: `这个文件夹目前团队成员都能同步。`
- actor leftover: `当前仍按成员授权。保存后会改成按角色，并替换原来的成员名单。`
- owner: `拥有者`
- confirm title: `停止同步`
- confirm body: `{{members}} 名成员将停止同步这个文件夹里的 {{files}} 个文件。已经拷走的文件收不回来。`
- save: `保存`
- remove: `改为团队可见`

Remove calls `deleteDocumentLibrary`. It is shown only when a rule exists.

`FileTree.tsx`: replace the `KnowledgeAclDialog` import and mount with `DocumentLibraryDialog`. Keep `onOpenChange` clearing `aclPrefix` and calling `refreshRestricted`. Change `onManagePermissions` so it is passed only when the sync key plus a trailing slash matches `^documents\/[^/]+\/$`. Nested `documents/` directories and the `documents` root no longer get the menu. `isPermissionRestricted` stays as it is, so a lock still appears on any prefix returned by `listKnowledgeAcl`, including a role library.

Add the `documentLibrary` strings to `zh-CN.json` and `en.json`. English defaults: title "Who can see this", confirm button "Stop syncing", caveat "Files already copied away cannot be taken back."

- [ ] **Step 4: Run the dialog test and the lock test**

```bash
pnpm --filter @teamclu/app exec vitest run src/components/teamshare/__tests__/DocumentLibraryDialog.test.tsx src/components/workspace/__tests__/FileTreeNode-lock.test.tsx
```

Expected: PASS. `KnowledgeAclDialog.test.tsx` still passes because that component remains for now; Task 10 stops the settings page from offering person grants on library prefixes. Do not delete `KnowledgeAclDialog.tsx` in this task — the settings page still uses the knowledge-acl client, not this dialog.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/teamshare/DocumentLibraryDialog.tsx packages/app/src/components/teamshare/__tests__/DocumentLibraryDialog.test.tsx packages/app/src/components/workspace/FileTree.tsx packages/app/src/locales/zh-CN.json packages/app/src/locales/en.json
git commit -m "feat: choose document-library viewers by role"
```

---

### Task 10: Settings list

**Files:**
- Modify: `packages/app/src/components/settings/KnowledgeAclSection.tsx`
- Modify: `packages/app/src/components/settings/Settings.tsx` only if the section needs a new nav id. Prefer rendering the library list at the top of the existing knowledge-acl section so there is no second nav entry.
- Test: `packages/app/src/components/settings/__tests__/KnowledgeAclSection.libraries.test.tsx`

**Interfaces:**
- Consumes: `listDocumentLibraries`, `deleteDocumentLibrary`, existing `listKnowledgeAcl`
- Produces: library rows above the knowledge rules. A `documents/<one>/` row is not given person checkboxes.

- [ ] **Step 1: Write the failing test**

Mock `getBackend()` with both clients. `listKnowledgeAcl` returns `knowledge/hr/` (actors `['alice']`) and `documents/财务/` (actors `[]`). `listDocumentLibraries` returns the finance folder with `audience: "roles"` and finance + owner.

Assert:

- The finance row shows the role name and no member checkbox.
- The knowledge row still shows the member toggle (`updateKnowledgeAcl` is the handler the existing section uses).
- A nested legacy rule `documents/财务/工资/` from `listKnowledgeAcl` is still listed, with delete, and its member toggle still calls `updateKnowledgeAcl`.
- The finance row's remove control calls `deleteDocumentLibrary`, not `deleteKnowledgeAcl`.

- [ ] **Step 2: Run it**

```bash
pnpm --filter @teamclu/app exec vitest run src/components/settings/__tests__/KnowledgeAclSection.libraries.test.tsx
```

Expected: FAIL. The section has no library list, and it will try to render `documents/财务/` as a person rule.

- [ ] **Step 3: Render the two lists**

In `KnowledgeAclSection.load`, also call `listDocumentLibraries`. Render those items first: path, role names, owner included, button that deletes via `deleteDocumentLibrary`. When `audience === "actors"`, the row text is 「当前仍按成员授权」 and there is no person checkbox; deleting uses `deleteDocumentLibrary` (Task 5 allows that for a top-level prefix).

Filter `listKnowledgeAcl` results before the existing person UI: drop any item whose `pathPrefix` matches `^documents\/[^/]+\/$`. Keep `knowledge/` items and nested `documents/` items on the existing person UI.

Header copy for the library block: 「资料库文件夹」. Keep the existing knowledge header for the remaining rules.

- [ ] **Step 4: Run the settings test**

```bash
pnpm --filter @teamclu/app exec vitest run src/components/settings/__tests__/KnowledgeAclSection.libraries.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings/KnowledgeAclSection.tsx packages/app/src/components/settings/__tests__/KnowledgeAclSection.libraries.test.tsx
git commit -m "feat: list role-gated document folders in settings"
```

---

## Spec coverage

| Spec | Task |
|------|------|
| D1 library prefix, root files stay team-visible | 1, 3, 9 |
| D2 role union, active roles only | 1, 3, 5 |
| D3 owner always stored and allowed; admin is not | 1, 3, 5, 9 |
| D4 no nested overlap; sibling folders ok | 1, 5 |
| D5 no member snapshot | 5 (writes role ids), 3 (reads live roles) |
| D6 停止同步 copy, confirm counts, plaintext promise unchanged | 5, 9 |
| Table, RLS, service_role grant | 2 |
| `loadView` fail closed, empty team stays one query | 3 |
| Role PUT invalidates cache and resurfaces gains only | 7 |
| Local delete stays `apply_revocations` | no code |
| Wiki preflight keeps seeing the prefix | 6 (`listKnowledgeAcl` unfiltered) |
| Old API cannot create documents rules; role rules reject actor edits | 6 |
| File tree and settings | 9, 10 |

Daemon, wiki maintainer, and knowledge-folder ACL behavior are intentionally absent from the tasks.

## Self-review

- Placeholder scan: no TBD, no "write tests for the above", no "similar to task N" left without the code it depends on.
- `prepareRoleIds`, `roleRuleDenies`, `membersLosingLibraryAccess`, `libraryPrefixesToResurface`, and `resurfaceAclPrefix` are named the same way in every task that uses them.
- `DocumentLibrary.audience` is `"roles" | "actors"` in the OpenAPI task, the repository task, and the client task.
