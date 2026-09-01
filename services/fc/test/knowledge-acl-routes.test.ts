/**
 * knowledge-acl-routes.test.ts
 *
 * That the five management routes are actually REGISTERED, at the paths the
 * client calls.
 *
 * The rest of the ACL suite (sync-acl.test.ts) invokes handlers and repository
 * methods directly, which proves the logic and proves nothing about routing. A
 * typo in a path string, or a `registerKnowledgeAcl` that never made it into
 * routes/index.ts, would sail through every one of those tests and show up as
 * "Route not found" in the settings page — which is exactly what it looked like
 * against a deployment that predates these endpoints, so the two failures are
 * indistinguishable from the outside.
 *
 * Assertion is deliberately narrow: the request must not fall through to the
 * app's unknown-route 404. The repository is a stub, so what a handler does with
 * the request afterwards is not this file's business.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";

const TEAM = "11111111-1111-1111-1111-111111111111";
const ACL = "22222222-2222-2222-2222-222222222222";

/**
 * Every method resolves; the route layer only needs to reach *something*.
 *
 * `then` must come back undefined. The adapter does
 * `await deps.createRepository(...)`, and a proxy that hands out a function for
 * every key makes the repository look like a thenable — `await` then calls
 * `then(resolve, reject)` on a stub that never resolves, and the run hangs with
 * no output at all rather than failing.
 */
function stubRepository() {
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        typeof prop === "symbol" || prop === "then"
          ? undefined
          : async () => ({ items: [] }),
    },
  );
}

// Goes through the same bridge the other /v1 route tests use, which drives the
// real Hono app. Calling createApp directly also works but leaves a handle open,
// so the test runner never exits.
async function call(method: string, path: string) {
  const hasBody = method !== "GET" && method !== "DELETE";
  const res = await handleBusinessApiRequest(
    {
      httpMethod: method,
      path,
      headers: { Authorization: "Bearer test", "X-Request-Id": "req_acl_routes" },
      body: hasBody ? JSON.stringify({ pathPrefix: "knowledge/hr/" }) : undefined,
    },
    { createRepository: () => stubRepository() },
  );
  return { status: res.statusCode, body: String(res.body ?? "") };
}

describe("knowledge ACL routes are registered", () => {
  const routes: [string, string][] = [
    ["GET", `/v1/teams/${TEAM}/knowledge-acl`],
    ["POST", `/v1/teams/${TEAM}/knowledge-acl`],
    // Must resolve to the preview handler rather than being read as an aclId by
    // the `:aclId` route below it.
    ["POST", `/v1/teams/${TEAM}/knowledge-acl/preview`],
    ["PATCH", `/v1/teams/${TEAM}/knowledge-acl/${ACL}`],
    ["DELETE", `/v1/teams/${TEAM}/knowledge-acl/${ACL}`],
  ];

  for (const [method, path] of routes) {
    test(`${method} ${path.replace(TEAM, ":teamId").replace(ACL, ":aclId")}`, async () => {
      const { body } = await call(method, path);
      assert.ok(
        !body.includes("Route not found"),
        `${method} ${path} is not registered — the client would see the same 404 it gets from a deployment without this feature`,
      );
    });
  }
});
