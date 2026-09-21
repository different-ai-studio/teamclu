"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDaemonSync, toCamelSyncBody } = require("./sync-adapter");
const { SYNC_OPTIONS } = require("./publish");

test("toCamelSyncBody keeps bulk gates off", () => {
  assert.deepEqual(toCamelSyncBody(SYNC_OPTIONS), {
    forceSync: true,
    allowBulkAdd: false,
    allowBulkDelete: false,
  });
});

test("createDaemonSync posts the frozen flags and never flips bulk gates", async () => {
  const calls = [];
  const syncTeam = createDaemonSync({
    baseUrl: "http://127.0.0.1:9",
    token: "secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ skipped: false, blocked_new_files: 12 }),
      };
    },
  });
  const result = await syncTeam(SYNC_OPTIONS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:9/v1/team/sync");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    forceSync: true,
    allowBulkAdd: false,
    allowBulkDelete: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.blocked_new_files, 12);
});
