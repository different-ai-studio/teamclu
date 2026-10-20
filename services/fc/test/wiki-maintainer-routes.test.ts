import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";

const TEAM = "11111111-1111-1111-1111-111111111111";

function stubRepository() {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        if (prop === "prepareWikiMaintainerCheckpoint") {
          return async () => ({
            sha256: "",
            size: 0,
          });
        }
        if (
          prop === "pruneWikiMaintainerCheckpoints" ||
          prop === "sweepWikiMaintainerUploads"
        ) {
          return async () => [];
        }
        return async () => ({ stage: "idle", generation: 0 });
      },
    },
  );
}

async function call(method: string, path: string, body: Record<string, unknown> = {}) {
  return handleBusinessApiRequest(
    {
      httpMethod: method,
      path,
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        "X-Request-Id": "req_wiki_maintainer",
      },
      body: method === "GET" ? undefined : JSON.stringify(body),
    },
    { createRepository: () => stubRepository() },
  );
}

describe("wiki maintainer phase-one routes are registered", () => {
  const routes: Array<[string, string, Record<string, unknown>?]> = [
    ["GET", `/v1/teams/${TEAM}/wiki-maintainer`],
    ["PUT", `/v1/teams/${TEAM}/wiki-maintainer/config`, { expectedVersion: 0, config: {} }],
    [
      "POST",
      `/v1/teams/${TEAM}/wiki-maintainer/checkpoints/prepare`,
      { expectedGeneration: 0, sha256: "a".repeat(64), size: 1 },
    ],
    ["POST", `/v1/teams/${TEAM}/wiki-maintainer/checkpoints/complete`, {}],
    ["GET", `/v1/teams/${TEAM}/wiki-maintainer/checkpoints/latest/download`],
    ["GET", `/v1/teams/${TEAM}/wiki-maintainer/checkpoints/2/download`],
    ["POST", `/v1/teams/${TEAM}/wiki-maintainer/publish/begin`, {}],
    ["POST", `/v1/teams/${TEAM}/wiki-maintainer/publish/complete`, {}],
    ["POST", `/v1/teams/${TEAM}/wiki-maintainer/publish/recover`, {}],
  ];

  for (const [method, path, body] of routes) {
    test(`${method} ${path.replace(TEAM, ":teamId")}`, async () => {
      const response = await call(method, path, body);
      assert.ok(
        !String(response.body ?? "").includes("Route not found"),
        `${method} ${path} is not registered`,
      );
    });
  }
});
