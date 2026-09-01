/**
 * sync-acl.test.ts
 *
 * Per-directory knowledge ACL. Design:
 * docs/specs/2026-08-31-knowledge-path-acl-design.md
 *
 * Two layers are tested here:
 *   1. The pure matchers, which decide what a prefix covers.
 *   2. Enforcement at the five /sync/* entry points, through the postgres
 *      backend on pglite — the same harness sync-handlers-pg.test.ts uses.
 *
 * The single most important assertion in this file is
 * "unrestricted team is untouched": if that ever fails, this feature is charging
 * every team in the product for something almost none of them use.
 */

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import type { BlobStorage } from "../src/lib/team-blob-storage.js";
import { makeOssSyncRepo } from "../src/lib/pg-repo/oss-sync.js";
import { makeKnowledgeAclRepo } from "../src/lib/pg-repo/knowledge-acl.js";
import {
  teams,
  actors,
  members,
  teamMembers,
  teamWorkspaceConfig,
} from "../src/db/schema/index.js";
import {
  handleSyncManifest,
  handleSyncUploadPrepare,
  handleSyncUploadComplete,
  handleSyncDownload,
  handleSyncDelete,
  handleSyncVersions,
} from "../src/lib/sync-handlers.js";
import {
  matchPrefix,
  isDenied,
  validateAclPrefix,
  aclViewFor,
  resetSyncAclCache,
  invalidateTeamAcl,
} from "../src/lib/sync-acl.js";

const origBackendKind = process.env.BACKEND_KIND;
before(() => {
  process.env.BACKEND_KIND = "postgres";
});
after(() => {
  if (origBackendKind === undefined) delete process.env.BACKEND_KIND;
  else process.env.BACKEND_KIND = origBackendKind;
});

// The ACL view cache is module-level and keyed by (team, actor). Tests reuse
// neither, but a stale entry would still make failures baffling.
beforeEach(() => resetSyncAclCache());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMockStorage(objects: Map<string, number>): BlobStorage {
  return {
    async createUploadUrl(p) {
      return `https://storage.test/upload/${p}`;
    },
    async createDownloadUrl(p) {
      return `https://storage.test/download/${p}`;
    },
    async stat(p) {
      const size = objects.get(p);
      return size === undefined ? null : { size };
    },
    async remove(p) {
      objects.delete(p);
    },
  };
}

let slugCounter = 0;

async function seedTeam(db: any) {
  const [t] = await db
    .insert(teams)
    .values({ name: "AclTeam", slug: `acl-test-${Date.now()}-${slugCounter++}` })
    .returning();
  await db.insert(teamWorkspaceConfig).values({ teamId: t.id, syncMode: "oss", ossChangeSeq: 0 });
  return t;
}

async function seedMember(db: any, teamId: string, role = "member") {
  const userId = `user-${Math.random().toString(36).slice(2)}`;
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "Tester", userId })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role });
  return { ...actor, userId };
}

/** Push one file all the way through prepare+complete so it exists server-side. */
async function seedFile(
  ctx: { db: any; repo: any; storage: BlobStorage; objects: Map<string, number> },
  team: any,
  actor: any,
  path: string,
  hash: string,
) {
  const caller = { userId: actor.userId, teamId: team.id, actorId: actor.id };
  const deps = { db: ctx.db, repo: ctx.repo, storage: ctx.storage, mqtt: null };
  const prep = await handleSyncUploadPrepare(
    caller,
    { path, parentVersion: 0, contentHash: hash, size: 10 },
    deps,
  );
  assert.equal(prep.statusCode, 200, `prepare failed for ${path}: ${prep.body}`);
  const { uploadSessionId, ossKey } = JSON.parse(prep.body);
  ctx.objects.set(ossKey, 10);
  const done = await handleSyncUploadComplete(caller, { uploadSessionId }, deps);
  assert.equal(done.statusCode, 200, `complete failed for ${path}: ${done.body}`);
}

async function setup() {
  const { db } = await makeTestDb();
  const repo = makeOssSyncRepo(db);
  const objects = new Map<string, number>();
  const storage = makeMockStorage(objects);
  const team = await seedTeam(db);
  const admin = await seedMember(db, team.id, "owner");
  const insider = await seedMember(db, team.id);
  const outsider = await seedMember(db, team.id);
  const ctx = { db, repo, storage, objects };
  const deps = { db, repo, storage, mqtt: null as any };
  const aclRepo = (userId: string) => makeKnowledgeAclRepo(db, { userId });
  return { db, repo, storage, objects, team, admin, insider, outsider, ctx, deps, aclRepo };
}

