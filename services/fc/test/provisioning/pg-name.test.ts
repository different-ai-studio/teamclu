import { test } from "node:test";
import assert from "node:assert/strict";
import { appSchemaName, appRoleName, orgDatabaseName } from "../../src/lib/provisioning/pg-name.js";

test("appSchemaName includes a sanitized slug and the full appId hex suffix", () => {
  const appId = "3f1c9a2e-0000-4000-8000-000000000abc";
  const idHex = appId.replace(/-/g, "");
  const out = appSchemaName("Demo App", appId);
  assert.equal(out, `app_demo_app_${idHex}`);
  assert.match(out, /^[a-z0-9_]+$/);
});

test("appSchemaName disambiguates same-slug apps across teams via appId", () => {
  const a = appSchemaName("myapp", "11111111-1111-4111-8111-111111111111");
  const b = appSchemaName("myapp", "22222222-2222-4222-8222-222222222222");
  assert.notEqual(a, b);
});

test("appSchemaName stays within the 63-byte Postgres identifier limit", () => {
  const out = appSchemaName("x".repeat(200), "3f1c9a2e-0000-4000-8000-000000000abc");
  assert.ok(out.length <= 63, `got ${out.length}`);
  assert.ok(out.startsWith("app_"));
});

test("appRoleName derives from the appId uuid with underscores", () => {
  assert.equal(
    appRoleName("3f1c9a2e-0000-4000-8000-000000000abc"),
    "app_3f1c9a2e_0000_4000_8000_000000000abc",
  );
});

test("orgDatabaseName is tc_org_ + org id hex", () => {
  const orgId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.equal(orgDatabaseName(orgId), `tc_org_${orgId.replace(/-/g, "")}`);
  assert.match(orgDatabaseName(orgId), /^[a-z0-9_]+$/);
  assert.ok(orgDatabaseName(orgId).length <= 63);
});

test("orgDatabaseName rejects an empty id", () => {
  assert.throws(() => orgDatabaseName("---"), /hex/);
});
