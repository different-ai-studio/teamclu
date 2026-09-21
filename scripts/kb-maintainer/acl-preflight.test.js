"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertDocumentsAclAllowsPublish } = require("./acl-preflight");

const whitelist = ["documents/handbook/", "documents/training/"];

test("assertDocumentsAclAllowsPublish accepts an empty ACL list", () => {
  assert.doesNotThrow(() =>
    assertDocumentsAclAllowsPublish({ whitelistPrefixes: whitelist, aclPrefixes: [] }),
  );
});

test("assertDocumentsAclAllowsPublish ignores knowledge/ ACL prefixes", () => {
  assert.doesNotThrow(() =>
    assertDocumentsAclAllowsPublish({
      whitelistPrefixes: whitelist,
      aclPrefixes: ["knowledge/hr/"],
    }),
  );
});

test("assertDocumentsAclAllowsPublish fails when a documents ACL covers the whitelist", () => {
  assert.throws(
    () =>
      assertDocumentsAclAllowsPublish({
        whitelistPrefixes: whitelist,
        aclPrefixes: ["documents/"],
      }),
    /documents\/.*acl|restricted/i,
  );
});

test("assertDocumentsAclAllowsPublish fails when a nested documents ACL sits under a whitelist prefix", () => {
  assert.throws(
    () =>
      assertDocumentsAclAllowsPublish({
        whitelistPrefixes: whitelist,
        aclPrefixes: ["documents/handbook/secret/"],
      }),
    /handbook/i,
  );
});

test("assertDocumentsAclAllowsPublish fails closed when ACL state is unknown", () => {
  assert.throws(
    () =>
      assertDocumentsAclAllowsPublish({
        whitelistPrefixes: whitelist,
        aclPrefixes: null,
      }),
    /unknown|confirm/i,
  );
});

test("assertDocumentsAclAllowsPublish allows a documents ACL on an unrelated prefix", () => {
  assert.doesNotThrow(() =>
    assertDocumentsAclAllowsPublish({
      whitelistPrefixes: whitelist,
      aclPrefixes: ["documents/personnel/"],
    }),
  );
});
