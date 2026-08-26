/**
 * sync-handlers-pg.test.ts
 *
 * Tests for the BACKEND_KIND=postgres path in sync-handlers.ts.
 * Uses a pglite in-memory DB and an in-memory BlobStorage — no real storage or
 * Supabase.
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import type { BlobStorage } from "../src/lib/team-blob-storage.js";
import { makeOssSyncRepo } from "../src/lib/pg-repo/oss-sync.js";
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
  handleSyncSetMode,
  handleSyncTeamMode,
  handleSyncUploadPrepareBatch,
  handleSyncUploadCompleteBatch,
  handleSyncDownloadBatch,
  handleSyncDeleteBatch,
  MAX_SYNC_BATCH,
} from "../src/lib/sync-handlers.js";
import { resetQuotaCache } from "../src/lib/sync-guards.js";

// ---------------------------------------------------------------------------
// Force BACKEND_KIND=postgres
// ---------------------------------------------------------------------------

const origBackendKind = process.env.BACKEND_KIND;

before(() => {
  process.env.BACKEND_KIND = "postgres";
});

after(() => {
  if (origBackendKind === undefined) {
    delete process.env.BACKEND_KIND;
  } else {
    process.env.BACKEND_KIND = origBackendKind;
  }
});

// ---------------------------------------------------------------------------
// In-memory BlobStorage
// ---------------------------------------------------------------------------

interface MockStorageState {
  objects: Map<string, number>; // objectPath → size
  /** Every stat() the handlers performed — asserts the dedupe short-circuit. */
  stats?: string[];
}

function makeMockStorage(state: MockStorageState): BlobStorage {
  return {
    async createUploadUrl(objectPath) {
      return `https://storage.test/upload/${objectPath}?token=fake`;
    },
    async createDownloadUrl(objectPath, expiresIn = 900) {
      return `https://storage.test/download/${objectPath}?exp=${expiresIn}`;
    },
    async stat(objectPath) {
      state.stats?.push(objectPath);
      const size = state.objects.get(objectPath);
      return size === undefined ? null : { size };
    },
    async remove(objectPath) {
      state.objects.delete(objectPath);
    },
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

let _slugCounter = 0;

async function seedTeam(db: any) {
  const slug = `handler-test-${Date.now()}-${_slugCounter++}`;
  const [t] = await db.insert(teams).values({ name: "HandlerTeam", slug }).returning();
  await db
    .insert(teamWorkspaceConfig)
    .values({ teamId: t.id, syncMode: "oss", ossChangeSeq: 0 });
  return t;
}

async function seedMember(db: any, teamId: string, role = "member", userId?: string) {
  const uid = userId ?? `user-${Math.random().toString(36).slice(2)}`;
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "Tester", userId: uid })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role });
  return actor;
}

