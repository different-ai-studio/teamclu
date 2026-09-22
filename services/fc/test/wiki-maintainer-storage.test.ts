import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertCheckpointDescriptor,
  checkpointObjectKey,
  checkpointUpload,
  verifyCheckpointObject,
} from "../src/lib/wiki-maintainer-storage.js";

const TEAM = "11111111-1111-1111-1111-111111111111";
const HASH = "ab".repeat(32);

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
