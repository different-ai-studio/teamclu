/**
 * sync-acl.test.ts
 *
 * Per-directory knowledge ACL. Design:
 * docs/specs/2026-08-31-knowledge-path-acl-design.md
 *
 * Only the pure matchers are covered here. The behavioural half of this suite —
 * view resolution, cache TTL, and enforcement at the five /sync/* entry points —
 * was written against the postgres backend on pglite, and went with it. The
 * supabase path it left behind is the one that actually runs in production and
 * was never exercised by those tests either, so porting them is a real gap to
 * close, not a like-for-like restoration.
 *
 * Still covered elsewhere: route-level authorization in
 * knowledge-acl-routes.test.ts, and the service_role table grants (whose
 * absence was a production outage) in services/supabase/tests/020_oss_sync_schema.sql.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchPrefix, isDenied, validateAclPrefix } from "../src/lib/sync-acl.js";

describe("sync-acl matchers", () => {
  test("a prefix matches only on a path boundary", () => {
    const prefixes = ["knowledge/hr/"];
    assert.equal(matchPrefix("knowledge/hr/salary.md", prefixes), "knowledge/hr/");
    assert.equal(matchPrefix("knowledge/hr/sub/deep.md", prefixes), "knowledge/hr/");
    // The whole reason prefixes are stored with a trailing slash. Without it
    // this would be a false positive and a sibling directory would vanish.
    assert.equal(matchPrefix("knowledge/hr-public/notes.md", prefixes), null);
    assert.equal(matchPrefix("knowledge/hrx.md", prefixes), null);
    assert.equal(matchPrefix("knowledge/other/a.md", prefixes), null);
  });

  test("isDenied is false when nothing is restricted", () => {
    assert.equal(isDenied("knowledge/hr/a.md", { denied: [], allPrefixes: [] }), false);
  });

  test("validateAclPrefix rejects the shapes the SQL CHECK also rejects", () => {
    assert.equal(validateAclPrefix("knowledge/hr/").ok, true);
    assert.equal(validateAclPrefix("knowledge/").ok, true);
    assert.equal(validateAclPrefix("knowledge/hr").ok, false, "must end with /");
    assert.equal(validateAclPrefix("skills/x/").ok, false, "must be under knowledge/");
    assert.equal(validateAclPrefix("knowledge/../etc/").ok, false);
    assert.equal(validateAclPrefix("knowledge//hr/").ok, false);
    assert.equal(validateAclPrefix("").ok, false);
    assert.equal(validateAclPrefix(undefined).ok, false);
  });
});