function makeCaller(teamId: string, actorId: string, userId = "user-1") {
  return { userId, teamId, actorId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-handlers postgres path", () => {
  test("uploadPrepare: returns presignedPut + sessionId when blob missing", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const storeState: MockStorageState = { objects: new Map() }; // nothing in storage yet
    const storage = makeMockStorage(storeState);

    const caller = makeCaller(team.id, actor.id);
    const res = await handleSyncUploadPrepare(
      caller,
      {
        path: "knowledge/hello.md",
        parentVersion: 0,
        contentHash: "abc123def456abc123def456abc123de",
        size: 42,
      },
      { db, repo, storage }
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.uploadSessionId, "should have uploadSessionId");
    assert.equal(body.requiresUpload, true);
    assert.ok(body.presignedPut, "should have presignedPut URL");
    assert.ok(body.ossKey.includes(team.id), "ossKey should contain teamId");
  });

  test("uploadPrepare: requiresUpload=false when blob already in OSS", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "cafecafecafecafecafecafecafecafe";
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const storeState: MockStorageState = { objects: new Map([[ossKey, 100]]) };
    const storage = makeMockStorage(storeState);

    const res = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/b.txt", parentVersion: 0, contentHash: hash, size: 100 },
      { db, repo, storage }
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.requiresUpload, false);
    assert.equal(body.presignedPut, null);
  });

  test("uploadComplete: advances version and returns changeSeq", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    // Prepare
    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    const size = 50;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const storeState: MockStorageState = { objects: new Map() };
    const storage = makeMockStorage(storeState);

    const prepRes = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/file.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, storage }
    );
    const sessionId = JSON.parse(prepRes.body).uploadSessionId;

    // Simulate blob uploaded to OSS
    storeState.objects.set(ossKey, size);

    const completeRes = await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: sessionId },
      { db, repo, storage }
    );

    assert.equal(completeRes.statusCode, 200);
    const body = JSON.parse(completeRes.body);
    assert.equal(body.version, 1);
    assert.equal(body.contentHash, hash);
    assert.ok(body.changeSeq >= 1);
  });

  test("manifest: reflects uploaded file", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "feedfeedfeedfeedfeedfeedfeedfeed";
    const size = 77;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const storeState: MockStorageState = { objects: new Map([[ossKey, size]]) };
    const storage = makeMockStorage(storeState);

    // Prepare + complete
    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/manifest-test.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, storage }
    );
    const sessionId = JSON.parse(pr.body).uploadSessionId;
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: sessionId },
      { db, repo, storage }
    );

    // Manifest afterSeq=0
    const mRes = await handleSyncManifest(
      makeCaller(team.id, actor.id),
      { afterSeq: 0 },
      { db, repo }
    );

    assert.equal(mRes.statusCode, 200);
    const body = JSON.parse(mRes.body);
    assert.ok(Array.isArray(body.items));
    const found = body.items.find((i: any) => i.path === "knowledge/manifest-test.md");
    assert.ok(found, "uploaded file should appear in manifest");
    assert.equal(found.contentHash, hash);
    assert.equal(found.deleted, false);
  });

  test("download: returns presigned GET URL", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
    const size = 200;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const storeState: MockStorageState = { objects: new Map([[ossKey, size]]) };
    const storage = makeMockStorage(storeState);

    // Prepare + complete to register verified blob
    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/dl-test.bin", parentVersion: 0, contentHash: hash, size },
      { db, repo, storage }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr.body).uploadSessionId },
      { db, repo, storage }
    );

    const dlRes = await handleSyncDownload(
      makeCaller(team.id, actor.id),
      { contentHash: hash },
      { db, repo, storage }
    );

    assert.equal(dlRes.statusCode, 200);
    const body = JSON.parse(dlRes.body);
    assert.ok(body.downloadUrl, "should have downloadUrl");
    assert.equal(body.size, size);
    assert.equal(body.ttlSec, 900);
  });

  test("prepare: a verified blob short-circuits without touching storage", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "dedupe00dedupe00dedupe00dedupe00";
    const size = 33;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const storeState: MockStorageState = {
      objects: new Map([[ossKey, size]]),
      stats: [],
    };
    const storage = makeMockStorage(storeState);

    // First push of this content: verifies the blob.
    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/a.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, storage }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr.body).uploadSessionId },
      { db, repo, storage }
    );
    const statsAfterFirst = storeState.stats!.length;
    assert.ok(statsAfterFirst > 0, "the first round-trip must consult storage");

    // Same content at a different path — the DB row already says verified, so
    // this must not cost a storage call. Supabase Storage has no HEAD; every
    // stat() here is a `list`, and prepare runs per changed file per tick.
    const again = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/b.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, storage }
    );

    assert.equal(again.statusCode, 200);
    const body = JSON.parse(again.body);
    assert.equal(body.requiresUpload, false, "content already stored");
    assert.equal(body.presignedPut, null, "no upload URL when nothing to upload");
    assert.equal(
      storeState.stats!.length,
      statsAfterFirst,
      "a verified blob must not trigger another storage lookup"
    );
  });

  test("delete: tombstones file", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
    const size = 10;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const storeState: MockStorageState = { objects: new Map([[ossKey, size]]) };
    const storage = makeMockStorage(storeState);

    // Upload first
    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/to-delete.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, storage }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr.body).uploadSessionId },
      { db, repo, storage }
    );

    // Delete
    const delRes = await handleSyncDelete(
      makeCaller(team.id, actor.id),
      { path: "knowledge/to-delete.md", parentVersion: 1 },
      { db, repo }
    );

    assert.equal(delRes.statusCode, 200);
    const body = JSON.parse(delRes.body);
    assert.equal(body.version, 2);
    assert.ok(body.changeSeq >= 2);

    // Manifest should show deleted=true
    const mRes = await handleSyncManifest(
      makeCaller(team.id, actor.id),
      { afterSeq: 0 },
      { db, repo }
    );
    const items = JSON.parse(mRes.body).items;
    const item = items.find((i: any) => i.path === "knowledge/to-delete.md");
    assert.ok(item, "deleted file should appear in manifest");
    assert.equal(item.deleted, true);
  });

  test("versions: lists version history", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash1 = "1111111111111111111111111111111a";
    const hash2 = "2222222222222222222222222222222b";
    const size = 5;

    const makeOssKey = (h: string) =>
      `teams/${team.id}/blobs/sha256/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`;

    const storeState: MockStorageState = {
      objects: new Map([
        [makeOssKey(hash1), size],
        [makeOssKey(hash2), size],
      ]),
    };
    const storage = makeMockStorage(storeState);

    // Upload version 1
    const pr1 = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/versions-test.md", parentVersion: 0, contentHash: hash1, size },
      { db, repo, storage }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr1.body).uploadSessionId },
      { db, repo, storage }
    );

    // Upload version 2
    const pr2 = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/versions-test.md", parentVersion: 1, contentHash: hash2, size },
      { db, repo, storage }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr2.body).uploadSessionId },
      { db, repo, storage }
    );

    const vRes = await handleSyncVersions(
      makeCaller(team.id, actor.id),
      { path: "knowledge/versions-test.md" },
      { db, repo }
    );

    assert.equal(vRes.statusCode, 200);
    const body = JSON.parse(vRes.body);
    assert.ok(Array.isArray(body.versions));
    assert.equal(body.versions.length, 2);
    // Newest first
    assert.equal(body.versions[0].version, 2);
    assert.equal(body.versions[1].version, 1);
  });

  test("set-mode: owner can set mode", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const owner = await seedMember(db, team.id, "owner");

    const res = await handleSyncSetMode(
      owner.userId,
      { teamId: team.id, mode: "git" },
      { db, repo }
    );

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).mode, "git");
  });

  test("set-mode: non-owner gets 403", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const member = await seedMember(db, team.id, "member");

    const res = await handleSyncSetMode(
      member.userId,
      { teamId: team.id, mode: "git" },
      { db, repo }
    );

    assert.equal(res.statusCode, 403);
  });

  test("team-mode: reads current sync mode", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const member = await seedMember(db, team.id);

    const res = await handleSyncTeamMode(
      member.userId,
      { teamId: team.id },
      { db, repo }
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // seedTeam sets syncMode='oss'
    assert.equal(body.mode, "oss");
  });

  test("delete: cas-mismatch returns 409", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "abababababababababababababababab01";
    const size = 8;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const storeState: MockStorageState = { objects: new Map([[ossKey, size]]) };
    const storage = makeMockStorage(storeState);

    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/cas-test.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, storage }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr.body).uploadSessionId },
      { db, repo, storage }
    );

    // Delete with wrong parentVersion (0 instead of 1)
    const res = await handleSyncDelete(
      makeCaller(team.id, actor.id),
      { path: "knowledge/cas-test.md", parentVersion: 0 },
      { db, repo }
    );

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).reason, "cas-mismatch");
  });
});

