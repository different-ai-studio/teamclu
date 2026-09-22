import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertExpectedGeneration,
  hashPublishToken,
  parseWikiConfigWrite,
} from "../src/lib/supabase-repo/wiki-maintainer.js";

test("wiki checkpoint CAS rejects a stale expected generation", () => {
  assert.throws(
    () => assertExpectedGeneration(7, 6),
    (error: any) =>
      error?.statusCode === 409 &&
      error?.code === "checkpoint_conflict" &&
      error?.details?.currentGeneration === 7,
  );
});

test("wiki config write requires an explicit non-negative version", () => {
  assert.throws(
    () => parseWikiConfigWrite({ config: {} }),
    /expectedVersion/,
  );
  assert.deepEqual(parseWikiConfigWrite({ expectedVersion: 0, config: { sources: [] } }), {
    expectedVersion: 0,
    config: { sources: [] },
  });
});

test("publish tokens are stored as hashes", () => {
  assert.equal(
    hashPublishToken("publish-secret"),
    "ba509c407b1569c6f2ad3762bd3c13a8868e3d5f63156f8138754b92dece0be5",
  );
  assert.notEqual(hashPublishToken("publish-secret"), "publish-secret");
});
