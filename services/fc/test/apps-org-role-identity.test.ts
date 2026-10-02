import assert from "node:assert/strict";
import test from "node:test";
import { findAppOrgRoleIdentities } from "../src/lib/apps-org-role-identity.js";

const AUTH_ID = "cf985f96-b2e7-4d98-8e58-36ddb7133474";
const ORG_ID = "7860249f-5359-44f0-8dff-94a99ca07409";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

function db(users: Array<{ id: string; auth_user_id: string; deleted_at: string | null }>,
  bindings: Array<{ user_id: string; org_id: string; status: string }>) {
  return {
    schema(name: string) {
      assert.equal(name, "public");
      return {
        from(table: string) {
          const filters: Record<string, unknown> = {};
          return {
            select() { return this; },
            eq(key: string, value: unknown) { filters[key] = value; return this; },
            is(key: string, value: unknown) { filters[key] = value; return this; },
            in(key: string, value: unknown[]) { filters[key] = value; return this; },
            then(resolve: (result: { data: unknown[]; error: null }) => unknown) {
              const rows = table === "users" ? users : bindings;
              return Promise.resolve(resolve({ data: rows.filter(row =>
                Object.entries(filters).every(([key, value]) =>
                  Array.isArray(value) ? value.includes((row as any)[key]) : (row as any)[key] === value)), error: null }));
            },
          };
        },
      };
    },
  };
}

test("an active app-org role on the creator's primary identity admits them without a tenant row", async () => {
  const admin = db(
    [{ id: AUTH_ID, auth_user_id: AUTH_ID, deleted_at: null }],
    [{ user_id: AUTH_ID, org_id: ORG_ID, status: "active" }],
  );
  assert.deepEqual(await findAppOrgRoleIdentities(admin, AUTH_ID, ORG_ID), [AUTH_ID]);
});

test("a role in another org or an inactive role cannot supply app-org identity", async () => {
  const users = [{ id: AUTH_ID, auth_user_id: AUTH_ID, deleted_at: null }];
  assert.deepEqual(await findAppOrgRoleIdentities(db(users, [
    { user_id: AUTH_ID, org_id: OTHER_ORG, status: "active" },
  ]), AUTH_ID, ORG_ID), []);
  assert.deepEqual(await findAppOrgRoleIdentities(db(users, [
    { user_id: AUTH_ID, org_id: ORG_ID, status: "inactive" },
  ]), AUTH_ID, ORG_ID), []);
});

test("a deleted identity cannot supply app-org access", async () => {
  const admin = db(
    [{ id: AUTH_ID, auth_user_id: AUTH_ID, deleted_at: "2026-10-01T00:00:00Z" }],
    [{ user_id: AUTH_ID, org_id: ORG_ID, status: "active" }],
  );
  assert.deepEqual(await findAppOrgRoleIdentities(admin, AUTH_ID, ORG_ID), []);
});

test("roles on two live identities in the same org are both considered", async () => {
  const second = "11111111-1111-4111-8111-111111111111";
  const admin = db(
    [
      { id: AUTH_ID, auth_user_id: AUTH_ID, deleted_at: null },
      { id: second, auth_user_id: AUTH_ID, deleted_at: null },
    ],
    [
      { user_id: AUTH_ID, org_id: ORG_ID, status: "active" },
      { user_id: second, org_id: ORG_ID, status: "active" },
    ],
  );
  assert.deepEqual(await findAppOrgRoleIdentities(admin, AUTH_ID, ORG_ID), [AUTH_ID, second]);
});
