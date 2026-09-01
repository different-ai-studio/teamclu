/**
 * sync-acl.test.ts
 *
 * Per-directory knowledge ACL. Design:
 * docs/specs/2026-08-31-knowledge-path-acl-design.md
 *
 * These run against the supabase path — the one that serves production. The
 * suite this replaces was pinned to `BACKEND_KIND=postgres` on pglite, so it
 * exercised the twin that never ran; the supabase branch it left behind had no
 * behavioural coverage at all.
 *
 * The single most important assertion here is "an unrestricted team is
 * untouched": if that ever fails, this feature is charging every team in the
 * product for something almost none of them use.
 *
 * Enforcement at the five /sync/* entry points is still NOT covered — that
 * needs a stub of the whole sync-handlers supabase path, which does not exist
 * yet. What is covered is the module that decides the answer those entry points
 * act on.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  matchPrefix,
  isDenied,
  validateAclPrefix,
  aclViewFor,
  deniedPrefixesFor,
  recordAccess,
  auditIfRestricted,
  auditManifest,
  resetSyncAclCache,
  invalidateTeamAcl,
  pathForbiddenResponse,
  MAX_ACL_RULES_PER_TEAM,
} from "../src/lib/sync-acl.js";

// ---------------------------------------------------------------------------
// A service-role stub shaped like the two reads and the one insert this module
// makes. Records every call so the tests can assert on the queries themselves,
// not just their results.
// ---------------------------------------------------------------------------

type Rule = { id: string; path_prefix: string };
type Grant = { acl_id: string };

function fakeSupabase({
  rules = [] as Rule[],
  grants = [] as Grant[],
  rulesError = null as { message: string } | null,
  grantsError = null as { message: string } | null,
  insertError = null as { message: string } | null,
} = {}) {
  const calls: any[] = [];
  const inserted: any[] = [];
  const client = {
    calls,
    inserted,
    from(table: string) {
      return {
        select(columns: string) {
          return {
            eq(column: string, value: unknown) {
              calls.push({ table, columns, column, value });
              if (table === "amuxc_path_acl") {
                return Promise.resolve({ data: rules, error: rulesError });
              }
              if (table === "amuxc_path_acl_grants") {
                return Promise.resolve({ data: grants, error: grantsError });
              }
              throw new Error(`unexpected select on ${table}`);
            },
          };
        },
        insert(row: any) {
          calls.push({ table, op: "insert" });
          inserted.push(row);
          return Promise.resolve({ error: insertError });
        },
      };
    },
  };
  return client;
}

const TEAM = "team-1";
const ALICE = "actor-alice";

beforeEach(() => {
  resetSyncAclCache();
});

// ---------------------------------------------------------------------------
// Pure matchers
// ---------------------------------------------------------------------------

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
    assert.equal(validateAclPrefix("skills/x/").ok, false, "must be under a fixed root");
    assert.equal(validateAclPrefix("knowledge/../etc/").ok, false);
    assert.equal(validateAclPrefix("knowledge//hr/").ok, false);
    assert.equal(validateAclPrefix("").ok, false);
    assert.equal(validateAclPrefix(undefined).ok, false);
  });

  test("pathForbiddenResponse names the path and nothing about the rule", () => {
    const res = pathForbiddenResponse("knowledge/hr/salary.md");
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.code, "PathForbidden");
    // Design D7: the caller must not learn a rule exists, who holds it, or who
    // else can see the directory.
    assert.ok(!/grant|rule|admin|owner|acl/i.test(res.body), res.body);
  });
});

// ---------------------------------------------------------------------------
// View resolution
// ---------------------------------------------------------------------------

describe("sync-acl view", () => {
  test("an unrestricted team resolves to an empty view and never asks about grants", async () => {
    // The hot path. A team with no rules must cost exactly one query, and the
    // manifest it produces must be byte-identical to the pre-feature one.
    const supabase = fakeSupabase({ rules: [] });
    const view = await aclViewFor(TEAM, ALICE, { supabase });

    assert.deepEqual(view, { denied: [], allPrefixes: [] });
    assert.equal(supabase.calls.length, 1, "no grants query for an unrestricted team");
    assert.deepEqual(supabase.calls[0], {
      table: "amuxc_path_acl",
      columns: "id, path_prefix",
      column: "team_id",
      value: TEAM,
    });
  });

  test("a rule closes the prefix to everyone not granted", async () => {
    const supabase = fakeSupabase({
      rules: [{ id: "acl-1", path_prefix: "knowledge/hr/" }],
      grants: [],
    });
    const view = await aclViewFor(TEAM, ALICE, { supabase });

    assert.deepEqual(view.denied, ["knowledge/hr/"]);
    assert.deepEqual(view.allPrefixes, ["knowledge/hr/"]);
    assert.equal(isDenied("knowledge/hr/salary.md", view), true);
    assert.equal(isDenied("knowledge/eng/readme.md", view), false);
  });

  test("a grant lifts exactly its own rule, and the prefix stays in allPrefixes", async () => {
    // allPrefixes is what the audit path reads: a granted caller's reads are
    // precisely the ones worth recording, so the prefix must not drop out.
    const supabase = fakeSupabase({
      rules: [
        { id: "acl-1", path_prefix: "knowledge/hr/" },
        { id: "acl-2", path_prefix: "knowledge/legal/" },
      ],
      grants: [{ acl_id: "acl-1" }],
    });
    const view = await aclViewFor(TEAM, ALICE, { supabase });

    assert.deepEqual(view.denied, ["knowledge/legal/"]);
    assert.deepEqual(view.allPrefixes, ["knowledge/hr/", "knowledge/legal/"]);
    assert.equal(isDenied("knowledge/hr/salary.md", view), false, "granted");
    assert.equal(isDenied("knowledge/legal/nda.md", view), true, "not granted");
  });

  test("the grants query is scoped to the actor, not the team", async () => {
    // A team-scoped grants query would hand one member another member's access.
    const supabase = fakeSupabase({
      rules: [{ id: "acl-1", path_prefix: "knowledge/hr/" }],
      grants: [{ acl_id: "acl-1" }],
    });
    await aclViewFor(TEAM, ALICE, { supabase });

    assert.deepEqual(supabase.calls[1], {
      table: "amuxc_path_acl_grants",
      columns: "acl_id",
      column: "actor_id",
      value: ALICE,
    });
  });

  test("deniedPrefixesFor is the deny list and nothing else", async () => {
    const supabase = fakeSupabase({
      rules: [{ id: "acl-1", path_prefix: "knowledge/hr/" }],
      grants: [],
    });
    assert.deepEqual(await deniedPrefixesFor(TEAM, ALICE, { supabase }), ["knowledge/hr/"]);
  });

  test("a rules query error fails CLOSED — it must never resolve to 'show everything'", async () => {
    const supabase = fakeSupabase({ rulesError: { message: "boom" } });
    await assert.rejects(
      () => aclViewFor(TEAM, ALICE, { supabase }),
      /acl rules query failed: boom/,
    );
  });

  test("a grants query error fails closed too", async () => {
    // The dangerous shape: rules load fine, grants blow up. Swallowing this
    // would deny nothing... or grant everything, depending on which way the
    // code leaned. It has to throw.
    const supabase = fakeSupabase({
      rules: [{ id: "acl-1", path_prefix: "knowledge/hr/" }],
      grantsError: { message: "nope" },
    });
    await assert.rejects(
      () => aclViewFor(TEAM, ALICE, { supabase }),
      /acl grants query failed: nope/,
    );
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe("sync-acl cache", () => {
  test("a second call inside the TTL asks the database nothing", async () => {
    const supabase = fakeSupabase({
      rules: [{ id: "acl-1", path_prefix: "knowledge/hr/" }],
      grants: [],
    });
    let now = 1_000_000;
    const deps = { supabase, nowMs: () => now };

    await aclViewFor(TEAM, ALICE, deps);
    const afterFirst = supabase.calls.length;
    await aclViewFor(TEAM, ALICE, deps);

    assert.equal(supabase.calls.length, afterFirst, "second call served from cache");
  });

  test("the cache expires, and expiry is driven by the injected clock", async () => {
    const supabase = fakeSupabase({
      rules: [{ id: "acl-1", path_prefix: "knowledge/hr/" }],
      grants: [],
    });
    let now = 1_000_000;
    const deps = { supabase, nowMs: () => now };

    await aclViewFor(TEAM, ALICE, deps);
    const afterFirst = supabase.calls.length;
    now += 10_001; // one millisecond past the 10s TTL
    await aclViewFor(TEAM, ALICE, deps);

    assert.ok(supabase.calls.length > afterFirst, "expired entry is reloaded");
  });

  test("invalidateTeamAcl drops the entry early — an admin's grant lands on the next sync", async () => {
    // Without this, a grant takes up to the full TTL to appear, which is what
    // makes "I gave you access" and "I still cannot see it" both true.
    const supabase = fakeSupabase({
      rules: [{ id: "acl-1", path_prefix: "knowledge/hr/" }],
      grants: [],
    });
    let now = 1_000_000;
    const deps = { supabase, nowMs: () => now };

    await aclViewFor(TEAM, ALICE, deps);
    const afterFirst = supabase.calls.length;
    invalidateTeamAcl(TEAM);
    await aclViewFor(TEAM, ALICE, deps);

    assert.ok(supabase.calls.length > afterFirst, "invalidation forced a reload");
  });

  test("invalidating one team leaves another team's entry alone", async () => {
    const supabase = fakeSupabase({
      rules: [{ id: "acl-1", path_prefix: "knowledge/hr/" }],
      grants: [],
    });
    let now = 1_000_000;
    const deps = { supabase, nowMs: () => now };

    await aclViewFor(TEAM, ALICE, deps);
    await aclViewFor("team-2", ALICE, deps);
    const afterBoth = supabase.calls.length;

    invalidateTeamAcl("team-2");
    await aclViewFor(TEAM, ALICE, deps);

    assert.equal(supabase.calls.length, afterBoth, "team-1 stayed cached");
  });

  test("the cache is keyed by actor as well as team", async () => {
    // Sharing one entry across a team is how a granted member's view leaks to
    // an ungranted one.
    const supabase = fakeSupabase({
      rules: [{ id: "acl-1", path_prefix: "knowledge/hr/" }],
      grants: [],
    });
    let now = 1_000_000;
    const deps = { supabase, nowMs: () => now };

    await aclViewFor(TEAM, ALICE, deps);
    const afterAlice = supabase.calls.length;
    await aclViewFor(TEAM, "actor-bob", deps);

    assert.ok(supabase.calls.length > afterAlice, "bob is resolved on his own");
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe("sync-acl audit", () => {
  test("recordAccess writes the snake_case row the table expects", async () => {
    const supabase = fakeSupabase();
    await recordAccess(
      {
        teamId: TEAM,
        actorId: ALICE,
        pathPrefix: "knowledge/hr/",
        path: "knowledge/hr/salary.md",
        action: "download",
        allowed: true,
      },
      { supabase },
    );

    assert.deepEqual(supabase.inserted, [
      {
        team_id: TEAM,
        actor_id: ALICE,
        path_prefix: "knowledge/hr/",
        path: "knowledge/hr/salary.md",
        action: "download",
        allowed: true,
      },
    ]);
  });

  test("a failed audit write is swallowed — it must not fail the request it describes", async () => {
    // The deliberate asymmetry with aclViewFor: refusing a legitimate read
    // because the log was unavailable protects nothing and breaks sync.
    const supabase = fakeSupabase({ insertError: { message: "log is down" } });
    await recordAccess(
      { teamId: TEAM, actorId: ALICE, pathPrefix: "knowledge/hr/", action: "manifest", allowed: true },
      { supabase },
    );
    // Reaching here without throwing is the assertion.
    assert.equal(supabase.inserted.length, 1);
  });

  test("auditIfRestricted writes nothing when the team has no rules", async () => {
    const supabase = fakeSupabase();
    await auditIfRestricted(
      { denied: [], allPrefixes: [] },
      { teamId: TEAM, actorId: ALICE, path: "knowledge/hr/a.md", action: "download", allowed: true },
      { supabase },
    );
    assert.deepEqual(supabase.inserted, []);
  });

  test("auditIfRestricted writes nothing for a path that touches no restricted prefix", async () => {
    const supabase = fakeSupabase();
    await auditIfRestricted(
      { denied: [], allPrefixes: ["knowledge/hr/"] },
      { teamId: TEAM, actorId: ALICE, path: "knowledge/eng/a.md", action: "download", allowed: true },
      { supabase },
    );
    assert.deepEqual(supabase.inserted, []);
  });

  test("auditIfRestricted records a REFUSED access, not only a permitted one", async () => {
    const supabase = fakeSupabase();
    await auditIfRestricted(
      { denied: ["knowledge/hr/"], allPrefixes: ["knowledge/hr/"] },
      { teamId: TEAM, actorId: ALICE, path: "knowledge/hr/salary.md", action: "download", allowed: false },
      { supabase },
    );
    assert.equal(supabase.inserted.length, 1);
    assert.equal(supabase.inserted[0].allowed, false);
    assert.equal(supabase.inserted[0].path_prefix, "knowledge/hr/");
  });

  test("auditManifest writes one row per VISIBLE prefix and none for denied ones", async () => {
    // Per-prefix rather than per-file: a manifest is bulk, and the question the
    // audit answers is "who pulled this directory", not "which files".
    const supabase = fakeSupabase();
    await auditManifest(
      { denied: ["knowledge/legal/"], allPrefixes: ["knowledge/hr/", "knowledge/legal/"] },
      { teamId: TEAM, actorId: ALICE },
      { supabase },
    );

    assert.equal(supabase.inserted.length, 1);
    assert.equal(supabase.inserted[0].path_prefix, "knowledge/hr/");
    assert.equal(supabase.inserted[0].action, "manifest");
    assert.equal(supabase.inserted[0].path, null, "manifest rows name a prefix, not a file");
    assert.equal(supabase.inserted[0].allowed, true);
  });

  test("auditManifest writes nothing for an unrestricted team", async () => {
    const supabase = fakeSupabase();
    await auditManifest({ denied: [], allPrefixes: [] }, { teamId: TEAM, actorId: ALICE }, { supabase });
    assert.deepEqual(supabase.inserted, []);
  });
});

test("MAX_ACL_RULES_PER_TEAM bounds how much one team can slow the manifest down", () => {
  // Each rule becomes a NOT LIKE on the hottest endpoint in the product.
  assert.equal(MAX_ACL_RULES_PER_TEAM, 64);
});
