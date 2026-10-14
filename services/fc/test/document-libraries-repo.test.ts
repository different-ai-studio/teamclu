import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNoDocumentOverlap,
  needsRevokeConfirm,
  prepareRoleIds,
} from "../src/lib/supabase-repo/document-libraries.js";
import {
  assertLegacyDocumentCreate,
  assertLegacyDocumentUpdate,
  filesUnderPrefix,
  hasLikeMetachars,
} from "../src/lib/supabase-repo/knowledge-acl.js";

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

test("a role deactivated after it was granted may stay; a new inactive grant may not", () => {
  const roles = [
    { id: "owner", code: "owner", status: "active", isSystem: true },
    { id: "old", code: "hr", status: "inactive", isSystem: false },
  ];
  assert.deepEqual(prepareRoleIds(roles, ["old"], new Set(["old"])).roleIds, ["owner", "old"]);
  assert.throws(() => prepareRoleIds(roles, ["old"], new Set(["other"])), (err: any) => err.statusCode === 400);
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

test("legacy create refuses every documents prefix", () => {
  assert.throws(() => assertLegacyDocumentCreate("documents/财务/"), (err: any) => err.statusCode === 400);
  assert.throws(() => assertLegacyDocumentCreate("documents/财务/工资/"), (err: any) => err.statusCode === 400);
  assert.doesNotThrow(() => assertLegacyDocumentCreate("knowledge/hr/"));
});

test("legacy update refuses a rule that already has role grants", () => {
  assert.throws(() => assertLegacyDocumentUpdate(1), (err: any) => err.statusCode === 409);
  assert.doesNotThrow(() => assertLegacyDocumentUpdate(0));
});

test("only LIKE metacharacters force the exact-match path", () => {
  assert.equal(hasLikeMetachars("documents/财务/"), false);
  assert.equal(hasLikeMetachars("documents/a_b/"), true);
  assert.equal(hasLikeMetachars("documents/100%/"), true);
  assert.equal(hasLikeMetachars("documents/a*b/"), true);
  assert.equal(hasLikeMetachars("documents/a\\b/"), true);
});

test("filesUnderPrefix keeps only exact prefix matches from the widened LIKE", async () => {
  const seen: { like?: string; liveOnly?: boolean } = {};
  const admin = {
    from() {
      const api: any = {
        select: () => api,
        eq(col: string) {
          if (col === "deleted") seen.liveOnly = true;
          return api;
        },
        like(_col: string, pattern: string) {
          seen.like = pattern;
          return api;
        },
        order: () => api,
        range: async () => ({
          data: [
            { id: "1", path: "documents/a_b/x.md" },
            { id: "2", path: "documents/axb/y.md" },
            { id: "3", path: "documents/a_b/sub/z.md" },
          ],
          error: null,
        }),
      };
      return api;
    },
  };
  const files = await filesUnderPrefix(admin, "team-1", "documents/a_b/", { liveOnly: true });
  assert.deepEqual(files.map((f) => f.id), ["1", "3"]);
  assert.equal(seen.like, "documents/a_b/%");
  assert.equal(seen.liveOnly, true);
});