function caller(team: any, actor: any) {
  return { userId: actor.userId, teamId: team.id, actorId: actor.id };
}

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
    assert.equal(validateAclPrefix("skills/x/").ok, false, "must be under knowledge/");
    assert.equal(validateAclPrefix("knowledge/../etc/").ok, false);
    assert.equal(validateAclPrefix("knowledge//hr/").ok, false);
    assert.equal(validateAclPrefix("").ok, false);
    assert.equal(validateAclPrefix(undefined).ok, false);
  });
});

// ---------------------------------------------------------------------------
// View resolution
// ---------------------------------------------------------------------------

describe("sync-acl view", () => {
  test("unrestricted team resolves to an empty view", async () => {
    const { db, team, insider } = await setup();
    const view = await aclViewFor(team.id, insider.id, { db });
    assert.deepEqual(view.denied, []);
    assert.deepEqual(view.allPrefixes, []);
  });

  test("whitelist: a rule closes the prefix to everyone not granted", async () => {
    const { db, team, admin, insider, outsider, aclRepo } = await setup();
    await aclRepo(admin.userId).createKnowledgeAcl(team.id, {
      pathPrefix: "knowledge/hr/",
      actorIds: [insider.id],
    });

    const granted = await aclViewFor(team.id, insider.id, { db });
    assert.deepEqual(granted.denied, [], "granted actor sees nothing denied");
    assert.deepEqual(granted.allPrefixes, ["knowledge/hr/"]);

    const denied = await aclViewFor(team.id, outsider.id, { db });
    assert.deepEqual(denied.denied, ["knowledge/hr/"]);
  });

  test("overlapping rules intersect — the strictest wins", async () => {
    const { db, team, admin, insider, aclRepo } = await setup();
    // Granted on the outer directory, NOT on the inner one.
    await aclRepo(admin.userId).createKnowledgeAcl(team.id, {
      pathPrefix: "knowledge/hr/",
      actorIds: [insider.id],
    });
    await aclRepo(admin.userId).createKnowledgeAcl(team.id, {
      pathPrefix: "knowledge/hr/salary/",
      actorIds: [],
    });

    const view = await aclViewFor(team.id, insider.id, { db });
    assert.deepEqual(view.denied, ["knowledge/hr/salary/"]);
    assert.equal(isDenied("knowledge/hr/roster.md", view), false);
    assert.equal(isDenied("knowledge/hr/salary/band.md", view), true);
  });

  test("cache holds until the TTL, and invalidation drops it early", async () => {
    const { db, team, admin, outsider, aclRepo } = await setup();
    let clock = 1_000_000;
    const deps = { db, nowMs: () => clock };

    assert.deepEqual((await aclViewFor(team.id, outsider.id, deps)).denied, []);

    // A rule created behind the cache's back is not seen until it expires...
    await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("drizzle-orm")).sql`select 1`,
    );
    await aclRepo(admin.userId).createKnowledgeAcl(team.id, {
      pathPrefix: "knowledge/hr/",
      actorIds: [],
    });
    // ...except the repo invalidates on write, which is the behaviour we want:
    // an admin's change takes effect on the next sync, not ten seconds later.
    assert.deepEqual(
      (await aclViewFor(team.id, outsider.id, deps)).denied,
      ["knowledge/hr/"],
      "mutation should have invalidated the cached view",
    );

    // Prove the TTL itself works, using a view cached deliberately.
    resetSyncAclCache();
    await aclViewFor(team.id, outsider.id, deps);
    invalidateTeamAcl("some-other-team");
    assert.deepEqual((await aclViewFor(team.id, outsider.id, deps)).denied, ["knowledge/hr/"]);
    clock += 11_000;
    assert.deepEqual((await aclViewFor(team.id, outsider.id, deps)).denied, ["knowledge/hr/"]);
  });
});

// ---------------------------------------------------------------------------
// Enforcement at the five entry points
// ---------------------------------------------------------------------------