// ---------------------------------------------------------------------------
// Batch endpoints (postgres path) — per-item independence is the iron rule.
// ---------------------------------------------------------------------------

const h32 = (c: string) => c.repeat(32).slice(0, 32);
const ossKeyFor = (teamId: string, h: string) =>
  `teams/${teamId}/blobs/sha256/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`;

describe("sync batch endpoints postgres path", () => {
  test("prepare-batch: N items → N results, same order, whole request 200", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const storeState: MockStorageState = { objects: new Map() }; // no blobs yet
    const storage = makeMockStorage(storeState);

    const items = [
      { path: "knowledge/a.md", parentVersion: 0, contentHash: h32("a"), size: 10 },
      { path: "knowledge/b.md", parentVersion: 0, contentHash: h32("b"), size: 20 },
      { path: "knowledge/c.md", parentVersion: 0, contentHash: h32("c"), size: 30 },
    ];

    const res = await handleSyncUploadPrepareBatch(
      makeCaller(team.id, actor.id),
      { items },
      { db, repo, storage }
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.results.length, 3, "results length == items length");
    body.results.forEach((r: any) => {
      assert.equal(r.ok, true);
      assert.ok(r.uploadSessionId, "each item gets a session");
      assert.equal(r.requiresUpload, true);
      assert.ok(r.presignedPut);
    });
  });

  test("complete-batch: 3 items, 1 conflict — siblings still commit (no whole-batch rollback)", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const hA = h32("1");
    const hB = h32("2");
    const sizeA = 11;
    const sizeB = 22;
    const storeState: MockStorageState = {
      objects: new Map([
        [ossKeyFor(team.id, hA), sizeA],
        [ossKeyFor(team.id, hB), sizeB],
      ]),
    };
    const storage = makeMockStorage(storeState);
    const deps = { db, repo, storage };

    // Prepare: A (fresh), B (will be completed first → bumps to v1),
    //          B2 (stale pv0 session on same path → must conflict at complete).
    const prep = async (path: string, hash: string, size: number, pv: number) =>
      JSON.parse(
        (await handleSyncUploadPrepare(caller, { path, parentVersion: pv, contentHash: hash, size }, deps)).body
      ).uploadSessionId;

    const sessA = await prep("knowledge/batch-a.md", hA, sizeA, 0);
    const sessB = await prep("knowledge/batch-b.md", hB, sizeB, 0);
    const sessB2 = await prep("knowledge/batch-b.md", hB, sizeB, 0); // stale once B → v1

    // Land B first so sessB2's parentVersion(0) is stale.
    const firstB = await handleSyncUploadComplete(caller, { uploadSessionId: sessB }, deps);
    assert.equal(firstB.statusCode, 200);

    // Batch: [A ok, B2 conflict, plus a bogus session → error]. Whole request 200.
    const res = await handleSyncUploadCompleteBatch(
      caller,
      { items: [
        { uploadSessionId: sessA },
        { uploadSessionId: sessB2 },
        { uploadSessionId: "00000000-0000-0000-0000-000000000000" },
      ] },
      deps
    );

    assert.equal(res.statusCode, 200, "whole batch is always 200");
    const { results } = JSON.parse(res.body);
    assert.equal(results.length, 3);

    // Item 0: A committed independently.
    assert.equal(results[0].ok, true);
    assert.equal(results[0].version, 1);

    // Item 1: B2 is a CAS conflict — does NOT roll back item 0.
    assert.equal(results[1].ok, false);
    assert.equal(results[1].status, 409);
    assert.equal(results[1].reason, "cas-mismatch");

    // Item 2: missing session → per-item error, still no abort.
    assert.equal(results[2].ok, false);
    assert.ok(results[2].status >= 400);

    // Confirm A actually persisted despite siblings failing.
    const mRes = await handleSyncManifest(caller, { afterSeq: 0 }, { db, repo });
    const items = JSON.parse(mRes.body).items;
    assert.ok(items.find((i: any) => i.path === "knowledge/batch-a.md"), "A persisted");
  });

  test("download-batch: mixed found / not-found per item", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const hash = h32("d");
    const size = 64;
    const storeState: MockStorageState = { objects: new Map([[ossKeyFor(team.id, hash), size]]) };
    const storage = makeMockStorage(storeState);
    const deps = { db, repo, storage };

    // Register one verified blob via prepare+complete.
    const pr = await handleSyncUploadPrepare(
      caller, { path: "knowledge/dl.bin", parentVersion: 0, contentHash: hash, size }, deps
    );
    await handleSyncUploadComplete(caller, { uploadSessionId: JSON.parse(pr.body).uploadSessionId }, deps);

    const res = await handleSyncDownloadBatch(
      caller,
      { items: [{ contentHash: hash }, { contentHash: h32("e") /* unknown */ }] },
      deps
    );

    assert.equal(res.statusCode, 200);
    const { results } = JSON.parse(res.body);
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.ok(results[0].downloadUrl);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].status, 404);
  });

  test("delete-batch: per-item tombstone + independent CAS conflict", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const hash = h32("f");
    const size = 9;
    const storeState: MockStorageState = { objects: new Map([[ossKeyFor(team.id, hash), size]]) };
    const storage = makeMockStorage(storeState);
    const deps = { db, repo, storage };

    // Upload one file so it can be tombstoned at v1.
    const pr = await handleSyncUploadPrepare(
      caller, { path: "knowledge/del.md", parentVersion: 0, contentHash: hash, size }, deps
    );
    await handleSyncUploadComplete(caller, { uploadSessionId: JSON.parse(pr.body).uploadSessionId }, deps);

    const res = await handleSyncDeleteBatch(
      caller,
      { items: [
        { path: "knowledge/del.md", parentVersion: 1 },          // ok → v2 tombstone
        { path: "knowledge/del.md", parentVersion: 0 },          // stale → 409
        { path: "knowledge/never-existed.md", parentVersion: 0 } // missing → 404
      ] },
      { db, repo }
    );

    assert.equal(res.statusCode, 200);
    const { results } = JSON.parse(res.body);
    assert.equal(results.length, 3);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].version, 2);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].status, 409);
    assert.equal(results[2].ok, false);
    assert.equal(results[2].status, 404);
  });

  test("batch: oversized request rejected with 400 batch_too_large", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const items = Array.from({ length: MAX_SYNC_BATCH + 1 }, (_, i) => ({
      path: `knowledge/x${i}.md`, parentVersion: 0, contentHash: h32("a"), size: 1,
    }));
    const res = await handleSyncUploadPrepareBatch(
      makeCaller(team.id, actor.id), { items }, { db, repo }
    );
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, "batch_too_large");
  });

  test("batch: non-array items rejected with 400; empty array → empty results", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const bad = await handleSyncDownloadBatch(caller, { items: "nope" as any }, { db, repo });
    assert.equal(bad.statusCode, 400);

    const empty = await handleSyncDownloadBatch(caller, { items: [] }, { db, repo });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(JSON.parse(empty.body).results, []);
  });
});

