import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isDocumentLibraryPrefix,
  documentPrefixesOverlap,
  roleRuleDenies,
  membersLosingLibraryAccess,
  libraryPrefixesToResurface,
  libraryGrantWidens,
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

  test("dot segments and over-long prefixes are refused, as validateAclPrefix does", () => {
    assert.equal(isDocumentLibraryPrefix("documents/../"), false);
    assert.equal(isDocumentLibraryPrefix("documents/a..b/"), false);
    assert.equal(isDocumentLibraryPrefix(`documents/${"x".repeat(1100)}/`), false);
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

describe("libraryPrefixesToResurface", () => {
  test("adding finance resurfaces only libraries that grant finance", () => {
    const prefixes = libraryPrefixesToResurface({
      libraries: [
        { pathPrefix: "documents/财务/", roleIds: ["role-finance", "role-owner"] },
        { pathPrefix: "documents/人事/", roleIds: ["role-hr", "role-owner"] },
      ],
      addedRoleIds: ["role-finance"],
      addedOwner: false,
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
    });
    assert.deepEqual(prefixes, ["documents/财务/", "documents/人事/"]);
  });

  test("removing a role resurfaces nothing", () => {
    assert.deepEqual(libraryPrefixesToResurface({
      libraries: [{ pathPrefix: "documents/财务/", roleIds: ["role-finance"] }],
      addedRoleIds: [],
      addedOwner: false,
    }), []);
  });
});

describe("libraryGrantWidens", () => {
  test("restricting an open folder lets no one new in", () => {
    assert.equal(libraryGrantWidens({ kind: "open" }, ["role-owner", "role-hr"]), false);
  });

  test("replacing a per-member rule can let people in", () => {
    assert.equal(libraryGrantWidens({ kind: "actors" }, ["role-owner"]), true);
  });

  test("a role rule widens only when a role id is added", () => {
    const before = { kind: "roles" as const, roleIds: ["role-owner", "role-hr", "role-fin"] };
    assert.equal(libraryGrantWidens(before, ["role-owner", "role-hr"]), false);
    assert.equal(libraryGrantWidens(before, ["role-owner", "role-hr", "role-fin"]), false);
    assert.equal(libraryGrantWidens(before, ["role-owner", "role-ops"]), true);
  });
});