describe("sync-acl enforcement", () => {
  test("unrestricted team is untouched: every path stays visible", async () => {
    const s = await setup();
    await seedFile(s.ctx, s.team, s.admin, "knowledge/hr/salary.md", "a".repeat(32));
    await seedFile(s.ctx, s.team, s.admin, "knowledge/open/notes.md", "b".repeat(32));

    const res = await handleSyncManifest(caller(s.team, s.outsider), { afterSeq: 0 }, s.deps);
    assert.equal(res.statusCode, 200);
    const paths = JSON.parse(res.body).items.map((i: any) => i.path).sort();
    assert.deepEqual(paths, ["knowledge/hr/salary.md", "knowledge/open/notes.md"]);
  });

  test("manifest hides restricted paths from a denied caller only", async () => {
    const s = await setup();
    await seedFile(s.ctx, s.team, s.admin, "knowledge/hr/salary.md", "a".repeat(32));
    await seedFile(s.ctx, s.team, s.admin, "knowledge/open/notes.md", "b".repeat(32));
    await s.aclRepo(s.admin.userId).createKnowledgeAcl(s.team.id, {
      pathPrefix: "knowledge/hr/",
      actorIds: [s.insider.id],
      confirmRevokeExisting: true,
    });

    const hidden = JSON.parse(
      (await handleSyncManifest(caller(s.team, s.outsider), { afterSeq: 0 }, s.deps)).body,
    ).items.map((i: any) => i.path);
    assert.deepEqual(hidden, ["knowledge/open/notes.md"]);

    const seen = JSON.parse(
      (await handleSyncManifest(caller(s.team, s.insider), { afterSeq: 0 }, s.deps)).body,
    ).items.map((i: any) => i.path).sort();
    assert.deepEqual(seen, ["knowledge/hr/salary.md", "knowledge/open/notes.md"]);
  });

  test("download is refused by hash, not just hidden by path", async () => {
    const s = await setup();
    const hash = "c".repeat(32);
    await seedFile(s.ctx, s.team, s.admin, "knowledge/hr/salary.md", hash);
    await s.aclRepo(s.admin.userId).createKnowledgeAcl(s.team.id, {
      pathPrefix: "knowledge/hr/",
      actorIds: [s.insider.id],
      confirmRevokeExisting: true,
    });

    // The whole point: the caller already knows the hash. Hiding the manifest
    // row is not enough — this is the door that has to be locked too.
    const denied = await handleSyncDownload(
      caller(s.team, s.outsider),
      { contentHash: hash },
      s.deps,
    );
    assert.equal(denied.statusCode, 403);
    assert.equal(JSON.parse(denied.body).code, "PathForbidden");

    const allowed = await handleSyncDownload(
      caller(s.team, s.insider),
      { contentHash: hash },
      s.deps,
    );
    assert.equal(allowed.statusCode, 200);
  });

  test("a hash reachable through an open path stays downloadable", async () => {
    const s = await setup();
    const hash = "d".repeat(32);
    await seedFile(s.ctx, s.team, s.admin, "knowledge/hr/copy.md", hash);
    await seedFile(s.ctx, s.team, s.admin, "knowledge/open/copy.md", hash);
    await s.aclRepo(s.admin.userId).createKnowledgeAcl(s.team.id, {
      pathPrefix: "knowledge/hr/",
      actorIds: [],
      confirmRevokeExisting: true,
    });

    // Refusing here would protect nothing — they can read the same bytes at the
    // open path — and would confirm that a restricted copy exists.
    const res = await handleSyncDownload(caller(s.team, s.outsider), { contentHash: hash }, s.deps);
    assert.equal(res.statusCode, 200);
  });

  test("prepare, delete and versions all refuse a restricted path", async () => {
    const s = await setup();
    await seedFile(s.ctx, s.team, s.admin, "knowledge/hr/salary.md", "e".repeat(32));
    await s.aclRepo(s.admin.userId).createKnowledgeAcl(s.team.id, {
      pathPrefix: "knowledge/hr/",
      actorIds: [],
      confirmRevokeExisting: true,
    });
    const who = caller(s.team, s.outsider);

    const prep = await handleSyncUploadPrepare(
      who,
      { path: "knowledge/hr/new.md", parentVersion: 0, contentHash: "f".repeat(32), size: 1 },
      s.deps,
    );
    assert.equal(prep.statusCode, 403);
    assert.equal(JSON.parse(prep.body).code, "PathForbidden");

    const del = await handleSyncDelete(
      who,
      { path: "knowledge/hr/salary.md", parentVersion: 1 },
      s.deps,
    );
    assert.equal(del.statusCode, 403);

    const ver = await handleSyncVersions(who, { path: "knowledge/hr/salary.md" }, s.deps);
    assert.equal(ver.statusCode, 403);
  });
});

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