// ---------------------------------------------------------------------------
// Knowledge sync MQTT hints — one publish per successful complete/delete call.
// ---------------------------------------------------------------------------

describe("sync knowledge MQTT hints", () => {
  function makeMqttRecorder() {
    const published: Array<{ topic: string; payload: string; options?: Record<string, unknown> }> = [];
    return {
      published,
      mqtt: {
        publish: async (topic: string, payload: string, options?: Record<string, unknown>) => {
          published.push({ topic, payload, options });
        },
      },
    };
  }

  test("complete-batch of N → exactly one publish with max changeSeq, no path", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const hA = h32("1");
    const hB = h32("2");
    const hC = h32("3");
    const storeState: MockStorageState = {
      objects: new Map([
        [ossKeyFor(team.id, hA), 10],
        [ossKeyFor(team.id, hB), 20],
        [ossKeyFor(team.id, hC), 30],
      ]),
    };
    const storage = makeMockStorage(storeState);
    const { mqtt, published } = makeMqttRecorder();
    const fixedNow = new Date("2026-08-26T07:12:00.000Z");
    const deps = { db, repo, storage, mqtt, now: () => fixedNow };

    const prep = async (path: string, hash: string, size: number) =>
      JSON.parse(
        (await handleSyncUploadPrepare(
          caller,
          { path, parentVersion: 0, contentHash: hash, size },
          { db, repo, storage },
        )).body,
      ).uploadSessionId;

    const sessA = await prep("knowledge/hint-a.md", hA, 10);
    const sessB = await prep("knowledge/hint-b.md", hB, 20);
    const sessC = await prep("knowledge/hint-c.md", hC, 30);

    const res = await handleSyncUploadCompleteBatch(
      caller,
      {
        nodeId: "mac-9f3c",
        items: [
          { uploadSessionId: sessA },
          { uploadSessionId: sessB },
          { uploadSessionId: sessC },
        ],
      },
      deps,
    );

    assert.equal(res.statusCode, 200);
    const { results } = JSON.parse(res.body);
    assert.equal(results.length, 3);
    assert.ok(results.every((r: any) => r.ok));
    const maxSeq = Math.max(...results.map((r: any) => r.changeSeq));

    assert.equal(published.length, 1, "exactly one MQTT publish for the batch");
    assert.equal(published[0].topic, `amux/${team.id}/sync/knowledge`);
    assert.equal(published[0].options?.retain, false);
    assert.equal(published[0].options?.qos, 1);

    const hint = JSON.parse(published[0].payload);
    assert.equal(hint.v, 1);
    assert.equal(hint.changeSeq, maxSeq);
    assert.equal(hint.originNodeId, "mac-9f3c");
    assert.equal(hint.at, "2026-08-26T07:12:00.000Z");
    assert.equal("path" in hint, false, "hint must not carry path");
  });

  test("publish failure does not change the HTTP 200 result", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const hash = h32("f");
    const size = 7;
    const storeState: MockStorageState = {
      objects: new Map([[ossKeyFor(team.id, hash), size]]),
    };
    const storage = makeMockStorage(storeState);
    const mqtt = {
      publish: async () => {
        throw new Error("broker unreachable");
      },
    };

    const prep = await handleSyncUploadPrepare(
      caller,
      { path: "knowledge/fail-hint.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, storage },
    );
    const sess = JSON.parse(prep.body).uploadSessionId;

    const res = await handleSyncUploadCompleteBatch(
      caller,
      { items: [{ uploadSessionId: sess }] },
      { db, repo, storage, mqtt },
    );

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).results[0].ok, true);
  });

  test("mqtt: null (no MQTT_BROKER_URL) still returns 200", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const hash = h32("n");
    const size = 5;
    const storeState: MockStorageState = {
      objects: new Map([[ossKeyFor(team.id, hash), size]]),
    };
    const storage = makeMockStorage(storeState);

    const prep = await handleSyncUploadPrepare(
      caller,
      { path: "knowledge/no-mqtt.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, storage },
    );
    const sess = JSON.parse(prep.body).uploadSessionId;

    const res = await handleSyncUploadCompleteBatch(
      caller,
      { items: [{ uploadSessionId: sess }] },
      { db, repo, storage, mqtt: null },
    );

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).results[0].ok, true);
  });

  test("single complete publishes one hint (legacy path)", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const hash = h32("s");
    const size = 4;
    const storeState: MockStorageState = {
      objects: new Map([[ossKeyFor(team.id, hash), size]]),
    };
    const storage = makeMockStorage(storeState);
    const { mqtt, published } = makeMqttRecorder();

    const prep = await handleSyncUploadPrepare(
      caller,
      { path: "knowledge/single.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, storage },
    );
    const res = await handleSyncUploadComplete(
      caller,
      { uploadSessionId: JSON.parse(prep.body).uploadSessionId, nodeId: "node-legacy" },
      { db, repo, storage, mqtt },
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(published.length, 1);
    const hint = JSON.parse(published[0].payload);
    assert.equal(hint.changeSeq, body.changeSeq);
    assert.equal(hint.originNodeId, "node-legacy");
  });

  test("delete-batch publishes once with max successful changeSeq", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const caller = makeCaller(team.id, actor.id);

    const hA = h32("d");
    const hB = h32("e");
    const storeState: MockStorageState = {
      objects: new Map([
        [ossKeyFor(team.id, hA), 8],
        [ossKeyFor(team.id, hB), 9],
      ]),
    };
    const storage = makeMockStorage(storeState);
    const { mqtt, published } = makeMqttRecorder();
    const deps = { db, repo, storage };

    for (const [path, hash, size] of [
      ["knowledge/del-a.md", hA, 8],
      ["knowledge/del-b.md", hB, 9],
    ] as const) {
      const pr = await handleSyncUploadPrepare(
        caller,
        { path, parentVersion: 0, contentHash: hash, size },
        deps,
      );
      await handleSyncUploadComplete(
        caller,
        { uploadSessionId: JSON.parse(pr.body).uploadSessionId },
        { ...deps, mqtt: null },
      );
    }

    published.length = 0;
    const res = await handleSyncDeleteBatch(
      caller,
      {
        nodeId: "del-node",
        items: [
          { path: "knowledge/del-a.md", parentVersion: 1 },
          { path: "knowledge/del-b.md", parentVersion: 1 },
        ],
      },
      { db, repo, mqtt },
    );

    assert.equal(res.statusCode, 200);
    const { results } = JSON.parse(res.body);
    assert.ok(results.every((r: any) => r.ok));
    const maxSeq = Math.max(...results.map((r: any) => r.changeSeq));
    assert.equal(published.length, 1);
    const hint = JSON.parse(published[0].payload);
    assert.equal(hint.changeSeq, maxSeq);
    assert.equal(hint.originNodeId, "del-node");
    assert.equal(published[0].topic, `amux/${team.id}/sync/knowledge`);
  });
});

