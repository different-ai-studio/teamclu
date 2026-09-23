import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  assertCheckpointDescriptor,
  checkpointObjectKey,
  checkpointUpload,
  retainedCheckpointGenerations,
  verifyCheckpointObject,
} from "../src/lib/wiki-maintainer-storage.js";

const TEAM = "11111111-1111-1111-1111-111111111111";
const HASH = "ab".repeat(32);
const require = createRequire(import.meta.url);
const { zipStore } = require("../../../scripts/kb-maintainer/zip.js");

test("checkpoint retention keeps three baselines and the chain after the newest", () => {
  assert.deepEqual(
    retainedCheckpointGenerations([
      { generation: 10, baseline: true },
      { generation: 11, baseline: false },
      { generation: 20, baseline: true },
      { generation: 30, baseline: true },
      { generation: 40, baseline: true },
      { generation: 41, baseline: false },
    ]).sort((left, right) => left - right),
    [20, 30, 40, 41],
  );
});

test("checkpoint descriptors reject non-canonical uppercase hashes", () => {
  assert.throws(
    () => assertCheckpointDescriptor({ teamId: TEAM, sha256: HASH.toUpperCase(), size: 10 }),
    /lowercase hex/,
  );
});

test("checkpoint upload reuses an object only after size and hash verification", async () => {
  let signed = 0;
  const storage: any = {
    stat: async () => ({ size: 10 }),
    hashSha256: async () => HASH,
    createUploadUrl: async () => {
      signed += 1;
      return "https://upload.invalid";
    },
  };
  const result = await checkpointUpload({ teamId: TEAM, sha256: HASH, size: 10 }, storage);
  assert.equal(result.requiresUpload, false);
  assert.equal(result.presignedPut, null);
  assert.equal(signed, 0);
});

test("checkpoint completion rejects an object key from another team", async () => {
  let inspected = false;
  const storage: any = {
    stat: async () => {
      inspected = true;
      return { size: 10 };
    },
    hashSha256: async () => HASH,
  };
  await assert.rejects(
    () =>
      verifyCheckpointObject(
        {
          teamId: TEAM,
          objectKey: checkpointObjectKey("22222222-2222-2222-2222-222222222222", HASH),
          sha256: HASH,
          size: 10,
        },
        storage,
      ),
    /object key does not match/,
  );
  assert.equal(inspected, false);
});

test("checkpoint completion reads the authoritative manifest from verified bytes", async () => {
  const entries = {
    "config.json": Buffer.from("{}"),
    "state.json": Buffer.from("{}"),
    "wiki.bundle": Buffer.from("# v2 git bundle\nfixture"),
    "prepared-run.json": Buffer.from("{}"),
  };
  const manifest = {
    schemaVersion: 1,
    teamId: TEAM,
    generation: 3,
    entries: Object.fromEntries(
      Object.entries(entries).map(([name, data]) => [
        name,
        {
          size: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        },
      ]),
    ),
  };
  const bytes: Buffer = zipStore([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    ...Object.entries(entries).map(([name, data]) => ({ name, data })),
  ]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storage: any = {
    stat: async () => ({ size: bytes.length }),
    readBytes: async () => bytes,
  };
  assert.deepEqual(
    await verifyCheckpointObject(
      {
        teamId: TEAM,
        objectKey: checkpointObjectKey(TEAM, sha256),
        sha256,
        size: bytes.length,
      },
      storage,
    ),
    manifest,
  );
});