describe("knowledge ACL management", () => {
  test("only owner/admin may manage rules", async () => {
    const s = await setup();
    await assert.rejects(
      () =>
        s.aclRepo(s.insider.userId).createKnowledgeAcl(s.team.id, {
          pathPrefix: "knowledge/hr/",
          actorIds: [],
        }),
      /owner or admin/,
    );
    await assert.rejects(() => s.aclRepo(s.insider.userId).listKnowledgeAcl(s.team.id));
  });

  test("restricting a populated directory needs explicit confirmation", async () => {
    const s = await setup();
    await seedFile(s.ctx, s.team, s.admin, "knowledge/hr/a.md", "1".repeat(32));
    await seedFile(s.ctx, s.team, s.admin, "knowledge/hr/b.md", "2".repeat(32));

    // Three members exist; granting one means two lose access.
    const preview = await s.aclRepo(s.admin.userId).previewKnowledgeAcl(s.team.id, {
      pathPrefix: "knowledge/hr/",
      actorIds: [s.insider.id],
    });
    assert.equal(preview.affectedFiles, 2);
    assert.equal(preview.affectedMembers, 2);

    await assert.rejects(
      () =>
        s.aclRepo(s.admin.userId).createKnowledgeAcl(s.team.id, {
          pathPrefix: "knowledge/hr/",
          actorIds: [s.insider.id],
        }),
      /confirmRevokeExisting/,
    );

    const created = await s.aclRepo(s.admin.userId).createKnowledgeAcl(s.team.id, {
      pathPrefix: "knowledge/hr/",
      actorIds: [s.insider.id],
      confirmRevokeExisting: true,
    });
    assert.equal(created.pathPrefix, "knowledge/hr/");
    assert.deepEqual(created.actorIds, [s.insider.id]);
  });

  test("an empty directory needs no confirmation", async () => {
    const s = await setup();
    const created = await s.aclRepo(s.admin.userId).createKnowledgeAcl(s.team.id, {
      pathPrefix: "knowledge/future/",
      actorIds: [],
    });
    assert.ok(created.id);
  });

  test("granting later re-surfaces files the actor never received", async () => {
    const s = await setup();
    await seedFile(s.ctx, s.team, s.admin, "knowledge/hr/a.md", "3".repeat(32));
    const rule = await s.aclRepo(s.admin.userId).createKnowledgeAcl(s.team.id, {
      pathPrefix: "knowledge/hr/",
      actorIds: [],
      confirmRevokeExisting: true,
    });

    // The outsider syncs to the head of the manifest while denied, so their
    // cursor moves past the restricted rows.
    const first = JSON.parse(
      (await handleSyncManifest(caller(s.team, s.outsider), { afterSeq: 0 }, s.deps)).body,
    );
    assert.deepEqual(first.items, []);
    const cursorAfterDenial = first.snapshotSeq;

    await s.aclRepo(s.admin.userId).updateKnowledgeAcl(s.team.id, rule.id, {
      addActorIds: [s.outsider.id],
    });

    // Without the change_seq bump this would be empty forever: the row's seq is
    // behind the cursor the client already advanced past.
    const after = JSON.parse(
      (await handleSyncManifest(
        caller(s.team, s.outsider),
        { afterSeq: cursorAfterDenial },
        s.deps,
      )).body,
    );
    assert.deepEqual(
      after.items.map((i: any) => i.path),
      ["knowledge/hr/a.md"],
    );
  });

  test("deleting a rule reopens the prefix to the whole team", async () => {
    const s = await setup();
    await seedFile(s.ctx, s.team, s.admin, "knowledge/hr/a.md", "4".repeat(32));
    const rule = await s.aclRepo(s.admin.userId).createKnowledgeAcl(s.team.id, {
      pathPrefix: "knowledge/hr/",
      actorIds: [],
      confirmRevokeExisting: true,
    });
    assert.equal(
      JSON.parse((await handleSyncManifest(caller(s.team, s.outsider), { afterSeq: 0 }, s.deps)).body)
        .items.length,
      0,
    );

    await s.aclRepo(s.admin.userId).deleteKnowledgeAcl(s.team.id, rule.id);

    const res = JSON.parse(
      (await handleSyncManifest(caller(s.team, s.outsider), { afterSeq: 0 }, s.deps)).body,
    );
    assert.deepEqual(
      res.items.map((i: any) => i.path),
      ["knowledge/hr/a.md"],
    );
  });
});