// ---------------------------------------------------------------------------
// Per-team byte quota (Phase F) — live sum of amuxc_files.size, not disk.
// ---------------------------------------------------------------------------

describe("sync upload prepare byte quota", () => {
  const prevMax = process.env.SYNC_MAX_BYTES_PER_TEAM;

  before(() => {
    process.env.SYNC_MAX_BYTES_PER_TEAM = "100";
  });

  after(() => {
    if (prevMax === undefined) delete process.env.SYNC_MAX_BYTES_PER_TEAM;
    else process.env.SYNC_MAX_BYTES_PER_TEAM = prevMax;
  });

  test("single prepare: sum + size over ceiling → 422 QuotaExceeded kind bytes", async () => {
    resetQuotaCache();
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const storage = makeMockStorage({ objects: new Map() });

    const res = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/big.md", parentVersion: 0, contentHash: h32("q"), size: 40 },
      {
        db,
        repo,
        storage,
        sumLiveBytes: async () => 80,
        countLiveFiles: async () => 0,
      },
    );

    assert.equal(res.statusCode, 422);
    const body = JSON.parse(res.body);
    assert.equal(body.code, "QuotaExceeded");
    assert.equal(body.kind, "bytes");
  });

  test("prepare-batch: item that crosses and every item after it are rejected", async () => {
    resetQuotaCache();
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const storage = makeMockStorage({ objects: new Map() });

    // max=100, live sum=50 → sizes 30, 30, 30 cross at index 1 (50+30+30=110).
    const res = await handleSyncUploadPrepareBatch(
      makeCaller(team.id, actor.id),
      {
        items: [
          { path: "knowledge/b0.md", parentVersion: 0, contentHash: h32("0"), size: 30 },
          { path: "knowledge/b1.md", parentVersion: 0, contentHash: h32("1"), size: 30 },
          { path: "knowledge/b2.md", parentVersion: 0, contentHash: h32("2"), size: 30 },
        ],
      },
      {
        db,
        repo,
        storage,
        sumLiveBytes: async () => 50,
        countLiveFiles: async () => 0,
      },
    );

    assert.equal(res.statusCode, 200);
    const { results } = JSON.parse(res.body);
    assert.equal(results.length, 3);
    assert.equal(results[0].ok, true, "item 0 stays under the ceiling");
    assert.equal(results[1].ok, false);
    assert.equal(results[1].status, 422);
    assert.equal(results[1].code, "QuotaExceeded");
    assert.equal(results[1].kind, "bytes");
    assert.equal(results[2].ok, false);
    assert.equal(results[2].status, 422);
    assert.equal(results[2].kind, "bytes");
  });

  test("single prepare: sum failure → allow (null policy)", async () => {
    resetQuotaCache();
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);
    const storage = makeMockStorage({ objects: new Map() });

    const res = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "knowledge/ok.md", parentVersion: 0, contentHash: h32("ok"), size: 90 },
      {
        db,
        repo,
        storage,
        sumLiveBytes: async () => null,
        countLiveFiles: async () => 0,
      },
    );

    assert.equal(res.statusCode, 200);
    assert.ok(JSON.parse(res.body).uploadSessionId);
  });
});
