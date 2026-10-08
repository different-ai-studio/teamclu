import { test } from "node:test";
import assert from "node:assert/strict";
import { findTenantIdentity } from "../src/lib/apps-tenant-identity.js";

// Just the builder chains findTenantIdentity uses, over in-memory tables.
function fakeAdmin(tables: Record<string, any[]>) {
  const builder = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    let limit: number | null = null;
    const run = () => {
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return { data: limit === null ? rows : rows.slice(0, limit), error: null };
    };
    const api: any = {
      select: () => api,
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return api; },
      is: (c: string, v: any) => { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
      in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return api; },
      limit: (n: number) => { limit = n; return api; },
      then: (ok: any, ko: any) => Promise.resolve(run()).then(ok, ko),
    };
    return api;
  };
  return { schema: () => ({ from: builder }) };
}

const ORG = "org-co";

test("an account that already is an identity in the org stays as it is", async () => {
  const admin = fakeAdmin({
    users: [{ id: "u1", auth_user_id: "u1", org_id: ORG, mobile: "", admin_type: 2, deleted_at: null }],
    email_users_links: [],
  });
  const r = await findTenantIdentity(admin, { sub: "u1", email: "a@x.test" }, ORG);
  assert.deepEqual(r, { user: { sub: "u1", email: "a@x.test" }, inOrg: true });
});

test("an email user is carried over to their linked identity in the org", async () => {
  // Signed in with the real email (their own tenant's account); their identity
  // in Co sits on a synthetic <id>@teamclu.email account.
  const admin = fakeAdmin({
    users: [
      { id: "own", auth_user_id: "own", org_id: "org-own", mobile: "", admin_type: 3, deleted_at: null },
      { id: "co", auth_user_id: "co", org_id: ORG, mobile: "", admin_type: 2, deleted_at: null },
    ],
    email_users_links: [
      { email: "a@x.test", user_id: "own" },
      { email: "a@x.test", user_id: "co" },
    ],
  });
  const r = await findTenantIdentity(admin, { sub: "own", email: "A@x.test" }, ORG);
  assert.deepEqual(r, { user: { sub: "co", email: "A@x.test" }, inOrg: true });
});

test("a phone user is carried over through the shared mobile, staff first", async () => {
  // The SSO cookie came from another org's app. In Co the person holds a
  // member card and a staff identity; the staff one is who they are here.
  const admin = fakeAdmin({
    users: [
      { id: "gym", auth_user_id: "gym", org_id: "org-gym", mobile: "13800000001", admin_type: 2, deleted_at: null },
      { id: "card", auth_user_id: "card", org_id: ORG, mobile: "13800000001", admin_type: 1, deleted_at: null, created_at: "1" },
      { id: "staff", auth_user_id: "staff", org_id: ORG, mobile: "13800000001", admin_type: 2, deleted_at: null, created_at: "2" },
    ],
    email_users_links: [],
  });
  const r = await findTenantIdentity(admin, { sub: "gym", email: "gym@x.local" }, ORG);
  assert.equal(r.user.sub, "staff");
  assert.equal(r.inOrg, true);
});

test("nobody there: the account is kept and flagged as outside the org", async () => {
  const admin = fakeAdmin({
    users: [{ id: "own", auth_user_id: "own", org_id: "org-own", mobile: "13800000002", admin_type: 3, deleted_at: null }],
    email_users_links: [],
  });
  const r = await findTenantIdentity(admin, { sub: "own", email: "a@x.test" }, ORG);
  assert.deepEqual(r, { user: { sub: "own", email: "a@x.test" }, inOrg: false });
});

test("a row without an account of its own is never signed in as", async () => {
  const admin = fakeAdmin({
    users: [
      { id: "own", auth_user_id: "own", org_id: "org-own", mobile: "13800000003", admin_type: 3, deleted_at: null },
      { id: "unbound", auth_user_id: null, org_id: ORG, mobile: "13800000003", admin_type: 2, deleted_at: null },
    ],
    email_users_links: [],
  });
  const r = await findTenantIdentity(admin, { sub: "own", email: "a@x.test" }, ORG);
  assert.equal(r.inOrg, false);
});
