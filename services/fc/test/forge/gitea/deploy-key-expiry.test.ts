import assert from "node:assert/strict";
import { test } from "node:test";
import { makeDeployKeyExpirySweep } from "../../../src/lib/forge/gitea/deploy-key-expiry.js";
import { JIT_DEPLOY_KEY_TTL_MS } from "../../../src/lib/forge/gitea/deploy-key.js";

test("heartbeat sweeps quiet legacy and per-org repos, resuming from its last app", async () => {
  const now = 1_800_000_000_000;
  const org = "o00000000-0000-0000-0000-000000000001";
  const rows = [
    { id: "aaa", git_remote_url: null },
    { id: "bbb", git_remote_url: "ssh://git@public.example/" + org + "/app-bbb.git" },
  ];
  const seen: string[] = [];
  const removed: string[] = [];
  let failOnce = true;
  const gitea = {
    owner: "legacy",
    withOwner(owner: string) {
      return {
        async listAllDeployKeys(appId: string) {
          seen.push(owner + "/" + appId);
          return [
            { id: 1, title: "jit-" + (now - JIT_DEPLOY_KEY_TTL_MS) },
            { id: 2, title: "jit-" + (now - 100) },
            { id: 3, title: "operator-key" },
          ];
        },
        async deleteDeployKey(appId: string, keyId: number) {
          if (failOnce && appId === "aaa") {
            failOnce = false;
            throw new Error("temporary upstream failure");
          }
          removed.push(owner + "/" + appId + "/" + keyId);
        },
      };
    },
  };
  const run = makeDeployKeyExpirySweep({
    gitea,
    listApps: async (_client, after, limit) => rows.filter((row) => row.id > after).slice(0, limit),
    now: () => now,
    batchSize: 1,
  });
  assert.deepEqual(await run(undefined, now + 5000), { scanned: 1, revoked: 0, failed: 1 });
  assert.deepEqual(await run(undefined, now + 5000), { scanned: 1, revoked: 1, failed: 0 });
  assert.deepEqual(await run(undefined, now + 5000), { scanned: 1, revoked: 1, failed: 0 });
  assert.deepEqual(seen, ["legacy/aaa", org + "/bbb", "legacy/aaa"]);
  assert.deepEqual(removed, [org + "/bbb/1", "legacy/aaa/1"]);
});
